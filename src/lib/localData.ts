/**
 * ファイルから直接開いて使う版（npm run build:single）のデータの読み出し。
 *
 * ファイルから開いたページでは fetch で data/ を読めないため、取得済みデータ（public/data と同じ
 * manifest.json・spot/fyYYYY.json）を次のどちらかの形で渡す。
 * - inline（既定）: HTML の <script type="application/json" data-jv-file="spot/fy2024.json"> の中に JSON を埋め込む。
 *   実行されないデータ用の script 要素なので、CSP でスクリプトを制限していても読める。
 * - scripts（--split）: HTML と同じ場所の data/spot/fy2024.js が jepxViewerData("spot/fy2024.json", {…}) を呼ぶ。
 *   <script src> は、ファイルから開いたページでも同じフォルダのファイルを読める（fetch と違い CORS の制限を受けない）。
 */

/** データ用 script 要素の属性。値は public/data からの相対パス */
export const EMBED_ATTR = 'data-jv-file';
export const LOCAL_MANIFEST = 'manifest.json';
/** scripts 形式であることを示す meta 要素の name */
export const SCRIPTS_META = 'jepx-viewer-data';
/** data/*.js が呼ぶ関数の名前 */
export const REGISTER_FN = 'jepxViewerData';

export type LocalDataMode = 'inline' | 'scripts' | null;

function findBlock(file: string, doc: Document): HTMLScriptElement | undefined {
  return [...doc.querySelectorAll<HTMLScriptElement>(`script[${EMBED_ATTR}]`)].find((el) => el.getAttribute(EMBED_ATTR) === file);
}

/**
 * ファイルから開いて使う版なら、データの渡し方を返す（通常の Web 版は null）。
 * inline はデータなしで作った場合も manifest（null）を埋め込んであるので判定できる。
 */
export function localDataMode(doc: Document = document): LocalDataMode {
  if (findBlock(LOCAL_MANIFEST, doc)) return 'inline';
  if (doc.querySelector(`meta[name="${SCRIPTS_META}"]`)) return 'scripts';
  return null;
}

/** HTML に埋め込んだ JSON を読む */
export function readEmbedded(file: string, doc: Document = document): unknown {
  const el = findBlock(file, doc);
  if (!el) throw new Error(`埋め込みデータ（${file}）がありません`);
  return JSON.parse(el.textContent ?? '');
}

/**
 * データとして読んでよい名前か（manifest が書き換えられても、data/ の外や別のサイトのファイルは読まない）。
 * 取引結果の年度ファイル、入札カーブの指標の年度ファイル・1 日分のファイルだけ
 */
export function isDataFile(file: string): boolean {
  return file === LOCAL_MANIFEST || /^(spot|curves)\/fy\d{4}\.json$/.test(file) || /^curves\/\d{4}\/\d{8}\.json$/.test(file);
}

/** data/*.js の場所（manifest.json → data/manifest.js、spot/fy2024.json → data/spot/fy2024.js） */
export function dataScriptPath(file: string): string {
  if (!isDataFile(file)) throw new Error(`データファイルの名前が不正です: ${file}`);
  return `data/${file.replace(/\.json$/, '.js')}`;
}

const received = new Map<string, unknown>();

/**
 * data/*.js を <script> で読み込み、その中で jepxViewerData(file, json) に渡されたデータを返す。
 * @param query 同じ名前のまま更新されたファイルを、古い内容のまま使わないための問い合わせ文字列
 */
export function loadDataScript(file: string, query = '', doc: Document = document): Promise<unknown> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (typeof g[REGISTER_FN] !== 'function') {
    g[REGISTER_FN] = (name: unknown, json: unknown) => {
      if (typeof name === 'string') received.set(name, json);
    };
  }
  return new Promise((resolve, reject) => {
    const rel = dataScriptPath(file);
    const url = new URL(rel, doc.baseURI);
    url.search = query;
    const el = doc.createElement('script');
    el.src = url.href;
    el.onload = () => {
      el.remove();
      if (!received.has(file)) {
        reject(new Error(`${rel} の形式が不正です`));
        return;
      }
      const json = received.get(file);
      received.delete(file);
      resolve(json);
    };
    el.onerror = () => {
      el.remove();
      reject(new Error(`${rel} を読み込めませんでした`));
    };
    doc.head.append(el);
  });
}
