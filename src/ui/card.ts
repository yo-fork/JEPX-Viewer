/**
 * グラフカード。ECharts インスタンス・リサイズ・「表で見る」切替・CSV 出力をまとめて持つ。
 * すべてのグラフに同じ内容の表（アクセシビリティ上の代替表示）を用意する。
 */
import { toCsv } from '../lib/csv';
import { fmtNum } from '../lib/format';
import { downloadText, h, uniqueId } from './dom';
import { initChart, type echarts, type EChartsOption } from './echarts';
import type { ThemeName } from './theme';

export interface TableData {
  columns: string[];
  rows: (string | number)[][];
  /** 数値列の表示桁数（null は文字列として表示） */
  digits?: (number | null)[];
  filename: string;
}

export interface CardOptions {
  title: string;
  subtitle?: string;
  height: number;
  /** グリッドの 2 列ぶんを使う */
  wide?: boolean;
  theme: ThemeName;
}

const MAX_TABLE_ROWS = 2000;

export class ChartCard {
  readonly el: HTMLElement;
  /** グラフの下に置く補足（表示・非表示でグラフの位置が動かないよう、グラフより後ろに置く） */
  readonly footer: HTMLDivElement;
  readonly chart: echarts.ECharts;
  private readonly chartEl: HTMLDivElement;
  private readonly tableEl: HTMLDivElement;
  private readonly emptyEl: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly subtitleEl: HTMLParagraphElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly csvBtn: HTMLButtonElement;
  private readonly ro: ResizeObserver;
  private table: TableData | null = null;
  private showTable = false;

  constructor(parent: HTMLElement, opts: CardOptions) {
    const titleId = uniqueId('card');
    this.titleEl = h('h3', { class: 'card-title', id: titleId }, opts.title);
    this.subtitleEl = h('p', { class: 'card-subtitle' }, opts.subtitle ?? '');
    this.toggleBtn = h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-sm', 'aria-pressed': 'false', onclick: () => this.toggleTable() },
      '表で見る',
    );
    this.csvBtn = h(
      'button',
      { type: 'button', class: 'btn btn-ghost btn-sm', onclick: () => this.downloadCsv(), title: 'この図のデータを CSV で保存' },
      'CSV',
    );
    this.chartEl = h('div', { class: 'chart', style: `height:${opts.height}px`, role: 'img', 'aria-labelledby': titleId });
    this.tableEl = h('div', { class: 'table-wrap', hidden: true });
    this.emptyEl = h('div', { class: 'card-empty', hidden: true });
    this.footer = h('div', { class: 'card-footer' });
    this.el = h(
      'figure',
      { class: `card${opts.wide ? ' card-wide' : ''}` },
      h(
        'div',
        { class: 'card-head' },
        h('div', { class: 'card-titles' }, this.titleEl, this.subtitleEl),
        h('div', { class: 'card-actions' }, this.toggleBtn, this.csvBtn),
      ),
      this.chartEl,
      this.tableEl,
      this.emptyEl,
      this.footer,
    );
    parent.append(this.el);
    this.chart = initChart(this.chartEl, opts.theme);
    this.ro = new ResizeObserver(() => this.chart.resize());
    this.ro.observe(this.chartEl);
  }

  setOption(option: EChartsOption, table: TableData | null): void {
    this.setEmpty(null);
    // 時間軸は「JST の壁時計時刻を UTC として表したミリ秒」で渡すので UTC で表示する（カレンダーは除く）
    const opt = option as Record<string, unknown>;
    this.chart.setOption({ useUTC: true, ...opt } as EChartsOption, { notMerge: true, lazyUpdate: true });
    this.table = table;
    this.csvBtn.disabled = !table;
    this.toggleBtn.disabled = !table;
    if (this.showTable) this.renderTable();
  }

  setTitle(text: string): void {
    this.titleEl.textContent = text;
  }

  setSubtitle(text: string): void {
    this.subtitleEl.textContent = text;
  }

  setHeight(px: number): void {
    if (this.chartEl.style.height !== `${px}px`) {
      this.chartEl.style.height = `${px}px`;
      this.chart.resize();
    }
  }

  /** データが無いときのメッセージ表示（null で解除） */
  setEmpty(message: string | null): void {
    const empty = message !== null;
    this.emptyEl.hidden = !empty;
    this.emptyEl.textContent = message ?? '';
    this.chartEl.hidden = empty || this.showTable;
    this.tableEl.hidden = empty || !this.showTable;
    this.toggleBtn.disabled = empty;
    this.csvBtn.disabled = empty;
    if (empty) {
      this.chart.clear();
      this.table = null;
    }
  }

  private toggleTable(): void {
    this.showTable = !this.showTable;
    this.toggleBtn.setAttribute('aria-pressed', String(this.showTable));
    this.toggleBtn.textContent = this.showTable ? 'グラフで見る' : '表で見る';
    this.chartEl.hidden = this.showTable;
    this.tableEl.hidden = !this.showTable;
    if (this.showTable) this.renderTable();
    else this.chart.resize();
  }

  private renderTable(): void {
    const t = this.table;
    if (!t) {
      this.tableEl.replaceChildren();
      return;
    }
    const digits = t.digits ?? [];
    const shown = t.rows.slice(0, MAX_TABLE_ROWS);
    const cell = (v: string | number, i: number) => {
      const d = digits[i];
      if (typeof v === 'number' && d !== null && d !== undefined) return h('td', { class: 'num' }, fmtNum(v, d));
      return h('td', { class: typeof v === 'number' ? 'num' : undefined }, typeof v === 'number' ? fmtNum(v, 2) : v);
    };
    const table = h(
      'table',
      { class: 'data-table' },
      h('thead', null, h('tr', null, t.columns.map((c, i) => h('th', { scope: 'col', class: digits[i] !== null && i > 0 ? 'num' : undefined }, c)))),
      h(
        'tbody',
        null,
        shown.map((r) => h('tr', null, r.map(cell))),
      ),
    );
    const note =
      t.rows.length > MAX_TABLE_ROWS
        ? h('p', { class: 'table-note' }, `先頭 ${fmtNum(MAX_TABLE_ROWS)} 行を表示しています（全 ${fmtNum(t.rows.length)} 行は CSV で保存できます）。`)
        : null;
    this.tableEl.replaceChildren(table, ...(note ? [note] : []));
  }

  private downloadCsv(): void {
    if (!this.table) return;
    downloadText(this.table.filename, toCsv([this.table.columns, ...this.table.rows]));
  }

  dispose(): void {
    this.ro.disconnect();
    // ヒートマップなど要素の多い図は描画が複数フレームに分かれる。途中で破棄すると zrender の
    // 次フレームの描画が例外になるため、空の状態を同期描画して保留中の描画を打ち切ってから破棄する。
    try {
      this.chart.clear();
      this.chart.getZr().refreshImmediately();
    } catch {
      /* 破棄処理は続行する */
    }
    this.chart.dispose();
    this.el.remove();
  }
}
