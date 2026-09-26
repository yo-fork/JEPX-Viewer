/**
 * 価格感応度: 買いが増えたり減ったりしたときに、約定価格がどう動くか。
 *
 * 売りと買いの入札カーブの交点を、買いの量をずらして求め直す（交わり方の決まりは bidCurves.ts の crossing と同じ）。
 * JEPX が公表している価格感応度（series.ts の SensitivityKey）は、0.01 円の売りか 999 円の買いを足して約定計算をやり直したもので、
 * ブロック入札の約定も判定し直している。ここではカーブをずらすだけなので、ブロック入札の約定
 * （分断エリアのカーブでは、連系線でやりとりする量も）を変えない目安になる。
 */
import { crossing, rowsFromSteps, type CurveRow, type StepCurve } from './bidCurves';
import { FLOOR_PRICE, SENSITIVITY_SIZES } from './series';

/** 高騰の目安にする価格（円/kWh）。期間の図は入札カーブの指標（その価格以下の売り・以上の買い）から求めるので、指標のある価格にする */
export const SPIKE_PRICES = [20, 50] as const;
export type SpikePrice = (typeof SPIKE_PRICES)[number];

const EPS = 1e-6;

/**
 * 買いの増減（MW。増えれば正）に対する約定価格の段。
 * 買いの増減が steps[k].from 以上、steps[k + 1].from 未満のとき、約定価格は steps[k].price（先頭の from は -Infinity）。
 * limit より買いが増えると、売り入札が足りず交わらない
 */
export interface PriceResponse {
  /** 交点を求めるカーブの行（価格の昇順） */
  rows: CurveRow[];
  steps: { from: number; price: number }[];
  limit: number;
}

export function priceResponse(curve: StepCurve): PriceResponse | null {
  const rows = rowsFromSteps(curve.sell, curve.buy);
  if (rows.length === 0) return null;
  const steps: { from: number; price: number }[] = [{ from: Number.NEGATIVE_INFINITY, price: rows[0].price }];
  const push = (from: number, price: number) => {
    const last = steps[steps.length - 1];
    if (Math.abs(last.price - price) < EPS) return;
    // 幅の無い段は、次の段で置き換える
    if (from <= last.from) last.price = price;
    else steps.push({ from, price });
  };
  // crossing(rows, d) は「売り − 買い」が d 以上になる最初の点で交わる。
  // それより前の点の「売り − 買い」の最大 max を d が超えると、交わる点が先へ移る
  let max = rows[0].sell - rows[0].buy;
  for (let k = 1; k < rows.length; k++) {
    const e = rows[k].sell - rows[k].buy;
    if (e <= max) continue;
    // d が「1 つ前の点の売り − この点の買い」より小さいあいだは、1 つ前の価格（買いの段）で交わる
    const y = rows[k - 1].sell - rows[k].buy;
    if (y > max) push(max, rows[k - 1].price);
    push(Math.max(y, max), rows[k].price);
    max = e;
  }
  return { rows, steps, limit: max };
}

/** 買いを mw だけ増やした（負なら減らした）ときの約定価格（売りが足りず交わらなければ NaN） */
export function priceAtShift(r: PriceResponse, mw: number): number {
  return crossing(r.rows, mw)?.price ?? Number.NaN;
}

/** 約定価格が price を超える最初の段（売りが尽きるまで超えなければ null） */
export function exceedStep(r: PriceResponse, price: number): { from: number; price: number } | null {
  return r.steps.find((x) => x.price > price + EPS) ?? null;
}

/**
 * 約定価格が price を超える買いの増減（MW）。買いがこれより増えると price を超える。
 * 売りが尽きるまで超えなければ NaN、買いをすべて除いても超えていれば -Infinity
 */
export function exceedShift(r: PriceResponse, price: number): number {
  return exceedStep(r, price)?.from ?? Number.NaN;
}

/** 1 コマ・1 本のカーブの価格感応度 */
export interface Sensitivity {
  response: PriceResponse;
  /** ずらさないときの約定価格 */
  base: number;
  /** 買いを SENSITIVITY_SIZES の量だけ増やしたとき・減らしたときの約定価格（売りが尽きれば NaN） */
  up: number[];
  down: number[];
  /** 0.01 円になる買いの増減（MW）。買いの増減がこれより小さいと 0.01 円（exceedShift の 0.01 円） */
  floor: number;
  /** SPIKE_PRICES を超える買いの増減（MW） */
  spike: number[];
  /** 売り入札が尽きる買いの増減（MW） */
  limit: number;
}

/**
 * カーブの価格感応度。
 * @param base ずらさないときの約定価格（単エリアの推定で約定価格に合わせて補正したカーブは、その約定価格）。省略すると交点の価格
 */
export function curveSensitivity(curve: StepCurve, base?: number): Sensitivity | null {
  const response = priceResponse(curve);
  if (!response) return null;
  const b = base ?? priceAtShift(response, 0);
  if (!Number.isFinite(b)) return null;
  return {
    response,
    base: b,
    up: SENSITIVITY_SIZES.map((mw) => priceAtShift(response, mw)),
    down: SENSITIVITY_SIZES.map((mw) => priceAtShift(response, -mw)),
    floor: exceedShift(response, FLOOR_PRICE),
    spike: SPIKE_PRICES.map((p) => exceedShift(response, p)),
    limit: response.limit,
  };
}

/** 期間で集計する値（1 コマごと） */
export const SENS_FIELDS = [
  ...SENSITIVITY_SIZES.flatMap((mw) => [`up${mw}`, `down${mw}`] as const),
  'floor',
  ...SPIKE_PRICES.map((p) => `spike${p}` as const),
] as const;
export type SensField = (typeof SENS_FIELDS)[number];
export const SENS_FIELD_INDEX = Object.fromEntries(SENS_FIELDS.map((f, i) => [f, i])) as Record<SensField, number>;

/**
 * SENS_FIELDS の順の値: 上昇幅・下落幅（円/kWh。売りが尽きれば NaN）、0.01 円になる・高騰する買いの増減（MW。無ければ NaN）
 */
export function sensitivityValues(s: Sensitivity): number[] {
  const finite = (v: number) => (Number.isFinite(v) ? v : Number.NaN);
  return [
    ...SENSITIVITY_SIZES.flatMap((_, i) => [s.up[i] - s.base, s.base - s.down[i]]),
    finite(s.floor),
    ...s.spike.map(finite),
  ];
}
