/**
 * 配色トークン。CSS 変数（styles.css）と同じ値を ECharts 用に JS でも持つ。
 *
 * - 系列色は「エンティティに固定」: エリアの表示・非表示を切り替えても色は変わらない
 * - 東京・関西・九州に、どの 2 本が重なっても色覚多様性に配慮した判別ができる最初の 3 色を割り当てる
 * - システムプライスは基準線として無彩色（全色相と十分に離れていることを検証済み）
 * - 9 エリア目の四国は中国と同じ色相の破線（色 × 線種の複合符号化）
 */
import type { SeriesKey } from '../lib/series';

export type ThemeName = 'light' | 'dark';

export interface Tokens {
  page: string;
  surface: string;
  raised: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  border: string;
  /** カテゴリ色（固定順） */
  cat: string[];
  /** 単一色相の連続スケール（値が小さい→大きい） */
  seq: string[];
  /** 順序スケール（古い→新しい）。面に近い端でも 2:1 以上のコントラスト */
  ordinal: string[];
  /** 橙の順序スケール（買い入札の図用。ordinal と同じ明度の段） */
  ordinalWarm: string[];
  /** 発散スケール（負 → 中立 → 正。両側は同じ明度の段を対にする） */
  div: string[];
  neutralSeries: string;
  /** 強調しない文脈線（過去の年度など） */
  deemph: string;
  /** 凡例で非表示にした項目の文字色 */
  inactive: string;
  /** データの無いカレンダーのセル */
  emptyCell: string;
  /** 箱ひげの箱などの面の不透明度 */
  fillAlpha: number;
  /** 最低〜最高の帯の不透明度 */
  bandAlpha: number;
  /** 散布図の点の不透明度 */
  scatterAlpha: number;
}

/** 青の段（連続・順序・発散スケールで使う） */
const BLUE = {
  100: '#cde2fb',
  150: '#b7d3f6',
  200: '#9ec5f4',
  250: '#86b6ef',
  300: '#6da7ec',
  350: '#5598e7',
  400: '#3987e5',
  450: '#2a78d6',
  500: '#256abf',
  550: '#1c5cab',
  600: '#184f95',
  650: '#104281',
  700: '#0d366b',
};

/** 橙（カテゴリ色の 2 番目の色相）を、青の各段と同じ明度にそろえた段（買い入札の図用） */
const ORANGE = {
  100: '#ffd5c6',
  150: '#ffbfa8',
  200: '#ffa98a',
  250: '#f8946f',
  300: '#f37e52',
  350: '#ec6732',
  400: '#e15102',
  450: '#cb4801',
  500: '#b43f03',
  550: '#9e3703',
  600: '#8a2e01',
  650: '#752601',
  700: '#611e01',
};

export const TOKENS: Record<ThemeName, Tokens> = {
  light: {
    page: '#f9f9f7',
    surface: '#fcfcfb',
    raised: '#ffffff',
    ink: '#0b0b0b',
    ink2: '#52514e',
    // 軸ラベル等の補助テキスト（小さい文字でも 4.5:1 以上になる濃さ）
    muted: '#6f6e69',
    grid: '#e1e0d9',
    axis: '#c3c2b7',
    border: 'rgba(11,11,11,0.10)',
    cat: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
    seq: [BLUE[100], BLUE[200], BLUE[300], BLUE[400], BLUE[500], BLUE[600], BLUE[700]],
    ordinal: [BLUE[250], BLUE[300], BLUE[350], BLUE[400], BLUE[450], BLUE[500], BLUE[550], BLUE[600], BLUE[650], BLUE[700]],
    ordinalWarm: [ORANGE[250], ORANGE[300], ORANGE[350], ORANGE[400], ORANGE[450], ORANGE[500], ORANGE[550], ORANGE[600], ORANGE[650], ORANGE[700]],
    div: ['#2a78d6', '#f0efec', '#e34948'],
    neutralSeries: '#52514e',
    deemph: '#c3c2b7',
    inactive: '#c3c2b7',
    emptyCell: 'rgba(11,11,11,0.05)',
    fillAlpha: 0.16,
    bandAlpha: 0.12,
    scatterAlpha: 0.35,
  },
  // ダークは暗い面に沈まないよう、連続・順序スケールの暗い端を持ち上げ（面に対し 2.6:1 / 3.2:1 以上）、
  // 補助テキスト・罫線・面の塗りをライトより一段明るく・濃くしている
  dark: {
    page: '#0d0d0d',
    surface: '#1a1a19',
    raised: '#262624',
    ink: '#ffffff',
    ink2: '#d0cfc7',
    muted: '#aeaca5',
    grid: '#353533',
    axis: '#4a4945',
    border: 'rgba(255,255,255,0.13)',
    cat: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    seq: [BLUE[550], BLUE[500], BLUE[450], BLUE[400], BLUE[350], BLUE[300], BLUE[250], BLUE[200], BLUE[150], BLUE[100]],
    ordinal: [BLUE[500], BLUE[450], BLUE[400], BLUE[350], BLUE[300], BLUE[250], BLUE[200], BLUE[150], BLUE[100]],
    ordinalWarm: [ORANGE[500], ORANGE[450], ORANGE[400], ORANGE[350], ORANGE[300], ORANGE[250], ORANGE[200], ORANGE[150], ORANGE[100]],
    // 青の 300・450 段と同じ明度の赤を対にし、中央は面より少し明るい無彩色
    div: [BLUE[300], BLUE[450], '#3a3a37', '#d2393a', '#f27b74'],
    // 全エリア色と色覚シミュレーション下でも ΔE 10 以上離れる明るさ（検証済み）
    neutralSeries: '#b3b1a9',
    deemph: '#757470',
    inactive: '#5f5e5a',
    emptyCell: 'rgba(255,255,255,0.07)',
    fillAlpha: 0.3,
    bandAlpha: 0.22,
    scatterAlpha: 0.6,
  },
};

/** 系列 → カテゴリ色スロット（-1 は無彩色） */
const SERIES_SLOT: Record<SeriesKey, number> = {
  system: -1,
  tokyo: 0,
  kansai: 1,
  kyushu: 2,
  hokkaido: 3,
  tohoku: 4,
  chubu: 5,
  hokuriku: 6,
  chugoku: 7,
  shikoku: 7,
  sellBid: 0,
  buyBid: 1,
  volume: -1,
};

export function seriesColor(key: SeriesKey, theme: ThemeName): string {
  const slot = SERIES_SLOT[key];
  return slot < 0 ? TOKENS[theme].neutralSeries : TOKENS[theme].cat[slot];
}

export function seriesDashed(key: SeriesKey): boolean {
  return key === 'shikoku';
}

/**
 * 0〜1 の位置で順序スケールの色を取る（n 本のとき均等に）。
 * 隣の段と見分けられる（明度差 0.06 以上）のは 5 本まで。それより多いときは古いものを deemph にする
 * @param warm 橙のスケール（買い入札の図）
 */
export function ordinalColors(n: number, theme: ThemeName, warm = false): string[] {
  const ramp = warm ? TOKENS[theme].ordinalWarm : TOKENS[theme].ordinal;
  if (n <= 1) return [ramp[ramp.length - 1]];
  return Array.from({ length: n }, (_, i) => ramp[Math.round((i / (n - 1)) * (ramp.length - 1))]);
}

export const FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", Meiryo, sans-serif';

export type ThemeMode = 'auto' | ThemeName;
const STORAGE_KEY = 'jepx-viewer:theme';

export function loadThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* ストレージが使えない環境では既定値 */
  }
  return 'auto';
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* 保存できなくても動作は継続 */
  }
}

export function applyThemeMode(mode: ThemeMode): void {
  if (mode === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
}

export function effectiveTheme(mode: ThemeMode): ThemeName {
  if (mode !== 'auto') return mode;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
