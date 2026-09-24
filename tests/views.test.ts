import { describe, expect, it } from 'vitest';
import { src } from '../src/lib/aggregate';
import { dayFromYmd, MS_PER_SLOT } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { select } from '../src/lib/select';
import { DataStore } from '../src/lib/store';
import { stateFromHash, stateToHash } from '../src/state';
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
