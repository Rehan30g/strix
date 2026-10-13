/* Group calls (server: /api/duo/turn SSE, /api/duo/ring JSON; see server/CONTRACT-NOTES.md "Duo").
   Participants are built-in personas or the user's own custom personas. */
import { api } from '../api';
import { AUTO, langName, cleanAccent, type Persona } from './persona';

export interface DuoMsg {
  role: 'user' | 'assistant' | 'event';
  speaker?: string;                     // persona id (assistant)
  content: string;
  interrupted?: { spokenText: string; unspokenText: string };
}
export interface Participant { id: string; kind: 'builtin' | 'custom'; language?: string; persona?: { name: string; description: string; accent: string; language: string; voiceId: string } }
export interface Callable { id: string; name: string; description: string }
export interface CallEvent { target: string; name: string; reason: string; caller?: string }
export interface EndEvent { decision: 'hangup'; reason?: string; speaker?: string }

export function participant(p: Persona): Participant {
  if (p.builtin) return { id: p.id, kind: 'builtin', ...(p.lang === AUTO ? {} : { language: langName(p.lang) }) };
  return { id: p.id, kind: 'custom', persona: { name: p.name, description: p.custom?.description || p.sub || p.name, accent: cleanAccent(p.accent), language: langName(p.lang), voiceId: p.voiceId } };
}
export const callable = (list: Persona[]): Callable[] => list.slice(0, 8).map((p) => ({ id: p.id, name: p.name, description: (p.sub || '').slice(0, 200) }));

/** POST /api/duo/turn. Plain JSON answers (nobody / chain cap) come back as `{json}`. */
export async function duoTurn(body: Record<string, unknown>, h: {
  signal?: AbortSignal; onSpeaker?: (id: string, info: any) => void; onText?: (d: string, full: string) => void;
  onEnd?: (e: EndEvent) => void; onCall?: (c: CallEvent) => void; onNext?: (next: string, info: any) => void;
}): Promise<{ speaker: string | null; text: string; next: string | null; end: EndEvent | null; call: CallEvent | null; json?: any; error?: string }> {
  let speaker: string | null = null, text = '', next: string | null = null, end: EndEvent | null = null, call: CallEvent | null = null, json: any, error: string | undefined;
  await api.sse('/duo/turn', body, {
    signal: h.signal,
    onEvent: (j) => {
      if (!j || typeof j !== 'object') return;
      if (typeof j.speaker === 'string') { speaker = j.speaker; h.onSpeaker?.(j.speaker, j); return; }
      if (typeof j.t === 'string' && j.t) { text += j.t; h.onText?.(j.t, text); return; }
      if (j.end) { end = j.end; h.onEnd?.(j.end); return; }
      if (j.call) { call = j.call; h.onCall?.(j.call); return; }
      if (j.error) { error = String(j.error); return; }
      if (typeof j.next === 'string') { next = j.next; if (speaker) h.onNext?.(j.next, j); else json = j; }
    },
  });
  return { speaker, text, next, end, call, json, error };
}

export interface RingLine { speaker: string; text: string }
/** eaction = a persona already on the call reacting while it rings (null when the user is alone); fter = its line
    once the call was declined / not answered. The callee itself says nothing before it picks up. */
export interface RingResult { decision: 'answer' | 'decline' | 'ignore' | 'off'; rings: number; reaction: RingLine | null; after?: RingLine | null; attempt: number; maxAttempts?: number; why?: string[]; ms?: number }
export const duoRing = (body: Record<string, unknown>, signal?: AbortSignal) =>
  api.raw('/duo/ring', { method: 'POST', json: body, signal, headers: { Accept: 'application/json' } }).then((r) => r.json() as Promise<RingResult>);
