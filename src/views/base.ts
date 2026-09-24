/**
 * ビュー（タブ）の共通基盤。
 */
import type { Selection } from '../lib/select';
import type { Dataset } from '../lib/store';
import type { AppState, Extent } from '../state';
import { ChartCard, type CardOptions } from '../ui/card';
import { h } from '../ui/dom';
import type { ThemeName } from '../ui/theme';

export interface AppApi {
  setState(patch: Partial<AppState>): void;
}

export interface ViewContext {
  app: AppApi;
  state: AppState;
  ds: Dataset;
  sel: Selection;
  theme: ThemeName;
  /** 利用できるデータ全体の範囲（未読み込みの年度を含む） */
  extent: Extent;
}

export abstract class View {
  protected root!: HTMLElement;
  protected ctx!: ViewContext;
  private cards: ChartCard[] = [];

  mount(root: HTMLElement, ctx: ViewContext): void {
    this.root = root;
    this.ctx = ctx;
    this.build();
    this.update(ctx);
  }

  /** DOM・グラフの枠を作る（タブ表示時に 1 回） */
  protected abstract build(): void;

  /** 状態・データに合わせて内容を描画する */
  update(ctx: ViewContext): void {
    this.ctx = ctx;
    this.render();
  }

  protected abstract render(): void;

  unmount(): void {
    for (const c of this.cards) c.dispose();
    this.cards = [];
    this.root.replaceChildren();
  }

  protected card(parent: HTMLElement, opts: Omit<CardOptions, 'theme'>): ChartCard {
    const c = new ChartCard(parent, { ...opts, theme: this.ctx.theme });
    this.cards.push(c);
    return c;
  }

  protected removeCard(card: ChartCard): void {
    card.dispose();
    this.cards = this.cards.filter((c) => c !== card);
  }

  protected grid(): HTMLElement {
    const g = h('div', { class: 'card-grid' });
    this.root.append(g);
    return g;
  }

  protected set(patch: Partial<AppState>): void {
    this.ctx.app.setState(patch);
  }
}

/** 選択範囲にデータが無いときの共通メッセージ */
export const NO_DATA = '選択した条件に該当するデータがありません。期間・曜日・時間帯の条件を見直してください。';
