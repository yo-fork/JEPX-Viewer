import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCurves, parseCheckArgs } from '../scripts/check-curves';
import { defaultOptions, run } from '../scripts/fetch-jepx';
import { decodeCurveDay, encodeCurveDay, formatBidCurveCsv, formatSplittingAreasCsv, SYSTEM_GROUP, type CurveGroup } from '../src/lib/bidCurves';
import { checkSlot, median, share, slotKind } from '../src/lib/curveCheck';
import { dayFromYmd, isoFromDay } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay, type SlotTarget } from '../src/lib/demoCurves';
import { formatSpotCsv } from '../src/lib/jepxCsv';
import { AREA_KEYS, SERIES_INDEX, SLOTS, type AreaKey, type PriceKey } from '../src/lib/series';

const base = { tohoku: 12, tokyo: 12, chubu: 9, hokuriku: 9, kansai: 9, chugoku: 9, shikoku: 9 };

/** 合成の 1 コマ（保存・読み込みしたときと同じ描画用のカーブ）と、取引結果の約定価格 */
function slot(target: SlotTarget) {
  const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [target]);
  const gs = decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups)))).slots[0]!;
  const prices = { system: target.system, ...target.areas } as Record<PriceKey, number>;
  return { gs, price: (k: PriceKey) => prices[k] ?? target.system };
}

const total = (a: ArrayLike<number>) => (a.length >= 2 ? a[a.length - 1] : 0);

describe('checkSlot', () => {
  it('分断の様子を分け、単エリアが 1 つなら推定の交点と約定価格の差を出す', () => {
    const { gs, price } = slot({ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } });
    const system = gs.find((g) => g.id === SYSTEM_GROUP)!;
    const c = checkSlot({ groups: gs, price, sellBid: total(system.sell), buyBid: total(system.buy) })!;
    expect([c.kind, c.singles, c.sellDiff, c.buyDiff]).toEqual(['single', ['hokkaido'], 0, 0]);
    // 分断エリアのカーブは約定価格で交わる（合成のカーブは 0.25 円おきの段）
    expect(c.groupCross).toHaveLength(2);
    for (const x of c.groupCross) expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
    // 合成のカーブでは連系線でやりとりする量が約定量の 8%（2.4GW）で、分断エリアの合計は買いがシステムプライスより多い
    expect(c.excessBuy).toBeGreaterThan(0);
    expect(c.rangeSell).toBeGreaterThan(1000);
    expect(c.estimate).toMatchObject({ area: 'hokkaido', available: true });
    expect(Math.abs(c.estimate!.cross)).toBeLessThanOrEqual(0.25);
    expect(c.estimate!.lift).toBeGreaterThan(1000);
  });

  it('単エリアが無い分断では、分断エリアの合計 − システムプライスが連系線でやりとりする量（価格によらない）', () => {
    const { gs, price } = slot({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9 } });
    const c = checkSlot({ groups: gs, price, sellBid: Number.NaN, buyBid: Number.NaN })!;
    expect(c.kind).toBe('split');
    expect(c.excessSell).toBeCloseTo(2400, -2);
    expect(c.excessBuy).toBeCloseTo(2400, -2);
    // 価格による変わり方は、描画用に間引いた分ほど
    expect(c.rangeSell).toBeLessThan(150);
    expect(c.rangeBuy).toBeLessThan(150);
    expect(c.estimate).toBeUndefined();
    expect(Number.isNaN(c.sellDiff)).toBe(true);
  });

  it('システムプライスのカーブに単エリアの入札が入っていなければ、取引結果より少なく、推定できない', () => {
    const { gs, price } = slot({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9, shikoku: 5 } });
    const system = gs.find((g) => g.id === SYSTEM_GROUP)!;
    const rest: AreaKey[] = AREA_KEYS.filter((a) => a !== 'shikoku');
    // 四国以外のカーブ（連系線の分 1GW を含む）と、四国を除いたシステムプライスのカーブ
    const minus = (steps: Float64Array, v: number) => steps.map((x, i) => (i % 2 ? Math.max(0, x - v) : x));
    const groups: CurveGroup[] = [
      { ...system, sell: minus(system.sell, 1000), buy: minus(system.buy, 1000) },
      { id: 0, label: '四国以外', areas: rest, sell: system.sell, buy: system.buy },
    ];
    const national = { sell: total(system.sell) + 1500, buy: total(system.buy) + 1200 };
    const c = checkSlot({ groups, price, sellBid: national.sell, buyBid: national.buy })!;
    expect(slotKind(groups)).toBe('single');
    expect([c.sellDiff, c.buyDiff]).toEqual([-2500, -2200]);
    expect(c.estimate).toMatchObject({ area: 'shikoku', available: false });
  });

  it('中央値と割合（NaN は除く）', () => {
    expect([median([3, 1, Number.NaN, 2]), median([4, 1, 2, 3]), median([])]).toEqual([2, 2.5, Number.NaN]);
    expect(share([1, -1, 3, Number.NaN], (v) => v > 0)).toBeCloseTo(2 / 3);
  });
});

describe('npm run check:curves', () => {
  let dir = '';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'jepx-check-'));
    const csv = path.join(dir, 'csv');
    await mkdir(csv);
    const days = generateDemoDays(dayFromYmd(2026, 9, 24), dayFromYmd(2026, 9, 26), 7);
    for (const [day, vals] of days) {
      const at = (k: keyof typeof SERIES_INDEX, s: number) => vals[SERIES_INDEX[k] * SLOTS + s];
      const targets = Array.from({ length: SLOTS }, (_, s) => ({ system: at('system', s), volume: at('volume', s) / 500, areas: Object.fromEntries(AREA_KEYS.map((a) => [a, at(a, s)])) }));
      const { raw, groups } = syntheticCurveDay(day, targets);
      // 取引結果の入札量を、システムプライスのカーブの合計（全エリアの入札）にそろえる
      for (let s = 0; s < SLOTS; s++) {
        const rows = raw.slots[s].get(SYSTEM_GROUP)!;
        vals[SERIES_INDEX.sellBid * SLOTS + s] = Math.max(...rows.map((r) => r.sell)) * 500;
        vals[SERIES_INDEX.buyBid * SLOTS + s] = Math.max(...rows.map((r) => r.buy)) * 500;
      }
      const ymd = isoFromDay(day).replace(/-/g, '');
      await writeFile(path.join(csv, `spot_bid_curves_${ymd}.csv`), formatBidCurveCsv(raw));
      await writeFile(path.join(csv, `spot_splitting_areas_${ymd}.csv`), formatSplittingAreasCsv(day, groups));
    }
    await writeFile(path.join(csv, 'spot_summary_2026.csv'), formatSpotCsv(days));
    await run({ ...defaultOptions(), fromDirs: [csv], out: path.join(dir, 'out'), log: () => {} });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('システムプライスのカーブの合計と取引結果の入札量、分断エリアのカーブ、単エリアの推定をまとめる', async () => {
    const text = (await checkCurves(parseCheckArgs(['--data', path.join(dir, 'out')]))).join('\n');
    expect(text).toContain('2026/09/24〜2026/09/26 の 3 日・144 コマ');
    expect(text).toMatch(/単エリア 1 つ\s+\d+\s+100\.0%\s+100\.0%/);
    expect(text).toContain('公表されている分断エリアのカーブ（');
    expect(text).toMatch(/推定できた \d+・推定できない（引いた差が価格によらずほぼ一定）0/);
    // 1 日だけのときはコマごとの一覧も出す
    const day = (await checkCurves(parseCheckArgs(['--data', path.join(dir, 'out'), '--date', '2026-09-26']))).join('\n');
    expect(day).toContain('■ コマごと');
    expect(day.split('\n').filter((l) => /^\s+\d+\s+\d\d:\d\d–/.test(l))).toHaveLength(48);
  });

  it('1 コマを詳しく: 入札量の合計と、価格ごとのシステムプライス − 分断エリアの合計', async () => {
    const data = path.join(dir, 'out');
    // コマごとの一覧から、単エリアが 1 つのコマを選ぶ
    const list = await checkCurves(parseCheckArgs(['--data', data, '--date', '2026-09-26']));
    const row = list.find((l) => /^\s+\d+\s+\d\d:\d\d–\d\d:\d\d\s+単エリア 1 つ/.test(l))!;
    const n = row.trim().split(/\s+/)[0];
    const text = (await checkCurves(parseCheckArgs(['--data', data, '--date', '2026-09-26', '--slot', n]))).join('\n');
    expect(text).toContain(`（${n} コマ目）: 単エリア 1 つ`);
    expect(text).toContain('取引結果の入札量');
    expect(text).toContain('分断エリアの合計 − システム');
    expect(text).toContain('システムプライス − 分断エリアの合計（MW）');
    expect(text).toMatch(/推定した.+のカーブ: 売り・買いに [\d,]+ MW を足すと交点は/);
  });

  it('オプション', () => {
    expect(parseCheckArgs(['--date', '2026-09-26', '--slot', '48'])).toMatchObject({ from: dayFromYmd(2026, 9, 26), to: dayFromYmd(2026, 9, 26), slot: 47 });
    expect(() => parseCheckArgs(['--slot', '9'])).toThrow(/--date と一緒に/);
    expect(() => parseCheckArgs(['--date', '2026-09-26', '--slot', '49'])).toThrow(/1〜48/);
    expect(() => parseCheckArgs(['--x'])).toThrow(/不明なオプション/);
    return expect(checkCurves(parseCheckArgs(['--data', path.join(dir, 'none')]))).rejects.toThrow(/manifest\.json を読めません/);
  });
});
