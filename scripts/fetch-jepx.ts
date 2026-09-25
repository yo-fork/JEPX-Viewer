/**
 * JEPX「スポット市場 取引結果」の年度別 CSV と、受渡日ごとの入札カーブを取得し、ビューア用のデータ（public/data）に変換する。
 *
 *   npm run fetch                             取引結果（2005 年度〜今年度）と、直近 90 日の入札カーブを取得（取得済みはスキップ）
 *   npm run fetch -- --from 2016              取引結果は 2016 年度以降だけ
 *   npm run fetch -- --curves-from 2025-04-01 入札カーブを 2025/4/1 の受渡分から取得
 *   npm run fetch -- --no-curves              入札カーブを取得しない
 *   npm run fetch -- --force                  取得済みの年度・日も取り直す
 *   npm run fetch -- --keep-csv               元の CSV も public/data/raw/ に保存する
 *   npm run fetch -- --from-dir ./csv         手元の CSV（ダウンロード・保存しておいたもの）を変換する（通信なし。複数指定できる）
 *
 * 社内プロキシ環境では HTTPS_PROXY / HTTP_PROXY / NO_PROXY 環境変数がそのまま使われる。
 * JEPX のサイトに負荷をかけないよう、取得は 1 件ずつ間隔（--delay）を空けて行う。
 */
import { mkdir, open, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvHttpProxyAgent, fetch } from 'undici';
import {
  applyGroupNames,
  curveCsvKind,
  curveDayFile,
  curveMetricsFile,
  decodeCurveMetrics,
  encodeCurveDay,
  encodeCurveMetrics,
  metricsOfDayFile,
  parseBidCurveCsv,
  parseSplittingAreasCsv,
  type AreaGroup,
  type CurveDayFile,
  type CurveMetricDays,
  type RawCurveDay,
} from '../src/lib/bidCurves';
import {
  decodeFyFile,
  encodeFyFile,
  FY_FILE_FORMAT,
  MANIFEST_FORMAT,
  splitByFiscalYear,
  type CurveIndex,
  type FyFile,
  type Manifest,
  type ManifestEntry,
} from '../src/lib/dataFile';
import { fiscalYearOfDay, isoFromDay, parseDateString, todayJst } from '../src/lib/dates';
import { decodeCsvBytes } from '../src/lib/encoding';
import { parseSpotCsv, type DayMap } from '../src/lib/jepxCsv';

export const JEPX_SPOT_PAGE = 'https://www.jepx.jp/electricpower/market-data/spot/';
export const DEFAULT_URL_TEMPLATE = 'https://www.jepx.jp/js/csv_read.php?dir=spot_summary&file=spot_summary_{fy}.csv';
/** 入札カーブの取得元（{dir} は spot_bid_curves または spot_splitting_areas、{file} はファイル名） */
export const DEFAULT_CURVES_URL_TEMPLATE = 'https://www.jepx.jp/js/csv_read.php?dir={dir}&file={file}';
/** JEPX のスポット市場は 2005 年 4 月に開始 */
export const FIRST_FY = 2005;
/** 入札カーブを既定で取得する日数（翌日受渡分までの直近の日数） */
export const DEFAULT_CURVE_DAYS = 90;

export interface FetchOptions {
  from: number;
  to: number;
  out: string;
  force: boolean;
  keepCsv: boolean;
  /** 手元の CSV のフォルダ（--from-dir。複数指定できる。指定すると通信しない） */
  fromDirs: string[];
  urlTemplate: string;
  delayMs: number;
  log: (msg: string) => void;
  /** 入札カーブを取得する */
  curves: boolean;
  /** 入札カーブを取得する受渡日の範囲 */
  curvesFrom: number;
  curvesTo: number;
  /** --curves-from / --curves-to を指定した（--from-dir では、指定したときだけ受渡日で絞る） */
  curvesRangeSet: boolean;
  curvesUrlTemplate: string;
}

export function defaultOptions(): FetchOptions {
  // 3/31 には翌日（翌年度 4/1）受渡分の約定結果が出ているので、翌日を基準にする
  const tomorrow = todayJst() + 1;
  return {
    from: FIRST_FY,
    to: fiscalYearOfDay(tomorrow),
    out: 'public/data',
    force: false,
    keepCsv: false,
    urlTemplate: DEFAULT_URL_TEMPLATE,
    delayMs: 1500,
    log: (msg) => console.log(msg),
    curves: true,
    curvesFrom: tomorrow - (DEFAULT_CURVE_DAYS - 1),
    curvesTo: tomorrow,
    curvesRangeSet: false,
    curvesUrlTemplate: DEFAULT_CURVES_URL_TEMPLATE,
    fromDirs: [],
  };
}

export function parseArgs(argv: string[], base = defaultOptions()): FetchOptions {
  const o = { ...base };
  const date = (a: string, v: string) => {
    const day = parseDateString(v);
    if (day === null) throw new Error(`${a} には日付（例: 2025-04-01）を指定してください`);
    return day;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} の値がありません`);
      return v;
    };
    switch (a) {
      case '--from':
        o.from = Number(next());
        break;
      case '--to':
        o.to = Number(next());
        break;
      case '--out':
        o.out = next();
        break;
      case '--force':
        o.force = true;
        break;
      case '--keep-csv':
        o.keepCsv = true;
        break;
      case '--from-dir':
        o.fromDirs = [...o.fromDirs, next()];
        break;
      case '--url-template':
        o.urlTemplate = next();
        break;
      case '--delay':
        o.delayMs = Number(next());
        break;
      case '--curves-from':
        o.curvesFrom = date(a, next());
        o.curvesRangeSet = true;
        break;
      case '--curves-to':
        o.curvesTo = date(a, next());
        o.curvesRangeSet = true;
        break;
      case '--no-curves':
        o.curves = false;
        break;
      case '--curves-url-template':
        o.curvesUrlTemplate = next();
        break;
      case '-h':
      case '--help':
        console.log(HELP);
        process.exit(0);
        break;
      default:
        throw new Error(`不明なオプション: ${a}\n${HELP}`);
    }
  }
  if (!Number.isInteger(o.from) || !Number.isInteger(o.to) || o.from > o.to) throw new Error('--from / --to には年度（例: 2024）を指定してください');
  if (o.curvesFrom > o.curvesTo) throw new Error('--curves-from が --curves-to より後になっています');
  return o;
}

const HELP = `使い方: npm run fetch -- [オプション]
  --from <年度>          取引結果を取得する最初の年度（既定: ${FIRST_FY}）
  --to <年度>            取引結果を取得する最後の年度（既定: 今年度）
  --curves-from <日付>   入札カーブを取得する最初の受渡日（既定: 直近 ${DEFAULT_CURVE_DAYS} 日）
  --curves-to <日付>     入札カーブを取得する最後の受渡日（既定: 翌日）
  --no-curves            入札カーブを取得しない
  --out <ディレクトリ>   出力先（既定: public/data）
  --force                取得済みの年度・日も取り直す
  --keep-csv             元の CSV を <出力先>/raw/ に保存する
  --from-dir <ディレクトリ>  手元の CSV を変換する（通信しない。サブフォルダも含め、ファイル名は問わず中身で判定。複数指定できる）
  --url-template <URL>   取引結果の取得元 URL（{fy} が年度に置き換わる）
  --curves-url-template <URL>  入札カーブの取得元 URL（{dir}・{file} が置き換わる）
  --delay <ミリ秒>       連続取得の間隔（既定: 1500）`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ymd8 = (day: number) => isoFromDay(day).replace(/-/g, '');

/** 2 回目以降の取得の前に ms 待つ（取引結果と入札カーブで共通） */
function pacer(ms: number): () => Promise<void> {
  let first = true;
  return async () => {
    if (!first && ms > 0) await sleep(ms);
    first = false;
  };
}

function fyPath(out: string, fy: number): string {
  return path.join(out, 'spot', `fy${fy}.json`);
}

async function download(url: string, dispatcher: EnvHttpProxyAgent): Promise<Uint8Array | null> {
  const res = await fetch(url, {
    dispatcher,
    headers: {
      'User-Agent': 'jepx-viewer/0.1 (+https://github.com/yo-fork/JEPX-Viewer)',
      Referer: JEPX_SPOT_PAGE,
      Accept: 'text/csv,*/*',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function writeFyFile(out: string, fy: number, days: DayMap): Promise<FyFile> {
  const file = encodeFyFile(fy, days);
  await mkdir(path.dirname(fyPath(out, fy)), { recursive: true });
  await writeFile(fyPath(out, fy), JSON.stringify(file));
  return file;
}

/** 入札カーブの 1 日分を保存し、ファイルの大きさ（バイト）を返す */
/** システムプライスの入札カーブが 1 コマも無い CSV の案内（分断エリア連番の読み違いなど） */
const NO_SYSTEM_CURVE = 'システムプライスの入札カーブが 1 コマも無いため保存しません（分断エリア連番が空か -1 の行をシステムプライスとして読みます）';

/**
 * 入札カーブの 1 日分を保存し、ファイルの大きさ（バイト）と保存したコマ数を返す。
 * システムプライスのカーブが 1 コマも無ければ、中身の無いファイルは作らない（slots 0 を返す）
 */
async function writeCurveDayFile(out: string, raw: RawCurveDay, groups: AreaGroup[][] | undefined): Promise<{ bytes: number; slots: number }> {
  const file = encodeCurveDay(raw, groups);
  const slots = file.slots.filter(Boolean).length;
  if (slots === 0) return { bytes: 0, slots };
  const p = path.join(out, curveDayFile(raw.day));
  await mkdir(path.dirname(p), { recursive: true });
  const text = JSON.stringify(file);
  await writeFile(p, text);
  return { bytes: Buffer.byteLength(text), slots };
}

/**
 * 出力先の curves/ にある 1 日分のファイルから、指標の年度ファイルと一覧を作る。
 * 指標の年度ファイルは、その年度の日が変わったとき（touched か、入っている日が違うとき）だけ作り直す。
 */
export async function writeCurveIndex(out: string, touched: Set<number> = new Set()): Promise<CurveIndex | undefined> {
  const root = path.join(out, 'curves');
  if (!existsSync(root)) return undefined;
  const days: number[] = [];
  for (const y of (await readdir(root)).filter((d) => /^\d{4}$/.test(d))) {
    for (const f of await readdir(path.join(root, y))) {
      const m = /^(\d{8})\.json$/.exec(f);
      const day = m ? parseDateString(m[1]) : null;
      if (day !== null) days.push(day);
    }
  }
  if (days.length === 0) return undefined;
  days.sort((a, b) => a - b);
  const byFy = new Map<number, number[]>();
  for (const d of days) {
    const fy = fiscalYearOfDay(d);
    if (!byFy.has(fy)) byFy.set(fy, []);
    byFy.get(fy)!.push(d);
  }
  const metrics: ManifestEntry[] = [];
  for (const [fy, list] of byFy) {
    const file = curveMetricsFile(fy);
    const p = path.join(out, file);
    let fresh = !touched.has(fy) && existsSync(p);
    if (fresh) {
      try {
        const have = [...decodeCurveMetrics(JSON.parse(await readFile(p, 'utf8'))).keys()];
        fresh = have.length === list.length && have.every((d, i) => d === list[i]);
      } catch {
        fresh = false;
      }
    }
    if (!fresh) {
      const map: CurveMetricDays = new Map();
      for (const d of list) map.set(d, metricsOfDayFile(JSON.parse(await readFile(path.join(out, curveDayFile(d)), 'utf8')) as CurveDayFile));
      await writeFile(p, JSON.stringify(encodeCurveMetrics(fy, map)));
    }
    metrics.push({ fy, file, firstDate: isoFromDay(list[0]), lastDate: isoFromDay(list[list.length - 1]), days: list.length });
  }
  return { firstDate: isoFromDay(days[0]), lastDate: isoFromDay(days[days.length - 1]), dates: days.map(ymd8), metrics };
}

/** 出力先にある年度ファイル・入札カーブから manifest.json を作り直す */
export async function writeManifest(out: string, source: string, touchedCurveFys: Set<number> = new Set()): Promise<Manifest> {
  const dir = path.join(out, 'spot');
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => /^fy\d{4}\.json$/.test(f)).sort() : [];
  const entries: ManifestEntry[] = [];
  for (const f of files) {
    const json = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as FyFile;
    if (json.format !== FY_FILE_FORMAT) continue;
    const days = [...decodeFyFile(json).keys()].sort((a, b) => a - b);
    if (days.length === 0) continue;
    entries.push({ fy: json.fy, file: `spot/${f}`, firstDate: isoFromDay(days[0]), lastDate: isoFromDay(days[days.length - 1]), days: days.length });
  }
  const curves = await writeCurveIndex(out, touchedCurveFys);
  const manifest: Manifest = { format: MANIFEST_FORMAT, generatedAt: new Date().toISOString(), source, files: entries, ...(curves ? { curves } : {}) };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** ファイルの先頭の数 KB（列名の行を含む）を文字列にする（CSV の種類の判定用） */
async function readHead(file: string, size = 8192): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = new Uint8Array(size);
    const { bytesRead } = await fh.read(buf, 0, size, 0);
    let end = bytesRead;
    if (bytesRead === size) {
      // 途中で切れた文字で文字コードの判定を誤らないよう、最後の改行までにする（UTF-8・Shift_JIS とも 0x0A は文字の途中に現れない）
      const lf = buf.lastIndexOf(0x0a, bytesRead - 1);
      if (lf > 0) end = lf + 1;
    }
    return decodeCsvBytes(buf.subarray(0, end)).text;
  } finally {
    await fh.close();
  }
}

/**
 * 手元の CSV（--from-dir のフォルダ。サブフォルダも含む）を変換する。入札カーブを保存した年度を返す。
 * - 取引結果・入札カーブ・分断エリアのどれかは、ファイル名ではなく列名で見分ける（保存したときの名前やフォルダは問わない）
 * - 入札カーブと分断エリアは受渡日の列で突き合わせる。1 つの CSV に何日分入っていてもよい
 *   （同じ日が複数あれば後に読んだもの。フォルダは指定の順、フォルダの中は名前の順に読む）
 * - 分断エリアだけがある日は、変換済みの入札カーブがあれば名前を付け直す（別々に変換したとき）
 * - 入札カーブは --curves-from / --curves-to を指定したときだけ受渡日で絞る（既定はすべて）
 * - 読めない CSV は飛ばして最後にまとめて知らせ、1 件も変換できなければエラーにする
 */
async function convertDir(o: FetchOptions): Promise<Set<number>> {
  const files: { path: string; label: string }[] = [];
  for (const dir of o.fromDirs) {
    let names: string[];
    try {
      names = await readdir(dir, { recursive: true });
    } catch (err) {
      throw new Error(`${dir} を開けません（${(err as Error).message}）`);
    }
    for (const name of names.filter((f) => /\.csv$/i.test(f)).sort()) {
      files.push({ path: path.join(dir, name), label: o.fromDirs.length > 1 ? path.join(dir, name) : name });
    }
  }
  const where = o.fromDirs.join('、');
  if (files.length === 0) throw new Error(`${where} に CSV ファイルがありません`);
  const read = async (file: string) => decodeCsvBytes(await readFile(file)).text;
  const failed: string[] = [];
  const fail = (label: string, err: unknown) => {
    failed.push(label);
    o.log(`${label}: 読み込めませんでした（${(err as Error).message}）`);
  };
  const inRange = (day: number) => !o.curvesRangeSet || (day >= o.curvesFrom && day <= o.curvesTo);

  // 1 周目: 取引結果と分断エリアの名前を読み、入札カーブの CSV（大きいので 2 周目に 1 つずつ読む）を見つける
  const days: DayMap = new Map();
  const groups = new Map<number, AreaGroup[][]>();
  const curveFiles: typeof files = [];
  for (const f of files) {
    try {
      const kind = curveCsvKind(await readHead(f.path));
      if (kind === 'bidCurves') {
        curveFiles.push(f);
        continue;
      }
      const text = await read(f.path);
      if (kind === 'splittingAreas') {
        for (const [day, g] of parseSplittingAreasCsv(text)) groups.set(day, g);
      } else {
        const res = parseSpotCsv(text);
        for (const [day, vals] of res.days) days.set(day, vals);
        o.log(`${f.label}: ${isoFromDay(res.firstDay)}〜${isoFromDay(res.lastDay)}（${res.rowCount} コマ）${res.warnings.length ? ` ※${res.warnings.join(' / ')}` : ''}`);
      }
    } catch (err) {
      fail(f.label, err);
    }
  }
  for (const [fy, fyDays] of splitByFiscalYear(days)) {
    if (fy < o.from || fy > o.to) continue;
    await writeFyFile(o.out, fy, fyDays);
    o.log(`→ ${fyPath(o.out, fy)}（${fyDays.size} 日）`);
  }

  // 2 周目: 入札カーブ
  const touched = new Set<number>();
  const written = new Set<number>();
  let outside = 0;
  if (!o.curves && curveFiles.length > 0) o.log(`入札カーブの CSV ${curveFiles.length} 件は、--no-curves のため変換しません`);
  for (const f of o.curves ? curveFiles : []) {
    let parsed: Map<number, RawCurveDay>;
    try {
      parsed = parseBidCurveCsv(await read(f.path));
    } catch (err) {
      fail(f.label, err);
      continue;
    }
    for (const [day, raw] of parsed) {
      if (!inRange(day)) {
        outside++;
        continue;
      }
      const g = groups.get(day);
      const { bytes, slots } = await writeCurveDayFile(o.out, raw, g);
      if (slots === 0) {
        fail(f.label, new Error(`${isoFromDay(day)}: ${NO_SYSTEM_CURVE}`));
        continue;
      }
      touched.add(fiscalYearOfDay(day));
      written.add(day);
      o.log(`${f.label}: ${isoFromDay(day)} の入札カーブ ${slots} コマ（${Math.round(bytes / 1024)} KB）${g ? '' : '・分断エリアの名前なし'}`);
    }
  }

  // 分断エリアの名前だけがある日: 変換済みの入札カーブ（前に別に変換したもの）があれば、名前を付け直す
  let renamed = 0;
  let orphan = 0;
  for (const [day, g] of o.curves ? groups : new Map<number, AreaGroup[][]>()) {
    if (written.has(day) || !inRange(day)) continue;
    const file = path.join(o.out, curveDayFile(day));
    if (!existsSync(file)) {
      orphan++;
      continue;
    }
    const json = JSON.parse(await readFile(file, 'utf8')) as CurveDayFile;
    if (applyGroupNames(json, g)) {
      await writeFile(file, JSON.stringify(json));
      renamed++;
    }
  }
  if (renamed > 0) o.log(`分断エリアの名前を、変換済みの入札カーブ ${renamed} 日に付けました`);
  if (orphan > 0) o.log(`分断エリアの CSV だけがあり、入札カーブが無い日: ${orphan} 日（その日の入札カーブを変換すると名前が付きます）`);
  if (outside > 0) o.log(`入札カーブ: --curves-from / --curves-to の範囲外の ${outside} 日は変換しませんでした`);
  if (failed.length > 0) o.log(`読み込めなかった CSV: ${failed.length} 件（${failed.join(', ')}）`);
  if (days.size === 0 && touched.size === 0 && renamed === 0) throw new Error(`${where} に変換できる CSV がありません`);
  return touched;
}

async function fetchAll(o: FetchOptions, dispatcher: EnvHttpProxyAgent, pace: () => Promise<void>): Promise<void> {
  const currentFy = fiscalYearOfDay(todayJst());
  for (let fy = o.from; fy <= o.to; fy++) {
    // 前年度以前は確定済みとみなし、取得済みなら再取得しない（今年度・前年度は毎回更新）
    if (!o.force && fy < currentFy - 1 && existsSync(fyPath(o.out, fy))) {
      o.log(`${fy}年度: 取得済みのためスキップ`);
      continue;
    }
    await pace();
    const url = o.urlTemplate.replace(/\{fy\}/g, String(fy));
    let bytes: Uint8Array | null;
    try {
      bytes = await download(url, dispatcher);
    } catch (err) {
      o.log(`${fy}年度: 取得に失敗しました（${(err as Error).message}）`);
      continue;
    }
    if (!bytes || bytes.length === 0) {
      o.log(`${fy}年度: データがありません`);
      continue;
    }
    if (o.keepCsv) {
      await mkdir(path.join(o.out, 'raw'), { recursive: true });
      await writeFile(path.join(o.out, 'raw', `spot_summary_${fy}.csv`), bytes);
    }
    let days: DayMap;
    try {
      const { text } = decodeCsvBytes(bytes);
      const res = parseSpotCsv(text);
      for (const w of res.warnings) o.log(`${fy}年度: ${w}`);
      const byFy = splitByFiscalYear(res.days);
      days = byFy.get(fy) ?? new Map();
      const others = [...byFy.keys()].filter((k) => k !== fy);
      if (others.length > 0) o.log(`${fy}年度: 他の年度（${others.join(', ')}）の行は無視しました`);
    } catch (err) {
      o.log(`${fy}年度: CSV を解釈できませんでした（${(err as Error).message}）`);
      continue;
    }
    if (days.size === 0) {
      o.log(`${fy}年度: データがありません`);
      continue;
    }
    await writeFyFile(o.out, fy, days);
    const keys = [...days.keys()].sort((a, b) => a - b);
    o.log(`${fy}年度: ${isoFromDay(keys[0])}〜${isoFromDay(keys[keys.length - 1])}（${days.size} 日）を保存`);
  }
}

function curveUrl(o: FetchOptions, dir: string, day: number): string {
  return o.curvesUrlTemplate.replace(/\{dir\}/g, dir).replace(/\{file\}/g, `${dir}_${ymd8(day)}.csv`);
}

/** 受渡日ごとの入札カーブ（と分断エリアの名前）を取得する。保存した日の年度を返す */
async function fetchCurves(o: FetchOptions, dispatcher: EnvHttpProxyAgent, pace: () => Promise<void>): Promise<Set<number>> {
  const touched = new Set<number>();
  const total = o.curvesTo - o.curvesFrom + 1;
  let saved = 0;
  let skipped = 0;
  let missing = 0;
  for (let day = o.curvesFrom; day <= o.curvesTo; day++) {
    const label = `[${day - o.curvesFrom + 1}/${total}] 入札カーブ ${isoFromDay(day)}`;
    // 受渡日の入札カーブは約定後に変わらないので、取得済みの日は取り直さない
    if (!o.force && existsSync(path.join(o.out, curveDayFile(day)))) {
      skipped++;
      continue;
    }
    await pace();
    let raw: RawCurveDay | undefined;
    try {
      const bytes = await download(curveUrl(o, 'spot_bid_curves', day), dispatcher);
      if (bytes && bytes.length > 0) {
        if (o.keepCsv) {
          await mkdir(path.join(o.out, 'raw', 'curves'), { recursive: true });
          await writeFile(path.join(o.out, 'raw', 'curves', `spot_bid_curves_${ymd8(day)}.csv`), bytes);
        }
        raw = parseBidCurveCsv(decodeCsvBytes(bytes).text).get(day);
      }
    } catch (err) {
      o.log(`${label}: 取得できませんでした（${(err as Error).message}）`);
      continue;
    }
    if (!raw) {
      missing++;
      o.log(`${label}: データがありません`);
      continue;
    }
    // 分断エリアの名前（取れなくてもカーブは保存する）
    let groups: AreaGroup[][] | undefined;
    await pace();
    try {
      const bytes = await download(curveUrl(o, 'spot_splitting_areas', day), dispatcher);
      if (bytes && bytes.length > 0) {
        if (o.keepCsv) await writeFile(path.join(o.out, 'raw', 'curves', `spot_splitting_areas_${ymd8(day)}.csv`), bytes);
        groups = parseSplittingAreasCsv(decodeCsvBytes(bytes).text).get(day);
      }
    } catch (err) {
      o.log(`${label}: 分断エリアの名前を取得できませんでした（${(err as Error).message}）`);
    }
    const { bytes, slots } = await writeCurveDayFile(o.out, raw, groups);
    if (slots === 0) {
      missing++;
      o.log(`${label}: ${NO_SYSTEM_CURVE}`);
      continue;
    }
    touched.add(fiscalYearOfDay(day));
    saved++;
    o.log(`${label}: ${slots} コマを保存（${Math.round(bytes / 1024)} KB）`);
  }
  o.log(`入札カーブ: ${saved} 日を保存、取得済み ${skipped} 日、データなし ${missing} 日`);
  return touched;
}

export async function run(o: FetchOptions): Promise<Manifest> {
  let touched = new Set<number>();
  const local = o.fromDirs.length > 0;
  if (local) {
    touched = await convertDir(o);
  } else {
    const dispatcher = new EnvHttpProxyAgent();
    const pace = pacer(o.delayMs);
    try {
      await fetchAll(o, dispatcher, pace);
      if (o.curves) touched = await fetchCurves(o, dispatcher, pace);
    } finally {
      await dispatcher.close();
    }
  }
  const manifest = await writeManifest(o.out, local ? `local:${o.fromDirs.join(' | ')}` : JEPX_SPOT_PAGE, touched);
  const first = manifest.files[0];
  const last = manifest.files[manifest.files.length - 1];
  if (manifest.files.length > 0) {
    o.log(`manifest.json を更新しました: ${manifest.files.length} 年度（${first.firstDate}〜${last.lastDate}）`);
  } else if (manifest.curves) {
    // 画面は取引結果の期間で開くので、入札カーブだけでは表示できない
    o.log(`manifest.json を更新しました: 取引結果のデータがまだありません。入札カーブのタブを見るには、npm run fetch で取引結果も取得してください（出力先: ${o.out}）`);
  } else {
    o.log('データが 1 件もありません。ネットワーク接続や取得元 URL を確認してください。');
  }
  if (manifest.curves) o.log(`入札カーブ: ${manifest.curves.dates.length} 日（${manifest.curves.firstDate}〜${manifest.curves.lastDate}）`);
  return manifest;
}

// CLI として実行されたとき
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => run(parseArgs(process.argv.slice(2))))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
