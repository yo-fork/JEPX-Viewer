/**
 * 日本の祝日・休日判定（「国民の祝日に関する法律」に基づく計算、2000 年以降に対応）。
 *
 * - ハッピーマンデー、振替休日、国民の休日（祝日に挟まれた平日）を含む
 * - 2019 年の即位関連、2020・2021 年の東京五輪に伴う移動を反映
 * - 春分日・秋分日は 1980〜2099 年の近似式による
 *
 * データ表を持たずに計算するので、将来年度でもそのまま使える（テストで @holiday-jp の表と照合済み）。
 */
import { dayFromYmd, dowOfDay } from './dates';

const cache = new Map<number, Map<number, string>>();

function vernalEquinoxDay(y: number): number {
  return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

function autumnalEquinoxDay(y: number): number {
  return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
}

/** y 年 m 月の第 n 月曜日 */
function nthMonday(y: number, m: number, n: number): number {
  const first = dayFromYmd(y, m, 1);
  const offset = (8 - dowOfDay(first)) % 7;
  return first + offset + (n - 1) * 7;
}

function buildYear(y: number): Map<number, string> {
  const holidays = new Map<number, string>();
  const add = (day: number, name: string) => holidays.set(day, name);
  const ymd = (m: number, d: number) => dayFromYmd(y, m, d);

  add(ymd(1, 1), '元日');
  add(y >= 2000 ? nthMonday(y, 1, 2) : ymd(1, 15), '成人の日');
  add(ymd(2, 11), '建国記念の日');
  if (y >= 2020) add(ymd(2, 23), '天皇誕生日');
  add(ymd(3, vernalEquinoxDay(y)), '春分の日');
  add(ymd(4, 29), y >= 2007 ? '昭和の日' : 'みどりの日');
  add(ymd(5, 3), '憲法記念日');
  if (y >= 2007) add(ymd(5, 4), 'みどりの日');
  add(ymd(5, 5), 'こどもの日');

  if (y === 2020) add(ymd(7, 23), '海の日');
  else if (y === 2021) add(ymd(7, 22), '海の日');
  else if (y >= 2003) add(nthMonday(y, 7, 3), '海の日');
  else if (y >= 1996) add(ymd(7, 20), '海の日');

  if (y === 2020) add(ymd(8, 10), '山の日');
  else if (y === 2021) add(ymd(8, 8), '山の日');
  else if (y >= 2016) add(ymd(8, 11), '山の日');

  add(y >= 2003 ? nthMonday(y, 9, 3) : ymd(9, 15), '敬老の日');
  add(ymd(9, autumnalEquinoxDay(y)), '秋分の日');

  const sportsName = y >= 2020 ? 'スポーツの日' : '体育の日';
  if (y === 2020) add(ymd(7, 24), sportsName);
  else if (y === 2021) add(ymd(7, 23), sportsName);
  else add(y >= 2000 ? nthMonday(y, 10, 2) : ymd(10, 10), sportsName);

  add(ymd(11, 3), '文化の日');
  add(ymd(11, 23), '勤労感謝の日');
  if (y >= 1989 && y <= 2018) add(ymd(12, 23), '天皇誕生日');

  if (y === 2019) {
    add(ymd(5, 1), '天皇の即位の日');
    add(ymd(10, 22), '即位礼正殿の儀');
  }

  const national = new Set(holidays.keys());

  // 振替休日: 祝日が日曜日に当たるとき、その後の最初の祝日でない日
  for (const day of national) {
    if (dowOfDay(day) !== 0) continue;
    let sub = day + 1;
    if (y >= 2007) {
      while (holidays.has(sub)) sub++;
    } else if (holidays.has(sub)) {
      continue;
    }
    holidays.set(sub, '振替休日');
  }

  // 国民の休日: 前日と翌日が祝日である日（2006 年以前は日曜日を除く）
  for (const day of national) {
    const mid = day + 1;
    if (national.has(mid + 1) && !holidays.has(mid) && (y >= 2007 || dowOfDay(mid) !== 0)) {
      holidays.set(mid, '国民の休日');
    }
  }

  return holidays;
}

function yearMap(y: number): Map<number, string> {
  let map = cache.get(y);
  if (!map) {
    map = buildYear(y);
    cache.set(y, map);
  }
  return map;
}

/** 祝日・休日名（祝日でなければ undefined） */
export function holidayName(day: number): string | undefined {
  const y = new Date(day * 86_400_000).getUTCFullYear();
  return yearMap(y).get(day);
}

export function isNationalHoliday(day: number): boolean {
  return holidayName(day) !== undefined;
}

/** 土日祝（電力取引で一般的な「休日」扱い） */
export function isOffDay(day: number): boolean {
  const dow = dowOfDay(day);
  return dow === 0 || dow === 6 || isNationalHoliday(day);
}

/** 指定年の祝日・休日一覧（テスト・表示用） */
export function holidaysOfYear(y: number): [number, string][] {
  return [...yearMap(y).entries()].sort((a, b) => a[0] - b[0]);
}
