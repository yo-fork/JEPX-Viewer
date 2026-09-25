/**
 * ヒートマップ：日付×時間帯・月×時間帯・曜日×時間帯・年度×月の格子で価格の濃淡を見る。
 * 値は単一色相の濃淡（高いほど濃い）。システムプライスとの差を見るときは青（安い）↔赤（高い）の発散色。
 */
import { aggregate, buildPeriods, FISCAL_MONTH_LABELS, fiscalMonthIndex, src, type Source } from '../lib/aggregate';
import { formatDay, slotRangeLabel, slotStartLabel } from '../lib/dates';
import { fmtPrice, fmtSigned } from '../lib/format';
import { AREA_KEYS, PRICE_KEYS, SERIES_LABEL, SLOTS, type PriceKey } from '../lib/series';
import type { Selection } from '../lib/select';
import { accMean, quantileSorted } from '../lib/stats';
import type { HeatKind, ScaleMode } from '../state';
import type { ChartCard, TableData } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { TOKENS, type ThemeName } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { CommonRange, describeSelection, monthLabel, PRICE_UNIT, rangeTag, SCALE_OPTIONS } from './common';

const DOW_COLUMNS = ['月', '火', '水', '木', '金', '土', '日', '祝日'];
const MAX_DAILY_COLUMNS = 800;

export interface Grid {
  xLabels: string[];
  /** ツールチップ用の詳しい列名 */
  xTitles: string[];
  yLabels: string[];
  yTitles: string[];
  /** [x, y, value] */
  cells: [number, number, number][];
  /** y 軸を上から時刻順に並べる */
  yIsSlot: boolean;
  note?: string;
}

export class HeatmapView extends View {
  private kind!: Segmented<HeatKind>;
  private focus!: SelectField<PriceKey>;
  private value!: Segmented<'price' | 'spread'>;
  private scale!: Segmented<ScaleMode>;
  private chart!: ChartCard;
  private readonly common = new CommonRange();

  protected build(): void {
    const s = this.ctx.state;
    this.kind = segmented(
      '格子',
      [
        { value: 'dateSlot', label: '日付 × 時間帯' },
        { value: 'monthSlot', label: '月 × 時間帯' },
        { value: 'dowSlot', label: '曜日 × 時間帯' },
        { value: 'fyMonth', label: '年度 × 月' },
      ],
      s.heatKind,
      (v) => this.set({ heatKind: v }),
    );
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.value = segmented(
      '値',
      [
        { value: 'price', label: '価格' },
        { value: 'spread', label: 'システムプライスとの差' },
      ],
      s.heatSpread ? 'spread' : 'price',
      (v) => this.set({ heatSpread: v === 'spread' }),
    );
    this.scale = segmented('色の範囲', SCALE_OPTIONS, s.scale, (v) => this.set({ scale: v }));
    this.root.append(toolbar(this.kind.el, this.focus.el, this.value.el, this.scale.el));
    const g = this.grid();
    this.chart = this.card(g, { title: 'ヒートマップ', height: 560, wide: true });
  }

  protected render(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    this.kind.set(state.heatKind);
    this.focus.set(state.focus);
    const spreadAllowed = state.focus !== 'system';
    this.value.setDisabled(!spreadAllowed);
    const spread = state.heatSpread && spreadAllowed;
    this.value.set(spread ? 'spread' : 'price');
    this.scale.set(state.scale);
    if (sel.days.length === 0) {
      this.chart.setEmpty(NO_DATA);
      return;
    }
    const sourceOf = (k: PriceKey) => (spread ? src(ds, k, 'system') : src(ds, k));
    const g = buildGrid(sel, sourceOf(state.focus), state.heatKind);
    if (g.cells.length === 0) {
      this.chart.setEmpty(NO_DATA);
      return;
    }

    const common = state.scale === 'common';
    const valueLabel = spread ? `${SERIES_LABEL[state.focus]} − システムプライス` : SERIES_LABEL[state.focus];
    this.chart.setSubtitle(
      `${describeSelection(sel, state)}・${valueLabel}（${PRICE_UNIT}）${g.note ? `・${g.note}` : ''}${common ? '・色の範囲は全エリア共通' : ''}`,
    );

    // 全エリア共通: システムプライスと各エリア（差を見るときは各エリア）の色の範囲をすべて含む範囲
    const [min, max] = common
      ? this.common.get(sel, `${state.heatKind}|${spread}`, spread ? AREA_KEYS : PRICE_KEYS, (k) =>
          colorRange(buildGrid(sel, sourceOf(k), state.heatKind), spread),
        )
      : colorRange(g, spread);
    this.chart.setHeight(heatmapHeight(g));
    const fmt = spread ? (v: number) => `${fmtSigned(v)} 円` : (v: number) => `${fmtPrice(v)} ${PRICE_UNIT}`;

    this.chart.setOption(
      heatmapOption(g, { theme, min, max, colors: spread ? t.div : t.seq, precision: spread ? 1 : 0, fmt, valueLabel }),
      gridTable(g, `jepx_heatmap_${state.heatKind}_${state.focus}${spread ? '_spread' : ''}_${rangeTag(sel)}.csv`),
    );
  }
}

export function buildGrid(sel: Selection, source: Source, kind: HeatKind): Grid {
  const ds = sel.ds;
  const slotLabels = sel.slots.map(slotStartLabel);
  const slotTitles = sel.slots.map(slotRangeLabel);
  const slotRow = new Int32Array(SLOTS).fill(-1);
  sel.slots.forEach((s, r) => (slotRow[s] = r));

  if (kind === 'dateSlot' && sel.days.length <= MAX_DAILY_COLUMNS) {
    const cells: [number, number, number][] = [];
    const { a, b } = source;
    sel.days.forEach((i, x) => {
      for (const s of sel.slots) {
        let v = a[i * SLOTS + s];
        if (b) v -= b[i * SLOTS + s];
        if (!Number.isNaN(v)) cells.push([x, slotRow[s], v]);
      }
    });
    const days = [...sel.days].map((i) => ds.start + i);
    return {
      xLabels: days.map((d) => formatDay(d)),
      xTitles: days.map((d) => formatDay(d, true)),
      yLabels: slotLabels,
      yTitles: slotTitles,
      cells,
      yIsSlot: true,
    };
  }

  if (kind === 'dateSlot' || kind === 'monthSlot') {
    const gran = kind === 'dateSlot' ? 'week' : 'month';
    const periods = buildPeriods(sel, gran);
    const g = aggregate(sel, source, (i, s) => periods.ofDay[i] * SLOTS + s, periods.starts.length * SLOTS);
    const cells: [number, number, number][] = [];
    periods.starts.forEach((_, x) => {
      for (const s of sel.slots) {
        const acc = g.acc[x * SLOTS + s];
        if (acc.n > 0) cells.push([x, slotRow[s], accMean(acc)]);
      }
    });
    const labels = periods.starts.map((d) => (gran === 'week' ? formatDay(d) : monthLabel(d)));
    return {
      xLabels: labels,
      xTitles: periods.starts.map((d) => (gran === 'week' ? `${formatDay(d)}〜${formatDay(d + 6)} の週平均` : `${monthLabel(d)} の平均`)),
      yLabels: slotLabels,
      yTitles: slotTitles,
      cells,
      yIsSlot: true,
      note: kind === 'dateSlot' ? `期間が長いため週平均で表示（${MAX_DAILY_COLUMNS} 日以下で日別表示）` : undefined,
    };
  }

  if (kind === 'dowSlot') {
    const col = (i: number) => (ds.holiday[i] ? 7 : (ds.dow[i] + 6) % 7);
    const g = aggregate(sel, source, (i, s) => col(i) * SLOTS + s, 8 * SLOTS);
    const cells: [number, number, number][] = [];
    for (let x = 0; x < 8; x++) {
      for (const s of sel.slots) {
        const acc = g.acc[x * SLOTS + s];
        if (acc.n > 0) cells.push([x, slotRow[s], accMean(acc)]);
      }
    }
    return {
      xLabels: DOW_COLUMNS,
      xTitles: DOW_COLUMNS.map((d) => (d === '祝日' ? '祝日・休日の平均' : `${d}曜日の平均（祝日を除く）`)),
      yLabels: slotLabels,
      yTitles: slotTitles,
      cells,
      yIsSlot: true,
    };
  }

  // 年度 × 月
  const fys = [...new Set([...sel.days].map((i) => ds.fy[i]))].sort((x, y) => x - y);
  const fyRow = new Map(fys.map((fy, r) => [fy, r]));
  const g = aggregate(sel, source, (i) => fyRow.get(ds.fy[i])! * 12 + fiscalMonthIndex(ds.m[i]), fys.length * 12);
  const cells: [number, number, number][] = [];
  fys.forEach((_, r) => {
    for (let x = 0; x < 12; x++) {
      const acc = g.acc[r * 12 + x];
      if (acc.n > 0) cells.push([x, r, accMean(acc)]);
    }
  });
  return {
    xLabels: FISCAL_MONTH_LABELS,
    xTitles: FISCAL_MONTH_LABELS.map((m) => `${m}の平均`),
    yLabels: fys.map((fy) => `${fy}年度`),
    yTitles: fys.map((fy) => `${fy}年度`),
    cells,
    yIsSlot: false,
  };
}

/** 格子をそのまま表に（行 = 横軸の項目、列 = 縦軸の項目） */
export function gridTable(g: Grid, filename: string): TableData {
  const rows: (string | number)[][] = g.xLabels.map((x) => [x, ...g.yLabels.map(() => '')]);
  for (const [x, y, v] of g.cells) rows[x][y + 1] = v;
  return { columns: ['', ...g.yLabels], rows, digits: [null, ...g.yLabels.map(() => 2)], filename };
}

/** 色の範囲: 外れ値に引っ張られないよう 1〜99% 点（symmetric なら 0 を中心に対称、そうでなければ整数に丸める） */
export function colorRange(g: Grid, symmetric: boolean, round = true): [number, number] {
  const sorted = Float64Array.from(g.cells.map((c) => c[2])).sort();
  let min = quantileSorted(sorted, 0.01);
  let max = quantileSorted(sorted, 0.99);
  if (symmetric) {
    const a = Math.max(Math.abs(min), Math.abs(max), 0.5);
    return [-a, a];
  }
  if (!round) return [min, max > min ? max : min + 1];
  min = Math.max(0, Math.floor(min));
  max = Math.max(min + 1, Math.ceil(max));
  return [min, max];
}

/** 格子の行数に合わせたグラフの高さ */
export function heatmapHeight(g: Grid): number {
  const rowH = g.yIsSlot ? Math.max(6, Math.min(12, 480 / g.yLabels.length)) : 30;
  return Math.round(g.yLabels.length * rowH + 110);
}

export function heatmapOption(
  g: Grid,
  o: { theme: ThemeName; min: number; max: number; colors: string[]; precision: number; fmt: (v: number) => string; valueLabel: string },
): Record<string, unknown> {
  const t = TOKENS[o.theme];
  const dense = g.xLabels.length > 60;
  return {
    grid: { left: 8, right: 16, top: 48, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    tooltip: {
      trigger: 'item',
      formatter: (p: { value: [number, number, number] }) => {
        const [x, y, v] = p.value;
        return ttHeader(`${g.xTitles[x]}・${g.yTitles[y]}`) + ttRow(t.ink2, o.fmt(v), o.valueLabel, 'none');
      },
    },
    xAxis: {
      type: 'category',
      data: g.xLabels,
      splitArea: { show: false },
      axisLabel: { hideOverlap: true },
      axisLine: { show: false },
    },
    yAxis: {
      type: 'category',
      data: g.yLabels,
      inverse: true,
      axisLine: { show: false },
      axisLabel: g.yIsSlot ? { interval: (i: number) => g.yLabels[i].endsWith(':00') && Number(g.yLabels[i].slice(0, 2)) % 3 === 0 } : {},
    },
    visualMap: {
      type: 'continuous',
      min: o.min,
      max: o.max,
      calculable: true,
      orient: 'horizontal',
      right: 8,
      top: 0,
      itemWidth: 12,
      itemHeight: 200,
      precision: o.precision,
      inRange: { color: o.colors },
      textStyle: { color: t.muted, fontSize: 11 },
    },
    series: [
      {
        type: 'heatmap',
        data: g.cells,
        progressive: 0,
        itemStyle: dense ? { borderWidth: 0 } : { borderColor: t.surface, borderWidth: g.yIsSlot ? 1 : 2 },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
      },
    ],
  };
}
