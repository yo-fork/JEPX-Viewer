/**
 * 期間別の時系列を作る共通処理（概要・推移・入札量のタブで使う）。
 */
import { aggregate, buildPeriods, type Granularity, type Periods, type Source } from '../lib/aggregate';
import { formatDay, MS_PER_DAY, MS_PER_SLOT, slotStartLabel, wallClockMs, ymdFromDay } from '../lib/dates';
import { SLOTS } from '../lib/series';
import type { Selection } from '../lib/select';
import { accMean, quantileSorted } from '../lib/stats';
import type { TrendStat } from '../state';

/** 期間の長さから見やすい粒度を選ぶ */
export function autoGranularity(sel: Selection, allowSlot = true): Granularity {
  const days = sel.to - sel.from + 1;
  if (allowSlot && days <= 14) return 'slot';
  if (days <= 400) return 'day';
  if (days <= 1100) return 'week';
  return 'month';
}

export interface SeriesPoints {
  /** [時刻(ms), 値] */
  points: [number, number][];
  /** 範囲帯用の最小・最大 */
  low?: number[];
  high?: number[];
}

export function periodPoints(sel: Selection, source: Source, periods: Periods, stat: TrendStat, withRange = false): SeriesPoints {
  const keep = stat === 'median';
  const g = aggregate(sel, source, (i) => periods.ofDay[i], periods.starts.length, keep);
  const points: [number, number][] = [];
  const low: number[] = [];
  const high: number[] = [];
  periods.starts.forEach((start, k) => {
    const acc = g.acc[k];
    let v: number;
    if (acc.n === 0) v = Number.NaN;
    else if (stat === 'mean') v = accMean(acc);
    else if (stat === 'max') v = acc.max;
    else if (stat === 'min') v = acc.min;
    else v = quantileSorted(Float64Array.from(g.values![k]).sort(), 0.5);
    points.push([periodMs(start), v]);
    if (withRange) {
      low.push(acc.n ? acc.min : Number.NaN);
      high.push(acc.n ? acc.max : Number.NaN);
    }
  });
  return withRange ? { points, low, high } : { points };
}

/** 30 分値そのまま（受渡日ごとに時刻順。日をまたぐ時間帯指定でも時間の前後が入れ替わらない） */
export function slotPoints(sel: Selection, source: Source): SeriesPoints {
  const points: [number, number][] = [];
  const { a, b } = source;
  for (const i of sel.days) {
    const day = sel.ds.start + i;
    for (let s = 0; s < SLOTS; s++) {
      if (!sel.slotMask[s]) continue;
      let v = a[i * SLOTS + s];
      if (b) v -= b[i * SLOTS + s];
      points.push([wallClockMs(day, s), v]);
    }
  }
  return { points };
}

/** 折れ線用: 30 分より離れた点（対象外の時間帯・日）の間に欠損を挟み、線をつながない */
export function breakGaps(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k < points.length; k++) {
    if (k > 0 && points[k][0] - points[k - 1][0] > MS_PER_SLOT) out.push([points[k - 1][0] + MS_PER_SLOT, Number.NaN]);
    out.push(points[k]);
  }
  return out;
}

export function buildSeriesPoints(
  sel: Selection,
  sources: Source[],
  gran: Granularity,
  stat: TrendStat,
  withRange = false,
): SeriesPoints[] {
  if (gran === 'slot') return sources.map((s) => slotPoints(sel, s));
  const periods = buildPeriods(sel, gran);
  return sources.map((s) => periodPoints(sel, s, periods, stat, withRange));
}

/** 期間の代表時刻（週・月・年度は初日） */
export function periodMs(startDay: number): number {
  return startDay * MS_PER_DAY;
}

/** ツールチップ見出し */
export function periodLabel(ms: number, gran: Granularity): string {
  const day = Math.floor(ms / MS_PER_DAY);
  switch (gran) {
    case 'slot':
      return `${formatDay(day, true)} ${slotStartLabel(Math.round((ms - day * MS_PER_DAY) / 1_800_000))}`;
    case 'day':
      return formatDay(day, true);
    case 'week':
      return `${formatDay(day)}〜${formatDay(day + 6)} の週`;
    case 'month': {
      const { y, m } = ymdFromDay(day);
      return `${y}年${m}月`;
    }
    case 'fy':
      return `${ymdFromDay(day).y}年度`;
    case 'year':
      return `${ymdFromDay(day).y}年`;
  }
}

/** 時間軸のラベル書式（UTC として JST の壁時計時刻を表示） */
export const TIME_AXIS_LABEL = {
  hideOverlap: true,
  formatter: {
    year: '{yyyy}年',
    month: '{M}月',
    day: '{M}/{d}',
    hour: '{HH}:{mm}',
    minute: '{HH}:{mm}',
    second: '{HH}:{mm}',
  },
};
