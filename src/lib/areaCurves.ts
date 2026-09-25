/**
 * エリアごとの入札カーブ（そのコマでエリアの価格を決めたカーブ）。
 *
 * - 市場分断が無いコマは、どのエリアもシステムプライスのカーブ
 * - 分断したコマは、エリアを含む分断エリア（JEPX が公表する 2 エリア以上のまとまり）のカーブ
 * - 1 エリアだけで分断した「単エリア」は JEPX がカーブを出さないので、システムプライスのカーブから
 *   公表されている分断エリアのカーブを引いて推定する。
 *   単エリアが 1 つなら、そのエリアの約定価格で交わるように売りか買いの一方に一定量を足して補正する
 *   （システムプライスのカーブと分断エリアのカーブで扱いの違う入札があるらしく、引いただけでは少しずれるため）。
 *   単エリアが複数なら、エリアごとには分けられないので、合わせたカーブ（補正なし）にする。
 */
import { buyVolumeAt, buyVolumesAt, sellVolumeAt, sellVolumesAt, stepPrices, SYSTEM_GROUP, SYSTEM_LABEL, type CurveDay, type CurveGroup } from './bidCurves';
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

/**
 * 階段状のカーブの差（total − Σ parts）。量は 1MW 単位に丸め、負にはせず、
 * 累積の量として減らないようにならす（売りは価格の昇順、買いは降順に増えていく）。
 */
export function subtractCurves(total: StepCurve, parts: readonly StepCurve[]): { sell: Float64Array; buy: Float64Array } {
  const sp = stepPrices(total.sell, ...parts.map((p) => p.sell));
  const st = sellVolumesAt(total.sell, sp);
  const sParts = parts.map((p) => sellVolumesAt(p.sell, sp));
  const sell: number[] = [];
  let prev = 0;
  for (let k = 0; k < sp.length; k++) {
    let v = st[k];
    for (const x of sParts) v -= x[k];
    v = Math.round(v);
    if (v > prev) {
      sell.push(sp[k], v);
      prev = v;
    }
  }
  const bp = stepPrices(total.buy, ...parts.map((p) => p.buy));
  const bt = buyVolumesAt(total.buy, bp);
  const bParts = parts.map((p) => buyVolumesAt(p.buy, bp));
  const buy: number[] = [];
  prev = 0;
  for (let k = bp.length - 1; k >= 0; k--) {
    let v = bt[k];
    for (const x of bParts) v -= x[k];
    v = Math.round(v);
    if (v > prev) {
      buy.push(bp[k], v);
      prev = v;
    }
  }
  return { sell: Float64Array.from(sell), buy: Float64Array.from(buy) };
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

export interface AreaCurve {
  /**
   * system: システムプライスのカーブ（対象がシステムプライスか、分断していないコマ）
   * group: 公表されている分断エリアのカーブ
   * single: 単エリアのカーブ（推定）
   * combined: 単エリアが複数のとき、それらを合わせたカーブ（推定）
   */
  kind: 'system' | 'group' | 'single' | 'combined';
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
  /** single: 約定価格で交わるように足した側と量（約定価格が分からなければ無し） */
  correction?: { side: 'sell' | 'buy'; mw: number; price: number };
}

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

  const residual = subtractCurves(system, split.published);
  const subtracted = split.published.map((g) => g.label);
  if (split.singles.length > 1) {
    return { kind: 'combined', ...residual, label: split.singles.map(areaLabel).join('・'), areas: split.singles, subtracted };
  }
  const price = priceOf(target);
  if (!Number.isFinite(price)) return { kind: 'single', ...residual, label: areaLabel(target), areas: [target], subtracted };
  const c = correctToPrice(residual, price);
  return { kind: 'single', sell: c.sell, buy: c.buy, label: areaLabel(target), areas: [target], subtracted, correction: { side: c.side, mw: c.mw, price } };
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
