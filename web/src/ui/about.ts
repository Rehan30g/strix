/* "Tentang uji coba": the notice shown the first time someone gets in (before the tour) and re-openable from the account
   sheet. It says what this is, when the closed test ends, what is stored and where the code lives.
   The end date comes from the server (TEST_END_DATE, default 2026-10-20). */
import { h } from './dom';
import { svg } from '../icons';
import { modal } from './overlay';
import { settings } from '../settings';

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
/** "20 Oktober 2026" */
export function fmtEndDate(iso: string): string {
  const t = dayStart(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : iso;
}
/** "20 Okt" */
export function fmtEndShort(iso: string): string {
  const t = dayStart(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }) : iso;
}
/** whole days from today to the end day (0 = today, negative = already over) */
export function daysLeft(iso: string): number {
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((dayStart(iso) - today) / 86400000);
}
/** "6 hari lagi" / "hari ini" / "sudah ditutup" */
export function leftLabel(iso: string): string {
  const n = daysLeft(iso);
  return n > 1 ? `${n} hari lagi` : n === 1 ? 'besok' : n === 0 ? 'hari ini' : 'sudah ditutup';
}

/** Resolves when the notice is closed. `first` = the automatic one: the button reads "Mengerti" and the notice is remembered. */
export function openAbout(opts: { testEnd: string; first?: boolean }): Promise<void> {
  const { testEnd } = opts;
  const over = daysLeft(testEnd) < 0;
  const end = h('div', { class: 'about-end' + (over ? ' over' : daysLeft(testEnd) <= 2 ? ' soon' : ''), html: svg('calendar') },
    h('div', null,
      h('b', null, over ? `Uji coba ditutup pada ${fmtEndDate(testEnd)}` : `Uji coba ini ditutup pada ${fmtEndDate(testEnd)}`),
      h('span', null, over ? 'Terima kasih sudah mencoba.' : `${leftLabel(testEnd)}. Setelah itu layanan tidak bisa dipakai lagi.`)));
  const li = (icon: string, t: string) => h('li', { html: svg(icon) }, h('span', null, t));
  const body = h('div', { class: 'about' },
    end,
    h('p', { class: 'about-lead' }, 'Strix adalah eksperimen ngobrol dengan persona AI lewat suara, dengan teks ke suara, pengubah suara, dan clone suara.'),
    h('ul', { class: 'about-list' },
      li('shield', 'Hanya untuk pengundang dan penguji. Ini uji coba tertutup, bisa berubah atau rusak tanpa pemberitahuan.'),
      li('chat', 'Persona dan suaranya dibuat oleh AI. Jangan bagikan data pribadi yang sensitif.'),
      li('info', 'Yang tersimpan di server: emailmu, teks yang kamu ubah jadi suara, dan ringkasan ingatan percakapan. Ingatan bisa dihapus lewat menu persona.'),
      li('mic', 'Clone suara hanya untuk suaramu sendiri atau suara yang kamu punya izinnya.')),
    h('a', { class: 'about-repo', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', html: svg('external') },
      h('div', null, h('span', null, 'Kode sumber di GitHub'), h('small', null, 'github.com/Rehan30g/strix · lisensi MIT'))));
  const ok = h('button', { type: 'button', class: 'btn primary lg block' }, opts.first ? 'Mengerti, lanjut' : 'Tutup') as HTMLButtonElement;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; if (opts.first) markAboutSeen(); resolve(); };
    const m = modal({ title: 'Tentang uji coba ini', body, cls: 'about-dlg', actions: [ok], onClose: finish });
    ok.onclick = () => { m.close(); finish(); };
  });
}
