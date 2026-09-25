import { describe, expect, it } from 'vitest';
import { largestSteps } from '../src/lib/areaCurves';
import { CurveStore } from '../src/lib/curveStore';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { stepGrid, type StepOccurrence } from '../src/lib/stepGrid';
import { DataStore } from '../src/lib/store';
import { stateFromHash, stateToHash } from '../src/state';

describe('何度も出てくる段', () => {
  it('大きい段は、増えた量の大きい順に n 段（増えていない段は除く）', () => {
    // 売り: 5 円で +200、10 円で +50、12 円で +0、20 円で +300
    expect(largestSteps([0, 100, 5, 300, 10, 350, 12, 350, 20, 650], 2)).toEqual([
      { price: 20, mw: 300, before: 350 },
      { price: 5, mw: 200, before: 100 },
    ]);
  });

  it('価格と量の格子に分け、段のあったコマを数える（1 コマに同じマスの段が 2 つあっても 1 と数える）', () => {
    const occ: StepOccurrence[] = [];
    // 10 円前後・300MW 余りの段が 3 コマに出てくる（2 日目のコマ 5 には 2 つ。量の刻みは 20MW、価格の刻みは 0.5 円になる）
    occ.push({ day: 1, slot: 3, price: 10.1, mw: 305 }, { day: 2, slot: 5, price: 10.2, mw: 302 }, { day: 2, slot: 5, price: 10.3, mw: 303 });
    occ.push({ day: 3, slot: 7, price: 10.2, mw: 301 });
    // ほかの段はばらばら
    for (let k = 0; k < 20; k++) occ.push({ day: 10 + k, slot: 0, price: 1 + k, mw: 20 + k * 5 });
    const g = stepGrid(occ)!;
    const top = g.cells[0];
    expect(top.slots).toBe(3);
    expect(top.latest).toEqual({ day: 3, slot: 7 });
    // その段の価格と量が、そのマスの範囲に入る
    const pLo = g.price.start + top.p * g.price.width;
    expect(10.1).toBeGreaterThanOrEqual(pLo - 1e-9);
    expect(10.3).toBeLessThan(pLo + 2 * g.price.width);
    expect([g.price.width, g.mw.width]).toEqual([0.5, 20]);
    expect(top.m * g.mw.width).toBeLessThanOrEqual(301);
    expect((top.m + 1) * g.mw.width).toBeGreaterThan(305);
    // 並びはコマの数の多い順
    for (let k = 1; k < g.cells.length; k++) expect(g.cells[k - 1].slots).toBeGreaterThanOrEqual(g.cells[k].slots);
  });

  it('価格は 1〜99%点で分け、外れた価格は両端の階級に入れる', () => {
    const occ: StepOccurrence[] = Array.from({ length: 200 }, (_, k) => ({ day: k, slot: 0, price: 10 + (k % 20) * 0.5, mw: 100 }));
    occ.push({ day: 500, slot: 0, price: 0.01, mw: 100 }, { day: 501, slot: 0, price: 999.99, mw: 100 });
    const g = stepGrid(occ)!;
    expect([g.price.below, g.price.above]).toEqual([true, true]);
    // 999.99 円があっても、刻みは 10〜19.5 円の範囲に合わせて細かいまま
    expect(g.price.width).toBeLessThanOrEqual(0.5);
    expect(stepGrid([])).toBeNull();
  });

  it('入札カーブを 1 日分読むが、手元には置かない（カーブの無い日は null）', async () => {
    const store = new DataStore();
    store.addDays(generateDemoDays(dayFromYmd(2026, 6, 1), dayFromYmd(2026, 6, 10), 5), 'demo');
    const cs = CurveStore.demo(store.dataset()!)!;
    const day = await cs.readDay(cs.last);
    expect(day?.day).toBe(cs.last);
    expect(day?.slots.some((s) => s !== null)).toBe(true);
    expect(cs.getDay(cs.last)).toBeUndefined();
    expect(await cs.readDay(cs.last + 1)).toBeNull();
  });

  it('見る側（売り・買い）を URL に保存・復元できる', () => {
    const s = stateFromHash('#tab=curves&ssd=buy');
    expect(s.stepSide).toBe('buy');
    expect(stateToHash(s)).toBe('#tab=curves&ssd=buy');
    expect(stateFromHash('#ssd=up').stepSide).toBe('sell');
  });
});
