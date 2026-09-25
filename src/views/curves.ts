/**
 * 入札カーブ：受渡日・時間帯ごとの売り・買いの入札カーブ（価格ごとの累積の入札量）と、
 * カーブから計算した指標（価格帯ごとの入札量・価格感応度）の推移。
 * 売り入札は青、買い入札は橙（入札・約定量のタブと同じ色）。同じ側の線を何本も重ねるときは、その色相の濃淡で順序を表す。
 */
import { GRANULARITY_LABEL } from '../lib/aggregate';
import { aloneSlots, areaCurve, areaLabel, blockGapText, CURVE_TARGETS, type AreaCurve, type CurveTarget, type SpotBids, type StepCurve } from '../lib/areaCurves';
import {
  buyVolumeAt,
  buyVolumesAt,
  crossing,
  CURVE_METRICS,
  rowsFromSteps,
  sellVolumeAt,
  sellVolumesAt,
  SIMPLIFY_RATIO,
  stepPath,
  stepPrices,
  SYSTEM_LABEL,
  type CurveDay,
  type CurveMetricKey,
} from '../lib/bidCurves';
import { COMPARE_DAYS, type CurveStore } from '../lib/curveStore';
import { DOW_LABEL, dowOfDay, formatDay, isoFromDay, parseDateString, slotRangeLabel, slotStartLabel, ymdFromDay } from '../lib/dates';
import { fmtNum, fmtPrice } from '../lib/format';
import { kwhToMw, SERIES_INDEX, SLOTS, type AreaKey, type SeriesKey } from '../lib/series';
import { reselect, type Selection } from '../lib/select';
import { niceStep } from '../lib/stats';
import { MAX_CURVE_PICKS, normalizePicks, type CurveCompare, type CurvePick, type CurveRange, type CurveSide } from '../state';
import type { ChartCard, TableData } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { h, uniqueId } from '../ui/dom';
import { ordinalColors, seriesColor, TOKENS, type ThemeName } from '../ui/theme';
import { ttHeader, ttNote, ttRow } from '../ui/tooltip';
import { View } from './base';
import { describeSelection, endLabels, grid, labelRoom, lineLegend, PRICE_UNIT, rangeTag, styledLine, valueAxis } from './common';
import { buildGrid, colorRange, gridTable, heatmapHeight, heatmapOption } from './heatmap';
import { autoGranularity, breakGaps, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL } from './timeseries';

const NO_CURVES =
  '入札カーブのデータがありません。npm run fetch でデータを取得すると、取引結果と一緒に入札カーブ（既定で直近 90 日分）も取得します。';
const SIDE_LABEL: Record<CurveSide, string> = { sell: '売り入札', buy: '買い入札' };
/** 比較の図で色を付ける本数（隣と見分けられる濃淡の段の数。それより古い日は灰色） */
const MAX_COLORED = 5;
/** 時間帯を比べるときの間隔（12 コマ = 6 時間） */
const SLOT_STEP = 12;
/** 価格の範囲「自動」「すべて」で選ぶ縦軸の上限の候補 */
const PRICE_MAX_STEPS = [30, 50, 100, 200, 500, 1000];
/** 線と、その横に置く名前の間（px） */
const LABEL_GAP = 6;
/** 交点のラベルの幅の目安（px。1 行・2 行に折り返したとき） */
const CROSS_LABEL_WIDTH = 176;
const CROSS_LABEL_WIDTH_WRAPPED = 120;
/** グラフ領域の上端（凡例 1 行と縦軸の名前の分）と、凡例が折り返したときの 1 行の高さ */
const PLOT_TOP = 36;
const LEGEND_ROW = 24;

/** 価格帯ごとの入札量の推移で見る指標（入れ子になっている順。最後が合計） */
const DEPTH: Record<CurveSide, { key: CurveMetricKey; name: string }[]> = {
  sell: [
    { key: 'sell001', name: '0.01円以下' },
    { key: 'sell10', name: '10円以下' },
    { key: 'sell20', name: '20円以下' },
    { key: 'sellTotal', name: '合計' },
  ],
  buy: [
    { key: 'buyTop', name: '最高価格' },
    { key: 'buy20', name: '20円以上' },
    { key: 'buy10', name: '10円以上' },
    { key: 'buyTotal', name: '合計' },
  ],
};

const SENSITIVITY: { key: CurveMetricKey; name: string; short: string }[] = [
  { key: 'upPrice', name: '買いが 1GW 増えたときの上昇幅', short: '上昇幅' },
  { key: 'downPrice', name: '買いが 1GW 減ったときの下落幅', short: '下落幅' },
];

type AxisParam = { axisValue?: unknown; seriesIndex: number; value: unknown };

interface CompareItem {
  name: string;
  curve: AreaCurve;
  color: string;
}

const targetLabel = (t: CurveTarget): string => (t === 'system' ? SYSTEM_LABEL : areaLabel(t));
/** 推定したカーブ（単エリア）。線を破線にする */
const isEstimate = (c: AreaCurve): boolean => c.kind === 'single' || c.kind === 'combined';
const pickName = (p: CurvePick): string => `${shortDay(p.day)} ${slotStartLabel(p.slot)}`;

export class CurvesView extends View {
  private message!: HTMLElement;
  private content!: HTMLElement;
  private demoNote!: HTMLElement;
  private shapesNote!: HTMLElement;
  private periodNote!: HTMLElement;
  private methodNote!: HTMLElement;
  private checkNote!: HTMLElement;
  private aloneRow!: HTMLElement;
  private dateInput!: HTMLInputElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private latestBtn!: HTMLButtonElement;
  private slot!: SelectField<string>;
  private target!: SelectField<CurveTarget>;
  private range!: Segmented<CurveRange>;
  private compare!: Segmented<CurveCompare>;
  private side!: Segmented<CurveSide>;
  private picksRow!: HTMLElement;
  private pickDate!: HTMLInputElement;
  private pickSlot!: HTMLSelectElement;
  private pickAdd!: HTMLButtonElement;
  private pickList!: HTMLElement;
  /** 追加する日・時間帯の入力を、今の日・時間帯で初期化したか */
  private pickerReady = false;
  private depthSide!: Segmented<CurveSide>;
  private metric!: SelectField<CurveMetricKey>;
  private curve!: ChartCard;
  private comparison!: ChartCard;
  private depth!: ChartCard;
  private sensitivity!: ChartCard;
  private heat!: ChartCard;
  /** 凡例で非表示にした系列（ツールチップに出さない）。描き直すと凡例は全部表示に戻る */
  private hidden = new Map<ChartCard, Record<string, boolean>>();

  protected build(): void {
    const s = this.ctx.state;
    this.message = h('p', { class: 'view-message', hidden: true }, NO_CURVES);
    this.content = h('div', { class: 'curves' });
    this.root.append(this.message, this.content);

    const dateId = uniqueId('cd');
    this.dateInput = h('input', { id: dateId, type: 'date', onchange: () => this.onDateInput() });
    this.prevBtn = h('button', { type: 'button', class: 'btn', title: '前の受渡日', 'aria-label': '前の受渡日', onclick: () => this.stepDate(-1) }, '◀');
    this.nextBtn = h('button', { type: 'button', class: 'btn', title: '次の受渡日', 'aria-label': '次の受渡日', onclick: () => this.stepDate(1) }, '▶');
    this.latestBtn = h('button', { type: 'button', class: 'btn', onclick: () => this.set({ curveDate: Number.NaN }) }, '最新');
    const dateField = h(
      'div',
      { class: 'field' },
      h('label', { for: dateId }, '受渡日'),
      h('div', { class: 'date-nav' }, this.prevBtn, this.dateInput, this.nextBtn, this.latestBtn),
    );
    this.slot = selectField(
      '時間帯',
      Array.from({ length: SLOTS }, (_, i) => ({ value: String(i), label: slotRangeLabel(i) })),
      String(s.curveSlot),
      (v) => this.set({ curveSlot: Number(v) }),
    );
    this.target = selectField(
      '対象',
      CURVE_TARGETS.map((t) => ({ value: t, label: targetLabel(t) })),
      s.curveArea,
      (v) => this.set({ curveArea: v }),
    );
    this.range = segmented(
      '価格の範囲',
      [
        { value: 'auto', label: '自動' },
        { value: '30', label: '〜30円' },
        { value: '50', label: '〜50円' },
        { value: '100', label: '〜100円' },
        { value: 'all', label: 'すべて' },
      ],
      s.curveRange,
      (v) => this.set({ curveRange: v }),
    );
    this.compare = segmented(
      '比べるもの',
      [
        { value: 'days', label: `直近 ${COMPARE_DAYS} 日` },
        { value: 'slots', label: '6 時間おき' },
        { value: 'picks', label: '自由に選ぶ' },
      ],
      s.curveCompare,
      (v) => this.onCompare(v),
    );
    const sides = [
      { value: 'sell' as const, label: '売り入札' },
      { value: 'buy' as const, label: '買い入札' },
    ];
    this.side = segmented('比べる側', sides, s.curveSide, (v) => this.set({ curveSide: v }));
    this.depthSide = segmented('入札', sides, s.curveDepth, (v) => this.set({ curveDepth: v }));
    this.metric = selectField(
      '指標',
      CURVE_METRICS.map((m) => ({ value: m.key, label: m.label })),
      s.curveMetric,
      (v) => this.set({ curveMetric: v }),
    );
    const pickId = uniqueId('cp');
    this.pickDate = h('input', { id: pickId, type: 'date' });
    this.pickSlot = h(
      'select',
      { 'aria-label': '追加する時間帯' },
      Array.from({ length: SLOTS }, (_, i) => h('option', { value: String(i) }, slotRangeLabel(i))),
    );
    this.pickAdd = h('button', { type: 'button', class: 'btn', onclick: () => this.addPick() }, '追加');
    this.pickList = h('div', { class: 'picks', role: 'group', 'aria-label': '比べる日・時間帯（押すと外す）' });

    this.shapesNote = h('p', { class: 'view-note', hidden: true });
    this.demoNote = h(
      'p',
      { class: 'view-note', hidden: true },
      'デモ表示: 入札カーブは、デモデータの価格の近くで交わるように合成したもので、実際の入札カーブではありません。',
    );
    this.content.append(
      h('h2', { class: 'view-section-title' }, '1 コマの入札カーブ'),
      toolbar(dateField, this.slot.el, this.target.el, this.range.el),
      h(
        'p',
        { class: 'view-note' },
        '売り入札は価格の安い順、買い入札は価格の高い順に入札量を積み上げたカーブです。2 本の交点が約定価格と約定量になります。' +
          '対象でエリアを選ぶと、日付や時間帯を変えても、そのエリアの価格を決めたカーブ（市場分断していれば分断エリアのカーブ）を表示します。' +
          '1 エリアだけで分断した単エリアは JEPX がカーブを出していないため、推定して破線で表示します。',
      ),
      this.shapesNote,
      this.demoNote,
    );
    const g1 = h('div', { class: 'card-grid' });
    this.content.append(g1);
    this.curve = this.card(g1, { title: '入札カーブ', height: 420 });
    this.methodNote = h('p', { class: 'card-note', hidden: true });
    this.checkNote = h('p', { class: 'card-note', hidden: true });
    this.aloneRow = h('div', { class: 'card-note alone', hidden: true });
    this.curve.footer.append(
      this.methodNote,
      this.checkNote,
      this.aloneRow,
      h(
        'p',
        { class: 'card-note' },
        `描画用に、売り・買いそれぞれの合計量の ${SIMPLIFY_RATIO * 100}% 未満の入札量の増え方は次の価格の段にまとめています（交点もまとめた後のカーブから求めています）。`,
      ),
    );
    this.comparison = this.card(g1, { title: '入札カーブの比較', height: 420 });
    this.comparison.addControls(this.compare.el, this.side.el);
    this.picksRow = this.comparison.addControls(
      h('div', { class: 'field' }, h('label', { for: pickId }, '比べる日・時間帯を追加'), h('div', { class: 'date-nav' }, this.pickDate, this.pickSlot, this.pickAdd)),
      this.pickList,
    );

    this.periodNote = h('p', { class: 'view-note' });
    this.content.append(h('h2', { class: 'view-section-title' }, '期間で見る'), this.periodNote);
    const g2 = h('div', { class: 'card-grid' });
    this.content.append(g2);
    this.depth = this.card(g2, { title: '価格帯ごとの入札量の推移', height: 340 });
    this.depth.addControls(this.depthSide.el);
    this.sensitivity = this.card(g2, { title: '価格感応度の推移', height: 340 });
    this.heat = this.card(g2, { title: '指標のヒートマップ', height: 480, wide: true });
    this.heat.addControls(this.metric.el);
    for (const card of [this.curve, this.comparison]) {
      card.chart.on('legendselectchanged', (e: unknown) => {
        this.hidden.set(card, (e as { selected: Record<string, boolean> }).selected);
      });
    }
  }

  private isShown(card: ChartCard, name: string): boolean {
    return this.hidden.get(card)?.[name] !== false;
  }

  protected render(): void {
    const { curves: cs, state } = this.ctx;
    this.message.hidden = cs !== null;
    this.content.hidden = cs === null;
    if (!cs) return;

    const date = cs.resolve(state.curveDate);
    this.demoNote.hidden = !cs.isDemo;
    // 1 ファイル版では、1 コマのカーブは直近の数日分だけ入っている
    const fewer = cs.first > cs.metricsFirst;
    this.shapesNote.hidden = !fewer;
    if (fewer) {
      this.shapesNote.textContent = `1 コマのカーブは ${formatDay(cs.first)}〜${formatDay(cs.last)} の ${fmtNum(cs.days.length)} 日分を見られます（期間で見る指標は ${formatDay(cs.metricsFirst)} から）。`;
    }
    this.dateInput.min = isoFromDay(cs.first);
    this.dateInput.max = isoFromDay(cs.last);
    this.dateInput.value = isoFromDay(date);
    this.prevBtn.disabled = cs.step(date, -1) === null;
    this.nextBtn.disabled = cs.step(date, 1) === null;
    this.latestBtn.disabled = date === cs.last;
    this.slot.set(String(state.curveSlot));
    this.target.set(state.curveArea);
    this.range.set(state.curveRange);
    this.compare.set(state.curveCompare);
    this.side.set(state.curveSide);
    this.depthSide.set(state.curveDepth);
    this.metric.set(state.curveMetric);

    this.renderCurve(cs, date);
    this.renderComparison(cs, date);
    this.renderPeriod(cs);
  }

  private onDateInput(): void {
    const cs = this.ctx.curves;
    const day = parseDateString(this.dateInput.value);
    if (cs && day !== null) this.set({ curveDate: cs.resolve(day) });
  }

  private stepDate(step: number): void {
    const cs = this.ctx.curves;
    if (!cs) return;
    const day = cs.step(cs.resolve(this.ctx.state.curveDate), step);
    if (day !== null) this.set({ curveDate: day });
  }

  /** 「自由に選ぶ」に切り替えたとき、まだ何も選んでいなければ今の日・時間帯から始める */
  private onCompare(v: CurveCompare): void {
    const { state, curves: cs } = this.ctx;
    if (v === 'picks' && state.curvePicks.length === 0 && cs) {
      this.set({ curveCompare: v, curvePicks: [{ day: cs.resolve(state.curveDate), slot: state.curveSlot }] });
    } else {
      this.set({ curveCompare: v });
    }
  }

  private addPick(): void {
    const cs = this.ctx.curves;
    const day = parseDateString(this.pickDate.value);
    if (!cs || day === null) return;
    this.set({ curvePicks: normalizePicks([...this.ctx.state.curvePicks, { day: cs.resolve(day), slot: Number(this.pickSlot.value) }]) });
  }

  private removePick(p: CurvePick): void {
    this.set({ curvePicks: this.ctx.state.curvePicks.filter((q) => q.day !== p.day || q.slot !== p.slot) });
  }

  /** 受渡日・コマの取引結果の値（約定価格、入札量は kWh。無ければ NaN） */
  private price(day: number, slot: number, key: SeriesKey): number {
    const { ds } = this.ctx;
    const i = day - ds.start;
    return i < 0 || i >= ds.n ? Number.NaN : ds.values[SERIES_INDEX[key]][i * SLOTS + slot];
  }

  /** 取引結果の売り・買い入札量とブロック入札の量（MW。デモのカーブは取引結果と別に合成しているので使わない） */
  private spotBids(day: number, slot: number): SpotBids | null {
    if (this.ctx.curves?.isDemo) return null;
    const v = (k: SeriesKey) => kwhToMw(this.price(day, slot, k));
    return {
      sellBid: v('sellBid'),
      buyBid: v('buyBid'),
      sellBlockBid: v('sellBlockBid'),
      sellBlockVolume: v('sellBlockVolume'),
      buyBlockBid: v('buyBlockBid'),
      buyBlockVolume: v('buyBlockVolume'),
    };
  }

  /** その日・時間帯に、target の価格を決めたカーブ（カーブが無ければ null） */
  private curveOf(day: CurveDay, slot: number, target: CurveTarget): AreaCurve | null {
    const groups = day.slots[slot];
    if (!groups) return null;
    return areaCurve(groups, target, (a) => this.price(day.day, slot, a), { spot: this.spotBids(day.day, slot), residual: day.residuals?.[slot] });
  }

  /** その日・時間帯に、対象の価格を決めたカーブ（カーブが無ければ null） */
  private resolveCurve(cs: CurveStore, day: number, slot: number): AreaCurve | null {
    const d = cs.getDay(day);
    return d ? this.curveOf(d, slot, this.ctx.state.curveArea) : null;
  }

  // ---- 1 コマの入札カーブ ----

  private renderCurve(cs: CurveStore, date: number): void {
    const { state, theme } = this.ctx;
    const slot = state.curveSlot;
    const target = state.curveArea;
    const when = `${formatDay(date, true)} ${slotRangeLabel(slot)}`;
    this.methodNote.hidden = true;
    this.checkNote.hidden = true;
    this.aloneRow.hidden = true;
    const day = cs.getDay(date);
    if (!day) {
      this.curve.setEmpty(`${formatDay(date, true)} の入札カーブを読み込めませんでした。`);
      return;
    }
    const ac = this.resolveCurve(cs, date, slot);
    if (!ac) {
      this.curve.setEmpty(`${when} の入札カーブがありません。`);
      return;
    }
    const published = this.price(date, slot, target);
    const priceText = Number.isFinite(published) ? `・約定価格 ${fmtPrice(published)} ${PRICE_UNIT}` : '';
    this.curve.setSubtitle(`${when}・${targetText(target, ac)}${priceText}`);
    if (ac.kind === 'unavailable') {
      this.curve.setEmpty(unavailableText(target, ac));
      return;
    }
    const sellColor = seriesColor('sellBid', theme);
    const buyColor = seriesColor('buyBid', theme);
    const estimate = isEstimate(ac);
    const rows = rowsFromSteps(ac.sell, ac.buy);
    // 単エリアが複数のときは交点に意味が無いので、代わりに各エリアの約定価格の線を引く
    const lines = ac.kind === 'combined' ? priceLines(ac.areas, (a) => this.price(date, slot, a)) : [];
    // 単エリアの推定は約定価格の点に。ただし、もう約定価格で交わっていれば交点の決まりどおりに求める
    // （交点の段で売りと買いの量が違う。売りと買いが同じ量の価格が幅を持つときは、約定価格の点にする）
    const c = ac.correction;
    const cross =
      ac.kind === 'combined'
        ? null
        : c && !(c.mw === 0 && Math.abs((ac.rawCrossing ?? Number.NaN) - c.price) < 0.005)
          ? { price: c.price, volume: sellVolumeAt(ac.sell, c.price) }
          : crossing(rows);
    const ymax = priceMax(state.curveRange, [ac], cross ? [cross.price] : lines.map((l) => l.price));
    const xmax = volumeMax([ac], ymax, ['sell', 'buy']);
    const plotWidth = this.curve.chart.getWidth() - 100;

    this.renderMethod(ac, day, slot);

    const series: Record<string, unknown>[] = [
      styledLine(SIDE_LABEL.sell, sellColor, theme, toGw(ac.sell), estimate, {
        symbol: 'none',
        z: 3,
        ...(lines.length > 0 ? { markLine: priceMarkLine(lines, theme) } : {}),
      }),
      styledLine(SIDE_LABEL.buy, buyColor, theme, toGw(ac.buy), estimate, { symbol: 'none', z: 3 }),
      priceProbe(ymax),
    ];
    if (cross) series.push(crossingSeries(cross, theme, ((cross.volume / 1000) / xmax) * plotWidth, plotWidth));
    // 売りは安いところ、買いは高いところで、カーブの左（量の少ない側）に名前を置く
    const low = ymax * 0.15;
    const high = ymax * 0.85;
    series.push(
      lineLabels(
        [
          { name: SIDE_LABEL.sell, x: sellVolumeAt(ac.sell, low) / 1000, y: low, position: 'left', others: [buyVolumeAt(ac.buy, low) / 1000] },
          { name: SIDE_LABEL.buy, x: buyVolumeAt(ac.buy, high) / 1000, y: high, position: 'left', others: [sellVolumeAt(ac.sell, high) / 1000] },
        ],
        xmax,
        plotWidth,
        theme,
      ),
    );

    this.hidden.delete(this.curve);
    this.curve.setOption(
      {
        grid: grid({ top: PLOT_TOP, bottom: 28, right: 24 }),
        legend: lineLegend([
          { name: SIDE_LABEL.sell, dashed: estimate },
          { name: SIDE_LABEL.buy, dashed: estimate },
        ]),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'line', axis: 'y', snap: false },
          formatter: (params: AxisParam | AxisParam[]) => {
            const p = pointerPrice(params);
            if (p === null) return '';
            const sv = sellVolumeAt(ac.sell, p) / 1000;
            const bv = buyVolumeAt(ac.buy, p) / 1000;
            const showSell = this.isShown(this.curve, SIDE_LABEL.sell);
            const showBuy = this.isShown(this.curve, SIDE_LABEL.buy);
            let html = ttHeader(`${fmtPrice(p)} ${PRICE_UNIT}`);
            if (showSell) html += ttRow(sellColor, `${fmtNum(sv, 2)} GW`, `${SIDE_LABEL.sell}（この価格以下）`, estimate ? 'dash' : 'line');
            if (showBuy) html += ttRow(buyColor, `${fmtNum(bv, 2)} GW`, `${SIDE_LABEL.buy}（この価格以上）`, estimate ? 'dash' : 'line');
            if (estimate) html += ttNote('推定のカーブ');
            if (!showSell || !showBuy) return html;
            const diff = sv - bv;
            return html + ttNote(Math.abs(diff) < 0.005 ? '売りと買いがほぼ同じ量' : diff > 0 ? `売りが ${fmtNum(diff, 2)} GW 多い` : `買いが ${fmtNum(-diff, 2)} GW 多い`);
          },
        },
        xAxis: volumeAxis(xmax, theme),
        yAxis: valueAxis(PRICE_UNIT, { min: 0, max: ymax }),
        series,
      },
      {
        columns: ['価格（円/kWh）', `${SIDE_LABEL.sell}の累積（MW、この価格以下）`, `${SIDE_LABEL.buy}の累積（MW、この価格以上）`],
        rows: rows.map((r) => [r.price, r.sell, r.buy]),
        digits: [2, 0, 0],
        filename: `jepx_bidcurve_${fileDate(date)}_${slotStartLabel(slot).replace(':', '')}${target === 'system' ? '' : `_${target}`}${estimate ? '_estimated' : ''}.csv`,
      },
    );
  }

  /** 推定したカーブの作り方・確かめた結果と、単エリアが複数のときに補正できる時間帯 */
  private renderMethod(ac: AreaCurve, day: CurveDay, slot: number): void {
    const target = this.ctx.state.curveArea;
    if (!isEstimate(ac) || target === 'system') return;
    let text = `推定: システムプライスのカーブから、公表されている分断エリア（${(ac.subtracted ?? []).join('、')}）のカーブを引いたものです。`;
    if (ac.blocks) {
      text += `ブロック入札はシステムプライスの計算と市場分断の計算とで約定するものが違うため、取引結果のブロック入札の量から求めたその違い（${blockGapText(ac.blocks, fmtMw)}）を差し引いています。`;
    } else if (this.spotBids(day.day, slot)) {
      text += '取引結果にブロック入札の量が無いため、ブロック入札の約定の違いは差し引いていません（取引結果を取り直すと差し引けます）。';
    }
    const lift = ac.lift ?? 0;
    if (lift > 0) {
      text +=
        `分断エリアのカーブには連系線で送る量が買い、受ける量が売りとして入っていて、引くと売り・買いとも同じだけ引き過ぎになるため、売り・買いに同じ ${fmtMw(lift)} を足しています` +
        '（足す量そのものは分からないので、最も安い売りと最も高い買いの少ない方を 0 にしています。横軸の位置は目安で、カーブの形と交点の価格はこの量によりません）。';
    }
    if (ac.kind === 'single') {
      const c = ac.correction;
      const raw = Number.isFinite(ac.rawCrossing) ? `こうして作ったカーブの交点は ${fmtPrice(ac.rawCrossing!)} ${PRICE_UNIT} で` : 'こうして作ったカーブは交わらず';
      if (!c) text += `${raw}、約定価格が分からないため補正していません。`;
      else if (c.mw === 0) text += `こうして作ったカーブは、約定価格 ${fmtPrice(c.price)} ${PRICE_UNIT} で交わります。`;
      else {
        text += `${raw}、約定価格 ${fmtPrice(c.price)} ${PRICE_UNIT} で交わるように${SIDE_LABEL[c.side]}に ${fmtMw(c.mw)} を足して補正しています。`;
        if (!ac.exact) text += '（描画用に間引いたカーブどうしの差のため、少しずれます。入札カーブを変換し直すと、間引く前のカーブから求めます）';
      }
    } else {
      text += `単エリアが ${ac.areas.length} つ（${ac.label}）あり、エリアごとには分けられないため、${ac.areas.length} エリアを合わせたカーブです（補正なし）。破線の横線は各エリアの約定価格です。`;
    }
    const check = evidenceText(ac);
    this.checkNote.textContent = check;
    this.checkNote.hidden = check === '';
    this.methodNote.textContent = text;
    this.methodNote.hidden = false;
    if (ac.kind !== 'combined') return;
    const name = areaLabel(target);
    // 補正した推定を見られる（推定できる）時間帯だけ
    const near = aloneSlots(day, target)
      .filter((s) => this.curveOf(day, s, target)?.kind === 'single')
      .sort((a, b) => Math.abs(a - slot) - Math.abs(b - slot))
      .slice(0, 12)
      .sort((a, b) => a - b);
    this.aloneRow.replaceChildren(
      near.length > 0 ? `この日、${name}だけが単エリアになった時間帯（補正した推定を見られます）:` : `この日は、${name}だけが単エリアになった時間帯はありません。`,
      ...near.map((s) => h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.set({ curveSlot: s }) }, slotStartLabel(s))),
    );
    this.aloneRow.hidden = false;
  }

  private syncPicks(cs: CurveStore, date: number): void {
    const { state } = this.ctx;
    this.pickDate.min = isoFromDay(cs.first);
    this.pickDate.max = isoFromDay(cs.last);
    if (!this.pickerReady) {
      this.pickDate.value = isoFromDay(date);
      this.pickSlot.value = String(state.curveSlot);
      this.pickerReady = true;
    }
    const full = state.curvePicks.length >= MAX_CURVE_PICKS;
    this.pickAdd.disabled = full;
    this.pickAdd.title = full ? `${MAX_CURVE_PICKS} 件まで選べます（外すには、下の日・時間帯を押します）` : '';
    this.pickList.replaceChildren(
      ...state.curvePicks.map((p) =>
        h(
          'button',
          { type: 'button', class: 'pick', title: `${pickName(p)} を外す`, 'aria-label': `${pickName(p)} を外す`, onclick: () => this.removePick(p) },
          pickName(p),
          h('span', { class: 'pick-x', 'aria-hidden': 'true' }, '×'),
        ),
      ),
    );
  }

  private renderComparison(cs: CurveStore, date: number): void {
    const { state, theme } = this.ctx;
    const t = TOKENS[theme];
    const side = state.curveSide;
    const slot = state.curveSlot;
    const target = state.curveArea;
    const mode = state.curveCompare;
    this.picksRow.hidden = mode !== 'picks';
    if (mode === 'picks') this.syncPicks(cs, date);

    let raw: { name: string; curve: AreaCurve | null }[];
    let subtitle: string;
    if (mode === 'days') {
      const days = cs.recent(date, COMPARE_DAYS);
      raw = days.map((d) => ({ name: shortDay(d), curve: this.resolveCurve(cs, d, slot) }));
      subtitle = `${slotRangeLabel(slot)}・${formatDay(days[0])}〜${formatDay(date)}`;
    } else if (mode === 'slots') {
      const slots = Array.from({ length: SLOTS / SLOT_STEP }, (_, k) => (slot % SLOT_STEP) + k * SLOT_STEP);
      raw = slots.map((s) => ({ name: slotStartLabel(s), curve: this.resolveCurve(cs, date, s) }));
      subtitle = `${formatDay(date, true)}・6 時間おきの時間帯`;
    } else {
      raw = state.curvePicks.map((p) => ({ name: pickName(p), curve: this.resolveCurve(cs, p.day, p.slot) }));
      subtitle = '選んだ日・時間帯';
    }
    const present = raw.filter((r): r is { name: string; curve: AreaCurve } => r.curve !== null && r.curve.kind !== 'unavailable');
    const unavailable = raw.filter((r) => r.curve?.kind === 'unavailable').length;
    const missing = raw.length - present.length - unavailable;
    if (present.length === 0) {
      this.comparison.setEmpty(
        mode === 'picks' && raw.length === 0
          ? '比べる日・時間帯を選んで「追加」を押してください。'
          : unavailable > 0
            ? `比べる入札カーブがありません（${targetLabel(target)}の単エリアのカーブを推定できない ${unavailable} 件を除きました）。`
            : '比べる入札カーブがありません。',
      );
      return;
    }
    const colored = Math.min(present.length, MAX_COLORED);
    const ramp = ordinalColors(colored, theme, side === 'buy');
    const grayed = present.length - colored;
    const items: CompareItem[] = present.map((r, k) => ({ ...r, color: k < grayed ? t.deemph : ramp[k - grayed] }));
    const later = mode === 'days' ? '新しい日' : mode === 'slots' ? '遅い時刻' : '新しい日・時刻';
    this.comparison.setSubtitle(
      `${targetLabel(target)}・${SIDE_LABEL[side]}・${subtitle}・${theme === 'light' ? '色が濃い' : '色が明るい'}ほど${later}` +
        (grayed > 0 ? `（灰色は古い ${grayed} 日）` : '') +
        (items.some((it) => isEstimate(it.curve)) ? '・破線は推定' : '') +
        (missing > 0 ? `・カーブの無い ${missing} 件を除く` : '') +
        (unavailable > 0 ? `・単エリアを推定できない ${unavailable} 件を除く` : ''),
    );

    const crosses = items.map((it) => referencePrice(it.curve));
    const ymax = priceMax(state.curveRange, items.map((it) => it.curve), crosses);
    const xmax = volumeMax(items.map((it) => it.curve), ymax, [side]);
    const steps = (it: CompareItem) => (side === 'sell' ? it.curve.sell : it.curve.buy);
    const volumeAt = side === 'sell' ? sellVolumeAt : buyVolumeAt;
    const series: Record<string, unknown>[] = items.map((it, k) =>
      styledLine(it.name, it.color, theme, toGw(steps(it)), isEstimate(it.curve), { symbol: 'none', z: 2 + k }),
    );
    series.push(priceProbe(ymax));
    if (items.length <= 4) {
      // 売りは価格の高いところ、買いは安いところで、ほかの線と重ならない側に名前を置く
      const y = side === 'sell' ? ymax * 0.7 : ymax * 0.3;
      const xs = items.map((it) => volumeAt(steps(it), y) / 1000);
      series.push(
        lineLabels(
          items.map((it, k) => ({ name: it.name, x: xs[k], y, position: side === 'sell' ? 'left' : 'right', others: xs.filter((_, j) => j !== k) })),
          xmax,
          this.comparison.chart.getWidth() - 100,
          theme,
        ),
      );
    }
    // エリアを選んでいるときは、それぞれのカーブがどの分断エリアのものかをツールチップ・表に出す
    const detail = (it: CompareItem) => (target === 'system' ? it.name : `${it.name}（${curveNote(it.curve)}）`);

    const prices = stepPrices(...items.map(steps));
    const columns = items.map((it) => (side === 'sell' ? sellVolumesAt(it.curve.sell, prices) : buyVolumesAt(it.curve.buy, prices)));
    const table: TableData = {
      columns: [`価格（円/kWh）`, ...items.map((it) => `${detail(it)}（MW、この価格${side === 'sell' ? '以下' : '以上'}）`)],
      rows: prices.map((p, r) => [p, ...columns.map((c) => c[r])]),
      digits: [2, ...items.map(() => 0)],
      filename: `jepx_bidcurve_compare_${mode}_${side}${target === 'system' ? '' : `_${target}`}_${fileDate(date)}_${slotStartLabel(slot).replace(':', '')}.csv`,
    };

    const legend = wrappedLegend(
      items.map((it) => it.name),
      this.comparison.chart.getWidth(),
      items.map((it) => isEstimate(it.curve)),
    );
    this.hidden.delete(this.comparison);
    this.comparison.setOption(
      {
        grid: grid({ top: legend.top, bottom: 28, right: 24 }),
        legend: legend.legend,
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'line', axis: 'y', snap: false },
          formatter: (params: AxisParam | AxisParam[]) => {
            const p = pointerPrice(params);
            if (p === null) return '';
            let html = ttHeader(`${fmtPrice(p)} ${PRICE_UNIT}${side === 'sell' ? '以下の売り入札' : '以上の買い入札'}`);
            const order = mode === 'slots' ? items : [...items].reverse();
            for (const it of order) {
              if (!this.isShown(this.comparison, it.name)) continue;
              html += ttRow(it.color, `${fmtNum(volumeAt(steps(it), p) / 1000, 2)} GW`, detail(it), isEstimate(it.curve) ? 'dash' : 'line');
            }
            return html;
          },
        },
        xAxis: volumeAxis(xmax, theme),
        yAxis: valueAxis(PRICE_UNIT, { min: 0, max: ymax }),
        series,
      },
      table,
    );
  }

  // ---- 期間で見る ----

  private renderPeriod(cs: CurveStore): void {
    const { sel } = this.ctx;
    const from = Math.max(sel.from, cs.metricsFirst);
    const to = Math.min(sel.to, cs.metricsLast);
    this.periodNote.textContent =
      `入札カーブの指標は ${formatDay(cs.metricsFirst)}〜${formatDay(cs.metricsLast)}（${fmtNum(cs.metricDays)} 日分）にあります。` +
      '上の絞り込み条件（期間・曜日・時間帯）のうち、この範囲に入る分を、システムプライスのカーブから計算した指標で集計します。';
    const cards = [this.depth, this.sensitivity, this.heat];
    const selC = from <= to ? reselect(sel, from, to) : null;
    if (!selC || selC.days.length === 0) {
      const msg = `選択した条件（${formatDay(sel.from)}〜${formatDay(sel.to)}）に入札カーブのデータがありません。期間を ${formatDay(cs.metricsFirst)}〜${formatDay(cs.metricsLast)} に含めてください。`;
      cards.forEach((c) => c.setEmpty(msg));
      return;
    }
    this.renderDepth(cs, selC);
    this.renderSensitivity(cs, selC);
    this.renderHeat(cs, selC);
  }

  private renderDepth(cs: CurveStore, sel: Selection): void {
    const { ds, state, theme } = this.ctx;
    const side = state.curveDepth;
    const defs = DEPTH[side];
    const colors = ordinalColors(defs.length, theme, side === 'buy');
    const gran = autoGranularity(sel);
    const raw = buildSeriesPoints(sel, defs.map((d) => ({ a: cs.metricArray(ds, d.key) })), gran, 'mean');
    const data = raw.map((r) => r.points.map(([x, v]) => [x, v / 1000] as [number, number]));
    const names = defs.map((d) => d.name);
    this.depth.setTitle(`価格帯ごとの${SIDE_LABEL[side]}の量`);
    this.depth.setSubtitle(
      `${describeSelection(sel, state)}・${side === 'sell' ? 'その価格以下' : 'その価格以上'}の入札量（GW、${granText(gran)}）`,
    );
    const ends = endLabels(names, data.map((d) => d.map((p) => p[1])), theme, 260);
    const legend = wrappedLegend(names, this.depth.chart.getWidth());
    this.depth.setOption(
      {
        grid: grid({ top: legend.top + 8, right: labelRoom(defs.length) }),
        legend: legend.legend,
        tooltip: {
          trigger: 'axis',
          formatter: namedTooltip(
            names.map((n) => (n === '合計' ? `${SIDE_LABEL[side]}の合計` : n)),
            colors,
            (p) => periodLabel(Number((p.value as number[])[0]), gran),
            (v) => `${fmtNum(v, 2)} GW`,
          ),
        },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis('GW'),
        series: defs.map((d, i) =>
          styledLine(d.name, colors[i], theme, gran === 'slot' ? breakGaps(data[i]) : data[i], false, { sampling: 'lttb', ...ends[i] }),
        ),
      },
      {
        columns: ['期間', ...defs.map((d) => `${d.name === '合計' ? `${SIDE_LABEL[side]}の合計` : `${d.name}の${SIDE_LABEL[side]}`}（GW）`)],
        rows: data[0].map((p, r) => [periodLabel(p[0], gran), ...data.map((d) => d[r][1])]),
        digits: [null, ...defs.map(() => 3)],
        filename: `jepx_bidcurve_depth_${side}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderSensitivity(cs: CurveStore, sel: Selection): void {
    const { ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const colors = [t.cat[2], t.cat[3]];
    const gran = autoGranularity(sel);
    const raw = buildSeriesPoints(sel, SENSITIVITY.map((d) => ({ a: cs.metricArray(ds, d.key) })), gran, 'mean');
    const data = raw.map((r) => r.points);
    this.sensitivity.setSubtitle(`${describeSelection(sel, state)}・カーブの交点から価格がどれだけ動くか（円/kWh、${granText(gran)}）`);
    const ends = endLabels(SENSITIVITY.map((d) => d.short), data.map((d) => d.map((p) => p[1])), theme, 260);
    const legend = wrappedLegend(
      SENSITIVITY.map((d) => d.name),
      this.sensitivity.chart.getWidth(),
    );
    this.sensitivity.setOption(
      {
        grid: grid({ top: legend.top + 8, right: labelRoom(SENSITIVITY.length) }),
        legend: legend.legend,
        tooltip: {
          trigger: 'axis',
          formatter: namedTooltip(
            SENSITIVITY.map((d) => d.name),
            colors,
            (p) => periodLabel(Number((p.value as number[])[0]), gran),
            (v) => `${fmtPrice(v)} 円`,
          ),
        },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis(PRICE_UNIT, { min: 0 }),
        series: SENSITIVITY.map((d, i) =>
          styledLine(d.name, colors[i], theme, gran === 'slot' ? breakGaps(data[i]) : data[i], false, { sampling: 'lttb', ...ends[i] }),
        ),
      },
      {
        columns: ['期間', ...SENSITIVITY.map((d) => `${d.name}（円/kWh）`)],
        rows: data[0].map((p, r) => [periodLabel(p[0], gran), ...data.map((d) => d[r][1])]),
        digits: [null, 2, 2],
        filename: `jepx_bidcurve_sensitivity_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderHeat(cs: CurveStore, sel: Selection): void {
    const { ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const m = CURVE_METRICS.find((x) => x.key === state.curveMetric) ?? CURVE_METRICS[0];
    const isVolume = m.unit === 'MW';
    const values = cs.metricArray(ds, m.key);
    const g = buildGrid(sel, { a: isVolume ? values.map((v) => v / 1000) : values }, 'dateSlot');
    if (g.cells.length === 0) {
      this.heat.setEmpty('この指標の値がありません。');
      return;
    }
    const unit = isVolume ? 'GW' : PRICE_UNIT;
    this.heat.setSubtitle(`${describeSelection(sel, state)}・${m.label}（${unit}）${g.note ? `・${g.note}` : ''}`);
    const [min, max] = colorRange(g, false, isVolume);
    const fmt = isVolume ? (v: number) => `${fmtNum(v, 2)} GW` : (v: number) => `${fmtPrice(v)} ${PRICE_UNIT}`;
    this.heat.setHeight(heatmapHeight(g));
    this.heat.setOption(
      heatmapOption(g, { theme, min, max, colors: t.seq, precision: isVolume ? 0 : 1, fmt, valueLabel: m.label }),
      gridTable(g, `jepx_bidcurve_heatmap_${m.key}_${rangeTag(sel)}.csv`),
    );
  }
}

/** 階段状のカーブを、横軸 GW・縦軸 円/kWh の折れ線の頂点にする */
function toGw(steps: Float64Array): [number, number][] {
  return stepPath(steps).map(([v, p]) => [v / 1000, p]);
}

/** 副題に出す、対象と表示しているカーブの説明 */
function targetText(target: CurveTarget, ac: AreaCurve): string {
  if (target === 'system') return SYSTEM_LABEL;
  const name = areaLabel(target);
  switch (ac.kind) {
    case 'system':
      return ac.unnamed ? `${name}（分断エリアの名前が分からないため、システムプライスのカーブ）` : `${name}（市場分断なし: システムプライスのカーブ）`;
    case 'group':
      return `${name}（分断エリア: ${ac.label}）`;
    case 'single':
      return `${name}（単エリア・推定）`;
    case 'combined':
      return `${name}（単エリア ${ac.areas.length} つを合わせた推定: ${ac.label}）`;
    case 'unavailable':
      return `${name}（単エリア・推定できません）`;
  }
}

/** 小さい量は MW、大きい量は GW で */
function fmtMw(mw: number): string {
  return Math.abs(mw) < 1000 ? `${fmtNum(mw, 0)} MW` : `${fmtNum(mw / 1000, 2)} GW`;
}

const fmtGw = (mw: number) => `${fmtNum(mw / 1000, 2)} GW`;

/**
 * 単エリアの入札がシステムプライスのカーブに入っていることの裏付け（引いた差が価格によって変わる）と、入札量の合計。
 * 公表されている分断エリアの合計がシステムプライスより多いのは、連系線でやりとりする量が入っているため
 */
function evidenceText(ac: AreaCurve): string {
  const t = ac.totals;
  const r = ac.ranges;
  if (!t || !r) return '';
  let text =
    `システムプライスのカーブから分断エリアのカーブを引いた差は、価格によって売りで ${fmtGw(r.sell)}・買いで ${fmtGw(r.buy)} 変わり、この分が${ac.label}の入札です` +
    `（システムプライスのカーブには${ac.label}の入札も入っています。価格によらない分は、連系線でやりとりする量とブロック入札の約定の違い）。` +
    `入札量の合計は、システムプライスのカーブが売り ${fmtGw(t.systemSell)}・買い ${fmtGw(t.systemBuy)}、公表されている分断エリアの合計が売り ${fmtGw(t.publishedSell)}・買い ${fmtGw(t.publishedBuy)} です`;
  if (t.publishedSell > t.systemSell || t.publishedBuy > t.systemBuy) text += '（分断エリアの合計のほうが多いのは、連系線でやりとりする量が入っているため）';
  return `${text}。`;
}

/** 単エリアを推定できないときの説明（引く前後の入札量の合計を添えて、なぜ推定できないかが分かるようにする） */
function unavailableText(target: CurveTarget, ac: AreaCurve): string {
  const t = ac.totals!;
  return (
    `${targetLabel(target)}のカーブは推定できませんでした。システムプライスのカーブから、公表されている分断エリア（${(ac.subtracted ?? []).join('、')}）のカーブを引いた差が、` +
    `価格によらずほぼ一定で、${ac.label}の入札の形が残りません（入札量の合計: システムプライスのカーブは売り ${fmtGw(t.systemSell)}・買い ${fmtGw(t.systemBuy)}、` +
    `公表されている分断エリアのカーブの合計は売り ${fmtGw(t.publishedSell)}・買い ${fmtGw(t.publishedBuy)}）。` +
    `システムプライスのカーブに${ac.label}の入札が入っていないか、公表されている分断エリアのカーブに含まれているとみられます。`
  );
}

/** 比較の図で、それぞれのカーブがどのカーブかの短い説明 */
function curveNote(ac: AreaCurve): string {
  switch (ac.kind) {
    case 'system':
      return ac.unnamed ? 'システムプライス' : '分断なし';
    case 'group':
      return ac.label;
    case 'single':
      return '単エリア・推定';
    case 'combined':
      return `${ac.label}の合算・推定`;
    case 'unavailable':
      return '推定できません';
  }
}

/** 縦軸の範囲を決めるのに使う価格（交点。補正した単エリアは約定価格、単エリアの合算は無し） */
function referencePrice(ac: AreaCurve): number {
  if (ac.kind === 'combined') return Number.NaN;
  if (ac.correction) return ac.correction.price;
  return crossing(rowsFromSteps(ac.sell, ac.buy))?.price ?? Number.NaN;
}

/** エリアの約定価格の横線（同じ価格のエリアは 1 本にまとめる） */
function priceLines(areas: readonly AreaKey[], priceOf: (a: AreaKey) => number): { price: number; label: string }[] {
  const out: { price: number; names: string[] }[] = [];
  for (const a of areas) {
    const p = priceOf(a);
    if (!Number.isFinite(p)) continue;
    const same = out.find((x) => Math.abs(x.price - p) < 0.005);
    if (same) same.names.push(areaLabel(a));
    else out.push({ price: p, names: [areaLabel(a)] });
  }
  return out.map((x) => ({ price: x.price, label: x.names.join('・') }));
}

function priceMarkLine(lines: { price: number; label: string }[], theme: ThemeName): Record<string, unknown> {
  const t = TOKENS[theme];
  return {
    symbol: 'none',
    silent: true,
    animation: false,
    lineStyle: { color: t.ink2, width: 1, type: [4, 4] },
    label: { position: 'insideEndTop', color: t.ink2, fontSize: 11, backgroundColor: t.surface, padding: [1, 3], borderRadius: 3 },
    data: lines.map((l) => ({ yAxis: l.price, label: { formatter: `${l.label} ${fmtPrice(l.price)}円` } })),
  };
}

/** 縦軸（価格）の上限。「自動」は交点の価格の 1.5 倍が入る段（30 円以上） */
function priceMax(range: CurveRange, groups: StepCurve[], crossPrices: number[]): number {
  if (range === 'all') {
    let top = 0;
    for (const g of groups) {
      if (g.sell.length > 0) top = Math.max(top, g.sell[g.sell.length - 2]);
      if (g.buy.length > 0) top = Math.max(top, g.buy[0]);
    }
    return PRICE_MAX_STEPS.find((m) => m >= top) ?? Math.ceil(top / 100) * 100;
  }
  if (range !== 'auto') return Number(range);
  const c = Math.max(0, ...crossPrices.filter(Number.isFinite));
  return PRICE_MAX_STEPS.find((m) => m >= c * 1.5) ?? Math.ceil((c * 1.5) / 100) * 100;
}

/** 横軸（GW）の上限: 表示する価格の範囲の中のカーブが収まる量 */
function volumeMax(groups: StepCurve[], priceTop: number, sides: CurveSide[]): number {
  let mw = 0;
  for (const g of groups) {
    if (sides.includes('sell')) mw = Math.max(mw, sellVolumeAt(g.sell, priceTop));
    if (sides.includes('buy')) mw = Math.max(mw, buyVolumeAt(g.buy, 0));
  }
  const gw = (mw / 1000) * 1.03;
  if (!(gw > 0)) return 1;
  const step = niceStep(gw / 10);
  return Math.ceil(gw / step) * step;
}

function volumeAxis(max: number, theme: ThemeName): Record<string, unknown> {
  return {
    type: 'value',
    name: '累積の入札量（GW）',
    nameLocation: 'middle',
    nameGap: 26,
    min: 0,
    max,
    splitLine: { show: true, lineStyle: { color: TOKENS[theme].grid } },
  };
}

/**
 * 交点（約定価格・約定量）の点と値のラベル。ラベルは右に置き、入らなければ左に、
 * どちらにも 1 行で入らなければ 2 行に折り返す。
 * @param at 交点の横位置（グラフ領域の左端からの px）
 */
function crossingSeries(c: { price: number; volume: number }, theme: ThemeName, at: number, plotWidth: number): Record<string, unknown> {
  const t = TOKENS[theme];
  const price = `交点 ${fmtPrice(c.price)} ${PRICE_UNIT}`;
  const volume = `${fmtNum(c.volume / 1000, 1)} GW`;
  const right = plotWidth - at;
  const wrap = right < CROSS_LABEL_WIDTH && at < CROSS_LABEL_WIDTH;
  const width = wrap ? CROSS_LABEL_WIDTH_WRAPPED : CROSS_LABEL_WIDTH;
  return {
    type: 'scatter',
    name: '交点',
    data: [[c.volume / 1000, c.price]],
    symbolSize: 10,
    z: 5,
    silent: true,
    tooltip: { show: false },
    itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 2 },
    label: {
      show: true,
      position: right >= width || right >= at ? 'right' : 'left',
      distance: 8,
      formatter: wrap ? `${price}\n${volume}` : `${price}・${volume}`,
      color: t.ink,
      fontSize: 11,
      fontWeight: 600,
      lineHeight: 15,
      backgroundColor: t.surface,
      padding: [2, 4],
      borderRadius: 3,
    },
  };
}

interface LineLabel {
  name: string;
  /** GW */
  x: number;
  /** 円/kWh */
  y: number;
  /** 置きたい側（空きが無ければ反対側に置き、どちらにも無ければ省く） */
  position: 'left' | 'right';
  /** 同じ高さにあるほかの線の横位置（GW）。名前がこれらの線にかからないようにする */
  others: number[];
}

/**
 * 線の横に置く系列名（面の色の下地を敷く）。名前が図の端やほかの線・名前にかかる場合は反対側に置き、
 * どちらにも置けなければ省く（凡例・ツールチップ・表で識別できる）。
 */
function lineLabels(labels: LineLabel[], xmax: number, plotWidth: number, theme: ThemeName): Record<string, unknown> {
  const t = TOKENS[theme];
  const px = (x: number) => (x / xmax) * plotWidth;
  const placed: { y: number; a: number; b: number }[] = [];
  const data: Record<string, unknown>[] = [];
  for (const l of labels) {
    if (!Number.isFinite(l.x)) continue;
    const at = px(l.x);
    const width = (legendTextWidth(l.name) * 11) / 12 + 8;
    const others = l.others.filter(Number.isFinite).map(px);
    const leftEdge = Math.max(0, ...others.filter((o) => o < at - 1));
    const rightEdge = Math.min(plotWidth, ...others.filter((o) => o > at + 1));
    const order: ('left' | 'right')[] = l.position === 'left' ? ['left', 'right'] : ['right', 'left'];
    for (const dir of order) {
      const [a, b] = dir === 'left' ? [at - LABEL_GAP - width, at - LABEL_GAP] : [at + LABEL_GAP, at + LABEL_GAP + width];
      const free = dir === 'left' ? a >= leftEdge + 2 : b <= rightEdge - 2;
      if (!free || placed.some((p) => Math.abs(p.y - l.y) < 1e-9 && p.a < b && a < p.b)) continue;
      placed.push({ y: l.y, a, b });
      data.push({ name: l.name, value: [l.x, l.y], label: { position: dir } });
      break;
    }
  }
  return {
    type: 'scatter',
    name: '',
    silent: true,
    symbolSize: 0,
    z: 6,
    tooltip: { show: false },
    data,
    label: {
      show: true,
      formatter: '{b}',
      distance: LABEL_GAP,
      color: t.ink2,
      fontSize: 11,
      fontWeight: 600,
      backgroundColor: t.surface,
      padding: [1, 3],
      borderRadius: 3,
    },
  };
}

/** 軸ツールチップの指している価格（0.01 円単位） */
function pointerPrice(params: AxisParam | AxisParam[]): number | null {
  const ps = Array.isArray(params) ? params : [params];
  const v = Number(ps[0]?.axisValue);
  return Number.isFinite(v) ? Math.max(0, Math.round(v * 100) / 100) : null;
}

/**
 * 価格軸のツールチップ用の見えない系列（縦軸の範囲を細かく刻んだ点）。
 * ECharts の軸ツールチップは、ポインタに最も近い点の値に合わせて表示するので、
 * この点に合わせることで、ポインタの位置の価格（0.01 円単位）で入札量を出せる。
 */
function priceProbe(priceTop: number): Record<string, unknown> {
  const step = niceStep(priceTop / 3000);
  const n = Math.floor(priceTop / step + 1e-9);
  return {
    type: 'line',
    name: '',
    data: Array.from({ length: n + 1 }, (_, k) => [0, Math.round(k * step * 100) / 100]),
    symbol: 'none',
    silent: true,
    animation: false,
    lineStyle: { opacity: 0 },
    emphasis: { disabled: true },
    z: 0,
  };
}

/** 名前・色を指定した系列の軸ツールチップ（系列の順に並べる） */
function namedTooltip(
  names: string[],
  colors: string[],
  header: (first: AxisParam) => string,
  format: (v: number) => string,
): (params: AxisParam | AxisParam[]) => string {
  return (params) => {
    const ps = (Array.isArray(params) ? params : [params]).slice().sort((a, b) => a.seriesIndex - b.seriesIndex);
    if (ps.length === 0) return '';
    let html = ttHeader(header(ps[0]));
    for (const p of ps) {
      const name = names[p.seriesIndex];
      if (name === undefined) continue;
      const v = Array.isArray(p.value) ? Number(p.value[1]) : Number(p.value);
      html += ttRow(colors[p.seriesIndex], format(v), name);
    }
    return html;
  };
}

/** 凡例に並べる短い日付（9/25(金)） */
function shortDay(day: number): string {
  const { m, d } = ymdFromDay(day);
  return `${m}/${d}(${DOW_LABEL[dowOfDay(day)]})`;
}

/** 文字列の幅の目安（px、12px の文字。全角は 1 文字 12px、半角は 7.5px。少し広めに見積もる） */
function legendTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? 12 : 7.5;
  return w * 1.05;
}

/**
 * 項目が多いときは折り返す凡例（スクロールで隠れる項目を作らない）と、その行数に合わせたグラフ領域の上端。
 * @param width グラフの幅（px）
 */
function wrappedLegend(names: string[], width: number, dashed: boolean[] = []): { legend: Record<string, unknown>; top: number } {
  // 凡例の内側の余白（左右 5px）を除いた幅に並べる
  const room = width - 10;
  let rows = 1;
  let x = 0;
  for (const name of names) {
    // 線の見本 18px + 見本と文字の間 5px + 文字 + 項目の間 16px
    const w = 18 + 5 + legendTextWidth(name);
    if (x > 0 && x + w > room) {
      rows++;
      x = 0;
    }
    x += w + 16;
  }
  return { legend: lineLegend(names.map((name, i) => ({ name, dashed: dashed[i] })), { type: 'plain' }), top: PLOT_TOP + (rows - 1) * LEGEND_ROW };
}

function granText(gran: ReturnType<typeof autoGranularity>): string {
  return gran === 'slot' ? '30分値' : `${GRANULARITY_LABEL[gran]}ごとの平均`;
}

function fileDate(day: number): string {
  return isoFromDay(day).replace(/-/g, '');
}
