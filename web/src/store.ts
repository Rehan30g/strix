/* Minimal reactive app store + cached loaders for shared server data (me, config, voices, characters). */
import { api, type Me, type Config, type Voice, type Character } from './api';

export interface AppState {
  me: Me | null;
  config: Config | null;
  voices: Voice[] | null;
  voicesError: string | null;
  characters: Character[] | null;
  theme: 'light' | 'dark';
  route: string;
}

type Sub<T> = (state: T, prev: T) => void;

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<Sub<T>>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const prev = state;
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const s of subs) { try { s(state, prev); } catch (e) { console.error(e); } }
    },
    /** Subscribe to all changes. Returns unsubscribe. */
    subscribe(fn: Sub<T>) { subs.add(fn); return () => { subs.delete(fn); }; },
    /** Subscribe to one selected value; fires only when it changes (Object.is). */
    select<V>(pick: (s: T) => V, fn: (v: V, prev: V) => void, immediate = false) {
      let cur = pick(state);
      if (immediate) fn(cur, cur);
      const un = (s: T) => { const v = pick(s); if (!Object.is(v, cur)) { const p = cur; cur = v; fn(v, p); } };
      subs.add(un);
      return () => { subs.delete(un); };
    },
  };
}

export const store = createStore<AppState>({
  me: null, config: null, voices: null, voicesError: null, characters: null, theme: 'light', route: '',
});

/* ---------- cached loaders ---------- */
let voicesP: Promise<Voice[]> | null = null, voicesAt = 0;
/** Voices (premade + own clones). Cached ~5 min; pass force to refetch after clone/delete. */
export function loadVoices(force = false): Promise<Voice[]> {
  if (!force && voicesP && Date.now() - voicesAt < 5 * 60_000) return voicesP;
  voicesAt = Date.now();
  voicesP = api.voices().then((v) => { store.set({ voices: v, voicesError: null }); return v; })
    .catch((e) => { voicesP = null; store.set({ voicesError: e.message }); throw e; });
  return voicesP;
}

let configP: Promise<Config> | null = null;
export function loadConfig(): Promise<Config> {
  configP ??= api.config().then((c) => { store.set({ config: c }); return c; }).catch((e) => { configP = null; throw e; });
  return configP;
}

let charsP: Promise<Character[]> | null = null;
export function loadCharacters(): Promise<Character[]> {
  charsP ??= api.characters().then((c) => { store.set({ characters: c }); return c; }).catch((e) => { charsP = null; throw e; });
  return charsP;
}

let meT: ReturnType<typeof setTimeout> | null = null;
/** Re-fetch /me (quota meter). Debounced. */
export function refreshMe(delay = 800): void {
  if (meT) clearTimeout(meT);
  meT = setTimeout(async () => { meT = null; try { store.set({ me: await api.me() }); } catch { /* handled globally */ } }, delay);
}

export function resetCaches(): void { voicesP = null; configP = null; charsP = null; store.set({ voices: null, config: null, characters: null, me: null }); }

export type Store = typeof store;
