/* Quota appeal as a chat: a message thread between a tester and the admin (me on the right, them on the left), with
   photo attachments. `threadView` is a plain element used by the "Pesan" page (tester) and the admin panel.
   - day separators, grouped bubbles (same side within a few minutes), time only on the last bubble of a group
   - optimistic sending: the bubble shows "Mengirim..." at once, and "Gagal terkirim" with retry / remove on failure
   - the list only follows new messages while the reader is already near the bottom (else a "Pesan baru" pill)
   - photos open in a lightbox; their box size is remembered so polling re-renders do not make the list jump */
import { h } from './dom';
import { svg } from '../icons';
import { toast } from './overlay';
import { api, QUOTA_LABEL } from '../api';

export interface ThreadMsg { id: number; fromAdmin: boolean; text: string; image: boolean; at: string | null }
export interface ThreadLoad { messages: ThreadMsg[]; open?: boolean }
interface ViewOpts {
  load: () => Promise<ThreadLoad>;
  send: (text: string, image?: string) => Promise<void>;
  /** true = the bubble belongs to the person looking at it (right side) */
  mine: (m: ThreadMsg) => boolean;
  /** shown while there are no messages */
  empty: { title: string; text?: string; hint?: string };
  placeholder: string;
  /** placeholder while the next message starts a new request (no thread yet, or it was closed) */
  placeholderNew?: string;
  /** minimum length of a message that starts a new request (the server checks the same) */
  minFirst?: number;
  /** quiet line at the top of a non-empty thread */
  intro?: string;
  /** line at the end when the thread is closed */
  closedNote?: string;
  label: string;
  onLoaded?: (r: ThreadLoad) => void;
}
interface Pending { key: number; text: string; image?: string; state: 'sending' | 'failed' | 'sent'; error?: string; at: number; after: number }

const MAX = 400, GROUP_MS = 5 * 60_000;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const timeOf = (t: number) => new Date(t).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
const dayKey = (t: number) => { const d = new Date(t); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); };
function dayLabel(t: number): string {
  const now = new Date(), d = new Date(t);
  if (dayKey(t) === dayKey(+now)) return 'Hari ini';
  if (dayKey(t) === dayKey(+now - 864e5)) return 'Kemarin';
  return d.toLocaleDateString('id-ID', d.getFullYear() === now.getFullYear() ? { weekday: 'long', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
const fullTime = (t: number) => new Date(t).toLocaleString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const ERR: Record<string, string> = {
  too_short: 'Ceritakan sedikit lagi ya, minimal 15 karakter.',
  too_many: 'Kamu sudah mengirim 6 pesan dalam sehari. Tunggu balasannya dulu ya.',
  bad_image: 'Fotonya tidak bisa dikirim. Coba foto lain.',
  rate_limited: 'Terlalu sering mengirim. Coba lagi sebentar lagi.',
  network: 'Gagal terkirim. Periksa koneksimu.',
};
const errText = (e: any) => ERR[e?.code] || 'Gagal terkirim.';

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
  throw new Error('Fotonya terlalu besar.');
}

/** Full-screen photo viewer: Esc, the close button or a tap outside the photo closes it; focus returns to the opener. */
function lightbox(src: string, opener: HTMLElement) {
  const img = h('img', { src, alt: 'Foto' });
  const x = h('button', { type: 'button', class: 'ap-lb-b', 'aria-label': 'Tutup foto', html: svg('x') }) as HTMLButtonElement;
  const open = src.startsWith('data:') ? null : h('a', { class: 'ap-lb-b', href: src, target: '_blank', rel: 'noopener', 'aria-label': 'Buka di tab baru', title: 'Buka di tab baru', html: svg('external') });
  const box = h('div', { class: 'ap-lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Foto' }, img, h('div', { class: 'ap-lb-bar' }, open, x));
  const close = () => { box.remove(); removeEventListener('keydown', key, true); removeEventListener('hashchange', close); opener.focus({ preventScroll: true }); };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { const f = [open, x].filter(Boolean) as HTMLElement[]; const i = f.indexOf(document.activeElement as HTMLElement); e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus(); }
  };
  box.addEventListener('click', (e) => { if (e.target === box || e.target === img) close(); });
  x.onclick = close;
  addEventListener('keydown', key, true); addEventListener('hashchange', close);
  document.body.append(box);
  x.focus({ preventScroll: true });
}

export function threadView(o: ViewOpts): { el: HTMLElement; destroy: () => void; refresh: () => Promise<void>; focus: () => void } {
  let alive = true, loaded = false, failedLoad = false, open = false, msgs: ThreadMsg[] = [], pending: Pending[] = [], seq = 0, lastSig = '', lastIncoming = 0;
  const sizes = new Map<number, [number, number]>();   // photo id -> natural size (reserve the box on re-render)

  /* ---------- structure ---------- */
  const list = h('div', { class: 'ap-list' });
  const scroller = h('div', { class: 'ap-scroll', role: 'log', 'aria-label': o.label, tabindex: '0' }, list);
  const jump = h('button', { type: 'button', class: 'ap-jump', hidden: true, html: svg('chevronDown') }, h('span', null, 'Pesan baru')) as HTMLButtonElement;
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const main = h('div', { class: 'ap-main' }, scroller, jump, live);

  const input = h('textarea', { class: 'input ap-in', rows: '1', maxLength: MAX, placeholder: o.placeholder, enterkeyhint: 'send', 'aria-label': 'Tulis pesan' }) as HTMLTextAreaElement;
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, tabindex: '-1' }) as HTMLInputElement;
  const attach = h('button', { type: 'button', class: 'btn ghost icon ap-attach', 'aria-label': 'Lampirkan foto', title: 'Lampirkan foto', html: svg('image') }) as HTMLButtonElement;
  const send = h('button', { type: 'submit', class: 'btn primary icon ap-send', 'aria-label': 'Kirim', title: 'Kirim', disabled: true, html: svg('arrowUp') }) as HTMLButtonElement;
  const chip = h('div', { class: 'ap-chip', hidden: true });
  const noteMsg = h('span', { class: 'ap-note-m' });
  const counter = h('span', { class: 'ap-count', hidden: true });
  const note = h('div', { class: 'ap-note', 'aria-live': 'polite' }, noteMsg, counter);
  const form = h('form', { class: 'ap-form' }, attach, input, send, file) as HTMLFormElement;
  const bar = h('div', { class: 'ap-bar' }, chip, form, note);
  const el = h('div', { class: 'ap' }, main, bar);

  /* ---------- scrolling: follow the bottom only while the reader is there ---------- */
  let stick = true;
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 72;
  const toBottom = (smooth = false) => { scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !reduced() ? 'smooth' : 'auto' }); };
  scroller.addEventListener('scroll', () => { stick = nearBottom(); if (stick) jump.hidden = true; }, { passive: true });
  // keyboard opening, the composer growing, a photo loading: stay at the bottom if we were there
  const ro = new ResizeObserver(() => { if (stick) toBottom(); });
  ro.observe(scroller); ro.observe(list);
  jump.onclick = () => { stick = true; jump.hidden = true; toBottom(true); };

  /* ---------- composer ---------- */
  let photo: string | null = null;
  const startsNew = () => !!o.minFirst && loaded && !open;
  const syncSend = () => {
    const n = input.value.length;
    send.disabled = !input.value.trim() && !photo;
    counter.hidden = n < MAX - 80;
    counter.textContent = `${n}/${MAX}`;
    counter.classList.toggle('max', n >= MAX);
  };
  const setNote = (t: string, bad = false) => { noteMsg.textContent = t; note.classList.toggle('bad', bad); };
  const grow = () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + (input.offsetHeight - input.clientHeight), 168) + 'px';
  };
  const setPhoto = (b64: string | null) => {
    photo = b64;
    chip.hidden = !b64;
    const rm = h('button', { type: 'button', class: 'btn ghost icon ap-chip-x', 'aria-label': 'Hapus foto', title: 'Hapus foto', html: svg('x') });
    rm.onclick = () => { setPhoto(null); input.focus(); };
    chip.replaceChildren(...(b64 ? [h('img', { src: 'data:image/jpeg;base64,' + b64, alt: 'Foto terlampir' }), h('span', null, 'Foto siap dikirim'), rm] : []));
    syncSend();
  };
  attach.onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files?.[0]; file.value = '';
    if (!f) return;
    attach.disabled = true; attach.classList.add('busy'); attach.innerHTML = '<span class="spinner" aria-hidden="true"></span>';
    try { setPhoto(await shrink(f)); input.focus({ preventScroll: true }); } catch (e: any) { toast(e?.message || 'Fotonya tidak bisa dibaca.', { kind: 'bad' }); }
    finally { attach.disabled = false; attach.classList.remove('busy'); attach.innerHTML = svg('image'); }
  };
  input.addEventListener('input', () => { grow(); syncSend(); if (note.classList.contains('bad')) setNote(''); });
  input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
  // tapping send must not close the on-screen keyboard
  send.addEventListener('mousedown', (e) => { if (document.activeElement === input) e.preventDefault(); });

  /* ---------- rendering ---------- */
  const fit = (img: HTMLImageElement, w: number, hh: number) => {
    // fit in 260 x 320, but never thinner than 180 x 110 (very tall / wide shots are cropped; the lightbox shows all)
    const k = Math.min(1, 260 / w, 320 / hh);
    img.style.width = Math.round(Math.min(260, Math.max(180, w * k))) + 'px';
    img.style.height = Math.round(Math.min(320, Math.max(110, hh * k))) + 'px';
  };
  const photoEl = (src: string, id: number | null) => {
    const img = h('img', { src, alt: 'Foto', decoding: 'async' }) as HTMLImageElement;
    const known = id != null ? sizes.get(id) : undefined;
    if (known) fit(img, known[0], known[1]);
    img.onload = () => { if (id != null) sizes.set(id, [img.naturalWidth, img.naturalHeight]); fit(img, img.naturalWidth, img.naturalHeight); img.parentElement?.classList.remove('loading'); };
    img.onerror = () => { img.parentElement?.classList.add('broken'); };
    const b = h('button', { type: 'button', class: 'ap-photo' + (known ? '' : ' loading'), 'aria-label': 'Lihat foto' }, img);
    b.onclick = () => lightbox(src, b);
    return b;
  };
  const bubble = (text: string, img: HTMLElement | null) => h('div', { class: 'ap-b' + (img ? ' has-img' : '') + (img && !text ? ' only-img' : '') }, img, text ? h('div', { class: 'ap-t' }, text) : null);

  type Item = { mine: boolean; t: number; node: (cls: string, showMeta: boolean) => HTMLElement };
  const items = (): Item[] => {
    const out: Item[] = msgs.map((m) => {
      const t = m.at ? Date.parse(m.at) : Date.now();
      return { mine: o.mine(m), t, node: (cls, showMeta) => h('div', { class: 'ap-msg ' + cls },
        bubble(m.text, m.image ? photoEl('/api/quota/image/' + m.id, m.id) : null),
        showMeta ? h('div', { class: 'ap-meta' }, h('time', { dateTime: m.at || '', title: fullTime(t) }, timeOf(t))) : null) };
    });
    const lastMine = msgs.filter((m) => o.mine(m));
    for (const p of pending) {
      // already on the server list (sent while a poll was in flight): do not show it twice
      if (p.state === 'sent' && lastMine.some((m) => m.id > p.after && m.text === p.text)) continue;
      out.push({ mine: true, t: p.at, node: (cls) => {
        const meta = p.state === 'failed'
          ? h('div', { class: 'ap-meta ap-fail', role: 'alert' }, h('span', null, p.error || 'Gagal terkirim.'),
            h('button', { type: 'button', class: 'ap-act', onclick: () => void deliver(p) }, 'Coba lagi'),
            h('button', { type: 'button', class: 'ap-act', onclick: () => { pending = pending.filter((x) => x !== p); paint(true); } }, 'Hapus'))
          : h('div', { class: 'ap-meta' }, h('span', { class: 'spinner ap-spin', 'aria-hidden': 'true' }), 'Mengirim…');
        return h('div', { class: 'ap-msg ' + cls + ' ' + p.state }, bubble(p.text, p.image ? photoEl('data:image/jpeg;base64,' + p.image, null) : null), meta);
      } });
    }
    return out;
  };

  const skeleton = () => h('div', { class: 'ap-skels', 'aria-hidden': 'true' },
    ...[['them', 62], ['them', 40], ['me', 54], ['them', 48], ['me', 34]].map(([s, w]) => h('div', { class: 'skel ap-skel ' + s, style: `width:${w}%` })));
  const emptyEl = () => h('div', { class: 'ap-empty' },
    h('div', { class: 'empty-ic', html: svg('message') }),
    h('h3', null, o.empty.title),
    o.empty.text ? h('p', null, o.empty.text) : null,
    o.empty.hint ? h('p', { class: 'hint' }, o.empty.hint) : null);

  function paint(force = false) {
    if (!loaded) {
      list.replaceChildren(failedLoad
        ? h('div', { class: 'ap-empty' }, h('div', { class: 'empty-ic', html: svg('alert') }), h('h3', null, 'Pesan belum bisa dimuat'), h('p', null, 'Periksa koneksi, lalu coba lagi.'),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { failedLoad = false; paint(true); void refresh(); } }, 'Coba lagi'))
        : skeleton());
      return;
    }
    const sig = msgs.map((m) => m.id).join(',') + '|' + open + '|' + pending.map((p) => p.key + p.state).join(',');
    if (!force && sig === lastSig) return;
    lastSig = sig;
    const was = stick, top = scroller.scrollTop;
    const all = items();
    if (!all.length) { list.replaceChildren(emptyEl()); return; }
    const nodes: HTMLElement[] = [];
    if (o.intro) nodes.push(h('p', { class: 'ap-sys' }, o.intro));
    let prevDay = 0;
    all.forEach((it, i) => {
      const day = dayKey(it.t);
      if (day !== prevDay) { nodes.push(h('div', { class: 'ap-day', role: 'separator' }, h('span', null, dayLabel(it.t)))); prevDay = day; }
      const prev = all[i - 1], next = all[i + 1];
      const joins = (a?: Item, b?: Item) => !!a && !!b && a.mine === b.mine && Math.abs(b.t - a.t) < GROUP_MS && dayKey(a.t) === dayKey(b.t);
      const first = !joins(prev, it), last = !joins(it, next);
      nodes.push(it.node((it.mine ? 'me' : 'them') + (first ? ' first' : '') + (last ? ' last' : ''), last));
    });
    if (o.closedNote && !open && msgs.length && !pending.length) nodes.push(h('p', { class: 'ap-sys end' }, o.closedNote));
    list.replaceChildren(...nodes);
    if (was) toBottom(); else scroller.scrollTop = top;
  }

  /* ---------- load / poll ---------- */
  const refresh = async () => {
    try {
      const r = await o.load();
      if (!alive) return;
      const firstLoad = !loaded;
      const newest = r.messages.filter((m) => !o.mine(m)).at(-1);
      if (newest && newest.id > lastIncoming) {
        if (!firstLoad) {
          live.textContent = 'Pesan baru: ' + (newest.text || 'foto');
          if (!stick) jump.hidden = false;
        }
        lastIncoming = newest.id;
      }
      msgs = r.messages; open = !!r.open; loaded = true; failedLoad = false;
      input.placeholder = startsNew() && o.placeholderNew ? o.placeholderNew : o.placeholder;
      paint(firstLoad);
      if (firstLoad) { stick = true; toBottom(); }
      o.onLoaded?.(r);
    } catch { if (alive && !loaded) { failedLoad = true; paint(true); } /* offline later: keep what is shown */ }
  };
  paint();
  void refresh();
  const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
  const onVis = () => { if (!document.hidden) void refresh(); };
  document.addEventListener('visibilitychange', onVis);

  /* ---------- sending ---------- */
  async function deliver(p: Pending) {
    p.state = 'sending'; p.error = undefined; paint();
    try {
      await o.send(p.text, p.image);
      if (!alive) return;
      p.state = 'sent';
      await refresh();
      pending = pending.filter((x) => x !== p);
      paint();
    } catch (err) {
      if (!alive) return;
      p.state = 'failed'; p.error = errText(err); paint();
    }
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text && !photo) return;
    if (startsNew() && text.length < (o.minFirst || 0)) {
      setNote(text ? `Ceritakan sedikit lagi ya, minimal ${o.minFirst} karakter.` : 'Tambahkan sedikit cerita untuk fotonya ya.', true);
      input.focus();
      return;
    }
    setNote('');
    const p: Pending = { key: ++seq, text, image: photo || undefined, state: 'sending', at: Date.now(), after: msgs.at(-1)?.id || 0 };
    pending.push(p);
    input.value = ''; grow(); setPhoto(null);
    stick = true;
    void deliver(p);
  };

  return {
    el, refresh,
    focus: () => input.focus({ preventScroll: true }),
    destroy: () => { alive = false; clearInterval(timer); ro.disconnect(); document.removeEventListener('visibilitychange', onVis); },
  };
}

/** The tester's side of the thread (used by the "Pesan" page). `kind` = which quota ran out (from the quota notice). */
export function testerThread(kind: string, onLoaded?: ViewOpts['onLoaded']) {
  const what = QUOTA_LABEL[kind];
  return threadView({
    label: 'Percakapan dengan pengundangmu',
    empty: {
      title: what ? `Kuota ${what} habis?` : 'Butuh kuota tambahan?',
      text: 'Ceritakan untuk apa kamu butuh tambahan. Pesanmu langsung sampai ke orang yang mengundangmu, dan balasannya muncul di sini.',
      hint: 'Kuota dibatasi karena kredit uji coba ini terbatas. Boleh lampirkan foto, misalnya tangkapan layar.',
    },
    intro: 'Hanya kamu dan pengundangmu yang bisa melihat percakapan ini.',
    closedNote: 'Percakapan ini sudah selesai. Kirim pesan baru kalau butuh tambahan lagi.',
    placeholder: 'Tulis pesan…',
    placeholderNew: 'Ceritakan kebutuhanmu…',
    minFirst: 15,
    mine: (m) => !m.fromAdmin,
    onLoaded,
    load: async () => {
      const r = await api.get<{ messages: ThreadMsg[]; open: boolean; unread: number }>('/quota/thread');
      // mark read before the header badge refreshes (onLoaded), so it clears right away
      if (r.unread) await api.post('/quota/thread/seen').catch(() => {});
      return r;
    },
    send: async (text, image) => { await api.post('/quota/message', { kind, text, image }); },
  });
}

/** Admin side: the thread with one user. */
export function adminThread(userId: number, onChange: () => void, isOpen: () => boolean = () => true) {
  return threadView({
    label: 'Percakapan dengan penguji',
    empty: { title: 'Belum ada pesan' },
    closedNote: 'Thread ditutup. Penguji bisa membukanya lagi dengan pesan baru.',
    placeholder: 'Balas…',
    mine: (x) => x.fromAdmin,
    load: async () => ({ ...(await api.get<{ messages: ThreadMsg[] }>('/admin/threads/' + userId)), open: isOpen() }),
    send: async (text, image) => { await api.post(`/admin/threads/${userId}/reply`, { text, image }); onChange(); },
  });
}
