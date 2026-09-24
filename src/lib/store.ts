/**
 * 読み込んだ日別データを保持し、分析用の連続配列（Dataset）を組み立てる。
 */
import { dowOfDay, fiscalYearOf, ymdFromDay } from './dates';
import { isNationalHoliday } from './holidays';
import type { DayMap } from './jepxCsv';
import { SERIES_COUNT, SERIES_KEYS, SLOTS, type SeriesKey } from './series';

export type SourceKind = 'bundled' | 'upload' | 'demo';

export interface Dataset {
  /** 先頭日（経過日数） */
  start: number;
  /** 日数（start から連続。データの無い日は present=0） */
  n: number;
  /** 系列ごとの値。長さ n × 48、欠損は NaN */
  values: Float64Array[];
  present: Uint8Array;
  dow: Uint8Array;
  /** 土日祝なら 1 */
  offDay: Uint8Array;
  holiday: Uint8Array;
  y: Uint16Array;
  m: Uint8Array;
  d: Uint8Array;
  fy: Uint16Array;
  /** 1 つでも値がある系列 */
  hasSeries: Record<SeriesKey, boolean>;
  firstDay: number;
  lastDay: number;
}

export class DataStore {
  private days: DayMap = new Map();
  private cached: Dataset | null = null;
  readonly sources = new Set<SourceKind>();
  /** 変更のたびに増える（描画キャッシュの判定用） */
  version = 0;

  get dayCount(): number {
    return this.days.size;
  }

  get isEmpty(): boolean {
    return this.days.size === 0;
  }

  get isDemo(): boolean {
    return this.sources.has('demo');
  }

  clear(): void {
    this.days.clear();
    this.sources.clear();
    this.invalidate();
  }

  /**
   * 日別データを追加する。既存の日と重なる場合、読み込んだ CSV（upload）は有効な値で上書きし、
   * 取得済みデータ（bundled・後から遅延読み込みされる）は空いている値だけを埋める。
   */
  addDays(incoming: DayMap, kind: SourceKind): void {
    const overwrite = kind !== 'bundled';
    for (const [day, vals] of incoming) {
      const cur = this.days.get(day);
      if (!cur) {
        this.days.set(day, vals);
        continue;
      }
      for (let i = 0; i < vals.length; i++) {
        if (Number.isNaN(vals[i])) continue;
        if (overwrite || Number.isNaN(cur[i])) cur[i] = vals[i];
      }
    }
    this.sources.add(kind);
    this.invalidate();
  }

  /** データのある日（昇順） */
  dayKeys(): number[] {
    return [...this.days.keys()].sort((a, b) => a - b);
  }

  /** データのある最初と最後の日（空なら null） */
  extent(): { first: number; last: number } | null {
    if (this.days.size === 0) return null;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const day of this.days.keys()) {
      if (day < first) first = day;
      if (day > last) last = day;
    }
    return { first, last };
  }

  private invalidate(): void {
    this.cached = null;
    this.version++;
  }

  dataset(): Dataset | null {
    if (this.days.size === 0) return null;
    if (this.cached) return this.cached;
    const keys = this.dayKeys();
    const start = keys[0];
    const end = keys[keys.length - 1];
    const n = end - start + 1;
    const values = SERIES_KEYS.map(() => new Float64Array(n * SLOTS).fill(Number.NaN));
    const present = new Uint8Array(n);
    const dow = new Uint8Array(n);
    const offDay = new Uint8Array(n);
    const holiday = new Uint8Array(n);
    const y = new Uint16Array(n);
    const m = new Uint8Array(n);
    const d = new Uint8Array(n);
    const fy = new Uint16Array(n);
    const hasSeries = Object.fromEntries(SERIES_KEYS.map((k) => [k, false])) as Record<SeriesKey, boolean>;

    for (let i = 0; i < n; i++) {
      const day = start + i;
      const ymd = ymdFromDay(day);
      y[i] = ymd.y;
      m[i] = ymd.m;
      d[i] = ymd.d;
      fy[i] = fiscalYearOf(ymd.y, ymd.m);
      dow[i] = dowOfDay(day);
      holiday[i] = isNationalHoliday(day) ? 1 : 0;
      offDay[i] = dow[i] === 0 || dow[i] === 6 || holiday[i] ? 1 : 0;
    }

    for (const [day, vals] of this.days) {
      const i = day - start;
      present[i] = 1;
      for (let s = 0; s < SERIES_COUNT; s++) {
        const src = vals.subarray(s * SLOTS, (s + 1) * SLOTS);
        values[s].set(src, i * SLOTS);
        if (!hasSeries[SERIES_KEYS[s]]) {
          for (let k = 0; k < SLOTS; k++) {
            if (!Number.isNaN(src[k])) {
              hasSeries[SERIES_KEYS[s]] = true;
              break;
            }
          }
        }
      }
    }

    this.cached = { start, n, values, present, dow, offDay, holiday, y, m, d, fy, hasSeries, firstDay: start, lastDay: end };
    return this.cached;
  }
}
