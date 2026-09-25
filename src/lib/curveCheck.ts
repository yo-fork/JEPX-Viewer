/**
 * 取得済みの入札カーブを、取引結果（約定価格・売り買いの入札量）と突き合わせて確かめる（npm run check:curves）。
 *
 * - システムプライスのカーブの入札量の合計が、取引結果の売り・買い入札量（全国）と同じか。
 *   同じなら、システムプライスのカーブには（単エリアを含む）全エリアの入札が入っている
 * - 公表されている分断エリアのカーブの交点が、そのエリアの約定価格と同じか。
 *   同じなら、分断エリアのカーブには連系線でやりとりする量も入っている（入っていなければ、連系線で受ける側・送る側のカーブは
 *   約定価格では交わらない）
 * - 公表されている分断エリアのカーブの合計とシステムプライスのカーブの差。単エリアが無いコマでは、連系線でやりとりする量になる
 * - 単エリアが 1 つのコマで、推定したカーブ（システムプライス − 分断エリア、売り・買いに同じ量を足しただけ）の交点が、
 *   そのエリアの約定価格と同じか
 */
import { areaCurve, curveDifference, liftDifference, slotSplit, totalOf } from './areaCurves';
import { crossing, rowsFromSteps, SYSTEM_GROUP, type CurveGroup } from './bidCurves';
import type { AreaKey, PriceKey } from './series';

export type SlotKind = 'none' | 'split' | 'single' | 'singles' | 'unnamed';
export const SLOT_KINDS: SlotKind[] = ['none', 'split', 'single', 'singles', 'unnamed'];
export const SLOT_KIND_LABEL: Record<SlotKind, string> = {
  none: '分断なし',
  split: '分断・単エリアなし',
  single: '単エリア 1 つ',
  singles: '単エリア 2 つ以上',
  unnamed: '分断・エリア名なし',
};

export interface SlotInput {
  groups: readonly CurveGroup[];
  /** 取引結果の約定価格（円/kWh。分からなければ NaN） */
  price: (key: PriceKey) => number;
  /** 取引結果の売り・買い入札量（MW。分からなければ NaN） */
  sellBid: number;
  buyBid: number;
  /** 間引く前のカーブから計算した、システムプライスのカーブの入札量の合計と交点の価格（無ければ描画用のカーブから） */
  systemSell?: number;
  systemBuy?: number;
  systemClear?: number;
}

export interface SlotCheck {
  kind: SlotKind;
  /** 単エリア */
  singles: AreaKey[];
  /** システムプライスのカーブの入札量の合計 − 取引結果の入札量（MW。分からなければ NaN） */
  sellDiff: number;
  buyDiff: number;
  /** システムプライスのカーブの交点 − システムプライス（円/kWh） */
  systemCross: number;
  /** 公表されている分断エリアのカーブそれぞれの、交点 − そのエリアの約定価格（円/kWh） */
  groupCross: number[];
  /** 公表されている分断エリアのカーブの合計 − システムプライスのカーブ（入札量の合計、MW。分断していなければ NaN） */
  excessSell: number;
  excessBuy: number;
  /** システムプライス − 分断エリアの合計の、価格による変わり方（MW。分断していなければ NaN） */
  rangeSell: number;
  rangeBuy: number;
  /** 単エリアが 1 つのコマの推定 */
  estimate?: {
    area: AreaKey;
    /** 推定できた（引いた差が価格によって変わる） */
    available: boolean;
    /** 引いて足しただけのカーブの交点 − そのエリアの約定価格（円/kWh） */
    cross: number;
    /** 約定価格で交わるように足した量（MW） */
    correction: number;
    /** 売り・買いに足した量（MW） */
    lift: number;
  };
}

const crossPrice = (g: { sell: ArrayLike<number>; buy: ArrayLike<number> }): number => crossing(rowsFromSteps(g.sell, g.buy))?.price ?? Number.NaN;

export function slotKind(groups: readonly CurveGroup[]): SlotKind {
  const split = slotSplit(groups);
  if (split.kind !== 'split') return split.kind;
  return split.singles.length === 0 ? 'split' : split.singles.length === 1 ? 'single' : 'singles';
}

/** 1 コマ分を確かめる（システムプライスのカーブが無ければ null） */
export function checkSlot(input: SlotInput): SlotCheck | null {
  const system = input.groups.find((g) => g.id === SYSTEM_GROUP);
  if (!system) return null;
  const split = slotSplit(input.groups);
  const out: SlotCheck = {
    kind: slotKind(input.groups),
    singles: split.kind === 'split' ? split.singles : [],
    sellDiff: (input.systemSell ?? totalOf(system.sell)) - input.sellBid,
    buyDiff: (input.systemBuy ?? totalOf(system.buy)) - input.buyBid,
    systemCross: (input.systemClear ?? crossPrice(system)) - input.price('system'),
    groupCross: [],
    excessSell: Number.NaN,
    excessBuy: Number.NaN,
    rangeSell: Number.NaN,
    rangeBuy: Number.NaN,
  };
  const published = input.groups.filter((g) => g.id !== SYSTEM_GROUP);
  if (published.length === 0) return out;
  out.excessSell = published.reduce((v, g) => v + totalOf(g.sell), 0) - totalOf(system.sell);
  out.excessBuy = published.reduce((v, g) => v + totalOf(g.buy), 0) - totalOf(system.buy);
  const lifted = liftDifference(curveDifference(system, published));
  out.rangeSell = lifted.sellRange;
  out.rangeBuy = lifted.buyRange;
  if (split.kind !== 'split') return out;
  out.groupCross = split.published.map((g) => crossPrice(g) - input.price(g.areas[0]));
  if (split.singles.length === 1) {
    const area = split.singles[0];
    const ac = areaCurve(input.groups, area, input.price)!;
    out.estimate = {
      area,
      available: ac.kind === 'single',
      cross: (ac.rawCrossing ?? Number.NaN) - input.price(area),
      correction: ac.correction?.mw ?? Number.NaN,
      lift: ac.lift ?? Number.NaN,
    };
  }
  return out;
}

// ---- まとめ ----

/** 中央値（NaN は除く。無ければ NaN） */
export function median(values: readonly number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** 条件を満たす割合（NaN は除く。無ければ NaN） */
export function share(values: readonly number[], test: (v: number) => boolean): number {
  const v = values.filter(Number.isFinite);
  return v.length === 0 ? Number.NaN : v.filter(test).length / v.length;
}

/** 価格の差の目安（円/kWh）: 同じ（0.01 円以内）・0.1 円以内・0.5 円以内 */
export const PRICE_TOLERANCES = [0.01, 0.1, 0.5] as const;
export const withinPrice = (tol: number) => (v: number) => Math.abs(v) <= tol + 1e-9;
