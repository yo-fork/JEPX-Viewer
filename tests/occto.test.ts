import { describe, expect, it } from 'vitest';
import { toCsv } from '../src/lib/csv';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { IntertieStore } from '../src/lib/intertieStore';
import {
  areaNetImports,
  atLimit,
  crossingFlows,
  decodeIntertieFy,
  encodeIntertieFy,
  hasIntertieFields,
  INTERTIE_FIELD_INDEX,
  INTERTIE_INDEX,
  intertieOffset,
  intertieTitle,
  mergeIntertieDays,
  newIntertieDay,
  occtoCsvKind,
  parseOcctoCsv,
  PLAN_FIELDS,
  type IntertieField,
  type IntertieKey,
} from '../src/lib/occto';
import { SERIES_INDEX, SLOTS, type AreaKey } from '../src/lib/series';
import { coverageNotes, type LineCoverage } from '../src/views/interties';
import { DataStore } from '../src/lib/store';

/** 連系線空容量（翌日）の CSV（広域機関の形。2 コマ分と、知らない連系線） */
const PLAN_CSV = toCsv([
  ['対象断面', '策定日', '策定／更新後', '連系線', '年月日', '時刻', '方向', '空容量', '計画潮流', '広域調整枠', 'マージン', '運用容量', '運用容量決定要因', '最新更新年月日時刻'],
  ['翌日', '20260920', '策定', '相馬双葉幹線', '2026/09/21', '00:30', '順方向', '95.1', '5344.9', '0', '110', '5550', '熱容量（作業）', '2026/09/20 16:50:08'],
  ['翌日', '20260920', '策定', '相馬双葉幹線', '2026/09/21', '00:30', '逆方向', '-7662.9', '5344.9', '0', '-42', '-2360', '熱容量', '2026/09/20 16:50:08'],
  ['翌日', '20260920', '策定', '相馬双葉幹線', '2026/09/21', '24:00', '順方向', '0', '5550', '0', '0', '5550', '熱容量', '2026/09/20 16:50:08'],
  ['翌日', '20260920', '策定', '相馬双葉幹線', '2026/09/21', '24:00', '逆方向', '-7910', '5550', '0', '0', '-2360', '熱容量', '2026/09/20 16:50:08'],
  ['翌日', '20260920', '策定', '新しい連系線', '2026/09/21', '00:30', '順方向', '0', '0', '0', '0', '100', '熱容量', '2026/09/20 16:50:08'],
]);

/** 連系線潮流実績の CSV（5 分ごと。最初のコマの 6 行と、最後のコマの 1 行） */
const FLOW_CSV = toCsv([
  ['連系線', '対象日付', '対象時刻', '運用容量(順方向)', '運用容量(逆方向)', '広域調整枠(順方向)', '広域調整枠(逆方向)', 'マージン(順方向)', 'マージン(逆方向)', '空容量(順方向)', '空容量(逆方向)', '計画潮流(順方向)', '計画潮流(逆方向)', '潮流実績', '運用容量拡大分(順方向)', '運用容量拡大分(逆方向)'],
  ...['00:05', '00:10', '00:15', '00:20', '00:25', '00:30'].map((t, i) => ['中部フェンス', '2026/09/06', t, 2280, -2610, 0, 0, 353.702, 0, 4483.598, -52.7, -2557.3, -2557.3, -2570 + i * 4, 0, 0]),
  ['中部フェンス', '2026/09/06', '24:00', 2580, -3010, 0, 0, 176.484, 0, 5168.316, -245.2, -2764.8, -2764.8, -2859, 0, 0],
]);

const at = (vals: Float64Array, key: IntertieKey, field: IntertieField, slot: number) => vals[intertieOffset(INTERTIE_INDEX[key], INTERTIE_FIELD_INDEX[field], slot)];

describe('広域機関の連系線の CSV', () => {
  it('列名で種類を見分ける', () => {
    expect(occtoCsvKind(PLAN_CSV)).toBe('plan');
    expect(occtoCsvKind(FLOW_CSV)).toBe('flow');
    expect(occtoCsvKind('受渡日,時刻コード,システムプライス\n')).toBeNull();
    expect(() => parseOcctoCsv('a,b\n1,2\n')).toThrow(/広域機関/);
  });

  it('翌日の CSV: 計画潮流と、上限（運用容量 − マージン − 広域調整枠）・運用容量を、向きごとに 30 分のコマへ入れる', () => {
    const res = parseOcctoCsv(PLAN_CSV);
    const day = dayFromYmd(2026, 9, 21);
    expect([res.kind, res.firstDay, res.lastDay, res.unknown]).toEqual(['plan', day, day, ['新しい連系線']]);
    const v = res.days.get(day)!;
    // 「00:30」は 0:00〜0:30 のコマ、「24:00」は 23:30〜24:00 のコマ
    expect([at(v, 'tohokuTokyo', 'plan', 0), at(v, 'tohokuTokyo', 'limFwd', 0), at(v, 'tohokuTokyo', 'limRev', 0)]).toEqual([5344.9, 5440, -2318]);
    expect([at(v, 'tohokuTokyo', 'capFwd', 0), at(v, 'tohokuTokyo', 'capRev', 0)]).toEqual([5550, -2360]);
    expect(at(v, 'tohokuTokyo', 'plan', 47)).toBe(5550);
    expect(Number.isNaN(at(v, 'tohokuTokyo', 'plan', 1))).toBe(true);
    expect(Number.isNaN(at(v, 'tohokuTokyo', 'actual', 0))).toBe(true);
  });

  it('潮流実績の CSV: 5 分ごとの値を 30 分のコマの平均にする（そのときの計画潮流も）', () => {
    const res = parseOcctoCsv(FLOW_CSV);
    const v = res.days.get(dayFromYmd(2026, 9, 6))!;
    expect(at(v, 'chubuFence', 'actual', 0)).toBe(-2560);
    expect(at(v, 'chubuFence', 'planFinal', 0)).toBe(-2557.3);
    expect([at(v, 'chubuFence', 'actual', 47), at(v, 'chubuFence', 'planFinal', 47)]).toEqual([-2859, -2764.8]);
    expect(Number.isNaN(at(v, 'chubuFence', 'plan', 0))).toBe(true);
  });

  it('年度ファイルに入れて読み戻し、種類を指定して重ねるとほかの種類は残す', () => {
    const plan = parseOcctoCsv(PLAN_CSV).days;
    const day = dayFromYmd(2026, 9, 21);
    const back = decodeIntertieFy(JSON.parse(JSON.stringify(encodeIntertieFy(2026, plan))));
    expect(at(back.get(day)!, 'tohokuTokyo', 'limRev', 0)).toBe(-2318);
    const into = new Map([[day, newIntertieDay()]]);
    into.get(day)![intertieOffset(INTERTIE_INDEX.tohokuTokyo, INTERTIE_FIELD_INDEX.actual, 0)] = 5300;
    expect(mergeIntertieDays(into, plan, PLAN_FIELDS)).toBe(1);
    expect([at(into.get(day)!, 'tohokuTokyo', 'plan', 0), at(into.get(day)!, 'tohokuTokyo', 'actual', 0)]).toEqual([5344.9, 5300]);
    expect(hasIntertieFields(into.get(day), ['plan'])).toBe(true);
    expect(hasIntertieFields(newIntertieDay(), ['plan'])).toBe(false);
    expect(() => decodeIntertieFy({ format: 'x' })).toThrow(/形式が不正/);
  });

  it('計画潮流が上限に達したか（上限が 0 の向きは、流せないだけなので数えない）', () => {
    expect(atLimit(5440, 5440, -2318)).toBe(1);
    expect(atLimit(5439.6, 5440, -2318)).toBe(1);
    expect(atLimit(-2318, 5440, -2318)).toBe(-1);
    expect(atLimit(1000, 5440, -2318)).toBe(0);
    expect(atLimit(0, 280, 0)).toBe(0);
    expect(Number.isNaN(atLimit(Number.NaN, 1, -1))).toBe(true);
  });
});

describe('連系線の名前', () => {
  it('区間の名前のあとに設備の名前を並べる（フェンスと関西-中国間の内訳は区間の名前だけ）', () => {
    expect(intertieTitle('kansaiShikoku')).toBe('関西-四国間（阿南紀北直流幹線）');
    expect(intertieTitle('tokyoChubu')).toBe('東京-中部間（周波数変換設備）');
    expect(intertieTitle('chubuFence')).toBe('中部-北陸・関西間（中部フェンス）');
    expect(intertieTitle('kansaiChugokuEast')).toBe('関西-中国間（東）');
  });
});

describe('市場分断の境をまたぐ連系線', () => {
  const east = ['hokkaido', 'tohoku'] as AreaKey[];
  const rest = ['tokyo', 'chubu', 'hokuriku', 'kansai', 'chugoku', 'shikoku', 'kyushu'] as AreaKey[];
  const plans = (v: Partial<Record<IntertieKey, number>>) => (k: IntertieKey) => v[k] ?? Number.NaN;

  it('両側のエリアがそれぞれ 1 つのまとまりに入る連系線だけ（関西-中国間の内訳は重ねない）', () => {
    const got = crossingFlows([east, rest], plans({ tohokuTokyo: 5550, hokkaidoHonshu: 300, tokyoChubu: 900, kansaiChugoku: -4000, kansaiChugokuEast: -2000 }));
    expect(got).toEqual([{ key: 'tohokuTokyo', plan: 5550, fromGroup: 0, toGroup: 1 }]);
    const west = crossingFlows([[...east, 'tokyo', 'chubu', 'hokuriku', 'kansai'], ['chugoku', 'shikoku', 'kyushu']], plans({ kansaiChugoku: -4000, kansaiChugokuEast: -2000, kansaiShikoku: -600 }));
    expect(west.map((c) => c.key)).toEqual(['kansaiChugoku', 'kansaiShikoku']);
  });

  it('中地域は、個別の連系線の値があればそれを、無ければフェンスを使う', () => {
    const groups = [[...east, 'tokyo', 'chubu'], ['hokuriku', 'kansai', 'chugoku', 'shikoku', 'kyushu']] as AreaKey[][];
    expect(crossingFlows(groups, plans({ chubuFence: -3010 })).map((c) => [c.key, c.plan])).toEqual([['chubuFence', -3010]]);
    // 2026 年 3 月より前（個別の連系線の計画潮流がある）は、北陸フェンスなどと重ねない
    const old = crossingFlows(groups, plans({ chubuKansai: -2000, chubuHokuriku: -300, hokurikuFence: 100, chubuFence: -2300 }));
    expect(old.map((c) => c.key)).toEqual(['chubuKansai', 'chubuHokuriku']);
  });
});

/** 中地域の外の連系線の計画潮流（試験用。負は逆方向） */
const OUTER_PLANS: Partial<Record<IntertieKey, number>> = {
  hokkaidoHonshu: 300,
  tohokuTokyo: 5000,
  tokyoChubu: -900,
  kansaiChugoku: -2000,
  kansaiShikoku: -1000,
  chugokuShikoku: 200,
  chugokuKyushu: -2500,
};

describe('エリアごとの正味の受け入れ量', () => {
  const plans = (v: Partial<Record<IntertieKey, number>>) => (k: IntertieKey) => v[k] ?? Number.NaN;
  const sum = (net: Record<AreaKey, number>) => Object.values(net).reduce((a, b) => a + b, 0);

  it('エリアにつながる連系線の計画潮流を足し引きし、全エリアの合計は 0 になる（個別の連系線があれば、フェンスと関西-中国間の内訳は使わない）', () => {
    const net = areaNetImports(
      plans({ ...OUTER_PLANS, chubuKansai: 1500, chubuHokuriku: 300, hokurikuKansai: 100, chubuFence: 9999, hokurikuFence: 9999, kansaiFence: 9999, kansaiChugokuEast: 777 }),
    );
    expect(net).toEqual({ hokkaido: -300, tohoku: -4700, tokyo: 5900, chubu: -2700, hokuriku: 200, kansai: 4600, chugoku: 300, shikoku: -800, kyushu: -2500 });
    expect(sum(net)).toBe(0);
  });

  it('個別の連系線が無ければ、中部フェンスを中部の送り出し、北陸フェンスと関西フェンスをそれぞれの受け入れにする', () => {
    const net = areaNetImports(plans({ ...OUTER_PLANS, chubuFence: 1800, hokurikuFence: 300, kansaiFence: 1500 }));
    expect([net.chubu, net.hokuriku, net.kansai]).toEqual([-2700, 300, 4500]);
    expect(sum(net)).toBe(0);
  });

  it('値の無い連系線につながるエリアだけ NaN', () => {
    const { chugokuKyushu: _drop, ...rest } = OUTER_PLANS;
    const net = areaNetImports(plans({ ...rest, chubuFence: 1800, hokurikuFence: 300, kansaiFence: 1500 }));
    expect([Number.isNaN(net.kyushu), Number.isNaN(net.chugoku), net.shikoku]).toEqual([true, true, -800]);
  });
});

describe('連系線のデータ（ブラウザ側）', () => {
  it('エリアごとの正味の受け入れ量を、コマごとに連系線の計画潮流から求める', async () => {
    const day = dayFromYmd(2026, 9, 21);
    const v = newIntertieDay();
    const set = (k: IntertieKey, x: number) => (v[intertieOffset(INTERTIE_INDEX[k], INTERTIE_FIELD_INDEX.plan, 5)] = x);
    for (const [k, x] of Object.entries(OUTER_PLANS)) set(k as IntertieKey, x);
    set('chubuFence', 1800);
    set('hokurikuFence', 300);
    set('kansaiFence', 1500);
    const json = JSON.parse(JSON.stringify(encodeIntertieFy(2026, new Map([[day, v]]))));
    const index = { firstDate: '2026-09-21', lastDate: '2026-09-21', files: [{ fy: 2026, file: 'interties/fy2026.json', firstDate: '2026-09-21', lastDate: '2026-09-21', days: 1 }] };
    const st = IntertieStore.fromIndex(index, async () => json)!;
    await st.ensure(day, day);
    const ds = new DataStore();
    ds.addDays(generateDemoDays(dayFromYmd(2026, 9, 20), dayFromYmd(2026, 9, 22), 1), 'bundled');
    const dataset = ds.dataset()!;
    const net = st.netImports(dataset);
    const k = (day - dataset.start) * SLOTS + 5;
    expect([net.tokyo[k], net.chubu[k], net.kansai[k]]).toEqual([5900, -2700, 4500]);
    // 値の無いコマと、データの無い日は NaN
    expect([Number.isNaN(net.tokyo[k - 1]), Number.isNaN(net.tokyo[k - SLOTS])]).toEqual([true, true]);
  });

  it('年度ファイルを必要なときに読み、Dataset の日の並びにそろえる', async () => {
    const plan = parseOcctoCsv(PLAN_CSV).days;
    const reads: string[] = [];
    const json = JSON.parse(JSON.stringify(encodeIntertieFy(2026, plan)));
    const st = IntertieStore.fromIndex(
      { firstDate: '2026-09-21', lastDate: '2026-09-21', files: [{ fy: 2026, file: 'interties/fy2026.json', firstDate: '2026-09-21', lastDate: '2026-09-21', days: 1 }] },
      async (f) => {
        reads.push(f);
        return json;
      },
    )!;
    expect(st.ensure(dayFromYmd(2025, 4, 1), dayFromYmd(2025, 4, 2))).toBeNull();
    await st.ensure(dayFromYmd(2026, 9, 1), dayFromYmd(2026, 9, 30));
    expect(reads).toEqual(['interties/fy2026.json']);
    expect(st.ensure(dayFromYmd(2026, 9, 1), dayFromYmd(2026, 9, 30))).toBeNull();
    const ds = new DataStore();
    ds.addDays(generateDemoDays(dayFromYmd(2026, 9, 20), dayFromYmd(2026, 9, 22), 1), 'bundled');
    const dataset = ds.dataset()!;
    expect(st.valueAt(dataset, dayFromYmd(2026, 9, 21), 0, 'tohokuTokyo', 'plan')).toBe(5344.9);
    expect(st.array(dataset, 'tohokuTokyo', 'plan')).toHaveLength(dataset.n * SLOTS);
    expect(st.linesWithData(dataset, dataset.start, dataset.start + dataset.n - 1)).toEqual(['tohokuTokyo']);
  });

  it('デモでは、両側のエリアの価格が違うコマは、安い側から高い側へ上限まで流れる', () => {
    const ds = new DataStore();
    ds.addDays(generateDemoDays(dayFromYmd(2025, 4, 1), dayFromYmd(2025, 6, 30), 3), 'demo');
    const dataset = ds.dataset()!;
    const st = IntertieStore.demo(dataset)!;
    expect(st.isDemo).toBe(true);
    const plan = st.array(dataset, 'tohokuTokyo', 'plan');
    const tohoku = dataset.values[SERIES_INDEX.tohoku];
    const tokyo = dataset.values[SERIES_INDEX.tokyo];
    let split = 0;
    for (let k = 0; k < plan.length; k++) {
      if (Number.isNaN(plan[k]) || Math.abs(tohoku[k] - tokyo[k]) <= 0.005) continue;
      split++;
      expect(plan[k]).toBe(tohoku[k] < tokyo[k] ? 5550 : -2400);
    }
    expect(split).toBeGreaterThan(0);
  });
});

describe('連系線の推移の図の注記', () => {
  const day0 = dayFromYmd(2026, 3, 10);
  /** 1 文字が 1 日（1 は値あり、0 は値なし） */
  const cov = (plan: string, actual: string, anyPlan = '1'.repeat(plan.length), anyActual = '1'.repeat(plan.length)): LineCoverage => {
    const flags = (s: string) => [...s].map((ch) => ch === '1');
    return { days: [...plan].map((_, i) => day0 + i), plan: flags(plan), actual: flags(actual), anyPlan: flags(anyPlan), anyActual: flags(anyActual) };
  };

  it('中地域の個別の連系線は、値のある期間と、フェンスに変わったことを書く', () => {
    const notes = coverageNotes('chubuKansai', cov('1111000', '1110000'));
    expect(notes[0]).toContain('2026 年 3 月 13 日受渡分まで');
    expect(notes).toContain('この期間のうち、この連系線の値があるのは 2026/03/10〜2026/03/13 です。');
    expect(notes).toContain('この連系線の潮流実績があるのは 2026/03/10〜2026/03/12 です。');
    expect(notes.some((n) => n.includes('npm run fetch'))).toBe(false);
    // デモでは、実際の公表のされ方の説明は付けない
    expect(coverageNotes('chubuKansai', cov('1111000', '1110000'), false)[0]).toContain('値があるのは');
  });

  it('どの連系線にも値の無い日は、取得できていない日として取り直し方を書く', () => {
    const notes = coverageNotes('tohokuTokyo', cov('1100111', '1100111', '1100111', '1100111'));
    expect(notes).toContain('計画潮流の無い日が 2 日あります（2026/03/12〜2026/03/13）。');
    expect(notes).toContain('潮流実績の無い日が 2 日あります（2026/03/12〜2026/03/13）。');
    expect(notes[notes.length - 1]).toContain('npm run fetch');
    expect(coverageNotes('tohokuTokyo', cov('1111111', '1111111'))).toEqual([]);
  });

  it('潮流実績の無い連系線（関西-中国間の内訳）と、まだ実績の無い翌日は、潮流実績が無いと書かない', () => {
    expect(coverageNotes('kansaiChugokuEast', cov('1111111', '0000000'))).toEqual([expect.stringContaining('潮流実績と計画潮流（最終）は公表されていません')]);
    // 最後の日（翌日）は、どの連系線にも潮流実績がまだ無い
    expect(coverageNotes('tohokuTokyo', cov('1111111', '1111110', '1111111', '1111110'))).toEqual([]);
    expect(coverageNotes('tohokuTokyo', cov('1111111', '0000000', '1111111', '0000000'))).toEqual(['この期間には潮流実績がありません。']);
    expect(coverageNotes('tohokuTokyo', cov('1111111', '0000000'))).toEqual(['この期間には、この連系線の潮流実績がありません。']);
    expect(coverageNotes('tohokuTokyo', cov('1111111', '0001111', '1111111', '0001111'))).toEqual(['潮流実績は 2026/03/13 からです。']);
  });
});
