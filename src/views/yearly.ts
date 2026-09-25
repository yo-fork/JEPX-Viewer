/**
 * 年度比較：同じ月どうしを年度で重ね、年度ごとの水準とエリア別の平均を比べる。
 */
import { aggregate, FISCAL_MONTH_LABELS, fiscalMonthIndex, src } from '../lib/aggregate';
import { fmtNum, fmtPrice } from '../lib/format';
import { PRICE_KEYS, SERIES_LABEL, SERIES_SHORT, type PriceKey } from '../lib/series';
import { accMean, accStd } from '../lib/stats';
import { fiscalYearsIn, type ScaleMode, type YearMetric } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { h } from '../ui/dom';
import { ordinalColors, TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import {
  CommonRange,
  describeSelection,
  endLabels,
  fixedAxis,
  grid,
  labelOnSeq,
  labelRoom,
  lineLegend,
  PRICE_UNIT,
  rangeTag,
  SCALE_OPTIONS,
  styledLine,
  valueAxis,
  valueRange,
} from './common';

const METRICS: { value: YearMetric; label: string }[] = [
  { value: 'mean', label: '月平均' },
  { value: 'max', label: '月最高' },
  { value: 'min', label: '月最低' },
  { value: 'floor', label: '0.01円のコマ数' },
];
const FY_COLORED = 5;

export class YearlyView extends View {
  private focus!: SelectField<PriceKey>;
  private metric!: Segmented<YearMetric>;
  private scale!: Segmented<ScaleMode>;
  private months!: ChartCard;
  private fyBars!: ChartCard;
  private fyAreas!: ChartCard;
  private hint!: HTMLElement;
  private readonly monthsRange = new CommonRange();
  private readonly fyRange = new CommonRange();

  protected build(): void {
    const s = this.ctx.state;
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.metric = segmented('指標', METRICS, s.yearMetric, (v) => this.set({ yearMetric: v }));
    this.scale = segmented('軸の範囲', SCALE_OPTIONS, s.scale, (v) => this.set({ scale: v }));
    this.root.append(toolbar(this.focus.el, this.metric.el, this.scale.el));
    this.hint = h(
      'p',
      { class: 'view-note', hidden: true },
      '期間内の年度が少ないため比較できる年度が限られます。',
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.set({ preset: 'all' }) }, '全期間で比較する'),
    );
    this.root.append(this.hint);
    const g = this.grid();
    this.months = this.card(g, { title: '月別の推移（年度比較）', height: 360, wide: true });
    this.fyBars = this.card(g, { title: '年度別の平均価格', height: 320 });
    this.fyAreas = this.card(g, { title: '年度 × エリアの平均価格', height: 320 });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.focus.set(state.focus);
    this.metric.set(state.yearMetric);
    this.scale.set(state.scale);
    if (sel.days.length === 0) {
      [this.months, this.fyBars, this.fyAreas].forEach((c) => c.setEmpty(NO_DATA));
      return;
    }
    const fys = [...new Set([...sel.days].map((i) => sel.ds.fy[i]))].sort((a, b) => a - b);
    const available = fiscalYearsIn(this.ctx.extent).length;
    this.hint.hidden = !(fys.length <= 2 && available > fys.length);
    this.renderMonths(fys);
    this.renderFyBars(fys);
    this.renderFyAreas(fys);
  }

  /** key の、年度（fys の順）ごとの 12 か月（4 月〜3 月）の指標の値 */
  private monthValues(key: PriceKey, fys: number[]): number[][] {
    const { sel, ds, state } = this.ctx;
    const row = new Map(fys.map((fy, k) => [fy, k]));
    const g = aggregate(sel, src(ds, key), (i) => row.get(ds.fy[i])! * 12 + fiscalMonthIndex(ds.m[i]), fys.length * 12);
    const metric = state.yearMetric;
    const value = (k: number) => {
      const acc = g.acc[k];
      if (acc.n === 0) return Number.NaN;
      return metric === 'mean' ? accMean(acc) : metric === 'max' ? acc.max : metric === 'min' ? acc.min : g.floor[k];
    };
    return fys.map((_, r) => Array.from({ length: 12 }, (_, m) => value(r * 12 + m)));
  }

  private renderMonths(fys: number[]): void {
    const { sel, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const metric = state.yearMetric;
    const values = this.monthValues(state.focus, fys);
    const common = state.scale === 'common';
    // 全エリア共通: システムプライスと各エリアの値がすべて入る範囲
    const axis = common ? fixedAxis(this.monthsRange.get(sel, metric, PRICE_KEYS, (k) => valueRange(this.monthValues(k, fys)))) : {};
    const colored = fys.slice(-FY_COLORED);
    const ramp = ordinalColors(colored.length, theme);
    const lines = fys.map((fy, r) => {
      const c = colored.indexOf(fy);
      return {
        name: `${fy}年度`,
        color: c >= 0 ? ramp[c] : t.deemph,
        muted: c < 0,
        values: values[r],
      };
    });
    const unit = metric === 'floor' ? 'コマ' : PRICE_UNIT;
    const fmt = (v: number) => (metric === 'floor' ? `${fmtNum(v)} コマ` : `${fmtPrice(v)} ${PRICE_UNIT}`);
    const mutedN = lines.filter((l) => l.muted).length;
    const ends = endLabels(lines.map((l) => l.name), lines.map((l) => l.values), theme, 260, axis);
    this.months.setSubtitle(
      `${describeSelection(sel, state)}・${SERIES_LABEL[state.focus]}の${METRICS.find((m) => m.value === metric)!.label}・${theme === 'light' ? '色が濃い' : '色が明るい'}ほど新しい年度${mutedN ? `（灰色は古い ${mutedN} 年度）` : ''}${common ? '・縦軸は全エリア共通' : ''}`,
    );
    this.months.setOption(
      {
        grid: grid({ right: labelRoom(lines.length) }),
        legend: lineLegend(lines),
        tooltip: {
          trigger: 'axis',
          formatter: (params: { seriesIndex: number; dataIndex: number }[]) => {
            if (!params.length) return '';
            let html = ttHeader(FISCAL_MONTH_LABELS[params[0].dataIndex]);
            for (const p of [...params].reverse()) {
              const l = lines[p.seriesIndex];
              html += ttRow(l.color, fmt(l.values[p.dataIndex]), l.name);
            }
            return html;
          },
        },
        xAxis: { type: 'category', data: FISCAL_MONTH_LABELS, boundaryGap: false },
        yAxis: valueAxis(unit, axis),
        series: lines.map((l, i) =>
          styledLine(l.name, l.color, theme, l.values, false, {
            z: l.muted ? 1 : 2 + i,
            lineStyle: { width: l.muted ? 1 : 2 },
            ...ends[i],
          }),
        ),
      },
      {
        columns: ['年度', ...FISCAL_MONTH_LABELS.map((m) => `${m}（${unit}）`)],
        rows: lines.map((l) => [l.name, ...l.values]),
        digits: [null, ...FISCAL_MONTH_LABELS.map(() => (metric === 'floor' ? 0 : 2))],
        filename: `jepx_yearly_months_${state.focus}_${metric}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderFyBars(fys: number[]): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const row = new Map(fys.map((fy, k) => [fy, k]));
    const byFy = (k: PriceKey) => aggregate(sel, src(ds, k), (i) => row.get(ds.fy[i])!, fys.length);
    const g = byFy(state.focus);
    const means = fys.map((_, k) => accMean(g.acc[k]));
    const days = fys.map((fy) => [...sel.days].filter((i) => ds.fy[i] === fy).length);
    const common = state.scale === 'common';
    // 全エリア共通: システムプライスと各エリアの年度別の平均がすべて入る範囲
    const axis = common ? fixedAxis(this.fyRange.get(sel, '', PRICE_KEYS, (k) => valueRange([byFy(k).acc.map(accMean)]))) : {};
    this.fyBars.setSubtitle(`${describeSelection(sel, state)}・${SERIES_LABEL[state.focus]}（期間内の日のみで集計）${common ? '・縦軸は全エリア共通' : ''}`);
    this.fyBars.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip: {
          trigger: 'item',
          formatter: (p: { dataIndex: number }) => {
            const k = p.dataIndex;
            const acc = g.acc[k];
            return (
              ttHeader(`${fys[k]}年度（${days[k]} 日）`) +
              ttRow(t.cat[0], `${fmtPrice(means[k])} ${PRICE_UNIT}`, '平均', 'rect') +
              ttRow(t.cat[0], `${fmtPrice(acc.max)} ${PRICE_UNIT}`, '最高', 'none') +
              ttRow(t.cat[0], `${fmtPrice(acc.min)} ${PRICE_UNIT}`, '最低', 'none') +
              ttRow(t.cat[0], `${fmtNum(g.floor[k])} コマ`, '0.01 円', 'none')
            );
          },
        },
        xAxis: { type: 'category', data: fys.map((fy) => `${fy}`), axisLabel: { hideOverlap: true, formatter: '{value}年度' } },
        yAxis: valueAxis(PRICE_UNIT, axis),
        series: [
          {
            type: 'bar',
            data: means,
            barMaxWidth: 24,
            itemStyle: { color: t.cat[0], borderRadius: [4, 4, 0, 0] },
            label: { show: fys.length <= 12, position: 'top', color: t.ink2, fontSize: 11, formatter: (p: { value: number }) => fmtPrice(p.value) },
          },
        ],
      },
      {
        columns: ['年度', '日数', 'コマ数', `平均（${PRICE_UNIT}）`, '最高', '最低', '標準偏差', '0.01円のコマ数'],
        rows: fys.map((fy, k) => [`${fy}年度`, days[k], g.acc[k].n, means[k], g.acc[k].max, g.acc[k].min, accStd(g.acc[k]), g.floor[k]]),
        digits: [null, 0, 0, 2, 2, 2, 2, 0],
        filename: `jepx_yearly_${state.focus}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderFyAreas(fys: number[]): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const row = new Map(fys.map((fy, k) => [fy, k]));
    const keys = PRICE_KEYS;
    const table: (string | number)[][] = fys.map((fy) => [`${fy}年度`]);
    const cells: { value: [number, number, number]; label: { color: string } }[] = [];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const raw: [number, number, number][] = [];
    keys.forEach((k, c) => {
      const g = aggregate(sel, src(ds, k), (i) => row.get(ds.fy[i])!, fys.length);
      fys.forEach((_, r) => {
        const v = accMean(g.acc[r]);
        table[r].push(Number.isFinite(v) ? v : '');
        if (!Number.isFinite(v)) return;
        raw.push([c, r, v]);
        min = Math.min(min, v);
        max = Math.max(max, v);
      });
    });
    if (raw.length === 0) {
      this.fyAreas.setEmpty(NO_DATA);
      return;
    }
    const lo = Math.floor(min);
    const hi = Math.max(lo + 1, Math.ceil(max));
    for (const [c, r, v] of raw) cells.push({ value: [c, r, v], label: { color: labelOnSeq((v - lo) / (hi - lo), theme) } });
    const showLabels = fys.length <= 14;
    this.fyAreas.setHeight(Math.max(240, fys.length * 30 + 90));
    this.fyAreas.setSubtitle(`${describeSelection(sel, state)}・${PRICE_UNIT}`);
    this.fyAreas.setOption(
      {
        grid: { left: 8, right: 8, top: 28, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [number, number, number] }) =>
            ttHeader(`${fys[p.value[1]]}年度・${SERIES_SHORT[keys[p.value[0]]]}`) + ttRow(t.ink2, `${fmtPrice(p.value[2])} ${PRICE_UNIT}`, '平均', 'none'),
        },
        xAxis: { type: 'category', data: keys.map((k) => SERIES_SHORT[k]), position: 'top', axisLine: { show: false }, axisLabel: { interval: 0 } },
        yAxis: { type: 'category', data: fys.map((fy) => `${fy}年度`), inverse: true, axisLine: { show: false } },
        visualMap: { show: false, min: lo, max: hi, inRange: { color: t.seq } },
        series: [
          {
            type: 'heatmap',
            data: cells,
            label: { show: showLabels, fontSize: 11, formatter: (p: { value: [number, number, number] }) => p.value[2].toFixed(1) },
            itemStyle: { borderColor: t.surface, borderWidth: 2 },
            emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
          },
        ],
      },
      {
        columns: ['年度', ...keys.map((k) => `${SERIES_SHORT[k]}（${PRICE_UNIT}）`)],
        rows: table,
        digits: [null, ...keys.map(() => 2)],
        filename: `jepx_yearly_areas_${rangeTag(sel)}.csv`,
      },
    );
  }
}
