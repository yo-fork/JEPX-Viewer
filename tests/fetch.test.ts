import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import iconv from 'iconv-lite';
import { dayRuns, defaultOptions, parseArgs, run } from '../scripts/fetch-jepx';
import {
  CURVE_METRICS_REV,
  curveDayFile,
  decodeCurveAbsorbed,
  decodeCurveDay,
  decodeCurveGroups,
  decodeCurveMetrics,
  encodeCurveDay,
  formatBidCurveCsv,
  formatSplittingAreasCsv,
  parseBidCurveCsv,
  parseSplittingAreasCsv,
} from '../src/lib/bidCurves';
import { toCsv } from '../src/lib/csv';
import { decodeFyFile, type Manifest } from '../src/lib/dataFile';
import { dayFromYmd, formatDay } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay } from '../src/lib/demoCurves';
import { formatSpotCsv, newDayValues, type DayMap } from '../src/lib/jepxCsv';
import { decodeIntertieFy, INTERTIE_FIELD_INDEX, INTERTIE_INDEX, intertieOffset, type IntertieField } from '../src/lib/occto';
import { SENSITIVITY_KEYS, SENSITIVITY_SIZES, sensitivityKey, SERIES_INDEX, SLOTS, type SeriesKey } from '../src/lib/series';

/** 各年度の先頭 3 日ぶんの合成データ（Shift_JIS の CSV として配信する） */
const FIXTURES = new Map<number, DayMap>([
  [2023, generateDemoDays(dayFromYmd(2023, 4, 1), dayFromYmd(2023, 4, 3), 1)],
  [2024, generateDemoDays(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 3), 2)],
]);

const round2 = (v: number) => Math.round(v * 100) / 100;
/** 価格感応度の CSV（virtualprice_{年度}.csv）の列と系列 */
const SENS_COLUMNS: [string, SeriesKey][] = [
  ['システムプライス', 'system'],
  ...SENSITIVITY_SIZES.flatMap((mw): [string, SeriesKey][] => [
    [`売${mw}MW`, sensitivityKey('sell', mw)],
    [`買${mw}MW`, sensitivityKey('buy', mw)],
  ]),
];

/** 合成データのシステムプライスから作った価格感応度。取引結果の無い翌日の行も入れる（取引結果のある日にだけ入ることを確かめる） */
const SENS_FIXTURES = new Map<number, DayMap>(
  [...FIXTURES].map(([fy, days]) => {
    const out: DayMap = new Map();
    const last = Math.max(...days.keys());
    for (const [day, vals] of [...days, [last + 1, days.get(last)!] as const]) {
      const v = newDayValues();
      for (let s = 0; s < SLOTS; s++) {
        const sys = vals[SERIES_INDEX.system * SLOTS + s];
        v[SERIES_INDEX.system * SLOTS + s] = sys;
        SENSITIVITY_SIZES.forEach((mw, i) => {
          v[SERIES_INDEX[sensitivityKey('sell', mw)] * SLOTS + s] = Math.max(0.01, round2(sys - 0.3 * (i + 1)));
          v[SERIES_INDEX[sensitivityKey('buy', mw)] * SLOTS + s] = round2(sys + 0.4 * (i + 1));
        });
      }
      out.set(day, v);
    }
    return [fy, out];
  }),
);

function formatSensitivityCsv(days: DayMap): string {
  const rows: (string | number)[][] = [['年月日', '時刻コード', ...SENS_COLUMNS.map((c) => c[0])]];
  for (const day of [...days.keys()].sort((a, b) => a - b)) {
    const vals = days.get(day)!;
    for (let s = 0; s < SLOTS; s++) rows.push([formatDay(day), s + 1, ...SENS_COLUMNS.map(([, k]) => vals[SERIES_INDEX[k] * SLOTS + s])]);
  }
  return toCsv(rows);
}

/** 取引結果に、その日の価格感応度を重ねた値（年度ファイルに入るはずの値） */
function withSensitivity(fy: number, day: number, vals: Float64Array): Float64Array {
  const out = Float64Array.from(vals);
  const sens = SENS_FIXTURES.get(fy)!.get(day)!;
  for (const k of SENSITIVITY_KEYS) out.set(sens.subarray(SERIES_INDEX[k] * SLOTS, (SERIES_INDEX[k] + 1) * SLOTS), SERIES_INDEX[k] * SLOTS);
  return out;
}

const hasSensitivityValues = (vals: Float64Array | undefined) =>
  !!vals && SENSITIVITY_KEYS.some((k) => vals.subarray(SERIES_INDEX[k] * SLOTS, (SERIES_INDEX[k] + 1) * SLOTS).some((v) => !Number.isNaN(v)));

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

// ---- 広域機関の系統情報サービス（情報ダウンロード画面）のまね ----

/** 公表されている期間（計画潮流（翌日）と潮流実績） */
const OCCTO_RANGES = { plan: [dayFromYmd(2024, 3, 25), dayFromYmd(2024, 4, 3)], flow: [dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 3)] };
/** 試験用の計画潮流（東北-東京間。日とコマで決まる） */
const fixturePlan = (day: number, s: number) => 1000 + (day % 7) * 10 + s;
const slash = (day: number) => formatDay(day).replace(/-/g, '/');
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function occtoPlanCsv(from: number, to: number): string {
  const rows: (string | number)[][] = [
    ['対象断面', '策定日', '策定／更新後', '連系線', '年月日', '時刻', '方向', '空容量', '計画潮流', '広域調整枠', 'マージン', '運用容量', '運用容量決定要因', '最新更新年月日時刻'],
  ];
  for (let d = from; d <= to; d++) {
    for (const line of ['相馬双葉幹線', '未知の連系線']) {
      for (let s = 0; s < SLOTS; s++) {
        const p = fixturePlan(d, s);
        rows.push(['翌日', '', '策定', line, slash(d), hhmm((s + 1) * 30), '順方向', 5000 - 100 - p, p, 0, 100, 5000, '熱容量', '']);
        rows.push(['翌日', '', '策定', line, slash(d), hhmm((s + 1) * 30), '逆方向', -2000 + 50 - p, p, 0, -50, -2000, '熱容量', '']);
      }
    }
  }
  return toCsv(rows);
}

function occtoFlowCsv(from: number, to: number): string {
  const rows: (string | number)[][] = [
    ['連系線', '対象日付', '対象時刻', '運用容量(順方向)', '運用容量(逆方向)', '広域調整枠(順方向)', '広域調整枠(逆方向)', 'マージン(順方向)', 'マージン(逆方向)', '空容量(順方向)', '空容量(逆方向)', '計画潮流(順方向)', '計画潮流(逆方向)', '潮流実績', '運用容量拡大分(順方向)', '運用容量拡大分(逆方向)'],
  ];
  for (let d = from; d <= to; d++) {
    for (let k = 1; k <= 288; k++) {
      const plan = fixturePlan(d, Math.floor((k * 5 - 1) / 30)) + 5;
      // 5 分ごとの値は 30 分の平均が計画潮流と同じになるように揺らす
      rows.push(['相馬双葉幹線', slash(d), hhmm(k * 5), 5000, -2000, 0, 0, 100, -50, 0, 0, plan, plan, plan + ((k - 1) % 6) - 2.5, 0, 0]);
    }
  }
  return toCsv(rows);
}

async function occtoMock(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const params = new URLSearchParams(body);
  const sub = params.get('fwExtention.actionSubType') ?? '';
  const json = (root: Record<string, unknown>) => {
    res.writeHead(200, { 'Content-Type': 'text/plain;charset=utf-8' });
    res.end(JSON.stringify({ root: { errMessage: null, ...root } }));
  };
  if (url.pathname === '/occto/LOGIN_login') {
    occtoRequests.push('/occto/login');
    res.writeHead(200, { 'Set-Cookie': ['JSESSIONID=s1; Path=/', 'HSERVERID=h1; Path=/'], 'Content-Type': 'text/html' });
    res.end('<html><title>メニュー</title></html>');
    return;
  }
  if (url.pathname !== '/occto/CF01S010C') {
    res.writeHead(404).end();
    return;
  }
  // セッションが無ければ、本物と同じくタイムアウトの画面
  if (!(req.headers.cookie ?? '').includes('JSESSIONID=s1')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<form id="mainForm"><p>一定時間操作が行われなかったため、タイムアウトが発生しました。</p></form>');
    return;
  }
  if (url.searchParams.get('fwExtention.pathInfo') === 'CF01S010C') {
    occtoRequests.push('/occto/open');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><title>情報ダウンロード</title><form id="mainForm"></form></html>');
    return;
  }
  occtoRequests.push(`/occto/${sub}`);
  const kind = params.get('rklDataKnd') === '06' ? 'plan' : 'flow';
  const day = (k: string) => {
    const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(params.get(k) ?? '');
    return m ? dayFromYmd(Number(m[1]), Number(m[2]), Number(m[3])) : Number.NaN;
  };
  const [from, to] = [day('rklNngpFrom'), day('rklNngpTo')];
  if (req.headers.sdreqtype === 'AJAX') {
    if (sub === 'initDisplay') {
      const r = (k: 'plan' | 'flow') => ({ value: `(${slash(OCCTO_RANGES[k][0])}〜${slash(OCCTO_RANGES[k][1])})` });
      json({ bizRoot: { header: { akyuryNdKkn: r('plan'), rklFlowRsltKkn: r('flow') } } });
      return;
    }
    if (!(from >= OCCTO_RANGES[kind][0] && to <= OCCTO_RANGES[kind][1])) {
      json({ errMessage: [{ msgFormat: '検索対象期間外です。検索条件を見直してください。' }] });
      return;
    }
    if (sub === 'print') json({ confirmationMessage: { message: 'CSVを保存します。よろしいですか？' }, bizRoot: { header: { requestToken: { value: 't1' } } } });
    else if (sub === 'ok' && params.get('requestToken') === 't1') json({ bizRoot: { header: { downloadKey: { value: 'k1' }, requestToken: { value: 't2' } } } });
    else json({ errMessage: [{ msgFormat: '不正な操作です。' }] });
    return;
  }
  if (sub === 'download' && params.get('downloadKey') === 'k1' && params.get('requestToken') === 't2') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment;filename=x.csv' });
    res.end(iconv.encode(kind === 'plan' ? occtoPlanCsv(from, to) : occtoFlowCsv(from, to), 'Shift_JIS'));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('不正なリクエストです。');
}

/** 広域機関のまねへの通信（送った操作の順） */
const occtoRequests: string[] = [];

let server: Server;
let baseUrl = '';
let workdir = '';
const requests: string[] = [];
/** 取得元の URL（試験用のサーバー） */
const urls = () => ({
  urlTemplate: `${baseUrl}/csv_read.php?file=spot_summary_{fy}.csv`,
  curvesUrlTemplate: `${baseUrl}/csv_read.php?dir={dir}&file={file}`,
  sensitivityUrlTemplate: `${baseUrl}/csv_read.php?dir=virtualprice&file=virtualprice_{fy}.csv`,
  occtoBase: `${baseUrl}/occto/`,
});

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'jepx-viewer-'));
  server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/occto/')) {
      void occtoMock(req, res);
      return;
    }
    requests.push(req.url ?? '');
    const summary = /spot_summary_(\d{4})\.csv/.exec(req.url ?? '');
    const sens = /virtualprice_(\d{4})\.csv/.exec(req.url ?? '');
    const curve = /(spot_bid_curves|spot_splitting_areas)_(\d{8})\.csv/.exec(req.url ?? '');
    let csv: string | null = null;
    if (summary) {
      const days = FIXTURES.get(Number(summary[1]));
      if (days) csv = formatSpotCsv(days);
    } else if (sens) {
      const days = SENS_FIXTURES.get(Number(sens[1]));
      if (days) csv = formatSensitivityCsv(days);
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
  it('年度別 CSV を取得して年度ファイルと manifest を作る（価格感応度は取引結果のある日に入れる）', async () => {
    const out = path.join(workdir, 'data');
    const logs: string[] = [];
    const manifest = await run({
      ...defaultOptions(),
      ...urls(),
      from: 2022,
      to: 2024,
      out,
      delayMs: 0,
      curves: false,
      log: (m) => logs.push(m),
    });
    expect(requests.some((r) => r.includes('spot_summary_2022.csv'))).toBe(true);
    expect(requests.some((r) => r.includes('dir=virtualprice&file=virtualprice_2024.csv'))).toBe(true);
    // 取引結果の無い年度は、価格感応度を取りに行かない
    expect(requests.some((r) => r.includes('virtualprice_2022.csv'))).toBe(false);
    expect(requests.some((r) => r.includes('spot_bid_curves'))).toBe(false);
    expect(logs.some((l) => l.startsWith('2022年度') && l.includes('データがありません'))).toBe(true);
    expect(logs).toContain('2024年度: 2024-04-01〜2024-04-03（3 日）を保存（価格感応度 3 日）');
    expect(manifest.files.map((f) => [f.fy, f.firstDate, f.lastDate, f.days])).toEqual([
      [2023, '2023-04-01', '2023-04-03', 3],
      [2024, '2024-04-01', '2024-04-03', 3],
    ]);
    expect(manifest.curves).toBeUndefined();
    const onDisk = JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')) as Manifest;
    expect(onDisk.files).toHaveLength(2);
    const back = decodeFyFile(JSON.parse(await readFile(path.join(out, 'spot', 'fy2024.json'), 'utf8')));
    for (const [day, vals] of FIXTURES.get(2024)!) expect(back.get(day)).toEqual(withSensitivity(2024, day, vals));
    expect(back.has(dayFromYmd(2024, 4, 4))).toBe(false);
  });

  it('前の版で取得した年度ファイルには、価格感応度だけを取得して足す（2 回目からは取りに行かない）', async () => {
    const out = path.join(workdir, 'upgrade');
    const opts = { ...defaultOptions(), ...urls(), from: 2023, to: 2023, out, delayMs: 0, curves: false };
    await run({ ...opts, sensitivity: false, log: () => {} });
    const file = () => readFile(path.join(out, 'spot', 'fy2023.json'), 'utf8').then((t) => decodeFyFile(JSON.parse(t)));
    expect(hasSensitivityValues((await file()).get(dayFromYmd(2023, 4, 1)))).toBe(false);

    // 前年度より前の年度は取得済みならスキップするが、価格感応度が無ければそれだけ取得する
    const before = requests.length;
    const logs: string[] = [];
    await run({ ...opts, log: (m) => logs.push(m) });
    expect(requests.slice(before).map((r) => /(spot_summary|virtualprice)_\d{4}/.exec(r)?.[0])).toEqual(['virtualprice_2023']);
    expect(logs).toContain('2023年度: 取得済みの取引結果に、価格感応度（3 日）を足しました');
    for (const [day, vals] of FIXTURES.get(2023)!) expect((await file()).get(day)).toEqual(withSensitivity(2023, day, vals));

    const again = requests.length;
    const later: string[] = [];
    await run({ ...opts, log: (m) => later.push(m) });
    expect(requests.length).toBe(again);
    expect(later).toContain('2023年度: 取得済みのためスキップ');
  });

  it('価格感応度を取得できなくても取引結果は保存し、前に取得した価格感応度は残す', async () => {
    const out = path.join(workdir, 'no-sens');
    const opts = { ...defaultOptions(), ...urls(), from: 2024, to: 2024, out, delayMs: 0, curves: false, force: true };
    const first: string[] = [];
    await run({ ...opts, sensitivityUrlTemplate: `${baseUrl}/missing/{fy}.csv`, log: (m) => first.push(m) });
    expect(first).toContain('2024年度: 2024-04-01〜2024-04-03（3 日）を保存（価格感応度 0 日）');
    const fy2024 = () => readFile(path.join(out, 'spot', 'fy2024.json'), 'utf8').then((t) => decodeFyFile(JSON.parse(t)));
    expect(hasSensitivityValues((await fy2024()).get(dayFromYmd(2024, 4, 1)))).toBe(false);

    await run({ ...opts, log: () => {} });
    const logs: string[] = [];
    await run({ ...opts, sensitivity: false, log: (m) => logs.push(m) });
    expect(logs).toContain('2024年度: 2024-04-01〜2024-04-03（3 日）を保存（価格感応度 3 日。前に取得したもの）');
    for (const [day, vals] of FIXTURES.get(2024)!) expect((await fy2024()).get(day)).toEqual(withSensitivity(2024, day, vals));
  });

  it('受渡日ごとの入札カーブを取得し、1 日分のファイル・指標の年度ファイル・一覧を作る', async () => {
    const out = path.join(workdir, 'curves');
    const logs: string[] = [];
    const opts = {
      ...defaultOptions(),
      ...urls(),
      from: 2024,
      to: 2024,
      out,
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
    // 市場分断したコマには、間引く前のカーブから求めた「システムプライス − 分断エリアの合計」も入れる
    expect(day.residuals![split]).not.toBeNull();
    // 分断エリアのカーブの入札量の合計（連系線の量を求めるのに使う）も、間引く前のカーブから入れる
    expect(day.groupTotals![split]).not.toBeNull();
    expect(day.groupTotals![expected.groups.findIndex((g) => g.length === 0)]).toBeNull();
    expect(day.residuals![expected.groups.findIndex((g) => g.length === 0)]).toBeNull();
    const fyPath = path.join(out, 'curves', 'fy2024.json');
    const fyJson = JSON.parse(await readFile(fyPath, 'utf8'));
    const metrics = decodeCurveMetrics(fyJson);
    expect(metrics.size).toBe(3);
    // 取引結果に価格感応度の公表値があるので、ブロック入札の約定の変化の推定に使う値（間引く前のカーブから）も入れる
    expect(day.absorbed).toHaveLength(SLOTS);
    expect(day.absorbed!.some((a) => a !== null && Number.isFinite(a[0]))).toBe(true);
    // 指標の年度ファイルにも入れる（期間の一覧で使う）
    expect(fyJson.rev).toBe(CURVE_METRICS_REV);
    expect(decodeCurveAbsorbed(fyJson).size).toBe(3);
    expect(decodeCurveGroups(fyJson).size).toBeGreaterThan(0);

    // 2 回目は取得済みの日を取り直さない
    const before = requests.length;
    const again = await run({ ...opts, from: 2025, to: 2025 });
    expect(requests.slice(before).filter((r) => r.includes('spot_bid_curves'))).toEqual([expect.stringContaining('20240331')]);
    expect(again.curves!.dates).toHaveLength(3);

    // 前の版の指標の年度ファイル（版の番号と absorbed が無い）は、取り直さずに日のファイルから作り直す
    const old = JSON.parse(await readFile(fyPath, 'utf8'));
    delete old.rev;
    delete old.absorbed;
    await writeFile(fyPath, JSON.stringify(old));
    const third = requests.length;
    await run({ ...opts, from: 2025, to: 2025 });
    expect(requests.slice(third).filter((r) => r.includes('spot_bid_curves'))).toEqual([expect.stringContaining('20240331')]);
    const rebuilt = JSON.parse(await readFile(fyPath, 'utf8'));
    expect(rebuilt.rev).toBe(CURVE_METRICS_REV);
    expect(decodeCurveAbsorbed(rebuilt).size).toBe(3);
  });

  it('公表値を取得する前に保存した入札カーブには、あとで入札カーブだけを取り直して、ブロック入札の推定に使う値を足す', async () => {
    const out = path.join(workdir, 'absorbed');
    const day1 = dayFromYmd(2024, 4, 1);
    const opts = { ...defaultOptions(), ...urls(), from: 2024, to: 2024, out, curvesFrom: day1, curvesTo: day1, delayMs: 0 };
    await run({ ...opts, sensitivity: false, log: () => {} });
    const file = path.join(out, curveDayFile(day1));
    expect(JSON.parse(await readFile(file, 'utf8')).absorbed).toBeUndefined();

    const before = requests.length;
    const logs: string[] = [];
    await run({ ...opts, log: (m) => logs.push(m) });
    const again = requests.slice(before);
    expect(again.filter((r) => r.includes('spot_bid_curves_20240401'))).toHaveLength(1);
    expect(again.some((r) => r.includes('spot_splitting_areas'))).toBe(false);
    expect(logs.some((l) => l.includes('ブロック入札の約定の変化の推定のために取り直しました'))).toBe(true);
    expect(decodeCurveDay(JSON.parse(await readFile(file, 'utf8'))).absorbed!.some(Boolean)).toBe(true);
    // 指標の年度ファイルも作り直して入れる
    expect(decodeCurveAbsorbed(JSON.parse(await readFile(path.join(out, 'curves', 'fy2024.json'), 'utf8'))).size).toBe(1);

    // 足した後は取り直さない
    const third = requests.length;
    await run({ ...opts, log: () => {} });
    expect(requests.slice(third).some((r) => r.includes('spot_bid_curves'))).toBe(false);
  });

  it('--keep-csv では、価格感応度・入札カーブ・分断エリアの CSV も raw に保存する（あとで --from-dir で変換し直せる）', async () => {
    const out = path.join(workdir, 'keep');
    await run({
      ...defaultOptions(),
      ...urls(),
      from: 2024,
      to: 2024,
      out,
      keepCsv: true,
      curvesFrom: dayFromYmd(2024, 4, 1),
      curvesTo: dayFromYmd(2024, 4, 1),
      delayMs: 0,
      log: () => {},
    });
    for (const f of ['spot_summary_2024.csv', 'virtualprice_2024.csv', 'curves/spot_bid_curves_20240401.csv', 'curves/spot_splitting_areas_20240401.csv']) {
      expect(existsSync(path.join(out, 'raw', f))).toBe(true);
    }
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

  it('--from-dir: 価格感応度の CSV は取引結果のある日に重ね、取引結果の CSV が無い年度は変換済みの年度ファイルに足す', async () => {
    const sjis = (csv: string) => iconv.encode(csv, 'Shift_JIS');
    const both = path.join(workdir, 'sens-both');
    await mkdir(both, { recursive: true });
    // 名前の順で価格感応度を先に読む（後から読んだ取引結果で、価格感応度を消さない）
    await writeFile(path.join(both, 'a_virtualprice_2024.csv'), sjis(formatSensitivityCsv(SENS_FIXTURES.get(2024)!)));
    await writeFile(path.join(both, 'b_spot_summary_2024.csv'), sjis(formatSpotCsv(FIXTURES.get(2024)!)));
    const out = path.join(workdir, 'sens-out');
    const logs: string[] = [];
    const manifest = await run({ ...defaultOptions(), out, fromDirs: [both], log: (m) => logs.push(m) });
    // 取引結果の無い翌日（価格感応度だけの行）は入れない
    expect(manifest.files.map((x) => [x.fy, x.days])).toEqual([[2024, 3]]);
    const fy2024 = (dir: string) => readFile(path.join(dir, 'spot', 'fy2024.json'), 'utf8').then((t) => decodeFyFile(JSON.parse(t)));
    for (const [day, vals] of FIXTURES.get(2024)!) expect((await fy2024(out)).get(day)).toEqual(withSensitivity(2024, day, vals));
    expect(logs.some((l) => l.includes('fy2024.json') && l.includes('価格感応度 3 日'))).toBe(true);

    // 取引結果だけを変換してから、価格感応度だけを変換する
    const spotOnly = path.join(workdir, 'sens-spot');
    const sensOnly = path.join(workdir, 'sens-only');
    await mkdir(spotOnly, { recursive: true });
    await mkdir(sensOnly, { recursive: true });
    await writeFile(path.join(spotOnly, 'spot_summary_2024.csv'), sjis(formatSpotCsv(FIXTURES.get(2024)!)));
    await writeFile(path.join(sensOnly, 'virtualprice_2023.csv'), sjis(formatSensitivityCsv(SENS_FIXTURES.get(2023)!)));
    await writeFile(path.join(sensOnly, 'virtualprice_2024.csv'), sjis(formatSensitivityCsv(SENS_FIXTURES.get(2024)!)));
    const apart = path.join(workdir, 'sens-apart');
    await run({ ...defaultOptions(), out: apart, fromDirs: [spotOnly], log: () => {} });
    const later: string[] = [];
    const m2 = await run({ ...defaultOptions(), out: apart, fromDirs: [sensOnly], log: (m) => later.push(m) });
    expect(later).toContain('2023年度: 取引結果が無いため、価格感応度だけでは変換しません（取引結果の CSV も指定してください）');
    expect(m2.files.map((x) => x.fy)).toEqual([2024]);
    for (const [day, vals] of FIXTURES.get(2024)!) expect((await fy2024(apart)).get(day)).toEqual(withSensitivity(2024, day, vals));

    // 取引結果を変換し直しても、変換済みの価格感応度は残す
    const again: string[] = [];
    await run({ ...defaultOptions(), out: apart, fromDirs: [spotOnly], log: (m) => again.push(m) });
    expect(again.some((l) => l.includes('fy2024.json') && l.includes('変換済みの価格感応度 3 日を残す'))).toBe(true);
    for (const [day, vals] of FIXTURES.get(2024)!) expect((await fy2024(apart)).get(day)).toEqual(withSensitivity(2024, day, vals));
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

  it('--from-dir: 分断エリア連番が -1.0・0.0 の UTF-8 の CSV も変換し、システムプライスのカーブが無い日は保存しない', async () => {
    const dir = path.join(workdir, 'decimals');
    await mkdir(dir, { recursive: true });
    const d2 = dayFromYmd(2024, 4, 2);
    const f2 = curveFixture(d2)!;
    // 最後の列（分断エリア連番）を -1.0・0.0 のような小数にする（表計算ソフトで保存し直した形）
    const decimals = (csv: string) => csv.replace(/,(\d*)\r\n/g, (_, id: string) => `,${id === '' ? '-1' : id}.0\r\n`);
    const bid = decimals(formatBidCurveCsv(f2.raw));
    expect(bid).toMatch(/,-1\.0\r\n/);
    await writeFile(path.join(dir, 'spot_bid_curves_20240402.csv'), bid);
    await writeFile(path.join(dir, 'spot_splitting_areas_20240402.csv'), decimals(formatSplittingAreasCsv(d2, f2.groups)));
    // システムプライスの行が無い CSV（分断エリアの行だけ）
    const onlyGroups = bid
      .split('\r\n')
      .filter((l, i) => i === 0 || (l !== '' && !l.endsWith(',-1.0')))
      .join('\r\n')
      .replace(/^20240402,/gm, '20240403,');
    await writeFile(path.join(dir, 'spot_bid_curves_20240403.csv'), onlyGroups);

    const out = path.join(workdir, 'decimals-out');
    const logs: string[] = [];
    const manifest = await run({ ...defaultOptions(), out, fromDirs: [dir], log: (m) => logs.push(m) });
    const expected = encodeCurveDay(parseBidCurveCsv(formatBidCurveCsv(f2.raw)).get(d2)!, parseSplittingAreasCsv(formatSplittingAreasCsv(d2, f2.groups)).get(d2));
    expect(JSON.parse(await readFile(path.join(out, curveDayFile(d2)), 'utf8'))).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(expected.slots.filter(Boolean)).toHaveLength(SLOTS);
    expect(manifest.curves?.dates).toEqual(['20240402']);
    expect(existsSync(path.join(out, curveDayFile(dayFromYmd(2024, 4, 3))))).toBe(false);
    expect(logs.some((l) => l.includes('2024-04-03') && l.includes('システムプライスの入札カーブが 1 コマも無い'))).toBe(true);
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

  it('広域機関から連系線の計画潮流（翌日）と潮流実績を取得し、連系線の年度ファイルと一覧を作る（取得済みの日は取り直さない）', async () => {
    const out = path.join(workdir, 'interties');
    const logs: string[] = [];
    const opts = {
      ...defaultOptions(),
      ...urls(),
      from: 2024,
      to: 2024,
      out,
      delayMs: 0,
      curves: false,
      sensitivity: false,
      intertiesFrom: dayFromYmd(2024, 3, 20),
      intertiesTo: dayFromYmd(2024, 4, 5),
      log: (m: string) => logs.push(m),
    };
    const before = occtoRequests.length;
    const manifest = await run(opts);
    const occ = occtoRequests.slice(before);
    // メニューでセッションを作り、画面を開き、取得できる期間を受け取ってから、確認・準備・ダウンロードの順に送る
    expect(occ.slice(0, 6)).toEqual(['/occto/login', '/occto/open', '/occto/initDisplay', '/occto/print', '/occto/ok', '/occto/download']);
    // 取得する範囲は、公表されている期間に縮める（計画潮流は 3/25〜4/3、潮流実績は 4/1〜4/3）
    expect(manifest.interties!.files.map((f) => [f.fy, f.firstDate, f.lastDate])).toEqual([
      [2023, '2024-03-25', '2024-03-31'],
      [2024, '2024-04-01', '2024-04-03'],
    ]);
    const d = dayFromYmd(2024, 4, 2);
    const v = decodeIntertieFy(JSON.parse(await readFile(path.join(out, 'interties', 'fy2024.json'), 'utf8'))).get(d)!;
    const at = (f: IntertieField, s: number) => v[intertieOffset(INTERTIE_INDEX.tohokuTokyo, INTERTIE_FIELD_INDEX[f], s)];
    expect([at('plan', 10), at('capFwd', 10), at('capRev', 10)]).toEqual([fixturePlan(d, 10), 5000, -2000]);
    // 上限は 運用容量 − マージン − 広域調整枠
    expect([at('limFwd', 10), at('limRev', 10)]).toEqual([4900, -1950]);
    // 潮流実績は 5 分ごとの値の 30 分の平均
    expect(at('actual', 10)).toBeCloseTo(fixturePlan(d, 10) + 5, 1);
    expect(at('planFinal', 10)).toBe(fixturePlan(d, 10) + 5);
    expect(logs.some((l) => l.includes('知らない連系線は読み飛ばしました: 未知の連系線'))).toBe(true);

    // 2 回目は取得済みの日を取り直さない
    const second = occtoRequests.length;
    await run(opts);
    expect(occtoRequests.slice(second).filter((r) => r === '/occto/download')).toEqual([]);
  });

  it('--from-dir: 広域機関の連系線の CSV（手元に保存したもの）も列名で見分けて、連系線の年度ファイルに入れる', async () => {
    const src = path.join(workdir, 'occto-csv');
    const out = path.join(workdir, 'occto-out');
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, 'renkeisen_akiyouryou.csv'), iconv.encode(occtoPlanCsv(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 2)), 'Shift_JIS'));
    await writeFile(path.join(src, 'renkeisen_flow.csv'), iconv.encode(occtoFlowCsv(dayFromYmd(2024, 4, 2), dayFromYmd(2024, 4, 2)), 'Shift_JIS'));
    const logs: string[] = [];
    const manifest = await run({ ...defaultOptions(), out, fromDirs: [src], log: (m) => logs.push(m) });
    expect(manifest.interties).toMatchObject({ firstDate: '2024-04-01', lastDate: '2024-04-02' });
    const v = decodeIntertieFy(JSON.parse(await readFile(path.join(out, 'interties', 'fy2024.json'), 'utf8'))).get(dayFromYmd(2024, 4, 2))!;
    const at = (f: IntertieField) => v[intertieOffset(INTERTIE_INDEX.tohokuTokyo, INTERTIE_FIELD_INDEX[f], 3)];
    expect([at('plan'), at('planFinal')]).toEqual([fixturePlan(dayFromYmd(2024, 4, 2), 3), fixturePlan(dayFromYmd(2024, 4, 2), 3) + 5]);
    expect(logs.some((l) => l.includes('連系線の計画潮流（翌日） 2024-04-01〜2024-04-02'))).toBe(true);
  });

  it('取得する日を、続いている日ごとに決まった日数以内の範囲にまとめる', () => {
    expect(dayRuns([5, 1, 2, 3, 7, 8], 31)).toEqual([
      [1, 3],
      [5, 5],
      [7, 8],
    ]);
    expect(dayRuns(Array.from({ length: 70 }, (_, i) => 100 + i), 31)).toEqual([
      [100, 130],
      [131, 161],
      [162, 169],
    ]);
  });

  it('コマンドライン引数を解釈する', () => {
    const o = parseArgs(['--from', '2016', '--to', '2020', '--force', '--keep-csv', '--out', 'x', '--delay', '0']);
    expect(o).toMatchObject({ from: 2016, to: 2020, force: true, keepCsv: true, out: 'x', delayMs: 0, curves: true });
    const c = parseArgs(['--curves-from', '2025-04-01', '--curves-to', '2025/04/30', '--no-curves']);
    expect(c).toMatchObject({ curvesFrom: dayFromYmd(2025, 4, 1), curvesTo: dayFromYmd(2025, 4, 30), curves: false, curvesRangeSet: true });
    expect(o.curvesRangeSet).toBe(false);
    expect(o.fromDirs).toEqual([]);
    expect(parseArgs(['--from-dir', 'a', '--from-dir', 'b']).fromDirs).toEqual(['a', 'b']);
    expect(o.sensitivity).toBe(true);
    expect(parseArgs(['--no-sensitivity', '--sensitivity-url-template', 'http://x/{fy}.csv'])).toMatchObject({ sensitivity: false, sensitivityUrlTemplate: 'http://x/{fy}.csv' });
    const d = defaultOptions();
    expect(d.curvesTo - d.curvesFrom + 1).toBe(90);
    expect([d.interties, d.intertiesTo - d.intertiesFrom + 1]).toEqual([true, 90]);
    expect(parseArgs(['--no-interties', '--interties-from', '2025-04-01', '--interties-to', '2025-04-30', '--occto-url', 'http://x/'])).toMatchObject({
      interties: false,
      intertiesFrom: dayFromYmd(2025, 4, 1),
      intertiesTo: dayFromYmd(2025, 4, 30),
      occtoBase: 'http://x/',
    });
    expect(() => parseArgs(['--interties-from', '2025-05-01', '--interties-to', '2025-04-01'])).toThrow(/--interties-from/);
    expect(() => parseArgs(['--from', '2020', '--to', '2016'])).toThrow();
    expect(() => parseArgs(['--curves-from', '2025-05-01', '--curves-to', '2025-04-01'])).toThrow(/--curves-from/);
    expect(() => parseArgs(['--curves-from', 'yesterday'])).toThrow(/日付/);
    expect(() => parseArgs(['--unknown'])).toThrow();
  });
});
