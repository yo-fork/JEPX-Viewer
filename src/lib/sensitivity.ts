/**
 * 価格感応度: 買いが増えたり減ったりしたときに、約定価格がどう動くか。
 *
 * 売りと買いの入札カーブの交点を、買いの量をずらして求め直す（交わり方の決まりは bidCurves.ts の crossing と同じ）。
 * JEPX が公表している価格感応度（series.ts の SensitivityKey）は、0.01 円の売りか 999 円の買いを足して約定計算をやり直したもので、
 * ブロック入札の約定も判定し直している。ここではカーブをずらすだけなので、ブロック入札の約定
 * （分断エリアのカーブでは、連系線でやりとりする量も）を変えない目安になる。
 */
import { crossing, rowsFromSteps, SYSTEM_GROUP, type CurveRow, type RawCurveDay, type StepCurve } from './bidCurves';
import { FLOOR_PRICE, SENSITIVITY_SIZES, sensitivityKey, SLOTS, type SeriesKey } from './series';

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
  return responseOfRows(rowsFromSteps(curve.sell, curve.buy));
}

/** 価格の昇順の行（間引く前の CSV のカーブも）の、買いの増減に対する約定価格の段 */
export function responseOfRows(rows: CurveRow[]): PriceResponse | null {
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

// ---- ブロック入札の約定の変化の見込み ----
//
// JEPX の公表値は、買い（売り）を足して約定計算をやり直すときに、ブロック入札の約定も判定し直している。
// 買いが増えて価格が上がると、それまで約定しなかった売りのブロック入札が約定するなどして、足した量の一部が効かなくなる。
// 公表値の価格になるようにカーブをずらす量と、足した量との差を「効かなかった量」とし、その割合で見込む。

/** JEPX が公表している、そのコマの価格感応度（システムプライス。SENSITIVITY_SIZES の順） */
export interface PublishedSensitivity {
  system: number;
  /** 買いを足したとき（999 円の買い）・売りを足したとき（0.01 円の売り）のシステムプライス */
  up: number[];
  down: number[];
}

/** 取引結果の値から、そのコマの公表値を読む（1 つも無ければ null） */
export function publishedAt(value: (key: SeriesKey) => number): PublishedSensitivity | null {
  const up = SENSITIVITY_SIZES.map((mw) => value(sensitivityKey('buy', mw)));
  const down = SENSITIVITY_SIZES.map((mw) => value(sensitivityKey('sell', mw)));
  return [...up, ...down].some(Number.isFinite) ? { system: value('system'), up, down } : null;
}

/**
 * 約定価格が price になる買いの増減の範囲（MW）。その価格の段が無ければ、price をまたぐ境目（幅 0）。
 * 売りが尽きても届かなければ [limit, limit]
 */
export function shiftRangeAt(r: PriceResponse, price: number): [number, number] {
  const { steps, limit } = r;
  for (let k = 0; k < steps.length; k++) {
    const next = k + 1 < steps.length ? steps[k + 1].from : limit;
    if (Math.abs(steps[k].price - price) < 0.005) return [steps[k].from, next];
    if (steps[k].price > price) return [steps[k].from, steps[k].from];
  }
  return [limit, limit];
}

/**
 * 買いを mw 増やした（負なら減らした）のに、効かなかった量（MW）。
 * 公表値の価格の動き move（公表値 − 公表のシステムプライス）を、カーブの交点 base からの動きとして当てはめ、
 * そうなる買いの増減のうち mw に最も近いものとの差をとる（公表値を説明できる、効かなかった量の最小）。
 * 公表値のほうが大きく動いたときは負になる。求められなければ NaN
 */
export function absorbedMw(r: PriceResponse, base: number, mw: number, move: number): number {
  const a = absorbedRange(r, base, mw, move)[0];
  return Number.isFinite(a) ? a : Number.NaN;
}

/**
 * 公表値を説明できる、効かなかった量の範囲 [最小, 最大]（MW）。公表値の価格の段が幅を持つと、その幅だけ広がる。
 * 最大は、段が買いを減らす側に果てしなく続けば Infinity
 */
export function absorbedRange(r: PriceResponse, base: number, mw: number, move: number): [number, number] {
  const [lo, hi] = shiftRangeAt(r, base + move);
  // 段の端ちょうどでは隣の段の価格で交わることがあるので、段の内側に少し入れる（量は 0.1MW 単位より細かくはない）
  const inset = Math.min(0.5, (hi - lo) / 2);
  const d = Math.min(Math.max(mw, lo + inset), hi - inset);
  return mw > 0 ? [mw - d, mw - (lo + inset)] : [d - mw, hi - inset - mw];
}

/** 足した量のうち効かなかった割合（SENSITIVITY_SIZES の順。買いを増やすとき・減らすとき。分からなければ NaN） */
export interface BlockShare {
  up: number[];
  down: number[];
}

/** そのコマの公表値から求めた、効かなかった割合 */
export function publishedShare(r: PriceResponse, base: number, pub: PublishedSensitivity): BlockShare {
  const share = (mw: number, p: number) =>
    Number.isFinite(p) && Number.isFinite(pub.system) ? absorbedMw(r, base, mw, p - pub.system) / Math.abs(mw) : Number.NaN;
  return {
    up: SENSITIVITY_SIZES.map((mw, i) => share(mw, pub.up[i])),
    down: SENSITIVITY_SIZES.map((mw, i) => share(-mw, pub.down[i])),
  };
}

export const isCompleteShare = (s: BlockShare): boolean => [...s.up, ...s.down].every(Number.isFinite);

function quantile(values: number[], q: number): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const i = (v.length - 1) * q;
  const lo = Math.floor(i);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (i - lo);
}

/** いくつものコマの割合の、量・向きごとの q の分位点（値が minCount 個に満たなければ NaN） */
export function shareQuantile(samples: readonly BlockShare[], q: number, minCount = 1): BlockShare {
  const at = (side: 'up' | 'down', i: number) => {
    const v = samples.map((s) => s[side][i]).filter(Number.isFinite);
    return v.length >= minCount ? quantile(v, q) : Number.NaN;
  };
  return { up: SENSITIVITY_SIZES.map((_, i) => at('up', i)), down: SENSITIVITY_SIZES.map((_, i) => at('down', i)) };
}

/**
 * 効かない量の見込み。SENSITIVITY_SIZES の量では割合 × 量とし、その間（と 0 との間）は量について直線で結ぶ。
 * 最も大きい量（5GW）を超える分は、その分の tail の割合だけ効かない量を増やす（0 なら増えない）
 */
export interface BlockModel {
  share: BlockShare;
  /** 5GW を超える分のうち効かない割合（買いを増やすとき・減らすとき） */
  tail: { up: number; down: number };
}

/**
 * 5GW を超える分のうち効かない割合の上限。
 * 1 コマの公表値ではまれに 5GW のほとんどが効かないことがあり、その割合のまま伸ばすと、高騰する境目が現実離れして遠くなる
 */
export const MAX_TAIL_SHARE = 0.75;

/** 買いを m（MW、0 以上）増やす（up）・減らすときに効かない量（MW） */
export function absorbedAt(model: BlockModel, up: boolean, m: number): number {
  const shares = up ? model.share.up : model.share.down;
  let prevM = 0;
  let prevA = 0;
  for (let i = 0; i < SENSITIVITY_SIZES.length; i++) {
    const size = SENSITIVITY_SIZES[i];
    const a = shares[i] * size;
    if (m <= size) return prevA + ((a - prevA) * (m - prevM)) / (size - prevM);
    prevM = size;
    prevA = a;
  }
  return prevA + model.tail[up ? 'up' : 'down'] * (m - prevM);
}

/** 効かない量を見込んだ、交点を求める買いの増減（MW） */
export function effectiveShift(model: BlockModel, d: number): number {
  if (d === 0) return 0;
  const m = Math.abs(d);
  const e = m - absorbedAt(model, d > 0, m);
  return d > 0 ? e : -e;
}

/**
 * カーブで約定価格が変わる境目の買いの増減 t（MW）を、効かない量を見込んだ買いの増減にする。
 * 効かない量を見込むと届かなければ NaN（±Infinity と NaN はそのまま）
 */
export function adjustThreshold(model: BlockModel, t: number): number {
  if (!Number.isFinite(t) || t === 0) return t;
  const up = t > 0;
  const sign = up ? 1 : -1;
  const target = Math.abs(t);
  // 実際に効く量 g(m) = m − 効かない量 が target に届く最小の m（g は SENSITIVITY_SIZES で折れる直線）
  const g = (m: number) => m - absorbedAt(model, up, m);
  let m0 = 0;
  let g0 = 0;
  for (const m1 of SENSITIVITY_SIZES) {
    const g1 = g(m1);
    if (g1 >= target) return sign * (m0 + ((target - g0) / (g1 - g0)) * (m1 - m0));
    m0 = m1;
    g0 = g1;
  }
  const slope = 1 - model.tail[up ? 'up' : 'down'];
  return slope > 0 ? sign * (m0 + (target - g0) / slope) : Number.NaN;
}

/** 効かない量を見込んだ価格感応度（価格は SENSITIVITY_SIZES の順、境目は MW） */
export interface AdjustedSensitivity {
  up: number[];
  down: number[];
  floor: number;
  spike: number[];
}

export function adjustSensitivity(s: Sensitivity, model: BlockModel): AdjustedSensitivity {
  const at = (d: number) => priceAtShift(s.response, effectiveShift(model, d));
  return {
    up: SENSITIVITY_SIZES.map((mw) => at(mw)),
    down: SENSITIVITY_SIZES.map((mw) => at(-mw)),
    floor: adjustThreshold(model, s.floor),
    spike: s.spike.map((t) => adjustThreshold(model, t)),
  };
}

/**
 * 見込みと、その範囲の 3 つの見込み。
 * 範囲の一方（less）は割合の少ない側で、5GW を超える分では効かない量が増えない。
 * もう一方（more）は割合の多い側で、5GW を超える分も tail.more の 5GW での割合で効かない量が増える。
 * 見込み（mid）の 5GW を超える分は、tail.mid の 5GW での割合の半分（増えない場合と、割合のまま増える場合の中間）で増やす。
 * tail は、1 コマの公表値に合わせた見込みでは直近の日の割合を使う（1 コマの 5GW での割合は、ばらつきが大きい）
 */
export interface BlockModels {
  mid: BlockModel;
  less: BlockModel;
  more: BlockModel;
}

export function blockModels(mid: BlockShare, less: BlockShare = mid, more: BlockShare = mid, tail: { mid: BlockShare; more: BlockShare } = { mid, more }): BlockModels {
  const last = SENSITIVITY_SIZES.length - 1;
  const rate = (s: BlockShare, k: number) => {
    const at = (v: number) => (Number.isFinite(v) ? Math.min(MAX_TAIL_SHARE, Math.max(0, v * k)) : 0);
    return { up: at(s.up[last]), down: at(s.down[last]) };
  };
  return {
    mid: { share: mid, tail: rate(tail.mid, 0.5) },
    less: { share: less, tail: { up: 0, down: 0 } },
    more: { share: more, tail: rate(tail.more, 1) },
  };
}

// ---- ブロック入札の約定の変化の推定 ----
//
// 公表値の計算で効かなかった量は、約定が変わったブロック入札の量とみなせる。ブロック入札は連続するコマに同じ量で入るので、
// 1 日のコマの効かなかった量を、できるだけ少ない一定の量の区切りで説明し、その量の増減をブロックらしきもの（時間帯と量）に分ける。
// 効かなかった量の範囲は、描画用に間引いたカーブでは粗くなりすぎる（数十 MW ずれる）ので、間引く前のカーブから求めて保存しておく。

/** 効かなかった量の範囲を保存する、買いの増減の量と向き（この順に [最小, 最大] を並べる） */
export const FLIP_CASES = SENSITIVITY_SIZES.flatMap((mw) => [
  { mw, up: true },
  { mw, up: false },
]);

/** 1 コマの、公表値を説明できる効かなかった量の範囲（FLIP_CASES の順に最小・最大。公表値の無いものは NaN） */
export function absorbedRanges(r: PriceResponse, base: number, pub: PublishedSensitivity): number[] {
  return FLIP_CASES.flatMap(({ mw, up }) => {
    const i = SENSITIVITY_SIZES.indexOf(mw as (typeof SENSITIVITY_SIZES)[number]);
    const p = up ? pub.up[i] : pub.down[i];
    return Number.isFinite(p) && Number.isFinite(pub.system) ? absorbedRange(r, base, up ? mw : -mw, p - pub.system) : [Number.NaN, Number.NaN];
  });
}

/**
 * 1 日分の、効かなかった量の範囲（入札カーブの日のファイルに入れる形）。
 * 間引く前のシステムプライスのカーブと、そのコマの公表値から求め、0.1MW に丸める。最小が分からなければ null、最大が無限なら null
 */
export function absorbedOfDay(raw: RawCurveDay, pubOf: (slot: number) => PublishedSensitivity | null): ((number | null)[] | null)[] {
  return Array.from({ length: SLOTS }, (_, s) => {
    const rows = raw.slots[s]?.get(SYSTEM_GROUP);
    const pub = rows ? pubOf(s) : null;
    const r = rows && pub ? responseOfRows(rows) : null;
    if (!r || !pub) return null;
    const v = absorbedRanges(r, priceAtShift(r, 0), pub);
    return v.some(Number.isFinite) ? v.map((x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null)) : null;
  });
}

/**
 * 効かなかった量を一定とみなせる区切り（コマ from 以上 to 未満。mw は選んだ量）。
 * lo〜hi はその区切りのすべてのコマの範囲に入る量（許す幅を足さずに重ならなければ、足した範囲）
 */
export interface FlipPlateau {
  from: number;
  to: number;
  lo: number;
  hi: number;
  mw: number;
}

/** 効かなかった量の範囲を丸めた誤差などとして許す幅（MW） */
export const FLIP_TOLERANCE = 2;

/**
 * コマごとの効かなかった量の範囲を、できるだけ少ない一定の量の区切りで説明する（許す幅 tol まで範囲の外でもよい）。
 * 区切りの量は、すべてのコマの範囲に入る量のうち、前の区切りの量にできるだけ近いもの（最初は 0 に近いもの。量が変わる区切りを増やさない）。
 * 範囲の無いコマはどの量でもよい
 */
export function flipPlateaus(ranges: readonly ([number, number] | null)[], tol = FLIP_TOLERANCE): FlipPlateau[] {
  const n = ranges.length;
  const lo = (i: number) => (ranges[i] && Number.isFinite(ranges[i]![0]) ? ranges[i]![0] - tol : Number.NEGATIVE_INFINITY);
  const hi = (i: number) => (ranges[i] && Number.isFinite(ranges[i]![0]) ? ranges[i]![1] + tol : Number.POSITIVE_INFINITY);
  const count = new Array<number>(n + 1).fill(Number.POSITIVE_INFINITY);
  const start = new Array<number>(n + 1).fill(-1);
  count[0] = 0;
  for (let j = 1; j <= n; j++) {
    let a = Number.NEGATIVE_INFINITY;
    let b = Number.POSITIVE_INFINITY;
    for (let i = j - 1; i >= 0; i--) {
      a = Math.max(a, lo(i));
      b = Math.min(b, hi(i));
      if (a > b) break;
      if (count[i] + 1 < count[j]) {
        count[j] = count[i] + 1;
        start[j] = i;
      }
    }
  }
  const cuts: [number, number][] = [];
  for (let j = n; j > 0; j = start[j]) cuts.unshift([start[j], j]);
  let prev = 0;
  return cuts.map(([from, to]) => {
    // 許す幅を足さない範囲が重なれば、その中から選ぶ
    let a = Number.NEGATIVE_INFINITY;
    let b = Number.POSITIVE_INFINITY;
    for (let i = from; i < to; i++) {
      a = Math.max(a, lo(i) + tol);
      b = Math.min(b, hi(i) - tol);
    }
    if (a > b) {
      a -= tol;
      b += tol;
    }
    const mw = Math.min(Math.max(prev, a), b);
    prev = mw;
    return { from, to, lo: a, hi: b, mw };
  });
}

/** 約定が変わったとみられるブロック入札（コマ from 以上 to 未満に mw） */
export interface FlipBlock {
  from: number;
  to: number;
  mw: number;
}

/** ブロックらしきものとして挙げる最小の量（MW。これより小さい増減は、丸めた誤差などとみなす） */
export const MIN_FLIP_MW = 20;

/**
 * 区切りの量（0 未満は 0 とみなす）の増減を、入れ子のブロックに分ける。量が増えたら新しいブロックを始め、減ったら新しく始めたものから終える。
 * 分け方は 1 つに決まらないが、ブロックの数ができるだけ少なくなる分け方の 1 つ（量が増えた回数だけ）
 */
export function flipBlocks(plateaus: readonly FlipPlateau[], minMw = MIN_FLIP_MW): FlipBlock[] {
  const out: FlipBlock[] = [];
  const open: { from: number; mw: number }[] = [];
  let level = 0;
  const close = (to: number, drop: number) => {
    while (drop > 0.05 && open.length > 0) {
      const top = open[open.length - 1];
      if (top.mw <= drop + 0.05) {
        out.push({ from: top.from, to, mw: top.mw });
        drop -= top.mw;
        open.pop();
      } else {
        out.push({ from: top.from, to, mw: drop });
        top.mw -= drop;
        drop = 0;
      }
    }
  };
  for (const p of plateaus) {
    const v = Math.max(0, p.mw);
    if (v > level) open.push({ from: p.from, mw: v - level });
    else if (v < level) close(p.from, level - v);
    level = v;
  }
  close(plateaus.length > 0 ? plateaus[plateaus.length - 1].to : 0, level);
  return out.filter((b) => b.mw >= minMw).sort((a, b) => a.from - b.from || b.to - a.to);
}
