/* Quota appeal as a chat: a message thread between a tester and the admin (me on the right, them on the left), with
   photo attachments. `threadView` is a plain element used by the "Pesan" page (tester) and the admin panel. */
import { h } from './dom';
import { svg } from '../icons';
import { toast } from './overlay';
import { api } from '../api';

export interface ThreadMsg { id: number; fromAdmin: boolean; text: string; image: boolean; at: string | null }
interface ViewOpts {
  load: () => Promise<{ messages: ThreadMsg[]; open?: boolean }>;
  send: (text: string, image?: string) => Promise<void>;
  /** true = the bubble belongs to the person looking at it (right side) */
  mine: (m: ThreadMsg) => boolean;
  empty: string;
  placeholder: string;
  onLoaded?: (r: { messages: ThreadMsg[]; open?: boolean }) => void;
}

const when = (iso: string | null) => { if (!iso) return ''; const d = new Date(iso); return isNaN(+d) ? '' : d.toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };

/** Shrink a photo to a JPEG of at most ~1280 px and well under the server limit; resolves with the base64 payload. */
async function shrink(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55, 0.4]) {
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= 1_300_000) {
      const buf = new Uint8Array(await blob.arrayBuffer()); let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    }
  }
  throw new Error('Foto terlalu besar.');
}

export function threadView(o: ViewOpts): { el: HTMLElement; destroy: () => void; refresh: () => Promise<void> } {
  let alive = true, last = -1;
  const list = h('div', { class: 'ap-list', role: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { class: 'input ap-in', rows: '1', maxLength: 400, placeholder: o.placeholder, enterkeyhint: 'send' }) as HTMLTextAreaElement;
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true }) as HTMLInputElement;
  const attach = h('button', { type: 'button', class: 'btn ghost icon ap-attach', 'aria-label': 'Lampirkan foto', html: svg('image') }) as HTMLButtonElement;
  const send = h('button', { type: 'submit', class: 'btn primary icon ap-send', 'aria-label': 'Kirim', html: svg('arrowUp') }) as HTMLButtonElement;
  const chip = h('div', { class: 'ap-chip', hidden: true });
  const form = h('form', { class: 'ap-form' }, attach, input, send, file) as HTMLFormElement;
  const el = h('div', { class: 'ap' }, list, chip, form);
  let photo: string | null = null;
  const setPhoto = (b64: string | null) => {
    photo = b64;
    chip.hidden = !b64;
    chip.replaceChildren(...(b64 ? [h('img', { src: 'data:image/jpeg;base64,' + b64, alt: 'Foto terlampir' }), h('button', { type: 'button', class: 'btn ghost sm', onclick: () => setPhoto(null) }, 'Hapus foto')] : []));
  };
  attach.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0]; file.value = '';
    if (!f) return;
    attach.disabled = true;
    try { setPhoto(await shrink(f)); } catch (e: any) { toast(e?.message || 'Foto tidak bisa dibaca.', { kind: 'bad' }); }
    finally { attach.disabled = false; }
  };
  const paint = (msgs: ThreadMsg[]) => {
    const sig = msgs.length ? msgs[msgs.length - 1].id : 0;
    if (sig === last) return;
    last = sig;
    list.replaceChildren(...(msgs.length
      ? msgs.map((x) => h('div', { class: 'ap-msg ' + (o.mine(x) ? 'me' : 'them') },
        h('div', { class: 'ap-b' },
          x.image ? h('a', { href: '/api/quota/image/' + x.id, target: '_blank', rel: 'noopener' }, h('img', { class: 'ap-img', src: '/api/quota/image/' + x.id, alt: 'Foto', loading: 'lazy', onload: () => { list.scrollTop = list.scrollHeight; } })) : null,
          x.text ? h('span', null, x.text) : null),
        h('small', null, when(x.at))))
      : [h('p', { class: 'hint ap-empty' }, o.empty)]));
    list.scrollTop = list.scrollHeight;
  };
  const refresh = async () => { try { const r = await o.load(); if (alive) { paint(r.messages); o.onLoaded?.(r); } } catch { /* offline: keep what is shown */ } };
  void refresh();
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !photo) return;
    send.disabled = true;
    try { await o.send(text, photo || undefined); input.value = ''; setPhoto(null); await refresh(); }
    catch (err: any) { toast(err?.message || 'Gagal mengirim.', { kind: 'bad' }); }
    finally { send.disabled = false; }
  };
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
  return { el, refresh, destroy: () => { alive = false; clearInterval(timer); } };
}

/** The tester's side of the thread (used by the "Pesan" page). */
export function testerThread(kind: string, onLoaded?: ViewOpts['onLoaded']) {
  return threadView({
    empty: 'Kuota harian dibatasi karena kredit uji coba ini terbatas. Ceritakan untuk apa kamu butuh tambahan (minimal 15 karakter, boleh lampirkan foto). Balasan akan muncul di sini.',
    placeholder: 'Tulis pesan...',
    mine: (m) => !m.fromAdmin,
    onLoaded,
    load: async () => {
      const r = await api.get<{ messages: ThreadMsg[]; open: boolean; unread: number }>('/quota/thread');
      if (r.unread) void api.post('/quota/thread/seen').catch(() => {});
      return r;
    },
    send: async (text, image) => { await api.post('/quota/message', { kind, text, image }); },
  });
}

/** Admin side: the thread with one user. */
export function adminThread(userId: number, onChange: () => void) {
  return threadView({
    empty: 'Belum ada pesan.', placeholder: 'Balas...',
    mine: (x) => x.fromAdmin,
    load: async () => api.get<{ messages: ThreadMsg[] }>('/admin/threads/' + userId),
    send: async (text, image) => { await api.post(`/admin/threads/${userId}/reply`, { text, image }); onChange(); },
  });
}
