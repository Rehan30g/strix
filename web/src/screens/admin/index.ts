/* Admin: invite codes (1–4 uses, expiry, note, copy, revoke), users (usage, suspend, quota override, delete clones)
   and the account's voice slots for public Voice Library voices (clean up voices no user references). */
import type { ScreenCtx } from '../../ctx';
import { h, fmtDate, relTime, fmtNum, avatar } from '../../ui/dom';
import { field, seg } from '../../ui/controls';
import { adminThread } from '../../ui/appeal';
import { QUOTA_LABEL } from '../../api';

interface Invite { id: number; code: string; maxUses: number; usedCount: number; expiresAt: string; note: string | null; revoked: boolean; status: 'active' | 'expired' | 'full' | 'revoked'; createdBy: string | null; createdAt: string; users: string[] }
interface Limits { llmReqPerDay: number; ttsCharsPerDay: number; maxClones: number; vcSecPerDay?: number; sttSecPerDay?: number }
interface AdminUser { id: number; email: string; name: string; picture: string | null; status: 'pending' | 'active' | 'suspended'; isAdmin: boolean; inviteCode: string | null; createdAt: string; clones: number; usageToday: { llm: number; tts: number; tokens: number; vc?: number }; limits: Limits; quotaOverrides: Partial<Limits> }

const INV_STATUS: Record<Invite['status'], [string, string]> = { active: ['Aktif', 'ok'], full: ['Penuh', 'info'], expired: ['Kedaluwarsa', 'warn'], revoked: ['Dicabut', 'bad'] };
const USER_STATUS: Record<AdminUser['status'], [string, string]> = { active: ['Aktif', 'ok'], pending: ['Menunggu kode', 'warn'], suspended: ['Ditangguhkan', 'bad'] };

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { api, ui, icons, store } = ctx;
  const S = icons.svg;
  let tab: 'invites' | 'users' | 'messages' = ctx.route.params.get('tab') === 'users' ? 'users' : ctx.route.params.get('tab') === 'messages' ? 'messages' : 'invites';
  let invites: Invite[] = [], users: AdminUser[] = [];
  let showInactive = false;
  let uq = '';

  const copy = async (text: string, btnEl?: HTMLElement) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const t = h('textarea', { value: text, style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
      document.body.append(t); t.select(); document.execCommand('copy'); t.remove();
    }
    if (btnEl) { const old = btnEl.innerHTML; btnEl.innerHTML = S('check') + (btnEl.textContent ? '<span>Tersalin</span>' : ''); btnEl.classList.add('copied'); setTimeout(() => { btnEl.innerHTML = old; btnEl.classList.remove('copied'); }, 1400); }
    else ui.toast('Disalin ke clipboard.', { kind: 'ok', timeout: 2000 });
  };
  const copyBtn = (text: string, label = '') => {
    const b = h('button', { type: 'button', class: 'btn sm ' + (label ? 'soft' : 'ghost icon'), title: 'Salin kode', 'aria-label': `Salin kode ${text}`, html: S('copy') + (label ? `<span>${label}</span>` : '') });
    b.onclick = () => copy(text, b);
    return b;
  };

  /* ---------- invites ---------- */
  let uses = 1;
  const usesSeg = seg<string>([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], '1', (v) => { uses = Number(v); }, 'Jumlah pemakaian');
  const expSel = h('select', { class: 'select' },
    ...[['24', '1 hari'], ['72', '3 hari'], ['168', '7 hari'], ['336', '14 hari'], ['720', '30 hari'], ['custom', 'Pilih tanggal...']].map(([v, l]) => new Option(l, v))) as HTMLSelectElement;
  expSel.value = '168';
  const expDate = h('input', { class: 'input', type: 'datetime-local', hidden: true, 'aria-label': 'Tanggal kedaluwarsa' }) as HTMLInputElement;
  expSel.onchange = () => {
    expDate.hidden = expSel.value !== 'custom';
    if (!expDate.hidden && !expDate.value) { const d = new Date(Date.now() + 7 * 86400_000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); expDate.value = d.toISOString().slice(0, 16); }
  };
  const note = h('input', { class: 'input', maxLength: 200, placeholder: 'mis. untuk Budi (teman kantor)' }) as HTMLInputElement;
  const createBtn = ui.btn({ label: 'Buat kode', icon: 'plus', cls: 'primary', type: 'submit' });
  const created = h('div', { 'aria-live': 'polite' });
  const createForm = h('form', { class: 'inv-form' },
    field('Jumlah akun', usesSeg),
    h('div', { class: 'field' }, h('label', null, 'Berlaku'), expSel, expDate),
    field('Catatan', note),
    h('div', { class: 'inv-submit' }, createBtn));
  createForm.onsubmit = async (e) => {
    e.preventDefault();
    const body: Record<string, unknown> = { maxUses: uses, note: note.value.trim() || undefined };
    if (expSel.value === 'custom') {
      const t = new Date(expDate.value).getTime();
      if (!expDate.value || !(t > Date.now())) { ui.toast('Tanggal kedaluwarsa harus di masa depan.', { kind: 'warn' }); expDate.focus(); return; }
      body.expiresAt = new Date(t).toISOString();
    } else body.expiresInHours = Number(expSel.value);
    createBtn.disabled = true;
    try {
      const r = await api.post<{ invite: Invite }>('/admin/invites', body);
      const inv = r.invite;
      note.value = '';
      created.replaceChildren(h('div', { class: 'inv-new' },
        h('div', null, h('div', { class: 'hint' }, `Kode baru · ${inv.maxUses}x pakai · berlaku sampai ${fmtDate(inv.expiresAt)}`), h('div', { class: 'inv-code-big' }, inv.code)),
        copyBtn(inv.code, 'Salin kode')));
      copy(inv.code).catch(() => {});
      await loadInvites();
    } catch (err: any) { ui.toast(err.message, { kind: 'bad', title: 'Gagal membuat kode' }); }
    finally { createBtn.disabled = false; }
  };

  const invBody = h('div');
  const inactiveToggle = h('label', { class: 'check', style: 'font-size:13.5px' }, h('input', { type: 'checkbox', onchange: (e: Event) => { showInactive = (e.target as HTMLInputElement).checked; paintInvites(); } }), 'Tampilkan nonaktif');
  function paintInvites() {
    const list = invites.filter((i) => showInactive || i.status === 'active' || i.status === 'full');
    if (!list.length) { invBody.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('ticket') }), h('h3', null, 'Belum ada kode'), h('p', null, 'Buat kode undangan di atas lalu bagikan ke teman.'))); return; }
    invBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table cards' },
      h('thead', null, h('tr', null, ...['Kode', 'Status', 'Dipakai', 'Berlaku sampai', 'Catatan', ''].map((t) => h('th', { class: t === 'Dipakai' ? 'num' : t === '' ? 'actions' : '' }, t)))),
      h('tbody', null, ...list.map((i) => {
        const [sl, sc] = INV_STATUS[i.status] || [i.status, ''];
        const revoke = i.status === 'active' || i.status === 'full' ? ui.btn({ label: 'Cabut', icon: 'ban', cls: 'sm danger-soft', onClick: async () => {
          if (!(await ui.confirm({ title: `Cabut kode ${i.code}?`, message: 'Kode tidak bisa dipakai lagi. Akun yang sudah memakainya tetap aktif.', confirm: 'Cabut', danger: true }))) return;
          try { await api.post(`/admin/invites/${i.id}/revoke`); ui.toast('Kode dicabut.', { kind: 'ok' }); await loadInvites(); } catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
        } }) : null;
        return h('tr', null,
          h('td', { class: 'primary-cell', 'data-label': 'Kode' }, h('div', { class: 'row', style: 'gap:6px' }, h('code', { class: 'inv-code' + (i.status === 'active' ? '' : ' dim') }, i.code), copyBtn(i.code))),
          h('td', { 'data-label': 'Status' }, h('span', { class: 'badge ' + sc }, sl)),
          h('td', { class: 'num', 'data-label': 'Dipakai', title: i.users.join(', ') }, h('span', { class: 'uses' }, ...Array.from({ length: i.maxUses }, (_, k) => h('i', { class: k < i.usedCount ? 'on' : '' }))), ` ${i.usedCount}/${i.maxUses}`),
          h('td', { 'data-label': 'Berlaku sampai', title: fmtDate(i.expiresAt) }, i.status === 'expired' ? relTime(i.expiresAt) : fmtDate(i.expiresAt)),
          h('td', { 'data-label': 'Catatan', class: 'note-cell' }, i.note || h('span', { class: 'hint' }, '–'), i.users.length ? h('div', { class: 'hint' }, i.users.join(', ')) : null),
          h('td', { class: 'actions' }, revoke));
      })))));
  }
  async function loadInvites() {
    try { invites = (await api.get<{ invites: Invite[] }>('/admin/invites')).invites || []; paintInvites(); }
    catch (e: any) { invBody.replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px', html: S('alert') }, h('span', null, e.message))); }
  }
  const invitesView = h('div', { class: 'stack', style: 'gap:20px' },
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Buat kode undangan')), h('div', { class: 'card-b stack', style: 'gap:16px' }, createForm, created)),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Kode undangan'), h('div', { style: 'margin-left:auto' }, inactiveToggle)), invBody));

  /* ---------- users ---------- */
  const usersBody = h('div');
  const userSearch = h('input', { class: 'input', type: 'search', placeholder: 'Cari email atau nama...', 'aria-label': 'Cari pengguna' }) as HTMLInputElement;
  userSearch.oninput = () => { uq = userSearch.value.trim().toLowerCase(); paintUsers(); };
  const meter = (used: number, limit: number, over: boolean) => {
    const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
    const bar = h('i'); bar.style.width = pct + '%';
    return h('div', { class: 'meter mini' + (pct >= 100 ? ' bad' : pct >= 80 ? ' warn' : '') },
      h('div', { class: 'm-top' }, h('span', null, h('b', null, fmtNum(used)), ` / ${fmtNum(limit)}`), over ? h('span', { class: 'badge accent', style: 'height:18px;font-size:11px' }, 'custom') : null),
      h('div', { class: 'bar' }, bar));
  };
  function paintUsers() {
    const me = store.get().me?.user;
    const list = users.filter((u) => !uq || `${u.email} ${u.name}`.toLowerCase().includes(uq));
    if (!list.length) { usersBody.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('users') }), h('h3', null, 'Tidak ada pengguna'))); return; }
    usersBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table cards' },
      h('thead', null, h('tr', null, ...['Pengguna', 'Status', 'Kode', 'AI hari ini', 'TTS hari ini', 'Clone', ''].map((t) => h('th', { class: t === 'Clone' ? 'num' : t === '' ? 'actions' : '' }, t)))),
      h('tbody', null, ...list.map((u) => {
        const [sl, sc] = USER_STATUS[u.status] || [u.status, ''];
        const self = me && String(me.id) === String(u.id);
        const more = h('button', { type: 'button', class: 'btn ghost icon sm', 'aria-label': `Aksi untuk ${u.email}`, 'aria-haspopup': 'menu', title: 'Aksi', html: S('moreV') });
        more.onclick = () => {
          const items = h('div', null,
            u.status === 'suspended' ? ui.menuItem('Aktifkan lagi', 'refresh', () => setStatus(u, 'unsuspend'))
              : self ? null : ui.menuItem('Tangguhkan', 'ban', () => setStatus(u, 'suspend'), 'danger'),
            ui.menuItem('Ubah kuota', 'gauge', () => editQuota(u)),
            u.clones > 0 ? ui.menuItem(`Hapus ${u.clones} clone suara`, 'trash', () => deleteVoices(u), 'danger') : null);
          ui.popover(more, items, { align: 'end' });
        };
        const act = h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' }, more);
        return h('tr', null,
          h('td', { class: 'primary-cell', 'data-label': 'Pengguna' }, h('div', { class: 'user-cell' }, avatar(u.name || u.email, u.picture),
            h('div', { class: 'user-t' }, h('b', null, u.name || u.email, u.isAdmin ? h('span', { class: 'badge accent', style: 'margin-left:6px;height:18px;font-size:11px' }, 'admin') : null), h('span', { title: `Bergabung ${fmtDate(u.createdAt)}` }, u.email)))),
          h('td', { 'data-label': 'Status' }, h('span', { class: 'badge ' + sc }, sl)),
          h('td', { 'data-label': 'Kode' }, u.inviteCode ? h('code', { class: 'inv-code sm' }, u.inviteCode) : h('span', { class: 'hint' }, '–')),
          h('td', { 'data-label': 'AI hari ini' }, meter(u.usageToday.llm, u.limits.llmReqPerDay, u.quotaOverrides.llmReqPerDay != null)),
          h('td', { 'data-label': 'TTS hari ini' }, meter(u.usageToday.tts, u.limits.ttsCharsPerDay, u.quotaOverrides.ttsCharsPerDay != null)),
          h('td', { class: 'num', 'data-label': 'Clone' }, `${u.clones} / ${u.limits.maxClones}`),
          h('td', { class: 'actions' }, act));
      })))));
  }
  async function loadUsers() {
    try { users = (await api.get<{ users: AdminUser[] }>('/admin/users')).users || []; paintUsers(); if (sel != null) paintHead(); }
    catch (e: any) { usersBody.replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px', html: S('alert') }, h('span', null, e.message))); }
  }
  async function setStatus(u: AdminUser, action: 'suspend' | 'unsuspend') {
    if (action === 'suspend' && !(await ui.confirm({ title: `Tangguhkan ${u.email}?`, message: 'Pengguna ini langsung tidak bisa memakai aplikasi sampai diaktifkan lagi.', confirm: 'Tangguhkan', danger: true }))) return;
    try { await api.post(`/admin/users/${u.id}/${action}`); ui.toast(action === 'suspend' ? 'Pengguna ditangguhkan.' : 'Pengguna diaktifkan.', { kind: 'ok' }); await loadUsers(); }
    catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
  }
  async function deleteVoices(u: AdminUser) {
    if (!(await ui.confirm({ title: `Hapus clone suara ${u.email}?`, message: `${u.clones} suara clone akan dihapus dari ElevenLabs dan database.`, confirm: 'Hapus semua', danger: true }))) return;
    try { const r = await api.del<{ deleted: number }>(`/admin/users/${u.id}/voices`); ui.toast(`${r?.deleted ?? 0} suara dihapus.`, { kind: 'ok' }); await loadUsers(); }
    catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
  }
  function editQuota(u: AdminUser) {
    const inp = (k: keyof Limits) => h('input', { class: 'input', type: 'number', min: '0', step: '1', inputMode: 'numeric', value: u.quotaOverrides[k] != null ? String(u.quotaOverrides[k]) : '', placeholder: `Bawaan` }) as HTMLInputElement;
    const llm = inp('llmReqPerDay'), tts = inp('ttsCharsPerDay'), cl = inp('maxClones'), vc = inp('vcSecPerDay');
    const hasVc = u.limits.vcSecPerDay != null;
    const stt = inp('sttSecPerDay'), hasStt = u.limits.sttSecPerDay != null;
    const save = ui.btn({ label: 'Simpan', cls: 'primary' });
    const cancel = ui.btn({ label: 'Batal' });
    const m = ui.modal({ title: `Kuota ${u.name || u.email}`, body: h('div', { class: 'stack', style: 'gap:14px' },
      h('p', { class: 'hint' }, 'Kosongkan untuk memakai nilai bawaan server. Berlaku harian (reset tengah malam UTC).'),
      field('Permintaan AI per hari', llm, `Sekarang: ${fmtNum(u.limits.llmReqPerDay)}`),
      field('Karakter TTS per hari', tts, `Sekarang: ${fmtNum(u.limits.ttsCharsPerDay)}`),
      hasVc ? field('Voice Changer (detik audio) per hari', vc, `Sekarang: ${fmtNum(u.limits.vcSecPerDay ?? 0)}`) : null,
      hasStt ? field('Input suara / mic (detik) per hari', stt, `Sekarang: ${fmtNum(u.limits.sttSecPerDay ?? 0)}`) : null,
      field('Maksimal clone suara', cl, `Sekarang: ${u.limits.maxClones}`)), actions: [cancel, save] });
    cancel.onclick = () => m.close();
    save.onclick = async () => {
      const val = (i: HTMLInputElement) => (i.value.trim() === '' ? null : Math.max(0, Math.floor(Number(i.value))));
      const body: Record<string, number | null> = { llmReqPerDay: val(llm), ttsCharsPerDay: val(tts), maxClones: val(cl) };
      if (hasVc) body.vcSecPerDay = val(vc);
      if (hasStt) body.sttSecPerDay = val(stt);
      if (Object.values(body).some((v) => v != null && !Number.isFinite(v))) { ui.toast('Isi angka yang valid.', { kind: 'warn' }); return; }
      save.disabled = true;
      try { await api.put(`/admin/users/${u.id}/quota`, body); m.close(); ui.toast('Kuota disimpan.', { kind: 'ok' }); await loadUsers(); }
      catch (e: any) { ui.toast(e.message, { kind: 'bad' }); save.disabled = false; }
    };
  }
  /* ---------- messages: chat threads with testers (quota appeals) ----------
     Desktop: list and thread side by side. Phones: the list, then the thread with a back button. */
  interface Th { userId: number; email: string; name?: string; picture?: string | null; kind: string; open: boolean; awaiting: boolean; last: string; lastFromAdmin?: boolean; lastImage?: boolean; lastAt?: string; updatedAt: string }
  let threads: Th[] = [], sel: number | null = null, threadsLoaded = false, threadsFailed = false;
  let tv: ReturnType<typeof adminThread> | null = null, tvUser = 0;
  const thList = h('div', { class: 'am-list', role: 'list', 'aria-label': 'Percakapan' });
  const thCount = h('span', { class: 'badge accent', hidden: true });
  const paneHead = h('div', { class: 'am-th' });
  const paneBody = h('div', { class: 'am-tb' });
  const pane = h('div', { class: 'am-pane' }, paneHead, paneBody);
  const msgView = h('section', { class: 'card am' },
    h('div', { class: 'am-side' }, h('div', { class: 'am-sh' }, h('h2', null, 'Pesan dari penguji'), thCount), thList),
    pane);
  const thName = (t: Th) => t.name || t.email;
  const thPreview = (t: Th) => (t.lastFromAdmin ? 'Kamu: ' : '') + (t.last || (t.lastImage ? 'Foto' : ''));
  const kindLabel = (k: string) => (QUOTA_LABEL[k] ? 'Kuota ' + QUOTA_LABEL[k] : '');
  const shortTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString('id-ID', { weekday: 'short' });
    return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  };
  const seg2Count = (n: number) => {
    const b = [...tabs.querySelectorAll('button')].at(-1); if (!b) return;
    let c = b.querySelector<HTMLElement>('.seg-count');
    if (!c) { c = h('span', { class: 'seg-count', 'aria-hidden': 'true' }); b.append(c); }
    c.hidden = !n; c.textContent = String(n);
    b.setAttribute('aria-label', n ? `Pesan, ${n} menunggu balasan` : 'Pesan');
  };
  function paintList() {
    const waiting = threads.filter((t) => t.awaiting).length;
    thCount.hidden = !waiting; thCount.textContent = `${waiting} menunggu`;
    seg2Count(waiting);
    if (!threadsLoaded) { thList.replaceChildren(...(threadsFailed ? [h('div', { class: 'notice bad', style: 'margin:12px', html: S('alert') }, h('span', null, 'Daftar pesan belum bisa dimuat.'))] : [0, 1, 2].map(() => h('div', { class: 'am-skel' }, h('span', { class: 'skel', style: 'width:36px;height:36px;border-radius:50%' }), h('span', { class: 'skel', style: 'flex:1;height:30px' }))))); return; }
    if (!threads.length) { thList.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('message') }), h('h3', null, 'Belum ada pesan'), h('p', null, 'Penguji yang kehabisan kuota bisa minta tambahan, dan pesannya muncul di sini.'))); return; }
    const sorted = [...threads].sort((a, b) => Number(b.awaiting) - Number(a.awaiting) || Number(b.open) - Number(a.open) || String(b.lastAt || b.updatedAt).localeCompare(String(a.lastAt || a.updatedAt)));
    thList.replaceChildren(...sorted.map((t) => {
      const meta = [kindLabel(t.kind), t.open ? '' : 'Ditutup'].filter(Boolean).join(' · ');
      const b = h('button', { type: 'button', class: 'am-item' + (t.awaiting ? ' awaiting' : '') + (t.open ? '' : ' closed'), role: 'listitem', 'aria-current': sel === t.userId ? 'true' : null,
        'aria-label': `${thName(t)}${t.awaiting ? ', menunggu balasan' : ''}${t.open ? '' : ', ditutup'}. ${thPreview(t)}` },
        avatar(thName(t), t.picture),
        h('span', { class: 'am-i-b' },
          h('span', { class: 'am-i-top' }, h('b', null, thName(t)), h('time', { dateTime: t.lastAt || '', title: t.lastAt ? fmtDate(t.lastAt) : '' }, shortTime(t.lastAt || t.updatedAt))),
          h('span', { class: 'am-i-prev' }, h('span', null, thPreview(t)), t.awaiting ? h('i', { class: 'am-dot', title: 'Menunggu balasan' }) : null),
          meta ? h('span', { class: 'am-i-meta' }, meta) : null));
      b.onclick = () => select(t.userId);
      return b;
    }));
  }
  function paintHead() {
    const t = threads.find((x) => x.userId === sel);
    if (!t) { paneHead.replaceChildren(); return; }
    const u = users.find((y) => y.id === t.userId);
    const usage = u ? `AI ${fmtNum(u.usageToday.llm)}/${fmtNum(u.limits.llmReqPerDay)} · TTS ${fmtNum(u.usageToday.tts)}/${fmtNum(u.limits.ttsCharsPerDay)}` : '';
    const sub = [t.name ? t.email : '', kindLabel(t.kind)].filter(Boolean).join(' · ');
    paneHead.replaceChildren(
      h('button', { type: 'button', class: 'btn ghost icon am-back', 'aria-label': 'Kembali ke daftar pesan', html: S('arrowLeft'), onclick: () => select(null) }),
      avatar(thName(t), t.picture),
      h('div', { class: 'am-th-t' }, h('b', null, thName(t), t.open ? null : h('span', { class: 'badge', style: 'margin-left:8px;height:20px;font-size:11.5px' }, 'Ditutup')),
        sub ? h('span', null, sub) : null, usage ? h('span', { class: 'am-usage' }, 'Hari ini: ' + usage) : null),
      h('div', { class: 'am-th-a' },
        ui.btn({ label: 'Atur kuota', icon: 'gauge', cls: 'sm soft', onClick: () => { if (u) editQuota(u); else { tab = 'users'; tabs.setValue('users'); show(); ui.toast('Pilih penggunanya di daftar.', { kind: 'warn' }); } } }),
        ui.btn({ label: t.open ? 'Tutup thread' : 'Buka lagi', cls: 'sm ghost', title: t.open ? 'Tandai selesai' : 'Buka lagi', onClick: async () => {
          try { await api.post('/admin/threads/' + t.userId + '/reply', { close: t.open }); t.open = !t.open; await loadThreads(); void tv?.refresh(); }
          catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
        } })));
  }
  function select(id: number | null) {
    sel = id;
    msgView.classList.toggle('has-sel', id != null);
    if (id !== tvUser) {
      tv?.destroy(); tv = null; tvUser = 0;
      if (id != null) {
        tv = adminThread(id, () => void loadThreads(), () => threads.find((x) => x.userId === id)?.open ?? true);
        tvUser = id;
        paneBody.replaceChildren(tv.el);
        if (matchMedia('(pointer: fine)').matches) tv.focus();
      } else paneBody.replaceChildren(h('div', { class: 'empty am-none' }, h('div', { class: 'empty-ic', html: S('message') }), h('h3', null, 'Pilih percakapan'), h('p', null, 'Pesan dari penguji muncul di daftar sebelah kiri.')));
    }
    paintHead(); paintList();
  }
  async function loadThreads() {
    try { threads = (await api.get<{ threads: Th[] }>('/admin/threads')).threads || []; threadsLoaded = true; threadsFailed = false; }
    catch { threadsFailed = !threadsLoaded; }
    paintList(); paintHead();
  }
  const thTimer = setInterval(() => { if (tab === 'messages' && !document.hidden) void loadThreads(); }, 15000);
  const usersView = h('section', { class: 'card' },
    h('div', { class: 'card-h', style: 'flex-wrap:wrap' }, h('h2', { style: 'flex:1 0 auto' }, 'Pengguna'), h('div', { style: 'flex:1 1 240px;max-width:340px;display:flex;gap:8px;align-items:center;margin-left:auto' }, userSearch, ui.btn({ icon: 'refresh', cls: 'ghost icon sm', title: 'Muat ulang', onClick: () => loadUsers() }))),
    usersBody);

  /* ---------- voice slots (public Voice Library) ---------- */
  interface Slots { used: number; accountSlotsUsed: number; appAdded: number; limit: number; cap: number; reserve: number; tier: string; unreferenced: number; mapped: Array<{ sourceId: string; name: string; refs: number; created: boolean; addedAt: string }> }
  const slotBody = h('div', { class: 'card-b stack', style: 'gap:12px' });
  slotBody.append(h('div', { class: 'skel', style: 'height:28px;width:60%' }), h('div', { class: 'skel', style: 'height:14px;width:90%' }));
  async function loadSlots() {
    try {
      const d = await api.get<Slots>('/admin/voice-slots');
      const clean = ui.btn({ label: `Bersihkan suara tak terpakai${d.unreferenced ? ` (${d.unreferenced})` : ''}`, icon: 'trash', cls: 'soft sm', onClick: async () => {
        const ok = await ui.confirm({ title: 'Bersihkan slot?', message: 'Suara Library yang tidak ada di koleksi siapa pun dihapus dari akun ElevenLabs. Clone dan suara bawaan tidak disentuh.', confirm: 'Bersihkan' });
        if (!ok) return;
        clean.disabled = true;
        try { const r = await api.post<{ removed: number; failed: number }>('/admin/voice-slots/cleanup'); ui.toast(`${r.removed} suara dihapus dari akun${r.failed ? `, ${r.failed} gagal` : ''}.`, { kind: r.failed ? 'warn' : 'ok' }); }
        catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
        loadSlots();
      } });
      clean.disabled = !d.unreferenced;
      slotBody.replaceChildren(
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
          h('span', { class: 'badge' + (d.used >= d.cap ? ' warn' : '') }, `Terpakai ${d.used} / batas ${d.cap}`),
          h('span', { class: 'badge outline' }, `Akun: ${d.accountSlotsUsed} / ${d.limit} (${d.tier || '-'})`),
          h('span', { class: 'badge outline' }, `Dari Library: ${d.appAdded}`)),
        h('p', { class: 'hint', style: 'margin:0' }, `Suara Library yang ditambahkan pengguna dipasang sekali di akun dan dipakai bersama. Batas = MAX_ACCOUNT_VOICE_SLOTS_USED atau batas akun dikurangi cadangan ${d.reserve}.`),
        d.mapped.length ? h('div', { class: 'hint', style: 'margin:0' }, d.mapped.slice(0, 30).map((m) => `${m.name.split(' - ')[0]} (${m.refs} pengguna${m.created ? '' : ', sudah ada di akun'})`).join(' · ')) : '',
        h('div', null, clean));
    } catch (e: any) { slotBody.replaceChildren(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, e.message))); }
  }
  const slotsView = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, 'Slot suara')), slotBody);

  /* ---------- page ---------- */
  const holder = h('div', { class: 'stack adm-holder', style: 'gap:16px' });
  const tabs = seg<'invites' | 'users' | 'messages'>([['invites', 'Kode undangan', 'ticket'], ['users', 'Pengguna', 'users'], ['messages', 'Pesan', 'message']], tab, (v) => { tab = v; show(); history.replaceState(null, '', `#/admin?tab=${v}`); }, 'Bagian admin');
  tabs.classList.add('adm-tabs');
  const page = h('div', { class: 'page' }, h('div', { class: 'page-inner' },
    h('div', null, tabs),
    holder));
  // the Pesan tab fills the screen (list / thread scroll inside, the composer stays at the bottom)
  function show() {
    root.classList.toggle('fill', tab === 'messages'); page.classList.toggle('am-mode', tab === 'messages');
    holder.replaceChildren(...(tab === 'invites' ? [invitesView] : tab === 'messages' ? [msgView] : [slotsView, usersView]));
    if (tab === 'users') { loadUsers(); loadSlots(); } else if (tab === 'messages') { loadThreads(); if (!users.length) loadUsers(); } else loadInvites();
  }
  root.append(page);
  const skel = () => h('div', { style: 'padding:16px' }, h('div', { class: 'stack', style: 'gap:10px' }, ...[0, 1, 2].map(() => h('div', { class: 'skel', style: 'height:36px' }))));
  invBody.append(skel()); usersBody.append(skel());
  select(null);
  show();
  // waiting count on the Pesan tab even before it is opened
  if (tab !== 'messages') void loadThreads();
  return () => { tv?.destroy(); clearInterval(thTimer); };
}
