/**
 * 画面の状態と URL ハッシュとの相互変換。
 * 既定値と異なる項目だけを URL に載せるので、表示中の切り口をそのままリンクで共有できる。
 */
import { fiscalYearEnd, fiscalYearOfDay, fiscalYearStart, isoFromDay, parseDateString } from './lib/dates';
import type { Granularity } from './lib/aggregate';
import type { DayType } from './lib/select';
import { CURVE_TARGETS, type CurveTarget } from './lib/areaCurves';
import { CURVE_METRIC_KEYS, type CurveMetricKey } from './lib/bidCurves';
import { AREA_KEYS, PRICE_KEYS, type AreaKey, type PriceKey } from './lib/series';

export const TABS = [
  { id: 'overview', label: '概要' },
  { id: 'trend', label: '推移' },
  { id: 'intraday', label: '時間帯' },
  { id: 'heatmap', label: 'ヒートマップ' },
  { id: 'calendar', label: 'カレンダー' },
  { id: 'distribution', label: '分布' },
  { id: 'area', label: 'エリア比較' },
  { id: 'volume', label: '入札・約定量' },
  { id: 'curves', label: '入札カーブ' },
  { id: 'yearly', label: '年度比較' },
  { id: 'table', label: '統計表' },
] as const;
export type TabId = (typeof TABS)[number]['id'];
const TAB_IDS = TABS.map((t) => t.id) as TabId[];

export const SLOT_PRESETS = [
  { id: 'all', label: '終日 0:00〜24:00', start: 0, end: 48 },
  { id: 'day', label: '日中 8:00〜20:00', start: 16, end: 40 },
  { id: 'daytime', label: '昼間 8:00〜18:00', start: 16, end: 36 },
  { id: 'night', label: '夜間 20:00〜8:00', start: 40, end: 16 },
  { id: 'midday', label: '昼 10:00〜15:00', start: 20, end: 30 },
  { id: 'evening', label: '夕方 17:00〜20:00', start: 34, end: 40 },
  { id: 'custom', label: 'カスタム', start: 0, end: 48 },
] as const;
export type SlotPresetId = (typeof SLOT_PRESETS)[number]['id'];

export type TrendGran = 'auto' | Granularity;
export type TrendStat = 'mean' | 'max' | 'min' | 'median';
export type IntradayMode = 'series' | 'season' | 'daytype' | 'fy';
export type HeatKind = 'dateSlot' | 'monthSlot' | 'dowSlot' | 'fyMonth';
export type CalMetric = 'mean' | 'max' | 'min' | 'range' | 'floor' | 'spread';
export type DistGroup = 'month' | 'fy' | 'dow' | 'hour' | 'area';
export type YearMetric = 'mean' | 'max' | 'min' | 'floor';
export type TableUnit = 'day' | 'week' | 'month' | 'fy' | 'year' | 'dow' | 'slot' | 'all';
export type TableKind = 'areas' | 'stats';
/** 色・軸の範囲: 対象ごとに決めるか、全エリアで共通にする（対象を切り替えても変えない）か */
export type ScaleMode = 'auto' | 'common';
/** 入札カーブの縦軸（価格）の上限 */
export type CurveRange = 'auto' | '30' | '50' | '100' | 'all';
/** 入札カーブの比較: 直近の日・6 時間おき・自由に選んだ日と時間帯 */
export type CurveCompare = 'days' | 'slots' | 'picks';
export type CurveSide = 'sell' | 'buy';
/** 比較の図で自由に選んだ受渡日・時間帯（コマ 0〜47） */
export interface CurvePick {
  day: number;
  slot: number;
}
/** 自由に選べる数（重ねた線を濃淡で見分けられる本数） */
export const MAX_CURVE_PICKS = 5;

/** 古い順に並べ、同じものを除き、MAX_CURVE_PICKS 件までにする */
export function normalizePicks(picks: readonly CurvePick[]): CurvePick[] {
  const out: CurvePick[] = [];
  for (const p of [...picks].sort((a, b) => a.day - b.day || a.slot - b.slot)) {
    if (!out.some((q) => q.day === p.day && q.slot === p.slot)) out.push(p);
  }
  return out.slice(0, MAX_CURVE_PICKS);
}

export interface AppState {
  tab: TabId;
  /** 期間プリセット（last7 / last30 / last90 / last365 / fyYYYY / all / custom） */
  preset: string;
  from: number;
  to: number;
  dayType: DayType;
  slotPreset: SlotPresetId;
  slotStart: number;
  slotEnd: number;
  /** 表示系列（複数系列のグラフ） */
  series: PriceKey[];
  /** 注目系列（単一系列のグラフ） */
  focus: PriceKey;
  trendGran: TrendGran;
  trendStat: TrendStat;
  trendSplit: boolean;
  /** 系列ごとに分割したときに各図へ重ねる線 */
  splitRefs: PriceKey[];
  intradayMode: IntradayMode;
  intradayStat: 'mean' | 'median';
  heatKind: HeatKind;
  heatSpread: boolean;
  calMetric: CalMetric;
  distBin: string;
  distGroup: DistGroup;
  /** ヒートマップ・カレンダーの色と、時間帯・分布・年度比較のグラフの軸の範囲 */
  scale: ScaleMode;
  pairA: AreaKey;
  pairB: AreaKey;
  /** エリア比較タブの比較の基準（平均差・分断率・月別の差） */
  areaBase: PriceKey;
  /** 入札カーブを見る受渡日（NaN は最新の日） */
  curveDate: number;
  /** 入札カーブを見るコマ（0〜47） */
  curveSlot: number;
  /** 入札カーブの対象（システムプライスかエリア。受渡日・時間帯を変えても保つ） */
  curveArea: CurveTarget;
  curveRange: CurveRange;
  curveCompare: CurveCompare;
  /** 比較の図で自由に選んだ受渡日・時間帯（古い順） */
  curvePicks: CurvePick[];
  /** 比較の図で重ねる側 */
  curveSide: CurveSide;
  /** 価格帯ごとの入札量の推移で見る側 */
  curveDepth: CurveSide;
  /** 入札カーブのヒートマップの指標 */
  curveMetric: CurveMetricKey;
  yearMetric: YearMetric;
  tableUnit: TableUnit;
  tableKind: TableKind;
  threshold: number;
}

export const DEFAULT_STATE: AppState = {
  tab: 'overview',
  preset: 'last365',
  from: Number.NaN,
  to: Number.NaN,
  dayType: 'all',
  slotPreset: 'all',
  slotStart: 0,
  slotEnd: 48,
  series: ['system', 'tokyo', 'kansai', 'kyushu'],
  focus: 'system',
  trendGran: 'auto',
  trendStat: 'mean',
  trendSplit: false,
  splitRefs: ['system'],
  intradayMode: 'series',
  intradayStat: 'mean',
  heatKind: 'dateSlot',
  heatSpread: false,
  calMetric: 'mean',
  distBin: 'auto',
  distGroup: 'month',
  scale: 'auto',
  pairA: 'tokyo',
  pairB: 'kansai',
  areaBase: 'system',
  curveDate: Number.NaN,
  curveSlot: 36,
  curveArea: 'system',
  curveRange: 'auto',
  curveCompare: 'days',
  curvePicks: [],
  curveSide: 'sell',
  curveDepth: 'sell',
  curveMetric: 'sell001',
  yearMetric: 'mean',
  tableUnit: 'month',
  tableKind: 'areas',
  threshold: 30,
};

interface Codec<T> {
  enc(v: T): string;
  dec(s: string): T | undefined;
}
const oneOf = <T extends string>(allowed: readonly T[]): Codec<T> => ({
  enc: (v) => v,
  dec: (s) => ((allowed as readonly string[]).includes(s) ? (s as T) : undefined),
});
const listOf = <T extends string>(allowed: readonly T[]): Codec<T[]> => ({
  enc: (v) => v.join(','),
  dec: (s) => {
    const items = [...new Set(s.split(','))].filter((x): x is T => (allowed as readonly string[]).includes(x));
    return items.length > 0 ? items : undefined;
  },
});
/** 空の選択も表せるリスト（空は "none"） */
const listOrNone = <T extends string>(allowed: readonly T[]): Codec<T[]> => {
  const list = listOf(allowed);
  return {
    enc: (v) => (v.length === 0 ? 'none' : list.enc(v)),
    dec: (s) => (s === 'none' ? [] : list.dec(s)),
  };
};
const intIn = (min: number, max: number): Codec<number> => ({
  enc: (v) => String(v),
  dec: (s) => {
    const v = Number(s);
    return Number.isInteger(v) && v >= min && v <= max ? v : undefined;
  },
});
const numIn = (min: number, max: number): Codec<number> => ({
  enc: (v) => String(v),
  dec: (s) => {
    const v = Number(s);
    return Number.isFinite(v) && v >= min && v <= max ? v : undefined;
  },
});
const bool: Codec<boolean> = { enc: (v) => (v ? '1' : '0'), dec: (s) => (s === '1' ? true : s === '0' ? false : undefined) };
const day: Codec<number> = {
  enc: (v) => (Number.isFinite(v) ? isoFromDay(v) : ''),
  dec: (s) => parseDateString(s) ?? undefined,
};
/** 20260925.36,20260926.12 */
const picksCodec: Codec<CurvePick[]> = {
  enc: (v) => v.map((p) => `${isoFromDay(p.day).replace(/-/g, '')}.${p.slot}`).join(','),
  dec: (s) => {
    const picks: CurvePick[] = [];
    for (const item of s.split(',')) {
      const m = /^(\d{8})\.(\d{1,2})$/.exec(item);
      const day = m ? parseDateString(m[1]) : null;
      const slot = m ? Number(m[2]) : Number.NaN;
      if (day !== null && slot >= 0 && slot <= 47) picks.push({ day, slot });
    }
    return picks.length > 0 ? normalizePicks(picks) : undefined;
  },
};
const presetCodec: Codec<string> = {
  enc: (v) => v,
  dec: (s) => (/^(last(7|30|90|365)|fy\d{4}|all|custom)$/.test(s) ? s : undefined),
};

const SCHEMA: { [K in keyof AppState]: [string, Codec<AppState[K]>] } = {
  tab: ['tab', oneOf(TAB_IDS)],
  preset: ['p', presetCodec],
  from: ['from', day],
  to: ['to', day],
  dayType: ['dt', oneOf<DayType>(['all', 'weekday', 'offday'])],
  slotPreset: ['tz', oneOf(SLOT_PRESETS.map((p) => p.id))],
  slotStart: ['ts', intIn(0, 47)],
  slotEnd: ['te', intIn(1, 48)],
  series: ['s', listOf(PRICE_KEYS)],
  focus: ['f', oneOf(PRICE_KEYS)],
  trendGran: ['g', oneOf<TrendGran>(['auto', 'slot', 'day', 'week', 'month', 'fy', 'year'])],
  trendStat: ['stat', oneOf<TrendStat>(['mean', 'max', 'min', 'median'])],
  trendSplit: ['split', bool],
  splitRefs: ['sr', listOrNone(PRICE_KEYS)],
  intradayMode: ['im', oneOf<IntradayMode>(['series', 'season', 'daytype', 'fy'])],
  intradayStat: ['is', oneOf<'mean' | 'median'>(['mean', 'median'])],
  heatKind: ['hk', oneOf<HeatKind>(['dateSlot', 'monthSlot', 'dowSlot', 'fyMonth'])],
  heatSpread: ['hs', bool],
  calMetric: ['cm', oneOf<CalMetric>(['mean', 'max', 'min', 'range', 'floor', 'spread'])],
  distBin: ['bin', oneOf(['auto', '0.5', '1', '2', '5', '10'])],
  distGroup: ['dg', oneOf<DistGroup>(['month', 'fy', 'dow', 'hour', 'area'])],
  scale: ['sc', oneOf<ScaleMode>(['auto', 'common'])],
  pairA: ['a', oneOf(AREA_KEYS)],
  pairB: ['b', oneOf(AREA_KEYS)],
  areaBase: ['base', oneOf(PRICE_KEYS)],
  curveDate: ['cd', day],
  curveSlot: ['cs', intIn(0, 47)],
  curveArea: ['ca', oneOf(CURVE_TARGETS)],
  curveRange: ['cr', oneOf<CurveRange>(['auto', '30', '50', '100', 'all'])],
  curveCompare: ['cc', oneOf<CurveCompare>(['days', 'slots', 'picks'])],
  curvePicks: ['cp', picksCodec],
  curveSide: ['csd', oneOf<CurveSide>(['sell', 'buy'])],
  curveDepth: ['cdp', oneOf<CurveSide>(['sell', 'buy'])],
  curveMetric: ['cm2', oneOf<CurveMetricKey>(CURVE_METRIC_KEYS)],
  yearMetric: ['ym', oneOf<YearMetric>(['mean', 'max', 'min', 'floor'])],
  tableUnit: ['tu', oneOf<TableUnit>(['day', 'week', 'month', 'fy', 'year', 'dow', 'slot', 'all'])],
  tableKind: ['tk', oneOf<TableKind>(['areas', 'stats'])],
  threshold: ['th', numIn(0, 1000)],
};

export function stateToHash(state: AppState): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(SCHEMA) as (keyof AppState)[]) {
    if ((key === 'from' || key === 'to') && state.preset !== 'custom') continue;
    if ((key === 'slotStart' || key === 'slotEnd') && state.slotPreset !== 'custom') continue;
    const [param, codec] = SCHEMA[key] as [string, Codec<unknown>];
    const enc = codec.enc(state[key]);
    const def = codec.enc(DEFAULT_STATE[key]);
    if (enc !== def && enc !== '') params.set(param, enc);
  }
  const s = params.toString();
  return s ? `#${s}` : '';
}

export function stateFromHash(hash: string): AppState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const state: AppState = { ...DEFAULT_STATE, series: [...DEFAULT_STATE.series] };
  for (const key of Object.keys(SCHEMA) as (keyof AppState)[]) {
    const [param, codec] = SCHEMA[key] as [string, Codec<unknown>];
    const raw = params.get(param);
    if (raw === null) continue;
    const v = codec.dec(raw);
    if (v !== undefined) (state as unknown as Record<string, unknown>)[key] = v;
  }
  const slotPreset = SLOT_PRESETS.find((p) => p.id === state.slotPreset);
  if (slotPreset && slotPreset.id !== 'custom') {
    state.slotStart = slotPreset.start;
    state.slotEnd = slotPreset.end;
  }
  if (state.preset === 'custom' && !(state.from <= state.to)) state.preset = DEFAULT_STATE.preset;
  return state;
}

export interface Extent {
  first: number;
  last: number;
}

/** 期間プリセットを具体的な日付範囲にする（「直近」はデータの最終日が基準） */
export function resolveRange(preset: string, extent: Extent, current: { from: number; to: number }): { from: number; to: number } {
  const { first, last } = extent;
  const clip = (from: number, to: number) => ({ from: Math.max(first, from), to: Math.min(last, to) });
  const m = /^last(\d+)$/.exec(preset);
  if (m) return clip(last - Number(m[1]) + 1, last);
  const fy = /^fy(\d{4})$/.exec(preset);
  if (fy) return clip(fiscalYearStart(Number(fy[1])), fiscalYearEnd(Number(fy[1])));
  if (preset === 'all') return { from: first, to: last };
  if (Number.isFinite(current.from) && Number.isFinite(current.to)) return { from: current.from, to: current.to };
  return clip(last - 364, last);
}

export function fiscalYearsIn(extent: Extent): number[] {
  const out: number[] = [];
  for (let fy = fiscalYearOfDay(extent.last); fy >= fiscalYearOfDay(extent.first); fy--) out.push(fy);
  return out;
}
