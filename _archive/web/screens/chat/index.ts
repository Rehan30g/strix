/* Roleplay chat (port of old index.html / app.js): characters, rename nick, model selector, accent, audio tags,
   auto-speak, voice picker, custom character, end_interview verdict, streaming reply with sentence-chunked TTS. */
import type { ScreenCtx } from '../../ctx';
import type { Character } from '../../api';
import { h, renderTagged, onDisconnect } from '../../ui/dom';
import { field, switchRow, voiceSelect, previewButton, modelInput, accentInput } from '../../ui/controls';
import { charIcon, cleanName, customChar, displayName, streamChat, activeVoice, ttsText, type ChatMsg, type CustomChar, type Verdict } from '../../lib/roleplay';

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { icons, settings, player, ui } = ctx;
  const S = icons.svg;
  let chars: Character[] = [];
  let cur: Character | null = null, custom: CustomChar | null = null;
  let history: ChatMsg[] = [];
  let busy = false, ended = false, chatCtrl: AbortController | null = null;
  let rec: ReturnType<typeof ctx.speech.listen> = null;

  /* ---------- layout ---------- */
  const list = h('div', { class: 'rp-list', role: 'list' });
  const side = h('aside', { class: 'rp-side', 'aria-label': 'Karakter' },
    h('div', { class: 'rp-side-h' }, 'Karakter'), list,
    h('button', { class: 'rp-char custom', type: 'button', onclick: () => openCustom() },
      h('span', { class: 'avatar', html: S('sparkle') }), h('span', { class: 'rp-char-t' }, h('b', null, 'Karakter custom'), h('span', null, 'Tulis prompt sendiri'))));

  const headAv = h('span', { class: 'avatar lg' });
  const headName = h('div', { class: 'rp-head-name' });
  const headSub = h('div', { class: 'rp-head-sub' });
  const statePill = h('span', { class: 'badge', 'aria-live': 'polite' });
  const btnReset = ui.btn({ icon: 'refresh', cls: 'ghost icon', title: 'Mulai ulang percakapan', onClick: () => cur && start(cur, custom) });
  const btnChars = ui.btn({ icon: 'users', cls: 'ghost icon rp-only-mobile', title: 'Pilih karakter', onClick: () => openCharDrawer() });
  const head = h('div', { class: 'rp-head' }, headAv, h('div', { class: 'rp-head-t' }, headName, headSub), statePill, btnChars, btnReset);

  const log = h('div', { class: 'rp-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Percakapan' });
  const scroller = h('div', { class: 'rp-scroll' }, log);
  const ta = h('textarea', { class: 'rp-input', rows: 1, placeholder: 'Pilih karakter dulu', disabled: true, 'aria-label': 'Pesan' }) as HTMLTextAreaElement;
  const btnMic = h('button', { class: 'rp-circle', type: 'button', title: 'Bicara (English)', 'aria-label': 'Bicara', html: S('mic'), disabled: true });
  const btnSend = h('button', { class: 'rp-send', type: 'submit', title: 'Kirim', 'aria-label': 'Kirim', html: S('arrowUp'), disabled: true });
  const form = h('form', { class: 'rp-composer' }, btnMic, ta, btnSend);
  const hint = h('div', { class: 'rp-hint' }, 'Enter kirim · Shift+Enter baris baru');
  const main = h('section', { class: 'rp-main' }, head, scroller, h('div', { class: 'rp-compose-wrap' }, form, hint));
  root.append(h('div', { class: 'rp' }, side, main));

  ctx.shell.setActions([ui.btn({ icon: 'sliders', label: 'Opsi', cls: 'sm', onClick: () => openOptions() })]);

  /* ---------- rendering ---------- */
  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };
  function paintHead() {
    if (!cur) {
      headAv.innerHTML = S('chat'); headName.textContent = 'Pilih karakter'; headSub.textContent = 'Mulai roleplay dalam bahasa Inggris';
      btnReset.disabled = true; return;
    }
    headAv.innerHTML = S(charIcon(cur));
    headName.textContent = displayName(cur);
    headSub.textContent = cur.id ? cur.role || '' : 'Karakter custom';
    btnReset.disabled = false;
  }
  function paintState() {
    const listening = !!rec;
    statePill.className = 'badge ' + (listening ? 'bad' : busy ? 'accent' : player.pending ? 'ok' : '');
    statePill.innerHTML = listening ? S('mic') + 'Mendengarkan' : busy ? S('sparkle') + 'Mengetik' : player.pending ? S('speaker') + 'Berbicara' : ended ? S('flag') + 'Selesai' : S('checkCircle') + 'Siap';
    statePill.hidden = !cur;
    btnMic.classList.toggle('rec', listening);
    btnMic.setAttribute('aria-pressed', String(listening));
    const stop = (busy || player.pending > 0) && !(ta.value.trim() && !busy);
    btnSend.innerHTML = S(stop ? 'stop' : 'arrowUp');
    btnSend.classList.toggle('stop', stop);
    btnSend.title = stop ? 'Hentikan' : 'Kirim'; btnSend.setAttribute('aria-label', btnSend.title);
    btnSend.disabled = !cur || ended || (!stop && !ta.value.trim());
  }
  function paintList() {
    list.replaceChildren(...chars.map((c) => {
      const b = h('button', { class: 'rp-char', type: 'button', role: 'listitem', 'aria-current': cur && !custom && cur.id === c.id ? 'true' : null, onclick: () => { start(c); closeDrawer?.(); } },
        h('span', { class: 'avatar', html: S(charIcon(c)) }),
        h('span', { class: 'rp-char-t' }, h('b', null, displayName(c)), h('span', null, c.role || '')));
      return b;
    }));
  }
  function emptyState() {
    log.replaceChildren(h('div', { class: 'rp-empty' },
      h('div', { class: 'empty-ic', html: S('chat') }),
      h('h2', null, 'Roleplay dengan karakter AI'),
      h('p', null, 'Pilih karakter, lalu ketik atau bicara dalam bahasa Inggris. Balasan dibacakan otomatis dengan suara ekspresif.'),
      h('div', { class: 'rp-pick' }, ...chars.map((c) => h('button', { type: 'button', class: 'rp-pick-card', onclick: () => start(c) },
        h('span', { class: 'avatar lg', html: S(charIcon(c)) }), h('b', null, displayName(c)), h('span', null, c.role || ''))),
        h('button', { type: 'button', class: 'rp-pick-card', onclick: () => openCustom() },
          h('span', { class: 'avatar lg', html: S('sparkle') }), h('b', null, 'Custom'), h('span', null, 'Prompt sendiri')))));
  }

  function aiRow(text: string, opts: { typing?: boolean } = {}) {
    const tx = h('div', { class: 'msg-text' });
    if (text) renderTagged(tx, text, { hideTags: !settings.prefs().showTags });
    const body = h('div', { class: 'msg-body' }, h('div', { class: 'msg-name' }, cur ? displayName(cur) : ''), tx);
    const typing = opts.typing ? h('div', { class: 'typing', 'aria-label': 'Mengetik' }, h('i'), h('i'), h('i')) : null;
    if (typing) body.append(typing);
    const row = h('div', { class: 'msg ai' }, h('span', { class: 'avatar', html: S(charIcon(cur)) }), body);
    log.append(row); scrollDown();
    return { row, body, tx, typing };
  }
  function addPlay(body: HTMLElement, getText: () => string) {
    const b = h('button', { class: 'msg-play', type: 'button', html: S('speaker') }, 'Putar');
    b.onclick = () => { player.stop(); speakText(getText()); };
    body.append(b);
  }
  function userRow(text: string) { log.append(h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, text))); scrollDown(); }
  function errRow(msg: string) { log.append(h('div', { class: 'msg-err', role: 'alert', html: S('alert') }, h('span', null, msg))); scrollDown(); }
  function verdictCard(v: Verdict) {
    const passed = v.decision === 'passed';
    const again = ui.btn({ label: 'Coba lagi', icon: 'refresh', cls: 'sm', onClick: () => cur && start(cur, custom) });
    log.append(h('div', { class: 'verdict ' + (passed ? 'passed' : 'rejected') },
      h('div', { class: 'verdict-h', html: S(passed ? 'checkCircle' : 'xCircle') }, h('h3', null, passed ? 'Lolos interview' : 'Ditolak')),
      v.reason ? h('p', null, h('b', null, 'Alasan: '), v.reason) : null,
      v.feedback ? h('p', null, h('b', null, 'Feedback: '), v.feedback) : null,
      again));
    scrollDown();
  }
  function lock(locked: boolean) {
    ta.disabled = btnMic.disabled = locked || !cur;
    if (!ctx.speech.hasSpeech()) btnMic.hidden = true;
    ta.placeholder = !cur ? 'Pilih karakter dulu' : locked ? 'Percakapan sudah selesai.' : (matchMedia('(max-width: 640px)').matches ? 'Ketik pesan (English)...' : 'Ketik, atau tekan mic untuk bicara (English)...');
  }

  /* ---------- speech ---------- */
  function speak(text: string) {
    const t = text.trim(); if (!t || !cur) return;
    player.speak(ttsText(t), { voiceId: activeVoice(cur, custom), who: cur.id || 'custom', model: settings.prefs().ttsModel || undefined });
  }
  function speakText(text: string) { player.stop(); speak(text); }

  /* ---------- flow ---------- */
  function start(c: Character, cust: CustomChar | null = null) {
    stopAll();
    cur = c; custom = cust; history = []; ended = false; busy = false;
    log.replaceChildren();
    paintHead(); paintList(); lock(false); paintState();
    const r = aiRow(c.greeting); addPlay(r.body, () => c.greeting);
    history.push({ role: 'assistant', content: c.greeting });
    if (settings.prefs().autoSpeak) speak(c.greeting);
    if (matchMedia('(min-width: 900px)').matches) ta.focus();
  }

  async function send(text: string) {
    text = text.trim();
    if (!text || busy || !cur || ended) return;
    player.stop();
    ta.value = ''; autosize();
    userRow(text);
    history.push({ role: 'user', content: text });
    busy = true; chatCtrl = new AbortController(); paintState();
    const r = aiRow('', { typing: true });
    const auto = settings.prefs().autoSpeak;
    const chunks = ctx.text.chunker((s) => auto && speak(s), 160, 40);
    let reply = '', verdict: Verdict | null = null, failed = false;
    try {
      const res = await streamChat({
        character: cur, custom, messages: history, signal: chatCtrl.signal,
        onText: (d, full) => { r.typing?.remove(); reply = full; renderTagged(r.tx, full, { hideTags: !settings.prefs().showTags }); scrollDown(); chunks.push(d); },
      });
      reply = res.reply; verdict = res.verdict;
    } catch (e: any) {
      failed = true;
      if (e?.code !== 'aborted') errRow(e?.message || String(e));
    }
    r.typing?.remove();
    if (!failed || reply) chunks.flush();
    if (reply) { history.push({ role: 'assistant', content: reply }); const full = reply; addPlay(r.body, () => full); }
    else { r.row.remove(); if (failed) history.pop(); }
    if (verdict) { ended = true; verdictCard(verdict); lock(true); }
    busy = false; chatCtrl = null; paintState();
    if (!ended && matchMedia('(min-width: 900px)').matches) ta.focus();
  }

  function stopAll() { chatCtrl?.abort(); player.stop(); rec?.abort(); rec = null; }

  /* ---------- composer ---------- */
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; }
  ta.addEventListener('input', () => { autosize(); paintState(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); } });
  form.onsubmit = (e) => {
    e.preventDefault();
    if (ta.value.trim() && !busy) return void send(ta.value);
    if (busy || player.pending) { chatCtrl?.abort(); player.stop(); }
  };
  btnMic.onclick = () => {
    if (!cur || ended) return;
    if (rec) { rec.stop(); return; }
    player.stop();
    rec = ctx.speech.listen({
      lang: settings.prefs().sttLang || 'en-US',
      onText: (t) => { ta.value = t; autosize(); },
      onEnd: (t) => { rec = null; paintState(); if (t && !busy) send(t); },
      onError: (_c, m) => ui.toast(m, { kind: 'warn' }),
    });
    paintState();
  };

  /* ---------- custom character / drawers ---------- */
  let closeDrawer: (() => void) | null = null;
  function openCharDrawer() {
    const body = h('div', { class: 'rp-list' });
    const d = ui.drawer({ title: 'Pilih karakter', body, onClose: () => { closeDrawer = null; } });
    closeDrawer = d.close;
    body.append(...chars.map((c) => h('button', { class: 'rp-char', type: 'button', 'aria-current': cur && !custom && cur.id === c.id ? 'true' : null, onclick: () => { start(c); d.close(); } },
      h('span', { class: 'avatar', html: S(charIcon(c)) }), h('span', { class: 'rp-char-t' }, h('b', null, displayName(c)), h('span', null, c.role || '')))),
    h('button', { class: 'rp-char custom', type: 'button', onclick: () => { d.close(); openCustom(); } },
      h('span', { class: 'avatar', html: S('sparkle') }), h('span', { class: 'rp-char-t' }, h('b', null, 'Karakter custom'), h('span', null, 'Tulis prompt sendiri'))));
  }
  function openCustom() {
    const saved = settings.get<CustomChar>('chat.custom', { prompt: '', voiceId: '' });
    const prompt = h('textarea', { class: 'textarea', rows: 6, placeholder: 'You are a pirate captain who...', value: saved.prompt || '' }) as HTMLTextAreaElement;
    const voice = voiceSelect({ value: saved.voiceId || '', onChange: () => {}, emptyLabel: 'Suara bawaan (Rachel)' });
    const go = ui.btn({ label: 'Mulai', icon: 'arrowRight', cls: 'primary' });
    const cancel = ui.btn({ label: 'Batal' });
    const m = ui.modal({ title: 'Karakter custom', wide: true, body: h('div', { class: 'stack' },
      field('Prompt karakter', prompt, 'Jelaskan siapa karakternya, sifat, dan situasinya (bahasa Inggris paling bagus).'),
      field('Suara', voice)), actions: [cancel, go] });
    cancel.onclick = () => m.close();
    go.onclick = () => {
      const p = prompt.value.trim();
      if (!p) { prompt.focus(); return; }
      const cc: CustomChar = { prompt: p, voiceId: voice.value || undefined };
      settings.set('chat.custom', cc);
      m.close(); start(customChar(cc), cc);
    };
  }
  function openOptions() {
    const p = settings.prefs();
    const nameInput = h('input', { class: 'input', value: cur?.nick ? settings.prefs().names?.[cur.id] || '' : '', placeholder: cur?.nick || (cur ? 'Tidak tersedia untuk karakter custom' : 'Pilih karakter dulu'), disabled: !cur?.nick, maxLength: 30 }) as HTMLInputElement;
    nameInput.oninput = () => {
      if (!cur?.nick) return;
      settings.setPrefs({ names: { ...settings.prefs().names, [cur.id]: cleanName(nameInput.value) } });
      paintHead(); paintList();
    };
    const vs = voiceSelect({ value: p.voiceId, onChange: (v) => settings.setPrefs({ voiceId: v }), emptyLabel: 'Bawaan karakter' });
    const body = h('div', { class: 'stack', style: 'gap:18px' },
      field('Nama karakter', nameInput, 'Kosong = nama bawaan. Disimpan per karakter.'),
      field('Suara', h('div', { class: 'row' }, h('div', { class: 'grow' }, vs), previewButton(() => vs.value, () => activeVoice(cur, custom)))),
      field('Aksen', accentInput({ value: p.accent, onChange: (v) => settings.setPrefs({ accent: v }) }), 'Ditambahkan sebagai tag [strong X accent] per kalimat; tidak tampil di chat.'),
      field('Model chat (OpenRouter)', modelInput({ value: p.model, onChange: (v) => settings.setPrefs({ model: v }) }), 'Kosong = model bawaan server.'),
      h('div', { class: 'stack', style: 'gap:6px' },
        switchRow('Thinking / reasoning', p.thinking, (v) => settings.setPrefs({ thinking: v }), 'Lebih lambat.'),
        switchRow('Suara otomatis', p.autoSpeak, (v) => settings.setPrefs({ autoSpeak: v }), 'Bacakan balasan begitu muncul.'),
        switchRow('Audio tags', p.audioTags, (v) => settings.setPrefs({ audioTags: v }), '[laughs], [whispers] … membuat suara lebih ekspresif.'),
        switchRow('Tampilkan audio tag di layar', p.showTags, (v) => settings.setPrefs({ showTags: v }))),
      h('a', { href: '#/settings', class: 'hint', style: 'display:flex;gap:6px;align-items:center', html: S('sliders') }, 'Tuning suara (stability, speed …) ada di Pengaturan'));
    ui.drawer({ title: 'Opsi roleplay', body });
  }

  /* ---------- boot ---------- */
  paintHead(); lock(false); paintState(); emptyState();
  onDisconnect(statePill, player.on('change', paintState));
  ctx.data.characters().then((l) => { chars = l; paintList(); if (!cur) emptyState(); })
    .catch((e) => { list.replaceChildren(h('div', { class: 'hint', style: 'padding:8px 12px' }, e.message)); errRow(`Gagal memuat karakter: ${e.message}`); });
  ctx.data.voices().catch(() => {});

  return () => { stopAll(); closeDrawer?.(); };
}
