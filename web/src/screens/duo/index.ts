/* Group call ("call over"): the user and up to three personas in ONE room, voice only. Not a phone UI: a neutral stage
   with the personas' orbs side by side; the one speaking grows and nudges its neighbours; captions coloured per speaker,
   revealed in sync with the real audio (lib/captions.ts). Same duplex machinery as Chat (lib/duplex.ts DuplexMachine):
   interrupt any time by voice (Mode Percakapan) or typing; the cut speaker knows where it stopped (`interrupted`).
   - Turns: POST /api/duo/turn picks the speaker (server director) and streams ONE persona line; {next} says whether
     another persona follows (requested at once, while the current line is still being spoken = low latency) or the user.
   - Audio strictly sequential (player.ts queue): never two voices at once.
   - Ringing: POST /api/duo/ring; synthesized ring tone; a persona ALREADY on the call reacts out loud while it rings
     (its voice and colour); the callee is silent until it answers (then greets via join) / declines / lets it ring
     (then the reacting persona says its `after` line). Personas can ring someone themselves ({call} -> ring).
   - Memory: per persona, reason 'duo' (or 'hangup' when it left), with the transcript it was there for.
   Route: #/duo?call=strix,lena (ring them) | #/duo?with=<id>&call=<id>[&caller=<id>] (from a solo Chat with <with>). */
import type { RouteInfo, ScreenCtx } from '../../ctx';
import type { Character } from '../../api';
import { h, onDisconnect } from '../../ui/dom';
import { orb, thinkingLevel, type OrbEl } from '../../ui/orb';
import { orbGhost, handOff, receiveOrb, hasHandOff, enter, reducedMotion } from '../../ui/transition';
import { haptic } from '../../ui/gesture';
import { Captions } from '../../lib/captions';
import { startStt, sttSupported, prewarmStt, type SttSession } from '../../lib/stt';
import { DuplexMachine, isEcho, splitAtWord, plain, words, fastDecide, type DEvent, type Effect, type ResumeHint } from '../../lib/duplex';
import { decide } from '../../lib/decide';
import { fromCharacter, fromCustom, customPersonas, chatPrefs, setChatPrefs, loadLog, ttsText, orbSpecFor, sttLocale, visibleText, AUTO, DEFAULT_VOICE, type Persona } from '../../lib/persona';
import { commitMemory } from '../../lib/memory';
import { duoTurn, duoRing, participant, callable, type DuoMsg, type EndEvent, type CallEvent, type RingResult } from '../../lib/duo';
import { startRing, RING_MS, type Ringtone } from '../../lib/ringtone';
import { pickPersona } from './picker';
import '../chat/chat.css';
import './duo.css';

const MAX_PERSONAS = 3;
const NUDGE_MS = 7000, NUDGE_Q_MS = 12000;      // silence before the personas fill it (longer after a question to the user)
type SlotState = 'ringing' | 'on' | 'left' | 'declined';
interface Slot {
  p: Persona; el: HTMLElement; inner: HTMLElement; orb: OrbEl; label: HTMLElement; sub: HTMLElement;
  state: SlotState; joinIdx: number; leftIdx: number | null; committed: boolean; hangup: string; how?: 'storm_out' | 'quiet';
  color: string;
}
interface Reply {
  id: string; gen: number; speaker: string | null; full: string;
  chunks: Array<{ sid: string; start: number; raw: string; done: boolean }>;
  pendingCaps: Array<{ sid: string; t: string }>; block: boolean;
  msg: DuoMsg | null; streaming: boolean; cut: boolean; cancelled: boolean;
  end: EndEvent | null; call: CallEvent | null; next: string | null; userAt: number; reqAt: number; heardAt: number;
  ring?: boolean; after: Array<() => void>; ctrl?: AbortController; close?: boolean;
}

export function mount(root: HTMLElement, ctx: ScreenCtx) {
  const { icons, settings, player, ui } = ctx;
  const S = icons.svg;
  ctx.shell.setTopbar(false); ctx.shell.setTabbar(false);
  root.classList.add('fill');

  let personas: Persona[] = [];
  const slots = new Map<string, Slot>();
  const order: string[] = [];                      // slot order left -> right
  const log: DuoMsg[] = [];
  const callId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let gen = 0, busy = 0;                           // busy = /duo/turn requests in flight
  const replies: Reply[] = [];
  let ringing: { id: string; ctrl: AbortController; tone: Ringtone; until: number } | null = null;
  let waitingUser = false, nudges = 0, quietSince = performance.now(), lastChain = 0;
  let forceMerge = false, ended = false, started = false;
  let rec: SttSession | null = null;
  let recPhase: 'connecting' | 'listening' | 'finishing' | 'closed' = 'closed';
  let micLevel = 0;
  let convo = !!chatPrefs().convo;
  let convoPaused: '' | 'silence' | 'error' | 'quota' | 'user' | 'hidden' = '';
  const caps = new Captions(4);
  const think = thinkingLevel();
  let dm = newMachine();
  const t0call = Date.now();
  const params = ctx.route.params;
  const withId = params.get('with') || '';
  const back = withId || chatPrefs().last || 'strix';
  // test hooks / measurements
  const stats = { lat: [] as number[], turns: [] as Array<{ id: string; speaker: string; reqMs: number; firstAudibleMs: number | null; chars: number; chain: number }>, audio: [] as Array<{ who: string; sid: string; start: number; end: number | null }>, perExchange: [] as number[], rings: [] as Array<{ id: string; decision: string; ms: number }> };
  let turnsSinceUser = 0;

  /* ================= DOM ================= */
  const title = h('span', { class: 'duo-title' }, 'Panggilan');
  const timer = h('span', { class: 'duo-timer' }, '00:00');
  const trBtn = h('button', { type: 'button', class: 'vx-chip', html: S('history'), title: 'Transkrip panggilan' }, h('span', null, 'Transkrip'));
  const moreBtn = h('button', { type: 'button', class: 'btn icon ghost vx-more', 'aria-label': 'Opsi', 'aria-haspopup': 'menu', html: S('moreV') });
  const top = h('header', { class: 'duo-top' }, h('div', { class: 'duo-head' }, title, timer), h('div', { class: 'spacer' }), trBtn, moreBtn);
  const status = h('div', { class: 'duo-status', 'aria-live': 'polite' });
  const stage = h('div', { class: 'duo-stage' }, caps.el, caps.live);
  const orbsRow = h('div', { class: 'duo-orbs', 'data-hswipe': '1' });
  const you = h('div', { class: 'vx-you duo-youtxt', 'aria-live': 'polite' });
  const me = ctx.store.get().me?.user;
  const youDot = h('span', { class: 'duo-youdot', 'aria-hidden': 'true' }, ui.avatar(me?.name || me?.email || 'Kamu', me?.picture || null));
  const youRow = h('div', { class: 'duo-you' }, youDot, you);
  const input = h('textarea', { class: 'vx-input', rows: 1, placeholder: 'Ketik untuk menyela...', 'aria-label': 'Pesan', enterkeyhint: 'send' }) as HTMLTextAreaElement;
  const micBtn = h('button', { type: 'button', class: 'vx-mic', 'aria-label': 'Tahan untuk bicara', html: S('mic') });
  const micBars = h('span', { class: 'vx-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const sendBtn = h('button', { type: 'submit', class: 'vx-send', 'aria-label': 'Kirim', html: S('arrowUp') });
  const form = h('form', { class: 'vx-bar' }, micBtn, input, sendBtn);
  const muteBtn = h('button', { type: 'button', class: 'duo-cb', 'aria-pressed': 'false' }, h('span', { class: 'duo-cb-ic', html: S('speaker') }), h('span', null, 'Bisukan'));
  const addBtn = h('button', { type: 'button', class: 'duo-cb' }, h('span', { class: 'duo-cb-ic', html: S('plus') }), h('span', null, 'Tambah orang'));
  const leaveBtn = h('button', { type: 'button', class: 'duo-cb leave' }, h('span', { class: 'duo-cb-ic', html: S('phoneOff') }), h('span', null, 'Tinggalkan panggilan'));
  const ctl = h('div', { class: 'duo-ctl' }, muteBtn, addBtn, leaveBtn);
  const endBox = h('div', { class: 'duo-end', hidden: true });
  const wrap = h('div', { class: 'duo', 'data-state': 'idle' }, top, stage, status, orbsRow, youRow, h('div', { class: 'duo-bottom' }, form, ctl, endBox));
  root.append(wrap);

  /* ================= slots (orbs) ================= */
  const nameOf = (id: string | null | undefined) => (id && (slots.get(id)?.p.name || personas.find((p) => p.id === id)?.name)) || 'Seseorang';
  const present = () => order.filter((id) => slots.get(id)?.state === 'on');
  const orbSize = () => Math.round(innerWidth >= 900 ? Math.min(260, Math.max(160, innerHeight * 0.3)) : Math.min(240, Math.max(118, Math.min(innerWidth * 0.4, innerHeight * 0.22))));
  const BIG = orbSize();
  orbsRow.style.setProperty('--big', BIG + 'px');
  function colorOf(p: Persona) {
    const c = orbSpecFor(p).colors[1];
    return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
  }
  function addSlot(p: Persona, state: SlotState): Slot {
    const old = slots.get(p.id);
    if (old) { old.state = state; paintSlots(); return old; }
    const ob = orb(orbSpecFor(p), { size: BIG, cls: 'duo-orb' });
    const label = h('span', { class: 'duo-name' }, p.name);
    const sub = h('span', { class: 'duo-sub' });
    const ring = h('span', { class: 'duo-ringfx', 'aria-hidden': 'true' });
    const inner = h('button', { type: 'button', class: 'duo-orbbtn', 'aria-label': p.name }, ring, ob);
    const el = h('div', { class: 'duo-slot', 'data-id': p.id }, inner, label, sub);
    const s: Slot = { p, el, inner, orb: ob, label, sub, state, joinIdx: log.length, leftIdx: null, committed: false, hangup: '', color: colorOf(p) };
    el.style.setProperty('--spk', s.color);
    slots.set(p.id, s);
    order.push(p.id);
    orbsRow.append(el);
    ob.setLive(true, () => levelOf(p.id));
    inner.onclick = () => { if (speakingId() === p.id || dm.state === 'speaking' || dm.state === 'ducked') D({ type: 'stop' }); };
    paintSlots();
    return s;
  }
  function removeSlot(id: string) {
    const s = slots.get(id); if (!s) return;
    s.el.classList.add('gone');
    setTimeout(() => { s.el.remove(); }, reducedMotion() ? 60 : 650);
    slots.delete(id); order.splice(order.indexOf(id), 1);
    setTimeout(paintSlots, 20);
  }
  // who is audible right now (the element is really playing, not just buffering the next line)
  const speakingId = () => { const w = player.speaker || ''; if (!(w.startsWith('duo:') || w.startsWith('ring:')) || !player.speechNow()?.playing) return null; return w.slice(w.indexOf(':') + 1); };
  const thinkingId = () => replies.find((r) => r.streaming && !r.cut && !r.cancelled && r.speaker && !r.chunks.some((c) => stats.audio.some((a) => a.sid === c.sid)))?.speaker ?? null;
  function levelOf(id: string): number {
    const s = slots.get(id);
    if (!s) return 0;
    if (speakingId() === id) { const l = player.level(); return l.amp * (dm.state === 'ducked' ? 0.45 : 1); }
    if (s.state === 'ringing') return 0.25 + 0.25 * Math.max(0, Math.sin(performance.now() / 120));
    if (thinkingId() === id) return think() * 0.7;
    return 0;
  }
  let paintedKey = '';
  function paintSlots() {
    const talk = speakingId(), th = thinkingId();
    const vis = order.filter((id) => slots.has(id));
    const n = Math.max(1, vis.length);
    const k = n >= 3 ? 0.7 : n === 2 ? 0.86 : 1;
    const key = vis.map((id) => `${id}:${slots.get(id)!.state}`).join(',') + `|${talk}|${th}|${dm.state}|${ringing?.id ?? ''}`;
    if (key === paintedKey) return;
    paintedKey = key;
    orbsRow.style.setProperty('--k', String(k));
    orbsRow.dataset.n = String(n);
    const ti = talk ? vis.indexOf(talk) : -1;
    vis.forEach((id, i) => {
      const s = slots.get(id)!;
      s.el.dataset.state = s.state;
      s.el.classList.toggle('talk', id === talk);
      s.el.classList.toggle('think', id === th && id !== talk);
      s.el.style.setProperty('--dx', ti >= 0 && i !== ti ? `${Math.sign(i - ti) * (n >= 3 ? 10 : 16)}px` : '0px');
      s.sub.textContent = s.state === 'ringing' ? (ringing?.id === id ? 'memanggil…' : 'menunggu…')
        : s.state === 'left' ? 'keluar' : s.state === 'declined' ? 'menolak' : id === talk ? 'bicara' : id === th ? '…' : '';
    });
    wrap.classList.toggle('alone', present().length <= 1);
  }

  /* ================= the turn-taking machine (same as Chat) ================= */
  function newMachine(): DuplexMachine {
    const m = new DuplexMachine();
    m.onChange = (s) => { if (s === 'interrupted') { if (intT) clearTimeout(intT); intT = setTimeout(() => { if (dm === m && m.state === 'interrupted') D({ type: 'timeout' }); }, 8000); } };
    return m;
  }
  let intT: ReturnType<typeof setTimeout> | null = null;
  function D(ev: DEvent) {
    const fx = dm.dispatch(ev);
    for (const f of fx) run(f);
    paintState(); kick();
  }
  function run(f: Effect) {
    switch (f.type) {
      case 'duck': player.duck(); ringing?.tone.duck(true); haptic(6); break;
      case 'unduck': player.unduck(); break;
      case 'decide': scheduleDecide(f); break;
      case 'cut': cutAll(); break;
      case 'cancel': cancelPending(); break;
      case 'send': void sendTurn(f.text, f.merge); break;
      case 'heard': break;
      case 'drop': if (!input.value.trim()) hideYou(600); break;
    }
  }

  /* ================= state / loop ================= */
  function paintState() {
    const s = dm.state;
    wrap.dataset.state = rec && !convo ? 'listening' : s;
    wrap.classList.toggle('convo', convo && !!rec);
    const kids: Array<Node | string> = [];
    if (ended) { /* the end box says it */ }
    else if (ringing) {
      const b = h('button', { type: 'button', class: 'btn sm soft', html: S('x') }, h('span', null, 'Batal'));
      b.onclick = () => cancelRing();
      kids.push(h('span', null, 'Berdering…'), b);
    } else if (retryRing && (s === 'idle' || s === 'listening')) {
      const r = retryRing;
      const b = h('button', { type: 'button', class: 'btn sm soft', html: S('phone') }, h('span', null, 'Coba lagi'));
      b.onclick = () => { retryRing = null; void ringCall(r.id, 'user'); };
      kids.push(h('span', null, r.text), b);
    } else if (s === 'thinking' || (busy && s !== 'speaking' && s !== 'ducked')) kids.push(h('span', { class: 'vx-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    else if (s === 'ducked') kids.push(dm.duckBy === 'typing' ? 'Tekan Enter untuk menyela' : 'Mendengarkanmu...');
    else if (s === 'interrupted') kids.push('Silakan, mereka mendengarkan');
    else if (rec && recPhase === 'connecting') kids.push('Menyambungkan mic...');
    else if (s === 'speaking') kids.push(convo && rec ? 'Bicara saja untuk menyela' : 'Ketuk bola yang bicara untuk menyela');
    else if (convo && convoPaused) kids.push(convoPaused === 'silence' ? 'Mic dijeda karena hening. Ketuk mic untuk lanjut' : convoPaused === 'hidden' ? 'Dijeda saat tab disembunyikan' : convoPaused === 'quota' ? 'Kuota input suara habis' : 'Mic dijeda. Ketuk mic untuk lanjut');
    else if (convo && rec) kids.push(uttId ? 'Aku dengar...' : 'Mendengarkan. Bicara kapan saja');
    else if (!started) { /* waiting for the first tap */ }
    else kids.push(sttSupported() ? 'Tahan mic untuk bicara, atau ketik' : 'Ketik untuk bicara');
    status.replaceChildren(...kids);
    paintBar();
    paintSlots();
  }
  let raf = 0;
  function loop() {
    raf = 0;
    const s = dm.state;
    if ((s === 'speaking' || s === 'ducked' || s === 'thinking') && !busy && player.pending === 0 && !ringing) D({ type: 'quiet' });
    if (dm.state === 'idle' || dm.state === 'listening') { if (busy || player.pending > 0) quietSince = performance.now(); } else quietSince = performance.now();
    if (convo && !rec && !convoPaused && started && !ended && !document.hidden && !document.querySelector('.dlg') && (navigator as any).userActivation?.hasBeenActive !== false) startConvo();
    if (player.pending > 0) caps.tick(player.speechNow(), player.level().amp);
    runAfter();
    maybeNudge();
    paintSlots();
    raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  /* ================= speaking ================= */
  function blockFor(r: Reply) {
    if (r.block) return;
    r.block = true;
    caps.block(r.id, 'spk' + (r.ring ? ' pre' : ''));
    const el = caps.el.lastElementChild as HTMLElement | null;
    if (el && r.speaker) { el.dataset.who = nameOf(r.speaker) + (r.ring ? ' · berdering' : ''); el.style.setProperty('--spk', slots.get(r.speaker)?.color || 'var(--accent)'); }
    for (const c of r.pendingCaps) caps.add(c.sid, c.t);
    r.pendingCaps = [];
  }
  function speakChunk(r: Reply, raw: string, start: number, sid: string, myGen: number) {
    const t = raw.trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t.replace(/\[[^\]]*\]/g, ''))) return;
    const p = slots.get(r.speaker!)?.p || personas.find((x) => x.id === r.speaker);
    if (!p) return;
    const c = { sid, start: start + (raw.length - raw.trimStart().length), raw: t, done: false };
    r.chunks.push(c);
    if (r.block) caps.add(sid, t); else r.pendingCaps.push({ sid, t });
    // a persona answering another persona: a natural beat (0.6-1.5 s) after the line before, not a queue
    if (r.chunks.length === 1 && !r.userAt && !r.ring && player.pending > 0) void player.gap(600 + Math.random() * 900);
    caps.speed = settings.tune().speed || 1;
    const who = (r.ring ? 'ring:' : 'duo:') + p.id;
    player.speak(ttsText(p, t), {
      voiceId: p.voiceId || DEFAULT_VOICE, who, meta: { sid, a: 0, b: t.length },
      onStart: () => {
        if (myGen !== gen && !r.ring) return;
        blockFor(r);
        stats.audio.push({ who, sid, start: performance.now(), end: null });
        if (!r.heardAt) {
          r.heardAt = performance.now();
          if (r.userAt) stats.lat.push(Math.round(r.heardAt - r.userAt));
          const tt = stats.turns.find((x) => x.id === r.id);
          if (tt) tt.firstAudibleMs = Math.round(r.heardAt - r.reqAt);
        }
        if (!r.ring) D({ type: 'audible' });
        ringing?.tone.duck(true);
        kick();
      },
      onEnd: (ok) => {
        const a = stats.audio.find((x) => x.sid === sid); if (a && a.end == null) a.end = performance.now();
        c.done = true;
        runAfter();   // e.g. "X left the call" shows before the next speaker's line starts
        if (ringing && !player.speaker) ringing.tone.duck(false);
        if (myGen !== gen && !r.ring) return;
        if (ok) caps.finish(sid); else { blockFor(r); caps.fail(sid); audioFailed(); }
        kick();
      },
    });
    kick();
  }
  let failToast = 0;
  function audioFailed() {
    if (Date.now() - failToast < 6000) return;
    failToast = Date.now();
    ui.toast((player.err ? player.err.trim().replace(/([^.!?])$/, '$1.') + ' ' : '') + 'Teks ditampilkan tanpa suara.', { kind: 'warn', title: 'Suara tidak bisa diputar' });
  }
  /** what of reply r was really heard, from the caption reveal state */
  function progress(r: Reply, rev = caps.revealed()) {
    let end = 0, n = 0;
    for (const c of r.chunks) {
      const got = rev[c.sid] ?? 0;
      const total = words(c.raw).length;
      if (got >= total) { end = c.start + c.raw.length; n += total; continue; }
      end = c.start + splitAtWord(c.raw, got).spoken.length; n += got;
      break;
    }
    return { spokenRaw: r.full.slice(0, end), unspokenRaw: r.full.slice(end), words: n };
  }
  const audibleReply = () => replies.find((r) => !r.cut && !r.cancelled && r.chunks.some((c) => !c.done) && r.block) ?? null;
  const replyDone = (r: Reply) => !r.streaming && r.chunks.every((c) => c.done);
  function runAfter() {
    for (const r of replies) {
      if (!r.after.length) continue;
      if (r.cut || r.cancelled || replyDone(r)) { const fns = r.after.splice(0); for (const f of fns) f(); }
    }
    while (replies.length > 6) replies.shift();
  }
  function echoRef(): string {
    const r = audibleReply() || replies[replies.length - 1];
    if (!r) return '';
    const { spokenRaw, unspokenRaw } = progress(r);
    return [...words(spokenRaw).slice(-40), ...words(unspokenRaw).slice(0, 8)].join(' ');
  }
  const echoWindow = () => dm.state === 'speaking' || dm.state === 'ducked' || !!speakingId();

  /** yield / stop: fade out, drop queued TTS + streams; the reply being heard keeps its exact cut point, later ones vanish */
  function cutAll() {
    gen++;
    const rev = caps.cut();
    void player.fadeStop(110);
    haptic();
    for (const r of replies) {
      if (r.cut || r.cancelled || r.ring) continue;
      r.cut = true;
      r.ctrl?.abort();
      const pr = progress(r, rev);
      if (!pr.words) { dropMsg(r); continue; }
      const spoken = pr.spokenRaw.trim();
      if (!pr.unspokenRaw.trim() && !r.streaming) continue;   // fully heard
      const m: DuoMsg = r.msg || { role: 'assistant', speaker: r.speaker || undefined, content: '' };
      m.content = spoken;
      m.interrupted = { spokenText: plain(spoken), unspokenText: plain(pr.unspokenRaw) };
      if (!r.msg) { insertMsg(r, m); }
    }
    busy = 0;
    waitingUser = true; nudges = 0;
    // nothing of the answer was heard: the next words join the user's last message (as in Chat)
    forceMerge = log[log.length - 1]?.role === 'user';
  }
  /** replies not audible yet are cancelled (the user kept talking): they never happened */
  function cancelPending() {
    gen++;
    for (const r of replies) {
      if (r.cut || r.cancelled || r.ring) continue;
      if (r.heardAt) continue;
      r.cancelled = true; r.ctrl?.abort(); dropMsg(r);
    }
    if (!audibleReply()) { player.stop(); caps.cancelPending(); }
    busy = 0;
  }
  function stopAll() {
    gen++; busy = 0;
    for (const r of replies) { r.ctrl?.abort(); if (!r.heardAt) r.cancelled = true; }
    player.stop(); caps.cancelPending();
    if (ringing) { ringing.ctrl.abort(); ringing.tone.stop(); ringing = null; }
    const rr = rec; rec = null; rr?.abort();
    uttId = 0; dm = newMachine(); clearDecide();
  }
  function dropMsg(r: Reply) { if (r.msg) { const i = log.indexOf(r.msg); if (i >= 0) log.splice(i, 1); r.msg = null; } }
  function insertMsg(r: Reply, m: DuoMsg) { r.msg = m; log.push(m); }

  /* ================= turns ================= */
  type TurnOpts = { speaker?: string; nudge?: 'silence' | 'goodbye'; join?: { id: string; caller: string }; resumeHint?: ResumeHint; opener?: boolean; userAt?: number };
  async function requestTurn(o: TurnOpts) {
    if (ended || !present().length) return;
    const myGen = gen;
    const r: Reply = { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), gen: myGen, speaker: null, full: '', chunks: [], pendingCaps: [], block: false, msg: null, streaming: true, cut: false, cancelled: false, end: null, call: null, next: null, userAt: o.userAt || 0, reqAt: performance.now(), heardAt: 0, after: [] };
    r.ctrl = new AbortController();
    replies.push(r);
    busy++; waitingUser = false;
    D({ type: 'think' });
    let n = 0, at = 0;
    const live = () => myGen === gen && !r.cut && !r.cancelled;
    const chunks = ctx.text.chunker((s) => { const start = at; at += s.length; if (live() && r.speaker) speakChunk(r, s, start, `${r.id}:${n++}`, myGen); }, 160, 40);
    let err: any = null, json: any = null;
    try {
      const res = await duoTurn({
        callId, participants: allParts(), present: present(), messages: wire(), callable: callable(personas.filter((p) => !slots.has(p.id) || slots.get(p.id)!.state !== 'on')),
        ...(o.speaker ? { speaker: o.speaker } : {}), ...(o.nudge ? { nudge: o.nudge } : {}), ...(o.join ? { join: o.join } : {}),
        ...(o.resumeHint ? { resumeHint: o.resumeHint } : {}), ...(o.opener ? { opener: true } : {}),
      }, {
        signal: r.ctrl.signal,
        onText: (d, full) => { r.full = full; chunks.push(d); },
        onEnd: (e) => { r.end = e; },
        onCall: (c) => { r.call = c; },
        onNext: (nx, info) => { r.next = nx; lastChain = Number(info?.chain) || 0; if (info?.close) r.close = true; },
        onSpeaker: (id, info) => { r.speaker = id; if (info?.maxChain) maxChain = Number(info.maxChain); if (info?.idleCloseSec) idleCloseMs = Number(info.idleCloseSec) * 1000; paintSlots(); },
      });
      json = res.json;
      if (res.error && !res.text) err = new Error(res.error);
    } catch (e: any) { err = e; }
    r.streaming = false;
    busy = Math.max(0, busy - 1);
    if (live() && r.speaker) chunks.flush();
    if (!live()) { kick(); return; }
    if (json) {                                   // nobody to speak / chain cap: the user's turn
      lastChain = Number(json.chain) || lastChain;
      if (json.capped === 'chain') nudges = 9;
      waitingUser = true; kick(); paintState(); return;
    }
    if (err) {
      if (err.code === 'duo_limit') { ui.toast('Panggilan ini sudah mencapai batas giliran. Mulai panggilan baru untuk lanjut.', { kind: 'warn' }); waitingUser = true; nudges = 9; }
      else if (err.code !== 'aborted') ui.toast(err.message || String(err), { kind: 'bad', title: 'Giliran gagal' });
      waitingUser = true; kick(); paintState(); return;
    }
    if (r.speaker && r.full.trim()) {
      insertMsg(r, { role: 'assistant', speaker: r.speaker, content: r.full });
      stats.turns.push({ id: r.id, speaker: r.speaker, reqMs: Math.round(performance.now() - r.reqAt), firstAudibleMs: r.heardAt ? Math.round(r.heardAt - r.reqAt) : null, chars: r.full.length, chain: lastChain });
      turnsSinceUser++;
    }
    const sp = r.speaker;
    if (r.end && sp) {
      // gone at once for the next turns; the orb leaves when its last line has been heard
      const s = slots.get(sp);
      const quiet = r.end.how === 'quiet';
      if (s) { s.state = 'left'; s.hangup = r.end.reason || ''; s.leftIdx = log.length; s.how = quiet ? 'quiet' : 'storm_out'; }
      log.push({ role: 'event', content: quiet ? `${nameOf(sp)} quietly left the call.` : `${nameOf(sp)} left the call.` });
      void commitFor(sp, quiet ? 'quit' : 'hangup');
      r.after.push(() => personaLeft(sp));
    }
    if (r.call && sp) {
      const c = r.call;
      r.after.push(() => { if (!ended) void ringCall(c.target, sp); });
    }
    const nx = r.next;
    if (r.close) { r.after.push(() => endCall('Panggilan ditutup: sudah lama sepi.')); waitingUser = false; kick(); paintState(); return; }
    if (nx && nx !== 'user' && present().includes(nx) && !r.call) void requestTurn({ speaker: nx });
    else { waitingUser = true; if (!present().length) r.after.push(() => maybeEnd()); }
    kick(); paintState();
  }
  function personaLeft(id: string) {
    const s = slots.get(id);
    if (!s) return;
    caps.block('left-' + id, 'event');
    caps.show(s.how === 'quiet' ? `${s.p.name} pamit dari panggilan.` : `${s.p.name} meninggalkan panggilan.`);
    s.el.classList.add('leaving');
    if (s.how === 'quiet') s.el.classList.add('quiet');
    setTimeout(() => removeSlot(id), reducedMotion() ? 100 : s.how === 'quiet' ? 1400 : 900);
    maybeEnd();
  }
  function maybeEnd() {
    if (ended || present().length || ringing) return;
    if ([...slots.values()].some((s) => s.state === 'ringing')) return;
    endCall('Semua sudah keluar. Panggilan selesai.');
  }
  /** what goes to the server: user / persona lines + events, the last 40 */
  function wire(): DuoMsg[] {
    return log.slice(-40).filter((m) => m.role === 'event' || m.content.trim() || m.interrupted).map((m) => ({ role: m.role, content: m.content.trim() || '…', ...(m.speaker ? { speaker: m.speaker } : {}), ...(m.interrupted ? { interrupted: m.interrupted } : {}) }));
  }
  function allParts() { return order.map((id) => slots.get(id)!).filter((s) => s.state === 'on' || s.state === 'left').map((s) => participant(s.p)); }

  /** the machine decided the user's turn is `text` */
  async function sendTurn(text: string, merge: boolean) {
    text = text.trim();
    if (!text || ended) { if (dm.state === 'thinking' && !busy) D({ type: 'quiet' }); return; }
    if (input.value.trim() === text) { input.value = ''; autosize(); }
    const userAt = performance.now();
    showYou(text, true);
    stats.perExchange.push(turnsSinceUser); turnsSinceUser = 0;
    const last = log[log.length - 1];
    if ((merge || forceMerge) && last?.role === 'user') last.content = `${last.content} ${text}`.trim(); else log.push({ role: 'user', content: text });
    forceMerge = false; nudges = 0; waitingUser = false; lastInputAt = performance.now();
    if (!present().length) { if (!ringing) { ui.toast('Belum ada yang di panggilan. Tambah orang dulu.', { kind: 'info' }); } if (dm.state === 'thinking') D({ type: 'quiet' }); return; }
    // the line before was cut off: resume it / rephrase / drop (decision as in Chat)
    let hint: ResumeHint | undefined;
    const prev = [...log].reverse().find((m, i) => i > 0 && m.role === 'assistant');
    const myGen = gen;
    if (prev?.interrupted?.unspokenText.trim() && log[log.length - 2] === prev && words(text).length <= 14) {
      busy++; paintState();
      try {
        const d = await decide({ personaName: nameOf(prev.speaker), state: 'listening', spoken: prev.interrupted.spokenText, remaining: prev.interrupted.unspokenText, userPartial: text, userFinal: true }, { timeoutMs: 1500 });
        if (d.action === 'resume') hint = d.resume || 'continue';
      } catch { /* aborted */ }
      busy = Math.max(0, busy - 1);
      if (myGen !== gen) return;
    }
    await requestTurn({ resumeHint: hint, userAt });
  }

  /* ================= silence: they fill it (bicker / check on the user) ================= */
  let maxChain = 6, idleCloseMs = 180_000, lastInputAt = performance.now(), closing = false;
  function maybeNudge() {
    if (!waitingUser || ended || ringing || busy || player.pending > 0) return;
    if (dm.state !== 'idle' && dm.state !== 'listening') return;
    if (uttId || input.value.trim() || document.hidden || document.querySelector('.dlg')) { quietSince = performance.now(); lastInputAt = Math.max(lastInputAt, performance.now() - 1000); return; }
    const pr = present();
    if (!pr.length) return;
    // nobody has heard from the user for a few minutes: one persona wraps the call up politely, then it ends
    if (!closing && performance.now() - lastInputAt > idleCloseMs && performance.now() - quietSince > 2500) {
      closing = true; quietSince = performance.now();
      void requestTurn({ nudge: 'goodbye' });
      return;
    }
    if (nudges >= 3 || lastChain >= maxChain) return;
    if (pr.length === 1 && nudges >= 1) return;
    const lastA = [...log].reverse().find((m) => m.role === 'assistant');
    const wait = (lastA && /\?\s*(\[[^\]]*\]\s*)*$/.test(lastA.content.trim()) ? NUDGE_Q_MS : NUDGE_MS) * (pr.length === 1 ? 1.6 : 1);
    if (performance.now() - quietSince < wait) return;
    nudges++; quietSince = performance.now();
    void requestTurn({ nudge: 'silence' });
  }

  /* ================= ringing someone ================= */
  let retryRing: { id: string; text: string } | null = null;
  const tries = new Map<string, number>();         // ring attempts per persona in this call
  const phoneOff = new Set<string>();             // declined 3 times / 'off': not callable again in this call
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function ringCall(id: string, caller: string) {
    const p = personas.find((x) => x.id === id);
    if (!p || ended) return;
    if (ringing) { ui.toast('Tunggu panggilan yang sedang berdering.', { kind: 'info' }); return; }
    const s0 = slots.get(id);
    if (s0?.state === 'on') return;
    if (phoneOff.has(id)) { ui.toast(`${p.name} mematikan teleponnya.`, { kind: 'info' }); return; }
    if (present().length >= MAX_PERSONAS) { ui.toast(`Maksimal ${MAX_PERSONAS} persona dalam satu panggilan.`, { kind: 'warn' }); return; }
    retryRing = null;
    const s = addSlot(p, 'ringing');
    tries.set(id, (tries.get(id) || 0) + 1);
    if (!hasHandOff('duo:' + id)) enter(s.el, { dx: order.indexOf(id) === 0 ? -24 : 24, dy: 0, scale: 0.8, ms: 420 });
    const ctrl = new AbortController();
    const tone = startRing({ muted: player.muted });
    const tStart = performance.now();
    ringing = { id, ctrl, tone, until: 0 };
    caps.block('ring-' + id + tries.get(id), 'event');
    caps.show(caller === 'user' ? `Memanggil ${p.name}…` : `${nameOf(caller)} menelepon ${p.name}…`);
    paintState(); kick();
    const recent = log.filter((m) => m.role !== 'event').slice(-6).map((m) => ({ who: m.role === 'user' ? 'User' : nameOf(m.speaker), text: plain(m.content).slice(0, 300) }));
    let res: RingResult | null = null;
    try {
      res = await duoRing({ callId, callee: participant(p), caller, present: present().map((x) => participant(slots.get(x)!.p)), recent, ...(forceRing ? { force: forceRing } : {}) }, ctrl.signal);
    } catch (e: any) {
      tone.stop();
      if (ringing?.ctrl === ctrl) ringing = null;
      if (e?.code !== 'aborted') {
        ui.toast(e?.code === 'duo_limit' ? `Maksimal ${MAX_PERSONAS} persona dalam satu panggilan.` : e?.message || String(e), { kind: 'warn', title: 'Panggilan gagal' });
        if (slots.get(id)?.state === 'ringing') removeSlot(id);
      }
      paintState(); maybeEnd(); return;
    }
    if (ringing?.ctrl !== ctrl) { tone.stop(); return; }     // cancelled meanwhile
    stats.rings.push({ id, decision: res.decision, ms: Math.round(performance.now() - tStart) });
    if (res.decision === 'off') {
      tone.stop(); ringing = null; phoneOff.add(id);
      caps.block('off-' + id, 'event'); caps.show(`${p.name} mematikan teleponnya.`);
      removeSlot(id); paintState(); maybeEnd(); return;
    }
    // while it rings, a persona already on the call reacts (its voice, its colour); the callee stays silent until it picks up
    if (res.reaction && slots.get(res.reaction.speaker)?.state === 'on') sayLine(res.reaction.speaker, res.reaction.text);
    // let it ring `rings` times (counted from the start), never cutting the reaction short, then a short beat
    const until = tStart + Math.max(1, res.rings) * RING_MS - 900;
    while (ringing?.ctrl === ctrl && (performance.now() < until || player.pending > 0 || busy > 0)) await sleep(120);
    if (ringing?.ctrl !== ctrl) return;
    await sleep(450);
    if (ringing?.ctrl !== ctrl) return;
    tone.stop(); ringing = null;
    const by = caller === 'user' ? 'the user' : nameOf(caller);
    if (res.decision === 'answer') {
      s.state = 'on'; s.joinIdx = log.length;
      s.el.classList.add('joined');
      haptic(10);
      log.push({ role: 'event', content: `${p.name} picked up (called by ${by}).` });
      paintState();
      void requestTurn({ join: { id, caller } });
    } else {
      const text = res.decision === 'decline' ? `${p.name} menolak panggilan.` : `${p.name} tidak menjawab.`;
      caps.block('miss-' + id + tries.get(id), 'event'); caps.show(text);
      log.push({ role: 'event', content: res.decision === 'decline' ? `${p.name} declined the call from ${by}.` : `${p.name} did not answer the call from ${by}.` });
      s.state = 'declined';
      paintSlots();
      setTimeout(() => { if (slots.get(id)?.state === 'declined') removeSlot(id); }, 1400);
      if (caller === 'user' && (tries.get(id) || 0) < 3) retryRing = { id, text: res.decision === 'decline' ? 'Ditolak.' : 'Tidak dijawab.' };
      else if ((tries.get(id) || 0) >= 3) phoneOff.add(id);
      // the persona who reacted says what it thinks of that
      if (res.after && slots.get(res.after.speaker)?.state === 'on') sayLine(res.after.speaker, res.after.text);
      paintState();
      setTimeout(maybeEnd, 1500);
    }
  }
  /** A persona on the call says one line that did not come from /duo/turn (ring reactions): spoken in its turn of the
      audio queue (never over another voice), captioned in its colour, and part of the transcript (and of its memory). */
  function sayLine(speaker: string, text: string) {
    const r: Reply = { id: 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), gen, speaker, full: text, chunks: [], pendingCaps: [], block: false, msg: null, streaming: false, cut: false, cancelled: false, end: null, call: null, next: null, userAt: 0, reqAt: performance.now(), heardAt: 0, after: [] };
    replies.push(r);
    insertMsg(r, { role: 'assistant', speaker, content: text });
    speakChunk(r, text, 0, r.id + ':0', gen);
    kick();
  }  function cancelRing() {
    const r = ringing; if (!r) return;
    r.ctrl.abort(); r.tone.stop(); ringing = null;
    log.push({ role: 'event', content: `The user hung up before ${nameOf(r.id)} answered.` });
    removeSlot(r.id);
    paintState(); setTimeout(maybeEnd, 400);
  }
  // tests: force a ring decision (dev server only honours it)
  let forceRing: string | null = null;

  /* ================= memory ================= */
  async function commitFor(id: string, reason: 'duo' | 'hangup' | 'quit', keepalive = false) {
    const s = slots.get(id);
    if (!s || s.committed) return;
    s.committed = true;
    const slice = log.slice(s.joinIdx, s.leftIdx ?? log.length).filter((m) => m.role !== 'event');
    const withList = order.map((x) => slots.get(x)!).filter((o) => o.p.id !== id && (o.state === 'on' || o.state === 'left')).map((o) => ({ id: o.p.id, name: o.p.name }));
    if (!slice.some((m) => m.role === 'user') && reason === 'duo') return;
    await commitMemory({
      personaId: id, personaName: s.p.name, reason, hangupReason: reason !== 'duo' ? s.hangup : undefined, keepalive,
      messages: slice.map((m) => ({ role: m.role, content: m.content, ...(m.speaker ? { speaker: m.speaker } : {}) })),
      duo: { with: withList },
    });
  }
  function commitAll(keepalive = false) { for (const id of [...order]) { const s = slots.get(id); if (s && (s.state === 'on' || s.state === 'left')) void commitFor(id, s.state === 'left' ? (s.how === 'quiet' ? 'quit' : 'hangup') : 'duo', keepalive); } }
  const onPageHide = () => commitAll(true);
  addEventListener('pagehide', onPageHide);

  /* ================= ending ================= */
  function endCall(text: string) {
    if (ended) return;
    ended = true;
    commitAll();
    const r = rec; rec = null; r?.abort();
    form.hidden = true; ctl.hidden = true;
    const again = ui.btn({ label: 'Kembali ke Chat', icon: 'arrowLeft', cls: 'primary' });
    again.onclick = () => leave(true);
    endBox.replaceChildren(h('p', { class: 'duo-endt' }, text), again);
    endBox.hidden = false;
    paintState();
  }
  let leaving = false;
  function leave(already = false) {
    if (leaving) return;
    leaving = true;
    if (!already) commitAll();
    ended = true;
    stopAll();
    // the orb of the persona Chat returns to flies back onto the Chat orb; the others fade
    const s = slots.get(back);
    if (s && s.el.isConnected) { const g = orbGhost(s.orb); if (g) handOff(g); }
    setChatPrefs({ last: back });
    ctx.navigate('chat/' + encodeURIComponent(back));
  }
  leaveBtn.onclick = () => leave();

  /* ================= decisions while someone speaks (as in Chat) ================= */
  let decideT: ReturnType<typeof setTimeout> | null = null;
  let pendingDecide: { utt: number; text: string; final: boolean } | null = null;
  let inflight = 0, lastAsked = '';
  function clearDecide() { if (decideT) clearTimeout(decideT); decideT = null; pendingDecide = null; lastAsked = ''; }
  function scheduleDecide(f: { utt: number; text: string; final: boolean }) {
    pendingDecide = f;
    if (f.final) { if (decideT) clearTimeout(decideT); decideT = null; void fireDecide(); return; }
    if (!decideT) decideT = setTimeout(() => { decideT = null; void fireDecide(); }, 200);
  }
  async function fireDecide() {
    const f = pendingDecide; pendingDecide = null;
    if (!f) return;
    const key = `${f.utt}|${f.final}|${f.text}`;
    if (key === lastAsked) return;
    if (inflight && !f.final) { pendingDecide = f; return; }
    lastAsked = key;
    const fast = fastDecide(f.text);
    if (fast) { D({ type: 'decision', utt: f.utt, d: fast, text: f.text, final: f.final }); return; }
    const r = audibleReply();
    const pr = r ? progress(r) : { spokenRaw: '', unspokenRaw: '', words: 0 };
    inflight++;
    let res;
    try { res = await decide({ personaName: nameOf(r?.speaker), state: 'speaking', spoken: plain(pr.spokenRaw), remaining: plain(pr.unspokenRaw), userPartial: f.text, userFinal: f.final, speechMs: uttStart ? Math.round(performance.now() - uttStart) : undefined }); } finally { inflight--; }
    D({ type: 'decision', utt: f.utt, d: res, text: f.text, final: f.final });
    if (pendingDecide && !decideT) void fireDecide();
  }

  /* ================= the user's words ================= */
  let youT: ReturnType<typeof setTimeout> | null = null;
  function showYou(text: string, final: boolean) { you.textContent = text; you.classList.add('on'); if (youT) clearTimeout(youT); youT = final ? setTimeout(() => hideYou(), 3800) : null; }
  function hideYou(ms = 0) { if (youT) clearTimeout(youT); youT = null; if (ms) youT = setTimeout(() => you.classList.remove('on'), ms); else you.classList.remove('on'); }

  /* ================= Mode Percakapan (one open Scribe session) ================= */
  let uttSeq = 0, uttId = 0, uttStart = 0, uttHasText = false;
  let loudSince = 0, lastLoud = 0, lastSound = 0, voiceFired = false, hushT: ReturnType<typeof setTimeout> | null = null;
  const sttLang = () => { const p = slots.get(present()[0] || '')?.p; return !p || p.lang === AUTO ? '' : sttLocale(p.lang); };
  function openUtt() { if (!uttId) { uttId = ++uttSeq; uttStart = performance.now(); uttHasText = false; } return uttId; }
  function onMicLevel(l: number) {
    micLevel = l;
    youDot.style.setProperty('--l', Math.min(1, l * 1.6).toFixed(2));
    if (!convo) return;
    const now = performance.now();
    const out = speakingId() ? player.level().amp * player.gainTarget : 0;
    const thr = 0.3 + 0.55 * out;
    if (l > 0.16 + 0.4 * out) lastSound = now;
    if (l > thr) {
      if (!loudSince) loudSince = now;
      lastLoud = now;
      if (!voiceFired && now - loudSince >= 250) {
        voiceFired = true;
        const id = openUtt();
        if (dm.state === 'speaking') D({ type: 'voice', utt: id });
        if (hushT) clearTimeout(hushT);
        hushT = setTimeout(() => { hushT = null; if (uttId === id && !uttHasText) { D({ type: 'hush', utt: id }); uttId = 0; } }, 1400);
      }
    } else if (loudSince && now - lastLoud > 350) { loudSince = 0; voiceFired = false; }
  }
  function onConvoPartial(t: string) {
    t = t.trim(); if (!t) return;
    if (echoWindow() && isEcho(t, echoRef())) return;
    if (performance.now() - lastSound > 3000) return;
    const id = openUtt(); uttHasText = true; quietSince = performance.now(); lastInputAt = performance.now();
    showYou(t, false);
    D({ type: 'partial', utt: id, text: t });
  }
  function onConvoFinal(t: string) {
    t = t.trim();
    const id = uttId || ++uttSeq;
    uttId = 0; uttHasText = false;
    if (!t) return;
    if (echoWindow() && isEcho(t, echoRef())) return;
    if (performance.now() - lastSound > 5000) return;
    D({ type: 'final', utt: id, text: t });
  }
  function startConvo() {
    if (rec || ended) return;
    if (!sttSupported()) { convoPaused = 'error'; paintState(); return; }
    convoPaused = ''; recPhase = 'connecting';
    const session: SttSession = startStt({
      lang: sttLang(), mode: 'vad', continuous: true, fallback: false, vadSilenceSec: 0.8,
      onState: (s) => { if (rec === session) { recPhase = s; paintState(); } },
      onLevel: (l) => { if (rec === session) onMicLevel(l); },
      onPartial: (t) => { if (rec === session) onConvoPartial(t); },
      onFinal: (t) => { if (rec === session) onConvoFinal(t); },
      onEnd: () => { if (rec !== session) return; rec = null; micLevel = 0; uttId = 0; if (!convoPaused) convoPaused = 'error'; D({ type: 'mic', on: false }); },
      onError: (code, m) => { if (rec !== session) return; convoPaused = code === 'quota' ? 'quota' : 'error'; if (code !== 'quota') ui.toast(m, { kind: 'warn', title: code.startsWith('mic') ? 'Mikrofon' : 'Mode Percakapan' }); },
    });
    rec = session;
    D({ type: 'mic', on: true });
  }
  function pauseConvo(why: typeof convoPaused) { convoPaused = why; if (rec) { const r = rec; rec = null; r.abort(); } micLevel = 0; uttId = 0; D({ type: 'mic', on: false }); }
  function setConvo(on: boolean) {
    convo = on; setChatPrefs({ convo: on });
    if (on) { if (rec) { const r = rec; rec = null; r.abort(); } convoPaused = ''; startConvo(); }
    else { pauseConvo('user'); convoPaused = ''; }
    paintState(); kick();
  }
  const onVis = () => { if (document.hidden && convo && rec && (dm.state === 'listening' || dm.state === 'idle')) pauseConvo('hidden'); };
  document.addEventListener('visibilitychange', onVis);

  /* ================= mic: hold to talk / tap (Mode Percakapan: pause / resume) ================= */
  function startListening() {
    if (ended) return;
    if (!sttSupported()) { ui.toast('Browser ini tidak bisa merekam suara. Ketik pesanmu.', { kind: 'warn' }); input.focus(); return; }
    const s0 = dm.state;
    if (s0 === 'speaking' || s0 === 'ducked' || s0 === 'thinking') D({ type: 'stop' });
    rec?.abort();
    let got = false;
    recPhase = 'connecting'; micLevel = 0;
    const session: SttSession = startStt({
      lang: sttLang(), mode: 'ptt',
      onState: (s) => { recPhase = s; paintState(); },
      onLevel: (l) => { micLevel = l; youDot.style.setProperty('--l', Math.min(1, l * 1.6).toFixed(2)); },
      onPartial: (t) => { if (rec === session && t) showYou(t, false); },
      onFinal: (t) => { if (rec !== session || got || !t.trim()) return; got = true; rec = null; D({ type: 'final', utt: ++uttSeq, text: t }); },
      onEnd: () => { if (rec === session) rec = null; if (got) prewarmStt(); micLevel = 0; if (!got) hideYou(); kick(); paintState(); },
      onError: (code, m) => { if (code !== 'quota') ui.toast(m, { kind: code === 'fallback' ? 'info' : 'warn' }); },
    });
    rec = session;
    kick(); paintState();
  }
  let pressT = 0;
  micBtn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    if (convo) { pressT = 0; if (rec) pauseConvo('user'); else { convoPaused = ''; startConvo(); } paintState(); kick(); return; }
    if (rec) { rec.stop(); pressT = 0; return; }
    startListening(); pressT = performance.now();
    try { micBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  const release = () => { if (pressT && performance.now() - pressT > 380 && rec) rec.stop(); pressT = 0; };
  micBtn.addEventListener('pointerup', release);
  micBtn.addEventListener('pointercancel', release);
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  micBtn.addEventListener('click', (e) => { if (e.detail !== 0) return; if (convo) { if (rec) pauseConvo('user'); else { convoPaused = ''; startConvo(); } return; } if (rec) rec.stop(); else startListening(); });
  micBtn.addEventListener('pointerenter', () => prewarmStt());

  /* ================= input bar (text duplex) ================= */
  function paintBar() {
    const talking = busy > 0 || player.pending > 0 || dm.state === 'speaking' || dm.state === 'ducked';
    const typed = !!input.value.trim();
    const stop = talking && !typed && !ringing;
    sendBtn.innerHTML = S(stop ? 'stop' : 'arrowUp');
    sendBtn.classList.toggle('stop', stop);
    sendBtn.setAttribute('aria-label', stop ? 'Hentikan' : 'Kirim');
    sendBtn.disabled = ended || (!stop && !typed);
    const live = convo && !!rec;
    micBtn.classList.toggle('rec', !!rec && !convo);
    micBtn.classList.toggle('convo', convo);
    micBtn.classList.toggle('live', live);
    if (convo) { if (!micBtn.contains(micBars)) { micBtn.innerHTML = S('waveform'); micBtn.append(micBars); } micBtn.setAttribute('aria-label', live ? 'Mode Percakapan aktif. Ketuk untuk jeda' : 'Mode Percakapan dijeda. Ketuk untuk lanjut'); }
    else if (micBtn.contains(micBars)) { micBtn.innerHTML = S('mic'); micBtn.setAttribute('aria-label', 'Tahan untuk bicara'); }
    micBtn.disabled = ended;
    input.disabled = ended;
    addBtn.disabled = ended || !!ringing || present().length >= MAX_PERSONAS;
    muteBtn.setAttribute('aria-pressed', String(player.muted));
    muteBtn.classList.toggle('on', player.muted);
  }
  const barT = setInterval(() => { if (convo && rec) micBars.style.setProperty('--l', Math.min(1, micLevel * 1.4).toFixed(2)); }, 90);
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 96) + 'px'; }
  const typingNow = () => !!input.value.trim() && document.activeElement === input;
  let typingWas = false;
  const typing = (on: boolean) => { if (on !== typingWas || (on && dm.state === 'speaking')) { typingWas = on; D({ type: 'typing', on }); } else paintBar(); };
  input.addEventListener('input', () => { autosize(); quietSince = performance.now(); lastInputAt = performance.now(); typing(typingNow()); });
  input.addEventListener('focus', () => { if (typingNow()) typing(true); });
  input.addEventListener('blur', () => typing(false));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitText(); } });
  function submitText() { const t = input.value.trim(); if (!t || ended) return; begin(); D({ type: 'submit', text: t }); }
  for (const ev of ['pointerdown', 'mousedown'] as const) sendBtn.addEventListener(ev, (e) => { if (document.activeElement === input) e.preventDefault(); });
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) { const s0 = dm.state; if (s0 === 'speaking' || s0 === 'ducked' || s0 === 'thinking') D({ type: 'stop' }); else if (player.busy && !ringing) player.stop(); return; }
    submitText();
  };
  muteBtn.onclick = () => { player.setMuted(!player.muted); ringing?.tone.setMuted(player.muted); paintBar(); ui.toast(player.muted ? 'Suara panggilan dibisukan. Teks tetap tampil.' : 'Suara panggilan nyala lagi.', { kind: 'ok', timeout: 1800 }); };
  addBtn.onclick = async () => {
    if (ended || ringing) return;
    const rows = personas.filter((p) => slots.get(p.id)?.state !== 'on').map((p) => {
      const n = tries.get(p.id) || 0;
      return { p, status: phoneOff.has(p.id) ? 'Mematikan telepon' : n ? `Sudah ditelepon ${n}x` : undefined, disabled: phoneOff.has(p.id) };
    });
    const pick = await pickPersona(ctx, { title: 'Tambah orang ke panggilan', rows, note: `Maksimal ${MAX_PERSONAS} persona. Yang ditelepon bisa menolak.` });
    if (pick) { const g = orbGhost(pick.orbEl); if (g) handOff(g, 1500, 'duo:' + pick.p.id); void ringCall(pick.p.id, 'user'); }
  };
  addEventListener('keydown', onKey, true);
  function onKey(e: KeyboardEvent) {
    const s = dm.state;
    if (e.key === 'Escape' && (s === 'speaking' || s === 'ducked' || s === 'thinking') && !document.querySelector('.dlg, .menu')) { e.preventDefault(); D({ type: 'stop' }); }
  }

  /* ================= sheets ================= */
  function openTranscript() {
    const items = log.filter((m) => m.role === 'event' || visibleText(m.content).trim());
    const row = (m: DuoMsg) => m.role === 'event'
      ? h('div', { class: 'tr-m ev' }, h('p', null, eventText(m.content)))
      : h('div', { class: 'tr-m ' + (m.role === 'user' ? 'me' : 'ai') + (m.interrupted ? ' cut' : ''), style: m.speaker ? `--spk:${slots.get(m.speaker)?.color || 'var(--accent)'}` : '' },
        h('span', { class: 'tr-who' }, m.role === 'user' ? 'Kamu' : nameOf(m.speaker), m.interrupted ? h('span', { class: 'tr-tag cut' }, 'terpotong') : null),
        h('p', null, visibleText(m.content).trim() + (m.interrupted ? ' —' : '')));
    const list = h('div', { class: 'tr duo-tr', role: 'log', 'aria-label': 'Transkrip' }, ...(items.length ? items.map(row) : [h('div', { class: 'empty', style: 'padding:28px 8px' }, h('p', null, 'Belum ada percakapan.'))]));
    const m = ui.modal({ title: 'Transkrip panggilan', cls: 'tr-dlg', body: list });
    requestAnimationFrame(() => { const b = m.root.querySelector('.dlg-b'); if (b) b.scrollTop = b.scrollHeight; });
  }
  const eventText = (t: string) => t.replace(/^(.+) quietly left the call\.$/, '$1 pamit dari panggilan.').replace(/^(.+) left the call\.$/, '$1 meninggalkan panggilan.').replace(/^(.+) picked up \(called by (.+)\)\.$/, (_, a, b) => `${a} mengangkat (ditelepon ${b === 'the user' ? 'kamu' : b}).`)
    .replace(/^(.+) declined the call.*$/, '$1 menolak panggilan.').replace(/^(.+) did not answer.*$/, '$1 tidak menjawab.').replace(/^The user hung up before (.+) answered\.$/, 'Kamu membatalkan panggilan ke $1.');
  trBtn.onclick = openTranscript;
  moreBtn.onclick = () => {
    const tg = h('button', { type: 'button', class: 'menu-item vx-toggle', role: 'menuitemcheckbox', 'aria-checked': String(convo), html: S('waveform') },
      h('span', { class: 'vx-tg-t' }, h('span', null, 'Mode Percakapan'), h('small', null, convo ? 'Mic terbuka, bicara kapan saja' : 'Bicara kapan saja, bisa menyela')), h('span', { class: 'vx-sw' + (convo ? ' on' : ''), 'aria-hidden': 'true' }));
    tg.onclick = () => setConvo(!convo);
    ui.popover(moreBtn, h('div', null, tg, h('div', { class: 'menu-sep' }), ui.menuItem('Tambah orang', 'plus', () => addBtn.click()), ui.menuItem('Transkrip', 'history', openTranscript), ui.menuItem('Tinggalkan panggilan', 'phoneOff', () => leave(), 'danger')), { align: 'end' });
  };

  /* ================= start ================= */
  // a call needs a user gesture for audio: coming from a tap it starts at once, a direct link shows one button
  const startBtn = h('button', { type: 'button', class: 'btn primary lg duo-start', html: S('phone') }, h('span', null, 'Mulai panggilan'));
  function begin() { if (!started) { started = true; startBtn.remove(); paintState(); } }
  async function boot(chars: Character[]) {
    personas = [...chars.map((c) => fromCharacter(c)), ...customPersonas().map(fromCustom)];
    const find = (id: string) => personas.find((p) => p.id === id);
    const callIds = (params.get('call') || (withId ? '' : 'strix,lena')).split(',').map((x) => x.trim()).filter((x) => find(x) && x !== withId).slice(0, MAX_PERSONAS);
    const caller = params.get('caller') || 'user';
    // already on the line (from a solo Chat): the recent solo lines are context; its own solo memory is committed by Chat
    const w = withId ? find(withId) : null;
    if (w) {
      const solo = loadLog(w.id).msgs.slice(-8);
      for (const m of solo) log.push({ role: m.role, content: m.content, ...(m.role === 'assistant' ? { speaker: w.id } : {}), ...(m.interrupted ? { interrupted: m.interrupted } : {}) });
      const s = addSlot(w, 'on');
      s.joinIdx = log.length;
      void receiveOrb(s.orb, 520, hasHandOff('duo:' + w.id) ? 'duo:' + w.id : '');
    }
    for (const id of callIds) if (hasHandOff('duo:' + id)) { const s = addSlot(find(id)!, 'ringing'); void receiveOrb(s.orb, 520, 'duo:' + id); }
    title.textContent = [w, ...callIds.map(find)].filter(Boolean).map((p) => p!.name).join(' · ') || 'Panggilan';
    paintState(); kick();
    const go = async () => {
      begin();
      for (const id of callIds) {
        if (ended) break;
        const by = caller !== 'user' && present().includes(caller) ? caller : 'user';
        await ringCall(id, by);
        while (ringing || busy || player.pending > 0) { if (ended) return; await sleep(200); }
      }
      if (!callIds.length && w) waitingUser = true;
    };
    if ((navigator as any).userActivation?.hasBeenActive !== false && document.visibilityState === 'visible') void go();
    else { status.replaceChildren(startBtn); startBtn.onclick = () => void go(); }
  }
  ctx.data.characters().then((l) => boot(l)).catch((e) => { caps.block('err', 'event'); caps.show(`Persona tidak bisa dimuat: ${e.message || e}`); });

  const clockT = setInterval(() => { const s = Math.floor((Date.now() - t0call) / 1000); timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 1000);
  onDisconnect(wrap, player.on('change', () => { kick(); paintBar(); }));
  const warmT = setTimeout(() => { if (sttSupported() && !document.hidden) prewarmStt(); }, 1500);
  // test hooks (dev / e2e)
  (window as any).__duo = () => ({
    state: dm.state, present: present(), slots: order.map((id) => ({ id, state: slots.get(id)?.state })), ringing: ringing?.id ?? null, busy, waitingUser, nudges, lastChain, ended,
    log: log.map((m) => ({ ...m })), stats, speaking: speakingId(), audio: player.pending, muted: player.muted, trace: dm.trace.slice(-40),
    force: (d: string | null) => { forceRing = d; },
  });
  (window as any).__caps = caps;

  return {
    cleanup: () => {
      if (!ended) commitAll();
      ended = true;
      stopAll();
      clearInterval(clockT); clearInterval(barT); clearTimeout(warmT); if (intT) clearTimeout(intT); if (hushT) clearTimeout(hushT); if (youT) clearTimeout(youT);
      if (raf) cancelAnimationFrame(raf);
      removeEventListener('keydown', onKey, true); removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVis);
      player.setMuted(false);
    },
    onRoute: (_r: RouteInfo) => { /* a running call ignores route changes inside #/duo */ },
  };
}
