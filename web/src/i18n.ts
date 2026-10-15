/* UI language (Indonesian = source/default, English US = translation).
   - t('Teks Indonesia {x}', { x }) : the key IS the Indonesian text. 'id' returns it as is (params filled in);
     'en' looks it up in i18n/en.json and falls back to the Indonesian text when an entry is missing.
   - The English table is loaded with a top-level await before any module that imports this one runs, so calling t() at
     module scope (constant maps, route labels) is safe. Indonesian visitors never download it.
   - The choice lives in localStorage (sm2.lang + sm2.langAt, outside the per-user namespace so the login page already
     knows it); lib/uilang.ts mirrors it into the synced user settings. Changing it reloads the page (see setLang).
   This module must not import anything from the app (it sits under everything else). See i18n/README.md. */
export type Lang = 'id' | 'en';
export type Params = Record<string, string | number>;

const LS = 'sm2.lang', LS_AT = 'sm2.langAt';
const isLang = (v: unknown): v is Lang => v === 'id' || v === 'en';

/** Saved choice, else English (the default; Indonesian is one tap away). */
function detect(): Lang {
  try { const s = localStorage.getItem(LS); if (isLang(s)) return s; } catch { /* private mode */ }
  return 'en';
}

const loaders = import.meta.glob<Record<string, string>>('./i18n/en.json', { import: 'default' });
async function loadEn(): Promise<Record<string, string> | null> {
  try { return await loaders['./i18n/en.json'](); } catch (e) { console.warn('i18n: English table failed to load', e); return null; }
}

let lang: Lang = detect();
let dict: Record<string, string> | null = lang === 'en' ? await loadEn() : null;
if (lang === 'en' && !dict) lang = 'id';      // offline / stale build: stay coherent in Indonesian
document.documentElement.lang = lang;

const warned = new Set<string>();
const fill = (s: string, p?: Params) => (p ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m)) : s);

/** Translate. `key` must be a plain string literal (scripts/i18n.mjs extracts it). Placeholders: {name}. */
export function t(key: string, params?: Params): string {
  if (dict) {
    const v = dict[key];
    if (v) return fill(v, params);
    if (import.meta.env.DEV && !warned.has(key)) { warned.add(key); console.warn('i18n missing', key); }
  }
  return fill(key, params);
}

export const getLang = (): Lang => lang;
/** BCP 47 locale for Intl / toLocale*String. */
export const locale = (): string => (lang === 'en' ? 'en-US' : 'id-ID');

/** When the choice was made (ms; 0 = never chosen, only detected). Used to reconcile with the synced setting. */
export function langChosenAt(): number {
  try { return Number(localStorage.getItem(LS_AT) || 0) || 0; } catch { return 0; }
}

const subs = new Set<(l: Lang) => void>();
/** Runs right before the page reloads into a new language (e.g. to save the choice to the server). */
export function onLang(cb: (l: Lang) => void): () => void { subs.add(cb); return () => { subs.delete(cb); }; }

/** Save the language locally only (no reload, no listeners). `at` = when it was chosen. */
export function storeLang(l: Lang, at = Date.now()): void {
  try { localStorage.setItem(LS, l); localStorage.setItem(LS_AT, String(at)); } catch { /* private mode */ }
}

/** Switch language: persist, tell listeners (they flush the synced setting), then reload so every screen is rebuilt
    in the new language. Resolves (without reloading) only when `l` is already the current language. */
export async function setLang(l: Lang): Promise<void> {
  if (!isLang(l)) return;
  storeLang(l);
  if (l === lang) return;
  subs.forEach((f) => { try { f(l); } catch (e) { console.error(e); } });
  if (l === 'en') await loadEn();               // warm the chunk so the reload does not wait for it
  await new Promise((r) => setTimeout(r, 120)); // let a keepalive settings PUT leave
  location.reload();
}
