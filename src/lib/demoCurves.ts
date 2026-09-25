/**
 * デモ・テスト用の合成の入札カーブ。
 *
 * 与えた価格（システムプライス・エリアプライス）と約定量の近くで売りと買いが交わるよう、JEPX に似た形の
 * カーブを擬似乱数で作る（昼は太陽光で 0.01 円以下の売りが増える、最も高い価格の買いが多い、など）。
 * 市場分断したコマは、価格の同じエリアのまとまりごとにカーブを作り、それらを足したものをシステムプライスのカーブにする。
 * JEPX と同じく、1 エリアだけのまとまり（単エリア）のカーブは出さない。
 * **実際の入札ではない**ため、画面上では常に「デモデータ」と明示する。
 */
import { SYSTEM_GROUP, type AreaGroup, type CurveRow, type RawCurveDay } from './bidCurves';
import { gaussian, mulberry32 } from './demo';
import { AREA_KEYS, SERIES_LABEL, SLOTS, type AreaKey } from './series';

/** 入札のある価格（円/kWh） */
const LEVELS: number[] = (() => {
  const out = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 1.5, 2, 2.5];
  for (let c = 300; c <= 3000; c += 25) out.push(c / 100);
  for (let p = 31; p <= 60; p++) out.push(p);
  for (let p = 65; p <= 100; p += 5) out.push(p);
  out.push(120, 150, 200, 300, 500, 999.99);
  return out;
})();

const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 1 本のカーブ。price・volume（MW）の近くで売りと買いが交わる。
 * @param solar 0〜1。大きいほど 0.01 円以下の売りが多い
 */
export function syntheticCurve(price: number, volume: number, solar: number, rand: () => number): CurveRow[] {
  const buyTotal = volume * (1.18 + 0.1 * rand());
  const buyTop = buyTotal * (0.6 + 0.1 * rand());
  const cd = 4 + 4 * rand();
  const demand = (p: number) => buyTop + (buyTotal - buyTop) * (cd / (p + cd));
  const sellTotal = buyTotal * (1.35 + 0.2 * rand());
  const floor = price <= 0.011;
  const target = demand(Math.max(price, 0.01));
  // 0.01 円以下の売り。最低価格で約定するコマは、これだけで買いを満たす
  const mustRun = floor ? target * (1.02 + 0.05 * rand()) : Math.min(target * 0.85, volume * (0.28 + 0.45 * solar) * (0.9 + 0.2 * rand()));
  const x = Math.min(0.999, Math.max(0.001, (target - mustRun) / (sellTotal - mustRun)));
  const lambda = floor ? 10 : price / Math.pow(-Math.log(1 - x), 1 / 1.5);
  const supply = (p: number) => (p < 0.01 ? mustRun * 0.45 : mustRun + (sellTotal - mustRun) * (1 - Math.exp(-Math.pow(p / lambda, 1.5))));

  const rows: CurveRow[] = [
    { price: 0, sell: 0, buy: round1(demand(0)) },
    { price: 0, sell: round1(supply(0)), buy: round1(demand(0)) },
  ];
  let sell = supply(0);
  let buy = demand(0);
  for (const p of LEVELS) {
    sell = Math.max(sell, supply(p) * (1 + 0.004 * gaussian(rand)));
    buy = Math.min(buy, demand(p) * (1 + 0.002 * gaussian(rand)));
    rows.push({ price: p, sell: round1(sell), buy: round1(buy) });
  }
  return rows;
}

export interface SlotTarget {
  /** システムプライス（円/kWh） */
  system: number;
  /** 約定量（MW） */
  volume: number;
  /** エリアプライス。価格の同じエリアを 1 つの分断エリアにまとめる（無いエリアはシステムプライス） */
  areas?: Partial<Record<AreaKey, number>>;
  /** areas が無いとき: 東（北海道・東北・東京）・西（それ以外）の価格 */
  east?: number;
  west?: number;
}

/** エリアの需要の割合の目安（分断エリアのカーブの量を分けるのに使う。合計 1） */
const AREA_SHARE: Record<AreaKey, number> = {
  hokkaido: 0.04,
  tohoku: 0.09,
  tokyo: 0.31,
  chubu: 0.14,
  hokuriku: 0.03,
  kansai: 0.16,
  chugoku: 0.07,
  shikoku: 0.04,
  kyushu: 0.12,
};
/** エリアの太陽光の多さの目安（西ほど多い） */
const AREA_SOLAR: Record<AreaKey, number> = {
  hokkaido: 0.5,
  tohoku: 0.7,
  tokyo: 0.6,
  chubu: 0.9,
  hokuriku: 0.6,
  kansai: 0.9,
  chugoku: 1.2,
  shikoku: 1.2,
  kyushu: 1.5,
};
const EAST_AREAS: readonly AreaKey[] = ['hokkaido', 'tohoku', 'tokyo'];
/**
 * 実データでは、システムプライスのカーブから分断エリアのカーブを引いた量が、単エリアの約定価格とずれることがある。
 * デモでも単エリアの補正を試せるよう、分断したコマのシステムプライスのカーブに、この割合の価格を問わない買いを足しておく
 */
const DEMO_MISMATCH = 0.015;

function areaPrices(t: SlotTarget): Record<AreaKey, number> | null {
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
  if (t.areas) return Object.fromEntries(AREA_KEYS.map((a) => [a, ok(t.areas![a]) ? t.areas![a] : t.system])) as Record<AreaKey, number>;
  if (ok(t.east) && ok(t.west)) return Object.fromEntries(AREA_KEYS.map((a) => [a, EAST_AREAS.includes(a) ? t.east : t.west])) as Record<AreaKey, number>;
  return null;
}

/** 価格の同じエリアのまとまり（エリアの並び順） */
function priceGroups(prices: Record<AreaKey, number>): { price: number; areas: AreaKey[] }[] {
  const out: { price: number; areas: AreaKey[] }[] = [];
  for (const a of AREA_KEYS) {
    const g = out.find((x) => Math.abs(x.price - prices[a]) < 0.005);
    if (g) g.areas.push(a);
    else out.push({ price: prices[a], areas: [a] });
  }
  return out;
}

/** 同じ価格の点を持つカーブを足す（syntheticCurve のカーブはどれも同じ価格の並び） */
function sumCurves(curves: CurveRow[][]): CurveRow[] {
  return curves[0].map((r, i) => ({
    price: r.price,
    sell: round1(curves.reduce((v, c) => v + c[i].sell, 0)),
    buy: round1(curves.reduce((v, c) => v + c[i].buy, 0)),
  }));
}

/** 1 日分（同じ日なら毎回同じカーブになる） */
export function syntheticCurveDay(day: number, targets: (SlotTarget | null)[]): { raw: RawCurveDay; groups: AreaGroup[][] } {
  const rand = mulberry32(day * 7919 + 13);
  const raw: RawCurveDay = { day, slots: Array.from({ length: SLOTS }, () => new Map()) };
  const groups: AreaGroup[][] = Array.from({ length: SLOTS }, () => []);
  targets.forEach((t, s) => {
    if (!t || !Number.isFinite(t.system) || !Number.isFinite(t.volume) || t.volume <= 0) return;
    const solar = Math.exp(-((s / 2 + 0.25 - 12.3) ** 2) / (2 * 2.2 ** 2));
    const prices = areaPrices(t);
    const parts = prices ? priceGroups(prices) : [];
    if (parts.length <= 1) {
      raw.slots[s].set(SYSTEM_GROUP, syntheticCurve(t.system, t.volume, solar, rand));
      return;
    }
    const curves = parts.map((g) => {
      const share = g.areas.reduce((v, a) => v + AREA_SHARE[a], 0);
      const sun = g.areas.reduce((v, a) => v + AREA_SOLAR[a] * AREA_SHARE[a], 0) / share;
      return syntheticCurve(g.price, t.volume * share, Math.min(1, solar * sun), rand);
    });
    const extra = t.volume * DEMO_MISMATCH;
    raw.slots[s].set(
      SYSTEM_GROUP,
      sumCurves(curves).map((r) => ({ ...r, buy: round1(r.buy + extra) })),
    );
    // 分断エリアの番号は単エリアにも振り、カーブと名前は 2 エリア以上のまとまりだけ出す（JEPX と同じく番号が飛ぶ）
    parts.forEach((g, id) => {
      if (g.areas.length < 2) return;
      raw.slots[s].set(id, curves[id]);
      groups[s].push({ id, label: g.areas.map((a) => SERIES_LABEL[a]).join('・'), areas: g.areas });
    });
  });
  return { raw, groups };
}
