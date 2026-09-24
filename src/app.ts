/**
 * アプリ本体：画面の骨組み、データの読み込み（取得済みデータ・CSV・デモ）、状態管理と描画の制御。
 */
import { decodeFyFile, MANIFEST_FORMAT, type Manifest, type ManifestEntry } from './lib/dataFile';
import { fiscalYearEnd, fiscalYearOfDay, fiscalYearStart, formatDay, parseDateString, todayJst } from './lib/dates';
import { generateDemoDays } from './lib/demo';
import { decodeCsvBytes } from './lib/encoding';
import { fmtNum } from './lib/format';
import { parseSpotCsv } from './lib/jepxCsv';
import { select } from './lib/select';
import { DataStore } from './lib/store';
import { DEFAULT_STATE, TABS, resolveRange, stateFromHash, stateToHash, type AppState, type Extent, type TabId } from './state';
import { h } from './ui/dom';
import { FilterBar } from './ui/filterBar';
import { applyThemeMode, effectiveTheme, loadThemeMode, saveThemeMode, type ThemeMode, type ThemeName } from './ui/theme';
import type { AppApi, View, ViewContext } from './views/base';
import { createView } from './views';

const DATA_BASE = new URL('data/', document.baseURI);
const JEPX_SPOT_URL = 'https://www.jepx.jp/electricpower/market-data/spot/';

export class App implements AppApi {
  private state: AppState;
  private readonly store = new DataStore();
  private manifest: Manifest | null = null;
  private readonly loaded = new Set<number>();
  private readonly failed = new Set<number>();
  private readonly loading = new Map<number, Promise<void>>();
  private themeMode: ThemeMode;
  private theme: ThemeName;
  private view: View | null = null;
  private viewKey = '';
  private renderQueued = false;
  private renderSeq = 0;
  private lastHash = '';

  private readonly statusEl: HTMLElement;
  private readonly demoBanner: HTMLElement;
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private readonly filterBar: FilterBar;
  private readonly workspace: HTMLElement;
  private readonly viewHost: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly toastHost: HTMLElement;
  private readonly fileInput: HTMLInputElement;
  private readonly dropOverlay: HTMLElement;

  constructor(root: HTMLElement) {
    this.state = stateFromHash(location.hash);
    this.themeMode = loadThemeMode();
    applyThemeMode(this.themeMode);
    this.theme = effectiveTheme(this.themeMode);

    this.fileInput = h('input', {
      type: 'file',
      accept: '.csv,text/csv',
      multiple: true,
      hidden: true,
      onchange: () => {
        const files = [...(this.fileInput.files ?? [])];
        this.fileInput.value = '';
        void this.importFiles(files);
      },
    });
    const themeSelect = h(
      'select',
      {
        'aria-label': '配色',
        class: 'theme-select',
        onchange: () => this.setThemeMode(themeSelect.value as ThemeMode),
      },
      h('option', { value: 'auto' }, '配色: 自動'),
      h('option', { value: 'light' }, '配色: ライト'),
      h('option', { value: 'dark' }, '配色: ダーク'),
    );
    themeSelect.value = this.themeMode;

    this.statusEl = h('p', { class: 'data-status' });
    const header = h(
      'header',
      { class: 'app-header' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
        h('div', null, h('h1', null, 'JEPX Viewer'), h('p', { class: 'brand-sub' }, 'スポット市場 約定価格実績ビューア')),
      ),
      this.statusEl,
      h(
        'div',
        { class: 'header-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => this.fileInput.click() }, 'CSV を読み込む'),
        themeSelect,
      ),
    );

    this.demoBanner = h(
      'div',
      { class: 'banner banner-demo', role: 'status', hidden: true },
      h('strong', null, 'デモデータを表示中'),
      h('span', null, '画面を試すための合成データです。実際の JEPX 約定価格ではありません。'),
      h('button', { type: 'button', class: 'btn btn-sm', onclick: () => this.exitDemo() }, 'デモを終了'),
    );

    const tabs = h('nav', { class: 'tabs', role: 'tablist', 'aria-label': '可視化の切り口' });
    for (const t of TABS) {
      const btn = h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: 'tab',
          id: `tab-${t.id}`,
          'aria-controls': 'view',
          onclick: () => this.setState({ tab: t.id }),
          onkeydown: (ev: Event) => this.onTabKey(ev as KeyboardEvent, t.id),
        },
        t.label,
      );
      this.tabButtons.set(t.id, btn);
      tabs.append(btn);
    }

    this.filterBar = new FilterBar((patch) => this.setState(patch));
    this.viewHost = h('main', { id: 'view', class: 'view', role: 'tabpanel', tabindex: '-1' });
    this.workspace = h('div', { class: 'workspace', hidden: true }, tabs, this.filterBar.el, this.viewHost);
    this.emptyEl = this.buildEmptyState();
    this.toastHost = h('div', { class: 'toasts', 'aria-live': 'polite' });
    this.dropOverlay = h('div', { class: 'drop-overlay', hidden: true }, h('p', null, 'CSV ファイルをドロップして読み込み'));

    const footer = h(
      'footer',
      { class: 'app-footer' },
      h(
        'p',
        null,
        '出典: 日本卸電力取引所（JEPX）「スポット市場 取引結果」。本ツールは JEPX とは関係のない非公式のビューアです。',
        '読み込んだ CSV はブラウザ内でのみ処理され、外部には送信されません。',
      ),
    );

    root.replaceChildren(header, this.demoBanner, this.emptyEl, this.workspace, footer, this.toastHost, this.dropOverlay, this.fileInput);
    this.setupDragAndDrop();
  }

  async start(): Promise<void> {
    window.addEventListener('hashchange', () => this.onHashChange());
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => this.setThemeMode(this.themeMode));
    await this.loadManifest();
    if (!this.manifest && new URLSearchParams(location.hash.slice(1)).get('demo') === '1') this.loadDemo();
    this.requestRender();
  }

  setState(patch: Partial<AppState>): void {
    const next: AppState = { ...this.state, ...patch };
    if (patch.preset !== undefined && patch.preset !== 'custom' && patch.from === undefined) {
      next.from = Number.NaN;
      next.to = Number.NaN;
    }
    this.state = next;
    this.syncUrl();
    this.requestRender();
  }

  // ---- 描画 ----

  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      void this.render();
    });
  }

  private async render(): Promise<void> {
    const seq = ++this.renderSeq;
    const extent = this.extent();
    this.updateChrome(extent);
    if (!extent) {
      this.showWorkspace(false);
      return;
    }
    this.showWorkspace(true);

    const range = resolveRange(this.state.preset, extent, this.state);
    this.state = { ...this.state, ...range };
    this.filterBar.sync(this.state, extent, this.theme);
    this.syncUrl();

    // 概要タブは前年同期との比較に 1 年前のデータも使う
    const pending = this.ensureLoaded(this.state.tab === 'overview' ? range.from - 366 : range.from, range.to);
    if (pending) {
      this.viewHost.classList.add('is-loading');
      this.filterBar.setStatus('データを読み込み中…');
      await pending;
      if (seq !== this.renderSeq) return;
      this.viewHost.classList.remove('is-loading');
      this.filterBar.setStatus('');
    }

    const ds = this.store.dataset();
    if (!ds) {
      this.viewHost.replaceChildren(h('p', { class: 'view-message' }, 'この期間のデータを読み込めませんでした。'));
      this.view = null;
      return;
    }
    const sel = select(ds, {
      from: this.state.from,
      to: this.state.to,
      dayType: this.state.dayType,
      slotStart: this.state.slotStart,
      slotEnd: this.state.slotEnd,
    });
    const ctx: ViewContext = { app: this, state: this.state, ds, sel, theme: this.theme };
    const key = `${this.state.tab}|${this.theme}`;
    try {
      if (!this.view || this.viewKey !== key) {
        this.view?.unmount();
        this.viewHost.replaceChildren();
        this.view = createView(this.state.tab);
        this.viewKey = key;
        this.view.mount(this.viewHost, ctx);
      } else {
        this.view.update(ctx);
      }
    } catch (err) {
      console.error(err);
      this.toast(`描画中にエラーが発生しました: ${(err as Error).message}`, 'error');
    }
  }

  private updateChrome(extent: Extent | null): void {
    for (const [id, btn] of this.tabButtons) {
      const selected = id === this.state.tab;
      btn.setAttribute('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
    }
    this.viewHost.setAttribute('aria-labelledby', `tab-${this.state.tab}`);
    this.demoBanner.hidden = !this.store.isDemo;
    if (!extent) {
      this.statusEl.textContent = 'データ未読み込み';
      return;
    }
    const source = this.store.isDemo
      ? 'デモデータ（合成）'
      : [this.manifest ? '取得済みデータ' : null, this.store.sources.has('upload') ? '読み込んだ CSV' : null].filter(Boolean).join(' + ');
    this.statusEl.textContent = `${formatDay(extent.first)}〜${formatDay(extent.last)}・${source}`;
    if (this.manifest) this.statusEl.title = `取得日時: ${new Date(this.manifest.generatedAt).toLocaleString('ja-JP')}`;
  }

  private showWorkspace(show: boolean): void {
    this.workspace.hidden = !show;
    this.emptyEl.hidden = show;
    if (!show && this.view) {
      this.view.unmount();
      this.view = null;
      this.viewKey = '';
    }
  }

  private syncUrl(): void {
    let hash = stateToHash(this.state);
    if (this.store.isDemo) hash = hash ? `${hash}&demo=1` : '#demo=1';
    if (hash === this.lastHash) return;
    this.lastHash = hash;
    history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
  }

  private onHashChange(): void {
    if (location.hash === this.lastHash) return;
    this.lastHash = location.hash;
    this.state = stateFromHash(location.hash);
    this.requestRender();
  }

  private onTabKey(ev: KeyboardEvent, current: TabId): void {
    const ids = TABS.map((t) => t.id) as TabId[];
    const i = ids.indexOf(current);
    const next =
      ev.key === 'ArrowRight' ? ids[(i + 1) % ids.length] : ev.key === 'ArrowLeft' ? ids[(i - 1 + ids.length) % ids.length] : ev.key === 'Home' ? ids[0] : ev.key === 'End' ? ids[ids.length - 1] : null;
    if (!next) return;
    ev.preventDefault();
    this.setState({ tab: next });
    this.tabButtons.get(next)?.focus();
  }

  private setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    saveThemeMode(mode);
    applyThemeMode(mode);
    const theme = effectiveTheme(mode);
    if (theme !== this.theme) {
      this.theme = theme;
      this.requestRender();
    }
  }

  // ---- データ ----

  private extent(): Extent | null {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const f of this.manifest?.files ?? []) {
      const a = parseDateString(f.firstDate);
      const b = parseDateString(f.lastDate);
      if (a !== null) first = Math.min(first, a);
      if (b !== null) last = Math.max(last, b);
    }
    const own = this.store.extent();
    if (own) {
      first = Math.min(first, own.first);
      last = Math.max(last, own.last);
    }
    return Number.isFinite(first) && Number.isFinite(last) ? { first, last } : null;
  }

  private async loadManifest(): Promise<void> {
    try {
      const res = await fetch(new URL('manifest.json', DATA_BASE), { cache: 'no-cache' });
      if (!res.ok) return;
      const json = (await res.json()) as Manifest;
      if (json?.format !== MANIFEST_FORMAT || !Array.isArray(json.files) || json.files.length === 0) return;
      this.manifest = json;
    } catch {
      // 取得済みデータが無い（npm run fetch 未実行）場合はここに来る
    }
  }

  private ensureLoaded(from: number, to: number): Promise<void> | null {
    if (!this.manifest) return null;
    const need = this.manifest.files.filter((f) => {
      if (this.loaded.has(f.fy) || this.failed.has(f.fy)) return false;
      const a = parseDateString(f.firstDate) ?? fiscalYearStart(f.fy);
      const b = parseDateString(f.lastDate) ?? fiscalYearEnd(f.fy);
      return a <= to && b >= from;
    });
    if (need.length === 0) return null;
    return Promise.all(need.map((f) => this.loadFy(f))).then(() => undefined);
  }

  private loadFy(entry: ManifestEntry): Promise<void> {
    let p = this.loading.get(entry.fy);
    if (!p) {
      p = fetch(new URL(entry.file, DATA_BASE))
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((json) => {
          this.store.addDays(decodeFyFile(json), 'bundled');
          this.loaded.add(entry.fy);
        })
        .catch((err: Error) => {
          this.failed.add(entry.fy);
          this.toast(`${entry.fy}年度のデータを読み込めませんでした（${err.message}）`, 'error');
        })
        .finally(() => this.loading.delete(entry.fy));
      this.loading.set(entry.fy, p);
    }
    return p;
  }

  private async importFiles(files: File[]): Promise<void> {
    const csvs = files.filter((f) => /\.csv$/i.test(f.name) || f.type === 'text/csv');
    if (csvs.length === 0) {
      this.toast('CSV ファイルを指定してください。', 'error');
      return;
    }
    if (this.store.isDemo) this.store.clear();
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    const done: string[] = [];
    const errors: string[] = [];
    for (const file of csvs) {
      try {
        const { text } = decodeCsvBytes(await file.arrayBuffer());
        const res = parseSpotCsv(text);
        this.store.addDays(res.days, 'upload');
        first = Math.min(first, res.firstDay);
        last = Math.max(last, res.lastDay);
        done.push(`${file.name}（${formatDay(res.firstDay)}〜${formatDay(res.lastDay)}、${fmtNum(res.rowCount)} コマ）`);
        for (const w of res.warnings) errors.push(`${file.name}: ${w}`);
      } catch (err) {
        errors.push(`${file.name}: ${(err as Error).message}`);
      }
    }
    if (done.length > 0) {
      this.toast(`読み込みました: ${done.join('、')}`);
      // 読み込んだ範囲を表示する（1 年度ぶんなら年度プリセットに合わせる）
      const fy = fiscalYearOfDay(first);
      const oneFy = fiscalYearOfDay(last) === fy;
      this.setState(oneFy ? { preset: `fy${fy}` } : { preset: 'custom', from: first, to: last });
    }
    if (errors.length > 0) this.toast(errors.join('\n'), 'error');
  }

  private loadDemo(): void {
    const today = todayJst();
    const from = fiscalYearStart(fiscalYearOfDay(today) - 6);
    this.store.clear();
    this.store.addDays(generateDemoDays(from, today + 1), 'demo');
    this.syncUrl();
    this.requestRender();
  }

  private exitDemo(): void {
    this.store.clear();
    this.state = { ...DEFAULT_STATE, tab: this.state.tab };
    this.syncUrl();
    this.requestRender();
  }

  // ---- 画面部品 ----

  private buildEmptyState(): HTMLElement {
    return h(
      'section',
      { class: 'empty-state', 'aria-labelledby': 'empty-title' },
      h('h2', { id: 'empty-title' }, 'JEPX スポット市場の価格実績を読み込んでください'),
      h(
        'p',
        { class: 'empty-lead' },
        '年度別の「スポット市場 取引結果」CSV を読み込むと、推移・時間帯・ヒートマップ・カレンダー・分布・エリア比較・年度比較などの切り口で可視化します。',
      ),
      h(
        'div',
        { class: 'empty-options' },
        h(
          'div',
          { class: 'empty-option' },
          h('h3', null, 'CSV ファイルを読み込む'),
          h(
            'p',
            null,
            'JEPX の',
            h('a', { href: JEPX_SPOT_URL, target: '_blank', rel: 'noopener' }, 'スポット市場ページ'),
            'から年度別 CSV（spot_summary_YYYY.csv）をダウンロードし、この画面にドラッグ&ドロップします（複数ファイル可）。',
          ),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => this.fileInput.click() }, 'CSV ファイルを選択'),
        ),
        h(
          'div',
          { class: 'empty-option' },
          h('h3', null, 'データを自動取得する'),
          h('p', null, 'リポジトリで次のコマンドを実行すると、JEPX から全年度の CSV を取得して public/data/ に保存し、起動時に自動で読み込みます。'),
          h('pre', { class: 'code' }, 'npm run fetch\nnpm run dev'),
        ),
        h(
          'div',
          { class: 'empty-option' },
          h('h3', null, 'デモデータで試す'),
          h('p', null, '操作を試すための合成データを表示します（実際の約定価格ではありません）。'),
          h('button', { type: 'button', class: 'btn', onclick: () => this.loadDemo() }, 'デモデータを表示'),
        ),
      ),
    );
  }

  private setupDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (ev: DragEvent) => [...(ev.dataTransfer?.types ?? [])].includes('Files');
    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      depth++;
      this.dropOverlay.hidden = false;
    });
    window.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.dropOverlay.hidden = true;
    });
    window.addEventListener('dragover', (ev) => {
      if (hasFiles(ev)) ev.preventDefault();
    });
    window.addEventListener('drop', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      this.dropOverlay.hidden = true;
      void this.importFiles([...(ev.dataTransfer?.files ?? [])]);
    });
  }

  private toast(message: string, kind: 'info' | 'error' = 'info'): void {
    const el = h(
      'div',
      { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('p', null, message),
      h('button', { type: 'button', class: 'toast-close', 'aria-label': '閉じる', onclick: () => el.remove() }, '×'),
    );
    this.toastHost.append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 12000 : 6000);
  }
}
