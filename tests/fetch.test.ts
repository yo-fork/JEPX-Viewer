import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { defaultOptions, parseArgs, run } from '../scripts/fetch-jepx';
import { decodeFyFile, type Manifest } from '../src/lib/dataFile';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { formatSpotCsv, type DayMap } from '../src/lib/jepxCsv';

/** 各年度の先頭 3 日ぶんの合成データ（Shift_JIS の CSV として配信する） */
const FIXTURES = new Map<number, DayMap>([
  [2023, generateDemoDays(dayFromYmd(2023, 4, 1), dayFromYmd(2023, 4, 3), 1)],
  [2024, generateDemoDays(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 3), 2)],
]);

let server: Server;
let baseUrl = '';
let workdir = '';
const requests: string[] = [];

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'jepx-viewer-'));
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const m = /spot_summary_(\d{4})\.csv/.exec(req.url ?? '');
    const days = m ? FIXTURES.get(Number(m[1])) : undefined;
    if (!days) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/csv' });
    res.end(iconv.encode(formatSpotCsv(days), 'Shift_JIS'));
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
      log: (m) => logs.push(m),
    });
    expect(requests.some((r) => r.includes('spot_summary_2022.csv'))).toBe(true);
    expect(logs.some((l) => l.startsWith('2022年度') && l.includes('データがありません'))).toBe(true);
    expect(manifest.files.map((f) => [f.fy, f.firstDate, f.lastDate, f.days])).toEqual([
      [2023, '2023-04-01', '2023-04-03', 3],
      [2024, '2024-04-01', '2024-04-03', 3],
    ]);
    const onDisk = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')) as Manifest;
    expect(onDisk.files).toHaveLength(2);
    const back = decodeFyFile(JSON.parse(await readFile(path.join(out, 'spot', 'fy2024.json'), 'utf8')));
    for (const [day, vals] of FIXTURES.get(2024)!) expect(back.get(day)).toEqual(vals);
  });

  it('ダウンロード済みの CSV（--from-dir）を変換できる', async () => {
    const csvDir = path.join(workdir, 'csv');
    await mkdir(csvDir, { recursive: true });
    await writeFile(path.join(csvDir, 'spot_summary_2023.csv'), iconv.encode(formatSpotCsv(FIXTURES.get(2023)!), 'Shift_JIS'));
    const out = path.join(workdir, 'converted');
    const manifest = await run({ ...defaultOptions(), from: 2005, to: 2030, out, fromDir: csvDir, log: () => {} });
    expect(manifest.files.map((f) => f.fy)).toEqual([2023]);
    expect(manifest.source).toBe(`local:${csvDir}`);
  });

  it('コマンドライン引数を解釈する', () => {
    const o = parseArgs(['--from', '2016', '--to', '2020', '--force', '--keep-csv', '--out', 'x', '--delay', '0']);
    expect(o).toMatchObject({ from: 2016, to: 2020, force: true, keepCsv: true, out: 'x', delayMs: 0 });
    expect(() => parseArgs(['--from', '2020', '--to', '2016'])).toThrow();
    expect(() => parseArgs(['--unknown'])).toThrow();
  });
});
