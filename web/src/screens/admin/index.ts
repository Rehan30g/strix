/* Admin: invite codes (1–4 uses, expiry, note, copy, revoke), users (usage, suspend, quota override, delete clones)
   and the account's voice slots for public Voice Library voices (clean up voices no user references). */
import type { ScreenCtx } from '../../ctx';
import { h, fmtDate, relTime, fmtNum, avatar } from '../../ui/dom';
import { field, seg } from '../../ui/controls';
import { adminThread } from '../../ui/appeal';
import { QUOTA_LABEL } from '../../api';
import { t, locale } from '../../i18n';

interface Invite { id: number; code: string; maxUses: number; usedCount: number; expiresAt: string; note: string | null; revoked: boolean; status: 'active' | 'expired' | 'full' | 'revoked'; createdBy: string | null; createdAt: string; users: string[] }
interface Limits { llmReqPerDay: number; ttsCharsPerDay: number; maxClones: number; vcSecPerDay?: number; sttSecPerDay?: number }
interface AdminUser { id: number; email: string; name: string; picture: string | null; status: 'pending' | 'active' | 'suspended'; isAdmin: boolean; inviteCode: string | null; createdAt: string; clones: number; usageToday: { llm: number; tts: number; tokens: number; vc?: number }; limits: Limits; quotaOverrides: Partial<Limits> }

const INV_STATUS: Record<Invite['status'], [string, string]> = { active: [t('Aktif'), 'ok'], full: [t('Penuh'), 'info'], expired: [t('Kedaluwarsa'), 'warn'], revoked: [t('Dicabut'), 'bad'] };
const USER_STATUS: Record<AdminUser['status'], [string, string]> = { active: [t('Aktif'), 'ok'], pending: [t('Menunggu kode'), 'warn'], suspended: [t('Ditangguhkan'), 'bad'] };

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
      const ta = h('textarea', { value: text, style: 'position:fixed;opacity:0' }) as HTMLTextAreaElement;
      document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    if (btnEl) { const old = btnEl.innerHTML; btnEl.innerHTML = S('check') + (btnEl.textContent ? `<span>${t('Tersalin')}</span>` : ''); btnEl.classList.add('copied'); setTimeout(() => { btnEl.innerHTML = old; btnEl.classList.remove('copied'); }, 1400); }
    else ui.toast(t('Disalin ke clipboard.'), { kind: 'ok', timeout: 2000 });
  };
  const copyBtn = (text: string, label = '') => {
    const b = h('button', { type: 'button', class: 'btn sm ' + (label ? 'soft' : 'ghost icon'), title: t('Salin kode'), 'aria-label': t('Salin kode {text}', { text }), html: S('copy') + (label ? `<span>${label}</span>` : '') });
    b.onclick = () => copy(text, b);
    return b;
  };

  /* ---------- invites ---------- */
  let uses = 1;
  const usesSeg = seg<string>([['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']], '1', (v) => { uses = Number(v); }, t('Jumlah pemakaian'));
  const expSel = h('select', { class: 'select' },
    ...[['24', t('1 hari')], ['72', t('3 hari')], ['168', t('7 hari')], ['336', t('14 hari')], ['720', t('30 hari')], ['custom', t('Pilih tanggal...')]].map(([v, l]) => new Option(l, v))) as HTMLSelectElement;
  expSel.value = '168';
  const expDate = h('input', { class: 'input', type: 'datetime-local', hidden: true, 'aria-label': t('Tanggal kedaluwarsa') }) as HTMLInputElement;
  expSel.onchange = () => {
    expDate.hidden = expSel.value !== 'custom';
    if (!expDate.hidden && !expDate.value) { const d = new Date(Date.now() + 7 * 86400_000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); expDate.value = d.toISOString().slice(0, 16); }
  };
  const note = h('input', { class: 'input', maxLength: 200, placeholder: t('mis. untuk Budi (teman kantor)') }) as HTMLInputElement;
  const createBtn = ui.btn({ label: t('Buat kode'), icon: 'plus', cls: 'primary', type: 'submit' });
  const created = h('div', { 'aria-live': 'polite' });
  const createForm = h('form', { class: 'inv-form' },
    field(t('Jumlah akun'), usesSeg),
    h('div', { class: 'field' }, h('label', null, t('Berlaku')), expSel, expDate),
    field(t('Catatan'), note),
    h('div', { class: 'inv-submit' }, createBtn));
  createForm.onsubmit = async (e) => {
    e.preventDefault();
    const body: Record<string, unknown> = { maxUses: uses, note: note.value.trim() || undefined };
    if (expSel.value === 'custom') {
      const ms = new Date(expDate.value).getTime();
      if (!expDate.value || !(ms > Date.now())) { ui.toast(t('Tanggal kedaluwarsa harus di masa depan.'), { kind: 'warn' }); expDate.focus(); return; }
      body.expiresAt = new Date(ms).toISOString();
    } else body.expiresInHours = Number(expSel.value);
    createBtn.disabled = true;
    try {
      const r = await api.post<{ invite: Invite }>('/admin/invites', body);
      const inv = r.invite;
      note.value = '';
      created.replaceChildren(h('div', { class: 'inv-new' },
        h('div', null, h('div', { class: 'hint' }, t('Kode baru · {n}x pakai · berlaku sampai {date}', { n: inv.maxUses, date: fmtDate(inv.expiresAt) })), h('div', { class: 'inv-code-big' }, inv.code)),
        copyBtn(inv.code, t('Salin kode'))));
      copy(inv.code).catch(() => {});
      await loadInvites();
    } catch (err: any) { ui.toast(err.message, { kind: 'bad', title: t('Gagal membuat kode') }); }
    finally { createBtn.disabled = false; }
  };

  const invBody = h('div');
  const inactiveToggle = h('label', { class: 'check', style: 'font-size:13.5px' }, h('input', { type: 'checkbox', onchange: (e: Event) => { showInactive = (e.target as HTMLInputElement).checked; paintInvites(); } }), t('Tampilkan nonaktif'));
  function paintInvites() {
    const list = invites.filter((i) => showInactive || i.status === 'active' || i.status === 'full');
    if (!list.length) { invBody.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('ticket') }), h('h3', null, t('Belum ada kode')), h('p', null, t('Buat kode undangan di atas lalu bagikan ke teman.')))); return; }
    invBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table cards' },
      h('thead', null, h('tr', null, ...[[t('Kode'), ''], ['Status', ''], [t('Dipakai'), 'num'], [t('Berlaku sampai'), ''], [t('Catatan'), ''], ['', 'actions']].map(([c, k]) => h('th', { class: k }, c)))),
      h('tbody', null, ...list.map((i) => {
        const [sl, sc] = INV_STATUS[i.status] || [i.status, ''];
        const revoke = i.status === 'active' || i.status === 'full' ? ui.btn({ label: t('Cabut'), icon: 'ban', cls: 'sm danger-soft', onClick: async () => {
          if (!(await ui.confirm({ title: t('Cabut kode {code}?', { code: i.code }), message: t('Kode tidak bisa dipakai lagi. Akun yang sudah memakainya tetap aktif.'), confirm: t('Cabut'), danger: true }))) return;
          try { await api.post(`/admin/invites/${i.id}/revoke`); ui.toast(t('Kode dicabut.'), { kind: 'ok' }); await loadInvites(); } catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
        } }) : null;
        return h('tr', null,
          h('td', { class: 'primary-cell', 'data-label': t('Kode') }, h('div', { class: 'row', style: 'gap:6px' }, h('code', { class: 'inv-code' + (i.status === 'active' ? '' : ' dim') }, i.code), copyBtn(i.code))),
          h('td', { 'data-label': 'Status' }, h('span', { class: 'badge ' + sc }, sl)),
          h('td', { class: 'num', 'data-label': t('Dipakai'), title: i.users.join(', ') }, h('span', { class: 'uses' }, ...Array.from({ length: i.maxUses }, (_, k) => h('i', { class: k < i.usedCount ? 'on' : '' }))), ` ${i.usedCount}/${i.maxUses}`),
          h('td', { 'data-label': t('Berlaku sampai'), title: fmtDate(i.expiresAt) }, i.status === 'expired' ? relTime(i.expiresAt) : fmtDate(i.expiresAt)),
          h('td', { 'data-label': t('Catatan'), class: 'note-cell' }, i.note || h('span', { class: 'hint' }, '–'), i.users.length ? h('div', { class: 'hint' }, i.users.join(', ')) : null),
          h('td', { class: 'actions' }, revoke));
      })))));
  }
  async function loadInvites() {
    try { invites = (await api.get<{ invites: Invite[] }>('/admin/invites')).invites || []; paintInvites(); }
    catch (e: any) { invBody.replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px', html: S('alert') }, h('span', null, e.message))); }
  }
  const invitesView = h('div', { class: 'stack', style: 'gap:20px' },
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('Buat kode undangan'))), h('div', { class: 'card-b stack', style: 'gap:16px' }, createForm, created)),
    h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('Kode undangan')), h('div', { style: 'margin-left:auto' }, inactiveToggle)), invBody));

  /* ---------- users ---------- */
  const usersBody = h('div');
  const userSearch = h('input', { class: 'input', type: 'search', placeholder: t('Cari email atau nama...'), 'aria-label': t('Cari pengguna') }) as HTMLInputElement;
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
    if (!list.length) { usersBody.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('users') }), h('h3', null, t('Tidak ada pengguna')))); return; }
    usersBody.replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'table cards' },
      h('thead', null, h('tr', null, ...[[t('Pengguna'), ''], ['Status', ''], [t('Kode'), ''], [t('AI hari ini'), ''], [t('TTS hari ini'), ''], ['Clone', 'num'], ['', 'actions']].map(([c, k]) => h('th', { class: k }, c)))),
      h('tbody', null, ...list.map((u) => {
        const [sl, sc] = USER_STATUS[u.status] || [u.status, ''];
        const self = me && String(me.id) === String(u.id);
        const more = h('button', { type: 'button', class: 'btn ghost icon sm', 'aria-label': t('Aksi untuk {email}', { email: u.email }), 'aria-haspopup': 'menu', title: t('Aksi'), html: S('moreV') });
        more.onclick = () => {
          const items = h('div', null,
            u.status === 'suspended' ? ui.menuItem(t('Aktifkan lagi'), 'refresh', () => setStatus(u, 'unsuspend'))
              : self ? null : ui.menuItem(t('Tangguhkan'), 'ban', () => setStatus(u, 'suspend'), 'danger'),
            ui.menuItem(t('Ubah kuota'), 'gauge', () => editQuota(u)),
            u.clones > 0 ? ui.menuItem(t('Hapus {n} clone suara', { n: u.clones }), 'trash', () => deleteVoices(u), 'danger') : null);
          ui.popover(more, items, { align: 'end' });
        };
        const act = h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' }, more);
        return h('tr', null,
          h('td', { class: 'primary-cell', 'data-label': t('Pengguna') }, h('div', { class: 'user-cell' }, avatar(u.name || u.email, u.picture),
            h('div', { class: 'user-t' }, h('b', null, u.name || u.email, u.isAdmin ? h('span', { class: 'badge accent', style: 'margin-left:6px;height:18px;font-size:11px' }, 'admin') : null), h('span', { title: t('Bergabung {date}', { date: fmtDate(u.createdAt) }) }, u.email)))),
          h('td', { 'data-label': 'Status' }, h('span', { class: 'badge ' + sc }, sl)),
          h('td', { 'data-label': t('Kode') }, u.inviteCode ? h('code', { class: 'inv-code sm' }, u.inviteCode) : h('span', { class: 'hint' }, '–')),
          h('td', { 'data-label': t('AI hari ini') }, meter(u.usageToday.llm, u.limits.llmReqPerDay, u.quotaOverrides.llmReqPerDay != null)),
          h('td', { 'data-label': t('TTS hari ini') }, meter(u.usageToday.tts, u.limits.ttsCharsPerDay, u.quotaOverrides.ttsCharsPerDay != null)),
          h('td', { class: 'num', 'data-label': 'Clone' }, `${u.clones} / ${u.limits.maxClones}`),
          h('td', { class: 'actions' }, act));
      })))));
  }
  async function loadUsers() {
    try { users = (await api.get<{ users: AdminUser[] }>('/admin/users')).users || []; paintUsers(); if (sel != null) paintHead(); }
    catch (e: any) { usersBody.replaceChildren(h('div', { class: 'notice bad', style: 'margin:16px', html: S('alert') }, h('span', null, e.message))); }
  }
  async function setStatus(u: AdminUser, action: 'suspend' | 'unsuspend') {
    if (action === 'suspend' && !(await ui.confirm({ title: t('Tangguhkan {email}?', { email: u.email }), message: t('Pengguna ini langsung tidak bisa memakai aplikasi sampai diaktifkan lagi.'), confirm: t('Tangguhkan'), danger: true }))) return;
    try { await api.post(`/admin/users/${u.id}/${action}`); ui.toast(action === 'suspend' ? t('Pengguna ditangguhkan.') : t('Pengguna diaktifkan.'), { kind: 'ok' }); await loadUsers(); }
    catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
  }
  async function deleteVoices(u: AdminUser) {
    if (!(await ui.confirm({ title: t('Hapus clone suara {email}?', { email: u.email }), message: t('{n} suara clone akan dihapus dari ElevenLabs dan database.', { n: u.clones }), confirm: t('Hapus semua'), danger: true }))) return;
    try { const r = await api.del<{ deleted: number }>(`/admin/users/${u.id}/voices`); ui.toast(t('{n} suara dihapus.', { n: r?.deleted ?? 0 }), { kind: 'ok' }); await loadUsers(); }
    catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
  }
  function editQuota(u: AdminUser) {
    const inp = (k: keyof Limits) => h('input', { class: 'input', type: 'number', min: '0', step: '1', inputMode: 'numeric', value: u.quotaOverrides[k] != null ? String(u.quotaOverrides[k]) : '', placeholder: t('Bawaan') }) as HTMLInputElement;
    const llm = inp('llmReqPerDay'), tts = inp('ttsCharsPerDay'), cl = inp('maxClones'), vc = inp('vcSecPerDay');
    const hasVc = u.limits.vcSecPerDay != null;
    const stt = inp('sttSecPerDay'), hasStt = u.limits.sttSecPerDay != null;
    const save = ui.btn({ label: t('Simpan'), cls: 'primary' });
    const cancel = ui.btn({ label: t('Batal') });
    const m = ui.modal({ title: t('Kuota {name}', { name: u.name || u.email }), body: h('div', { class: 'stack', style: 'gap:14px' },
      h('p', { class: 'hint' }, t('Kosongkan untuk memakai nilai bawaan server. Berlaku harian (reset tengah malam UTC).')),
      field(t('Permintaan AI per hari'), llm, t('Sekarang: {n}', { n: fmtNum(u.limits.llmReqPerDay) })),
      field(t('Karakter TTS per hari'), tts, t('Sekarang: {n}', { n: fmtNum(u.limits.ttsCharsPerDay) })),
      hasVc ? field(t('Voice Changer (detik audio) per hari'), vc, t('Sekarang: {n}', { n: fmtNum(u.limits.vcSecPerDay ?? 0) })) : null,
      hasStt ? field(t('Input suara / mic (detik) per hari'), stt, t('Sekarang: {n}', { n: fmtNum(u.limits.sttSecPerDay ?? 0) })) : null,
      field(t('Maksimal clone suara'), cl, t('Sekarang: {n}', { n: u.limits.maxClones }))), actions: [cancel, save] });
    cancel.onclick = () => m.close();
    save.onclick = async () => {
      const val = (i: HTMLInputElement) => (i.value.trim() === '' ? null : Math.max(0, Math.floor(Number(i.value))));
      const body: Record<string, number | null> = { llmReqPerDay: val(llm), ttsCharsPerDay: val(tts), maxClones: val(cl) };
      if (hasVc) body.vcSecPerDay = val(vc);
      if (hasStt) body.sttSecPerDay = val(stt);
      if (Object.values(body).some((v) => v != null && !Number.isFinite(v))) { ui.toast(t('Isi angka yang valid.'), { kind: 'warn' }); return; }
      save.disabled = true;
      try { await api.put(`/admin/users/${u.id}/quota`, body); m.close(); ui.toast(t('Kuota disimpan.'), { kind: 'ok' }); await loadUsers(); }
      catch (e: any) { ui.toast(e.message, { kind: 'bad' }); save.disabled = false; }
    };
  }
  /* ---------- messages: chat threads with testers (quota appeals) ----------
     Desktop: list and thread side by side. Phones: the list, then the thread with a back button. */
  interface Th { userId: number; email: string; name?: string; picture?: string | null; kind: string; open: boolean; awaiting: boolean; last: string; lastFromAdmin?: boolean; lastImage?: boolean; lastAt?: string; updatedAt: string }
  let threads: Th[] = [], sel: number | null = null, threadsLoaded = false, threadsFailed = false;
  let tv: ReturnType<typeof adminThread> | null = null, tvUser = 0;
  const thList = h('div', { class: 'am-list', role: 'list', 'aria-label': t('Percakapan') });
  const thCount = h('span', { class: 'badge accent', hidden: true });
  const paneHead = h('div', { class: 'am-th' });
  const paneBody = h('div', { class: 'am-tb' });
  const pane = h('div', { class: 'am-pane' }, paneHead, paneBody);
  const msgView = h('section', { class: 'card am' },
    h('div', { class: 'am-side' }, h('div', { class: 'am-sh' }, h('h2', null, t('Pesan dari penguji')), thCount), thList),
    pane);
  const thName = (x: Th) => x.name || x.email;
  const thPreview = (x: Th) => { const txt = x.last || (x.lastImage ? t('Foto') : ''); return x.lastFromAdmin ? t('Kamu: {text}', { text: txt }) : txt; };
  const kindLabel = (k: string) => (QUOTA_LABEL[k] ? t('Kuota {what}', { what: QUOTA_LABEL[k] }) : '');
  const shortTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    if (now.getTime() - d.getTime() < 6 * 864e5) return d.toLocaleDateString(locale(), { weekday: 'short' });
    return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  };
  const seg2Count = (n: number) => {
    const b = [...tabs.querySelectorAll('button')].at(-1); if (!b) return;
    let c = b.querySelector<HTMLElement>('.seg-count');
    if (!c) { c = h('span', { class: 'seg-count', 'aria-hidden': 'true' }); b.append(c); }
    c.hidden = !n; c.textContent = String(n);
    b.setAttribute('aria-label', n ? t('Pesan, {n} menunggu balasan', { n }) : t('Pesan'));
  };
  function paintList() {
    const waiting = threads.filter((t) => t.awaiting).length;
    thCount.hidden = !waiting; thCount.textContent = t('{n} menunggu', { n: waiting });
    seg2Count(waiting);
    if (!threadsLoaded) { thList.replaceChildren(...(threadsFailed ? [h('div', { class: 'notice bad', style: 'margin:12px', html: S('alert') }, h('span', null, t('Daftar pesan belum bisa dimuat.')))] : [0, 1, 2].map(() => h('div', { class: 'am-skel' }, h('span', { class: 'skel', style: 'width:36px;height:36px;border-radius:50%' }), h('span', { class: 'skel', style: 'flex:1;height:30px' }))))); return; }
    if (!threads.length) { thList.replaceChildren(h('div', { class: 'empty' }, h('div', { class: 'empty-ic', html: S('message') }), h('h3', null, t('Belum ada pesan')), h('p', null, t('Penguji yang kehabisan kuota bisa minta tambahan, dan pesannya muncul di sini.')))); return; }
    const sorted = [...threads].sort((a, b) => Number(b.awaiting) - Number(a.awaiting) || Number(b.open) - Number(a.open) || String(b.lastAt || b.updatedAt).localeCompare(String(a.lastAt || a.updatedAt)));
    thList.replaceChildren(...sorted.map((x) => {
      const meta = [kindLabel(x.kind), x.open ? '' : t('Ditutup')].filter(Boolean).join(' · ');
      const b = h('button', { type: 'button', class: 'am-item' + (x.awaiting ? ' awaiting' : '') + (x.open ? '' : ' closed'), role: 'listitem', 'aria-current': sel === x.userId ? 'true' : null,
        'aria-label': [thName(x), x.awaiting ? t('menunggu balasan') : '', x.open ? '' : t('ditutup')].filter(Boolean).join(', ') + '. ' + thPreview(x) },
        avatar(thName(x), x.picture),
        h('span', { class: 'am-i-b' },
          h('span', { class: 'am-i-top' }, h('b', null, thName(x)), h('time', { dateTime: x.lastAt || '', title: x.lastAt ? fmtDate(x.lastAt) : '' }, shortTime(x.lastAt || x.updatedAt))),
          h('span', { class: 'am-i-prev' }, h('span', null, thPreview(x)), x.awaiting ? h('i', { class: 'am-dot', title: t('Menunggu balasan') }) : null),
          meta ? h('span', { class: 'am-i-meta' }, meta) : null));
      b.onclick = () => select(x.userId);
      return b;
    }));
  }
  function paintHead() {
    const th = threads.find((x) => x.userId === sel);
    if (!th) { paneHead.replaceChildren(); return; }
    const u = users.find((y) => y.id === th.userId);
    const usage = u ? `AI ${fmtNum(u.usageToday.llm)}/${fmtNum(u.limits.llmReqPerDay)} · TTS ${fmtNum(u.usageToday.tts)}/${fmtNum(u.limits.ttsCharsPerDay)}` : '';
    const sub = [th.name ? th.email : '', kindLabel(th.kind)].filter(Boolean).join(' · ');
    paneHead.replaceChildren(
      h('button', { type: 'button', class: 'btn ghost icon am-back', 'aria-label': t('Kembali ke daftar pesan'), html: S('arrowLeft'), onclick: () => select(null) }),
      avatar(thName(th), th.picture),
      h('div', { class: 'am-th-t' }, h('b', null, thName(th), th.open ? null : h('span', { class: 'badge', style: 'margin-left:8px;height:20px;font-size:11.5px' }, t('Ditutup'))),
        sub ? h('span', null, sub) : null, usage ? h('span', { class: 'am-usage' }, t('Hari ini: {usage}', { usage })) : null),
      h('div', { class: 'am-th-a' },
        ui.btn({ label: t('Atur kuota'), icon: 'gauge', cls: 'sm soft', onClick: () => { if (u) editQuota(u); else { tab = 'users'; tabs.setValue('users'); show(); ui.toast(t('Pilih penggunanya di daftar.'), { kind: 'warn' }); } } }),
        ui.btn({ label: th.open ? t('Tutup thread') : t('Buka lagi'), cls: 'sm ghost', title: th.open ? t('Tandai selesai') : t('Buka lagi'), onClick: async () => {
          try { await api.post('/admin/threads/' + th.userId + '/reply', { close: th.open }); th.open = !th.open; await loadThreads(); void tv?.refresh(); }
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
      } else paneBody.replaceChildren(h('div', { class: 'empty am-none' }, h('div', { class: 'empty-ic', html: S('message') }), h('h3', null, t('Pilih percakapan')), h('p', null, t('Pesan dari penguji muncul di daftar sebelah kiri.'))));
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
    h('div', { class: 'card-h', style: 'flex-wrap:wrap' }, h('h2', { style: 'flex:1 0 auto' }, t('Pengguna')), h('div', { style: 'flex:1 1 240px;max-width:340px;display:flex;gap:8px;align-items:center;margin-left:auto' }, userSearch, ui.btn({ icon: 'refresh', cls: 'ghost icon sm', title: t('Muat ulang'), onClick: () => loadUsers() }))),
    usersBody);

  /* ---------- voice slots (public Voice Library) ---------- */
  interface Slots { used: number; accountSlotsUsed: number; appAdded: number; limit: number; cap: number; reserve: number; tier: string; unreferenced: number; mapped: Array<{ sourceId: string; name: string; refs: number; created: boolean; addedAt: string }> }
  const slotBody = h('div', { class: 'card-b stack', style: 'gap:12px' });
  slotBody.append(h('div', { class: 'skel', style: 'height:28px;width:60%' }), h('div', { class: 'skel', style: 'height:14px;width:90%' }));
  async function loadSlots() {
    try {
      const d = await api.get<Slots>('/admin/voice-slots');
      const clean = ui.btn({ label: d.unreferenced ? t('Bersihkan suara tak terpakai ({n})', { n: d.unreferenced }) : t('Bersihkan suara tak terpakai'), icon: 'trash', cls: 'soft sm', onClick: async () => {
        const ok = await ui.confirm({ title: t('Bersihkan slot?'), message: t('Suara Library yang tidak ada di koleksi siapa pun dihapus dari akun ElevenLabs. Clone dan suara bawaan tidak disentuh.'), confirm: t('Bersihkan') });
        if (!ok) return;
        clean.disabled = true;
        try { const r = await api.post<{ removed: number; failed: number }>('/admin/voice-slots/cleanup'); ui.toast(r.failed ? t('{removed} suara dihapus dari akun, {failed} gagal.', { removed: r.removed, failed: r.failed }) : t('{removed} suara dihapus dari akun.', { removed: r.removed }), { kind: r.failed ? 'warn' : 'ok' }); }
        catch (e: any) { ui.toast(e.message, { kind: 'bad' }); }
        loadSlots();
      } });
      clean.disabled = !d.unreferenced;
      slotBody.replaceChildren(
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
          h('span', { class: 'badge' + (d.used >= d.cap ? ' warn' : '') }, t('Terpakai {used} / batas {cap}', { used: d.used, cap: d.cap })),
          h('span', { class: 'badge outline' }, t('Akun: {used} / {limit} ({tier})', { used: d.accountSlotsUsed, limit: d.limit, tier: d.tier || '-' })),
          h('span', { class: 'badge outline' }, t('Dari Library: {n}', { n: d.appAdded }))),
        h('p', { class: 'hint', style: 'margin:0' }, t('Suara Library yang ditambahkan pengguna dipasang sekali di akun dan dipakai bersama. Batas = MAX_ACCOUNT_VOICE_SLOTS_USED atau batas akun dikurangi cadangan {reserve}.', { reserve: d.reserve })),
        d.mapped.length ? h('div', { class: 'hint', style: 'margin:0' }, d.mapped.slice(0, 30).map((m) => m.created ? t('{name} ({refs} pengguna)', { name: m.name.split(' - ')[0], refs: m.refs }) : t('{name} ({refs} pengguna, sudah ada di akun)', { name: m.name.split(' - ')[0], refs: m.refs })).join(' · ')) : '',
        h('div', null, clean));
    } catch (e: any) { slotBody.replaceChildren(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, e.message))); }
  }
  const slotsView = h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('h2', null, t('Slot suara'))), slotBody);

  /* ---------- page ---------- */
  const holder = h('div', { class: 'stack adm-holder', style: 'gap:16px' });
  const tabs = seg<'invites' | 'users' | 'messages'>([['invites', t('Kode undangan'), 'ticket'], ['users', t('Pengguna'), 'users'], ['messages', t('Pesan'), 'message']], tab, (v) => { tab = v; show(); history.replaceState(null, '', `#/admin?tab=${v}`); }, t('Bagian admin'));
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
