/* UI settings synced to the server (GET/PUT /api/settings/:key) with a localStorage cache.
   - get() is synchronous (reads the cache, merged over registered defaults)
   - set()/patch() write the cache immediately and PUT to the server (debounced)
   - sync(keys) pulls server values once after login (server wins; local-only values are pushed up)
   Keys are namespaced per user in localStorage. Max 64 KB per key (server limit). */
import { api, ApiError, type Tune } from './api';

export interface Prefs {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  lang: 'en' | 'id';      // AI speaking language (Coffee etc.)
  sttLang: string;        // Web Speech recognition language
  voiceId: string;        // '' = character default
  audioTags: boolean;
  autoSpeak: boolean;
  handsFree: boolean;
  showTags: boolean;
  names: Record<string, string>;   // renamed character nicks, per character id
  levelVoices: boolean;   // "Samakan volume suara": client-side loudness leveling (lib/leveler.ts)
}

export const PREFS_DEFAULT: Prefs = {
  theme: 'system', accent: '', lang: 'en', sttLang: 'en-US', voiceId: '',
  audioTags: true, autoSpeak: true, handsFree: false, showTags: true, names: {}, levelVoices: true,
};
export const TUNE_DEFAULT: Tune = { stability: 0.5, similarity: 0.75, style: 0, speed: 1, speakerBoost: false };

const defaults = new Map<string, unknown>([['prefs', PREFS_DEFAULT], ['tune', TUNE_DEFAULT]]);
const cache = new Map<string, unknown>();
const subs = new Map<string, Set<(v: any) => void>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const dirty = new Set<string>();
let ns = 'anon';
let online = false;          // true once logged-in & active: PUTs go to the server

const lsKey = (k: string) => `sm2:${ns}:${k}`;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function readLocal(k: string): unknown {
  try { const s = localStorage.getItem(lsKey(k)); return s == null ? undefined : JSON.parse(s); } catch { return undefined; }
}
function writeLocal(k: string, v: unknown) { try { localStorage.setItem(lsKey(k), JSON.stringify(v)); } catch { /* quota / private mode */ } }

function merged<T>(k: string, v: unknown): T {
  const d = defaults.get(k);
  if (isObj(d) && isObj(v)) return { ...clone(d), ...v } as T;
  return (v === undefined ? clone(d) : v) as T;
}

function notify(k: string) { const v = get(k); subs.get(k)?.forEach((fn) => { try { fn(v); } catch (e) { console.error(e); } }); }

/** Server response may be {value} / {value_json} / the raw value. */
function unwrap(r: any): unknown {
  if (r == null) return undefined;
  if (isObj(r) && 'value' in r) return r.value ?? undefined;
  if (isObj(r) && 'value_json' in r) { const v = r.value_json; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } } return v ?? undefined; }
  return r;
}

async function push(k: string) {
  timers.delete(k);
  if (!online) return;
  const v = cache.has(k) ? cache.get(k) : readLocal(k);
  const body = JSON.stringify({ value: v });
  if (body.length > 64 * 1024) { console.warn(`setting "${k}" > 64 KB, kept local only`); dirty.delete(k); return; }
  try { await api.put(`/settings/${encodeURIComponent(k)}`, { value: v }); dirty.delete(k); }
  catch (e) { if (!(e instanceof ApiError) || e.status >= 500 || e.status === 0) setTimeout(() => schedule(k), 5000); else dirty.delete(k); }
}
function schedule(k: string, ms = 600) {
  dirty.add(k);
  const t = timers.get(k); if (t) clearTimeout(t);
  timers.set(k, setTimeout(() => push(k), ms));
}

export function get<T = any>(key: string, fallback?: T): T {
  if (!cache.has(key)) { const v = readLocal(key); if (v !== undefined) cache.set(key, v); }
  const v = cache.get(key);
  if (v === undefined && fallback !== undefined && !defaults.has(key)) return fallback;
  return merged<T>(key, v);
}

export function set<T = any>(key: string, value: T): void {
  cache.set(key, clone(value)); writeLocal(key, value); schedule(key); notify(key);
}

export function patch<T extends object>(key: string, partial: Partial<T>): T {
  const next = { ...get<T>(key), ...partial } as T;
  set(key, next);
  return next;
}

/** Register defaults for a key (call before get). Objects are shallow-merged under stored values. */
export function register<T>(key: string, def: T): void { defaults.set(key, def); }

export function subscribe<T = any>(key: string, fn: (v: T) => void): () => void {
  let s = subs.get(key); if (!s) subs.set(key, (s = new Set()));
  s.add(fn);
  return () => { s!.delete(fn); };
}

/** Pull keys from the server. Server value wins; if the server has nothing but we have a local value, upload it. */
export async function sync(keys: string[] = ['prefs', 'tune']): Promise<void> {
  // one round-trip for everything (GET /api/settings -> {settings:{key:value}}); fall back to per-key GETs
  try {
    const all = (await api.get<{ settings: Record<string, unknown> }>('/settings')).settings || {};
    for (const k of new Set([...keys, ...Object.keys(all)])) {
      const v = all[k];
      if (v !== undefined && v !== null) { if (!dirty.has(k)) { cache.set(k, v); writeLocal(k, v); notify(k); } }
      else if (keys.includes(k) && readLocal(k) !== undefined) schedule(k, 50);
    }
    return;
  } catch { /* older server: per key */ }
  await Promise.all(keys.map(async (k) => {
    try {
      const r = await api.get(`/settings/${encodeURIComponent(k)}`);
      const v = unwrap(r);
      if (v !== undefined && !dirty.has(k)) { cache.set(k, v); writeLocal(k, v); notify(k); }
      else if (readLocal(k) !== undefined) schedule(k, 50);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && readLocal(k) !== undefined) schedule(k, 50);
    }
  }));
}

/** Called on login/logout. Switches the localStorage namespace and enables server writes. */
export function setUser(userId: string | number | null, active: boolean): void {
  const next = userId == null ? 'anon' : String(userId);
  if (next !== ns) { cache.clear(); ns = next; }
  online = !!userId && active;
}

/** Flush pending writes now (e.g. on page hide). */
export function flush(): void {
  for (const k of [...dirty]) {
    const t = timers.get(k); if (t) clearTimeout(t); timers.delete(k);
    if (!online) continue;
    const body = JSON.stringify({ value: cache.get(k) });
    if (body.length > 64 * 1024) continue;
    try { fetch(`/api/settings/${encodeURIComponent(k)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body }); } catch { /* ignore */ }
    dirty.delete(k);
  }
}
addEventListener('pagehide', flush);

/** Per-user localStorage only (never synced) — for bulky data like chat sessions. */
export const local = {
  get<T>(key: string, fallback: T): T { const v = readLocal('local.' + key); return v === undefined ? fallback : (v as T); },
  set(key: string, value: unknown): void { writeLocal('local.' + key, value); },
  remove(key: string): void { try { localStorage.removeItem(lsKey('local.' + key)); } catch { /* ignore */ } },
};

export const prefs = () => get<Prefs>('prefs');
export const setPrefs = (p: Partial<Prefs>) => patch<Prefs>('prefs', p);
export const tune = () => get<Tune>('tune');
export const setTune = (p: Partial<Tune>) => patch<Tune>('tune', p);

export const settings = { get, set, patch, register, subscribe, sync, flush, setUser, local, prefs, setPrefs, tune, setTune, PREFS_DEFAULT, TUNE_DEFAULT };
export type Settings = typeof settings;
