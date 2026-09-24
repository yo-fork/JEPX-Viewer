/**
 * 推移：30 分値〜年度までの粒度で価格の時系列を見る。
 * 重ねて表示のほか、系列ごとに分割した小さな図（同じ縦軸）で東西差などを比べられる。
 */
import { src, GRANULARITY_LABEL, type Granularity } from '../lib/aggregate';
import { fmtPrice } from '../lib/format';
import { niceStep } from '../lib/stats';
import { SERIES_LABEL, SERIES_SHORT, type PriceKey } from '../lib/series';
import type { TrendGran, TrendStat } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, toolbar, type Segmented } from '../ui/controls';
import { h } from '../ui/dom';
import { seriesColor, TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { axisTooltip, describeSelection, endLabels, grid, labelRoom, lineSeries, PRICE_UNIT, priceText, rangeTag, seriesLegend, styledLine, valueAxis } from './common';
import { autoGranularity, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL, type SeriesPoints } from './timeseries';

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

export class TrendView extends View {
  private gran!: Segmented<TrendGran>;
  private stat!: Segmented<TrendStat>;
  private split!: Segmented<'overlay' | 'split'>;
  private note!: HTMLElement;
  private chart!: ChartCard;

  protected build(): void {
    const s = this.ctx.state;
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
    this.root.append(toolbar(this.gran.el, this.stat.el, this.split.el));
    this.note = h('p', { class: 'view-note' });
    this.root.append(this.note);
    const g = this.grid();
    this.chart = this.card(g, { title: '価格の推移', height: 440, wide: true });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.gran.set(state.trendGran);
    this.stat.set(state.trendStat);
    this.split.set(state.trendSplit ? 'split' : 'overlay');
    if (sel.days.length === 0) {
      this.chart.setEmpty(NO_DATA);
      this.note.textContent = '';
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

    const keys = state.series;
    const withRange = keys.length === 1 && gran !== 'slot' && stat === 'mean';
    const data = buildSeriesPoints(sel, keys.map((k) => src(this.ctx.ds, k)), gran, stat, withRange);
    const table = {
      columns: ['期間', ...keys.map((k) => `${SERIES_LABEL[k]}（${PRICE_UNIT}）`)],
      rows: data[0].points.map((p, r) => [periodLabel(p[0], gran), ...keys.map((_, i) => data[i].points[r][1])]),
      digits: [null, ...keys.map(() => 2)],
      filename: `jepx_trend_${gran}_${rangeTag(sel)}.csv`,
    };
    if (state.trendSplit && keys.length > 1) this.renderSplit(keys, data, gran, table);
    else this.renderOverlay(keys, data, gran, withRange, table);
  }

  private renderOverlay(keys: PriceKey[], data: SeriesPoints[], gran: Granularity, withRange: boolean, table: Parameters<ChartCard['setOption']>[1]): void {
    const { theme } = this.ctx;
    const t = TOKENS[theme];
    this.chart.setHeight(440);
    const ends = endLabels(keys.map((k) => SERIES_SHORT[k]), data.map((d) => d.points.map((p) => p[1])), theme, 320);
    const series: Record<string, unknown>[] = keys.map((k, i) =>
      lineSeries(k, theme, data[i].points, { sampling: 'lttb', z: k === 'system' ? 4 : 3, ...ends[i] }),
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
          areaStyle: { color, opacity: 0.12 },
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
    this.chart.setOption(
      {
        grid: grid({ bottom: 56, right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: { trigger: 'axis', formatter: tooltip },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis(),
        dataZoom: [
          { type: 'inside', throttle: 50 },
          { type: 'slider', height: 22, bottom: 8, showDetail: false, brushSelect: false, borderColor: t.border },
        ],
        series,
      },
      table,
    );
  }

  /** 系列ごとの小さな図（縦軸は共通）。エリアの図には基準としてシステムプライスを重ねる */
  private renderSplit(keys: PriceKey[], data: SeriesPoints[], gran: Granularity, table: Parameters<ChartCard['setOption']>[1]): void {
    const { theme, state } = this.ctx;
    const t = TOKENS[theme];
    const width = this.chart.el.clientWidth || 1200;
    const cols = width >= 1000 ? 3 : width >= 620 ? 2 : 1;
    const rows = Math.ceil(keys.length / cols);
    const panelH = 190;
    const gapV = 40;
    const top0 = 12;
    const sliderH = 44;
    const height = top0 + rows * (panelH + gapV) + sliderH;
    this.chart.setHeight(height);

    let max = 0;
    let min = 0;
    for (const d of data) {
      for (const [, v] of d.points) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
    }
    // 全図で共通の縦軸（きりのよい目盛り）
    const yStep = niceStep((max - Math.min(0, min)) / 3);
    const yMax = Math.ceil(max / yStep) * yStep;
    const yMin = min < 0 ? Math.floor(min / yStep) * yStep : 0;
    const sysIdx = keys.indexOf('system');
    const stat = gran === 'slot' ? 'mean' : state.trendStat;
    const sysPoints = sysIdx >= 0 ? data[sysIdx].points : buildSeriesPoints(this.ctx.sel, [src(this.ctx.ds, 'system')], gran, stat)[0].points;

    const grids: Record<string, unknown>[] = [];
    const xAxes: Record<string, unknown>[] = [];
    const yAxes: Record<string, unknown>[] = [];
    const series: Record<string, unknown>[] = [];
    const titles: Record<string, unknown>[] = [];
    const seriesKeyOf: (PriceKey | null)[] = [];
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
        style: { text: SERIES_LABEL[k], fill: t.ink, font: `600 12px ${getComputedStyle(document.body).fontFamily}` },
      });
      if (k !== 'system' && sysPoints) {
        series.push(styledLine('システム', t.neutralSeries, theme, sysPoints, false, { xAxisIndex: i, yAxisIndex: i, sampling: 'lttb', lineStyle: { width: 1, color: t.neutralSeries }, z: 2 }));
        seriesKeyOf.push('system');
      }
      series.push(lineSeries(k, theme, data[i].points, { xAxisIndex: i, yAxisIndex: i, sampling: 'lttb', z: 3 }));
      seriesKeyOf.push(k);
    });

    this.chart.setOption(
      {
        grid: grids,
        xAxis: xAxes,
        yAxis: yAxes,
        graphic: titles,
        tooltip: {
          trigger: 'axis',
          formatter: (params: { seriesIndex: number; value: [number, number] }[]) => {
            if (!params.length) return '';
            let html = ttHeader(periodLabel(params[0].value[0], gran));
            for (const p of params) {
              const key = seriesKeyOf[p.seriesIndex];
              if (!key) continue;
              html += ttRow(seriesColor(key, theme), `${fmtPrice(p.value[1])} ${PRICE_UNIT}`, SERIES_SHORT[key]);
            }
            return html;
          },
        },
        axisPointer: { link: [{ xAxisIndex: 'all' }] },
        dataZoom: [
          { type: 'inside', xAxisIndex: keys.map((_, i) => i), throttle: 50 },
          { type: 'slider', xAxisIndex: keys.map((_, i) => i), height: 22, bottom: 8, left: 16, right: 16, showDetail: false, brushSelect: false },
        ],
        series,
      },
      table,
    );
    this.chart.setSubtitle(`${describeSelection(this.ctx.sel, state)}・縦軸は全図共通（灰色の線はシステムプライス）`);
  }
}
