/**
 * 何度も出てくる入札の段。多くのコマのカーブから集めた段を、価格と量の格子に分けて、段のあったコマを数える。
 * 同じ価格帯に同じくらいの量の段が何度も出てくれば、同じ発電所（買いなら同じ需要）の入札の可能性がある。
 */
import { SLOTS } from './series';
import { niceStep, quantileSorted } from './stats';

/** 1 コマのカーブにあった段 */
export interface StepOccurrence {
  day: number;
  slot: number;
  /** 段の価格（円/kWh） */
  price: number;
  /** その価格で増えた量（MW） */
  mw: number;
}

/** 階級: start から width 刻みで n 個。範囲の外の値は両端の階級に入れ、あったことを below・above で示す */
export interface StepAxis {
  start: number;
  width: number;
  n: number;
  below: boolean;
  above: boolean;
}

export interface StepCell {
  /** 価格の階級・量の階級の番号 */
  p: number;
  m: number;
  /** その段があったコマの数（1 コマに同じマスの段が 2 つあっても 1 と数える） */
  slots: number;
  /** その段があった、いちばん新しいコマ */
  latest: { day: number; slot: number };
}

export interface StepGrid {
  price: StepAxis;
  mw: StepAxis;
  /** 段のあったマス（コマの数の多い順。同じなら量の大きい順） */
  cells: StepCell[];
}

/** 価格は 1〜99%点を約 40 個に（外れた価格は両端に入れる）、量は 0 から最大までを約 25 個に分ける */
export function stepGrid(occ: readonly StepOccurrence[]): StepGrid | null {
  if (occ.length === 0) return null;
  const prices = Float64Array.from(occ, (o) => o.price).sort();
  const lo = quantileSorted(prices, 0.01);
  const hi = quantileSorted(prices, 0.99);
  const pw = Math.max(0.05, niceStep((hi - lo) / 40));
  const pStart = Math.floor(lo / pw) * pw;
  const nP = Math.floor((hi - pStart) / pw) + 1;
  const top = occ.reduce((m, o) => Math.max(m, o.mw), 0);
  const mw = Math.max(1, niceStep(top / 25));
  const nM = Math.floor(top / mw) + 1;
  const price: StepAxis = { start: pStart, width: pw, n: nP, below: false, above: false };

  const cells = new Map<number, { p: number; m: number; seen: Set<number>; latest: number }>();
  for (const o of occ) {
    let p = Math.floor((o.price - pStart) / pw);
    if (p < 0) {
      p = 0;
      price.below = true;
    } else if (p >= nP) {
      p = nP - 1;
      price.above = true;
    }
    const m = Math.min(nM - 1, Math.floor(o.mw / mw));
    const at = o.day * SLOTS + o.slot;
    const key = p * nM + m;
    const c = cells.get(key);
    if (c) {
      c.seen.add(at);
      c.latest = Math.max(c.latest, at);
    } else {
      cells.set(key, { p, m, seen: new Set([at]), latest: at });
    }
  }
  return {
    price,
    mw: { start: 0, width: mw, n: nM, below: false, above: false },
    cells: [...cells.values()]
      .map((c) => ({ p: c.p, m: c.m, slots: c.seen.size, latest: { day: Math.floor(c.latest / SLOTS), slot: c.latest % SLOTS } }))
      .sort((a, b) => b.slots - a.slots || b.m - a.m || a.p - b.p),
  };
}
