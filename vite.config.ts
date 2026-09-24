import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * 公開用ビルドに入れる Content Security Policy（読み込み元の制限）。
 * GitHub Pages のように HTTP ヘッダーを設定できない配信先でも効くよう、<meta> タグで入れる。
 * 開発サーバー（npm run dev）には入れないので、外部のフォントや Worker などを使うようにしたときは
 * ここも更新し、npm run build && npm run preview で確認する。
 */
const CSP = [
  "default-src 'self'",
  // スクリプトは同じサイトの JS ファイルだけ（インラインスクリプト・eval は実行しない）
  "script-src 'self'",
  // ECharts のツールチップやグラフの高さ指定が style 属性を使うので、属性は許可する。
  // <style> 要素は許可せず、スタイルシートは同じサイトの CSS ファイルだけ（style-src-elem 非対応のブラウザは前の行に従う）
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self'",
  // favicon とロゴの SVG は data: URI で埋め込んでいる
  "img-src 'self' data:",
  // 価格データ（data/*.json）は同じサイトから読む
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        // インラインの <script> / <style> は CSP で止まるので、公開してから気づくことがないようビルドを止める
        if (/<script\b(?![^>]*\bsrc=)[^>]*>|<style\b/i.test(html)) {
          throw new Error('index.html にインラインの <script> または <style> があります。CSP で止まるため、別ファイルにしてください。');
        }
        return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
      },
    },
  };
}

export default defineConfig({
  // 相対パスで出力し、GitHub Pages などサブパス配下でもそのまま動くようにする
  base: './',
  plugins: [contentSecurityPolicy()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
