/* Coffee agent simulation (main screen). Port of the old coffee.html + coffee-voice.js + coffee-phone.js/css +
   coffee-settings.js, split into modules:
     sim.ts (wallet/invoices/scam/bug), agent.ts (agent loop + tools + seller AI + call_number), voice.ts (speech layer),
     prompts.ts (voice/persona prompt layers), contacts.ts (call_number parties), human.ts (Jadi Coffee tags-only voicer),
     render.ts (HTML), phone.ts (Phone + Preview mode), settingsUi.ts (settings drawer).
   Contract: mount(root, ctx) => cleanup. */
import type { ScreenCtx } from '../../ctx';
import './coffee.css';
import type { Contact, Session } from './types';
import { STOP } from './types';
import { FORM_DEFAULTS, HC_COMBOS, HC_CONTACT_TEMPLATES, HC_TEMPLATES, REFUND_TXT, SCAM_TXT, GLITCH_TXT, WALLET_TXT, type CoffeeForm } from './defaults';
import { createRev, createVoice, type CvSettings } from './voice';
import { PERSONAS, agentSuffix, sellerSuffix, type PromptCfg } from './prompts';
import { VOICE, presetContacts, resolveContact } from './contacts';
import { createAgent, answerFor, type Runtime } from './agent';
import { createInvoice, log, newSession, refund, shopOf } from './sim';
import { emptyHtml, panelHtml, threadHtml, type RenderEnv } from './render';
import { createPhone, type CallView, type PhoneCfg } from './phone';
import { openSettings } from './settingsUi';
import { esc, liveSafe, parseArgs, rp, typedTokens } from './util';
import { addTagsOnly, applyTags, removeInsertedTags, trimOnly } from './human';

const CV_DEFAULTS: CvSettings = {
  on: true, tags: true, hands: false, readCoffee: true, userSpeech: 'always', player: 'stream', agentPreset: '', coffeePreset: '',
  superExpr: false, free: false, fxOn: true, fxLevel: 'medium', readAsk: true, fast: true, showTags: false,
  agentName: PERSONAS.sam.name, agentAccent: PERSONAS.sam.accent, agentTrait: PERSONAS.sam.trait,
  coffeeAccent: PERSONAS.barista.accent, coffeeTrait: PERSONAS.barista.trait, agentVoice: VOICE.agent, coffeeVoice: VOICE.coffee,
};
const PHONE_DEFAULTS: PhoneCfg = { on: true, wp: 0, preview: false };
const STATUS_DOT: Record<string, string> = { running: 'accent', waiting_user: 'warn', finished: 'ok', error: 'bad', max_turns: 'warn', stopped: 'warn', idle: '' };
const STATUS_TXT_SHORT: Record<string, string> = { idle: 'menunggu user', running: 'berjalan', waiting_user: 'menunggu jawaban', finished: 'selesai', error: 'error', max_turns: 'kena batas turn', stopped: 'dihentikan' };

/* sessions live for the page lifetime (like the old page), so leaving and re-opening the screen keeps them */
const book: { sessions: Session[]; seq: number; selectedId: number | null } = { sessions: [], seq: 0, selectedId: null };

export function mount(root: HTMLElement, ctx: ScreenCtx): () => void {
  const { settings, player, ui } = ctx;
  const { h } = ui;
  const IC = ctx.icons.IC;
  settings.register('coffee.cv', CV_DEFAULTS);
  settings.register('coffee.form', {});
  settings.register('coffee.phone', PHONE_DEFAULTS);

  /* ---------- settings access ---------- */
  const cv = (): CvSettings => {
    const v = settings.get<CvSettings>('coffee.cv');
    if (!['always', 'mutecall', 'never'].includes(v.userSpeech)) v.userSpeech = 'always';
    if (!['stream', 'full', 'simple'].includes(v.player)) v.player = 'stream';
    return v;
  };
  const setCv = (p: Partial<CvSettings>) => { settings.patch<CvSettings>('coffee.cv', p); };
  let urlScam = ctx.route.params.get('scenario') === 'scam';
  const form = (): CoffeeForm => {
    const m = { ...FORM_DEFAULTS, ...(settings.get<Partial<CoffeeForm>>('coffee.form') || {}) } as CoffeeForm;
    if (urlScam) m.scenario = 'scam';
    return m;
  };
  const setForm = <K extends keyof CoffeeForm>(k: K, v: CoffeeForm[K]) => {
    if (k === 'scenario') urlScam = false;
    const next: Record<string, unknown> = { ...(settings.get<Record<string, unknown>>('coffee.form') || {}) };
    if (JSON.stringify(v) === JSON.stringify(FORM_DEFAULTS[k])) delete next[k]; else next[k] = v;   // store only what differs from the defaults
    settings.set('coffee.form', next);
  };
  const phoneCfg = (): PhoneCfg => settings.get<PhoneCfg>('coffee.phone');
  const lang = () => (settings.prefs().lang === 'id' ? 'id' : 'en') as 'en' | 'id';
  const promptCfg = (): PromptCfg => { const s = cv(); return { lang: lang(), tags: s.tags, superExpr: s.superExpr, free: s.free, agentName: s.agentName, agentAccent: s.agentAccent, agentTrait: s.agentTrait, coffeeAccent: s.coffeeAccent, coffeeTrait: s.coffeeTrait }; };
  let defModel = 'deepseek/deepseek-v4.1-flash';
  ctx.data.config().then((c) => { if (c?.defaultModel) { defModel = c.defaultModel; renderTop(); } }).catch(() => {});
  const agentModel = () => form().model.trim() || settings.prefs().model || defModel;

  /* ---------- state ---------- */
  const rt: Runtime = { running: false, stopFlag: false, ctrl: null };
  const rev = createRev();
  let follow = true, panelTab = 'wallet';
  let lastHumanTurn: unknown = null;
  let panelOpen = root.getBoundingClientRect().width > 1500;
  const cur = () => book.sessions.find((s) => s.id === book.selectedId);
  const contacts = (s?: Session | null): Contact[] => [...presetContacts(form()), ...Object.values(s?.adhoc || {})];
  const contactOf = (s: Session, id: string | null | undefined): Contact | null => {
    if (!id) return null;
    const list = contacts(s);
    return list.find((c) => c.id === id) || resolveContact(id, list);
  };

  /* ---------- layout ---------- */
  const thread = h('div', { class: 'cf-threadbox' });
  const chat = h('div', { class: 'cf-chat' }, thread);
  const input = h('textarea', { class: 'cf-input', rows: 1, placeholder: 'Minta agent memesan kopi...', 'aria-label': 'Pesan' }) as HTMLTextAreaElement;
  const btnMic = h('button', { class: 'cf-send cf-mic', type: 'button', title: 'Bicara', 'aria-label': 'Bicara', html: IC.mic });
  const btnSend = h('button', { class: 'cf-send', type: 'button', title: 'Kirim', 'aria-label': 'Kirim', html: IC.arrowUp });
  const composer = h('div', { class: 'cf-composer' }, btnMic, input, btnSend);
  const hint = h('div', { class: 'cf-hint' });
  const composerWrap = h('div', { class: 'cf-composer-wrap' }, composer, hint);

  const pill = (icon: string, label: string, title: string, onClick: () => void) => {
    const b = h('button', { class: 'cf-pill', type: 'button', title }) as HTMLButtonElement;
    b.innerHTML = IC[icon] + `<span>${esc(label)}</span>`; b.onclick = onClick; return b;
  };
  const pHuman = pill('cup', 'Jadi Coffee', 'Jadi Coffee: kamu yang menjawab telepon agent (berlaku untuk sesi baru)', () => { setForm('humanCoffee', !form().humanCoffee); paintPills(); });
  const pFree = pill('sparkle', 'Free', '', () => { setCv({ free: !cv().free }); paintPills(); });
  const pSuper = pill('flame', 'Super', '', () => { setCv({ superExpr: !cv().superExpr }); paintPills(); });
  const pHands = pill('headset', 'Ngobrol', 'Dengarkan otomatis setelah agent selesai bicara / bertanya', () => { setCv({ hands: !cv().hands }); paintPills(); if (cv().hands) kick(); else stopListening(); });
  const pState = pill('speaker', 'Siap', 'Klik untuk nyalakan/matikan suara', () => toggleVoice());
  const pPreview = pill('eye', 'Preview', 'Preview Mode (Alt+P). Keluar: Esc atau tombol X di pojok kanan atas', () => { savePhone({ preview: true }); phone.apply(); });
  const pPhone = pill('smartphone', 'Phone', 'Tampilan telepon', () => { savePhone({ on: !phoneCfg().on }); phone.apply(); });
  const pModel = h('button', { class: 'cf-pill cf-pill-model', type: 'button', title: 'Ganti model' }) as HTMLButtonElement;
  pModel.onclick = () => showSettings('model');
  const pWallet = h('button', { class: 'cf-pill cf-pill-wallet', type: 'button' }) as HTMLButtonElement;
  pWallet.onclick = () => { panelOpen = !panelOpen; renderPanel(); };
  const bar = h('div', { class: 'cf-bar', role: 'toolbar', 'aria-label': 'Mode Coffee' }, pHuman, pFree, pSuper, pHands, pState, pPreview, pPhone, pModel, pWallet);

  const main = h('section', { class: 'cf-main' }, bar, chat, composerWrap);

  const runlist = h('div', { class: 'cf-runlist' });
  const linkOther = h('a', { class: 'cf-sidelink' });
  const side = h('aside', { class: 'cf-side', 'aria-label': 'Riwayat sesi' },
    h('div', { class: 'cf-side-top' },
      h('div', { class: 'cf-brand' }, h('span', { class: 'cf-logo', html: IC.cup }), h('span', { class: 'cf-brand-name' }, 'Coffee Order Agent')),
      ui.btn({ label: 'Sesi baru', icon: 'plus', cls: 'block', onClick: () => newChat() })),
    h('div', { class: 'cf-side-label' }, 'Riwayat sesi'), runlist,
    h('div', { class: 'cf-side-bottom' }, linkOther,
      h('button', { class: 'cf-sidelink', type: 'button', onClick: () => downloadJsonl(), html: IC.download + '<span>Unduh log JSONL</span>' }),
      h('button', { class: 'cf-sidelink', type: 'button', onClick: () => showSettings(), html: IC.gear + '<span>Pengaturan</span>' })));
  const backdrop = h('div', { class: 'cf-backdrop', onClick: () => closeSide() });

  const tabs = h('div', { class: 'cf-tabs', role: 'tablist' });
  for (const [k, l] of [['wallet', 'Dompet & struk'], ['seller', 'Sisi Coffee & kontak'], ['menu', 'Menu & stok']]) {
    const b = h('button', { class: 'cf-tab', type: 'button', role: 'tab', dataset: { tab: k } }, l);
    b.onclick = () => { panelTab = k; renderPanel(); };
    tabs.append(b);
  }
  const panelBody = h('div', { class: 'cf-panel-body' });
  const panel = h('aside', { class: 'cf-panel', 'aria-label': 'Detail sesi' },
    h('div', { class: 'cf-panel-h' }, h('span', null, 'Detail sesi'), ui.btn({ icon: 'x', cls: 'ghost icon sm', title: 'Tutup', onClick: () => { panelOpen = false; renderPanel(); } })),
    tabs, panelBody);

  const pvTools = h('div', { class: 'cf-pv-tools' },
    h('button', { type: 'button', title: 'Sesi baru', 'aria-label': 'Sesi baru', html: IC.plus, onClick: () => newChat() }),
    h('button', { type: 'button', title: 'Pengaturan', 'aria-label': 'Pengaturan', html: IC.gear, onClick: () => showSettings() }),
    h('button', { type: 'button', title: 'Keluar Preview Mode (Esc)', 'aria-label': 'Keluar Preview Mode', html: IC.x, onClick: () => { savePhone({ preview: false }); phone.apply(); } }));

  const app = h('div', { class: 'cf' }, side, backdrop, main, panel, pvTools);
  root.append(h('div', { class: 'cf-root' }, app));

  ctx.shell.setActions([
    ui.btn({ icon: 'history', cls: 'sm ghost icon', title: 'Riwayat sesi', onClick: () => openSide() }),
    ui.btn({ icon: 'gear', cls: 'sm ghost icon', title: 'Pengaturan Coffee', onClick: () => showSettings() }),
  ]);

  /* ---------- voice + agent ---------- */
  const voice = createVoice({ ctx, st: cv, lang, callOpen: () => !!cur()?.callOpen, rev });
  const agent = createAgent({
    ctx, voice, rev, rt, st: cv, form, promptCfg,
    sellerSuffix: () => (cv().on ? sellerSuffix(promptCfg()) : ''),
    contacts: (s) => contacts(s), render, updateComposer, updateLive, ring: () => phone.ring(),
  });
  const savePhone = (p: Partial<PhoneCfg>) => settings.patch<PhoneCfg>('coffee.phone', p);
  const phone = createPhone({
    ctx, app, thread, chat, rev, cfg: phoneCfg, saveCfg: savePhone, follow: () => follow, voiceOn: () => cv().on,
    sessionKey: () => String(cur()?.id ?? 'none'), sessionMsgs: () => cur()?.messages.length || 0,
    onMic: () => micClick(), onVoice: () => toggleVoice(),
    onEnd: () => { if (rt.running) stopAll(); else { player.stop(); rev.doneAll(); } },
    onApply: () => { paintPills(); if (phoneCfg().preview) input.focus(); },
  });
  app.insertBefore(phone.el, main);
  main.insertBefore(phone.callbar, chat);

  /* ---------- render ---------- */
  const env = (): RenderEnv => ({ IC, showTags: cv().showTags, speaking: player.pending > 0, rev, contactOf, sellerSuffix: cv().on ? sellerSuffix(promptCfg()) : '', humanVoicer: !!cur()?.humanVoicer });
  function renderTop() {
    const s = cur();
    ctx.shell.setTitle(s ? `#${s.id} · ${s.title}` : (form().scenario === 'scam' ? 'Coffee Agent · Penjual penipu' : 'Coffee Agent'));
    pModel.textContent = s ? s.model : agentModel();
    pWallet.title = s ? `${s.scenario === 'scam' ? 'Penipu: ' + SCAM_TXT[s.scamTactic] : 'Bug: ' + (s.glitch.on ? GLITCH_TXT[s.glitch.mode] : 'mati')} · ${WALLET_TXT[s.walletSupport]} · instruksi pemulihan: ${s.recoverRule ? 'ya' : 'tidak'}` : 'Dompet, struk, sisi Coffee';
    pWallet.innerHTML = IC.card + '<span>' + esc((s ? rp(s.balance) : 'Dompet') + (s?.scenario === 'scam' ? ` · penipu: ${SCAM_TXT[s.scamTactic]}` : '')
      + (s?.glitch.on ? ` · bug ${s.glitch.mult}x` : '') + (s ? ` · refund ${REFUND_TXT[s.refundPolicy]}` : '')) + '</span>';
    pWallet.classList.toggle('cf-neg', !!s && s.balance < 0);
    pWallet.classList.toggle('cf-on', panelOpen);
    const scam = form().scenario === 'scam';
    app.querySelector<HTMLElement>('.cf-brand-name')!.textContent = scam ? 'Penjual Penipu' : 'Coffee Order Agent';
    linkOther.setAttribute('href', scam ? '#/coffee' : '#/coffee?scenario=scam');
    linkOther.innerHTML = IC.refresh + `<span>${scam ? 'Tes 2: Penjual jujur' : 'Tes 3: Penjual penipu'}</span>`;
  }
  function renderList() {
    if (!book.sessions.length) { runlist.innerHTML = '<div class="cf-note" style="padding:6px 10px">Belum ada sesi.</div>'; return; }
    runlist.innerHTML = book.sessions.slice().reverse().map((s) => `
      <button class="cf-runitem${s.id === book.selectedId ? ' cf-active' : ''}" data-sess="${s.id}">
        <span class="cf-t"><span class="dot ${STATUS_DOT[s.status] || ''}${s.status === 'running' || s.status === 'waiting_user' ? ' cf-pulse' : ''}"></span>#${s.id} · ${esc(s.title)}</span>
        <span class="cf-m">${esc(STATUS_TXT_SHORT[s.status])} · ${s.receipts.length} struk · ${s.turns} turn</span>
      </button>`).join('');
  }
  function renderThread() {
    const s = cur();
    thread.innerHTML = s ? threadHtml(env(), s) : emptyHtml();
    if (!s) chat.scrollTop = 0; else if (follow) chat.scrollTop = chat.scrollHeight;
    if (s?.humanTurn && s.humanTurn !== lastHumanTurn) {          // your turn: show the agent's line at the top of the card
      lastHumanTurn = s.humanTurn;
      const card = thread.querySelector<HTMLElement>('.cf-humanturn');
      if (card) { chat.scrollTop = Math.max(0, card.offsetTop - chat.offsetTop - 12); follow = false; }
    }
  }
  function renderPanel() {
    panel.classList.toggle('cf-open', panelOpen);
    pWallet.classList.toggle('cf-on', panelOpen);
    tabs.querySelectorAll<HTMLElement>('.cf-tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === panelTab)));
    if (!panelOpen) return;
    panelBody.innerHTML = panelHtml(env(), cur(), panelTab);
  }
  function callView(s: Session | undefined): CallView | null {
    if (!s) return null;
    const ended = ['finished', 'error', 'stopped', 'max_turns'].includes(s.status);
    let party = s.callWith;
    if (!party && s.callOpen) {                     // the phone opens before the tool runs: show who is being called
      const last = [...s.messages].reverse().find((m) => m.role === 'assistant');
      const tc = last?.tool_calls?.find((t) => t.function.name === 'talk_to_coffee' || t.function.name === 'call_number');
      party = tc ? (tc.function.name === 'talk_to_coffee' ? 'coffee' : String(parseArgs(tc).contact || '')) : (s.lastParty || 'coffee');
    }
    if (!party) party = s.lastParty || 'coffee';
    const c = party === 'coffee' ? null : contactOf(s, party);
    return { live: !!s.callOpen && !ended, connected: s.callConnected, ringing: s.ringing, t0: s.callT0, sessionId: s.id,
      name: party === 'coffee' ? shopOf(s) : c?.display || party, number: c ? c.number : '', icon: party === 'coffee' ? 'cup' : c?.icon || 'user' };
  }
  function render() {
    renderTop(); renderList(); renderThread(); renderPanel();
    const s = cur();
    phone.sync(callView(s));
    if (!s) phone.setIdleName(((/kasir di ([^,.\n]+)/i.exec(form().sellerPrompt) || [])[1] || 'Kedai Coffee').trim());
    input.style.height = ''; autosize();
  }
  /** Live agent line: the bubble appears from the first written word; words are revealed following the voice. */
  function updateLive(s: Session) {
    if (s !== cur() || !s.live) return;
    const sid = s.live.sid;
    const el = thread.querySelector<HTMLElement>(`.cf-ai-text[data-sid="${CSS.escape(sid)}"]`);
    const toks = typedTokens(liveSafe(s.live.content));
    if (!el) { if (toks.length) render(); return; }
    for (let i = el.querySelectorAll('.cf-w').length; i < toks.length; i++) {
      const span = document.createElement('span');
      span.className = 'cf-w' + (rev.done.has(sid) || toks[i].o < (rev.off[sid] ?? 0) ? ' cf-done' : '');
      span.dataset.o = String(toks[i].o); span.textContent = toks[i].t;
      el.append(span);
    }
  }

  /* ---------- pills / voice state ---------- */
  let listening: ReturnType<typeof ctx.speech.listen> = null;
  function paintPills() {
    const st = cv();
    const on = (b: HTMLElement, v: boolean) => b.classList.toggle('cf-on', v);
    on(pHuman, form().humanCoffee); on(pFree, st.free); on(pSuper, st.superExpr); on(pHands, st.hands);
    on(pPhone, phoneCfg().on); on(pPreview, phoneCfg().preview);
    pFree.title = `Free mode: ${st.free ? 'NYALA' : 'mati'}. Agent menuruti permintaan aneh apa adanya (simulasi, tidak ada yang nyata). Berlaku untuk sesi baru`;
    pSuper.title = `Super expressive: ${st.superExpr ? 'NYALA' : 'mati'} (banyak tag [ ], uhh tiap kalimat, pura-pura bego sebentar)`;
    const [ic, label] = !st.on ? ['speakerOff', 'Mati'] : listening ? ['mic', 'Dengar…'] : player.pending ? ['speaker', 'Bicara…'] : player.err ? ['alert', 'Error'] : ['speaker', 'Siap'];
    pState.innerHTML = IC[ic] + `<span>${label}</span>`;
    on(pState, !!listening || player.pending > 0);
    pState.title = player.err || 'Klik untuk nyalakan/matikan suara';
    btnMic.classList.toggle('cf-rec', !!listening);
  }
  function toggleVoice() { setCv({ on: !cv().on }); if (!cv().on) { player.stop(); stopListening(); rev.doneAll(); } paintPills(); }

  /* ---------- mic (Web Speech) & hands-free ---------- */
  const micLang = () => (lang() === 'id' ? 'id-ID' : 'en-US');
  const canListen = () => { const s = cur(); return ctx.speech.hasSpeech() && cv().on && !listening && player.pending === 0 && !!s && !(rt.running && !(s.pendingAsk || s.humanTurn)); };
  function startListening() {
    if (!ctx.speech.hasSpeech()) { ui.toast('Browser ini tidak mendukung speech recognition. Pakai Chrome atau Edge.', { kind: 'warn' }); return; }
    if (listening) return;
    player.stop();
    listening = ctx.speech.listen({
      lang: micLang(),
      onText: (t) => { input.value = t; autosize(); updateComposer(); },
      onEnd: (t) => {
        listening = null; paintPills();
        if (t) { input.value = t; send(); }
        else if (cv().hands && cur()?.pendingAsk) setTimeout(kick, 500);
      },
      onError: (code, msg) => { if (code === 'not-allowed' || code === 'service-not-allowed') setCv({ hands: false }); if (msg) ui.toast(msg, { kind: 'warn' }); },
    });
    paintPills();
  }
  function stopListening() { if (listening) { const r = listening; listening = null; r.abort(); } paintPills(); }
  function micClick() { if (listening) listening.stop(); else startListening(); }
  let kickT: ReturnType<typeof setTimeout> | undefined;
  function kick() {
    clearTimeout(kickT);
    kickT = setTimeout(() => {
      const s = cur();
      if (cv().hands && canListen() && s && (s.pendingAsk || s.humanTurn || (!rt.running && s.status === 'idle'))) startListening();
    }, 400);
  }
  const unPlayer = player.on('change', () => { paintPills(); if (player.pending === 0) kick(); });
  const unCv = settings.subscribe('coffee.cv', () => { paintPills(); });

  /* ---------- composer ---------- */
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 160) + 'px'; }
  function updateComposer() {
    const s = cur(), asking = !!s?.pendingAsk || !!s?.humanTurn, typed = !!input.value.trim();
    const isStop = rt.running && !typed;            // text = send as interjection; empty = Stop
    btnSend.classList.toggle('cf-stop', isStop);
    btnSend.innerHTML = isStop ? ctx.icons.svg('stop') : IC.arrowUp;
    btnSend.title = isStop ? 'Stop' : asking ? 'Kirim jawaban' : rt.running ? 'Sela agent (agent tetap lanjut)' : 'Kirim';
    btnSend.setAttribute('aria-label', btnSend.title);
    btnSend.disabled = rt.running && rt.stopFlag;
    composer.classList.toggle('cf-asking', asking);
    input.placeholder = s?.humanTurn ? `Balas telepon agent sebagai ${s.humanTurn.partyName}...` : asking ? 'Pilih opsi di atas, atau ketik jawaban sendiri...'
      : rt.running ? (s && s.status !== 'running' && s.status !== 'waiting_user' ? 'Sesi lain sedang berjalan...' : 'Agent sedang bekerja... ketik untuk menyela (agent tetap lanjut kecuali kamu suruh berhenti)')
        : s ? 'Balas agent...' : 'Minta agent memesan kopi...';
    hint.textContent = s?.humanTurn ? `Agent menunggu balasan ${s.humanTurn.partyName} (kamu).` : asking ? 'Agent menunggu jawaban Anda.'
      : 'Semua simulasi: penjual (Coffee) dan kontak telepon adalah AI lain, saldo, transaksi, dan panggilan tidak nyata.';
    kick();
  }
  function stopAll() {
    player.stop(); stopListening(); rev.doneAll();
    rt.stopFlag = true; rt.ctrl?.abort();
    book.sessions.forEach((x) => { x.pendingAsk?.resolve(STOP); x.humanTurn?.resolve(STOP); });
    updateComposer();
  }
  function send() {
    const text = input.value.trim();
    const s = cur();
    const clear = () => { input.value = ''; autosize(); };
    if (s?.pendingAsk) { if (!text) return; clear(); s.pendingAsk.resolve(answerFor(s.pendingAsk.options, text)); return; }   // free answer to ask_user
    if (s?.humanTurn) { if (!text) return; clear(); s.humanTurn.resolve(text); return; }                                  // reply as Coffee / the contact
    if (rt.running && text && s && s.status === 'running') { clear(); s.inbox.push(text); render(); updateComposer(); return; }   // interjection: queued for the next agent turn
    if (rt.running) { stopAll(); return; }
    if (!text) return;
    let sess = s;
    if (!sess) {
      const f = form();
      sess = newSession(++book.seq, text, f, { model: agentModel(), agentSuffix: cv().on ? agentSuffix(promptCfg()) : '', voiceOn: cv().on, scenario: f.scenario });
      book.sessions.push(sess);
    }
    book.selectedId = sess.id;
    sess.messages.push({ role: 'user', content: text });
    log(sess, 'user_message', { content: text });
    clear();
    agent.runLoop(sess);
  }
  btnSend.onclick = send;
  btnMic.onclick = () => micClick();
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { autosize(); updateComposer(); });

  /* ---------- "Jadi Coffee" card actions ---------- */
  function hcAction(el: HTMLElement) {
    const s = cur(), hT = s?.humanTurn; if (!s || !hT) return;
    const a = el.dataset.hc;
    const lastInv = () => hT.created.at(-1) || [...s.invoices].reverse().find((i) => i.status === 'unpaid');
    const fillInput = (t: string) => { input.value = t; autosize(); input.focus(); };
    if (a === 'qty') {
      const m = s.menu.find((x) => x.name === el.dataset.item); if (!m) return;
      const q = Math.max(0, Math.min(m.stock, (hT.draft[m.name] || 0) + Number(el.dataset.d)));
      if (q) hT.draft[m.name] = q; else delete hT.draft[m.name];
    } else if (a === 'combo') {
      hT.draft = {};
      for (const [n, q] of HC_COMBOS[Number(el.dataset.i)][1]) { const m = s.menu.find((x) => x.name === n); if (m && m.stock > 0) hT.draft[n] = Math.min(q, m.stock); }
    } else if (a === 'clear') hT.draft = {};
    else if (a === 'make') {
      const r = createInvoice(s, { items: Object.entries(hT.draft).map(([name, qty]) => ({ name, qty })) });
      if (r.error) hT.note = 'Gagal: ' + r.error;
      else {
        hT.created.push(r.invoice!); hT.draft = {}; hT.note = `Invoice ${r.invoice!.id} dibuat: ${rp(r.invoice!.total)}`;
        log(s, 'seller_tool', { name: 'create_invoice', human: true, invoice: r.invoice!.id });
        if (!input.value.trim()) { input.value = `Okay, invoice ${r.invoice!.id}, total ${rp(r.invoice!.total)}. You can pay now.`; autosize(); }
      }
    } else if (a === 'pay') hT.view = hT.view === 'pay' ? '' : 'pay';
    else if (a === 'refund') hT.note = refund(s, { transaction_id: el.dataset.trx, reason: 'refund manual oleh Coffee' });
    else if (a === 'tpl') {
      const list = hT.party === 'coffee' ? HC_TEMPLATES : HC_CONTACT_TEMPLATES;
      const t = list[Number(el.dataset.i)][1], inv = lastInv();
      fillInput(t === '@invoice' ? (inv ? `Okay, invoice ${inv.id}, total ${rp(inv.total)}. You can pay now.` : 'Let me make the invoice first.') : t);
    }
    render(); updateComposer();
  }

  /* ---------- events ---------- */
  thread.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const hc = t.closest<HTMLButtonElement>('[data-hc]');
    if (hc && !hc.disabled) { hcAction(hc); return; }
    const opt = t.closest<HTMLElement>('[data-answer]');
    if (opt) { cur()?.pendingAsk?.resolve({ index: Number(opt.dataset.answer) }); return; }
    const sg = t.closest<HTMLElement>('[data-sugg]');
    if (sg) { input.value = sg.dataset.sugg || ''; autosize(); updateComposer(); input.focus(); return; }
    const th = t.closest<HTMLElement>('.cf-tool-h');
    if (th && app.classList.contains('cf-phone-mode')) th.parentElement?.classList.toggle('cf-open');    // compact tool rows: click to expand
  });
  chat.addEventListener('scroll', () => { follow = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 60; });
  runlist.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-sess]'); if (!b) return;
    player.stop(); stopListening(); rev.doneAll();
    book.selectedId = Number(b.dataset.sess); follow = true; render(); updateComposer(); closeSide();
  });
  function newChat() { player.stop(); stopListening(); rev.doneAll(); book.selectedId = null; render(); updateComposer(); closeSide(); input.focus(); }
  function openSide() { side.classList.add('cf-open'); backdrop.classList.add('cf-open'); }
  function closeSide() { side.classList.remove('cf-open'); backdrop.classList.remove('cf-open'); }
  function downloadJsonl() {
    const lines = book.sessions.flatMap((s) => s.log.map((l) => JSON.stringify(l)));
    if (!lines.length) { ui.toast('Belum ada log.', { kind: 'info' }); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'application/x-ndjson' }));
    a.download = 'coffee-agent-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function showSettings(focus?: 'model') {
    closeSide();
    openSettings({ ctx, form, setForm, resetForm: () => { settings.set('coffee.form', {}); }, cv, setCv, scenarioFromUrl: urlScam,
      onChange: () => { paintPills(); render(); }, stopVoice: () => { player.stop(); stopListening(); rev.doneAll(); } }, focus);
  }

  /* dev/test hooks */
  if (import.meta.env.DEV) (window as any).__coffee = { book, cur, cv, form, rt, rev, applyTags, removeInsertedTags, addTagsOnly: (t: string) => addTagsOnly(ctx, agentModel(), t), trimOnly: (t: string) => trimOnly(ctx, agentModel(), t) };

  phone.apply();
  render(); updateComposer(); paintPills();

  return () => {
    rt.stopFlag = true; rt.ctrl?.abort();
    book.sessions.forEach((x) => { x.pendingAsk?.resolve(STOP); x.humanTurn?.resolve(STOP); });
    clearTimeout(kickT); stopListening(); player.stop();
    unPlayer(); unCv(); phone.destroy();
    ctx.shell.setChrome(true);
    if (import.meta.env.DEV) delete (window as any).__coffee;
  };
}
