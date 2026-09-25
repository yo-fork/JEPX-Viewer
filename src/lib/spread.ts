/**
 * 2 系列の値差（A − B）の集計。どちらが高かったコマの数、値差の大きさ、分布の階級を求める。
 */
import { SLOTS } from './series';
import type { Selection } from './select';
import { niceStep, quantileSorted } from './stats';

/** これ以下の差は価格が同じとみなす（市場分断の発生率と同じ判定） */
export const SAME_PRICE = 0.005;

export interface SpreadStats {
  /** 両方に値があるコマ数と、値差の合計 */
  n: number;
  sum: number;
  /** A が高かった（値差が SAME_PRICE を超えた）コマ数と、その値差の合計 */
  up: number;
  upSum: number;
  /** B が高かったコマ数と、その値差の合計（負） */
  down: number;
  downSum: number;
  /** 最大・最小の値差と、その位置（dayIndex × 48 + slot。無ければ -1） */
  max: number;
  maxAt: number;
  min: number;
  minAt: number;
}

function newStats(): SpreadStats {
  return { n: 0, sum: 0, up: 0, upSum: 0, down: 0, downSum: 0, max: Number.NEGATIVE_INFINITY, maxAt: -1, min: Number.POSITIVE_INFINITY, minAt: -1 };
}

/** groupOf(dayIndex, slot) が返すグループ番号ごとに、a − b を集計する（負の番号は対象外） */
export function spreadBy(
  sel: Selection,
  a: Float64Array,
  b: Float64Array,
  groupOf: (i: number, slot: number) => number,
  nGroups: number,
): SpreadStats[] {
  const out = Array.from({ length: nGroups }, newStats);
  for (const i of sel.days) {
    const base = i * SLOTS;
    for (const s of sel.slots) {
      const d = a[base + s] - b[base + s];
      if (Number.isNaN(d)) continue;
      const g = groupOf(i, s);
      if (g < 0) continue;
      const c = out[g];
      c.n++;
      c.sum += d;
      if (d > SAME_PRICE) {
        c.up++;
        c.upSum += d;
      } else if (d < -SAME_PRICE) {
        c.down++;
        c.downSum += d;
      }
      if (d > c.max) {
        c.max = d;
        c.maxAt = base + s;
      }
      if (d < c.min) {
        c.min = d;
        c.minAt = base + s;
      }
    }
  }
  return out;
}

/** 価格が異なったコマの a − b（昇順） */
export function spreadValues(sel: Selection, a: Float64Array, b: Float64Array): Float64Array {
  const out: number[] = [];
  for (const i of sel.days) {
    const base = i * SLOTS;
    for (const s of sel.slots) {
      const d = a[base + s] - b[base + s];
      if (Math.abs(d) > SAME_PRICE) out.push(d);
    }
  }
  return Float64Array.from(out).sort();
}

/** 値差の階級（start から width 刻みで nBins 個。0 は必ず階級の境目になる） */
export interface SpreadBins {
  start: number;
  width: number;
  nBins: number;
}

/**
 * 値差の分布の階級。1〜99%点（と 0）が入る範囲を約 24 個に分ける（それより外は両端の「〜」の階級にまとめる）。
 * 0 を境目にするので、どの階級も A が高い側か B が高い側のどちらかに入る
 */
export function spreadBins(sorted: Float64Array): SpreadBins {
  const lo = Math.min(0, quantileSorted(sorted, 0.01) || 0);
  const hi = Math.max(0, quantileSorted(sorted, 0.99) || 0);
  const width = Math.max(0.01, niceStep((hi - lo) / 24));
  const start = Math.floor(lo / width) * width;
  return { start, width, nBins: Math.max(1, Math.ceil((hi - start) / width)) };
}

/** 階級ごとのコマ数（長さ nBins + 2。最初は start 未満、最後は上端以上） */
export function spreadCounts(values: ArrayLike<number>, b: SpreadBins): number[] {
  const end = b.start + b.nBins * b.width;
  const counts = new Array<number>(b.nBins + 2).fill(0);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    counts[v < b.start ? 0 : v >= end ? b.nBins + 1 : 1 + Math.min(b.nBins - 1, Math.floor((v - b.start) / b.width))]++;
  }
  return counts;
}
