/**
 * 推移：30 分値〜年度までの粒度で価格の時系列を見る。
 * 重ねて表示のほか、系列ごとに分割した小さな図（同じ縦軸）で東西差などを比べられる。
 * 分割表示では、システムプライスや任意のエリアを比較用の線として各図に重ねられる。
 */
import { src, GRANULARITY_LABEL, type Granularity } from '../lib/aggregate';
import { formatDay, MS_PER_DAY } from '../lib/dates';
import { fmtPrice } from '../lib/format';
import { niceStep } from '../lib/stats';
import { PRICE_KEYS, SERIES_LABEL, SERIES_SHORT, type PriceKey } from '../lib/series';
import type { TrendGran, TrendStat } from '../state';
import type { ChartCard, TableData } from '../ui/card';
import { chipGroup, segmented, toolbar, type ChipGroup, type Segmented } from '../ui/controls';
import { h } from '../ui/dom';
import { seriesColor, seriesDashed, TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import {
  axisTooltip,
  describeSelection,
  endLabels,
  grid,
  labelRoom,
  lineLegend,
  lineSeries,
  PRICE_UNIT,
  priceText,
  rangeTag,
  seriesLegend,
  styledLine,
  valueAxis,
} from './common';
import { autoGranularity, breakGaps, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL, type SeriesPoints } from './timeseries';

const GRAN_OPTIONS: { value: TrendGran; label: string }[] = [
  { value: 'auto', label: '自動' },
  { value: 'slot', label: '30分' },
  { value: 'day', label: '日' },
  { value: 'week', label: '週' },
  { value: 'month', label: '月' },
  { value: 'fy', label: '年度' },
  { value: 'year', label: '暦年' },
];

const STAT_OPTIONS: { value: TrendStat; label: string }[] = [
  { value: 'mean', label: '平均' },
  { value: 'max', label: '最高' },
  { value: 'min', label: '最低' },
  { value: 'median', label: '中央値' },
];

const STAT_LABEL: Record<TrendStat, string> = { mean: '平均', max: '最高', min: '最低', median: '中央値' };

/** 重ね線（比較用の線）の系列名に付ける印。凡例で主線と別に表示・非表示を切り替えられる */
const REF_SUFFIX = '（重ね線）';

/**
 * スライダー・ホイールで拡大した表示範囲（時刻 ms）。粒度・集計・表示方法・系列を変えても保ち、
 * 絞り込みの期間が変わったときだけ解除する。タブを移っても残るようモジュールに置く。
 */
let zoomMemory: { from: number; to: number; start: number; end: number } | null = null;

type DataZoomState = { start?: number; end?: number; startValue?: number | string; endValue?: number | string };

export class TrendView extends View {
  private gran!: Segmented<TrendGran>;
  private stat!: Segmented<TrendStat>;
  private split!: Segmented<'overlay' | 'split'>;
  private refs!: ChipGroup<PriceKey>;
  private note!: HTMLElement;
  private zoomNote!: HTMLElement;
  private zoomText!: HTMLElement;
  private chart!: ChartCard;
  /** 直近の描画での横軸（時刻）のデータ範囲。拡大率（%）を時刻に換算するのに使う */
  private extentX: [number, number] | null = null;

  protected build(): void {
    const s = this.ctx.state;
    const theme = this.ctx.theme;
    this.gran = segmented('粒度', GRAN_OPTIONS, s.trendGran, (v) => this.set({ trendGran: v }));
    this.stat = segmented('集計', STAT_OPTIONS, s.trendStat, (v) => this.set({ trendStat: v }));
    this.split = segmented(
      '表示方法',
      [
        { value: 'overlay', label: '重ねて表示' },
        { value: 'split', label: '系列ごとに分割' },
      ],
      s.trendSplit ? 'split' : 'overlay',
      (v) => this.set({ trendSplit: v === 'split' }),
    );
    this.refs = chipGroup(
      '各図に重ねる線',
      PRICE_KEYS.map((k) => ({ value: k, label: SERIES_SHORT[k], color: seriesColor(k, theme), dashed: seriesDashed(k) })),
      s.splitRefs,
      (v) => this.set({ splitRefs: v }),
    );
    this.root.append(toolbar(this.gran.el, this.stat.el, this.split.el, this.refs.el));
    this.note = h('p', { class: 'view-note' });
    this.zoomText = h('span');
    this.zoomNote = h(
      'p',
      { class: 'view-note', hidden: true },
      this.zoomText,
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.resetZoom() }, '全体を表示'),
    );
    this.root.append(this.note, this.zoomNote);
    const g = this.grid();
    this.chart = this.card(g, { title: '価格の推移', height: 440, wide: true });
    this.chart.chart.on('datazoom', () => this.rememberZoom());
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.gran.set(state.trendGran);
    this.stat.set(state.trendStat);
    this.split.set(state.trendSplit ? 'split' : 'overlay');
    this.refs.set(state.splitRefs);
    this.refs.el.hidden = !state.trendSplit;
    if (sel.days.length === 0) {
      this.chart.setEmpty(NO_DATA);
      this.note.textContent = '';
      this.zoomNote.hidden = true;
      return;
    }
    const gran: Granularity = state.trendGran === 'auto' ? autoGranularity(sel) : state.trendGran;
    this.stat.setDisabled(gran === 'slot');
    const stat: TrendStat = gran === 'slot' ? 'mean' : state.trendStat;
    const statText = gran === 'slot' ? '30分値' : `${GRANULARITY_LABEL[gran]}ごとの${STAT_LABEL[stat]}`;
    this.chart.setSubtitle(`${describeSelection(sel, state)}・${statText}${state.trendGran === 'auto' ? '（自動）' : ''}`);
    const points = sel.days.length * sel.slots.length;
    this.note.textContent =
      gran === 'slot' && points > 20000
        ? `30分値 ${points.toLocaleString('ja-JP')} 点を表示しています。拡大（下部のスライダーやホイール）で細部を確認できます。`
        : '';

    // 期間の絞り込みが変わったら拡大は解除する
    if (zoomMemory && (zoomMemory.from !== sel.from || zoomMemory.to !== sel.to)) zoomMemory = null;

    const keys = state.series;
    const split = state.trendSplit;
    const withRange = !split && keys.length === 1 && gran !== 'slot' && stat === 'mean';
    const data = buildSeriesPoints(sel, keys.map((k) => src(this.ctx.ds, k)), gran, stat, withRange);
    const table: TableData = {
      columns: ['期間', ...keys.map((k) => `${SERIES_LABEL[k]}（${PRICE_UNIT}）`)],
      rows: data[0].points.map((p, r) => [periodLabel(p[0], gran), ...keys.map((_, i) => data[i].points[r][1])]),
      digits: [null, ...keys.map(() => 2)],
      filename: `jepx_trend_${gran}_${rangeTag(sel)}.csv`,
    };
    this.extentX = data[0].points.length ? [data[0].points[0][0], data[0].points[data[0].points.length - 1][0]] : null;
    if (split) this.renderSplit(keys, data, gran, stat, table);
    else this.renderOverlay(keys, data, gran, withRange, table);
    this.updateZoomNote();
  }

  /** dataZoom の設定（拡大していれば、その範囲を時刻で指定する） */
  private zoomRange(): { startValue: number; endValue: number } | { start: number; end: number } {
    return zoomMemory ? { startValue: zoomMemory.start, endValue: zoomMemory.end } : { start: 0, end: 100 };
  }

  /** ユーザーが拡大・移動した範囲を時刻に換算して覚える */
  private rememberZoom(): void {
    const opt = this.chart.chart.getOption() as { dataZoom?: DataZoomState[] };
    const dz = opt.dataZoom?.[0];
    if (!dz || !this.extentX) return;
    const [x0, x1] = this.extentX;
    const toMs = (v: number | string | undefined, pct: number | undefined, fallback: number) => {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof pct === 'number' && Number.isFinite(pct)) return x0 + ((x1 - x0) * pct) / 100;
      return fallback;
    };
    const start = toMs(dz.startValue, dz.start, x0);
    const end = toMs(dz.endValue, dz.end, x1);
    const full = (dz.start ?? 0) <= 0.01 && (dz.end ?? 100) >= 99.99;
    zoomMemory = full ? null : { from: this.ctx.sel.from, to: this.ctx.sel.to, start, end };
    this.updateZoomNote();
  }

  private resetZoom(): void {
    zoomMemory = null;
    this.chart.chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
    this.updateZoomNote();
  }

  private updateZoomNote(): void {
    this.zoomNote.hidden = !zoomMemory;
    if (zoomMemory) {
      const a = formatDay(Math.floor(zoomMemory.start / MS_PER_DAY));
      const b = formatDay(Math.floor(zoomMemory.end / MS_PER_DAY));
      this.zoomText.textContent = `${a}〜${b} を拡大表示中（粒度・集計・表示方法を変えても保たれます）`;
    }
  }

  private renderOverlay(keys: PriceKey[], data: SeriesPoints[], gran: Granularity, withRange: boolean, table: TableData): void {
    const { theme } = this.ctx;
    const t = TOKENS[theme];
    this.chart.setHeight(440);
    const ends = endLabels(keys.map((k) => SERIES_SHORT[k]), data.map((d) => d.points.map((p) => p[1])), theme, 320);
    const series: Record<string, unknown>[] = keys.map((k, i) =>
      lineSeries(k, theme, gran === 'slot' ? breakGaps(data[i].points) : data[i].points, { sampling: 'lttb', z: k === 'system' ? 4 : 3, ...ends[i] }),
    );
    let tooltip = axisTooltip(keys, theme, (p) => periodLabel(p.value[0], gran));
    if (withRange) {
      const d = data[0];
      const color = seriesColor(keys[0], theme);
      // 最低〜最高の帯（下端は透明、上端との差を面で塗る）
      series.unshift(
        { type: 'line', name: '_low', data: d.points.map((p, r) => [p[0], d.low![r]]), stack: 'range', symbol: 'none', lineStyle: { opacity: 0 }, silent: true, z: 1 },
        {
          type: 'line',
          name: '_band',
          data: d.points.map((p, r) => [p[0], d.high![r] - d.low![r]]),
          stack: 'range',
          symbol: 'none',
          lineStyle: { opacity: 0 },
          areaStyle: { color, opacity: t.bandAlpha },
          silent: true,
          z: 1,
        },
      );
      tooltip = (params: unknown) => {
        const ps = (params as { seriesName: string; dataIndex: number; value: [number, number] }[]).filter((p) => !p.seriesName.startsWith('_'));
        if (ps.length === 0) return '';
        const r = ps[0].dataIndex;
        return (
          ttHeader(periodLabel(ps[0].value[0], gran)) +
          ttRow(color, priceText(ps[0].value[1]), `${SERIES_SHORT[keys[0]]}（平均）`) +
          ttRow(color, priceText(d.high![r]), '最高', 'rect') +
          ttRow(color, priceText(d.low![r]), '最低', 'rect')
        );
      };
    }
    const range = this.zoomRange();
    this.chart.setOption(
      {
        grid: grid({ bottom: 56, right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: { trigger: 'axis', formatter: tooltip },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis(),
        dataZoom: [
          { type: 'inside', throttle: 50, ...range },
          { type: 'slider', height: 22, bottom: 8, showDetail: false, brushSelect: false, borderColor: t.border, ...range },
        ],
        series,
      },
      table,
    );
  }

  /**
   * 系列ごとの小さな図（縦軸は共通）。各図には「各図に重ねる線」で選んだ系列（システムプライスや
   * 他のエリア）を細い線で重ねる。重ね線は主線と同じ系列色で、凡例から表示・非表示を切り替えられる。
   */
  private renderSplit(keys: PriceKey[], data: SeriesPoints[], gran: Granularity, stat: TrendStat, table: TableData): void {
    const { theme, state, sel, ds } = this.ctx;
    const t = TOKENS[theme];
    const refs = PRICE_KEYS.filter((k) => state.splitRefs.includes(k));
    const width = this.chart.el.clientWidth || 1200;
    const cols = width >= 1000 ? 3 : width >= 620 ? 2 : 1;
    const rows = Math.ceil(keys.length / cols);
    const panelH = 190;
    const gapV = 40;
    const top0 = refs.length ? 40 : 12;
    const sliderH = 44;
    this.chart.setHeight(top0 + rows * (panelH + gapV) + sliderH);

    // 重ね線のデータ（表示系列に含まれていればそれを使い、無ければ計算する）
    const pointsOf = new Map<PriceKey, [number, number][]>(keys.map((k, i) => [k, data[i].points]));
    const missing = refs.filter((k) => !pointsOf.has(k));
    buildSeriesPoints(sel, missing.map((k) => src(ds, k)), gran, stat).forEach((d, i) => pointsOf.set(missing[i], d.points));

    // 全図で共通の縦軸（きりのよい目盛り）。重ね線も範囲に含める
    let max = 0;
    let min = 0;
    for (const k of new Set([...keys, ...refs])) {
      for (const [, v] of pointsOf.get(k)!) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    const yStep = niceStep((max - Math.min(0, min)) / 3);
    const yMax = Math.ceil(max / yStep) * yStep;
    const yMin = min < 0 ? Math.floor(min / yStep) * yStep : 0;
    const line = (pts: [number, number][]) => (gran === 'slot' ? breakGaps(pts) : pts);

    const grids: Record<string, unknown>[] = [];
    const xAxes: Record<string, unknown>[] = [];
    const yAxes: Record<string, unknown>[] = [];
    const series: Record<string, unknown>[] = [];
    const titles: Record<string, unknown>[] = [];
    const seriesKeyOf: PriceKey[] = [];
    const font = getComputedStyle(document.body).fontFamily;
    keys.forEach((k, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const leftPct = (col / cols) * 100;
      const top = top0 + row * (panelH + gapV) + 24;
      grids.push({
        left: `${leftPct + (cols > 1 ? 1 : 0)}%`,
        width: `${100 / cols - (cols > 1 ? 3 : 1)}%`,
        top,
        height: panelH - 24,
        outerBoundsMode: 'none',
        containLabel: false,
      });
      xAxes.push({ type: 'time', gridIndex: i, axisLabel: { ...TIME_AXIS_LABEL, fontSize: 10 }, splitNumber: 3 });
      yAxes.push({
        type: 'value',
        gridIndex: i,
        min: yMin,
        max: yMax,
        interval: yStep,
        axisLabel: { fontSize: 10, inside: true, verticalAlign: 'bottom', margin: 2, showMaxLabel: false },
      });
      titles.push({
        type: 'text',
        left: `${leftPct + (cols > 1 ? 1 : 0)}%`,
        top: top - 22,
        style: { text: SERIES_LABEL[k], fill: t.ink, font: `600 12px ${font}` },
      });
      // 重ね線（その図の系列自身は除く）は主線より細く、下に描く
      for (const r of refs) {
        if (r === k) continue;
        series.push(
          styledLine(`${SERIES_SHORT[r]}${REF_SUFFIX}`, seriesColor(r, theme), theme, line(pointsOf.get(r)!), seriesDashed(r), {
            xAxisIndex: i,
            yAxisIndex: i,
            sampling: 'lttb',
            lineStyle: { width: 1.25, type: seriesDashed(r) ? [5, 3] : 'solid', opacity: 0.9 },
            z: 2,
          }),
        );
        seriesKeyOf.push(r);
      }
      series.push(lineSeries(k, theme, line(pointsOf.get(k)!), { xAxisIndex: i, yAxisIndex: i, sampling: 'lttb', z: 3 }));
      seriesKeyOf.push(k);
    });

    const range = this.zoomRange();
    const axisIdx = keys.map((_, i) => i);
    this.chart.setOption(
      {
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        graphic: titles,
        legend: refs.length
          ? lineLegend(
              refs.map((r) => ({ name: `${SERIES_SHORT[r]}${REF_SUFFIX}`, dashed: seriesDashed(r) })),
              { left: 8 },
            )
          : undefined,
        tooltip: {
          trigger: 'axis',
          formatter: (params: { seriesIndex: number; value: [number, number] }[]) => {
            if (!params.length) return '';
            let html = ttHeader(periodLabel(params[0].value[0], gran));
            // 同じ系列は（主線・重ね線とも）1 回だけ表示する
            const seen = new Set<PriceKey>();
            for (const p of params) {
              const key = seriesKeyOf[p.seriesIndex];
              if (!key || seen.has(key)) continue;
              seen.add(key);
              html += ttRow(seriesColor(key, theme), `${fmtPrice(p.value[1])} ${PRICE_UNIT}`, SERIES_SHORT[key], seriesDashed(key) ? 'dash' : 'line');
            }
            return html;
          },
        },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        dataZoom: [
          { type: 'inside', xAxisIndex: axisIdx, throttle: 50, ...range },
          { type: 'slider', xAxisIndex: axisIdx, height: 22, bottom: 8, left: 16, right: 16, showDetail: false, brushSelect: false, ...range },
        ],
        series,
      },
      table,
    );
    const refText = refs.length ? `各図に重ねた細い線: ${refs.map((r) => SERIES_SHORT[r]).join('・')}` : '重ね線なし';
    this.chart.setSubtitle(`${describeSelection(sel, state)}・縦軸は全図共通・${refText}`);
  }
}
