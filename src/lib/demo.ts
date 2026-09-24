/**
 * デモ用の合成データ生成。
 *
 * 実データが手元にない状態でも画面を試せるように、JEPX スポット価格に似た傾向
 * （季節・曜日・時間帯のパターン、太陽光による昼間の値下がり、東西の市場分断、
 * 九州の 0.01 円コマ、2021 年 1 月のような高騰）を持つ値を擬似乱数で作る。
 * **実際の約定価格ではない**ため、画面上では常に「デモデータ」と明示する。
 */
import { dowOfDay, fiscalYearOf, ymdFromDay } from './dates';
import { isNationalHoliday } from './holidays';
import { newDayValues, type DayMap } from './jepxCsv';
import { SERIES_INDEX, SLOTS, type SeriesKey } from './series';

/** 年度ごとの価格水準（円/kWh）と 1 コマあたり約定量（kWh）の目安 */
const LEVEL: Record<number, [number, number]> = {
  2016: [8.3, 3.0e6],
  2017: [9.5, 5.2e6],
  2018: [9.6, 9.0e6],
  2019: [7.6, 11.5e6],
  2020: [8.8, 13.5e6],
  2021: [13.0, 15.5e6],
  2022: [19.5, 12.8e6],
  2023: [10.4, 13.6e6],
  2024: [11.6, 14.6e6],
  2025: [10.9, 15.2e6],
};

function levelOf(fy: number): [number, number] {
  if (LEVEL[fy]) return LEVEL[fy];
  return fy < 2016 ? [9.5, 1.0e6] : [10.8, 15.5e6];
}

/** 時刻別の価格形状（0 時〜23 時） */
const HOUR_SHAPE = [
  0.9, 0.87, 0.85, 0.84, 0.85, 0.89, 0.97, 1.07, 1.12, 1.07, 0.99, 0.95, 0.93, 0.95, 0.99, 1.05, 1.13, 1.24, 1.3,
  1.24, 1.13, 1.05, 0.99, 0.94,
];
/** 月別の水準（1〜12 月） */
const MONTH_FACTOR = [1.24, 1.16, 0.97, 0.86, 0.82, 0.9, 1.08, 1.2, 1.02, 0.9, 0.95, 1.12];
/** 太陽光の影響の強さ（1〜12 月） */
const SOLAR_MONTH = [0.35, 0.5, 0.8, 1.0, 1.0, 0.7, 0.55, 0.55, 0.7, 0.85, 0.7, 0.4];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const round2 = (v: number) => Math.max(0.01, Math.round(v * 100) / 100);

export function generateDemoDays(fromDay: number, toDay: number, seed = 20240401): DayMap {
  const rand = mulberry32(seed);
  const days: DayMap = new Map();
  let dailyShock = 0;
  let eastBias = 0.04;
  const idx = (k: SeriesKey, s: number) => SERIES_INDEX[k] * SLOTS + s;

  for (let day = fromDay; day <= toDay; day++) {
    const { y, m, d } = ymdFromDay(day);
    const fy = fiscalYearOf(y, m);
    const [level, volLevel] = levelOf(fy);
    const off = dowOfDay(day) === 0 || dowOfDay(day) === 6 || isNationalHoliday(day);
    const solarGrowth = Math.min(1, Math.max(0.15, (fy - 2015) / 9));

    dailyShock = 0.82 * dailyShock + 0.09 * gaussian(rand);
    eastBias = 0.9 * eastBias + 0.1 * (0.05 + 0.08 * gaussian(rand));
    // 2021 年 1 月の需給ひっ迫のような高騰イベント
    const crisis = y === 2021 && m === 1 && d >= 6 && d <= 22 ? 4 + 9 * Math.sin(((d - 6) / 16) * Math.PI) : 1;
    // 冬・夏の突発的な高値
    const spikeDay = (m === 1 || m === 2 || m === 7 || m === 8) && rand() < 0.03 ? 1.6 + rand() * 1.6 : 1;

    const vals = newDayValues();
    for (let s = 0; s < SLOTS; s++) {
      const hour = Math.floor(s / 2);
      const t = s / 2 + 0.25;
      const solarBell = Math.exp(-((t - 12.3) ** 2) / (2 * 2.2 ** 2));
      const solarDip = solarBell * SOLAR_MONTH[m - 1] * solarGrowth * (off ? 0.62 : 0.5);
      const peak = hour >= 17 && hour <= 19 ? spikeDay : 1 + (spikeDay - 1) * 0.35;
      let base =
        level *
        MONTH_FACTOR[m - 1] *
        (off ? 0.86 : 1) *
        Math.exp(dailyShock) *
        HOUR_SHAPE[hour] *
        (1 - solarDip) *
        peak *
        crisis *
        (1 + 0.035 * gaussian(rand));
      base = Math.max(0.01, base);

      // 東西の分断（東側が高くなりやすい）
      const splitEW = rand() < 0.28 + 0.2 * solarBell;
      const east = splitEW ? base * (1 + Math.abs(eastBias) + 0.03 * rand()) : base;
      const west = splitEW ? base * (1 - 0.35 * Math.abs(eastBias)) : base;
      const hokkaido = rand() < 0.22 ? east * (1 + 0.04 + 0.25 * rand()) : east;
      const tohoku = rand() < 0.1 ? east * (0.9 + 0.08 * rand()) : east;

      // 太陽光の出力が大きい時間帯は九州・中国・四国で最低価格（0.01 円）が出やすい
      const floorChance = solarBell * SOLAR_MONTH[m - 1] * solarGrowth * (off ? 0.75 : 0.35);
      const kyushuFloor = rand() < floorChance;
      const kyushu = kyushuFloor ? 0.01 : rand() < 0.15 ? west * (0.85 + 0.1 * rand()) : west;
      const shikokuFloor = kyushuFloor && rand() < 0.35;
      const chugoku = shikokuFloor && rand() < 0.6 ? 0.01 : west;
      const shikoku = shikokuFloor ? 0.01 : west;
      const system = splitEW ? base * (1 + 0.1 * Math.abs(eastBias)) : base;

      vals[idx('system', s)] = round2(system);
      vals[idx('hokkaido', s)] = round2(hokkaido);
      vals[idx('tohoku', s)] = round2(tohoku);
      vals[idx('tokyo', s)] = round2(east);
      vals[idx('chubu', s)] = round2(rand() < 0.08 ? (east + west) / 2 : west);
      vals[idx('hokuriku', s)] = round2(west);
      vals[idx('kansai', s)] = round2(west);
      vals[idx('chugoku', s)] = round2(chugoku);
      vals[idx('shikoku', s)] = round2(shikoku);
      vals[idx('kyushu', s)] = round2(kyushu);

      const volume = volLevel * MONTH_FACTOR[m - 1] ** 0.5 * (0.75 + 0.35 * HOUR_SHAPE[hour]) * (off ? 0.9 : 1) * (1 + 0.05 * gaussian(rand));
      vals[idx('volume', s)] = Math.round(volume);
      vals[idx('sellBid', s)] = Math.round(volume * (1.25 + 0.3 * rand() + 0.25 * solarBell));
      vals[idx('buyBid', s)] = Math.round(volume * (1.08 + 0.2 * rand()));
    }
    days.set(day, vals);
  }
  return days;
}
