/**
 * エリアごとの入札カーブ（そのコマでエリアの価格を決めたカーブ）。
 *
 * - 市場分断が無いコマは、どのエリアもシステムプライスのカーブ
 * - 分断したコマは、エリアを含む分断エリア（JEPX が公表する 2 エリア以上のまとまり）のカーブ
 * - 1 エリアだけで分断した「単エリア」は JEPX がカーブを出さないので、システムプライスのカーブから
 *   公表されている分断エリアのカーブを引いて推定する。
 *
 * JEPX の実データ（2022〜2026 年）で確かめたカーブの作り:
 * - システムプライスのカーブには、単エリアを含む全エリアの入札が入っている（引いた差が、単エリアの入札の分だけ価格によって変わる）
 * - 分断エリアのカーブには、連系線で他の分断エリアとやりとりする量が、送る側では買い（最も高い価格）、受ける側では売り（0 円）として
 *   入っている。単エリアの無い分断では、システムプライス − 分断エリアの合計は、どの価格でも同じ量になる。
 *   公表されている分断エリアの入札量の合計が、システムプライスより多くなることもある
 * - ブロック入札は、システムプライスの計算と市場分断の計算とで約定するものが違い、カーブには約定したものだけが価格によらない量で入っている。
 *   その差は、取引結果の入札量・ブロック入札の量と、システムプライスのカーブの入札量の合計から分かる
 *
 * そこで、単エリアのカーブは次のように推定する（単エリアが 1 つなら、こうして作ったカーブはそのエリアの約定価格で交わる）。
 * 1. システムプライスのカーブから、公表されている分断エリアのカーブを引く（負にもなる）
 * 2. ブロック入札の約定の違いを差し引く（取引結果にブロック入札の量が無ければ、代わりに 4. で合わせる）
 * 3. 連系線でやりとりする量は分からないので、売り・買いに同じ量を足して 0 以上に戻す。同じ量なので交点の価格は変わらない。
 *    足す量そのものは分からないため、少ない方の端（最も安い売りか最も高い買い）を 0 にする
 * 4. 単エリアが 1 つなら、約定価格とのずれが残れば売りか買いの一方に足して合わせる
 * 単エリアが複数ならエリアごとには分けられないので、合わせたカーブ（4. はしない）にする。
 * 引いた差が価格によらずほぼ一定（単エリアの入札の形が残らない）なら、推定できないとする。
 */
import {
  buyVolumeAt,
  crossing,
  curveDifference,
  rowsFromSteps,
  sellVolumeAt,
  SYSTEM_GROUP,
  SYSTEM_LABEL,
  type CurveDay,
  type CurveDifference,
  type CurveGroup,
  type StepCurve,
  type StepResidual,
} from './bidCurves';
import { AREA_KEYS, SERIES_LABEL, SLOTS, type AreaKey } from './series';

export { curveDifference, type CurveDifference, type StepCurve } from './bidCurves';

/** 入札カーブを見る対象（システムプライスか、エリア） */
export type CurveTarget = 'system' | AreaKey;
export const CURVE_TARGETS: CurveTarget[] = ['system', ...AREA_KEYS];

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

/** 保存しておいた「システムプライス − 分断エリアの合計」（間引く前のカーブから求めたもの）を、価格の点ごとの値に戻す */
export function residualDifference(r: StepResidual): CurveDifference {
  const sellPrices: number[] = [];
  const sell: number[] = [];
  for (let i = 0; i < r.sell.length; i += 2) {
    sellPrices.push(r.sell[i]);
    sell.push(r.sell[i + 1] - r.offset);
  }
  // 買いは価格の降順なので、昇順に並べ直す
  const buyPrices: number[] = [];
  const buy: number[] = [];
  for (let i = r.buy.length - 2; i >= 0; i -= 2) {
    buyPrices.push(r.buy[i]);
    buy.push(r.buy[i + 1] - r.offset);
  }
  return { sellPrices, sell: Float64Array.from(sell), buyPrices, buy: Float64Array.from(buy) };
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

/** 取引結果の売り・買い入札量とブロック入札の量（MW。分からなければ NaN） */
export interface SpotBids {
  sellBid: number;
  buyBid: number;
  sellBlockBid: number;
  sellBlockVolume: number;
  buyBlockBid: number;
  buyBlockVolume: number;
}

/**
 * ブロック入札の約定の違い（MW）: システムプライスの計算で、市場分断の計算より多く約定した売りのブロック入札（sell）と、
 * 少なく約定した買いのブロック入札（buy）。どちらも負にもなる
 */
export interface BlockGap {
  sell: number;
  buy: number;
}

/** ブロック入札の約定の違いの説明（「システムプライスの計算のほうが、売りが 142 MW 多く、買いが 758 MW 少なく約定」） */
export function blockGapText(g: BlockGap, fmt: (mw: number) => string = (mw) => `${Math.round(mw).toLocaleString('ja-JP')} MW`): string {
  if (g.sell === 0 && g.buy === 0) return 'システムプライスの計算と市場分断の計算とで同じだけ約定';
  const side = (label: string, mw: number) => (mw === 0 ? `${label}は同じだけ` : `${label}が ${fmt(Math.abs(mw))} ${mw > 0 ? '多く' : '少なく'}`);
  // buy は「少なく約定した買い」なので、符号を逆にして言う
  return `システムプライスの計算のほうが、${side('売り', g.sell)}、${side('買い', -g.buy)}約定`;
}

/**
 * 取引結果とシステムプライスのカーブから、ブロック入札の約定の違いを求める（取引結果にブロック入札の量が無ければ null）。
 * システムプライスのカーブの入札量の合計 = 取引結果の入札量 − システムプライスの計算で約定しなかったブロック入札。
 * 約定したブロック入札の量（取引結果）は市場分断の計算のもの
 */
export function blockGap(system: StepCurve, spot: SpotBids): BlockGap | null {
  const sell = spot.sellBlockBid - spot.sellBlockVolume - (spot.sellBid - totalOf(system.sell));
  const buy = spot.buyBid - totalOf(system.buy) - (spot.buyBlockBid - spot.buyBlockVolume);
  return Number.isFinite(sell) && Number.isFinite(buy) ? { sell: Math.round(sell), buy: Math.round(buy) } : null;
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
  /** 推定: 差し引いたブロック入札の約定の違い（取引結果にブロック入札の量が無ければ無し） */
  blocks?: BlockGap;
  /** 推定: 引いた差の価格による変わり方（MW。単エリアの入札の分） */
  ranges?: { sell: number; buy: number };
  /** 推定: 間引く前のカーブから求めた差を使った（前の版のファイルでは、描画用に間引いたカーブどうしの差） */
  exact?: boolean;
  /** single: 補正する前のカーブ（引いてブロック入札の違いを差し引き、足しただけ）の交点の価格（交わらなければ NaN） */
  rawCrossing?: number;
  /** single: 約定価格で交わるように足した側と量（もう約定価格で交わっていれば量は 0。約定価格が分からなければ無し） */
  correction?: { side: 'sell' | 'buy'; mw: number; price: number };
  /** 推定・unavailable: 売り・買いの入札量の合計 */
  totals?: CurveTotals;
}

/**
 * 単エリアの入札の形が残っているとみなす、引いた差の価格による変わり方の最小: システムプライスの入札量の合計に対する割合と下限（MW）。
 * 描画用に間引いたカーブの差なので、間引いた分（各カーブの合計量の 0.1%）より十分大きくとる
 */
export const MIN_RESIDUAL_SHARE = 0.005;
export const MIN_RESIDUAL_MW = 100;
/** 同じ価格とみなす差（価格は 0.01 円単位） */
const PRICE_EPS = 0.005;

/** 階段状のカーブの入札量の合計（売りは最も高い価格、買いは最も安い価格での累積。どちらも最後の点） */
export const totalOf = (steps: ArrayLike<number>): number => (steps.length >= 2 ? steps[steps.length - 1] : 0);

export const areaLabel = (a: AreaKey): string => SERIES_LABEL[a];

/** 単エリアの推定に使う、取引結果と保存しておいた差 */
export interface EstimateInputs {
  /** 取引結果の入札量・ブロック入札の量（ブロック入札の約定の違いを差し引くのに使う） */
  spot?: SpotBids | null;
  /** 間引く前のカーブから求めた「システムプライス − 分断エリアの合計」（CurveDay.residuals） */
  residual?: StepResidual | null;
}

/**
 * そのコマで target の価格を決めたカーブ。
 * @param priceOf エリアの約定価格（分からなければ NaN）。単エリアの補正に使う
 */
export function areaCurve(groups: readonly CurveGroup[], target: CurveTarget, priceOf: (area: AreaKey) => number, inputs: EstimateInputs = {}): AreaCurve | null {
  const system = groups.find((g) => g.id === SYSTEM_GROUP);
  if (!system) return null;
  const sys: AreaCurve = { kind: 'system', sell: system.sell, buy: system.buy, label: SYSTEM_LABEL, areas: AREA_KEYS };
  if (target === 'system') return sys;
  const split = slotSplit(groups);
  if (split.kind === 'none') return sys;
  if (split.kind === 'unnamed') return { ...sys, unnamed: true };
  const own = split.published.find((g) => g.areas.includes(target));
  if (own) return { kind: 'group', sell: own.sell, buy: own.buy, label: own.label, areas: own.areas };

  const exact = !!inputs.residual;
  const diff = inputs.residual ? residualDifference(inputs.residual) : curveDifference(system, split.published);
  const blocks = inputs.spot ? blockGap(system, inputs.spot) : null;
  if (blocks) {
    for (let k = 0; k < diff.sell.length; k++) diff.sell[k] -= blocks.sell;
    for (let k = 0; k < diff.buy.length; k++) diff.buy[k] += blocks.buy;
  }
  const est = liftDifference(diff);
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
  const ranges = { sell: est.sellRange, buy: est.buyRange };
  if (ranges.sell < minMw && ranges.buy < minMw) {
    return { kind: 'unavailable', sell: new Float64Array(0), buy: new Float64Array(0), label, areas: split.singles, subtracted, totals, ranges };
  }
  const base = { sell: est.sell, buy: est.buy, subtracted, lift: est.lift, totals, ranges, exact, ...(blocks ? { blocks } : {}) };
  if (split.singles.length > 1) return { kind: 'combined', ...base, label, areas: split.singles };
  const rawCrossing = crossing(rowsFromSteps(est.sell, est.buy))?.price ?? Number.NaN;
  const single = { kind: 'single' as const, ...base, label: areaLabel(target), areas: [target], rawCrossing };
  const price = priceOf(target);
  if (!Number.isFinite(price)) return single;
  // もう約定価格で交わっていれば足さない（交点の段で売りと買いの量が違うのは、約定価格の入札が一部だけ約定したため）
  if (Math.abs(rawCrossing - price) < PRICE_EPS) return { ...single, correction: { side: 'buy', mw: 0, price } };
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

/** 市場分断が起きる地域間連系線（エリアのつながり） */
export const INTERTIES: readonly (readonly [AreaKey, AreaKey])[] = [
  ['hokkaido', 'tohoku'],
  ['tohoku', 'tokyo'],
  ['tokyo', 'chubu'],
  ['chubu', 'hokuriku'],
  ['chubu', 'kansai'],
  ['hokuriku', 'kansai'],
  ['kansai', 'chugoku'],
  ['kansai', 'shikoku'],
  ['chugoku', 'shikoku'],
  ['chugoku', 'kyushu'],
];

/**
 * 約定価格から分けた市場分断のまとまり（エリアの並び順）。連系線でつながったエリアのうち、価格が同じものを 1 つにまとめる。
 * 分断エリアは連系線でつながったエリアのまとまりなので、離れたエリアの価格がたまたま同じでも（最低価格の 0.01 円など）別のまとまりにする。
 * 価格の分からないエリアがあれば null
 */
export function priceSplit(price: (area: AreaKey) => number): AreaKey[][] | null {
  const ps = AREA_KEYS.map(price);
  if (ps.some((p) => !Number.isFinite(p))) return null;
  const parent = AREA_KEYS.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (const [a, b] of INTERTIES) {
    const i = AREA_KEYS.indexOf(a);
    const j = AREA_KEYS.indexOf(b);
    if (Math.abs(ps[i] - ps[j]) < PRICE_EPS) parent[root(i)] = root(j);
  }
  const groups = new Map<number, AreaKey[]>();
  AREA_KEYS.forEach((a, i) => {
    const r = root(i);
    const g = groups.get(r);
    if (g) g.push(a);
    else groups.set(r, [a]);
  });
  return [...groups.values()];
}

/** 単エリアが 1 つだけのコマ */
export interface AloneSlot {
  day: number;
  slot: number;
  /** 1 エリアだけで分断したエリア */
  area: AreaKey;
}

/**
 * 約定価格から、単エリアが 1 つだけのコマ（そのエリアのカーブを推定し、約定価格で補正できるコマ）を探す（日・コマの順）。
 * @param price 受渡日・コマ・エリアの約定価格（分からなければ NaN）
 */
export function findAloneSlots(days: readonly number[], price: (day: number, slot: number, area: AreaKey) => number): AloneSlot[] {
  const out: AloneSlot[] = [];
  for (const day of days) {
    for (let slot = 0; slot < SLOTS; slot++) {
      const groups = priceSplit((a) => price(day, slot, a));
      if (!groups || groups.length < 2) continue;
      const singles = groups.filter((g) => g.length === 1);
      if (singles.length === 1) out.push({ day, slot, area: singles[0][0] });
    }
  }
  return out;
}

/** 入札の段: その価格で増えた量（MW）と、増える前の累積（MW） */
export interface CurveStep {
  price: number;
  mw: number;
  before: number;
}

/**
 * 階段状のカーブの段（売りは価格の昇順、買いは降順の点の並び）。最初の点は段ではなく起点なので除く
 * （推定したカーブの最初の点には、足した量が入っている）
 */
export function curveSteps(steps: ArrayLike<number>): CurveStep[] {
  const out: CurveStep[] = [];
  for (let i = 2; i + 1 < steps.length; i += 2) out.push({ price: steps[i], mw: steps[i + 1] - steps[i - 1], before: steps[i - 1] });
  return out;
}
