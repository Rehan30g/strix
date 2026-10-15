/* Login (Google), Redeem invite code, Suspended — full-page auth screens outside the shell. */
import { h, btn, busy } from '../ui/dom';
import { svg } from '../icons';
import { api, ApiError, type Me } from '../api';
import { fmtEndDate } from '../ui/about';
import { langSwitch } from '../ui/langswitch';
import { t } from '../i18n';

const brand = () => h('div', { class: 'auth-mark', html: svg('waveform'), 'aria-hidden': 'true' });

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: t('Login dibatalkan.'),
  google_error: t('Google menolak permintaan login. Coba lagi.'),
  state_missing: t('Sesi login kedaluwarsa. Coba lagi.'),
  state_mismatch: t('Sesi login tidak cocok. Coba lagi.'),
  token_exchange: t('Login Google gagal (pertukaran token). Coba lagi.'),
  no_id_token: t('Login Google gagal. Coba lagi.'),
  verify_failed: t('Verifikasi akun Google gagal. Pastikan email Google sudah terverifikasi.'),
  google_not_configured: t('Login Google belum dikonfigurasi di server.'),
};

function loginError(): string {
  const q = new URLSearchParams(location.search);
  const hq = new URLSearchParams(location.hash.split('?')[1] || '');
  const code = q.get('error') || hq.get('error');
  if (!code) return '';
  // drop ?error from the address bar so a reload does not show it again
  history.replaceState(null, '', location.pathname + (location.hash.split('?')[0] || ''));
  return LOGIN_ERRORS[code] || t('Login gagal ({code}).', { code });
}

export function renderLogin(root: HTMLElement): void {
  const err = loginError();
  const g = h('a', { class: 'gbtn', href: '/api/auth/google/start', html: svg('google') }, t('Masuk dengan Google'));
  const extra = h('div');
  const endLine = h('p', { class: 'auth-end' });
  // dev-only fake login + "Google not configured" notice (GET /api/auth/config is public)
  api.get<{ google: boolean; devLogin: boolean; testEnd?: string }>('/auth/config').then((c) => {
    if (c.testEnd) endLine.textContent = t('Uji coba tertutup · berakhir {date}', { date: fmtEndDate(c.testEnd) });
    if (!c.google) extra.append(h('div', { class: 'notice warn', style: 'margin-top:12px', html: svg('alert') }, h('span', null, t('Login Google belum dikonfigurasi di server.'))));
    if (c.devLogin) {
      const email = h('input', { class: 'input', type: 'email', placeholder: 'dev@example.com', 'aria-label': t('Email dev'), autocomplete: 'off' }) as HTMLInputElement;
      const go = btn({ label: 'Dev login', icon: 'key' });
      const f = h('form', { class: 'row' }, h('div', { class: 'grow' }, email), go);
      f.onsubmit = (e) => { e.preventDefault(); const q = new URLSearchParams({ redirect: '/' }); if (email.value.trim()) q.set('email', email.value.trim()); location.href = '/api/auth/dev-login?' + q; };
      go.type = 'submit';
      extra.append(h('div', { class: 'auth-sep' }, t('mode pengembangan')), f);
    }
  }).catch(() => {});
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      brand(),
      h('h1', null, 'Strix'),
      endLine,
      err ? h('div', { class: 'notice bad', style: 'margin-bottom:14px', html: svg('alert') }, h('span', null, err)) : null,
      g, extra,
      h('p', { class: 'foot' }, t('Khusus undangan.')),
      langSwitch('quiet'))));
}

export function renderRedeem(root: HTMLElement, me: Me, onDone: () => void, onLogout: () => void): void {
  const input = h('input', { class: 'input code-input', id: 'code', maxLength: 14, autocomplete: 'one-time-code', spellcheck: false, placeholder: 'XXXXXXXXXX', 'aria-describedby': 'code-hint', autofocus: true }) as HTMLInputElement;
  const msg = h('div', { role: 'alert', 'aria-live': 'assertive' });
  const submit = btn({ label: t('Aktifkan akun'), cls: 'primary lg block', type: 'submit' });
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    try { input.setSelectionRange(pos, pos); } catch { /* ignore */ }
    msg.replaceChildren();
  });
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'code' }, t('Kode undangan')), input,
      h('div', { class: 'hint', id: 'code-hint' }, t('10 karakter huruf dan angka.'))),
    msg, submit);
  form.onsubmit = (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (code.length < 6) { msg.replaceChildren(h('div', { class: 'notice warn', html: svg('alert') }, h('span', null, t('Masukkan kode undangan lengkap.')))); input.focus(); return; }
    busy(submit, async () => {
      try { await api.redeem(code); onDone(); }
      catch (e) {
        const er = e as ApiError;
        let text = er.message;
        if (er.code === 'validation') text = t('Format kode tidak valid.');
        msg.replaceChildren(h('div', { class: 'notice bad', html: svg('xCircle') }, h('span', null, text)));
        input.select();
      }
    }, t('Memeriksa...'));
  };
  const out = h('button', { class: 'btn ghost', type: 'button', html: svg('logout') }, t('Keluar'));
  out.onclick = async () => { try { await api.logout(); } catch { /* ignore */ } onLogout(); };
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      brand(),
      h('h1', null, t('Masukkan kode undangan')),
      h('p', { class: 'lead' }, t('Masuk sebagai {email}. Masukkan kode dari admin untuk mengaktifkan akun.', { email: me.user.email })),
      form,
      h('div', { class: 'foot row', style: 'justify-content:center' }, out),
      langSwitch('quiet'))));
}

export function renderSuspended(root: HTMLElement, onLogout: () => void): void {
  const out = btn({ label: t('Keluar'), icon: 'logout', cls: 'block' });
  out.onclick = async () => { try { await api.logout(); } catch { /* ignore */ } onLogout(); };
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' }, brand(),
      h('h1', null, t('Akun ditangguhkan')),
      h('p', { class: 'lead' }, t('Akses akun ini sedang dihentikan oleh admin. Hubungi admin kalau menurutmu ini keliru.')),
      out)));
}

export function renderBootError(root: HTMLElement, message: string, retry: () => void): void {
  const b = btn({ label: t('Coba lagi'), icon: 'refresh', cls: 'primary block' });
  b.onclick = retry;
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' }, brand(), h('h1', null, t('Tidak bisa terhubung')), h('p', { class: 'lead' }, message), b)));
}
