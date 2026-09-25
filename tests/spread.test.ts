import { describe, expect, it } from 'vitest';
import { dayFromYmd } from '../src/lib/dates';
import { stepDigits } from '../src/lib/format';
import { newDayValues, type DayMap } from '../src/lib/jepxCsv';
import { select } from '../src/lib/select';
import { SERIES_INDEX, SLOTS } from '../src/lib/series';
import { spreadBins, spreadBy, spreadCounts, spreadValues } from '../src/lib/spread';
import { DataStore } from '../src/lib/store';

/** 2 日分。東京 − 関西 の値差を、1 日目はコマ 0〜2 に +3, 0, −1.5、2 日目はコマ 0 に +0.004（同じ価格とみなす）とする */
function fixture(from: number): DayMap {
  const days: DayMap = new Map();
  const diffs = [
    [3, 0, -1.5],
    [0.004, Number.NaN, 0],
  ];
  diffs.forEach((row, i) => {
    const v = newDayValues();
    row.forEach((d, s) => {
      v[SERIES_INDEX.kansai * SLOTS + s] = 10;
      v[SERIES_INDEX.tokyo * SLOTS + s] = 10 + d;
    });
    days.set(from + i, v);
  });
  return days;
}

describe('2 エリア間の値差', () => {
  const start = dayFromYmd(2025, 4, 1);
  const store = new DataStore();
  store.addDays(fixture(start), 'upload');
  const ds = store.dataset()!;
  const sel = select(ds, { from: start, to: start + 1, dayType: 'all', slotStart: 0, slotEnd: 3 });
  const tokyo = ds.values[SERIES_INDEX.tokyo];
  const kansai = ds.values[SERIES_INDEX.kansai];

  it('どちらが高かったコマの数、値差の合計、最大・最小とその位置を数える（0.005 円以下の差は同じ価格）', () => {
    const [c] = spreadBy(sel, tokyo, kansai, () => 0, 1);
    // 2 日目のコマ 1 は東京に値が無いので数えない
    expect(c).toMatchObject({ n: 5, up: 1, upSum: 3, down: 1, downSum: -1.5, max: 3, maxAt: 0, min: -1.5, minAt: 2 });
    expect(c.sum).toBeCloseTo(1.504);
  });

  it('時間帯（コマ）ごとに分けて数える', () => {
    const bySlot = spreadBy(sel, tokyo, kansai, (_i, s) => s, SLOTS);
    expect(bySlot.slice(0, 3).map((c) => [c.n, c.up, c.down])).toEqual([
      [2, 1, 0],
      [1, 0, 0],
      [2, 0, 1],
    ]);
  });

  it('分布は価格が異なったコマだけを使い、0 を階級の境目にして、両端の外れた値は「〜」の階級に入れる', () => {
    const values = spreadValues(sel, tokyo, kansai);
    expect([...values]).toEqual([-1.5, 3]);
    const b = spreadBins(values);
    // 0 が階級の境目になる（start から width の整数倍の位置）
    expect(Math.abs(b.start / b.width - Math.round(b.start / b.width))).toBeLessThan(1e-9);
    expect(b.start).toBeLessThanOrEqual(-1.5);
    const counts = spreadCounts(values, b);
    expect(counts).toHaveLength(b.nBins + 2);
    expect(counts.reduce((x, y) => x + y, 0)).toBe(2);
    // 範囲の外の値は両端の階級へ
    const narrow = { start: -1, width: 0.5, nBins: 4 };
    expect(spreadCounts([-1.2, -1, 0.99, 1, 7], narrow)).toEqual([1, 1, 0, 0, 1, 2]);
  });

  it('刻み幅の小数の桁数', () => {
    expect([1, 2.5, 0.5, 0.25, 0.025, 10].map(stepDigits)).toEqual([0, 1, 1, 2, 3, 0]);
  });
});
