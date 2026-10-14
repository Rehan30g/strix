/* Account sheet: who am I, today's quota, theme, a few advanced settings, admin link, logout.
   Replaces the old big Settings page. Opens as a bottom sheet on phones, a dialog on desktop. */
import { h, avatar, fmtNum, onDisconnect } from './dom';
import { svg } from '../icons';
import { modal } from './overlay';
import { seg, switchRow, tuneControls } from './controls';
import { store } from '../store';
import { api, resetText, type Me } from '../api';
import { settings } from '../settings';
import { setTheme, themePref } from '../theme';
import { fmtEndDate, leftLabel } from './about';

const fmtSec = (s: number) => (s >= 60 ? `${Math.floor(s / 60)} mnt${s % 60 ? ` ${Math.round(s % 60)} dtk` : ''}` : `${Math.round(s)} dtk`);

export function quotaMeter(label: string, used: number, limit: number, fmt: (n: number) => string = fmtNum): HTMLElement {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const bar = h('i'); bar.style.width = pct + '%';
  return h('div', { class: 'meter' + (pct >= 100 ? ' bad' : pct >= 85 ? ' warn' : ''), role: 'meter', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(used) },
    h('div', { class: 'm-top' }, h('span', null, label), h('span', null, h('b', null, fmt(used)), ` / ${fmt(limit)}`)),
    h('div', { class: 'bar' }, bar));
}

export function quotaBlock(me: Me): HTMLElement[] {
  const q = me.quota; if (!q) return [];
  const out = [
    quotaMeter('Chat AI (permintaan)', q.llm?.used ?? 0, q.llm?.limit ?? 0),
    quotaMeter('TTS (karakter)', q.tts?.used ?? 0, q.tts?.limit ?? 0),
  ];
  if (q.vc) out.push(quotaMeter('Voice Changer', q.vc.used ?? 0, q.vc.limit ?? 0, fmtSec));
  if (q.stt) out.push(quotaMeter('Bicara lewat mic', q.stt.used ?? 0, q.stt.limit ?? 0, fmtSec));
  if (q.search) out.push(quotaMeter('Pencarian web (chat)', q.search.used ?? 0, q.search.limit ?? 0));
  return out;
}

export function openAccount(onLogout: () => void): void {
  const me = store.get().me; if (!me) return;

  const quota = h('div', { class: 'acct-quota' });
  const paintQuota = () => { const m = store.get().me; if (m) quota.replaceChildren(...quotaBlock(m)); };
  paintQuota();
  const reset = resetText(me.quota?.resetAt);

  const theme = seg<'system' | 'light' | 'dark'>([['system', 'Sistem', 'monitor'], ['light', 'Terang', 'sun'], ['dark', 'Gelap', 'moon']], themePref(),
    (v) => { setTheme(v); settings.setPrefs({ theme: v }); }, 'Tema', true);

  const level = switchRow('Samakan volume suara', settings.prefs().levelVoices !== false, (v) => { settings.setPrefs({ levelVoices: v }); },
    'Suara yang pelan dikeraskan dan yang keras dipelankan agar volumenya setara, tanpa menghilangkan bisikan atau teriakan.');
  level.classList.add('acct-level');

  const adv = h('details', { class: 'disclosure' },
    h('summary', null, h('span', null, 'Tuning suara'), h('small', null, 'Kestabilan, kemiripan, gaya, kecepatan')),
    h('div', { class: 'disc-b stack' }, tuneControls({ compact: true })));

  const logout = h('button', { type: 'button', class: 'btn danger-soft block', html: svg('logout') }, 'Keluar');
  const adminLink = me.user.isAdmin ? h('a', { class: 'acct-link', href: '#/admin', html: svg('shield') }, h('span', null, 'Panel admin'), h('span', { html: svg('chevronRight'), style: 'display:contents' })) : null;

  const endIso = String((store.get().config as { testEnd?: string } | null)?.testEnd || '');
  const aboutLink = h('button', { type: 'button', class: 'acct-link', html: svg('info') }, h('span', null, 'Tentang uji coba', endIso ? h('small', { class: 'acct-sub' }, `Ditutup ${fmtEndDate(endIso)} · ${leftLabel(endIso)}`) : null), h('span', { html: svg('chevronRight'), style: 'display:contents' }));
  const introLink = h('button', { type: 'button', class: 'acct-link', html: svg('sparkle') }, h('span', null, 'Tur singkat'), h('span', { html: svg('chevronRight'), style: 'display:contents' }));
  const body = h('div', { class: 'acct' },
    h('div', { class: 'acct-head' }, avatar(me.user.name || me.user.email, me.user.picture, 'lg'),
      h('div', { class: 'who' }, h('b', null, me.user.name || 'Pengguna'), h('span', null, me.user.email))),
    h('section', { class: 'acct-sec' }, h('div', { class: 'acct-sec-h' }, h('span', null, 'Kuota hari ini'), reset ? h('small', null, `reset ${reset}`) : null), quota),
    h('section', { class: 'acct-sec' }, h('div', { class: 'acct-sec-h' }, h('span', null, 'Tema')), theme),
    h('section', { class: 'acct-sec' }, h('div', { class: 'acct-sec-h' }, h('span', null, 'Suara')), level),
    adv,
    aboutLink,
    introLink,
    adminLink,
    logout);

  const m = modal({ title: 'Akun', body, cls: 'acct-dlg' });
  aboutLink.onclick = () => { m.close(); import('./about').then((x) => x.openAbout({ testEnd: endIso || '2026-10-20' })).catch(() => {}); };
  introLink.onclick = () => { m.close(); import('./intro').then((x) => x.openIntro()).catch(() => {}); };
  if (adminLink) adminLink.addEventListener('click', () => m.close());
  logout.onclick = async () => { m.close(); try { await api.logout(); } catch { /* ignore */ } onLogout(); };
  onDisconnect(quota, store.select((s) => s.me, paintQuota));
}
