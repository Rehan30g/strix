/* Keeps the UI language (i18n.ts, localStorage) in step with the per-user synced setting `uiLang` = { lang, at }.
   (Named uiLang, not lang, so it is not confused with prefs.lang, the language the AI speaks.)
   - choosing a language while signed in writes the setting and flushes it before the reload
   - after login, settings.sync() brings the server value: the newer choice wins. A newer server choice (made on
     another device) is adopted with one reload; a newer local one (e.g. picked on the login page) is pushed up. */
import { settings } from '../settings';
import { getLang, langChosenAt, onLang, storeLang, type Lang } from '../i18n';

const KEY = 'uiLang';
type Saved = { lang: Lang; at: number };

onLang((l) => { settings.set<Saved>(KEY, { lang: l, at: Date.now() }); settings.flush(); });

/** Call once the synced settings have arrived (signed in and active). */
export function reconcileLang(): void {
  const s = settings.get<Saved | null>(KEY, null);
  const localAt = langChosenAt();
  if (s && (s.lang === 'id' || s.lang === 'en') && Number(s.at) > localAt) {
    storeLang(s.lang, Number(s.at));
    // reload only when it was saved (private mode would otherwise loop)
    if (s.lang !== getLang() && langChosenAt() === Number(s.at)) location.reload();
  } else if (localAt && (!s || s.lang !== getLang() || Number(s.at) < localAt)) {
    settings.set<Saved>(KEY, { lang: getLang(), at: localAt });
  }
}
