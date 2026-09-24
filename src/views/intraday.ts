/**
 * 時間帯：1 日の中での価格の形（日内カーブ）を、系列・季節・曜日区分・年度で比べる。
 * 下段はコマごとの価格のばらつき（箱ひげ図）。
 */
import { aggregate, seasonOfMonth, src } from '../lib/aggregate';
import { slotRangeLabel, slotStartLabel } from '../lib/dates';
import { PRICE_KEYS, SERIES_LABEL, SERIES_SHORT, SLOTS, type PriceKey } from '../lib/series';
import { accMean, quantileSorted } from '../lib/stats';
import type { IntradayMode } from '../state';
import type { ChartCard } from '../ui/card';
import { segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { ordinalColors, seriesColor, seriesDashed, TOKENS } from '../ui/theme';
import { ttHeader, ttRow } from '../ui/tooltip';
import { NO_DATA, View } from './base';
import {
  describeSelection,
  endLabels,
  grid,
  labelRoom,
  lineLegend,
  PRICE_UNIT,
  priceText,
  rangeTag,
  slotAxis,
  styledLine,
  valueAxis,
  withAlpha,
} from './common';

interface Group {
  name: string;
  color: string;
  dashed?: boolean;
  /** 強調しない（過去年度などの文脈線） */
  muted?: boolean;
  values: number[];
}

/** 冬・夏（高需要期）→ 春・秋（中間期）の順に、カテゴリ色 1〜4 を順に割り当てる */
const SEASON_ORDER = [
  { season: 3, label: '冬（12〜2月）' },
  { season: 1, label: '夏（6〜8月）' },
  { season: 0, label: '春（3〜5月）' },
  { season: 2, label: '秋（9〜11月）' },
];

const FY_COLORED = 5;

export class IntradayView extends View {
  private mode!: Segmented<IntradayMode>;
  private stat!: Segmented<'mean' | 'median'>;
  private focus!: SelectField<PriceKey>;
  private profile!: ChartCard;
  private box!: ChartCard;

  protected build(): void {
    const s = this.ctx.state;
    this.mode = segmented(
      '比べる切り口',
      [
        { value: 'series', label: '系列' },
        { value: 'season', label: '季節' },
        { value: 'daytype', label: '平日・土曜・日祝' },
        { value: 'fy', label: '年度' },
      ],
      s.intradayMode,
      (v) => this.set({ intradayMode: v }),
    );
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.stat = segmented(
      '統計量',
      [
        { value: 'mean', label: '平均' },
        { value: 'median', label: '中央値' },
      ],
      s.intradayStat,
      (v) => this.set({ intradayStat: v }),
    );
    this.root.append(toolbar(this.mode.el, this.focus.el, this.stat.el));
    const g = this.grid();
    this.profile = this.card(g, { title: '時間帯別の価格（日内カーブ）', height: 380, wide: true });
    this.box = this.card(g, { title: '時間帯別の価格のばらつき', height: 340, wide: true });
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.mode.set(state.intradayMode);
    this.stat.set(state.intradayStat);
    this.focus.set(state.focus);
    if (sel.days.length === 0) {
      this.profile.setEmpty(NO_DATA);
      this.box.setEmpty(NO_DATA);
      return;
    }
    this.renderProfile();
    this.renderBox();
  }

  private groups(): Group[] {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const median = state.intradayStat === 'median';
    const valuesOf = (key: PriceKey, groupOf: (i: number) => number, n: number): number[][] => {
      const g = aggregate(sel, src(ds, key), (i, s) => (groupOf(i) < 0 ? -1 : groupOf(i) * SLOTS + s), n * SLOTS, median);
      return Array.from({ length: n }, (_, k) =>
        sel.slots.map((s) => {
          const idx = k * SLOTS + s;
          if (!median) return accMean(g.acc[idx]);
          return quantileSorted(Float64Array.from(g.values![idx]).sort(), 0.5);
        }),
      );
    };

    switch (state.intradayMode) {
      case 'series':
        return state.series.map((k) => ({
          name: SERIES_SHORT[k],
          color: seriesColor(k, theme),
          dashed: seriesDashed(k),
          values: valuesOf(k, () => 0, 1)[0],
        }));
      case 'season': {
        const v = valuesOf(state.focus, (i) => seasonOfMonth(ds.m[i]), 4);
        return SEASON_ORDER.map((o, i) => ({ name: o.label, color: t.cat[i], values: v[o.season] }));
      }
      case 'daytype': {
        // 0: 平日, 1: 土曜（祝日を除く）, 2: 日曜・祝日
        const v = valuesOf(state.focus, (i) => (ds.holiday[i] || ds.dow[i] === 0 ? 2 : ds.dow[i] === 6 ? 1 : 0), 3);
        return ['平日', '土曜', '日曜・祝日'].map((name, i) => ({ name, color: t.cat[i], values: v[i] }));
      }
      case 'fy': {
        const fys = [...new Set([...sel.days].map((i) => ds.fy[i]))].sort((a, b) => a - b);
        const index = new Map(fys.map((fy, k) => [fy, k]));
        const v = valuesOf(state.focus, (i) => index.get(ds.fy[i]) ?? -1, fys.length);
        const colored = fys.slice(-FY_COLORED);
        const ramp = ordinalColors(colored.length, theme);
        return fys.map((fy, k) => {
          const c = colored.indexOf(fy);
          return c >= 0
            ? { name: `${fy}年度`, color: ramp[c], values: v[k] }
            : { name: `${fy}年度`, color: t.deemph, muted: true, values: v[k] };
        });
      }
    }
  }

  private renderProfile(): void {
    const { sel, state, theme } = this.ctx;
    const groups = this.groups();
    const statLabel = state.intradayStat === 'median' ? '中央値' : '平均';
    const target = state.intradayMode === 'series' ? '' : `・${SERIES_LABEL[state.focus]}`;
    const mutedCount = groups.filter((g) => g.muted).length;
    this.profile.setSubtitle(
      `${describeSelection(sel, state)}${target}・コマごとの${statLabel}${state.intradayMode === 'fy' ? `・${theme === 'light' ? '色が濃い' : '色が明るい'}ほど新しい年度` : ''}${mutedCount ? `（灰色は古い ${mutedCount} 年度）` : ''}`,
    );
    const ends = endLabels(
      groups.map((g) => g.name.replace(/（.*）/, '')),
      groups.map((g) => g.values),
      theme,
      300,
    );
    this.profile.setOption(
      {
        grid: grid({ right: labelRoom(groups.length) }),
        legend: lineLegend(groups),
        tooltip: {
          trigger: 'axis',
          formatter: (params: { seriesIndex: number; dataIndex: number }[]) => {
            if (!params.length) return '';
            let html = ttHeader(slotRangeLabel(sel.slots[params[0].dataIndex]));
            for (const p of params) {
              const g = groups[p.seriesIndex];
              html += ttRow(g.color, priceText(g.values[p.dataIndex]), g.name, g.dashed ? 'dash' : 'line');
            }
            return html;
          },
        },
        xAxis: slotAxis(sel.slots),
        yAxis: valueAxis(),
        series: groups.map((g, i) =>
          styledLine(g.name, g.color, theme, g.values, g.dashed, {
            z: g.muted ? 1 : 2 + i,
            lineStyle: { width: g.muted ? 1 : 2, type: g.dashed ? [6, 4] : 'solid' },
            ...ends[i],
          }),
        ),
      },
      {
        columns: ['時刻', ...groups.map((g) => `${g.name}（${PRICE_UNIT}）`)],
        rows: sel.slots.map((s, r) => [slotStartLabel(s), ...groups.map((g) => g.values[r])]),
        digits: [null, ...groups.map(() => 2)],
        filename: `jepx_intraday_${state.intradayMode}_${rangeTag(sel)}.csv`,
      },
    );
  }

  private renderBox(): void {
    const { sel, ds, state, theme } = this.ctx;
    const t = TOKENS[theme];
    const g = aggregate(sel, src(ds, state.focus), (_i, s) => s, SLOTS, true);
    const stats = sel.slots.map((s) => {
      const v = Float64Array.from(g.values![s]).sort();
      return {
        p10: quantileSorted(v, 0.1),
        p25: quantileSorted(v, 0.25),
        med: quantileSorted(v, 0.5),
        p75: quantileSorted(v, 0.75),
        p90: quantileSorted(v, 0.9),
        mean: accMean(g.acc[s]),
        min: g.acc[s].min,
        max: g.acc[s].max,
      };
    });
    this.box.setSubtitle(`${describeSelection(sel, state)}・${SERIES_LABEL[state.focus]}・箱は 25〜75%点、ひげは 10〜90%点、中の線は中央値`);
    this.box.setOption(
      {
        grid: grid({ top: 28 }),
        tooltip: {
          trigger: 'item',
          formatter: (p: { dataIndex: number }) => {
            const s = stats[p.dataIndex];
            return (
              ttHeader(`${slotRangeLabel(sel.slots[p.dataIndex])}・${SERIES_SHORT[state.focus]}`) +
              [
                ['90%点', s.p90],
                ['75%点', s.p75],
                ['中央値', s.med],
                ['25%点', s.p25],
                ['10%点', s.p10],
                ['平均', s.mean],
                ['最高', s.max],
                ['最低', s.min],
              ]
                .map(([l, v]) => ttRow(t.cat[0], priceText(v as number), l as string, 'none'))
                .join('')
            );
          },
        },
        xAxis: { type: 'category', data: sel.slots.map(slotStartLabel), axisLabel: { interval: (i: number) => sel.slots[i] % 4 === 0, hideOverlap: true } },
        yAxis: valueAxis(),
        series: [
          {
            type: 'boxplot',
            data: stats.map((s) => [s.p10, s.p25, s.med, s.p75, s.p90]),
            boxWidth: [3, 14],
            itemStyle: { color: withAlpha(t.cat[0], 0.16), borderColor: t.cat[0], borderWidth: 1.5 },
            emphasis: { itemStyle: { borderWidth: 2, color: withAlpha(t.cat[0], 0.3) } },
          },
        ],
      },
      {
        columns: ['時刻', '10%点', '25%点', '中央値', '75%点', '90%点', '平均', '最低', '最高'],
        rows: stats.map((s, r) => [slotStartLabel(sel.slots[r]), s.p10, s.p25, s.med, s.p75, s.p90, s.mean, s.min, s.max]),
        digits: [null, 2, 2, 2, 2, 2, 2, 2, 2],
        filename: `jepx_intraday_box_${state.focus}_${rangeTag(sel)}.csv`,
      },
    );
  }
}
