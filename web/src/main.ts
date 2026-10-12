import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/screens.css';
import './styles/features.css';
import './theme';
import { refreshOrbs } from './lib/orbs';
import { api, ApiError, onApiEvent } from './api';
import { store, resetCaches, loadConfig, refreshMe } from './store';
import { settings } from './settings';
import { setTheme } from './theme';
import { mountShell } from './shell';
import { renderLogin, renderRedeem, renderSuspended, renderBootError } from './screens/auth';
import { toast } from './ui/overlay';
import { player } from './player';
import { h } from './ui/dom';

const root = document.getElementById('app')!;
let teardown: (() => void) | null = null;
let phase: 'boot' | 'login' | 'redeem' | 'suspended' | 'app' = 'boot';

function leaveApp() { try { teardown?.(); } catch (e) { console.error(e); } teardown = null; player.stop(); }

function toLogin() {
  leaveApp(); settings.setUser(null, false); resetCaches();
  phase = 'login'; renderLogin(root);
}

async function boot() {
  root.replaceChildren(h('div', { class: 'boot' }, h('span', { class: 'spinner', 'aria-label': 'Memuat' })));
  let me;
  try { me = await api.me(); }
  catch (e) {
    if (e instanceof ApiError && e.status === 401) return toLogin();
    phase = 'boot';
    return renderBootError(root, (e as Error).message || 'Server tidak merespons.', boot);
  }
  store.set({ me });
  if (me.user.status === 'suspended') { leaveApp(); phase = 'suspended'; settings.setUser(me.user.id, false); return renderSuspended(root, toLogin); }
  if (me.user.status !== 'active') {
    leaveApp(); phase = 'redeem'; settings.setUser(me.user.id, false);
    return renderRedeem(root, me, () => { toast('Akun aktif. Selamat datang!', { kind: 'ok' }); boot(); }, toLogin);
  }
  settings.setUser(me.user.id, true);
  refreshOrbs();
  // theme from synced prefs (server wins once synced)
  setTheme(settings.prefs().theme);
  const synced = settings.sync(['prefs', 'tune']).then(() => { setTheme(settings.prefs().theme); refreshOrbs(); });
  loadConfig().catch(() => {});
  if (phase !== 'app') {
    phase = 'app'; leaveApp(); teardown = mountShell(root, toLogin);
    // first visit: animated intro (decided after the server settings arrive, so another device's "onboarded" counts)
    Promise.race([synced.catch(() => {}), new Promise((r) => setTimeout(r, 2500))]).then(() => {
      if (phase === 'app' && settings.get<boolean>('onboarded', false) !== true) import('./ui/intro').then((m) => m.openIntro()).catch(() => {});
    });
  }
}

/* global API reactions */
let lastQuotaToast = 0;
onApiEvent((e) => {
  switch (e.type) {
    case 'unauthorized':
      if (phase === 'app' || phase === 'redeem') { toast('Sesi berakhir. Silakan masuk lagi.', { kind: 'warn' }); toLogin(); }
      break;
    case 'invite_required':
      if (phase === 'app') { phase = 'boot'; leaveApp(); boot(); }
      break;
    case 'suspended':
      if (phase !== 'suspended') { phase = 'boot'; leaveApp(); boot(); }
      break;
    case 'quota':
      if (Date.now() - lastQuotaToast > 4000) { lastQuotaToast = Date.now(); toast(e.message, { kind: 'warn', title: 'Kuota habis', timeout: 8000 }); }
      refreshMe(0);
      break;
    case 'usage':
      if (phase === 'app') refreshMe(1500);
      break;
  }
});

// dev-only handle for debugging / automated UI tests
if (import.meta.env.DEV) (window as any).__sm = { api, store, settings, player };

boot();
