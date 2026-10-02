import { describe, expect, it } from 'vitest';
import { priceSplit, type SpotBids } from '../src/lib/areaCurves';
import {
  addGroupTotals,
  decodeCurveDay,
  decodeCurveGroups,
  encodeCurveDay,
  encodeCurveMetrics,
  groupTotalsOf,
  groupTotalsOfDay,
  metricsOfDayFile,
  parseBidCurveCsv,
  SYSTEM_GROUP,
} from '../src/lib/bidCurves';
import { dayFromYmd } from '../src/lib/dates';
import { syntheticCurveDay } from '../src/lib/demoCurves';
import { boundaryFlow, boundaryName, groupName, signedFlow, type BoundaryFlow } from '../src/lib/interties';
import { SLOTS, type AreaKey } from '../src/lib/series';

/** 1 コマ目がシステムプライスと分断エリア 1、2 コマ目は分断していない入札カーブ */
const BID_CSV = `電力受渡日,商品コード,入札価格(円/kWh),売入札量累積(MW),買入札量累積(MW),分断エリア連番
20260925,1,0.00,0.0,49366.6,
20260925,1,0.01,35177.9,49366.6,
20260925,1,1.00,36134.5,49225.9,
20260925,1,0.00,0.0,32884.0,1
20260925,1,0.00,10840.3,32884.0,1
20260925,1,0.01,20313.2,32884.0,1
20260925,2,0.00,0.0,48000.0,
20260925,2,0.01,30000.0,47000.0,
`;

const prices = (p: Partial<Record<AreaKey, number>>, rest: number) => (a: AreaKey) => p[a] ?? rest;

describe('分断エリアのカーブの入札量の合計', () => {
  const day = dayFromYmd(2026, 9, 25);
  const raw = parseBidCurveCsv(BID_CSV).get(day)!;

  it('間引く前のカーブから求めて日のファイルに入れ、前の版のファイルでは描画用のカーブの合計（1 MW 単位）を使う', () => {
    const file = JSON.parse(JSON.stringify(encodeCurveDay(raw)));
    expect(file.slots[0].totals).toEqual([20313.2, 32884]);
    expect(file.slots[1].totals).toBeUndefined();
    const back = decodeCurveDay(file);
    expect(groupTotalsOf(back, 0)).toEqual({ sell: 20313.2, buy: 32884, count: 1, exact: true });
    expect(groupTotalsOf(back, 1)).toBeNull();
    // 前の版のファイル
    delete file.slots[0].totals;
    expect(groupTotalsOf(decodeCurveDay(file), 0)).toEqual({ sell: 20313, buy: 32884, count: 1, exact: false });
    // 入札カーブを取り直したときに足す（足した後は変えない）
    expect(addGroupTotals(file, raw)).toBe(true);
    expect(file.slots[0].totals).toEqual([20313.2, 32884]);
    expect(addGroupTotals(file, raw)).toBe(false);
  });

  it('指標の年度ファイルにも、日 × コマの売り・買い・数として入れて読み戻せる', () => {
    const file = encodeCurveDay(raw);
    const groups = groupTotalsOfDay(decodeCurveDay(file));
    const json = JSON.parse(JSON.stringify(encodeCurveMetrics(2026, new Map([[day, metricsOfDayFile(file)]]), undefined, new Map([[day, groups]]))));
    expect(json.groups).toHaveLength(3);
    const back = decodeCurveGroups(json).get(day)!;
    expect([back[0], back[SLOTS], back[2 * SLOTS]]).toEqual([20313.2, 32884, 1]);
    expect(Number.isNaN(back[1])).toBe(true);
    // 分断したコマが無ければ入れない
    const none = JSON.parse(JSON.stringify(encodeCurveMetrics(2026, new Map([[day, metricsOfDayFile(file)]]))));
    expect(none.groups).toBeUndefined();
    expect(decodeCurveGroups(none).size).toBe(0);
  });
});

describe('連系線の量（分断エリアのカーブと取引結果から）', () => {
  // 東（北海道・東北・東京）12 円、西 9 円で 2 つに分断
  const eastWest = prices({ hokkaido: 12, tohoku: 12, tokyo: 12 }, 9);
  const published = { sell: 40000, buy: 41000, count: 2 };
  const spot = (extra: Partial<SpotBids> = {}): SpotBids => ({
    sellBid: 38000,
    sellBlockBid: 1000,
    sellBlockVolume: 400,
    buyBid: 38900,
    buyBlockBid: 800,
    buyBlockVolume: 300,
    ...extra,
  });

  it('分断エリアのカーブの合計 − （取引結果の入札量 − 約定しなかったブロック入札）を、売りと買いから求める', () => {
    const f = boundaryFlow({ groups: priceSplit(eastWest), price: eastWest, published, spot: spot() }) as BoundaryFlow;
    // 売り: 40000 − (38000 − 600) = 2600、買い: 41000 − (38900 − 500) = 2600
    expect([f.kind, f.sell, f.buy, f.mw]).toEqual(['pair', 2600, 2600, 2600]);
    // 価格の安い西から高い東へ。北海道を含む側から流れるときを正にする
    expect(f.from).toContain('kyushu');
    expect(f.to).toEqual(['hokkaido', 'tohoku', 'tokyo']);
    expect(signedFlow(f)).toBe(-2600);
    expect(boundaryName(f.groups)).toBe('北海道〜東京 と 中部〜九州');
  });

  it('求められないコマは理由を返し、市場分断していないコマは null', () => {
    const one = prices({}, 10);
    expect(boundaryFlow({ groups: priceSplit(one), price: one, published, spot: spot() })).toBeNull();
    // 単エリア（北海道だけ）がある
    const single = prices({ hokkaido: 20 }, 10);
    expect(boundaryFlow({ groups: priceSplit(single), price: single, published: { ...published, count: 1 }, spot: spot() })).toBe('single');
    expect(boundaryFlow({ groups: priceSplit(eastWest), price: eastWest, published: { ...published, count: 3 }, spot: spot() })).toBe('groups');
    expect(boundaryFlow({ groups: priceSplit(eastWest), price: eastWest, published, spot: spot({ sellBlockBid: Number.NaN }) })).toBe('blocks');
    expect(boundaryFlow({ groups: priceSplit(eastWest), price: eastWest, published, spot: spot({ buyBid: 39500 }) })).toBe('mismatch');
  });

  it('3 つ以上に分かれたコマは、すべての境の量の合計', () => {
    const three = prices({ hokkaido: 10, tohoku: 10, tokyo: 20, chubu: 20 }, 15);
    const groups = priceSplit(three)!;
    expect(groups).toHaveLength(3);
    const f = boundaryFlow({ groups, price: three, published: { ...published, count: 3 }, spot: spot() }) as BoundaryFlow;
    expect([f.kind, f.mw]).toEqual(['many', 2600]);
  });

  it('デモの合成カーブ（取引結果と別に作ったもの）は、システムプライスのカーブとの差から求める', () => {
    const day = dayFromYmd(2025, 5, 3);
    const { raw, groups } = syntheticCurveDay(day, [{ system: 10, volume: 30000, east: 12, west: 9 }]);
    const cd = decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups))));
    const sys = cd.slots[0]!.find((g) => g.id === SYSTEM_GROUP)!;
    const last = (a: Float64Array) => a[a.length - 1];
    const f = boundaryFlow({
      groups: priceSplit(eastWest),
      price: eastWest,
      published: groupTotalsOf(cd, 0),
      spot: null,
      system: { sell: last(sys.sell), buy: last(sys.buy) },
    }) as BoundaryFlow;
    // 合成のカーブでやりとりする量は約定量の 8%（描画用のカーブの合計は 1 MW 単位）
    expect(f.kind).toBe('pair');
    expect(Math.abs(f.mw - 30000 * 0.08)).toBeLessThanOrEqual(1);
  });

  it('分断エリアの短い名前（続いている 3 エリア以上は「〜」でつなぐ）', () => {
    expect(groupName(['hokkaido', 'tohoku', 'tokyo', 'chubu'])).toBe('北海道〜中部');
    expect(groupName(['hokkaido', 'tohoku'])).toBe('北海道・東北');
    expect(groupName(['chubu', 'kansai', 'chugoku'])).toBe('中部・関西・中国');
  });
});
