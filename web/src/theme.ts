/* Theme: 'system' | 'light' | 'dark' → resolved onto <html data-theme>. Last choice also kept outside the per-user
   namespace so the login page renders in the right theme before we know the user. */
import { store } from './store';

const mq = matchMedia('(prefers-color-scheme: dark)');
let pref: 'system' | 'light' | 'dark' = 'system';
try { const t = localStorage.getItem('sm2:theme'); if (t === 'light' || t === 'dark' || t === 'system') pref = t; } catch { /* ignore */ }

function resolve(): 'light' | 'dark' { return pref === 'system' ? (mq.matches ? 'dark' : 'light') : pref; }
function paint() {
  const t = resolve();
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'dark' ? '#0f1013' : '#f6f6f7');
  store.set({ theme: t });
}
mq.addEventListener('change', () => { if (pref === 'system') paint(); });

export function setTheme(p: 'system' | 'light' | 'dark') {
  pref = p; try { localStorage.setItem('sm2:theme', p); } catch { /* ignore */ }
  paint();
}
export const themePref = () => pref;
paint();
