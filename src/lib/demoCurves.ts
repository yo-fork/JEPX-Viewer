/**
 * デモ・テスト用の合成の入札カーブ。
 *
 * 与えた価格（システムプライス・東西のエリアプライス）と約定量の近くで売りと買いが交わるよう、JEPX に似た形の
 * カーブを擬似乱数で作る（昼は太陽光で 0.01 円以下の売りが増える、最も高い価格の買いが多い、など）。
 * **実際の入札ではない**ため、画面上では常に「デモデータ」と明示する。
 */
import { SYSTEM_GROUP, type AreaGroup, type CurveRow, type RawCurveDay } from './bidCurves';
import { gaussian, mulberry32 } from './demo';
import { SLOTS } from './series';

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
  /** 東西で分断したときの東・西の価格 */
  east?: number;
  west?: number;
}

const EAST: AreaGroup = { id: 0, label: '北海道・東北・東京', areas: ['hokkaido', 'tohoku', 'tokyo'] };
const WEST: AreaGroup = { id: 1, label: '中部・北陸・関西・中国・四国・九州', areas: ['chubu', 'hokuriku', 'kansai', 'chugoku', 'shikoku', 'kyushu'] };

/** 1 日分（同じ日なら毎回同じカーブになる） */
export function syntheticCurveDay(day: number, targets: (SlotTarget | null)[]): { raw: RawCurveDay; groups: AreaGroup[][] } {
  const rand = mulberry32(day * 7919 + 13);
  const raw: RawCurveDay = { day, slots: Array.from({ length: SLOTS }, () => new Map()) };
  const groups: AreaGroup[][] = Array.from({ length: SLOTS }, () => []);
  targets.forEach((t, s) => {
    if (!t || !Number.isFinite(t.system) || !Number.isFinite(t.volume) || t.volume <= 0) return;
    const solar = Math.exp(-((s / 2 + 0.25 - 12.3) ** 2) / (2 * 2.2 ** 2));
    raw.slots[s].set(SYSTEM_GROUP, syntheticCurve(t.system, t.volume, solar, rand));
    if (t.east !== undefined && t.west !== undefined && Number.isFinite(t.east) && Number.isFinite(t.west) && Math.abs(t.east - t.west) > 0.005) {
      raw.slots[s].set(EAST.id, syntheticCurve(t.east, t.volume * 0.42, solar * 0.6, rand));
      raw.slots[s].set(WEST.id, syntheticCurve(t.west, t.volume * 0.58, Math.min(1, solar * 1.3), rand));
      groups[s] = [EAST, WEST];
    }
  });
  return { raw, groups };
}
