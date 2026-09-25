import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCurves, parseCheckArgs } from '../scripts/check-curves';
import { defaultOptions, run } from '../scripts/fetch-jepx';
import type { SpotBids } from '../src/lib/areaCurves';
import { decodeCurveDay, encodeCurveDay, formatBidCurveCsv, formatSplittingAreasCsv, SYSTEM_GROUP, type CurveGroup, type RawCurveDay } from '../src/lib/bidCurves';
import { checkSlot, isFlat, median, share, slotKind, varies } from '../src/lib/curveCheck';
import { dayFromYmd, isoFromDay } from '../src/lib/dates';
import { generateDemoDays } from '../src/lib/demo';
import { syntheticCurveDay, type SlotTarget } from '../src/lib/demoCurves';
import { formatSpotCsv } from '../src/lib/jepxCsv';
import { AREA_KEYS, SERIES_INDEX, SLOTS, type AreaKey, type PriceKey } from '../src/lib/series';

const base = { tohoku: 12, tokyo: 12, chubu: 9, hokuriku: 9, kansai: 9, chugoku: 9, shikoku: 9 };
const lastOf = (a: ArrayLike<number>) => (a.length >= 2 ? a[a.length - 1] : 0);

/** 合成の 1 コマを保存・読み込みした形と、取引結果の約定価格 */
function slot(target: SlotTarget, edit?: (raw: RawCurveDay) => void) {
  const { raw, groups } = syntheticCurveDay(dayFromYmd(2025, 5, 3), [target]);
  edit?.(raw);
  const day = decodeCurveDay(JSON.parse(JSON.stringify(encodeCurveDay(raw, groups))));
  const prices = { system: target.system, ...target.areas } as Record<PriceKey, number>;
  return { gs: day.slots[0]!, residual: day.residuals![0], price: (k: PriceKey) => prices[k] ?? target.system };
}

/** 取引結果: ブロック入札の約定の違いが sell・buy になるように */
function spotFor(system: CurveGroup, sell = 0, buy = 0): SpotBids {
  return { sellBid: lastOf(system.sell) + 5000 - sell, buyBid: lastOf(system.buy) + 800 + buy, sellBlockBid: 6000, sellBlockVolume: 1000, buyBlockBid: 1000, buyBlockVolume: 200 };
}

describe('checkSlot', () => {
  it('単エリアが 1 つなら、差は価格によって変わり、ブロック入札の違いを差し引いた推定は補正しなくても約定価格で交わる', () => {
    const { gs, residual, price } = slot({ system: 10, volume: 30000, areas: { ...base, hokkaido: 15, kyushu: 9 } }, (raw) => {
      // システムプライスの計算のほうが、売りのブロック入札が 300MW 多く、買いが 500MW 少なく約定したとする
      const sys = raw.slots[0].get(SYSTEM_GROUP)!;
      raw.slots[0].set(SYSTEM_GROUP, sys.map((r, i) => ({ price: r.price, sell: i === 0 ? r.sell : r.sell + 300, buy: r.buy - 500 })));
    });
    const system = gs.find((g) => g.id === SYSTEM_GROUP)!;
    const c = checkSlot({ groups: gs, residual, price, spot: spotFor(system, 300, 500) })!;
    expect([c.kind, c.singles, c.exact, c.blocks]).toEqual(['single', ['hokkaido'], true, { sell: 300, buy: 500 }]);
    expect([varies(c), isFlat(c)]).toEqual([true, false]);
    // 分断エリアのカーブは約定価格で交わる（合成のカーブは 0.25 円おきの段）
    expect(c.groupCross).toHaveLength(2);
    for (const x of c.groupCross) expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
    expect(c.estimate).toMatchObject({ area: 'hokkaido', available: true });
    expect(Math.abs(c.estimate!.cross)).toBeLessThanOrEqual(0.25);
    expect(c.estimate!.correction).toBeLessThan(50);
  });

  it('単エリアが無い分断では、分断エリアの合計 − システムプライスが価格によらない（連系線でやりとりする量）', () => {
    const { gs, residual, price } = slot({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9 } });
    const system = gs.find((g) => g.id === SYSTEM_GROUP)!;
    const c = checkSlot({ groups: gs, residual, price, spot: spotFor(system) })!;
    expect(c.kind).toBe('split');
    expect([isFlat(c), varies(c)]).toEqual([true, false]);
    // 合成のカーブでは、連系線でやりとりする量は約定量の 8%（2.4GW）
    expect(c.excessSell).toBeCloseTo(2400, -2);
    expect(c.excessBuy).toBeCloseTo(2400, -2);
    expect(c.estimate).toBeUndefined();
    // 保存しておいた差が無いと、描画用のカーブどうしの差から（間引いた分の誤差があるので、一定とみなす幅は広い）
    const approx = checkSlot({ groups: gs, price, spot: spotFor(system) })!;
    expect([approx.exact, isFlat(approx)]).toEqual([false, true]);
  });

  it('システムプライスのカーブに単エリアの入札が入っていなければ、差は価格によらず、推定できない', () => {
    const { gs, price } = slot({ system: 10, volume: 30000, areas: { ...base, hokkaido: 12, kyushu: 9, shikoku: 5 } });
    const system = gs.find((g) => g.id === SYSTEM_GROUP)!;
    const rest: AreaKey[] = AREA_KEYS.filter((a) => a !== 'shikoku');
    // 四国以外のカーブ（連系線の分 1GW を含む）と、四国を除いたシステムプライスのカーブ
    const minus = (steps: Float64Array, v: number) => steps.map((x, i) => (i % 2 ? Math.max(0, x - v) : x));
    const groups: CurveGroup[] = [
      { ...system, sell: minus(system.sell, 1000), buy: minus(system.buy, 1000) },
      { id: 0, label: '四国以外', areas: rest, sell: system.sell, buy: system.buy },
    ];
    const c = checkSlot({ groups, price, spot: spotFor(groups[0]) })!;
    expect(slotKind(groups)).toBe('single');
    expect([varies(c), isFlat(c)]).toEqual([false, true]);
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
      // 取引結果の入札量を、システムプライスのカーブの合計（全エリアの入札）にそろえ、ブロック入札は無しにする
      for (let s = 0; s < SLOTS; s++) {
        const rows = raw.slots[s].get(SYSTEM_GROUP)!;
        vals[SERIES_INDEX.sellBid * SLOTS + s] = Math.max(...rows.map((r) => r.sell)) * 500;
        vals[SERIES_INDEX.buyBid * SLOTS + s] = Math.max(...rows.map((r) => r.buy)) * 500;
        for (const k of ['sellBlockBid', 'sellBlockVolume', 'buyBlockBid', 'buyBlockVolume'] as const) vals[SERIES_INDEX[k] * SLOTS + s] = 0;
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

  it('差が価格によって変わるか、分断エリアのカーブの交点、単エリアの推定をまとめる', async () => {
    const text = (await checkCurves(parseCheckArgs(['--data', path.join(dir, 'out')]))).join('\n');
    expect(text).toContain('2026/09/24〜2026/09/26 の 3 日・144 コマ');
    expect(text).toMatch(/分断・単エリアなし\s+\d+\s+100\.0%\s+0\.0%/);
    expect(text).toMatch(/単エリア 1 つ\s+\d+\s+0\.0%\s+100\.0%/);
    expect(text).toContain('■ 公表されている分断エリアのカーブの交点 − そのエリアの約定価格');
    expect(text).toMatch(/推定できた \d+・推定できない（引いた差が価格によらずほぼ一定）0/);
    expect(text).toMatch(/補正しなくても約定価格で売りと買いが釣り合う: \d+ コマ/);
    expect(text).not.toContain('前の版で変換したファイル');
    // 1 日だけのときはコマごとの一覧も出す
    const day = (await checkCurves(parseCheckArgs(['--data', path.join(dir, 'out'), '--date', '2026-09-26']))).join('\n');
    expect(day).toContain('■ コマごと');
    expect(day.split('\n').filter((l) => /^\s+\d+\s+\d\d:\d\d–/.test(l))).toHaveLength(48);
  });

  it('1 コマを詳しく: 入札量の合計、取引結果、価格ごとのシステムプライス − 分断エリアの合計、推定', async () => {
    const data = path.join(dir, 'out');
    // コマごとの一覧から、単エリアが 1 つのコマを選ぶ
    const list = await checkCurves(parseCheckArgs(['--data', data, '--date', '2026-09-26']));
    const row = list.find((l) => /^\s+\d+\s+\d\d:\d\d–\d\d:\d\d\s+単エリア 1 つ/.test(l))!;
    const n = row.trim().split(/\s+/)[0];
    const text = (await checkCurves(parseCheckArgs(['--data', data, '--date', '2026-09-26', '--slot', n]))).join('\n');
    expect(text).toContain(`（${n} コマ目）: 単エリア 1 つ`);
    expect(text).toContain('分断エリアの合計 − システム');
    expect(text).toContain('取引結果（MW）');
    expect(text).toContain('ブロック入札の約定の違い: システムプライスの計算と市場分断の計算とで同じだけ約定');
    expect(text).toContain('システムプライス − 分断エリアの合計（MW。間引く前のカーブから）');
    expect(text).toMatch(/推定した.+のカーブ: ブロック入札の約定の違いを差し引き、売り・買いに [\d,]+ MW を足すと、交点は/);
    expect(text).toContain('約定総量との突き合わせ');
  });

  it('オプション', () => {
    expect(parseCheckArgs(['--date', '2026-09-26', '--slot', '48'])).toMatchObject({ from: dayFromYmd(2026, 9, 26), to: dayFromYmd(2026, 9, 26), slot: 47 });
    expect(() => parseCheckArgs(['--slot', '9'])).toThrow(/--date と一緒に/);
    expect(() => parseCheckArgs(['--date', '2026-09-26', '--slot', '49'])).toThrow(/1〜48/);
    expect(() => parseCheckArgs(['--x'])).toThrow(/不明なオプション/);
    return expect(checkCurves(parseCheckArgs(['--data', path.join(dir, 'none')]))).rejects.toThrow(/manifest\.json を読めません/);
  });
});
