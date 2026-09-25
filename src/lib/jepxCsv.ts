/**
 * JEPX「スポット市場 取引結果」CSV（spot_summary_YYYY.csv）のパーサ。
 *
 * 列名は年度によって追加・変更があるため、完全一致ではなくキーワードで列を特定する。
 *   受渡日, 時刻コード, 売り入札量(kWh), 買い入札量(kWh), 約定総量(kWh),
 *   システムプライス(円/kWh), エリアプライス北海道(円/kWh) … エリアプライス九州(円/kWh),
 *   売りブロック入札総量(kWh), 売りブロック約定総量(kWh), 買いブロック入札総量(kWh), 買いブロック約定総量(kWh), …
 * 回避可能原価・α値などの列は読み飛ばす。ブロック入札の量は、入札カーブの単エリアの推定に使う。
 */
import { parseCsv, toCsv } from './csv';
import { formatDay, parseDateString } from './dates';
import { AREAS, SERIES_COUNT, SERIES_INDEX, SLOTS, type SeriesKey } from './series';

export type DayValues = Float64Array; // SERIES_COUNT × SLOTS（系列ごとに 48 コマ）
export type DayMap = Map<number, DayValues>;

export interface SpotCsvResult {
  days: DayMap;
  /** 読み取れた系列 */
  columns: SeriesKey[];
  rowCount: number;
  firstDay: number;
  lastDay: number;
  warnings: string[];
}

export function newDayValues(): DayValues {
  return new Float64Array(SERIES_COUNT * SLOTS).fill(Number.NaN);
}

export function normalizeHeader(h: string): string {
  return h.normalize('NFKC').replace(/["'\s]/g, '');
}

type Matcher = (h: string) => boolean;

const SERIES_MATCHERS: [SeriesKey, Matcher][] = [
  ['sellBid', (h) => /売り?入札(総)?量/.test(h) && !h.includes('ブロック')],
  ['buyBid', (h) => /買い?入札(総)?量/.test(h) && !h.includes('ブロック')],
  ['volume', (h) => /約定(総)?量/.test(h) && !h.includes('ブロック')],
  ['system', (h) => h.includes('システムプライス')],
  ...AREAS.map((a): [SeriesKey, Matcher] => [a.key, (h) => h.includes('エリアプライス') && h.includes(a.label)]),
  ['sellBlockBid', (h) => /売り?ブロック入札(総)?量/.test(h)],
  ['sellBlockVolume', (h) => /売り?ブロック約定(総)?量/.test(h)],
  ['buyBlockBid', (h) => /買い?ブロック入札(総)?量/.test(h)],
  ['buyBlockVolume', (h) => /買い?ブロック約定(総)?量/.test(h)],
];

function findColumn(headers: string[], tests: Matcher[]): number {
  for (const test of tests) {
    const idx = headers.findIndex(test);
    if (idx >= 0) return idx;
  }
  return -1;
}

/** 時刻コード（1〜48）または "HH:MM" 形式をコマ番号（0〜47）に変換 */
export function parseSlot(value: string): number | null {
  const s = value.normalize('NFKC').trim();
  // 1〜48 のコード（表計算ソフトで保存し直した 1.0 のような形も）
  if (/^\d{1,2}(\.0+)?$/.test(s)) {
    const code = Number(s);
    return code >= 1 && code <= SLOTS ? code - 1 : null;
  }
  const m = /^(\d{1,2}):(\d{2})/.exec(s);
  if (m) {
    const slot = Number(m[1]) * 2 + (Number(m[2]) >= 30 ? 1 : 0);
    return slot >= 0 && slot < SLOTS ? slot : null;
  }
  return null;
}

export function parseNumber(value: string | undefined): number {
  if (value === undefined) return Number.NaN;
  const s = value.normalize('NFKC').replace(/,/g, '').trim();
  if (s === '' || s === '-') return Number.NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : Number.NaN;
}

export class SpotCsvFormatError extends Error {}

export function parseSpotCsv(text: string): SpotCsvResult {
  const rows = parseCsv(text);
  const headerRowIdx = rows.slice(0, 20).findIndex((r) => r.some((c) => normalizeHeader(c).includes('システムプライス')));
  if (headerRowIdx < 0) {
    throw new SpotCsvFormatError(
      'JEPX スポット市場の CSV として認識できませんでした（「システムプライス」列が見つかりません）。',
    );
  }
  const headers = rows[headerRowIdx].map(normalizeHeader);
  const dateCol = findColumn(headers, [
    (h) => h.includes('受渡日'),
    (h) => h.includes('年月日'),
    (h) => h.includes('日付'),
    (h) => h.toLowerCase().includes('date'),
  ]);
  const slotCol = findColumn(headers, [
    (h) => h.includes('時刻コード'),
    (h) => h.includes('コマ'),
    (h) => h.includes('時刻') || h.includes('時間帯'),
  ]);
  if (dateCol < 0 || slotCol < 0) {
    throw new SpotCsvFormatError('受渡日または時刻コードの列が見つかりません。JEPX からダウンロードした CSV を指定してください。');
  }

  const seriesCols: [number, number][] = []; // [列番号, 系列インデックス]
  const columns: SeriesKey[] = [];
  for (const [key, test] of SERIES_MATCHERS) {
    const col = headers.findIndex(test);
    if (col >= 0) {
      seriesCols.push([col, SERIES_INDEX[key]]);
      columns.push(key);
    }
  }

  const warnings: string[] = [];
  const missingAreas = AREAS.filter((a) => !columns.includes(a.key)).map((a) => a.label);
  if (missingAreas.length > 0) warnings.push(`エリアプライス列が見つかりません: ${missingAreas.join('、')}`);

  const days: DayMap = new Map();
  let rowCount = 0;
  let skipped = 0;
  let firstDay = Number.POSITIVE_INFINITY;
  let lastDay = Number.NEGATIVE_INFINITY;

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length <= 1 && (row[0] ?? '').trim() === '') continue; // 空行
    const day = parseDateString(row[dateCol] ?? '');
    const slot = parseSlot(row[slotCol] ?? '');
    if (day === null || slot === null) {
      skipped++;
      continue;
    }
    let values = days.get(day);
    if (!values) {
      values = newDayValues();
      days.set(day, values);
    }
    for (const [col, si] of seriesCols) {
      values[si * SLOTS + slot] = parseNumber(row[col]);
    }
    rowCount++;
    if (day < firstDay) firstDay = day;
    if (day > lastDay) lastDay = day;
  }

  if (rowCount === 0) throw new SpotCsvFormatError('CSV にデータ行がありません。');
  if (skipped > 0) warnings.push(`日付または時刻コードを解釈できない ${skipped} 行を読み飛ばしました。`);

  return { days, columns, rowCount, firstDay, lastDay, warnings };
}

/** JEPX と同じ列名・並び（主要列のみ）で CSV を書き出す */
export const SPOT_CSV_COLUMNS: [string, SeriesKey][] = [
  ['売り入札量(kWh)', 'sellBid'],
  ['買い入札量(kWh)', 'buyBid'],
  ['約定総量(kWh)', 'volume'],
  ['システムプライス(円/kWh)', 'system'],
  ...AREAS.map((a): [string, SeriesKey] => [`エリアプライス${a.label}(円/kWh)`, a.key]),
  ['売りブロック入札総量(kWh)', 'sellBlockBid'],
  ['売りブロック約定総量(kWh)', 'sellBlockVolume'],
  ['買いブロック入札総量(kWh)', 'buyBlockBid'],
  ['買いブロック約定総量(kWh)', 'buyBlockVolume'],
];

export function formatSpotCsv(days: DayMap, slotFilter?: (day: number, slot: number) => boolean): string {
  const rows: (string | number)[][] = [['受渡日', '時刻コード', ...SPOT_CSV_COLUMNS.map((c) => c[0])]];
  const keys = [...days.keys()].sort((a, b) => a - b);
  for (const day of keys) {
    const vals = days.get(day)!;
    for (let s = 0; s < SLOTS; s++) {
      if (slotFilter && !slotFilter(day, s)) continue;
      rows.push([formatDay(day), s + 1, ...SPOT_CSV_COLUMNS.map(([, key]) => vals[SERIES_INDEX[key] * SLOTS + s])]);
    }
  }
  return toCsv(rows);
}
