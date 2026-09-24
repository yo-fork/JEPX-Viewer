/**
 * 取得済みデータ（public/data）のファイル形式。取得スクリプトとブラウザの両方で使う。
 *
 * manifest.json … 年度ファイルの一覧
 * spot/fyYYYY.json … 1 年度分。系列ごとに「日数 × 48 コマ」の配列（欠損は null）
 */
import { fiscalYearOfDay, isoFromDay, parseDateString } from './dates';
import { newDayValues, type DayMap } from './jepxCsv';
import { SERIES_INDEX, SERIES_KEYS, SLOTS, type SeriesKey } from './series';

export const FY_FILE_FORMAT = 'jepx-viewer/spot-fy@1';
export const MANIFEST_FORMAT = 'jepx-viewer/manifest@1';

export interface FyFile {
  format: typeof FY_FILE_FORMAT;
  fy: number;
  firstDate: string;
  days: number;
  series: Partial<Record<SeriesKey, (number | null)[]>>;
}

export interface ManifestEntry {
  fy: number;
  file: string;
  firstDate: string;
  lastDate: string;
  days: number;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  generatedAt: string;
  source: string;
  files: ManifestEntry[];
}

/** 日別データを年度ごとに分ける */
export function splitByFiscalYear(days: DayMap): Map<number, DayMap> {
  const out = new Map<number, DayMap>();
  for (const [day, vals] of days) {
    const fy = fiscalYearOfDay(day);
    let m = out.get(fy);
    if (!m) {
      m = new Map();
      out.set(fy, m);
    }
    m.set(day, vals);
  }
  return out;
}

export function encodeFyFile(fy: number, days: DayMap): FyFile {
  const keys = [...days.keys()].sort((a, b) => a - b);
  const first = keys[0];
  const n = keys[keys.length - 1] - first + 1;
  const series: FyFile['series'] = {};
  for (const key of SERIES_KEYS) {
    const si = SERIES_INDEX[key];
    const arr: (number | null)[] = new Array(n * SLOTS).fill(null);
    let any = false;
    for (const [day, vals] of days) {
      const off = (day - first) * SLOTS;
      for (let s = 0; s < SLOTS; s++) {
        const v = vals[si * SLOTS + s];
        if (!Number.isNaN(v)) {
          arr[off + s] = v;
          any = true;
        }
      }
    }
    if (any) series[key] = arr;
  }
  return { format: FY_FILE_FORMAT, fy, firstDate: isoFromDay(first), days: n, series };
}

export function decodeFyFile(json: unknown): DayMap {
  const file = json as FyFile;
  if (!file || file.format !== FY_FILE_FORMAT) throw new Error('データファイルの形式が不正です');
  const first = parseDateString(file.firstDate);
  if (first === null) throw new Error('データファイルの firstDate が不正です');
  const days: DayMap = new Map();
  for (let d = 0; d < file.days; d++) {
    let vals: Float64Array | undefined;
    for (const key of SERIES_KEYS) {
      const arr = file.series[key];
      if (!arr) continue;
      for (let s = 0; s < SLOTS; s++) {
        const v = arr[d * SLOTS + s];
        if (v === null || v === undefined) continue;
        vals ??= newDayValues();
        vals[SERIES_INDEX[key] * SLOTS + s] = v;
      }
    }
    if (vals) days.set(first + d, vals);
  }
  return days;
}
