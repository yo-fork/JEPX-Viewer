/**
 * 連系線のデータ（ブラウザ側）。広域機関の公表値の年度ファイル（interties/fyYYYY.json）を、必要になったときに読み込む。
 * 間接送電権の取引結果（interties/transmission-rights.json）も、最初に連系線を読み込むときに一緒に読む。
 * デモでは、デモデータのエリア価格から、分断したコマは上限まで（安い側から高い側へ）流れる合成の値を作る。
 */
import type { IntertieIndex, RightsIndex } from './dataFile';
import { dowOfDay, fiscalYearEnd, fiscalYearStart, isoFromDay, parseDateString } from './dates';
import { mulberry32 } from './demo';
import {
  areaNetImports,
  decodeIntertieFy,
  DERIVED_FIELDS,
  FENCE_PARTS,
  INTERTIE_DEFS,
  INTERTIE_FIELD_INDEX,
  INTERTIE_INDEX,
  INTERTIE_KEYS,
  intertieOffset,
  type IntertieDays,
  type IntertieField,
  type IntertieKey,
} from './occto';
import { AREA_KEYS, SERIES_INDEX, SLOTS, type AreaKey } from './series';
import type { Dataset } from './store';
import {
  allProducts,
  decodeRightsFile,
  estimateCancellation,
  rightsLink,
  rightsVolumes,
  type ByDirection,
  type RightsProduct,
} from './transmissionRights';

export type ReadFile = (file: string) => Promise<unknown>;

/** デモで値を作る日数 */
export const DEMO_INTERTIE_DAYS = 365;

/** デモの連系線と、計画潮流の上限（順方向・逆方向、MW） */
const DEMO_LIMITS: Partial<Record<IntertieKey, [number, number]>> = {
  hokkaidoHonshu: [900, -900],
  tohokuTokyo: [5550, -2400],
  tokyoChubu: [2100, -2100],
  chubuFence: [2500, -3000],
  hokurikuFence: [1500, -1500],
  kansaiFence: [2500, -2800],
  kansaiChugoku: [4000, -4300],
  kansaiShikoku: [1400, -1400],
  chugokuShikoku: [1200, -1200],
  chugokuKyushu: [2600, -2400],
};

/**
 * デモの作業停止: 連系線ごとに、1 割ほどの週に 2〜4 日、上限を 4〜6 割に下げる。その日の上限に掛ける係数（停止していなければ 1）
 */
function demoOutage(line: number, day: number): number {
  const week = Math.floor(day / 7);
  const rand = mulberry32(week * 389 + line * 53 + 11);
  if (rand() >= 0.1) return 1;
  const start = Math.floor(rand() * 4);
  const len = 2 + Math.floor(rand() * 3);
  const scale = 0.4 + rand() * 0.2;
  const i = day - week * 7;
  return i >= start && i < start + len ? scale : 1;
}

/** デモの間接送電権の向き（送電側 → 受電側。2026 年度の JEPX の商品と同じ向き） */
const DEMO_RIGHTS: [AreaKey, AreaKey][] = [
  ['hokkaido', 'tohoku'],
  ['tohoku', 'hokkaido'],
  ['tohoku', 'tokyo'],
  ['tokyo', 'chubu'],
  ['chubu', 'tokyo'],
  ['chugoku', 'kansai'],
  ['shikoku', 'kansai'],
  ['shikoku', 'chugoku'],
  ['kyushu', 'chugoku'],
];

/**
 * デモの間接送電権: [first, last] を土曜から金曜の週間商品に分ける。売り入札量はその向きの上限（作業停止で下がる前の値）、
 * 約定量はその 5〜10 割（1 割ほどの商品は約定しない）。作業停止で上限が約定量より下がった日に、推定キャンセル量が出る
 */
function demoRights(first: number, last: number): RightsProduct[] {
  const products: RightsProduct[] = [];
  // first を含む週の土曜（dowOfDay は 6 が土曜）
  const sat0 = first - ((dowOfDay(first) + 1) % 7);
  DEMO_RIGHTS.forEach(([from, to], j) => {
    const link = rightsLink(from, to);
    const lim = link && DEMO_LIMITS[link.line];
    if (!link || !lim) return;
    const cap = link.dir > 0 ? lim[0] : -lim[1];
    const pair = `T${AREA_KEYS.indexOf(from) + 1}${AREA_KEYS.indexOf(to) + 1}`;
    for (let sat = sat0; sat <= last; sat += 7) {
      const rand = mulberry32(sat * 97 + j * 13 + 5);
      const sold = rand() >= 0.1;
      products.push({
        code: `D${isoFromDay(sat).replace(/-/g, '')}${pair}`,
        label: 'デモ',
        from,
        to,
        tradeDay: sat - 60,
        first: sat,
        last: sat + 6,
        offer: cap,
        price: sold ? Math.round((0.01 + rand() * 1.5) * 100) / 100 : null,
        volume: sold ? Math.round(cap * (0.5 + rand() * 0.5) * 10) / 10 : null,
      });
    }
  });
  return products;
}

type Source = { kind: 'files'; index: IntertieIndex; read: ReadFile; rights?: RightsIndex } | { kind: 'demo'; ds: Dataset };

/** 公表されていないコマを補った値と、補ったコマの印（1。補わない連系線・値の種類では null） */
export interface DerivedValues {
  values: Float64Array;
  derived: Uint8Array | null;
}

/** 連系線の 1 つの向きの間接送電権: 約定量の合計と推定キャンセル量（MW、正の値。Dataset の日の並び × 48） */
export interface RightsSeries {
  volume: Float64Array;
  cancel: Float64Array;
}

export class IntertieStore {
  /** データのある期間 */
  readonly first: number;
  readonly last: number;
  private readonly days: IntertieDays = new Map();
  private readonly loadedFy = new Set<number>();
  private readonly pendingFy = new Map<number, Promise<void>>();
  private readonly aligned = new Map<string, Float64Array>();
  private readonly derivedArrays = new Map<string, DerivedValues>();
  private net: { key: string; value: Record<AreaKey, Float64Array> } | null = null;
  private version = 0;
  /** 間接送電権の商品（読み込んでいなければ null）と、読み込めなかったときの理由 */
  private rights: RightsProduct[] | null = null;
  private rightsPending: Promise<void> | null = null;
  private rightsFailure: string | null = null;
  private readonly rightsCache = new Map<string, ByDirection<RightsSeries>>();

  private constructor(
    private readonly source: Source,
    first: number,
    last: number,
  ) {
    this.first = first;
    this.last = last;
  }

  /** @param rights 間接送電権の取引結果（取得していなければ undefined） */
  static fromIndex(index: IntertieIndex, read: ReadFile, rights?: RightsIndex): IntertieStore | null {
    const first = parseDateString(index.firstDate);
    const last = parseDateString(index.lastDate);
    if (first === null || last === null || index.files.length === 0) return null;
    return new IntertieStore({ kind: 'files', index, read, rights }, first, last);
  }

  /** デモデータの直近 DEMO_INTERTIE_DAYS 日の値（間接送電権も）を作る */
  static demo(ds: Dataset): IntertieStore | null {
    if (ds.n === 0) return null;
    const last = ds.start + ds.n - 1;
    const st = new IntertieStore({ kind: 'demo', ds }, Math.max(ds.start, last - DEMO_INTERTIE_DAYS + 1), last);
    st.rights = demoRights(st.first, st.last);
    return st;
  }

  get isDemo(): boolean {
    return this.source.kind === 'demo';
  }

  /** 間接送電権の取引結果があるか（取得していなければ false。読み込む前でも true） */
  get hasRights(): boolean {
    return this.source.kind === 'demo' || this.source.rights !== undefined;
  }

  /** 間接送電権の取引結果を読み込めなかったときの理由（読み込めたか、まだなら null） */
  get rightsError(): string | null {
    return this.rightsFailure;
  }

  /** 期間 [from, to] の年度ファイルと、間接送電権の取引結果を読み込む（読み込み済みなら null） */
  ensure(from: number, to: number): Promise<void> | null {
    const source = this.source;
    if (source.kind === 'demo') return null;
    const rights = this.ensureRights();
    const need = source.index.files.filter((f) => {
      if (this.loadedFy.has(f.fy)) return false;
      const a = parseDateString(f.firstDate) ?? fiscalYearStart(f.fy);
      const b = parseDateString(f.lastDate) ?? fiscalYearEnd(f.fy);
      return a <= to && b >= from;
    });
    if (need.length === 0) return rights;
    return Promise.all([
      rights,
      ...need.map((f) => {
        let p = this.pendingFy.get(f.fy);
        if (!p) {
          p = source
            .read(f.file)
            .then((json) => {
              for (const [day, vals] of decodeIntertieFy(json)) this.days.set(day, vals);
              this.loadedFy.add(f.fy);
              this.version++;
            })
            .finally(() => this.pendingFy.delete(f.fy));
          this.pendingFy.set(f.fy, p);
        }
        return p;
      }),
    ]).then(() => undefined);
  }

  /**
   * 間接送電権の取引結果を読み込む（読み込み済みか、取得していないか、前に読み込めなかったなら null）。
   * 読み込めなくても連系線の図は描けるので、失敗は rightsError に残し、ここでは失敗にしない
   */
  private ensureRights(): Promise<void> | null {
    const source = this.source;
    if (source.kind === 'demo' || !source.rights || this.rights || this.rightsFailure !== null) return null;
    const file = source.rights.file;
    this.rightsPending ??= (async () => {
      try {
        this.rights = allProducts(decodeRightsFile(await source.read(file)));
        this.version++;
      } catch (err) {
        this.rightsFailure = (err as Error).message;
      } finally {
        this.rightsPending = null;
      }
    })();
    return this.rightsPending;
  }

  /**
   * 連系線の向きごとの、間接送電権の約定量の合計と推定キャンセル量（transmissionRights.ts の estimateCancellation）。
   * その向きの商品が無ければ null（間接送電権を取得していないか、まだ読み込んでいなければ、どちらも null）
   */
  rightsOf(ds: Dataset, line: IntertieKey): ByDirection<RightsSeries> {
    if (!this.rights) return { fwd: null, rev: null };
    const key = `${line}|${ds.start}|${ds.n}|${this.version}`;
    let out = this.rightsCache.get(key);
    if (out) return out;
    const volumes = rightsVolumes(this.rights, ds.start, ds.n, line);
    const side = (volume: Float64Array | null, dir: 1 | -1): RightsSeries | null => {
      if (!volume) return null;
      const [cap, lim] = dir > 0 ? (['capFwd', 'limFwd'] as const) : (['capRev', 'limRev'] as const);
      return { volume, cancel: estimateCancellation(volume, this.array(ds, line, cap), this.array(ds, line, lim), dir, ds.start) };
    };
    out = { fwd: side(volumes.fwd, 1), rev: side(volumes.rev, -1) };
    if (this.rightsCache.size > 20) this.rightsCache.clear();
    this.rightsCache.set(key, out);
    return out;
  }

  /** 連系線の値を Dataset の日の並びにそろえた配列（n × 48、無い値は NaN） */
  array(ds: Dataset, line: IntertieKey, field: IntertieField): Float64Array {
    const key = `${line}|${field}|${ds.start}|${ds.n}|${this.version}`;
    let out = this.aligned.get(key);
    if (out) return out;
    out = new Float64Array(ds.n * SLOTS).fill(Number.NaN);
    if (this.source.kind === 'demo') {
      this.fillDemo(out, ds, line, field);
    } else {
      const off = intertieOffset(INTERTIE_INDEX[line], INTERTIE_FIELD_INDEX[field]);
      for (const [day, vals] of this.days) {
        const i = day - ds.start;
        if (i < 0 || i >= ds.n) continue;
        out.set(vals.subarray(off, off + SLOTS), i * SLOTS);
      }
    }
    if (this.aligned.size > 60) this.aligned.clear();
    this.aligned.set(key, out);
    return out;
  }

  /**
   * array と同じ値に、中部フェンスと関西フェンスの計画潮流と潮流実績だけは、公表されていないコマ（2026 年 3 月 12 日受渡分まで）を
   * 個別の連系線の和（occto.ts の FENCE_PARTS）で補ったもの。上限と運用容量は補わない
   */
  withDerived(ds: Dataset, line: IntertieKey, field: IntertieField): DerivedValues {
    const values = this.array(ds, line, field);
    const parts = FENCE_PARTS[line];
    if (!parts || !DERIVED_FIELDS.includes(field)) return { values, derived: null };
    const key = `${line}|${field}|${ds.start}|${ds.n}|${this.version}`;
    let out = this.derivedArrays.get(key);
    if (out) return out;
    const sources = parts.map((p) => this.array(ds, p, field));
    const filled = values.slice();
    const derived = new Uint8Array(filled.length);
    for (let k = 0; k < filled.length; k++) {
      if (!Number.isNaN(filled[k])) continue;
      let sum = 0;
      for (const a of sources) sum += a[k];
      if (Number.isNaN(sum)) continue;
      filled[k] = Math.round(sum * 10) / 10;
      derived[k] = 1;
    }
    out = { values: filled, derived };
    if (this.derivedArrays.size > 20) this.derivedArrays.clear();
    this.derivedArrays.set(key, out);
    return out;
  }

  /** エリアごとの正味の受け入れ量（MW、Dataset の日の並び × 48。計画潮流（翌日）から occto.ts の areaNetImports で求める） */
  netImports(ds: Dataset): Record<AreaKey, Float64Array> {
    const key = `${ds.start}|${ds.n}|${this.version}`;
    if (this.net?.key === key) return this.net.value;
    const plans = new Map(INTERTIE_KEYS.map((k) => [k, this.array(ds, k, 'plan')]));
    const value = Object.fromEntries(AREA_KEYS.map((a) => [a, new Float64Array(ds.n * SLOTS).fill(Number.NaN)])) as Record<AreaKey, Float64Array>;
    // データのある期間だけ求める
    const from = Math.max(this.first, ds.start) - ds.start;
    const to = Math.min(this.last, ds.start + ds.n - 1) - ds.start;
    for (let k = from * SLOTS; k < (to + 1) * SLOTS; k++) {
      const net = areaNetImports((line) => plans.get(line)![k]);
      for (const a of AREA_KEYS) value[a][k] = net[a];
    }
    this.net = { key, value };
    return value;
  }

  /** その日・コマの値（無ければ NaN） */
  valueAt(ds: Dataset, day: number, slot: number, line: IntertieKey, field: IntertieField): number {
    const i = day - ds.start;
    return i < 0 || i >= ds.n ? Number.NaN : this.array(ds, line, field)[i * SLOTS + slot];
  }

  /** 読み込んだ期間に計画潮流の値（中部フェンスと関西フェンスは、個別の連系線から補った値も含む）がある連系線（INTERTIE_DEFS の順） */
  linesWithData(ds: Dataset, from: number, to: number): IntertieKey[] {
    return INTERTIE_DEFS.map((d) => d.key).filter((k) => {
      const a = this.withDerived(ds, k, 'plan').values;
      for (let i = Math.max(0, from - ds.start); i <= Math.min(ds.n - 1, to - ds.start); i++) {
        for (let s = 0; s < SLOTS; s++) if (!Number.isNaN(a[i * SLOTS + s])) return true;
      }
      return false;
    });
  }

  /**
   * デモの値: 両側のエリアの価格が違えば（市場分断）、安い側から高い側へ上限まで流れる。同じなら上限の内側で日内に揺れる。
   * 作業停止の日（demoOutage）は上限が下がる。潮流実績は計画潮流に小さな揺らぎを足したもの
   */
  private fillDemo(out: Float64Array, ds: Dataset, line: IntertieKey, field: IntertieField): void {
    const nominal = DEMO_LIMITS[line];
    if (!nominal) return;
    const def = INTERTIE_DEFS[INTERTIE_INDEX[line]];
    const price = (areas: readonly AreaKey[], k: number) => areas.reduce((v, a) => v + ds.values[SERIES_INDEX[a]][k], 0) / areas.length;
    const from = Math.max(this.first, ds.start);
    const to = Math.min(this.last, ds.start + ds.n - 1);
    for (let day = from; day <= to; day++) {
      const i = day - ds.start;
      const cut = demoOutage(INTERTIE_INDEX[line], day);
      const lim = nominal.map((v) => Math.round(v * cut));
      const rand = mulberry32(day * 131 + INTERTIE_INDEX[line] * 17 + 7);
      const phase = rand() * Math.PI * 2;
      for (let s = 0; s < SLOTS; s++) {
        const k = i * SLOTS + s;
        const pa = price(def.from, k);
        const pb = price(def.to, k);
        if (!Number.isFinite(pa) || !Number.isFinite(pb)) continue;
        const free = 0.35 * Math.sin((s / SLOTS) * Math.PI * 2 + phase) + 0.15;
        const plan = Math.abs(pa - pb) > 0.005 ? (pa < pb ? lim[0] : lim[1]) : Math.round(free * (free >= 0 ? lim[0] : -lim[1]));
        const v =
          field === 'plan' || field === 'planFinal'
            ? plan
            : field === 'limFwd'
              ? lim[0]
              : field === 'limRev'
                ? lim[1]
                : field === 'capFwd'
                  ? lim[0] + 100
                  : field === 'capRev'
                    ? lim[1] - 100
                    : Math.round(plan + (rand() - 0.5) * 0.08 * (lim[0] - lim[1]));
        out[k] = v;
      }
    }
  }
}
