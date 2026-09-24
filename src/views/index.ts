import type { TabId } from '../state';
import { AreaView } from './area';
import type { View } from './base';
import { CalendarView } from './calendar';
import { CurvesView } from './curves';
import { DistributionView } from './distribution';
import { HeatmapView } from './heatmap';
import { IntradayView } from './intraday';
import { OverviewView } from './overview';
import { TableView } from './table';
import { TrendView } from './trend';
import { VolumeView } from './volume';
import { YearlyView } from './yearly';

const FACTORIES: Record<TabId, () => View> = {
  overview: () => new OverviewView(),
  trend: () => new TrendView(),
  intraday: () => new IntradayView(),
  heatmap: () => new HeatmapView(),
  calendar: () => new CalendarView(),
  distribution: () => new DistributionView(),
  area: () => new AreaView(),
  volume: () => new VolumeView(),
  curves: () => new CurvesView(),
  yearly: () => new YearlyView(),
  table: () => new TableView(),
};

export function createView(tab: TabId): View {
  return FACTORIES[tab]();
}
