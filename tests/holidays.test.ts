import { describe, expect, it } from 'vitest';
import holidayJp from '@holiday-jp/holiday_jp';
import { holidayName, holidaysOfYear, isOffDay } from '../src/lib/holidays';
import { dayFromYmd, isoFromDay } from '../src/lib/dates';

const reference = new Set(Object.keys(holidayJp.holidays));

describe('祝日判定', () => {
  it('2000〜2050 年の祝日・休日が @holiday-jp/holiday_jp の表と一致する', () => {
    const missing: string[] = [];
    const extra: string[] = [];
    for (let y = 2000; y <= 2050; y++) {
      const mine = new Set(holidaysOfYear(y).map(([day]) => isoFromDay(day)));
      for (const iso of reference) {
        if (iso.startsWith(`${y}-`) && !mine.has(iso)) missing.push(iso);
      }
      for (const iso of mine) {
        if (!reference.has(iso)) extra.push(iso);
      }
    }
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('特殊な年の祝日を正しく扱う', () => {
    expect(holidayName(dayFromYmd(2019, 5, 1))).toBe('天皇の即位の日');
    expect(holidayName(dayFromYmd(2019, 4, 30))).toBe('国民の休日');
    expect(holidayName(dayFromYmd(2020, 7, 24))).toBe('スポーツの日');
    expect(holidayName(dayFromYmd(2021, 8, 9))).toBe('振替休日');
    expect(holidayName(dayFromYmd(2026, 9, 22))).toBe('国民の休日');
    expect(holidayName(dayFromYmd(2019, 12, 23))).toBeUndefined();
  });

  it('土日祝を休日として判定する', () => {
    expect(isOffDay(dayFromYmd(2024, 4, 29))).toBe(true); // 昭和の日（月）
    expect(isOffDay(dayFromYmd(2024, 4, 27))).toBe(true); // 土曜
    expect(isOffDay(dayFromYmd(2024, 4, 30))).toBe(false); // 火曜
  });
});
