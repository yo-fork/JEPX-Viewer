/**
 * 連系線: 市場分断したコマで、分断エリアの間を連系線でやりとりした量。
 *
 * 公表されている分断エリアのカーブには、連系線でやりとりする量が、受ける側では売り（0 円）、送る側では買い（最も高い価格）として入っている。
 * 取引結果の入札量は、全エリアの入札（約定しなかったブロック入札も含む）の合計なので、
 *   分断エリアのカーブの売りの合計 − （取引結果の売り入札量 − 市場分断の計算で約定しなかった売りのブロック入札）
 * が、分断エリアのカーブに入っている受け入れの量になる（買いも同じく送り出しの量）。
 * 単エリア（1 エリアだけの分断エリア）はカーブが公表されないので、単エリアのあるコマでは求められない。
 * 2 つに分かれたコマでは、これが境をまたいだ量（境に連系線が複数あれば、その合計）になる。
 */
import type { SpotBids } from './areaCurves';
import { AREA_KEYS, SERIES_LABEL, type AreaKey } from './series';

/** 市場分断したコマの、分断エリアの間を連系線でやりとりした量 */
export interface BoundaryFlow {
  /** pair: 2 つに分かれた（境をまたいだ量）。many: 3 つ以上に分かれた（すべての境の量の合計） */
  kind: 'pair' | 'many';
  /** 約定価格から分けた分断エリア（エリアの並び順） */
  groups: AreaKey[][];
  /** pair のとき、価格の安い側（送る側）と高い側（受ける側） */
  from: AreaKey[];
  to: AreaKey[];
  /** 量（MW。売りから求めた量と買いから求めた量の平均） */
  mw: number;
  /** 売りから求めた量と、買いから求めた量（MW） */
  sell: number;
  buy: number;
}

/** 求められなかった理由 */
export type FlowFailure = 'single' | 'groups' | 'blocks' | 'mismatch';

export interface FlowInputs {
  /** 約定価格から分けた分断エリア（areaCurves.ts の priceSplit。分からなければ null） */
  groups: AreaKey[][] | null;
  /** エリアの約定価格 */
  price: (area: AreaKey) => number;
  /** 公表されている分断エリアのカーブの入札量の合計（MW）と数（市場分断していなければ null） */
  published: { sell: number; buy: number; count: number } | null;
  /** 取引結果の入札量とブロック入札の量（MW）。デモの合成カーブのように取引結果と別に作ったカーブでは null */
  spot: SpotBids | null;
  /** システムプライスのカーブの入札量の合計（MW。spot が null のときに使う） */
  system?: { sell: number; buy: number } | null;
}

/**
 * 売りから求めた量と買いから求めた量の差の許容（MW）。
 * 間引く前のカーブから求めた合計なら一致する。前の版のファイルは 1 MW 単位に丸めた描画用のカーブの合計なので、そのずれを見込む
 */
export const FLOW_TOLERANCE = 3;

/**
 * 市場分断したコマの、分断エリアの間を連系線でやりとりした量（市場分断していないコマは null）。
 * 求められないコマは、理由（単エリアがある、分断エリアの数が合わない、取引結果にブロック入札の量が無い、売りと買いで合わない）を返す
 */
export function boundaryFlow(x: FlowInputs): BoundaryFlow | FlowFailure | null {
  const { groups, published } = x;
  if (!groups || groups.length < 2 || !published) return null;
  if (groups.some((g) => g.length === 1)) return 'single';
  if (published.count !== groups.length) return 'groups';
  let sell: number;
  let buy: number;
  if (x.spot) {
    const s = x.spot;
    sell = published.sell - (s.sellBid - (s.sellBlockBid - s.sellBlockVolume));
    buy = published.buy - (s.buyBid - (s.buyBlockBid - s.buyBlockVolume));
  } else if (x.system) {
    // 取引結果と別に作ったカーブ（デモ）: システムプライスのカーブとの差がそのまま、やりとりする量
    sell = published.sell - x.system.sell;
    buy = published.buy - x.system.buy;
  } else {
    return 'blocks';
  }
  if (!Number.isFinite(sell) || !Number.isFinite(buy)) return 'blocks';
  if (Math.abs(sell - buy) > FLOW_TOLERANCE) return 'mismatch';
  const mw = Math.max(0, (sell + buy) / 2);
  if (groups.length > 2) return { kind: 'many', groups, from: [], to: [], mw, sell, buy };
  // 連系線は価格の安い側から高い側へ流れる
  const [a, b] = groups;
  const cheapA = x.price(a[0]) <= x.price(b[0]);
  return { kind: 'pair', groups, from: cheapA ? a : b, to: cheapA ? b : a, mw, sell, buy };
}

/**
 * 2 つに分かれたときの向き付きの量（MW）。北・東のまとまり（北海道を含む側）から南・西へ流れるときを正にする
 * （広域機関の連系線の「順方向」と同じ向き）
 */
export function signedFlow(f: BoundaryFlow): number {
  return f.from === f.groups[0] ? f.mw : -f.mw;
}

/**
 * 分断エリアの短い名前。エリアの並びで続いている 3 エリア以上は「北海道〜中部」、それ以外は「北海道・東北」のように並べる
 */
export function groupName(areas: readonly AreaKey[]): string {
  const idx = areas.map((a) => AREA_KEYS.indexOf(a));
  const run = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (run && areas.length >= 3) return `${SERIES_LABEL[areas[0]]}〜${SERIES_LABEL[areas[areas.length - 1]]}`;
  return areas.map((a) => SERIES_LABEL[a]).join('・');
}

/** 2 つに分かれたときの境の名前（北・東のまとまりが先） */
export function boundaryName(groups: readonly AreaKey[][]): string {
  return `${groupName(groups[0])} と ${groupName(groups[1])}`;
}

/** 求められなかった理由の説明 */
export const FLOW_FAILURE_TEXT: Record<FlowFailure, string> = {
  single: '単エリア（1 エリアだけで分断したエリア）があり、そのカーブが公表されないため分かりません',
  groups: '公表されている分断エリアの数が、約定価格から分けた数と合わないため分かりません',
  blocks: '取引結果にブロック入札の量が無いため分かりません（取引結果を取り直すと求められます）',
  mismatch: '売りから求めた量と買いから求めた量が合わないため、求めていません',
};
