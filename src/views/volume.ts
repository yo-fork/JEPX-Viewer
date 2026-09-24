/**
 * 入札・約定量：売り・買いの入札量と約定総量の推移、時間帯別の平均、約定量と価格の関係。
 */
import { aggregateBySlot, src } from '../lib/aggregate';
import { formatDay, slotStartLabel } from '../lib/dates';
import { fmtNum, fmtPrice, MKWH } from '../lib/format';
import { SERIES_INDEX, SERIES_LABEL, SLOTS, VOLUME_KEYS } from '../lib/series';
import { accMean } from '../lib/stats';
import type { ChartCard } from '../ui/card';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { axisTooltip, describeSelection, endLabels, grid, labelRoom, lineSeries, rangeTag, seriesLegend, slotAxis, valueAxis } from './common';
import { autoGranularity, breakGaps, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL } from './timeseries';

const UNIT = '百万kWh';
const MAX_SCATTER = 12000;
/** 線の右端の直接ラベル（売り入札量・買い入札量・約定総量） */
const END_NAMES = ['売り入札', '買い入札', '約定'];

export class VolumeView extends View {
  private trend!: ChartCard;
  private profile!: ChartCard;
  private scatter!: ChartCard;

  protected build(): void {
    const g = this.grid();
    this.trend = this.card(g, { title: '入札量・約定量の推移', height: 340, wide: true });
    this.profile = this.card(g, { title: '時間帯別の平均（1 コマあたり）', height: 320 });
    this.scatter = this.card(g, { title: '約定総量とシステムプライス', height: 320 });
  }

  protected render(): void {
    const { sel, ds } = this.ctx;
    const cards = [this.trend, this.profile, this.scatter];
    if (sel.days.length === 0) {
      cards.forEach((c) => c.setEmpty(NO_DATA));
      return;
    }
    if (!ds.hasSeries.volume) {
      cards.forEach((c) => c.setEmpty('読み込んだデータに入札量・約定量の列がありません。'));
      return;
    }
    this.renderTrend();
    this.renderProfile();
    this.renderScatter();
  }

  private renderTrend(): void {
    const { sel, ds, state, theme } = this.ctx;
    const keys = VOLUME_KEYS;
    const gran = autoGranularity(sel);
    const perDay = gran !== 'slot';
    // 期間の長さに依らず比べられるよう、1 コマ平均 × 対象コマ数 =「1 日あたり（対象時間帯）」で表す
    const scale = (perDay ? sel.slots.length : 1) / MKWH;
    const raw = buildSeriesPoints(sel, keys.map((k) => src(ds, k)), gran, 'mean');
    const data = raw.map((d) => d.points.map(([x, v]) => [x, v * scale] as [number, number]));
    const unit = perDay ? `${UNIT}/日` : `${UNIT}/コマ`;
    this.trend.setSubtitle(
      `${describeSelection(sel, state)}・${perDay ? `1 日あたりの量（${gran === 'day' ? '日別' : `${periodShort(gran)}ごとの 1 日平均`}）` : '30分値'}`,
    );
    const trendEnds = endLabels(END_NAMES, data.map((d) => d.map((p) => p[1])), theme, 260);
    this.trend.setOption(
      {
        grid: grid({ right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: { trigger: 'axis', formatter: axisTooltip(keys, theme, (p) => periodLabel(p.value[0], gran), (v) => `${fmtNum(v, 1)} ${unit}`) },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis(unit),
        series: keys.map((k, i) => lineSeries(k, theme, perDay ? data[i] : breakGaps(data[i]), { sampling: 'lttb', ...trendEnds[i] })),
      },
      {
        columns: ['期間', ...keys.map((k) => `${SERIES_LABEL[k]}（${unit}）`)],
        rows: data[0].map((p, r) => [periodLabel(p[0], gran), ...data.map((d) => d[r][1])]),
        digits: [null, 1, 1, 1],
        filename: `jepx_volume_trend_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderProfile(): void {
    const { sel, ds, state, theme } = this.ctx;
    const keys = VOLUME_KEYS;
    const values = keys.map((k) => {
      const g = aggregateBySlot(sel, src(ds, k));
      return sel.slots.map((s) => accMean(g.acc[s]) / MKWH);
    });
    this.profile.setSubtitle(`${describeSelection(sel, state)}・${UNIT}/コマ`);
    const ends = endLabels(END_NAMES, values, theme, 240);
    this.profile.setOption(
      {
        grid: grid({ right: labelRoom(keys.length) }),
        legend: seriesLegend(keys),
        tooltip: { trigger: 'axis', formatter: axisTooltip(keys, theme, (p) => `${p.axisValue} 開始のコマ`, (v) => `${fmtNum(v, 2)} ${UNIT}`) },
        xAxis: slotAxis(sel.slots),
        yAxis: valueAxis(UNIT),
        series: keys.map((k, i) => lineSeries(k, theme, values[i], ends[i])),
      },
      {
        columns: ['時刻', ...keys.map((k) => `${SERIES_LABEL[k]}（${UNIT}/コマ）`)],
        rows: sel.slots.map((s, r) => [slotStartLabel(s), ...values.map((v) => v[r])]),
        digits: [null, 2, 2, 2],
        filename: `jepx_volume_profile_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderScatter(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const vol = ds.values[SERIES_INDEX.volume];
    const price = ds.values[SERIES_INDEX.system];
    const total = sel.days.length * sel.slots.length;
    const stride = Math.max(1, Math.ceil(total / MAX_SCATTER));
    const points: [number, number, number][] = [];
    let k = 0;
    for (const i of sel.days) {
      for (const s of sel.slots) {
        if (k++ % stride !== 0) continue;
        const v = vol[i * SLOTS + s];
        const p = price[i * SLOTS + s];
        if (Number.isNaN(v) || Number.isNaN(p)) continue;
        points.push([v / MKWH, p, i * SLOTS + s]);
      }
    }
    this.scatter.setSubtitle(
      `${describeSelection(sel, state)}・1 点が 1 コマ${stride > 1 ? `（${fmtNum(total)} コマから ${stride} コマおきに ${fmtNum(points.length)} 点を表示）` : ''}`,
    );
    this.scatter.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [number, number, number] }) => {
            const [v, pr, at] = p.value;
            const day = ds.start + Math.floor(at / SLOTS);
            return (
              ttHeader(`${formatDay(day, true)} ${slotStartLabel(at % SLOTS)}`) +
              ttRow(t.cat[0], `${fmtPrice(pr)} 円/kWh`, 'システムプライス', 'none') +
              ttRow(t.cat[0], `${fmtNum(v, 2)} ${UNIT}`, '約定総量', 'none')
            );
          },
        },
        xAxis: { type: 'value', name: `約定総量（${UNIT}/コマ）`, nameLocation: 'middle', nameGap: 26, scale: true, splitLine: { show: true, lineStyle: { color: t.grid } } },
        yAxis: valueAxis('円/kWh'),
        series: [
          {
            type: 'scatter',
            progressive: 0,
            data: points,
            symbolSize: 5,
            large: points.length > 4000,
            itemStyle: { color: t.cat[0], opacity: 0.35 },
            emphasis: { itemStyle: { opacity: 1, borderColor: t.surface, borderWidth: 2 }, scale: 2 },
          },
        ],
      },
      {
        columns: ['日時', `約定総量（${UNIT}）`, 'システムプライス（円/kWh）'],
        rows: points.map(([v, p, at]) => [`${formatDay(ds.start + Math.floor(at / SLOTS))} ${slotStartLabel(at % SLOTS)}`, v, p]),
        digits: [null, 3, 2],
        filename: `jepx_volume_price_${rangeTag(sel)}.csv`,
      },
    );
  }
}

function periodShort(gran: string): string {
  return ({ week: '週', month: '月', fy: '年度', year: '年' } as Record<string, string>)[gran] ?? '';
}
