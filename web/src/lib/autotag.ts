/* Auto tag: POST /api/tts/autotag {text, language?, intensity} -> {text} (same words + [audio tags]).
   The result is accepted only when its words are exactly the input's words (tags removed), so the text never changes.
   MOCK: while the server has no endpoint (404) a small local heuristic is used (remove `mockAutotag` + the 404 branch
   once the endpoint is everywhere). */
import { api } from '../api';
import { t } from '../i18n';

export type Intensity = 'light' | 'normal' | 'rich';
export const INTENSITY: Array<[Intensity, string, string]> = [
  ['light', t('Ringan'), t('Beberapa tag saja')],
  ['normal', t('Normal'), t('Seimbang dan natural')],
  ['rich', t('Kaya'), t('Ekspresif, banyak tag')],
];

/** Words of a text without audio tags (for the "text unchanged" check). */
export const bareWords = (t: string) => t.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();

export const AUTOTAG_MAX = 3000;
export async function autoTag(text: string, intensity: Intensity, signal?: AbortSignal, language?: string): Promise<{ text: string; mock: boolean; fallback: boolean }> {
  if (text.length > AUTOTAG_MAX) throw Object.assign(new Error(t('Auto tag maksimal {max} karakter. Pendekkan teksnya dulu.', { max: AUTOTAG_MAX })), { code: 'too_long' });
  let out: string; let mock = false, fallback = false;
  try {
    const r = await api.post<{ text: string; added?: number; fallback?: boolean }>('/tts/autotag', { text, intensity, ...(language ? { language } : {}) }, { signal });
    out = String(r?.text ?? '');
    fallback = !!r?.fallback;
  } catch (e: any) {
    if (e?.status !== 404 || e?.code === 'voice_forbidden') throw e;
    out = mockAutotag(text, intensity); mock = true;               // MOCK (endpoint not deployed yet)
  }
  if (bareWords(out) !== bareWords(text)) throw Object.assign(new Error(t('Hasil auto tag mengubah isi teks, jadi tidak dipakai. Coba lagi.')), { code: 'changed' });
  return { text: out, mock, fallback };
}

export interface TagLine { speaker: string; text: string }
export const AUTOTAG_DIALOGUE_MAX = 6000;
/** Dialogue auto tag: every line is tagged with its speaker as context (POST /api/tts/autotag {lines}).
    Accepted only when every line keeps exactly its words. */
export async function autoTagLines(lines: TagLine[], intensity: Intensity, signal?: AbortSignal): Promise<{ lines: string[]; mock: boolean; fallback: boolean }> {
  const total = lines.reduce((n, l) => n + l.text.length, 0);
  if (total > AUTOTAG_DIALOGUE_MAX) throw Object.assign(new Error(t('Auto tag dialog maksimal {max} karakter.', { max: AUTOTAG_DIALOGUE_MAX })), { code: 'too_long' });
  let out: string[]; let mock = false, fallback = false;
  try {
    const r = await api.post<{ lines?: TagLine[]; fallback?: boolean }>('/tts/autotag', { lines, intensity }, { signal });
    out = lines.map((l, i) => String(r?.lines?.[i]?.text ?? l.text));
    fallback = !!r?.fallback;
  } catch (e: any) {
    if (e?.status !== 404) throw e;
    out = lines.map((l) => mockAutotag(l.text, intensity)); mock = true;   // MOCK (endpoint not deployed yet)
  }
  if (out.length !== lines.length || out.some((t, i) => bareWords(t) !== bareWords(lines[i].text))) throw Object.assign(new Error(t('Hasil auto tag mengubah isi teks, jadi tidak dipakai. Coba lagi.')), { code: 'changed' });
  return { lines: out, mock, fallback };
}

/* ---------- MOCK: local heuristic (only used when the server has no /tts/autotag) ---------- */
export function mockAutotag(text: string, intensity: Intensity): string {
  const every = intensity === 'light' ? 3 : intensity === 'normal' ? 2 : 1;
  const parts = text.split(/(?<=[.!?…]["')\]]?)(\s+)/);
  let n = 0;
  return parts.map((p) => {
    if (!p.trim() || /^\s+$/.test(p)) return p;
    const i = n++;
    if (i % every !== 0 || /^\s*\[/.test(p)) return p;
    const tag = /\b(ha(ha)+|lol|lucu|funny)\b/i.test(p) ? 'laughs' : /\?\s*$/.test(p) ? 'curious' : /!\s*$/.test(p) ? 'excited'
      : /\.\.\.|…/.test(p) ? 'pause' : i === 0 ? 'warmly' : intensity === 'rich' ? ['softly', 'thoughtful', 'cheerfully'][i % 3] : '';
    if (!tag) return p;
    const lead = /^\s*/.exec(p)![0];
    return `${lead}[${tag}] ${p.slice(lead.length)}`;
  }).join('');
}
