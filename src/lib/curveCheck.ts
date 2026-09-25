/**
 * 取得済みの入札カーブを、取引結果（約定価格・入札量・ブロック入札の量）と突き合わせて確かめる（npm run check:curves）。
 *
 * - 単エリアの無い分断で、システムプライス − 分断エリアの合計が価格によらず一定か。
 *   一定なら、分断エリアのカーブには連系線でやりとりする量（とブロック入札の約定の違い）が価格によらない量で入っている
 * - 単エリアのある分断で、その差が価格によって変わるか。変われば、システムプライスのカーブに単エリアの入札が入っている
 * - 公表されている分断エリアのカーブが、そのエリアの約定価格で交わるか
 * - 単エリアが 1 つのコマで、推定したカーブ（引いて、ブロック入札の約定の違いを差し引き、売り・買いに同じ量を足したもの）が、
 *   補正しなくてもそのエリアの約定価格で交わるか
 */
import { areaCurve, blockGap, liftDifference, MIN_RESIDUAL_MW, MIN_RESIDUAL_SHARE, residualDifference, slotSplit, totalOf, type BlockGap, type SpotBids } from './areaCurves';
import { crossing, curveDifference, rowsFromSteps, SYSTEM_GROUP, type CurveGroup, type StepResidual } from './bidCurves';
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
  /** 間引く前のカーブから求めた「システムプライス − 分断エリアの合計」（前の版のファイルには無い） */
  residual?: StepResidual | null;
  /** 取引結果の約定価格（円/kWh。分からなければ NaN） */
  price: (key: PriceKey) => number;
  /** 取引結果の入札量・ブロック入札の量（MW。分からなければ NaN） */
  spot: SpotBids;
}

export interface SlotCheck {
  kind: SlotKind;
  /** 単エリア */
  singles: AreaKey[];
  /** 公表されている分断エリアのカーブそれぞれの、交点 − そのエリアの約定価格（円/kWh） */
  groupCross: number[];
  /** 分断エリアの合計 − システムプライスのカーブ（入札量の合計、MW。分断していなければ NaN） */
  excessSell: number;
  excessBuy: number;
  /** システムプライス − 分断エリアの合計の、価格による変わり方（MW。分断していなければ NaN） */
  rangeSell: number;
  rangeBuy: number;
  /** システムプライスの入札量の合計（売り・買いの多い方、MW） */
  systemTotal: number;
  /** ブロック入札の約定の違い（取引結果にブロック入札の量が無ければ null） */
  blocks: BlockGap | null;
  /** 間引く前のカーブから求めた差がある */
  exact: boolean;
  /** 単エリアが 1 つのコマの推定 */
  estimate?: {
    area: AreaKey;
    /** 推定できた（引いた差が価格によって変わる） */
    available: boolean;
    /** 推定したカーブ（補正する前）の交点 − そのエリアの約定価格（円/kWh）。売りと買いが同じ量の価格が幅を持つときは、その安い端 */
    cross: number;
    /** 約定価格で交わるように足した量（MW。補正しなくても約定価格で売りと買いが釣り合えば 0） */
    correction: number;
  };
}

/**
 * 価格によらず一定とみなす変わり方（MW）。間引く前のカーブからの差でも、各カーブを 1MW 単位に丸めた分は残る。
 * 描画用のカーブどうしの差では間引いた分の誤差があるので、システムプライスの入札量の 0.2% までとする
 */
export const FLAT_MW_EXACT = 5;
export const FLAT_SHARE_APPROX = 0.002;

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
  const published = input.groups.filter((g) => g.id !== SYSTEM_GROUP);
  const out: SlotCheck = {
    kind: slotKind(input.groups),
    singles: split.kind === 'split' ? split.singles : [],
    groupCross: [],
    excessSell: Number.NaN,
    excessBuy: Number.NaN,
    rangeSell: Number.NaN,
    rangeBuy: Number.NaN,
    systemTotal: Math.max(totalOf(system.sell), totalOf(system.buy)),
    blocks: blockGap(system, input.spot),
    exact: !!input.residual,
  };
  if (published.length === 0) return out;
  out.excessSell = published.reduce((v, g) => v + totalOf(g.sell), 0) - totalOf(system.sell);
  out.excessBuy = published.reduce((v, g) => v + totalOf(g.buy), 0) - totalOf(system.buy);
  const lifted = liftDifference(input.residual ? residualDifference(input.residual) : curveDifference(system, published));
  out.rangeSell = lifted.sellRange;
  out.rangeBuy = lifted.buyRange;
  if (split.kind !== 'split') return out;
  out.groupCross = split.published.map((g) => crossPrice(g) - input.price(g.areas[0]));
  if (split.singles.length === 1) {
    const area = split.singles[0];
    const ac = areaCurve(input.groups, area, input.price, { spot: input.spot, residual: input.residual })!;
    out.estimate = {
      area,
      available: ac.kind === 'single',
      cross: (ac.rawCrossing ?? Number.NaN) - input.price(area),
      correction: ac.correction?.mw ?? Number.NaN,
    };
  }
  return out;
}

/** 価格によらず一定か（変わり方が FLAT_MW_EXACT、描画用のカーブどうしならシステムプライスの入札量の 0.2% 以下） */
export function isFlat(c: SlotCheck): boolean {
  const tol = c.exact ? FLAT_MW_EXACT : FLAT_SHARE_APPROX * c.systemTotal;
  return c.rangeSell <= tol && c.rangeBuy <= tol;
}

/** 価格によって変わるか（単エリアの入札の形が残っているか。単エリアの推定と同じ基準） */
export function varies(c: SlotCheck): boolean {
  const min = Math.max(MIN_RESIDUAL_MW, MIN_RESIDUAL_SHARE * c.systemTotal);
  return c.rangeSell >= min || c.rangeBuy >= min;
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

/** 価格の差の目安（円/kWh）: 同じ（0.01 円未満）・0.1 円以内・0.5 円以内 */
export const PRICE_TOLERANCES = [0.01, 0.1, 0.5] as const;
export const withinPrice = (tol: number) => (v: number) => (tol <= 0.01 ? Math.abs(v) < 0.005 : Math.abs(v) <= tol + 1e-9);
