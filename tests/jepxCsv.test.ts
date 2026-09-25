import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { parseCsv, toCsv } from '../src/lib/csv';
import { decodeCsvBytes } from '../src/lib/encoding';
import { formatSpotCsv, parseSlot, parseSpotCsv, SpotCsvFormatError } from '../src/lib/jepxCsv';
import { dayFromYmd, parseDateString } from '../src/lib/dates';
import { SERIES_INDEX, SLOTS } from '../src/lib/series';
import { generateDemoDays } from '../src/lib/demo';

const AREA_HEADERS = ['北海道', '東北', '東京', '中部', '北陸', '関西', '中国', '四国', '九州'];

/** 実際の JEPX CSV（2022 年度以降）と同じ列構成のテキストを作る */
function jepxLikeCsv(rows: string[][]): string {
  const header = [
    '受渡日',
    '時刻コード',
    '売り入札量(kWh)',
    '買い入札量(kWh)',
    '約定総量(kWh)',
    'システムプライス(円/kWh)',
    ...AREA_HEADERS.map((a) => `エリアプライス${a}(円/kWh)`),
    'スポット・時間前平均価格(円/kWh)',
    'α上限値×スポット・時間前平均価格(円/kWh)',
    'α下限値×スポット・時間前平均価格(円/kWh)',
    'α速報値×スポット・時間前平均価格(円/kWh)',
    'α確報値×スポット・時間前平均価格(円/kWh)',
    '回避可能原価全国値(円/kWh)',
    ...AREA_HEADERS.map((a) => `回避可能原価${a}(円/kWh)`),
    '売りブロック入札総量(kWh)',
    '売りブロック約定総量(kWh)',
    '買いブロック入札総量(kWh)',
    '買いブロック約定総量(kWh)',
  ];
  return [header, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}

function row(date: string, code: number, system: string, areaOffset = 0): string[] {
  const areas = AREA_HEADERS.map((_, i) => (Number(system) + (i === 8 ? -areaOffset : 0)).toFixed(2));
  // α 値・回避可能原価（読み飛ばす）と、ブロック入札の量（売りの入札・約定、買いの入札・約定）
  return [date, String(code), '25000000', '22000000', '18000000', system, ...areas, ...new Array(15).fill('9.99'), '10000000', '2000000', '3000000', '2500000'];
}

describe('CSV パーサ', () => {
  it('クォート・改行・CRLF を扱える', () => {
    const rows = parseCsv('﻿a,"b,c","d""e"\r\n1,"2\n3",4\n');
    expect(rows).toEqual([
      ['a', 'b,c', 'd"e'],
      ['1', '2\n3', '4'],
    ]);
  });

  it('toCsv は必要なときだけクォートする', () => {
    expect(toCsv([['a', 'b,c', 1.5, Number.NaN]])).toBe('a,"b,c",1.5,\r\n');
  });
});

describe('文字コード判定', () => {
  it('Shift_JIS と UTF-8（BOM 有無）を判定する', () => {
    const text = '受渡日,システムプライス(円/kWh)\n';
    expect(decodeCsvBytes(iconv.encode(text, 'Shift_JIS'))).toEqual({ text, encoding: 'shift_jis' });
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toEqual({ text, encoding: 'utf-8' });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeCsvBytes(bom).text).toBe(text);
  });
});

describe('JEPX スポット CSV', () => {
  it('Shift_JIS の CSV から主要列とブロック入札の量を読み取り、付帯列は無視する', () => {
    const csv = jepxLikeCsv([row('2024/04/01', 1, '10.50'), row('2024/04/01', 2, '11.25', 3), row('2024/04/02', 48, '0.01')]);
    const { text } = decodeCsvBytes(iconv.encode(csv, 'Shift_JIS'));
    const res = parseSpotCsv(text);
    expect(res.rowCount).toBe(3);
    expect(res.columns).toEqual([
      'sellBid',
      'buyBid',
      'volume',
      'system',
      'hokkaido',
      'tohoku',
      'tokyo',
      'chubu',
      'hokuriku',
      'kansai',
      'chugoku',
      'shikoku',
      'kyushu',
      'sellBlockBid',
      'sellBlockVolume',
      'buyBlockBid',
      'buyBlockVolume',
    ]);
    expect(res.warnings).toEqual([]);
    const d1 = res.days.get(dayFromYmd(2024, 4, 1))!;
    expect(d1[SERIES_INDEX.system * SLOTS + 0]).toBe(10.5);
    expect(d1[SERIES_INDEX.kyushu * SLOTS + 1]).toBeCloseTo(8.25);
    expect(d1[SERIES_INDEX.volume * SLOTS + 0]).toBe(18000000);
    expect([d1[SERIES_INDEX.sellBid * SLOTS], d1[SERIES_INDEX.sellBlockBid * SLOTS], d1[SERIES_INDEX.sellBlockVolume * SLOTS]]).toEqual([25000000, 10000000, 2000000]);
    expect([d1[SERIES_INDEX.buyBlockBid * SLOTS], d1[SERIES_INDEX.buyBlockVolume * SLOTS]]).toEqual([3000000, 2500000]);
    expect(Number.isNaN(d1[SERIES_INDEX.system * SLOTS + 2])).toBe(true);
    const d2 = res.days.get(dayFromYmd(2024, 4, 2))!;
    expect(d2[SERIES_INDEX.system * SLOTS + 47]).toBe(0.01);
    expect(res.firstDay).toBe(dayFromYmd(2024, 4, 1));
    expect(res.lastDay).toBe(dayFromYmd(2024, 4, 2));
  });

  it('旧形式（付帯列なし・ハイフン区切り日付・前置きの行）も読める', () => {
    const csv = [
      'スポット市場取引結果',
      '年月日,時刻コード,約定総量(kWh),システムプライス(円/kWh),エリアプライス 東京(円/kWh),エリアプライス 関西(円/kWh)',
      '2010-04-01,1,"1,234,000",7.10,7.10,7.00',
      '不正な行,x,,,,',
    ].join('\n');
    const res = parseSpotCsv(csv);
    expect(res.rowCount).toBe(1);
    const vals = res.days.get(dayFromYmd(2010, 4, 1))!;
    expect(vals[SERIES_INDEX.volume * SLOTS]).toBe(1234000);
    expect(vals[SERIES_INDEX.kansai * SLOTS]).toBe(7);
    expect(res.warnings.some((w) => w.includes('北海道'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('1 行'))).toBe(true);
  });

  it('JEPX 以外の CSV はエラーにする', () => {
    expect(() => parseSpotCsv('a,b,c\n1,2,3\n')).toThrow(SpotCsvFormatError);
  });

  it('書き出した CSV を読み戻すと同じ値になる', () => {
    const from = dayFromYmd(2024, 4, 1);
    const days = generateDemoDays(from, from + 2, 7);
    const back = parseSpotCsv(formatSpotCsv(days));
    expect(back.rowCount).toBe(3 * SLOTS);
    for (const [day, vals] of days) expect(back.days.get(day)).toEqual(vals);
  });

  it('時刻コードと日付を解釈する', () => {
    expect(parseSlot('1')).toBe(0);
    expect(parseSlot('48')).toBe(47);
    expect(parseSlot('49')).toBeNull();
    expect(parseSlot('13:30')).toBe(27);
    expect(parseDateString('2024/4/1')).toBe(dayFromYmd(2024, 4, 1));
    expect(parseDateString('20240401')).toBe(dayFromYmd(2024, 4, 1));
    expect(parseDateString('2024/02/30')).toBeNull();
  });
});
