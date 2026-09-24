/**
 * ツールバー用のフォーム部品（select・セグメント切替・数値入力）。
 * いずれも生成後に set() で値を同期でき、再描画のたびに作り直さない（フォーカスを保つ）。
 */
import { h, uniqueId } from './dom';

export interface Option<T extends string> {
  value: T;
  label: string;
}

export interface SelectField<T extends string> {
  el: HTMLElement;
  input: HTMLSelectElement;
  set(value: T): void;
  setOptions(options: Option<T>[], value: T): void;
  setDisabled(disabled: boolean): void;
}

export function selectField<T extends string>(
  label: string,
  options: Option<T>[],
  value: T,
  onChange: (v: T) => void,
): SelectField<T> {
  const id = uniqueId('sel');
  const input = h('select', { id, onchange: () => onChange(input.value as T) });
  const fill = (opts: Option<T>[], v: T) => {
    input.replaceChildren(...opts.map((o) => h('option', { value: o.value }, o.label)));
    input.value = v;
  };
  fill(options, value);
  const el = h('div', { class: 'field' }, h('label', { for: id }, label), input);
  return {
    el,
    input,
    set: (v) => {
      input.value = v;
    },
    setOptions: fill,
    setDisabled: (d) => {
      input.disabled = d;
      el.classList.toggle('is-disabled', d);
    },
  };
}

export interface Segmented<T extends string> {
  el: HTMLElement;
  set(value: T): void;
  setDisabled(disabled: boolean): void;
}

export function segmented<T extends string>(
  label: string,
  options: Option<T>[],
  value: T,
  onChange: (v: T) => void,
): Segmented<T> {
  const labelId = uniqueId('seg');
  const buttons = options.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg-btn',
        'data-value': o.value,
        'aria-pressed': String(o.value === value),
        onclick: () => onChange(o.value),
      },
      o.label,
    ),
  );
  const el = h(
    'div',
    { class: 'field' },
    h('span', { class: 'field-label', id: labelId }, label),
    h('div', { class: 'segmented', role: 'group', 'aria-labelledby': labelId }, buttons),
  );
  return {
    el,
    set: (v) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v))),
    setDisabled: (d) => {
      buttons.forEach((b) => (b.disabled = d));
      el.classList.toggle('is-disabled', d);
    },
  };
}

export function numberField(
  label: string,
  value: number,
  opts: { min?: number; max?: number; step?: number; unit?: string },
  onChange: (v: number) => void,
): { el: HTMLElement; set(v: number): void } {
  const id = uniqueId('num');
  const input = h('input', {
    id,
    type: 'number',
    value: String(value),
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
    inputmode: 'decimal',
    onchange: () => {
      let v = Number(input.value);
      if (!Number.isFinite(v)) return;
      if (opts.min !== undefined) v = Math.max(opts.min, v);
      if (opts.max !== undefined) v = Math.min(opts.max, v);
      input.value = String(v);
      onChange(v);
    },
  });
  const el = h('div', { class: 'field' }, h('label', { for: id }, label), h('span', { class: 'input-unit' }, input, opts.unit ?? ''));
  return { el, set: (v) => (input.value = String(v)) };
}

/** ツールバー（ビュー固有の表示設定の行） */
export function toolbar(...items: HTMLElement[]): HTMLElement {
  return h('div', { class: 'view-toolbar' }, items);
}
