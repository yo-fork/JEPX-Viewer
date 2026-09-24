import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { defaultOptions, parseArgs, run } from '../scripts/fetch-jepx';
import { decodeCurveDay, decodeCurveMetrics, formatBidCurveCsv, formatSplittingAreasCsv } from '../src/lib/bidCurves';
import { decodeFyFile, type Manifest } from '../src/lib/dataFile';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay } from '../src/lib/demoCurves';
import { formatSpotCsv, type DayMap } from '../src/lib/jepxCsv';
import { SERIES_INDEX, SLOTS } from '../src/lib/series';

/** 各年度の先頭 3 日ぶんの合成データ（Shift_JIS の CSV として配信する） */
const FIXTURES = new Map<number, DayMap>([
  [2023, generateDemoDays(dayFromYmd(2023, 4, 1), dayFromYmd(2023, 4, 3), 1)],
  [2024, generateDemoDays(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 3), 2)],
]);

/** 合成データの価格の近くで交わる入札カーブ */
function curveFixture(day: number) {
  const vals = [...FIXTURES.values()].find((m) => m.has(day))?.get(day);
  if (!vals) return null;
  const at = (k: keyof typeof SERIES_INDEX, s: number) => vals[SERIES_INDEX[k] * SLOTS + s];
  return syntheticCurveDay(
    day,
    Array.from({ length: SLOTS }, (_, s) => ({ system: at('system', s), volume: at('volume', s) / 500, east: at('tokyo', s), west: at('kansai', s) })),
  );
}

let server: Server;
let baseUrl = '';
let workdir = '';
const requests: string[] = [];

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'jepx-viewer-'));
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const summary = /spot_summary_(\d{4})\.csv/.exec(req.url ?? '');
    const curve = /(spot_bid_curves|spot_splitting_areas)_(\d{8})\.csv/.exec(req.url ?? '');
    let csv: string | null = null;
    if (summary) {
      const days = FIXTURES.get(Number(summary[1]));
      if (days) csv = formatSpotCsv(days);
    } else if (curve) {
      const f = curveFixture(dayFromYmd(Number(curve[2].slice(0, 4)), Number(curve[2].slice(4, 6)), Number(curve[2].slice(6))));
      if (f) csv = curve[1] === 'spot_bid_curves' ? formatBidCurveCsv(f.raw) : formatSplittingAreasCsv(f.raw.day, f.groups);
    }
    if (csv === null) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(iconv.encode(csv, 'Shift_JIS'));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  baseUrl = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(workdir, { recursive: true, force: true });
});

describe('データ取得スクリプト', () => {
  it('年度別 CSV を取得して年度ファイルと manifest を作る', async () => {
    const out = path.join(workdir, 'data');
    const logs: string[] = [];
    const manifest = await run({
      ...defaultOptions(),
      from: 2022,
      to: 2024,
      out,
      urlTemplate: `${baseUrl}/csv_read.php?file=spot_summary_{fy}.csv`,
      delayMs: 0,
      curves: false,
      log: (m) => logs.push(m),
    });
    expect(requests.some((r) => r.includes('spot_summary_2022.csv'))).toBe(true);
    expect(requests.some((r) => r.includes('spot_bid_curves'))).toBe(false);
    expect(logs.some((l) => l.startsWith('2022年度') && l.includes('データがありません'))).toBe(true);
    expect(manifest.files.map((f) => [f.fy, f.firstDate, f.lastDate, f.days])).toEqual([
      [2023, '2023-04-01', '2023-04-03', 3],
      [2024, '2024-04-01', '2024-04-03', 3],
    ]);
    expect(manifest.curves).toBeUndefined();
    const onDisk = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')) as Manifest;
    expect(onDisk.files).toHaveLength(2);
    const back = decodeFyFile(JSON.parse(await readFile(path.join(out, 'spot', 'fy2024.json'), 'utf8')));
    for (const [day, vals] of FIXTURES.get(2024)!) expect(back.get(day)).toEqual(vals);
  });

  it('受渡日ごとの入札カーブを取得し、1 日分のファイル・指標の年度ファイル・一覧を作る', async () => {
    const out = path.join(workdir, 'curves');
    const logs: string[] = [];
    const opts = {
      ...defaultOptions(),
      from: 2024,
      to: 2024,
      out,
      urlTemplate: `${baseUrl}/csv_read.php?file=spot_summary_{fy}.csv`,
      curvesUrlTemplate: `${baseUrl}/csv_read.php?dir={dir}&file={file}`,
      curvesFrom: dayFromYmd(2024, 3, 31),
      curvesTo: dayFromYmd(2024, 4, 3),
      delayMs: 0,
      log: (m: string) => logs.push(m),
    };
    const manifest = await run(opts);
    expect(requests.some((r) => r.includes('dir=spot_bid_curves&file=spot_bid_curves_20240401.csv'))).toBe(true);
    expect(requests.some((r) => r.includes('dir=spot_splitting_areas&file=spot_splitting_areas_20240401.csv'))).toBe(true);
    expect(logs.some((l) => l.includes('2024-03-31') && l.includes('データがありません'))).toBe(true);
    expect(manifest.curves).toMatchObject({ firstDate: '2024-04-01', lastDate: '2024-04-03', dates: ['20240401', '20240402', '20240403'] });
    expect(manifest.curves!.metrics.map((m) => [m.fy, m.file, m.days])).toEqual([[2024, 'curves/fy2024.json', 3]]);

    const day = decodeCurveDay(JSON.parse(await readFile(path.join(out, 'curves', '2024', '20240402.json'), 'utf8')));
    const expected = curveFixture(dayFromYmd(2024, 4, 2))!;
    const split = expected.groups.findIndex((g) => g.length > 0);
    expect(day.slots[split]!.map((g) => g.label)).toEqual(['システムプライス', ...expected.groups[split].map((g) => g.label)]);
    const metrics = decodeCurveMetrics(JSON.parse(await readFile(path.join(out, 'curves', 'fy2024.json'), 'utf8')));
    expect(metrics.size).toBe(3);

    // 2 回目は取得済みの日を取り直さない
    const before = requests.length;
    const again = await run({ ...opts, from: 2025, to: 2025 });
    expect(requests.slice(before).filter((r) => r.includes('spot_bid_curves'))).toEqual([expect.stringContaining('20240331')]);
    expect(again.curves!.dates).toHaveLength(3);
  });

  it('ダウンロード済みの CSV（--from-dir）を変換できる（入札カーブの CSV も）', async () => {
    const csvDir = path.join(workdir, 'csv');
    await mkdir(csvDir, { recursive: true });
    await writeFile(path.join(csvDir, 'spot_summary_2023.csv'), iconv.encode(formatSpotCsv(FIXTURES.get(2023)!), 'Shift_JIS'));
    const f = curveFixture(dayFromYmd(2023, 4, 2))!;
    await writeFile(path.join(csvDir, 'spot_bid_curves_20230402.csv'), iconv.encode(formatBidCurveCsv(f.raw), 'Shift_JIS'));
    await writeFile(path.join(csvDir, 'spot_splitting_areas_20230402.csv'), iconv.encode(formatSplittingAreasCsv(f.raw.day, f.groups), 'Shift_JIS'));
    const out = path.join(workdir, 'converted');
    const manifest = await run({ ...defaultOptions(), from: 2005, to: 2030, out, fromDir: csvDir, log: () => {} });
    expect(manifest.files.map((x) => x.fy)).toEqual([2023]);
    expect(manifest.source).toBe(`local:${csvDir}`);
    expect(manifest.curves?.dates).toEqual(['20230402']);
    expect(existsSync(path.join(out, 'curves', 'fy2023.json'))).toBe(true);
  });

  it('コマンドライン引数を解釈する', () => {
    const o = parseArgs(['--from', '2016', '--to', '2020', '--force', '--keep-csv', '--out', 'x', '--delay', '0']);
    expect(o).toMatchObject({ from: 2016, to: 2020, force: true, keepCsv: true, out: 'x', delayMs: 0, curves: true });
    const c = parseArgs(['--curves-from', '2025-04-01', '--curves-to', '2025/04/30', '--no-curves']);
    expect(c).toMatchObject({ curvesFrom: dayFromYmd(2025, 4, 1), curvesTo: dayFromYmd(2025, 4, 30), curves: false });
    const d = defaultOptions();
    expect(d.curvesTo - d.curvesFrom + 1).toBe(90);
    expect(() => parseArgs(['--from', '2020', '--to', '2016'])).toThrow();
    expect(() => parseArgs(['--curves-from', '2025-05-01', '--curves-to', '2025-04-01'])).toThrow(/--curves-from/);
    expect(() => parseArgs(['--curves-from', 'yesterday'])).toThrow(/日付/);
    expect(() => parseArgs(['--unknown'])).toThrow();
  });
});
