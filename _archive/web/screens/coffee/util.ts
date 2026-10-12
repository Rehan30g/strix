/* Small pure helpers shared by the Coffee modules. */
import type { Msg, ToolCall } from './types';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Rupiah: 22000 -> "Rp22.000" (negative keeps the sign). */
export const rp = (n: number): string => { n = Math.round(+n || 0); return (n < 0 ? '-' : '') + 'Rp' + Math.abs(n).toLocaleString('id-ID'); };

/** mm:ss relative duration (call timer / call timestamps). */
export const mmss = (ms: number): string => {
  const t = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');
};

const TAG_RE = /\[[^\]\n]{1,80}\]\s*/g;
/** Audio tags [..] are voice-only: removed before text goes to another model or is used as an option/argument. */
export const stripTags = (t: unknown): string => String(t ?? '').replace(TAG_RE, '').trim();
/** Text for the screen: tags hidden unless "show tags" is on. */
export const visText = (t: unknown, showTags: boolean): string =>
  showTags ? String(t ?? '') : String(t ?? '').replace(/\s*\[[^\]\n]{1,80}\]\s*/g, ' ').replace(/ {2,}/g, ' ').trim();

export const parseArgs = (tc: ToolCall): Record<string, any> => { try { return JSON.parse(tc.function.arguments || '{}') || {}; } catch { return {}; } };

/** Fields prefixed "_" are UI-only and never sent to a model. */
export const stripPrivate = (msgs: Msg[]): Record<string, unknown>[] =>
  msgs.map((m) => { const o: Record<string, unknown> = {}; for (const k in m) if (!k.startsWith('_')) o[k] = (m as any)[k]; return o; });

export const normWords = (t: string): string[] => String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
export const isSubsequence = (small: string[], big: string[]): boolean => {
  let j = 0; for (const w of big) if (j < small.length && w === small[j]) j++;
  return j === small.length;
};

/** Sentence spans of a reply, with their offsets in the original text.
    A sentence ends at . ! ? … followed by whitespace/end (so "Rp22.000" or "3.5" never splits), at a newline, or at the end. */
export function sentenceSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const re = /\S[^\n]*?(?:[.!?…]+(?=\s|$)|(?=\n)|$)/g;
  const out: Array<{ start: number; end: number; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Typed tokens (tags skipped) with their offset in the raw text, for text revealed in sync with speech. */
export function typedTokens(raw: string): Array<{ o: number; t: string }> {
  const out: Array<{ o: number; t: string }> = [], re = /\[[^\]\n]{1,80}\]\s*|\S+\s*/g;
  let m: RegExpExecArray | null;
  const s = String(raw ?? '');
  while ((m = re.exec(s))) {
    if (m[0].startsWith('[') && /^\[[^\]\n]{1,80}\]/.test(m[0])) continue;
    out.push({ o: m.index, t: m[0] });
  }
  return out;
}

/** Drop the last word / tag that is still being written by the model. */
export function liveSafe(raw: string): string {
  let t = String(raw ?? '');
  const lb = t.lastIndexOf('['); if (lb > t.lastIndexOf(']')) t = t.slice(0, lb);
  return /\s$/.test(t) ? t : t.replace(/\S+$/, '');
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Small stable hash (voice pick for ad-hoc contacts). */
export function hashStr(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
