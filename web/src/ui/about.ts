/* "Tentang uji coba": the notice shown the first time someone gets in (before the tour) and re-openable from the account
   sheet. It says what this is, when the closed test ends, what is stored and where the code lives.
   The end date comes from the server (TEST_END_DATE, default 2026-10-20). */
import { h } from './dom';
import { svg } from '../icons';
import { modal } from './overlay';
import { settings } from '../settings';
import { t, locale } from '../i18n';

export const REPO_URL = 'https://github.com/Rehan30g/strix';
const KEY = 'aboutSeen', LS = 'sm2.aboutSeen';

export function isAboutSeen(): boolean {
  try { if (localStorage.getItem(LS) === '1') return true; } catch { /* private mode */ }
  return settings.get<boolean>(KEY, false) === true;
}
export function markAboutSeen(): void {
  settings.set(KEY, true);
  try { localStorage.setItem(LS, '1'); } catch { /* private mode */ }
}

const dayStart = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, (m || 1) - 1, d || 1).getTime(); };
/** "20 Oktober 2026" / "October 20, 2026" */
export function fmtEndDate(iso: string): string {
  const d = dayStart(iso);
  return Number.isFinite(d) ? new Date(d).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }) : iso;
}
/** "20 Okt" / "Oct 20" */
export function fmtEndShort(iso: string): string {
  const d = dayStart(iso);
  return Number.isFinite(d) ? new Date(d).toLocaleDateString(locale(), { day: 'numeric', month: 'short' }) : iso;
}
/** whole days from today to the end day (0 = today, negative = already over) */
export function daysLeft(iso: string): number {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((dayStart(iso) - today) / 86400000);
}
/** "6 hari lagi" / "besok" / "hari ini" / "sudah ditutup" ("6 days left" / "tomorrow" / "today" / "closed") */
export function leftLabel(iso: string): string {
  const n = daysLeft(iso);
  return n > 1 ? t('{n} hari lagi', { n }) : n === 1 ? t('besok') : n === 0 ? t('hari ini') : t('sudah ditutup');
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Resolves when the notice is closed. `first` = the automatic one: the button reads "Mengerti" and the notice is remembered. */
export function openAbout(opts: { testEnd: string; first?: boolean }): Promise<void> {
  const { testEnd } = opts;
  const over = daysLeft(testEnd) < 0;
  const end = h('div', { class: 'about-end' + (over ? ' over' : daysLeft(testEnd) <= 2 ? ' soon' : ''), html: svg('calendar') },
    h('div', null,
      h('b', null, over ? t('Uji coba ditutup pada {date}', { date: fmtEndDate(testEnd) }) : t('Uji coba ini ditutup pada {date}', { date: fmtEndDate(testEnd) })),
      h('span', null, over ? t('Terima kasih sudah mencoba.') : t('{left}. Setelah itu layanan tidak bisa dipakai lagi.', { left: cap(leftLabel(testEnd)) }))));
  const li = (icon: string, text: string) => h('li', { html: svg(icon) }, h('span', null, text));
  const body = h('div', { class: 'about' },
    end,
    h('p', { class: 'about-lead' }, t('Strix adalah eksperimen ngobrol dengan persona AI lewat suara, dengan teks ke suara, pengubah suara, dan clone suara.')),
    h('ul', { class: 'about-list' },
      li('shield', t('Hanya untuk pengundang dan penguji. Ini uji coba tertutup, bisa berubah atau rusak tanpa pemberitahuan.')),
      li('chat', t('Persona dan suaranya dibuat oleh AI. Jangan bagikan data pribadi yang sensitif.')),
      li('info', t('Yang tersimpan di server: emailmu, teks yang kamu ubah jadi suara, dan ringkasan ingatan percakapan. Ingatan bisa dihapus lewat menu persona.')),
      li('mic', t('Clone suara boleh untuk suaramu sendiri, suara yang kamu punya izinnya, atau suara karakter, asal bukan untuk tujuan komersial atau melanggar hak cipta.'))),
    h('a', { class: 'about-repo', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', html: svg('external') },
      h('div', null, h('span', null, t('Kode sumber di GitHub')), h('small', null, t('github.com/Rehan30g/strix · lisensi MIT')))));
  const ok = h('button', { type: 'button', class: 'btn primary lg block' }, opts.first ? t('Mengerti, lanjut') : t('Tutup')) as HTMLButtonElement;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; if (opts.first) markAboutSeen(); resolve(); };
    const m = modal({ title: t('Tentang uji coba ini'), body, cls: 'about-dlg', actions: [ok], onClose: finish });
    ok.onclick = () => { m.close(); finish(); };
  });
}
