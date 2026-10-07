/**
 * 連系線: 電力広域的運営推進機関（広域機関）が公表している、地域間連系線ごとの計画潮流・上限・潮流実績。
 * 連系線ごとの、計画潮流が上限に達したコマ（市場分断が起きる）の割合、選んだ連系線の推移・時間帯別の様子・ヒートマップ。
 */
import { aggregateBySlot } from '../lib/aggregate';
import { formatDay, slotRangeLabel, slotStartLabel } from '../lib/dates';
import { fmtNum, fmtPct, fmtSigned } from '../lib/format';
import type { IntertieStore } from '../lib/intertieStore';
import {
  atLimit,
  INTERTIE_DEFS,
  INTERTIE_INDEX,
  INTERTIE_KEYS,
  intertieNote,
  intertieTitle,
  NO_FLOW_LINES,
  OCCTO_SOURCE,
  type IntertieDef,
  type IntertieField,
  type IntertieKey,
} from '../lib/occto';
import { AREA_KEYS, AREAS, SERIES_LABEL, SLOTS, type AreaKey } from '../lib/series';
import type { Selection } from '../lib/select';
import { accMean } from '../lib/stats';
import type { TrendGran } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { h } from '../ui/dom';
import { seriesColor, seriesDashed, TOKENS } from '../ui/theme';
import { ttHeader, ttNote, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import { describeSelection, endLabels, grid, labelRoom, LINE_SAMPLING, lineLegend, rangeTag, slotAxis, styledLine, valueAxis } from './common';
import { CURVE_GRAN_OPTIONS, curveGranularity, granText, namedTooltip, slotZoom } from './curveCommon';
import { buildGrid, colorRange, gridTable, heatmapHeight, heatmapOption } from './heatmap';
import { breakGaps, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL } from './timeseries';

const def = (key: IntertieKey): IntertieDef => INTERTIE_DEFS[INTERTIE_INDEX[key]];
/** 概要の図の縦軸の名前（設備の名前は 2 行目に小さく） */
const axisName = (key: IntertieKey) => (def(key).facility ? `${def(key).label}\n{f|${def(key).name}}` : def(key).label);
const areaNames = (areas: readonly AreaKey[]) => areas.map((a) => SERIES_LABEL[a]).join('・');
/** 順方向・逆方向の向きの説明（「東北 → 東京」） */
const forward = (key: IntertieKey) => `${areaNames(def(key).from)} → ${areaNames(def(key).to)}`;
const backward = (key: IntertieKey) => `${areaNames(def(key).to)} → ${areaNames(def(key).from)}`;

/** 推移の図の線（値の種類・名前・色の番号・破線か） */
const TREND_LINES: { field: IntertieField; name: string; color: 'cat0' | 'cat1' | 'cat2' | 'neutral'; dashed: boolean }[] = [
  { field: 'plan', name: '計画潮流（翌日）', color: 'cat0', dashed: false },
  { field: 'planFinal', name: '計画潮流（最終）', color: 'cat2', dashed: true },
  { field: 'actual', name: '潮流実績', color: 'cat1', dashed: false },
  { field: 'limFwd', name: '上限（順方向）', color: 'neutral', dashed: true },
  { field: 'limRev', name: '上限（逆方向）', color: 'neutral', dashed: true },
];

/**
 * 選んだ日（古い順）ごとの、値があるかどうか。plan・actual は選んだ連系線の計画潮流（翌日）と潮流実績、
 * anyPlan・anyActual はどれかの連系線にあるか（どの連系線にも無い日は、取得できていない日）
 */
export interface LineCoverage {
  days: number[];
  plan: boolean[];
  actual: boolean[];
  anyPlan: boolean[];
  anyActual: boolean[];
}

/** flags が true の最初と最後の位置（[from, to] の中で。無ければ null） */
function span(flags: boolean[], from = 0, to = flags.length - 1): [number, number] | null {
  let a = -1;
  let b = -1;
  for (let i = from; i <= to; i++) {
    if (!flags[i]) continue;
    if (a < 0) a = i;
    b = i;
  }
  return a < 0 ? null : [a, b];
}

/** 値の無い日の並び（続いている日はまとめ、3 つまで書く） */
function daysText(days: number[], idx: number[]): string {
  const runs: [number, number][] = [];
  for (const i of idx) {
    const r = runs[runs.length - 1];
    if (r && i === r[1] + 1) r[1] = i;
    else runs.push([i, i]);
  }
  const text = runs.slice(0, 3).map(([a, b]) => (a === b ? formatDay(days[a]) : `${formatDay(days[a])}〜${formatDay(days[b])}`));
  return `${text.join('、')}${runs.length > 3 ? ' など' : ''}`;
}

/**
 * 推移の図の下に出す注記: 選んだ期間のうち、この連系線の値がある範囲と、値の無い日（その日は線が切れる）。
 * 公表のされ方に決まりのある連系線は、その説明も付ける（special: デモでは付けない）
 */
export function coverageNotes(key: IntertieKey, c: LineCoverage, special = true): string[] {
  const notes: string[] = [];
  const about = special ? intertieNote(key) : null;
  if (about) notes.push(about);
  const p = span(c.plan);
  if (!p) return notes;
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const all = span(c.anyPlan) ?? p;
  if (p[0] > all[0] || p[1] < all[1]) notes.push(`この期間のうち、この連系線の値があるのは ${formatDay(c.days[p[0]])}〜${formatDay(c.days[p[1]])} です。`);
  let refetch = false;
  const planHoles = range(p[0], p[1]).filter((i) => !c.plan[i]);
  if (planHoles.length > 0) {
    notes.push(`計画潮流の無い日が ${planHoles.length} 日あります（${daysText(c.days, planHoles)}）。`);
    refetch ||= planHoles.some((i) => !c.anyPlan[i]);
  }
  // 潮流実績は、どれかの連系線に潮流実績のある日の中で見る（まだ実績の無い翌日の分などは数えない）
  if (!NO_FLOW_LINES.includes(key)) {
    const w = span(c.anyActual, p[0], p[1]);
    const a = w && span(c.actual, w[0], w[1]);
    if (!w) notes.push('この期間には潮流実績がありません。');
    else if (!a) notes.push('この期間には、この連系線の潮流実績がありません。');
    else {
      if (w[0] > p[0]) notes.push(`潮流実績は ${formatDay(c.days[w[0]])} からです。`);
      if (a[0] > w[0] || a[1] < w[1]) notes.push(`この連系線の潮流実績があるのは ${formatDay(c.days[a[0]])}〜${formatDay(c.days[a[1]])} です。`);
      const flowHoles = range(a[0], a[1]).filter((i) => !c.actual[i]);
      if (flowHoles.length > 0) {
        notes.push(`潮流実績の無い日が ${flowHoles.length} 日あります（${daysText(c.days, flowHoles)}）。`);
        refetch ||= flowHoles.some((i) => !c.anyActual[i]);
      }
    }
  }
  if (refetch) notes.push('どの連系線にも値の無い日は、広域機関から取得できていない日です。npm run fetch を実行し直すと取り直します。');
  return notes;
}

interface LineStat {
  key: IntertieKey;
  /** 計画潮流のあるコマの数と、順方向・逆方向の上限に達したコマの数 */
  n: number;
  fwd: number;
  rev: number;
  /** 計画潮流の平均（MW） */
  mean: number;
}

export class IntertiesView extends View {
  private note!: HTMLElement;
  private line!: SelectField<IntertieKey>;
  private gran!: Segmented<TrendGran>;
  private overview!: ChartCard;
  private trend!: ChartCard;
  private profile!: ChartCard;
  private congestion!: ChartCard;
  private heat!: ChartCard;
  private net!: ChartCard;
  private netGran!: Segmented<TrendGran>;
  private netHeat!: ChartCard;
  private netArea!: SelectField<AreaKey>;
  /** 概要の図の棒の連系線（押した棒から引く） */
  private overviewKeys: IntertieKey[] = [];

  protected build(): void {
    const s = this.ctx.state;
    this.note = h('p', { class: 'view-note' });
    this.root.append(this.note, h('h2', { class: 'view-section-title' }, '連系線ごとの比較'));
    const g1 = this.grid();
    this.overview = this.card(g1, { title: '連系線ごとの、計画潮流が上限に達したコマの割合', height: 360, wide: true });
    // 連系線を選ぶリストは、それで変わる図（推移、時間帯別、ヒートマップ）の見出しの下に置く
    this.line = selectField<IntertieKey>('連系線', [], s.intertie, (v) => this.set({ intertie: v }));
    const lineTitle = h('h2', { class: 'view-section-title' }, '連系線別');
    this.root.append(lineTitle, toolbar(this.line.el));
    this.overview.chart.on('click', (e: unknown) => {
      const key = this.overviewKeys[(e as { dataIndex: number }).dataIndex];
      if (!key) return;
      // 押した連系線の図が見えるように移る
      this.set({ intertie: key });
      lineTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const g2 = this.grid();
    this.trend = this.card(g2, { title: '計画潮流と上限の推移', height: 360, wide: true });
    this.gran = segmented('粒度', CURVE_GRAN_OPTIONS, s.intertieGran, (v) => this.set({ intertieGran: v }));
    this.trend.addControls(this.gran.el);
    this.profile = this.card(g2, { title: '時間帯別の平均', height: 320 });
    this.congestion = this.card(g2, { title: '時間帯別の、上限に達したコマの割合', height: 320 });
    this.heat = this.card(g2, { title: '計画潮流（翌日）のヒートマップ', height: 480, wide: true });
    this.root.append(h('h2', { class: 'view-section-title' }, 'エリアごとの受け入れ量'));
    const g3 = this.grid();
    this.net = this.card(g3, { title: 'エリアごとの正味の受け入れ量の推移', height: 360, wide: true });
    this.netGran = segmented('粒度', CURVE_GRAN_OPTIONS, s.intertieGran, (v) => this.set({ intertieGran: v }));
    this.net.addControls(this.netGran.el);
    this.netHeat = this.card(g3, { title: 'エリアの正味の受け入れ量のヒートマップ', height: 480, wide: true });
    this.netArea = selectField<AreaKey>('エリア', AREAS.map((a) => ({ value: a.key, label: a.label })), s.intertieArea, (v) => this.set({ intertieArea: v }));
    this.netHeat.addControls(this.netArea.el);
  }

  protected render(): void {
    const { sel, ds, state } = this.ctx;
    const st = this.ctx.interties;
    const cards = [this.overview, this.trend, this.profile, this.congestion, this.heat, this.net, this.netHeat];
    this.trend.footer.replaceChildren();
    this.gran.set(state.intertieGran);
    this.netGran.set(state.intertieGran);
    this.netArea.set(state.intertieArea);
    if (!st) {
      this.note.textContent = '連系線のデータがありません。npm run fetch を実行すると、電力広域的運営推進機関（広域機関）から計画潮流と潮流実績を取得します。';
      this.line.setOptions([], state.intertie);
      cards.forEach((c) => c.setEmpty('連系線のデータがありません。'));
      return;
    }
    this.note.textContent =
      `${st.isDemo ? 'デモの値（デモデータのエリア価格から合成したもので、実際の値ではありません）。' : `${OCCTO_SOURCE}。データは ${formatDay(st.first)}〜${formatDay(st.last)} にあります。`}` +
      '計画潮流（翌日）は前日に策定した値（スポット市場の約定で使った量を含む）、計画潮流（最終）は時間前市場などで変わった後の値、潮流実績は実際に流れた量（5 分ごとの値の 30 分の平均）です。' +
      '上限は「運用容量 − マージン − 広域調整枠」で、計画潮流が上限に達すると市場分断が起きます。正の値は順方向（連系線の名前の前の側から後ろの側）です。' +
      'エリアの正味の受け入れ量は、そのエリアにつながる連系線の計画潮流（翌日）を足し引きしたもので、スポット市場で約定した買い − 売り（ブロック入札も含む）にあたります（正は受け入れ、負は送り出し）。';
    if (sel.days.length === 0) {
      cards.forEach((c) => c.setEmpty(NO_DATA));
      return;
    }
    const lines = st.linesWithData(ds, sel.from, sel.to);
    this.line.setOptions(
      lines.map((k) => ({ value: k, label: intertieTitle(k) })),
      lines.includes(state.intertie) ? state.intertie : (lines[0] ?? state.intertie),
    );
    if (lines.length === 0) {
      cards.forEach((c) => c.setEmpty(`選択した期間に連系線のデータがありません（${formatDay(st.first)}〜${formatDay(st.last)} にあります）。`));
      return;
    }
    const key = lines.includes(state.intertie) ? state.intertie : lines[0];
    this.renderOverview(st, sel, lines);
    this.renderTrend(st, sel, key);
    this.renderProfile(st, sel, key);
    this.renderCongestion(st, sel, key);
    this.renderHeat(st, sel, key);
    this.renderNet(st, sel);
    this.renderNetHeat(st, sel);
  }

  /** 選んだ日ごとに、選んだ連系線とどれかの連系線に、計画潮流と潮流実績があるか */
  private coverage(st: IntertieStore, sel: Selection, key: IntertieKey): LineCoverage {
    const { ds } = this.ctx;
    const has = (a: Float64Array, i: number) => {
      for (let s = 0; s < SLOTS; s++) if (!Number.isNaN(a[i * SLOTS + s])) return true;
      return false;
    };
    const plans = INTERTIE_KEYS.map((k) => st.array(ds, k, 'plan'));
    const actuals = INTERTIE_KEYS.map((k) => st.array(ds, k, 'actual'));
    const line = INTERTIE_INDEX[key];
    const days = [...sel.days];
    return {
      days: days.map((i) => ds.start + i),
      plan: days.map((i) => has(plans[line], i)),
      actual: days.map((i) => has(actuals[line], i)),
      anyPlan: days.map((i) => plans.some((a) => has(a, i))),
      anyActual: days.map((i) => actuals.some((a) => has(a, i))),
    };
  }

  /** 上限に達したかどうか（1: 順方向、−1: 逆方向、0: 達していない、NaN: 値が無い）をコマごとに */
  private limitState(st: IntertieStore, key: IntertieKey): (k: number) => number {
    const { ds } = this.ctx;
    const plan = st.array(ds, key, 'plan');
    const limF = st.array(ds, key, 'limFwd');
    const limR = st.array(ds, key, 'limRev');
    return (k) => atLimit(plan[k], limF[k], limR[k]);
  }

  private stat(st: IntertieStore, sel: Selection, key: IntertieKey): LineStat {
    const at = this.limitState(st, key);
    const plan = st.array(this.ctx.ds, key, 'plan');
    let n = 0;
    let fwd = 0;
    let rev = 0;
    let sum = 0;
    for (const i of sel.days) {
      for (let s = 0; s < SLOTS; s++) {
        if (!sel.slotMask[s]) continue;
        const v = at(i * SLOTS + s);
        if (Number.isNaN(v)) continue;
        n++;
        sum += plan[i * SLOTS + s];
        if (v > 0) fwd++;
        else if (v < 0) rev++;
      }
    }
    return { key, n, fwd, rev, mean: n > 0 ? sum / n : Number.NaN };
  }

  private renderOverview(st: IntertieStore, sel: Selection, lines: IntertieKey[]): void {
    const { state, theme } = this.ctx;
    const t = TOKENS[theme];
    const stats = lines.map((k) => this.stat(st, sel, k)).filter((x) => x.n > 0);
    this.overviewKeys = stats.map((x) => x.key);
    this.overview.setHeight(Math.max(240, stats.length * 38 + 100));
    this.overview.setSubtitle(
      `${describeSelection(sel, state)}・計画潮流（翌日）が順方向・逆方向の上限に達したコマの割合（上限との差が 0.5 MW 以内）・押すとその連系線を選びます`,
    );
    const pct = (a: number, n: number) => (n > 0 ? (a / n) * 100 : Number.NaN);
    const names = ['順方向で上限', '逆方向で上限'];
    const colors = [t.cat[0], t.cat[1]];
    this.overview.setOption(
      {
        grid: grid({ top: 44, right: 24, left: 8 }),
        legend: lineLegend(names.map((name) => ({ name })), { data: names.map((name) => ({ name, icon: 'rect' })) }),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (ps: { dataIndex: number }[]) => {
            const x = stats[ps[0]?.dataIndex ?? -1];
            if (!x) return '';
            return (
              ttHeader(intertieTitle(x.key)) +
              ttRow(colors[0], fmtPct(x.fwd / x.n), `順方向（${forward(x.key)}）で上限（${fmtNum(x.fwd)} コマ）`, 'rect') +
              ttRow(colors[1], fmtPct(x.rev / x.n), `逆方向（${backward(x.key)}）で上限（${fmtNum(x.rev)} コマ）`, 'rect') +
              ttNote(`計画潮流の平均 ${fmtSigned(x.mean, 0)} MW・${fmtNum(x.n)} コマ`)
            );
          },
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: stats.map((x) => x.key),
          axisTick: { show: false },
          axisLabel: { interval: 0, lineHeight: 16, formatter: (key: IntertieKey) => axisName(key), rich: { f: { fontSize: 11, lineHeight: 14, color: t.muted } } },
        },
        xAxis: { type: 'value', name: '%', min: 0, axisLabel: { formatter: (v: number) => `${v}` } },
        series: [
          { name: names[0], type: 'bar', stack: 'limit', barMaxWidth: 18, itemStyle: { color: colors[0] }, data: stats.map((x) => pct(x.fwd, x.n)) },
          {
            name: names[1],
            type: 'bar',
            stack: 'limit',
            barMaxWidth: 18,
            itemStyle: { color: colors[1], borderRadius: [0, 4, 4, 0] },
            data: stats.map((x) => pct(x.rev, x.n)),
          },
        ],
      },
      {
        columns: ['連系線', '順方向', 'コマ数', '順方向で上限（%）', '逆方向で上限（%）', '順方向で上限（コマ）', '逆方向で上限（コマ）', '計画潮流の平均（MW）'],
        rows: stats.map((x) => [intertieTitle(x.key), forward(x.key), x.n, pct(x.fwd, x.n), pct(x.rev, x.n), x.fwd, x.rev, x.mean]),
        digits: [null, null, 0, 1, 1, 0, 0, 0],
        filename: `jepx_interties_congestion_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderTrend(st: IntertieStore, sel: Selection, key: IntertieKey): void {
    const { ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const color = { cat0: t.cat[0], cat1: t.cat[1], cat2: t.cat[2], neutral: t.neutralSeries };
    const gran = curveGranularity(sel, state.intertieGran);
    const zoom = slotZoom(gran);
    const raw = buildSeriesPoints(sel, TREND_LINES.map((l) => ({ a: st.array(ds, key, l.field) })), gran, 'mean');
    // 値の無い種類（潮流実績は 2025 年 4 月から）は出さない
    const shown = TREND_LINES.map((l, i) => ({ ...l, points: raw[i].points })).filter((l) => l.points.some((p) => Number.isFinite(p[1])));
    this.trend.setTitle(`${intertieTitle(key)}の計画潮流と上限の推移`);
    this.trend.setSubtitle(`${describeSelection(sel, state)}・MW（正は順方向: ${forward(key)}）、${granText(gran)}`);
    // 値の無い期間や日（線が切れる所）と、その理由を図の下に書く
    this.trend.footer.replaceChildren(...coverageNotes(key, this.coverage(st, sel, key), !st.isDemo).map((text) => h('p', { class: 'card-note' }, text)));
    const names = shown.map((l) => l.name);
    const ends = endLabels(names, shown.map((l) => l.points.map((p) => p[1])), theme, 260);
    this.trend.setOption(
      {
        grid: grid({ right: labelRoom(names.length), bottom: zoom.bottom }),
        legend: lineLegend(shown.map((l) => ({ name: l.name, dashed: l.dashed }))),
        ...(zoom.dataZoom ? { dataZoom: zoom.dataZoom } : {}),
        tooltip: {
          trigger: 'axis',
          formatter: namedTooltip(
            names,
            shown.map((l) => color[l.color]),
            (p) => periodLabel(Number((p.value as number[])[0]), gran),
            (v) => `${fmtSigned(v, 0)} MW`,
            shown.map((l) => l.dashed),
          ),
        },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis('MW'),
        series: shown.map((l, i) =>
          styledLine(l.name, color[l.color], theme, gran === 'slot' ? breakGaps(l.points) : l.points, l.dashed, {
            sampling: LINE_SAMPLING,
            ...(l.field === 'actual' ? { lineStyle: { width: 1.5 } } : {}),
            ...ends[i],
          }),
        ),
      },
      {
        columns: ['期間', ...names.map((n) => `${n}（MW）`)],
        rows: (shown[0]?.points ?? []).map((p, r) => [periodLabel(p[0], gran), ...shown.map((l) => l.points[r][1])]),
        digits: [null, ...names.map(() => 1)],
        filename: `jepx_intertie_${key}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderProfile(st: IntertieStore, sel: Selection, key: IntertieKey): void {
    const { ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const color = { cat0: t.cat[0], cat1: t.cat[1], cat2: t.cat[2], neutral: t.neutralSeries };
    const lines = TREND_LINES.filter((l) => l.field !== 'planFinal')
      .map((l) => {
        const g = aggregateBySlot(sel, { a: st.array(ds, key, l.field) });
        return { ...l, values: sel.slots.map((s) => accMean(g.acc[s])) };
      })
      .filter((l) => l.values.some(Number.isFinite));
    this.profile.setSubtitle(`${describeSelection(sel, state)}・各コマの平均（MW、正は ${forward(key)}）`);
    const names = lines.map((l) => l.name);
    this.profile.setOption(
      {
        grid: grid({ right: 24 }),
        legend: lineLegend(lines.map((l) => ({ name: l.name, dashed: l.dashed }))),
        tooltip: {
          trigger: 'axis',
          formatter: namedTooltip(
            names,
            lines.map((l) => color[l.color]),
            (p) => `${String(p.axisValue)} 開始のコマの平均`,
            (v) => `${fmtSigned(v, 0)} MW`,
            lines.map((l) => l.dashed),
          ),
        },
        xAxis: slotAxis(sel.slots),
        yAxis: valueAxis('MW'),
        series: lines.map((l) => styledLine(l.name, color[l.color], theme, l.values, l.dashed)),
      },
      {
        columns: ['時刻', ...names.map((n) => `${n}（MW）`)],
        rows: sel.slots.map((s, r) => [slotStartLabel(s), ...lines.map((l) => l.values[r])]),
        digits: [null, ...names.map(() => 1)],
        filename: `jepx_intertie_${key}_profile_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderCongestion(st: IntertieStore, sel: Selection, key: IntertieKey): void {
    const { state, theme } = this.ctx;
    const t = TOKENS[theme];
    const at = this.limitState(st, key);
    const rows = sel.slots.map((s) => {
      let n = 0;
      let fwd = 0;
      let rev = 0;
      for (const i of sel.days) {
        const v = at(i * SLOTS + s);
        if (Number.isNaN(v)) continue;
        n++;
        if (v > 0) fwd++;
        else if (v < 0) rev++;
      }
      return { s, n, fwd: n > 0 ? (fwd / n) * 100 : Number.NaN, rev: n > 0 ? (rev / n) * 100 : Number.NaN };
    });
    this.congestion.setSubtitle(`${describeSelection(sel, state)}・計画潮流（翌日）が上限に達した日の割合（%）`);
    const names = [`順方向（${forward(key)}）`, `逆方向（${backward(key)}）`];
    const colors = [t.cat[0], t.cat[1]];
    this.congestion.setOption(
      {
        grid: grid(),
        legend: lineLegend(names.map((name) => ({ name })), { data: names.map((name) => ({ name, icon: 'rect' })) }),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (ps: { dataIndex: number }[]) => {
            const r = rows[ps[0]?.dataIndex ?? -1];
            if (!r) return '';
            return ttHeader(slotRangeLabel(r.s)) + ttRow(colors[0], `${fmtNum(r.fwd, 1)}%`, names[0], 'rect') + ttRow(colors[1], `${fmtNum(r.rev, 1)}%`, names[1], 'rect') + ttNote(`${fmtNum(r.n)} 日`);
          },
        },
        xAxis: slotAxis(sel.slots),
        yAxis: valueAxis('%', { min: 0 }),
        series: [
          { name: names[0], type: 'bar', stack: 'limit', itemStyle: { color: colors[0] }, data: rows.map((r) => r.fwd) },
          { name: names[1], type: 'bar', stack: 'limit', itemStyle: { color: colors[1], borderRadius: [4, 4, 0, 0] }, data: rows.map((r) => r.rev) },
        ],
      },
      {
        columns: ['時刻', '日数', `${names[0]}で上限（%）`, `${names[1]}で上限（%）`],
        rows: rows.map((r) => [slotStartLabel(r.s), r.n, r.fwd, r.rev]),
        digits: [null, 0, 1, 1],
        filename: `jepx_intertie_${key}_congestion_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderHeat(st: IntertieStore, sel: Selection, key: IntertieKey): void {
    const { ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const g = buildGrid(sel, { a: st.array(ds, key, 'plan') }, 'dateSlot');
    this.heat.setTitle(`${intertieTitle(key)}の計画潮流（翌日）のヒートマップ`);
    if (g.cells.length === 0) {
      this.heat.setEmpty('選択した期間に、この連系線の計画潮流がありません。');
      return;
    }
    this.heat.setSubtitle(`${describeSelection(sel, state)}・MW（赤は順方向: ${forward(key)}、青は逆方向）${g.note ? `・${g.note}` : ''}`);
    const [min, max] = colorRange(g, true);
    this.heat.setHeight(heatmapHeight(g));
    this.heat.setOption(
      heatmapOption(g, { theme, min, max, colors: t.div, precision: 0, fmt: (v) => `${fmtSigned(v, 0)} MW`, valueLabel: '計画潮流（翌日）' }),
      gridTable(g, `jepx_intertie_${key}_heatmap_${rangeTag(sel)}.csv`),
    );
  }

  /** エリアごとの正味の受け入れ量（計画潮流（翌日）を足し引きしたもの）の推移 */
  private renderNet(st: IntertieStore, sel: Selection): void {
    const { ds, state, theme } = this.ctx;
    const gran = curveGranularity(sel, state.intertieGran);
    const zoom = slotZoom(gran);
    const net = st.netImports(ds);
    const raw = buildSeriesPoints(sel, AREA_KEYS.map((a) => ({ a: net[a] })), gran, 'mean');
    const shown = AREA_KEYS.map((a, i) => ({ name: SERIES_LABEL[a], color: seriesColor(a, theme), dashed: seriesDashed(a), points: raw[i].points })).filter((l) =>
      l.points.some((p) => Number.isFinite(p[1])),
    );
    if (shown.length === 0) {
      this.net.setEmpty('選択した期間に、エリアの受け入れ量を求められる計画潮流がありません。');
      return;
    }
    this.net.setSubtitle(`${describeSelection(sel, state)}・MW（正は受け入れ、負は送り出し）、${granText(gran)}`);
    const names = shown.map((l) => l.name);
    this.net.setOption(
      {
        grid: grid({ right: 24, bottom: zoom.bottom }),
        legend: lineLegend(shown.map((l) => ({ name: l.name, dashed: l.dashed }))),
        ...(zoom.dataZoom ? { dataZoom: zoom.dataZoom } : {}),
        tooltip: {
          trigger: 'axis',
          formatter: namedTooltip(
            names,
            shown.map((l) => l.color),
            (p) => periodLabel(Number((p.value as number[])[0]), gran),
            (v) => `${fmtSigned(v, 0)} MW`,
            shown.map((l) => l.dashed),
          ),
        },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis('MW'),
        series: shown.map((l) => styledLine(l.name, l.color, theme, gran === 'slot' ? breakGaps(l.points) : l.points, l.dashed, { sampling: LINE_SAMPLING })),
      },
      {
        columns: ['期間', ...names.map((n) => `${n}（MW）`)],
        rows: (shown[0]?.points ?? []).map((p, r) => [periodLabel(p[0], gran), ...shown.map((l) => l.points[r][1])]),
        digits: [null, ...names.map(() => 1)],
        filename: `jepx_intertie_net_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderNetHeat(st: IntertieStore, sel: Selection): void {
    const { ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const area = state.intertieArea;
    const g = buildGrid(sel, { a: st.netImports(ds)[area] }, 'dateSlot');
    this.netHeat.setTitle(`${SERIES_LABEL[area]}の正味の受け入れ量のヒートマップ`);
    if (g.cells.length === 0) {
      this.netHeat.setEmpty('選択した期間に、このエリアの受け入れ量を求められる計画潮流がありません。');
      return;
    }
    this.netHeat.setSubtitle(`${describeSelection(sel, state)}・MW（赤は受け入れ、青は送り出し）${g.note ? `・${g.note}` : ''}`);
    const [min, max] = colorRange(g, true);
    this.netHeat.setHeight(heatmapHeight(g));
    this.netHeat.setOption(
      heatmapOption(g, { theme, min, max, colors: t.div, precision: 0, fmt: (v) => `${fmtSigned(v, 0)} MW`, valueLabel: '正味の受け入れ量' }),
      gridTable(g, `jepx_intertie_net_${area}_heatmap_${rangeTag(sel)}.csv`),
    );
  }
}
