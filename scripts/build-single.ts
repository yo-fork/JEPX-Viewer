/**
 * ダブルクリックで開ける 1 ファイル版（HTML 1 つ）を作る。共有フォルダや Teams で配れる。
 *
 *   npm run build:single                    取得済みデータ（public/data）の全年度を埋め込む
 *   npm run build:single -- --from 2021     2021 年度以降だけ埋め込む
 *   npm run build:single -- --no-data       データを埋め込まない（各自が JEPX の CSV を読み込む）
 *   npm run build:single -- --split         データを HTML に入れず、HTML と同じ場所の data フォルダに出力する（共有フォルダ向け）
 *   npm run build:single -- --artifact      Claude の Artifact に出すページを作る（--split ではデータを data/*.json として出す）
 *
 * 入札カーブ（npm run fetch で取得したもの）は、指標をすべてと、1 コマの図に使うカーブを直近 7 日分入れる
 * （1 日分が数百 KB あるため。--curve-days で変えられる）。--split では取得済みのカーブをすべて data フォルダに書き出す。
 * 連系線（広域機関の公表値）は、埋め込む年度の年度ファイルを入れる（--no-interties で入れない）。
 *
 * ファイルから直接開いたページでは、ブラウザは別ファイルのモジュールスクリプト・CSS を読み込まず、fetch も使えない。
 * そこで vite build の出力（dist/index.html と assets/ の JS・CSS）を 1 つの HTML にまとめ、
 * 年度ファイル・入札カーブのファイルは <script> の中に埋め込む（読み出しは src/lib/localData.ts）。
 * ファイルを小さくするため、manifest 以外は gzip で圧縮して base64 にする（--no-compress では JSON のまま）。
 * --split では埋め込まず、jepxViewerData(…) を呼ぶだけの data/*.js として HTML の隣に書き出す
 * （通常の <script src> なら、ファイルから開いたページでも同じフォルダから読み込める）。
 * CSP は埋め込んだスクリプト・スタイルのハッシュ（--split ではローカルのファイルも）だけを許可し、通信はすべて禁止する。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { CURVE_DAY_FORMAT, CURVE_METRICS_FORMAT, curveDayFile } from '../src/lib/bidCurves';
import { FY_FILE_FORMAT, MANIFEST_FORMAT, type CurveIndex, type IntertieIndex, type Manifest } from '../src/lib/dataFile';
import { fiscalYearOfDay, parseDateString } from '../src/lib/dates';
import { dataScriptPath, EMBED_ATTR, ENCODING_ATTR, GZIP_BASE64, LOCAL_MANIFEST, REGISTER_FN, SCRIPTS_META } from '../src/lib/localData';
import { INTERTIE_FY_FORMAT } from '../src/lib/occto';

/** 1 ファイル版に入れる、1 コマの図に使う入札カーブの日数（入札カーブのタブの「直近 7 日」の比較に足りる分） */
export const INLINE_CURVE_DAYS = 7;

export interface SingleOptions {
  /** vite build の出力先 */
  dist: string;
  /** 取得済みデータ（npm run fetch の出力先） */
  data: string;
  out: string;
  /** 埋め込む年度の範囲（省略時は取得済みの全年度） */
  from?: number;
  to?: number;
  noData: boolean;
  /** データを HTML に埋め込まず、出力先と同じ場所の data/ に書き出す */
  split: boolean;
  /** 1 コマの図に使う入札カーブを直近何日分入れるか（省略時は INLINE_CURVE_DAYS 日、--split は取得済みのすべて） */
  curveDays?: number;
  /** 入札カーブを入れない */
  noCurves: boolean;
  /** 連系線（広域機関の公表値）を入れない */
  noInterties: boolean;
  /** 埋め込むデータを gzip で圧縮する（--no-compress で JSON のまま） */
  compress: boolean;
  /** Claude の Artifact に出すページにする（--split ではデータを data/ に JSON のまま書き出し、fetch で読む） */
  artifact: boolean;
  log: (msg: string) => void;
}

/** --artifact で --out を指定しなかったときの出力先 */
export const ARTIFACT_OUT = 'dist-single/artifact/jepx-viewer.html';
/** Artifact に出せるページと、ページと一緒に出すファイル 1 つの大きさの上限（16 MB。少なめに見積もる） */
export const ARTIFACT_MAX_BYTES = 16_000_000;

export function defaultOptions(): SingleOptions {
  return {
    dist: 'dist',
    data: 'public/data',
    out: 'dist-single/jepx-viewer.html',
    noData: false,
    split: false,
    artifact: false,
    noCurves: false,
    noInterties: false,
    compress: true,
    log: (msg) => console.log(msg),
  };
}

const HELP = `使い方: npm run build:single -- [オプション]
  --from <年度>          埋め込む最初の年度（既定: 取得済みの全年度）
  --to <年度>            埋め込む最後の年度
  --no-data              データを埋め込まない（各自が JEPX の CSV を読み込んで使う）
  --split                データを HTML と同じ場所の data フォルダに分けて出力する（共有フォルダ向け）
  --curve-days <日数>    1 コマの図に使う入札カーブを直近何日分入れるか（既定: 7 日。--split では取得済みのすべて）
  --no-curves            入札カーブを入れない
  --no-interties         連系線（広域機関の公表値）を入れない
  --no-compress          データを圧縮せず、JSON のまま埋め込む（DecompressionStream に対応していない古いブラウザ向け）
  --artifact             Claude の Artifact に出すページにする（--split ではデータを data フォルダに JSON のまま出す）
  --out <ファイル>       出力先（既定: dist-single/jepx-viewer.html、--artifact では ${ARTIFACT_OUT}）
  --data <ディレクトリ>  取得済みデータの場所（既定: public/data）
  --dist <ディレクトリ>  vite build の出力先（既定: dist）`;

export function parseArgs(argv: string[], base = defaultOptions()): SingleOptions {
  const o = { ...base };
  let outGiven = false;
  const year = (a: string, v: string) => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${a} には年度（例: 2024）を指定してください`);
    return n;
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
        o.from = year(a, next());
        break;
      case '--to':
        o.to = year(a, next());
        break;
      case '--no-data':
        o.noData = true;
        break;
      case '--split':
        o.split = true;
        break;
      case '--curve-days': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) throw new Error('--curve-days には 1 以上の日数を指定してください');
        o.curveDays = n;
        break;
      }
      case '--no-curves':
        o.noCurves = true;
        break;
      case '--no-interties':
        o.noInterties = true;
        break;
      case '--no-compress':
        o.compress = false;
        break;
      case '--artifact':
        o.artifact = true;
        break;
      case '--out':
        o.out = next();
        outGiven = true;
        break;
      case '--data':
        o.data = next();
        break;
      case '--dist':
        o.dist = next();
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
  if (o.from !== undefined && o.to !== undefined && o.from > o.to) throw new Error('--from が --to より後になっています');
  if (o.split && o.noData) throw new Error('--split と --no-data は同時に指定できません');
  if (o.noCurves && o.curveDays !== undefined) throw new Error('--curve-days と --no-curves は同時に指定できません');
  if (o.artifact && !outGiven) o.out = ARTIFACT_OUT;
  return o;
}

export interface EmbeddedData {
  manifest: Manifest;
  /** データファイルの名前（public/data からの相対パス）→ JSON */
  files: Map<string, unknown>;
}

/**
 * インラインのスクリプトに置くと HTML の解析を狂わせる並び（</script・<!--）の < を \x3C にする。
 * 文字列・正規表現・コメントのどこに現れても JavaScript としての意味は変わらない。
 */
export function escapeInlineScript(js: string): string {
  return js.replace(/<(?=\/script|!--)/gi, '\\x3C');
}

/** CSP のハッシュ（ブラウザは要素の中身をそのままハッシュするので、改行は LF にそろえてから計算する） */
export function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * 1 ファイル版の CSP。スクリプトとスタイルシートは埋め込んだものだけ、通信・外部の読み込みはすべて禁止。
 * @param localScripts data/*.js（HTML と同じ場所のファイル）の読み込みも許可する（--split）。ネット上のスクリプトは不可のまま
 */
export function singleFileCsp(scriptHash: string, styleHash: string, localScripts = false): string {
  return [
    "default-src 'none'",
    // file: はファイルから開いたとき、'self' は Web サーバーに置いたときの data/*.js
    `script-src ${scriptHash}${localScripts ? " 'self' file:" : ''}`,
    // ECharts のツールチップやグラフの高さ指定が style 属性を使うので、属性は許可する。
    // <style> 要素は埋め込んだもの（ハッシュ）だけ（style-src-elem 非対応のブラウザは style-src に従う）
    "style-src 'unsafe-inline'",
    `style-src-elem ${styleHash}`,
    "style-src-attr 'unsafe-inline'",
    // favicon とロゴの SVG は data: URI で埋め込んでいる
    'img-src data:',
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const lf = (s: string) => s.replace(/\r\n?/g, '\n');

/**
 * データ用の script 要素。compress なら gzip で圧縮して base64 にする（base64 の文字には < が無いので、要素が途中で終わらない）。
 * JSON のままなら、中の < をエスケープし、</script> で要素が終わらないようにする
 */
function jsonBlock(file: string, value: unknown, compress = false): string {
  if (compress) {
    const gz = gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 9 });
    return `<script type="application/octet-stream" ${EMBED_ATTR}="${file}" ${ENCODING_ATTR}="${GZIP_BASE64}">${gz.toString('base64')}</script>\n`;
  }
  return `<script type="application/json" ${EMBED_ATTR}="${file}">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>\n`;
}

function checkName(name: string, pattern: RegExp, what: string): string {
  if (!pattern.test(name)) throw new Error(`${what}の名前が不正です: ${name}`);
  return name;
}

/**
 * manifest に載っているデータファイル（取引結果の年度ファイル、入札カーブの指標の年度ファイル・1 日分のファイル）を、
 * 名前と中身がそろっていることを確かめてから返す
 */
function dataFiles(data: EmbeddedData): [string, unknown][] {
  const { files, curves, interties } = data.manifest;
  const names = files.map((f) => checkName(f.file, /^spot\/fy\d{4}\.json$/, '年度ファイル'));
  if (interties) names.push(...interties.files.map((f) => checkName(f.file, /^interties\/fy\d{4}\.json$/, '連系線の年度ファイル')));
  if (curves) {
    names.push(...curves.metrics.map((m) => checkName(m.file, /^curves\/fy\d{4}\.json$/, '入札カーブの指標のファイル')));
    names.push(...curves.dates.map((d) => curveDayFile(parseDateString(checkName(d, /^\d{8}$/, '入札カーブの日付'))!)));
  }
  return names.map((file) => {
    if (!data.files.has(file)) throw new Error(`データファイルがありません: ${file}`);
    return [file, data.files.get(file)];
  });
}

/**
 * データ用の script 要素（データなしのときは manifest を null にして、1 ファイル版であることだけを示す）。
 * manifest は 1 ファイル版かどうかの判定にも使うので、圧縮しない
 */
export function embedBlocks(data: EmbeddedData | null, compress = false): string {
  if (!data) return jsonBlock(LOCAL_MANIFEST, null);
  return [jsonBlock(LOCAL_MANIFEST, data.manifest), ...dataFiles(data).map(([file, json]) => jsonBlock(file, json, compress))].join('');
}

/** data/*.js の中身（JSON は JavaScript の式としてそのまま書ける） */
export function dataScript(file: string, json: unknown): string {
  return `${REGISTER_FN}(${JSON.stringify(file)}, ${JSON.stringify(json)});\n`;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Artifact でページと一緒に出す data/*.json（public/data と同じ名前）を書き出し、合計バイト数を返す。
 * 一覧（manifest.json）は最後に書く。Artifact に出せない大きさのファイルがあれば、書く前にエラーにする
 */
async function writeDataJson(htmlDir: string, data: EmbeddedData): Promise<number> {
  const texts = [...dataFiles(data), [LOCAL_MANIFEST, data.manifest] as [string, unknown]].map(([file, json]) => [file, JSON.stringify(json)] as const);
  const big = texts.find(([, text]) => Buffer.byteLength(text) > ARTIFACT_MAX_BYTES);
  if (big) throw new Error(`${big[0]} が ${mb(Buffer.byteLength(big[1]))} あり、Artifact に出せる 1 ファイル 16 MB を超えています（--from で年度を絞ってください）`);
  let bytes = 0;
  for (const [file, text] of texts) {
    const out = path.join(htmlDir, 'data', file);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, text);
    bytes += Buffer.byteLength(text);
  }
  return bytes;
}

/** HTML と同じ場所に data/*.js を書き出し、合計バイト数を返す。一覧（manifest.js）はデータファイルをそろえてから最後に書く */
async function writeDataScripts(htmlDir: string, data: EmbeddedData): Promise<number> {
  let bytes = 0;
  for (const [file, json] of [...dataFiles(data), [LOCAL_MANIFEST, data.manifest] as [string, unknown]]) {
    const out = path.join(htmlDir, dataScriptPath(file));
    const text = dataScript(file, json);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, text);
    bytes += Buffer.byteLength(text);
  }
  return bytes;
}

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** vite build の index.html（公開用の CSP は外したもの）が読み込む JS・CSS を探し、埋め込める形で読む */
async function readBundle(base: string, readAsset: (rel: string) => Promise<string>) {
  if (/<link\b[^>]*\brel="modulepreload"/.test(base)) throw new Error('分割されたスクリプト（modulepreload）には対応していません');
  const scripts = [...base.matchAll(/<script\b([^>]*)><\/script>/g)];
  const sheets = [...base.matchAll(/<link\b([^>]*\brel="stylesheet"[^>]*)>/g)];
  if (scripts.length !== 1 || sheets.length !== 1) {
    throw new Error(`index.html のスクリプト・CSS の数が想定と異なります（script ${scripts.length} 個・CSS ${sheets.length} 個。各 1 個のみ対応）`);
  }
  const [script, sheet] = [scripts[0], sheets[0]];
  const src = attr(script[1], 'src');
  const href = attr(sheet[1], 'href');
  if (!src || attr(script[1], 'type') !== 'module' || !href) throw new Error('index.html のスクリプト・CSS の指定が想定と異なります');
  const js = escapeInlineScript(lf(await readAsset(src)));
  const css = lf(await readAsset(href));
  if (/<\/style/i.test(css)) throw new Error('CSS に </style が含まれているため埋め込めません');
  return { script, sheet, js, css };
}

/** 公開用の CSP を外した index.html（1 ファイル版の CSP に差し替えるか、Artifact では入れない） */
const withoutCsp = (indexHtml: string) => indexHtml.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, () => '');

/**
 * vite build の index.html に JS・CSS・データを埋め込み、CSP を 1 ファイル版のものに差し替える。
 * @param readAsset index.html からの相対パスで JS・CSS を読む
 * @param data 埋め込むデータ（null はデータなし）。'scripts' のときは埋め込まず、HTML と同じ場所の data/*.js から読む
 * @param compress 埋め込むデータを gzip で圧縮する
 */
export async function assembleHtml(
  indexHtml: string,
  readAsset: (rel: string) => Promise<string>,
  data: EmbeddedData | null | 'scripts',
  compress = false,
): Promise<string> {
  const split = data === 'scripts';
  const base = withoutCsp(indexHtml);
  const { script, sheet, js, css } = await readBundle(base, readAsset);
  const headEnd = base.indexOf('<head>') + '<head>'.length;
  const bodyEnd = base.lastIndexOf('</body>');
  if (headEnd < '<head>'.length || bodyEnd < 0) throw new Error('index.html に <head> または </body> が見つかりません');
  const csp = singleFileCsp(cspHash(js), cspHash(css), split);

  // 差し込む位置はすべて元の index.html で決め、後ろから差し込む。埋め込んだ JS・データの中身に
  // </body> などの文字列や置き換えで意味を持つ $& があっても、位置や内容がずれない。
  const edits = [
    {
      at: headEnd,
      end: headEnd,
      text: `\n    <meta http-equiv="Content-Security-Policy" content="${csp}">${split ? `\n    <meta name="${SCRIPTS_META}" content="data/">` : ''}`,
    },
    { at: script.index, end: script.index + script[0].length, text: `<script type="module">${js}</script>` },
    { at: sheet.index, end: sheet.index + sheet[0].length, text: `<style>${css}</style>` },
    { at: bodyEnd, end: bodyEnd, text: split ? '' : embedBlocks(data, compress) },
    // 同じ位置なら置き換えを先に、その前への差し込みを後にする
  ].sort((a, b) => b.at - a.at || b.end - a.end);
  let html = base;
  for (const e of edits) html = html.slice(0, e.at) + e.text + html.slice(e.end);
  return html;
}

/**
 * Claude の Artifact に出すページ。Artifact は公開するときに <!doctype html>・<head>・<body> で包むので、
 * 題名、CSS、アプリを置く要素、JS、データだけを並べる（題名はファイルの先頭 8 KB から探されるので最初に置く）。
 * CSP は Artifact の側で決まっているので入れない。アプリを置く要素の data-host で、Artifact の中だとアプリに伝える。
 * @param data 埋め込むデータ（null はデータなし）。'fetch' のときは埋め込まず、ページと一緒に出す data/*.json を fetch で読む
 */
export async function assembleArtifact(
  indexHtml: string,
  readAsset: (rel: string) => Promise<string>,
  data: EmbeddedData | null | 'fetch',
  compress = false,
): Promise<string> {
  const { js, css } = await readBundle(withoutCsp(indexHtml), readAsset);
  const title = /<title>([^<]*)<\/title>/.exec(indexHtml)?.[1];
  if (!title) throw new Error('index.html に <title> が見つかりません');
  return [
    `<title>${title}</title>`,
    `<style>${css}</style>`,
    // <html lang="ja"> は書けないので、日本語の字形で表示されるようアプリを置く要素に付ける
    '<div id="app" lang="ja" data-host="artifact"></div>',
    `<script type="module">${js}</script>`,
    data === 'fetch' ? '' : embedBlocks(data, compress),
  ].join('\n');
}

async function readJson(o: SingleOptions, file: string, format: string): Promise<unknown> {
  const json = JSON.parse(await readFile(path.join(o.data, file), 'utf8')) as { format?: string };
  if (json?.format !== format) throw new Error(`${file} の形式が不正です`);
  return json;
}

/**
 * 入れる入札カーブを選んで読む: 指標は対象の年度すべて、描画用のカーブは直近 curveDays 日分。
 * 一覧の firstDate・lastDate は指標のある期間、dates は入れたカーブの日
 */
async function loadCurves(o: SingleOptions, index: CurveIndex | undefined, files: Map<string, unknown>): Promise<CurveIndex | undefined> {
  if (o.noCurves || !index) return undefined;
  const inRange = (fy: number) => (o.from === undefined || fy >= o.from) && (o.to === undefined || fy <= o.to);
  const metrics = index.metrics.filter((m) => inRange(m.fy)).sort((a, b) => a.fy - b.fy);
  const all = index.dates
    .filter((d) => /^\d{8}$/.test(d))
    .map((d) => [d, parseDateString(d)] as const)
    .filter((x): x is readonly [string, number] => x[1] !== null && inRange(fiscalYearOfDay(x[1])))
    .sort((a, b) => a[1] - b[1]);
  if (metrics.length === 0 || all.length === 0) return undefined;
  const keep = o.curveDays ?? (o.split ? all.length : INLINE_CURVE_DAYS);
  const days = all.slice(Math.max(0, all.length - keep));
  for (const m of metrics) files.set(m.file, await readJson(o, m.file, CURVE_METRICS_FORMAT));
  for (const [, day] of days) files.set(curveDayFile(day), await readJson(o, curveDayFile(day), CURVE_DAY_FORMAT));
  return { firstDate: metrics[0].firstDate, lastDate: metrics[metrics.length - 1].lastDate, dates: days.map(([d]) => d), metrics };
}

/** 入れる連系線の年度ファイルを読む（埋め込む年度の範囲だけ） */
async function loadInterties(o: SingleOptions, index: IntertieIndex | undefined, files: Map<string, unknown>): Promise<IntertieIndex | undefined> {
  if (o.noInterties || !index) return undefined;
  const list = index.files.filter((f) => (o.from === undefined || f.fy >= o.from) && (o.to === undefined || f.fy <= o.to)).sort((a, b) => a.fy - b.fy);
  if (list.length === 0) return undefined;
  for (const f of list) files.set(f.file, await readJson(o, f.file, INTERTIE_FY_FORMAT));
  return { firstDate: list[0].firstDate, lastDate: list[list.length - 1].lastDate, files: list };
}

/** 取得済みデータから、埋め込む年度の manifest と年度ファイル・入札カーブ・連系線を読む */
async function loadData(o: SingleOptions): Promise<EmbeddedData> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(o.data, 'manifest.json'), 'utf8')) as Manifest;
  } catch {
    throw new Error(`${path.join(o.data, 'manifest.json')} がありません。先に npm run fetch でデータを取得してください（データなしで作るときは --no-data）`);
  }
  if (manifest.format !== MANIFEST_FORMAT || !Array.isArray(manifest.files)) throw new Error('manifest.json の形式が不正です');
  const entries = manifest.files.filter((f) => (o.from === undefined || f.fy >= o.from) && (o.to === undefined || f.fy <= o.to));
  if (entries.length === 0) throw new Error('埋め込む年度がありません（--from / --to と取得済みの年度を確認してください）');
  const files = new Map<string, unknown>();
  for (const f of entries) files.set(f.file, await readJson(o, f.file, FY_FILE_FORMAT));
  const curves = await loadCurves(o, manifest.curves, files);
  const interties = await loadInterties(o, manifest.interties, files);
  // 手元の CSV から作ったデータの取得元（local:フォルダのパス）には作った人の PC のフォルダ名が入るので、配るファイルには入れない
  const source = manifest.source?.startsWith('local:') ? 'local' : manifest.source;
  const { curves: _all, interties: _ties, ...rest } = manifest;
  return { manifest: { ...rest, source, files: entries, ...(curves ? { curves } : {}), ...(interties ? { interties } : {}) }, files };
}

export async function buildSingle(o: SingleOptions): Promise<{ bytes: number; dataBytes: number; data: EmbeddedData | null }> {
  const indexHtml = await readFile(path.join(o.dist, 'index.html'), 'utf8').catch(() => {
    throw new Error(`${path.join(o.dist, 'index.html')} がありません。先に npm run build を実行してください`);
  });
  const root = path.resolve(o.dist);
  const readAsset = (rel: string) => {
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) throw new Error(`dist の外のファイルは読み込めません: ${rel}`);
    return readFile(file, 'utf8');
  };
  const data = o.noData ? null : await loadData(o);
  const compress = o.compress && !o.split;
  const html = o.artifact
    ? await assembleArtifact(indexHtml, readAsset, o.split ? 'fetch' : data, compress)
    : await assembleHtml(indexHtml, readAsset, o.split ? 'scripts' : data, compress);
  const bytes = Buffer.byteLength(html);
  if (o.artifact && bytes > ARTIFACT_MAX_BYTES) {
    throw new Error(`Artifact に出せるページは 16 MB までですが、${mb(bytes)} になりました。--from で年度を絞るか、--split でデータを分けてください`);
  }
  const htmlDir = path.dirname(o.out);
  await mkdir(htmlDir, { recursive: true });
  // データのファイルを先に書く（HTML を開いたときにデータがそろっているように）
  const dataBytes = o.split && data ? await (o.artifact ? writeDataJson(htmlDir, data) : writeDataScripts(htmlDir, data)) : 0;
  await writeFile(o.out, html);
  const files = data?.manifest.files ?? [];
  const range = files.length
    ? `${files[0].fy}〜${files[files.length - 1].fy} 年度（${files[0].firstDate}〜${files[files.length - 1].lastDate}）`
    : 'データなし';
  const curves = data?.manifest.curves;
  const ties = data?.manifest.interties;
  const curveText =
    (curves
      ? `・入札カーブ ${curves.dates.length} 日分（${curves.dates[0].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')}〜、指標は ${curves.firstDate}〜${curves.lastDate}）`
      : '') + (ties ? `・連系線 ${ties.firstDate}〜${ties.lastDate}` : '');
  // 圧縮したときは、圧縮しなければどれだけになったかも示す
  const uncompressed = () => (o.artifact ? assembleArtifact(indexHtml, readAsset, data) : assembleHtml(indexHtml, readAsset, data));
  const plain = compress && data ? Buffer.byteLength(await uncompressed()) : 0;
  const what = o.artifact ? 'Artifact に出すページを' : o.split ? '' : '1 ファイル版を';
  const where = !o.split ? '' : o.artifact ? '。data フォルダの中身は、ページと一緒に data/ として出してください' : '。2 つは同じ場所に置いてください';
  o.log(
    o.split
      ? `${what}作成しました: ${o.out}（${mb(bytes)}）と ${path.join(htmlDir, 'data')}（${mb(dataBytes)}、${range}${curveText}）${where}`
      : `${what}作成しました: ${o.out}（${mb(bytes)}${plain ? `。データは圧縮して埋め込み、圧縮しなければ ${mb(plain)}` : ''}、${range}${curveText}）`,
  );
  return { bytes, dataBytes, data };
}

// CLI として実行されたとき
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => buildSingle(parseArgs(process.argv.slice(2))))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
