/**
 * 統計タイル（ラベル・値・補足・前期間との差）。
 */
import { h } from './dom';

export interface StatTile {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  delta?: string;
}

export function renderTiles(container: HTMLElement, tiles: StatTile[]): void {
  container.replaceChildren(
    ...tiles.map((t) =>
      h(
        'div',
        { class: 'kpi' },
        h('div', { class: 'kpi-label' }, t.label),
        h('div', { class: 'kpi-value' }, t.value, t.unit ? h('span', { class: 'kpi-unit' }, t.unit) : null),
        t.delta ? h('div', { class: 'kpi-delta' }, t.delta) : null,
        t.sub ? h('div', { class: 'kpi-sub' }, t.sub) : null,
      ),
    ),
  );
}
