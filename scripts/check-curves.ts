/**
 * 取得済みの入札カーブ（npm run fetch の出力）を、取引結果と突き合わせて確かめる。
 *
 *   npm run check:curves                                   取得済みの全期間
 *   npm run check:curves -- --from 2026-04-01 --to 2026-09-30
 *   npm run check:curves -- --date 2026-09-26              1 日分（コマごとの一覧も出す）
 *   npm run check:curves -- --date 2026-09-26 --slot 9     1 コマの数字を詳しく（--slot は 1〜48 のコマ）
 *   npm run check:curves -- --data <ディレクトリ>            取得済みデータの場所（既定: public/data）
 *
 * 市場分断したときの入札カーブの作り（システムプライスのカーブに単エリアの入札が入っているか、分断エリアのカーブに
 * 連系線でやりとりする量が入っているか）と、単エリアのカーブの推定が合っているかを、手元のデータで確かめる（src/lib/curveCheck.ts）。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { areaCurve, slotSplit, totalOf } from '../src/lib/areaCurves';
import {
  buyVolumeAt,
  crossing,
  CURVE_METRIC_INDEX,
  curveDayFile,
  decodeCurveDay,
  decodeCurveMetrics,
  rowsFromSteps,
  sellVolumeAt,
  SYSTEM_GROUP,
  type CurveGroup,
  type CurveMetricDays,
  type CurveMetricKey,
} from '../src/lib/bidCurves';
import { checkSlot, median, PRICE_TOLERANCES, share, SLOT_KIND_LABEL, SLOT_KINDS, withinPrice, type SlotCheck, type SlotInput } from '../src/lib/curveCheck';
import { decodeFyFile, MANIFEST_FORMAT, type Manifest } from '../src/lib/dataFile';
import { formatDay, isoFromDay, parseDateString, slotRangeLabel } from '../src/lib/dates';
import { fmtNum, fmtPct, fmtPrice, fmtSigned } from '../src/lib/format';
import type { DayMap } from '../src/lib/jepxCsv';
import { AREA_KEYS, kwhToMw, SERIES_INDEX, SERIES_LABEL, SLOTS, type PriceKey, type SeriesKey } from '../src/lib/series';

export interface CheckOptions {
  /** 取得済みデータ（npm run fetch の出力先） */
  data: string;
  from: number | null;
  to: number | null;
  /** 1 コマを詳しく見るとき（0 始まり。--date と一緒に指定する） */
  slot: number | null;
}

/** システムプライスのカーブの合計と取引結果の入札量を「同じ」とみなす差（MW）。間引く前のカーブの量は 0.1MW 単位 */
const SAME_MW = 1;

export function parseCheckArgs(argv: string[]): CheckOptions {
  const o: CheckOptions = { data: 'public/data', from: null, to: null, slot: null };
  const date = (a: string, v: string | undefined) => {
    const day = parseDateString(v ?? '');
    if (day === null) throw new Error(`${a} には日付（例: 2026-09-26）を指定してください`);
    return day;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--data') {
      if (!v) throw new Error('--data にはディレクトリを指定してください');
      o.data = v;
      i++;
    } else if (a === '--from') {
      o.from = date(a, v);
      i++;
    } else if (a === '--to') {
      o.to = date(a, v);
      i++;
    } else if (a === '--date') {
      o.from = o.to = date(a, v);
      i++;
    } else if (a === '--slot') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > SLOTS) throw new Error('--slot には 1〜48 のコマを指定してください');
      o.slot = n - 1;
      i++;
    } else if (a === '--help' || a === '-h') {
      throw new Error(HELP);
    } else {
      throw new Error(`不明なオプション: ${a}\n${HELP}`);
    }
  }
  if (o.slot !== null && (o.from === null || o.from !== o.to)) throw new Error('--slot は --date と一緒に指定してください');
  return o;
}

const HELP = `使い方: npm run check:curves -- [オプション]
  --from <日付> / --to <日付>   確かめる受渡日の範囲（既定: 取得済みの全期間）
  --date <日付>                 1 日分（コマごとの一覧も出す）
  --slot <1〜48>                --date と一緒に: 1 コマの数字を詳しく
  --data <ディレクトリ>          取得済みデータの場所（既定: public/data）`;

// ---- 表示 ----

/** 端末での表示幅（全角は 2） */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[⺀-￯]/.test(ch) && !/[｡-ﾟ]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, w: number, right: boolean): string {
  const n = Math.max(0, w - width(s));
  return right ? ' '.repeat(n) + s : s + ' '.repeat(n);
}

/** 列をそろえた表。left に入っている列は左寄せ（既定は 1 列目だけ）、ほかは右寄せ */
function table(header: string[], rows: string[][], indent = '  ', left: number[] = [0]): string[] {
  const ws = header.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const line = (r: string[]) => indent + r.map((c, i) => pad(c ?? '', ws[i], !left.includes(i))).join('  ').trimEnd();
  return [line(header), ...rows.map(line)];
}

const mw = (v: number, digits = 0) => (Number.isFinite(v) ? `${fmtNum(v, digits)}` : '—');
const signedMw = (v: number, digits = 0) => (Number.isFinite(v) ? fmtSigned(v, digits) : '—');
const gw = (v: number) => (Number.isFinite(v) ? `${fmtSigned(v / 1000, 2)} GW` : '—');
const yen = (v: number) => (Number.isFinite(v) ? `${fmtSigned(v, 2)} 円` : '—');
const pct = (v: number) => fmtPct(v);
const within = (values: number[]) => PRICE_TOLERANCES.map((t) => `${t} 円以内 ${pct(share(values, withinPrice(t)))}`).join('・');
const same = (v: number) => Math.abs(v) <= SAME_MW;

// ---- 読み込み ----

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

interface Loaded {
  spot: DayMap;
  metrics: CurveMetricDays;
  days: number[];
}

async function load(o: CheckOptions): Promise<Loaded> {
  let manifest: Manifest;
  try {
    manifest = (await readJson(path.join(o.data, 'manifest.json'))) as Manifest;
  } catch {
    throw new Error(`${path.join(o.data, 'manifest.json')} を読めません。npm run fetch で取得したデータの場所を --data で指定してください`);
  }
  if (manifest?.format !== MANIFEST_FORMAT) throw new Error(`${path.join(o.data, 'manifest.json')} の形式が不正です`);
  if (!manifest.curves || manifest.curves.dates.length === 0) throw new Error('入札カーブがありません。npm run fetch で取得してください');
  const spot: DayMap = new Map();
  for (const e of manifest.files) for (const [d, v] of decodeFyFile(await readJson(path.join(o.data, e.file)))) spot.set(d, v);
  const metrics: CurveMetricDays = new Map();
  for (const e of manifest.curves.metrics) for (const [d, v] of decodeCurveMetrics(await readJson(path.join(o.data, e.file)))) metrics.set(d, v);
  const days = manifest.curves.dates
    .map((s) => parseDateString(s))
    .filter((d): d is number => d !== null && (o.from === null || d >= o.from) && (o.to === null || d <= o.to))
    .sort((a, b) => a - b);
  return { spot, metrics, days };
}

/** 受渡日・コマの確かめる材料 */
function slotInput(l: Loaded, day: number, slot: number, groups: CurveGroup[]): SlotInput {
  const vals = l.spot.get(day);
  const at = (k: SeriesKey) => (vals ? vals[SERIES_INDEX[k] * SLOTS + slot] : Number.NaN);
  const m = l.metrics.get(day);
  const metric = (k: CurveMetricKey) => {
    const v = m ? m[CURVE_METRIC_INDEX[k] * SLOTS + slot] : Number.NaN;
    return Number.isFinite(v) ? v : undefined;
  };
  return {
    groups,
    price: (k: PriceKey) => at(k),
    sellBid: kwhToMw(at('sellBid')),
    buyBid: kwhToMw(at('buyBid')),
    systemSell: metric('sellTotal'),
    systemBuy: metric('buyTotal'),
    systemClear: metric('clearPrice'),
  };
}

interface Checked {
  day: number;
  slot: number;
  c: SlotCheck;
}

// ---- まとめ ----

function summary(list: Checked[]): string[] {
  const out: string[] = [];
  const of = (kind: string) => list.filter((x) => x.c.kind === kind).map((x) => x.c);
  const kinds = SLOT_KINDS.filter((k) => of(k).length > 0);

  out.push('', '■ システムプライスのカーブの入札量の合計と、取引結果の売り・買い入札量（全国）');
  out.push(`  差 = カーブ − 取引結果。${SAME_MW}MW 以内なら「同じ」。同じなら、システムプライスのカーブには（単エリアを含む）全エリアの入札が入っている`);
  out.push(
    ...table(
      ['コマ', 'コマ数', '売りが同じ', '買いが同じ', '売りの差（中央値）', '買いの差（中央値）', '売りの差（最大）', '買いの差（最大）'],
      kinds.map((k) => {
        const cs = of(k);
        const maxAbs = (f: (c: SlotCheck) => number) => {
          const v = cs.map(f).filter(Number.isFinite);
          return v.length === 0 ? Number.NaN : v.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
        };
        return [
          SLOT_KIND_LABEL[k],
          fmtNum(cs.length),
          pct(share(cs.map((c) => c.sellDiff), same)),
          pct(share(cs.map((c) => c.buyDiff), same)),
          `${signedMw(median(cs.map((c) => c.sellDiff)), 1)} MW`,
          `${signedMw(median(cs.map((c) => c.buyDiff)), 1)} MW`,
          `${signedMw(maxAbs((c) => c.sellDiff), 1)} MW`,
          `${signedMw(maxAbs((c) => c.buyDiff), 1)} MW`,
        ];
      }),
    ),
  );

  const splits = list.filter((x) => x.c.groupCross.length > 0).map((x) => x.c);
  out.push('', '■ 交点と約定価格の差（交点 − 約定価格）');
  out.push(`  システムプライスのカーブ（${fmtNum(list.length)} コマ）: ${within(list.map((x) => x.c.systemCross))}`);
  if (splits.length > 0) {
    out.push(`  公表されている分断エリアのカーブ（${fmtNum(splits.reduce((n, c) => n + c.groupCross.length, 0))} 本）: ${within(splits.flatMap((c) => c.groupCross))}`);
    out.push('  分断エリアのカーブが約定価格で交わるなら、連系線でやりとりする量（送る側は買い、受ける側は売り）も入っている');
    out.push('  （描画用に間引いたカーブの交点なので、段 1 つ分ほどずれることがある）');
  }

  const excessKinds = (['split', 'single', 'singles'] as const).filter((k) => of(k).length > 0);
  if (excessKinds.length > 0) {
    out.push('', '■ 公表されている分断エリアのカーブの合計 − システムプライスのカーブ（入札量の合計の中央値）');
    out.push('  単エリアが無いのに正で、価格によらずほぼ一定（右の 2 列が小さい）なら、分断エリアのカーブに連系線でやりとりする量が入っている');
    out.push(
      ...table(
        ['コマ', 'コマ数', '売り', '買い', '価格による変わり方（売り）', '価格による変わり方（買い）'],
        excessKinds.map((k) => {
          const cs = of(k);
          return [
            SLOT_KIND_LABEL[k],
            fmtNum(cs.length),
            gw(median(cs.map((c) => c.excessSell))),
            gw(median(cs.map((c) => c.excessBuy))),
            `${fmtNum(median(cs.map((c) => c.rangeSell)) / 1000, 2)} GW`,
            `${fmtNum(median(cs.map((c) => c.rangeBuy)) / 1000, 2)} GW`,
          ];
        }),
      ),
    );
  }

  const singles = list.filter((x) => x.c.estimate);
  if (singles.length > 0) {
    const est = singles.map((x) => x.c.estimate!);
    const ok = est.filter((e) => e.available);
    out.push('', '■ 単エリアが 1 つのコマの推定（システムプライス − 分断エリア、売り・買いに同じ量を足しただけのカーブ）');
    out.push(`  ${fmtNum(est.length)} コマ: 推定できた ${fmtNum(ok.length)}・推定できない（引いた差が価格によらずほぼ一定）${fmtNum(est.length - ok.length)}`);
    if (ok.length > 0) {
      out.push(`  交点 − 単エリアの約定価格: ${within(ok.map((e) => e.cross))}`);
      out.push(`  約定価格で交わるように足した量の中央値 ${mw(median(ok.map((e) => e.correction)))} MW、売り・買いに足した量の中央値 ${mw(median(ok.map((e) => e.lift)))} MW`);
    }
    const months = [...new Set(singles.map((x) => isoFromDay(x.day).slice(0, 7)))].sort();
    if (months.length > 1) {
      out.push('', '■ 月ごと（単エリアが 1 つのコマ）');
      out.push(
        ...table(
          ['月', 'コマ数', '売りの合計が同じ', '買いの合計が同じ', '交点が 0.1 円以内', '推定できない'],
          months.map((m) => {
            const xs = singles.filter((x) => isoFromDay(x.day).startsWith(m));
            const avail = xs.filter((x) => x.c.estimate!.available);
            return [
              m,
              fmtNum(xs.length),
              pct(share(xs.map((x) => x.c.sellDiff), same)),
              pct(share(xs.map((x) => x.c.buyDiff), same)),
              pct(share(avail.map((x) => x.c.estimate!.cross), withinPrice(0.1))),
              fmtNum(xs.length - avail.length),
            ];
          }),
        ),
      );
    }
  }
  return out;
}

/** 1 日分のコマごとの一覧 */
function slotList(list: Checked[]): string[] {
  const kindText = (c: SlotCheck) => (c.singles.length > 0 ? `${SLOT_KIND_LABEL[c.kind]}（${c.singles.map((a) => SERIES_LABEL[a]).join('・')}）` : SLOT_KIND_LABEL[c.kind]);
  return [
    '',
    '■ コマごと（差 = システムプライスのカーブの合計 − 取引結果、MW）',
    ...table(
      ['コマ', '時刻', '分断', '売りの差', '買いの差', '分断エリア − システム（買い）', '単エリアの推定: 交点 − 約定価格'],
      list.map(({ slot, c }) => [
        String(slot + 1),
        slotRangeLabel(slot),
        kindText(c),
        signedMw(c.sellDiff, 1),
        signedMw(c.buyDiff, 1),
        Number.isFinite(c.excessBuy) ? signedMw(c.excessBuy) : '',
        c.estimate ? (c.estimate.available ? yen(c.estimate.cross) : '推定できない') : '',
      ]),
      '  ',
      [1, 2],
    ),
  ];
}

/** 残りの価格の目安（円/kWh） */
const DETAIL_PRICES = [0, 0.01, 1, 3, 5, 7.5, 10, 12.5, 15, 20, 25, 30, 40, 50, 75, 100, 200, 500, 999.99];

/** 1 コマの数字を詳しく */
function detail(l: Loaded, day: number, slot: number, groups: CurveGroup[]): string[] {
  const input = slotInput(l, day, slot, groups);
  const c = checkSlot(input)!;
  const system = groups.find((g) => g.id === SYSTEM_GROUP)!;
  const published = groups.filter((g) => g.id !== SYSTEM_GROUP);
  const split = slotSplit(groups);
  const out: string[] = [];
  const head = c.singles.length > 0 ? `${SLOT_KIND_LABEL[c.kind]}（${c.singles.map((a) => SERIES_LABEL[a]).join('・')}）` : SLOT_KIND_LABEL[c.kind];
  out.push('', `■ ${formatDay(day, true)} ${slotRangeLabel(slot)}（${slot + 1} コマ目）: ${head}`);
  out.push(`  約定価格（円/kWh）: ${(['system', ...AREA_KEYS] as PriceKey[]).map((k) => `${k === 'system' ? 'システム' : SERIES_LABEL[k]} ${fmtPrice(input.price(k))}`).join('、')}`);
  const priceOfGroup = (g: CurveGroup) => (g.areas.length > 0 ? input.price(g.areas[0]) : Number.NaN);
  const crossOf = (g: CurveGroup) => crossing(rowsFromSteps(g.sell, g.buy))?.price ?? Number.NaN;
  const rows: string[][] = [
    ['システムプライス', mw(input.systemSell ?? totalOf(system.sell), 1), mw(input.systemBuy ?? totalOf(system.buy), 1), fmtPrice(input.systemClear ?? crossOf(system)), fmtPrice(input.price('system'))],
    ['取引結果の入札量', mw(input.sellBid, 1), mw(input.buyBid, 1), '', ''],
  ];
  for (const g of published) rows.push([`${g.id}: ${g.label}`, mw(totalOf(g.sell)), mw(totalOf(g.buy)), fmtPrice(crossOf(g)), fmtPrice(priceOfGroup(g))]);
  if (published.length > 0) {
    rows.push(['分断エリアの合計', mw(published.reduce((v, g) => v + totalOf(g.sell), 0)), mw(published.reduce((v, g) => v + totalOf(g.buy), 0)), '', '']);
    rows.push(['分断エリアの合計 − システム', signedMw(c.excessSell), signedMw(c.excessBuy), '', '']);
  }
  out.push(
    '  入札量の合計（MW）と交点（円/kWh）。分断エリアは描画用に間引いたカーブから（量は 1MW 単位）',
    ...table(['カーブ', '売り', '買い', '交点', '約定価格'], rows, '    '),
  );
  if (published.length === 0) return out;

  const top = Math.max(system.sell.length >= 2 ? system.sell[system.sell.length - 2] : 0, system.buy.length >= 2 ? system.buy[0] : 0);
  const marks = [input.price('system'), ...c.singles.map((a) => input.price(a))].filter(Number.isFinite);
  const prices = [...new Set([...DETAIL_PRICES, ...marks, top].map((p) => Math.round(p * 100) / 100))].filter((p) => p <= top + 1e-9).sort((a, b) => a - b);
  const resid = (p: number) => [
    sellVolumeAt(system.sell, p) - published.reduce((v, g) => v + sellVolumeAt(g.sell, p), 0),
    buyVolumeAt(system.buy, p) - published.reduce((v, g) => v + buyVolumeAt(g.buy, p), 0),
  ];
  out.push(
    '  システムプライス − 分断エリアの合計（MW）: 価格によって変わるなら、単エリアの入札が入っている。価格によらず一定の分は連系線でやりとりする量',
    ...table(
      ['価格（円/kWh）', '売り（この価格以下）', '買い（この価格以上）'],
      prices.map((p) => {
        const [s, b] = resid(p);
        return [fmtPrice(p), signedMw(s), signedMw(b)];
      }),
      '    ',
    ),
  );
  if (split.kind === 'split' && split.singles.length === 1) {
    const area = split.singles[0];
    const ac = areaCurve(groups, area, input.price)!;
    const name = SERIES_LABEL[area];
    if (ac.kind !== 'single') {
      out.push(`  ${name}のカーブは推定できません（引いた差が価格によらずほぼ一定）`);
    } else {
      const corr = ac.correction ? `、約定価格で交わるように${ac.correction.side === 'sell' ? '売り' : '買い'}に ${mw(ac.correction.mw)} MW を足して補正` : '';
      out.push(`  推定した${name}のカーブ: 売り・買いに ${mw(ac.lift ?? 0)} MW を足すと交点は ${fmtPrice(ac.rawCrossing ?? Number.NaN)} 円/kWh（約定価格 ${fmtPrice(input.price(area))} 円/kWh）${corr}`);
    }
  }
  return out;
}

export async function checkCurves(o: CheckOptions): Promise<string[]> {
  const l = await load(o);
  if (l.days.length === 0) throw new Error('指定した期間に入札カーブがありません');
  const list: Checked[] = [];
  let unread = 0;
  let detailLines: string[] = [];
  for (const day of l.days) {
    let slots: (CurveGroup[] | null)[];
    try {
      slots = decodeCurveDay(await readJson(path.join(o.data, curveDayFile(day)))).slots;
    } catch {
      unread++;
      continue;
    }
    slots.forEach((groups, slot) => {
      if (!groups) return;
      const c = checkSlot(slotInput(l, day, slot, groups));
      if (c) list.push({ day, slot, c });
      if (o.slot === slot) detailLines = detail(l, day, slot, groups);
    });
  }
  const first = l.days[0];
  const last = l.days[l.days.length - 1];
  const out = [
    `入札カーブの確認: ${o.data}（${formatDay(first)}〜${formatDay(last)} の ${fmtNum(l.days.length - unread)} 日・${fmtNum(list.length)} コマ）`,
  ];
  if (unread > 0) out.push(`  読めなかった日: ${fmtNum(unread)} 日`);
  if (list.length === 0) return out;
  if (o.slot !== null) {
    if (detailLines.length === 0) out.push('', `${formatDay(first, true)} の ${o.slot + 1} コマ目の入札カーブがありません`);
    return [...out, ...detailLines];
  }
  out.push(...summary(list));
  if (first === last) out.push(...slotList(list));
  return out;
}

// CLI として実行されたとき
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve()
    .then(() => checkCurves(parseCheckArgs(process.argv.slice(2))))
    .then((lines) => console.log(lines.join('\n')))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
