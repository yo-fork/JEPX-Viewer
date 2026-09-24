/**
 * エリア比較：エリアプライスとシステムプライスの差、市場分断の起きやすさ、エリア間の値差を比べる。
 */
import { aggregate, aggregateAll, buildPeriods, splitRate, src } from '../lib/aggregate';
import { fmtPct, fmtSigned } from '../lib/format';
import { AREAS, SERIES_INDEX, type AreaKey } from '../lib/series';
import { accMean } from '../lib/stats';
import type { ChartCard } from '../ui/card';
import { selectField, toolbar, type SelectField } from '../ui/controls';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { categoryBarOption, describeSelection, grid, isNarrow, labelOnSeq, monthLabel, rangeTag, valueAxis } from './common';
import { autoGranularity, periodLabel } from './timeseries';

const AREA_OPTIONS = AREAS.map((a) => ({ value: a.key as AreaKey, label: a.label }));

export class AreaView extends View {
  private pairA!: SelectField<AreaKey>;
  private pairB!: SelectField<AreaKey>;
  private spread!: ChartCard;
  private split!: ChartCard;
  private matrix!: ChartCard;
  private monthly!: ChartCard;
  private pair!: ChartCard;

  protected build(): void {
    const s = this.ctx.state;
    this.pairA = selectField('値差を見るエリア A', AREA_OPTIONS, s.pairA, (v) => this.set({ pairA: v }));
    this.pairB = selectField('エリア B', AREA_OPTIONS, s.pairB, (v) => this.set({ pairB: v }));
    this.root.append(toolbar(this.pairA.el, this.pairB.el));
    const g = this.grid();
    this.spread = this.card(g, { title: 'システムプライスとの平均差', height: 300 });
    this.split = this.card(g, { title: '市場分断の発生率', height: 300 });
    this.pair = this.card(g, { title: '2 エリア間の値差の推移', height: 320, wide: true });
    this.matrix = this.card(g, { title: 'エリア間で価格が異なったコマの割合', height: 380 });
    this.monthly = this.card(g, { title: '月別のシステムプライスとの差', height: 380 });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.pairA.set(state.pairA);
    this.pairB.set(state.pairB);
    const cards = [this.spread, this.split, this.pair, this.matrix, this.monthly];
    if (sel.days.length === 0) {
      cards.forEach((c) => c.setEmpty(NO_DATA));
      return;
    }
    const desc = describeSelection(sel, state);
    cards.forEach((c) => c.setSubtitle(desc));
    this.renderSpread();
    this.renderSplit();
    this.renderPair();
    this.renderMatrix();
    this.renderMonthly();
  }

  private renderSpread(): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const diffs = AREAS.map((a) => accMean(aggregateAll(sel, src(ds, a.key, 'system')).acc[0]));
    const color = (v: number) => (v >= 0 ? t.div[2] : t.div[0]);
    this.spread.setSubtitle(`${describeSelection(sel, this.ctx.state)}・赤はシステムより高い、青は安いエリア`);
    this.spread.setOption(
      categoryBarOption(
        AREAS.map((a, i) => ({ label: a.label, value: diffs[i], color: color(diffs[i]) })),
        {
          horizontal: isNarrow(this.spread.el),
          theme,
          unit: '円/kWh',
          format: (v) => fmtSigned(v),
          tooltip: (i) => ttHeader(AREAS[i].label) + ttRow(color(diffs[i]), `${fmtSigned(diffs[i])} 円/kWh`, 'エリア − システム（平均）', 'rect'),
          valueAxisExtra: { boundaryGap: ['15%', '15%'] },
        },
      ),
      {
        columns: ['エリア', 'エリア − システム（円/kWh、平均）'],
        rows: AREAS.map((a, i) => [a.label, diffs[i]]),
        digits: [null, 3],
        filename: `jepx_area_spread_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderSplit(): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const sys = ds.values[SERIES_INDEX.system];
    const rates = AREAS.map((a) => splitRate(sel, ds.values[SERIES_INDEX[a.key]], sys));
    const pct = rates.map((r) => (r.n ? r.split / r.n : Number.NaN));
    this.split.setSubtitle(`${describeSelection(sel, this.ctx.state)}・エリアプライスがシステムプライスと異なったコマの割合`);
    this.split.setOption(
      categoryBarOption(
        AREAS.map((a, i) => ({ label: a.label, value: pct[i] * 100, color: t.cat[0] })),
        {
          horizontal: isNarrow(this.split.el),
          theme,
          unit: '%',
          format: (v) => `${v.toFixed(1)}%`,
          tooltip: (i) =>
            ttHeader(AREAS[i].label) +
            ttRow(t.cat[0], fmtPct(pct[i]), `${rates[i].split.toLocaleString('ja-JP')} / ${rates[i].n.toLocaleString('ja-JP')} コマ`, 'rect'),
          valueAxisExtra: { max: 100, axisLabel: { formatter: '{value}%' } },
        },
      ),
      {
        columns: ['エリア', '分断コマ数', '対象コマ数', '発生率（%）'],
        rows: AREAS.map((a, i) => [a.label, rates[i].split, rates[i].n, pct[i] * 100]),
        digits: [null, 0, 0, 1],
        filename: `jepx_area_split_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderPair(): void {
    const { sel, ds, state: st, theme } = this.ctx;
    const t = TOKENS[theme];
    const a = st.pairA;
    const b = st.pairB;
    const la = AREAS.find((x) => x.key === a)!.label;
    const lb = AREAS.find((x) => x.key === b)!.label;
    if (a === b) {
      this.pair.setEmpty('異なる 2 つのエリアを選んでください。');
      return;
    }
    let gran = autoGranularity(sel, false);
    if (gran === 'slot') gran = 'day';
    const periods = buildPeriods(sel, gran as Exclude<typeof gran, 'slot'>);
    const g = aggregate(sel, src(ds, a, b), (i) => periods.ofDay[i], periods.starts.length);
    const values = periods.starts.map((_, k) => accMean(g.acc[k]));
    const rate = splitRate(sel, ds.values[SERIES_INDEX[a]], ds.values[SERIES_INDEX[b]]);
    const total = accMean(aggregateAll(sel, src(ds, a, b)).acc[0]);
    this.pair.setSubtitle(
      `${describeSelection(sel, st)}・${la} − ${lb}（${periodLabelShort(gran)}平均）・期間平均 ${fmtSigned(total)} 円・価格が異なったコマ ${fmtPct(rate.n ? rate.split / rate.n : Number.NaN)}`,
    );
    const color = (v: number) => (v >= 0 ? t.div[2] : t.div[0]);
    this.pair.setOption(
      {
        grid: grid({ top: 28, bottom: 8 }),
        tooltip: {
          trigger: 'axis',
          formatter: (params: { dataIndex: number }[]) => {
            if (!params.length) return '';
            const k = params[0].dataIndex;
            return ttHeader(periodLabel(periods.starts[k] * 86_400_000, gran)) + ttRow(color(values[k]), `${fmtSigned(values[k])} 円/kWh`, `${la} − ${lb}`, 'rect');
          },
        },
        xAxis: {
          type: 'category',
          data: periods.starts.map((d) => periodLabel(d * 86_400_000, gran)),
          axisLabel: { hideOverlap: true },
        },
        yAxis: valueAxis('円/kWh'),
        series: [
          {
            type: 'bar',
            barMaxWidth: 24,
            barCategoryGap: periods.starts.length > 120 ? 0 : '20%',
            data: values.map((v) => ({
              value: v,
              itemStyle: { color: color(v), borderRadius: periods.starts.length > 120 ? 0 : v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] },
            })),
          },
        ],
      },
      {
        columns: ['期間', `${la} − ${lb}（円/kWh）`],
        rows: periods.starts.map((d, k) => [periodLabel(d * 86_400_000, gran), values[k]]),
        digits: [null, 3],
        filename: `jepx_pair_${a}_${b}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderMatrix(): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const n = AREAS.length;
    const rate: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(Number.NaN));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const r = splitRate(sel, ds.values[SERIES_INDEX[AREAS[i].key]], ds.values[SERIES_INDEX[AREAS[j].key]]);
        rate[i][j] = rate[j][i] = r.n ? (r.split / r.n) * 100 : Number.NaN;
      }
    }
    const cells: { value: [number, number, number]; label: { color: string } }[] = [];
    let max = 1;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (Number.isFinite(rate[i][j])) max = Math.max(max, rate[i][j]);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || !Number.isFinite(rate[i][j])) continue;
        cells.push({ value: [j, i, rate[i][j]], label: { color: labelOnSeq(rate[i][j] / max, theme) } });
      }
    }
    this.matrix.setSubtitle(`${describeSelection(sel, this.ctx.state)}・値が大きいほど 2 エリア間で市場が分断されやすい`);
    this.matrix.setOption(
      {
        grid: { left: 8, right: 8, top: 44, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [number, number, number] }) =>
            ttHeader(`${AREAS[p.value[1]].label} と ${AREAS[p.value[0]].label}`) + ttRow(t.ink2, fmtPct(p.value[2] / 100), '価格が異なったコマの割合', 'none'),
        },
        xAxis: { type: 'category', data: AREAS.map((a) => a.label), position: 'top', axisLine: { show: false }, axisLabel: { interval: 0 } },
        yAxis: { type: 'category', data: AREAS.map((a) => a.label), inverse: true, axisLine: { show: false } },
        visualMap: { show: false, min: 0, max, inRange: { color: t.seq } },
        series: [
          {
            type: 'heatmap',
            data: cells,
            label: { show: true, fontSize: 11, formatter: (p: { value: [number, number, number] }) => p.value[2].toFixed(0) },
            itemStyle: { borderColor: t.surface, borderWidth: 2 },
            emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
          },
        ],
      },
      {
        columns: ['エリア', ...AREAS.map((a) => `${a.label}（%）`)],
        rows: AREAS.map((a, i) => [a.label, ...rate[i].map((v) => (Number.isFinite(v) ? v : ''))]),
        digits: [null, ...AREAS.map(() => 1)],
        filename: `jepx_split_matrix_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderMonthly(): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const periods = buildPeriods(sel, 'month');
    const cols = periods.starts.length;
    const cells: [number, number, number][] = [];
    const table: (string | number)[][] = periods.starts.map((d) => [monthLabel(d)]);
    let maxAbs = 0.5;
    AREAS.forEach((a, r) => {
      const g = aggregate(sel, src(ds, a.key, 'system'), (i) => periods.ofDay[i], cols);
      for (let c = 0; c < cols; c++) {
        const v = accMean(g.acc[c]);
        table[c].push(Number.isFinite(v) ? v : '');
        if (!Number.isFinite(v)) continue;
        cells.push([c, r, v]);
        maxAbs = Math.max(maxAbs, Math.abs(v));
      }
    });
    this.monthly.setSubtitle(`${describeSelection(sel, this.ctx.state)}・エリアプライス − システムプライスの月平均（赤: 高い、青: 安い）`);
    this.monthly.setOption(
      {
        grid: { left: 8, right: 16, top: 48, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [number, number, number] }) =>
            ttHeader(`${monthLabel(periods.starts[p.value[0]])}・${AREAS[p.value[1]].label}`) + ttRow(t.ink2, `${fmtSigned(p.value[2])} 円/kWh`, 'エリア − システム', 'none'),
        },
        xAxis: { type: 'category', data: periods.starts.map(monthLabel), axisLine: { show: false }, axisLabel: { hideOverlap: true } },
        yAxis: { type: 'category', data: AREAS.map((a) => a.label), inverse: true, axisLine: { show: false } },
        visualMap: {
          type: 'continuous',
          min: -maxAbs,
          max: maxAbs,
          calculable: true,
          orient: 'horizontal',
          right: 8,
          top: 0,
          itemWidth: 12,
          itemHeight: 160,
          precision: 1,
          inRange: { color: t.div },
          textStyle: { color: t.muted, fontSize: 11 },
        },
        series: [{ type: 'heatmap', progressive: 0, data: cells, itemStyle: cols > 60 ? { borderWidth: 0 } : { borderColor: t.surface, borderWidth: 2 } }],
      },
      {
        columns: ['月', ...AREAS.map((a) => `${a.label} − システム（円/kWh）`)],
        rows: table,
        digits: [null, ...AREAS.map(() => 3)],
        filename: `jepx_area_monthly_spread_${rangeTag(sel)}.csv`,
      },
    );
  }
}

function periodLabelShort(gran: string): string {
  return ({ day: '日', week: '週', month: '月', fy: '年度', year: '年' } as Record<string, string>)[gran] ?? '';
}
