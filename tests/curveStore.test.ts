import { describe, expect, it } from 'vitest';
import { CURVE_METRIC_INDEX, curveDayFile, encodeCurveDay, encodeCurveMetrics, newMetricValues, SYSTEM_GROUP } from '../src/lib/bidCurves';
import { CurveStore } from '../src/lib/curveStore';
import type { CurveIndex } from '../src/lib/dataFile';
import { dayFromYmd } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay } from '../src/lib/demoCurves';
import { SLOTS } from '../src/lib/series';
import { DataStore } from '../src/lib/store';

const d = (m: number, day: number) => dayFromYmd(2024, m, day);

/** 指標は 3/25〜4/3、描画用のカーブは直近の 4/2・4/3 だけ（1 ファイル版と同じ形） */
const INDEX: CurveIndex = {
  firstDate: '2024-03-25',
  lastDate: '2024-04-03',
  dates: ['20240402', '20240403'],
  metrics: [
    { fy: 2023, file: 'curves/fy2023.json', firstDate: '2024-03-25', lastDate: '2024-03-31', days: 7 },
    { fy: 2024, file: 'curves/fy2024.json', firstDate: '2024-04-01', lastDate: '2024-04-03', days: 3 },
  ],
};

/** 日ごとに sell001 だけ値を入れた指標の年度ファイル */
function metricsFile(fy: number, days: number[]) {
  const map = new Map<number, Float64Array>();
  for (const day of days) {
    const v = newMetricValues();
    for (let s = 0; s < SLOTS; s++) v[CURVE_METRIC_INDEX.sell001 * SLOTS + s] = day - d(3, 1) + s / 100;
    map.set(day, v);
  }
  return encodeCurveMetrics(fy, map);
}

function store(): { cs: CurveStore; reads: string[] } {
  const reads: string[] = [];
  const files = new Map<string, unknown>([
    ['curves/fy2023.json', metricsFile(2023, Array.from({ length: 7 }, (_, i) => d(3, 25) + i))],
    ['curves/fy2024.json', metricsFile(2024, [d(4, 1), d(4, 2), d(4, 3)])],
  ]);
  for (const day of [d(4, 2), d(4, 3)]) {
    const targets = Array.from({ length: SLOTS }, () => ({ system: 10, volume: 30000, east: 10, west: 10 }));
    files.set(curveDayFile(day), encodeCurveDay(syntheticCurveDay(day, targets).raw));
  }
  const cs = CurveStore.fromIndex(INDEX, async (file) => {
    reads.push(file);
    if (!files.has(file)) throw new Error(`no ${file}`);
    return files.get(file);
  })!;
  return { cs, reads };
}

describe('CurveStore', () => {
  it('描画用のカーブがある日と、指標のある期間を分けて持つ', () => {
    const { cs } = store();
    expect([cs.first, cs.last]).toEqual([d(4, 2), d(4, 3)]);
    expect([cs.metricsFirst, cs.metricsLast, cs.metricDays]).toEqual([d(3, 25), d(4, 3), 10]);
    expect(cs.resolve(Number.NaN)).toBe(d(4, 3));
    // カーブの無い日は、それ以前の最も近い日（無ければ最初の日）
    expect(cs.resolve(d(4, 10))).toBe(d(4, 3));
    expect(cs.resolve(d(3, 1))).toBe(d(4, 2));
    expect(cs.step(d(4, 3), -1)).toBe(d(4, 2));
    expect(cs.step(d(4, 2), -1)).toBeNull();
    expect(cs.recent(d(4, 3), 7)).toEqual([d(4, 2), d(4, 3)]);
    expect(CurveStore.fromIndex({ ...INDEX, dates: [] }, async () => null)).toBeNull();
  });

  it('必要な年度の指標・日のカーブだけを読み、Dataset の日の並びにそろえる', async () => {
    const { cs, reads } = store();
    await cs.ensureMetrics(d(4, 1), d(4, 3));
    expect(reads).toEqual(['curves/fy2024.json']);
    // 読み込み済みなら何もしない
    expect(cs.ensureMetrics(d(4, 1), d(4, 2))).toBeNull();
    await cs.ensureMetrics(d(3, 1), d(4, 3));
    expect(reads).toEqual(['curves/fy2024.json', 'curves/fy2023.json']);

    const ds = new DataStore();
    ds.addDays(generateDemoDays(d(3, 30), d(4, 3), 1), 'bundled');
    const dataset = ds.dataset()!;
    const arr = cs.metricArray(dataset, 'sell001');
    expect(arr.length).toBe(dataset.n * SLOTS);
    const at = (day: number, s: number) => arr[(day - dataset.start) * SLOTS + s];
    expect(at(d(3, 30), 0)).toBe(29);
    expect(at(d(4, 3), 5)).toBeCloseTo(33.05);
    expect(Number.isNaN(cs.metricArray(dataset, 'buy10')[0])).toBe(true);

    expect(cs.getDay(d(4, 3))).toBeUndefined();
    await cs.ensureDays([d(4, 2), d(4, 3), d(3, 30)]);
    expect(reads.filter((f) => f.startsWith('curves/2024/'))).toEqual(['curves/2024/20240402.json', 'curves/2024/20240403.json']);
    expect(cs.getDay(d(4, 3))!.slots[10]![0].id).toBe(SYSTEM_GROUP);
    expect(cs.ensureDays([d(4, 3)])).toBeNull();
  });

  it('デモではデモデータの直近の日から合成し、ファイルは読まない', () => {
    const ds = new DataStore();
    ds.addDays(generateDemoDays(d(1, 1), d(4, 30), 3), 'demo');
    const cs = CurveStore.demo(ds.dataset()!)!;
    expect(cs.isDemo).toBe(true);
    expect(cs.days).toHaveLength(90);
    expect(cs.last).toBe(d(4, 30));
    expect(cs.ensureMetrics(cs.first, cs.last)).toBeNull();
    expect(Number.isFinite(cs.metricArray(ds.dataset()!, 'clearPrice')[(cs.last - ds.dataset()!.start) * SLOTS + 20])).toBe(true);
  });
});
