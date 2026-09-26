/**
 * 取得済みの入札カーブ（npm run fetch の出力）を、取引結果と突き合わせて確かめる。
 *
 *   npm run check:curves                                   取得済みの全期間
 *   npm run check:curves -- --from 2026-04-01 --to 2026-09-30
 *   npm run check:curves -- --date 2026-09-26              1 日分（コマごとの一覧も出す）
 *   npm run check:curves -- --date 2026-09-26 --slot 9     1 コマの数字を詳しく（--slot は 1〜48 のコマ）
 *   npm run check:curves -- --data <ディレクトリ>            取得済みデータの場所（既定: public/data）
 *
 * 市場分断したときの入札カーブの作り（分断エリアのカーブに連系線でやりとりする量が入っているか、システムプライスのカーブに
 * 単エリアの入札が入っているか）と、単エリアのカーブの推定が約定価格で交わるかを、手元のデータで確かめる（src/lib/curveCheck.ts）。
 * 取引結果に JEPX の価格感応度の公表値があれば、システムプライスのカーブをずらして計算した目安（src/lib/sensitivity.ts）と比べる。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { areaCurve, blockGapText, residualDifference, slotSplit, totalOf, type SpotBids } from '../src/lib/areaCurves';
import {
  crossing,
  curveDayFile,
  curveDifference,
  decodeCurveDay,
  rowsFromSteps,
  SYSTEM_GROUP,
  type CurveDay,
  type CurveGroup,
} from '../src/lib/bidCurves';
import {
  checkSlot,
  isFlat,
  median,
  PRICE_TOLERANCES,
  share,
  SLOT_KIND_LABEL,
  SLOT_KINDS,
  varies,
  withinPrice,
  type SlotCheck,
  type SlotInput,
} from '../src/lib/curveCheck';
import { decodeFyFile, MANIFEST_FORMAT, type Manifest } from '../src/lib/dataFile';
import { formatDay, isoFromDay, parseDateString, slotRangeLabel } from '../src/lib/dates';
import { fmtNum, fmtPct, fmtPrice, fmtSigned } from '../src/lib/format';
import type { DayMap } from '../src/lib/jepxCsv';
import { curveSensitivity, publishedShare, shareQuantile, SPIKE_PRICES, type Sensitivity } from '../src/lib/sensitivity';
import { AREA_KEYS, kwhToMw, SENSITIVITY_SIZES, sensitivityKey, SERIES_INDEX, SERIES_LABEL, SLOTS, type PriceKey, type SeriesKey } from '../src/lib/series';

export interface CheckOptions {
  /** 取得済みデータ（npm run fetch の出力先） */
  data: string;
  from: number | null;
  to: number | null;
  /** 1 コマを詳しく見るとき（0 始まり。--date と一緒に指定する） */
  slot: number | null;
}

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

const mw = (v: number, digits = 0) => (Number.isFinite(v) ? fmtNum(v, digits) : '—');
const signedMw = (v: number, digits = 0) => (Number.isFinite(v) ? fmtSigned(v, digits) : '—');
const gw = (v: number) => (Number.isFinite(v) ? `${fmtNum(v / 1000, 2)} GW` : '—');
const signedGw = (v: number) => (Number.isFinite(v) ? `${fmtSigned(v / 1000, 2)} GW` : '—');
const yen = (v: number) => (Number.isFinite(v) ? `${fmtSigned(v, 2)} 円` : '—');
const pct = (v: number) => fmtPct(v);
const TOL_LABEL = (t: number) => (t <= 0.01 ? '同じ' : `${t} 円以内`);
const within = (values: number[]) => PRICE_TOLERANCES.map((t) => `${TOL_LABEL(t)} ${pct(share(values, withinPrice(t)))}`).join('・');
const kindText = (c: SlotCheck) => (c.singles.length > 0 ? `${SLOT_KIND_LABEL[c.kind]}（${c.singles.map((a) => SERIES_LABEL[a]).join('・')}）` : SLOT_KIND_LABEL[c.kind]);
/** ブロック入札の約定の違い（システムプライスの計算で多く約定した売り、少なく約定した買い） */
const blocksText = (c: SlotCheck) =>
  c.blocks ? `売り ${signedMw(c.blocks.sell)}・買い ${signedMw(-c.blocks.buy)} MW` : '（取引結果にブロック入札の量なし）';

// ---- 読み込み ----

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(file, 'utf8'));
}

interface Loaded {
  spot: DayMap;
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
  const days = manifest.curves.dates
    .map((s) => parseDateString(s))
    .filter((d): d is number => d !== null && (o.from === null || d >= o.from) && (o.to === null || d <= o.to))
    .sort((a, b) => a - b);
  return { spot, days };
}

/** 受渡日・コマの確かめる材料 */
function slotInput(l: Loaded, day: CurveDay, slot: number): SlotInput {
  const vals = l.spot.get(day.day);
  const at = (k: SeriesKey) => (vals ? vals[SERIES_INDEX[k] * SLOTS + slot] : Number.NaN);
  const spot: SpotBids = {
    sellBid: kwhToMw(at('sellBid')),
    buyBid: kwhToMw(at('buyBid')),
    sellBlockBid: kwhToMw(at('sellBlockBid')),
    sellBlockVolume: kwhToMw(at('sellBlockVolume')),
    buyBlockBid: kwhToMw(at('buyBlockBid')),
    buyBlockVolume: kwhToMw(at('buyBlockVolume')),
  };
  return { groups: day.slots[slot]!, residual: day.residuals?.[slot], price: (k: PriceKey) => at(k), spot };
}

interface Checked {
  day: number;
  slot: number;
  c: SlotCheck;
}

/** JEPX が公表している価格感応度（システムプライス） */
interface Published {
  system: number;
  up: number[];
  down: number[];
}

/** 1 コマの、システムプライスのカーブをずらして計算した目安と公表値 */
interface SensitivityChecked {
  est: Sensitivity;
  pub: Published | null;
}

function publishedOf(l: Loaded, day: number, slot: number): Published | null {
  const vals = l.spot.get(day);
  const at = (k: SeriesKey) => (vals ? vals[SERIES_INDEX[k] * SLOTS + slot] : Number.NaN);
  const up = SENSITIVITY_SIZES.map((mw) => at(sensitivityKey('buy', mw)));
  const down = SENSITIVITY_SIZES.map((mw) => at(sensitivityKey('sell', mw)));
  return [...up, ...down].some(Number.isFinite) ? { system: at('system'), up, down } : null;
}

function sensitivityCheck(l: Loaded, day: CurveDay, slot: number): SensitivityChecked | null {
  const system = day.slots[slot]?.find((g) => g.id === SYSTEM_GROUP);
  const est = system ? curveSensitivity(system) : null;
  return est ? { est, pub: publishedOf(l, day.day, slot) } : null;
}

// ---- まとめ ----

function summary(list: Checked[]): string[] {
  const out: string[] = [];
  const of = (kind: string) => list.filter((x) => x.c.kind === kind).map((x) => x.c);
  const splitKinds = (['split', 'single', 'singles'] as const).filter((k) => of(k).length > 0);
  const counts = SLOT_KINDS.filter((k) => of(k).length > 0).map((k) => `${SLOT_KIND_LABEL[k]} ${fmtNum(of(k).length)}`);
  out.push(`  ${counts.join('・')}`);
  const approx = list.filter((x) => x.c.kind !== 'none' && x.c.kind !== 'unnamed' && !x.c.exact).length;
  if (approx > 0) {
    out.push(
      `  （${fmtNum(approx)} コマは前の版で変換したファイルのため、描画用に間引いたカーブどうしの差から確かめています。` +
        'npm run fetch で変換し直すと、間引く前のカーブから求めた差を使います）',
    );
  }

  if (splitKinds.length > 0) {
    out.push('', '■ システムプライス − 公表されている分断エリアのカーブの合計');
    out.push('  単エリアが無いのに価格によらず一定なら、分断エリアのカーブには連系線でやりとりする量（とブロック入札の約定の違い）が価格によらない量で入っている。');
    out.push('  単エリアがあって価格によって変わるなら、システムプライスのカーブにその単エリアの入札が入っている');
    out.push(
      ...table(
        ['コマ', 'コマ数', '価格によらず一定', '価格によって変わる', '変わり方の中央値（売り / 買い）', '分断エリアの合計 − システム（売り / 買い）'],
        splitKinds.map((k) => {
          const cs = of(k);
          return [
            SLOT_KIND_LABEL[k],
            fmtNum(cs.length),
            pct(cs.filter(isFlat).length / cs.length),
            pct(cs.filter(varies).length / cs.length),
            `${gw(median(cs.map((c) => c.rangeSell)))} / ${gw(median(cs.map((c) => c.rangeBuy)))}`,
            `${signedGw(median(cs.map((c) => c.excessSell)))} / ${signedGw(median(cs.map((c) => c.excessBuy)))}`,
          ];
        }),
      ),
    );
  }

  const splits = list.filter((x) => x.c.groupCross.length > 0).map((x) => x.c);
  if (splits.length > 0) {
    out.push('', '■ 公表されている分断エリアのカーブの交点 − そのエリアの約定価格');
    out.push(`  ${fmtNum(splits.reduce((n, c) => n + c.groupCross.length, 0))} 本: ${within(splits.flatMap((c) => c.groupCross))}`);
    out.push('  （描画用に間引いたカーブの交点なので、段 1 つ分ほどずれることがある）');
  }

  const singles = list.filter((x) => x.c.estimate);
  if (singles.length > 0) {
    const ok = singles.filter((x) => x.c.estimate!.available).map((x) => x.c);
    out.push('', '■ 単エリアが 1 つのコマの推定（システムプライス − 分断エリア − ブロック入札の約定の違い、売り・買いに同じ量を足したもの）');
    out.push(`  ${fmtNum(singles.length)} コマ: 推定できた ${fmtNum(ok.length)}・推定できない（引いた差が価格によらずほぼ一定）${fmtNum(singles.length - ok.length)}`);
    if (ok.length > 0) {
      const withBlocks = ok.filter((c) => c.blocks);
      const fixed = ok.filter((c) => c.estimate!.correction > 0);
      out.push(
        `  補正しなくても約定価格で売りと買いが釣り合う: ${fmtNum(ok.length - fixed.length)} コマ（${pct((ok.length - fixed.length) / ok.length)}）。` +
          `約定価格で交わるように足したのは ${fmtNum(fixed.length)} コマ（足した量の中央値 ${mw(median(fixed.map((c) => c.estimate!.correction)))} MW、` +
          `最大 ${mw(Math.max(0, ...fixed.map((c) => c.estimate!.correction)))} MW）`,
      );
      out.push(`  補正する前の交点 − 単エリアの約定価格: ${within(ok.map((c) => c.estimate!.cross))}（売りと買いが同じ量の価格が幅を持つときは、その安い端）`);
      if (withBlocks.length < ok.length) {
        out.push(`  （うち ${fmtNum(ok.length - withBlocks.length)} コマは取引結果にブロック入札の量が無く、ブロック入札の約定の違いを差し引いていない）`);
      }
    }
    const months = [...new Set(singles.map((x) => isoFromDay(x.day).slice(0, 7)))].sort();
    if (months.length > 1) {
      out.push('', '■ 月ごと（単エリアが 1 つのコマ）');
      out.push(
        ...table(
          ['月', 'コマ数', '差が価格によって変わる', '補正なしで約定価格で釣り合う', '推定できない'],
          months.map((m) => {
            const xs = singles.filter((x) => isoFromDay(x.day).startsWith(m)).map((x) => x.c);
            const avail = xs.filter((c) => c.estimate!.available);
            return [
              m,
              fmtNum(xs.length),
              pct(xs.filter(varies).length / xs.length),
              pct(share(
                avail.map((c) => c.estimate!.correction),
                (v) => v === 0,
              )),
              fmtNum(xs.length - avail.length),
            ];
          }),
        ),
      );
    }
  }
  return out;
}

const mean = (v: number[]) => (v.length > 0 ? v.reduce((a, b) => a + b, 0) / v.length : Number.NaN);
const sizeText = (mw: number) => `${mw / 1000}GW`;

/** 価格感応度: 公表値と目安の、約定価格の動き（買いを増減したときの価格 − 増減しないときの価格）の比べ */
function sensitivitySummary(list: SensitivityChecked[]): string[] {
  const out = ['', '■ 価格感応度: JEPX の公表値と、システムプライスのカーブ（描画用に間引いたもの）をずらして計算した目安'];
  const pub = list.filter((x): x is SensitivityChecked & { pub: Published } => x.pub !== null);
  if (pub.length === 0) {
    out.push('  取引結果に価格感応度の公表値がありません（npm run fetch で取引結果と一緒に取得します。2021 年度から）');
    return out;
  }
  out.push(`  公表値のある ${fmtNum(pub.length)} コマ。カーブの交点 − 公表されているシステムプライス: ${within(pub.map((x) => x.est.base - x.pub.system))}`);
  out.push('  目安はブロック入札の約定を変えずにカーブをずらしたもの。公表値は約定計算をやり直し、ブロック入札の約定も判定し直している');
  out.push('  効かなかった割合 = 公表値の価格になるようにカーブをずらす量と、足した量との差 ÷ 足した量（画面のブロック入札の変化の見込みに使う割合）');
  // 足した量のうち効かなかった割合の、25%・50%・75% 点
  const shares = pub.map((x) => publishedShare(x.est.response, x.est.base, x.pub));
  const [q25, q50, q75] = [0.25, 0.5, 0.75].map((q) => shareQuantile(shares, q));
  const rows = SENSITIVITY_SIZES.flatMap((mw, k) =>
    (['up', 'down'] as const).map((dir) => {
      const pairs = pub
        .map((x) => ({
          est: (dir === 'up' ? x.est.up[k] : x.est.down[k]) - x.est.base,
          pub: (dir === 'up' ? x.pub.up[k] : x.pub.down[k]) - x.pub.system,
        }))
        .filter((q) => Number.isFinite(q.est) && Number.isFinite(q.pub));
      const diffs = pairs.map((q) => q.pub - q.est);
      return [
        `買い ${dir === 'up' ? '+' : '−'}${sizeText(mw)}`,
        fmtNum(pairs.length),
        pct(share(diffs, withinPrice(0.01))),
        pct(share(diffs, withinPrice(0.1))),
        `${fmtPrice(mean(pairs.map((q) => Math.abs(q.pub))))} / ${fmtPrice(mean(pairs.map((q) => Math.abs(q.est))))} 円`,
        `${fmtPrice(mean(diffs.map(Math.abs)))} 円`,
        pct(share(pairs.map((q) => Math.abs(q.pub) - Math.abs(q.est)), (v) => v <= 0.005)),
        `${pct(q50[dir][k])}〔${pct(q25[dir][k])}〜${pct(q75[dir][k])}〕`,
      ];
    }),
  );
  out.push(
    ...table(
      ['買いの増減', 'コマ数', '動きが同じ', '差が 0.1 円以内', '動きの大きさの平均（公表値 / 目安）', '差の大きさの平均', '公表値の動きが目安以下', '効かなかった割合（中央値〔25〜75%〕）'],
      rows,
    ),
  );
  return out;
}

/** 1 コマの価格感応度（目安と公表値）と、0.01 円・高騰・売りが尽きるまでの買いの増減 */
function sensitivityDetail(sc: SensitivityChecked): string[] {
  const { est, pub } = sc;
  const rows: string[][] = [['増減なし', fmtPrice(est.base), pub ? fmtPrice(pub.system) : '']];
  SENSITIVITY_SIZES.forEach((mw, k) => {
    rows.push([`買い +${sizeText(mw)}`, fmtPrice(est.up[k]), pub ? fmtPrice(pub.up[k]) : '']);
    rows.push([`買い −${sizeText(mw)}`, fmtPrice(est.down[k]), pub ? fmtPrice(pub.down[k]) : '']);
  });
  const shift = (v: number) => (Number.isFinite(v) ? signedGw(v) : v === Number.NEGATIVE_INFINITY ? 'なし（買いが無くても）' : 'なし（売りが尽きるまで）');
  return [
    '  価格感応度（円/kWh。目安はシステムプライスのカーブをずらしたもの）',
    ...table(['買いの増減', '目安', 'JEPX の公表値'], rows, '    '),
    `  約定価格が変わる買いの増減: 0.01 円になる ${shift(est.floor)}・${SPIKE_PRICES.map((p, i) => `${p} 円を超える ${shift(est.spike[i])}`).join('・')}・売りが尽きる ${signedGw(est.limit)}`,
  ];
}

/** 1 日分のコマごとの一覧 */
function slotList(list: Checked[]): string[] {
  return [
    '',
    '■ コマごと',
    ...table(
      ['コマ', '時刻', '分断', '差の変わり方（売り / 買い）', 'ブロック入札の約定の違い', '推定: 交点 − 約定価格', '補正'],
      list.map(({ slot, c }) => [
        String(slot + 1),
        slotRangeLabel(slot),
        kindText(c),
        Number.isFinite(c.rangeSell) ? `${mw(c.rangeSell)} / ${mw(c.rangeBuy)} MW` : '',
        c.kind === 'none' ? '' : blocksText(c),
        c.estimate ? (c.estimate.available ? yen(c.estimate.cross) : '推定できない') : '',
        c.estimate?.available ? `${mw(c.estimate.correction)} MW` : '',
      ]),
      '  ',
      [1, 2, 4],
    ),
    '  差の変わり方 = システムプライス − 分断エリアの合計の、価格による変わり方。ブロック入札の約定の違い = システムプライスの計算で多く約定した量（負は少なく）',
  ];
}

/** 差を見る価格の目安（円/kWh） */
const DETAIL_PRICES = [0, 0.01, 1, 3, 5, 7.5, 10, 12.5, 15, 20, 25, 30, 40, 50, 75, 100, 200, 500, 999];

/** 1 コマの数字を詳しく */
function detail(l: Loaded, day: CurveDay, slot: number): string[] {
  const input = slotInput(l, day, slot);
  const groups = input.groups;
  const c = checkSlot(input)!;
  const system = groups.find((g) => g.id === SYSTEM_GROUP)!;
  const published = groups.filter((g) => g.id !== SYSTEM_GROUP);
  const split = slotSplit(groups);
  const vals = l.spot.get(day.day);
  const at = (k: SeriesKey) => (vals ? vals[SERIES_INDEX[k] * SLOTS + slot] : Number.NaN);
  const out: string[] = [];
  out.push('', `■ ${formatDay(day.day, true)} ${slotRangeLabel(slot)}（${slot + 1} コマ目）: ${kindText(c)}`);
  out.push(`  約定価格（円/kWh）: ${(['system', ...AREA_KEYS] as PriceKey[]).map((k) => `${k === 'system' ? 'システム' : SERIES_LABEL[k]} ${fmtPrice(input.price(k))}`).join('、')}`);
  const crossOf = (g: CurveGroup) => crossing(rowsFromSteps(g.sell, g.buy));
  const rows: string[][] = [['システムプライス', mw(totalOf(system.sell)), mw(totalOf(system.buy)), fmtPrice(crossOf(system)?.price ?? Number.NaN), fmtPrice(input.price('system'))]];
  for (const g of published) rows.push([`${g.id}: ${g.label}`, mw(totalOf(g.sell)), mw(totalOf(g.buy)), fmtPrice(crossOf(g)?.price ?? Number.NaN), fmtPrice(g.areas.length > 0 ? input.price(g.areas[0]) : Number.NaN)]);
  if (published.length > 0) {
    rows.push(['分断エリアの合計', mw(published.reduce((v, g) => v + totalOf(g.sell), 0)), mw(published.reduce((v, g) => v + totalOf(g.buy), 0)), '', '']);
    rows.push(['分断エリアの合計 − システム', signedMw(c.excessSell), signedMw(c.excessBuy), '', '']);
  }
  out.push('  入札量の合計（MW）と交点（円/kWh）', ...table(['カーブ', '売り', '買い', '交点', '約定価格'], rows, '    '));
  out.push(
    '  取引結果（MW）',
    ...table(
      ['', '入札量', 'ブロック入札', 'ブロック入札の約定', '約定総量'],
      [
        ['売り', mw(input.spot.sellBid, 1), mw(input.spot.sellBlockBid, 1), mw(input.spot.sellBlockVolume, 1), mw(kwhToMw(at('volume')), 1)],
        ['買い', mw(input.spot.buyBid, 1), mw(input.spot.buyBlockBid, 1), mw(input.spot.buyBlockVolume, 1), ''],
      ],
      '    ',
    ),
  );
  const sc = sensitivityCheck(l, day, slot);
  if (sc) out.push(...sensitivityDetail(sc));
  if (c.blocks) {
    out.push(
      `  ブロック入札の約定の違い: ${blockGapText(c.blocks)}` +
        '（システムプライスのカーブの入札量の合計と、取引結果の入札量 − 約定しなかったブロック入札 の差）',
    );
  }
  if (published.length === 0) return out;

  const d = input.residual ? residualDifference(input.residual) : curveDifference(system, published);
  const valueAt = (prices: number[], v: Float64Array, p: number, descending: boolean) => {
    // 売りはその価格以下で最も高い点、買いはその価格以上で最も安い点の値（段の間は前の点の値のまま）
    let out = Number.NaN;
    if (!descending) prices.forEach((q, k) => (q <= p + 1e-9 ? (out = v[k]) : null));
    else for (let k = prices.length - 1; k >= 0; k--) if (prices[k] >= p - 1e-9) out = v[k];
    return out;
  };
  const marks = [input.price('system'), ...c.singles.map((a) => input.price(a))].filter(Number.isFinite);
  const prices = [...new Set([...DETAIL_PRICES, ...marks].map((p) => Math.round(p * 100) / 100))].sort((a, b) => a - b);
  out.push(
    `  システムプライス − 分断エリアの合計（MW。${input.residual ? '間引く前のカーブから' : '描画用に間引いたカーブどうしの差'}）: ` +
      '価格によって変わる分が単エリアの入札で、価格によらない分は連系線でやりとりする量とブロック入札の約定の違い',
    ...table(
      ['価格（円/kWh）', '売り（この価格以下）', '買い（この価格以上）'],
      prices.map((p) => [fmtPrice(p), signedMw(valueAt(d.sellPrices, d.sell, p, false)), signedMw(valueAt(d.buyPrices, d.buy, p, true))]),
      '    ',
    ),
  );
  if (split.kind === 'split' && split.singles.length === 1) {
    const area = split.singles[0];
    const name = SERIES_LABEL[area];
    const ac = areaCurve(groups, area, input.price, { spot: input.spot, residual: input.residual })!;
    if (ac.kind !== 'single') {
      out.push(`  ${name}のカーブは推定できません（引いた差が価格によらずほぼ一定）`);
      return out;
    }
    const corr = ac.correction && ac.correction.mw > 0 ? `。約定価格で交わるように${ac.correction.side === 'sell' ? '売り' : '買い'}に ${mw(ac.correction.mw)} MW を足して補正` : '';
    out.push(
      `  推定した${name}のカーブ: ${c.blocks ? 'ブロック入札の約定の違いを差し引き、' : ''}売り・買いに ${mw(ac.lift ?? 0)} MW を足すと、` +
        `交点は ${fmtPrice(ac.rawCrossing ?? Number.NaN)} 円/kWh（約定価格 ${fmtPrice(input.price(area))} 円/kWh）${corr}`,
    );
    // 約定総量 = 分断エリアの交点の量の合計 + 単エリアの売りの量（システムプライス − 分断エリア − ブロック入札の違い）
    if (c.blocks) {
      const crossVolume = split.published.reduce((v, g) => v + (crossOf(g)?.volume ?? Number.NaN), 0);
      const p = input.price(area);
      const own = valueAt(d.sellPrices, d.sell, p, false) - c.blocks.sell;
      out.push(
        `  約定総量との突き合わせ: 分断エリアの交点の量の合計 ${mw(crossVolume)} + ${name}の売りの差（約定価格で、ブロック入札の違いを除く）${signedMw(own)} = ${mw(crossVolume + own)} MW` +
          `（取引結果の約定総量 ${mw(kwhToMw(at('volume')), 1)} MW。分断エリアの交点は描画用に間引いたカーブから）`,
      );
    }
  }
  return out;
}

export async function checkCurves(o: CheckOptions): Promise<string[]> {
  const l = await load(o);
  if (l.days.length === 0) throw new Error('指定した期間に入札カーブがありません');
  const list: Checked[] = [];
  const sens: SensitivityChecked[] = [];
  let unread = 0;
  let detailLines: string[] = [];
  for (const dayNum of l.days) {
    let day: CurveDay;
    try {
      day = decodeCurveDay(await readJson(path.join(o.data, curveDayFile(dayNum))));
    } catch {
      unread++;
      continue;
    }
    day.slots.forEach((groups, slot) => {
      if (!groups) return;
      const c = checkSlot(slotInput(l, day, slot));
      if (c) list.push({ day: dayNum, slot, c });
      const sc = sensitivityCheck(l, day, slot);
      if (sc) sens.push(sc);
      if (o.slot === slot) detailLines = detail(l, day, slot);
    });
  }
  const first = l.days[0];
  const last = l.days[l.days.length - 1];
  const out = [`入札カーブの確認: ${o.data}（${formatDay(first)}〜${formatDay(last)} の ${fmtNum(l.days.length - unread)} 日・${fmtNum(list.length)} コマ）`];
  if (unread > 0) out.push(`  読めなかった日: ${fmtNum(unread)} 日`);
  if (list.length === 0) return out;
  if (o.slot !== null) {
    if (detailLines.length === 0) out.push('', `${formatDay(first, true)} の ${o.slot + 1} コマ目の入札カーブがありません`);
    return [...out, ...detailLines];
  }
  out.push(...summary(list));
  out.push(...sensitivitySummary(sens));
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
