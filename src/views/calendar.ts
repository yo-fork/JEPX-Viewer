/**
 * カレンダー：日ごとの指標を年度別カレンダーに並べ、曜日・祝日・季節の並びを一望する。
 */
import { aggregate, src, type Source } from '../lib/aggregate';
import { formatDay, isoFromDay } from '../lib/dates';
import { holidayName } from '../lib/holidays';
import { fmtNum, fmtPrice, fmtSigned } from '../lib/format';
import { AREA_KEYS, PRICE_KEYS, SERIES_LABEL, SERIES_SHORT, type PriceKey } from '../lib/series';
import type { Selection } from '../lib/select';
import { accMean, quantileSorted, type Acc } from '../lib/stats';
import type { CalMetric, ScaleMode } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttNote, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { CommonRange, describeSelection, PRICE_UNIT, rangeTag, SCALE_OPTIONS } from './common';

const METRICS: { value: CalMetric; label: string }[] = [
  { value: 'mean', label: '日平均' },
  { value: 'max', label: '日最高' },
  { value: 'min', label: '日最低' },
  { value: 'range', label: '日内の値幅' },
  { value: 'floor', label: '0.01円のコマ数' },
  { value: 'spread', label: 'システムとの差' },
];

const MONTHS = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const DAYS = ['日', '月', '火', '水', '木', '金', '土'];
const CAL_HEIGHT = 150;

export class CalendarView extends View {
  private focus!: SelectField<PriceKey>;
  private metric!: Segmented<CalMetric>;
  private scale!: Segmented<ScaleMode>;
  private chart!: ChartCard;
  private readonly common = new CommonRange();

  protected build(): void {
    const s = this.ctx.state;
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.metric = segmented('指標', METRICS, s.calMetric, (v) => this.set({ calMetric: v }));
    this.scale = segmented('色の範囲', SCALE_OPTIONS, s.scale, (v) => this.set({ scale: v }));
    this.root.append(toolbar(this.focus.el, this.metric.el, this.scale.el));
    const g = this.grid();
    this.chart = this.card(g, { title: '日別カレンダー', height: 400, wide: true });
  }

  protected render(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    this.focus.set(state.focus);
    const metric: CalMetric = state.calMetric === 'spread' && state.focus === 'system' ? 'mean' : state.calMetric;
    this.metric.set(metric);
    this.scale.set(state.scale);
    if (sel.days.length === 0) {
      this.chart.setEmpty(NO_DATA);
      return;
    }
    const sourceOf = (k: PriceKey) => (metric === 'spread' ? src(ds, k, 'system') : src(ds, k));
    const values = dayValues(sel, sourceOf(state.focus), metric);

    const fys = [...new Set([...sel.days].map((i) => ds.fy[i]))].sort((a, b) => a - b);
    const calIndex = new Map(fys.map((fy, k) => [fy, k]));
    const data: [string, number][][] = fys.map(() => []);
    sel.days.forEach((i, k) => {
      if (Number.isFinite(values[k])) data[calIndex.get(ds.fy[i])!].push([isoFromDay(ds.start + i), values[k]]);
    });

    if (!values.some(Number.isFinite)) {
      this.chart.setEmpty(NO_DATA);
      return;
    }
    const common = state.scale === 'common';
    // 全エリア共通: システムプライスと各エリア（差を見るときは各エリア）の色の範囲をすべて含む範囲
    const [min, max] = common
      ? this.common.get(sel, metric, metric === 'spread' ? AREA_KEYS : PRICE_KEYS, (k) => dayRange(metric, dayValues(sel, sourceOf(k), metric)))
      : dayRange(metric, values);
    const label = METRICS.find((m) => m.value === metric)!.label;
    const unit = metric === 'floor' ? 'コマ' : PRICE_UNIT;
    const fmt = (v: number) => (metric === 'floor' ? `${fmtNum(v)} コマ` : metric === 'spread' ? `${fmtSigned(v)} 円` : `${fmtPrice(v)} ${PRICE_UNIT}`);
    this.chart.setSubtitle(
      `${describeSelection(sel, state)}・${SERIES_LABEL[state.focus]}の${label}（${unit}）${common ? '・色の範囲は全エリア共通' : ''}・灰色の日は対象外またはデータなし`,
    );
    this.chart.setHeight(fys.length * CAL_HEIGHT + 60);

    this.chart.setOption(
      {
        // カレンダーは日付文字列をローカル時刻として扱うので UTC 表示にしない
        useUTC: false,
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [string, number] }) => {
            const [iso, v] = p.value;
            const day = Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);
            const hol = holidayName(day);
            return ttHeader(formatDay(day, true)) + ttRow(t.ink2, fmt(v), `${SERIES_SHORT[state.focus]}の${label}`, 'none') + (hol ? ttNote(hol) : '');
          },
        },
        visualMap: {
          type: 'continuous',
          min,
          max,
          calculable: true,
          orient: 'horizontal',
          right: 8,
          top: 0,
          itemWidth: 12,
          itemHeight: 200,
          precision: metric === 'floor' ? 0 : 1,
          inRange: { color: metric === 'spread' ? t.div : t.seq },
          textStyle: { color: t.muted, fontSize: 11 },
        },
        calendar: fys.map((fy, k) => ({
          range: [`${fy}-04-01`, `${fy + 1}-03-31`],
          top: 64 + k * CAL_HEIGHT,
          left: 56,
          right: 12,
          cellSize: ['auto', 14],
          orient: 'horizontal',
          splitLine: { show: false },
          itemStyle: { color: t.emptyCell, borderColor: t.surface, borderWidth: 2 },
          yearLabel: { show: true, formatter: `${fy}年度`, position: 'left', margin: 28, color: t.ink2, fontSize: 12 },
          dayLabel: { firstDay: 1, nameMap: DAYS, color: t.muted, fontSize: 10, margin: 6 },
          monthLabel: { nameMap: MONTHS, color: t.muted, fontSize: 10, margin: 6 },
        })),
        series: fys.map((_, k) => ({
          type: 'heatmap',
          progressive: 0,
          coordinateSystem: 'calendar',
          calendarIndex: k,
          data: data[k],
          emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
        })),
      },
      {
        columns: ['日付', '曜日・祝日', `${label}（${unit}）`],
        rows: [...sel.days].map((i, k) => {
          const day = ds.start + i;
          return [formatDay(day), holidayName(day) ?? ['日', '月', '火', '水', '木', '金', '土'][ds.dow[i]], values[k]];
        }),
        digits: [null, null, metric === 'floor' ? 0 : 2],
        filename: `jepx_calendar_${metric}_${state.focus}_${rangeTag(sel)}.csv`,
      },
    );
  }
}

/** 対象の日（sel.days の順）ごとの指標の値（値の無い日は NaN） */
function dayValues(sel: Selection, source: Source, metric: CalMetric): number[] {
  const pos = new Int32Array(sel.ds.n).fill(-1);
  sel.days.forEach((i, k) => (pos[i] = k));
  const g = aggregate(sel, source, (i) => pos[i], sel.days.length);
  return [...sel.days].map((_, k) => dayValue(metric, g.acc[k], g.floor[k]));
}

/**
 * 色の範囲: 外れ値に引っ張られないよう 1〜99% 点を整数に丸める（差は 0 を中心に対称、0.01 円のコマ数は 0〜最大）。
 * 値が無ければ NaN
 */
export function dayRange(metric: CalMetric, values: readonly number[]): [number, number] {
  const finite = Float64Array.from(values.filter(Number.isFinite)).sort();
  if (finite.length === 0) return [Number.NaN, Number.NaN];
  if (metric === 'spread') {
    const a = Math.max(Math.abs(quantileSorted(finite, 0.01)), Math.abs(quantileSorted(finite, 0.99)), 0.5);
    return [-a, a];
  }
  if (metric === 'floor') return [0, Math.max(1, quantileSorted(finite, 1))];
  const min = Math.max(0, Math.floor(quantileSorted(finite, 0.01)));
  return [min, Math.max(min + 1, Math.ceil(quantileSorted(finite, 0.99)))];
}

function dayValue(metric: CalMetric, acc: Acc, floor: number): number {
  if (acc.n === 0) return Number.NaN;
  switch (metric) {
    case 'mean':
    case 'spread':
      return accMean(acc);
    case 'max':
      return acc.max;
    case 'min':
      return acc.min;
    case 'range':
      return acc.max - acc.min;
    case 'floor':
      return floor;
  }
}
