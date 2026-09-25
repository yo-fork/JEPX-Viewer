/**
 * 分布：30 分値の価格がどの水準にどれだけあるか（ヒストグラム・価格持続曲線・グループ別の箱ひげ図）。
 */
import { aggregate, buildPeriods, collectValues, src } from '../lib/aggregate';
import { fiscalYearOfDay } from '../lib/dates';
import { fmtNum, fmtPct, fmtPrice } from '../lib/format';
import { AREAS, PRICE_KEYS, SERIES_LABEL, SERIES_SHORT, type PriceKey, type SeriesKey } from '../lib/series';
import { niceStep, quantileSorted, summarizeInPlace } from '../lib/stats';
import type { DistGroup, ScaleMode } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import {
  axisTooltip,
  CommonRange,
  describeSelection,
  endLabels,
  fixedAxis,
  grid,
  labelRoom,
  seriesLegend,
  lineSeries,
  monthLabel,
  PRICE_UNIT,
  priceText,
  rangeTag,
  SCALE_OPTIONS,
  valueAxis,
  valueRange,
  whiskerRange,
  withAlpha,
  type FixedAxis,
} from './common';

const BIN_OPTIONS = [
  { value: 'auto', label: '自動' },
  { value: '0.5', label: '0.5円' },
  { value: '1', label: '1円' },
  { value: '2', label: '2円' },
  { value: '5', label: '5円' },
  { value: '10', label: '10円' },
];

const GROUP_OPTIONS: { value: DistGroup; label: string }[] = [
  { value: 'month', label: '月' },
  { value: 'fy', label: '年度' },
  { value: 'dow', label: '曜日' },
  { value: 'hour', label: '時刻' },
  { value: 'area', label: 'エリア' },
];

const DOW_COLUMNS = ['月', '火', '水', '木', '金', '土', '日', '祝日'];

export class DistributionView extends View {
  private focus!: SelectField<PriceKey>;
  private bin!: SelectField<string>;
  private group!: Segmented<DistGroup>;
  private scale!: Segmented<ScaleMode>;
  private hist!: ChartCard;
  private duration!: ChartCard;
  private box!: ChartCard;
  /** ヒストグラムの階級を決める範囲（最小値〜99.5%点）と、縦軸（コマ数）の範囲 */
  private readonly histRange = new CommonRange();
  private readonly histCount = new CommonRange();
  private readonly durationRange = new CommonRange();
  private readonly boxRange = new CommonRange();

  protected build(): void {
    const s = this.ctx.state;
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.bin = selectField('階級の幅', BIN_OPTIONS, s.distBin, (v) => this.set({ distBin: v }));
    this.group = segmented('箱ひげ図のグループ', GROUP_OPTIONS, s.distGroup, (v) => this.set({ distGroup: v }));
    this.scale = segmented('軸の範囲', SCALE_OPTIONS, s.scale, (v) => this.set({ scale: v }));
    this.root.append(toolbar(this.focus.el, this.bin.el, this.group.el, this.scale.el));
    const g = this.grid();
    this.hist = this.card(g, { title: '価格帯別のコマ数（ヒストグラム）', height: 320 });
    this.duration = this.card(g, { title: '価格持続曲線', height: 320 });
    this.box = this.card(g, { title: 'グループ別の価格分布（箱ひげ図）', height: 340, wide: true });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.focus.set(state.focus);
    this.bin.set(state.distBin);
    this.group.set(state.distGroup);
    this.scale.set(state.scale);
    if (sel.days.length === 0) {
      [this.hist, this.duration, this.box].forEach((c) => c.setEmpty(NO_DATA));
      return;
    }
    this.renderHistogram();
    this.renderDuration();
    this.renderBox();
  }

  private renderHistogram(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const values = collectValues(sel, src(ds, state.focus));
    if (values.length === 0) {
      this.hist.setEmpty(NO_DATA);
      return;
    }
    const s = summarizeInPlace(values); // values はソート済みになる
    const common = state.scale === 'common';
    // 全エリア共通: 階級は全エリアの最小値から 99.5%点の最大までで決め、縦軸は全エリアのコマ数の最大までにする
    const [lo, upper] = common
      ? this.histRange.get(sel, '', PRICE_KEYS, (k) => {
          const v = collectValues(sel, src(ds, k)).sort();
          return [v.length ? v[0] : Number.NaN, quantileSorted(v, 0.995)];
        })
      : [s.min, quantileSorted(values, 0.995)];
    const bins = histogramBins(lo, upper, state.distBin);
    const { start, width, nBins } = bins;
    const cap = start + nBins * width;
    const counts = histogramCounts(values, bins);
    // 全エリア共通では、どのエリアでも同じ階級を並べる（上端以上のコマが無くても「〜」の階級を残す）
    if (!common && counts[nBins] === 0) counts.pop();
    const axis = common
      ? fixedAxis(this.histCount.get(sel, state.distBin, PRICE_KEYS, (k) => [0, Math.max(...histogramCounts(collectValues(sel, src(ds, k)), bins))]))
      : {};
    // 階級幅に合わせた小数桁（0.25 刻みなら 2 桁、0.5・2.5 刻みなら 1 桁）
    const tenths = Math.round(width * 1e6) / 1e5; // width × 10（浮動小数点の誤差を除く）
    const digits = Number.isInteger(width) ? 0 : Number.isInteger(tenths) ? 1 : 2;
    const labels = counts.map((_, k) => (k === nBins ? `${fmtNum(cap, digits)}〜` : fmtNum(start + k * width, digits)));
    const ranges = counts.map((_, k) =>
      k === nBins ? `${fmtNum(cap, digits)} 円以上` : `${fmtNum(start + k * width, digits)}〜${fmtNum(start + (k + 1) * width, digits)} 円未満`,
    );
    this.hist.setSubtitle(
      `${describeSelection(sel, state)}・${SERIES_LABEL[state.focus]}・平均 ${fmtPrice(s.mean)}・中央値 ${fmtPrice(s.median)}・10〜90%点 ${fmtPrice(s.p10)}〜${fmtPrice(s.p90)} 円/kWh${common ? '・軸は全エリア共通' : ''}`,
    );
    this.hist.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip: {
          trigger: 'item',
          formatter: (p: { dataIndex: number }) =>
            ttHeader(ranges[p.dataIndex]) +
            ttRow(t.cat[0], `${fmtNum(counts[p.dataIndex])} コマ`, `全体の ${fmtPct(counts[p.dataIndex] / values.length)}`, 'rect'),
        },
        xAxis: { type: 'category', data: labels, name: `価格帯（${PRICE_UNIT}）`, nameLocation: 'middle', nameGap: 26 },
        yAxis: valueAxis('コマ数', axis),
        series: [
          {
            type: 'bar',
            data: counts,
            barCategoryGap: 2,
            itemStyle: { color: t.cat[0], borderRadius: [3, 3, 0, 0] },
            emphasis: { itemStyle: { color: withAlpha(t.cat[0], 0.75) } },
          },
        ],
      },
      {
        columns: ['価格帯（円/kWh）', 'コマ数', '割合（%）'],
        rows: counts.map((c, k) => [ranges[k], c, (c / values.length) * 100]),
        digits: [null, 0, 2],
        filename: `jepx_histogram_${state.focus}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderDuration(): void {
    const { sel, ds, state, theme } = this.ctx;
    const keys = state.series;
    const STEPS = 200;
    const curves = keys.map((k) => {
      const v = collectValues(sel, src(ds, k)).slice().sort();
      return Array.from({ length: STEPS + 1 }, (_, i) => {
        const q = i / STEPS;
        return [q * 100, v.length ? quantileSorted(v, 1 - q) : Number.NaN] as [number, number];
      });
    });
    const common = state.scale === 'common';
    // 全エリア共通: システムプライスと各エリアの値がすべて入る範囲（表示していない系列も含める）
    const axis = common ? fixedAxis(this.durationRange.get(sel, '', PRICE_KEYS, (k) => valueRange([collectValues(sel, src(ds, k))]))) : {};
    const ends = endLabels(keys.map((k) => SERIES_SHORT[k]), curves.map((c) => c.map((p) => p[1])), theme, 240, axis);
    this.duration.setSubtitle(
      `${describeSelection(sel, state)}・30分値を高い順に並べたときの価格（横軸は時間の割合）${common ? '・縦軸は全エリア共通' : ''}`,
    );
    this.duration.setOption(
      {
        grid: grid({ right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: {
          trigger: 'axis',
          formatter: axisTooltip(keys, theme, (p) => `高い方から ${fmtNum(p.value[0], 1)}% の時点`),
        },
        xAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } },
        yAxis: valueAxis(PRICE_UNIT, axis),
        series: keys.map((k, i) => lineSeries(k, theme, curves[i], ends[i])),
      },
      {
        columns: ['時間の割合（%）', ...keys.map((k) => `${SERIES_LABEL[k]}（${PRICE_UNIT}）`)],
        rows: curves[0].filter((_, i) => i % 2 === 0).map(([x], r) => [x, ...curves.map((c) => c[r * 2][1])]),
        digits: [1, ...keys.map(() => 2)],
        filename: `jepx_duration_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderBox(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const group = state.distGroup;
    const common = state.scale === 'common' && group !== 'area';
    let labels: string[];
    let valuesPerGroup: number[][];
    let axis: FixedAxis = {};

    if (group === 'area') {
      const keys: SeriesKey[] = ['system', ...AREAS.map((a) => a.key)];
      labels = keys.map((k) => SERIES_SHORT[k]);
      valuesPerGroup = keys.map((k) => Array.from(collectValues(sel, src(ds, k))));
    } else {
      let groupOf: (i: number, s: number) => number;
      let n: number;
      if (group === 'month' || group === 'fy') {
        const periods = buildPeriods(sel, group);
        groupOf = (i) => periods.ofDay[i];
        n = periods.starts.length;
        labels = periods.starts.map((d) => (group === 'month' ? monthLabel(d) : `${fiscalYearOfDay(d)}年度`));
      } else if (group === 'dow') {
        groupOf = (i) => (ds.holiday[i] ? 7 : (ds.dow[i] + 6) % 7);
        n = 8;
        labels = DOW_COLUMNS;
      } else {
        groupOf = (_i, s) => Math.floor(s / 2);
        n = 24;
        labels = Array.from({ length: 24 }, (_, h) => `${h}時`);
      }
      const valuesOf = (k: PriceKey) => aggregate(sel, src(ds, k), groupOf, n, true).values!;
      valuesPerGroup = valuesOf(state.focus);
      // 全エリア共通: システムプライスと各エリアのひげがすべて入る範囲
      if (common) axis = fixedAxis(this.boxRange.get(sel, group, PRICE_KEYS, (k) => whiskerRange(valuesOf(k))));
    }

    const stats = valuesPerGroup.map((vals) => {
      const v = Float64Array.from(vals).sort();
      if (v.length === 0) return null;
      let sum = 0;
      for (const x of v) sum += x;
      return {
        p10: quantileSorted(v, 0.1),
        p25: quantileSorted(v, 0.25),
        med: quantileSorted(v, 0.5),
        p75: quantileSorted(v, 0.75),
        p90: quantileSorted(v, 0.9),
        mean: sum / v.length,
        n: v.length,
      };
    });
    const target = group === 'area' ? '全エリア' : SERIES_LABEL[state.focus];
    this.box.setSubtitle(
      `${describeSelection(sel, state)}・${target}・箱は 25〜75%点、ひげは 10〜90%点、中の線は中央値${common ? '・縦軸は全エリア共通' : ''}`,
    );
    this.box.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip: {
          trigger: 'item',
          formatter: (p: { dataIndex: number }) => {
            const s = stats[p.dataIndex];
            if (!s) return '';
            return (
              ttHeader(`${labels[p.dataIndex]}（${fmtNum(s.n)} コマ）`) +
              [
                ['90%点', s.p90],
                ['75%点', s.p75],
                ['中央値', s.med],
                ['25%点', s.p25],
                ['10%点', s.p10],
                ['平均', s.mean],
              ]
                .map(([l, v]) => ttRow(t.cat[0], priceText(v as number), l as string, 'none'))
                .join('')
            );
          },
        },
        xAxis: { type: 'category', data: labels, axisLabel: { hideOverlap: true } },
        yAxis: valueAxis(PRICE_UNIT, axis),
        series: [
          {
            type: 'boxplot',
            data: stats.map((s) => (s ? [s.p10, s.p25, s.med, s.p75, s.p90] : [])),
            boxWidth: [3, 24],
            itemStyle: { color: withAlpha(t.cat[0], t.fillAlpha), borderColor: t.cat[0], borderWidth: 1.5 },
            emphasis: { itemStyle: { borderWidth: 2, color: withAlpha(t.cat[0], t.fillAlpha * 1.8) } },
          },
        ],
      },
      {
        columns: ['グループ', 'コマ数', '10%点', '25%点', '中央値', '75%点', '90%点', '平均'],
        rows: stats.map((s, k) => (s ? [labels[k], s.n, s.p10, s.p25, s.med, s.p75, s.p90, s.mean] : [labels[k], 0, '', '', '', '', '', ''])),
        digits: [null, 0, 2, 2, 2, 2, 2, 2],
        filename: `jepx_box_${group}_${rangeTag(sel)}.csv`,
      },
    );
  }
}

/** ヒストグラムの階級（start から width 刻みで nBins 個。最後の階級の上端以上は「〜」の階級にまとめる） */
export interface Bins {
  start: number;
  width: number;
  nBins: number;
}

/** 最小値から上端（99.5%点）までを階級に分ける。bin は「自動」（約 40 個に分ける幅）か階級の幅（円） */
export function histogramBins(min: number, upper: number, bin: string): Bins {
  const width = bin === 'auto' ? Math.max(0.1, niceStep((upper - min) / 40)) : Number(bin);
  const start = Math.floor(min / width) * width;
  return { start, width, nBins: Math.max(1, Math.ceil((upper - start) / width)) };
}

/** 階級ごとのコマ数（長さ nBins + 1。最後は上端以上のコマ数） */
export function histogramCounts(values: ArrayLike<number>, b: Bins): number[] {
  const cap = b.start + b.nBins * b.width;
  const counts = new Array<number>(b.nBins + 1).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    counts[v >= cap ? b.nBins : Math.min(b.nBins - 1, Math.max(0, Math.floor((v - b.start) / b.width)))]++;
  }
  return counts;
}
