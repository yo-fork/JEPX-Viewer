/**
 * 入札カーブのタブの「価格感応度」: 買いが増えたり減ったりしたときに、約定価格がどう動くか。
 *
 * - 1 コマ: 対象のカーブの買いの増減と約定価格、エリア別の価格感応度、エリア別の 0.01 円・高騰までの買いの増減
 * - 期間: 価格感応度の推移（システムプライスは JEPX の公表値と入札カーブから計算した目安）と、0.01 円・高騰までの買いの増減の推移
 * エリアの期間の値は、エリアの価格を決めたカーブを 1 日ずつ読んで計算する（1 日分が数百 KB あるので、ボタンを押したときだけ）。
 */
import { areaLabel, CURVE_TARGETS, type AreaCurve, type CurveTarget } from '../lib/areaCurves';
import { SENSITIVITY_MW, type CurveDay, type CurveMetricKey } from '../lib/bidCurves';
import type { Source } from '../lib/aggregate';
import type { CurveStore } from '../lib/curveStore';
import { formatDay, slotRangeLabel, slotStartLabel } from '../lib/dates';
import { fmtNum, fmtPrice, fmtSigned } from '../lib/format';
import { reselect, type Selection } from '../lib/select';
import {
  curveSensitivity,
  exceedStep,
  priceAtShift,
  SENS_FIELD_INDEX,
  SENS_FIELDS,
  sensitivityValues,
  SPIKE_PRICES,
  type SensField,
  type Sensitivity,
  type SpikePrice,
} from '../lib/sensitivity';
import { SENSITIVITY_SIZES, sensitivityKey, SERIES_INDEX, SLOTS, type AreaKey, type SensitivitySize, type SeriesKey } from '../lib/series';
import { niceStep } from '../lib/stats';
import type { Dataset } from '../lib/store';
import type { AppState, CurveRange } from '../state';
import type { CardOptions, ChartCard, TableData } from '../ui/card';
import { segmented, type Segmented } from '../ui/controls';
import { h } from '../ui/dom';
import { renderTiles, type StatTile } from '../ui/kpi';
import { TOKENS, type ThemeName } from '../ui/theme';
import { ttHeader, ttNote, ttRow } from '../ui/tooltip';
import type { ViewContext } from './base';
import { DASH_ICON, describeSelection, endLabels, grid, legend, LINE_ICON, PRICE_UNIT, rangeTag, styledLine, valueAxis, withAlpha } from './common';
import { curveNote, fileDate, fmtGw, granText, isEstimate, legendTextWidth, namedTooltip, PLOT_TOP, targetLabel, targetText, wrappedLegend, type AxisParam } from './curveCommon';
import { autoGranularity, breakGaps, buildSeriesPoints, periodLabel, TIME_AXIS_LABEL } from './timeseries';

/** 価格感応度の図を置くビュー（入札カーブのタブ）から受け取るもの */
export interface SensitivityHost {
  ctx(): ViewContext;
  card(parent: HTMLElement, opts: Omit<CardOptions, 'theme'>): ChartCard;
  set(patch: Partial<AppState>): void;
  /** その日・時間帯に、target の価格を決めたカーブ（カーブが無ければ null） */
  curveOf(day: CurveDay, slot: number, target: CurveTarget): AreaCurve | null;
  /** 受渡日・コマの取引結果の値（無ければ NaN） */
  value(day: number, slot: number, key: SeriesKey): number;
  /** タブを閉じた（計算の途中ならやめる） */
  disposed(): boolean;
}

/** 1 コマの、ある対象の価格を決めたカーブとその価格感応度 */
interface TargetRow {
  target: CurveTarget;
  ac: AreaCurve | null;
  s: Sensitivity | null;
  /** 推定したカーブ（単エリア） */
  estimate: boolean;
  /** 計算できないときの理由 */
  reason: string;
}

/** エリアの期間の価格感応度（コマごとに SENS_FIELDS の値。集めたときの取引結果が変われば集め直す） */
interface AreaSensitivity {
  ds: Dataset;
  days: Map<number, Float64Array>;
  /** 日が増えるたびに増える（そろえた配列のキャッシュの判定用） */
  version: number;
  failed: number;
}
/** 集めた値は、タブを切り替えても入札カーブが同じあいだ使い回す */
const collected = new WeakMap<CurveStore, Map<AreaKey, AreaSensitivity>>();

const FIELD_COUNT = SENS_FIELDS.length;
/** 縦軸（価格）の上限の候補 */
const PRICE_TOPS = [30, 50, 100, 200, 500, 1000];
/** 1 コマの図の横軸に必ず入れる買いの増減（MW。公表値の ±5GW が入るように） */
const MIN_SHIFT = 5500;
/** 高騰の目安の価格の、期間の図で使う入札カーブの指標（その価格以下の売り・以上の買い） */
const SPIKE_METRICS: Record<SpikePrice, [CurveMetricKey, CurveMetricKey]> = {
  20: ['sell20', 'buy20'],
  50: ['sell50', 'buy50'],
};

const sizeText = (mw: number) => `${mw / 1000}GW`;
const shortTarget = (t: CurveTarget) => (t === 'system' ? 'システム' : areaLabel(t));
/** 買いの増減（MW）を符号付きの GW に */
const signedGw = (mw: number) => fmtSigned(mw / 1000, 2);

/** 価格感応度を計算できるカーブなら計算する（単エリアの推定で約定価格に合わせて補正したカーブは、その約定価格を基準にする） */
function sensitivityOf(ac: AreaCurve | null): Sensitivity | null {
  if (!ac || ac.kind === 'unavailable' || ac.kind === 'combined') return null;
  return curveSensitivity(ac, ac.correction?.price);
}

function unusableReason(ac: AreaCurve | null): string {
  if (!ac) return 'カーブがありません';
  if (ac.kind === 'combined') return '単エリアが複数あり、エリアごとのカーブが分かりません';
  if (ac.kind === 'unavailable') return '単エリアのカーブを推定できません';
  return '売りと買いのカーブが交わりません';
}

export class SensitivitySection {
  private readonly note: HTMLElement;
  private readonly response: ChartCard;
  private readonly tiles: HTMLElement;
  private readonly areaSens: ChartCard;
  private readonly areaMargin: ChartCard;
  private readonly trend: ChartCard;
  private readonly margin: ChartCard;
  private readonly sizes: Segmented<`${SensitivitySize}`>[] = [];
  private readonly spikes: Segmented<`${SpikePrice}`>[] = [];
  private readonly collectBtn: HTMLButtonElement;
  /** エリア別の図の行の対象（押した棒から対象を引く） */
  private rowTargets: CurveTarget[] = [];
  /** 値を集めているエリア（集めていなければ null） */
  private collecting: AreaKey | null = null;
  private readonly aligned = new Map<string, Float64Array>();

  constructor(
    private readonly host: SensitivityHost,
    parent: HTMLElement,
  ) {
    const s = host.ctx().state;
    this.note = h('p', { class: 'view-note' });
    parent.append(h('h2', { class: 'view-section-title' }, '価格感応度'), this.note);
    const g = h('div', { class: 'card-grid' });
    parent.append(g);
    const sizeControl = () => {
      const c = segmented(
        '買いの増減',
        SENSITIVITY_SIZES.map((mw) => ({ value: String(mw) as `${SensitivitySize}`, label: `±${sizeText(mw)}` })),
        String(s.sensSize) as `${SensitivitySize}`,
        (v) => host.set({ sensSize: Number(v) as SensitivitySize }),
      );
      this.sizes.push(c);
      return c.el;
    };
    const spikeControl = () => {
      const c = segmented(
        '高騰の目安',
        SPIKE_PRICES.map((p) => ({ value: String(p) as `${SpikePrice}`, label: `${p} 円` })),
        String(s.spikePrice) as `${SpikePrice}`,
        (v) => host.set({ spikePrice: Number(v) as SpikePrice }),
      );
      this.spikes.push(c);
      return c.el;
    };

    this.response = host.card(g, { title: '買いの増減と約定価格', height: 380, wide: true });
    this.tiles = h('div', { class: 'kpis', 'aria-label': '約定価格が 0.01 円になる・高騰する買いの増減' });
    this.response.footer.append(
      this.tiles,
      h(
        'p',
        { class: 'card-note' },
        '1 コマの図とエリア別の図は、描画用に間引いたカーブ（売り・買いそれぞれの合計量の 0.1% 未満の増え方は次の価格の段にまとめたもの）から求めるため、' +
          '交点が公表の約定価格と少し違ったり、小さい増減での価格の動きが粗くなったりすることがあります。' +
          '期間の図のシステムプライスの目安（±1GW の価格の動きと、0.01 円・高騰までの買いの増減）は、間引く前のカーブから求めています。',
      ),
    );
    this.areaSens = host.card(g, { title: 'エリア別の価格感応度', height: 420 });
    this.areaSens.addControls(sizeControl());
    this.areaMargin = host.card(g, { title: 'エリア別の 0.01 円・高騰までの買いの増減', height: 420 });
    this.areaMargin.addControls(spikeControl());
    for (const card of [this.areaSens, this.areaMargin]) {
      card.chart.on('click', (e: unknown) => {
        const target = this.rowTargets[(e as { dataIndex: number }).dataIndex];
        if (target) host.set({ curveArea: target });
      });
    }
    this.trend = host.card(g, { title: '価格感応度の推移', height: 340 });
    this.collectBtn = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, onclick: () => this.onCollect() }, '計算する');
    this.trend.addControls(sizeControl(), this.collectBtn);
    this.margin = host.card(g, { title: '0.01 円・高騰までの買いの増減の推移', height: 340 });
    this.margin.addControls(spikeControl());
  }

  render(cs: CurveStore, date: number): void {
    const { state } = this.host.ctx();
    for (const c of this.sizes) c.set(String(state.sensSize) as `${SensitivitySize}`);
    for (const c of this.spikes) c.set(String(state.spikePrice) as `${SpikePrice}`);
    this.note.textContent =
      '買いが増えたり減ったりしたときに約定価格がどう動くかを、入札カーブの交点を買いの量だけずらして求めます。' +
      'ブロック入札の約定と、分断エリアのカーブでは連系線でやりとりする量を変えない目安です。' +
      'JEPX もシステムプライスの価格感応度を公表していますが（2021 年度から。npm run fetch で取引結果と一緒に取得します）、' +
      '0.01 円の売りか 999 円の買いを足して約定計算をやり直し、ブロック入札の約定も判定し直しているため、この目安より動きが小さいことが多くあります。' +
      (cs.isDemo ? 'デモ表示では、公表値も合成した値です。' : '');
    this.renderSlot(cs, date);
    this.renderPeriod(cs);
  }

  // ---- 1 コマ ----

  /** 対象ごとの、その価格を決めたカーブと価格感応度（同じカーブは 1 回だけ計算する） */
  private slotRows(day: CurveDay, slot: number): TargetRow[] {
    const done = new Map<ArrayLike<number>, Sensitivity | null>();
    return CURVE_TARGETS.map((target) => {
      const ac = this.host.curveOf(day, slot, target);
      let s: Sensitivity | null = null;
      if (ac) {
        if (!done.has(ac.sell)) done.set(ac.sell, sensitivityOf(ac));
        s = done.get(ac.sell)!;
      }
      return { target, ac, s, estimate: !!ac && isEstimate(ac), reason: s ? '' : unusableReason(ac) };
    });
  }

  private renderSlot(cs: CurveStore, date: number): void {
    const { state } = this.host.ctx();
    const slot = state.curveSlot;
    const when = `${formatDay(date, true)} ${slotRangeLabel(slot)}`;
    const day = cs.getDay(date);
    this.rowTargets = [];
    if (!day) {
      this.tiles.replaceChildren();
      for (const c of [this.response, this.areaSens, this.areaMargin]) c.setEmpty(`${formatDay(date, true)} の入札カーブを読み込めませんでした。`);
      return;
    }
    const rows = this.slotRows(day, slot);
    this.renderResponse(rows.find((r) => r.target === state.curveArea)!, date, slot, when);
    if (!rows.some((r) => r.s)) {
      for (const c of [this.areaSens, this.areaMargin]) c.setEmpty(`${when} の入札カーブがありません。`);
      return;
    }
    this.rowTargets = rows.map((r) => r.target);
    this.renderAreaSens(rows, date, slot, when);
    this.renderAreaMargin(rows, date, slot, when);
  }

  /** JEPX が公表している、そのコマの価格感応度（システムプライス。無ければ null） */
  private published(day: number, slot: number): { system: number; up: number[]; down: number[] } | null {
    const v = (k: SeriesKey) => this.host.value(day, slot, k);
    const up = SENSITIVITY_SIZES.map((mw) => v(sensitivityKey('buy', mw)));
    const down = SENSITIVITY_SIZES.map((mw) => v(sensitivityKey('sell', mw)));
    return [...up, ...down].some(Number.isFinite) ? { system: v('system'), up, down } : null;
  }

  /** 対象のカーブの、買いの増減に対する約定価格の段と、0.01 円・高騰・売りが尽きるまでの量 */
  private renderResponse(r: TargetRow, date: number, slot: number, when: string): void {
    const { state, theme } = this.host.ctx();
    const t = TOKENS[theme];
    const card = this.response;
    this.tiles.replaceChildren();
    if (!r.ac) {
      card.setSubtitle(when);
      card.setEmpty(`${when} の入札カーブがありません。`);
      return;
    }
    card.setSubtitle(`${when}・${targetText(r.target, r.ac)}`);
    const s = r.s;
    if (!s) {
      card.setEmpty(`${targetLabel(r.target)}の価格感応度を計算できません（${r.reason}）。`);
      return;
    }
    const color = t.cat[2];
    const pub = r.target === 'system' ? this.published(date, slot) : null;
    const top = responseTop(state.curveRange, s);
    const axis = shiftAxis(s, top);
    const path = responsePath(s, axis.min * 1000, axis.max * 1000);
    const probeStep = niceStep((axis.max - axis.min) / 2000);
    const lineName = '入札カーブから計算した目安';
    const pubName = 'JEPX の公表値';
    card.setSubtitle(
      `${when}・${targetText(r.target, r.ac)}・約定価格 ${fmtPrice(s.base)} ${PRICE_UNIT}・横軸は買いの増減（GW）、縦軸はそのときの約定価格` +
        (r.estimate ? '・破線は推定のカーブ' : '') +
        (pub ? `・◆は ${pubName}（買い ±0.5・1・5GW）` : ''),
    );

    const series: Record<string, unknown>[] = [
      styledLine(lineName, color, theme, path, r.estimate, {
        symbol: 'none',
        z: 3,
        markLine: {
          symbol: 'none',
          silent: true,
          animation: false,
          label: { color: t.ink2, fontSize: 11, backgroundColor: t.surface, padding: [1, 3], borderRadius: 3 },
          data: [
            { xAxis: 0, lineStyle: { color: t.ink2, width: 1, type: 'solid' }, label: { formatter: '増減なし', position: 'end' } },
            ...SPIKE_PRICES.filter((p) => p < top).map((p) => ({
              yAxis: p,
              lineStyle: { color: t.ink2, width: 1, type: [4, 4] },
              label: { formatter: `${p} 円`, position: 'insideEndTop' },
            })),
          ],
        },
      }),
      {
        type: 'scatter',
        name: '約定価格',
        data: [[0, s.base]],
        symbolSize: 9,
        z: 5,
        silent: true,
        tooltip: { show: false },
        itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 2 },
        label: {
          show: true,
          position: 'left',
          distance: 8,
          formatter: `約定 ${fmtPrice(s.base)} 円`,
          color: t.ink,
          fontSize: 11,
          fontWeight: 600,
          backgroundColor: t.surface,
          padding: [1, 3],
          borderRadius: 3,
        },
      },
    ];
    if (pub) {
      series.push({
        type: 'scatter',
        name: pubName,
        symbol: 'diamond',
        symbolSize: 12,
        z: 6,
        silent: true,
        data: SENSITIVITY_SIZES.flatMap((mw, k) => [
          [mw / 1000, pub.up[k]],
          [-mw / 1000, pub.down[k]],
        ]).filter(([, v]) => Number.isFinite(v)),
        itemStyle: { color: t.ink, borderColor: t.surface, borderWidth: 1.5 },
      });
    }
    series.push(shiftProbe(axis.min, axis.max, probeStep));

    card.setOption(
      {
        grid: grid({ top: PLOT_TOP, bottom: 30, right: 28 }),
        legend: legend({
          data: [{ name: lineName, icon: r.estimate ? DASH_ICON : LINE_ICON }, ...(pub ? [{ name: pubName, icon: 'diamond' }] : [])],
        }),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'line', axis: 'x', snap: false },
          formatter: (params: AxisParam | AxisParam[]) => {
            const ps = Array.isArray(params) ? params : [params];
            const x = Number(ps[0]?.axisValue);
            if (!Number.isFinite(x)) return '';
            const mw = Math.round((Math.round(x / probeStep) * probeStep) * 1000);
            const p = priceAtShift(s.response, mw);
            let html = ttHeader(mw === 0 ? '買いの増減なし' : `買いが ${fmtGw(Math.abs(mw))} ${mw > 0 ? '増えた' : '減った'}とき`);
            html += Number.isFinite(p)
              ? ttRow(color, `${fmtPrice(p)} ${PRICE_UNIT}`, `約定価格の目安（${fmtSigned(p - s.base)} 円）`, r.estimate ? 'dash' : 'line')
              : ttRow(color, '交わらない', '売り入札が足りない', r.estimate ? 'dash' : 'line');
            const k = SENSITIVITY_SIZES.findIndex((mw2) => mw2 === Math.abs(mw));
            const v = pub && k >= 0 ? (mw > 0 ? pub.up[k] : pub.down[k]) : Number.NaN;
            if (pub && Number.isFinite(v)) html += ttRow(t.ink, `${fmtPrice(v)} ${PRICE_UNIT}`, `${pubName}（${fmtSigned(v - pub.system)} 円）`, 'none');
            return html;
          },
        },
        xAxis: {
          type: 'value',
          name: '買いの増減（GW。0 が実際の約定）',
          nameLocation: 'middle',
          nameGap: 26,
          min: axis.min,
          max: axis.max,
          interval: axis.interval,
          splitLine: { show: true, lineStyle: { color: t.grid } },
          axisLabel: { formatter: (v: number) => (v === 0 ? '0' : fmtSigned(v, Number.isInteger(v) ? 0 : 1)) },
        },
        // 縦軸は、横軸の 0 の位置ではなく左端に置く
        yAxis: valueAxis(PRICE_UNIT, { min: 0, max: top, axisLine: { onZero: false } }),
        series,
      },
      responseTable(s, pub, r.target, date, slot),
    );
    renderTiles(this.tiles, responseTiles(s, state.sensSize, pub));
  }

  /** エリア別の、買いを ±N 増減したときの約定価格の上昇幅・下落幅（右: 上昇、左: 下落） */
  private renderAreaSens(rows: TargetRow[], date: number, slot: number, when: string): void {
    const { state, theme } = this.host.ctx();
    const t = TOKENS[theme];
    const [neg, pos] = poles(theme);
    const k = SENSITIVITY_SIZES.indexOf(state.sensSize);
    const size = sizeText(state.sensSize);
    const upName = `買い +${size}`;
    const downName = `買い −${size}`;
    const up = rows.map((r) => (r.s ? r.s.up[k] - r.s.base : Number.NaN));
    const down = rows.map((r) => (r.s ? r.s.down[k] - r.s.base : Number.NaN));
    const pub = this.published(date, slot);
    this.areaSens.setSubtitle(
      `${when}・買いが ${size} 増えたとき（右）・減ったとき（左）の約定価格の動き（円/kWh。各エリアの価格を決めたカーブから計算した目安）` +
        (rows.some((r) => r.estimate && r.s) ? '・破線の枠は推定のカーブ' : '') +
        '・押すと対象をそのエリアにします',
    );
    // 買いを増やすと売りが尽きるときは、棒の代わりにそう書く
    const exhausted = rows.map((r, i) => (r.s && !Number.isFinite(up[i]) ? '売りが尽きる' : null));
    const bars = (name: string, color: string, values: number[], notes: (string | null)[], position: 'left' | 'right') => ({
      type: 'bar',
      name,
      stack: 'sens',
      barMaxWidth: 16,
      color,
      data: barItems(values, notes, color, rows, position),
      label: { show: true, color: t.ink2, fontSize: 11, formatter: (p: { value: number }) => (Number.isFinite(p.value) ? fmtSigned(p.value) : '') },
    });
    this.areaSens.setOption(
      {
        grid: grid({ top: PLOT_TOP, right: 56, bottom: 28 }),
        legend: legend({ data: [upName, downName] }),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (ps: { dataIndex: number }[]) => {
            const r = rows[ps[0]?.dataIndex];
            if (!r) return '';
            let html = ttHeader(`${shortTarget(r.target)}（${r.ac ? curveNote(r.ac) : 'カーブなし'}）`);
            if (!r.s) return html + ttNote(r.reason);
            html += ttRow(pos, priceMove(r.s.up[k], r.s.base), upName, 'rect');
            html += ttRow(neg, priceMove(r.s.down[k], r.s.base), downName, 'rect');
            html += ttNote(`約定価格 ${fmtPrice(r.s.base)} ${PRICE_UNIT}${r.estimate ? '・推定のカーブ' : ''}`);
            if (r.target === 'system' && pub && Number.isFinite(pub.up[k]) && Number.isFinite(pub.down[k])) {
              html += ttNote(`JEPX の公表値: ${fmtSigned(pub.up[k] - pub.system)} 円 / ${fmtSigned(pub.down[k] - pub.system)} 円`);
            }
            return html;
          },
        },
        xAxis: barValueAxis(PRICE_UNIT, [...up, ...down], theme),
        yAxis: { type: 'category', data: rows.map((r) => shortTarget(r.target)), inverse: true, axisLabel: { interval: 0 } },
        series: [bars(upName, pos, up, exhausted, 'right'), bars(downName, neg, down, rows.map(() => null), 'left')],
      },
      areaTable(rows, date, slot),
    );
  }

  /** エリア別の、約定価格が 0.01 円になる（左）・高騰の目安を超える（右）買いの増減 */
  private renderAreaMargin(rows: TargetRow[], date: number, slot: number, when: string): void {
    const { state, theme } = this.host.ctx();
    const t = TOKENS[theme];
    const [neg, pos] = poles(theme);
    const x = state.spikePrice;
    const k = SPIKE_PRICES.indexOf(x);
    const floorName = '0.01 円になる';
    const spikeName = `${x} 円を超える`;
    const floor = rows.map((r) => (r.s && Number.isFinite(r.s.floor) ? r.s.floor / 1000 : Number.NaN));
    const spike = rows.map((r) => (r.s && Number.isFinite(r.s.spike[k]) ? r.s.spike[k] / 1000 : Number.NaN));
    this.areaMargin.setSubtitle(
      `${when}・約定価格が 0.01 円になる買いの減少（左）と、${x} 円を超える買いの増加（右）（GW。各エリアの価格を決めたカーブから計算した目安）` +
        (rows.some((r) => r.estimate && r.s) ? '・破線の枠は推定のカーブ' : '') +
        '・押すと対象をそのエリアにします',
    );
    // 0.01 円にならない・高騰の目安を超えないときは、棒の代わりにそう書く
    const floorNotes = rows.map((r) => (!r.s || Number.isFinite(r.s.floor) ? null : r.s.floor === Number.NEGATIVE_INFINITY ? '0.01 円にならない' : '売りが尽きるまで 0.01 円'));
    const spikeNotes = rows.map((r) => (!r.s || Number.isFinite(r.s.spike[k]) ? null : Number.isNaN(r.s.spike[k]) ? '売りが尽きるまで超えない' : '買いが無くても超える'));
    const bars = (name: string, color: string, values: number[], notes: (string | null)[]) => ({
      type: 'bar',
      name,
      barMaxWidth: 12,
      barGap: '20%',
      color,
      data: barItems(values, notes, color, rows),
      label: { show: true, color: t.ink2, fontSize: 11, formatter: (p: { value: number }) => (Number.isFinite(p.value) ? fmtSigned(p.value, 1) : '') },
    });
    this.areaMargin.setOption(
      {
        grid: grid({ top: PLOT_TOP, right: 48, bottom: 28, left: 8 }),
        legend: legend({ data: [floorName, spikeName] }),
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          formatter: (ps: { dataIndex: number }[]) => {
            const r = rows[ps[0]?.dataIndex];
            if (!r) return '';
            let html = ttHeader(`${shortTarget(r.target)}（${r.ac ? curveNote(r.ac) : 'カーブなし'}）`);
            if (!r.s) return html + ttNote(r.reason);
            html += ttRow(neg, floorText(r.s.floor), floorName, 'rect');
            html += ttRow(pos, spikeText(r.s.spike[k], x), spikeName, 'rect');
            html += ttNote(`約定価格 ${fmtPrice(r.s.base)} ${PRICE_UNIT}・買いが ${fmtGw(r.s.limit)} より増えると売りが尽きる${r.estimate ? '・推定のカーブ' : ''}`);
            return html;
          },
        },
        xAxis: barValueAxis('GW', [...floor, ...spike], theme),
        yAxis: { type: 'category', data: rows.map((r) => shortTarget(r.target)), inverse: true, axisLabel: { interval: 0 } },
        series: [bars(floorName, neg, floor, floorNotes), bars(spikeName, pos, spike, spikeNotes)],
      },
      areaTable(rows, date, slot),
    );
  }

  // ---- 期間 ----

  private renderPeriod(cs: CurveStore): void {
    const { sel, state } = this.host.ctx();
    const from = Math.max(sel.from, cs.metricsFirst);
    const to = Math.min(sel.to, cs.metricsLast);
    const selC = from <= to ? reselect(sel, from, to) : null;
    const curves = selC && selC.days.length > 0 ? selC : null;
    if (state.curveArea === 'system') {
      this.collectBtn.hidden = true;
      this.renderSystemTrend(cs, sel, curves);
      this.renderSystemMargin(cs, curves);
    } else {
      this.renderAreaPeriod(cs, curves, state.curveArea);
    }
  }

  /** システムプライスの価格感応度の推移: JEPX の公表値（実線）と、入札カーブから計算した目安（破線。±1GW だけ） */
  private renderSystemTrend(cs: CurveStore, sel: Selection, curves: Selection | null): void {
    const { ds, state, theme } = this.host.ctx();
    const [neg, pos] = poles(theme);
    const mw = state.sensSize;
    const size = sizeText(mw);
    const col = (k: SeriesKey) => ds.values[SERIES_INDEX[k]];
    const buyK = sensitivityKey('buy', mw);
    const sellK = sensitivityKey('sell', mw);
    const hasPub = anyValue(sel, col(buyK));
    const withEst = mw === SENSITIVITY_MW && curves !== null;
    if (!hasPub && !withEst) {
      this.trend.setEmpty(
        mw === SENSITIVITY_MW
          ? '選択した期間に、JEPX の価格感応度の公表値も入札カーブの指標もありません。'
          : `選択した期間に、買い ±${size} の JEPX の公表値がありません（npm run fetch で取得できます）。入札カーブから計算した目安は ±${sizeText(SENSITIVITY_MW)} だけです。`,
      );
      return;
    }
    const use = hasPub ? sel : curves!;
    const lines: PeriodLine[] = [];
    if (hasPub) {
      lines.push(
        { name: '上昇幅（公表値）', short: '上昇（公表）', color: pos, dashed: false, source: { a: col(buyK), b: col('system') } },
        { name: '下落幅（公表値）', short: '下落（公表）', color: neg, dashed: false, source: { a: col('system'), b: col(sellK) } },
      );
    }
    if (withEst) {
      lines.push(
        { name: '上昇幅（目安）', short: '上昇（目安）', color: pos, dashed: true, source: { a: cs.metricArray(ds, 'upPrice') } },
        { name: '下落幅（目安）', short: '下落（目安）', color: neg, dashed: true, source: { a: cs.metricArray(ds, 'downPrice') } },
      );
    }
    const gran = autoGranularity(use);
    const what =
      hasPub && withEst
        ? '実線は JEPX の公表値、破線は入札カーブから計算した目安'
        : hasPub
          ? `JEPX の公表値（入札カーブから計算した目安は ±${sizeText(SENSITIVITY_MW)} のときだけ重ねます）`
          : `入札カーブから計算した目安（この期間に JEPX の公表値はありません）`;
    this.drawLines(this.trend, use, gran, lines, {
      subtitle: `${describeSelection(use, state)}・システムプライス・買いが ${size} 増えたときの上昇幅と、減ったときの下落幅（円/kWh、${granText(gran)}）・${what}`,
      unit: PRICE_UNIT,
      scale: 1,
      min: 0,
      format: (v) => `${fmtPrice(v)} 円`,
      digits: 2,
      filename: `jepx_sensitivity_system_${mw}_${rangeTag(use)}.csv`,
    });
  }

  /** システムプライスのカーブで、0.01 円になる・高騰の目安を超える買いの増減の推移（入札カーブの指標から） */
  private renderSystemMargin(cs: CurveStore, curves: Selection | null): void {
    const { ds, state, theme } = this.host.ctx();
    const [neg, pos] = poles(theme);
    if (!curves) {
      this.margin.setEmpty(`選択した期間に入札カーブの指標がありません（${formatDay(cs.metricsFirst)}〜${formatDay(cs.metricsLast)} にあります）。`);
      return;
    }
    const x = state.spikePrice;
    const [sellX, buyX] = SPIKE_METRICS[x];
    const m = (k: CurveMetricKey) => cs.metricArray(ds, k);
    const gran = autoGranularity(curves);
    this.drawLines(
      this.margin,
      curves,
      gran,
      [
        { name: '0.01 円になる', short: '0.01円', color: neg, dashed: false, source: { a: m('sell001'), b: m('buyTotal') } },
        { name: `${x} 円を超える`, short: `${x}円`, color: pos, dashed: false, source: { a: m(sellX), b: m(buyX) } },
      ],
      {
        subtitle:
          `${describeSelection(curves, state)}・システムプライスのカーブで、約定価格が 0.01 円になる・${x} 円を超える買いの増減（GW、${granText(gran)}。0 が実際の買い）・` +
          `0.01 円以下の売り − 買いの合計、${x} 円以下の売り − ${x} 円以上の買い`,
        unit: 'GW',
        scale: 1 / 1000,
        zeroLine: true,
        format: (v) => `${fmtSigned(v, 2)} GW`,
        digits: 3,
        filename: `jepx_sensitivity_margin_system_${x}_${rangeTag(curves)}.csv`,
      },
    );
  }

  /** エリアを選んでいるとき: そのエリアの価格を決めたカーブから、1 日ずつ読んで計算した値の推移 */
  private renderAreaPeriod(cs: CurveStore, curves: Selection | null, area: AreaKey): void {
    const { ds, state, theme } = this.host.ctx();
    const [neg, pos] = poles(theme);
    const name = areaLabel(area);
    const cards = [this.trend, this.margin];
    // 計算する前も、何の図かが分かるようにする（計算した後は描くときに付け直す）
    for (const c of cards) c.setSubtitle(curves ? `${describeSelection(curves, state)}・${name}` : name);
    if (!curves) {
      this.collectBtn.hidden = true;
      cards.forEach((c) => c.setEmpty(`選択した期間に入札カーブがありません（${formatDay(cs.first)}〜${formatDay(cs.last)} にあります）。`));
      return;
    }
    const days = cs.days.filter((d) => d >= curves.from && d <= curves.to);
    const got = this.areaData(cs, area);
    const missing = days.filter((d) => !got?.days.has(d));
    const have = days.length - missing.length;
    this.collectBtn.hidden = this.collecting !== null || missing.length === 0;
    this.collectBtn.textContent = have > 0 ? `残りの ${fmtNum(missing.length)} 日分も計算する` : `${name}の ${fmtNum(days.length)} 日分のカーブから計算する`;
    // 集めている途中は、進み具合を出したままにする
    if (this.collecting === area) return;
    if (days.length === 0) {
      cards.forEach((c) => c.setEmpty(`選択した期間に、1 コマの入札カーブのある日がありません（${formatDay(cs.first)}〜${formatDay(cs.last)} にあります）。`));
      return;
    }
    if (!got || have === 0) {
      const msg = `「価格感応度の推移」のボタンを押すと、${name}の価格を決めたカーブ（分断エリアのカーブか、単エリアの推定）を ${fmtNum(days.length)} 日分読み込み、コマごとに計算します。JEPX はエリアごとの価格感応度を公表していません。`;
      cards.forEach((c) => c.setEmpty(msg));
      return;
    }
    const mw = state.sensSize;
    const size = sizeText(mw);
    const x = state.spikePrice;
    const gran = autoGranularity(curves);
    const range = `カーブのある ${fmtNum(have)} 日${missing.length > 0 ? `（まだ計算していない ${fmtNum(missing.length)} 日を除く）` : ''}${got.failed > 0 ? `・読み込めなかった ${fmtNum(got.failed)} 日を除く` : ''}`;
    const arr = (f: SensField) => this.fieldArray(area, got, f, ds);
    this.drawLines(
      this.trend,
      curves,
      gran,
      [
        { name: '上昇幅（目安）', short: '上昇（目安）', color: pos, dashed: true, source: { a: arr(`up${mw}`) } },
        { name: '下落幅（目安）', short: '下落（目安）', color: neg, dashed: true, source: { a: arr(`down${mw}`) } },
      ],
      {
        subtitle: `${describeSelection(curves, state)}・${name}・${range}・買いが ${size} 増えたときの上昇幅と、減ったときの下落幅（円/kWh、${granText(gran)}。${name}の価格を決めたカーブから計算した目安）`,
        unit: PRICE_UNIT,
        scale: 1,
        min: 0,
        format: (v) => `${fmtPrice(v)} 円`,
        digits: 2,
        filename: `jepx_sensitivity_${area}_${mw}_${rangeTag(curves)}.csv`,
      },
    );
    this.drawLines(
      this.margin,
      curves,
      gran,
      [
        { name: '0.01 円になる', short: '0.01円', color: neg, dashed: false, source: { a: arr('floor') } },
        { name: `${x} 円を超える`, short: `${x}円`, color: pos, dashed: false, source: { a: arr(`spike${x}`) } },
      ],
      {
        subtitle: `${describeSelection(curves, state)}・${name}・${range}・約定価格が 0.01 円になる・${x} 円を超える買いの増減（GW、${granText(gran)}。0 が実際の買い）`,
        unit: 'GW',
        scale: 1 / 1000,
        zeroLine: true,
        format: (v) => `${fmtSigned(v, 2)} GW`,
        digits: 3,
        filename: `jepx_sensitivity_margin_${area}_${x}_${rangeTag(curves)}.csv`,
      },
    );
  }

  /** 期間の折れ線（期間ごとの平均） */
  private drawLines(
    card: ChartCard,
    sel: Selection,
    gran: ReturnType<typeof autoGranularity>,
    lines: PeriodLine[],
    opts: { subtitle: string; unit: string; scale: number; min?: number; zeroLine?: boolean; format: (v: number) => string; digits: number; filename: string },
  ): void {
    const { theme } = this.host.ctx();
    const t = TOKENS[theme];
    const raw = buildSeriesPoints(sel, lines.map((l) => l.source), gran, 'mean');
    const data = raw.map((r) => r.points.map(([x, v]) => [x, v * opts.scale] as [number, number]));
    if (!data.some((d) => d.some((p) => Number.isFinite(p[1])))) {
      card.setEmpty('選択した条件に値がありません。');
      return;
    }
    const names = lines.map((l) => l.name);
    const legendOf = wrappedLegend(names, card.chart.getWidth(), lines.map((l) => l.dashed));
    const ends = endLabels(lines.map((l) => l.short), data.map((d) => d.map((p) => p[1])), theme, 260);
    const room = Math.max(...lines.map((l) => (legendTextWidth(l.short) * 11) / 12)) + 16;
    card.setSubtitle(opts.subtitle);
    card.setOption(
      {
        grid: grid({ top: legendOf.top + 8, right: Math.max(24, room) }),
        legend: legendOf.legend,
        tooltip: {
          trigger: 'axis',
          formatter: namedTooltip(
            names,
            lines.map((l) => l.color),
            (p) => periodLabel(Number((p.value as number[])[0]), gran),
            opts.format,
            lines.map((l) => l.dashed),
          ),
        },
        xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
        yAxis: valueAxis(opts.unit, opts.min !== undefined ? { min: opts.min } : {}),
        series: lines.map((l, i) =>
          styledLine(l.name, l.color, theme, gran === 'slot' ? breakGaps(data[i]) : data[i], l.dashed, {
            sampling: 'lttb',
            ...ends[i],
            ...(opts.zeroLine && i === 0
              ? {
                  markLine: {
                    symbol: 'none',
                    silent: true,
                    animation: false,
                    lineStyle: { color: t.ink2, width: 1, type: 'solid' },
                    label: { formatter: '実際の買い', position: 'insideEndTop', color: t.ink2, fontSize: 11 },
                    data: [{ yAxis: 0 }],
                  },
                }
              : {}),
          }),
        ),
      },
      {
        columns: ['期間', ...lines.map((l) => `${l.name}（${opts.unit}）`)],
        rows: data[0].map((p, r) => [periodLabel(p[0], gran), ...data.map((d) => d[r][1])]),
        digits: [null, ...lines.map(() => opts.digits)],
        filename: opts.filename,
      },
    );
  }

  // ---- エリアの期間の値を集める ----

  private areaData(cs: CurveStore, area: AreaKey): AreaSensitivity | undefined {
    const got = collected.get(cs)?.get(area);
    return got && got.ds === this.host.ctx().ds ? got : undefined;
  }

  private onCollect(): void {
    const { curves: cs, state, sel } = this.host.ctx();
    const area = state.curveArea;
    if (!cs || area === 'system') return;
    const from = Math.max(sel.from, cs.metricsFirst);
    const to = Math.min(sel.to, cs.metricsLast);
    const days = cs.days.filter((d) => d >= from && d <= to && !this.areaData(cs, area)?.days.has(d));
    if (days.length > 0) void this.collect(cs, area, days);
  }

  /** エリアの価格を決めたカーブを 1 日ずつ読み、コマごとの価格感応度を集める（読んだカーブは手元に置かない） */
  private async collect(cs: CurveStore, area: AreaKey, days: number[]): Promise<void> {
    if (this.collecting) return;
    this.collecting = area;
    const ds = this.host.ctx().ds;
    let map = collected.get(cs);
    if (!map) collected.set(cs, (map = new Map()));
    let got = this.areaData(cs, area);
    if (!got) map.set(area, (got = { ds, days: new Map(), version: 0, failed: 0 }));
    const name = areaLabel(area);
    this.collectBtn.hidden = true;
    try {
      let k = 0;
      for (const d of days) {
        // タブを切り替えたり、対象を変えたりしたらやめる（計算し終えた日の値は使う）
        if (this.host.disposed() || this.host.ctx().state.curveArea !== area) break;
        const msg = `${name}の入札カーブを読み込んでいます… ${fmtNum(++k)} / ${fmtNum(days.length)} 日`;
        this.trend.setEmpty(msg);
        this.margin.setEmpty(msg);
        let day: CurveDay | null = null;
        try {
          day = await cs.readDay(d);
        } catch {
          got.failed++;
        }
        // 進み具合を表示できるよう、1 日ごとに描画の機会を渡す
        await new Promise((r) => setTimeout(r, 0));
        if (!day) continue;
        const vals = new Float64Array(SLOTS * FIELD_COUNT).fill(Number.NaN);
        for (let s = 0; s < SLOTS; s++) {
          const sens = sensitivityOf(this.host.curveOf(day, s, area));
          if (sens) vals.set(sensitivityValues(sens), s * FIELD_COUNT);
        }
        got.days.set(d, vals);
        got.version++;
      }
    } finally {
      this.collecting = null;
    }
    if (!this.host.disposed()) this.renderPeriod(cs);
  }

  /** 集めた値の 1 つを、Dataset の日の並びにそろえた配列（n × 48、無い値は NaN） */
  private fieldArray(area: AreaKey, got: AreaSensitivity, field: SensField, ds: Dataset): Float64Array {
    const key = `${area}|${field}|${got.version}|${ds.start}|${ds.n}`;
    let out = this.aligned.get(key);
    if (out) return out;
    out = new Float64Array(ds.n * SLOTS).fill(Number.NaN);
    const f = SENS_FIELD_INDEX[field];
    for (const [day, vals] of got.days) {
      const i = day - ds.start;
      if (i < 0 || i >= ds.n) continue;
      for (let s = 0; s < SLOTS; s++) out[i * SLOTS + s] = vals[s * FIELD_COUNT + f];
    }
    if (this.aligned.size > 20) this.aligned.clear();
    this.aligned.set(key, out);
    return out;
  }
}

interface PeriodLine {
  name: string;
  short: string;
  color: string;
  dashed: boolean;
  source: Source;
}

/** 発散色（負: 青、正: 赤）の両端 */
function poles(theme: ThemeName): [string, string] {
  const div = TOKENS[theme].div;
  return [div[0], div[div.length - 1]];
}

/** 推定のカーブの棒は、薄い塗りと破線の枠にする */
function barStyle(color: string, estimate: boolean, positive: boolean): Record<string, unknown> {
  const borderRadius = positive ? [0, 4, 4, 0] : [4, 0, 0, 4];
  return estimate ? { color: withAlpha(color, 0.3), borderColor: color, borderWidth: 1.5, borderType: 'dashed', borderRadius } : { color, borderRadius };
}

/**
 * エリア別の図の棒（推定のカーブは薄い塗りと破線の枠）。値が無く理由があるところは、0 の位置に理由だけを書く
 * @param position 値ラベルの位置（省略すると値の符号で左右を決める）
 */
function barItems(values: number[], notes: (string | null)[], color: string, rows: TargetRow[], position?: 'left' | 'right'): Record<string, unknown>[] {
  return values.map((v, i) => {
    if (Number.isFinite(v)) return { value: v, itemStyle: barStyle(color, rows[i].estimate, v >= 0), label: { position: position ?? (v >= 0 ? 'right' : 'left') } };
    const note = notes[i];
    return note ? { value: 0, itemStyle: { color: 'transparent' }, label: { position: position ?? 'right', formatter: note } } : { value: Number.NaN };
  });
}

/** 横向きの棒の値の軸（0 を挟んで左右に伸ばす）。棒の先の値のラベルが収まるよう、値のある側に余白を取る */
function barValueAxis(unit: string, values: number[], theme: ThemeName): Record<string, unknown> {
  const v = values.filter(Number.isFinite);
  const lo = Math.min(0, ...v);
  const hi = Math.max(0, ...v);
  const pad = (hi - lo || 1) * 0.16;
  const interval = niceStep((hi - lo + (lo < 0 ? pad : 0) + (hi > 0 ? pad : 0)) / 6);
  return valueAxis(unit, {
    nameLocation: 'end',
    nameTextStyle: { align: 'right', verticalAlign: 'top', padding: [22, 0, 0, 0] },
    min: lo < 0 ? Math.floor((lo - pad) / interval) * interval : 0,
    max: hi > 0 ? Math.ceil((hi + pad) / interval) * interval : 0,
    interval,
    splitLine: { show: true, lineStyle: { color: TOKENS[theme].grid } },
    axisLabel: { formatter: (x: number) => (x === 0 ? '0' : fmtSigned(x, Number.isInteger(x) ? 0 : 1)) },
  });
}

/** 期間の中に値が 1 つでもあるか（時間帯の条件も見る） */
function anyValue(sel: Selection, values: Float64Array): boolean {
  for (const i of sel.days) {
    for (const s of sel.slots) if (Number.isFinite(values[i * SLOTS + s])) return true;
  }
  return false;
}

/** 縦軸（価格）の上限。「自動」は約定価格の 1.5 倍と、高騰の目安の最も高い価格（50 円）が入る段 */
function responseTop(range: CurveRange, s: Sensitivity): number {
  if (range !== 'auto' && range !== 'all') return Number(range);
  const need = range === 'all' ? s.response.steps[s.response.steps.length - 1].price : Math.max(s.base * 1.5, SPIKE_PRICES[SPIKE_PRICES.length - 1]);
  return PRICE_TOPS.find((m) => m >= need) ?? Math.ceil(need / 100) * 100;
}

/** 横軸（買いの増減、GW）の範囲: 0.01 円になるところから、縦軸の上限に届くところ（か売りが尽きるところ）まで。±5.5GW は必ず入れる */
function shiftAxis(s: Sensitivity, top: number): { min: number; max: number; interval: number } {
  const r = s.response;
  const reach = r.steps.find((x) => x.price > top)?.from ?? r.limit;
  const lo = Math.min(-MIN_SHIFT, Number.isFinite(s.floor) ? s.floor : -MIN_SHIFT);
  const hi = Math.max(MIN_SHIFT, Math.min(reach, r.limit));
  const pad = (hi - lo) * 0.03;
  const interval = niceStep((hi - lo + 2 * pad) / 1000 / 8);
  return { min: Math.floor((lo - pad) / 1000 / interval) * interval, max: Math.ceil((hi + pad) / 1000 / interval) * interval, interval };
}

/** 約定価格の段を、横軸 GW・縦軸 円/kWh の折れ線の頂点にする（lo〜hi の MW の範囲。売りが尽きたところで終える） */
function responsePath(s: Sensitivity, lo: number, hi: number): [number, number][] {
  const { steps, limit } = s.response;
  const end = Math.min(hi, limit);
  const out: [number, number][] = [];
  for (let k = 0; k < steps.length; k++) {
    const a = Math.max(steps[k].from, lo);
    const b = Math.min(k + 1 < steps.length ? steps[k + 1].from : limit, end);
    if (b < a) continue;
    out.push([a / 1000, steps[k].price], [b / 1000, steps[k].price]);
  }
  return out;
}

/** 横軸のツールチップ用の見えない系列（横軸を細かく刻んだ点。curves.ts の priceProbe の横軸版） */
function shiftProbe(min: number, max: number, step: number): Record<string, unknown> {
  const n = Math.floor((max - min) / step + 1e-9);
  return {
    type: 'line',
    name: '',
    data: Array.from({ length: n + 1 }, (_, k) => [Math.round((min + k * step) * 1e6) / 1e6, 0]),
    symbol: 'none',
    silent: true,
    animation: false,
    lineStyle: { opacity: 0 },
    emphasis: { disabled: true },
    z: 0,
  };
}

/** 動いた後の価格と、その差 */
function priceMove(price: number, base: number): string {
  return Number.isFinite(price) ? `${fmtPrice(price)} 円（${fmtSigned(price - base)}）` : '売りが尽きる';
}

function floorText(floor: number): string {
  if (floor === Number.NEGATIVE_INFINITY) return '買いが無くても 0.01 円にならない';
  if (!Number.isFinite(floor)) return '—';
  return floor <= 0 ? `買いが ${fmtGw(-floor)} 減ると` : `今は 0.01 円（買いが ${fmtGw(floor)} 増えるまで）`;
}

function spikeText(spike: number, price: number): string {
  if (Number.isNaN(spike)) return '売りが尽きるまで超えない';
  if (spike === Number.NEGATIVE_INFINITY) return `買いが無くても ${price} 円を超える`;
  return spike > 0 ? `買いが ${fmtGw(spike)} 増えると` : `今は ${price} 円を超えている（買いが ${fmtGw(-spike)} 減ると ${price} 円以下）`;
}

/** 1 コマの図の下に並べる、0.01 円・高騰・売りが尽きるまでの量と、選んだ量の価格感応度 */
function responseTiles(s: Sensitivity, size: SensitivitySize, pub: { system: number; up: number[]; down: number[] } | null): StatTile[] {
  const k = SENSITIVITY_SIZES.indexOf(size);
  const finite = (v: number) => Number.isFinite(v);
  const tiles: StatTile[] = [
    {
      label: '0.01 円になる',
      value: finite(s.floor) ? signedGw(s.floor) : '—',
      unit: finite(s.floor) ? 'GW' : undefined,
      sub: floorText(s.floor),
    },
    ...SPIKE_PRICES.map((p, i) => ({
      label: `${p} 円を超える`,
      value: finite(s.spike[i]) ? signedGw(s.spike[i]) : '—',
      unit: finite(s.spike[i]) ? 'GW' : undefined,
      sub: spikeText(s.spike[i], p),
    })),
    { label: '売り入札が尽きる', value: signedGw(s.limit), unit: 'GW', sub: `買いが ${fmtGw(Math.max(0, s.limit))} より増えると、売りが足りない` },
  ];
  const sz = sizeText(size);
  for (const [dir, price, pubPrice] of [
    ['+', s.up[k], pub?.up[k]],
    ['−', s.down[k], pub?.down[k]],
  ] as const) {
    tiles.push({
      label: `買い ${dir}${sz}`,
      value: finite(price) ? fmtSigned(price - s.base) : '—',
      unit: finite(price) ? '円/kWh' : undefined,
      sub:
        (finite(price) ? `${fmtPrice(price)} 円になる` : '売りが尽きる') +
        (pub && pubPrice !== undefined && finite(pubPrice) ? `（JEPX の公表値 ${fmtSigned(pubPrice - pub.system)} 円）` : ''),
    });
  }
  return tiles;
}

/** 1 コマの図の表: 買いの増減ごとの約定価格の目安と公表値、0.01 円・高騰・売りが尽きるまでの量 */
function responseTable(s: Sensitivity, pub: { system: number; up: number[]; down: number[] } | null, target: CurveTarget, date: number, slot: number): TableData {
  const rows: (string | number)[][] = [['増減なし', 0, s.base, pub?.system ?? '']];
  SENSITIVITY_SIZES.forEach((mw, k) => {
    rows.push([`買い +${sizeText(mw)}`, mw, s.up[k], pub?.up[k] ?? '']);
    rows.push([`買い −${sizeText(mw)}`, -mw, s.down[k], pub?.down[k] ?? '']);
  });
  const at = (mw: number) => priceAtShift(s.response, mw);
  rows.push(['0.01 円になる（これより買いが減ると）', s.floor, Number.isFinite(s.floor) ? at(s.floor - 1) : '', '']);
  // 超えた直後の価格（段の境目ちょうどの買いの増減では、まだ超える前の価格で交わることがある）
  SPIKE_PRICES.forEach((p, i) => rows.push([`${p} 円を超える（これより買いが増えると）`, s.spike[i], exceedStep(s.response, p)?.price ?? '', '']));
  rows.push(['売り入札が尽きる（これより買いが増えると）', s.limit, '', '']);
  return {
    columns: ['買いの増減', '買いの増減（MW）', '約定価格の目安（円/kWh）', 'JEPX の公表値（円/kWh）'],
    rows: rows.map((r) => r.map((v) => (typeof v === 'number' && !Number.isFinite(v) ? '' : v))),
    digits: [null, 0, 2, 2],
    filename: `jepx_sensitivity_${fileDate(date)}_${slotStartLabel(slot).replace(':', '')}${target === 'system' ? '' : `_${target}`}.csv`,
  };
}

/** エリア別の図の表（2 つの図で共通） */
function areaTable(rows: TargetRow[], date: number, slot: number): TableData {
  return {
    columns: [
      '対象',
      'カーブ',
      '約定価格（円/kWh）',
      ...SENSITIVITY_SIZES.flatMap((mw) => [`買い +${sizeText(mw)}（円/kWh）`, `買い −${sizeText(mw)}（円/kWh）`]),
      '0.01 円になる買いの増減（MW）',
      ...SPIKE_PRICES.map((p) => `${p} 円を超える買いの増減（MW）`),
      '売りが尽きる買いの増減（MW）',
    ],
    rows: rows.map((r) => {
      const s = r.s;
      const num = (v: number | undefined) => (v !== undefined && Number.isFinite(v) ? v : '');
      return [
        targetLabel(r.target),
        r.ac ? (s ? curveNote(r.ac) : `${curveNote(r.ac)}（${r.reason}）`) : 'カーブなし',
        num(s?.base),
        ...SENSITIVITY_SIZES.flatMap((_, k) => [num(s?.up[k]), num(s?.down[k])]),
        num(s?.floor),
        ...SPIKE_PRICES.map((_, i) => num(s?.spike[i])),
        num(s?.limit),
      ];
    }),
    digits: [null, null, 2, ...SENSITIVITY_SIZES.flatMap(() => [2, 2]), 0, ...SPIKE_PRICES.map(() => 0), 0],
    filename: `jepx_sensitivity_areas_${fileDate(date)}_${slotStartLabel(slot).replace(':', '')}.csv`,
  };
}
