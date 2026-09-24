/**
 * 系列（システムプライス・エリアプライス・入札/約定量）の定義。
 * CSV の列、内部配列のインデックス、画面表示ラベルはすべてここを起点にする。
 */

export const AREAS = [
  { key: 'hokkaido', label: '北海道' },
  { key: 'tohoku', label: '東北' },
  { key: 'tokyo', label: '東京' },
  { key: 'chubu', label: '中部' },
  { key: 'hokuriku', label: '北陸' },
  { key: 'kansai', label: '関西' },
  { key: 'chugoku', label: '中国' },
  { key: 'shikoku', label: '四国' },
  { key: 'kyushu', label: '九州' },
] as const;

export type AreaKey = (typeof AREAS)[number]['key'];
export type PriceKey = 'system' | AreaKey;
export type VolumeKey = 'sellBid' | 'buyBid' | 'volume';
export type SeriesKey = PriceKey | VolumeKey;

export const AREA_KEYS: AreaKey[] = AREAS.map((a) => a.key);
export const PRICE_KEYS: PriceKey[] = ['system', ...AREA_KEYS];
export const VOLUME_KEYS: VolumeKey[] = ['sellBid', 'buyBid', 'volume'];
export const SERIES_KEYS: SeriesKey[] = [...PRICE_KEYS, ...VOLUME_KEYS];
export const SERIES_COUNT = SERIES_KEYS.length;

/** 1 日あたりのコマ数（30 分 × 48） */
export const SLOTS = 48;

export const SERIES_INDEX = Object.fromEntries(SERIES_KEYS.map((k, i) => [k, i])) as Record<SeriesKey, number>;

export const SERIES_LABEL: Record<SeriesKey, string> = {
  system: 'システムプライス',
  ...(Object.fromEntries(AREAS.map((a) => [a.key, a.label])) as Record<AreaKey, string>),
  sellBid: '売り入札量',
  buyBid: '買い入札量',
  volume: '約定総量',
};

/** チップや凡例用の短い表記 */
export const SERIES_SHORT: Record<SeriesKey, string> = {
  ...SERIES_LABEL,
  system: 'システム',
};

/** 最低価格（JEPX スポット市場の入札価格下限 0.01 円/kWh） */
export const FLOOR_PRICE = 0.01;
export const isFloorPrice = (v: number): boolean => v <= FLOOR_PRICE + 1e-9;
