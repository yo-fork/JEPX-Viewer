/**
 * 入札カーブのタブの図で共通に使う部品（カーブの説明・量の表記・凡例・ツールチップ）。
 */
import { GRANULARITY_LABEL } from '../lib/aggregate';
import { areaLabel, type AreaCurve, type CurveTarget } from '../lib/areaCurves';
import { SYSTEM_LABEL } from '../lib/bidCurves';
import { isoFromDay } from '../lib/dates';
import { fmtNum } from '../lib/format';
import { ttHeader, ttRow } from '../ui/tooltip';
import { lineLegend } from './common';
import type { autoGranularity } from './timeseries';

/** グラフ領域の上端（凡例 1 行と縦軸の名前の分）と、凡例が折り返したときの 1 行の高さ */
export const PLOT_TOP = 36;
const LEGEND_ROW = 24;

export type AxisParam = { axisValue?: unknown; seriesIndex: number; value: unknown };

export const targetLabel = (t: CurveTarget): string => (t === 'system' ? SYSTEM_LABEL : areaLabel(t));
/** 推定したカーブ（単エリア）。線を破線にする */
export const isEstimate = (c: AreaCurve): boolean => c.kind === 'single' || c.kind === 'combined';

/** 副題に出す、対象と表示しているカーブの説明 */
export function targetText(target: CurveTarget, ac: AreaCurve): string {
  if (target === 'system') return SYSTEM_LABEL;
  const name = areaLabel(target);
  switch (ac.kind) {
    case 'system':
      return ac.unnamed ? `${name}（分断エリアの名前が分からないため、システムプライスのカーブ）` : `${name}（市場分断なし: システムプライスのカーブ）`;
    case 'group':
      return `${name}（分断エリア: ${ac.label}）`;
    case 'single':
      return `${name}（単エリア・推定）`;
    case 'combined':
      return `${name}（単エリア ${ac.areas.length} つを合わせた推定: ${ac.label}）`;
    case 'unavailable':
      return `${name}（単エリア・推定できません）`;
  }
}

/** 比較の図で、それぞれのカーブがどのカーブかの短い説明 */
export function curveNote(ac: AreaCurve): string {
  switch (ac.kind) {
    case 'system':
      return ac.unnamed ? 'システムプライス' : '分断なし';
    case 'group':
      return ac.label;
    case 'single':
      return '単エリア・推定';
    case 'combined':
      return `${ac.label}の合算・推定`;
    case 'unavailable':
      return '推定できません';
  }
}

/** 小さい量は MW、大きい量は GW で */
export function fmtMw(mw: number): string {
  return Math.abs(mw) < 1000 ? `${fmtNum(mw, 0)} MW` : `${fmtNum(mw / 1000, 2)} GW`;
}

export const fmtGw = (mw: number) => `${fmtNum(mw / 1000, 2)} GW`;

/** 名前・色を指定した系列の軸ツールチップ（系列の順に並べる） */
export function namedTooltip(
  names: string[],
  colors: string[],
  header: (first: AxisParam) => string,
  format: (v: number) => string,
  dashed: boolean[] = [],
): (params: AxisParam | AxisParam[]) => string {
  return (params) => {
    const ps = (Array.isArray(params) ? params : [params]).slice().sort((a, b) => a.seriesIndex - b.seriesIndex);
    if (ps.length === 0) return '';
    let html = ttHeader(header(ps[0]));
    for (const p of ps) {
      const name = names[p.seriesIndex];
      if (name === undefined) continue;
      const v = Array.isArray(p.value) ? Number(p.value[1]) : Number(p.value);
      html += ttRow(colors[p.seriesIndex], format(v), name, dashed[p.seriesIndex] ? 'dash' : 'line');
    }
    return html;
  };
}

/** 文字列の幅の目安（px、12px の文字。全角は 1 文字 12px、半角は 7.5px。少し広めに見積もる） */
export function legendTextWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e7f ? 12 : 7.5;
  return w * 1.05;
}

/**
 * 項目が多いときは折り返す凡例（スクロールで隠れる項目を作らない）と、その行数に合わせたグラフ領域の上端。
 * @param width グラフの幅（px）
 * @param icons 線の見本の代わりにする見本の形（'diamond' など。指定しない項目は線）
 */
export function wrappedLegend(
  names: string[],
  width: number,
  dashed: boolean[] = [],
  icons: (string | undefined)[] = [],
): { legend: Record<string, unknown>; top: number } {
  // 凡例の内側の余白（左右 5px）を除いた幅に並べる
  const room = width - 10;
  let rows = 1;
  let x = 0;
  for (const name of names) {
    // 線の見本 18px + 見本と文字の間 5px + 文字 + 項目の間 16px
    const w = 18 + 5 + legendTextWidth(name);
    if (x > 0 && x + w > room) {
      rows++;
      x = 0;
    }
    x += w + 16;
  }
  const legend = lineLegend(names.map((name, i) => ({ name, dashed: dashed[i] })), { type: 'plain' });
  if (icons.some(Boolean)) legend.data = (legend.data as { name: string; icon: string }[]).map((d, i) => (icons[i] ? { ...d, icon: icons[i] } : d));
  return { legend, top: PLOT_TOP + (rows - 1) * LEGEND_ROW };
}

export function granText(gran: ReturnType<typeof autoGranularity>): string {
  return gran === 'slot' ? '30分値' : `${GRANULARITY_LABEL[gran]}ごとの平均`;
}

export function fileDate(day: number): string {
  return isoFromDay(day).replace(/-/g, '');
}
