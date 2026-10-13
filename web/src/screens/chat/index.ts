/* Chat Persona, voice-only. No message bubbles: a clean stage with the persona's big orb just above a compact input bar
   (type / push-to-talk mic / send). Every reply is spoken (LLM streams in the background, TTS per sentence chunk) and
   its words appear above the orb only while they are being spoken (lib/captions.ts, driven by the real audio clock).
   Audio tags are spoken, never shown. Older captions fade and scroll up; the user's words show briefly, small and dim.
   Transcript and persona list live in sheets. Tap the orb while it talks = stop and listen.

   Full duplex (lib/duplex.ts DuplexMachine = the ONE turn-taking state machine):
   - Mode Percakapan: one Scribe Realtime session stays open (VAD, echo cancellation); while the persona talks, user
     speech ducks its voice at once, /api/chat/decide says ignore / backchannel / yield / stop / resume; yield & stop cut
     the reply with a short fade at the last word really heard (captions freeze there), the cut point is stored on the
     assistant message (`interrupted`) and sent with the next turn; "Lanjutkan" / "go on" resumes from that point.
   - Text duplex: typing while the persona talks ducks it, Enter interrupts the same way, clearing / blur restores it.
   - Tools (web search) are shown openly: chip near the orb while running, sources chip after, lines in the transcript. */
import type { RouteInfo, ScreenCtx } from '../../ctx';
import type { Character } from '../../api';
import { h, onDisconnect } from '../../ui/dom';
import { field } from '../../ui/controls';
import { voicePicker } from '../../ui/voicepicker';
import { orb, jelly, thinkingLevel, onOrbsChange, emptyOrbSpec } from '../../ui/orb';
import { openOrbStudio } from '../../ui/orbstudio';
import { orbGhost, handOff, receiveOrb, flyOrb, morphOrb, enter } from '../../ui/transition';
import { drag, swipeRow, haptic, rubber, settle } from '../../ui/gesture';
import { Captions } from '../../lib/captions';
import { startStt, sttSupported, prewarmStt, type SttSession } from '../../lib/stt';
import { DuplexMachine, isEcho, splitAtWord, plain, words, fastDecide, type DEvent, type Effect, type DState, type ResumeHint } from '../../lib/duplex';
import { decide, decideLog } from '../../lib/decide';
import { openPersonaEditor, createPersonaFlow } from './creator';
import { prewarmForge } from './forgegl';
import { toolChip, toolLine, toolMeta, isQuota } from './tools';
import {
  type Persona, type ChatLog, type ChatMsg, type Verdict, type CustomPersona, type ToolEvent,
  fromCharacter, fromCustom, customPersonas, chatPrefs, setChatPrefs, setOverride, saveCustom, deleteCustom, setPersonaOrb,
  loadLog, saveLog, streamChat, visibleText, ttsText, greetingFor, langLabel, langName, sttLocale, LANGS, ACCENTS, cleanAccent, DEFAULT_VOICE, orbSpecFor, AUTO,
} from '../../lib/persona';
import './chat.css';

type UiState = DState | 'ptt';
const desktop = () => matchMedia('(min-width: 900px)').matches;
const fmtMin = (sec: number) => (sec >= 90 ? `${Math.round(sec / 60)} mnt` : `${Math.max(0, Math.round(sec))} dtk`);

/** One spoken reply (or greeting) being played: where each TTS chunk sits in the raw text, for the cut point. */
interface Reply {
  id: string; p: Persona; gen: number;
  full: string;                                   // raw text received so far (with [tags])
  chunks: Array<{ sid: string; start: number; raw: string }>;
  msg: ChatMsg | null;                            // its message in the log once written
  base: { msg: ChatMsg; prefix: string } | null;  // "Lanjutkan": the continuation is appended to this interrupted message
  tools: ToolEvent[];
  cut: boolean; cancelled: boolean; endedAt: number;
}

export function mount(root: HTMLElement, ctx: ScreenCtx) {
  const { icons, settings, player, ui } = ctx;
  const S = icons.svg;
  ctx.shell.setTopbar(false);
  root.classList.add('fill');

  let chars: Character[] = [];
  let charsErr = '';
  let personas: Persona[] = [];
  let cur: Persona | null = null;
  let log: ChatLog = { msgs: [] };
  let busy = false, chatCtrl: AbortController | null = null, gen = 0;
  // speech input = ElevenLabs Scribe Realtime (lib/stt.ts); Web Speech only as a marked fallback (push-to-talk)
  let rec: SttSession | null = null;
  let recPhase: 'connecting' | 'listening' | 'finishing' | 'closed' = 'closed';
  let micLevel = 0, recFallback = false;
  let convo = !!chatPrefs().convo;                 // Mode Percakapan wanted
  let convoPaused: '' | 'silence' | 'error' | 'quota' | 'user' | 'hidden' = '';
  let loaded = false;
  let shown: UiState | '' = '';
  let failToast = 0;
  let retry: (() => void) | null = null;
  let R: Reply | null = null;                      // the reply being spoken / prepared
  let forceMerge = false;
  const caps = new Captions(3);
  const think = thinkingLevel();
  let dm = newMachine();

  /* ================= DOM ================= */
  const whoName = h('span', { class: 'vx-who-n' }, 'Chat');
  const whoBtn = h('button', { type: 'button', class: 'vx-who', 'aria-haspopup': 'dialog', 'aria-label': 'Ganti persona' }, whoName, h('span', { class: 'vx-who-c', html: S('chevronDown') }));
  const trBtn = h('button', { type: 'button', class: 'vx-chip', html: S('history'), title: 'Transkrip percakapan' }, h('span', null, 'Transkrip'));
  const moreBtn = h('button', { type: 'button', class: 'btn icon ghost vx-more', 'aria-label': 'Opsi', 'aria-haspopup': 'menu', html: S('moreV') });
  const top = h('header', { class: 'vx-top' }, whoBtn, h('div', { class: 'spacer' }), trBtn, moreBtn, h('span', { class: 'only-mobile' }, ctx.shell.accountButton()));

  const hint = h('div', { class: 'vx-hint', hidden: true, role: 'note' });
  const you = h('div', { class: 'vx-you', 'aria-live': 'polite' });
  const stage = h('div', { class: 'vx-stage' }, hint, caps.el, caps.live);
  const big = Math.round(Math.min(236, Math.max(150, Math.min(innerWidth * 0.5, innerHeight * 0.25))));
  const theOrb = orb(orbSpecFor({ voiceId: DEFAULT_VOICE, name: 'chat' }), { size: big, cls: 'vx-orb' });
  const heard = h('span', { class: 'vx-heard', 'aria-hidden': 'true' });
  const orbBtn = h('button', { type: 'button', class: 'vx-orbbtn', 'aria-label': 'Bola persona' }, h('span', { class: 'vx-ring', 'aria-hidden': 'true' }), h('span', { class: 'vx-scan', 'aria-hidden': 'true' }), theOrb, heard);
  const toolRow = h('div', { class: 'vx-tools', 'aria-live': 'polite' });
  const status = h('div', { class: 'vx-status', 'aria-live': 'polite' });
  const orbWrap = h('div', { class: 'vx-orbwrap', 'data-hswipe': '1' }, you, orbBtn, toolRow, status);

  const input = h('textarea', { class: 'vx-input', rows: 1, placeholder: 'Ketik pesan...', 'aria-label': 'Pesan', enterkeyhint: 'send' }) as HTMLTextAreaElement;
  const micBtn = h('button', { type: 'button', class: 'vx-mic', 'aria-label': 'Tahan untuk bicara', title: 'Tahan untuk bicara (atau ketuk)', html: S('mic') });
  const micBars = h('span', { class: 'vx-bars', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
  const sendBtn = h('button', { type: 'submit', class: 'vx-send', 'aria-label': 'Kirim', html: S('arrowUp') });
  const form = h('form', { class: 'vx-bar' }, micBtn, input, sendBtn);
  const restartBar = h('div', { class: 'vx-ended', hidden: true }, ui.btn({ label: 'Mulai percakapan baru', icon: 'refresh', cls: 'primary', onClick: () => restart() }));
  const edge = h('div', { class: 'vx-edge', 'data-hswipe': '1', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'vx', 'data-state': 'idle' }, top, stage, orbWrap, h('div', { class: 'vx-bottom' }, form, restartBar), edge);
  root.append(wrap);

  /* ================= personas ================= */
  function buildPersonas() {
    personas = [...chars.map((c) => fromCharacter(c)), ...customPersonas().map(fromCustom)];
    const had = cur;
    if (cur) cur = personas.find((p) => p.id === cur!.id) || null;
    // the persona we are talking to was deleted (here or in another tab): stop it and move to another persona
    if (had && !cur) queueMicrotask(() => {
      stopAll();
      history.replaceState(null, '', '#/chat');
      onRoute({ name: 'chat', path: 'chat', params: new URLSearchParams() });
    });
  }
  function paintHead() {
    if (!cur) return;
    whoName.textContent = cur.name;
    const spec = orbSpecFor(cur);
    if (theOrb._spec?.key !== spec.key) morphOrb(theOrb, () => theOrb.setSpec(spec));
    orbBtn.setAttribute('aria-label', `Bola ${cur.name}. Ketuk untuk ganti persona, atau untuk menyela saat bicara.`);
    input.placeholder = log.verdict ? 'Percakapan selesai' : `Ketik untuk ${cur.name}...`;
  }

  /* ================= the turn-taking machine ================= */
  function newMachine(): DuplexMachine {
    const m = new DuplexMachine();
    m.onChange = (s, prev) => {
      if (s === 'interrupted') { if (intT) clearTimeout(intT); intT = setTimeout(() => { if (dm === m && m.state === 'interrupted') D({ type: 'timeout' }); }, 8000); }
      lastBusyAt = performance.now();
    };
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
      case 'duck': player.duck(); haptic(6); break;
      case 'unduck': player.unduck(); break;
      case 'decide': scheduleDecide(f); break;
      case 'cut': cutReply(); break;
      case 'cancel': cancelReply(); break;
      case 'send': void sendTurn(f.text, f.merge); break;
      case 'heard': flashHeard(); break;
      case 'drop': if (!input.value.trim()) hideYou(600); break;
    }
  }

  /* ================= state / loop ================= */
  const chatAmp = () => { const l = player.level(); return l.who === 'chat' ? l.amp : 0; };
  const toolRunning = () => !!R && !R.cut && R.tools.some((t) => t.status === 'start');
  function uiState(): UiState {
    if (rec && !convo) return 'ptt';
    return dm.state;
  }
  const orbLevel = () => {
    const s = uiState();
    if ((s === 'speaking' || s === 'ducked') && player.speaker === 'chat') return chatAmp() * (s === 'ducked' ? 0.45 : 1);
    if (toolRunning()) return think() * 0.55;
    if (s === 'thinking') return think() * 0.8;
    if (s === 'listening' || s === 'ptt' || s === 'interrupted') return micLevel * 0.7;
    return 0;
  };
  theOrb.setLive(true, orbLevel);
  // build the persona editor's GL program in the background now (idle time), so "Buat persona" opens at once
  {
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    const warm = () => prewarmForge();
    if (ric) ric(warm, { timeout: 3000 }); else setTimeout(warm, 1500);
  }
  // jelly: drag stretches the orb (a light drag swallows the click, so it never stops / opens anything); tap splashes
  jelly(theOrb, { target: orbBtn });

  function lastAssistant(): ChatMsg | null { const m = log.msgs[log.msgs.length - 1]; return m && m.role === 'assistant' ? m : null; }
  function canResume(): boolean {
    const m = lastAssistant();
    return !!(m?.interrupted && m.interrupted.unspokenText.trim() && !busy && !log.verdict && (dm.state === 'idle' || dm.state === 'listening'));
  }
  function paintState() {
    const s = uiState();
    const tool = toolRunning() ? R!.tools.find((t) => t.status === 'start')!.name : '';
    wrap.dataset.state = s === 'ptt' ? 'listening' : s;
    if (tool) wrap.dataset.tool = tool; else delete wrap.dataset.tool;
    wrap.classList.toggle('convo', convo && !!rec);
    const userTalking = !!uttId && (s === 'listening' || s === 'interrupted');
    wrap.classList.toggle('user-talk', userTalking);
    const label: Record<UiState, string> = {
      idle: '',
      ptt: recPhase === 'connecting' ? 'Menyambungkan mic...' : recPhase === 'finishing' ? 'Memproses...' : 'Mendengarkan...' + (recFallback ? ' (mode browser)' : ''),
      listening: recPhase === 'connecting' ? 'Menyambungkan mic...' : userTalking ? 'Aku dengar...' : 'Mendengarkan. Bicara kapan saja',
      thinking: tool ? '' : 'Berpikir',
      speaking: tool && player.speaker !== 'chat' ? '' : convo && rec ? 'Bicara saja untuk menyela' : 'Ketuk bola untuk menyela',
      ducked: dm.duckBy === 'typing' ? 'Tekan Enter untuk menyela' : 'Mendengarkanmu...',
      interrupted: 'Silakan, aku dengarkan',
    };
    const kids: Array<Node | string> = [label[s]];
    if (s === 'thinking' && !tool) kids.push(h('span', { class: 'vx-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')));
    if ((s === 'idle' || s === 'listening') && retry) kids.splice(0, kids.length, h('button', { type: 'button', class: 'btn sm soft', html: S('refresh'), onclick: () => { const r = retry; retry = null; r?.(); } }, h('span', null, 'Coba lagi')));
    else if (canResume() && !userTalking) {
      const b = h('button', { type: 'button', class: 'btn sm soft vx-resume', html: S('play') }, h('span', null, 'Lanjutkan'));
      b.onclick = () => resumeCut();
      kids.splice(0, kids.length, b);
    } else if (s === 'idle' && cur && !log.verdict && convo && convoPaused) kids.splice(0, kids.length, pausedText());
    else if (s === 'idle' && cur && !log.verdict && convo && !rec) kids.splice(0, kids.length, 'Ketuk mic untuk mulai Mode Percakapan');
    else if (s === 'idle' && cur && !log.verdict && caps.empty) kids.splice(0, kids.length, sttSupported() ? 'Tahan mic untuk bicara, atau ketik' : 'Ketik pesan untuk mulai');
    status.replaceChildren(...kids);
    paintBar();
    shown = s;
  }
  function pausedText(): string {
    return convoPaused === 'silence' ? 'Mode Percakapan dijeda karena hening. Ketuk mic untuk lanjut'
      : convoPaused === 'quota' ? 'Kuota input suara habis. Mode Percakapan berhenti'
        : convoPaused === 'error' ? 'Mic terputus. Ketuk mic untuk mencoba lagi'
          : convoPaused === 'hidden' ? 'Dijeda saat tab disembunyikan. Ketuk mic untuk lanjut'
            : 'Mode Percakapan dijeda. Ketuk mic untuk lanjut';
  }
  let raf = 0, lastBusyAt = performance.now();
  function loop() {
    raf = 0;
    const s = dm.state;
    // player -> machine: the reply is over (nothing queued / playing, stream finished)
    if ((s === 'speaking' || s === 'ducked' || s === 'thinking') && !busy && player.pending === 0) { if (R) R.endedAt = performance.now(); D({ type: 'quiet' }); }
    if (dm.state !== 'idle' && dm.state !== 'listening') lastBusyAt = performance.now();
    if (convo && !rec && !convoPaused && cur && !log.verdict && !document.hidden && !document.querySelector('.dlg') && (navigator as any).userActivation?.hasBeenActive !== false) startConvo();
    if (uiState() !== shown) paintState();
    if (player.pending > 0) caps.tick(player.speechNow(), chatAmp());
    if (dm.state !== 'idle' || caps.pending() || player.pending > 0) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
  // test hooks (read-only): word reveal log, audio clock, machine trace, decisions, the cut point
  (window as any).__caps = caps;
  (window as any).__chatClock = () => { const n = player.speechNow(); return n ? { sid: n.sid, t: n.t, final: n.final, dur: n.dur, amp: player.level().amp } : null; };
  (window as any).__duplex = () => ({ state: dm.state, ui: uiState(), trace: dm.trace.slice(-60), decisions: decideLog.slice(-20), gain: player.gainTarget, cuts: cutLog.slice(-10), sends: sendLog.slice(-10), echo: echoLog.slice(-20), convo, paused: convoPaused, rec: !!rec, utt: uttId });
  const cutLog: Array<{ spoken: string; unspoken: string; words: number; at: number; t: number | null }> = [];
  const sendLog: Array<{ text: string; merge: boolean; hint?: string; at: number }> = [];
  const echoLog: Array<{ text: string; at: number }> = [];

  /* ================= speaking ================= */
  function speakChunk(r: Reply, raw: string, start: number, sid: string, myGen: number) {
    const t = raw.trim();
    if (!t || !/[\p{L}\p{N}]/u.test(t.replace(/\[[^\]]*\]/g, ''))) return;
    r.chunks.push({ sid, start: start + (raw.length - raw.trimStart().length), raw: t });
    caps.add(sid, t);
    caps.speed = settings.tune().speed || 1;
    player.speak(ttsText(r.p, t), {
      voiceId: r.p.voiceId || DEFAULT_VOICE, who: 'chat', meta: { sid, a: 0, b: t.length },
      onStart: () => { if (myGen === gen) D({ type: 'audible' }); kick(); },
      onEnd: (ok) => {
        if (myGen !== gen) return;
        if (ok) caps.finish(sid);
        else { caps.fail(sid); audioFailed(); }
        kick();
      },
    });
    kick();
  }
  function audioFailed() {
    if (Date.now() - failToast < 6000) return;
    failToast = Date.now();
    const why = player.err ? player.err.trim().replace(/([^.!?])$/, '$1.') + ' ' : '';
    ui.toast(why + 'Teks balasan ditampilkan tanpa suara.', { kind: 'warn', title: 'Suara tidak bisa diputar' });
  }
  /** Speak a whole text at once (greeting). `msg` = its message in the log (for the cut point). */
  function speakText(p: Persona, text: string, msg: ChatMsg | null) {
    const myGen = gen;
    const id = 'g' + Date.now().toString(36);
    const r: Reply = { id, p, gen: myGen, full: text, chunks: [], msg, base: null, tools: [], cut: false, cancelled: false, endedAt: 0 };
    R = r;
    caps.block(id);
    let pos = 0;
    ctx.text.splitChunks(text.trim(), 400).forEach((part, i) => {
      const at = text.indexOf(part, pos); const start = at >= 0 ? at : pos; pos = start + part.length;
      speakChunk(r, part, start, `${id}:${i}`, myGen);
    });
    D({ type: 'think' });
  }

  /** What has really been said out loud in reply r (raw, with tags) and the rest, from the caption reveal state. */
  function progress(r: Reply, rev = caps.revealed()): { spokenRaw: string; unspokenRaw: string; words: number } {
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
  /** Assistant text around the audio position (echo reference): recent spoken words + a few ahead. */
  function echoRef(): string {
    const r = R;
    if (!r) return '';
    const { spokenRaw, unspokenRaw } = progress(r);
    const sp = words(spokenRaw);
    return [...sp.slice(-40), ...words(unspokenRaw).slice(0, 8)].join(' ');
  }
  const echoWindow = () => !!R && (dm.state === 'speaking' || dm.state === 'ducked' || player.speaker === 'chat' || performance.now() - (R.endedAt || 0) < 2500);

  /** yield / stop: fade out, drop queued TTS + the LLM stream, keep the exact cut point on the assistant message. */
  function cutReply() {
    const r = R;
    gen++;
    chatCtrl?.abort(); chatCtrl = null; busy = false;
    const now = player.speechNow();
    const rev = caps.cut();
    void player.fadeStop(110);
    haptic();
    if (!r || r.cut || r.cancelled) return;
    r.cut = true;
    const pr = progress(r, rev);
    cutLog.push({ spoken: plain(pr.spokenRaw), unspoken: plain(pr.unspokenRaw), words: pr.words, at: Date.now(), t: now ? now.t : null });
    if (!pr.words) {
      // nothing was heard: as if the reply never started -> the next words join the user's last message
      if (r.msg && !r.base) { const i = log.msgs.indexOf(r.msg); if (i >= 0) log.msgs.splice(i, 1); }
      forceMerge = !r.base && log.msgs[log.msgs.length - 1]?.role === 'user';
      if (cur) saveLog(cur.id, log);
      return;
    }
    const spokenRaw = pr.spokenRaw.trim();
    if (r.base) {
      const m = r.base.msg;
      m.content = `${r.base.prefix} ${spokenRaw}`.trim();
      m.interrupted = { spokenText: plain(m.content), unspokenText: plain(pr.unspokenRaw) };
      m.resumed = true;
      if (r.tools.length) m.tools = [...(m.tools || []), ...r.tools];
    } else {
      const m: ChatMsg = r.msg || { role: 'assistant', content: '' };
      m.content = spokenRaw;
      m.interrupted = { spokenText: plain(spokenRaw), unspokenText: plain(pr.unspokenRaw) };
      if (r.tools.length) m.tools = r.tools;
      if (!r.msg) { log.msgs.push(m); r.msg = m; }
    }
    if (cur) saveLog(cur.id, log);
  }
  /** A reply that was not audible yet is cancelled (the user kept talking): it never happened. */
  function cancelReply() {
    const r = R;
    gen++;
    chatCtrl?.abort(); chatCtrl = null; busy = false;
    player.stop(); caps.cancelPending();
    if (r) {
      r.cancelled = true;
      if (r.msg && !r.base) { const i = log.msgs.indexOf(r.msg); if (i >= 0) log.msgs.splice(i, 1); }
      if (cur) saveLog(cur.id, log);
    }
    R = null;
    clearTools();
  }
  /** Stop everything at once (switching persona, leaving). */
  function stopAll() {
    gen++; chatCtrl?.abort(); chatCtrl = null; busy = false; player.stop(); caps.cancelPending();
    const r = rec; rec = null; r?.abort();
    R = null; uttId = 0; dm = newMachine(); clearDecide(); clearTools();
  }

  /* ================= conversation ================= */
  function open(id: string) {
    stopAll();
    const p = personas.find((x) => x.id === id) || null;
    const switched = !!cur && !!p && cur.id !== p.id;
    cur = p;
    caps.clear(); hideYou(0); retry = null;
    if (!p) return;
    ctx.shell.setTitle(p.name);
    setChatPrefs({ last: p.id });
    log = loadLog(p.id);
    paintHead();
    // a persona picked in the list (or "Ngobrol" after creating one): its orb lands here
    void receiveOrb(theOrb);
    if (switched) enter(stage, { dy: 8, ms: 300 });
    if (log.verdict) showVerdict(log.verdict);
    else if (!log.msgs.length) {
      const g = greetingFor(p);
      if (g) {
        const m: ChatMsg = { role: 'assistant', content: g };
        log.msgs.push(m); saveLog(p.id, log);
        const active = (navigator as any).userActivation?.hasBeenActive;
        if (active) speakText(p, g, m); else { caps.block('greet'); caps.show(g); }
      }
    } else {
      const last = [...log.msgs].reverse().find((m) => m.role === 'assistant');
      if (last) { caps.block('prev', 'prev'); caps.show(last.content); }
    }
    restartBar.hidden = !log.verdict; form.hidden = !!log.verdict;
    paintState(); kick();
  }
  function restart() {
    if (!cur) return;
    stopAll();
    settings.local.remove('chat.log.' + cur.id);
    log = { msgs: [] };
    caps.clear();
    const g = greetingFor(cur);
    if (g) { const m: ChatMsg = { role: 'assistant', content: g }; log.msgs.push(m); saveLog(cur.id, log); speakText(cur, g, m); }
    restartBar.hidden = true; form.hidden = false;
    paintHead(); paintState(); kick();
  }
  function showVerdict(v: Verdict) {
    caps.block('verdict', 'verdict');
    const head = v.decision === 'hangup' ? `${cur?.name || 'Persona'} menutup telepon.` : v.decision === 'passed' ? 'Lolos interview.' : 'Interview berakhir: ditolak.';
    caps.show([head, v.reason || '', v.feedback || ''].filter(Boolean).join(' '));
    restartBar.hidden = false; form.hidden = true;
    if (rec) { const r = rec; rec = null; r.abort(); }
    paintHead();
  }

  /** The machine decided the user's turn is `text` (voice or typed). merge = join the user's last message (the reply to
      it was cancelled before it could be heard). After an interruption, /decide tells whether to resume the cut reply. */
  async function sendTurn(text: string, merge: boolean) {
    text = text.trim();
    const p = cur;
    if (!text || !p || log.verdict) { if (dm.state === 'thinking' && !busy) D({ type: 'quiet' }); return; }
    if (input.value.trim() === text) { input.value = ''; autosize(); }
    showYou(text, true);
    const lastMsg = log.msgs[log.msgs.length - 1];
    const merged = (merge || forceMerge) && lastMsg?.role === 'user';
    if (merged) lastMsg.content = `${lastMsg.content} ${text}`.trim();
    else log.msgs.push({ role: 'user', content: text });
    forceMerge = false;
    saveLog(p.id, log);
    // the reply just before was cut off: should the persona resume it (continue / rephrase / drop)?
    const prev = log.msgs[log.msgs.length - 2];
    let hint: ResumeHint | undefined;
    const myGen = gen;
    if (prev?.role === 'assistant' && prev.interrupted?.unspokenText.trim() && words(text).length <= 14) {
      busy = true; paintState();
      try {
        const d = await decide({ personaName: p.name, state: 'listening', spoken: prev.interrupted.spokenText, remaining: prev.interrupted.unspokenText, userPartial: text, userFinal: true, lang: p.lang === AUTO ? undefined : langName(p.lang) }, { timeoutMs: 1500 });
        if (d.action === 'resume') hint = d.resume || 'continue';
      } catch { /* aborted */ }
      busy = false;
      if (myGen !== gen || cur !== p) return;           // the user talked again meanwhile
    }
    sendLog.push({ text, merge: merged, hint, at: Date.now() });
    await reply(p, { resumeHint: hint });
  }
  /** "Lanjutkan": continue the cut-off reply from where it stopped. */
  function resumeCut() {
    const m = lastAssistant();
    if (!cur || !m?.interrupted) return;
    hideYou();
    void reply(cur, { resumeHint: 'continue', base: m });
  }
  async function reply(p: Persona, o: { resumeHint?: ResumeHint; base?: ChatMsg } = {}) {
    const myGen = ++gen;
    retry = null;
    clearTools();
    busy = true; chatCtrl = new AbortController();
    const rid = 'r' + Date.now().toString(36);
    const r: Reply = { id: rid, p, gen: myGen, full: '', chunks: [], msg: null, base: o.base ? { msg: o.base, prefix: o.base.content } : null, tools: [], cut: false, cancelled: false, endedAt: 0 };
    R = r;
    D({ type: 'think' });
    caps.block(rid);
    let n = 0, at = 0;
    const live = () => myGen === gen && cur === p && !r.cut && !r.cancelled;
    const chunks = ctx.text.chunker((s) => { const start = at; at += s.length; if (live()) speakChunk(r, s, start, `${rid}:${n++}`, myGen); }, 160, 40);
    let replyText = '', verdict: Verdict | null = null, err: any = null;
    try {
      const res = await streamChat({
        persona: p, messages: log.msgs, speak: true, signal: chatCtrl.signal,
        resumeHint: o.resumeHint, webSearch: chatPrefs().webSearch !== false,
        onText: (d, full) => { replyText = full; r.full = full; chunks.push(d); },
        onTool: (t) => { if (live()) onTool(r, t, () => chunks.flush(true)); },
      });
      replyText = res.reply; verdict = res.verdict; r.full = replyText;
    } catch (e: any) { err = e; }
    if (live() && (!err || replyText)) chunks.flush();
    if (replyText && !r.cut && !r.cancelled) {
      if (r.base) {
        const m = r.base.msg;
        m.content = `${r.base.prefix} ${replyText}`.trim();
        delete m.interrupted; m.resumed = true;
        if (r.tools.length) m.tools = [...(m.tools || []), ...r.tools];
        r.msg = m;
      } else {
        const m: ChatMsg = { role: 'assistant', content: replyText, ...(r.tools.length ? { tools: r.tools } : {}) };
        log.msgs.push(m); r.msg = m;
      }
    }
    if (verdict && !r.cancelled) log.verdict = verdict;
    if (!r.cancelled) saveLog(p.id, log);
    if (myGen !== gen || cur !== p) return;              // interrupted / switched persona
    busy = false; chatCtrl = null;
    if (err && err.code !== 'aborted' && !replyText) {
      ui.toast(err.message || String(err), { kind: 'bad', title: 'Balasan gagal' });
      retry = () => { if (!busy && cur === p) reply(p, o); };
    }
    if (verdict) { await player.waitIdle(60000); if (cur === p) showVerdict(verdict); }
    kick(); paintState();
  }

  /* ================= tools (web search) ================= */
  function onTool(r: Reply, t: ToolEvent, flushIntro: () => void) {
    const i = r.tools.findIndex((x) => x.id === t.id);
    if (i >= 0) r.tools[i] = { ...r.tools[i], ...t, query: t.query || r.tools[i].query }; else r.tools.push(t);
    if (t.status === 'start') flushIntro();         // the "let me look that up" sentence is spoken now, not after the search
    if (t.status === 'error') {
      const m = toolMeta(t.name);
      ui.toast(isQuota(t) ? 'Kuota pencarian web hari ini habis. Persona menjawab tanpa mencari.' : (t.error || 'Persona menjawab tanpa hasil pencarian.'), { kind: 'warn', title: isQuota(t) ? m.quota : m.failed });
    }
    if (t.status !== 'start') ctx.data.refreshMe(1500);
    paintTools(r);
    paintState(); kick();
  }
  function paintTools(r: Reply | null) {
    toolRow.replaceChildren(...(r ? r.tools.map((t) => toolChip(t)) : []));
  }
  function clearTools() { toolRow.replaceChildren(); delete wrap.dataset.tool; }

  /* ================= duplex: decisions ================= */
  let decideT: ReturnType<typeof setTimeout> | null = null;
  let pendingDecide: { utt: number; text: string; final: boolean } | null = null;
  let inflight = 0;
  let lastAsked = '';
  function clearDecide() { if (decideT) clearTimeout(decideT); decideT = null; pendingDecide = null; lastAsked = ''; }
  function scheduleDecide(f: { utt: number; text: string; final: boolean }) {
    pendingDecide = f;
    if (f.final) { if (decideT) clearTimeout(decideT); decideT = null; void fireDecide(); return; }
    if (!decideT) decideT = setTimeout(() => { decideT = null; void fireDecide(); }, 200);   // debounce partials
  }
  async function fireDecide() {
    const f = pendingDecide; pendingDecide = null;
    if (!f || !cur) return;
    const key = `${f.utt}|${f.final}|${f.text}`;
    if (key === lastAsked) return;
    if (inflight && !f.final) { pendingDecide = f; return; }       // one partial request at a time; the newest waits
    lastAsked = key;
    // unmistakable cut-in ("wait", "stop", "wait, ..."): act now, no round trip
    const fast = fastDecide(f.text);
    if (fast) {
      decideLog.push({ personaName: cur.name, state: 'speaking', spoken: '', userPartial: f.text, userFinal: f.final, res: { ...fast, source: 'fast', ms: 0 }, at: Date.now() });
      D({ type: 'decision', utt: f.utt, d: fast, text: f.text, final: f.final });
      return;
    }
    const r = R;
    const pr = r ? progress(r) : { spokenRaw: '', unspokenRaw: '', words: 0 };
    inflight++;
    let res;
    try {
      res = await decide({
        personaName: cur.name, state: 'speaking',
        spoken: plain(pr.spokenRaw), remaining: plain(pr.unspokenRaw),
        userPartial: f.text, userFinal: f.final, speechMs: uttStart ? Math.round(performance.now() - uttStart) : undefined,
        lang: cur.lang === AUTO ? undefined : langName(cur.lang),
      });
    } finally { inflight--; }
    D({ type: 'decision', utt: f.utt, d: res, text: f.text, final: f.final });
    if (pendingDecide && !decideT) void fireDecide();
  }
  function flashHeard() {
    heard.classList.remove('on'); void heard.offsetWidth; heard.classList.add('on');
    setTimeout(() => heard.classList.remove('on'), 1200);
  }

  /* ================= the user's words: small, dim, brief ================= */
  let youT: ReturnType<typeof setTimeout> | null = null;
  function showYou(text: string, final: boolean) {
    you.textContent = text;
    you.classList.add('on');
    if (youT) clearTimeout(youT);
    youT = final ? setTimeout(() => hideYou(), 3800) : null;
  }
  function hideYou(ms = 0) { if (youT) clearTimeout(youT); youT = null; if (ms) youT = setTimeout(() => you.classList.remove('on'), ms); else you.classList.remove('on'); }

  /* ================= Mode Percakapan: one open Scribe session ================= */
  let uttSeq = 0, uttId = 0, uttStart = 0, uttHasText = false;
  let loudSince = 0, lastLoud = 0, lastSound = 0, voiceFired = false, hushT: ReturnType<typeof setTimeout> | null = null;
  let lastUserAt = performance.now();
  const SILENCE_PAUSE_MS = 60_000;
  function openUtt() { if (!uttId) { uttId = ++uttSeq; uttStart = performance.now(); uttHasText = false; } return uttId; }
  function onMicLevel(l: number) {
    micLevel = l;
    if (!convo) return;
    const now = performance.now();
    // the assistant's own voice leaks into the mic (no headphones): a louder voice is needed while it talks
    const out = player.speaker === 'chat' ? chatAmp() * player.gainTarget : 0;
    const thr = 0.3 + 0.55 * out;
    if (l > 0.16 + 0.4 * out) lastSound = now;
    if (l > thr) {
      if (!loudSince) loudSince = now;
      lastLoud = now;
      if (!voiceFired && now - loudSince >= 250) {          // ignore < 250 ms (clicks, coughs)
        voiceFired = true; lastUserAt = now;
        const id = openUtt();
        if (dm.state === 'speaking') D({ type: 'voice', utt: id });
        if (hushT) clearTimeout(hushT);
        hushT = setTimeout(() => { hushT = null; if (uttId === id && !uttHasText) { D({ type: 'hush', utt: id }); uttId = 0; } }, 1400);
      }
    } else if (loudSince && now - lastLoud > 350) { loudSince = 0; voiceFired = false; }
  }
  function onConvoPartial(t: string) {
    t = t.trim();
    if (!t) return;
    if (echoWindow() && isEcho(t, echoRef())) { echoLog.push({ text: t, at: Date.now() }); if (echoLog.length > 50) echoLog.shift(); return; }
    // words with no voice energy behind them (transcriber hallucination on silence / far noise) are ignored
    if (performance.now() - lastSound > 3000) { echoLog.push({ text: '(no voice) ' + t, at: Date.now() }); return; }
    lastUserAt = performance.now();
    const id = openUtt(); uttHasText = true;
    showYou(t, false);
    D({ type: 'partial', utt: id, text: t });
  }
  function onConvoFinal(t: string) {
    t = t.trim();
    const id = uttId || ++uttSeq;
    uttId = 0; uttHasText = false;
    if (!t) return;
    if (echoWindow() && isEcho(t, echoRef())) { echoLog.push({ text: '(final) ' + t, at: Date.now() }); return; }
    if (performance.now() - lastSound > 5000) { echoLog.push({ text: '(final, no voice) ' + t, at: Date.now() }); return; }
    lastUserAt = performance.now();
    D({ type: 'final', utt: id, text: t });
    if (dm.state !== 'thinking' && dm.state !== 'ducked') hideYou(1500);
  }
  function startConvo() {
    if (!cur || log.verdict || rec) return;
    if (!sttSupported()) { convoPaused = 'error'; ui.toast('Browser ini tidak bisa merekam suara.', { kind: 'warn' }); paintState(); return; }
    convoPaused = '';
    recPhase = 'connecting'; micLevel = 0; lastUserAt = performance.now();
    const session: SttSession = startStt({
      lang: cur.lang === AUTO ? '' : sttLocale(cur.lang),
      mode: 'vad', continuous: true, fallback: false, vadSilenceSec: 0.8,
      onState: (s) => { if (rec !== session) return; recPhase = s; paintState(); },
      onLevel: (l) => { if (rec === session) onMicLevel(l); },
      onPartial: (t) => { if (rec === session) onConvoPartial(t); },
      onFinal: (t) => { if (rec === session) onConvoFinal(t); },
      onEnd: () => {
        if (rec !== session) return;
        rec = null; micLevel = 0; uttId = 0;
        if (!convoPaused) convoPaused = 'error';
        D({ type: 'mic', on: false });
      },
      onError: (code, m) => {
        if (rec !== session) return;
        convoPaused = code === 'quota' ? 'quota' : 'error';
        if (code !== 'quota') ui.toast(m, { kind: 'warn', title: code === 'quota' ? 'Kuota input suara' : code.startsWith('mic') ? 'Mikrofon' : 'Mode Percakapan' });
      },
    });
    rec = session;
    D({ type: 'mic', on: true });
  }
  function pauseConvo(why: typeof convoPaused) {
    convoPaused = why;
    if (rec) { const r = rec; rec = null; r.abort(); }
    micLevel = 0; uttId = 0;
    D({ type: 'mic', on: false });
  }
  function setConvo(on: boolean) {
    convo = on;
    setChatPrefs({ convo: on });
    if (on) {
      if (rec) { const r = rec; rec = null; r.abort(); }
      convoPaused = '';
      startConvo();
      showHint();
      ui.toast('Mode Percakapan nyala: bicara kapan saja, juga saat persona sedang bicara.', { kind: 'ok', timeout: 3200 });
    } else {
      pauseConvo('user'); convoPaused = '';
      hint.hidden = true;
      ui.toast('Mode Percakapan mati: tahan atau ketuk mic untuk bicara.', { kind: 'ok', timeout: 2400 });
    }
    paintState(); kick();
  }
  function sttLeft(): number | null {
    const q = ctx.store.get().me?.quota?.stt;
    return q ? Math.max(0, (q.limit ?? 0) - (q.used ?? 0)) : null;
  }
  let hintT: ReturnType<typeof setTimeout> | null = null;
  function searchSub(): string {
    const q = ctx.store.get().me?.quota?.search;
    return q && q.limit > 0 ? `Persona boleh mencari info terbaru · sisa ${Math.max(0, q.limit - q.used)}` : 'Persona boleh mencari info terbaru';
  }
  function showHint() {
    const left = sttLeft();
    const x = h('button', { type: 'button', class: 'vx-hint-x', 'aria-label': 'Tutup', html: S('x') });
    hint.replaceChildren(h('span', { class: 'vx-hint-ic', html: S('headset') }),
      h('span', { class: 'vx-hint-t' }, h('b', null, 'Pakai headphone untuk hasil terbaik.'), ' Tanpa headphone, suara persona bisa terdengar lagi oleh mic.',
        left != null ? h('small', null, ` Sisa input suara hari ini: ${fmtMin(left)}.`) : null), x);
    hint.hidden = chatPrefs().hpHint === true;
    x.onclick = () => { hint.hidden = true; setChatPrefs({ hpHint: true }); };
    if (hintT) clearTimeout(hintT);
    hintT = setTimeout(() => { hint.hidden = true; }, 12000);
  }
  // long silence: close the session (saves STT quota); the tab hidden: pause too
  const silenceT = setInterval(() => {
    if (!convo || !rec) return;
    const now = performance.now();
    if ((dm.state === 'listening' || dm.state === 'idle') && now - Math.max(lastUserAt, lastBusyAt) > SILENCE_PAUSE_MS) pauseConvo('silence');
  }, 1000);
  const onVis = () => { if (document.hidden && convo && rec && (dm.state === 'listening' || dm.state === 'idle')) pauseConvo('hidden'); };
  document.addEventListener('visibilitychange', onVis);
  // the conversation mic may only open after a user gesture: the first tap / key anywhere starts it
  const onGesture = () => { if (convo && !rec && !convoPaused) kick(); };
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  /* ================= mic: hold to talk, or tap to toggle (Mode Percakapan: tap = pause / resume) ================= */
  // push-to-talk: manual commit on release -> one final text -> the machine sends it.
  function startListening() {
    if (!cur || log.verdict) return;
    if (!sttSupported()) { ui.toast('Browser ini tidak bisa merekam suara. Ketik pesanmu.', { kind: 'warn' }); input.focus(); return; }
    const s0 = dm.state;
    if (s0 === 'speaking' || s0 === 'ducked' || s0 === 'thinking') D({ type: 'stop' }); else if (player.busy) player.stop();
    rec?.abort();
    let got = false;
    recPhase = 'connecting'; recFallback = false; micLevel = 0;
    const session: SttSession = startStt({
      lang: cur.lang === AUTO ? '' : sttLocale(cur.lang),
      mode: 'ptt',
      onState: (s) => { if (rec !== session && s !== 'connecting') return; recPhase = s; paintState(); },
      onLevel: (l) => { micLevel = l; },
      onPartial: (t) => { if (rec !== session) return; if (t) showYou(t, false); },
      onFinal: (t) => {
        if (rec !== session || got || !t.trim()) return;
        got = true;
        rec = null;
        D({ type: 'final', utt: ++uttSeq, text: t });
      },
      onEnd: () => {
        if (rec === session) rec = null;
        if (got) prewarmStt();   // the next turn will likely use the mic again
        micLevel = 0;
        if (!got) hideYou();
        kick(); paintState();
      },
      onError: (code, m) => { if (code !== 'quota') ui.toast(m, { kind: code === 'fallback' ? 'info' : 'warn', title: code.startsWith('mic') ? 'Mikrofon' : undefined }); },
      onFallback: () => { recFallback = true; paintState(); },
    });
    rec = session;
    kick(); paintState();
  }
  function stopListening() { rec?.stop(); }
  let pressT = 0;
  micBtn.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    if (convo) {                         // tap = pause / resume Mode Percakapan
      pressT = 0;
      if (rec) pauseConvo('user'); else { convoPaused = ''; startConvo(); }
      paintState(); kick();
      return;
    }
    if (rec) { stopListening(); pressT = 0; return; }
    startListening();
    pressT = performance.now();
    try { micBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  const release = () => { if (pressT && performance.now() - pressT > 380 && rec) stopListening(); pressT = 0; };
  micBtn.addEventListener('pointerup', release);
  micBtn.addEventListener('pointercancel', release);
  micBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  micBtn.addEventListener('click', (e) => {   // keyboard
    if (e.detail !== 0) return;
    if (convo) { if (rec) pauseConvo('user'); else { convoPaused = ''; startConvo(); } return; }
    if (rec) stopListening(); else startListening();
  });

  /* ================= input bar (text duplex) ================= */
  function paintBar() {
    const talking = busy || player.pending > 0 || dm.state === 'speaking' || dm.state === 'ducked';
    const typed = !!input.value.trim();
    const stop = talking && !typed;
    sendBtn.innerHTML = S(stop ? 'stop' : 'arrowUp');
    sendBtn.classList.toggle('stop', stop);
    sendBtn.setAttribute('aria-label', stop ? 'Hentikan' : 'Kirim');
    sendBtn.disabled = !cur || (!stop && !typed);
    const live = convo && !!rec;
    micBtn.classList.toggle('rec', !!rec && !convo);
    micBtn.classList.toggle('convo', convo);
    micBtn.classList.toggle('live', live);
    if (convo) {
      if (!micBtn.contains(micBars)) { micBtn.innerHTML = S('waveform'); micBtn.append(micBars); }
      const lbl = live ? 'Mode Percakapan aktif. Ketuk untuk jeda' : 'Mode Percakapan dijeda. Ketuk untuk lanjut';
      micBtn.setAttribute('aria-label', lbl); micBtn.title = lbl;
    } else if (micBtn.contains(micBars)) {
      micBtn.innerHTML = S('mic');
      micBtn.setAttribute('aria-label', 'Tahan untuk bicara'); micBtn.title = 'Tahan untuk bicara (atau ketuk)';
    }
    micBtn.setAttribute('aria-pressed', String(!!rec));
    micBtn.disabled = !cur || !!log.verdict;
    input.disabled = !cur || !!log.verdict;
  }
  // live level bars on the conversation pill
  const barT = setInterval(() => {
    if (!convo || !rec) return;
    const l = Math.min(1, micLevel * 1.4);
    micBars.style.setProperty('--l', l.toFixed(2));
  }, 90);
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 96) + 'px'; }
  const typingNow = () => !!input.value.trim() && document.activeElement === input;
  let typingWas = false;
  const typing = (on: boolean) => { if (on !== typingWas || (on && dm.state === 'speaking')) { typingWas = on; D({ type: 'typing', on }); } else paintBar(); };
  input.addEventListener('input', () => { autosize(); typing(typingNow()); });
  input.addEventListener('focus', () => { if (typingNow()) typing(true); });
  input.addEventListener('blur', () => typing(false));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitText(); } });
  function submitText() {
    const t = input.value.trim();
    if (!t || !cur || log.verdict) return;
    D({ type: 'submit', text: t });
  }
  // keep the keyboard (and the layout) steady: tapping send must not steal focus from the textarea
  for (const ev of ['pointerdown', 'mousedown'] as const) sendBtn.addEventListener(ev, (e) => { if (document.activeElement === input) e.preventDefault(); });
  form.onsubmit = (e) => {
    e.preventDefault();
    if (!input.value.trim()) {
      const s0 = dm.state;
      if (s0 === 'speaking' || s0 === 'ducked' || s0 === 'thinking') D({ type: 'stop' }); else if (player.busy) player.stop();
      return;
    }
    submitText();
  };

  /* ================= orb: tap / swipe up ================= */
  orbBtn.onclick = () => {
    const s = uiState();
    if (s === 'speaking' || s === 'ducked' || s === 'thinking') {
      D({ type: 'stop' });
      if (!convo) { if (sttSupported()) startListening(); else input.focus(); }
    } else if (s === 'ptt') stopListening();
    else openPersonaSheet();
  };
  drag(orbWrap, {
    axis: 'y', mouse: true, slop: 8,
    onStart: (s) => s.dy < 0,
    onMove: () => { /* the jelly orb itself follows the finger */ },
    onEnd: (s, cancelled) => {
      const go = !cancelled && (s.dy < -56 || (s.vy < -0.5 && s.dy < -24));
      if (go) { haptic(); openPersonaSheet(); }
    },
  });
  drag(edge, {
    axis: 'x',
    onStart: (s) => s.dx > 0,
    onMove: (s) => { wrap.style.transform = `translate3d(${rubber(s.dx, 50)}px,0,0)`; },
    onEnd: async (s, cancelled) => {
      await settle(wrap, 'translate3d(0,0,0)', 180); wrap.style.transform = '';
      if (!cancelled && (s.dx > 60 || (s.vx > 0.5 && s.dx > 30))) { haptic(); openPersonaSheet(); }
    },
  });
  whoBtn.onclick = () => openPersonaSheet();
  addEventListener('keydown', onKey, true);   // capture: runs before a popover's own Esc handler removes it
  function onKey(e: KeyboardEvent) {
    const s = dm.state;
    if (e.key === 'Escape' && (s === 'speaking' || s === 'ducked' || s === 'thinking') && !document.querySelector('.dlg, .menu')) { e.preventDefault(); D({ type: 'stop' }); }
  }

  /* ================= sheets ================= */
  function openPersonaSheet() {
    const list = h('div', { class: 'ps-list', role: 'list' });
    let curRowOrb: HTMLElement | null = null, picking = false;
    /** an action from a row; "Edit" opens the persona forge: that row's orb grows into it (connected transition) */
    const runAct = (a: { icon: string; run: () => void }, rowOrb: HTMLElement) => {
      if (a.icon === 'edit') { picking = true; const g = orbGhost(rowOrb); m.close(); if (g) handOff(g); a.run(); return; }
      m.close(); a.run();
    };
    const paint = () => {
      const rows: Node[] = [];
      if (!loaded) rows.push(...[0, 1, 2].map(() => h('div', { class: 'skel', style: 'height:60px;margin:4px 0' })));
      if (charsErr) rows.push(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, `Gagal memuat persona: ${charsErr}`)));
      for (const p of personas) {
        const rowOrb = orb(orbSpecFor(p), { size: 46 });
        if (cur?.id === p.id) curRowOrb = rowOrb;
        const main = h('button', { type: 'button', class: 'ps-main', 'aria-current': cur?.id === p.id ? 'true' : null },
          rowOrb,
          h('span', { class: 'ps-t' }, h('b', null, p.name), h('span', null, p.builtin ? 'Persona bawaan' : (p.sub || 'Persona buatanmu'))),
          cur?.id === p.id ? h('span', { class: 'ps-on', html: S('check') }) : null);
        main.onclick = () => {
          if (cur?.id === p.id) { m.close(); return; }   // same persona: the orb flies back (onClose)
          // shared element: this row's orb flies onto the big orb of the chat while the persona changes
          picking = true;
          const g = orbGhost(rowOrb);
          m.close();
          if (g) handOff(g);
          ctx.navigate('chat/' + encodeURIComponent(p.id));
          setTimeout(() => { if (theOrb.style.visibility === 'hidden' && !document.querySelector('.orb-ghost')) theOrb.style.visibility = ''; }, 900);
        };
        const more = h('button', { type: 'button', class: 'btn icon ghost ps-more', 'aria-label': `Aksi untuk ${p.name}`, 'aria-haspopup': 'menu', html: S('moreV') });
        more.onclick = (e) => { e.stopPropagation(); ui.popover(more, h('div', null, ...actions(p).map((a) => ui.menuItem(a.label, a.icon, () => runAct(a, rowOrb), a.cls || ''))), { align: 'end' }); };
        const host = swipeRow(h('div', { class: 'ps-row' }, main, more), actions(p).map((a) => ({ ...a, run: () => runAct(a, rowOrb) })), S);
        host.setAttribute('role', 'listitem');
        rows.push(host);
      }
      list.replaceChildren(...rows);
    };
    const mk = h('button', { type: 'button', class: 'btn primary block lg', html: S('plus') }, h('span', null, 'Buat persona'));
    const cl = h('a', { class: 'btn soft block', href: '#/voices/clone', html: S('mic') }, h('span', null, 'Clone suaramu dulu'));
    const m = ui.modal({ title: 'Persona', cls: 'ps-dlg', body: h('div', { class: 'ps' }, list, h('div', { class: 'ps-new' }, mk, cl), h('p', { class: 'ps-tip' }, 'Geser persona ke kiri untuk edit, bola, atau hapus.')),
      // closing without a pick: the active row's orb flies back into the big orb
      onClose: () => { if (!picking) { if (curRowOrb?.isConnected && theOrb.style.visibility === 'hidden') void flyOrb(curRowOrb, theOrb); else theOrb.style.visibility = ''; } } });
    mk.onclick = () => {
      picking = true;
      // a new, still empty orb grows from the button into the persona forge
      const ic = (mk.querySelector('svg') || mk) as HTMLElement, r = ic.getBoundingClientRect();
      const seed = orb(emptyOrbSpec(), { size: Math.max(20, Math.round(r.width)), cls: 'orb-ghost', live: true });
      seed.style.left = r.left + 'px'; seed.style.top = r.top + 'px';
      document.body.append(seed); handOff(seed);
      m.close(); newPersona();
    };
    paint();
    // shared element: the big orb shrinks into the active persona's row (and comes back when the sheet closes)
    const cro = curRowOrb as HTMLElement | null;   // set by paint()
    if (cro && theOrb.isConnected) {
      // the active row in view first (scroll the sheet only, never the page)
      const sc = cro.closest('.dlg-b') as HTMLElement | null, row = cro.closest('.ps-row') as HTMLElement | null;
      if (sc && row) { const rr = row.getBoundingClientRect(), sr = sc.getBoundingClientRect(); if (rr.bottom > sr.bottom || rr.top < sr.top) sc.scrollTop += rr.top - sr.top - sr.height / 2 + rr.height / 2; }
      const g = orbGhost(theOrb); if (g) { theOrb.style.visibility = 'hidden'; handOff(g); void receiveOrb(cro); }
    }
    onDisconnect(list, settings.subscribe('chat.personas', () => { buildPersonas(); paint(); }));
  }
  function actions(p: Persona): Array<{ label: string; icon: string; cls?: string; run: () => void }> {
    const out: Array<{ label: string; icon: string; cls?: string; run: () => void }> = [
      p.builtin ? { label: 'Atur suara & bahasa', icon: 'sliders', run: () => tunePersona(p) } : { label: 'Edit', icon: 'edit', run: () => editPersona(p.custom!) },
      { label: 'Studio Bola', icon: 'palette', run: () => orbStudio(p) },
    ];
    if (!p.builtin) out.push({ label: 'Hapus', icon: 'trash', cls: 'danger', run: () => removePersona(p) });
    return out;
  }
  function openTranscript() {
    const items = log.msgs.filter((m) => visibleText(m.content).trim() || m.tools?.length);
    const row = (m: ChatMsg) => {
      const me = m.role === 'user';
      const tools = (m.tools || []).filter((t) => t.status !== 'start');
      const cut = !!m.interrupted;
      return h('div', { class: 'tr-m ' + (me ? 'me' : 'ai') + (cut ? ' cut' : '') },
        h('span', { class: 'tr-who' }, me ? 'Kamu' : cur?.name || 'Persona',
          !me && tools.some((t) => t.name === 'web_search' && t.status === 'done') ? h('span', { class: 'tr-tag', html: S('search') }, 'Dicari di web') : null,
          cut ? h('span', { class: 'tr-tag cut', title: 'Disela sebelum selesai bicara' }, 'terpotong') : null,
          m.resumed && !cut ? h('span', { class: 'tr-tag' }, 'dilanjutkan') : null),
        ...tools.map((t) => toolLine(t)),
        h('p', null, visibleText(m.content).trim() + (cut ? ' —' : '')));
    };
    const list = h('div', { class: 'tr', role: 'log', 'aria-label': 'Transkrip' },
      ...(items.length ? items.map(row) : [h('div', { class: 'empty', style: 'padding:28px 8px' }, h('p', null, 'Belum ada percakapan.'))]));
    const again = ui.btn({ label: 'Mulai ulang', icon: 'refresh', cls: 'ghost' });
    const m = ui.modal({ title: cur ? `Transkrip · ${cur.name}` : 'Transkrip', cls: 'tr-dlg', body: list, actions: [again] });
    again.onclick = async () => {
      m.close();
      if (log.msgs.length > 1 && !(await ui.confirm({ title: 'Mulai ulang?', message: 'Riwayat percakapan dengan persona ini dihapus dari perangkat ini.', confirm: 'Mulai ulang' }))) return;
      restart();
    };
    requestAnimationFrame(() => { const b = m.root.querySelector('.dlg-b'); if (b) b.scrollTop = b.scrollHeight; });
  }
  trBtn.onclick = openTranscript;
  moreBtn.onclick = () => {
    if (!cur) return;
    const p = cur;
    const web = chatPrefs().webSearch !== false;
    const left = sttLeft();
    const toggle = (label: string, sub: string, on: boolean, icon: string, fn: () => void) => {
      const b = h('button', { type: 'button', class: 'menu-item vx-toggle', role: 'menuitemcheckbox', 'aria-checked': String(on), html: S(icon) },
        h('span', { class: 'vx-tg-t' }, h('span', null, label), h('small', null, sub)), h('span', { class: 'vx-sw' + (on ? ' on' : ''), 'aria-hidden': 'true' }));
      b.onclick = fn;
      return b;
    };
    const box = h('div', null,
      toggle('Mode Percakapan', convo ? (left != null ? `Mic terbuka · sisa ${fmtMin(left)}` : 'Mic terbuka, bicara kapan saja') : 'Bicara kapan saja, bisa menyela', convo, 'waveform', () => setConvo(!convo)),
      ctx.store.get().me?.features?.webSearch === false ? null : toggle('Cari di web', web ? searchSub() : 'Mati: jawab dari pengetahuan sendiri', web, 'globe', () => {
        setChatPrefs({ webSearch: !web });
        ui.toast(!web ? 'Pencarian web nyala.' : 'Pencarian web mati.', { kind: 'ok', timeout: 1800 });
      }),
      h('div', { class: 'menu-sep' }),
      ui.menuItem('Ganti persona', 'users', () => openPersonaSheet()),
      ...actions(p).filter((a) => a.icon !== 'trash').map((a) => ui.menuItem(a.label === 'Edit' ? 'Edit persona' : a.label, a.icon, a.run)),
      ui.menuItem('Transkrip', 'history', openTranscript),
      ui.menuItem('Mulai ulang percakapan', 'refresh', async () => {
        if (log.msgs.length > 1 && !(await ui.confirm({ title: 'Mulai ulang?', message: 'Riwayat percakapan dengan persona ini dihapus dari perangkat ini.', confirm: 'Mulai ulang' }))) return;
        restart();
      }),
      p.builtin ? null : h('div', { class: 'menu-sep' }),
      p.builtin ? null : ui.menuItem('Hapus persona', 'trash', () => removePersona(p), 'danger'));
    ui.popover(moreBtn, box, { align: 'end' });
  };

  /* ================= editors ================= */
  async function removePersona(p: Persona) {
    if (!(await ui.confirm({ title: `Hapus "${p.name}"?`, message: 'Persona dan riwayat percakapannya dihapus.', confirm: 'Hapus', danger: true }))) return;
    deleteCustom(p.id); buildPersonas();   // if it was the open persona, buildPersonas() moves the chat to another one
    ui.toast('Persona dihapus.', { kind: 'ok' });
  }
  function orbStudio(p: Persona) {
    openOrbStudio({
      title: 'Studio Bola', subtitle: `Bola untuk ${p.name}`, initial: p.orb || null,
      base: orbSpecFor({ voiceId: p.voiceId, name: p.name }), seedKey: 'p:' + p.name.trim().toLowerCase(), resetLabel: 'Ikuti bola suara',
      onSave: (o) => { setPersonaOrb(p, o); buildPersonas(); paintHead(); ui.toast(o ? 'Bola tersimpan.' : 'Bola kembali mengikuti suaranya.', { kind: 'ok', timeout: 1800 }); },
    });
  }
  const langSelect = (v: string, auto = false) => {
    const s = h('select', { class: 'select' }, ...(auto ? [new Option(langLabel(AUTO), AUTO)] : []), ...LANGS.map(([k, l]) => new Option(l, k))) as HTMLSelectElement;
    s.value = v; return s;
  };
  const accentField = (v: string) => {
    const id = 'acc-' + Math.random().toString(36).slice(2, 7);
    const i = h('input', { class: 'input', value: v, placeholder: 'Kosong = tanpa aksen khusus', autocomplete: 'off', maxLength: 40 }) as HTMLInputElement;
    i.setAttribute('list', id);
    return { input: i, el: h('div', { style: 'display:contents' }, i, h('datalist', { id }, ...ACCENTS.map((a) => h('option', { value: a })))) };
  };
  function tunePersona(p: Persona) {
    let voice = p.voiceId;
    const vp = voicePicker({ value: voice, onChange: (v) => { voice = v; }, unknownLabel: 'Suara bawaan persona' });
    const lang = langSelect(p.lang, true);
    const acc = accentField(p.accent);
    const save = ui.btn({ label: 'Simpan', cls: 'primary' });
    const reset = ui.btn({ label: 'Reset', icon: 'refresh', cls: 'ghost' });
    const m = ui.modal({ title: p.name, body: h('div', { class: 'stack' },
      field('Suara', vp),
      field('Bahasa', lang, 'Bahasa yang dipakai persona saat membalas. Ikuti bahasamu = menyesuaikan bahasa yang kamu pakai.'),
      field('Aksen', acc.el, 'Contoh: British, Australian.')), actions: [reset, save] });
    reset.onclick = () => { setOverride(p.id, { voiceId: undefined, lang: undefined, accent: undefined }); m.close(); refreshPersona(); ui.toast('Dikembalikan ke bawaan.', { kind: 'ok' }); };
    save.onclick = () => {
      setOverride(p.id, { voiceId: voice === p.defaultVoiceId ? undefined : voice, lang: lang.value, accent: cleanAccent(acc.input.value) });
      m.close(); refreshPersona(); ui.toast('Tersimpan.', { kind: 'ok', timeout: 1800 });
    };
  }
  /** the persona editor is gone (saved or not): the orb that left it flies home onto the big orb; never stays hidden */
  function orbHome() { void receiveOrb(theOrb).then(() => { theOrb.style.visibility = ''; }); }
  function editPersona(c: CustomPersona) {
    openPersonaEditor(ctx, c, (out) => {
      saveCustom(out);
      settings.local.remove('chat.log.' + out.id);
      buildPersonas();
      if (cur?.id === out.id) open(out.id);
      ui.toast('Persona disimpan.', { kind: 'ok' });
    }, { onClosed: orbHome });
  }
  function newPersona() { createPersonaFlow(ctx, { onCreated: () => buildPersonas(), onClosed: orbHome }); }
  function refreshPersona() { buildPersonas(); paintHead(); }

  /* ================= route ================= */
  function onRoute(r: RouteInfo) {
    let id = decodeURIComponent(r.path.split('/')[1] || '');
    if (!loaded) { pendingId = id; return; }
    if (!id || !personas.some((p) => p.id === id)) {
      const last = chatPrefs().last;
      const pick = personas.find((p) => p.id === last) || personas[0];
      if (!pick) { cur = null; whoName.textContent = 'Chat'; caps.clear(); caps.block('none'); caps.show(charsErr ? 'Persona tidak bisa dimuat.' : 'Belum ada persona. Buat satu dulu.'); paintState(); return; }
      id = pick.id;
      history.replaceState(null, '', '#/chat/' + encodeURIComponent(id));
    }
    if (id !== cur?.id) open(id);
  }
  let pendingId: string = decodeURIComponent(ctx.route.path.split('/')[1] || '');

  /* ================= boot ================= */
  ctx.shell.setTabbar(true);
  paintState();
  onDisconnect(wrap, player.on('change', () => { kick(); paintBar(); }));
  onDisconnect(wrap, settings.subscribe('chat.personas', () => { buildPersonas(); paintHead(); }));
  onDisconnect(wrap, settings.subscribe('chat.prefs', () => { buildPersonas(); paintHead(); }));
  onDisconnect(wrap, onOrbsChange(() => paintHead()));
  ctx.data.characters().then((l) => { chars = l; }).catch((e) => { charsErr = e.message || 'error'; })
    .finally(() => { loaded = true; buildPersonas(); onRoute({ name: 'chat', path: 'chat/' + pendingId, params: new URLSearchParams() }); });
  ctx.data.voices().catch(() => {});
  // a ready STT token makes the first mic press ~1 s faster
  const warmT = setTimeout(() => { if (sttSupported() && !document.hidden) prewarmStt(); }, 1500);
  onDisconnect(wrap, () => clearTimeout(warmT));
  micBtn.addEventListener('pointerenter', () => prewarmStt());
  if (convo) showHint();
  if (desktop()) setTimeout(() => input.focus({ preventScroll: true }), 300);

  return {
    cleanup: () => {
      stopAll();
      clearInterval(silenceT); clearInterval(barT); if (intT) clearTimeout(intT); if (hushT) clearTimeout(hushT);
      document.removeEventListener('visibilitychange', onVis);
      document.removeEventListener('pointerdown', onGesture, true); document.removeEventListener('keydown', onGesture, true);
      if (raf) cancelAnimationFrame(raf); removeEventListener('keydown', onKey, true); if (youT) clearTimeout(youT);
    },
    onRoute,
  };
}
