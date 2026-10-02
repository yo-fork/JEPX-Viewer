/**
 * 電力広域的運営推進機関（広域機関）「系統情報サービス」の情報ダウンロード画面から、連系線の CSV を取得する。
 *
 * 画面と同じ手順で送る。
 * 1. メニュー（LOGIN_login）を開いてセッション（Cookie）を作る
 * 2. 情報ダウンロード画面を開き、初期表示の通信（initDisplay）で取得できる期間を受け取る
 * 3. CSV 保存の確認（print）、ダウンロードの準備（ok。downloadKey を受け取る）、ダウンロード（download）の順に送る
 * 取得したデータは、利用条件により、出典と加工したことを示して使う（src/lib/occto.ts の OCCTO_SOURCE）。
 */
import { type EnvHttpProxyAgent, fetch } from 'undici';
import { isoFromDay, parseDateString } from '../src/lib/dates';
import type { OcctoCsvKind } from '../src/lib/occto';

export const DEFAULT_OCCTO_BASE = 'https://occtonet3.occto.or.jp/public/dfw/RP11/OCCTO/SD/';
const SCREEN = 'CF01S010C';
/** 情報ダウンロード画面の「データ種別」（06: 連系線空容量（翌日）、11: 連系線潮流実績） */
const DATA_KIND: Record<OcctoCsvKind, string> = { plan: '06', flow: '11' };
/** 取得できる期間が入る項目 */
const RANGE_FIELD: Record<OcctoCsvKind, string> = { plan: 'akyuryNdKkn', flow: 'rklFlowRsltKkn' };
const USER_AGENT = 'jepx-viewer/0.1 (+https://github.com/yo-fork/JEPX-Viewer)';

/** 取得できる期間（受渡日。分からなければ null） */
export type OcctoRanges = Record<OcctoCsvKind, [number, number] | null>;

interface AjaxRoot {
  root: {
    errMessage?: { msgFormat?: string }[] | null;
    bizRoot?: { header?: Record<string, { value?: string } | undefined> };
  };
}

const slashDate = (day: number) => isoFromDay(day).replace(/-/g, '/');

/** 「(2016/06/02〜2026/10/03)」のような期間 */
export function parseRange(text: string | undefined): [number, number] | null {
  const dates = [...(text ?? '').matchAll(/(\d{4})\/(\d{2})\/(\d{2})/g)]
    .map((m) => parseDateString(`${m[1]}-${m[2]}-${m[3]}`))
    .filter((d): d is number => d !== null);
  return dates.length >= 2 ? [dates[0], dates[dates.length - 1]] : null;
}

export class OcctoClient {
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly base: string,
    private readonly dispatcher: EnvHttpProxyAgent,
  ) {}

  private async send(url: string, body: string | null, ajax = false): Promise<Awaited<ReturnType<typeof fetch>>> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Referer: `${this.base}${SCREEN}?fwExtention.pathInfo=${SCREEN}&fwExtention.prgbrh=0` };
    if (this.cookies.size > 0) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    if (ajax) {
      headers.sdReqType = 'AJAX';
      headers['X-Requested-With'] = 'XMLHttpRequest';
    }
    const res = await fetch(url, { method: body === null ? 'GET' : 'POST', body: body ?? undefined, headers, dispatcher: this.dispatcher });
    for (const c of res.headers.getSetCookie()) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(c);
      if (m) this.cookies.set(m[1], m[2]);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return res;
  }

  /** 情報ダウンロード画面に送る項目（連系線の値は「すべての対象連系線区間」） */
  private fields(sub: string, kind: OcctoCsvKind | null, from: number, to: number, extra: Record<string, string> = {}): string {
    return new URLSearchParams({
      'fwExtention.actionType': 'reference',
      'fwExtention.actionSubType': sub,
      'fwExtention.pagingTargetTable': '',
      'fwExtention.pathInfo': SCREEN,
      'fwExtention.prgbrh': '0',
      'fwExtention.formId': 'CF01S010P',
      'fwExtention.jsonString': '',
      ajaxToken: '',
      requestToken: '',
      requestTokenBk: '',
      transitionContextKey: 'DEFAULT',
      tabSntk: '0',
      downloadKey: '',
      ...(kind
        ? {
            rklDataKnd: DATA_KIND[kind],
            // 策定（前日に決めた値）
            dvlSlashLblUpdaf: '1',
            rklNngpFrom: slashDate(from),
            rklNngpTo: slashDate(to),
            allTgtRklSectDwld: 'Y',
            areaDataKnd: '22',
          }
        : {}),
      ...extra,
    }).toString();
  }

  private async ajax(sub: string, kind: OcctoCsvKind | null, from: number, to: number, extra: Record<string, string> = {}): Promise<AjaxRoot['root']> {
    const res = await this.send(`${this.base}${SCREEN}`, this.fields(sub, kind, from, to, extra), true);
    let json: AjaxRoot;
    try {
      json = JSON.parse(await res.text()) as AjaxRoot;
    } catch {
      throw new Error('広域機関の画面から想定と違う応答がありました（画面の仕様が変わった可能性があります）');
    }
    const err = json.root?.errMessage;
    if (err && err.length > 0) throw new Error(err.map((e) => e.msgFormat ?? '').join(' '));
    return json.root;
  }

  /** セッションを作って情報ダウンロード画面を開き、取得できる期間を返す */
  async open(): Promise<OcctoRanges> {
    this.cookies.clear();
    await this.send(`${this.base}LOGIN_login`, null);
    const html = await (await this.send(`${this.base}${SCREEN}?fwExtention.pathInfo=${SCREEN}&fwExtention.prgbrh=0`, '')).text();
    if (html.includes('タイムアウト') || !html.includes('情報ダウンロード')) throw new Error('広域機関の情報ダウンロード画面を開けませんでした');
    const header = (await this.ajax('initDisplay', null, 0, 0)).bizRoot?.header ?? {};
    return { plan: parseRange(header[RANGE_FIELD.plan]?.value), flow: parseRange(header[RANGE_FIELD.flow]?.value) };
  }

  /** 連系線の CSV（受渡日 from〜to、すべての連系線。Shift_JIS のまま）を取得する */
  async download(kind: OcctoCsvKind, from: number, to: number): Promise<Uint8Array> {
    const check = await this.ajax('print', kind, from, to);
    const token = check.bizRoot?.header?.requestToken?.value ?? '';
    const ready = await this.ajax('ok', kind, from, to, { requestToken: token });
    const h = ready.bizRoot?.header ?? {};
    const downloadKey = h.downloadKey?.value;
    if (!downloadKey) throw new Error('広域機関の画面から、ダウンロードの準備の応答がありませんでした');
    const res = await this.send(`${this.base}${SCREEN}`, this.fields('download', kind, from, to, { downloadKey, requestToken: h.requestToken?.value ?? '' }));
    return new Uint8Array(await res.arrayBuffer());
  }
}
