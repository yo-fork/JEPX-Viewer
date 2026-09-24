import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assembleHtml, buildSingle, defaultOptions, escapeInlineScript, parseArgs, type EmbeddedData } from '../scripts/build-single';
import { writeManifest } from '../scripts/fetch-jepx';
import { decodeFyFile, encodeFyFile, MANIFEST_FORMAT, type Manifest } from '../src/lib/dataFile';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { isSingleFile, readEmbedded } from '../src/lib/embedded';

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
const blocks = (html: string) =>
  [...html.matchAll(/<script type="application\/json" data-jv-file="([^"]+)">([\s\S]*?)<\/script>/g)].map((m) => ({ file: m[1], json: JSON.parse(m[2]) as unknown }));

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

  it('データなしでは manifest を null にする', async () => {
    const html = await assembleHtml(INDEX_HTML, readAsset, null);
    expect(blocks(html)).toEqual([{ file: 'manifest.json', json: null }]);
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
    await writeManifest(path.join(dir, 'data'), 'test');
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
    const decoded = decodeFyFile(got[1].json);
    expect([...decoded.keys()]).toEqual([...days2024.keys()]);
    expect([...decoded.get(dayFromYmd(2024, 4, 2))!]).toEqual([...days2024.get(dayFromYmd(2024, 4, 2))!]);
  });

  it('--no-data ではデータを読まない。データが無ければ取得方法を案内する', async () => {
    const { data } = await buildSingle(opts({ noData: true, data: path.join(dir, 'none') }));
    expect(data).toBeNull();
    await expect(buildSingle(opts({ data: path.join(dir, 'none') }))).rejects.toThrow(/npm run fetch/);
    await expect(buildSingle(opts({ from: 2030 }))).rejects.toThrow(/埋め込む年度がありません/);
    await expect(buildSingle(opts({ dist: path.join(dir, 'none') }))).rejects.toThrow(/npm run build/);
  });
});

describe('embedded（ブラウザ側の読み出し）', () => {
  const fakeDoc = (items: { file: string; text: string }[]) =>
    ({ querySelectorAll: () => items.map((i) => ({ getAttribute: () => i.file, textContent: i.text })) }) as unknown as Document;

  it('manifest の有無で 1 ファイル版かを判定し、埋め込んだ JSON を読む', () => {
    expect(isSingleFile(fakeDoc([]))).toBe(false);
    const doc = fakeDoc([
      { file: 'manifest.json', text: 'null' },
      { file: 'spot/fy2024.json', text: '{"fy":2024,"s":"\\u003c/script>"}' },
    ]);
    expect(isSingleFile(doc)).toBe(true);
    expect(readEmbedded('manifest.json', doc)).toBeNull();
    expect(readEmbedded('spot/fy2024.json', doc)).toEqual({ fy: 2024, s: '</script>' });
    expect(() => readEmbedded('spot/fy2020.json', doc)).toThrow(/ありません/);
  });
});
