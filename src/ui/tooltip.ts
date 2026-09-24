/**
 * ツールチップ HTML の部品。値を先に太字で、系列名を後ろに補助色で並べる。
 * 系列の識別は短い線（線グラフ）または小さな矩形（棒・面）で示す。
 */
import { escapeHtml } from '../lib/format';

export function ttHeader(text: string): string {
  return `<div class="tt-head">${escapeHtml(text)}</div>`;
}

export function ttRow(color: string, value: string, label: string, key: 'line' | 'dash' | 'rect' | 'none' = 'line'): string {
  const keyHtml =
    key === 'none'
      ? ''
      : key === 'rect'
        ? `<span class="tt-key tt-key-rect" style="background:${color}"></span>`
        : `<span class="tt-key${key === 'dash' ? ' tt-key-dash' : ''}" style="--c:${color}"></span>`;
  return `<div class="tt-row">${keyHtml}<b class="tt-val">${escapeHtml(value)}</b><span class="tt-label">${escapeHtml(label)}</span></div>`;
}

export function ttNote(text: string): string {
  return `<div class="tt-note">${escapeHtml(text)}</div>`;
}
