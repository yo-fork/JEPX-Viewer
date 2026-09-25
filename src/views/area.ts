/**
 * エリア比較：基準（システムプライスまたは任意のエリア）との価格差・市場分断の起きやすさ、
 * 2 エリア間の値差（どちらが高かったか、推移、時間帯、分布、日付と時間帯の並び）、
 * エリアの組み合わせごとの分断率と平均値差を比べる。
 */
import { aggregate, aggregateAll, buildPeriods, splitRate, src } from '../lib/aggregate';
import { slotRangeLabel, slotStartLabel } from '../lib/dates';
import { fmtNum, fmtPct, fmtPosition, fmtPrice, fmtSigned, stepDigits } from '../lib/format';
import { AREAS, PRICE_KEYS, SERIES_INDEX, SERIES_LABEL, SERIES_SHORT, SLOTS, type AreaKey, type PriceKey } from '../lib/series';
import { spreadBins, spreadBy, spreadCounts, spreadValues, type SpreadStats } from '../lib/spread';
import { accMean } from '../lib/stats';
import type { HeatKind } from '../state';
import type { ChartCard, TableData } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { h } from '../ui/dom';
import { renderTiles } from '../ui/kpi';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import {
  categoryBarOption,
  describeSelection,
  grid,
  isNarrow,
  labelOnDiv,
  labelOnSeq,
  legend,
  monthLabel,
  PRICE_UNIT,
  rangeTag,
  valueAxis,
} from './common';
import { buildGrid, colorRange, gridTable, HEAT_KIND_OPTIONS, heatmapHeight, heatmapOption } from './heatmap';
import { autoGranularity, periodLabel } from './timeseries';

const AREA_OPTIONS = AREAS.map((a) => ({ value: a.key as AreaKey, label: a.label }));
const BASE_OPTIONS = PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] }));
const SAME_PAIR = '異なる 2 つのエリアを選んでください。';

export class AreaView extends View {
  private base!: SelectField<PriceKey>;
  private pairA!: SelectField<AreaKey>;
  private pairB!: SelectField<AreaKey>;
  private heatKind!: Segmented<HeatKind>;
  private pairTiles!: HTMLElement;
  private spread!: ChartCard;
  private split!: ChartCard;
  private monthly!: ChartCard;
  private pair!: ChartCard;
  private slotMean!: ChartCard;
  private slotSide!: ChartCard;
  private hist!: ChartCard;
  private pairHeat!: ChartCard;
  private matrix!: ChartCard;
  private meanMatrix!: ChartCard;

  protected build(): void {
    const s = this.ctx.state;
    this.base = selectField('比較の基準', BASE_OPTIONS, s.areaBase, (v) => this.set({ areaBase: v }));
    this.root.append(h('h2', { class: 'view-section-title' }, '基準との比較'), toolbar(this.base.el));
    const g1 = this.grid();
    this.spread = this.card(g1, { title: '平均差', height: 300 });
    this.split = this.card(g1, { title: '市場分断の発生率', height: 300 });
    this.monthly = this.card(g1, { title: '月別の差', height: 380, wide: true });

    this.pairA = selectField('エリア A', AREA_OPTIONS, s.pairA, (v) => this.set({ pairA: v }));
    this.pairB = selectField('エリア B', AREA_OPTIONS, s.pairB, (v) => this.set({ pairB: v }));
    const swap = h(
      'button',
      { type: 'button', class: 'btn', onclick: () => this.set({ pairA: this.ctx.state.pairB, pairB: this.ctx.state.pairA }) },
      'A と B を入れ替える',
    );
    this.pairTiles = h('div', { class: 'kpis', 'aria-label': '2 エリア間の値差の要約' });
    this.root.append(h('h2', { class: 'view-section-title' }, '2 エリア間の値差'), toolbar(this.pairA.el, this.pairB.el, swap), this.pairTiles);
    const g2 = this.grid();
    this.pair = this.card(g2, { title: '値差の推移', height: 320, wide: true });
    this.slotMean = this.card(g2, { title: '時間帯別の平均値差', height: 300 });
    this.slotSide = this.card(g2, { title: '時間帯別の、どちらが高かったか', height: 300 });
    this.hist = this.card(g2, { title: '値差の分布', height: 300, wide: true });
    this.pairHeat = this.card(g2, { title: '値差のヒートマップ', height: 480, wide: true });
    this.heatKind = segmented('格子', HEAT_KIND_OPTIONS, s.heatKind, (v) => this.set({ heatKind: v }));
    this.pairHeat.addControls(this.heatKind.el);

    this.root.append(h('h2', { class: 'view-section-title' }, '全エリアの組み合わせ'));
    const g3 = this.grid();
    this.matrix = this.card(g3, { title: 'エリア間で価格が異なったコマの割合', height: 380 });
    this.meanMatrix = this.card(g3, { title: 'エリア間の平均値差', height: 380 });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.base.set(state.areaBase);
    this.pairA.set(state.pairA);
    this.pairB.set(state.pairB);
    this.heatKind.set(state.heatKind);
    const base = state.areaBase;
    const baseName = base === 'system' ? SERIES_LABEL.system : `${SERIES_LABEL[base]}エリア`;
    this.spread.setTitle(`${baseName}との平均差`);
    this.split.setTitle(`${baseName}との市場分断の発生率`);
    this.monthly.setTitle(`月別の${baseName}との差`);
    if (sel.days.length === 0) {
      [this.spread, this.split, this.monthly, ...this.pairCards(), this.matrix, this.meanMatrix].forEach((c) => c.setEmpty(NO_DATA));
      this.pairTiles.replaceChildren();
      return;
    }
    // 基準以外の系列（基準がエリアのときはシステムプライスも比較対象に含める）
    const targets = PRICE_KEYS.filter((k) => k !== base);
    this.renderSpread(base, targets);
    this.renderSplit(base, targets);
    this.renderMonthly(base, targets);
    this.renderPairSection();
    this.renderMatrix();
    this.renderMeanMatrix();
  }

  private pairCards(): ChartCard[] {
    return [this.pair, this.slotMean, this.slotSide, this.hist, this.pairHeat];
  }

  /** 2 エリア間の値差（エリア A − エリア B）の要約と図 */
  private renderPairSection(): void {
    const { sel, ds, state } = this.ctx;
    if (state.pairA === state.pairB) {
      this.pairCards().forEach((c) => c.setEmpty(SAME_PAIR));
      this.pairTiles.replaceChildren(h('p', { class: 'view-message' }, SAME_PAIR));
      return;
    }
    const a = ds.values[SERIES_INDEX[state.pairA]];
    const b = ds.values[SERIES_INDEX[state.pairB]];
    const total = spreadBy(sel, a, b, () => 0, 1)[0];
    this.renderPairTiles(total);
    this.renderPair();
    this.renderSlots(a, b);
    this.renderHistogram(a, b, total);
    this.renderPairHeat();
  }

  /** 発散色（負: 青、正: 赤）の両端 */
  private poles(): [string, string] {
    const div = TOKENS[this.ctx.theme].div;
    return [div[0], div[div.length - 1]];
  }

  private renderSpread(base: PriceKey, targets: PriceKey[]): void {
    const { sel, ds, theme } = this.ctx;
    const [neg, pos] = this.poles();
    const diffs = targets.map((k) => accMean(aggregateAll(sel, src(ds, k, base)).acc[0]));
    const color = (v: number) => (v >= 0 ? pos : neg);
    const b = SERIES_SHORT[base];
    this.spread.setSubtitle(`${describeSelection(sel, this.ctx.state)}・赤は${b}より高い、青は安い（30 分値の差の平均）`);
    this.spread.setOption(
      categoryBarOption(
        targets.map((k, i) => ({ label: SERIES_SHORT[k], value: diffs[i], color: color(diffs[i]) })),
        {
          horizontal: isNarrow(this.spread.el),
          theme,
          unit: '円/kWh',
          format: (v) => fmtSigned(v),
          tooltip: (i) =>
            ttHeader(SERIES_SHORT[targets[i]]) + ttRow(color(diffs[i]), `${fmtSigned(diffs[i])} 円/kWh`, `${SERIES_SHORT[targets[i]]} − ${b}（平均）`, 'rect'),
          valueAxisExtra: { boundaryGap: ['15%', '15%'] },
        },
      ),
      {
        columns: ['系列', `${b}との差（円/kWh、平均）`],
        rows: targets.map((k, i) => [SERIES_LABEL[k], diffs[i]]),
        digits: [null, 3],
        filename: `jepx_area_spread_vs_${base}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderSplit(base: PriceKey, targets: PriceKey[]): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const baseValues = ds.values[SERIES_INDEX[base]];
    const rates = targets.map((k) => splitRate(sel, ds.values[SERIES_INDEX[k]], baseValues));
    const pct = rates.map((r) => (r.n ? r.split / r.n : Number.NaN));
    const b = SERIES_SHORT[base];
    this.split.setSubtitle(`${describeSelection(sel, this.ctx.state)}・${b}と価格が異なったコマの割合`);
    this.split.setOption(
      categoryBarOption(
        targets.map((k, i) => ({ label: SERIES_SHORT[k], value: pct[i] * 100, color: t.cat[0] })),
        {
          horizontal: isNarrow(this.split.el),
          theme,
          unit: '%',
          format: (v) => `${v.toFixed(1)}%`,
          tooltip: (i) =>
            ttHeader(`${SERIES_SHORT[targets[i]]} と ${b}`) +
            ttRow(t.cat[0], fmtPct(pct[i]), `${rates[i].split.toLocaleString('ja-JP')} / ${rates[i].n.toLocaleString('ja-JP')} コマで分断`, 'rect'),
          valueAxisExtra: { max: 100, axisLabel: { formatter: '{value}%' } },
        },
      ),
      {
        columns: ['系列', `${b}と異なったコマ数`, '対象コマ数', '発生率（%）'],
        rows: targets.map((k, i) => [SERIES_LABEL[k], rates[i].split, rates[i].n, pct[i] * 100]),
        digits: [null, 0, 0, 1],
        filename: `jepx_area_split_vs_${base}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderPair(): void {
    const { sel, ds, state: st } = this.ctx;
    const [neg, pos] = this.poles();
    const a = st.pairA;
    const b = st.pairB;
    const la = SERIES_SHORT[a];
    const lb = SERIES_SHORT[b];
    let gran = autoGranularity(sel, false);
    if (gran === 'slot') gran = 'day';
    const periods = buildPeriods(sel, gran as Exclude<typeof gran, 'slot'>);
    const g = aggregate(sel, src(ds, a, b), (i) => periods.ofDay[i], periods.starts.length);
    const values = periods.starts.map((_, k) => accMean(g.acc[k]));
    this.pair.setSubtitle(`${describeSelection(sel, st)}・${la} − ${lb}（${periodLabelShort(gran)}平均、赤: ${la}が高い、青: ${lb}が高い）`);
    const color = (v: number) => (v >= 0 ? pos : neg);
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

  /** 値差の要約（平均、どちらが高かったコマの割合、最も差が開いたとき） */
  private renderPairTiles(c: SpreadStats): void {
    const { ds, state } = this.ctx;
    const la = SERIES_SHORT[state.pairA];
    const lb = SERIES_SHORT[state.pairB];
    if (c.n === 0) {
      this.pairTiles.replaceChildren(h('p', { class: 'view-message' }, NO_DATA));
      return;
    }
    const same = c.n - c.up - c.down;
    renderTiles(this.pairTiles, [
      { label: `平均値差（${la} − ${lb}）`, value: fmtSigned(c.sum / c.n), unit: PRICE_UNIT, sub: `${fmtNum(c.n)} コマの平均` },
      { label: `${la}が高かったコマ`, value: fmtPct(c.up / c.n), sub: c.up ? `平均 ${fmtPrice(c.upSum / c.up)} 円高い` : undefined },
      { label: `${lb}が高かったコマ`, value: fmtPct(c.down / c.n), sub: c.down ? `平均 ${fmtPrice(-c.downSum / c.down)} 円高い` : undefined },
      { label: '価格が同じだったコマ', value: fmtPct(same / c.n), sub: `${fmtNum(same)} コマ` },
      {
        label: `最大の値差（${la} − ${lb}）`,
        value: c.up ? fmtPrice(c.max) : '—',
        unit: c.up ? PRICE_UNIT : undefined,
        sub: c.up ? fmtPosition(ds.start, c.maxAt) : `${la}が高かったコマはありません`,
      },
      {
        label: `最大の値差（${lb} − ${la}）`,
        value: c.down ? fmtPrice(-c.min) : '—',
        unit: c.down ? PRICE_UNIT : undefined,
        sub: c.down ? fmtPosition(ds.start, c.minAt) : `${lb}が高かったコマはありません`,
      },
    ]);
  }

  /** 時間帯別の平均値差と、どちらの価格が高かったコマの割合 */
  private renderSlots(a: Float64Array, b: Float64Array): void {
    const { sel, state } = this.ctx;
    const [neg, pos] = this.poles();
    const la = SERIES_SHORT[state.pairA];
    const lb = SERIES_SHORT[state.pairB];
    const bySlot = spreadBy(sel, a, b, (_i, s) => s, SLOTS);
    const rows = sel.slots.map((s) => bySlot[s]);
    const mean = rows.map((c) => (c.n ? c.sum / c.n : Number.NaN));
    const upPct = rows.map((c) => (c.n ? (c.up / c.n) * 100 : Number.NaN));
    const downPct = rows.map((c) => (c.n ? (c.down / c.n) * 100 : Number.NaN));
    const xAxis = {
      type: 'category',
      data: sel.slots.map(slotStartLabel),
      axisLabel: { interval: (i: number) => sel.slots[i] % 4 === 0, hideOverlap: true },
    };
    const tooltip = {
      trigger: 'axis',
      formatter: (ps: { dataIndex: number }[]) => {
        if (!ps.length) return '';
        const r = ps[0].dataIndex;
        return (
          ttHeader(`${slotRangeLabel(sel.slots[r])}（${fmtNum(rows[r].n)} コマ）`) +
          ttRow(mean[r] >= 0 ? pos : neg, `${fmtSigned(mean[r])} 円/kWh`, `平均値差（${la} − ${lb}）`, 'rect') +
          ttRow(pos, fmtPct(upPct[r] / 100), `${la}が高かった`, 'rect') +
          ttRow(neg, fmtPct(downPct[r] / 100), `${lb}が高かった`, 'rect')
        );
      },
    };
    const table: TableData = {
      columns: ['時刻', `平均値差（${la} − ${lb}、円/kWh）`, `${la}が高かった割合（%）`, `${lb}が高かった割合（%）`, '価格が同じだった割合（%）'],
      rows: sel.slots.map((s, r) => [slotStartLabel(s), mean[r], upPct[r], downPct[r], 100 - upPct[r] - downPct[r]]),
      digits: [null, 3, 1, 1, 1],
      filename: `jepx_pair_slots_${state.pairA}_${state.pairB}_${rangeTag(sel)}.csv`,
    };
    const desc = describeSelection(sel, state);
    this.slotMean.setSubtitle(`${desc}・${la} − ${lb} のコマごとの平均（赤: ${la}が高い、青: ${lb}が高い）`);
    this.slotMean.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip,
        xAxis,
        yAxis: valueAxis(PRICE_UNIT),
        series: [
          {
            type: 'bar',
            barMaxWidth: 24,
            data: mean.map((v) => ({ value: v, itemStyle: { color: v >= 0 ? pos : neg, borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
          },
        ],
      },
      table,
    );
    // 上に A が高かった割合、下に B が高かった割合を積む（残りは価格が同じだったコマ）
    this.slotSide.setSubtitle(`${desc}・コマごとの、価格が高かった日の割合（上: ${la}、下: ${lb}。残りは同じ価格）`);
    this.slotSide.setOption(
      {
        grid: grid(),
        legend: legend({ data: [`${la}が高い`, `${lb}が高い`] }),
        tooltip,
        xAxis,
        yAxis: valueAxis('%', { axisLabel: { formatter: (v: number) => `${Math.abs(v)}%` } }),
        series: [
          { type: 'bar', name: `${la}が高い`, stack: 'side', barMaxWidth: 24, data: upPct, itemStyle: { color: pos, borderRadius: [3, 3, 0, 0] } },
          {
            type: 'bar',
            name: `${lb}が高い`,
            stack: 'side',
            barMaxWidth: 24,
            data: downPct.map((v) => -v),
            itemStyle: { color: neg, borderRadius: [0, 0, 3, 3] },
          },
        ],
      },
      table,
    );
  }

  /** 価格が異なったコマの値差の分布 */
  private renderHistogram(a: Float64Array, b: Float64Array, total: SpreadStats): void {
    const { sel, state } = this.ctx;
    const [neg, pos] = this.poles();
    const la = SERIES_SHORT[state.pairA];
    const lb = SERIES_SHORT[state.pairB];
    const values = spreadValues(sel, a, b);
    if (values.length === 0) {
      this.hist.setEmpty(`${la}と${lb}の価格が異なったコマはありません。`);
      return;
    }
    const bins = spreadBins(values);
    const all = spreadCounts(values, bins);
    const { start, width, nBins } = bins;
    const digits = stepDigits(width);
    const edge = (k: number) => fmtSigned(start + k * width, digits);
    // 両端の「〜」の階級は、コマが無ければ出さない
    const from = all[0] > 0 ? 0 : 1;
    const to = all[nBins + 1] > 0 ? nBins + 1 : nBins;
    const idx = Array.from({ length: to - from + 1 }, (_, k) => from + k);
    const counts = idx.map((i) => all[i]);
    const labels = idx.map((i) => (i === 0 ? `〜${edge(0)}` : i === nBins + 1 ? `${edge(nBins)}〜` : edge(i - 1)));
    const ranges = idx.map((i) => (i === 0 ? `${edge(0)} 円未満` : i === nBins + 1 ? `${edge(nBins)} 円以上` : `${edge(i - 1)}〜${edge(i)} 円未満`));
    // 0 は階級の境目なので、階級の下端が 0 以上なら A が高い側
    const aHigher = idx.map((i) => i === nBins + 1 || (i > 0 && start + (i - 1) * width > -width / 2));
    this.hist.setSubtitle(
      `${describeSelection(sel, state)}・${la} − ${lb}・価格が異なった ${fmtNum(values.length)} コマ（価格が同じだった ${fmtNum(total.n - values.length)} コマは除く。赤: ${la}が高い、青: ${lb}が高い）`,
    );
    this.hist.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip: {
          trigger: 'item',
          formatter: (p: { dataIndex: number }) => {
            const k = p.dataIndex;
            return (
              ttHeader(`${la} − ${lb}：${ranges[k]}`) +
              ttRow(aHigher[k] ? pos : neg, `${fmtNum(counts[k])} コマ`, `価格が異なったコマの ${fmtPct(counts[k] / values.length)}`, 'rect')
            );
          },
        },
        xAxis: { type: 'category', data: labels, name: `値差（${la} − ${lb}、${PRICE_UNIT}）`, nameLocation: 'middle', nameGap: 26 },
        yAxis: valueAxis('コマ数'),
        series: [
          {
            type: 'bar',
            barCategoryGap: 2,
            data: counts.map((c, k) => ({ value: c, itemStyle: { color: aHigher[k] ? pos : neg, borderRadius: [3, 3, 0, 0] } })),
          },
        ],
      },
      {
        columns: [`値差（${la} − ${lb}、円/kWh）`, 'コマ数', '割合（%）'],
        rows: counts.map((c, k) => [ranges[k], c, (c / values.length) * 100]),
        digits: [null, 0, 2],
        filename: `jepx_pair_histogram_${state.pairA}_${state.pairB}_${rangeTag(sel)}.csv`,
      },
    );
  }

  /** 値差を日付×時間帯などの格子に並べる */
  private renderPairHeat(): void {
    const { sel, ds, state, theme } = this.ctx;
    const la = SERIES_SHORT[state.pairA];
    const lb = SERIES_SHORT[state.pairB];
    const g = buildGrid(sel, src(ds, state.pairA, state.pairB), state.heatKind);
    if (g.cells.length === 0) {
      this.pairHeat.setEmpty(NO_DATA);
      return;
    }
    const valueLabel = `${la} − ${lb}`;
    this.pairHeat.setSubtitle(
      `${describeSelection(sel, state)}・${valueLabel}（${PRICE_UNIT}、赤: ${la}が高い、青: ${lb}が高い）${g.note ? `・${g.note}` : ''}`,
    );
    const [min, max] = colorRange(g, true);
    this.pairHeat.setHeight(heatmapHeight(g));
    this.pairHeat.setOption(
      heatmapOption(g, { theme, min, max, colors: TOKENS[theme].div, precision: 1, fmt: (v) => `${fmtSigned(v)} 円`, valueLabel }),
      gridTable(g, `jepx_pair_heatmap_${state.heatKind}_${state.pairA}_${state.pairB}_${rangeTag(sel)}.csv`),
    );
  }

  /** エリアの組み合わせごとの平均値差（行のエリア − 列のエリア） */
  private renderMeanMatrix(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const n = AREAS.length;
    const mean: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(Number.NaN));
    let maxAbs = 0.5;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        // 同じコマどうしの差なので、逆向きは符号を変えるだけ
        const v = accMean(aggregateAll(sel, src(ds, AREAS[i].key, AREAS[j].key)).acc[0]);
        mean[i][j] = v;
        mean[j][i] = -v;
        if (Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
      }
    }
    const digits = maxAbs >= 10 ? 1 : 2;
    const cells: { value: [number, number, number]; label: { color: string } }[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j || !Number.isFinite(mean[i][j])) continue;
        cells.push({ value: [j, i, mean[i][j]], label: { color: labelOnDiv(Math.abs(mean[i][j]) / maxAbs, theme) } });
      }
    }
    this.meanMatrix.setSubtitle(`${describeSelection(sel, state)}・行のエリア − 列のエリア の平均（円/kWh、赤: 行のエリアが高い、青: 安い）`);
    this.meanMatrix.setOption(
      {
        grid: { left: 8, right: 8, top: 44, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [number, number, number] }) =>
            ttHeader(`${AREAS[p.value[1]].label} − ${AREAS[p.value[0]].label}`) + ttRow(t.ink2, `${fmtSigned(p.value[2])} 円/kWh`, '平均値差', 'none'),
        },
        xAxis: { type: 'category', data: AREAS.map((a) => a.label), position: 'top', axisLine: { show: false }, axisLabel: { interval: 0 } },
        yAxis: { type: 'category', data: AREAS.map((a) => a.label), inverse: true, axisLine: { show: false } },
        visualMap: { show: false, min: -maxAbs, max: maxAbs, inRange: { color: t.div } },
        series: [
          {
            type: 'heatmap',
            data: cells,
            label: { show: true, fontSize: 11, formatter: (p: { value: [number, number, number] }) => fmtSigned(p.value[2], digits) },
            itemStyle: { borderColor: t.surface, borderWidth: 2 },
            emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
          },
        ],
      },
      {
        columns: ['行のエリア − 列のエリア', ...AREAS.map((a) => `${a.label}（円/kWh）`)],
        rows: AREAS.map((a, i) => [a.label, ...mean[i].map((v) => (Number.isFinite(v) ? v : ''))]),
        digits: [null, ...AREAS.map(() => 3)],
        filename: `jepx_mean_spread_matrix_${rangeTag(sel)}.csv`,
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
    this.matrix.setSubtitle(`${describeSelection(sel, this.ctx.state)}・値（%）が大きいほど 2 エリア間で市場が分断されやすい`);
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

  private renderMonthly(base: PriceKey, targets: PriceKey[]): void {
    const { sel, ds, theme } = this.ctx;
    const t = TOKENS[theme];
    const periods = buildPeriods(sel, 'month');
    const cols = periods.starts.length;
    const cells: [number, number, number][] = [];
    const table: (string | number)[][] = periods.starts.map((d) => [monthLabel(d)]);
    let maxAbs = 0.5;
    targets.forEach((k, r) => {
      const g = aggregate(sel, src(ds, k, base), (i) => periods.ofDay[i], cols);
      for (let c = 0; c < cols; c++) {
        const v = accMean(g.acc[c]);
        table[c].push(Number.isFinite(v) ? v : '');
        if (!Number.isFinite(v)) continue;
        cells.push([c, r, v]);
        maxAbs = Math.max(maxAbs, Math.abs(v));
      }
    });
    const b = SERIES_SHORT[base];
    // セルに数値を書ける幅があるときだけ値を表示する（色だけに頼らない）
    const cellWidth = ((this.monthly.el.clientWidth || 600) - 90) / Math.max(1, cols);
    const showLabels = cellWidth >= 44;
    const digits = maxAbs >= 10 ? 1 : 2;
    this.monthly.setSubtitle(`${describeSelection(sel, this.ctx.state)}・${b}との差の月平均（円/kWh、赤: 高い、青: 安い）`);
    this.monthly.setOption(
      {
        grid: { left: 8, right: 16, top: 48, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
        tooltip: {
          trigger: 'item',
          formatter: (p: { value: [number, number, number] }) =>
            ttHeader(`${monthLabel(periods.starts[p.value[0]])}・${SERIES_SHORT[targets[p.value[1]]]}`) +
            ttRow(t.ink2, `${fmtSigned(p.value[2])} 円/kWh`, `${SERIES_SHORT[targets[p.value[1]]]} − ${b}`, 'none'),
        },
        xAxis: { type: 'category', data: periods.starts.map(monthLabel), axisLine: { show: false }, axisLabel: { hideOverlap: true } },
        yAxis: { type: 'category', data: targets.map((k) => SERIES_SHORT[k]), inverse: true, axisLine: { show: false } },
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
        series: [
          {
            type: 'heatmap',
            progressive: 0,
            data: cells.map(([c, r, v]) => ({ value: [c, r, v], label: { color: labelOnDiv(Math.abs(v) / maxAbs, theme) } })),
            label: {
              show: showLabels,
              fontSize: 10,
              formatter: (p: { value: [number, number, number] }) => fmtSigned(p.value[2], digits),
            },
            itemStyle: cols > 60 ? { borderWidth: 0 } : { borderColor: t.surface, borderWidth: 2 },
            emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
          },
        ],
      },
      {
        columns: ['月', ...targets.map((k) => `${SERIES_SHORT[k]} − ${b}（円/kWh）`)],
        rows: table,
        digits: [null, ...targets.map(() => 3)],
        filename: `jepx_monthly_spread_vs_${base}_${rangeTag(sel)}.csv`,
      },
    );
  }
}

function periodLabelShort(gran: string): string {
  return ({ day: '日', week: '週', month: '月', fy: '年度', year: '年' } as Record<string, string>)[gran] ?? '';
}

