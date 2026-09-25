import { describe, expect, it } from 'vitest';
import {
  aloneSlots,
  areaCurve,
  blockGap,
  blockGapText,
  correctToPrice,
  curveDifference,
  curveSteps,
  findAloneSlots,
  liftDifference,
  priceSplit,
  residualDifference,
  slotSplit,
  type SpotBids,
} from '../src/lib/areaCurves';
import { buyAtOrAbove, buyVolumeAt, crossing, decodeCurveDay, encodeCurveDay, rowsFromSteps, sellAtOrBelow, sellVolumeAt, SYSTEM_GROUP, type CurveGroup, type RawCurveDay } from '../src/lib/bidCurves';
import { CurveStore } from '../src/lib/curveStore';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay, type SlotTarget } from '../src/lib/demoCurves';
import { AREA_KEYS, SERIES_INDEX, SLOTS, type AreaKey } from '../src/lib/series';
import { DataStore } from '../src/lib/store';

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

/** 合成の 1 コマを、保存・読み込みしたときと同じ形（描画用のカーブ）にする */
function slotGroups(target: SlotTarget): CurveGroup[] {
  const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [target]);
  return decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups)))).slots[0]!;
}

const saved = (raw: RawCurveDay, groups?: Parameters<typeof encodeCurveDay>[1]) => decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups))));
const lastOf = (a: ArrayLike<number>) => a[a.length - 1];

describe('間引く前のカーブから求めた「システムプライス − 分断エリアの合計」', () => {
  const base = { tohoku: 12, tokyo: 12, chubu: 9, hokuriku: 9, kansai: 9, chugoku: 9, shikoku: 9 };
  it('市場分断したコマに 1MW 単位で持ち、少ない方の端が 0 になるよう offset を足してある', () => {
    const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [{ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } }]);
    const day = saved(raw, groups);
    const r = day.residuals![0]!;
    expect(r.offset).toBeGreaterThan(0);
    expect(Math.min(r.sell[1], r.buy[1])).toBe(0);
    const m = raw.slots[0];
    const sys = m.get(SYSTEM_GROUP)!;
    const parts = [...m.keys()].filter((k) => k !== SYSTEM_GROUP).map((k) => m.get(k)!);
    const d = residualDifference(r);
    // 残した点では、生のカーブの差と丸めの分（各カーブ 0.5MW）ほどしか違わない
    d.sellPrices.forEach((p, k) => expect(Math.abs(d.sell[k] - (sellAtOrBelow(sys, p) - parts.reduce((v, rows) => v + sellAtOrBelow(rows, p), 0)))).toBeLessThanOrEqual(2));
    d.buyPrices.forEach((p, k) => expect(Math.abs(d.buy[k] - (buyAtOrAbove(sys, p) - parts.reduce((v, rows) => v + buyAtOrAbove(rows, p), 0)))).toBeLessThanOrEqual(2));
    // 分断していないコマには無い
    expect(saved(syntheticCurveDay(dayFromYmd(2025, 5, 3), [{ system: 10, volume: 30000 }]).raw).residuals![0]).toBeNull();
  });

  it('ブロック入札の約定の違いを取引結果から求めて差し引くと、補正しなくても約定価格で交わる', () => {
    const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [{ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } }]);
    // 実データと同じく、システムプライスの計算のほうが売りのブロック入札が 300MW 多く、買いが 500MW 少なく約定したとする
    // （約定したブロック入札は、カーブに価格によらない量で入っている）
    const sys = raw.slots[0].get(SYSTEM_GROUP)!;
    raw.slots[0].set(
      SYSTEM_GROUP,
      sys.map((r, i) => ({ price: r.price, sell: i === 0 ? r.sell : r.sell + 300, buy: r.buy - 500 })),
    );
    const day = saved(raw, groups);
    const gs = day.slots[0]!;
    const system = gs.find((g) => g.id === SYSTEM_GROUP)!;
    // 取引結果: 約定しなかったブロック入札は（市場分断の計算で）売り 5,000MW・買い 800MW
    const spot: SpotBids = {
      sellBid: lastOf(system.sell) + 5000 - 300,
      buyBid: lastOf(system.buy) + 800 + 500,
      sellBlockBid: 6000,
      sellBlockVolume: 1000,
      buyBlockBid: 1000,
      buyBlockVolume: 200,
    };
    expect(blockGap(system, spot)).toEqual({ sell: 300, buy: 500 });
    expect(blockGapText({ sell: 142, buy: 758 })).toBe('システムプライスの計算のほうが、売りが 142 MW 多く、買いが 758 MW 少なく約定');
    expect(blockGapText({ sell: -1652, buy: 0 })).toBe('システムプライスの計算のほうが、売りが 1,652 MW 少なく、買いは同じだけ約定');
    const price = (a: AreaKey) => (a === 'hokkaido' ? 15 : Number.NaN);
    const c = areaCurve(gs, 'hokkaido', price, { spot, residual: day.residuals![0] })!;
    expect([c.kind, c.blocks, c.exact]).toEqual(['single', { sell: 300, buy: 500 }, true]);
    // 合成のカーブは 0.25 円おきの段
    expect(Math.abs(c.rawCrossing! - 15)).toBeLessThanOrEqual(0.25);
    expect(c.correction!.mw).toBeLessThan(50);
    // 取引結果にブロック入札の量が無ければ、約定価格で交わるよう一方に足して合わせる（ブロック入札の違いの分だけ多く足す）
    const without = areaCurve(gs, 'hokkaido', price, { spot: { ...spot, sellBlockBid: Number.NaN }, residual: day.residuals![0] })!;
    expect(without.blocks).toBeUndefined();
    expect(without.correction!.mw).toBeGreaterThan(700);
    // 保存しておいた差が無い（前の版のファイル）ときは、描画用のカーブどうしの差から
    const old = areaCurve(gs, 'hokkaido', price, { spot })!;
    expect([old.exact, old.blocks]).toEqual([false, { sell: 300, buy: 500 }]);
    expect(Math.abs(old.rawCrossing! - 15)).toBeLessThanOrEqual(0.5);
  });

  it('約定価格でもう交わっていれば補正しない', () => {
    const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [{ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } }]);
    const day = saved(raw, groups);
    const probe = areaCurve(day.slots[0]!, 'hokkaido', () => Number.NaN, { residual: day.residuals![0] })!;
    const c = areaCurve(day.slots[0]!, 'hokkaido', (a) => (a === 'hokkaido' ? probe.rawCrossing! : Number.NaN), { residual: day.residuals![0] })!;
    expect(c.correction).toEqual({ side: 'buy', mw: 0, price: probe.rawCrossing });
    expect(f(c.sell)).toEqual(f(probe.sell));
  });
});

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

describe('約定価格から単エリアのコマを探す', () => {
  /** 指定しないエリアは 10 円 */
  const prices = (over: Partial<Record<AreaKey, number>>) => (a: AreaKey) => over[a] ?? 10;
  const singles = (over: Partial<Record<AreaKey, number>>) => priceSplit(prices(over))!.filter((g) => g.length === 1);

  it('連系線でつながったエリアのうち価格が同じものをまとめ、離れたエリアは価格が同じでも別にする', () => {
    expect(priceSplit(prices({}))).toEqual([AREA_KEYS]);
    expect(priceSplit(prices({ hokkaido: 15 }))).toEqual([['hokkaido'], AREA_KEYS.filter((a) => a !== 'hokkaido')]);
    // 北海道と九州がどちらも 0.01 円でも、つながっていないので別々の単エリア
    expect(singles({ hokkaido: 0.01, kyushu: 0.01 })).toEqual([['hokkaido'], ['kyushu']]);
    // 四国と九州は直接つながっていない（中国を通る）
    expect(singles({ shikoku: 0.01, kyushu: 0.01 })).toEqual([['shikoku'], ['kyushu']]);
    // 中国・四国・九州が同じ価格なら、中国を通して 1 つの分断エリア
    expect(priceSplit(prices({ chugoku: 0.01, shikoku: 0.01, kyushu: 0.01 }))!.map((g) => g.length)).toEqual([6, 3]);
    // 東北だけ安いと、北海道はほかとつながらないので、北海道も単エリア
    expect(singles({ tohoku: 8 })).toEqual([['hokkaido'], ['tohoku']]);
    // 価格の分からないエリアがあれば判定しない
    expect(priceSplit(prices({ tokyo: Number.NaN }))).toBeNull();
  });

  it('単エリアが 1 つだけのコマを、日・コマの順に返す（単エリアが 2 つ以上のコマ、単エリアの無い分断は除く）', () => {
    const cases: Record<string, Partial<Record<AreaKey, number>>> = {
      '1:5': { hokkaido: 15 },
      '1:6': { hokkaido: 15, kyushu: 5 },
      '2:3': { kyushu: 0.01 },
      '2:4': { hokkaido: 12, tohoku: 12 },
    };
    const found = findAloneSlots([1, 2], (d, s, a) => prices(cases[`${d}:${s}`] ?? {})(a));
    expect(found).toEqual([
      { day: 1, slot: 5, area: 'hokkaido' },
      { day: 2, slot: 3, area: 'kyushu' },
    ]);
  });

  it('デモの入札カーブの分断エリアから求めた単エリアと一致する', async () => {
    const store = new DataStore();
    store.addDays(generateDemoDays(dayFromYmd(2026, 6, 1), dayFromYmd(2026, 6, 30), 11), 'demo');
    const ds = store.dataset()!;
    const cs = CurveStore.demo(ds)!;
    await cs.ensureDays(cs.days);
    const found = findAloneSlots(cs.days, (d, s, a) => ds.values[SERIES_INDEX[a]][(d - ds.start) * SLOTS + s]);
    const exact = cs.days
      .flatMap((d) => AREA_KEYS.flatMap((area) => aloneSlots(cs.getDay(d)!, area).map((slot) => ({ day: d, slot, area }))))
      .sort((x, y) => x.day - y.day || x.slot - y.slot);
    expect(found.length).toBeGreaterThan(0);
    expect(found).toEqual(exact);
  });

  it('入札の段は、点と点のあいだで増えた量（最初の点は起点なので段にしない）', () => {
    expect(curveSteps([0, 100, 5, 300, 10, 350])).toEqual([
      { price: 5, mw: 200, before: 100 },
      { price: 10, mw: 50, before: 300 },
    ]);
    // 買いは価格の降順の点の並び
    expect(curveSteps([999.99, 300, 10, 500])).toEqual([{ price: 10, mw: 200, before: 300 }]);
    expect(curveSteps([0, 100])).toEqual([]);
  });
});
