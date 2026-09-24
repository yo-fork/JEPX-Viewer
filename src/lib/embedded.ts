/**
 * 1 ファイル版（npm run build:single）で HTML に埋め込んだデータの読み出し。
 *
 * ファイルから直接開いたページでは fetch で data/ を読めないため、取得済みデータ（public/data と同じ
 * manifest.json・spot/fyYYYY.json）を <script type="application/json" data-jv-file="…"> の中に入れてある。
 * 実行されないデータ用の script 要素なので、CSP でスクリプトを制限していても読める。
 */

/** データ用 script 要素の属性。値は public/data からの相対パス */
export const EMBED_ATTR = 'data-jv-file';
export const EMBED_MANIFEST = 'manifest.json';

function findBlock(file: string, doc: Document): HTMLScriptElement | undefined {
  return [...doc.querySelectorAll<HTMLScriptElement>(`script[${EMBED_ATTR}]`)].find((el) => el.getAttribute(EMBED_ATTR) === file);
}

/** 1 ファイル版として開かれているか（埋め込みの manifest があるか。データなしで作った場合も manifest はある） */
export function isSingleFile(doc: Document = document): boolean {
  return findBlock(EMBED_MANIFEST, doc) !== undefined;
}

/** 埋め込んだ JSON を読む */
export function readEmbedded(file: string, doc: Document = document): unknown {
  const el = findBlock(file, doc);
  if (!el) throw new Error(`埋め込みデータ（${file}）がありません`);
  return JSON.parse(el.textContent ?? '');
}
