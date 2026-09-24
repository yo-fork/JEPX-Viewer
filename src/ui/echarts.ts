/**
 * ECharts の初期化（必要なチャート・コンポーネントだけを取り込む）とテーマ登録。
 */
import * as echarts from 'echarts/core';
import { BarChart, BoxplotChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  CalendarComponent,
  DataZoomComponent,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import langJA from 'echarts/lib/i18n/langJA.js';
import { FONT_FAMILY, TOKENS, type ThemeName } from './theme';

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  ScatterChart,
  BoxplotChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  GraphicComponent,
  VisualMapComponent,
  CalendarComponent,
  MarkLineComponent,
  CanvasRenderer,
]);
echarts.registerLocale('JA', langJA as Parameters<typeof echarts.registerLocale>[1]);

function buildTheme(name: ThemeName): object {
  const t = TOKENS[name];
  const axisCommon = {
    axisLine: { show: true, lineStyle: { color: t.axis, width: 1 } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, fontFamily: FONT_FAMILY },
    splitLine: { show: false, lineStyle: { color: t.grid, width: 1, type: 'solid' } },
    nameTextStyle: { color: t.muted, fontSize: 11 },
  };
  return {
    color: t.cat,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT_FAMILY, color: t.ink2 },
    legend: {
      textStyle: { color: t.ink2, fontSize: 12 },
      inactiveColor: t.axis,
      pageTextStyle: { color: t.muted },
      pageIconColor: t.ink2,
      pageIconInactiveColor: t.axis,
    },
    tooltip: {
      backgroundColor: t.raised,
      borderColor: t.border,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: t.ink, fontSize: 12, fontFamily: FONT_FAMILY },
      extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,0.12); border-radius: 8px;',
      axisPointer: {
        lineStyle: { color: t.muted, width: 1 },
        crossStyle: { color: t.muted, width: 1 },
        shadowStyle: { color: name === 'light' ? 'rgba(11,11,11,0.04)' : 'rgba(255,255,255,0.05)' },
        label: { backgroundColor: t.ink2, color: t.surface },
      },
    },
    categoryAxis: axisCommon,
    timeAxis: axisCommon,
    valueAxis: {
      ...axisCommon,
      axisLine: { show: false },
      splitLine: { show: true, lineStyle: { color: t.grid, width: 1, type: 'solid' } },
    },
    line: { symbol: 'none', lineStyle: { width: 2, cap: 'round', join: 'round' } },
    bar: { itemStyle: { borderRadius: [4, 4, 0, 0] } },
    dataZoom: {
      borderColor: t.border,
      backgroundColor: 'transparent',
      fillerColor: name === 'light' ? 'rgba(42,120,214,0.10)' : 'rgba(57,135,229,0.16)',
      handleStyle: { color: t.surface, borderColor: t.axis },
      moveHandleStyle: { color: t.axis },
      textStyle: { color: t.muted },
      dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
      selectedDataBackground: { lineStyle: { color: t.cat[0] }, areaStyle: { color: t.cat[0], opacity: 0.1 } },
      brushStyle: { color: 'rgba(0,0,0,0.05)' },
    },
    visualMap: { textStyle: { color: t.muted } },
    calendar: {
      itemStyle: { color: 'transparent', borderColor: t.surface, borderWidth: 2 },
      splitLine: { show: false },
      dayLabel: { color: t.muted },
      monthLabel: { color: t.muted },
      yearLabel: { color: t.ink2 },
    },
  };
}

echarts.registerTheme('jv-light', buildTheme('light'));
echarts.registerTheme('jv-dark', buildTheme('dark'));

export function initChart(el: HTMLElement, theme: ThemeName): echarts.ECharts {
  return echarts.init(el, theme === 'dark' ? 'jv-dark' : 'jv-light', { renderer: 'canvas', locale: 'JA' });
}

export { echarts };
export type EChartsOption = Parameters<echarts.ECharts['setOption']>[0];
