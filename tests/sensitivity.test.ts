import { describe, expect, it } from 'vitest';
import { crossing, rowsFromSteps } from '../src/lib/bidCurves';
import { mulberry32 } from '../src/lib/demo';
import {
  absorbedAt,
  absorbedMw,
  adjustSensitivity,
  adjustThreshold,
  blockModels,
  curveSensitivity,
  effectiveShift,
  exceedShift,
  isCompleteShare,
  priceAtShift,
  priceResponse,
  publishedShare,
  SENS_FIELD_INDEX,
  sensitivityValues,
  shareQuantile,
  shiftRangeAt,
  type PriceResponse,
} from '../src/lib/sensitivity';

/**
 * 売り: 0.01 円 1000MW、8 円 2000MW、10 円 3000MW、30 円 4000MW、60 円 4500MW（累積）
 * 買い: 999 円 1500MW、12 円 2500MW、5 円 2800MW（累積。価格の高い順）
 * 交点は 10 円（売りと買いの差は 0.01 円 −1800、8 円 −500、10 円 +500、30 円 +2500、60 円 +3000 MW）
 */
const CURVE = {
  sell: Float64Array.of(0.01, 1000, 8, 2000, 10, 3000, 30, 4000, 60, 4500),
  buy: Float64Array.of(999, 1500, 12, 2500, 5, 2800),
};

/** 段の並びから読んだ価格（段の境目ちょうどは避けて使う） */
function stepPrice(r: PriceResponse, mw: number): number {
  if (mw > r.limit) return Number.NaN;
  let p = Number.NaN;
  for (const s of r.steps) {
    if (s.from > mw) break;
    p = s.price;
  }
  return p;
}

describe('買いの増減と約定価格', () => {
  it('交点をずらしたときの価格の段を求める（買いの段で交わるところも）', () => {
    const r = priceResponse(CURVE)!;
    expect(r.steps).toEqual([
      { from: Number.NEGATIVE_INFINITY, price: 0.01 },
      // 買いが 1800〜1500 MW 減ると、5 円の買いの段で交わる
      { from: -1800, price: 5 },
      { from: -1500, price: 8 },
      { from: -500, price: 10 },
      // 買いが 500〜1500 MW 増えると、12 円の買いの段で交わる
      { from: 500, price: 12 },
      { from: 1500, price: 30 },
      { from: 2500, price: 60 },
    ]);
    expect(r.limit).toBe(3000);
    expect(priceAtShift(r, 0)).toBe(10);
    expect(priceAtShift(r, 1000)).toBe(12);
    expect(priceAtShift(r, -1000)).toBe(8);
    expect(priceAtShift(r, 3001)).toBeNaN();
  });

  it('0.01 円になる・高騰する買いの増減', () => {
    const r = priceResponse(CURVE)!;
    expect(exceedShift(r, 0.01)).toBe(-1800);
    expect(exceedShift(r, 20)).toBe(1500);
    expect(exceedShift(r, 50)).toBe(2500);
    // 売りが尽きるまで超えない価格
    expect(exceedShift(r, 100)).toBeNaN();
    // 買いをすべて除いても超えている価格
    expect(exceedShift(r, 0)).toBe(Number.NEGATIVE_INFINITY);
  });

  it('価格感応度（±0.5・1・5GW）と、期間で集計する値', () => {
    const s = curveSensitivity(CURVE)!;
    expect(s.base).toBe(10);
    expect(s.up).toEqual([10, 12, Number.NaN]);
    expect(s.down).toEqual([8, 8, 0.01]);
    expect([s.floor, ...s.spike, s.limit]).toEqual([-1800, 1500, 2500, 3000]);
    const v = sensitivityValues(s);
    expect(v[SENS_FIELD_INDEX.up500]).toBe(0);
    expect(v[SENS_FIELD_INDEX.down500]).toBe(2);
    expect(v[SENS_FIELD_INDEX.up1000]).toBe(2);
    expect(v[SENS_FIELD_INDEX.up5000]).toBeNaN();
    expect(v[SENS_FIELD_INDEX.down5000]).toBeCloseTo(9.99, 9);
    expect([v[SENS_FIELD_INDEX.floor], v[SENS_FIELD_INDEX.spike20], v[SENS_FIELD_INDEX.spike50]]).toEqual([-1800, 1500, 2500]);
    // 約定価格に合わせて補正したカーブは、その約定価格を基準にする
    expect(curveSensitivity(CURVE, 11)!.base).toBe(11);
    expect(curveSensitivity({ sell: new Float64Array(0), buy: new Float64Array(0) })).toBeNull();
  });

  it('段の並びは、どの買いの増減でも crossing と同じ価格になる（ランダムなカーブ）', () => {
    const rand = mulberry32(7);
    for (let trial = 0; trial < 200; trial++) {
      const prices = [...new Set(Array.from({ length: 3 + Math.floor(rand() * 12) }, () => Math.round(rand() * 6000) / 100))].sort((a, b) => a - b);
      let v = 0;
      const sell = prices.flatMap((p) => [p, (v += Math.round(rand() * 800))]);
      v = 0;
      const buy = [...prices].reverse().flatMap((p) => [p, (v += Math.round(rand() * 800))]);
      const r = priceResponse({ sell, buy })!;
      const rows = rowsFromSteps(sell, buy);
      // 量は整数なので、段の境目（整数）を避けて 0.5 ずらした点で比べる
      for (let mw = -6000.5; mw <= 6000; mw += 97) {
        expect(stepPrice(r, mw)).toBe(crossing(rows, mw)?.price ?? Number.NaN);
      }
    }
  });
});

describe('ブロック入札の約定の変化の見込み', () => {
  it('公表値の価格になるカーブのずらし方から、効かなかった量を求める', () => {
    const r = priceResponse(CURVE)!;
    expect(shiftRangeAt(r, 10)).toEqual([-500, 500]);
    expect(shiftRangeAt(r, 12)).toEqual([500, 1500]);
    // その価格の段が無ければ、またぐ境目
    expect(shiftRangeAt(r, 11)).toEqual([500, 500]);
    expect(shiftRangeAt(r, 100)).toEqual([3000, 3000]);
    // 買い +1GW: カーブでも公表値でも 12 円なら 0、公表値が 10 円のままなら 500MW 効かなかった（段の内側に 0.5MW 入れる）
    expect(absorbedMw(r, 10, 1000, 2)).toBe(0);
    expect(absorbedMw(r, 10, 1000, 0)).toBe(500.5);
    // 公表値が下がった（足した量より多く効かなかった）
    expect(absorbedMw(r, 10, 1000, -1)).toBe(1500);
    // 買い −1GW で公表値が 10 円のまま
    expect(absorbedMw(r, 10, -1000, 0)).toBe(500.5);
  });

  it('そのコマの公表値から割合を求め、見込みで価格と境目をずらす', () => {
    const r = priceResponse(CURVE)!;
    const share = publishedShare(r, 10, { system: 10, up: [10, 10, 30], down: [10, 8, 0.01] });
    const round = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000);
    expect({ up: round(share.up), down: round(share.down) }).toEqual({ up: [0.001, 0.5, 0.5], down: [0.001, 0, 0] });
    expect(isCompleteShare(share)).toBe(true);
    expect(isCompleteShare(publishedShare(r, 10, { system: 10, up: [10, Number.NaN, 30], down: [10, 8, 0.01] }))).toBe(false);
    // 以下は割合をそろえた見込み: 効かない量は 0.5GW で 0、1GW で 500MW、その間は直線、5GW を超える分は割合（0.5）× tail
    const { mid, less, more } = blockModels({ up: [0, 0.5, 0.5], down: [0, 0, 0] });
    expect(absorbedAt(mid, true, 750)).toBe(250);
    expect(absorbedAt(mid, true, 5000)).toBe(2500);
    expect(absorbedAt(mid, true, 7000)).toBe(3000);
    expect(absorbedAt(less, true, 7000)).toBe(2500);
    expect(absorbedAt(more, true, 7000)).toBe(3500);
    expect(effectiveShift(mid, 1000)).toBe(500);
    expect(effectiveShift(mid, -1000)).toBe(-1000);
    // 20 円を超える境目 +1500MW は、効く量が 1500MW になる +3000MW に移る
    expect(adjustThreshold(mid, 1500)).toBe(3000);
    expect(adjustThreshold(mid, 2500)).toBe(5000);
    expect(adjustThreshold(mid, 3000)).toBeCloseTo(5000 + 500 / 0.75, 9);
    expect(adjustThreshold(mid, -1800)).toBe(-1800);
    expect(adjustThreshold(mid, Number.NaN)).toBeNaN();
    // 5GW を超える分がすべて効かないと届かない
    expect(adjustThreshold({ share: { up: [0, 0.5, 1], down: [0, 0, 0] }, tail: { up: 1, down: 0 } }, 6000)).toBeNaN();
    // 5GW を超える分のうち効かない割合は MAX_TAIL_SHARE まで。1 コマの見込みでは、直近の日の割合を使える
    expect(blockModels({ up: [0, 0.5, 1], down: [0, 0, 0] }).more.tail).toEqual({ up: 0.75, down: 0 });
    const q = { up: [0, 0.2, 0.3], down: [0, 0.1, 0.2] };
    const withTail = blockModels({ up: [0, 0.5, 0.9], down: [0, 0, 0] }, undefined, undefined, { mid: q, more: q });
    expect(withTail.mid.tail).toEqual({ up: 0.15, down: 0.1 });
    expect(withTail.more.tail).toEqual({ up: 0.3, down: 0.2 });
    // そのコマの公表値から求めた見込みでは、公表値の価格が再現される
    const adj = adjustSensitivity(curveSensitivity(CURVE)!, blockModels(share).mid);
    expect(adj.up).toEqual([10, 10, 30]);
    expect(adj.down).toEqual([10, 8, 0.01]);
    expect(adj.floor).toBeCloseTo(-1800, 0);
    expect(adj.spike[0]).toBeCloseTo(3000, -1);
  });

  it('いくつものコマの割合の分位点（足りなければ NaN）', () => {
    const s = (v: number) => ({ up: [v, v, v], down: [v, v, Number.NaN] });
    const q = shareQuantile([s(0), s(0.2), s(0.4), s(0.6)], 0.5, 2);
    expect(q.up.map((v) => Math.round(v * 100) / 100)).toEqual([0.3, 0.3, 0.3]);
    expect(q.down[2]).toBeNaN();
    expect(shareQuantile([s(0.1)], 0.5, 2).up[0]).toBeNaN();
  });
});
