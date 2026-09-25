import { describe, expect, it } from 'vitest';
import { aloneSlots, areaCurve, correctToPrice, curveDifference, liftDifference, sameTotal, slotSplit } from '../src/lib/areaCurves';
import { buyVolumeAt, crossing, decodeCurveDay, encodeCurveDay, rowsFromSteps, sellVolumeAt, SYSTEM_GROUP, type CurveGroup } from '../src/lib/bidCurves';
import { dayFromYmd } from '../src/lib/dates';
import { syntheticCurveDay, type SlotTarget } from '../src/lib/demoCurves';
import type { AreaKey } from '../src/lib/series';

const f = (a: ArrayLike<number>) => [...Float64Array.from(a)];

describe('curveDifference・liftDifference', () => {
  const total = { sell: [0, 100, 5, 300, 10, 600], buy: [999.99, 300, 10, 500, 0.01, 700] };
  const part = { sell: [0, 150, 10, 250], buy: [999.99, 400, 10, 450] };

  it('価格の点ごとに差を取る（負にもなる）', () => {
    const d = curveDifference(total, [part]);
    expect(d.sellPrices).toEqual([0, 5, 10]);
    expect(f(d.sell)).toEqual([-50, 150, 350]);
    expect(d.buyPrices).toEqual([0.01, 10, 999.99]);
    expect(f(d.buy)).toEqual([250, 50, -100]);
  });

  it('負のところがあれば、少ない方の端が 0 になるよう売り・買いに同じ量を足す（交点の価格は変わらない）', () => {
    const d = curveDifference(total, [part]);
    const l = liftDifference(d);
    // 最も安い売り −50 と最も高い買い −100 の少ない方（買い）が 0 になるよう 100 を足す
    expect(l.lift).toBe(100);
    expect(f(l.sell)).toEqual([0, 50, 5, 250, 10, 450]);
    // 最も高い価格の買いは 0 になるので点にしない
    expect(f(l.buy)).toEqual([10, 150, 0.01, 350]);
    expect([l.sellRange, l.buyRange]).toEqual([400, 350]);
    const rows = d.sellPrices.map((price, k) => ({ price, sell: d.sell[k], buy: d.buy[k] }));
    expect(crossing(rowsFromSteps(l.sell, l.buy))!.price).toBe(rows.find((r) => r.sell >= r.buy)!.price);
  });

  it('途中で減るところは前の量のまま。負のところが無ければ足さない', () => {
    const l = liftDifference(curveDifference({ sell: [0, 100, 5, 120], buy: [] }, [{ sell: [0, 10, 5, 60], buy: [] }]));
    expect([l.lift, f(l.sell), l.sellRange]).toEqual([0, [0, 90], 0]);
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

it('システムプライスのカーブの合計と取引結果の入札量は 1MW 以内なら同じとみなす', () => {
  expect([sameTotal(44731, 44730.8), sameTotal(44731, 44729.9), sameTotal(44731, 44729.5)]).toEqual([true, false, false]);
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

  it('単エリアが 1 つなら、システムプライスから分断エリアを引いて売り・買いに同じ量を足し、約定価格で交わるように補正する', () => {
    const gs = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } });
    const split = slotSplit(gs);
    expect(split.kind === 'split' && split.singles).toEqual(['hokkaido']);
    const prices: Partial<Record<AreaKey, number>> = { hokkaido: 15.2 };
    const c = areaCurve(gs, 'hokkaido', (a) => prices[a] ?? Number.NaN)!;
    expect([c.kind, c.label, c.subtracted]).toEqual(['single', '北海道', ['東北・東京', '中部・北陸・関西・中国・四国・九州']]);
    // 分断エリアのカーブには連系線でやりとりする量が入っているので、公表されている分断エリアの合計はシステムプライスより多く、
    // 引くと売り・買いとも負になる。同じ量を足して、少ない方の端を 0 にする
    const t = c.totals!;
    expect(t.publishedBuy).toBeGreaterThan(t.systemBuy);
    expect(c.lift).toBeGreaterThan(1000);
    expect(Math.min(sellVolumeAt(c.sell, 0), buyVolumeAt(c.buy, 999.99))).toBeLessThanOrEqual(c.correction!.mw);
    // 引いて足しただけで、ほぼ約定価格で交わる（合成のカーブは 0.25 円おきの段）ので、補正はわずか
    expect(Math.abs(c.rawCrossing! - 15.2)).toBeLessThanOrEqual(0.25);
    expect(c.correction).toMatchObject({ price: 15.2 });
    expect(c.correction!.mw).toBeLessThan(50);
    // 約定価格で売りと買いが同じ量になる
    expect(Math.abs(sellVolumeAt(c.sell, 15.2) - buyVolumeAt(c.buy, 15.2))).toBeLessThanOrEqual(1);
    const x = crossing(rowsFromSteps(c.sell, c.buy))!.price;
    expect(x).toBeLessThanOrEqual(15.2);
    expect(x).toBeGreaterThanOrEqual(15.2 - 0.25);
    // 約定価格が分からなければ補正しない
    const raw = areaCurve(gs, 'hokkaido', () => Number.NaN)!;
    expect([raw.kind, raw.correction, raw.rawCrossing]).toEqual(['single', undefined, c.rawCrossing]);
  });

  it('単エリアが複数なら、合わせたカーブにする（補正なし）', () => {
    const gs = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 5 } });
    const c = areaCurve(gs, 'kyushu', () => 5)!;
    expect([c.kind, c.label, c.areas, c.correction]).toEqual(['combined', '北海道・九州', ['hokkaido', 'kyushu'], undefined]);
    expect(c.sell.length).toBeGreaterThan(0);
    expect(c.lift).toBeGreaterThan(0);
  });

  it('引いた差が価格によらずほぼ一定（単エリアの入札の形が残らない）なら推定できないとする', () => {
    const gs0 = slotGroups({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9, shikoku: 5 } });
    const system = gs0.find((g) => g.id === SYSTEM_GROUP)!;
    const rest: AreaKey[] = ['hokkaido', 'tohoku', 'tokyo', 'chubu', 'hokuriku', 'kansai', 'chugoku', 'kyushu'];
    const label = '北海道・東北・東京・中部・北陸・関西・中国・九州';
    const total = (a: Float64Array) => a[a.length - 1];
    // 四国以外のまとまりとして、システムプライスと同じカーブが公表されている（分断エリアのカーブに四国の入札も入っている）
    const same: CurveGroup[] = [system, { id: 0, label, areas: rest, sell: system.sell, buy: system.buy }];
    const c = areaCurve(same, 'shikoku', () => 8.74)!;
    expect(c.kind).toBe('unavailable');
    expect([c.sell.length, c.buy.length, c.label]).toEqual([0, 0, '四国']);
    expect(c.totals).toEqual({ systemSell: total(system.sell), systemBuy: total(system.buy), publishedSell: total(system.sell), publishedBuy: total(system.buy) });
    // システムプライスのカーブに四国の入札が入っておらず、分断エリアのカーブに連系線の量が入っているとき（差は価格によらない量）
    const plus = (steps: Float64Array) => steps.map((v, i) => (i % 2 ? v + 2000 : v));
    const excluded: CurveGroup[] = [system, { id: 0, label, areas: rest, sell: plus(system.sell), buy: plus(system.buy) }];
    const c2 = areaCurve(excluded, 'shikoku', () => 8.74)!;
    expect(c2.kind).toBe('unavailable');
    expect(c2.totals!.publishedBuy - c2.totals!.systemBuy).toBe(2000);
    // 分断エリアに入るエリアは、これまでどおりそのカーブ
    expect(areaCurve(same, 'tokyo', () => 10)!.kind).toBe('group');
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
