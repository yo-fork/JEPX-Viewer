/**
 * 間接送電権: 日本卸電力取引所（JEPX）「間接送電権市場」の取引結果。取得スクリプトとブラウザの両方で使う。
 *
 * 間接送電権は、スポット市場のエリア間の値差を受け取る（負なら支払う）権利で、連系線の向きごとに、
 * 週間商品（土曜から金曜）と年間商品（4 月 1 日から翌年 3 月 31 日）がある。どちらも 24 時間同じ量。
 * JEPX が公表しているのは商品ごとの売り入札量、約定価格、約定量だけで（取引規程第 91 条）、
 * キャンセル量（取引規程第 87 条の「買い量の減少」）は保有者に個別に通知される。そこで、画面では推定値を出す（estimateCancellation）。
 *
 * interties/transmission-rights.json … 取得した年度（CSV の年度。約定日の年度）ごとの商品の一覧
 */
import { parseCsv } from './csv';
import { dayFromYmd, isoFromDay, parseDateString } from './dates';
import { INTERTIE_DEFS, type IntertieKey } from './occto';
import { AREAS, SLOTS, type AreaKey } from './series';

export const RIGHTS_FILE = 'interties/transmission-rights.json';
export const RIGHTS_FILE_FORMAT = 'jepx-viewer/transmission-rights@1';
/** 間接送電権の取引は 2019 年度から */
export const FIRST_RIGHTS_FY = 2019;
/**
 * 推定キャンセル量を求め始める日。2025 年度までは経過措置計画量（取得したデータに無い）も差し引かれ、
 * 翌日の広域調整枠を差し引いていたかも分からないので、経過措置が終わった 2026 年度から求める
 * （翌日の広域調整枠は 2026 年 3 月 14 日受渡分から 0）
 */
export const RIGHTS_ESTIMATE_FROM = dayFromYmd(2026, 4, 1);

/** 間接送電権の商品（取引結果の CSV の 1 行） */
export interface RightsProduct {
  /** 商品名（例: 26W23T43。年間商品は Y27 で始まる） */
  code: string;
  /** 説明（例: 6月1週ＦＣ[逆]） */
  label: string;
  /** 値差をとる向き（送電側 → 受電側のエリア。受電側の価格 − 送電側の価格を受け取る） */
  from: AreaKey;
  to: AreaKey;
  /** 約定日と対象期間（日） */
  tradeDay: number;
  first: number;
  last: number;
  /** 売り入札量（MW） */
  offer: number;
  /** 約定価格（円/kWh）と約定量（MW）。約定しなかった商品は null */
  price: number | null;
  volume: number | null;
}

/** ファイルの 1 行: 商品名、説明、送電側、受電側、約定日、対象期間（自）、対象期間（至）、売り入札量、約定価格、約定量 */
type RightsRow = [string, string, AreaKey, AreaKey, string, string, string, number, number | null, number | null];

export interface RightsFile {
  format: typeof RIGHTS_FILE_FORMAT;
  /** 取得した CSV（約定日の年度ごと） */
  years: { fy: number; rows: RightsRow[] }[];
}

/** 取得した年度 → その年度の CSV の商品 */
export type RightsYears = Map<number, RightsProduct[]>;

export function encodeRightsFile(years: RightsYears): RightsFile {
  return {
    format: RIGHTS_FILE_FORMAT,
    years: [...years.keys()]
      .sort((a, b) => a - b)
      .map((fy) => ({
        fy,
        rows: years
          .get(fy)!
          .map((p): RightsRow => [p.code, p.label, p.from, p.to, isoFromDay(p.tradeDay), isoFromDay(p.first), isoFromDay(p.last), p.offer, p.price, p.volume]),
      })),
  };
}

const AREA_SET = new Set<string>(AREAS.map((a) => a.key));

export function decodeRightsFile(json: unknown): RightsYears {
  const file = json as RightsFile;
  if (!file || file.format !== RIGHTS_FILE_FORMAT || !Array.isArray(file.years)) throw new Error('間接送電権のファイルの形式が不正です');
  const years: RightsYears = new Map();
  for (const y of file.years) {
    const products: RightsProduct[] = [];
    for (const [code, label, from, to, trade, first, last, offer, price, volume] of y.rows) {
      const days = [trade, first, last].map((d) => parseDateString(d));
      if (days.some((d) => d === null) || !AREA_SET.has(from) || !AREA_SET.has(to)) continue;
      products.push({ code, label, from, to, tradeDay: days[0]!, first: days[1]!, last: days[2]!, offer, price, volume });
    }
    years.set(y.fy, products);
  }
  return years;
}

/** 全年度の商品を 1 つの並びに（年度の古い順） */
export function allProducts(years: RightsYears): RightsProduct[] {
  return [...years.keys()].sort((a, b) => a - b).flatMap((fy) => years.get(fy)!);
}

/** 商品の対象期間の最初と最後の日（商品が無ければ null） */
export function rightsSpan(products: readonly RightsProduct[]): [number, number] | null {
  if (products.length === 0) return null;
  let a = Number.POSITIVE_INFINITY;
  let b = Number.NEGATIVE_INFINITY;
  for (const p of products) {
    a = Math.min(a, p.first);
    b = Math.max(b, p.last);
  }
  return [a, b];
}

const RIGHTS_COLUMNS = ['商品名', '説明', '方向', '約定日', '対象期間(自)', '対象期間(至)', '売り入札量(MW)', '約定価格(円/kWh)', '約定量(MW)'] as const;

/** 列名から、間接送電権の取引結果の CSV か見分ける */
export function isRightsCsv(text: string): boolean {
  const head = text.slice(0, 2000).split(/\r?\n/, 1)[0] ?? '';
  return /^﻿?商品名,説明,方向,約定日,/.test(head) && head.includes('約定量');
}

const AREA_BY_LABEL = new Map<string, AreaKey>(AREAS.map((a) => [a.label, a.key]));

/** 「中部 -> 東京」のエリア。読めなければ、商品名の末尾（T43 なら 4 番目のエリアから 3 番目のエリア）から */
function directionOf(text: string, code: string): [AreaKey, AreaKey] | null {
  const parts = text.split('->').map((s) => AREA_BY_LABEL.get(s.trim()));
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0], parts[1]];
  const m = /T(\d)(\d)$/.exec(code.trim());
  const from = m ? AREAS[Number(m[1]) - 1]?.key : undefined;
  const to = m ? AREAS[Number(m[2]) - 1]?.key : undefined;
  return from && to ? [from, to] : null;
}

/** 数（「-」と空欄は null。桁区切りのカンマは除く） */
function amount(s: string | undefined): number | null {
  const t = (s ?? '').trim().replace(/,/g, '');
  if (t === '' || t === '-') return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

export interface RightsParseResult {
  products: RightsProduct[];
  /** 読めなかった行の数 */
  skipped: number;
}

/** 間接送電権の取引結果の CSV を読む */
export function parseRightsCsv(text: string): RightsParseResult {
  if (!isRightsCsv(text)) throw new Error('間接送電権の取引結果の CSV ではありません');
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const header = table[0].map((h) => h.trim());
  const [cCode, cLabel, cDir, cTrade, cFirst, cLast, cOffer, cPrice, cVolume] = RIGHTS_COLUMNS.map((name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`間接送電権の CSV に「${name}」の列がありません`);
    return i;
  });
  const products: RightsProduct[] = [];
  let skipped = 0;
  for (const r of table.slice(1)) {
    const code = (r[cCode] ?? '').trim();
    const dir = directionOf(r[cDir] ?? '', code);
    const [trade, first, last] = [cTrade, cFirst, cLast].map((c) => parseDateString(r[c] ?? ''));
    if (!code || !dir || trade === null || first === null || last === null || last < first) {
      skipped++;
      continue;
    }
    const volume = amount(r[cVolume]);
    products.push({
      code,
      label: (r[cLabel] ?? '').trim(),
      from: dir[0],
      to: dir[1],
      tradeDay: trade,
      first,
      last,
      offer: amount(r[cOffer]) ?? 0,
      // 約定量が 0 の商品は、約定しなかったものとして扱う
      price: volume ? amount(r[cPrice]) : null,
      volume: volume || null,
    });
  }
  return { products, skipped };
}

/** 連系線と、その上の向き（1: 順方向、−1: 逆方向） */
export interface RightsLink {
  line: IntertieKey;
  dir: 1 | -1;
}

/**
 * 値差をとる向き（送電側 → 受電側）の連系線と向き。対応する連系線が無ければ null。
 * 1 つのエリアどうしを結ぶ連系線から探す（関西-中国間は、内訳の東・西ではなく全体）
 */
export function rightsLink(from: AreaKey, to: AreaKey): RightsLink | null {
  for (const d of INTERTIE_DEFS) {
    if (d.from.length !== 1 || d.to.length !== 1) continue;
    if (d.from[0] === from && d.to[0] === to) return { line: d.key, dir: 1 };
    if (d.from[0] === to && d.to[0] === from) return { line: d.key, dir: -1 };
  }
  return null;
}

/** 連系線の向きごとの値（その向きの商品が無ければ null） */
export interface ByDirection<T> {
  fwd: T | null;
  rev: T | null;
}

/**
 * 連系線の向きごとの、間接送電権の約定量の合計（MW、正の値。start の日からの n 日 × 48 コマ）。
 * 商品のある日は約定しなかった商品も 0 として数え、どの商品も無い日は NaN
 */
export function rightsVolumes(products: readonly RightsProduct[], start: number, n: number, line: IntertieKey): ByDirection<Float64Array> {
  const out: ByDirection<Float64Array> = { fwd: null, rev: null };
  for (const p of products) {
    const link = rightsLink(p.from, p.to);
    if (!link || link.line !== line) continue;
    const side = link.dir > 0 ? 'fwd' : 'rev';
    const arr = (out[side] ??= new Float64Array(n * SLOTS).fill(Number.NaN));
    const a = Math.max(p.first, start) - start;
    const b = Math.min(p.last, start + n - 1) - start;
    for (let k = a * SLOTS; k < (b + 1) * SLOTS; k++) arr[k] = (Number.isNaN(arr[k]) ? 0 : arr[k]) + (p.volume ?? 0);
  }
  return out;
}

/**
 * 推定キャンセル量（MW、0 以上。start の日からの並び × 48 コマ）: 約定量の合計が、その向きの「運用容量 − マージン」を超える分。
 * 取引規程第 87 条では、受渡日の前日に広域機関から届く運用容量、マージン、経過措置計画量などで、発行済みの量を超える分を、
 * 保有量に応じて 0.1 MW 単位で減らす（2026 年度からは経過措置計画量が無く、翌日の広域調整枠も 0）。
 * 翌日の値（前日の夕方に策定したもの）のマージンは、スポット市場のあとにコマごとに積み増されていることがある
 * （東京-中部間の逆方向で、600 MW が 1,350 MW まで、など）。キャンセルを決める値はスポット市場の前のものと考え、
 * マージン（広域調整枠も含む）には、その日の最小値（積み増す前の値にあたる）を使う。
 * RIGHTS_ESTIMATE_FROM より前の日と、約定量か運用容量の無いコマは NaN
 * @param capacity その向きの運用容量（逆方向は負の値）
 * @param limit その向きの上限（運用容量 − マージン − 広域調整枠。逆方向は負の値）
 */
export function estimateCancellation(volume: Float64Array, capacity: Float64Array, limit: Float64Array, dir: 1 | -1, start: number): Float64Array {
  const out = new Float64Array(volume.length).fill(Number.NaN);
  for (let i = Math.max(0, RIGHTS_ESTIMATE_FROM - start); i * SLOTS < volume.length; i++) {
    let margin = Number.POSITIVE_INFINITY;
    for (let k = i * SLOTS; k < (i + 1) * SLOTS; k++) {
      const m = dir * (capacity[k] - limit[k]);
      if (m < margin) margin = m;
    }
    if (!Number.isFinite(margin)) continue;
    for (let k = i * SLOTS; k < (i + 1) * SLOTS; k++) {
      const v = volume[k];
      const cap = dir * capacity[k];
      if (Number.isNaN(v) || Number.isNaN(cap)) continue;
      out[k] = Math.round(Math.max(0, v - Math.max(0, cap - Math.max(0, margin))) * 10) / 10;
    }
  }
  return out;
}
