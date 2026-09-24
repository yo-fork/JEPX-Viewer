import { describe, expect, it } from 'vitest';
import { DataStore } from '../src/lib/store';
import { select } from '../src/lib/select';
import { aggregateAll, aggregateByPeriod, aggregateBySlot, collectValues, splitRate, src, weightedMean } from '../src/lib/aggregate';
import { quantileSorted, summarizeInPlace, accMean } from '../src/lib/stats';
import { dayFromYmd } from '../src/lib/dates';
import { newDayValues, type DayMap } from '../src/lib/jepxCsv';
import { SERIES_INDEX, SLOTS } from '../src/lib/series';
import { decodeFyFile, encodeFyFile, splitByFiscalYear } from '../src/lib/dataFile';
import { generateDemoDays } from '../src/lib/demo';

/** system = 日番号 + コマ/100、東京 = system + 1 のテスト用データ */
function fixture(from: number, n: number): DayMap {
  const days: DayMap = new Map();
  for (let i = 0; i < n; i++) {
    const v = newDayValues();
    for (let s = 0; s < SLOTS; s++) {
      v[SERIES_INDEX.system * SLOTS + s] = i + s / 100;
      v[SERIES_INDEX.tokyo * SLOTS + s] = i + s / 100 + (s % 2 === 0 ? 1 : 0);
      v[SERIES_INDEX.volume * SLOTS + s] = s < 24 ? 1 : 3;
    }
    days.set(from + i, v);
  }
  return days;
}

describe('統計量', () => {
  it('分位点と要約統計量', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    const s = summarizeInPlace(Float64Array.from([5, 1, 3, 2, 4]));
    expect(s).toMatchObject({ n: 5, mean: 3, min: 1, max: 5, median: 3, p25: 2, p75: 4 });
    expect(s.std).toBeCloseTo(Math.sqrt(2));
  });
});

describe('選択と集計', () => {
  const start = dayFromYmd(2024, 4, 1); // 月曜日
  const store = new DataStore();
  store.addDays(fixture(start, 14), 'upload');
  const ds = store.dataset()!;

  it('期間・曜日区分・時間帯で絞り込む', () => {
    const all = select(ds, { from: start, to: start + 13, dayType: 'all', slotStart: 0, slotEnd: 48 });
    expect(all.days.length).toBe(14);
    // 2024/4/1〜14 の土日は 4 日（祝日なし）
    const weekday = select(ds, { from: start, to: start + 13, dayType: 'weekday', slotStart: 0, slotEnd: 48 });
    expect(weekday.days.length).toBe(10);
    const off = select(ds, { from: start, to: start + 13, dayType: 'offday', slotStart: 0, slotEnd: 48 });
    expect(off.days.length).toBe(4);
    // 20:00〜8:00（日またぎ）
    const night = select(ds, { from: start, to: start, dayType: 'all', slotStart: 40, slotEnd: 16 });
    expect(night.slots).toEqual([40, 41, 42, 43, 44, 45, 46, 47, ...Array.from({ length: 16 }, (_, i) => i)]);
  });

  it('期間別・コマ別に平均を出す', () => {
    const sel = select(ds, { from: start, to: start + 13, dayType: 'all', slotStart: 0, slotEnd: 48 });
    const { periods, groups } = aggregateByPeriod(sel, src(ds, 'system'), 'week');
    expect(periods.starts).toEqual([start, start + 7]);
    expect(accMean(groups.acc[0])).toBeCloseTo(3 + 0.235);
    const bySlot = aggregateBySlot(sel, src(ds, 'system'));
    expect(accMean(bySlot.acc[10])).toBeCloseTo(6.5 + 0.1);
    const all = aggregateAll(sel, src(ds, 'tokyo', 'system'));
    expect(accMean(all.acc[0])).toBeCloseTo(0.5);
  });

  it('市場分断率と加重平均', () => {
    const sel = select(ds, { from: start, to: start, dayType: 'all', slotStart: 0, slotEnd: 48 });
    const r = splitRate(sel, ds.values[SERIES_INDEX.tokyo], ds.values[SERIES_INDEX.system]);
    expect(r).toEqual({ n: 48, split: 24 });
    // 前半 24 コマの重み 1、後半 24 コマの重み 3
    const w = weightedMean(sel, ds.values[SERIES_INDEX.system], ds.values[SERIES_INDEX.volume]);
    const expected = (Array.from({ length: 24 }, (_, s) => s / 100).reduce((a, b) => a + b) + 3 * Array.from({ length: 24 }, (_, s) => (s + 24) / 100).reduce((a, b) => a + b)) / 96;
    expect(w).toBeCloseTo(expected);
    expect(collectValues(sel, src(ds, 'system')).length).toBe(48);
  });

  it('既存データへの上書きは有効な値だけを反映する', () => {
    const s2 = new DataStore();
    s2.addDays(fixture(start, 1), 'bundled');
    const patch = new Map([[start, newDayValues()]]);
    patch.get(start)![SERIES_INDEX.system * SLOTS] = 99;
    s2.addDays(patch, 'upload');
    const d = s2.dataset()!;
    expect(d.values[SERIES_INDEX.system][0]).toBe(99);
    expect(d.values[SERIES_INDEX.system][1]).toBeCloseTo(0.01);
  });
});

describe('データファイル形式', () => {
  it('年度ファイルへの変換と復元', () => {
    const from = dayFromYmd(2025, 3, 30);
    const days = generateDemoDays(from, from + 4, 3); // 2024 年度と 2025 年度にまたがる
    const byFy = splitByFiscalYear(days);
    expect([...byFy.keys()].sort()).toEqual([2024, 2025]);
    const json = JSON.parse(JSON.stringify(encodeFyFile(2025, byFy.get(2025)!)));
    const back = decodeFyFile(json);
    expect(back.size).toBe(3);
    for (const [day, vals] of back) expect(vals).toEqual(days.get(day));
  });
});
