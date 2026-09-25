/**
 * 入札カーブのデータ（ブラウザ側）。
 * 指標は年度ごと、描画用のカーブは 1 日ごとのファイルを、必要になったときに読み込む。
 * デモでは、デモデータ（合成）の価格の近くで交わる合成のカーブを直近 90 日ぶん作る。
 */
import {
  CURVE_METRIC_INDEX,
  curveDayFile,
  decodeCurveDay,
  decodeCurveMetrics,
  encodeCurveDay,
  metricsOfDayFile,
  type CurveDay,
  type CurveDayFile,
  type CurveMetricKey,
} from './bidCurves';
import type { CurveIndex } from './dataFile';
import { fiscalYearEnd, fiscalYearStart, parseDateString } from './dates';
import { syntheticCurveDay } from './demoCurves';
import { AREA_KEYS, kwhToMw, SERIES_INDEX, SLOTS, type SeriesKey } from './series';
import type { Dataset } from './store';

export type ReadFile = (file: string) => Promise<unknown>;

/** デモで合成のカーブを作る日数（npm run fetch の既定と同じ） */
export const DEMO_CURVE_DAYS = 90;
/** 比較の図で重ねる日数 */
export const COMPARE_DAYS = 7;
/** 描画用のカーブを手元に置いておく日数 */
const MAX_CACHED_DAYS = 40;

type Source = { kind: 'files'; index: CurveIndex; read: ReadFile } | { kind: 'demo'; ds: Dataset };

export class CurveStore {
  /** 描画用のカーブがある日（昇順） */
  readonly days: number[];
  /**
   * 指標のある期間と日数（期間で見る図の範囲）。
   * 1 ファイル版では描画用のカーブを直近の数日分だけ入れるので、days より長いことがある
   */
  readonly metricsFirst: number;
  readonly metricsLast: number;
  readonly metricDays: number;
  private readonly daySet: Set<number>;
  private readonly metrics = new Map<number, Float64Array>();
  private readonly loadedFy = new Set<number>();
  private readonly pendingFy = new Map<number, Promise<void>>();
  private readonly shapes = new Map<number, CurveDay>();
  private readonly pendingDay = new Map<number, Promise<void>>();
  private readonly aligned = new Map<string, Float64Array>();
  private demoMetricsBuilt = false;
  /** 指標が増えるたびに増える（そろえた配列のキャッシュの判定用） */
  private version = 0;

  private constructor(
    days: number[],
    private readonly source: Source,
    metrics?: { first: number; last: number; days: number },
  ) {
    this.days = days;
    this.daySet = new Set(days);
    this.metricsFirst = metrics?.first ?? days[0];
    this.metricsLast = metrics?.last ?? days[days.length - 1];
    this.metricDays = metrics?.days ?? days.length;
  }

  static fromIndex(index: CurveIndex, read: ReadFile): CurveStore | null {
    const days = index.dates
      .map(parseDateString)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);
    if (days.length === 0) return null;
    const firsts = index.metrics.map((m) => parseDateString(m.firstDate)).filter((d): d is number => d !== null);
    const lasts = index.metrics.map((m) => parseDateString(m.lastDate)).filter((d): d is number => d !== null);
    const metrics =
      firsts.length > 0 && lasts.length > 0
        ? { first: Math.min(...firsts), last: Math.max(...lasts), days: index.metrics.reduce((n, m) => n + m.days, 0) }
        : undefined;
    return new CurveStore(days, { kind: 'files', index, read }, metrics);
  }

  /** デモデータの直近の日から合成のカーブを作る */
  static demo(ds: Dataset): CurveStore | null {
    const days: number[] = [];
    for (let i = ds.n - 1; i >= 0 && days.length < DEMO_CURVE_DAYS; i--) if (ds.present[i]) days.push(ds.start + i);
    days.reverse();
    return days.length > 0 ? new CurveStore(days, { kind: 'demo', ds }) : null;
  }

  get isDemo(): boolean {
    return this.source.kind === 'demo';
  }

  get first(): number {
    return this.days[0];
  }

  get last(): number {
    return this.days[this.days.length - 1];
  }

  has(day: number): boolean {
    return this.daySet.has(day);
  }

  /** day のカーブが無ければ、それ以前で最も近いカーブのある日（無ければ最初の日）。未指定なら最新の日 */
  resolve(day: number): number {
    if (!Number.isFinite(day)) return this.last;
    if (this.daySet.has(day)) return day;
    let best = this.days[0];
    for (const d of this.days) {
      if (d > day) break;
      best = d;
    }
    return best;
  }

  /** カーブのある日の中で、day から step 日分前（負）・後ろの日（無ければ null） */
  step(day: number, step: number): number | null {
    const i = this.days.indexOf(day);
    const j = i + step;
    return i >= 0 && j >= 0 && j < this.days.length ? this.days[j] : null;
  }

  /** day 以前のカーブのある n 日（古い順） */
  recent(day: number, n: number): number[] {
    const i = this.days.indexOf(day);
    return i < 0 ? [] : this.days.slice(Math.max(0, i - n + 1), i + 1);
  }

  getDay(day: number): CurveDay | undefined {
    return this.shapes.get(day);
  }

  /**
   * 描画用のカーブを 1 日分読む（手元には置かない。多くの日のカーブを順に集計するときに使う）。
   * 読み込み済みならそれを返す。カーブの無い日は null
   */
  async readDay(day: number): Promise<CurveDay | null> {
    const cached = this.shapes.get(day);
    if (cached) return cached;
    if (!this.daySet.has(day)) return null;
    const source = this.source;
    if (source.kind === 'demo') {
      const file = this.synth(source.ds, day);
      return file ? decodeCurveDay(file) : null;
    }
    return decodeCurveDay(await source.read(curveDayFile(day)));
  }

  /** 描画用のカーブを読み込む（すべて読み込み済みなら null） */
  ensureDays(days: number[]): Promise<void> | null {
    const need = days.filter((d) => this.daySet.has(d) && !this.shapes.has(d));
    if (need.length === 0) return null;
    return Promise.all(need.map((d) => this.loadDay(d))).then(() => this.trim(days));
  }

  private loadDay(day: number): Promise<void> {
    let p = this.pendingDay.get(day);
    if (!p) {
      const source = this.source;
      p = (async () => {
        if (source.kind === 'demo') {
          const file = this.synth(source.ds, day);
          if (file) this.shapes.set(day, decodeCurveDay(file));
        } else {
          this.shapes.set(day, decodeCurveDay(await source.read(curveDayFile(day))));
        }
      })().finally(() => this.pendingDay.delete(day));
      this.pendingDay.set(day, p);
    }
    return p;
  }

  /** 手元に置くカーブが多くなったら、今使っていないものから捨てる */
  private trim(keep: number[]): void {
    const k = new Set(keep);
    for (const d of this.shapes.keys()) {
      if (this.shapes.size <= MAX_CACHED_DAYS) break;
      if (!k.has(d)) this.shapes.delete(d);
    }
  }

  /** 期間 [from, to] の指標を読み込む（読み込み済みなら null） */
  ensureMetrics(from: number, to: number): Promise<void> | null {
    const source = this.source;
    if (source.kind === 'demo') {
      if (!this.demoMetricsBuilt) this.buildDemoMetrics(source.ds);
      return null;
    }
    const need = source.index.metrics.filter((m) => {
      if (this.loadedFy.has(m.fy)) return false;
      const a = parseDateString(m.firstDate) ?? fiscalYearStart(m.fy);
      const b = parseDateString(m.lastDate) ?? fiscalYearEnd(m.fy);
      return a <= to && b >= from;
    });
    if (need.length === 0) return null;
    return Promise.all(
      need.map((m) => {
        let p = this.pendingFy.get(m.fy);
        if (!p) {
          p = source
            .read(m.file)
            .then((json) => {
              for (const [day, vals] of decodeCurveMetrics(json)) this.metrics.set(day, vals);
              this.loadedFy.add(m.fy);
              this.version++;
            })
            .finally(() => this.pendingFy.delete(m.fy));
          this.pendingFy.set(m.fy, p);
        }
        return p;
      }),
    ).then(() => undefined);
  }

  /** 指標を Dataset の日の並びにそろえた配列（n × 48、無い値は NaN） */
  metricArray(ds: Dataset, key: CurveMetricKey): Float64Array {
    const cacheKey = `${key}|${ds.start}|${ds.n}|${this.version}`;
    let out = this.aligned.get(cacheKey);
    if (out) return out;
    out = new Float64Array(ds.n * SLOTS).fill(Number.NaN);
    const m = CURVE_METRIC_INDEX[key];
    for (const [day, vals] of this.metrics) {
      const i = day - ds.start;
      if (i < 0 || i >= ds.n) continue;
      out.set(vals.subarray(m * SLOTS, (m + 1) * SLOTS), i * SLOTS);
    }
    if (this.aligned.size > 40) this.aligned.clear();
    this.aligned.set(cacheKey, out);
    return out;
  }

  /** デモデータの 1 日分の価格・約定量から合成のカーブを作る */
  private synth(ds: Dataset, day: number): CurveDayFile | null {
    const i = day - ds.start;
    if (i < 0 || i >= ds.n || !ds.present[i]) return null;
    const at = (k: SeriesKey, s: number) => ds.values[SERIES_INDEX[k]][i * SLOTS + s];
    const targets = Array.from({ length: SLOTS }, (_, s) => ({
      system: at('system', s),
      volume: kwhToMw(at('volume', s)),
      areas: Object.fromEntries(AREA_KEYS.map((a) => [a, at(a, s)])),
    }));
    const { raw, groups } = syntheticCurveDay(day, targets);
    return encodeCurveDay(raw, groups);
  }

  private buildDemoMetrics(ds: Dataset): void {
    for (const day of this.days) {
      const file = this.synth(ds, day);
      if (file) this.metrics.set(day, metricsOfDayFile(file));
    }
    this.demoMetricsBuilt = true;
    this.version++;
  }
}
