import { describe, expect, it } from 'vitest';
import { aloneSlots, areaCurve, correctToPrice, slotSplit, subtractCurves } from '../src/lib/areaCurves';
import { buyVolumeAt, crossing, decodeCurveDay, encodeCurveDay, rowsFromSteps, sellVolumeAt, SYSTEM_GROUP, type CurveGroup } from '../src/lib/bidCurves';
import { dayFromYmd } from '../src/lib/dates';
import { syntheticCurveDay, type SlotTarget } from '../src/lib/demoCurves';
import type { AreaKey } from '../src/lib/series';

const f = (a: ArrayLike<number>) => [...Float64Array.from(a)];

describe('subtractCurves', () => {
  it('価格ごとに差を取り、負にせず、累積の量として減らないようにならす', () => {
    const total = { sell: [0, 100, 5, 300, 10, 600], buy: [999.99, 300, 10, 500, 0.01, 700] };
    const part = { sell: [0, 50, 10, 200], buy: [999.99, 100, 10, 150] };
    const r = subtractCurves(total, [part]);
    expect(f(r.sell)).toEqual([0, 50, 5, 250, 10, 400]);
    expect(f(r.buy)).toEqual([999.99, 200, 10, 350, 0.01, 550]);
    // 途中で減るところは前の量のまま、負になるところは 0
    expect(f(subtractCurves({ sell: [0, 100, 5, 120], buy: [] }, [{ sell: [0, 10, 5, 60], buy: [] }]).sell)).toEqual([0, 90]);
    expect(f(subtractCurves({ sell: [0, 10], buy: [] }, [{ sell: [0, 50], buy: [] }]).sell)).toEqual([]);
  });
});

describe('correctToPrice', () => {
  const curve = { sell: [0, 100, 10, 300], buy: [999.99, 150, 5, 250] };
  it('売りが多ければ買いに、買いが多ければ売りに差を足し、その価格で交わるようにする', () => {
    const up = correctToPrice(curve, 10);
    expect([up.side, up.mw]).toEqual(['buy', 150]);
    expect(f(up.buy)).toEqual([999.99, 300, 5, 400]);
    expect(crossing(rowsFromSteps(up.sell, up.buy))).toEqual({ price: 10, volume: 300 });
    const down = correctToPrice({ sell: [0, 100, 5, 200], buy: [999.99, 150, 5, 250] }, 5);
    expect([down.side, down.mw]).toEqual(['sell', 50]);
    expect(crossing(rowsFromSteps(down.sell, down.buy))!.price).toBe(5);
  });
});

/** 合成の 1 コマを、保存・読み込みしたときと同じ形（描画用のカーブ）にする */
function slotGroups(target: SlotTarget): CurveGroup[] {
  const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [target]);
  return decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups)))).slots[0]!;
}

describe('areaCurve', () => {
  const base = { tohoku: 12, tokyo: 12, chubu: 9, hokuriku: 9, kansai: 9, chugoku: 9, shikoku: 9 };
  it('分断していなければシステムプライス、分断エリアに入るエリアはそのカーブ', () => {
    const none = slotGroups({ system: 10, volume: 30000 });
    expect(slotSplit(none)).toEqual({ kind: 'none' });
    expect(areaCurve(none, 'tokyo', () => 10)!.kind).toBe('system');
    const gs = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9 } });
    const c = areaCurve(gs, 'tokyo', () => Number.NaN)!;
    expect([c.kind, c.label]).toEqual(['group', '北海道・東北・東京']);
    expect(areaCurve(gs, 'system', () => Number.NaN)!.kind).toBe('system');
  });

  it('単エリアが 1 つなら、システムプライスから分断エリアを引き、約定価格で交わるように補正する', () => {
    const gs = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } });
    const split = slotSplit(gs);
    expect(split.kind === 'split' && split.singles).toEqual(['hokkaido']);
    const prices: Partial<Record<AreaKey, number>> = { hokkaido: 15.2 };
    const c = areaCurve(gs, 'hokkaido', (a) => prices[a] ?? Number.NaN)!;
    expect([c.kind, c.label, c.subtracted]).toEqual(['single', '北海道', ['東北・東京', '中部・北陸・関西・中国・四国・九州']]);
    // 約定価格で売りと買いが同じ量になる（合成のカーブは 0.25 円おきの段なので、交点はその段の中）
    expect(Math.abs(sellVolumeAt(c.sell, 15.2) - buyVolumeAt(c.buy, 15.2))).toBeLessThanOrEqual(1);
    const x = crossing(rowsFromSteps(c.sell, c.buy))!.price;
    expect(x).toBeLessThanOrEqual(15.2);
    expect(x).toBeGreaterThanOrEqual(15.2 - 0.25);
    // デモのシステムプライスのカーブは買いが約定量の 1.5% 多いので、主に売りを足して補正する
    expect(c.correction).toMatchObject({ side: 'sell', price: 15.2 });
    expect(c.correction!.mw).toBeGreaterThan(200);
    // 約定価格が分からなければ補正しない
    expect(areaCurve(gs, 'hokkaido', () => Number.NaN)!.correction).toBeUndefined();
  });

  it('単エリアが複数なら、合わせたカーブにする（補正なし）', () => {
    const gs = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 5 } });
    const c = areaCurve(gs, 'kyushu', () => 5)!;
    expect([c.kind, c.label, c.areas, c.correction]).toEqual(['combined', '北海道・九州', ['hokkaido', 'kyushu'], undefined]);
    expect(c.sell.length).toBeGreaterThan(0);
  });

  it('公表されている分断エリアのカーブに単エリアの入札も含まれていて、引いても残らないときは推定できないとする', () => {
    const gs0 = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9, shikoku: 5 } });
    const system = gs0.find((g) => g.id === SYSTEM_GROUP)!;
    const rest: AreaKey[] = ['hokkaido', 'tohoku', 'tokyo', 'chubu', 'hokuriku', 'kansai', 'chugoku', 'kyushu'];
    // 四国以外のまとまりとして、システムプライスと同じカーブが公表されている
    const gs: CurveGroup[] = [system, { id: 0, label: '北海道・東北・東京・中部・北陸・関西・中国・九州', areas: rest, sell: system.sell, buy: system.buy }];
    const c = areaCurve(gs, 'shikoku', () => 8.74)!;
    expect(c.kind).toBe('unavailable');
    expect([c.sell.length, c.buy.length, c.label]).toEqual([0, 0, '四国']);
    const total = (a: Float64Array) => a[a.length - 1];
    expect(c.totals).toEqual({ systemSell: total(system.sell), systemBuy: total(system.buy), publishedSell: total(system.sell), publishedBuy: total(system.buy) });
    // 分断エリアに入るエリアは、これまでどおりそのカーブ
    expect(areaCurve(gs, 'tokyo', () => 10)!.kind).toBe('group');
  });

  it('分断エリアの名前が無ければ、エリアを決められないのでシステムプライスのカーブにする', () => {
    const gs = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9 } }).map((g) => (g.id === SYSTEM_GROUP ? g : { ...g, areas: [] }));
    expect(slotSplit(gs)).toEqual({ kind: 'unnamed' });
    expect(areaCurve(gs, 'tokyo', () => 12)).toMatchObject({ kind: 'system', unnamed: true });
  });

  it('その日のうち、そのエリアだけが単エリアになったコマ', () => {
    const t = (hokkaido: number, kyushu: number): SlotTarget => ({ system: 10, volume: 30000, areas: { ...base, hokkaido, kyushu } });
    const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [t(15, 9), t(15, 5), t(12, 9), t(15, 9)]);
    const day = decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups))));
    expect(aloneSlots(day, 'hokkaido')).toEqual([0, 3]);
    expect(aloneSlots(day, 'kyushu')).toEqual([]);
  });
});
