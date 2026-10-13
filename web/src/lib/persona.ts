/* Chat personas: built-in characters from /api/characters + the user's own personas (synced via /api/settings).
   Streaming chat goes through POST /api/chat (built-in: characterId, custom: persona {name, description, accent, language}). */
import { api, type Character } from '../api';
import { settings } from '../settings';
import { personaOrb, type CustomOrb } from '../ui/orb';
import { BRAND } from './brand';
import { forgetMemory } from './memory';

export interface CustomPersona {
  id: string;            // 'c_xxxxxxxx'
  name: string;
  description: string;   // personality / traits / situation
  accent: string;
  lang: string;          // LANGS key
  voiceId: string;
  greeting: string;
  createdAt: number;
  orb?: CustomOrb | null; // own orb (Studio Bola); none = inherits the voice's orb
}
export interface PersonaOverride { voiceId?: string; lang?: string; accent?: string; orb?: CustomOrb | null }
export interface ChatPrefs {
  speak: boolean; last: string; over: Record<string, PersonaOverride>;
  /** the persona may search the web (chat tool web_search); default on */
  webSearch: boolean;
  /** Mode Percakapan (full duplex: the mic stays open, you can talk over the persona) */
  convo: boolean;
  /** the "use headphones" hint was dismissed */
  hpHint: boolean;
}

export interface Persona {
  id: string;
  builtin: boolean;
  name: string;
  sub: string;           // one-line description for the list
  icon: string;
  voiceId: string;       // effective voice (override > default)
  defaultVoiceId: string;
  lang: string;
  accent: string;
  greeting: string;
  tools: string[];
  orb?: CustomOrb | null;
  custom?: CustomPersona;
}

/** The built-in persona / shared voice is called BRAND (lib/brand.ts) in the UI, whatever the upstream account calls it. */
const BRAND_RE = /[.*+?^${}()|[\]\\]/g;
const brandDup = new RegExp(`\\b${BRAND.replace(BRAND_RE, '\\$&')}(\\s+${BRAND.replace(BRAND_RE, '\\$&')})+\\b`, 'g');
export const brandName = (s: string) => String(s || '').replace(/\b(?:stripe|strape)(\s+heeler)?\b|\bheeler\b/gi, BRAND).replace(brandDup, BRAND);

/** A chat tool call as streamed by /api/chat: {tool:{id,name,status,query?,sources?,ms?}}. Generic: the UI picks its
    label / icon from `name` (web_search today). */
export interface ToolSource { title: string; url: string }
export interface ToolEvent { id: string; name: string; status: 'start' | 'done' | 'error'; query?: string; sources?: ToolSource[]; ms?: number; error?: string; code?: string }
/** Where an assistant reply was cut off by the user (full duplex). */
export interface Interrupt { spokenText: string; unspokenText: string }
export interface ChatMsg {
  role: 'user' | 'assistant'; content: string;
  /** assistant reply cut off by the user: `content` holds only what was really spoken */
  interrupted?: Interrupt;
  /** tool calls made for this reply (transcript) */
  tools?: ToolEvent[];
  /** this reply continues an interrupted one ("Lanjutkan") */
  resumed?: boolean;
}
export interface Verdict { decision: 'passed' | 'rejected' | 'hangup'; reason?: string; feedback?: string }
/** `mem` = how many of `msgs` were already sent to /api/memory/commit (the next commit sends only the rest). */
export interface ChatLog { msgs: ChatMsg[]; verdict?: Verdict | null; mem?: number; /** calls this persona placed itself (call_persona, max 1) */ calls?: number }

export const LANGS: Array<[string, string, string, string]> = [
  // key, label (UI), English name (prompt), speech-recognition locale
  ['en', 'English', 'English', 'en-US'],
  ['id', 'Indonesia', 'Indonesian', 'id-ID'],
  ['es', 'Español', 'Spanish', 'es-ES'],
  ['fr', 'Français', 'French', 'fr-FR'],
  ['de', 'Deutsch', 'German', 'de-DE'],
  ['pt', 'Português', 'Portuguese', 'pt-BR'],
  ['it', 'Italiano', 'Italian', 'it-IT'],
  ['ja', '日本語', 'Japanese', 'ja-JP'],
  ['ko', '한국어', 'Korean', 'ko-KR'],
];
/** Map a language given as key / English name / label / locale ("Indonesian", "id", "Bahasa Indonesia") to a LANGS key. */
export function langKey(s: unknown, fallback = 'en'): string {
  const t = String(s || '').trim().toLowerCase();
  if (!t) return fallback;
  const hit = LANGS.find(([k, label, name, loc]) => t === k || t === label.toLowerCase() || t === name.toLowerCase() || t === loc.toLowerCase() || t.startsWith(k + '-'))
    || LANGS.find(([, label, name]) => t.includes(name.toLowerCase()) || t.includes(label.toLowerCase()));
  return hit ? hit[0] : fallback;
}
/** 'auto' = the persona mirrors the user's language (the built-in BRAND persona); no `language` is sent. */
export const AUTO = 'auto';
export const langLabel = (k: string) => (k === AUTO ? 'Ikuti bahasamu' : LANGS.find((l) => l[0] === k)?.[1] || 'English');
export const langName = (k: string) => (k === AUTO ? '' : LANGS.find((l) => l[0] === k)?.[2] || 'English');
export const sttLocale = (k: string) => (k === AUTO ? (navigator.language || 'en-US') : LANGS.find((l) => l[0] === k)?.[3] || 'en-US');

export const ACCENTS = ['American', 'British', 'Australian', 'Irish', 'Scottish', 'Canadian', 'Indian', 'Southern US', 'New York', 'Jamaican', 'South African', 'French', 'German', 'Italian', 'Spanish', 'Japanese', 'Korean', 'Indonesian'];

const ICONS: Record<string, string> = {
  barista: 'cup', interviewer: 'briefcase', detective: 'search', friend: 'smile', tsundere: 'flame', wolf: 'crown', bandit: 'heart',
};
/** The built-in persona's (shared) voice: always usable. */
export const DEFAULT_VOICE = 'FjsOoJ0RVxWEQK4p2Wzq';

export const cleanAccent = (s: unknown) => String(s || '').replace(/[^\p{L}\s,'-]/gu, '').trim().slice(0, 40);
export const cleanName = (s: unknown) => String(s || '').replace(/[^\p{L}\p{N}\s.'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 30);

settings.register<ChatPrefs>('chat.prefs', { speak: true, last: '', over: {}, webSearch: true, convo: false, hpHint: false });
settings.register<CustomPersona[]>('chat.personas', []);

/** The built-in persona was called 'stripe' internally until the full rename to Strix; move saved data over once. */
const LEGACY_BUILTIN_ID = 'stripe', BUILTIN_ID = 'strix';
let migrating = false;
function migrateLegacyId(p: ChatPrefs): void {
  if (migrating) return;
  const hasOver = !!(p.over && p.over[LEGACY_BUILTIN_ID]);
  if (!hasOver && p.last !== LEGACY_BUILTIN_ID) return;
  migrating = true;
  try {
    const over = { ...(p.over || {}) };
    if (over[LEGACY_BUILTIN_ID]) { over[BUILTIN_ID] = { ...over[LEGACY_BUILTIN_ID], ...(over[BUILTIN_ID] || {}) }; delete over[LEGACY_BUILTIN_ID]; }
    try {
      const old = settings.local.get<ChatLog | null>('chat.log.' + LEGACY_BUILTIN_ID, null);
      if (old && !settings.local.get<ChatLog | null>('chat.log.' + BUILTIN_ID, null)) settings.local.set('chat.log.' + BUILTIN_ID, old);
      settings.local.remove('chat.log.' + LEGACY_BUILTIN_ID);
    } catch { /* storage unavailable */ }
    settings.patch<ChatPrefs>('chat.prefs', { over, last: p.last === LEGACY_BUILTIN_ID ? BUILTIN_ID : p.last });
  } finally { migrating = false; }
}
export const chatPrefs = () => {
  const p = settings.get<ChatPrefs>('chat.prefs');
  if (p) migrateLegacyId(p);
  return settings.get<ChatPrefs>('chat.prefs');
};
export const setChatPrefs = (p: Partial<ChatPrefs>) => settings.patch<ChatPrefs>('chat.prefs', p);
export const customPersonas = () => (settings.get<CustomPersona[]>('chat.personas') || []).filter((p) => p && p.id);

export function setOverride(id: string, o: PersonaOverride | null): void {
  const over = { ...chatPrefs().over };
  if (o) over[id] = { ...(over[id] || {}), ...o }; else delete over[id];
  setChatPrefs({ over });
}

export function saveCustom(p: CustomPersona): void {
  const list = customPersonas();
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p; else list.push(p);
  settings.set('chat.personas', list);
}
export function deleteCustom(id: string): void {
  settings.set('chat.personas', customPersonas().filter((p) => p.id !== id));
  setOverride(id, null);
  settings.local.remove('chat.log.' + id);
  void forgetMemory(id).catch(() => { /* offline: the orphaned memory stays until "Lupakan" / admin cleanup */ });
}
export const newId = () => 'c_' + Math.random().toString(36).slice(2, 10);

export function fromCharacter(c: Character & { description?: string; lang?: string; accent?: string }): Persona {
  const o = chatPrefs().over[c.id] || {};
  return {
    id: c.id, builtin: true,
    name: brandName(c.nick || c.name),
    sub: brandName(c.description || c.role || ''),
    orb: o.orb || null,
    icon: ICONS[c.id] || 'user',
    defaultVoiceId: c.voiceId || DEFAULT_VOICE,
    voiceId: o.voiceId || c.voiceId || DEFAULT_VOICE,
    lang: o.lang || c.lang || (c.mirrorLanguage ? AUTO : langKey(c.language)),
    accent: o.accent ?? c.accent ?? '',
    greeting: brandName(c.greeting || ''),
    tools: c.tools || [],
  };
}
export function fromCustom(c: CustomPersona): Persona {
  return {
    id: c.id, builtin: false, name: c.name || 'Persona', sub: c.description || '', icon: 'sparkle',
    defaultVoiceId: c.voiceId || DEFAULT_VOICE, voiceId: c.voiceId || DEFAULT_VOICE,
    lang: c.lang || 'en', accent: c.accent || '', greeting: c.greeting || '', tools: [], custom: c, orb: c.orb || null,
  };
}

/** The persona's magic orb: its own custom orb, else the voice's (custom or deterministic, varied by the name). */
export const orbSpecFor = (p: Pick<Persona, 'voiceId' | 'name'> & { orb?: CustomOrb | null }) => personaOrb(p.voiceId, p.name, p.orb);

/** Save the custom orb of any persona (custom: on the persona; built-in: in its override). null = inherit again. */
export function setPersonaOrb(p: Persona, o: CustomOrb | null): void {
  if (p.custom) saveCustom({ ...p.custom, orb: o });
  else setOverride(p.id, { orb: o });
}

/** "Roleplay rules" clause the server appends to public-figure personas: kept separate in the editor so it cannot be lost. */
const CLAUSE_RE = /\s*Roleplay rules:[\s\S]*$/;
export function splitClause(desc: string): { base: string; clause: string } {
  const m = CLAUSE_RE.exec(desc || '');
  if (!m) return { base: desc || '', clause: '' };
  return { base: desc.slice(0, m.index).trimEnd(), clause: m[0].trim() };
}
export const joinClause = (base: string, clause: string) => (clause ? `${base.trim()}\n\n${clause}` : base.trim());

/** The greeting shown when a conversation starts (built-in greetings are English; skip them for other languages). */
export function greetingFor(p: Persona): string {
  if (p.builtin && p.lang !== 'en' && p.lang !== AUTO) return '';
  return p.greeting.trim();
}

export const logKey = (id: string) => 'chat.log.' + id;
export const loadLog = (id: string): ChatLog => settings.local.get<ChatLog>(logKey(id), { msgs: [] });
export function saveLog(id: string, log: ChatLog) {
  const cut = Math.max(0, log.msgs.length - 60);   // only the last 60 are kept on the device; `mem` follows the cut
  settings.local.set(logKey(id), { msgs: log.msgs.slice(cut), verdict: log.verdict || null, mem: Math.max(0, (log.mem || 0) - cut), ...(log.calls ? { calls: log.calls } : {}) });
}

const safeUrl = (u: unknown) => { try { const x = new URL(String(u)); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch { return ''; } };
/** Validate a streamed tool event (untrusted JSON). */
export function parseTool(t: any): ToolEvent | null {
  if (!t || typeof t !== 'object' || typeof t.name !== 'string') return null;
  const status = t.status === 'done' || t.status === 'error' ? t.status : 'start';
  const sources = Array.isArray(t.sources) ? t.sources.map((x: any) => ({ title: String(x?.title || '').slice(0, 200), url: safeUrl(x?.url) })).filter((x: ToolSource) => x.url).slice(0, 12) : undefined;
  return {
    id: String(t.id || t.name), name: t.name.slice(0, 40), status,
    query: typeof t.query === 'string' ? t.query.slice(0, 300) : undefined,
    sources, ms: Number.isFinite(t.ms) ? Number(t.ms) : undefined,
    error: typeof t.error === 'string' ? t.error.slice(0, 300) : typeof t.message === 'string' ? t.message.slice(0, 300) : undefined,
    code: typeof t.code === 'string' ? t.code : typeof t.error === 'string' && /quota/i.test(t.error) ? 'quota' : undefined,
  };
}

/** POST /api/chat (SSE): {t} deltas, {tool} tool calls, {end} verdict, {error}.
    Full duplex: assistant messages may carry `interrupted`; `resumeHint` asks the persona to continue a cut-off reply. */
export async function streamChat(a: {
  persona: Persona; messages: ChatMsg[]; speak: boolean; signal?: AbortSignal; onText: (delta: string, full: string) => void;
  onTool?: (t: ToolEvent) => void; resumeHint?: 'continue' | 'rephrase' | 'drop'; webSearch?: boolean;
  /** the persona opens a new conversation itself from its memory (no messages); `noMemory` = use the static greeting */
  opener?: boolean;
  /** false = no cross-conversation memory (the intro tour's demo line) */
  memory?: boolean;
  /** who this persona may phone into a group call (tool call_persona) and how many calls it already placed */
  callable?: Array<{ id: string; name: string; description: string }>; callsMade?: number;
  onCall?: (c: { target: string; name: string; reason: string }) => void;
}): Promise<{ reply: string; verdict: Verdict | null; noMemory?: boolean; call?: { target: string; name: string; reason: string } | null }> {
  const p = a.persona;
  const messages = a.opener ? [] : a.messages.filter((m) => m.content.trim() || m.interrupted).map((m) => ({ role: m.role, content: m.content.trim() || '…', ...(m.interrupted ? { interrupted: m.interrupted } : {}) }));
  let reply = '', verdict: Verdict | null = null, err: string | null = null, noMemory = false;
  let call: { target: string; name: string; reason: string } | null = null;
  await api.sse('/chat', {
    ...(p.builtin ? { characterId: p.id } : { persona: { name: p.name, description: p.custom!.description, accent: cleanAccent(p.accent), language: langName(p.lang) } }),
    ...(a.memory === false ? {} : { memoryId: p.id }),   // cross-conversation memory (built-in id or this custom persona's id)
    ...(a.opener ? { opener: true } : {}),
    messages,
    audioTags: a.speak,
    ...(p.lang === AUTO ? {} : { language: langName(p.lang) }),
    accent: cleanAccent(p.accent),
    ...(a.resumeHint ? { resumeHint: a.resumeHint } : {}),
    ...(a.webSearch === false ? { tools: { web: false } } : {}),
    ...(a.callable?.length && !a.opener ? { callable: a.callable, callsMade: a.callsMade || 0 } : {}),
  }, {
    signal: a.signal,
    onEvent: (j) => {
      if (!j || typeof j !== 'object') return;
      if (j.noMemory === true) { noMemory = true; return; }
      if (j.error) { err = typeof j.error === 'string' ? j.error : j.error.message || 'Error'; return; }
      if (j.end) { verdict = j.end; return; }
      if (j.call && typeof j.call.target === 'string') { call = { target: j.call.target, name: String(j.call.name || ''), reason: String(j.call.reason || '') }; a.onCall?.(call); return; }
      if (j.tool) { const t = parseTool(j.tool); if (t) a.onTool?.(t); return; }
      if (typeof j.t === 'string' && j.t) { reply += j.t; a.onText(j.t, reply); }
    },
  });
  if (noMemory) return { reply: '', verdict: null, noMemory };
  if (err && !reply) throw new Error(err);
  if (!reply && !verdict && !call) throw new Error('Balasan kosong dari model. Coba kirim lagi.');
  return { reply, verdict, call };
}

/** Text shown on screen: audio tags removed, whitespace tidied. */
export function visibleText(t: string): string {
  return t.replace(/\[[^\]]*\]?/g, ' ').replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?…])/g, '$1').replace(/^\s+/, '');
}

/** Text sent to TTS: accent tag prefixed when tags are on. */
export function ttsText(p: Persona, text: string): string {
  const acc = cleanAccent(p.accent);
  return acc ? `[strong ${acc} accent] ${text}` : text;
}
