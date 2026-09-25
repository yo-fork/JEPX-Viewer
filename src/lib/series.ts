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
/** ブロック入札の量（取引結果の付帯列。入札カーブの単エリアの推定に使う） */
export type BlockKey = 'sellBlockBid' | 'sellBlockVolume' | 'buyBlockBid' | 'buyBlockVolume';
export type SeriesKey = PriceKey | VolumeKey | BlockKey;

export const AREA_KEYS: AreaKey[] = AREAS.map((a) => a.key);
export const PRICE_KEYS: PriceKey[] = ['system', ...AREA_KEYS];
export const VOLUME_KEYS: VolumeKey[] = ['sellBid', 'buyBid', 'volume'];
export const BLOCK_KEYS: BlockKey[] = ['sellBlockBid', 'sellBlockVolume', 'buyBlockBid', 'buyBlockVolume'];
export const SERIES_KEYS: SeriesKey[] = [...PRICE_KEYS, ...VOLUME_KEYS, ...BLOCK_KEYS];
export const SERIES_COUNT = SERIES_KEYS.length;

/** 1 日あたりのコマ数（30 分 × 48） */
export const SLOTS = 48;

/** 1 コマ（30 分）の電力量（kWh）を、その間の平均の電力（MW）にする（1MW × 0.5 時間 = 500kWh） */
export const kwhToMw = (kwh: number): number => kwh / 500;

export const SERIES_INDEX = Object.fromEntries(SERIES_KEYS.map((k, i) => [k, i])) as Record<SeriesKey, number>;

export const SERIES_LABEL: Record<SeriesKey, string> = {
  system: 'システムプライス',
  ...(Object.fromEntries(AREAS.map((a) => [a.key, a.label])) as Record<AreaKey, string>),
  sellBid: '売り入札量',
  buyBid: '買い入札量',
  volume: '約定総量',
  sellBlockBid: '売りブロック入札総量',
  sellBlockVolume: '売りブロック約定総量',
  buyBlockBid: '買いブロック入札総量',
  buyBlockVolume: '買いブロック約定総量',
};

/** チップや凡例用の短い表記 */
export const SERIES_SHORT: Record<SeriesKey, string> = {
  ...SERIES_LABEL,
  system: 'システム',
};

/** 最低価格（JEPX スポット市場の入札価格下限 0.01 円/kWh） */
export const FLOOR_PRICE = 0.01;
export const isFloorPrice = (v: number): boolean => v <= FLOOR_PRICE + 1e-9;
