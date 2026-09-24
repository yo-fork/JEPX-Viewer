/**
 * Selection に対する集計処理（期間別・コマ別・任意グループ別）。
 */
import { dayFromYmd, fiscalYearStart, weekStartOf } from './dates';
import { SERIES_INDEX, SLOTS, isFloorPrice, type SeriesKey } from './series';
import type { Selection } from './select';
import type { Dataset } from './store';
import { accAdd, newAcc, type Acc } from './stats';

/** 集計対象の値。b を指定すると a − b（値差）を集計する */
export interface Source {
  a: Float64Array;
  b?: Float64Array;
}

export function src(ds: Dataset, key: SeriesKey, minus?: SeriesKey): Source {
  return { a: ds.values[SERIES_INDEX[key]], b: minus ? ds.values[SERIES_INDEX[minus]] : undefined };
}

export interface Groups {
  acc: Acc[];
  values?: number[][];
  /** 最低価格（0.01 円）のコマ数 */
  floor: Int32Array;
}

/**
 * groupOf(dayIndex, slot) が返すグループ番号ごとに集計する（負の値は対象外）。
 */
export function aggregate(
  sel: Selection,
  source: Source,
  groupOf: (i: number, slot: number) => number,
  nGroups: number,
  keepValues = false,
): Groups {
  const acc = Array.from({ length: nGroups }, newAcc);
  const values = keepValues ? Array.from({ length: nGroups }, () => [] as number[]) : undefined;
  const floor = new Int32Array(nGroups);
  const { a, b } = source;
  const slots = sel.slots;
  for (let di = 0; di < sel.days.length; di++) {
    const i = sel.days[di];
    const base = i * SLOTS;
    for (let k = 0; k < slots.length; k++) {
      const s = slots[k];
      let v = a[base + s];
      if (b) v -= b[base + s];
      if (Number.isNaN(v)) continue;
      const g = groupOf(i, s);
      if (g < 0) continue;
      accAdd(acc[g], v, base + s);
      if (values) values[g].push(v);
      if (!b && isFloorPrice(v)) floor[g]++;
    }
  }
  return { acc, values, floor };
}

/** 選択範囲全体を 1 グループとして集計 */
export function aggregateAll(sel: Selection, source: Source, keepValues = false): Groups {
  return aggregate(sel, source, () => 0, 1, keepValues);
}

/** 選択範囲の有効な値をすべて取り出す */
export function collectValues(sel: Selection, source: Source): Float64Array {
  const out = new Float64Array(sel.days.length * sel.slots.length);
  let n = 0;
  const { a, b } = source;
  for (let di = 0; di < sel.days.length; di++) {
    const base = sel.days[di] * SLOTS;
    for (const s of sel.slots) {
      let v = a[base + s];
      if (b) v -= b[base + s];
      if (!Number.isNaN(v)) out[n++] = v;
    }
  }
  return out.subarray(0, n);
}

export type Granularity = 'slot' | 'day' | 'week' | 'month' | 'fy' | 'year';

export const GRANULARITY_LABEL: Record<Granularity, string> = {
  slot: '30分',
  day: '日',
  week: '週',
  month: '月',
  fy: '年度',
  year: '暦年',
};

/** 期間の開始日（経過日数） */
export function periodStart(ds: Dataset, i: number, gran: Exclude<Granularity, 'slot'>): number {
  const day = ds.start + i;
  switch (gran) {
    case 'day':
      return day;
    case 'week':
      return weekStartOf(day);
    case 'month':
      return dayFromYmd(ds.y[i], ds.m[i], 1);
    case 'fy':
      return fiscalYearStart(ds.fy[i]);
    case 'year':
      return dayFromYmd(ds.y[i], 1, 1);
  }
}

export interface Periods {
  /** 各期間の開始日（昇順） */
  starts: number[];
  /** Dataset の日インデックス → 期間番号（対象外は -1） */
  ofDay: Int32Array;
}

export function buildPeriods(sel: Selection, gran: Exclude<Granularity, 'slot'>): Periods {
  const ofDay = new Int32Array(sel.ds.n).fill(-1);
  const starts: number[] = [];
  const index = new Map<number, number>();
  for (const i of sel.days) {
    const p = periodStart(sel.ds, i, gran);
    let g = index.get(p);
    if (g === undefined) {
      g = starts.length;
      starts.push(p);
      index.set(p, g);
    }
    ofDay[i] = g;
  }
  return { starts, ofDay };
}

/** 期間別集計 */
export function aggregateByPeriod(
  sel: Selection,
  source: Source,
  gran: Exclude<Granularity, 'slot'>,
  keepValues = false,
): { periods: Periods; groups: Groups } {
  const periods = buildPeriods(sel, gran);
  const groups = aggregate(sel, source, (i) => periods.ofDay[i], periods.starts.length, keepValues);
  return { periods, groups };
}

/** コマ別集計（0〜47） */
export function aggregateBySlot(sel: Selection, source: Source, keepValues = false): Groups {
  return aggregate(sel, source, (_i, s) => s, SLOTS, keepValues);
}

/** 2 系列の価格が異なる（市場分断が起きた）コマの割合 */
export function splitRate(sel: Selection, a: Float64Array, b: Float64Array): { n: number; split: number } {
  let n = 0;
  let split = 0;
  for (const i of sel.days) {
    const base = i * SLOTS;
    for (const s of sel.slots) {
      const va = a[base + s];
      const vb = b[base + s];
      if (Number.isNaN(va) || Number.isNaN(vb)) continue;
      n++;
      if (Math.abs(va - vb) > 0.005) split++;
    }
  }
  return { n, split };
}

/** 約定量加重平均価格 */
export function weightedMean(sel: Selection, price: Float64Array, weight: Float64Array): number {
  let sw = 0;
  let spw = 0;
  for (const i of sel.days) {
    const base = i * SLOTS;
    for (const s of sel.slots) {
      const p = price[base + s];
      const w = weight[base + s];
      if (Number.isNaN(p) || Number.isNaN(w)) continue;
      sw += w;
      spw += p * w;
    }
  }
  return sw > 0 ? spw / sw : Number.NaN;
}

/** 季節の番号（0: 春 3〜5 月, 1: 夏 6〜8 月, 2: 秋 9〜11 月, 3: 冬 12〜2 月） */
export function seasonOfMonth(m: number): number {
  return m >= 3 && m <= 5 ? 0 : m >= 6 && m <= 8 ? 1 : m >= 9 && m <= 11 ? 2 : 3;
}

/** 年度内の月順（4 月=0 … 3 月=11） */
export function fiscalMonthIndex(m: number): number {
  return (m + 8) % 12;
}
export const FISCAL_MONTH_LABELS = ['4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '1月', '2月', '3月'];
