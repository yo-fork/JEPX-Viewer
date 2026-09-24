/**
 * JEPX「スポット市場 取引結果」の年度別 CSV を取得し、ビューア用のデータ（public/data）に変換する。
 *
 *   npm run fetch                        2005 年度〜今年度を取得（取得済みの古い年度はスキップ）
 *   npm run fetch -- --from 2016         2016 年度以降だけ
 *   npm run fetch -- --force             取得済みの年度も取り直す
 *   npm run fetch -- --keep-csv          元の CSV も public/data/raw/ に保存する
 *   npm run fetch -- --from-dir ./csv    手元の CSV（ブラウザでダウンロードしたもの）を変換する（通信なし）
 *
 * 社内プロキシ環境では HTTPS_PROXY / HTTP_PROXY / NO_PROXY 環境変数がそのまま使われる。
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EnvHttpProxyAgent, fetch } from 'undici';
import { decodeFyFile, encodeFyFile, FY_FILE_FORMAT, MANIFEST_FORMAT, splitByFiscalYear, type FyFile, type Manifest, type ManifestEntry } from '../src/lib/dataFile';
import { fiscalYearOfDay, isoFromDay, todayJst } from '../src/lib/dates';
import { decodeCsvBytes } from '../src/lib/encoding';
import { parseSpotCsv, type DayMap } from '../src/lib/jepxCsv';

export const JEPX_SPOT_PAGE = 'https://www.jepx.jp/electricpower/market-data/spot/';
export const DEFAULT_URL_TEMPLATE = 'https://www.jepx.jp/js/csv_read.php?dir=spot_summary&file=spot_summary_{fy}.csv';
/** JEPX のスポット市場は 2005 年 4 月に開始 */
export const FIRST_FY = 2005;

export interface FetchOptions {
  from: number;
  to: number;
  out: string;
  force: boolean;
  keepCsv: boolean;
  fromDir?: string;
  urlTemplate: string;
  delayMs: number;
  log: (msg: string) => void;
}

export function defaultOptions(): FetchOptions {
  return {
    from: FIRST_FY,
    // 3/31 には翌日（翌年度 4/1）受渡分の約定結果が出ているので、翌日を基準にする
    to: fiscalYearOfDay(todayJst() + 1),
    out: 'public/data',
    force: false,
    keepCsv: false,
    urlTemplate: DEFAULT_URL_TEMPLATE,
    delayMs: 1500,
    log: (msg) => console.log(msg),
  };
}

export function parseArgs(argv: string[], base = defaultOptions()): FetchOptions {
  const o = { ...base };
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
        o.fromDir = next();
        break;
      case '--url-template':
        o.urlTemplate = next();
        break;
      case '--delay':
        o.delayMs = Number(next());
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
  return o;
}

const HELP = `使い方: npm run fetch -- [オプション]
  --from <年度>          取得を始める年度（既定: ${FIRST_FY}）
  --to <年度>            取得する最後の年度（既定: 今年度）
  --out <ディレクトリ>   出力先（既定: public/data）
  --force                取得済みの年度も取り直す
  --keep-csv             元の CSV を <出力先>/raw/ に保存する
  --from-dir <ディレクトリ>  ダウンロード済みの CSV を変換する（通信しない）
  --url-template <URL>   取得元 URL（{fy} が年度に置き換わる）
  --delay <ミリ秒>       連続取得の間隔（既定: 1500）`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** 出力先にある年度ファイルから manifest.json を作り直す */
export async function writeManifest(out: string, source: string): Promise<Manifest> {
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
  const manifest: Manifest = { format: MANIFEST_FORMAT, generatedAt: new Date().toISOString(), source, files: entries };
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

/** ダウンロード済みの CSV を変換する */
async function convertDir(o: FetchOptions): Promise<void> {
  const dir = o.fromDir!;
  const names = (await readdir(dir)).filter((f) => /\.csv$/i.test(f)).sort();
  if (names.length === 0) throw new Error(`${dir} に CSV ファイルがありません`);
  const all: DayMap = new Map();
  for (const name of names) {
    const { text } = decodeCsvBytes(await readFile(path.join(dir, name)));
    const res = parseSpotCsv(text);
    for (const [day, vals] of res.days) all.set(day, vals);
    o.log(`${name}: ${isoFromDay(res.firstDay)}〜${isoFromDay(res.lastDay)}（${res.rowCount} コマ）${res.warnings.length ? ` ※${res.warnings.join(' / ')}` : ''}`);
  }
  for (const [fy, days] of splitByFiscalYear(all)) {
    if (fy < o.from || fy > o.to) continue;
    await writeFyFile(o.out, fy, days);
    o.log(`→ ${fyPath(o.out, fy)}（${days.size} 日）`);
  }
}

async function fetchAll(o: FetchOptions): Promise<void> {
  const dispatcher = new EnvHttpProxyAgent();
  const currentFy = fiscalYearOfDay(todayJst());
  let first = true;
  try {
    for (let fy = o.from; fy <= o.to; fy++) {
      // 前年度以前は確定済みとみなし、取得済みなら再取得しない（今年度・前年度は毎回更新）
      if (!o.force && fy < currentFy - 1 && existsSync(fyPath(o.out, fy))) {
        o.log(`${fy}年度: 取得済みのためスキップ`);
        continue;
      }
      if (!first && o.delayMs > 0) await sleep(o.delayMs);
      first = false;
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
  } finally {
    await dispatcher.close();
  }
}

export async function run(o: FetchOptions): Promise<Manifest> {
  if (o.fromDir) await convertDir(o);
  else await fetchAll(o);
  const manifest = await writeManifest(o.out, o.fromDir ? `local:${o.fromDir}` : JEPX_SPOT_PAGE);
  const first = manifest.files[0];
  const last = manifest.files[manifest.files.length - 1];
  o.log(
    manifest.files.length
      ? `manifest.json を更新しました: ${manifest.files.length} 年度（${first.firstDate}〜${last.lastDate}）`
      : 'データが 1 件もありません。ネットワーク接続や取得元 URL を確認してください。',
  );
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
