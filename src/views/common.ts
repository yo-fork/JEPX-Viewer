/**
 * 各ビューで共通に使うグラフ部品・表記。
 */
import { formatDay, slotStartLabel, ymdFromDay } from '../lib/dates';
import { fmtPrice } from '../lib/format';
import { SERIES_SHORT, type PriceKey, type SeriesKey } from '../lib/series';
import type { Selection } from '../lib/select';
import { isAllDay } from '../lib/select';
import { niceStep, quantileSorted } from '../lib/stats';
import type { Dataset } from '../lib/store';
import { SLOT_PRESETS, type AppState, type ScaleMode } from '../state';
import type { Option } from '../ui/controls';
import { TOKENS, seriesColor, seriesDashed, type ThemeName } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';

export const PRICE_UNIT = '円/kWh';

/** 軸ラベルがはみ出さない範囲でグラフ領域を取る */
export function grid(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { left: 8, right: 20, top: 44, bottom: 8, outerBoundsMode: 'same', outerBoundsContain: 'all', ...extra };
}

export function legend(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'scroll', top: 0, left: 0, itemWidth: 18, itemHeight: 10, itemGap: 16, itemStyle: { borderWidth: 0 }, ...extra };
}

/** 凡例の線キー（実線・破線） */
export const LINE_ICON = 'path://M0 0H20V3H0Z';
export const DASH_ICON = 'path://M0 0H5.5V3H0Z M7.25 0H12.75V3H7.25Z M14.5 0H20V3H14.5Z';

/** 系列（エリア）固定色の折れ線 */
export function lineSeries(key: SeriesKey, theme: ThemeName, data: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return styledLine(SERIES_SHORT[key], seriesColor(key, theme), theme, data, seriesDashed(key), extra);
}

/** 任意の名前・色の折れ線（2px、ホバー時のみ 8px の点と面色のリング） */
export function styledLine(
  name: string,
  color: string,
  theme: ThemeName,
  data: unknown[],
  dashed = false,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'line',
    name,
    data,
    color,
    showSymbol: false,
    symbol: 'circle',
    symbolSize: 8,
    itemStyle: { color, borderColor: TOKENS[theme].surface, borderWidth: 2 },
    lineStyle: { width: 2, type: dashed ? [6, 4] : 'solid', cap: 'round', join: 'round' },
    emphasis: { focus: 'none', lineStyle: { width: 2 } },
    ...extra,
  };
}

export function valueAxis(name = PRICE_UNIT, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'value',
    name,
    nameLocation: 'end',
    nameGap: 12,
    nameTextStyle: { align: 'left', padding: [0, 0, 0, -4] },
    scale: false,
    ...extra,
  };
}

/** ヒートマップ・カレンダーの色と、箱ひげ図の縦軸の範囲の決め方 */
export const SCALE_OPTIONS: Option<ScaleMode>[] = [
  { value: 'auto', label: '対象ごと' },
  { value: 'common', label: '全エリア共通' },
];

/** 範囲をすべて含む範囲（値の無い系列の NaN は除く。どれにも値が無ければ NaN） */
export function unionRange(ranges: readonly [number, number][]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const [a, b] of ranges) {
    if (a < lo) lo = a;
    if (b > hi) hi = b;
  }
  return lo <= hi ? [lo, hi] : [Number.NaN, Number.NaN];
}

/** 箱ひげ図のひげ（10〜90%点）がすべて入る範囲 */
export function whiskerRange(valuesPerGroup: readonly number[][]): [number, number] {
  return unionRange(
    valuesPerGroup.map((vals) => {
      const v = Float64Array.from(vals).sort();
      return [quantileSorted(v, 0.1), quantileSorted(v, 0.9)];
    }),
  );
}

/**
 * 縦軸を固定する設定。0 を含め、目盛りの幅（1・2・2.5・5 × 10^n）の倍数まで広げる。
 * 範囲だけを渡すと ECharts が目盛りの幅を選び直して上端の目盛りが半端になるので、幅も渡す。値が無ければ固定しない
 */
export function fixedAxis([lo, hi]: [number, number]): Record<string, number> {
  if (!(lo <= hi)) return {};
  const a = Math.min(0, lo);
  const b = Math.max(0, hi);
  const interval = niceStep((b - a) / 5);
  return { min: Math.floor(a / interval) * interval, max: Math.max(interval, Math.ceil(b / interval) * interval), interval };
}

/**
 * 全エリア共通の範囲。系列ごとの範囲をすべて含む範囲を、データと条件が同じあいだ使い回す
 * （全系列を集計し直すので、対象を切り替えるたびには計算しない）。
 */
export class CommonRange {
  private ds: Dataset | null = null;
  private key = '';
  private range: [number, number] = [Number.NaN, Number.NaN];

  /**
   * @param extra 期間・曜日区分・時間帯のほかに範囲が変わる条件（格子の種類・指標など。keys を変える条件も入れる）
   * @param rangeOf 系列の範囲（値が無ければ NaN）
   */
  get(sel: Selection, extra: string, keys: readonly PriceKey[], rangeOf: (key: PriceKey) => [number, number]): [number, number] {
    const f = sel.filters;
    const key = [sel.from, sel.to, f.dayType, f.slotStart, f.slotEnd, extra].join('|');
    if (sel.ds !== this.ds || key !== this.key) {
      this.range = unionRange(keys.map(rangeOf));
      this.ds = sel.ds;
      this.key = key;
    }
    return this.range;
  }
}

/** コマ（0〜47）のカテゴリ軸。2 時間おきにラベル */
export function slotAxis(slots: number[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'category',
    data: slots.map(slotStartLabel),
    boundaryGap: false,
    axisLabel: { interval: (i: number) => slots[i] % 4 === 0, hideOverlap: true },
    ...extra,
  };
}

/** 選択条件の説明（カードの副題用） */
export function describeSelection(sel: Selection, state: AppState): string {
  const parts = [`${formatDay(sel.from)}〜${formatDay(sel.to)}`];
  if (state.dayType === 'weekday') parts.push('平日');
  if (state.dayType === 'offday') parts.push('土日祝');
  if (!isAllDay(state)) {
    const p = SLOT_PRESETS.find((x) => x.id === state.slotPreset);
    parts.push(
      p && p.id !== 'custom' ? p.label : `${slotStartLabel(state.slotStart)}〜${slotStartLabel(state.slotEnd)}`,
    );
  }
  return parts.join('・');
}

export function priceText(v: number): string {
  return `${fmtPrice(v)} ${PRICE_UNIT}`;
}

/** 月ラベル 2024/04 */
export function monthLabel(day: number): string {
  const { y, m } = ymdFromDay(day);
  return `${y}/${String(m).padStart(2, '0')}`;
}

/** ファイル名に使う期間表記 */
export function rangeTag(sel: Selection): string {
  return `${formatDay(sel.from).replace(/\//g, '')}-${formatDay(sel.to).replace(/\//g, '')}`;
}

type TooltipParam = any;

/** 軸ツールチップ（複数系列の値を固定順で一覧） */
export function axisTooltip(
  keys: SeriesKey[],
  theme: ThemeName,
  header: (first: TooltipParam) => string,
  format: (v: number) => string = priceText,
): (params: TooltipParam) => string {
  return (params: TooltipParam) => {
    const ps: TooltipParam[] = Array.isArray(params) ? params : [params];
    if (ps.length === 0) return '';
    let html = ttHeader(header(ps[0]));
    for (const p of ps) {
      const key = keys[p.seriesIndex];
      if (!key) continue;
      const v = Array.isArray(p.value) ? p.value[1] : p.value;
      html += ttRow(seriesColor(key, theme), format(Number(v)), SERIES_SHORT[key], seriesDashed(key) ? 'dash' : 'line');
    }
    return html;
  };
}

/** 直接ラベルを付ける系列数の上限（それ以上は凡例とツールチップで識別） */
export const DIRECT_LABEL_MAX = 4;

function endLabel(name: string, theme: ThemeName): Record<string, unknown> {
  return { endLabel: { show: true, formatter: name, color: TOKENS[theme].ink2, fontSize: 11, distance: 6 } };
}

/**
 * 折れ線の右端に系列名を直接表示する設定を系列ごとに返す（4 系列以下のとき）。
 * 右端の値が近く、ラベルが重なるものは積み上げずに表示しない（凡例・ツールチップ・表で識別できる）。
 * @param values 各系列の y 値（右端のラベル位置と縦軸の範囲の見積もりに使う）
 */
export function endLabels(names: string[], values: ArrayLike<number>[], theme: ThemeName, plotHeight: number): Record<string, unknown>[] {
  const none = names.map(() => ({}));
  if (names.length > DIRECT_LABEL_MAX) return none;
  let lo = 0;
  let hi = Number.NEGATIVE_INFINITY;
  const last = values.map((arr) => {
    let v = Number.NaN;
    for (let i = 0; i < arr.length; i++) {
      const x = arr[i];
      if (!Number.isFinite(x)) continue;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      v = x;
    }
    return v;
  });
  if (!Number.isFinite(hi) || hi <= lo) return none;
  const px = last.map((v) => ((v - lo) / (hi - lo)) * plotHeight);
  const kept: number[] = [];
  return names.map((name, i) => {
    if (!Number.isFinite(px[i]) || kept.some((p) => Math.abs(p - px[i]) < 16)) return {};
    kept.push(px[i]);
    return endLabel(name, theme);
  });
}

/** 直接ラベル用に右側の余白を取る */
export function labelRoom(count: number, base = 20): number {
  return count <= DIRECT_LABEL_MAX ? 64 : base;
}

/** 折れ線の凡例（線の見本。四国などの破線は破線の見本） */
export function lineLegend(items: { name: string; dashed?: boolean }[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return legend({ data: items.map((it) => ({ name: it.name, icon: it.dashed ? DASH_ICON : LINE_ICON })), ...extra });
}

export function seriesLegend(keys: SeriesKey[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return lineLegend(keys.map((k) => ({ name: SERIES_SHORT[k], dashed: seriesDashed(k) })), extra);
}

/** #rrggbb に不透明度を付ける（面の塗り・箱ひげの箱など） */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export interface BarItem {
  label: string;
  value: number;
  color: string;
}

/** 幅の狭い画面ではカテゴリ棒グラフを横向きにする（ラベルが重ならないように） */
export function isNarrow(el: HTMLElement): boolean {
  return (el.clientWidth || window.innerWidth) < 600;
}

/**
 * カテゴリ（エリアなど）ごとの棒グラフ。縦向き・横向きを切り替えられ、値ラベルは棒の先端に付ける。
 */
export function categoryBarOption(
  items: BarItem[],
  opts: {
    horizontal: boolean;
    theme: ThemeName;
    unit: string;
    format: (v: number) => string;
    tooltip: (index: number) => string;
    valueAxisExtra?: Record<string, unknown>;
    markLine?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const t = TOKENS[opts.theme];
  const h = opts.horizontal;
  const radius = (v: number) => (h ? (v >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4]) : v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4]);
  const labelPos = (v: number) => (h ? (v >= 0 ? 'right' : 'left') : v >= 0 ? 'top' : 'bottom');
  const category = { type: 'category', data: items.map((i) => i.label), axisLabel: { interval: 0 }, ...(h ? { inverse: true } : {}) };
  const value = valueAxis(opts.unit, {
    ...(h ? { nameLocation: 'end', nameTextStyle: { align: 'right', verticalAlign: 'top', padding: [22, 0, 0, 0] }, splitLine: { show: true } } : {}),
    ...opts.valueAxisExtra,
  });
  return {
    grid: grid(h ? { top: 12, right: 56, bottom: 28 } : { top: 28, right: opts.markLine ? 84 : 20 }),
    tooltip: { trigger: 'item', formatter: (p: { dataIndex: number }) => opts.tooltip(p.dataIndex) },
    xAxis: h ? value : category,
    yAxis: h ? category : value,
    series: [
      {
        type: 'bar',
        barMaxWidth: 24,
        data: items.map((i) => ({
          value: i.value,
          itemStyle: { color: i.color, borderRadius: radius(i.value) },
          label: { position: labelPos(i.value) },
        })),
        label: { show: true, color: t.ink2, fontSize: 11, formatter: (p: { value: number }) => opts.format(p.value) },
        emphasis: { itemStyle: { opacity: 0.8 } },
        markLine: opts.markLine,
      },
    ],
  };
}

/**
 * 発散スケール（TOKENS.div）で塗ったセルに載せる数値ラベルの色。t は |値| / 範囲の最大（0〜1）。
 * ライトは中央が明るく両端も黒文字の方が読みやすい。ダークは中央が暗く、両端が明るい。
 */
export function labelOnDiv(t: number, theme: ThemeName): string {
  return theme === 'light' || t > 0.5 ? '#0b0b0b' : '#ffffff';
}

/**
 * 連続スケール（TOKENS.seq）で塗ったセルに載せる数値ラベルの色。
 * pos はスケール上の位置（0〜1）。ライトでは値が大きいほど濃く、ダークでは明るくなるので、
 * セル自体の明るさで黒か白を選ぶ。
 */
export function labelOnSeq(pos: number, theme: ThemeName): string {
  // ライトは 100→700 段、ダークは 550→100 段のスケール。白と黒のどちらがコントラストが高いかで分ける
  const cellIsLight = theme === 'light' ? pos < 0.6 : pos > 0.2;
  return cellIsLight ? '#0b0b0b' : '#ffffff';
}
