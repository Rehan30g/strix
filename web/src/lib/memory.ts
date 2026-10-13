/* Cross-conversation memory of chat personas (server: /api/memory, see server/CONTRACT-NOTES.md "Memory").
   Plain fetch on purpose: memory is a background nicety, a failure must stay silent (no global toasts / quota events). */

export type CommitReason = 'hangup' | 'quit' | 'restart' | 'switch' | 'idle' | 'duo';
export interface MemoryMood { label: string; intensity: number; intensityNow: number; nowLabel?: string; reason: string; at: string | null }
export interface MemoryEvent { id: number; text: string; at: string | null; from?: string; to?: string[]; fromName?: string; toNames?: string[]; kind?: 'solo' | 'duo' | 'missed' }
export interface PersonaMemory {
  personaId: string; exists: boolean; summary: string; facts: string[]; mood: MemoryMood | null;
  lastEndAt: string | null; lastEndReason: string | null; lastEndNote: string | null; turns: number; updatedAt: string | null;
  heard: MemoryEvent[]; told: MemoryEvent[];
  /** calls this persona did not take (declined / let ring), last 7 days */
  missed?: MemoryEvent[];
}

/** Debug / test hook: last commit results. */
export const memoryLog: Array<{ personaId: string; reason: string; ok: boolean; status: number; ms: number; at: number; skipped?: string }> = [];

const TAGS = /\[[^\]]{0,60}\]/g;

/** POST /api/memory/commit. Never throws; resolves false on any failure (the chat goes on regardless). */
export async function commitMemory(a: {
  personaId: string; personaName: string; reason: CommitReason; hangupReason?: string;
  messages: Array<{ role: string; content: string; speaker?: string }>; keepalive?: boolean; timeoutMs?: number;
  /** group call: who else was on it (assistant messages then carry speaker) */
  duo?: { with: Array<{ id: string; name: string }> };
}): Promise<boolean> {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), a.timeoutMs ?? 12_000);
  const messages = a.messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.replace(TAGS, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200), ...(m.speaker ? { speaker: m.speaker } : {}) }))
    .filter((m) => m.content)
    .slice(-40);
  let status = 0, ok = false, skipped: string | undefined;
  try {
    const r = await fetch('/api/memory/commit', {
      method: 'POST', credentials: 'same-origin', signal: ac.signal, keepalive: !!a.keepalive,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        personaId: a.personaId, personaName: a.personaName.slice(0, 40), reason: a.reason, messages,
        ...(a.reason === 'hangup' || a.reason === 'quit' ? { hangup: { reason: (a.hangupReason || '').slice(0, 300) } } : {}),
        ...(a.duo ? { duo: { with: a.duo.with.slice(0, 4).map((w) => ({ id: w.id, name: w.name.slice(0, 40) })) } } : {}),
      }),
    });
    status = r.status;
    if (r.ok) { const j: any = await r.json().catch(() => null); ok = !!j?.ok; skipped = j?.skipped; }
  } catch { /* offline / aborted: ignored */ } finally { clearTimeout(timer); }
  memoryLog.push({ personaId: a.personaId, reason: a.reason, ok, status, ms: Math.round(performance.now() - t0), at: Date.now(), skipped });
  if (memoryLog.length > 50) memoryLog.shift();
  return ok;
}

async function call<T>(method: 'GET' | 'DELETE', path: string): Promise<T> {
  const r = await fetch('/api/memory/' + path, { method, credentials: 'same-origin', headers: { Accept: 'application/json' } });
  const j: any = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.message || (r.status === 429 ? 'Terlalu sering. Coba lagi sebentar.' : `Gagal (${r.status}).`));
  return j as T;
}
export const getMemory = (id: string) => call<PersonaMemory>('GET', encodeURIComponent(id));
export const forgetMemory = (id: string) => call<{ ok: boolean }>('DELETE', encodeURIComponent(id));
export const forgetShared = () => call<{ ok: boolean; events: number }>('DELETE', 'shared');

/* ---------- human wording (Indonesian UI) ---------- */
const MOOD_ID: Record<string, string> = {
  calm: 'tenang', warm: 'hangat', happy: 'senang', touched: 'terharu', amused: 'terhibur', hurt: 'sakit hati', sad: 'sedih',
  annoyed: 'kesal', angry: 'marah', furious: 'murka', cold: 'dingin', sulky: 'merajuk', wary: 'waspada', worried: 'khawatir', embarrassed: 'malu',
};
export const moodWord = (l: string) => MOOD_ID[l] || l;
export function moodText(m: MemoryMood | null): string {
  if (!m || m.label === 'calm') return 'Tenang';
  const now = m.nowLabel && m.nowLabel !== m.label ? `${moodWord(m.label)}, kini tinggal ${moodWord(m.nowLabel)}` : moodWord(m.label);
  const x = m.intensityNow;
  const how = x >= 0.7 ? 'masih kuat' : x >= 0.45 ? 'masih terasa' : x >= 0.2 ? 'mulai reda' : 'sudah reda';
  return `${now[0].toUpperCase()}${now.slice(1)} (${how})`;
}
export function agoText(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 2) return 'baru saja';
  if (min < 60) return `${min} menit lalu`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h} jam lalu`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} hari lalu`;
  return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}
