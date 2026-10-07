import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ARTIFACT_OUT,
  assembleArtifact,
  assembleHtml,
  buildSingle,
  dataScript,
  defaultOptions,
  escapeInlineScript,
  INLINE_CURVE_DAYS,
  parseArgs,
  type EmbeddedData,
} from '../scripts/build-single';
import { writeManifest } from '../scripts/fetch-jepx';
import { curveDayFile, decodeCurveDay, decodeCurveMetrics, encodeCurveDay } from '../src/lib/bidCurves';
import { decodeFyFile, encodeFyFile, MANIFEST_FORMAT, type Manifest } from '../src/lib/dataFile';
import { dayFromYmd, isoFromDay } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay } from '../src/lib/demoCurves';
import { encodeIntertieFy, INTERTIE_FIELD_INDEX, INTERTIE_INDEX, intertieOffset, newIntertieDay } from '../src/lib/occto';
import { SLOTS } from '../src/lib/series';
import { dataScriptPath, isDataFile, loadDataScript, localDataMode, readEmbedded, REGISTER_FN } from '../src/lib/localData';

/** vite build が出力する index.html と同じ形 */
const INDEX_HTML = `<!doctype html>
<html lang="ja">
  <head>
    <meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; script-src &#39;self&#39;">

    <meta charset="utf-8" />
    <link
      rel="icon"
      href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3C/svg%3E"
    />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`;
/** 題名のある index.html（実際の index.html と同じく、題名を head に書く） */
const TITLED_HTML = INDEX_HTML.replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n    <title>JEPX Viewer</title>');
/** 置き換えで意味を持つ $& などや、HTML を狂わせる並び、CRLF をわざと含める */
const JS = 'const s = "</script><!--";\r\nconst r = "$&$1$$";\r\nconsole.log(s, r);\r\n';
const CSS = 'body{color:red}\r\n.a::before{content:"<"}\r\n';
const assets: Record<string, string> = { './assets/index-abc.js': JS, './assets/index-abc.css': CSS };
const readAsset = async (rel: string) => {
  if (!(rel in assets)) throw new Error(`no asset ${rel}`);
  return assets[rel];
};

const inlineScript = (html: string) => /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
const inlineStyle = (html: string) => /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
const cspOf = (html: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1] ?? '';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');
/** 埋め込んだデータ（圧縮したものは戻す） */
const blocks = (html: string) =>
  [...html.matchAll(/<script type="application\/(?:json|octet-stream)" data-jv-file="([^"]+)"(?: data-jv-encoding="([^"]+)")?>([\s\S]*?)<\/script>/g)].map((m) => ({
    file: m[1],
    compressed: m[2] === 'gzip-base64',
    json: JSON.parse(m[2] === 'gzip-base64' ? gunzipSync(Buffer.from(m[3], 'base64')).toString('utf8') : m[3]) as unknown,
  }));

const MANIFEST: Manifest = {
  format: MANIFEST_FORMAT,
  generatedAt: '2026-09-24T00:00:00.000Z',
  // 文字列中の </script> で要素が終わらないことを確かめる
  source: 'local:</script><script>alert(1)</script>',
  files: [
    { fy: 2023, file: 'spot/fy2023.json', firstDate: '2023-04-01', lastDate: '2023-04-02', days: 2 },
    { fy: 2024, file: 'spot/fy2024.json', firstDate: '2024-04-01', lastDate: '2024-04-02', days: 2 },
  ],
};
const DATA: EmbeddedData = {
  manifest: MANIFEST,
  files: new Map([
    ['spot/fy2023.json', { format: 'jepx-viewer/spot-fy@1', fy: 2023, note: '</script>' }],
    ['spot/fy2024.json', { format: 'jepx-viewer/spot-fy@1', fy: 2024 }],
  ]),
};

describe('escapeInlineScript', () => {
  it('HTML を狂わせる並びだけをエスケープし、JavaScript としての意味は変えない', () => {
    expect(escapeInlineScript('a</script>b<!--c</SCRIPT d<b>')).toBe('a\\x3C/script>b\\x3C!--c\\x3C/SCRIPT d<b>');
    const src = 'return ["</script>", `<!--`, /<\\/script/u.test("</script>"), /<!--/.test("<!--")]';
    expect(Function(escapeInlineScript(src))()).toEqual(Function(src)());
  });
});

describe('assembleHtml', () => {
  it('JS・CSS を埋め込み、CSP を中身のハッシュだけを許すものに差し替える', async () => {
    const html = await assembleHtml(INDEX_HTML, readAsset, DATA);
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
    expect(html).not.toMatch(/rel="stylesheet"/);
    expect(html).not.toContain('&#39;self&#39;');
    expect(html).toContain('rel="icon"');

    const js = inlineScript(html)!;
    const css = inlineStyle(html)!;
    // 改行は LF にそろい、$& などはそのまま、</script と <!-- はエスケープされる
    expect(js).toBe('const s = "\\x3C/script>\\x3C!--";\nconst r = "$&$1$$";\nconsole.log(s, r);\n');
    expect(css).toBe('body{color:red}\n.a::before{content:"<"}\n');

    const csp = cspOf(html);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'sha256-${sha(js)}'`);
    expect(csp).toContain(`style-src-elem 'sha256-${sha(css)}'`);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).not.toContain("'self'");
    expect(csp).not.toContain('unsafe-eval');
    // CSP はスクリプト・スタイルより前（head の先頭）
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<meta charset'));
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style>'));
  });

  it('データを JSON のまま埋め込み、文字列中の </script> で要素が終わらない', async () => {
    const html = await assembleHtml(INDEX_HTML, readAsset, DATA);
    expect(html).not.toContain('<script>alert(1)');
    const got = blocks(html);
    expect(got.map((b) => b.file)).toEqual(['manifest.json', 'spot/fy2023.json', 'spot/fy2024.json']);
    expect(got[0].json).toEqual(MANIFEST);
    expect(got[1].json).toEqual(DATA.files.get('spot/fy2023.json'));
    // 閉じタグは script 要素の数（モジュール 1 + データ 3）だけ
    expect(html.match(/<\/script>/g)).toHaveLength(4);
  });

  it('compress では、manifest 以外のデータを gzip で圧縮して base64 で埋め込む', async () => {
    const html = await assembleHtml(INDEX_HTML, readAsset, DATA, true);
    expect(html).not.toContain('<script>alert(1)');
    const got = blocks(html);
    expect(got.map((b) => [b.file, b.compressed])).toEqual([
      ['manifest.json', false],
      ['spot/fy2023.json', true],
      ['spot/fy2024.json', true],
    ]);
    expect(got[0].json).toEqual(MANIFEST);
    expect(got[1].json).toEqual(DATA.files.get('spot/fy2023.json'));
    expect(html.match(/<\/script>/g)).toHaveLength(4);
    // CSP は変わらない（データ用の要素は実行されない）
    expect(cspOf(html)).toBe(cspOf(await assembleHtml(INDEX_HTML, readAsset, DATA)));
  });

  it('JS の中に </body> やタグと同じ文字列があっても、差し込む位置と中身がずれない', async () => {
    const tricky = [
      'const a = "</body></html>";',
      'const b = "<head>";',
      'const c = \'<link rel="stylesheet" crossorigin href="./assets/index-abc.css">\';',
      'const d = \'<meta http-equiv="Content-Security-Policy" content="x">\';',
      '',
    ].join('\n');
    const read = async (rel: string) => (rel.endsWith('.js') ? tricky : CSS);
    const html = await assembleHtml(INDEX_HTML, read, DATA);
    expect(inlineScript(html)).toBe(tricky);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html.match(/<meta http-equiv="Content-Security-Policy" content="default-src/g)).toHaveLength(1);
    // データは本物の </body> の直前（スクリプトより後ろ）にある
    const body = html.lastIndexOf('</body>');
    expect(html.indexOf('data-jv-file="manifest.json"')).toBeGreaterThan(html.indexOf('<script type="module">'));
    expect(html.slice(0, body).trimEnd().endsWith('</script>')).toBe(true);
    expect(blocks(html).map((b) => b.file)).toEqual(['manifest.json', 'spot/fy2023.json', 'spot/fy2024.json']);
  });

  it('--split（scripts）ではデータを埋め込まず、data/*.js だけを追加で許可する', async () => {
    const html = await assembleHtml(INDEX_HTML, readAsset, 'scripts');
    expect(blocks(html)).toEqual([]);
    expect(html).toContain('<meta name="jepx-viewer-data" content="data/">');
    const csp = cspOf(html);
    expect(csp).toContain(`script-src 'sha256-${sha(inlineScript(html)!)}' 'self' file:`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('strict-dynamic');
    // 目印は CSP の後ろ（head の中）
    expect(html.indexOf('jepx-viewer-data')).toBeGreaterThan(html.indexOf('Content-Security-Policy'));
    expect(html.indexOf('jepx-viewer-data')).toBeLessThan(html.indexOf('</head>'));
  });

  it('データなしでは manifest を null にする', async () => {
    const html = await assembleHtml(INDEX_HTML, readAsset, null);
    expect(blocks(html)).toEqual([{ file: 'manifest.json', compressed: false, json: null }]);
  });

  it('Artifact では <html>・<head>・<body> と CSP を書かず、題名を先頭に置き、Artifact の中だと示す', async () => {
    const html = await assembleArtifact(TITLED_HTML, readAsset, null);
    expect(html.startsWith('<title>JEPX Viewer</title>\n<style>')).toBe(true);
    expect(html).not.toMatch(/<!doctype|<html|<head|<body|<\/body>|<meta/i);
    expect(html).toContain('<div id="app" lang="ja" data-host="artifact"></div>');
    expect(inlineScript(html)).toBe(escapeInlineScript(JS.replace(/\r\n/g, '\n')));
    expect(inlineStyle(html)).toBe(CSS.replace(/\r\n/g, '\n'));
    // データなしでも manifest（null）を埋め込み、データを探しに行かない
    expect(blocks(html)).toEqual([{ file: 'manifest.json', compressed: false, json: null }]);
    expect(blocks(await assembleArtifact(TITLED_HTML, readAsset, DATA, true)).map((b) => [b.file, b.compressed])).toEqual([
      ['manifest.json', false],
      ['spot/fy2023.json', true],
      ['spot/fy2024.json', true],
    ]);
    // ページと一緒に出す data/*.json を fetch で読むときは、何も埋め込まない
    expect(blocks(await assembleArtifact(TITLED_HTML, readAsset, 'fetch'))).toEqual([]);
    await expect(assembleArtifact(INDEX_HTML, readAsset, null)).rejects.toThrow(/<title>/);
  });

  it('想定外の index.html は埋め込まずにエラーにする', async () => {
    const twoScripts = INDEX_HTML.replace('</head>', '<script type="module" src="./assets/b.js"></script></head>');
    await expect(assembleHtml(twoScripts, readAsset, null)).rejects.toThrow(/script 2 個/);
    const preload = INDEX_HTML.replace('</head>', '<link rel="modulepreload" href="./assets/c.js"></head>');
    await expect(assembleHtml(preload, readAsset, null)).rejects.toThrow(/modulepreload/);
    const badCss = async (rel: string) => (rel.endsWith('.css') ? 'a{}</style><script>x</script>' : JS);
    await expect(assembleHtml(INDEX_HTML, badCss, null)).rejects.toThrow(/<\/style/);
    const badName: EmbeddedData = { ...DATA, manifest: { ...MANIFEST, files: [{ ...MANIFEST.files[0], file: '../x"y.json' }] } };
    await expect(assembleHtml(INDEX_HTML, readAsset, badName)).rejects.toThrow(/名前が不正/);
  });
});

describe('parseArgs', () => {
  it('オプションを読み、不正な値はエラーにする', () => {
    const o = parseArgs(['--from', '2021', '--to', '2023', '--no-data', '--out', 'x.html', '--data', 'd', '--dist', 'b']);
    expect(o).toMatchObject({ from: 2021, to: 2023, noData: true, out: 'x.html', data: 'd', dist: 'b' });
    const d = parseArgs([]);
    expect(d).toMatchObject({ noData: false, out: defaultOptions().out, data: 'public/data', dist: 'dist' });
    expect(d.from).toBeUndefined();
    expect(d.to).toBeUndefined();
    expect(() => parseArgs(['--from', 'abc'])).toThrow(/年度/);
    expect(() => parseArgs(['--from', '2024', '--to', '2023'])).toThrow(/--from/);
    expect(() => parseArgs(['--bogus'])).toThrow(/不明なオプション/);
    expect(() => parseArgs(['--out'])).toThrow(/値がありません/);
    expect(parseArgs(['--split']).split).toBe(true);
    expect(d.split).toBe(false);
    expect(() => parseArgs(['--split', '--no-data'])).toThrow(/同時に指定できません/);
    expect(parseArgs(['--curve-days', '14']).curveDays).toBe(14);
    expect(d.curveDays).toBeUndefined();
    expect(parseArgs(['--no-curves']).noCurves).toBe(true);
    expect(() => parseArgs(['--curve-days', '0'])).toThrow(/1 以上/);
    expect(() => parseArgs(['--curve-days', 'x'])).toThrow(/1 以上/);
    expect(() => parseArgs(['--curve-days', '3', '--no-curves'])).toThrow(/同時に指定できません/);
    // --artifact は、出力先を指定しなければ Artifact 用の場所に出す
    expect(parseArgs(['--artifact'])).toMatchObject({ artifact: true, out: ARTIFACT_OUT });
    expect(parseArgs(['--out', 'y.html', '--artifact']).out).toBe('y.html');
    expect(d.artifact).toBe(false);
  });
});

describe('buildSingle', () => {
  let dir = '';
  const days2024 = generateDemoDays(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 3), 2);
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jepx-single-'));
    await mkdir(path.join(dir, 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'dist', 'index.html'), INDEX_HTML);
    await writeFile(path.join(dir, 'dist', 'assets', 'index-abc.js'), JS);
    await writeFile(path.join(dir, 'dist', 'assets', 'index-abc.css'), CSS);
    await mkdir(path.join(dir, 'data', 'spot'), { recursive: true });
    const days2023 = generateDemoDays(dayFromYmd(2023, 4, 1), dayFromYmd(2023, 4, 3), 1);
    await writeFile(path.join(dir, 'data', 'spot', 'fy2023.json'), JSON.stringify(encodeFyFile(2023, days2023)));
    await writeFile(path.join(dir, 'data', 'spot', 'fy2024.json'), JSON.stringify(encodeFyFile(2024, days2024)));
    await writeManifest(path.join(dir, 'data'), 'local:/home/someone/Downloads/csv');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const opts = (extra: Partial<ReturnType<typeof defaultOptions>>) => ({
    ...defaultOptions(),
    dist: path.join(dir, 'dist'),
    data: path.join(dir, 'data'),
    out: path.join(dir, 'out', 'single.html'),
    log: () => {},
    ...extra,
  });

  it('指定した年度だけを埋め込み、元のデータに戻せる', async () => {
    await buildSingle(opts({ from: 2024 }));
    const html = await readFile(path.join(dir, 'out', 'single.html'), 'utf8');
    const got = blocks(html);
    expect(got.map((b) => b.file)).toEqual(['manifest.json', 'spot/fy2024.json']);
    expect((got[0].json as Manifest).files.map((f) => f.fy)).toEqual([2024]);
    // 作った人の PC のフォルダ名は配るファイルに入れない
    expect((got[0].json as Manifest).source).toBe('local');
    expect(html).not.toContain('/home/someone');
    const decoded = decodeFyFile(got[1].json);
    expect([...decoded.keys()]).toEqual([...days2024.keys()]);
    expect([...decoded.get(dayFromYmd(2024, 4, 2))!]).toEqual([...days2024.get(dayFromYmd(2024, 4, 2))!]);
  });

  it('--split では HTML の隣に data/*.js を書き、それぞれが jepxViewerData(名前, JSON) を呼ぶ', async () => {
    const out = path.join(dir, 'share', 'viewer.html');
    const { bytes, dataBytes } = await buildSingle(opts({ split: true, out }));
    const html = await readFile(out, 'utf8');
    expect(blocks(html)).toEqual([]);
    expect(html).toContain('name="jepx-viewer-data"');
    expect(dataBytes).toBeGreaterThan(0);
    expect(bytes).toBe(Buffer.byteLength(html));
    const calls: [string, unknown][] = [];
    const run = async (rel: string) => {
      const src = await readFile(path.join(dir, 'share', rel), 'utf8');
      Function(REGISTER_FN, src)((name: string, json: unknown) => calls.push([name, json]));
    };
    await run('data/manifest.js');
    await run('data/spot/fy2023.js');
    await run('data/spot/fy2024.js');
    expect(calls.map((c) => c[0])).toEqual(['manifest.json', 'spot/fy2023.json', 'spot/fy2024.json']);
    expect((calls[0][1] as Manifest).files.map((f) => f.file)).toEqual(['spot/fy2023.json', 'spot/fy2024.json']);
    expect([...decodeFyFile(calls[2][1]).keys()]).toEqual([...days2024.keys()]);
  });

  it('--artifact --split では、ページと一緒に出す data/*.json を取得済みデータと同じ名前と中身で書く', async () => {
    const dist = path.join(dir, 'dist-titled');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, 'index.html'), TITLED_HTML);
    await writeFile(path.join(dist, 'assets', 'index-abc.js'), JS);
    await writeFile(path.join(dist, 'assets', 'index-abc.css'), CSS);
    const out = path.join(dir, 'artifact', 'page.html');
    const { dataBytes } = await buildSingle(opts({ artifact: true, split: true, dist, out }));
    const html = await readFile(out, 'utf8');
    expect(html.startsWith('<title>')).toBe(true);
    expect(blocks(html)).toEqual([]);
    const read = async (file: string) => JSON.parse(await readFile(path.join(dir, 'artifact', 'data', file), 'utf8')) as unknown;
    const manifest = (await read('manifest.json')) as Manifest;
    expect(manifest.files.map((f) => f.file)).toEqual(['spot/fy2023.json', 'spot/fy2024.json']);
    expect(manifest.source).toBe('local');
    expect([...decodeFyFile(await read('spot/fy2024.json')).keys()]).toEqual([...days2024.keys()]);
    expect(await read('spot/fy2023.json')).toEqual(JSON.parse(await readFile(path.join(dir, 'data', 'spot', 'fy2023.json'), 'utf8')));
    expect(dataBytes).toBeGreaterThan(0);
  });

  it('--no-data ではデータを読まない。データが無ければ取得方法を案内する', async () => {
    const { data } = await buildSingle(opts({ noData: true, data: path.join(dir, 'none') }));
    expect(data).toBeNull();
    await expect(buildSingle(opts({ data: path.join(dir, 'none') }))).rejects.toThrow(/npm run fetch/);
    await expect(buildSingle(opts({ from: 2030 }))).rejects.toThrow(/埋め込む年度がありません/);
    await expect(buildSingle(opts({ dist: path.join(dir, 'none') }))).rejects.toThrow(/npm run build/);
  });
});

describe('buildSingle（入札カーブ）', () => {
  let dir = '';
  // 2024/03/25〜04/03 の 10 日分（2023 年度と 2024 年度にまたがる）
  const curveDays = Array.from({ length: 10 }, (_, i) => dayFromYmd(2024, 3, 25) + i);
  const ymd = (day: number) => isoFromDay(day).replace(/-/g, '');
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jepx-single-curves-'));
    await mkdir(path.join(dir, 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(dir, 'dist', 'index.html'), INDEX_HTML);
    await writeFile(path.join(dir, 'dist', 'assets', 'index-abc.js'), JS);
    await writeFile(path.join(dir, 'dist', 'assets', 'index-abc.css'), CSS);
    const data = path.join(dir, 'data');
    await mkdir(path.join(data, 'spot'), { recursive: true });
    await writeFile(path.join(data, 'spot', 'fy2023.json'), JSON.stringify(encodeFyFile(2023, generateDemoDays(dayFromYmd(2024, 3, 25), dayFromYmd(2024, 3, 31), 1))));
    await writeFile(path.join(data, 'spot', 'fy2024.json'), JSON.stringify(encodeFyFile(2024, generateDemoDays(dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 3), 2))));
    for (const day of curveDays) {
      const targets = Array.from({ length: SLOTS }, (_, s) => ({ system: 10 + (s % 5), volume: 30000, east: 10, west: s % 2 ? 11 : 10 }));
      const { raw, groups } = syntheticCurveDay(day, targets);
      const file = path.join(data, curveDayFile(day));
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(encodeCurveDay(raw, groups)));
    }
    // 連系線（2023 年度と 2024 年度）
    await mkdir(path.join(data, 'interties'), { recursive: true });
    for (const [fy, days] of [
      [2023, [dayFromYmd(2024, 3, 31)]],
      [2024, [dayFromYmd(2024, 4, 1), dayFromYmd(2024, 4, 2)]],
    ] as const) {
      const map = new Map(
        days.map((d) => {
          const v = newIntertieDay();
          v[intertieOffset(INTERTIE_INDEX.tohokuTokyo, INTERTIE_FIELD_INDEX.plan, 0)] = 1000;
          return [d, v] as [number, Float64Array];
        }),
      );
      await writeFile(path.join(data, 'interties', `fy${fy}.json`), JSON.stringify(encodeIntertieFy(fy, map)));
    }
    await writeManifest(data, 'test');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const opts = (extra: Partial<ReturnType<typeof defaultOptions>>) => ({
    ...defaultOptions(),
    dist: path.join(dir, 'dist'),
    data: path.join(dir, 'data'),
    out: path.join(dir, 'out', 'single.html'),
    log: () => {},
    ...extra,
  });
  const embedded = async (extra: Partial<ReturnType<typeof defaultOptions>>) => {
    await buildSingle(opts(extra));
    const got = blocks(await readFile(path.join(dir, 'out', 'single.html'), 'utf8'));
    return { manifest: got[0].json as Manifest, files: new Map(got.slice(1).map((b) => [b.file, b.json])) };
  };

  it('指標はすべて、1 コマの図に使うカーブは直近の日だけを埋め込む', async () => {
    const { manifest, files } = await embedded({});
    const kept = curveDays.slice(-INLINE_CURVE_DAYS);
    expect(manifest.curves).toMatchObject({ firstDate: '2024-03-25', lastDate: '2024-04-03', dates: kept.map(ymd) });
    expect(manifest.curves!.metrics.map((m) => m.file)).toEqual(['curves/fy2023.json', 'curves/fy2024.json']);
    expect([...files.keys()].filter((f) => f.startsWith('curves/'))).toEqual(['curves/fy2023.json', 'curves/fy2024.json', ...kept.map(curveDayFile)]);
    expect(decodeCurveMetrics(files.get('curves/fy2023.json')).size).toBe(7);
    expect(decodeCurveDay(files.get(curveDayFile(kept[0]))).day).toBe(kept[0]);
    expect((await embedded({ curveDays: 3 })).manifest.curves!.dates).toEqual(curveDays.slice(-3).map(ymd));
  });

  it('--from / --to の年度に入る分だけにし、--no-curves では入れない', async () => {
    const { manifest, files } = await embedded({ from: 2024 });
    expect(manifest.curves).toMatchObject({ firstDate: '2024-04-01', lastDate: '2024-04-03', dates: ['20240401', '20240402', '20240403'] });
    expect([...files.keys()].some((f) => f.includes('fy2023'))).toBe(false);
    const none = await embedded({ noCurves: true });
    expect(none.manifest.curves).toBeUndefined();
    expect([...none.files.keys()].some((f) => f.startsWith('curves/'))).toBe(false);
  });

  it('連系線の年度ファイルも、埋め込む年度の分だけ入れ、--no-interties では入れない', async () => {
    const all = await embedded({});
    expect(all.manifest.interties!.files.map((f) => f.file)).toEqual(['interties/fy2023.json', 'interties/fy2024.json']);
    expect([...all.files.keys()].filter((f) => f.startsWith('interties/'))).toEqual(['interties/fy2023.json', 'interties/fy2024.json']);
    const from = await embedded({ from: 2024 });
    expect(from.manifest.interties).toMatchObject({ firstDate: '2024-04-01', lastDate: '2024-04-02' });
    const none = await embedded({ noInterties: true });
    expect(none.manifest.interties).toBeUndefined();
    expect([...none.files.keys()].some((f) => f.startsWith('interties/'))).toBe(false);
    expect(isDataFile('interties/fy2024.json')).toBe(true);
  });

  it('既定ではデータを圧縮して埋め込み、--no-compress では JSON のまま埋め込む（中身は同じ）', async () => {
    const out = path.join(dir, 'out', 'single.html');
    await buildSingle(opts({}));
    const packed = await readFile(out, 'utf8');
    await buildSingle(opts({ compress: false }));
    const plain = await readFile(out, 'utf8');
    expect(blocks(packed).slice(1).every((b) => b.compressed)).toBe(true);
    expect(blocks(plain).some((b) => b.compressed)).toBe(false);
    expect(blocks(packed).map((b) => [b.file, b.json])).toEqual(blocks(plain).map((b) => [b.file, b.json]));
    expect(Buffer.byteLength(packed)).toBeLessThan(Buffer.byteLength(plain));
    expect(parseArgs(['--no-compress']).compress).toBe(false);
    expect(parseArgs([]).compress).toBe(true);
  });

  it('--split では取得済みのカーブをすべて data フォルダに書き出す', async () => {
    const out = path.join(dir, 'share', 'viewer.html');
    await buildSingle(opts({ split: true, out }));
    const load = async (rel: string) => {
      let got: unknown;
      Function(REGISTER_FN, await readFile(path.join(dir, 'share', rel), 'utf8'))((_: string, json: unknown) => (got = json));
      return got;
    };
    const manifest = (await load('data/manifest.js')) as Manifest;
    expect(manifest.curves!.dates).toEqual(curveDays.map(ymd));
    for (const day of curveDays) expect(decodeCurveDay(await load(dataScriptPath(curveDayFile(day)))).day).toBe(day);
    expect(decodeCurveMetrics(await load('data/curves/fy2024.js')).size).toBe(3);
  });
});

describe('localData（ブラウザ側の読み出し）', () => {
  const fakeDoc = (items: { file: string; text: string; encoding?: string }[], meta = false) =>
    ({
      querySelectorAll: () =>
        items.map((i) => ({ getAttribute: (name: string) => (name === 'data-jv-file' ? i.file : (i.encoding ?? null)), textContent: i.text })),
      querySelector: (sel: string) => (meta && sel.startsWith('meta') ? {} : null),
    }) as unknown as Document;

  it('渡し方（埋め込み・data/*.js・通常の Web 版）を判定し、埋め込んだ JSON を読む', async () => {
    expect(localDataMode(fakeDoc([]))).toBeNull();
    expect(localDataMode(fakeDoc([], true))).toBe('scripts');
    const doc = fakeDoc([
      { file: 'manifest.json', text: 'null' },
      { file: 'spot/fy2024.json', text: '{"fy":2024,"s":"\\u003c/script>"}' },
    ]);
    expect(localDataMode(doc)).toBe('inline');
    expect(await readEmbedded('manifest.json', doc)).toBeNull();
    expect(await readEmbedded('spot/fy2024.json', doc)).toEqual({ fy: 2024, s: '</script>' });
    await expect(readEmbedded('spot/fy2020.json', doc)).rejects.toThrow(/ありません/);
  });

  it('gzip で圧縮して base64 で埋め込んだデータを、戻して読む（日本語も）', async () => {
    const value = { fy: 2024, note: '連系線</script>', values: Array.from({ length: 2000 }, (_, i) => i / 10) };
    const text = gzipSync(Buffer.from(JSON.stringify(value), 'utf8')).toString('base64');
    // 改行を挟んでも読める
    const doc = fakeDoc([{ file: 'spot/fy2024.json', text: `\n${text.slice(0, 40)}\n${text.slice(40)}\n`, encoding: 'gzip-base64' }]);
    expect(await readEmbedded('spot/fy2024.json', doc)).toEqual(value);
  });

  it('data/ の外や別のサイトを指す名前は読まない', () => {
    expect(dataScriptPath('manifest.json')).toBe('data/manifest.js');
    expect(dataScriptPath('spot/fy2024.json')).toBe('data/spot/fy2024.js');
    for (const bad of ['../secret.json', 'spot/../../x.json', 'https://example.com/x.json', '//example.com/x.json', 'spot/fy2024.js', 'spot/fy24.json']) {
      expect(isDataFile(bad)).toBe(false);
      expect(() => dataScriptPath(bad)).toThrow(/不正/);
    }
  });

  /** <script> を追加すると、files にある中身を実行して onload（無ければ onerror）を呼ぶ document */
  const scriptDoc = (files: Record<string, string>) => {
    const loaded: string[] = [];
    const doc = {
      baseURI: 'file:///share/jepx/viewer.html',
      createElement: () => ({ remove: () => {} }),
      head: {
        append: (el: { src: string; onload: () => void; onerror: () => void }) => {
          loaded.push(el.src);
          const rel = el.src.replace('file:///share/jepx/', '').replace(/\?.*$/, '');
          queueMicrotask(() => {
            if (!(rel in files)) return el.onerror();
            Function(files[rel])();
            el.onload();
          });
        },
      },
    } as unknown as Document;
    return { doc, loaded };
  };

  it('data/*.js を読み込み、jepxViewerData に渡されたデータを返す', async () => {
    const fy = { format: 'jepx-viewer/spot-fy@1', fy: 2024, s: '\u2028</script>' };
    const { doc, loaded } = scriptDoc({
      'data/spot/fy2024.js': dataScript('spot/fy2024.json', fy),
      'data/manifest.js': dataScript('manifest.json', MANIFEST),
      // 名前の違うデータを登録するだけのファイル
      'data/spot/fy2023.js': dataScript('spot/fy2022.json', {}),
    });
    await expect(loadDataScript('spot/fy2024.json', 'v=2026-09-24', doc)).resolves.toEqual(fy);
    await expect(loadDataScript('manifest.json', '', doc)).resolves.toEqual(MANIFEST);
    expect(loaded[0]).toBe('file:///share/jepx/data/spot/fy2024.js?v=2026-09-24');
    await expect(loadDataScript('spot/fy2023.json', '', doc)).rejects.toThrow(/形式が不正/);
    await expect(loadDataScript('spot/fy2021.json', '', doc)).rejects.toThrow(/読み込めませんでした/);
    // 不正な名前はスクリプトを追加せずに失敗する
    const before = loaded.length;
    await expect(loadDataScript('../x.json', '', doc)).rejects.toThrow(/不正/);
    expect(loaded).toHaveLength(before);
  });
});
