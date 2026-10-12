/* Shared roleplay helpers for the Chat and Voice call screens (port of old app.js / voice.js). */
import { api, type Character } from '../api';
import { prefs } from '../settings';

export interface Verdict { decision: 'passed' | 'rejected'; reason?: string; feedback?: string }
export interface ChatMsg { role: 'user' | 'assistant'; content: string }
export interface CustomChar { prompt: string; voiceId?: string }

const ICONS: Record<string, string> = { barista: 'cup', interviewer: 'briefcase', detective: 'search', friend: 'moon' };
export const charIcon = (c: Pick<Character, 'id'> | null | undefined) => (c?.id ? ICONS[c.id] || 'user' : 'sparkle');

export const cleanName = (s: unknown) => String(s || '').replace(/[^\p{L}\p{N}\s.'-]/gu, '').trim().slice(0, 30);
export const cleanAccent = (s: unknown) => String(s || '').replace(/[^\p{L}\s,'-]/gu, '').trim().slice(0, 40);

export const customChar = (custom?: CustomChar | null): Character => ({
  id: '', name: 'Karakter custom', role: 'Custom', greeting: 'Hello! Shall we begin?', voiceId: custom?.voiceId || undefined,
});

/** Display name: renamed nick (prefs.names[id]) > nick > name. */
export function displayName(c: Character): string {
  if (!c.id) return c.name;
  return c.nick ? cleanName(prefs().names?.[c.id]) || c.nick : c.name;
}

export interface StreamChatArgs {
  character: Character;
  custom?: CustomChar | null;
  messages: ChatMsg[];
  signal?: AbortSignal;
  onText: (delta: string, full: string) => void;
}

/** POST /api/chat (SSE): {t} deltas, {end} verdict, {error}. Returns the full reply + verdict. */
export async function streamChat(a: StreamChatArgs): Promise<{ reply: string; verdict: Verdict | null }> {
  const p = prefs();
  let reply = '', verdict: Verdict | null = null, err: string | null = null;
  await api.sse('/chat', {
    characterId: a.character.id || undefined,
    customPrompt: a.character.id ? undefined : a.custom?.prompt,
    messages: a.messages,
    audioTags: p.audioTags,
    charName: a.character.nick ? displayName(a.character) : '',
    model: p.model || undefined,
    thinking: p.thinking,
    accent: cleanAccent(p.accent),
  }, {
    signal: a.signal,
    onEvent: (j) => {
      if (!j || typeof j !== 'object') return;
      if (j.error) { err = typeof j.error === 'string' ? j.error : j.error.message || 'Error'; return; }
      if (j.end) { verdict = j.end; return; }
      if (typeof j.t === 'string' && j.t) { reply += j.t; a.onText(j.t, reply); }
    },
  });
  if (err && !reply) throw new Error(err);
  if (!reply && !verdict) throw new Error('Respons kosong dari model.');
  return { reply, verdict };
}

/** Voice to use: explicit pick > custom voice > character default. */
export function activeVoice(c: Character | null, custom?: CustomChar | null): string {
  return prefs().voiceId || custom?.voiceId || c?.voiceId || '21m00Tcm4TlvDq8ikWAM';
}

/** Text sent to TTS: prefix the accent tag when audio tags are on (per chunk, not shown in chat). */
export function ttsText(text: string): string {
  const p = prefs(); const acc = cleanAccent(p.accent);
  return acc && p.audioTags ? `[strong ${acc} accent] ${text}` : text;
}
