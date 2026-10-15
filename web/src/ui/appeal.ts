/* Quota appeal as a chat with the admin: a message thread (me on the right, them on the left). Used by the tester
   ("Pesan ke admin", opened from the quota-exhausted notice or the account sheet) and by the admin panel. */
import { h } from './dom';
import { svg } from '../icons';
import { modal, toast } from './overlay';
import { api } from '../api';

export interface ThreadMsg { id: number; fromAdmin: boolean; text: string; at: string | null }
interface ChatOpts {
  title: string;
  load: () => Promise<{ messages: ThreadMsg[]; open?: boolean }>;
  send: (text: string) => Promise<void>;
  /** true = the bubble belongs to the person looking at it (right side) */
  mine: (m: ThreadMsg) => boolean;
  empty: string;
  placeholder: string;
  key: string;
  actions?: HTMLElement[];
}

const when = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

export function openThreadChat(o: ChatOpts) {
  let alive = true, last = -1;
  let timer: ReturnType<typeof setInterval> | undefined;
  const list = h('div', { class: 'ap-list', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'input ap-in', rows: '1', maxLength: 400, placeholder: o.placeholder, enterkeyhint: 'send' }) as HTMLTextAreaElement;
  const send = h('button', { type: 'submit', class: 'btn primary icon ap-send', 'aria-label': 'Kirim', html: svg('arrowUp') }) as HTMLButtonElement;
  const form = h('form', { class: 'ap-form' }, input, send) as HTMLFormElement;
  const body = h('div', { class: 'ap' }, list, form);
  const m = modal({ title: o.title, body, cls: 'ap-dlg', key: o.key, actions: o.actions, onClose: () => { alive = false; if (timer) clearInterval(timer); } });
  const paint = (msgs: ThreadMsg[]) => {
    const sig = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (sig === last) return;
    last = sig;
    list.replaceChildren(...(msgs.length
      ? msgs.map((x) => h('div', { class: 'ap-msg ' + (o.mine(x) ? 'me' : 'them') }, h('div', { class: 'ap-b' }, x.text), h('small', null, when(x.at))))
      : [h('p', { class: 'hint ap-empty' }, o.empty)]));
    list.scrollTop = list.scrollHeight;
  };
  const refresh = async () => { try { const r = await o.load(); if (alive) paint(r.messages); } catch { /* offline: keep what is shown */ } };
  void refresh();
  timer = setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try { await o.send(text); input.value = ''; await refresh(); }
    catch (err: any) { toast(err?.message || 'Gagal mengirim.', { kind: 'bad' }); }
    finally { send.disabled = false; }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
  return m;
}

/** The tester's side. */
export function openAppeal(kind = '') {
  return openThreadChat({
    title: 'Pesan ke admin', key: 'appeal',
    empty: 'Kuota harianmu terbatas karena kredit uji coba ini terbatas. Ceritakan untuk apa kamu butuh tambahan (minimal 15 karakter). Admin akan membalas di sini.',
    placeholder: 'Tulis pesan ke admin...',
    mine: (m) => !m.fromAdmin,
    load: async () => {
      const r = await api.get<{ messages: ThreadMsg[]; open: boolean }>('/quota/thread');
      if (r.messages.length) void api.post('/quota/thread/seen').catch(() => {});
      return r;
    },
    send: async (text) => { await api.post('/quota/message', { kind, text }); },
  });
}

/** Admin side: the thread with one user (reply, raise the quota, close). */
export function openAdminThread(opts: { userId: number; email: string; onQuota: () => void; onChange: () => void }) {
  const quota = h('button', { type: 'button', class: 'btn sm' }, 'Atur kuota') as HTMLButtonElement;
  const done = h('button', { type: 'button', class: 'btn ghost sm' }, 'Tutup thread') as HTMLButtonElement;
  const m = openThreadChat({
    title: opts.email, key: 'admin-thread',
    empty: 'Belum ada pesan.', placeholder: 'Balas...',
    mine: (x) => x.fromAdmin,
    load: async () => api.get<{ messages: ThreadMsg[] }>('/admin/threads/' + opts.userId),
    send: async (text) => { await api.post(`/admin/threads/${opts.userId}/reply`, { text }); opts.onChange(); },
    actions: [quota, done],
  });
  quota.onclick = () => { m.close(); opts.onQuota(); };
  done.onclick = async () => {
    try { await api.post(`/admin/threads/${opts.userId}/reply`, { close: true }); toast('Thread ditutup.', { kind: 'ok' }); m.close(); opts.onChange(); }
    catch (e: any) { toast(e.message, { kind: 'bad' }); }
  };
}
