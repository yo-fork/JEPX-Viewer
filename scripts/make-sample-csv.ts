/**
 * 動作確認用に、JEPX「スポット市場 取引結果」と同じ列構成・文字コード（Shift_JIS）の CSV を合成データで作る。
 * 値は src/lib/demo.ts の擬似乱数による合成値で、実際の約定価格ではない。
 *
 *   npm run sample                       今年度と前年度（samples/ に出力）
 *   npm run sample -- --from 2022 --to 2024 --out samples
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import iconv from 'iconv-lite';
import { toCsv } from '../src/lib/csv';
import { fiscalYearEnd, fiscalYearOfDay, fiscalYearStart, formatDay, todayJst } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { SPOT_CSV_COLUMNS } from '../src/lib/jepxCsv';
import { AREAS, SERIES_INDEX, SLOTS } from '../src/lib/series';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const today = todayJst();
const to = Number(opt('--to') ?? fiscalYearOfDay(today));
const from = Number(opt('--from') ?? to - 1);
const out = opt('--out') ?? 'samples';

// 実ファイルにある付帯列（本ツールでは読み飛ばす）も再現する
const EXTRA_COLUMNS = [
  'スポット・時間前平均価格(円/kWh)',
  'α上限値×スポット・時間前平均価格(円/kWh)',
  'α下限値×スポット・時間前平均価格(円/kWh)',
  'α速報値×スポット・時間前平均価格(円/kWh)',
  'α確報値×スポット・時間前平均価格(円/kWh)',
  '回避可能原価全国値(円/kWh)',
  ...AREAS.map((a) => `回避可能原価${a.label}(円/kWh)`),
];

await mkdir(out, { recursive: true });
for (let fy = from; fy <= to; fy++) {
  const start = fiscalYearStart(fy);
  const end = Math.min(fiscalYearEnd(fy), today + 1);
  if (end < start) continue;
  const days = generateDemoDays(start, end, 1000 + fy);
  const rows: (string | number)[][] = [['受渡日', '時刻コード', ...SPOT_CSV_COLUMNS.map((c) => c[0]), ...EXTRA_COLUMNS]];
  for (let day = start; day <= end; day++) {
    const v = days.get(day)!;
    for (let s = 0; s < SLOTS; s++) {
      const sys = v[SERIES_INDEX.system * SLOTS + s];
      rows.push([
        formatDay(day),
        s + 1,
        ...SPOT_CSV_COLUMNS.map(([, key]) => v[SERIES_INDEX[key] * SLOTS + s]),
        ...EXTRA_COLUMNS.map((_, i) => (i === 0 ? sys : Math.round(sys * (0.9 + i * 0.01) * 100) / 100)),
      ]);
    }
  }
  const file = path.join(out, `synthetic_spot_summary_${fy}.csv`);
  await writeFile(file, iconv.encode(toCsv(rows), 'Shift_JIS'));
  console.log(`${file}: ${formatDay(start)}〜${formatDay(end)}（${rows.length - 1} 行、合成データ）`);
}
