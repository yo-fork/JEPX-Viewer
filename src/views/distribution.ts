/**
 * 分布：30 分値の価格がどの水準にどれだけあるか（ヒストグラム・価格持続曲線・グループ別の箱ひげ図）。
 */
import { aggregate, buildPeriods, collectValues, src } from '../lib/aggregate';
import { fiscalYearOfDay } from '../lib/dates';
import { fmtNum, fmtPct, fmtPrice } from '../lib/format';
import { AREAS, PRICE_KEYS, SERIES_LABEL, SERIES_SHORT, type PriceKey, type SeriesKey } from '../lib/series';
import { niceStep, quantileSorted, summarizeInPlace } from '../lib/stats';
import type { DistGroup } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import {
  axisTooltip,
  describeSelection,
  endLabels,
  grid,
  labelRoom,
  seriesLegend,
  lineSeries,
  monthLabel,
  PRICE_UNIT,
  priceText,
  rangeTag,
  valueAxis,
  withAlpha,
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
  private hist!: ChartCard;
  private duration!: ChartCard;
  private box!: ChartCard;

  protected build(): void {
    const s = this.ctx.state;
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.bin = selectField('階級の幅', BIN_OPTIONS, s.distBin, (v) => this.set({ distBin: v }));
    this.group = segmented('箱ひげ図のグループ', GROUP_OPTIONS, s.distGroup, (v) => this.set({ distGroup: v }));
    this.root.append(toolbar(this.focus.el, this.bin.el, this.group.el));
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
    const upper = quantileSorted(values, 0.995);
    const width = state.distBin === 'auto' ? Math.max(0.1, niceStep((upper - s.min) / 40)) : Number(state.distBin);
    const start = Math.floor(s.min / width) * width;
    const nBins = Math.max(1, Math.ceil((upper - start) / width));
    const cap = start + nBins * width;
    const counts = new Array<number>(nBins + 1).fill(0);
    for (const v of values) {
      const k = v >= cap ? nBins : Math.min(nBins - 1, Math.floor((v - start) / width));
      counts[k]++;
    }
    const overflow = counts[nBins];
    if (overflow === 0) counts.pop();
    // 階級幅に合わせた小数桁（0.25 刻みなら 2 桁、0.5・2.5 刻みなら 1 桁）
    const tenths = Math.round(width * 1e6) / 1e5; // width × 10（浮動小数点の誤差を除く）
    const digits = Number.isInteger(width) ? 0 : Number.isInteger(tenths) ? 1 : 2;
    const labels = counts.map((_, k) => (k === nBins ? `${fmtNum(cap, digits)}〜` : fmtNum(start + k * width, digits)));
    const ranges = counts.map((_, k) =>
      k === nBins ? `${fmtNum(cap, digits)} 円以上` : `${fmtNum(start + k * width, digits)}〜${fmtNum(start + (k + 1) * width, digits)} 円未満`,
    );
    this.hist.setSubtitle(
      `${describeSelection(sel, state)}・${SERIES_LABEL[state.focus]}・平均 ${fmtPrice(s.mean)}・中央値 ${fmtPrice(s.median)}・10〜90%点 ${fmtPrice(s.p10)}〜${fmtPrice(s.p90)} 円/kWh`,
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
        yAxis: valueAxis('コマ数'),
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
    const ends = endLabels(keys.map((k) => SERIES_SHORT[k]), curves.map((c) => c.map((p) => p[1])), theme, 240);
    this.duration.setSubtitle(`${describeSelection(sel, state)}・30分値を高い順に並べたときの価格（横軸は時間の割合）`);
    this.duration.setOption(
      {
        grid: grid({ right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: {
          trigger: 'axis',
          formatter: axisTooltip(keys, theme, (p) => `高い方から ${fmtNum(p.value[0], 1)}% の時点`),
        },
        xAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%' }, splitLine: { show: false } },
        yAxis: valueAxis(),
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
    let labels: string[];
    let valuesPerGroup: number[][];

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
      const g = aggregate(sel, src(ds, state.focus), groupOf, n, true);
      valuesPerGroup = g.values!;
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
    this.box.setSubtitle(`${describeSelection(sel, state)}・${target}・箱は 25〜75%点、ひげは 10〜90%点、中の線は中央値`);
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
        yAxis: valueAxis(),
        series: [
          {
            type: 'boxplot',
            data: stats.map((s) => (s ? [s.p10, s.p25, s.med, s.p75, s.p90] : [])),
            boxWidth: [3, 24],
            itemStyle: { color: withAlpha(t.cat[0], 0.16), borderColor: t.cat[0], borderWidth: 1.5 },
            emphasis: { itemStyle: { borderWidth: 2, color: withAlpha(t.cat[0], 0.3) } },
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
