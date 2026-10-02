/**
 * JEPX スポット市場の入札カーブ（需給曲線）。取得スクリプトとブラウザの両方で使う。
 *
 * JEPX の入札カーブのページが読み込んでいる、受渡日ごとの CSV:
 *   spot_bid_curves_YYYYMMDD.csv       電力受渡日, 商品コード, 入札価格(円/kWh), 売入札量累積(MW), 買入札量累積(MW), 分断エリア連番
 *   spot_splitting_areas_YYYYMMDD.csv  電力受渡日, 商品コード, エリアグループ, 分断エリア連番
 * 商品コード 1〜48 は 30 分のコマ。分断エリア連番が空の行はシステムプライスの入札カーブ、数字の行は
 * 市場分断したときのエリアグループ（名前は splitting_areas で分かる）の入札カーブ。
 * 手元で保存した CSV には、システムプライスの分断エリア連番を -1 にしたものもあるので、-1 もシステムプライスとして読む。
 *
 * 画面では、描画用に間引いたカーブ（1 日 1 ファイル）と、間引く前のカーブから計算した指標（年度ごと）を使う。
 */
import { parseCsv, toCsv } from './csv';
import { isoFromDay, parseDateString } from './dates';
import { normalizeHeader, parseNumber, parseSlot } from './jepxCsv';
import { AREAS, SENSITIVITY_SIZES, SLOTS, type AreaKey, type SensitivitySize } from './series';

/** システムプライスの入札カーブのグループ番号（CSV では分断エリア連番が空か -1） */
export const SYSTEM_GROUP = -1;

/** 入札カーブの 1 点。売り・買いの量は、その価格まで（売り）・その価格以上（買い）の累積（MW） */
export interface CurveRow {
  price: number;
  sell: number;
  buy: number;
}

/** 1 日分の生のカーブ。コマごとに、グループ番号 → 価格の昇順の点 */
export interface RawCurveDay {
  day: number;
  slots: Map<number, CurveRow[]>[];
}

export interface AreaGroup {
  id: number;
  label: string;
  areas: AreaKey[];
}

export class BidCurveCsvError extends Error {}

type Matcher = (h: string) => boolean;
const find = (headers: string[], test: Matcher) => headers.findIndex(test);

function headerRow(rows: string[][], required: Matcher[]): number {
  return rows.slice(0, 10).findIndex((r) => {
    const hs = r.map(normalizeHeader);
    return required.every((t) => hs.some(t));
  });
}

const isDate: Matcher = (h) => h.includes('受渡日');
const isSlot: Matcher = (h) => h.includes('商品コード') || h.includes('時刻コード');
const isGroup: Matcher = (h) => h.includes('分断エリア');
const isPrice: Matcher = (h) => h.includes('入札価格');
const isSell: Matcher = (h) => /売り?入札量/.test(h);
const isBuy: Matcher = (h) => /買い?入札量/.test(h);
const isLabel: Matcher = (h) => h.includes('エリアグループ');
const BID_COLUMNS = [isDate, isSlot, isPrice, isSell, isBuy];
const SPLIT_COLUMNS = [isDate, isSlot, isLabel, isGroup];

export type CurveCsvKind = 'bidCurves' | 'splittingAreas';

/** 入札カーブ・分断エリアの CSV かどうかを列名で見分ける（どちらでもなければ null） */
export function curveCsvKind(text: string): CurveCsvKind | null {
  // 列名の行は先頭にあるので、先頭の数行だけを見る
  const rows = parseCsv(text.split(/\r?\n/, 12).join('\n'));
  if (headerRow(rows, BID_COLUMNS) >= 0) return 'bidCurves';
  if (headerRow(rows, SPLIT_COLUMNS) >= 0) return 'splittingAreas';
  return null;
}

/**
 * 分断エリア連番の値からグループ番号を読む。空（JEPX の形式）と -1 はシステムプライス。番号でなければ null。
 * 表計算ソフトなどで保存し直した CSV の -1.0・0.0 のような小数の形も読む
 */
function parseGroupId(cell: string | undefined): number | null {
  const s = (cell ?? '').normalize('NFKC').trim();
  if (s === '') return SYSTEM_GROUP;
  const id = Number(s);
  if (id === SYSTEM_GROUP) return SYSTEM_GROUP;
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/** 入札カーブの CSV を受渡日ごとに読む（通常は 1 ファイル 1 日） */
export function parseBidCurveCsv(text: string): Map<number, RawCurveDay> {
  const rows = parseCsv(text);
  const hi = headerRow(rows, BID_COLUMNS);
  if (hi < 0) throw new BidCurveCsvError('入札カーブの CSV ではありません（入札価格・売入札量累積・買入札量累積の列が見つかりません）');
  const hs = rows[hi].map(normalizeHeader);
  const col = { date: find(hs, isDate), slot: find(hs, isSlot), price: find(hs, isPrice), sell: find(hs, isSell), buy: find(hs, isBuy), group: find(hs, isGroup) };

  const out = new Map<number, RawCurveDay>();
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < 3 || row.every((c) => c.trim() === '')) continue;
    const day = parseDateString(row[col.date] ?? '');
    const slot = parseSlot(row[col.slot] ?? '');
    const price = parseNumber(row[col.price]);
    if (day === null || slot === null || Number.isNaN(price)) continue;
    const group = col.group >= 0 ? parseGroupId(row[col.group]) : SYSTEM_GROUP;
    if (group === null) continue;
    let d = out.get(day);
    if (!d) {
      d = { day, slots: Array.from({ length: SLOTS }, () => new Map()) };
      out.set(day, d);
    }
    let curve = d.slots[slot].get(group);
    if (!curve) {
      curve = [];
      d.slots[slot].set(group, curve);
    }
    curve.push({ price, sell: nz(parseNumber(row[col.sell])), buy: nz(parseNumber(row[col.buy])) });
  }
  // 価格の昇順（同じ価格の点は CSV の順のまま）
  for (const d of out.values()) for (const m of d.slots) for (const c of m.values()) c.sort((a, b) => a.price - b.price);
  return out;
}

const nz = (v: number) => (Number.isNaN(v) ? 0 : v);

const AREA_BY_LABEL = new Map<string, AreaKey>(AREAS.map((a) => [a.label, a.key]));

/** エリアグループの名前（東北・東京・中部 など）をエリアに分ける */
export function parseAreaGroupLabel(label: string): AreaKey[] {
  return label
    .split(/[・,、/]/)
    .map((s) => AREA_BY_LABEL.get(s.normalize('NFKC').trim()))
    .filter((k): k is AreaKey => k !== undefined);
}

/** 分断エリアの CSV を読む。受渡日 → コマごとのエリアグループ（システムプライスの行は除く） */
export function parseSplittingAreasCsv(text: string): Map<number, AreaGroup[][]> {
  const rows = parseCsv(text);
  const hi = headerRow(rows, SPLIT_COLUMNS);
  if (hi < 0) throw new BidCurveCsvError('分断エリアの CSV ではありません（エリアグループ・分断エリア連番の列が見つかりません）');
  const hs = rows[hi].map(normalizeHeader);
  const col = { date: find(hs, isDate), slot: find(hs, isSlot), label: find(hs, isLabel), group: find(hs, isGroup) };
  const out = new Map<number, AreaGroup[][]>();
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    const day = parseDateString(row[col.date] ?? '');
    const slot = parseSlot(row[col.slot] ?? '');
    const id = parseGroupId(row[col.group]);
    if (day === null || slot === null || id === null || id === SYSTEM_GROUP) continue;
    let d = out.get(day);
    if (!d) {
      d = Array.from({ length: SLOTS }, () => []);
      out.set(day, d);
    }
    const label = (row[col.label] ?? '').trim();
    d[slot].push({ id, label, areas: parseAreaGroupLabel(label) });
  }
  return out;
}

// ---- 指標（間引く前のカーブから計算する） ----

export const CURVE_METRICS = [
  { key: 'sell001', label: '0.01円以下の売り入札', unit: 'MW' },
  { key: 'sell5', label: '5円以下の売り入札', unit: 'MW' },
  { key: 'sell10', label: '10円以下の売り入札', unit: 'MW' },
  { key: 'sell20', label: '20円以下の売り入札', unit: 'MW' },
  { key: 'sell50', label: '50円以下の売り入札', unit: 'MW' },
  { key: 'sellTotal', label: '売り入札の合計', unit: 'MW' },
  { key: 'buy10', label: '10円以上の買い入札', unit: 'MW' },
  { key: 'buy20', label: '20円以上の買い入札', unit: 'MW' },
  { key: 'buy50', label: '50円以上の買い入札', unit: 'MW' },
  { key: 'buyTop', label: '最も高い価格の買い入札', unit: 'MW' },
  { key: 'buyTotal', label: '買い入札の合計', unit: 'MW' },
  { key: 'clearPrice', label: 'カーブの交点の価格', unit: '円/kWh' },
  { key: 'clearVolume', label: 'カーブの交点の量', unit: 'MW' },
  { key: 'upPrice', label: '買いが 1GW 増えたときの価格上昇（目安）', unit: '円/kWh' },
  { key: 'downPrice', label: '買いが 1GW 減ったときの価格下落（目安）', unit: '円/kWh' },
] as const;

export type CurveMetricKey = (typeof CURVE_METRICS)[number]['key'];

/** 入札カーブのヒートマップで、指標と取引結果から求めて見るもの（0.01 円・高騰までの買いの増減と、価格感応度の公表値） */
export type CurveHeatExtraKey = 'floorShift' | 'spike20Shift' | 'spike50Shift' | `pubUp${SensitivitySize}` | `pubDown${SensitivitySize}`;
export type CurveHeatKey = CurveMetricKey | CurveHeatExtraKey;
export const CURVE_HEAT_EXTRAS: { key: CurveHeatExtraKey; label: string }[] = [
  { key: 'floorShift', label: '0.01 円になる買いの増減（0.01 円以下の売り − 買いの合計）' },
  { key: 'spike20Shift', label: '20 円を超える買いの増減（20 円以下の売り − 20 円以上の買い）' },
  { key: 'spike50Shift', label: '50 円を超える買いの増減（50 円以下の売り − 50 円以上の買い）' },
  ...SENSITIVITY_SIZES.flatMap((mw): { key: CurveHeatExtraKey; label: string }[] => [
    { key: `pubUp${mw}`, label: `JEPX の公表値: 買い +${mw / 1000}GW の上昇幅` },
    { key: `pubDown${mw}`, label: `JEPX の公表値: 買い −${mw / 1000}GW の下落幅` },
  ]),
];
export const CURVE_HEAT_KEYS: CurveHeatKey[] = [...CURVE_METRICS.map((m) => m.key), ...CURVE_HEAT_EXTRAS.map((m) => m.key)];
export const CURVE_METRIC_KEYS: CurveMetricKey[] = CURVE_METRICS.map((m) => m.key);
export const CURVE_METRIC_COUNT = CURVE_METRICS.length;
export const CURVE_METRIC_INDEX = Object.fromEntries(CURVE_METRIC_KEYS.map((k, i) => [k, i])) as Record<CurveMetricKey, number>;
export const CURVE_METRIC_LABEL = Object.fromEntries(CURVE_METRICS.map((m) => [m.key, m.label])) as Record<CurveMetricKey, string>;

/** 価格の比較の誤差（価格は 0.01 円単位） */
const EPS = 1e-6;
/** 価格感応度を見るときの買いの増減（MW） */
export const SENSITIVITY_MW = 1000;

/** その価格までの売り入札量（累積） */
export function sellAtOrBelow(rows: CurveRow[], price: number): number {
  let v = 0;
  for (const r of rows) {
    if (r.price > price + EPS) break;
    v = Math.max(v, r.sell);
  }
  return v;
}

/** その価格以上の買い入札量（累積。同じ価格の点が複数あるときは大きい方） */
export function buyAtOrAbove(rows: CurveRow[], price: number): number {
  const i = rows.findIndex((r) => r.price >= price - EPS);
  if (i < 0) return 0;
  let v = rows[i].buy;
  for (let j = i + 1; j < rows.length && rows[j].price <= rows[i].price + EPS; j++) v = Math.max(v, rows[j].buy);
  return v;
}

/**
 * 売りと買いのカーブの交点。shift だけ買いを増やした（負なら減らした）ときの交点も求められる。
 * 売りの累積が買いの累積以上になる最初の点 k で、
 * - 買いの累積が 1 つ前の点の売りの累積以上なら、k の価格の売りの段で交わる（価格 = k の価格、量 = 買いの累積）
 * - そうでなければ、1 つ前の点の価格の買いの段で交わる（価格 = 1 つ前の点の価格、量 = 1 つ前の売りの累積）
 */
export function crossing(rows: CurveRow[], shift = 0): { price: number; volume: number } | null {
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k];
    const demand = Math.max(0, r.buy + shift);
    if (r.sell < demand) continue;
    const prev = k > 0 ? rows[k - 1] : null;
    if (prev && demand < prev.sell) return { price: prev.price, volume: prev.sell };
    return { price: r.price, volume: demand };
  }
  return null;
}

/** 1 コマ・1 グループのカーブから指標を計算する（CURVE_METRICS の順） */
export function curveMetrics(rows: CurveRow[]): number[] {
  if (rows.length === 0) return CURVE_METRIC_KEYS.map(() => Number.NaN);
  const last = rows[rows.length - 1];
  const c = crossing(rows);
  const up = c ? crossing(rows, SENSITIVITY_MW) : null;
  const down = c ? crossing(rows, -SENSITIVITY_MW) : null;
  const values: Record<CurveMetricKey, number> = {
    sell001: sellAtOrBelow(rows, 0.01),
    sell5: sellAtOrBelow(rows, 5),
    sell10: sellAtOrBelow(rows, 10),
    sell20: sellAtOrBelow(rows, 20),
    sell50: sellAtOrBelow(rows, 50),
    sellTotal: rows.reduce((m, r) => Math.max(m, r.sell), 0),
    buy10: buyAtOrAbove(rows, 10),
    buy20: buyAtOrAbove(rows, 20),
    buy50: buyAtOrAbove(rows, 50),
    buyTop: last.buy,
    buyTotal: rows.reduce((m, r) => Math.max(m, r.buy), 0),
    clearPrice: c ? c.price : Number.NaN,
    clearVolume: c ? c.volume : Number.NaN,
    upPrice: c && up ? up.price - c.price : Number.NaN,
    downPrice: c && down ? c.price - down.price : Number.NaN,
  };
  return CURVE_METRIC_KEYS.map((k) => values[k]);
}

// ---- 描画用に間引いたカーブ ----

/**
 * 階段状のカーブ。売りは価格の昇順、買いは価格の降順に [価格, 累積量, 価格, 累積量, …]。
 * 各点は「その価格で累積量がその値になる」ことを表す。
 */
export interface SteppedCurve {
  sell: number[];
  buy: number[];
}

/** 間引くときの量の許容差: 売り・買いそれぞれの合計量に対するこの割合 */
export const SIMPLIFY_RATIO = 0.001;

/**
 * 描画用にカーブを間引く。量の増え方が許容差未満の段は次の段にまとめる（量は 1MW 単位、価格は 0.01 円単位に丸める）。
 * 許容差は、省略時は売り・買いそれぞれの合計量の SIMPLIFY_RATIO（1MW 以上）。グラフの横軸はカーブの合計量に合わせるので、
 * 全国のカーブでも小さな分断エリアのカーブでも 1 画素より細かい段だけを省くことになり、見た目は変わらない。
 * 各側の段の数は多くても 1 / SIMPLIFY_RATIO 個ほどになる。
 */
export function simplifyCurve(rows: CurveRow[], tol?: number): SteppedCurve {
  const total = (k: 'sell' | 'buy') => rows.reduce((m, r) => Math.max(m, r[k]), 0);
  const sellTol = tol ?? Math.max(1, total('sell') * SIMPLIFY_RATIO);
  const buyTol = tol ?? Math.max(1, total('buy') * SIMPLIFY_RATIO);
  const sell: number[] = [];
  let kept = 0;
  let pending = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const v = Math.round(r.sell);
    if (v > kept) pending = true;
    if (pending && (v - kept >= sellTol || i === rows.length - 1)) {
      sell.push(round2(r.price), v);
      kept = v;
      pending = false;
    }
  }
  const buy: number[] = [];
  kept = 0;
  pending = false;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const v = Math.round(r.buy);
    if (v > kept) pending = true;
    if (pending && (v - kept >= buyTol || i === 0)) {
      buy.push(round2(r.price), v);
      kept = v;
      pending = false;
    }
  }
  return { sell, buy };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 階段状のカーブを折れ線の頂点にする（横軸 = 累積量、縦軸 = 価格）。
 * 売り: (0, p0) → (v0, p0) → (v0, p1) → (v1, p1) …　買い: (0, 最高価格) → (w0, 最高価格) → (w0, 次の価格) …
 */
export function stepPath(points: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  let prevV = 0;
  for (let i = 0; i < points.length; i += 2) {
    const p = points[i];
    const v = points[i + 1];
    out.push([prevV, p], [v, p]);
    prevV = v;
  }
  return out;
}

/** 階段状の売りのカーブで、累積量 v を満たす価格（足りなければ NaN） */
export function sellPriceAt(sell: ArrayLike<number>, v: number): number {
  for (let i = 0; i < sell.length; i += 2) if (sell[i + 1] >= v) return sell[i];
  return Number.NaN;
}

/** 階段状の買いのカーブで、累積量 v まで買う人がいる最も高い価格（買いが足りなければ NaN） */
export function buyPriceAt(buy: ArrayLike<number>, v: number): number {
  for (let i = 0; i < buy.length; i += 2) if (buy[i + 1] >= v) return buy[i];
  return Number.NaN;
}

/** 階段状の売りのカーブで、価格 price 以下の売り入札量（累積） */
export function sellVolumeAt(sell: ArrayLike<number>, price: number): number {
  let v = 0;
  for (let i = 0; i < sell.length && sell[i] <= price + EPS; i += 2) v = sell[i + 1];
  return v;
}

/** 階段状の買いのカーブで、価格 price 以上の買い入札量（累積） */
export function buyVolumeAt(buy: ArrayLike<number>, price: number): number {
  let v = 0;
  for (let i = 0; i < buy.length && buy[i] >= price - EPS; i += 2) v = buy[i + 1];
  return v;
}

/** 階段状のカーブの価格の点（昇順・重複なし） */
export function stepPrices(...curves: ArrayLike<number>[]): number[] {
  const prices = new Set<number>();
  for (const c of curves) for (let i = 0; i < c.length; i += 2) prices.add(c[i]);
  return [...prices].sort((a, b) => a - b);
}

/** 昇順の価格ごとの、その価格以下の売り入札量（累積） */
export function sellVolumesAt(sell: ArrayLike<number>, prices: ArrayLike<number>): Float64Array {
  const out = new Float64Array(prices.length);
  let i = 0;
  let v = 0;
  for (let k = 0; k < prices.length; k++) {
    while (i < sell.length && sell[i] <= prices[k] + EPS) {
      v = sell[i + 1];
      i += 2;
    }
    out[k] = v;
  }
  return out;
}

/** 昇順の価格ごとの、その価格以上の買い入札量（累積） */
export function buyVolumesAt(buy: ArrayLike<number>, prices: ArrayLike<number>): Float64Array {
  const out = new Float64Array(prices.length);
  // 買いは価格の降順なので、後ろ（安い方）から見ていく
  let i = buy.length - 2;
  for (let k = 0; k < prices.length; k++) {
    while (i >= 0 && buy[i] < prices[k] - EPS) i -= 2;
    out[k] = i >= 0 ? buy[i + 1] : 0;
  }
  return out;
}

/** 階段状の売り・買いのカーブを、両方の価格の点をそろえた行に戻す（交点の計算・表示用の表） */
export function rowsFromSteps(sell: ArrayLike<number>, buy: ArrayLike<number>): CurveRow[] {
  const prices = stepPrices(sell, buy);
  const s = sellVolumesAt(sell, prices);
  const b = buyVolumesAt(buy, prices);
  return prices.map((price, k) => ({ price, sell: s[k], buy: b[k] }));
}

/** 階段状のカーブ（売りは価格の昇順、買いは降順に [価格, 累積量, …]） */
export interface StepCurve {
  sell: ArrayLike<number>;
  buy: ArrayLike<number>;
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

/**
 * 市場分断したコマの「システムプライスのカーブ − 公表されている分断エリアのカーブの合計」（単エリアのカーブの推定に使う）。
 * 描画用に間引いたカーブどうしの差では、間引いた分（各カーブの合計量の 0.1%。全国のカーブなら数十 MW）の誤差が残るので、
 * 間引く前のカーブから 1MW 単位で求め、この差の量に対して間引いて持つ。
 * 差は負にもなるので、累積の量として減らないようにならしてから、少ない方の端（最も安い売りか最も高い買い）が 0 になるよう
 * offset を足した階段状のカーブにする（両端の点は 0 でも持つ）
 */
export interface StepResidual {
  offset: number;
  sell: Float64Array;
  buy: Float64Array;
}

export function residualSteps(system: CurveRow[], parts: CurveRow[][]): { offset: number; sell: number[]; buy: number[] } {
  const exact = (rows: CurveRow[]) => simplifyCurve(rows, 0.5);
  const d = curveDifference(exact(system), parts.map(exact));
  const sell = Float64Array.from(d.sell);
  for (let k = 1; k < sell.length; k++) sell[k] = Math.max(sell[k], sell[k - 1]);
  const buy = Float64Array.from(d.buy);
  for (let k = buy.length - 2; k >= 0; k--) buy[k] = Math.max(buy[k], buy[k + 1]);
  const ends = [sell.length > 0 ? sell[0] : 0, buy.length > 0 ? buy[buy.length - 1] : 0];
  const offset = Math.max(0, Math.round(-Math.min(0, ...ends)));
  const side = (prices: number[], v: Float64Array, descending: boolean): number[] => {
    const n = prices.length;
    if (n === 0) return [];
    const tol = Math.max(1, Math.round(v[descending ? 0 : n - 1] + offset) * SIMPLIFY_RATIO);
    const out: number[] = [];
    let kept = -1;
    for (let i = 0; i < n; i++) {
      const k = descending ? n - 1 - i : i;
      const x = Math.round(v[k] + offset);
      if (kept < 0 || x - kept >= tol || (i === n - 1 && x > kept)) {
        out.push(round2(prices[k]), x);
        kept = x;
      }
    }
    return out;
  };
  return { offset, sell: side(d.sellPrices, sell, false), buy: side(d.buyPrices, buy, true) };
}

// ---- ファイル形式（public/data/curves） ----

export const CURVE_DAY_FORMAT = 'jepx-viewer/curve-day@1';
export const CURVE_METRICS_FORMAT = 'jepx-viewer/curve-metrics@1';

/**
 * 1 日分のファイル（curves/YYYY/YYYYMMDD.json）。
 * カーブは差分で持つ: 売り [価格(銭), 量(MW), 価格の増分, 量の増分, …]、買い [価格(銭), 量, 価格の減分, 量の増分, …]
 */
export interface CurveDayFile {
  format: typeof CURVE_DAY_FORMAT;
  date: string;
  /**
   * 48 コマ（データの無いコマは null）。groups の先頭はシステムプライス。
   * residual は市場分断したコマの「システムプライス − 分断エリアの合計」（StepResidual。前の版のファイルには無い）。
   * totals は市場分断したコマの、公表されている分断エリアのカーブの入札量の合計 [売り, 買い]（MW。間引く前のカーブから。前の版のファイルには無い）
   */
  slots: ({ groups: AreaGroup[]; sell: number[][]; buy: number[][]; residual?: { offset: number; sell: number[]; buy: number[] }; totals?: [number, number] } | null)[];
  /** システムプライスのカーブの指標（CURVE_METRICS の順、各 48 コマ、欠損は null） */
  metrics: Record<CurveMetricKey, (number | null)[]>;
  /**
   * ブロック入札の約定の変化の推定に使う、公表値の計算で効かなかった量の範囲（sensitivity.ts の absorbedOfDay）。
   * 48 コマ、各コマ FLIP_CASES の順に [最小, 最大]（MW。最小が分からなければ null、最大が無限なら null）。
   * 間引く前のカーブと公表値から求めるので、取得したときに公表値が無かった日と、前の版のファイルには無い
   */
  absorbed?: ((number | null)[] | null)[];
}

/** 指標の年度ファイル（curves/fyYYYY.json）。series は「日数 × 48 コマ」 */
export interface CurveMetricsFile {
  format: typeof CURVE_METRICS_FORMAT;
  fy: number;
  firstDate: string;
  days: number;
  metrics: Record<CurveMetricKey, (number | null)[]>;
  /** 作った版（CURVE_METRICS_REV。前の版のファイルには無い） */
  rev?: number;
  /**
   * 日のファイルの absorbed（ブロック入札の約定の変化の推定に使う値）を並べたもの。ABSORBED_WIDTH 本、各「日数 × 48 コマ」（無い値は null）。
   * どの日にも無ければ無い
   */
  absorbed?: (number | null)[][];
  /**
   * 市場分断したコマの、公表されている分断エリアのカーブの入札量の合計と数（groupTotalsOfDay）。GROUP_TOTALS_WIDTH 本、各「日数 × 48 コマ」
   * （分断していないコマは null）。どの日にも無ければ無い
   */
  groups?: (number | null)[][];
}

/**
 * 指標の年度ファイルの版（2: 日のファイルの absorbed も入れる。3: 分断エリアのカーブの入札量の合計 groups も入れる）。
 * これより前の版のファイルは作り直す
 */
export const CURVE_METRICS_REV = 3;
/** 日のファイルの absorbed の、1 コマの値の数（sensitivity.ts の FLIP_CASES の数 × [最小, 最大]） */
export const ABSORBED_WIDTH = 12;

/** 画面で使う 1 コマ・1 グループのカーブ */
export interface CurveGroup extends AreaGroup {
  sell: Float64Array;
  buy: Float64Array;
}

export interface CurveDay {
  day: number;
  /** 48 コマ。先頭はシステムプライス */
  slots: (CurveGroup[] | null)[];
  /** 48 コマの「システムプライス − 分断エリアの合計」（間引く前のカーブから。市場分断していないコマと、前の版のファイルでは null） */
  residuals?: (StepResidual | null)[];
  /** 48 コマの、公表値の計算で効かなかった量の範囲（CurveDayFile.absorbed。分からない最小は NaN、無限の最大は Infinity） */
  absorbed?: (Float64Array | null)[];
  /** 48 コマの、分断エリアのカーブの入札量の合計 [売り, 買い]（CurveDayFile の totals。分断していないコマと、前の版のファイルでは null） */
  groupTotals?: ([number, number] | null)[];
}

export const SYSTEM_LABEL = 'システムプライス';
const ALL_AREAS = AREAS.map((a) => a.key);

export function curveDayFile(day: number): string {
  const iso = isoFromDay(day);
  return `curves/${iso.slice(0, 4)}/${iso.replace(/-/g, '')}.json`;
}

export function curveMetricsFile(fy: number): string {
  return `curves/fy${fy}.json`;
}

function encodeSteps(points: number[], descending: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const p = Math.round(points[i] * 100);
    const v = points[i + 1];
    if (i === 0) out.push(p, v);
    else {
      const dp = p - Math.round(points[i - 2] * 100);
      out.push(descending ? -dp : dp, v - points[i - 1]);
    }
  }
  return out;
}

function decodeSteps(enc: number[], descending: boolean): Float64Array {
  const out = new Float64Array(enc.length);
  let p = 0;
  let v = 0;
  for (let i = 0; i < enc.length; i += 2) {
    if (i === 0) {
      p = enc[0];
      v = enc[1];
    } else {
      p += descending ? -enc[i] : enc[i];
      v += enc[i + 1];
    }
    out[i] = p / 100;
    out[i + 1] = v;
  }
  return out;
}

const toNullable = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** 生のカーブ（と分断エリアの名前）から 1 日分のファイルを作る */
export function encodeCurveDay(raw: RawCurveDay, groups?: AreaGroup[][], tol?: number): CurveDayFile {
  const metrics = Object.fromEntries(CURVE_METRIC_KEYS.map((k) => [k, new Array<number | null>(SLOTS).fill(null)])) as CurveDayFile['metrics'];
  const slots: CurveDayFile['slots'] = raw.slots.map((m, s) => {
    const system = m.get(SYSTEM_GROUP);
    if (!system || system.length === 0) return null;
    curveMetrics(system).forEach((v, k) => (metrics[CURVE_METRIC_KEYS[k]][s] = toNullable(v)));
    const named = new Map((groups?.[s] ?? []).map((g) => [g.id, g]));
    const ids = [...m.keys()].filter((id) => id !== SYSTEM_GROUP).sort((a, b) => a - b);
    const gs: AreaGroup[] = [
      { id: SYSTEM_GROUP, label: SYSTEM_LABEL, areas: ALL_AREAS },
      ...ids.map((id) => named.get(id) ?? { id, label: `分断エリア ${id}`, areas: [] }),
    ];
    const curves = gs.map((g) => simplifyCurve(m.get(g.id)!, tol));
    const slot: NonNullable<CurveDayFile['slots'][number]> = { groups: gs, sell: curves.map((c) => encodeSteps(c.sell, false)), buy: curves.map((c) => encodeSteps(c.buy, true)) };
    if (ids.length > 0) {
      const r = residualSteps(system, ids.map((id) => m.get(id)!));
      slot.residual = { offset: r.offset, sell: encodeSteps(r.sell, false), buy: encodeSteps(r.buy, true) };
      slot.totals = rawGroupTotals(ids.map((id) => m.get(id)!));
    }
    return slot;
  });
  return { format: CURVE_DAY_FORMAT, date: isoFromDay(raw.day), slots, metrics };
}

/** 間引く前の分断エリアのカーブの入札量の合計 [売り, 買い]（0.1 MW 単位） */
function rawGroupTotals(parts: CurveRow[][]): [number, number] {
  const total = (rows: CurveRow[], k: 'sell' | 'buy') => rows.reduce((m, r) => Math.max(m, r[k]), 0);
  const sum = (k: 'sell' | 'buy') => Math.round(parts.reduce((v, rows) => v + total(rows, k), 0) * 10) / 10;
  return [sum('sell'), sum('buy')];
}

/**
 * 変換済みの 1 日分のファイルの、市場分断したコマに、間引く前のカーブから求めた分断エリアのカーブの入札量の合計（totals）を足す
 * （前の版で保存したファイルの入札カーブを取り直したとき）。足したコマがあれば true
 */
export function addGroupTotals(file: CurveDayFile, raw: RawCurveDay): boolean {
  let changed = false;
  file.slots.forEach((slot, s) => {
    if (!slot || slot.totals) return;
    const m = raw.slots[s];
    const ids = [...m.keys()].filter((id) => id !== SYSTEM_GROUP);
    if (ids.length === 0 || !slot.groups.some((g) => g.id !== SYSTEM_GROUP)) return;
    slot.totals = rawGroupTotals(ids.map((id) => m.get(id)!));
    changed = true;
  });
  return changed;
}

/**
 * 変換済みの 1 日分のファイルに、分断エリアの名前を付け直す（入札カーブと分断エリアの CSV を別々に変換したとき）。
 * 名前が変わったグループがあれば true
 */
export function applyGroupNames(file: CurveDayFile, groups: AreaGroup[][]): boolean {
  let changed = false;
  file.slots.forEach((slot, s) => {
    if (!slot) return;
    const named = new Map((groups[s] ?? []).map((g) => [g.id, g]));
    slot.groups = slot.groups.map((g) => {
      const n = g.id === SYSTEM_GROUP ? undefined : named.get(g.id);
      if (!n || (n.label === g.label && n.areas.join() === g.areas.join())) return g;
      changed = true;
      return { id: g.id, label: n.label, areas: n.areas };
    });
  });
  return changed;
}

export function decodeCurveDay(json: unknown): CurveDay {
  const file = json as CurveDayFile;
  if (!file || file.format !== CURVE_DAY_FORMAT || !Array.isArray(file.slots)) throw new Error('入札カーブのファイルの形式が不正です');
  const day = parseDateString(file.date);
  if (day === null) throw new Error('入札カーブのファイルの日付が不正です');
  return {
    day,
    slots: Array.from({ length: SLOTS }, (_, s) => {
      const f = file.slots[s];
      if (!f) return null;
      return f.groups.map((g, k) => ({ ...g, sell: decodeSteps(f.sell[k] ?? [], false), buy: decodeSteps(f.buy[k] ?? [], true) }));
    }),
    residuals: Array.from({ length: SLOTS }, (_, s) => {
      const r = file.slots[s]?.residual;
      return r ? { offset: r.offset, sell: decodeSteps(r.sell, false), buy: decodeSteps(r.buy, true) } : null;
    }),
    ...(file.absorbed ? { absorbed: Array.from({ length: SLOTS }, (_, s) => decodeAbsorbed(file.absorbed![s])) } : {}),
    groupTotals: Array.from({ length: SLOTS }, (_, s) => file.slots[s]?.totals ?? null),
  };
}

/** groupTotalsOfDay の 1 コマの値の数（売り, 買い, 分断エリアの数） */
export const GROUP_TOTALS_WIDTH = 3;

/** 公表されている分断エリアのカーブの入札量の合計（MW）と、分断エリアの数 */
export interface GroupTotals {
  sell: number;
  buy: number;
  count: number;
  /** 間引く前のカーブから求めた値か（前の版のファイルでは、1 MW 単位に丸めた描画用のカーブの合計） */
  exact: boolean;
}

/** そのコマの、公表されている分断エリアのカーブの入札量の合計と数（市場分断していなければ null） */
export function groupTotalsOf(day: CurveDay, slot: number): GroupTotals | null {
  const parts = (day.slots[slot] ?? []).filter((g) => g.id !== SYSTEM_GROUP);
  if (parts.length === 0) return null;
  const exact = day.groupTotals?.[slot];
  if (exact) return { sell: exact[0], buy: exact[1], count: parts.length, exact: true };
  const last = (a: Float64Array) => (a.length >= 2 ? a[a.length - 1] : 0);
  return { sell: parts.reduce((v, g) => v + last(g.sell), 0), buy: parts.reduce((v, g) => v + last(g.buy), 0), count: parts.length, exact: false };
}

/** 1 日分の groupTotalsOf（GROUP_TOTALS_WIDTH × 48 の並び。市場分断していないコマは NaN） */
export function groupTotalsOfDay(day: CurveDay): Float64Array {
  const out = new Float64Array(GROUP_TOTALS_WIDTH * SLOTS).fill(Number.NaN);
  for (let s = 0; s < SLOTS; s++) {
    const g = groupTotalsOf(day, s);
    if (!g) continue;
    out[s] = g.sell;
    out[SLOTS + s] = g.buy;
    out[2 * SLOTS + s] = g.count;
  }
  return out;
}

/** 1 コマの absorbed の値（最小が分からない組は最大も分からない。最小が分かって最大が null なら無限。すべて無ければ null） */
export function decodeAbsorbed(a: readonly (number | null)[] | null | undefined): Float64Array | null {
  if (!a || !a.some((v) => v !== null)) return null;
  return Float64Array.from(a, (v, i) => (v !== null ? v : i % 2 === 1 && a[i - 1] !== null ? Number.POSITIVE_INFINITY : Number.NaN));
}

/** 日 → 指標（CURVE_METRIC_COUNT × 48、欠損は NaN） */
export type CurveMetricDays = Map<number, Float64Array>;

export function newMetricValues(): Float64Array {
  return new Float64Array(CURVE_METRIC_COUNT * SLOTS).fill(Number.NaN);
}

/** 1 日分のファイルに入っている指標 */
export function metricsOfDayFile(file: CurveDayFile): Float64Array {
  const out = newMetricValues();
  CURVE_METRIC_KEYS.forEach((k, m) => {
    const arr = file.metrics?.[k] ?? [];
    for (let s = 0; s < SLOTS; s++) {
      const v = arr[s];
      if (typeof v === 'number') out[m * SLOTS + s] = v;
    }
  });
  return out;
}

/**
 * @param absorbed 日のファイルの absorbed（無い日は入れない）
 * @param groups 日ごとの groupTotalsOfDay（無い日は入れない）
 */
export function encodeCurveMetrics(
  fy: number,
  days: CurveMetricDays,
  absorbed?: ReadonlyMap<number, CurveDayFile['absorbed']>,
  groups?: ReadonlyMap<number, Float64Array>,
): CurveMetricsFile {
  const keys = [...days.keys()].sort((a, b) => a - b);
  const first = keys[0];
  const n = keys[keys.length - 1] - first + 1;
  const metrics = Object.fromEntries(CURVE_METRIC_KEYS.map((k) => [k, new Array<number | null>(n * SLOTS).fill(null)])) as CurveMetricsFile['metrics'];
  for (const [day, vals] of days) {
    const off = (day - first) * SLOTS;
    CURVE_METRIC_KEYS.forEach((k, m) => {
      for (let s = 0; s < SLOTS; s++) metrics[k][off + s] = toNullable(vals[m * SLOTS + s]);
    });
  }
  const file: CurveMetricsFile = { format: CURVE_METRICS_FORMAT, fy, firstDate: isoFromDay(first), days: n, metrics, rev: CURVE_METRICS_REV };
  const withAbsorbed = [...(absorbed?.entries() ?? [])].filter(
    (e): e is [number, NonNullable<CurveDayFile['absorbed']>] => !!e[1] && e[0] >= first && e[0] < first + n,
  );
  if (withAbsorbed.length > 0) {
    const out = Array.from({ length: ABSORBED_WIDTH }, () => new Array<number | null>(n * SLOTS).fill(null));
    for (const [day, a] of withAbsorbed) {
      a.forEach((vals, s) => {
        if (vals) vals.forEach((v, j) => (out[j][(day - first) * SLOTS + s] = v));
      });
    }
    file.absorbed = out;
  }
  const withGroups = [...(groups?.entries() ?? [])].filter(([day, g]) => day >= first && day < first + n && g.some(Number.isFinite));
  if (withGroups.length > 0) {
    const out = Array.from({ length: GROUP_TOTALS_WIDTH }, () => new Array<number | null>(n * SLOTS).fill(null));
    for (const [day, g] of withGroups) {
      for (let j = 0; j < GROUP_TOTALS_WIDTH; j++) {
        for (let s = 0; s < SLOTS; s++) out[j][(day - first) * SLOTS + s] = toNullable(g[j * SLOTS + s]);
      }
    }
    file.groups = out;
  }
  return file;
}

/** 指標の年度ファイルの groups を、日ごと（GROUP_TOTALS_WIDTH × 48、分断していないコマは NaN）に読む。無い日は入れない */
export function decodeCurveGroups(json: unknown): Map<number, Float64Array> {
  const file = json as CurveMetricsFile;
  const out = new Map<number, Float64Array>();
  const first = parseDateString(file?.firstDate ?? '');
  if (!file?.groups || first === null) return out;
  for (let i = 0; i < file.days; i++) {
    const g = new Float64Array(GROUP_TOTALS_WIDTH * SLOTS).fill(Number.NaN);
    let any = false;
    for (let j = 0; j < GROUP_TOTALS_WIDTH; j++) {
      for (let s = 0; s < SLOTS; s++) {
        const v = file.groups[j]?.[i * SLOTS + s];
        if (typeof v === 'number') {
          g[j * SLOTS + s] = v;
          any = true;
        }
      }
    }
    if (any) out.set(first + i, g);
  }
  return out;
}

/** 指標の年度ファイルの absorbed を、日ごと（48 コマ、各コマ ABSORBED_WIDTH 個か null）に読む。無い日は入れない */
export function decodeCurveAbsorbed(json: unknown): Map<number, (Float64Array | null)[]> {
  const file = json as CurveMetricsFile;
  const out = new Map<number, (Float64Array | null)[]>();
  const first = parseDateString(file?.firstDate ?? '');
  if (!file?.absorbed || first === null) return out;
  for (let i = 0; i < file.days; i++) {
    const slots = Array.from({ length: SLOTS }, (_, s) => decodeAbsorbed(file.absorbed!.map((arr) => arr[i * SLOTS + s] ?? null)));
    if (slots.some(Boolean)) out.set(first + i, slots);
  }
  return out;
}

export function decodeCurveMetrics(json: unknown): CurveMetricDays {
  const file = json as CurveMetricsFile;
  if (!file || file.format !== CURVE_METRICS_FORMAT) throw new Error('入札カーブの指標ファイルの形式が不正です');
  const first = parseDateString(file.firstDate);
  if (first === null) throw new Error('入札カーブの指標ファイルの firstDate が不正です');
  const out: CurveMetricDays = new Map();
  for (let i = 0; i < file.days; i++) {
    const vals = newMetricValues();
    let any = false;
    CURVE_METRIC_KEYS.forEach((k, m) => {
      const arr = file.metrics[k];
      if (!arr) return;
      for (let s = 0; s < SLOTS; s++) {
        const v = arr[i * SLOTS + s];
        if (typeof v === 'number') {
          vals[m * SLOTS + s] = v;
          any = true;
        }
      }
    });
    if (any) out.set(first + i, vals);
  }
  return out;
}

// ---- JEPX と同じ形式の CSV（テスト・サンプル用） ----

const ymd8 = (day: number) => isoFromDay(day).replace(/-/g, '');

export function formatBidCurveCsv(raw: RawCurveDay): string {
  const rows: (string | number)[][] = [['電力受渡日', '商品コード', '入札価格(円/kWh)', '売入札量累積(MW)', '買入札量累積(MW)', '分断エリア連番']];
  raw.slots.forEach((m, s) => {
    const ids = [...m.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      for (const r of m.get(id)!) rows.push([ymd8(raw.day), s + 1, r.price.toFixed(2), r.sell.toFixed(1), r.buy.toFixed(1), id === SYSTEM_GROUP ? '' : id]);
    }
  });
  return toCsv(rows);
}

export function formatSplittingAreasCsv(day: number, groups: AreaGroup[][]): string {
  const rows: (string | number)[][] = [['電力受渡日', '商品コード', 'エリアグループ', '分断エリア連番']];
  groups.forEach((gs, s) => {
    rows.push([ymd8(day), s + 1, SYSTEM_LABEL, '']);
    for (const g of gs) rows.push([ymd8(day), s + 1, g.label, g.id]);
  });
  return toCsv(rows);
}
