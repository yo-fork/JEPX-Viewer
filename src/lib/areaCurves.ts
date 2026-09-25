/**
 * エリアごとの入札カーブ（そのコマでエリアの価格を決めたカーブ）。
 *
 * - 市場分断が無いコマは、どのエリアもシステムプライスのカーブ
 * - 分断したコマは、エリアを含む分断エリア（JEPX が公表する 2 エリア以上のまとまり）のカーブ
 * - 1 エリアだけで分断した「単エリア」は JEPX がカーブを出さないので、システムプライスのカーブから
 *   公表されている分断エリアのカーブを引いて推定する。
 *
 * システムプライスのカーブは全エリアの入札そのものだが、分断エリアのカーブには、連系線で他の分断エリアとやりとりする量が
 * 送る側では買い、受ける側では売りとして、価格によらない量で入っているとみられる（分断エリアのカーブが約定価格で交わるのはそのため。
 * 公表されている分断エリアの入札量の合計が、システムプライスより多くなることもある）。引くと、その分だけ売り・買いとも引き過ぎになる。
 * - 引き過ぎは価格によらない量なので、売り・買いに同じ量を足して 0 以上に戻す。同じ量なので交点の価格は変わらない。
 *   足す量そのもの（単エリアの、最も安い売り・最も高い買いの量）は分からないので、少ない方の端を 0 にする
 * - 単エリアが 1 つなら、足したカーブはそのエリアの約定価格で交わるはず。ずれが残れば売りか買いの一方に足して合わせる
 * - 単エリアが複数なら、エリアごとには分けられないので、合わせたカーブ（補正なし）にする
 * - 引いた差が価格によらずほぼ一定（単エリアの入札の形が残らない）なら、推定できないとする
 */
import {
  buyVolumeAt,
  buyVolumesAt,
  crossing,
  rowsFromSteps,
  sellVolumeAt,
  sellVolumesAt,
  stepPrices,
  SYSTEM_GROUP,
  SYSTEM_LABEL,
  type CurveDay,
  type CurveGroup,
} from './bidCurves';
import { AREA_KEYS, SERIES_LABEL, type AreaKey } from './series';

/** 入札カーブを見る対象（システムプライスか、エリア） */
export type CurveTarget = 'system' | AreaKey;
export const CURVE_TARGETS: CurveTarget[] = ['system', ...AREA_KEYS];

/** 階段状のカーブ（売りは価格の昇順、買いは降順に [価格, 累積量, …]） */
export interface StepCurve {
  sell: ArrayLike<number>;
  buy: ArrayLike<number>;
}

/** そのコマの市場分断の様子 */
export type SlotSplit =
  | { kind: 'none' }
  /** 分断しているが、分断エリアの名前（エリアの組み合わせ）が分からない */
  | { kind: 'unnamed' }
  | {
      kind: 'split';
      /** 公表されている分断エリア */
      published: CurveGroup[];
      /** どの分断エリアにも入っていないエリア（単エリア） */
      singles: AreaKey[];
    };

export function slotSplit(groups: readonly CurveGroup[]): SlotSplit {
  const published = groups.filter((g) => g.id !== SYSTEM_GROUP);
  if (published.length === 0) return { kind: 'none' };
  if (published.some((g) => g.areas.length === 0)) return { kind: 'unnamed' };
  const covered = new Set(published.flatMap((g) => g.areas));
  return { kind: 'split', published, singles: AREA_KEYS.filter((a) => !covered.has(a)) };
}

/** 階段状のカーブの差（total − Σ parts）。売り・買いそれぞれ、価格の点（昇順）ごとの値で、負にもなる */
export interface CurveDifference {
  sellPrices: number[];
  sell: Float64Array;
  buyPrices: number[];
  buy: Float64Array;
}

export function curveDifference(total: StepCurve, parts: readonly StepCurve[]): CurveDifference {
  const side = (pick: (c: StepCurve) => ArrayLike<number>, volumesAt: typeof sellVolumesAt) => {
    const prices = stepPrices(pick(total), ...parts.map(pick));
    const v = volumesAt(pick(total), prices);
    for (const part of parts) {
      const x = volumesAt(pick(part), prices);
      for (let k = 0; k < prices.length; k++) v[k] -= x[k];
    }
    return { prices, v };
  };
  const s = side((c) => c.sell, sellVolumesAt);
  const b = side((c) => c.buy, buyVolumesAt);
  return { sellPrices: s.prices, sell: s.v, buyPrices: b.prices, buy: b.v };
}

export interface LiftedCurve {
  sell: Float64Array;
  buy: Float64Array;
  /** 売り・買いの両方に足した量（MW。負のところが無ければ 0） */
  lift: number;
  /** 価格による量の変わり方（MW）: 売りは最も高い価格と最も安い価格の点の差、買いは最も安い価格と最も高い価格の点の差 */
  sellRange: number;
  buyRange: number;
}

/**
 * 差のカーブを階段状のカーブにする。累積の量として減らないようにならし（売りは安い方から、買いは高い方から見て、
 * 前の点より少なければ前の点の量のまま）、負のところがあれば、売り・買いに同じ量を足して、
 * 少ない方の端（最も安い売りか、最も高い買い）が 0 になるようにする（交点の価格は変わらない）。量は 1MW 単位に丸める
 */
export function liftDifference(d: CurveDifference): LiftedCurve {
  const sell = Float64Array.from(d.sell);
  for (let k = 1; k < sell.length; k++) sell[k] = Math.max(sell[k], sell[k - 1]);
  const buy = Float64Array.from(d.buy);
  for (let k = buy.length - 2; k >= 0; k--) buy[k] = Math.max(buy[k], buy[k + 1]);
  const ends: number[] = [];
  if (sell.length > 0) ends.push(sell[0]);
  if (buy.length > 0) ends.push(buy[buy.length - 1]);
  const lift = Math.max(0, Math.round(-Math.min(0, ...ends)));
  const steps = (prices: number[], v: Float64Array, descending: boolean) => {
    const out: number[] = [];
    let prev = 0;
    for (let i = 0; i < prices.length; i++) {
      const k = descending ? prices.length - 1 - i : i;
      const x = Math.round(v[k] + lift);
      if (x > prev) {
        out.push(prices[k], x);
        prev = x;
      }
    }
    return Float64Array.from(out);
  };
  return {
    sell: steps(d.sellPrices, sell, false),
    buy: steps(d.buyPrices, buy, true),
    lift,
    sellRange: sell.length > 0 ? sell[sell.length - 1] - sell[0] : 0,
    buyRange: buy.length > 0 ? buy[0] - buy[buy.length - 1] : 0,
  };
}

/**
 * 交点が price になるよう、売りか買いの一方に一定量を足す。
 * price での売りの累積が買いより多ければ買いに、少なければ売りにその差を足す。
 */
export function correctToPrice(curve: StepCurve, price: number): { sell: Float64Array; buy: Float64Array; side: 'sell' | 'buy'; mw: number } {
  const gap = Math.round(sellVolumeAt(curve.sell, price) - buyVolumeAt(curve.buy, price));
  const add = (steps: ArrayLike<number>, mw: number) => {
    if (steps.length === 0) return Float64Array.of(price, mw);
    const out = Float64Array.from(steps);
    for (let i = 1; i < out.length; i += 2) out[i] += mw;
    return out;
  };
  if (gap >= 0) return { sell: Float64Array.from(curve.sell), buy: add(curve.buy, gap), side: 'buy', mw: gap };
  return { sell: add(curve.sell, -gap), buy: Float64Array.from(curve.buy), side: 'sell', mw: -gap };
}

/** 売り・買いの入札量の合計（MW） */
export interface CurveTotals {
  /** システムプライスのカーブ */
  systemSell: number;
  systemBuy: number;
  /** 公表されている分断エリアのカーブの合計 */
  publishedSell: number;
  publishedBuy: number;
}

export interface AreaCurve {
  /**
   * system: システムプライスのカーブ（対象がシステムプライスか、分断していないコマ）
   * group: 公表されている分断エリアのカーブ
   * single: 単エリアのカーブ（推定）
   * combined: 単エリアが複数のとき、それらを合わせたカーブ（推定）
   * unavailable: 単エリアだが、システムプライスのカーブから引いた差が価格によらずほぼ一定で推定できない（sell・buy は空）
   */
  kind: 'system' | 'group' | 'single' | 'combined' | 'unavailable';
  sell: Float64Array;
  buy: Float64Array;
  /** カーブの名前（システムプライス、東北・東京・中部、北海道、北海道・四国 など） */
  label: string;
  /** このカーブで価格が決まったエリア */
  areas: readonly AreaKey[];
  /** 分断しているが分断エリアの名前が分からず、システムプライスのカーブで代わりにしたとき */
  unnamed?: boolean;
  /** 推定: システムプライスのカーブから引いた分断エリア */
  subtracted?: string[];
  /** 推定: 引いた後に売り・買いの両方に足した量（MW） */
  lift?: number;
  /** single: 補正する前のカーブ（引いて足しただけ）の交点の価格（交わらなければ NaN） */
  rawCrossing?: number;
  /** single: 約定価格で交わるように足した側と量（約定価格が分からなければ無し） */
  correction?: { side: 'sell' | 'buy'; mw: number; price: number };
  /** 推定・unavailable: 売り・買いの入札量の合計 */
  totals?: CurveTotals;
}

/**
 * 単エリアの入札の形が残っているとみなす、引いた差の価格による変わり方の最小: システムプライスの入札量の合計に対する割合と下限（MW）。
 * 描画用に間引いたカーブの差なので、間引いた分（各カーブの合計量の 0.1%）より十分大きくとる
 */
export const MIN_RESIDUAL_SHARE = 0.005;
const MIN_RESIDUAL_MW = 100;

/**
 * システムプライスのカーブの入札量の合計と、取引結果の売り・買い入札量（kWh を MW にしたもの）を同じとみなす差（MW）。
 * 描画用のカーブの量は 1MW 単位に丸めてある
 */
export const TOTALS_TOLERANCE_MW = 1;
export const sameTotal = (curveMw: number, spotMw: number): boolean => Math.abs(curveMw - spotMw) <= TOTALS_TOLERANCE_MW;

/** 階段状のカーブの入札量の合計（売りは最も高い価格、買いは最も安い価格での累積。どちらも最後の点） */
export const totalOf = (steps: ArrayLike<number>): number => (steps.length >= 2 ? steps[steps.length - 1] : 0);

export const areaLabel = (a: AreaKey): string => SERIES_LABEL[a];

/**
 * そのコマで target の価格を決めたカーブ。
 * @param priceOf エリアの約定価格（分からなければ NaN）。単エリアの補正に使う
 */
export function areaCurve(groups: readonly CurveGroup[], target: CurveTarget, priceOf: (area: AreaKey) => number): AreaCurve | null {
  const system = groups.find((g) => g.id === SYSTEM_GROUP);
  if (!system) return null;
  const sys: AreaCurve = { kind: 'system', sell: system.sell, buy: system.buy, label: SYSTEM_LABEL, areas: AREA_KEYS };
  if (target === 'system') return sys;
  const split = slotSplit(groups);
  if (split.kind === 'none') return sys;
  if (split.kind === 'unnamed') return { ...sys, unnamed: true };
  const own = split.published.find((g) => g.areas.includes(target));
  if (own) return { kind: 'group', sell: own.sell, buy: own.buy, label: own.label, areas: own.areas };

  const est = liftDifference(curveDifference(system, split.published));
  const subtracted = split.published.map((g) => g.label);
  const label = split.singles.map(areaLabel).join('・');
  const sum = (f: (g: CurveGroup) => ArrayLike<number>) => split.published.reduce((v, g) => v + totalOf(f(g)), 0);
  const totals: CurveTotals = {
    systemSell: totalOf(system.sell),
    systemBuy: totalOf(system.buy),
    publishedSell: sum((g) => g.sell),
    publishedBuy: sum((g) => g.buy),
  };
  const minMw = Math.max(MIN_RESIDUAL_MW, MIN_RESIDUAL_SHARE * Math.max(totals.systemSell, totals.systemBuy));
  if (est.sellRange < minMw && est.buyRange < minMw) {
    return { kind: 'unavailable', sell: new Float64Array(0), buy: new Float64Array(0), label, areas: split.singles, subtracted, totals };
  }
  const base = { sell: est.sell, buy: est.buy, subtracted, lift: est.lift, totals };
  if (split.singles.length > 1) return { kind: 'combined', ...base, label, areas: split.singles };
  const rawCrossing = crossing(rowsFromSteps(est.sell, est.buy))?.price ?? Number.NaN;
  const single = { kind: 'single' as const, ...base, label: areaLabel(target), areas: [target], rawCrossing };
  const price = priceOf(target);
  if (!Number.isFinite(price)) return single;
  const c = correctToPrice(est, price);
  return { ...single, sell: c.sell, buy: c.buy, correction: { side: c.side, mw: c.mw, price } };
}

/** その日のうち、area だけが単エリアになったコマ（そのエリアのカーブを推定・補正できるコマ） */
export function aloneSlots(day: CurveDay, area: AreaKey): number[] {
  const out: number[] = [];
  day.slots.forEach((groups, s) => {
    if (!groups) return;
    const split = slotSplit(groups);
    if (split.kind === 'split' && split.singles.length === 1 && split.singles[0] === area) out.push(s);
  });
  return out;
}
