import { describe, expect, it } from 'vitest';
import { src } from '../src/lib/aggregate';
import { dayFromYmd, MS_PER_SLOT } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { select } from '../src/lib/select';
import { PRICE_KEYS } from '../src/lib/series';
import { DataStore } from '../src/lib/store';
import { stateFromHash, stateToHash } from '../src/state';
import { dayRange } from '../src/views/calendar';
import { CommonRange, endLabels, fixedAxis, unionRange, valueRange, whiskerRange } from '../src/views/common';
import { histogramBins, histogramCounts } from '../src/views/distribution';
import { buildGrid, colorRange } from '../src/views/heatmap';
import { breakGaps, slotPoints } from '../src/views/timeseries';

describe('30 分値の時系列', () => {
  const start = dayFromYmd(2025, 4, 7);
  const store = new DataStore();
  store.addDays(generateDemoDays(start, start + 2), 'demo');
  const ds = store.dataset()!;

  it('日をまたぐ時間帯（20:00〜8:00）でも受渡日ごとに時刻順に並ぶ', () => {
    const sel = select(ds, { from: start, to: start + 2, dayType: 'all', slotStart: 40, slotEnd: 16 });
    const pts = slotPoints(sel, src(ds, 'system')).points;
    expect(pts).toHaveLength(3 * 24);
    for (let k = 1; k < pts.length; k++) expect(pts[k][0]).toBeGreaterThan(pts[k - 1][0]);
  });

  it('対象外の時間帯をはさむ所で線を切る', () => {
    const sel = select(ds, { from: start, to: start + 1, dayType: 'all', slotStart: 40, slotEnd: 16 });
    const pts = breakGaps(slotPoints(sel, src(ds, 'system')).points);
    const gaps = pts.filter((p) => Number.isNaN(p[1]));
    // 各日の 7:30 → 20:00 と、1 日目 23:30 → 2 日目 0:00 は連続（30 分差）なので切れ目は 2 か所
    expect(gaps).toHaveLength(2);
    const full = select(ds, { from: start, to: start + 2, dayType: 'all', slotStart: 0, slotEnd: 48 });
    expect(breakGaps(slotPoints(full, src(ds, 'system')).points).some((p) => Number.isNaN(p[1]))).toBe(false);
    expect(pts[1][0] - pts[0][0]).toBe(MS_PER_SLOT);
  });
});

describe('URL の状態', () => {
  it('既定値以外だけを保存し、読み戻せる', () => {
    const s = stateFromHash('#tab=heatmap&p=fy2024&s=kyushu,tokyo,kyushu&dt=offday&tz=night&f=kansai');
    expect(s.tab).toBe('heatmap');
    expect(s.preset).toBe('fy2024');
    expect(s.series).toEqual(['kyushu', 'tokyo']);
    expect([s.slotStart, s.slotEnd]).toEqual([40, 16]);
    expect(stateFromHash(stateToHash(s))).toEqual(s);
    expect(stateToHash(stateFromHash(''))).toBe('');
  });

  it('不正な値は既定値に戻す', () => {
    const s = stateFromHash('#tab=unknown&p=last999&ts=99&s=foo&th=-5');
    expect(s.tab).toBe('overview');
    expect(s.preset).toBe('last365');
    expect(s.series).toEqual(['system', 'tokyo', 'kansai', 'kyushu']);
    expect(s.threshold).toBe(30);
  });
});

describe('新しい表示設定の URL', () => {
  it('重ね線なし（sr=none）と比較の基準（base）を保存・復元できる', () => {
    const s = stateFromHash('#tab=trend&split=1&sr=none&base=tokyo');
    expect(s.splitRefs).toEqual([]);
    expect(s.areaBase).toBe('tokyo');
    expect(stateToHash(s)).toContain('sr=none');
    expect(stateFromHash(stateToHash(s))).toEqual(s);
    // 既定（システムプライスのみを重ねる・基準はシステムプライス）は URL に載せない
    const d = stateFromHash('#tab=trend');
    expect(d.splitRefs).toEqual(['system']);
    expect(d.areaBase).toBe('system');
    expect(stateToHash(d)).toBe('#tab=trend');
  });
});

describe('入札カーブの URL', () => {
  it('対象のエリアと、自由に選んだ日・時間帯を保存・復元できる（古い順・重複なし・5 件まで）', () => {
    const s = stateFromHash('#tab=curves&ca=hokkaido&cc=picks&cp=20260922.36,20260920.24,20260922.36,bad,20260921.99');
    expect(s.curveArea).toBe('hokkaido');
    expect(s.curveCompare).toBe('picks');
    expect(s.curvePicks).toEqual([
      { day: dayFromYmd(2026, 9, 20), slot: 24 },
      { day: dayFromYmd(2026, 9, 22), slot: 36 },
    ]);
    expect(stateToHash(s)).toContain('cp=20260920.24%2C20260922.36');
    expect(stateFromHash(stateToHash(s))).toEqual(s);
    const many = Array.from({ length: 8 }, (_, i) => `2026091${i}.10`).join(',');
    expect(stateFromHash(`#cp=${many}`).curvePicks).toHaveLength(5);
    expect(stateFromHash('#ca=nowhere').curveArea).toBe('system');
    expect(stateToHash(stateFromHash('#tab=curves'))).toBe('#tab=curves');
  });
});

describe('全エリア共通の色・縦軸の範囲', () => {
  const start = dayFromYmd(2025, 4, 1);
  const store = new DataStore();
  store.addDays(generateDemoDays(start, start + 120), 'demo');
  const ds = store.dataset()!;
  const sel = select(ds, { from: start, to: start + 119, dayType: 'all', slotStart: 0, slotEnd: 48 });

  it('URL に保存・復元でき、既定の「対象ごと」は URL に載せない', () => {
    const s = stateFromHash('#tab=heatmap&sc=common');
    expect(s.scale).toBe('common');
    expect(stateToHash(s)).toBe('#tab=heatmap&sc=common');
    expect(stateFromHash(stateToHash(s))).toEqual(s);
    expect(stateFromHash('#sc=fixed').scale).toBe('auto');
    expect(stateToHash(stateFromHash('#tab=heatmap'))).toBe('#tab=heatmap');
  });

  it('系列ごとの範囲をすべて含む範囲にする（値の無い系列は除く）', () => {
    expect(unionRange([[4, 21], [0, 20], [Number.NaN, Number.NaN], [4, 22]])).toEqual([0, 22]);
    expect(unionRange([[Number.NaN, Number.NaN]]).every(Number.isNaN)).toBe(true);
  });

  it('ヒートマップの色の範囲は、どの対象の「対象ごと」の範囲も含む', () => {
    const rangeOf = (k: (typeof PRICE_KEYS)[number]) => colorRange(buildGrid(sel, src(ds, k), 'dateSlot'), false);
    const own = PRICE_KEYS.map(rangeOf);
    const [lo, hi] = new CommonRange().get(sel, 'dateSlot', PRICE_KEYS, rangeOf);
    for (const [a, b] of own) {
      expect(lo).toBeLessThanOrEqual(a);
      expect(hi).toBeGreaterThanOrEqual(b);
    }
    expect(lo).toBe(Math.min(...own.map((r) => r[0])));
    expect(hi).toBe(Math.max(...own.map((r) => r[1])));
  });

  it('期間・曜日区分・時間帯・格子の種類など（extra）とデータが同じあいだは計算し直さない', () => {
    const own = new DataStore();
    own.addDays(generateDemoDays(start, start + 30), 'demo');
    const s = select(own.dataset()!, { from: start, to: start + 29, dayType: 'all', slotStart: 0, slotEnd: 48 });
    const common = new CommonRange();
    let calls = 0;
    const rangeOf = (): [number, number] => {
      calls++;
      return [0, 1];
    };
    common.get(s, 'dateSlot', PRICE_KEYS, rangeOf);
    common.get(select(s.ds, s.filters), 'dateSlot', PRICE_KEYS, rangeOf);
    expect(calls).toBe(PRICE_KEYS.length);
    common.get(s, 'monthSlot', PRICE_KEYS, rangeOf);
    common.get(select(s.ds, { ...s.filters, dayType: 'weekday' }), 'monthSlot', PRICE_KEYS, rangeOf);
    expect(calls).toBe(PRICE_KEYS.length * 3);
    // データを読み込み直した（Dataset が作り直された）
    own.addDays(generateDemoDays(start + 30, start + 31), 'demo');
    common.get(select(own.dataset()!, { ...s.filters, dayType: 'weekday' }), 'monthSlot', PRICE_KEYS, rangeOf);
    expect(calls).toBe(PRICE_KEYS.length * 4);
  });

  it('箱ひげ図の縦軸は、ひげ（10〜90%点）がすべて入る目盛りの幅の倍数まで広げる', () => {
    expect(whiskerRange([[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [], [20]])).toEqual([2, 20]);
    expect(fixedAxis([2, 20])).toEqual({ min: 0, max: 20, interval: 5 });
    expect(fixedAxis([4.96, 18.96])).toEqual({ min: 0, max: 20, interval: 5 });
    expect(fixedAxis([0.01, 33.2])).toEqual({ min: 0, max: 40, interval: 10 });
    expect(fixedAxis([1, 12.1])).toEqual({ min: 0, max: 12.5, interval: 2.5 });
    expect(fixedAxis([-3, 12])).toEqual({ min: -5, max: 15, interval: 5 });
    // 値が無ければ固定しない
    expect(fixedAxis([Number.NaN, Number.NaN])).toEqual({});
  });

  it('折れ線・棒の縦軸は、値（NaN を除く）がすべて入る範囲', () => {
    expect(valueRange([[3, Number.NaN, 7], Float64Array.from([5, 12]), []])).toEqual([3, 12]);
    expect(valueRange([[Number.NaN]]).every(Number.isNaN)).toBe(true);
  });

  it('縦軸を固定したときは、右端のラベルの重なりをその範囲で見積もる', () => {
    // データの範囲（0〜11）では 27px 離れるが、0〜100 に固定すると 3px しか離れず重なる
    const names = ['A', 'B'];
    const values = [[10], [11]];
    expect(endLabels(names, values, 'light', 300).filter((e) => 'endLabel' in e)).toHaveLength(2);
    expect(endLabels(names, values, 'light', 300, fixedAxis([0, 100])).filter((e) => 'endLabel' in e)).toHaveLength(1);
  });

  it('ヒストグラムを全エリア共通の階級で数えると、どのエリアも同じ階級に分かれ、上端以上は最後の階級に入る', () => {
    const tokyo = [4.2, 7.9, 8.1, 12.5, 30];
    const kyushu = [0.01, 0.01, 6.3, 9.9];
    const b = histogramBins(0.01, 12.5, '2');
    expect(b).toEqual({ start: 0, width: 2, nBins: 7 });
    const t = histogramCounts(tokyo, b);
    const k = histogramCounts(kyushu, b);
    expect(t).toHaveLength(b.nBins + 1);
    expect(k).toHaveLength(b.nBins + 1);
    expect(t).toEqual([0, 0, 1, 1, 1, 0, 1, 1]);
    expect(k).toEqual([2, 0, 0, 1, 1, 0, 0, 0]);
    // 階級の下端より少し小さい値（浮動小数点の誤差）も最初の階級に入れる
    expect(histogramCounts([-1e-12], b)[0]).toBe(1);
    // 「自動」は約 40 個に分ける幅
    expect(histogramBins(0, 40, 'auto')).toEqual({ start: 0, width: 1, nBins: 40 });
  });

  it('カレンダーの「対象ごと」の色の範囲（1〜99%点、差は対称、0.01 円のコマ数は 0〜最大）', () => {
    const v = [0.01, 5.2, 7.9, 12.3, Number.NaN, 30.4];
    expect(dayRange('mean', v)).toEqual([0, 30]);
    expect(dayRange('floor', [0, 3, 12, Number.NaN])).toEqual([0, 12]);
    const [lo, hi] = dayRange('spread', [-2, 1, 3]);
    expect(hi).toBeCloseTo(2.96);
    expect(lo).toBe(-hi);
    expect(dayRange('mean', [Number.NaN]).every(Number.isNaN)).toBe(true);
  });
});

