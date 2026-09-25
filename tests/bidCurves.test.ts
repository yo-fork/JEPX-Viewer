import { describe, expect, it } from 'vitest';
import {
  applyGroupNames,
  buyAtOrAbove,
  buyPriceAt,
  buyVolumeAt,
  buyVolumesAt,
  crossing,
  CURVE_METRIC_INDEX,
  CURVE_METRIC_KEYS,
  curveCsvKind,
  curveDayFile,
  curveMetrics,
  decodeCurveDay,
  decodeCurveMetrics,
  encodeCurveDay,
  encodeCurveMetrics,
  formatBidCurveCsv,
  formatSplittingAreasCsv,
  metricsOfDayFile,
  parseAreaGroupLabel,
  parseBidCurveCsv,
  parseSplittingAreasCsv,
  rowsFromSteps,
  sellAtOrBelow,
  sellPriceAt,
  sellVolumeAt,
  sellVolumesAt,
  simplifyCurve,
  SIMPLIFY_RATIO,
  stepPath,
  stepPrices,
  SYSTEM_GROUP,
  type CurveRow,
} from '../src/lib/bidCurves';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay } from '../src/lib/demoCurves';
import { formatSpotCsv } from '../src/lib/jepxCsv';
import { SLOTS } from '../src/lib/series';

/** JEPX の入札カーブの CSV（先頭部分と、分断エリアのカーブの一部） */
const BID_CSV = `電力受渡日,商品コード,入札価格(円/kWh),売入札量累積(MW),買入札量累積(MW),分断エリア連番
20260925,1,0.00,0.0,49366.6,
20260925,1,0.00,15810.1,49366.6,
20260925,1,0.01,35177.9,49366.6,
20260925,1,0.02,35590.9,49365.6,
20260925,1,0.03,35612.5,49364.6,
20260925,1,1.00,36134.5,49225.9,
20260925,1,0.00,0.0,32884.0,1
20260925,1,0.00,10840.3,32884.0,1
20260925,1,0.01,20313.2,32884.0,1
20260925,2,0.00,0.0,48000.0,
20260925,2,0.01,30000.0,47000.0,
`;
const SPLIT_CSV = `電力受渡日,商品コード,エリアグループ,分断エリア連番
20260925,1,システムプライス,
20260925,1,東北・東京・中部,1
20260925,1,関西・中国・九州,3
20260925,5,システムプライス,
20260925,5,北海道・東北・東京・中部,0
20260925,5,北陸・関西・中国・四国・九州,1
`;

/** 答えの分かっている小さなカーブ */
const ROWS: CurveRow[] = [
  { price: 0, sell: 0, buy: 1000 },
  { price: 0, sell: 300, buy: 1000 },
  { price: 0.01, sell: 500, buy: 1000 },
  { price: 5, sell: 700, buy: 900 },
  { price: 10, sell: 900, buy: 800 },
  { price: 20, sell: 1200, buy: 600 },
  { price: 999.99, sell: 1500, buy: 400 },
];
const m = (vals: number[], key: (typeof CURVE_METRIC_KEYS)[number]) => vals[CURVE_METRIC_INDEX[key]];

/** システムプライスの行の分断エリア連番を -1 にした CSV（手元で保存した形） */
const withMinusOne = (csv: string) =>
  csv
    .split('\n')
    .map((line, i) => (i > 0 && /,\r?$/.test(line) ? line.replace(/,(\r?)$/, ',-1$1') : line))
    .join('\n');

describe('parseBidCurveCsv / parseSplittingAreasCsv', () => {
  it('分断エリア連番が -1 の行も、空の行と同じくシステムプライスとして読む', () => {
    expect(withMinusOne(BID_CSV)).toContain('20260925,1,0.00,0.0,49366.6,-1');
    expect(withMinusOne(SPLIT_CSV)).toContain('20260925,1,システムプライス,-1');
    expect(parseBidCurveCsv(withMinusOne(BID_CSV))).toEqual(parseBidCurveCsv(BID_CSV));
    expect(parseSplittingAreasCsv(withMinusOne(SPLIT_CSV))).toEqual(parseSplittingAreasCsv(SPLIT_CSV));
    // 全角の －１ も同じ。番号でない値の行は読み飛ばす
    const sys = parseBidCurveCsv(BID_CSV).get(dayFromYmd(2026, 9, 25))!.slots[0].get(SYSTEM_GROUP)!;
    const odd = parseBidCurveCsv(BID_CSV.replace('20260925,1,0.00,0.0,49366.6,', '20260925,1,0.00,0.0,49366.6,－１').replace('20260925,2,0.00,0.0,48000.0,', '20260925,2,0.00,0.0,48000.0,x'));
    expect(odd.get(dayFromYmd(2026, 9, 25))!.slots[0].get(SYSTEM_GROUP)).toEqual(sys);
    expect(odd.get(dayFromYmd(2026, 9, 25))!.slots[1].get(SYSTEM_GROUP)).toHaveLength(1);
  });

  it('表計算ソフトで保存し直した CSV（分断エリア連番・商品コードが -1.0・0.0・1.0 のような小数）も読む', () => {
    const decimals = (csv: string) =>
      csv
        .split('\n')
        .map((line, i) => {
          if (i === 0 || line.trim() === '') return line;
          const cells = line.replace(/\r$/, '').split(',');
          const last = cells.length - 1;
          cells[last] = cells[last] === '' || cells[last] === '-1' ? '-1.0' : `${cells[last]}.0`;
          cells[1] = `${cells[1]}.0`;
          return cells.join(',');
        })
        .join('\n');
    expect(decimals(BID_CSV)).toContain('20260925,1.0,0.00,0.0,49366.6,-1.0');
    expect(decimals(BID_CSV)).toContain('20260925,1.0,0.00,0.0,32884.0,1.0');
    expect(parseBidCurveCsv(decimals(BID_CSV))).toEqual(parseBidCurveCsv(BID_CSV));
    expect(decimals(SPLIT_CSV)).toContain('20260925,5.0,北海道・東北・東京・中部,0.0');
    expect(parseSplittingAreasCsv(decimals(SPLIT_CSV))).toEqual(parseSplittingAreasCsv(SPLIT_CSV));
  });

  it('入札カーブ・分断エリアの CSV を列名で見分ける（取引結果の CSV などは null）', () => {
    expect(curveCsvKind(BID_CSV)).toBe('bidCurves');
    expect(curveCsvKind(withMinusOne(SPLIT_CSV))).toBe('splittingAreas');
    expect(curveCsvKind(formatSpotCsv(generateDemoDays(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 2), 1)))).toBeNull();
    expect(curveCsvKind('a,b\n1,2\n')).toBeNull();
  });

  it('コマ・分断エリア連番ごとに価格の昇順の点にする（連番が空はシステムプライス）', () => {
    const days = parseBidCurveCsv(BID_CSV);
    const day = dayFromYmd(2026, 9, 25);
    expect([...days.keys()]).toEqual([day]);
    const d = days.get(day)!;
    expect([...d.slots[0].keys()].sort()).toEqual([SYSTEM_GROUP, 1].sort());
    const sys = d.slots[0].get(SYSTEM_GROUP)!;
    expect(sys).toHaveLength(6);
    expect(sys[1]).toEqual({ price: 0, sell: 15810.1, buy: 49366.6 });
    expect(d.slots[0].get(1)!.map((r) => r.sell)).toEqual([0, 10840.3, 20313.2]);
    expect(d.slots[1].get(SYSTEM_GROUP)!).toHaveLength(2);
    expect(d.slots[2].size).toBe(0);
  });

  it('入札カーブ以外の CSV はエラーにする', () => {
    expect(() => parseBidCurveCsv('受渡日,時刻コード,システムプライス\n2024/04/01,1,10\n')).toThrow(/入札カーブの CSV ではありません/);
    expect(() => parseSplittingAreasCsv(BID_CSV)).toThrow(/分断エリアの CSV ではありません/);
  });

  it('分断エリアの名前をエリアに分ける（システムプライスの行は除く）', () => {
    const groups = parseSplittingAreasCsv(SPLIT_CSV).get(dayFromYmd(2026, 9, 25))!;
    expect(groups[0]).toEqual([
      { id: 1, label: '東北・東京・中部', areas: ['tohoku', 'tokyo', 'chubu'] },
      { id: 3, label: '関西・中国・九州', areas: ['kansai', 'chugoku', 'kyushu'] },
    ]);
    expect(groups[4].map((g) => g.id)).toEqual([0, 1]);
    expect(groups[1]).toEqual([]);
    expect(parseAreaGroupLabel('北陸・関西・中国・四国・九州')).toEqual(['hokuriku', 'kansai', 'chugoku', 'shikoku', 'kyushu']);
  });
});

describe('指標', () => {
  it('価格帯ごとの売り・買いの量', () => {
    expect(sellAtOrBelow(ROWS, 0.01)).toBe(500);
    expect(sellAtOrBelow(ROWS, 7)).toBe(700);
    expect(sellAtOrBelow(ROWS, -1)).toBe(0);
    expect(buyAtOrAbove(ROWS, 10)).toBe(800);
    expect(buyAtOrAbove(ROWS, 50)).toBe(400);
    expect(buyAtOrAbove(ROWS, 2000)).toBe(0);
  });

  it('交点: 売りの段で交わる場合と、1 つ前の価格の買いの段で交わる場合', () => {
    expect(crossing(ROWS)).toEqual({ price: 10, volume: 800 });
    expect(crossing(ROWS, 100)).toEqual({ price: 10, volume: 900 });
    // 10 円では買いが上回り、10 円を超えると売りが上回る → 10 円の買いの一部が約定
    expect(crossing(ROWS, 150)).toEqual({ price: 10, volume: 900 });
    expect(crossing(ROWS, 5000)).toBeNull();
  });

  it('curveMetrics は CURVE_METRICS の順に値を返す', () => {
    const v = curveMetrics(ROWS);
    expect(v).toHaveLength(CURVE_METRIC_KEYS.length);
    expect(m(v, 'sell001')).toBe(500);
    expect(m(v, 'sell10')).toBe(900);
    expect(m(v, 'sellTotal')).toBe(1500);
    expect(m(v, 'buyTop')).toBe(400);
    expect(m(v, 'buyTotal')).toBe(1000);
    expect(m(v, 'clearPrice')).toBe(10);
    expect(m(v, 'clearVolume')).toBe(800);
    // 買いが 1GW 減ると 0 円で交わる
    expect(m(v, 'downPrice')).toBe(10);
    expect(curveMetrics([]).every(Number.isNaN)).toBe(true);
  });
});

describe('間引き・描画用の形', () => {
  it('許容差より小さい増え方は次の段にまとめ、合計は保つ', () => {
    // 省略時の許容差は、売り・買いそれぞれの合計量の 0.1%（1MW 以上）: ここでは 1.5MW・1MW なので間引かない
    expect(simplifyCurve(ROWS)).toEqual(simplifyCurve(ROWS, 0));
    expect(simplifyCurve(ROWS, 150).sell).toEqual([0, 300, 0.01, 500, 5, 700, 10, 900, 20, 1200, 999.99, 1500]);
    expect(simplifyCurve(ROWS, 250).sell).toEqual([0, 300, 5, 700, 20, 1200, 999.99, 1500]);
    // 買いは価格の降順（5 円の +100MW は許容差未満なので 0.01 円の段にまとまる）
    expect(simplifyCurve(ROWS, 150).buy).toEqual([999.99, 400, 20, 600, 10, 800, 0.01, 1000]);
  });

  it('階段の頂点と、量から価格を引く', () => {
    const { sell, buy } = simplifyCurve(ROWS, 150);
    expect(stepPath(sell).slice(0, 4)).toEqual([
      [0, 0],
      [300, 0],
      [300, 0.01],
      [500, 0.01],
    ]);
    expect(sellPriceAt(sell, 850)).toBe(10);
    expect(sellPriceAt(sell, 2000)).toBeNaN();
    expect(buyPriceAt(buy, 700)).toBe(10);
    expect(buyPriceAt(buy, 1200)).toBeNaN();
  });

  it('価格から量を引き、行に戻す（間引かなければ元のカーブと同じ交点になる）', () => {
    const { sell, buy } = simplifyCurve(ROWS, 0);
    expect(stepPrices(sell, buy)).toEqual([0, 0.01, 5, 10, 20, 999.99]);
    expect(sellVolumeAt(sell, 7)).toBe(700);
    expect(sellVolumeAt(sell, -1)).toBe(0);
    expect(buyVolumeAt(buy, 7)).toBe(800);
    expect(buyVolumeAt(buy, 2000)).toBe(0);
    const prices = [-1, 0, 0.005, 5, 7, 999.99, 2000];
    expect([...sellVolumesAt(sell, prices)]).toEqual(prices.map((p) => sellVolumeAt(sell, p)));
    expect([...buyVolumesAt(buy, prices)]).toEqual(prices.map((p) => buyVolumeAt(buy, p)));
    const rows = rowsFromSteps(sell, buy);
    for (const shift of [0, -1000, -300, 100, 150, 500, 5000]) expect(crossing(rows, shift)).toEqual(crossing(ROWS, shift));
  });

  it('間引いたカーブの交点は、元のカーブの交点とほぼ同じ（価格は段 1 つ分、量は許容差 2 つ分以内）', () => {
    const day = dayFromYmd(2025, 8, 1);
    const targets = Array.from({ length: SLOTS }, (_, s) => ({ system: 6 + (s % 16), volume: 32000, east: 10, west: 10 }));
    const { raw } = syntheticCurveDay(day, targets);
    for (let s = 0; s < SLOTS; s++) {
      const rows = raw.slots[s].get(SYSTEM_GROUP)!;
      const exact = crossing(rows)!;
      const { sell, buy } = simplifyCurve(rows);
      const approx = crossing(rowsFromSteps(sell, buy))!;
      // 合成のカーブの価格の段は 0.25 円おき
      expect(Math.abs(approx.price - exact.price)).toBeLessThanOrEqual(0.25 + 1e-9);
      const tol = Math.max(...rows.map((r) => Math.max(r.sell, r.buy))) * SIMPLIFY_RATIO;
      expect(Math.abs(approx.volume - exact.volume)).toBeLessThanOrEqual(2 * tol);
    }
  });
});

describe('ファイル形式', () => {
  const day = dayFromYmd(2026, 9, 25);
  const raw = parseBidCurveCsv(BID_CSV).get(day)!;
  const groups = parseSplittingAreasCsv(SPLIT_CSV).get(day)!;

  it('1 日分のファイル: 分断エリアの名前・間引いたカーブ・指標を持ち、元に戻せる', () => {
    const file = JSON.parse(JSON.stringify(encodeCurveDay(raw, groups, 1)));
    expect(file.date).toBe('2026-09-25');
    expect(file.slots[2]).toBeNull();
    const back = decodeCurveDay(file);
    expect(back.day).toBe(day);
    const s0 = back.slots[0]!;
    expect(s0.map((g) => [g.id, g.label])).toEqual([
      [SYSTEM_GROUP, 'システムプライス'],
      [1, '東北・東京・中部'],
    ]);
    expect([...s0[0].sell]).toEqual(simplifyCurve(raw.slots[0].get(SYSTEM_GROUP)!, 1).sell);
    expect([...s0[0].buy]).toEqual(simplifyCurve(raw.slots[0].get(SYSTEM_GROUP)!, 1).buy);
    const metrics = metricsOfDayFile(file);
    expect(metrics[CURVE_METRIC_INDEX.sell001 * SLOTS + 0]).toBeCloseTo(35177.9, 1);
    expect(Number.isNaN(metrics[CURVE_METRIC_INDEX.sell001 * SLOTS + 2])).toBe(true);
    expect(curveDayFile(day)).toBe('curves/2026/20260925.json');
  });

  it('変換済みのファイルに、あとから分断エリアの名前を付け直せる', () => {
    const day = dayFromYmd(2025, 5, 3);
    const targets = Array.from({ length: SLOTS }, (_, s) => ({ system: 10, volume: 30000, east: 10, west: s % 2 ? 12 : 10 }));
    const { raw, groups } = syntheticCurveDay(day, targets);
    const file = encodeCurveDay(raw);
    expect(file.slots[1]!.groups[1].label).toBe(`分断エリア ${groups[1][0].id}`);
    expect(applyGroupNames(file, groups)).toBe(true);
    expect(file).toEqual(encodeCurveDay(raw, groups));
    expect(applyGroupNames(file, groups)).toBe(false);
  });

  it('名前の無い分断エリアは番号で表す', () => {
    const back = decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw))));
    expect(back.slots[0]![1].label).toBe('分断エリア 1');
    expect(() => decodeCurveDay({ format: 'x' })).toThrow(/形式が不正/);
  });

  it('指標の年度ファイルは日 × コマの配列で、元に戻せる', () => {
    const d2 = day + 3;
    const days = new Map([
      [day, metricsOfDayFile(encodeCurveDay(raw))],
      [d2, metricsOfDayFile(encodeCurveDay({ ...raw, day: d2 }))],
    ]);
    const file = JSON.parse(JSON.stringify(encodeCurveMetrics(2026, days)));
    expect(file.days).toBe(4);
    const back = decodeCurveMetrics(file);
    expect([...back.keys()]).toEqual([day, d2]);
    expect(back.get(d2)![CURVE_METRIC_INDEX.sellTotal * SLOTS]).toBeCloseTo(36134.5, 1);
  });

  it('JEPX と同じ形式の CSV に書き出して、読み戻せる', () => {
    const csv = formatBidCurveCsv(raw);
    expect(csv.split('\r\n')[0]).toBe('電力受渡日,商品コード,入札価格(円/kWh),売入札量累積(MW),買入札量累積(MW),分断エリア連番');
    const back = parseBidCurveCsv(csv).get(day)!;
    expect(back.slots[0].get(1)).toEqual(raw.slots[0].get(1));
    expect(back.slots[1].get(SYSTEM_GROUP)).toEqual(raw.slots[1].get(SYSTEM_GROUP));
    const split = parseSplittingAreasCsv(formatSplittingAreasCsv(day, groups)).get(day)!;
    expect(split[0]).toEqual(groups[0]);
  });
});

describe('合成の入札カーブ（デモ用）', () => {
  it('与えた価格の近くで交わり、売りは増え、買いは減っていく（分断したコマは分断エリアのカーブを足したもの）', () => {
    const day = dayFromYmd(2025, 5, 3);
    const targets = Array.from({ length: SLOTS }, (_, s) => ({ system: s === 24 ? 0.01 : 8 + (s % 10), volume: 30000, east: 12, west: s % 2 ? 9 : 12 }));
    const { raw, groups } = syntheticCurveDay(day, targets);
    for (let s = 0; s < SLOTS; s++) {
      const rows = raw.slots[s].get(SYSTEM_GROUP)!;
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].sell).toBeGreaterThanOrEqual(rows[i - 1].sell);
        expect(rows[i].buy).toBeLessThanOrEqual(rows[i - 1].buy);
      }
      if (s % 2 === 0) {
        expect(groups[s]).toEqual([]);
        expect(Math.abs(crossing(rows)!.price - targets[s].system)).toBeLessThanOrEqual(0.5);
        continue;
      }
      // 東西に分断: 北海道・東北・東京（12 円）と、それ以外（9 円）
      expect(groups[s].map((g) => [g.id, g.label])).toEqual([
        [0, '北海道・東北・東京'],
        [1, '中部・北陸・関西・中国・四国・九州'],
      ]);
      const [east, west] = [raw.slots[s].get(0)!, raw.slots[s].get(1)!];
      expect(Math.abs(crossing(east)!.price - 12)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(crossing(west)!.price - 9)).toBeLessThanOrEqual(0.5);
      // システムプライスのカーブは 2 つを足したもの（買いには、ずれの分として約定量の 1.5% を足してある）
      rows.forEach((r, i) => {
        expect(r.sell).toBeCloseTo(east[i].sell + west[i].sell, 0);
        expect(r.buy).toBeCloseTo(east[i].buy + west[i].buy + 30000 * 0.015, 0);
      });
    }
    expect(crossing(raw.slots[24].get(SYSTEM_GROUP)!)!.price).toBeLessThanOrEqual(0.01);
    // 同じ日なら同じカーブ
    expect(syntheticCurveDay(day, targets).raw.slots[3].get(SYSTEM_GROUP)).toEqual(raw.slots[3].get(SYSTEM_GROUP));
  });

  it('1 エリアだけで分断したエリア（単エリア）のカーブと名前は出さず、分断エリアの番号は飛ぶ', () => {
    const areas = { hokkaido: 15, tohoku: 12, tokyo: 12, chubu: 9, hokuriku: 9, kansai: 9, chugoku: 9, shikoku: 9, kyushu: 5 };
    const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [{ system: 10, volume: 30000, areas }]);
    expect(groups[0].map((g) => [g.id, g.label, g.areas.length])).toEqual([
      [1, '東北・東京', 2],
      [2, '中部・北陸・関西・中国・四国', 5],
    ]);
    expect([...raw.slots[0].keys()].sort()).toEqual([SYSTEM_GROUP, 1, 2].sort());
  });
});
