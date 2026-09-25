/**
 * 表示用の数値・日付フォーマット。
 */
import { formatDay, slotStartLabel } from './dates';
import { SLOTS } from './series';

const nf = (digits: number) =>
  new Intl.NumberFormat('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const nf0 = nf(0);
const nf1 = nf(1);
const nf2 = nf(2);

/** 価格（円/kWh、小数 2 桁） */
export function fmtPrice(v: number): string {
  return Number.isFinite(v) ? nf2.format(v) : '—';
}

export function fmtNum(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  return digits === 0 ? nf0.format(v) : digits === 1 ? nf1.format(v) : digits === 2 ? nf2.format(v) : nf(digits).format(v);
}

export function fmtSigned(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const s = fmtNum(Math.abs(v), digits);
  return v > 0 ? `+${s}` : v < 0 ? `−${s}` : s;
}

export function fmtPct(ratio: number, digits = 1): string {
  return Number.isFinite(ratio) ? `${fmtNum(ratio * 100, digits)}%` : '—';
}

/** 刻み幅を表すのに要る小数の桁数（2.5 なら 1、0.025 なら 3） */
export function stepDigits(step: number): number {
  for (let d = 0; d < 4; d++) {
    const x = step * 10 ** d;
    if (Math.abs(x - Math.round(x)) < 1e-6) return d;
  }
  return 4;
}

/** kWh → 百万kWh */
export const MKWH = 1e6;

/** 大きな電力量を 億kWh / 万kWh で丸める（[数値, 単位]） */
export function energyCompact(kwh: number): [string, string] {
  if (!Number.isFinite(kwh)) return ['—', ''];
  if (kwh >= 1e8) return [fmtNum(kwh / 1e8, kwh >= 1e10 ? 0 : 1), '億kWh'];
  if (kwh >= 1e4) return [fmtNum(kwh / 1e4, 0), '万kWh'];
  return [fmtNum(kwh, 0), 'kWh'];
}

/** Dataset の位置（dayIndex × 48 + slot）を「2024/04/01(月) 12:30」に */
export function fmtPosition(start: number, at: number): string {
  if (at < 0) return '';
  const day = start + Math.floor(at / SLOTS);
  return `${formatDay(day, true)} ${slotStartLabel(at % SLOTS)}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
