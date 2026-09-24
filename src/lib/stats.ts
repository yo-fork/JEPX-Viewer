/**
 * 基本統計量。
 */

export interface Acc {
  n: number;
  sum: number;
  sumSq: number;
  min: number;
  max: number;
  /** 最小・最大を取った位置（dayIndex × 48 + slot） */
  minAt: number;
  maxAt: number;
}

export function newAcc(): Acc {
  return { n: 0, sum: 0, sumSq: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, minAt: -1, maxAt: -1 };
}

export function accAdd(acc: Acc, v: number, at = -1): void {
  acc.n++;
  acc.sum += v;
  acc.sumSq += v * v;
  if (v < acc.min) {
    acc.min = v;
    acc.minAt = at;
  }
  if (v > acc.max) {
    acc.max = v;
    acc.maxAt = at;
  }
}

export function accMean(acc: Acc): number {
  return acc.n > 0 ? acc.sum / acc.n : Number.NaN;
}

/** 標準偏差（母標準偏差） */
export function accStd(acc: Acc): number {
  if (acc.n === 0) return Number.NaN;
  const mean = acc.sum / acc.n;
  return Math.sqrt(Math.max(0, acc.sumSq / acc.n - mean * mean));
}

/** ソート済み配列の分位点（線形補間。numpy の既定と同じ） */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Summary {
  n: number;
  mean: number;
  std: number;
  min: number;
  max: number;
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

/** 配列（欠損なし）の要約統計量。引数はソートされる */
export function summarizeInPlace(values: Float64Array): Summary {
  const n = values.length;
  if (n === 0) {
    const nan = Number.NaN;
    return { n: 0, mean: nan, std: nan, min: nan, max: nan, p10: nan, p25: nan, median: nan, p75: nan, p90: nan };
  }
  values.sort();
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
  }
  const mean = sum / n;
  return {
    n,
    mean,
    std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    min: values[0],
    max: values[n - 1],
    p10: quantileSorted(values, 0.1),
    p25: quantileSorted(values, 0.25),
    median: quantileSorted(values, 0.5),
    p75: quantileSorted(values, 0.75),
    p90: quantileSorted(values, 0.9),
  };
}

/** 見やすい目盛り幅（1, 2, 2.5, 5 × 10^n）に丸める */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}
