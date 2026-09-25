import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { defaultOptions, parseArgs, run } from '../scripts/fetch-jepx';
import {
  curveDayFile,
  decodeCurveDay,
  decodeCurveMetrics,
  encodeCurveDay,
  formatBidCurveCsv,
  formatSplittingAreasCsv,
  parseBidCurveCsv,
  parseSplittingAreasCsv,
} from '../src/lib/bidCurves';
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
    const manifest = await run({ ...defaultOptions(), from: 2005, to: 2030, out, fromDirs: [csvDir], log: () => {} });
    expect(manifest.files.map((x) => x.fy)).toEqual([2023]);
    expect(manifest.source).toBe(`local:${csvDir}`);
    expect(manifest.curves?.dates).toEqual(['20230402']);
    expect(existsSync(path.join(out, 'curves', 'fy2023.json'))).toBe(true);
  });

  it('--from-dir は名前の違う CSV・サブフォルダ・複数日の CSV・分断エリア連番が -1 のシステムプライスも変換する', async () => {
    const saved = path.join(workdir, 'saved');
    await mkdir(path.join(saved, '2023'), { recursive: true });
    const minusOne = (csv: string) => csv.replace(/,\r\n/g, ',-1\r\n');
    const d2 = dayFromYmd(2023, 4, 2);
    const d3 = dayFromYmd(2023, 4, 3);
    const [f2, f3] = [curveFixture(d2)!, curveFixture(d3)!];
    const sjis = (csv: string) => iconv.encode(csv, 'Shift_JIS');
    await writeFile(path.join(saved, 'kakaku.csv'), sjis(formatSpotCsv(FIXTURES.get(2023)!)));
    await writeFile(path.join(saved, '2023', '入札カーブ_0402.csv'), sjis(minusOne(formatBidCurveCsv(f2.raw))));
    await writeFile(path.join(saved, '2023', '分断_0402.csv'), sjis(minusOne(formatSplittingAreasCsv(d2, f2.groups))));
    // 2 日分を 1 つの CSV に（2 日目は列名の行なし）。分断エリアの名前は無い
    const [head, ...rest] = minusOne(formatBidCurveCsv(f3.raw)).split('\r\n');
    await writeFile(path.join(saved, 'curves.csv'), sjis([minusOne(formatBidCurveCsv(f2.raw)).trimEnd(), ...rest].join('\r\n')));
    expect(head).toContain('入札価格');
    await writeFile(path.join(saved, 'memo.csv'), 'メモ,です\r\n');

    const out = path.join(workdir, 'saved-out');
    const logs: string[] = [];
    const manifest = await run({ ...defaultOptions(), out, fromDirs: [saved], log: (m) => logs.push(m) });
    expect(manifest.files.map((x) => x.fy)).toEqual([2023]);
    expect(manifest.curves?.dates).toEqual(['20230402', '20230403']);
    // JEPX の形式（連番が空）の CSV から作ったものと同じになる
    const jepx = encodeCurveDay(parseBidCurveCsv(formatBidCurveCsv(f2.raw)).get(d2)!, parseSplittingAreasCsv(formatSplittingAreasCsv(d2, f2.groups)).get(d2));
    expect(JSON.parse(await readFile(path.join(out, curveDayFile(d2)), 'utf8'))).toEqual(JSON.parse(JSON.stringify(jepx)));
    const day3 = decodeCurveDay(JSON.parse(await readFile(path.join(out, curveDayFile(d3)), 'utf8')));
    const split = day3.slots.findIndex((g) => g !== null && g.length > 1);
    if (split >= 0) expect(day3.slots[split]![1].label).toMatch(/^分断エリア \d+$/);
    expect(logs.some((l) => l.includes('分断エリアの名前なし'))).toBe(true);
    expect(logs).toContain('読み込めなかった CSV: 1 件（memo.csv）');

    // --curves-from / --curves-to を指定したときだけ受渡日で絞る
    const only = await run({ ...defaultOptions(), out: path.join(workdir, 'saved-out2'), fromDirs: [saved], curvesFrom: d3, curvesTo: d3, curvesRangeSet: true, log: () => {} });
    expect(only.curves?.dates).toEqual(['20230403']);
    await expect(run({ ...defaultOptions(), out: path.join(workdir, 'none'), fromDirs: [path.join(saved, '2023')], curves: false, log: () => {} })).rejects.toThrow(/変換できる CSV がありません/);
  });

  it('--from-dir: UTF-8 で保存した大きな分断エリアの CSV も、先頭で種類を見分けて読む', async () => {
    const dir = path.join(workdir, 'utf8');
    await mkdir(dir, { recursive: true });
    const d2 = dayFromYmd(2023, 4, 2);
    const f2 = curveFixture(d2)!;
    expect(f2.groups.some((g) => g.length > 0)).toBe(true);
    await writeFile(path.join(dir, 'bid.csv'), formatBidCurveCsv(f2.raw));
    // 30 日分の分断エリア（8KB を超える）。判定で読む先頭 8192 バイトの境目が、全角文字の途中になるようにずらす
    const days = Array.from({ length: 30 }, (_, i) => d2 - 15 + i);
    const [header, ...rows] = days.flatMap((d, i) => formatSplittingAreasCsv(d, f2.groups).trimEnd().split('\r\n').slice(i === 0 ? 0 : 1));
    let bytes = Buffer.from('');
    for (let pad = 0; pad < 8; pad++) {
      bytes = Buffer.from([header, ...rows].join('\r\n').replace('\r\n', `${' '.repeat(pad)}\r\n`), 'utf8');
      if (bytes[8192] >= 0x80 && bytes[8192] <= 0xbf) break;
    }
    expect(bytes.length).toBeGreaterThan(8192);
    expect(bytes[8192] >= 0x80 && bytes[8192] <= 0xbf).toBe(true);
    await writeFile(path.join(dir, 'areas.csv'), bytes);
    const logs: string[] = [];
    await run({ ...defaultOptions(), out: path.join(workdir, 'utf8-out'), fromDirs: [dir], log: (m) => logs.push(m) });
    expect(logs.some((l) => l.includes('読み込めなかった'))).toBe(false);
    const day = decodeCurveDay(JSON.parse(await readFile(path.join(workdir, 'utf8-out', curveDayFile(d2)), 'utf8')));
    const s = f2.groups.findIndex((g) => g.length > 0);
    expect(day.slots[s]!.slice(1).map((g) => g.label)).toEqual(f2.groups[s].map((g) => g.label));
  });

  it('--from-dir を複数指定して、別々のフォルダの入札カーブと分断エリアを突き合わせる（別々に変換しても名前を付け直す）', async () => {
    const bidDir = path.join(workdir, 'sep', 'bid_curves');
    const splitDir = path.join(workdir, 'elsewhere', 'splitting_areas');
    await mkdir(bidDir, { recursive: true });
    await mkdir(splitDir, { recursive: true });
    const d2 = dayFromYmd(2024, 4, 2);
    const f2 = curveFixture(d2)!;
    const s = f2.groups.findIndex((g) => g.length > 0);
    expect(s).toBeGreaterThanOrEqual(0);
    const minusOne = (csv: string) => csv.replace(/,\r\n/g, ',-1\r\n');
    await writeFile(path.join(bidDir, 'spot_bid_curves_20240402.csv'), iconv.encode(minusOne(formatBidCurveCsv(f2.raw)), 'Shift_JIS'));
    await writeFile(path.join(splitDir, 'spot_splitting_areas_20240402.csv'), iconv.encode(minusOne(formatSplittingAreasCsv(d2, f2.groups)), 'Shift_JIS'));
    // 分断エリアだけがある日（入札カーブは無い）
    await writeFile(path.join(splitDir, 'spot_splitting_areas_20240403.csv'), formatSplittingAreasCsv(dayFromYmd(2024, 4, 3), f2.groups));
    const expected = JSON.parse(
      JSON.stringify(encodeCurveDay(parseBidCurveCsv(formatBidCurveCsv(f2.raw)).get(d2)!, parseSplittingAreasCsv(formatSplittingAreasCsv(d2, f2.groups)).get(d2))),
    );
    const dayFile = (out: string) => readFile(path.join(out, curveDayFile(d2)), 'utf8').then((t) => JSON.parse(t) as unknown);

    // 1 回で 2 つのフォルダを読む
    const both = path.join(workdir, 'sep-out-both');
    const logs: string[] = [];
    await run({ ...defaultOptions(), out: both, fromDirs: [bidDir, splitDir], log: (m) => logs.push(m) });
    expect(await dayFile(both)).toEqual(expected);
    expect(logs.some((l) => l.includes('分断エリアの名前なし'))).toBe(false);
    expect(logs).toContain('分断エリアの CSV だけがあり、入札カーブが無い日: 1 日（その日の入札カーブを変換すると名前が付きます）');

    // 別々に変換しても、あとから読んだ分断エリアの名前を付け直す
    const apart = path.join(workdir, 'sep-out-apart');
    await run({ ...defaultOptions(), out: apart, fromDirs: [bidDir], log: () => {} });
    expect(decodeCurveDay(await dayFile(apart)).slots[s]![1].label).toMatch(/^分断エリア \d+$/);
    const later: string[] = [];
    const manifest = await run({ ...defaultOptions(), out: apart, fromDirs: [splitDir], log: (m) => later.push(m) });
    expect(later).toContain('分断エリアの名前を、変換済みの入札カーブ 1 日に付けました');
    expect(await dayFile(apart)).toEqual(expected);
    expect(manifest.curves?.dates).toEqual(['20240402']);
  });

  it('コマンドライン引数を解釈する', () => {
    const o = parseArgs(['--from', '2016', '--to', '2020', '--force', '--keep-csv', '--out', 'x', '--delay', '0']);
    expect(o).toMatchObject({ from: 2016, to: 2020, force: true, keepCsv: true, out: 'x', delayMs: 0, curves: true });
    const c = parseArgs(['--curves-from', '2025-04-01', '--curves-to', '2025/04/30', '--no-curves']);
    expect(c).toMatchObject({ curvesFrom: dayFromYmd(2025, 4, 1), curvesTo: dayFromYmd(2025, 4, 30), curves: false, curvesRangeSet: true });
    expect(o.curvesRangeSet).toBe(false);
    expect(o.fromDirs).toEqual([]);
    expect(parseArgs(['--from-dir', 'a', '--from-dir', 'b']).fromDirs).toEqual(['a', 'b']);
    const d = defaultOptions();
    expect(d.curvesTo - d.curvesFrom + 1).toBe(90);
    expect(() => parseArgs(['--from', '2020', '--to', '2016'])).toThrow();
    expect(() => parseArgs(['--curves-from', '2025-05-01', '--curves-to', '2025-04-01'])).toThrow(/--curves-from/);
    expect(() => parseArgs(['--curves-from', 'yesterday'])).toThrow(/日付/);
    expect(() => parseArgs(['--unknown'])).toThrow();
  });
});
