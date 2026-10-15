/* App shell: slim sidebar (desktop) / bottom tab bar (mobile), top bar with the account avatar, hash router. */
import { h, avatar } from './ui/dom';
import { svg } from './icons';
import { toast } from './ui/overlay';
import { ROUTES, DEFAULT_ROUTE, parseHash, type RouteDef } from './routes';
import { store } from './store';
import { makeCtx, type Cleanup, type MountResult, type RouteInfo, type ShellApi } from './ctx';
import { player } from './player';
import { openAccount } from './ui/account';
import { inbox, onInbox, refreshMessages } from './lib/inbox';
import { drag, rubber, settle, haptic } from './ui/gesture';
import { enter, leave } from './ui/transition';
import { t } from './i18n';

/** Reload once (not in a loop) when a lazy chunk is gone; true = reloading. */
function staleReload(): boolean {
  try {
    const t = Number(sessionStorage.getItem('sm2.staleReload') || 0);
    if (Date.now() - t < 30000) return false;
    sessionStorage.setItem('sm2.staleReload', String(Date.now()));
  } catch { /* private mode: just reload once */ }
  location.reload(); return true;
}
export function mountShell(root: HTMLElement, onLogout: () => void): () => void {
  const isAdmin = () => !!store.get().me?.user.isAdmin;
  const tabs = ROUTES.filter((r) => r.tab);

  /* ---------- nav (sidebar + tab bar share the same items) ---------- */
  const navLinks = new Map<string, HTMLAnchorElement[]>();
  const link = (r: RouteDef, cls: string) => {
    const a = h('a', { class: cls, href: '#/' + r.name }, h('span', { class: 'nav-ic', html: svg(r.icon) }), h('span', { class: 'nav-l' }, r.label));
    (navLinks.get(r.name) || navLinks.set(r.name, []).get(r.name)!).push(a);
    return a;
  };
  const acctButtons: HTMLButtonElement[] = [];
  const accountButton = () => {
    const b = h('button', { class: 'acct-btn', type: 'button', 'aria-label': t('Akun dan pengaturan'), 'aria-haspopup': 'dialog' });
    b.onclick = () => openAccount(onLogout);
    acctButtons.push(b);
    paintAccount();
    return b;
  };
  // "Pesan": only there once a thread exists, with a count badge while replies are unread. The sidebar one looks like a
  // nav item; both get aria-current on the Pesan page (the top bar one then hides: you are already there).
  const msgButtons: HTMLAnchorElement[] = [];
  const messageButton = (cls: string) => {
    const badge = h('i', { class: 'msg-dot', hidden: true, 'aria-hidden': 'true' });
    const a = (cls === 'side-msg'
      ? h('a', { class: 'side-item side-msg', href: '#/messages', hidden: true }, h('span', { class: 'nav-ic', html: svg('message') }, badge), h('span', { class: 'nav-l' }, t('Pesan')))
      : h('a', { class: 'msg-btn ' + cls, href: '#/messages', title: t('Pesan'), hidden: true, html: svg('message') }, badge)) as HTMLAnchorElement;
    msgButtons.push(a);
    (navLinks.get('messages') || navLinks.set('messages', []).get('messages')!).push(a);
    return a;
  };
  const paintInbox = () => {
    for (const a of msgButtons) {
      a.hidden = !inbox.exists;
      const dot = a.querySelector('.msg-dot') as HTMLElement;
      dot.hidden = !inbox.unread;
      dot.textContent = inbox.unread > 9 ? '9+' : String(inbox.unread || '');
      a.setAttribute('aria-label', inbox.unread ? t('Pesan, {n} belum dibaca', { n: inbox.unread }) : t('Pesan'));
    }
  };
  const unInbox = onInbox(paintInbox);
  void refreshMessages();
  const inboxTimer = setInterval(() => { if (!document.hidden) void refreshMessages(); }, 60000);
  const side = h('nav', { class: 'side', 'aria-label': t('Navigasi utama') },
    h('a', { class: 'side-brand', href: '#/' + DEFAULT_ROUTE, 'aria-label': 'Strix', html: svg('waveform') }),
    h('div', { class: 'side-items' }, ...tabs.map((r) => link(r, 'side-item'))),
    h('div', { class: 'spacer' }),
    messageButton('side-msg'),
    accountButton());
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': t('Navigasi') }, ...tabs.map((r) => link(r, 'tab')));

  /* ---------- top bar ---------- */
  const back = h('button', { class: 'tb-back', type: 'button', 'aria-label': t('Kembali'), html: svg('arrowLeft'), hidden: true });
  const title = h('h1', { class: 'tb-title' });
  const actions = h('div', { class: 'tb-actions' });
  const topAcct = accountButton(); topAcct.classList.add('tb-acct');
  const topbar = h('header', { class: 'topbar' }, h('div', { class: 'tb-in' }, back, title, actions, messageButton('tb-msg'), topAcct));

  const view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const main = h('div', { class: 'main' }, topbar, view);
  const app = h('div', { class: 'app' }, side, main, tabbar);
  root.replaceChildren(app);

  function paintAccount() {
    const me = store.get().me; if (!me) return;
    for (const b of acctButtons) b.replaceChildren(avatar(me.user.name || me.user.email, me.user.picture));
  }
  paintAccount();
  const unMe = store.select((s) => s.me?.user, paintAccount);

  /* ---------- keyboard-safe height (iOS does not resize the layout viewport) ---------- */
  const vv = window.visualViewport;
  const isField = (el: Element | null) => !!el && (el.matches('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit]),textarea,[contenteditable="true"]'));
  // keyboard open = a text field has focus and the visual viewport is clearly shorter than the layout viewport
  // Both iOS (only the visual viewport shrinks) and Android resizes-content (both shrink) are covered by comparing against
  // the height seen while no text field was focused.
  let baseH = vv ? vv.height : window.innerHeight;
  const onVV = () => {
    if (!vv) return;
    document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
    const field = isField(document.activeElement);
    if (!field) baseH = Math.max(vv.height, window.innerHeight);
    app.classList.toggle('kb-open', field && baseH - vv.height > 120);
  };
  vv?.addEventListener('resize', onVV); vv?.addEventListener('scroll', onVV);
  const onFocus = () => setTimeout(onVV, 60);
  document.addEventListener('focusin', onFocus); document.addEventListener('focusout', onFocus);
  onVV();

  /* ---------- swipe between tabs (phones; the tab bar is the button alternative) ---------- */
  const tabIndex = () => tabs.findIndex((r) => r.name === current);
  const unSwipe = drag(view, {
    axis: 'x', slop: 12,
    accept: (e) => !matchMedia('(min-width: 900px)').matches && !app.classList.contains('no-tabbar') && tabIndex() >= 0
      && !(e.target as Element).closest('[data-hswipe],.dlg,.menu,.vl,.lib-filters'),
    onStart: () => { const s = view.firstElementChild as HTMLElement | null; if (s) s.style.transition = ''; },
    onMove: (s) => {
      const i = tabIndex(), el = view.firstElementChild as HTMLElement | null; if (!el) return;
      const edge = (s.dx > 0 && i === 0) || (s.dx < 0 && i === tabs.length - 1);
      const x = edge ? Math.sign(s.dx) * rubber(Math.abs(s.dx), 40) : s.dx * 0.45;
      el.style.transform = `translate3d(${x}px,0,0)`; el.style.opacity = String(1 - Math.min(0.35, Math.abs(x) / 600));
    },
    onEnd: async (s, cancelled) => {
      const i = tabIndex(), el = view.firstElementChild as HTMLElement | null;
      const dir = s.dx < 0 ? 1 : -1, next = tabs[i + dir];
      const go = !cancelled && next && (Math.abs(s.dx) > Math.min(110, view.clientWidth * 0.28) || (Math.abs(s.vx) > 0.5 && Math.abs(s.dx) > 40));
      if (go) { haptic(); if (el) await settle(el, `translate3d(${-dir * 60}px,0,0)`, 120); location.hash = '#/' + next.name; }
      else if (el) { await settle(el, 'translate3d(0,0,0)', 200); }
      if (el) { el.style.transform = ''; el.style.opacity = ''; }
    },
  });

  /* ---------- routing ---------- */
  let cleanup: Cleanup | null = null;
  let onRoute: ((r: RouteInfo) => void) | null = null;
  let token = 0;
  let backFn: (() => void) | null = null;
  back.onclick = () => backFn?.();
  const shellApi: ShellApi = {
    setTitle: (s) => { title.textContent = s; document.title = s === 'Strix' ? 'Strix' : `${s} · Strix`; },
    setActions: (nodes) => actions.replaceChildren(...nodes),
    setBack: (fn) => { backFn = fn; back.hidden = !fn; topbar.classList.toggle('has-back', !!fn); },
    setTopbar: (v) => app.classList.toggle('no-topbar', !v),
    setTabbar: (v) => app.classList.toggle('no-tabbar', !v),
    setChrome: (v) => app.classList.toggle('no-chrome', !v),
    accountButton,
  };
  let current = '';

  async function go() {
    const info = parseHash();
    let def = ROUTES.find((r) => r.name === info.name);
    if (!def || (def.admin && !isAdmin())) {
      if (def?.admin) toast(t('Halaman ini hanya untuk admin.'), { kind: 'warn' });
      history.replaceState(null, '', '#/' + DEFAULT_ROUTE);
      def = ROUTES.find((r) => r.name === DEFAULT_ROUTE)!;
      info.name = def.name; info.path = def.name; info.params = new URLSearchParams();
    }
    for (const [name, els] of navLinks) for (const a of els) { if (name === def.name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    const key = info.path + '?' + info.params.toString();
    if (current === def.name && onRoute) {
      // a sub-page of the same screen (e.g. Library <-> Koleksi): a short dissolve of the screen
      const same = lastKey === key; lastKey = key;
      onRoute({ name: def.name, path: info.path, params: info.params });
      const sc = view.firstElementChild as HTMLElement | null;
      if (sc && !same) enter(sc, { dy: 6, ms: 220 });
      return;
    }
    if (current === def.name && key === lastKey && cleanup) return;
    const my = ++token;
    // leave: the old screen dissolves towards the side it goes to (tabs), then the new one comes in from the other side
    const from = tabs.findIndex((r) => r.name === current), to = tabs.findIndex((r) => r.name === def.name);
    const dir = from >= 0 && to >= 0 && from !== to ? Math.sign(to - from) : 0;
    const old = view.firstElementChild as HTMLElement | null;
    const leaving = current && old && !old.classList.contains('boot') && !old.style.transform ? leave(old, { dx: -dir * 14, dy: dir ? 0 : -4, ms: 140 }) : Promise.resolve();
    try { cleanup?.(); } catch (e) { console.error(e); }
    cleanup = null; onRoute = null;
    player.stop();
    acctButtons.splice(2);                                   // drop buttons created by the previous screen
    shellApi.setActions([]); shellApi.setBack(null); shellApi.setTopbar(true); shellApi.setTabbar(true); shellApi.setChrome(true);
    shellApi.setTitle(def.title);
    app.classList.toggle('wide', !!def.wide);
    store.set({ route: def.name });
    current = def.name; lastKey = key;
    let mod: { mount: (r: HTMLElement, c: any) => MountResult };
    try { [mod] = await Promise.all([def.load(), leaving]); } catch (e) {
      console.error(e);
      // a tab opened before a deploy still points at chunks that no longer exist: fetch the fresh build once
      if (staleReload()) return;
      view.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: svg('alert') }), h('h3', null, t('Gagal memuat halaman')), h('p', null, t('Periksa koneksi lalu muat ulang.'))));
      return;
    }
    if (my !== token) return;
    const screen = h('div', { class: 'screen' });
    view.replaceChildren(screen);
    view.scrollTop = 0;
    if (old) enter(screen, { dx: dir * 16, dy: dir ? 0 : 6, ms: 240 });
    const ctx = makeCtx({ name: def.name, path: info.path, params: info.params }, (p) => { location.hash = p.startsWith('#') ? p : '#/' + p.replace(/^\//, ''); }, shellApi);
    try {
      const r = mod.mount(screen, ctx);
      if (typeof r === 'function') cleanup = r;
      else if (r) { cleanup = r.cleanup; onRoute = r.onRoute || null; }
    } catch (e) {
      console.error(e);
      screen.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: svg('alert') }), h('h3', null, t('Terjadi kesalahan')), h('p', null, String((e as Error).message || e))));
    }
  }
  let lastKey = '';
  addEventListener('hashchange', go);
  if (!parseHash().name) history.replaceState(null, '', '#/' + DEFAULT_ROUTE);
  go();
  return () => {
    removeEventListener('hashchange', go); unMe(); unInbox(); clearInterval(inboxTimer); unSwipe(); vv?.removeEventListener('resize', onVV); vv?.removeEventListener('scroll', onVV); document.removeEventListener('focusin', onFocus); document.removeEventListener('focusout', onFocus);
    try { cleanup?.(); } catch (e) { console.error(e); }
    cleanup = null; token++;
  };
}
