/**
 * 画面上部のフィルタ（期間・曜日区分・時間帯）を Dataset に適用して、対象の日とコマを決める。
 */
import type { Dataset } from './store';
import { SLOTS } from './series';

export type DayType = 'all' | 'weekday' | 'offday';

export interface Filters {
  from: number;
  to: number;
  dayType: DayType;
  /** 開始コマ（0〜47） */
  slotStart: number;
  /** 終了コマ（1〜48、この直前のコマまで）。slotEnd <= slotStart のときは日をまたぐ */
  slotEnd: number;
}

export interface Selection {
  ds: Dataset;
  filters: Filters;
  /** データ範囲に切り詰めた期間 */
  from: number;
  to: number;
  /** 対象日（Dataset 内のインデックス、昇順） */
  days: Int32Array;
  /** 対象コマ（時間帯の開始から順に。日またぎの場合は 20:00, …, 23:30, 0:00, …） */
  slots: number[];
  slotMask: Uint8Array;
}

export function slotsOfRange(slotStart: number, slotEnd: number): number[] {
  const out: number[] = [];
  if (slotEnd > slotStart) {
    for (let s = slotStart; s < slotEnd; s++) out.push(s);
  } else {
    for (let s = slotStart; s < SLOTS; s++) out.push(s);
    for (let s = 0; s < slotEnd; s++) out.push(s);
  }
  return out;
}

export function isAllDay(f: Pick<Filters, 'slotStart' | 'slotEnd'>): boolean {
  return f.slotStart === 0 && (f.slotEnd === SLOTS || f.slotEnd === 0);
}

export function select(ds: Dataset, filters: Filters): Selection {
  const from = Math.max(filters.from, ds.firstDay);
  const to = Math.min(filters.to, ds.lastDay);
  const idx: number[] = [];
  for (let day = from; day <= to; day++) {
    const i = day - ds.start;
    if (!ds.present[i]) continue;
    if (filters.dayType === 'weekday' && ds.offDay[i]) continue;
    if (filters.dayType === 'offday' && !ds.offDay[i]) continue;
    idx.push(i);
  }
  const slots = slotsOfRange(filters.slotStart, filters.slotEnd);
  const slotMask = new Uint8Array(SLOTS);
  for (const s of slots) slotMask[s] = 1;
  return { ds, filters, from, to, days: Int32Array.from(idx), slots, slotMask };
}

/** 別の期間で同じ条件の Selection を作る（前年同期比較など） */
export function reselect(sel: Selection, from: number, to: number): Selection {
  return select(sel.ds, { ...sel.filters, from, to });
}
