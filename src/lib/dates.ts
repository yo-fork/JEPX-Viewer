/**
 * 日付ユーティリティ。
 *
 * 受渡日は「1970-01-01 からの経過日数（整数）」で扱う。JST の暦日をそのまま UTC の暦日として
 * 数えるため、ブラウザのタイムゾーンに依存しない。
 */

export const MS_PER_DAY = 86_400_000;
export const MS_PER_SLOT = 1_800_000;

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

export function dayFromYmd(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function ymdFromDay(day: number): Ymd {
  const dt = new Date(day * MS_PER_DAY);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** 曜日（0=日曜 … 6=土曜）。1970-01-01 は木曜日。 */
export function dowOfDay(day: number): number {
  return (((day + 4) % 7) + 7) % 7;
}

/** 年度（4 月始まり） */
export function fiscalYearOf(y: number, m: number): number {
  return m >= 4 ? y : y - 1;
}

export function fiscalYearOfDay(day: number): number {
  const { y, m } = ymdFromDay(day);
  return fiscalYearOf(y, m);
}

export function fiscalYearStart(fy: number): number {
  return dayFromYmd(fy, 4, 1);
}

export function fiscalYearEnd(fy: number): number {
  return dayFromYmd(fy + 1, 3, 31);
}

/** 月曜始まりの週の初日 */
export function weekStartOf(day: number): number {
  return day - ((dowOfDay(day) + 6) % 7);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** YYYY-MM-DD（input[type=date] や URL 用） */
export function isoFromDay(day: number): string {
  const { y, m, d } = ymdFromDay(day);
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

export const DOW_LABEL = ['日', '月', '火', '水', '木', '金', '土'] as const;

/** YYYY/MM/DD 表示 */
export function formatDay(day: number, withDow = false): string {
  const { y, m, d } = ymdFromDay(day);
  const s = `${y}/${pad2(m)}/${pad2(d)}`;
  return withDow ? `${s}(${DOW_LABEL[dowOfDay(day)]})` : s;
}

/**
 * 日付文字列を経過日数に変換する。
 * 対応形式: 2024/04/01, 2024-4-1, 20240401, 2024年4月1日（前後の空白・時刻部分は無視）
 */
export function parseDateString(input: string): number | null {
  const s = input.trim();
  let m = /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/.exec(s);
  if (!m) m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const day = dayFromYmd(y, mo, d);
  // 2024/02/31 のような存在しない日付を弾く
  const back = ymdFromDay(day);
  if (back.m !== mo || back.d !== d) return null;
  return day;
}

/** 現在の JST 暦日 */
export function todayJst(now = Date.now()): number {
  return Math.floor((now + 9 * 3_600_000) / MS_PER_DAY);
}

/** コマ（0〜47）の開始時刻 HH:MM */
export function slotStartLabel(slot: number): string {
  const min = slot * 30;
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

/** コマ（0〜47）の時間帯 HH:MM–HH:MM */
export function slotRangeLabel(slot: number): string {
  return `${slotStartLabel(slot)}–${slotStartLabel(slot + 1)}`;
}

/**
 * ECharts の時間軸用タイムスタンプ（JST の壁時計時刻を UTC として表したミリ秒）。
 * グラフ側は useUTC: true で描画するので、閲覧環境のタイムゾーンに関係なく JST で表示される。
 */
export function wallClockMs(day: number, slot = 0): number {
  return day * MS_PER_DAY + slot * MS_PER_SLOT;
}
