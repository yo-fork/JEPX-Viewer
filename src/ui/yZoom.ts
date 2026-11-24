/**
 * グラフの縦軸の拡大。
 * - Shift + ホイール: ポインタの位置を中心に、縦軸だけを拡大縮小する
 * - Shift + ドラッグ: 縦軸を上下に動かす
 * - ダブルクリック: 縦軸を元に戻す
 *
 * 横軸（期間）の拡大は ECharts の dataZoom（ホイール、ドラッグ、スライダー）に任せている。
 * 横軸の拡大は修飾キーに関係なくホイールに反応するので、ECharts の設定で縦軸に Shift + ホイールを割り当てると、
 * 横軸も一緒に拡大されてしまう。そこで Shift を押した操作は ECharts に届く前に受け取り、縦軸の dataZoom に範囲を渡す。
 *
 * 範囲は値で渡す。ECharts 自身の操作のように割合で渡すと、割合の基準が見えている期間の値の幅なので、
 * 期間を動かしたときに縦軸の値までずれてしまう。
 */
import { h } from './dom';
import type { echarts } from './echarts';

type ECharts = echarts.ECharts;

export const Y_ZOOM_ID = 'jv-y-zoom';

/** ホイールを 100 px（マウスの 1 目盛り）回したときの拡大率（横軸の拡大とそろえる） */
const WHEEL_STEP = 1.1;

/**
 * 縦軸を拡大できるようにする dataZoom（操作部品は出さず、範囲は YZoom が渡す）。
 * dataZoom の並びでは横軸のものより後ろに置く。ECharts は縦軸の範囲を、横軸で絞り込んだ後の値の幅に収まるようにずらし、
 * 値の幅より広ければ自動の範囲で描く。元の期間に戻すと、拡大した範囲に戻る。
 */
export function yZoomOption(yAxisIndex: number | number[] = 0): Record<string, unknown> {
  return { type: 'slider', id: Y_ZOOM_ID, show: false, yAxisIndex, filterMode: 'none', minSpan: 0.1 };
}

/** datazoom イベントが縦軸の拡大によるものか（横軸の範囲を覚える処理で、縦軸の操作を除くのに使う） */
export function isYZoomEvent(e: unknown): boolean {
  const ev = e as { dataZoomId?: unknown; batch?: { dataZoomId?: unknown }[] } | null;
  return (ev?.dataZoomId ?? ev?.batch?.[0]?.dataZoomId) === Y_ZOOM_ID;
}

/**
 * ECharts の内部のモデル。公開 API には軸のいまの範囲と図の中での位置を読む方法が無いので、使う所だけに型を付ける。
 * 読めないとき（ECharts の版を上げて作りが変わったときなど）は、Shift を押した操作も受け取らずに ECharts に渡す。
 */
interface AxisLike {
  scale: { getExtent(): number[] };
  getGlobalExtent(): number[];
}
interface ZoomModelLike {
  getPercentRange(): number[];
  getValueRange(): number[];
}
interface SeriesLike {
  name: string;
  getData(): { count(): number; mapDimension(dim: string): string; get(dim: string, index: number): unknown };
}
interface ModelLike {
  getComponent(mainType: string, index?: number): { axis?: AxisLike } | undefined;
  queryComponents(condition: { mainType: string; id: string }): ZoomModelLike[];
  getSeries(): SeriesLike[];
}

function modelOf(chart: ECharts): ModelLike | null {
  if (chart.isDisposed()) return null;
  return (chart as unknown as { getModel(): ModelLike | null | undefined }).getModel() ?? null;
}

/** 折れ線の右端（横軸で絞り込んだ後の最後の値） */
function lastValue(model: ModelLike, name: string): number {
  const s = model.getSeries().find((x) => x.name === name);
  if (!s) return Number.NaN;
  const data = s.getData();
  const dim = data.mapDimension('y');
  for (let i = data.count() - 1; i >= 0; i--) {
    const v = Number(data.get(dim, i));
    if (Number.isFinite(v)) return v;
  }
  return Number.NaN;
}

function list(v: unknown): Record<string, unknown>[] {
  return (Array.isArray(v) ? v : v ? [v] : []) as Record<string, unknown>[];
}

interface AxisRef {
  /** yAxis の番号 */
  axis: number;
  /** その軸のある grid の番号 */
  grid: number;
  /** 設定で決めている目盛りの間隔（拡大しているあいだは外す） */
  interval: unknown;
  /** 両端の目盛りの数字を出すかの設定（拡大しているあいだは出さない） */
  showMinLabel: unknown;
  showMaxLabel: unknown;
}

/** 縦軸の表示範囲（lo〜hi）とその両端の図の中での位置（px）、dataZoom の範囲（vlo〜vhi） */
interface AxisWindow {
  lo: number;
  hi: number;
  pLo: number;
  pHi: number;
  vlo: number;
  vhi: number;
}

export class YZoom {
  /** 図のすぐ下に出す操作の説明。拡大しているあいだは「縦軸を戻す」ボタンも出す */
  readonly note: HTMLParagraphElement;
  private readonly text: HTMLSpanElement;
  private readonly resetBtn: HTMLButtonElement;
  private axes: AxisRef[] = [];
  /** 右端に名前を付けた折れ線と、その名前をいま出しているか */
  private labels: { name: string; shown: boolean }[] = [];
  private zoomed = false;
  private frame = 0;
  private pendingZoom: { axis: number; py: number; factor: number } | null = null;
  private pendingWindow: [number, number] | null = null;
  private drag: { y: number; vlo: number; vhi: number; perPx: number; moved: boolean } | null = null;
  private suppressClick = false;

  constructor(
    private readonly el: HTMLElement,
    private readonly chart: ECharts,
  ) {
    this.text = h('span');
    this.resetBtn = h('button', { type: 'button', class: 'btn btn-sm', hidden: true, onclick: () => this.reset() }, '縦軸を戻す');
    this.note = h('p', { class: 'zoom-note y-zoom-note', hidden: true }, this.text, this.resetBtn);
    // ECharts（zrender）は図の中の要素でイベントを受け取るので、外側の要素の capture で先に受け取る
    el.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    el.addEventListener('mousewheel', this.onLegacyWheel, { capture: true, passive: false });
    el.addEventListener('mousedown', this.onMouseDown, true);
    el.addEventListener('click', this.onClick, true);
    el.addEventListener('dblclick', this.onDblClick, true);
    // 横軸を動かしたときや、凡例で系列を出し入れしたときも、縦軸の範囲が変わることがある（値の幅に収まらなくなって自動に戻るなど）
    chart.on('datazoom', () => queueMicrotask(() => this.sync()));
    chart.on('legendselectchanged', () => queueMicrotask(() => this.sync()));
  }

  /** 図を描き直したとき（縦軸の拡大は解除される）に、縦軸を拡大できるかと、その対象を読み直す */
  update(option: Record<string, unknown> | null): void {
    this.cancel();
    this.zoomed = false;
    const dz = option ? list(option.dataZoom).find((d) => d.id === Y_ZOOM_ID) : undefined;
    if (!option || !dz) {
      this.axes = [];
      this.labels = [];
    } else {
      const yAxes = list(option.yAxis);
      const indices = (Array.isArray(dz.yAxisIndex) ? dz.yAxisIndex : [dz.yAxisIndex ?? 0]) as number[];
      this.axes = indices.map((i) => {
        const label = (yAxes[i]?.axisLabel ?? {}) as Record<string, unknown>;
        return {
          axis: i,
          grid: Number(yAxes[i]?.gridIndex ?? 0),
          interval: yAxes[i]?.interval,
          showMinLabel: label.showMinLabel,
          showMaxLabel: label.showMaxLabel,
        };
      });
      this.labels = list(option.series)
        .filter((s) => typeof s.name === 'string' && (s.endLabel as { show?: unknown } | undefined)?.show === true)
        .map((s) => ({ name: s.name as string, shown: true }));
    }
    this.showState();
  }

  /** 縦軸を元に戻す（期間に合わせた自動の範囲） */
  reset(): void {
    if (this.axes.length === 0 || this.chart.isDisposed()) return;
    this.chart.dispatchAction({ type: 'dataZoom', dataZoomId: Y_ZOOM_ID, start: 0, end: 100 });
  }

  dispose(): void {
    this.cancel();
  }

  private onWheel = (e: WheelEvent): void => {
    if (!e.shiftKey) return;
    const hit = this.hitTest(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    // Shift を押すとホイールが横向き（deltaX）になる環境がある
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    const px = delta * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 600 : 1);
    if (px === 0) return;
    // 下に回すと縮小、上に回すと拡大（横軸の拡大と同じ向き）
    this.pendingZoom = { axis: hit.axis, py: hit.py, factor: (this.pendingZoom?.factor ?? 1) * WHEEL_STEP ** (px / 100) };
    this.schedule();
  };

  /** wheel の後に古い mousewheel も届くブラウザでは、それも ECharts に渡さない */
  private onLegacyWheel = (e: Event): void => {
    if (e instanceof MouseEvent && e.shiftKey && this.hitTest(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!e.shiftKey || e.button !== 0) return;
    const hit = this.hitTest(e);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    const w = hit.win;
    this.drag = { y: e.clientY, vlo: w.vlo, vhi: w.vhi, perPx: (w.hi - w.lo) / (w.pHi - w.pLo), moved: false };
    window.addEventListener('mousemove', this.onDragMove, true);
    window.addEventListener('mouseup', this.onDragEnd, true);
    this.chart.getZr().setCursorStyle('ns-resize');
  };

  private onDragMove = (e: MouseEvent): void => {
    const d = this.drag;
    if (!d) return;
    // ドラッグしているあいだは ECharts に渡さない（ツールチップや横軸が動かないように）
    e.preventDefault();
    e.stopPropagation();
    const dy = e.clientY - d.y;
    if (dy === 0 && !d.moved) return;
    d.moved = true;
    // ポインタの下の値がポインタについてくるように、範囲を動かす
    this.pendingWindow = [d.vlo - dy * d.perPx, d.vhi - dy * d.perPx];
    this.schedule();
  };

  private onDragEnd = (e: MouseEvent): void => {
    const d = this.drag;
    if (!d) return;
    e.stopPropagation();
    this.endDrag();
    this.chart.getZr().setCursorStyle('default');
    // ドラッグに続く click は、図のクリックとして扱わない
    if (d.moved) {
      this.suppressClick = true;
      setTimeout(() => (this.suppressClick = false), 0);
    }
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  private onDblClick = (e: MouseEvent): void => {
    if (!this.zoomed || !this.hitTest(e)) return;
    e.preventDefault();
    e.stopPropagation();
    this.reset();
  };

  /** ポインタが縦軸を拡大できる図の中にあれば、その軸といまの範囲を返す */
  private hitTest(e: MouseEvent): { axis: number; py: number; win: AxisWindow } | null {
    if (this.axes.length === 0 || this.chart.isDisposed()) return null;
    const r = this.el.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const a = this.axes.find((x) => this.chart.containPixel({ gridIndex: x.grid }, [px, py]));
    if (!a) return null;
    const win = this.axisWindow(a.axis);
    return win ? { axis: a.axis, py, win } : null;
  }

  private axisWindow(axis: number): AxisWindow | null {
    try {
      const model = modelOf(this.chart);
      const ax = model?.getComponent('yAxis', axis)?.axis;
      const dz = model?.queryComponents({ mainType: 'dataZoom', id: Y_ZOOM_ID })[0];
      if (!ax || !dz) return null;
      const [lo, hi] = ax.scale.getExtent();
      const [pLo, pHi] = ax.getGlobalExtent();
      // 拡大していないときの dataZoom の範囲は値の幅そのもので、表示範囲（きりのよい値まで広げたもの）より狭い
      const [vlo, vhi] = dz.getValueRange();
      return hi > lo && pLo !== pHi && vhi > vlo ? { lo, hi, pLo, pHi, vlo, vhi } : null;
    } catch {
      return null;
    }
  }

  private isZoomedNow(): boolean {
    try {
      const p = modelOf(this.chart)?.queryComponents({ mainType: 'dataZoom', id: Y_ZOOM_ID })[0]?.getPercentRange();
      return !!p && (p[0] > 1e-6 || p[1] < 100 - 1e-6);
    } catch {
      return false;
    }
  }

  private schedule(): void {
    if (this.frame === 0) this.frame = requestAnimationFrame(this.flush);
  }

  /** 範囲を変えるのは 1 フレームに 1 回にする（ホイールやドラッグのイベントはそれより多く届く） */
  private flush = (): void => {
    this.frame = 0;
    const zoom = this.pendingZoom;
    const win = this.pendingWindow;
    this.pendingZoom = null;
    this.pendingWindow = null;
    if (this.chart.isDisposed()) return;
    if (win) this.setWindow(win[0], win[1]);
    if (!zoom) return;
    const w = this.axisWindow(zoom.axis);
    if (!w) return;
    // ポインタの位置の値を中心に、dataZoom の範囲を広げる・狭める
    const t = Math.min(1, Math.max(0, (zoom.py - w.pLo) / (w.pHi - w.pLo)));
    const v = w.lo + t * (w.hi - w.lo);
    this.setWindow(v - (v - w.vlo) * zoom.factor, v + (w.vhi - v) * zoom.factor);
    // 縮小して値の幅全体を超えたら自動に戻す（範囲を残すと、期間を動かしたときにまた拡大した状態になる）
    if (zoom.factor > 1 && !this.isZoomedNow()) this.reset();
  };

  private setWindow(lo: number, hi: number): void {
    this.chart.dispatchAction({ type: 'dataZoom', dataZoomId: Y_ZOOM_ID, startValue: lo, endValue: hi });
  }

  /** 縦軸の拡大の有無が変わったら、目盛りの出し方と図の下の説明を直す。線の右端の名前は、そのつど出し分ける */
  private sync(): void {
    if (this.axes.length === 0 || this.chart.isDisposed()) return;
    const zoomed = this.isZoomedNow();
    const patch: Record<string, unknown> = {};
    if (zoomed !== this.zoomed) {
      this.zoomed = zoomed;
      this.showState();
      // 拡大した範囲の両端は切りのよい値ではないので、両端の目盛りの数字は出さない（19.338… のように出てしまう）。
      // 目盛りの間隔を決めている軸（系列ごとに分割した図）は、拡大しているあいだは間隔を ECharts に任せる
      const yAxis: Record<string, unknown>[] = [];
      for (const a of this.axes) {
        yAxis[a.axis] = {
          ...(a.interval != null ? { interval: zoomed ? null : a.interval } : {}),
          axisLabel: zoomed ? { showMinLabel: false, showMaxLabel: false } : { showMinLabel: a.showMinLabel ?? null, showMaxLabel: a.showMaxLabel ?? null },
        };
      }
      patch.yAxis = Array.from(yAxis, (x) => x ?? {});
    }
    const series = this.labelPatch();
    if (series.length > 0) patch.series = series;
    if (Object.keys(patch).length > 0) this.chart.setOption(patch);
  }

  /**
   * 線の右端の名前は、ECharts が図の枠で切らずに描くので、右端の値が縦軸の範囲の外にあると図の外にはみ出す。
   * 拡大しているあいだは、右端が範囲の中にある線にだけ名前を出す
   */
  private labelPatch(): Record<string, unknown>[] {
    if (this.labels.length === 0) return [];
    const model = modelOf(this.chart);
    const win = this.zoomed ? this.axisWindow(this.axes[0].axis) : null;
    const out: Record<string, unknown>[] = [];
    for (const l of this.labels) {
      let show = true;
      if (win && model) {
        const v = lastValue(model, l.name);
        show = v >= win.lo && v <= win.hi;
      }
      if (show !== l.shown) {
        l.shown = show;
        // 名前で指定すると、その系列だけが変わる
        out.push({ name: l.name, endLabel: { show } });
      }
    }
    return out;
  }

  private showState(): void {
    this.note.hidden = this.axes.length === 0;
    this.note.classList.toggle('zoomed', this.zoomed);
    this.text.textContent = this.zoomed
      ? '縦軸を拡大しています（図の中をダブルクリックしても戻せます）。'
      : '縦軸は、Shift を押しながらホイールで拡大縮小、ドラッグで上下に動かせます。';
    this.resetBtn.hidden = !this.zoomed;
  }

  private cancel(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pendingZoom = null;
    this.pendingWindow = null;
    this.endDrag();
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    window.removeEventListener('mousemove', this.onDragMove, true);
    window.removeEventListener('mouseup', this.onDragEnd, true);
  }
}
