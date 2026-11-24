import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { IntertieStore } from '../src/lib/intertieStore';
import { encodeIntertieFy, INTERTIE_FIELD_INDEX, INTERTIE_INDEX, intertieOffset, newIntertieDay } from '../src/lib/occto';
import { SLOTS } from '../src/lib/series';
import { DataStore } from '../src/lib/store';
import {
  decodeRightsFile,
  encodeRightsFile,
  estimateCancellation,
  isRightsCsv,
  parseRightsCsv,
  RIGHTS_ESTIMATE_FROM,
  RIGHTS_FILE,
  rightsLink,
  rightsSpan,
  rightsVolumes,
  type RightsProduct,
} from '../src/lib/transmissionRights';
import { rightsNotes } from '../src/views/interties';

/** JEPX「間接送電権市場」の取引結果の CSV（2026 年度の形。週間商品と年間商品、約定しなかった商品、読めない行） */
const CSV = toCsv([
  ['商品名', '説明', '方向', '約定日', '対象期間(自)', '対象期間(至)', '売り入札量(MW)', '約定価格(円/kWh)', '約定量(MW)'],
  ['26W23T43', '6月1週ＦＣ[逆]', '中部 -> 東京', '2026/04/22', '2026/05/30', '2026/06/05', '1200.0', '0.75', '1200.0'],
  ['26W23T34', '6月1週ＦＣ(順)', '東京 -> 中部', '2026/04/22', '2026/05/30', '2026/06/05', '1200.0', '-', '-'],
  ['26W23T76', '6月1週関中[逆]', '中国->関西', '2026/04/22', '2026/05/30', '2026/06/05', '4000.0', '0.04', '1,500.0'],
  ['Y271T43', '2027年度ＦＣ[逆]第一回', '?', '2026/09/18', '2027/04/01', '2028/03/31', '600.0', '0.50', '300.0'],
  ['26W24T43', '6月2週ＦＣ[逆]', '中部 -> 東京', '日付なし', '2026/06/06', '2026/06/12', '1200.0', '0.80', '900.0'],
]);

const product = (p: Partial<RightsProduct>): RightsProduct => ({
  code: 'x',
  label: '',
  from: 'chubu',
  to: 'tokyo',
  tradeDay: 0,
  first: 0,
  last: 0,
  offer: 0,
  price: null,
  volume: null,
  ...p,
});

describe('間接送電権の取引結果', () => {
  it('JEPX の CSV を読む（約定しなかった商品は null、方向が読めなければ商品名から、読めない行は飛ばす）', () => {
    expect(isRightsCsv(`﻿${CSV}`)).toBe(true);
    expect(isRightsCsv('対象断面,策定日\r\n')).toBe(false);
    const { products, skipped } = parseRightsCsv(`﻿${CSV}`);
    expect(skipped).toBe(1);
    expect(products.map((p) => [p.code, p.from, p.to, p.price, p.volume])).toEqual([
      ['26W23T43', 'chubu', 'tokyo', 0.75, 1200],
      ['26W23T34', 'tokyo', 'chubu', null, null],
      ['26W23T76', 'chugoku', 'kansai', 0.04, 1500],
      ['Y271T43', 'chubu', 'tokyo', 0.5, 300],
    ]);
    expect(products[0]).toMatchObject({ label: '6月1週ＦＣ[逆]', tradeDay: dayFromYmd(2026, 4, 22), first: dayFromYmd(2026, 5, 30), last: dayFromYmd(2026, 6, 5), offer: 1200 });
    expect(() => parseRightsCsv('a,b\r\n1,2\r\n')).toThrow(/間接送電権/);
  });

  it('ファイルに書いて読み戻せる（形式の違うファイルは読まない）', () => {
    const { products } = parseRightsCsv(CSV);
    const json = JSON.parse(JSON.stringify(encodeRightsFile(new Map([[2026, products]]))));
    expect(decodeRightsFile(json)).toEqual(new Map([[2026, products]]));
    expect(() => decodeRightsFile({ format: 'other' })).toThrow();
    expect(rightsSpan(products)).toEqual([dayFromYmd(2026, 5, 30), dayFromYmd(2028, 3, 31)]);
    expect(rightsSpan([])).toBeNull();
    expect(RIGHTS_FILE).toBe('interties/transmission-rights.json');
  });

  it('値差をとる向きを、連系線とその上の向きに対応づける', () => {
    expect(rightsLink('tokyo', 'chubu')).toEqual({ line: 'tokyoChubu', dir: 1 });
    expect(rightsLink('chubu', 'tokyo')).toEqual({ line: 'tokyoChubu', dir: -1 });
    expect(rightsLink('tohoku', 'hokkaido')).toEqual({ line: 'hokkaidoHonshu', dir: -1 });
    // 関西-中国間は、内訳の東・西ではなく全体
    expect(rightsLink('chugoku', 'kansai')).toEqual({ line: 'kansaiChugoku', dir: -1 });
    expect(rightsLink('kyushu', 'chugoku')).toEqual({ line: 'chugokuKyushu', dir: -1 });
    expect(rightsLink('hokkaido', 'kyushu')).toBeNull();
  });

  it('連系線の向きごとに、その日に有効な商品の約定量を足す（約定しなかった商品は 0、商品の無い日は NaN）', () => {
    const d0 = dayFromYmd(2026, 5, 29);
    const ps = [
      product({ from: 'chubu', to: 'tokyo', first: d0 + 1, last: d0 + 7, volume: 1200 }),
      product({ from: 'chubu', to: 'tokyo', first: d0 + 3, last: d0 + 400, volume: 300 }),
      product({ from: 'tokyo', to: 'chubu', first: d0 + 1, last: d0 + 7, volume: null }),
      product({ from: 'shikoku', to: 'chugoku', first: d0, last: d0 + 7, volume: 50 }),
    ];
    const v = rightsVolumes(ps, d0, 10, 'tokyoChubu');
    const at = (a: Float64Array | null, day: number, slot = 0) => a![(day - d0) * SLOTS + slot];
    expect(Number.isNaN(at(v.rev, d0))).toBe(true);
    expect([at(v.rev, d0 + 1), at(v.rev, d0 + 3, 47), at(v.rev, d0 + 8)]).toEqual([1200, 1500, 300]);
    expect([at(v.fwd, d0 + 1), Number.isNaN(at(v.fwd, d0 + 8))]).toEqual([0, true]);
    expect(rightsVolumes(ps, d0, 10, 'chugokuShikoku')).toMatchObject({ fwd: null });
    expect(rightsVolumes(ps, d0, 10, 'tohokuTokyo')).toEqual({ fwd: null, rev: null });
  });

  it('推定キャンセル量は、約定量のうち「運用容量 − その日の最小のマージン」を超える分（2026 年 4 月 1 日受渡分から）', () => {
    const start = RIGHTS_ESTIMATE_FROM - 1;
    const n = 3 * SLOTS;
    const volume = new Float64Array(n).fill(1200);
    // 逆方向: 運用容量 −2700、マージン 600（上限 −2100）
    const capacity = new Float64Array(n).fill(-2700);
    const limit = new Float64Array(n).fill(-2100);
    // 運用容量が下がったコマ（運用容量 − マージン = 900）
    capacity[SLOTS + 1] = -1500;
    limit[SLOTS + 1] = -900;
    // スポット市場のあとにマージンを積み増したコマ（上限 0）は、その日の最小のマージン（600）で比べる
    limit[SLOTS + 2] = 0;
    capacity[SLOTS + 3] = Number.NaN;
    volume[SLOTS + 4] = Number.NaN;
    capacity[SLOTS + 5] = -1799.96;
    limit[SLOTS + 5] = -1199.96;
    capacity[1] = -900;
    const c = estimateCancellation(volume, capacity, limit, -1, start);
    // 2026 年 3 月 31 日は求めない
    expect(Number.isNaN(c[1])).toBe(true);
    expect([c[SLOTS], c[SLOTS + 1], c[SLOTS + 2], c[SLOTS + 5]]).toEqual([0, 300, 0, 0]);
    expect([Number.isNaN(c[SLOTS + 3]), Number.isNaN(c[SLOTS + 4])]).toEqual([true, true]);
    // 順方向は、正の運用容量と比べる。運用容量が負なら 0 と比べる
    expect(estimateCancellation(new Float64Array([500]), new Float64Array([500]), new Float64Array([400]), 1, RIGHTS_ESTIMATE_FROM)[0]).toBe(100);
    expect(estimateCancellation(new Float64Array([500]), new Float64Array([-50]), new Float64Array([-50]), 1, RIGHTS_ESTIMATE_FROM)[0]).toBe(500);
  });

  it('推移の図の注記: 推定の方法と、推定していない期間、この期間の推定キャンセル量', () => {
    expect(rightsNotes({ shown: 0, estimated: false, before: false, cancelSlots: 0, cancelMwh: 0 })).toEqual([]);
    const both = rightsNotes({ shown: 1, estimated: true, before: true, cancelSlots: 12, cancelMwh: 1800 });
    expect(both[0]).toContain('塗った帯は推定キャンセル量');
    expect(both[1]).toContain('取引規程第 87 条');
    expect(both[1]).toContain('その日の最小のマージン');
    expect(both[2]).toContain('2026 年 4 月 1 日受渡分から');
    expect(both[3]).toBe('この期間の推定キャンセル量は 12 コマ、合計 1,800 MWh です。');
    // 推定した期間が無ければ、帯と推定の方法は書かない
    const none = rightsNotes({ shown: 1, estimated: false, before: true, cancelSlots: 0, cancelMwh: 0 });
    expect(none).toHaveLength(2);
    expect(none[0]).not.toContain('帯');
    expect(none[1]).toContain('推定キャンセル量は求めていません');
    expect(rightsNotes({ shown: 2, estimated: true, before: false, cancelSlots: 0, cancelMwh: 0 })[2]).toBe('この期間に推定キャンセル量はありません。');
  });
});

describe('連系線のデータと一緒に読む間接送電権', () => {
  const day = dayFromYmd(2026, 6, 1);
  const tieDay = () => {
    const v = newIntertieDay();
    const put = (f: keyof typeof INTERTIE_FIELD_INDEX, s: number, x: number) => (v[intertieOffset(INTERTIE_INDEX.tokyoChubu, INTERTIE_FIELD_INDEX[f], s)] = x);
    for (let s = 0; s < SLOTS; s++) {
      put('plan', s, -900);
      put('capFwd', s, 2700);
      put('limFwd', s, 2100);
      // 逆方向は、最初の 10 コマだけ運用容量が下がる（マージン 600）
      put('capRev', s, s < 10 ? -1500 : -2700);
      put('limRev', s, s < 10 ? -900 : -2100);
    }
    return v;
  };
  const index = { firstDate: '2026-06-01', lastDate: '2026-06-01', files: [{ fy: 2026, file: 'interties/fy2026.json', firstDate: '2026-06-01', lastDate: '2026-06-01', days: 1 }] };
  const rightsIndex = { file: RIGHTS_FILE, firstDate: '2026-05-30', lastDate: '2028-03-31', products: 4 };
  const dataset = () => {
    const ds = new DataStore();
    ds.addDays(generateDemoDays(day, day + 1, 1), 'bundled');
    return ds.dataset()!;
  };

  it('最初に連系線を読み込むときに一緒に読み、向きごとの約定量と推定キャンセル量を返す', async () => {
    const files: Record<string, unknown> = {
      'interties/fy2026.json': JSON.parse(JSON.stringify(encodeIntertieFy(2026, new Map([[day, tieDay()]])))),
      [RIGHTS_FILE]: JSON.parse(JSON.stringify(encodeRightsFile(new Map([[2026, parseRightsCsv(CSV).products]])))),
    };
    const reads: string[] = [];
    const st = IntertieStore.fromIndex(index, async (f) => (reads.push(f), files[f]), rightsIndex)!;
    expect(st.hasRights).toBe(true);
    await st.ensure(day, day);
    expect(reads.sort()).toEqual(['interties/fy2026.json', RIGHTS_FILE]);
    const ds = dataset();
    const { fwd, rev } = st.rightsOf(ds, 'tokyoChubu');
    const k = (day - ds.start) * SLOTS;
    expect([rev!.volume[k], rev!.cancel[k], rev!.cancel[k + 10]]).toEqual([1200, 300, 0]);
    expect([fwd!.volume[k], fwd!.cancel[k]]).toEqual([0, 0]);
    // 読み込み済みなら読み直さない
    expect(st.ensure(day, day)).toBeNull();
  });

  it('間接送電権を読み込めなくても、連系線の値は読み、理由を残す（取得していなければ hasRights は false）', async () => {
    const tie = JSON.parse(JSON.stringify(encodeIntertieFy(2026, new Map([[day, tieDay()]]))));
    const st = IntertieStore.fromIndex(
      index,
      async (f) => {
        if (f === RIGHTS_FILE) throw new Error('HTTP 404');
        return tie;
      },
      rightsIndex,
    )!;
    await st.ensure(day, day);
    expect(st.rightsError).toBe('HTTP 404');
    const ds = dataset();
    expect(st.valueAt(ds, day, 0, 'tokyoChubu', 'plan')).toBe(-900);
    expect(st.rightsOf(ds, 'tokyoChubu')).toEqual({ fwd: null, rev: null });
    expect(IntertieStore.fromIndex(index, async () => tie)!.hasRights).toBe(false);
  });
});
