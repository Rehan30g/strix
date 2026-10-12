/* App shell: left rail (desktop) / bottom bar (mobile), top bar with account menu, hash router mounting screens. */
import { h, avatar, fmtNum } from './ui/dom';
import { svg } from './icons';
import { popover, menuItem, toast } from './ui/overlay';
import { ROUTES, DEFAULT_ROUTE, parseHash, type RouteDef } from './routes';
import { store } from './store';
import { api, resetText, type Me } from './api';
import { makeCtx, type Cleanup, type ShellApi } from './ctx';
import { setTheme, themePref } from './theme';
import { settings } from './settings';
import { player } from './player';

export function quotaMeter(label: string, used: number, limit: number, unit = ''): HTMLElement {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const bar = h('i'); bar.style.width = pct + '%';
  return h('div', { class: 'meter' + (pct >= 100 ? ' bad' : pct >= 80 ? ' warn' : '') , role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(used) },
    h('div', { class: 'm-top' }, h('span', null, label), h('span', null, h('b', null, fmtNum(used)), ` / ${fmtNum(limit)}${unit}`)),
    h('div', { class: 'bar' }, bar));
}

function quotaBlock(me: Me): HTMLElement[] {
  const q = me.quota;
  if (!q) return [];
  return [quotaMeter('Permintaan AI hari ini', q.llm?.used ?? 0, q.llm?.limit ?? 0), quotaMeter('Karakter suara (TTS)', q.tts?.used ?? 0, q.tts?.limit ?? 0)];
}

export function mountShell(root: HTMLElement, onLogout: () => void): () => void {
  const isAdmin = () => !!store.get().me?.user.isAdmin;
  const visible = () => ROUTES.filter((r) => !r.admin || isAdmin());

  /* ---------- rail ---------- */
  const navLinks = new Map<string, HTMLAnchorElement[]>();
  const link = (r: RouteDef, cls: string, inner: (r: RouteDef) => Node[]) => {
    const a = h('a', { class: cls, href: '#/' + r.name, 'aria-label': r.label }, ...inner(r));
    (navLinks.get(r.name) || navLinks.set(r.name, []).get(r.name)!).push(a);
    return a;
  };
  const railItem = (r: RouteDef) => link(r, 'nav-item', (x) => [h('span', { html: svg(x.icon), style: 'display:contents' }), h('span', null, x.label)]);
  const brand = h('a', { class: 'brand', href: '#/' + DEFAULT_ROUTE },
    h('span', { class: 'brand-mark', html: svg('waveform') }),
    h('span', { class: 'brand-text' }, 'SpeakingModel', h('small', null, 'Preview undangan')));
  const railQuota = h('div', { class: 'rail-quota' });
  const rail = h('nav', { class: 'rail', 'aria-label': 'Navigasi utama' },
    brand,
    h('div', { class: 'nav-label' }, 'Studio'),
    ...visible().filter((r) => r.group === 'main').map(railItem),
    h('div', { class: 'nav-label' }, 'Kelola'),
    ...visible().filter((r) => r.group === 'manage').map(railItem),
    h('div', { class: 'spacer' }),
    h('div', { class: 'rail-foot' }, railQuota));

  /* ---------- top bar ---------- */
  const title = h('div', { class: 'tb-title' });
  const actions = h('div', { class: 'row', style: 'gap:6px;min-width:0' });
  const acctBtn = h('button', { class: 'acct-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Akun' });
  const topbar = h('header', { class: 'topbar' },
    h('a', { class: 'tb-brand brand-mark', href: '#/' + DEFAULT_ROUTE, 'aria-label': 'Beranda', html: svg('waveform') }),
    title, h('div', { class: 'tb-actions' }, actions, acctBtn));

  /* ---------- bottom bar (mobile) ---------- */
  const moreBtn = h('button', { type: 'button', 'aria-label': 'Lainnya', 'aria-haspopup': 'menu' }, h('span', { class: 'bb-ic', html: svg('more') }), h('span', { class: 'bb-l' }, 'Lainnya'));
  const bottombar = h('nav', { class: 'bottombar', 'aria-label': 'Navigasi' },
    ...visible().filter((r) => r.mobile).map((r) => link(r, '', (x) => [h('span', { class: 'bb-ic', html: svg(x.icon) }), h('span', { class: 'bb-l' }, x.label)])),
    moreBtn);
  moreBtn.onclick = () => {
    const box = h('div', null, ...visible().filter((r) => !r.mobile).map((r) => menuItem(r.label, r.icon, () => { location.hash = '#/' + r.name; })));
    popover(moreBtn, box, { placement: 'above' });
  };

  const view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  const app = h('div', { class: 'app' }, rail, h('div', { class: 'main' }, topbar, view), bottombar);
  root.replaceChildren(app);

  /* ---------- account ---------- */
  const paintAccount = () => {
    const me = store.get().me; if (!me) return;
    acctBtn.replaceChildren(avatar(me.user.name || me.user.email, me.user.picture), h('span', { html: svg('chevronDown'), style: 'display:contents' }));
    railQuota.replaceChildren(...quotaBlock(me));
  };
  paintAccount();
  const unMe = store.select((s) => s.me, paintAccount);

  acctBtn.onclick = () => {
    const me = store.get().me!;
    const seg = h('div', { class: 'seg block', role: 'group', 'aria-label': 'Tema' });
    for (const [v, label, icon] of [['system', 'Sistem', 'monitor'], ['light', 'Terang', 'sun'], ['dark', 'Gelap', 'moon']] as const) {
      const b = h('button', { type: 'button', 'aria-pressed': String(themePref() === v), html: svg(icon) }, label);
      b.onclick = () => { setTheme(v); settings.setPrefs({ theme: v }); seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); };
      seg.append(b);
    }
    const reset = resetText(me.quota?.resetAt);
    const box = h('div', { class: 'acct-menu' },
      h('div', { class: 'acct-head' }, avatar(me.user.name || me.user.email, me.user.picture, 'lg'),
        h('div', { class: 'who' }, h('b', null, me.user.name || 'Pengguna'), h('span', null, me.user.email))),
      h('div', { class: 'acct-quota' }, ...quotaBlock(me), reset ? h('div', { class: 'reset' }, `Kuota direset ${reset} (UTC tengah malam)`) : null),
      h('div', { class: 'acct-theme' }, seg),
      menuItem('Pengaturan', 'sliders', () => { location.hash = '#/settings'; }),
      me.user.isAdmin ? menuItem('Admin', 'shield', () => { location.hash = '#/admin'; }) : null,
      h('div', { class: 'menu-sep' }),
      menuItem('Keluar', 'logout', async () => { try { await api.logout(); } catch { /* ignore */ } onLogout(); }, 'danger'));
    popover(acctBtn, box, { align: 'end' });
  };

  /* ---------- routing ---------- */
  let cleanup: Cleanup | null = null;
  let token = 0;
  const shellApi: ShellApi = {
    setTitle: (t) => { title.textContent = t; document.title = `${t} · SpeakingModel`; },
    setActions: (nodes) => actions.replaceChildren(...nodes),
    setChrome: (v) => app.classList.toggle('no-chrome', !v),
  };

  async function go() {
    const info = parseHash();
    let def = ROUTES.find((r) => r.name === info.name);
    if (!def || (def.admin && !isAdmin())) {
      if (def?.admin) toast('Halaman ini hanya untuk admin.', { kind: 'warn' });
      history.replaceState(null, '', '#/' + DEFAULT_ROUTE);
      def = ROUTES.find((r) => r.name === DEFAULT_ROUTE)!;
      info.name = def.name; info.path = def.name;
    }
    const my = ++token;
    for (const [name, els] of navLinks) for (const a of els) { if (name === def.name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    moreBtn.toggleAttribute('aria-current', !ROUTES.find((r) => r.name === def!.name)?.mobile);
    if (moreBtn.hasAttribute('aria-current')) moreBtn.setAttribute('aria-current', 'page');
    if (store.get().route === def.name && cleanup && info.path === lastPath && info.params.toString() === lastQuery) return;
    try { cleanup?.(); } catch (e) { console.error(e); }
    cleanup = null;
    player.stop();
    shellApi.setActions([]); shellApi.setChrome(true); shellApi.setTitle(def.title);
    view.replaceChildren(h('div', { class: 'boot' }, h('span', { class: 'spinner' })));
    store.set({ route: def.name });
    lastPath = info.path; lastQuery = info.params.toString();
    let mod: { mount: (r: HTMLElement, c: any) => Cleanup | void };
    try { mod = await def.load(); } catch (e) {
      console.error(e);
      view.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: svg('alert') }), h('h3', null, 'Gagal memuat halaman'), h('p', null, 'Coba muat ulang.')));
      return;
    }
    if (my !== token) return;
    const screen = h('div', { class: 'screen', style: 'flex:1;min-height:0;display:flex;flex-direction:column' });
    view.replaceChildren(screen);
    const ctx = makeCtx({ name: def.name, path: info.path, params: info.params }, (p) => { location.hash = p.startsWith('#') ? p : '#/' + p.replace(/^\//, ''); }, shellApi);
    try { cleanup = mod.mount(screen, ctx) || null; } catch (e) {
      console.error(e);
      screen.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: svg('alert') }), h('h3', null, 'Terjadi kesalahan'), h('p', null, String((e as Error).message || e))));
    }
  }
  let lastPath = '', lastQuery = '';
  addEventListener('hashchange', go);
  if (!parseHash().name) history.replaceState(null, '', '#/' + DEFAULT_ROUTE);
  go();
  return () => {
    removeEventListener('hashchange', go); unMe();
    try { cleanup?.(); } catch (e) { console.error(e); }
    cleanup = null; token++;
  };
}
