/**
 * 概要：主要な統計量のタイルと、推移・エリア別・時間帯別の 3 つの図で全体像をつかむ。
 */
import { aggregateAll, aggregateBySlot, src, weightedMean } from '../lib/aggregate';
import { dayFromYmd, ymdFromDay } from '../lib/dates';
import { energyCompact, fmtNum, fmtPct, fmtPosition, fmtPrice, fmtSigned } from '../lib/format';
import { reselect, type Selection } from '../lib/select';
import { AREAS, PRICE_KEYS, SERIES_INDEX, SERIES_LABEL, SERIES_SHORT, type PriceKey } from '../lib/series';
import { accMean, summarizeInPlace } from '../lib/stats';
import type { ChartCard } from '../ui/card';
import { selectField, toolbar, type SelectField } from '../ui/controls';
import { h } from '../ui/dom';
import { renderTiles } from '../ui/kpi';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { axisTooltip, categoryBarOption, describeSelection, endLabels, grid, isNarrow, labelRoom, lineSeries, PRICE_UNIT, priceText, rangeTag, seriesLegend, slotAxis, valueAxis } from './common';
import { autoGranularity, breakGaps, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL } from './timeseries';
import { slotStartLabel } from '../lib/dates';

/** 同じ月日の 1 年前（2/29 は 2/28） */
function shiftYear(day: number, years: number): number {
  const { y, m, d } = ymdFromDay(day);
  const last = new Date(Date.UTC(y + years, m, 0)).getUTCDate();
  return dayFromYmd(y + years, m, Math.min(d, last));
}

export class OverviewView extends View {
  private focus!: SelectField<PriceKey>;
  private tiles!: HTMLElement;
  private trend!: ChartCard;
  private areas!: ChartCard;
  private profile!: ChartCard;

  protected build(): void {
    this.focus = selectField(
      '統計タイルの対象',
      PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })),
      this.ctx.state.focus,
      (v) => this.set({ focus: v }),
    );
    this.root.append(toolbar(this.focus.el));
    this.tiles = h('div', { class: 'kpis', 'aria-label': '主要な統計量' });
    this.root.append(this.tiles);
    const g = this.grid();
    this.trend = this.card(g, { title: '価格の推移', height: 320, wide: true });
    this.areas = this.card(g, { title: 'エリア別の平均価格', height: 300 });
    this.profile = this.card(g, { title: '時間帯別の平均価格', height: 300 });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.focus.set(state.focus);
    const cards = [this.trend, this.areas, this.profile];
    if (sel.days.length === 0) {
      this.tiles.replaceChildren(h('p', { class: 'view-message' }, NO_DATA));
      cards.forEach((c) => c.setEmpty(NO_DATA));
      return;
    }
    const desc = describeSelection(sel, state);
    cards.forEach((c) => c.setSubtitle(desc));
    this.renderTiles();
    this.renderTrend();
    this.renderAreas();
    this.renderProfile();
  }

  private renderTiles(): void {
    const { sel, ds, state } = this.ctx;
    const key = state.focus;
    const all = aggregateAll(sel, src(ds, key), true);
    const acc = all.acc[0];
    const s = summarizeInPlace(Float64Array.from(all.values![0]));
    const label = SERIES_SHORT[key];

    // 前年同期（同じ曜日区分・時間帯）
    let delta: string | undefined;
    const prev: Selection = reselect(sel, shiftYear(sel.from, -1), shiftYear(sel.to, -1));
    if (prev.days.length >= sel.days.length * 0.8) {
      const pm = accMean(aggregateAll(prev, src(ds, key)).acc[0]);
      if (Number.isFinite(pm) && pm > 0) {
        delta = `前年同期比 ${fmtSigned(s.mean - pm)} 円（${fmtSigned(((s.mean - pm) / pm) * 100, 1)}%）`;
      }
    }

    const vol = aggregateAll(sel, src(ds, 'volume')).acc[0];
    const [volValue, volUnit] = energyCompact(vol.n > 0 ? vol.sum : Number.NaN);
    const vwap = weightedMean(sel, ds.values[SERIES_INDEX.system], ds.values[SERIES_INDEX.volume]);

    renderTiles(this.tiles, [
      { label: `平均価格（${label}）`, value: fmtPrice(s.mean), unit: PRICE_UNIT, delta, sub: `${fmtNum(s.n)} コマの単純平均` },
      { label: '最高価格', value: fmtPrice(acc.max), unit: PRICE_UNIT, sub: fmtPosition(ds.start, acc.maxAt) },
      { label: '最低価格', value: fmtPrice(acc.min), unit: PRICE_UNIT, sub: fmtPosition(ds.start, acc.minAt) },
      { label: '中央値', value: fmtPrice(s.median), unit: PRICE_UNIT, sub: `10%点 ${fmtPrice(s.p10)}・90%点 ${fmtPrice(s.p90)}` },
      { label: '標準偏差', value: fmtPrice(s.std), unit: PRICE_UNIT, sub: '30 分値のばらつき' },
      { label: '0.01 円のコマ', value: fmtNum(all.floor[0]), unit: 'コマ', sub: `全体の ${fmtPct(all.floor[0] / Math.max(1, s.n))}` },
      {
        label: '約定総量（全国）',
        value: volValue,
        unit: volUnit,
        sub: Number.isFinite(vwap) ? `約定量加重平均 ${fmtPrice(vwap)} 円/kWh（システム）` : undefined,
      },
    ]);
  }

  private renderTrend(): void {
    const { sel, ds, state, theme } = this.ctx;
    const keys = state.series;
    const gran = autoGranularity(sel);
    const data = buildSeriesPoints(sel, keys.map((k) => src(ds, k)), gran, 'mean');
    const granLabel = gran === 'slot' ? '30分値' : `${{ day: '日', week: '週', month: '月', fy: '年度', year: '年' }[gran]}平均`;
    this.trend.setSubtitle(`${describeSelection(sel, state)}・${granLabel}`);
    const ends = endLabels(keys.map((k) => SERIES_SHORT[k]), data.map((d) => d.points.map((p) => p[1])), theme, 240);
    this.trend.setOption(
      {
        grid: grid({ bottom: 8, right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: { trigger: 'axis', formatter: axisTooltip(keys, theme, (p) => periodLabel(p.value[0], gran)) },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis(),
        series: keys.map((k, i) =>
          lineSeries(k, theme, gran === 'slot' ? breakGaps(data[i].points) : data[i].points, { sampling: 'lttb', z: k === 'system' ? 3 : 2, ...ends[i] }),
        ),
      },
      {
        columns: ['期間', ...keys.map((k) => `${SERIES_LABEL[k]}（${PRICE_UNIT}）`)],
        rows: data[0].points.map((p, r) => [periodLabel(p[0], gran), ...keys.map((_, i) => data[i].points[r][1])]),
        digits: [null, ...keys.map(() => 2)],
        filename: `jepx_trend_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderAreas(): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const means = AREAS.map((a) => accMean(aggregateAll(sel, src(ds, a.key)).acc[0]));
    const sys = accMean(aggregateAll(sel, src(ds, 'system')).acc[0]);
    const horizontal = isNarrow(this.areas.el);
    this.areas.setOption(
      categoryBarOption(
        AREAS.map((a, i) => ({ label: a.label, value: means[i], color: t.cat[0] })),
        {
          horizontal,
          theme,
          unit: PRICE_UNIT,
          format: fmtPrice,
          tooltip: (i) =>
            ttHeader(AREAS[i].label) +
            ttRow(t.cat[0], priceText(means[i]), '平均', 'rect') +
            ttRow(t.neutralSeries, fmtSigned(means[i] - sys) + ' 円', 'システムプライスとの差', 'none'),
          markLine: Number.isFinite(sys)
            ? {
                silent: true,
                symbol: 'none',
                lineStyle: { color: t.neutralSeries, width: 1, type: 'solid' },
                label: { formatter: `システム\n${fmtPrice(sys)}`, color: t.ink2, position: 'end', fontSize: 11, lineHeight: 14 },
                data: [horizontal ? { xAxis: sys } : { yAxis: sys }],
              }
            : undefined,
        },
      ),
      {
        columns: ['エリア', `平均価格（${PRICE_UNIT}）`, 'システムプライスとの差（円/kWh）'],
        rows: [...AREAS.map((a, i) => [a.label, means[i], means[i] - sys]), ['システムプライス', sys, 0]],
        digits: [null, 2, 2],
        filename: `jepx_area_mean_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderProfile(): void {
    const { sel, ds, state, theme } = this.ctx;
    const keys = state.series;
    const bySlot = keys.map((k) => aggregateBySlot(sel, src(ds, k)));
    const values = keys.map((_, i) => sel.slots.map((s) => accMean(bySlot[i].acc[s])));
    const ends = endLabels(keys.map((k) => SERIES_SHORT[k]), values, theme, 200);
    this.profile.setOption(
      {
        grid: grid({ right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: { trigger: 'axis', formatter: axisTooltip(keys, theme, (p) => `${p.axisValue} 開始のコマ`) },
        xAxis: slotAxis(sel.slots),
        yAxis: valueAxis(),
        series: keys.map((k, i) => lineSeries(k, theme, values[i], { z: k === 'system' ? 3 : 2, ...ends[i] })),
      },
      {
        columns: ['時刻', ...keys.map((k) => `${SERIES_LABEL[k]}（${PRICE_UNIT}）`)],
        rows: sel.slots.map((s, r) => [slotStartLabel(s), ...values.map((v) => v[r])]),
        digits: [null, ...keys.map(() => 2)],
        filename: `jepx_profile_${rangeTag(sel)}.csv`,
      },
    );
  }
}
