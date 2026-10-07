/**
 * 電力広域的運営推進機関（広域機関）が「系統情報サービス」で公表している、地域間連系線ごとの計画潮流・空容量・潮流実績。
 * 取得スクリプト（scripts/occto.ts）とブラウザの両方で使う。
 *
 * - 連系線空容量（翌日）の CSV: 30 分ごと・向きごとの空容量、計画潮流、広域調整枠、マージン、運用容量（前日に策定した値）
 * - 連系線潮流実績の CSV: 5 分ごとの潮流実績と、そのときの計画潮流（時間前市場などで変わった後の値）、運用容量など
 * 計画潮流と潮流実績は、連系線の「順方向」（名前の前の側から後ろの側）を正、逆方向を負とする。
 * 利用条件により、画面には出典と、加工して作成したことを示す。
 *
 * interties/fyYYYY.json … 1 年度分。連系線ごとに、値の種類ごとの「日数 × 48 コマ」の配列（欠損は null）
 */
import { parseCsv } from './csv';
import { fiscalYearOfDay, isoFromDay, parseDateString } from './dates';
import { AREA_KEYS, SLOTS, type AreaKey } from './series';

export const INTERTIE_FY_FORMAT = 'jepx-viewer/intertie-fy@1';
/** 出典の表示（利用条件で求められている。加工したことも示す） */
export const OCCTO_SOURCE = '出典: 電力広域的運営推進機関「系統情報サービス」（連系線空容量（翌日）、連系線潮流実績）のデータを 30 分ごとにまとめて作成';

export interface IntertieDef {
  key: IntertieKey;
  /** 画面に出す名前（広域機関の「対象連系線区間」の名前） */
  label: string;
  /** 広域機関の CSV の連系線（設備）の名前 */
  name: string;
  /** name が設備の名前か（画面では区間の名前のあとに並べる。フェンスと関西-中国間の内訳は、区間の名前と同じなので並べない） */
  facility?: boolean;
  /** 順方向に送る側と受ける側のエリア */
  from: readonly AreaKey[];
  to: readonly AreaKey[];
}

/**
 * 地域間連系線。中地域（中部・北陸・関西）は 2026 年 3 月 14 日受渡分から、個別の連系線（中部-関西間、中部-北陸間、北陸-関西間）ではなく
 * フェンスで運用容量などを管理する。中部フェンスと関西フェンスは 3 月 13 日受渡分から（この日だけ個別の連系線と両方ある）、
 * 北陸フェンスはそれより前からある。関西-中国（東・西）は関西-中国間の内訳
 */
export const INTERTIE_DEFS = [
  { key: 'hokkaidoHonshu', label: '北海道-本州間', name: '北海道・本州間電力連系設備', facility: true, from: ['hokkaido'], to: ['tohoku'] },
  { key: 'tohokuTokyo', label: '東北-東京間', name: '相馬双葉幹線', facility: true, from: ['tohoku'], to: ['tokyo'] },
  { key: 'tokyoChubu', label: '東京-中部間', name: '周波数変換設備', facility: true, from: ['tokyo'], to: ['chubu'] },
  { key: 'chubuFence', label: '中部-北陸・関西間（中部フェンス）', name: '中部フェンス', from: ['chubu'], to: ['hokuriku', 'kansai'] },
  { key: 'hokurikuFence', label: '中部・関西-北陸間（北陸フェンス）', name: '北陸フェンス', from: ['chubu', 'kansai'], to: ['hokuriku'] },
  { key: 'kansaiFence', label: '中部・北陸-関西間（関西フェンス）', name: '関西フェンス', from: ['chubu', 'hokuriku'], to: ['kansai'] },
  { key: 'chubuKansai', label: '中部-関西間', name: '三重東近江線', facility: true, from: ['chubu'], to: ['kansai'] },
  { key: 'chubuHokuriku', label: '中部-北陸間', name: '南福光連系所・南福光変電所の連系設備', facility: true, from: ['chubu'], to: ['hokuriku'] },
  { key: 'hokurikuKansai', label: '北陸-関西間', name: '越前嶺南線', facility: true, from: ['hokuriku'], to: ['kansai'] },
  { key: 'kansaiChugoku', label: '関西-中国間', name: '西播東岡山線・山崎智頭線', facility: true, from: ['kansai'], to: ['chugoku'] },
  { key: 'kansaiChugokuEast', label: '関西-中国間（東）', name: '関西-中国（東）', from: ['kansai'], to: ['chugoku'] },
  { key: 'kansaiChugokuWest', label: '関西-中国間（西）', name: '関西-中国（西）', from: ['kansai'], to: ['chugoku'] },
  { key: 'kansaiShikoku', label: '関西-四国間', name: '阿南紀北直流幹線', facility: true, from: ['kansai'], to: ['shikoku'] },
  { key: 'chugokuShikoku', label: '中国-四国間', name: '本四連系線', facility: true, from: ['chugoku'], to: ['shikoku'] },
  { key: 'chugokuKyushu', label: '中国-九州間', name: '関門連系線', facility: true, from: ['chugoku'], to: ['kyushu'] },
] as const satisfies readonly {
  key: string;
  label: string;
  name: string;
  facility?: boolean;
  from: readonly AreaKey[];
  to: readonly AreaKey[];
}[];

export type IntertieKey = (typeof INTERTIE_DEFS)[number]['key'];
export const INTERTIE_KEYS: IntertieKey[] = INTERTIE_DEFS.map((d) => d.key);
export const INTERTIE_INDEX = Object.fromEntries(INTERTIE_KEYS.map((k, i) => [k, i])) as Record<IntertieKey, number>;

/** 画面に出す連系線の名前（区間の名前のあとに設備の名前。例: 関西-四国間（阿南紀北直流幹線）） */
export function intertieTitle(key: IntertieKey): string {
  const d: IntertieDef = INTERTIE_DEFS[INTERTIE_INDEX[key]];
  return d.facility ? `${d.label}（${d.name}）` : d.label;
}
const BY_NAME = new Map<string, number>(INTERTIE_DEFS.map((d, i) => [d.name, i]));

/** 連系線ごとに持つ値（MW。逆方向の上限・運用容量は負） */
export const INTERTIE_FIELDS = [
  /** 計画潮流（翌日に策定した値） */
  'plan',
  /** 計画潮流の上限: 運用容量 − マージン − 広域調整枠（順方向は正、逆方向は負） */
  'limFwd',
  'limRev',
  /** 運用容量 */
  'capFwd',
  'capRev',
  /** 潮流実績（5 分ごとの値の 30 分の平均） */
  'actual',
  /** 潮流実績のときの計画潮流（時間前市場などで変わった後の値。30 分の平均） */
  'planFinal',
] as const;
export type IntertieField = (typeof INTERTIE_FIELDS)[number];
export const INTERTIE_FIELD_INDEX = Object.fromEntries(INTERTIE_FIELDS.map((f, i) => [f, i])) as Record<IntertieField, number>;
/** 翌日の CSV から入れる値と、潮流実績の CSV から入れる値 */
export const PLAN_FIELDS: readonly IntertieField[] = ['plan', 'limFwd', 'limRev', 'capFwd', 'capRev'];
export const FLOW_FIELDS: readonly IntertieField[] = ['actual', 'planFinal'];

const LINE_COUNT = INTERTIE_DEFS.length;
const FIELD_COUNT = INTERTIE_FIELDS.length;

/** 1 日分の値（連系線 × 値の種類 × 48 コマ。欠損は NaN） */
export type IntertieDayValues = Float64Array;
/** 日 → 1 日分の値 */
export type IntertieDays = Map<number, IntertieDayValues>;

export function newIntertieDay(): IntertieDayValues {
  return new Float64Array(LINE_COUNT * FIELD_COUNT * SLOTS).fill(Number.NaN);
}

/** 1 日分の値の位置 */
export function intertieOffset(line: number, field: number, slot = 0): number {
  return (line * FIELD_COUNT + field) * SLOTS + slot;
}

export type OcctoCsvKind = 'plan' | 'flow';

/** 列名から CSV の種類を見分ける（連系線空容量（翌日・当日など）か、連系線潮流実績か。どちらでもなければ null） */
export function occtoCsvKind(text: string): OcctoCsvKind | null {
  const head = text.slice(0, 2000).split(/\r?\n/, 1)[0] ?? '';
  if (/^﻿?連系線,対象日付,対象時刻,/.test(head) && head.includes('潮流実績')) return 'flow';
  if (/^﻿?対象断面,/.test(head) && head.includes('計画潮流') && head.includes('運用容量')) return 'plan';
  return null;
}

/** 「HH:MM」（区間の終わりの時刻。24:00 まで）の分 */
function minutesOf(t: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
}

const num = (s: string | undefined) => {
  const v = Number((s ?? '').trim());
  return (s ?? '').trim() === '' || !Number.isFinite(v) ? Number.NaN : v;
};
const round1 = (v: number) => Math.round(v * 10) / 10;

export interface OcctoParseResult {
  kind: OcctoCsvKind;
  days: IntertieDays;
  /** 読んだ行の数と、知らない連系線の名前 */
  rows: number;
  unknown: string[];
  firstDay: number;
  lastDay: number;
}

/** 連系線空容量（翌日）か連系線潮流実績の CSV を読む */
export function parseOcctoCsv(text: string): OcctoParseResult {
  const kind = occtoCsvKind(text);
  if (!kind) throw new Error('広域機関の連系線の CSV（連系線空容量・連系線潮流実績）ではありません');
  const table = parseCsv(text).filter((r) => r.length > 1);
  const header = table[0].map((h) => h.replace(/^﻿/, '').trim());
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`広域機関の CSV に「${name}」の列がありません`);
    return i;
  };
  const days: IntertieDays = new Map();
  const unknown = new Set<string>();
  let rows = 0;
  const dayValues = (day: number) => {
    let v = days.get(day);
    if (!v) days.set(day, (v = newIntertieDay()));
    return v;
  };
  const F = INTERTIE_FIELD_INDEX;
  if (kind === 'plan') {
    const [cLine, cDate, cTime, cDir, cPlan, cAdj, cMargin, cCap] = ['連系線', '年月日', '時刻', '方向', '計画潮流', '広域調整枠', 'マージン', '運用容量'].map(col);
    for (const r of table.slice(1)) {
      const line = BY_NAME.get(r[cLine]?.trim() ?? '');
      if (line === undefined) {
        if (r[cLine]) unknown.add(r[cLine].trim());
        continue;
      }
      const day = parseDateString((r[cDate] ?? '').trim().replace(/\//g, '-'));
      const slot = minutesOf(r[cTime] ?? '') / 30 - 1;
      if (day === null || !Number.isInteger(slot) || slot < 0 || slot >= SLOTS) continue;
      const v = dayValues(day);
      const fwd = (r[cDir] ?? '').trim() === '順方向';
      const cap = num(r[cCap]);
      const lim = cap - num(r[cMargin]) - (num(r[cAdj]) || 0);
      v[intertieOffset(line, F.plan, slot)] = round1(num(r[cPlan]));
      v[intertieOffset(line, fwd ? F.capFwd : F.capRev, slot)] = round1(cap);
      v[intertieOffset(line, fwd ? F.limFwd : F.limRev, slot)] = round1(lim);
      rows++;
    }
  } else {
    const [cLine, cDate, cTime, cPlan, cFlow] = ['連系線', '対象日付', '対象時刻', '計画潮流(順方向)', '潮流実績'].map(col);
    // 5 分ごとの値を 30 分ごとに平均する
    const sums = new Map<string, { day: number; line: number; slot: number; flow: number; nf: number; plan: number; np: number }>();
    for (const r of table.slice(1)) {
      const line = BY_NAME.get(r[cLine]?.trim() ?? '');
      if (line === undefined) {
        if (r[cLine]) unknown.add(r[cLine].trim());
        continue;
      }
      const day = parseDateString((r[cDate] ?? '').trim().replace(/\//g, '-'));
      const min = minutesOf(r[cTime] ?? '');
      if (day === null || !(min > 0 && min <= 1440)) continue;
      const slot = Math.floor((min - 1) / 30);
      const key = `${day}|${line}|${slot}`;
      let acc = sums.get(key);
      if (!acc) sums.set(key, (acc = { day, line, slot, flow: 0, nf: 0, plan: 0, np: 0 }));
      const flow = num(r[cFlow]);
      const plan = num(r[cPlan]);
      if (Number.isFinite(flow)) {
        acc.flow += flow;
        acc.nf++;
      }
      if (Number.isFinite(plan)) {
        acc.plan += plan;
        acc.np++;
      }
      rows++;
    }
    for (const a of sums.values()) {
      const v = dayValues(a.day);
      if (a.nf > 0) v[intertieOffset(a.line, F.actual, a.slot)] = round1(a.flow / a.nf);
      if (a.np > 0) v[intertieOffset(a.line, F.planFinal, a.slot)] = round1(a.plan / a.np);
    }
  }
  const keys = [...days.keys()].sort((a, b) => a - b);
  if (keys.length === 0) throw new Error('広域機関の CSV に、連系線の値がありません');
  return { kind, days, rows, unknown: [...unknown], firstDay: keys[0], lastDay: keys[keys.length - 1] };
}

/**
 * 1 日分の値に、別に読んだ値を重ねる（値のある所だけ上書きする）。fields を指定すると、その種類だけを重ねる。
 * 値を重ねた日の数を返す
 */
export function mergeIntertieDays(into: IntertieDays, from: IntertieDays, fields: readonly IntertieField[] = INTERTIE_FIELDS): number {
  const fi = fields.map((f) => INTERTIE_FIELD_INDEX[f]);
  let n = 0;
  for (const [day, vals] of from) {
    let cur = into.get(day);
    if (!cur) into.set(day, (cur = newIntertieDay()));
    let any = false;
    for (let line = 0; line < LINE_COUNT; line++) {
      for (const f of fi) {
        for (let s = 0; s < SLOTS; s++) {
          const v = vals[intertieOffset(line, f, s)];
          if (Number.isNaN(v)) continue;
          cur[intertieOffset(line, f, s)] = v;
          any = true;
        }
      }
    }
    if (any) n++;
  }
  return n;
}

/** その日に、指定の種類の値が 1 つでもある */
export function hasIntertieFields(vals: IntertieDayValues | undefined, fields: readonly IntertieField[]): boolean {
  if (!vals) return false;
  for (let line = 0; line < LINE_COUNT; line++) {
    for (const f of fields) {
      const off = intertieOffset(line, INTERTIE_FIELD_INDEX[f]);
      for (let s = 0; s < SLOTS; s++) if (!Number.isNaN(vals[off + s])) return true;
    }
  }
  return false;
}

// ---- 年度ファイル（public/data/interties/fyYYYY.json） ----

export interface IntertieFyFile {
  format: typeof INTERTIE_FY_FORMAT;
  fy: number;
  firstDate: string;
  days: number;
  /** 連系線 → 値の種類 → 「日数 × 48 コマ」（値の無い連系線・種類は入れない） */
  lines: Partial<Record<IntertieKey, Partial<Record<IntertieField, (number | null)[]>>>>;
}

export function intertieFyFile(fy: number): string {
  return `interties/fy${fy}.json`;
}

export function encodeIntertieFy(fy: number, days: IntertieDays): IntertieFyFile {
  const keys = [...days.keys()].sort((a, b) => a - b);
  const first = keys[0];
  const n = keys[keys.length - 1] - first + 1;
  const lines: IntertieFyFile['lines'] = {};
  INTERTIE_KEYS.forEach((key, line) => {
    INTERTIE_FIELDS.forEach((field, f) => {
      const arr = new Array<number | null>(n * SLOTS).fill(null);
      let any = false;
      for (const [day, vals] of days) {
        const off = (day - first) * SLOTS;
        for (let s = 0; s < SLOTS; s++) {
          const v = vals[intertieOffset(line, f, s)];
          if (Number.isNaN(v)) continue;
          arr[off + s] = v;
          any = true;
        }
      }
      if (any) (lines[key] ??= {})[field] = arr;
    });
  });
  return { format: INTERTIE_FY_FORMAT, fy, firstDate: isoFromDay(first), days: n, lines };
}

export function decodeIntertieFy(json: unknown): IntertieDays {
  const file = json as IntertieFyFile;
  if (!file || file.format !== INTERTIE_FY_FORMAT) throw new Error('連系線のデータファイルの形式が不正です');
  const first = parseDateString(file.firstDate);
  if (first === null) throw new Error('連系線のデータファイルの firstDate が不正です');
  const days: IntertieDays = new Map();
  INTERTIE_KEYS.forEach((key, line) => {
    const fields = file.lines?.[key];
    if (!fields) return;
    INTERTIE_FIELDS.forEach((field, f) => {
      const arr = fields[field];
      if (!arr) return;
      for (let d = 0; d < file.days; d++) {
        for (let s = 0; s < SLOTS; s++) {
          const v = arr[d * SLOTS + s];
          if (v === null || v === undefined) continue;
          let vals = days.get(first + d);
          if (!vals) days.set(first + d, (vals = newIntertieDay()));
          vals[intertieOffset(line, f, s)] = v;
        }
      }
    });
  });
  return days;
}

/** 日別の値を年度ごとに分ける */
export function splitIntertieByFy(days: IntertieDays): Map<number, IntertieDays> {
  const out = new Map<number, IntertieDays>();
  for (const [day, vals] of days) {
    const fy = fiscalYearOfDay(day);
    let m = out.get(fy);
    if (!m) out.set(fy, (m = new Map()));
    m.set(day, vals);
  }
  return out;
}

/** 計画潮流が上限に達したとみなす、上限との差（MW） */
export const LIMIT_TOLERANCE = 0.5;

/** 計画潮流が順方向（1）・逆方向（−1）の上限に達しているか（達していなければ 0。値が無ければ NaN） */
export function atLimit(plan: number, limFwd: number, limRev: number): number {
  if (!Number.isFinite(plan)) return Number.NaN;
  if (Number.isFinite(limFwd) && plan >= limFwd - LIMIT_TOLERANCE && limFwd > 0) return 1;
  if (Number.isFinite(limRev) && plan <= limRev + LIMIT_TOLERANCE && limRev < 0) return -1;
  return 0;
}

/** 中地域の個別の連系線（2026 年 3 月 13 日受渡分までの計画潮流）と、それを置き換えたフェンス */
const CENTRAL_LINES: readonly IntertieKey[] = ['chubuKansai', 'chubuHokuriku', 'hokurikuKansai'];
const CENTRAL_FENCES: readonly IntertieKey[] = ['chubuFence', 'hokurikuFence', 'kansaiFence'];
/** 関西-中国間の内訳（合計の連系線と重ねて数えない） */
const SUB_LINES: readonly IntertieKey[] = ['kansaiChugokuEast', 'kansaiChugokuWest'];

/** 市場分断のまとまりの境をまたぐ連系線と、その計画潮流（順方向に流れたときに送る側・受ける側のまとまりの番号） */
export interface CrossingFlow {
  key: IntertieKey;
  plan: number;
  fromGroup: number;
  toGroup: number;
}

/**
 * 市場分断のまとまり（エリアの並び）の境をまたぐ連系線の計画潮流。両側のエリアがそれぞれ 1 つのまとまりに入る連系線だけ。
 * 中地域は、個別の連系線の値があればそれを、無ければフェンスを使う（重ねて数えない）。値の無い連系線は除く
 */
export function crossingFlows(groups: readonly (readonly AreaKey[])[], plan: (key: IntertieKey) => number): CrossingFlow[] {
  const groupOf = new Map<AreaKey, number>();
  groups.forEach((g, i) => g.forEach((a) => groupOf.set(a, i)));
  const individual = CENTRAL_LINES.some((k) => Number.isFinite(plan(k)));
  const out: CrossingFlow[] = [];
  for (const d of INTERTIE_DEFS) {
    if (SUB_LINES.includes(d.key) || (individual ? CENTRAL_FENCES : CENTRAL_LINES).includes(d.key)) continue;
    const v = plan(d.key);
    if (!Number.isFinite(v)) continue;
    const from = new Set(d.from.map((a) => groupOf.get(a)));
    const to = new Set(d.to.map((a) => groupOf.get(a)));
    if (from.size !== 1 || to.size !== 1) continue;
    const [a] = [...from];
    const [b] = [...to];
    if (a === undefined || b === undefined || a === b) continue;
    out.push({ key: d.key, plan: v, fromGroup: a, toGroup: b });
  }
  return out;
}

/**
 * エリアごとの正味の受け入れ量（MW。正は受け入れ、負は送り出し）。エリアにつながる連系線の計画潮流を足し引きして求める。
 * 翌日の計画潮流はスポット市場の約定の結果なので、スポット市場で約定した買い − 売り（ブロック入札も含む）にあたる。
 * 中地域は、個別の連系線の値があればそれを、無ければフェンスを使う。中部フェンスは中部から北陸・関西へ、北陸フェンスは北陸へ、
 * 関西フェンスは関西へ流れる量なので、そのまま各エリアの送り出しと受け入れになる（中部フェンス = 北陸フェンス + 関西フェンス）。
 * 値の無い連系線につながるエリアは NaN
 */
export function areaNetImports(plan: (key: IntertieKey) => number): Record<AreaKey, number> {
  const net = Object.fromEntries(AREA_KEYS.map((a) => [a, 0])) as Record<AreaKey, number>;
  const individual = CENTRAL_LINES.some((k) => Number.isFinite(plan(k)));
  for (const d of INTERTIE_DEFS) {
    if (SUB_LINES.includes(d.key) || CENTRAL_FENCES.includes(d.key) || (!individual && CENTRAL_LINES.includes(d.key))) continue;
    const v = plan(d.key);
    net[d.from[0]] -= v;
    net[d.to[0]] += v;
  }
  if (!individual) {
    net.chubu -= plan('chubuFence');
    net.hokuriku += plan('hokurikuFence');
    net.kansai += plan('kansaiFence');
  }
  return net;
}
