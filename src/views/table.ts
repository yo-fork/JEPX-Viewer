/**
 * 統計表：任意の集計単位で、全エリアの平均または 1 系列の統計量を一覧にして CSV で持ち出す。
 */
import { aggregate, buildPeriods } from '../lib/aggregate';
import { toCsv } from '../lib/csv';
import { formatDay, slotRangeLabel } from '../lib/dates';
import { fmtNum } from '../lib/format';
import { formatSpotCsv, type DayMap } from '../lib/jepxCsv';
import { PRICE_KEYS, SERIES_COUNT, SERIES_INDEX, SERIES_LABEL, SERIES_SHORT, SLOTS, isFloorPrice, type PriceKey } from '../lib/series';
import { accMean, accStd, quantileSorted } from '../lib/stats';
import type { TableKind, TableUnit } from '../state';
import { numberField, segmented, selectField, toolbar, type Segmented, type SelectField } from '../ui/controls';
import { downloadText, h } from '../ui/dom';
import { NO_DATA, View } from './base';
import { describeSelection, monthLabel, PRICE_UNIT, rangeTag } from './common';
import { periodLabel } from './timeseries';

const UNIT_OPTIONS: { value: TableUnit; label: string }[] = [
  { value: 'day', label: '日' },
  { value: 'week', label: '週' },
  { value: 'month', label: '月' },
  { value: 'fy', label: '年度' },
  { value: 'year', label: '暦年' },
  { value: 'dow', label: '曜日' },
  { value: 'slot', label: '時刻' },
  { value: 'all', label: '全体' },
];
const DOW = ['月', '火', '水', '木', '金', '土', '日', '祝日'];
const MAX_ROWS = 2000;

interface Table {
  columns: string[];
  rows: (string | number)[][];
  digits: (number | null)[];
}

export class TableView extends View {
  private unit!: Segmented<TableUnit>;
  private kind!: Segmented<TableKind>;
  private focus!: SelectField<PriceKey>;
  private threshold!: { el: HTMLElement; set(v: number): void };
  private title!: HTMLElement;
  private subtitle!: HTMLElement;
  private wrap!: HTMLElement;
  private note!: HTMLElement;
  private current: Table | null = null;

  protected build(): void {
    const s = this.ctx.state;
    this.unit = segmented('集計単位', UNIT_OPTIONS, s.tableUnit, (v) => this.set({ tableUnit: v }));
    this.kind = segmented(
      '表の内容',
      [
        { value: 'areas', label: '全系列の平均' },
        { value: 'stats', label: '1 系列の統計量' },
      ],
      s.tableKind,
      (v) => this.set({ tableKind: v }),
    );
    this.focus = selectField('対象', PRICE_KEYS.map((k) => ({ value: k, label: SERIES_LABEL[k] })), s.focus, (v) => this.set({ focus: v }));
    this.threshold = numberField('しきい値', s.threshold, { min: 0, max: 1000, step: 1, unit: '円/kWh 以上' }, (v) => this.set({ threshold: v }));
    this.root.append(toolbar(this.unit.el, this.kind.el, this.focus.el, this.threshold.el));

    this.title = h('h3', { class: 'card-title' }, '統計表');
    this.subtitle = h('p', { class: 'card-subtitle' });
    this.wrap = h('div', { class: 'table-wrap' });
    this.note = h('p', { class: 'table-note' });
    const card = h(
      'section',
      { class: 'card standalone-table' },
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-titles' }, this.title, this.subtitle),
        h(
          'div',
          { class: 'card-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.downloadTable() }, 'この表を CSV で保存'),
          h(
            'button',
            { type: 'button', class: 'btn btn-sm', onclick: () => this.downloadRaw(), title: '絞り込み条件に合う 30 分値を JEPX と同じ列名で保存' },
            '30分値を CSV で保存',
          ),
        ),
      ),
      this.wrap,
      this.note,
    );
    this.root.append(card);
  }

  protected render(): void {
    const { sel, state } = this.ctx;
    this.unit.set(state.tableUnit);
    this.kind.set(state.tableKind);
    this.focus.set(state.focus);
    this.threshold.set(state.threshold);
    this.focus.setDisabled(state.tableKind === 'areas');
    this.threshold.el.classList.toggle('is-disabled', state.tableKind === 'areas');
    if (sel.days.length === 0) {
      this.current = null;
      this.wrap.replaceChildren(h('p', { class: 'card-empty' }, NO_DATA));
      this.note.textContent = '';
      return;
    }
    const table = state.tableKind === 'areas' ? this.areaTable() : this.statsTable();
    this.current = table;
    const unitLabel = UNIT_OPTIONS.find((u) => u.value === state.tableUnit)!.label;
    this.title.textContent = state.tableKind === 'areas' ? `${unitLabel}別の平均価格（全系列）` : `${unitLabel}別の統計量（${SERIES_LABEL[state.focus]}）`;
    this.subtitle.textContent =
      state.tableKind === 'areas'
        ? `${describeSelection(sel, state)}・価格は ${PRICE_UNIT}（30 分値の単純平均）、約定総量は百万kWh`
        : `${describeSelection(sel, state)}・${PRICE_UNIT}`;
    this.renderTable(table);
  }

  private groups(): { labels: string[]; groupOf: (i: number, s: number) => number } {
    const { sel, ds, state } = this.ctx;
    const unit = state.tableUnit;
    if (unit === 'dow') return { labels: DOW, groupOf: (i) => (ds.holiday[i] ? 7 : (ds.dow[i] + 6) % 7) };
    if (unit === 'slot') {
      const row = new Int32Array(SLOTS).fill(-1);
      sel.slots.forEach((s, r) => (row[s] = r));
      return { labels: sel.slots.map(slotRangeLabel), groupOf: (_i, s) => row[s] };
    }
    if (unit === 'all') return { labels: [`${formatDay(sel.from)}〜${formatDay(sel.to)}`], groupOf: () => 0 };
    const periods = buildPeriods(sel, unit);
    const labels = periods.starts.map((d) => (unit === 'month' ? monthLabel(d) : unit === 'day' ? formatDay(d, true) : periodLabel(d * 86_400_000, unit)));
    return { labels, groupOf: (i) => periods.ofDay[i] };
  }

  private areaTable(): Table {
    const { sel, ds } = this.ctx;
    const { labels, groupOf } = this.groups();
    const n = labels.length;
    const means = PRICE_KEYS.map((k) => {
      const g = aggregate(sel, { a: ds.values[SERIES_INDEX[k]] }, groupOf, n);
      return g.acc.map(accMean);
    });
    const vol = aggregate(sel, { a: ds.values[SERIES_INDEX.volume] }, groupOf, n);
    return {
      columns: ['区分', ...PRICE_KEYS.map((k) => SERIES_SHORT[k]), '約定総量', 'コマ数'],
      rows: labels.map((l, r) => [l, ...means.map((m) => m[r]), vol.acc[r].n ? vol.acc[r].sum / 1e6 : '', vol.acc[r].n]),
      digits: [null, ...PRICE_KEYS.map(() => 2), 1, 0],
    };
  }

  private statsTable(): Table {
    const { sel, ds, state } = this.ctx;
    const { labels, groupOf } = this.groups();
    const n = labels.length;
    const key = state.focus;
    const g = aggregate(sel, { a: ds.values[SERIES_INDEX[key]] }, groupOf, n, true);
    const th = state.threshold;
    const withVwap = key === 'system';
    const pw = new Float64Array(n);
    const w = new Float64Array(n);
    if (withVwap) {
      const p = ds.values[SERIES_INDEX.system];
      const v = ds.values[SERIES_INDEX.volume];
      for (const i of sel.days) {
        for (const s of sel.slots) {
          const k = groupOf(i, s);
          const pi = p[i * SLOTS + s];
          const vi = v[i * SLOTS + s];
          if (k < 0 || Number.isNaN(pi) || Number.isNaN(vi)) continue;
          pw[k] += pi * vi;
          w[k] += vi;
        }
      }
    }
    const rows = labels.map((l, r) => {
      const acc = g.acc[r];
      const vals = Float64Array.from(g.values![r]).sort();
      let over = 0;
      for (const v of vals) if (v >= th) over++;
      let floor = 0;
      for (const v of vals) if (isFloorPrice(v)) floor++;
      const row: (string | number)[] = [
        l,
        acc.n,
        accMean(acc),
        quantileSorted(vals, 0.5),
        acc.n ? acc.max : Number.NaN,
        acc.n ? acc.min : Number.NaN,
        accStd(acc),
        quantileSorted(vals, 0.1),
        quantileSorted(vals, 0.9),
        floor,
        over,
      ];
      if (withVwap) row.push(w[r] > 0 ? pw[r] / w[r] : Number.NaN);
      return row;
    });
    return {
      columns: [
        '区分',
        'コマ数',
        '平均',
        '中央値',
        '最高',
        '最低',
        '標準偏差',
        '10%点',
        '90%点',
        '0.01円のコマ',
        `${fmtNum(th, th % 1 ? 1 : 0)}円以上のコマ`,
        ...(withVwap ? ['約定量加重平均'] : []),
      ],
      rows,
      digits: [null, 0, 2, 2, 2, 2, 2, 2, 2, 0, 0, ...(withVwap ? [2] : [])],
    };
  }

  private renderTable(t: Table): void {
    const shown = t.rows.slice(0, MAX_ROWS);
    const cell = (v: string | number, i: number) => {
      const d = t.digits[i];
      if (typeof v === 'number') return h('td', { class: 'num' }, Number.isFinite(v) ? fmtNum(v, d ?? 2) : '—');
      return h('td', { class: i > 0 ? 'num' : undefined }, v);
    };
    this.wrap.replaceChildren(
      h(
        'table',
        { class: 'data-table' },
        h('thead', null, h('tr', null, t.columns.map((c, i) => h('th', { scope: 'col', class: i > 0 ? 'num' : undefined }, c)))),
        h(
          'tbody',
          null,
          shown.map((r) => h('tr', null, r.map(cell))),
        ),
      ),
    );
    this.note.textContent =
      t.rows.length > MAX_ROWS ? `先頭 ${fmtNum(MAX_ROWS)} 行を表示しています（全 ${fmtNum(t.rows.length)} 行は CSV で保存できます）。` : `${fmtNum(t.rows.length)} 行`;
  }

  private downloadTable(): void {
    if (!this.current) return;
    const { sel, state } = this.ctx;
    const rows = this.current.rows.map((r) => r.map((v) => (typeof v === 'number' && !Number.isFinite(v) ? '' : v)));
    downloadText(`jepx_table_${state.tableKind}_${state.tableUnit}_${rangeTag(sel)}.csv`, toCsv([this.current.columns, ...rows]));
  }

  /** 絞り込み条件（期間・曜日・時間帯）に合う 30 分値を JEPX 形式の列名で保存 */
  private downloadRaw(): void {
    const { sel, ds } = this.ctx;
    const days: DayMap = new Map();
    for (const i of sel.days) {
      const vals = new Float64Array(SERIES_COUNT * SLOTS);
      for (let s = 0; s < SERIES_COUNT; s++) vals.set(ds.values[s].subarray(i * SLOTS, (i + 1) * SLOTS), s * SLOTS);
      days.set(ds.start + i, vals);
    }
    const csv = formatSpotCsv(days, (_day, slot) => sel.slotMask[slot] === 1);
    downloadText(`jepx_spot_30min_${rangeTag(sel)}.csv`, csv);
  }
}
