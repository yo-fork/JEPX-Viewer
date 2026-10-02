/**
 * 入札カーブのタブの「市場分断の境をまたいだ量」: 市場分断したコマで、分断エリアの間を連系線でやりとりした量を、
 * 公表されている分断エリアのカーブと取引結果から求める（lib/interties.ts）。1 コマの図の下の説明と、期間の図。
 */
import { priceSplit, type SpotBids } from '../lib/areaCurves';
import { groupTotalsOf, SYSTEM_GROUP, type CurveDay } from '../lib/bidCurves';
import type { CurveStore } from '../lib/curveStore';
import { formatDay, slotRangeLabel, wallClockMs } from '../lib/dates';
import { fmtNum } from '../lib/format';
import { boundaryFlow, boundaryName, FLOW_FAILURE_TEXT, groupName, signedFlow, type BoundaryFlow, type FlowFailure } from '../lib/interties';
import { crossingFlows, INTERTIE_DEFS, INTERTIE_INDEX, type IntertieKey } from '../lib/occto';
import { kwhToMw, SERIES_INDEX, SERIES_LABEL, SLOTS, type AreaKey, type SeriesKey } from '../lib/series';
import type { Selection } from '../lib/select';
import type { Dataset } from '../lib/store';
import type { ChartCard } from '../ui/card';
import { TOKENS } from '../ui/theme';
import { ttHeader, ttNote, ttRow } from '../ui/tooltip';
import type { ViewContext } from './base';
import { describeSelection, grid, rangeTag, valueAxis } from './common';
import { slotZoom, wrappedLegend } from './curveCommon';
import { TIME_AXIS_LABEL } from './timeseries';

/** 期間の図に、境ごとの系列として出す数（ほかは「そのほかの境」にまとめる） */
const TOP_BOUNDARIES = 6;
const OTHER_NAME = 'そのほかの境';
const MANY_NAME = '3 つ以上に分かれたコマ（受け入れの合計）';

/** 取引結果の値（入札量は kWh。無ければ NaN） */
function valueAt(ds: Dataset, day: number, slot: number, key: SeriesKey): number {
  const i = day - ds.start;
  return i < 0 || i >= ds.n ? Number.NaN : ds.values[SERIES_INDEX[key]][i * SLOTS + slot];
}

/** 取引結果の入札量とブロック入札の量（MW） */
function spotBidsOf(ds: Dataset, day: number, slot: number): SpotBids {
  const v = (k: SeriesKey) => kwhToMw(valueAt(ds, day, slot, k));
  return {
    sellBid: v('sellBid'),
    buyBid: v('buyBid'),
    sellBlockBid: v('sellBlockBid'),
    sellBlockVolume: v('sellBlockVolume'),
    buyBlockBid: v('buyBlockBid'),
    buyBlockVolume: v('buyBlockVolume'),
  };
}

const lastOf = (a: Float64Array) => (a.length >= 2 ? a[a.length - 1] : 0);

/**
 * 1 コマの、分断エリアの間を連系線でやりとりした量（日のファイルから）。
 * デモの合成カーブは取引結果と別に作っているので、システムプライスのカーブとの差から求める
 */
export function flowOfDay(ds: Dataset, day: CurveDay, slot: number, demo: boolean): { flow: BoundaryFlow | FlowFailure | null; groups: AreaKey[][] | null } {
  const price = (a: AreaKey) => valueAt(ds, day.day, slot, a);
  const system = day.slots[slot]?.find((g) => g.id === SYSTEM_GROUP);
  const groups = priceSplit(price);
  const flow = boundaryFlow({
    groups,
    price,
    published: groupTotalsOf(day, slot),
    spot: demo ? null : spotBidsOf(ds, day.day, slot),
    system: system ? { sell: lastOf(system.sell), buy: lastOf(system.buy) } : null,
  });
  return { flow, groups };
}

const names = (areas: readonly AreaKey[]) => areas.map((a) => SERIES_LABEL[a]).join('・');

/**
 * 1 コマの図の下の説明（市場分断していなければ空）。
 * plan を渡すと、広域機関が公表している、境をまたぐ連系線ごとの計画潮流（翌日）も並べる（単エリアのあるコマや、3 つ以上に分かれたコマでも境ごとに分かる）
 */
export function flowText(
  x: { flow: BoundaryFlow | FlowFailure | null; groups: AreaKey[][] | null },
  plan: ((key: IntertieKey) => number) | null = null,
): string {
  const f = x.flow;
  if (f === null) return '';
  const how = '公表されている分断エリアのカーブと取引結果から求めた量';
  let text =
    typeof f === 'string'
      ? `連系線: ${FLOW_FAILURE_TEXT[f]}。`
      : f.kind === 'pair'
        ? `連系線: ${groupName(f.from)} から ${groupName(f.to)} へ ${fmtNum(f.mw)} MW（${how}。境に連系線が複数あれば、その合計）。`
        : `連系線: ${f.groups.length} つに分かれたため境ごとには分けられず、分断エリアのカーブに入っている受け入れの量の合計は ${fmtNum(f.mw)} MW です（${how}）。`;
  const cross = plan && x.groups ? crossingFlows(x.groups, plan) : [];
  if (cross.length > 0) {
    const items = cross.map((c) => {
      const d = INTERTIE_DEFS[INTERTIE_INDEX[c.key]];
      if (c.plan === 0) return `${d.label} 0 MW`;
      return c.plan > 0 ? `${d.label} ${fmtNum(c.plan)} MW（${names(d.from)} → ${names(d.to)}）` : `${d.label} ${fmtNum(-c.plan)} MW（${names(d.to)} → ${names(d.from)}）`;
    });
    text += `広域機関が公表している翌日の計画潮流では、境をまたぐ連系線は ${items.join('、')}です。`;
  }
  return text;
}

interface FlowPoint {
  ms: number;
  day: number;
  slot: number;
  flow: BoundaryFlow;
  /** 図の縦軸の値（2 つに分かれたときは向き付き、3 つ以上は合計） */
  value: number;
}

/** 選んだ期間の、市場分断したコマの量（期間の図） */
export function renderFlowPeriod(card: ChartCard, ctx: ViewContext, cs: CurveStore, sel: Selection): void {
  const { ds, state, theme } = ctx;
  const t = TOKENS[theme];
  if (!cs.hasGroups) {
    card.setSubtitle('');
    card.setEmpty('入札カーブの指標の年度ファイルに、分断エリアのカーブの入札量の合計がありません（前の版で作ったファイルです）。npm run fetch を実行すると作り直します。');
    return;
  }
  const pubSell = cs.groupArray(ds, 0);
  const pubBuy = cs.groupArray(ds, 1);
  const pubCount = cs.groupArray(ds, 2);
  const sysSell = cs.metricArray(ds, 'sellTotal');
  const sysBuy = cs.metricArray(ds, 'buyTotal');
  const points: FlowPoint[] = [];
  const failures = new Map<FlowFailure, number>();
  let split = 0;
  for (const i of sel.days) {
    const day = ds.start + i;
    for (let s = 0; s < SLOTS; s++) {
      if (!sel.slotMask[s]) continue;
      const k = i * SLOTS + s;
      if (!Number.isFinite(pubCount[k])) continue;
      const price = (a: AreaKey) => ds.values[SERIES_INDEX[a]][k];
      const f = boundaryFlow({
        groups: priceSplit(price),
        price,
        published: { sell: pubSell[k], buy: pubBuy[k], count: pubCount[k] },
        spot: cs.isDemo ? null : spotBidsOf(ds, day, s),
        system: { sell: sysSell[k], buy: sysBuy[k] },
      });
      if (f === null) continue;
      split++;
      if (typeof f === 'string') {
        failures.set(f, (failures.get(f) ?? 0) + 1);
        continue;
      }
      points.push({ ms: wallClockMs(day, s), day, slot: s, flow: f, value: f.kind === 'pair' ? signedFlow(f) : f.mw });
    }
  }
  const fail = [...failures].map(([k, n]) => `${{ single: '単エリアがある', groups: '分断エリアの数が合わない', blocks: 'ブロック入札の量が無い', mismatch: '売りと買いで合わない' }[k]} ${fmtNum(n)}`);
  card.setSubtitle(
    `${describeSelection(sel, state)}・市場分断したコマで、分断エリアの間を連系線でやりとりした量（MW。公表されている分断エリアのカーブと取引結果から）・` +
      '2 つに分かれたコマは境をまたいだ量（正は北海道を含む側から、負は逆の向き）、3 つ以上に分かれたコマは分断エリアのカーブに入っている受け入れの量の合計（凡例で選ぶと表示）・' +
      `市場分断した ${fmtNum(split)} コマのうち ${fmtNum(points.length)} コマ${fail.length > 0 ? `（求められないコマ: ${fail.join('、')}）` : ''}`,
  );
  if (points.length === 0) {
    card.setEmpty(split === 0 ? '選んだ期間に、市場分断したコマはありません。' : '選んだ期間に、連系線の量を求められるコマはありません（単エリアのあるコマでは求められません）。');
    return;
  }

  // 境ごとの系列（コマの多い順に TOP_BOUNDARIES まで。ほかはまとめる）
  const count = new Map<string, number>();
  for (const p of points) if (p.flow.kind === 'pair') count.set(boundaryName(p.flow.groups), (count.get(boundaryName(p.flow.groups)) ?? 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1]).slice(0, TOP_BOUNDARIES).map(([k]) => k);
  const seriesOf = (p: FlowPoint) => (p.flow.kind === 'many' ? MANY_NAME : top.includes(boundaryName(p.flow.groups)) ? boundaryName(p.flow.groups) : OTHER_NAME);
  const names = [...top, ...(points.some((p) => seriesOf(p) === OTHER_NAME) ? [OTHER_NAME] : []), ...(points.some((p) => p.flow.kind === 'many') ? [MANY_NAME] : [])];
  const colorOf = (name: string) => (name === OTHER_NAME || name === MANY_NAME ? t.neutralSeries : t.cat[top.indexOf(name) % t.cat.length]);
  const zoom = slotZoom('slot');
  const legend = wrappedLegend(names, card.chart.getWidth(), undefined, names.map((n) => (n === MANY_NAME ? 'emptyCircle' : 'circle')));
  const byName = new Map(names.map((n) => [n, [] as FlowPoint[]]));
  for (const p of points) byName.get(seriesOf(p))!.push(p);
  const direction = (f: BoundaryFlow) => (f.kind === 'pair' ? `${groupName(f.from)} → ${groupName(f.to)}` : f.groups.map(groupName).join(' / '));

  card.setOption(
    {
      grid: grid({ top: legend.top + 8, right: 24, bottom: zoom.bottom }),
      // 3 つ以上に分かれたコマの合計は、境ごとの量より大きく縦軸が広がるので、凡例で選んだときだけ出す
      legend: { ...legend.legend, selected: { [MANY_NAME]: false } },
      ...(zoom.dataZoom ? { dataZoom: zoom.dataZoom } : {}),
      tooltip: {
        trigger: 'item',
        formatter: (param: { seriesName: string; data: { p: FlowPoint } }) => {
          const p = param.data.p;
          const f = p.flow;
          return (
            ttHeader(`${formatDay(p.day, true)} ${slotRangeLabel(p.slot)}`) +
            ttRow(colorOf(param.seriesName), `${fmtNum(f.mw)} MW`, f.kind === 'pair' ? direction(f) : `${f.groups.length} つに分断（受け入れの合計）`, 'rect') +
            (f.kind === 'many' ? ttNote(direction(f)) : '')
          );
        },
      },
      xAxis: { type: 'time', axisLabel: TIME_AXIS_LABEL },
      yAxis: valueAxis('MW'),
      series: names.map((name) => ({
        name,
        type: 'scatter',
        symbol: name === MANY_NAME ? 'emptyCircle' : 'circle',
        symbolSize: 6,
        itemStyle: { color: colorOf(name) },
        emphasis: { scale: 1.6 },
        data: byName.get(name)!.map((p) => ({ value: [p.ms, p.value], p })),
        ...(name === names[0] ? { markLine: { symbol: 'none', silent: true, animation: false, lineStyle: { color: t.axis, width: 1, type: 'solid' }, label: { show: false }, data: [{ yAxis: 0 }] } } : {}),
      })),
    },
    {
      columns: ['日時', '分かれ方', '向き（送る側 → 受ける側）', '量（MW）', '図の値（MW）', '売りから求めた量（MW）', '買いから求めた量（MW）'],
      rows: points.map((p) => [
        `${formatDay(p.day, true)} ${slotRangeLabel(p.slot)}`,
        p.flow.kind === 'pair' ? boundaryName(p.flow.groups) : `${p.flow.groups.length} つに分断`,
        direction(p.flow),
        p.flow.mw,
        p.value,
        p.flow.sell,
        p.flow.buy,
      ]),
      digits: [null, null, null, 1, 1, 1, 1],
      filename: `jepx_intertie_flows_${rangeTag(sel)}.csv`,
    },
  );
}
