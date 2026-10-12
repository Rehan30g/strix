import { config } from './config.js';
import { all, one, run, type VoiceRow } from './db.js';
import { characters } from './characters.js';
import { sniffAudio } from './audio.js';

const API = 'https://api.elevenlabs.io';

export class UpstreamError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function elevenHeaders(extra: Record<string, string> = {}) {
  return { 'xi-api-key': config.elevenKey, ...extra };
}

/* ---------------- account voices (cached 5 min) ---------------- */

interface ElevenVoice {
  voice_id: string;
  name: string;
  category?: string;
  preview_url?: string | null;
  description?: string | null;
  labels?: Record<string, string> | null;
}

const CACHE_MS = 5 * 60_000;
let accountCache: { at: number; voices: ElevenVoice[] } = { at: 0, voices: [] };
let inflight: Promise<ElevenVoice[]> | null = null;
// single-voice lookups (shared voices missing from the listing, legacy premades) - same TTL
const singleCache = new Map<string, { at: number; voice: ElevenVoice | null }>();

export function invalidateVoiceCache() { accountCache = { at: 0, voices: [] }; singleCache.clear(); }

export async function accountVoices(): Promise<ElevenVoice[]> {
  if (accountCache.at && Date.now() - accountCache.at < CACHE_MS) return accountCache.voices;
  inflight ??= (async () => {
    try {
      const r = await fetch(`${API}/v1/voices`, { headers: elevenHeaders() });
      if (!r.ok) throw new UpstreamError(r.status, `ElevenLabs: ${(await r.text()).slice(0, 300)}`);
      const { voices = [] } = (await r.json()) as { voices?: ElevenVoice[] };
      accountCache = { at: Date.now(), voices };
      return voices;
    } finally { inflight = null; }
  })();
  return inflight;
}

/** One voice by id (account listing first, then GET /v1/voices/{id}); null if ElevenLabs doesn't know it. */
async function voiceById(voiceId: string): Promise<ElevenVoice | null> {
  const hit = (await accountVoices()).find((v) => v.voice_id === voiceId);
  if (hit) return hit;
  const c = singleCache.get(voiceId);
  if (c && Date.now() - c.at < CACHE_MS) return c.voice;
  const r = await fetch(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, { headers: elevenHeaders() });
  let voice: ElevenVoice | null = null;
  if (r.ok) voice = (await r.json()) as ElevenVoice;
  else if (r.status !== 404 && r.status !== 400) throw new UpstreamError(r.status, `ElevenLabs: ${(await r.text()).slice(0, 300)}`);
  else await r.body?.cancel();
  if (singleCache.size > 200) singleCache.clear();
  singleCache.set(voiceId, { at: Date.now(), voice });
  return voice;
}

export type VoiceCategory = 'premade' | 'cloned' | 'library' | 'shared';
export interface PublicVoice {
  id: string;
  name: string;
  category: VoiceCategory;
  previewUrl?: string;
  own: boolean;
  /** true for library voices the user added to their collection (and in /voices/library listings) */
  inCollection?: boolean;
  labels?: Record<string, string>;
  description?: string;
  /** public Voice Library voices: source voice id + public owner id */
  sourceId?: string;
  ownerId?: string;
}

const CLONE_LIKE = new Set(['cloned', 'professional_clone']);
const sharedIds = () => new Set(config.sharedVoiceIds);
export const isSharedVoice = (voiceId: string) => config.sharedVoiceIds.includes(voiceId);

/** Same-origin preview proxy (ElevenLabs preview hosts send no CORS headers -> Web Audio would play silence). */
export const previewProxyUrl = (voiceId: string) => `/api/voices/${encodeURIComponent(voiceId)}/preview`;

/**
 * Renamed voices (SHARED_VOICE_NAMES): the display name replaces the ElevenLabs account name, and the account's
 * own name words are scrubbed from description/labels so the old name never reaches the client.
 */
function displayFields(v: ElevenVoice) {
  const rename = config.sharedVoiceNames[v.voice_id];
  if (!rename) return { name: v.name, labels: v.labels ?? undefined, description: v.description ?? undefined };
  // old/upstream persona names are always scrubbed too (never sent to the client)
  const words = [...String(v.name ?? '').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3), 'Stripe', 'Strape', 'Heeler']
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(${words.join('|')})\\b`, 'iu');
  const ok = (s: unknown) => !re.test(String(s ?? ''));
  const labels = v.labels ? Object.fromEntries(Object.entries(v.labels).filter(([k, val]) => ok(k) && ok(val))) : undefined;
  return { name: rename, labels, description: v.description && ok(v.description) ? v.description : undefined };
}

function toPublic(v: ElevenVoice, category: VoiceCategory, own: boolean): PublicVoice {
  const d = displayFields(v);
  return {
    id: v.voice_id,
    name: d.name,
    category,
    own,
    ...(v.preview_url && { previewUrl: previewProxyUrl(v.voice_id) }),
    ...(d.labels && Object.keys(d.labels).length && { labels: d.labels }),
    ...(d.description && { description: d.description }),
  };
}

/**
 * The voice LIBRARY: the account's premade + library voices. Excluded: anything clone-like, any app
 * user's clone, and shared voices (those are always in every collection anyway).
 */
export async function libraryVoices(): Promise<{ v: ElevenVoice; category: VoiceCategory }[]> {
  const acct = await accountVoices();
  const shared = sharedIds();
  const anyUserClone = new Set(all<{ eleven_voice_id: string }>('SELECT eleven_voice_id FROM voices').map((v) => v.eleven_voice_id));
  return acct
    .filter((v) => !shared.has(v.voice_id) && !anyUserClone.has(v.voice_id) && !CLONE_LIKE.has(v.category ?? ''))
    .map((v) => ({ v, category: (v.category === 'premade' ? 'premade' : 'library') as VoiceCategory }));
}

export async function isLibraryVoice(voiceId: string) {
  return (await libraryVoices()).some((x) => x.v.voice_id === voiceId);
}

const collectionIds = (userId: number) =>
  new Set(all<{ voice_id: string }>('SELECT voice_id FROM user_voices WHERE user_id = ?', userId).map((r) => r.voice_id));

/**
 * A user's COLLECTION (GET /voices): own clones + shared voices (always) + library voices the user added.
 * Clones of other users are never visible.
 */
export async function voicesFor(userId: number): Promise<PublicVoice[]> {
  const acct = await accountVoices();
  const owned = all<VoiceRow>('SELECT * FROM voices WHERE user_id = ?', userId);
  const out: PublicVoice[] = [];
  const seen = new Set<string>();
  // own clones (fall back to the DB row if the account listing hasn't caught up yet)
  for (const row of owned) {
    if (isSharedVoice(row.eleven_voice_id)) continue; // shown as shared below
    const v = acct.find((a) => a.voice_id === row.eleven_voice_id);
    seen.add(row.eleven_voice_id);
    out.push(v ? toPublic(v, 'cloned', true)
      : { id: row.eleven_voice_id, name: row.name, category: 'cloned', own: true, ...(row.description && { description: row.description }) });
  }
  // shared voices: name/preview from the account; never deletable (own:false), even for the cloner
  for (const id of sharedIds()) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const v = await voiceById(id);
      if (v) out.push(toPublic(v, 'shared', false));
    } catch { /* ElevenLabs hiccup: skip this one, keep the list */ }
  }
  // library voices in the user's collection (silently skipped if the voice left the library)
  const coll = collectionIds(userId);
  const added: PublicVoice[] = [];
  // public Voice Library voices (shared_voice_map): rendered from the stored listing data
  for (const m of all<{ account_voice_id: string; source_voice_id: string; public_owner_id: string; name: string; meta_json: string | null }>(
    'SELECT m.account_voice_id, m.source_voice_id, m.public_owner_id, m.name, m.meta_json FROM shared_voice_map m JOIN user_voices u ON u.voice_id = m.account_voice_id WHERE u.user_id = ?', userId)) {
    if (seen.has(m.account_voice_id)) continue;
    seen.add(m.account_voice_id);
    let meta: { description?: string | null; preview_url?: string | null; labels?: Record<string, unknown> } = {};
    try { meta = m.meta_json ? JSON.parse(m.meta_json) : {}; } catch { /* keep empty */ }
    const labels = Object.fromEntries(Object.entries(meta.labels ?? {}).filter(([, v]) => typeof v === 'string' && v).map(([k, v]) => [k, String(v)]));
    added.push({
      id: m.account_voice_id, name: m.name || 'Library', category: 'library', own: false, inCollection: true,
      sourceId: m.source_voice_id, ownerId: m.public_owner_id,
      ...(meta.preview_url && { previewUrl: `${previewProxyUrl(m.account_voice_id)}?owner=${encodeURIComponent(m.public_owner_id)}` }),
      ...(Object.keys(labels).length && { labels }),
      ...(meta.description && { description: String(meta.description).slice(0, 600) }),
    });
  }
  for (const { v, category } of await libraryVoices()) {
    if (!coll.has(v.voice_id) || seen.has(v.voice_id)) continue;
    seen.add(v.voice_id);
    added.push({ ...toPublic(v, category, false), inCollection: true });
  }
  added.sort((a, b) => a.name.localeCompare(b.name));
  return [...out, ...added];
}

const characterVoiceIds = new Set(characters.map((c) => c.voiceId));

/**
 * May this user synthesize with voiceId (/tts, /vc, /chat persona)?
 * Only: shared voices, built-in persona voices, own clones, or library voices in the user's collection.
 * A premade/library voice that is not in the collection -> false (403 voice_forbidden).
 */
export async function canUseVoice(userId: number, voiceId: string): Promise<boolean> {
  if (isSharedVoice(voiceId)) return true; // shared with every active user
  if (one('SELECT 1 FROM voices WHERE user_id = ? AND eleven_voice_id = ?', userId, voiceId)) return true;
  if (one('SELECT 1 FROM voices WHERE eleven_voice_id = ?', voiceId)) return false; // someone else's clone
  if (characterVoiceIds.has(voiceId)) return true;
  return !!one('SELECT 1 FROM user_voices WHERE user_id = ? AND voice_id = ?', userId, voiceId);
}

/** May this user hear the preview? Anything usable, plus every library voice (to browse before adding). */
export async function canPreviewVoice(userId: number, voiceId: string) {
  return (await canUseVoice(userId, voiceId)) || isLibraryVoice(voiceId);
}

/* ---------------- preview proxy ---------------- */

const PREVIEW_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm', mp4: 'audio/mp4', aac: 'audio/aac',
};
const PREVIEW_TTL = 30 * 60_000;
const PREVIEW_MAX_BYTES = 3 * 1024 * 1024;
const PREVIEW_MAX_ENTRIES = 300;
const PREVIEW_MAX_TOTAL = 80 * 1024 * 1024; // all cached previews together
let previewBytes = 0;
const previewCache = new Map<string, { at: number; type: string; data: Buffer }>();

/** Only ElevenLabs-owned https hosts: *.elevenlabs.io, or their public GCS bucket. */
export function isAllowedPreviewUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  if (host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io')) return true;
  return host === 'storage.googleapis.com' && u.pathname.startsWith('/eleven-public-prod/');
}

/** Fetch (and briefly cache) a voice's preview audio. null = voice has no preview. */
export async function previewAudio(voiceId: string, libraryUrl?: () => Promise<string | null>): Promise<{ type: string; data: Buffer } | null> {
  const c = previewCache.get(voiceId);
  if (c && Date.now() - c.at < PREVIEW_TTL) return c;
  // public Voice Library voice (not on the account): its listing preview_url; else the account voice's preview
  let src = libraryUrl ? await libraryUrl() : null;
  if (!src) src = (await voiceById(voiceId))?.preview_url ?? null;
  if (!src) return null;
  let url = src;
  let r: Response | null = null;
  for (let hop = 0; hop < 4; hop++) { // follow redirects manually, re-validating every hop
    if (!isAllowedPreviewUrl(url)) throw new UpstreamError(0, 'ElevenLabs: preview URL host not allowed');
    r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!loc) break;
    await r.body?.cancel();
    url = new URL(loc, url).toString();
    r = null;
  }
  if (!r) throw new UpstreamError(0, 'ElevenLabs: too many preview redirects');
  if (!r.ok) throw new UpstreamError(r.status, `ElevenLabs preview: HTTP ${r.status}`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > PREVIEW_MAX_BYTES) { await r.body?.cancel(); throw new UpstreamError(0, 'ElevenLabs preview: too large'); }
  const data = Buffer.from(await r.arrayBuffer());
  if (!data.length || data.length > PREVIEW_MAX_BYTES) throw new UpstreamError(0, 'ElevenLabs preview: empty or too large');
  // GCS serves the mp3s as text/plain, so trust the bytes (magic numbers), never the upstream content-type
  const kind = sniffAudio(data);
  if (!kind) throw new UpstreamError(0, 'ElevenLabs preview: not an audio file');
  const entry = { at: Date.now(), type: PREVIEW_MIME[kind] ?? 'audio/mpeg', data };
  const old = previewCache.get(voiceId);
  if (old) { previewBytes -= old.data.length; previewCache.delete(voiceId); }
  while (previewCache.size && (previewCache.size >= PREVIEW_MAX_ENTRIES || previewBytes + data.length > PREVIEW_MAX_TOTAL)) {
    const k = previewCache.keys().next().value!;
    previewBytes -= previewCache.get(k)!.data.length;
    previewCache.delete(k);
  }
  previewCache.set(voiceId, entry);
  previewBytes += data.length;
  return entry;
}

export async function deleteElevenVoice(voiceId: string) {
  const r = await fetch(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'DELETE', headers: elevenHeaders() });
  // 404/400 = already gone at ElevenLabs; still remove locally
  if (!r.ok && r.status !== 404 && r.status !== 400) throw new UpstreamError(r.status, `ElevenLabs: ${(await r.text()).slice(0, 300)}`);
  invalidateVoiceCache();
}

/** Delete all of a user's clones (ElevenLabs + DB). Shared voices are never deleted. Returns count deleted. */
export async function deleteUserVoices(userId: number) {
  const rows = all<VoiceRow>('SELECT * FROM voices WHERE user_id = ?', userId);
  let n = 0;
  for (const v of rows) {
    if (isSharedVoice(v.eleven_voice_id)) continue;
    await deleteElevenVoice(v.eleven_voice_id);
    run('DELETE FROM voices WHERE id = ?', v.id);
    n++;
  }
  return n;
}

/* ---------------- TTS concurrency (semaphore) ---------------- */

let active = 0;
const waiters: { grant: () => void }[] = [];

export function acquireTts(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    if (active < config.maxTtsConcurrent) { active++; return resolve(); }
    const w = { grant: () => { active++; resolve(); } };
    waiters.push(w);
    signal.addEventListener('abort', () => {
      const i = waiters.indexOf(w);
      if (i >= 0) { waiters.splice(i, 1); reject(new Error('aborted')); }
    }, { once: true });
  });
}

export function releaseTts() {
  active--;
  waiters.shift()?.grant();
}

export interface TtsParams {
  text: string;
  voiceId: string;
  model: string;
  format: string;
  voiceSettings: Record<string, number | boolean>;
  stream: boolean;
}

/** POST to ElevenLabs TTS with retry on 429 (concurrency). Caller must hold the semaphore. */
export async function ttsRequest(p: TtsParams, signal: AbortSignal): Promise<Response> {
  const url = `${API}/v1/text-to-speech/${encodeURIComponent(p.voiceId)}${p.stream ? '/stream' : ''}?output_format=${encodeURIComponent(p.format)}`;
  let r: Response;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(url, {
      method: 'POST',
      signal,
      headers: elevenHeaders({ 'Content-Type': 'application/json', Accept: 'audio/mpeg' }),
      body: JSON.stringify({ text: p.text, model_id: p.model, voice_settings: p.voiceSettings }),
    });
    if (r.status !== 429 || attempt >= 4) break;
    await r.body?.cancel();
    await new Promise((ok) => setTimeout(ok, 500 * (attempt + 1)));
  }
  return r;
}
