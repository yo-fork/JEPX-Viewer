/**
 * 画面上部の絞り込み行（期間 → 曜日区分 → 時間帯 → 表示系列）。すべてのタブに共通で効く。
 */
import { isoFromDay, parseDateString, slotStartLabel } from '../lib/dates';
import { PRICE_KEYS, SERIES_SHORT, SLOTS, type PriceKey } from '../lib/series';
import { SLOT_PRESETS, fiscalYearsIn, type AppState, type Extent, type SlotPresetId } from '../state';
import { h, uniqueId } from './dom';
import { seriesColor, seriesDashed, type ThemeName } from './theme';

export type FilterPatch = Partial<Pick<AppState, 'preset' | 'from' | 'to' | 'dayType' | 'slotPreset' | 'slotStart' | 'slotEnd' | 'series'>>;

const RANGE_PRESETS: [string, string][] = [
  ['last7', '直近7日'],
  ['last30', '直近30日'],
  ['last90', '直近90日'],
  ['last365', '直近1年'],
];

export class FilterBar {
  readonly el: HTMLElement;
  private readonly preset: HTMLSelectElement;
  private readonly fromInput: HTMLInputElement;
  private readonly toInput: HTMLInputElement;
  private readonly dayType: HTMLSelectElement;
  private readonly slotPreset: HTMLSelectElement;
  private readonly slotStart: HTMLSelectElement;
  private readonly slotEnd: HTMLSelectElement;
  private readonly customSlots: HTMLElement;
  private readonly chips = new Map<PriceKey, HTMLButtonElement>();
  private readonly status: HTMLElement;
  private fyKey = '';
  private series: PriceKey[] = [];

  constructor(private readonly onChange: (patch: FilterPatch) => void) {
    const ids = { preset: uniqueId('f'), from: uniqueId('f'), to: uniqueId('f'), dt: uniqueId('f'), tz: uniqueId('f') };
    this.preset = h('select', { id: ids.preset, onchange: () => this.onChange({ preset: this.preset.value }) });
    this.fromInput = h('input', { id: ids.from, type: 'date', onchange: () => this.onDateChange() });
    this.toInput = h('input', { id: ids.to, type: 'date', 'aria-label': '終了日', onchange: () => this.onDateChange() });
    this.dayType = h(
      'select',
      { id: ids.dt, onchange: () => this.onChange({ dayType: this.dayType.value as AppState['dayType'] }) },
      h('option', { value: 'all' }, '全日'),
      h('option', { value: 'weekday' }, '平日'),
      h('option', { value: 'offday' }, '土日祝'),
    );
    this.slotPreset = h(
      'select',
      { id: ids.tz, onchange: () => this.onSlotPreset() },
      SLOT_PRESETS.map((p) => h('option', { value: p.id }, p.label)),
    );
    const timeOptions = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => h('option', { value: String(from + i) }, slotStartLabel(from + i)));
    this.slotStart = h('select', { 'aria-label': '開始時刻', onchange: () => this.onSlotCustom() }, timeOptions(0, SLOTS - 1));
    this.slotEnd = h('select', { 'aria-label': '終了時刻', onchange: () => this.onSlotCustom() }, timeOptions(1, SLOTS));
    this.customSlots = h('span', { class: 'custom-slots' }, this.slotStart, h('span', { 'aria-hidden': 'true' }, '〜'), this.slotEnd);

    const chipRow = h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': '表示系列' },
      PRICE_KEYS.map((key) => {
        const btn = h(
          'button',
          { type: 'button', class: 'chip', 'aria-pressed': 'false', onclick: () => this.toggleSeries(key) },
          h('span', { class: `chip-key${seriesDashed(key) ? ' is-dashed' : ''}`, 'aria-hidden': 'true' }),
          SERIES_SHORT[key],
        );
        this.chips.set(key, btn);
        return btn;
      }),
      h('button', { type: 'button', class: 'chip chip-action', onclick: () => this.onChange({ series: [...PRICE_KEYS] }) }, '全て'),
      h('button', { type: 'button', class: 'chip chip-action', onclick: () => this.onChange({ series: ['system'] }) }, 'システムのみ'),
    );

    this.status = h('span', { class: 'filter-status', role: 'status', 'aria-live': 'polite' });
    this.el = h(
      'section',
      { class: 'filter-bar', 'aria-label': '絞り込み条件' },
      h(
        'div',
        { class: 'filter-row' },
        h(
          'div',
          { class: 'field' },
          h('label', { for: ids.preset }, '期間'),
          h('div', { class: 'field-inline' }, this.preset, this.fromInput, h('span', { 'aria-hidden': 'true' }, '〜'), this.toInput),
        ),
        h('div', { class: 'field' }, h('label', { for: ids.dt }, '曜日'), this.dayType),
        h('div', { class: 'field' }, h('label', { for: ids.tz }, '時間帯'), h('div', { class: 'field-inline' }, this.slotPreset, this.customSlots)),
        this.status,
      ),
      h('div', { class: 'filter-row' }, h('div', { class: 'field field-series' }, h('span', { class: 'field-label' }, '表示系列'), chipRow)),
    );
    this.fromInput.setAttribute('aria-label', '開始日');
  }

  sync(state: AppState, extent: Extent, theme: ThemeName): void {
    const fys = fiscalYearsIn(extent);
    const key = fys.join(',');
    if (key !== this.fyKey) {
      this.fyKey = key;
      this.preset.replaceChildren(
        ...RANGE_PRESETS.map(([v, l]) => h('option', { value: v }, l)),
        h('optgroup', { label: '年度' }, fys.map((fy) => h('option', { value: `fy${fy}` }, `${fy}年度`))),
        h('option', { value: 'all' }, '全期間'),
        h('option', { value: 'custom' }, 'カスタム'),
      );
    }
    this.preset.value = state.preset;
    const min = isoFromDay(extent.first);
    const max = isoFromDay(extent.last);
    for (const input of [this.fromInput, this.toInput]) {
      input.min = min;
      input.max = max;
    }
    this.fromInput.value = isoFromDay(state.from);
    this.toInput.value = isoFromDay(state.to);
    this.dayType.value = state.dayType;
    this.slotPreset.value = state.slotPreset;
    this.customSlots.hidden = state.slotPreset !== 'custom';
    this.slotStart.value = String(state.slotStart);
    this.slotEnd.value = String(state.slotEnd);
    this.series = state.series;
    for (const [k, btn] of this.chips) {
      btn.setAttribute('aria-pressed', String(state.series.includes(k)));
      btn.style.setProperty('--c', seriesColor(k, theme));
    }
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  private onDateChange(): void {
    let from = parseDateString(this.fromInput.value);
    let to = parseDateString(this.toInput.value);
    if (from === null || to === null) return;
    if (from > to) [from, to] = [to, from];
    this.onChange({ preset: 'custom', from, to });
  }

  private onSlotPreset(): void {
    const id = this.slotPreset.value as SlotPresetId;
    const p = SLOT_PRESETS.find((x) => x.id === id)!;
    if (id === 'custom') this.onChange({ slotPreset: id });
    else this.onChange({ slotPreset: id, slotStart: p.start, slotEnd: p.end });
  }

  private onSlotCustom(): void {
    const start = Number(this.slotStart.value);
    const end = Number(this.slotEnd.value);
    this.onChange({ slotPreset: 'custom', slotStart: start, slotEnd: end === start ? start + 1 : end });
  }

  private toggleSeries(key: PriceKey): void {
    const on = this.series.includes(key);
    if (on && this.series.length === 1) return; // 少なくとも 1 系列は表示する
    const next = on ? this.series.filter((k) => k !== key) : PRICE_KEYS.filter((k) => k === key || this.series.includes(k));
    this.onChange({ series: next });
  }
}
