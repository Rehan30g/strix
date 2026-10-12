/* Voice call (port of old voice.html / voice.js): session history, push-to-talk or hands-free mic (Web Speech),
   streaming reply + streamed TTS (one request per ~160-char chunk), tune sliders, test voice, stop/barge-in. */
import type { ScreenCtx } from '../../ctx';
import type { Character } from '../../api';
import { h, renderTagged, onDisconnect, relTime } from '../../ui/dom';
import { field, switchRow, voiceSelect, previewButton, modelInput, accentInput, tuneControls, sttSelect, seg } from '../../ui/controls';
import { charIcon, cleanName, customChar, displayName, streamChat, activeVoice, ttsText, type ChatMsg, type CustomChar, type Verdict } from '../../lib/roleplay';

interface Session { id: string; charId: string | null; custom: CustomChar | null; title: string; ts: number; history: ChatMsg[]; ended: Verdict | null }

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { icons, settings, player, ui } = ctx;
  const S = icons.svg;
  let chars: Character[] = [];
  let sessions: Session[] = settings.local.get<Session[]>('call.sessions', []);
  const saveSessions = () => settings.local.set('call.sessions', sessions.slice(0, 60));
  let cur: Session | null = null;
  let busy = false, chatCtrl: AbortController | null = null;
  let rec: ReturnType<typeof ctx.speech.listen> = null;
  let idleT: ReturnType<typeof setTimeout> | null = null;
  let raf = 0;

  const charOf = (s: Session | null): Character => (s?.charId ? chars.find((c) => c.id === s.charId) : null) || customChar(s?.custom);
  const nameOf = (s: Session | null) => displayName(charOf(s));

  /* ---------- layout ---------- */
  const runlist = h('div', { class: 'call-runs', role: 'list' });
  const btnNew = ui.btn({ label: 'Sesi baru', icon: 'plus', cls: 'block', onClick: () => showEmpty() });
  const btnClear = ui.btn({ label: 'Hapus semua', icon: 'trash', cls: 'ghost sm block', onClick: async () => {
    if (await ui.confirm({ title: 'Hapus semua sesi?', message: 'Riwayat percakapan di perangkat ini akan dihapus.', confirm: 'Hapus', danger: true })) { sessions = []; saveSessions(); showEmpty(); }
  } });
  const side = h('aside', { class: 'call-side', 'aria-label': 'Riwayat sesi' }, h('div', { class: 'call-side-top' }, btnNew), h('div', { class: 'rp-side-h' }, 'Riwayat'), runlist, h('div', { class: 'call-side-foot' }, btnClear));

  const orb = h('div', { class: 'orb', 'aria-hidden': 'true' }, h('span', { class: 'orb-ring r1' }), h('span', { class: 'orb-ring r2' }), h('span', { class: 'orb-core' }));
  const stName = h('div', { class: 'call-name' });
  const stStatus = h('div', { class: 'call-status', role: 'status', 'aria-live': 'polite' });
  const caption = h('div', { class: 'call-caption' });
  const stage = h('div', { class: 'call-stage' }, orb, stName, stStatus, caption);

  const thread = h('div', { class: 'rp-log call-thread', role: 'log', 'aria-label': 'Transkrip' });
  const scroller = h('div', { class: 'rp-scroll' }, thread);

  const btnHands = h('button', { class: 'call-ctl', type: 'button', 'aria-pressed': 'false', title: 'Mode ngobrol: mic terbuka otomatis setelah karakter selesai bicara' }, h('span', { class: 'call-ctl-ic', html: S('headset') }), h('span', null, 'Ngobrol'));
  const btnMic = h('button', { class: 'call-mic', type: 'button', 'aria-label': 'Bicara', html: S('mic') });
  const btnStop = h('button', { class: 'call-ctl', type: 'button' }, h('span', { class: 'call-ctl-ic', html: S('stop') }), h('span', null, 'Hentikan'));
  const ta = h('textarea', { class: 'rp-input', rows: 1, placeholder: 'Atau ketik pesan...', 'aria-label': 'Pesan' }) as HTMLTextAreaElement;
  const btnSend = h('button', { class: 'rp-send', type: 'submit', 'aria-label': 'Kirim', title: 'Kirim', html: S('arrowUp') });
  const form = h('form', { class: 'rp-composer slim' }, ta, btnSend);
  const controls = h('div', { class: 'call-controls' }, h('div', { class: 'call-buttons' }, btnHands, btnMic, btnStop), form);

  const main = h('section', { class: 'call-main' }, stage, scroller, controls);
  const empty = h('div', { class: 'call-empty' });
  root.append(h('div', { class: 'call' }, side, main, empty));

  ctx.shell.setActions([
    ui.btn({ icon: 'history', cls: 'sm ghost icon rp-only-mobile', title: 'Riwayat sesi', onClick: () => openHistory() }),
    ui.btn({ icon: 'sliders', label: 'Opsi', cls: 'sm', onClick: () => openOptions() }),
  ]);

  /* ---------- state rendering ---------- */
  type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'ended';
  const phase = (): Phase => (rec ? 'listening' : busy && !player.pending ? 'thinking' : player.pending ? 'speaking' : cur?.ended ? 'ended' : 'idle');
  function paintState() {
    const p = phase();
    orb.dataset.state = p;
    stStatus.textContent = { idle: settings.prefs().handsFree ? 'Siap, mendengarkan otomatis' : 'Siap. Tekan mic untuk bicara', listening: 'Mendengarkan...', thinking: 'Berpikir...', speaking: 'Berbicara...', ended: 'Sesi selesai' }[p];
    btnMic.classList.toggle('rec', p === 'listening');
    btnMic.setAttribute('aria-pressed', String(p === 'listening'));
    btnMic.title = p === 'listening' ? 'Selesai bicara' : 'Bicara';
    btnMic.disabled = !cur || !!cur.ended;
    btnStop.disabled = !(busy || player.pending || rec);
    const hf = settings.prefs().handsFree;
    btnHands.setAttribute('aria-pressed', String(hf)); btnHands.classList.toggle('on', hf);
    ta.disabled = !cur || !!cur.ended;
    btnSend.disabled = ta.disabled || !ta.value.trim() || busy;
    if (p === 'speaking' && !raf) animate();
  }
  function animate() {
    const core = orb.querySelector<HTMLElement>('.orb-core')!;
    const tick = () => {
      const lv = player.level();
      const amp = player.pending ? Math.max(lv.amp, 0.05) : 0;
      core.style.transform = `scale(${1 + amp * 0.35})`;
      orb.style.setProperty('--amp', String(amp));
      if (player.pending) raf = requestAnimationFrame(tick); else { raf = 0; core.style.transform = ''; }
    };
    raf = requestAnimationFrame(tick);
  }
  const scrollDown = () => { scroller.scrollTop = scroller.scrollHeight; };

  function renderList() {
    runlist.replaceChildren(...sessions.map((s) => {
      const c = charOf(s);
      const del = h('button', { class: 'run-del', type: 'button', 'aria-label': 'Hapus sesi', title: 'Hapus', html: S('x') });
      del.onclick = (e) => { e.stopPropagation(); sessions = sessions.filter((x) => x !== s); saveSessions(); if (s === cur) showEmpty(); else renderList(); };
      const item = h('div', { class: 'run', role: 'listitem', 'aria-current': s === cur ? 'true' : null },
        h('button', { class: 'run-open', type: 'button', onclick: () => { openSession(s); historyDrawer?.(); } },
          h('span', { class: 'dot ' + (s.ended ? (s.ended.decision === 'passed' ? 'ok' : 'bad') : s === cur ? 'accent' : '') }),
          h('span', { class: 'run-t' }, h('b', null, s.title || 'Sesi baru'), h('span', null, `${displayName(c)} · ${relTime(s.ts)}`))),
        del);
      return item;
    }));
    if (!sessions.length) runlist.append(h('div', { class: 'hint', style: 'padding:6px 12px' }, 'Belum ada sesi.'));
  }

  function aiRow(text: string, typing = false) {
    const tx = h('div', { class: 'msg-text' });
    if (text) renderTagged(tx, text, { hideTags: !settings.prefs().showTags });
    const body = h('div', { class: 'msg-body' }, h('div', { class: 'msg-name' }, nameOf(cur)), tx);
    const t = typing ? h('div', { class: 'typing' }, h('i'), h('i'), h('i')) : null;
    if (t) body.append(t);
    const row = h('div', { class: 'msg ai' }, h('span', { class: 'avatar', html: S(charIcon(charOf(cur))) }), body);
    thread.append(row); scrollDown();
    return { row, body, tx, typing: t };
  }
  function addReplay(body: HTMLElement, getText: () => string) {
    const b = h('button', { class: 'msg-play', type: 'button', html: S('speaker') }, 'Putar ulang');
    b.onclick = () => { player.stop(); speak(getText()); };
    body.append(b);
  }
  function userRow(text: string) { thread.append(h('div', { class: 'msg user' }, h('div', { class: 'bubble' }, text))); scrollDown(); }
  function errLine(msg: string) { thread.append(h('div', { class: 'msg-err', role: 'alert', html: S('alert') }, h('span', null, msg))); scrollDown(); }
  function verdictCard(v: Verdict) {
    const passed = v.decision === 'passed';
    thread.append(h('div', { class: 'verdict ' + (passed ? 'passed' : 'rejected') },
      h('div', { class: 'verdict-h', html: S(passed ? 'checkCircle' : 'xCircle') }, h('h3', null, passed ? 'Lolos interview' : 'Ditolak')),
      v.reason ? h('p', null, h('b', null, 'Alasan: '), v.reason) : null,
      v.feedback ? h('p', null, h('b', null, 'Feedback: '), v.feedback) : null,
      ui.btn({ label: 'Coba lagi', icon: 'refresh', cls: 'sm', onClick: () => cur && startSession(cur.charId, cur.custom) })));
    scrollDown();
  }
  function setCaption(text: string) { renderTagged(caption, text, { hideTags: true }); }

  /* ---------- sessions ---------- */
  function showMain(on: boolean) { main.hidden = !on; empty.hidden = on; }
  function showEmpty() {
    stopAll(); cur = null; busy = false;
    thread.replaceChildren();
    ctx.shell.setTitle('Panggilan suara');
    empty.replaceChildren(h('div', { class: 'rp-empty' },
      h('div', { class: 'empty-ic', html: S('headset') }),
      h('h2', null, 'Panggilan suara dengan karakter AI'),
      h('p', null, 'Pilih karakter lalu ngobrol dengan suara. Nyalakan "Mode ngobrol" supaya mic terbuka otomatis setelah karakter selesai bicara.'),
      h('div', { class: 'rp-pick' }, ...chars.map((c) => h('button', { type: 'button', class: 'rp-pick-card', onclick: () => startSession(c.id, null) },
        h('span', { class: 'avatar lg', html: S(charIcon(c)) }), h('b', null, displayName(c)), h('span', null, c.role || ''))),
        h('button', { type: 'button', class: 'rp-pick-card', onclick: () => openCustom() }, h('span', { class: 'avatar lg', html: S('sparkle') }), h('b', null, 'Custom'), h('span', null, 'Prompt sendiri'))),
      ctx.speech.hasSpeech() ? null : h('div', { class: 'notice warn', style: 'margin-top:18px;text-align:left', html: S('alert') }, h('span', null, 'Browser ini tidak mendukung pengenalan suara. Pakai Chrome atau Edge untuk bicara; mengetik tetap bisa.'))));
    showMain(false); renderList(); paintState();
  }
  function openSession(s: Session) {
    stopAll(); cur = s; busy = false;
    thread.replaceChildren();
    const c = charOf(s);
    stName.textContent = displayName(c);
    orb.querySelector('.orb-core')!.innerHTML = S(charIcon(c));
    ctx.shell.setTitle(displayName(c));
    for (const m of s.history) {
      if (m.role === 'user') userRow(m.content);
      else { const r = aiRow(m.content); addReplay(r.body, () => m.content); }
    }
    const last = [...s.history].reverse().find((m) => m.role === 'assistant');
    setCaption(last?.content || '');
    if (s.ended) verdictCard(s.ended);
    showMain(true); renderList(); paintState();
  }
  function startSession(charId: string | null, custom: CustomChar | null) {
    const c = charId ? chars.find((x) => x.id === charId) || null : null;
    const s: Session = { id: Date.now().toString(36), charId, custom, title: '', ts: Date.now(), history: [], ended: null };
    sessions.unshift(s); openSession(s);
    const greeting = (c || customChar(custom)).greeting;
    s.history.push({ role: 'assistant', content: greeting }); saveSessions();
    const r = aiRow(greeting); addReplay(r.body, () => greeting);
    setCaption(greeting);
    if (settings.prefs().autoSpeak) speak(greeting);
    renderList(); paintState(); checkIdle();
  }

  /* ---------- speech out ---------- */
  let speakGen = -1;
  function speak(text: string) {
    const t = text.trim(); if (!t || !cur) return;
    speakGen = player.generation;
    player.speak(ttsText(t), { voiceId: activeVoice(charOf(cur), cur.custom), who: cur.charId || 'custom', model: settings.prefs().ttsModel || undefined });
  }

  /* ---------- chat ---------- */
  async function send(text: string) {
    text = text.trim();
    if (!text || busy || !cur || cur.ended) return;
    player.stop();
    ta.value = ''; autosize();
    const s = cur;
    if (!s.title) s.title = text.slice(0, 40);
    s.history.push({ role: 'user', content: text }); s.ts = Date.now(); saveSessions();
    userRow(text); renderList();
    busy = true; chatCtrl = new AbortController(); paintState();
    const row = aiRow('', true);
    const auto = settings.prefs().autoSpeak;
    const chunks = ctx.text.chunker((x) => auto && speak(x), 160, 40);
    let reply = '', verdict: Verdict | null = null, failed = false;
    try {
      const r = await streamChat({ character: charOf(s), custom: s.custom, messages: s.history, signal: chatCtrl.signal,
        onText: (d, full) => { row.typing?.remove(); reply = full; renderTagged(row.tx, full, { hideTags: !settings.prefs().showTags }); setCaption(full); scrollDown(); chunks.push(d); } });
      reply = r.reply; verdict = r.verdict;
    } catch (e: any) { failed = true; if (e?.code !== 'aborted') errLine(e?.message || String(e)); }
    row.typing?.remove();
    if (!failed || reply) chunks.flush();
    if (reply) { s.history.push({ role: 'assistant', content: reply }); const full = reply; addReplay(row.body, () => full); }
    else { row.row.remove(); if (failed) s.history.pop(); }
    if (verdict) { s.ended = verdict; verdictCard(verdict); }
    saveSessions(); busy = false; chatCtrl = null; renderList(); paintState(); checkIdle();
  }

  /* ---------- mic ---------- */
  function startListening() {
    if (!ctx.speech.hasSpeech()) { ui.toast('Browser ini tidak mendukung pengenalan suara. Pakai Chrome atau Edge.', { kind: 'warn' }); settings.setPrefs({ handsFree: false }); paintState(); return; }
    if (rec || busy || !cur || cur.ended) return;
    player.stop();
    rec = ctx.speech.listen({
      lang: settings.prefs().sttLang || 'en-US',
      onText: (t) => { ta.value = t; autosize(); setCaption(t); },
      onEnd: (t) => {
        rec = null; paintState();
        if (t) send(t);
        else if (settings.prefs().handsFree && cur && !cur.ended) idleT = setTimeout(startListening, 400);
      },
      onError: (code, m) => {
        if (code === 'not-allowed' || code === 'service-not-allowed') { settings.setPrefs({ handsFree: false }); }
        ui.toast(m, { kind: 'warn' });
      },
    });
    paintState();
  }
  function stopListening() { rec?.abort(); rec = null; paintState(); }
  /** Hands-free: after the AI finished speaking, listen again. */
  function checkIdle() {
    if (idleT) clearTimeout(idleT);
    if (settings.prefs().handsFree && !busy && player.pending === 0 && !rec && cur && !cur.ended)
      idleT = setTimeout(() => { if (!busy && !player.pending) startListening(); }, 300);
  }
  function stopAll() { if (idleT) clearTimeout(idleT); chatCtrl?.abort(); player.stop(); stopListening(); }

  btnMic.onclick = () => { if (!cur) return; if (rec) rec.stop(); else startListening(); };
  btnStop.onclick = () => { chatCtrl?.abort(); player.stop(); stopListening(); };
  btnHands.onclick = () => {
    const on = !settings.prefs().handsFree; settings.setPrefs({ handsFree: on });
    if (on) checkIdle(); else stopListening();
    paintState();
  };
  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; }
  ta.addEventListener('input', () => { autosize(); paintState(); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); } });
  form.onsubmit = (e) => { e.preventDefault(); send(ta.value); };
  const onKey = (e: KeyboardEvent) => {
    // Space = push-to-talk toggle when focus is not in a text field
    if (e.code !== 'Space' || e.repeat || (e.target as HTMLElement).closest('input,textarea,select,button,[contenteditable]') || !cur || cur.ended) return;
    e.preventDefault(); btnMic.click();
  };
  addEventListener('keydown', onKey);

  /* ---------- drawers ---------- */
  let historyDrawer: (() => void) | null = null;
  function openHistory() {
    const body = h('div', { class: 'stack', style: 'gap:10px' }, ui.btn({ label: 'Sesi baru', icon: 'plus', cls: 'block', onClick: () => { d.close(); showEmpty(); } }), runlist);
    const d = ui.drawer({ title: 'Riwayat sesi', body, onClose: () => { historyDrawer = null; side.insertBefore(runlist, side.querySelector('.call-side-foot')); } });
    historyDrawer = d.close;
  }
  function openCustom() {
    const saved = settings.get<CustomChar>('chat.custom', { prompt: '', voiceId: '' });
    const prompt = h('textarea', { class: 'textarea', rows: 6, placeholder: 'You are a pirate captain who...', value: saved.prompt || '' }) as HTMLTextAreaElement;
    const voice = voiceSelect({ value: saved.voiceId || '', onChange: () => {}, emptyLabel: 'Suara bawaan (Rachel)' });
    const go = ui.btn({ label: 'Mulai sesi', icon: 'arrowRight', cls: 'primary' });
    const cancel = ui.btn({ label: 'Batal' });
    const m = ui.modal({ title: 'Karakter custom', wide: true, body: h('div', { class: 'stack' }, field('Prompt karakter', prompt), field('Suara', voice)), actions: [cancel, go] });
    cancel.onclick = () => m.close();
    go.onclick = () => {
      const p = prompt.value.trim(); if (!p) { prompt.focus(); return; }
      const cc: CustomChar = { prompt: p, voiceId: voice.value || undefined };
      settings.set('chat.custom', cc); m.close(); startSession(null, cc);
    };
  }
  function openOptions() {
    const p = settings.prefs();
    const c = cur ? charOf(cur) : null;
    const nameInput = h('input', { class: 'input', value: c?.nick ? p.names?.[c.id] || '' : '', placeholder: c?.nick || (cur ? 'Tidak tersedia untuk karakter custom' : 'Pilih karakter dulu'), disabled: !c?.nick, maxLength: 30 }) as HTMLInputElement;
    nameInput.oninput = () => {
      if (!c?.nick) return;
      settings.setPrefs({ names: { ...settings.prefs().names, [c.id]: cleanName(nameInput.value) } });
      stName.textContent = displayName(c); ctx.shell.setTitle(displayName(c)); renderList();
    };
    const vs = voiceSelect({ value: p.voiceId, onChange: (v) => settings.setPrefs({ voiceId: v }), emptyLabel: 'Bawaan karakter' });
    const testText = h('textarea', { class: 'textarea', rows: 3, value: '[whispering, tired] Okay... [sighing] I really thought it would work this time.' }) as HTMLTextAreaElement;
    const pages: Record<string, HTMLElement> = {
      voice: h('div', { class: 'stack', style: 'gap:16px' },
        field('Suara', h('div', { class: 'row' }, h('div', { class: 'grow' }, vs), previewButton(() => vs.value, () => activeVoice(c, cur?.custom)))),
        field('Aksen', accentInput({ value: p.accent, onChange: (v) => settings.setPrefs({ accent: v }) })),
        field('Bahasa yang kamu ucapkan (mic)', sttSelect(p.sttLang, (v) => settings.setPrefs({ sttLang: v }))),
        h('div', { class: 'stack', style: 'gap:4px' },
          switchRow('Suara otomatis', p.autoSpeak, (v) => settings.setPrefs({ autoSpeak: v })),
          switchRow('Audio tags', p.audioTags, (v) => settings.setPrefs({ audioTags: v }), '[sighing], [whispering] …'),
          switchRow('Tampilkan audio tag di layar', p.showTags, (v) => settings.setPrefs({ showTags: v }))),
        h('div', { class: 'section-title' }, 'Tes suara'),
        field('Teks', testText, 'Diputar dengan suara, aksen, dan tuning di bawah. Geser slider lalu putar lagi untuk membandingkan.'),
        h('div', null, ui.btn({ label: 'Putar', icon: 'play', cls: 'soft', onClick: () => { const t = testText.value.trim(); if (t) { player.stop(); player.speak(ttsText(t), { voiceId: vs.value || activeVoice(c, cur?.custom), who: 'test' }); } } })),
        h('div', { class: 'section-title' }, 'Tuning TTS'),
        tuneControls()),
      char: h('div', { class: 'stack', style: 'gap:16px' },
        field('Nama karakter (sesi aktif)', nameInput, 'Kosong = nama bawaan. Disimpan per karakter.'),
        h('div', null, ui.btn({ label: 'Karakter custom...', icon: 'sparkle', onClick: () => { dr.close(); openCustom(); } }))),
      model: h('div', { class: 'stack', style: 'gap:16px' },
        field('Model chat (OpenRouter)', modelInput({ value: p.model, onChange: (v) => settings.setPrefs({ model: v }) }), 'Kosong = model bawaan server.'),
        switchRow('Thinking / reasoning', p.thinking, (v) => settings.setPrefs({ thinking: v }), 'Lebih lambat.')),
    };
    const holder = h('div', { style: 'margin-top:18px' }, pages.voice);
    const tabs = seg<'voice' | 'char' | 'model'>([['voice', 'Suara'], ['char', 'Karakter'], ['model', 'Model']], 'voice', (v) => holder.replaceChildren(pages[v]), 'Bagian opsi', true);
    const dr = ui.drawer({ title: 'Opsi panggilan', body: h('div', null, tabs, holder) });
  }

  /* ---------- boot ---------- */
  onDisconnect(orb, player.on('change', () => { paintState(); if (player.pending === 0 && player.generation === speakGen) checkIdle(); }));
  onDisconnect(orb, player.on('error', (e: any) => errLine(e?.message || 'TTS gagal')));
  showEmpty();
  ctx.data.characters().then((l) => {
    chars = l;
    const want = ctx.route.params.get('session');
    const s = want ? sessions.find((x) => x.id === want) : null;
    if (s) openSession(s); else showEmpty();
  }).catch((e) => ui.toast(`Gagal memuat karakter: ${e.message}`, { kind: 'bad' }));
  ctx.data.voices().catch(() => {});

  return () => { stopAll(); cancelAnimationFrame(raf); removeEventListener('keydown', onKey); historyDrawer?.(); };
}
