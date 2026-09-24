/**
 * CSV バイト列の文字コード判定とデコード。
 * JEPX の CSV は Shift_JIS（CP932）だが、Excel で保存し直したファイルなど UTF-8 の場合もある。
 */
export type TextEncodingName = 'utf-8' | 'shift_jis';

export function decodeCsvBytes(input: ArrayBuffer | Uint8Array): { text: string; encoding: TextEncodingName } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  try {
    // 日本語を含む Shift_JIS のバイト列は UTF-8 としてほぼ確実に不正になる
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    return { text: new TextDecoder('shift_jis').decode(bytes), encoding: 'shift_jis' };
  }
}
