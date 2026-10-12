/* Login (Google), Redeem invite code, Suspended — full-page auth screens outside the shell. */
import { h, btn, busy } from '../ui/dom';
import { svg } from '../icons';
import { api, ApiError, type Me } from '../api';

const brand = () => h('div', { class: 'auth-mark', html: svg('waveform'), 'aria-hidden': 'true' });

const LOGIN_ERRORS: Record<string, string> = {
  access_denied: 'Login dibatalkan.',
  google_error: 'Google menolak permintaan login. Coba lagi.',
  state_missing: 'Sesi login kedaluwarsa. Coba lagi.',
  state_mismatch: 'Sesi login tidak cocok. Coba lagi.',
  token_exchange: 'Login Google gagal (pertukaran token). Coba lagi.',
  no_id_token: 'Login Google gagal. Coba lagi.',
  verify_failed: 'Verifikasi akun Google gagal. Pastikan email Google sudah terverifikasi.',
  google_not_configured: 'Login Google belum dikonfigurasi di server.',
};

function loginError(): string {
  const q = new URLSearchParams(location.search);
  const hq = new URLSearchParams(location.hash.split('?')[1] || '');
  const code = q.get('error') || hq.get('error');
  if (!code) return '';
  // drop ?error from the address bar so a reload does not show it again
  history.replaceState(null, '', location.pathname + (location.hash.split('?')[0] || ''));
  return LOGIN_ERRORS[code] || `Login gagal (${code}).`;
}

export function renderLogin(root: HTMLElement): void {
  const err = loginError();
  const g = h('a', { class: 'gbtn', href: '/api/auth/google/start', html: svg('google') }, 'Masuk dengan Google');
  const extra = h('div');
  // dev-only fake login + "Google not configured" notice (GET /api/auth/config is public)
  api.get<{ google: boolean; devLogin: boolean }>('/auth/config').then((c) => {
    if (!c.google) extra.append(h('div', { class: 'notice warn', style: 'margin-top:12px', html: svg('alert') }, h('span', null, 'Login Google belum dikonfigurasi di server.')));
    if (c.devLogin) {
      const email = h('input', { class: 'input', type: 'email', placeholder: 'dev@example.com', 'aria-label': 'Email dev', autocomplete: 'off' }) as HTMLInputElement;
      const go = btn({ label: 'Dev login', icon: 'key' });
      const f = h('form', { class: 'row' }, h('div', { class: 'grow' }, email), go);
      f.onsubmit = (e) => { e.preventDefault(); const q = new URLSearchParams({ redirect: '/' }); if (email.value.trim()) q.set('email', email.value.trim()); location.href = '/api/auth/dev-login?' + q; };
      go.type = 'submit';
      extra.append(h('div', { class: 'auth-sep' }, 'mode pengembangan'), f);
    }
  }).catch(() => {});
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      brand(),
      h('h1', null, 'Strix'),
      h('p', { class: 'lead' }, 'Ngobrol dengan persona AI, ubah teks jadi suara, ubah suaramu, dan clone suara sendiri.'),
      h('ul', { class: 'auth-feats' },
        ...[['chat', 'Chat persona'], ['studio', 'Teks ke suara'], ['changer', 'Voice changer'], ['voices', 'Clone suara']]
          .map(([i, t]) => h('li', { html: svg(i) }, t))),
      err ? h('div', { class: 'notice bad', style: 'margin-bottom:14px', html: svg('alert') }, h('span', null, err)) : null,
      g, extra,
      h('p', { class: 'foot' }, 'Khusus undangan. Setelah masuk, masukkan kode undangan dari admin.'))));
}

export function renderRedeem(root: HTMLElement, me: Me, onDone: () => void, onLogout: () => void): void {
  const input = h('input', { class: 'input code-input', id: 'code', maxLength: 14, autocomplete: 'one-time-code', spellcheck: false, placeholder: 'XXXXXXXXXX', 'aria-describedby': 'code-hint', autofocus: true }) as HTMLInputElement;
  const msg = h('div', { role: 'alert', 'aria-live': 'assertive' });
  const submit = btn({ label: 'Aktifkan akun', cls: 'primary lg block', type: 'submit' });
  input.addEventListener('input', () => {
    const pos = input.selectionStart;
    input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    try { input.setSelectionRange(pos, pos); } catch { /* ignore */ }
    msg.replaceChildren();
  });
  const form = h('form', { class: 'stack', novalidate: true },
    h('div', { class: 'field' }, h('label', { for: 'code' }, 'Kode undangan'), input,
      h('div', { class: 'hint', id: 'code-hint' }, '10 karakter huruf dan angka.')),
    msg, submit);
  form.onsubmit = (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (code.length < 6) { msg.replaceChildren(h('div', { class: 'notice warn', html: svg('alert') }, h('span', null, 'Masukkan kode undangan lengkap.'))); input.focus(); return; }
    busy(submit, async () => {
      try { await api.redeem(code); onDone(); }
      catch (e) {
        const er = e as ApiError;
        let t = er.message;
        if (er.code === 'validation') t = 'Format kode tidak valid.';
        msg.replaceChildren(h('div', { class: 'notice bad', html: svg('xCircle') }, h('span', null, t)));
        input.select();
      }
    }, 'Memeriksa...');
  };
  const out = h('button', { class: 'btn ghost', type: 'button', html: svg('logout') }, 'Keluar');
  out.onclick = async () => { try { await api.logout(); } catch { /* ignore */ } onLogout(); };
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' },
      brand(),
      h('h1', null, 'Masukkan kode undangan'),
      h('p', { class: 'lead' }, `Masuk sebagai ${me.user.email}. Masukkan kode dari admin untuk mengaktifkan akun.`),
      form,
      h('div', { class: 'foot row', style: 'justify-content:center' }, out))));
}

export function renderSuspended(root: HTMLElement, onLogout: () => void): void {
  const out = btn({ label: 'Keluar', icon: 'logout', cls: 'block' });
  out.onclick = async () => { try { await api.logout(); } catch { /* ignore */ } onLogout(); };
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' }, brand(),
      h('h1', null, 'Akun ditangguhkan'),
      h('p', { class: 'lead' }, 'Akses akun ini sedang dihentikan oleh admin. Hubungi admin kalau menurutmu ini keliru.'),
      out)));
}

export function renderBootError(root: HTMLElement, message: string, retry: () => void): void {
  const b = btn({ label: 'Coba lagi', icon: 'refresh', cls: 'primary block' });
  b.onclick = retry;
  root.replaceChildren(h('div', { class: 'auth' },
    h('div', { class: 'auth-card' }, brand(), h('h1', null, 'Tidak bisa terhubung'), h('p', { class: 'lead' }, message), b)));
}
