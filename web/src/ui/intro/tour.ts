/* The intro: a guided 3D tour narrated by Strix, at the user's own pace.
   hello: Strix says what this is while four labelled feature orbs appear (Chat, Text to Speech, Voice Changer,
   Voices). Then the camera flies into real, small pieces of each screen (panels.ts), placed in 3D (cam.ts): arcs between
   panels, a push-in on the part that matters while Strix explains, rack focus (blur by depth) and parallax. On every
   panel Strix invites ONE small action, real where it is cheap:
     Chat: type or tap a suggestion -> a real /api/chat reply, spoken with streaming TTS and synced captions;
     TTS: the wand -> real /api/tts/autotag (purple tags) -> Play through /api/tts;
     Voice Changer: before / after examples;
     Voices: a navigable VOICE MAP (map.ts): many big, distinct voices in clusters at different depths; pan / pinch /
     zoom with parallax and depth of field; the ball in the middle speaks; add one to a (local, tour-only) collection.
   There is NO timer: the tour waits; the user moves on with Next (or Skip this). After >= 25 s without input Strix may say
   ONE gentle "take your time" per step; nothing moves on by itself. Quota / network failures fall back to static
   in-character clips. Static narration + reactions + demo clips live in public/intro (tour.json: word timings + a 50 Hz
   loudness envelope per clip).
   Every async continuation (narration end, surf hops, replies) is tied to a step token and a clip serial, so a user
   action can never be overtaken by a stale promise of the scripted flow.
   Orbs are drawn on canvases (stage.ts): one behind the panels (background, bokeh) and one in front (every orb), so
   each orb is a perfect circle at the projected position of its slot, whatever the panel's tilt.
   End: "Start talking" -> Strix's orb flies into the Chat orb while the stage dissolves (the match cut). */
import './tour.css';
import { h } from '../dom';
import { svg } from '../../icons';
import { customOrb, defaultVoiceOrb, personaOrb, hexToRgb, type OrbEl, type OrbSpec, type Rgb } from '../orb';
import { DEFAULT_VOICE, chatPrefs, fromCharacter, streamChat, ttsText, type Persona } from '../../lib/persona';
import { loadCharacters } from '../../store';
import { player, chunker } from '../../player';
import { autoTag, bareWords } from '../../lib/autotag';
import { BRAND } from '../../lib/brand';
import { staticClipVolume } from '../../lib/leveler';
import { Stage, type Bg, type Dot, type Rich } from './stage';
import { clamp, lerp, prog, easeInOutCubic, easeOutCubic, spring, rng } from './kit';
import { blend, frame, local, matrix, project, view, inQuad, type Place, type Pose, type Rect, type V3 } from './cam';
import { chatPanel, ttsPanel, vcPanel, voicesPanel, measure, TTS_TEXT, CHAT_H, type PanelBase, type ChatPanel, type TtsPanel, type VcPanel, type VoicesPanel } from './panels';
import { VoiceMap, loadMapVoices, collOrb, type MapVoice } from './map';

type Word = [string, number, number];
interface Clip { src: string; dur: number; words: Word[]; tags: Array<[string, number]>; env: number[] }
export interface TourOpts {
  onDone?: (how: 'finished' | 'skipped') => void;
  /** First-time tour for a new tester: no way to skip the whole tour (Skip tour / gate Skip / Esc are removed). If the tour assets cannot be loaded the Skip link comes back so nobody gets trapped. */
  mandatory?: boolean;
}

const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');
let open = false;

/* ---------- content ---------- */
const STEPS = ['hello', 'chat', 'tts', 'vc', 'voices', 'outro'] as const;
type StepId = typeof STEPS[number];
const NARR: Record<StepId, string> = { hello: 't_hello', chat: 't_chat', tts: 't_tts', vc: 't_vc', voices: 't_voices', outro: 't_outro' };
const HINT: Partial<Record<StepId, string>> = {
  hello: 'Press Next when you are ready',
  chat: 'Type a message, or tap a suggestion',
  tts: 'Tap the wand, then Play',
  vc: 'Tap Before and After to listen',
  voices: 'Drag to explore · pinch or +/− to zoom · tap a voice',
};
const FEATURES = [{ label: 'Chat', word: /^chat/i }, { label: 'Text to Speech', word: /^writing/i }, { label: 'Voice Changer', word: /^swap/i }, { label: 'Voices', word: /^collect/i }];
/** branching reactions: each pool is used in order and a line is never repeated in one tour */
const POOL = {
  next: ['r_good', 'r_see', 'r_impressed'],
  skip: ['r_skip', 'r_skip2'],
  nudge: ['r_nudge1', 'r_nudge2', 'r_nudge3'],
};
const TTS_FX = "[gasps] I can't believe you remembered. [softly] Honestly, you're the best.";
const REST_TEXT = 'Uhh, my voice is having a lie-down right now... but I did hear you. Hi.';
const NUDGE_AFTER = 25;
interface VoiceDef { clip: string; vid: string; name: string; tag: string; accent: string; gender: string; age: string }
/** static fallback of the voice map (the tour's own short clips): used when the library cannot be reached */
const VOICES: VoiceDef[] = [
  { clip: 'v_brian', vid: 'nPczCjzI2devNBz1zQrb', name: 'Brian', tag: 'Deep, calm', accent: 'American', gender: 'Male', age: 'Middle Aged' },
  { clip: 'v_jessica', vid: 'cgSgspJ2msm6clMCkdW9', name: 'Jessica', tag: 'Bright, young', accent: 'American', gender: 'Female', age: 'Young' },
  { clip: 'v_harry', vid: 'SOYHLrjzK2X1ezoPC6cr', name: 'Harry', tag: 'Fierce', accent: 'American', gender: 'Male', age: 'Young' },
  { clip: 'v_lily', vid: 'pFZP5JQG7iQjIQuC4Bku', name: 'Lily', tag: 'Velvety', accent: 'British', gender: 'Female', age: 'Middle Aged' },
  { clip: 'v_bill', vid: 'pqHfZKP75CvOlQylNhV4', name: 'Bill', tag: 'Older, wise', accent: 'American', gender: 'Male', age: 'Old' },
  { clip: 'v_charlie', vid: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie', tag: 'Upbeat', accent: 'Australian', gender: 'Male', age: 'Young' },
  { clip: 'v_laura', vid: 'FGY2WhTYpPnrIDTdsKH5', name: 'Laura', tag: 'Quirky', accent: 'American', gender: 'Female', age: 'Young' },
  { clip: 'v_george', vid: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', tag: 'Storyteller', accent: 'British', gender: 'Male', age: 'Middle Aged' },
  { clip: 'v_river', vid: 'SAz9YHcvj6GT2YYXdXww', name: 'River', tag: 'Calm, neutral', accent: 'American', gender: 'Neutral', age: 'Middle Aged' },
  { clip: 'v_callum', vid: 'N2lVS1w4EtoT3dr4eOWO', name: 'Callum', tag: 'Husky, sly', accent: 'American', gender: 'Male', age: 'Middle Aged' },
];
const STATIC_MAP: MapVoice[] = VOICES.map((v) => ({ id: v.vid, name: v.name, desc: v.tag, attrs: { accent: v.accent, gender: v.gender, age: v.age, use: '', lang: 'English' }, clip: v.clip, spec: defaultVoiceOrb(v.vid) }));
const WARM = customOrb({ colors: ['#5b1a6e', '#c74bd8', '#ff8fb1', '#ffe0f0', '#7d5cff'], style: 'aurora', speed: 1.3, soft: 0.6 }, 'tu:tts');
const YOU = defaultVoiceOrb('EXAVITQu4vr4xnSDxMaL');
const CHATORB = customOrb({ colors: ['#0b2a6e', '#2f7bff', '#7fd4ff', '#e6f6ff'], style: 'swirl', speed: 1, soft: 0.6 }, 'tu:chat');
interface Pal { top: string; bot: string; glow: string; glow2: string }
const PALS: Record<StepId, Pal> = {
  hello: { top: '#0d0b26', bot: '#05050c', glow: '#3a2f9e', glow2: '#103e73' },
  chat: { top: '#0c0d2a', bot: '#05050d', glow: '#3b3aa8', glow2: '#1a4f8a' },
  tts: { top: '#1a0b24', bot: '#07060d', glow: '#7a2a8a', glow2: '#2a1f8a' },
  vc: { top: '#1c0a16', bot: '#08050a', glow: '#8a2448', glow2: '#3a1f8a' },
  voices: { top: '#03161c', bot: '#03080d', glow: '#0e6e72', glow2: '#22409a' },
  outro: { top: '#0d0b26', bot: '#05050c', glow: '#3a2f9e', glow2: '#103e73' },
};
const ARC = [-0.75, -0.25, 0.25, 0.75], RAD = 1000, PY = [0, 14, -10, 6];
const F = 1000;   // focal length (px): ~45 degree vertical field of view on a phone

function chatOrb(): OrbEl | null {
  const el = document.querySelector('.vx-orb') as OrbEl | null;
  if (!el || !el._spec) return null;
  const r = el.getBoundingClientRect();
  return r.width > 8 && r.bottom > 0 && r.top < innerHeight ? el : null;
}
function strixVoice(): string { try { return chatPrefs()?.over?.strix?.voiceId || DEFAULT_VOICE; } catch { return DEFAULT_VOICE; } }
function strixOrb(): OrbSpec {
  let o: { orb?: unknown; voiceId?: string } = {};
  try { o = chatPrefs()?.over?.strix || {}; } catch { /* settings not ready */ }
  return personaOrb(o.voiceId || DEFAULT_VOICE, BRAND, (o.orb as Parameters<typeof personaOrb>[2]) || null);
}

export function openTour(opts: TourOpts = {}): void {
  if (open) return;
  open = true;
  const S = svg;
  const HERO = strixOrb();
  const FEAT_SPEC = [CHATORB, WARM, YOU, defaultVoiceOrb(VOICES[5].vid)];

  /* ---------------- DOM ---------------- */
  const back = new Stage(), front = new Stage();
  front.canvas.classList.add('front');
  const P = { chat: chatPanel(), tts: ttsPanel(), vc: vcPanel(), voices: voicesPanel() };
  const PANELS: PanelBase[] = [P.chat, P.tts, P.vc, P.voices];
  const world = h('div', { class: 'tu-world' }, ...PANELS.map((p) => p.el));
  const flabels = FEATURES.map((f) => h('div', { class: 'tu-flabel' }, f.label));
  const vlabel = h('div', { class: 'tu-vlabel', 'aria-hidden': 'true' }, h('b'), h('span'));
  const capLine = h('p', { class: 'tu-cap', 'aria-hidden': 'true' });
  const hintLine = h('p', { class: 'tu-hint' });
  const capSr = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const narr = h('div', { class: 'tu-narr' }, capLine, hintLine, capSr);
  const skipStep = h('button', { type: 'button', class: 'tu-skipstep' }, 'Skip this');
  const nextBtn = h('button', { type: 'button', class: 'tu-next' }, h('span', null, 'Next'), h('span', { class: 'tu-nextic', html: S('arrowRight') }));
  const startBtn = h('button', { type: 'button', class: 'tu-start', hidden: true }, h('span', null, 'Start talking'), h('span', { class: 'tu-nextic', html: S('arrowRight') }));
  const nav = h('div', { class: 'tu-nav' }, skipStep, nextBtn, startBtn);
  const dots = h('div', { class: 'tu-dots', 'aria-hidden': 'true' }, ...[0, 1, 2, 3].map(() => h('i')));
  const skipTour = h('button', { type: 'button', class: 'tu-skiptour' }, 'Skip tour');
  const soundBtn = h('button', { type: 'button', class: 'tu-sound', hidden: true, html: S('speakerOff') }, h('span', null, 'Sound off · tap for sound'));
  const top = h('div', { class: 'tu-top' }, soundBtn, dots, skipTour);
  const gPlay = h('button', { type: 'button', class: 'tu-gplay' }, h('span', { class: 'tu-gplayic', html: S('play') }), h('span', null, 'Take the tour'));
  const gSkip = h('button', { type: 'button', class: 'tu-link' }, 'Skip');
  const mandatory = !!opts.mandatory;
  if (mandatory) { skipTour.hidden = true; gSkip.hidden = true; }
  const gate = h('div', { class: 'tu-gate' }, h('div', { class: 'tu-gbtns' }, gPlay, h('p', { class: 'tu-gnote' }, 'a short tour · sound on'), gSkip));
  const root = h('div', { class: 'tour gated pending', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${BRAND} tour` },
    back.canvas, world, front.canvas, ...flabels, vlabel, narr, nav, top, gate);
  document.body.append(root);
  const html = document.documentElement;
  html.classList.add('intro-open');

  /* ---------------- state ---------------- */
  let reduced = reduceMq.matches;
  let clk = 0, raf = 0, last = 0, started = false, leaving = false, muted = false;
  let step = 0, stepAt = 0, stepTok = 0, narrDone = false, narrEndAt = 0, narrStarted = false, lastAct = 0;
  const did: Record<string, boolean> = {};
  const nudged = new Set<number>();
  const used = new Set<string>();
  const fps = { frames: 0, t0: 0, value: 0, worst: 0, samples: [] as number[] };
  const capLog: Array<{ clip: string; word: string; due: number; at: number; audio: number | null }> = [];
  const log: string[] = [];
  const errors: string[] = [];
  const note = (s: string) => { log.push(`${clk.toFixed(2)} ${s}`); if (log.length > 300) log.shift(); };
  const act = () => { lastAct = clk; };
  const sid = () => STEPS[step];
  const featStep = () => step >= 1 && step <= 4;
  /** the next unused line of a reaction pool (null when all were used) */
  const pick = (pool: string[]) => { const id = pool.find((x) => !used.has(x)) ?? null; if (id) used.add(id); return id; };

  /* ---------------- layout (incl. the on-screen keyboard) ---------------- */
  const L = { W: 0, H: 0, top: 0, mobile: true, areaTop: 0, areaH: 0, areaW: 0, cx: 0, cy: 0, narrY: 0, guideX: 0, guideR: 22, kb: false };
  const hMax: Record<number, number> = {};
  const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && root.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT'); };
  function layout() {
    const vv = window.visualViewport;
    const W = root.clientWidth;
    const vh = Math.round(vv ? vv.height : innerHeight);
    if (!typing()) hMax[W] = Math.max(hMax[W] || 0, vh);
    // keyboard: an input of the tour has focus and the visible height shrank (overlay keyboards change only the
    // visual viewport, resizing ones change the layout viewport too: both show up in visualViewport.height)
    const kb = typing() && vh < (hMax[W] || vh) - 120;
    const H = vh, topOff = vv && kb ? Math.round(vv.offsetTop) : 0;
    root.classList.toggle('kb', kb);
    root.style.top = kb ? topOff + 'px' : '';
    root.style.height = kb ? H + 'px' : '';
    const mobile = W < 700;
    const topH = kb ? 52 : 54, navH = kb ? 0 : mobile ? 74 : 84, narrH = kb ? 0 : mobile ? 104 : 112;
    const areaTop = topH, areaH = Math.max(140, H - areaTop - navH - narrH - (kb ? 8 : 0));
    const kbChanged = kb !== L.kb;
    Object.assign(L, { W, H, top: topOff, mobile, areaTop, areaH, areaW: W - (mobile ? 24 : 80), cx: W / 2, cy: areaTop + areaH / 2, narrY: areaTop + areaH + narrH / 2, guideR: mobile ? 21 : 25, kb });
    L.guideX = mobile ? 16 + L.guideR : Math.max(40 + L.guideR, W / 2 - 330);
    narr.style.top = areaTop + areaH + 'px'; narr.style.height = narrH + 'px';
    narr.style.setProperty('--gx', L.guideX + L.guideR + 14 + 'px');
    back.resize(W, H); front.resize(W, H);
    map.resize({ W, H, areaTop, areaH, mobile });
    fitChat();
    for (const p of PANELS) remeasure(p);
    if (kbChanged && started && featStep()) goto(restShot(step - 1), 0.32);
    rr0 = null;
  }
  /** keyboard open: the chat panel becomes exactly as tall as the visible area (smaller orb, header folded), at
      scale 1 when it fits, never below .82; closed: back to its normal size */
  function fitChat() {
    const p = P.chat;
    const s = Math.min(1, (L.areaW * 0.96) / p.w);
    const hh = L.kb ? Math.max(260, Math.floor((L.areaH * 0.99) / Math.max(0.82, s))) : CHAT_H;
    p.el.classList.toggle('kb', L.kb);
    if (p.el.style.height !== hh + 'px') p.el.style.height = hh + 'px';
  }
  let measured = false;
  function remeasure(p: PanelBase) {
    const was = p.el.hidden;
    if (was) { p.el.hidden = false; p.el.style.visibility = 'hidden'; }
    measure(p);
    if (p.id === 'voices') measureSea();
    if (was) { p.el.hidden = true; p.el.style.visibility = ''; }
    measured = true;
  }
  const place = (i: number): Place => ({ c: [RAD * Math.sin(ARC[i]), PY[i], RAD * Math.cos(ARC[i])], a: ARC[i], w: PANELS[i].w, h: PANELS[i].h });
  const fit = (r: Rect, cap: number) => Math.min(cap, (L.areaW * 0.96) / r.w, (L.areaH * 0.97) / r.h);
  const fullRect = (i: number): Rect => ({ x: 0, y: 0, w: PANELS[i].w, h: PANELS[i].h });
  const elRect = (p: PanelBase, el: HTMLElement): Rect => { let x = 0, y = 0, n: HTMLElement | null = el; while (n && n !== p.el) { x += n.offsetLeft; y += n.offsetTop; n = n.offsetParent as HTMLElement | null; } return { x, y, w: el.offsetWidth, h: el.offsetHeight }; };
  const capFull = () => (L.kb ? 1 : L.mobile ? 1 : 1.3);
  const shotFull = (i: number) => () => frame(place(i), fullRect(i), fit(fullRect(i), capFull()), F);
  const restShot = (i: number) => shotFull(i);
  const shotRect = (i: number, r: () => Rect, cap: number) => () => {
    if (L.kb) return shotFull(i)();
    const rr = r(), full = fit(fullRect(i), capFull());
    return safeFrame(i, rr, Math.max(full, fit(rr, cap)));
  };
  /** frame a panel rect at scale sc, but never let the panel's bottom edge run below the panel area (into the
      caption / buttons): the push-in crops the top of the panel instead */
  function safeFrame(i: number, rr: Rect, sc: number): Pose {
    const h0 = PANELS[i].h, cyT = Math.max(rr.y + rr.h / 2, h0 - (L.areaH * 0.98) / (2 * sc));
    return frame(place(i), { x: rr.x, y: cyT, w: rr.w, h: 0 }, sc, F);
  }
  function shotHello(): Pose { return { p: [0, -60, -1500], yaw: 0, pitch: 0, tgt: [0, 0, 600] }; }
  function shotWide(): Pose {
    const half = RAD * Math.sin(0.75) + 190, depth = RAD * Math.cos(0.75);
    const d = Math.max((F * half) / (L.areaW * 0.47) - depth, (F * 300) / (L.areaH * 0.5) - RAD);
    const y = -(L.areaH * 0.16 * (d + RAD * 0.85)) / F;   // panels sit below the guide orb
    return { p: [0, y, -d], yaw: 0, pitch: 0, tgt: [0, y, RAD * 0.9] };
  }

  /* ---------------- camera ---------------- */
  let cam: { from: Pose; to: () => Pose; t0: number; dur: number; arc: number } = { from: shotHello(), to: shotHello, t0: 0, dur: 0, arc: 0 };
  let pose: Pose = shotHello();
  function goto(to: () => Pose, dur: number, arc = 0) {
    cam = { from: pose, to, t0: clk, dur: reduced ? 0 : dur, arc: reduced ? 0 : arc };
  }
  function camPose(): Pose {
    const k = cam.dur <= 0 ? 1 : easeInOutCubic(prog(clk, cam.t0, cam.t0 + cam.dur));
    return k >= 1 ? cam.to() : blend(cam.from, cam.to(), k, cam.arc, F);
  }

  /* ---------------- audio: static clips on one element ---------------- */
  let clips: Record<string, Clip> = {};
  const blobs: Record<string, string> = {};
  const failed = new Set<string>();
  const au = new Audio();
  au.preload = 'auto';
  interface Playing { n: number; id: string; who: string; cap: boolean; t0: number; clockOnly: boolean; waitAt: number; res: (ok: boolean) => void }
  let cur: Playing | null = null, sayN = 0;
  const urlOf = (id: string) => blobs[id] || clips[id]?.src || '';
  /** stop the clip that is playing (its promise resolves false) */
  function stopClip() { if (!cur) return; const c = cur; cur = null; if (!au.paused) au.pause(); c.res(false); }
  /** play one static clip; resolves true when it played to the end, false when it was replaced / stopped / missing */
  function say(id: string, o: { who?: string; cap?: boolean } = {}): Promise<boolean> {
    stopClip();
    const c = clips[id];
    if (!c) return Promise.resolve(false);
    if (player.speaker === 'tour' || player.pending || player.busy) player.stop();
    note('say ' + id);
    const n = ++sayN;
    return new Promise((res) => {
      const clockOnly = muted || failed.has(id);
      cur = { n, id, who: o.who || 'guide', cap: o.cap !== false, t0: clk, clockOnly, waitAt: clk, res };
      if (cur.cap) startCaps(id);
      if (!clockOnly) {
        au.volume = staticClipVolume();   // the clips are mastered at -18.4 LUFS; live TTS is leveled to -20
        au.src = urlOf(id);
        try { au.currentTime = 0; } catch { /* */ }
        const p = au.play();
        // a play() interrupted by the NEXT clip rejects with AbortError: only this clip's own serial may react
        p?.catch((e: DOMException) => {
          if (cur?.n !== n) return;
          if (e?.name === 'NotAllowedError') setMuted(true);
          else if (e?.name === 'AbortError') return;
          if (cur) { cur.clockOnly = true; cur.t0 = clk; }
        });
      }
    });
  }
  function endClip(ok: boolean) { const c = cur; if (!c) return; cur = null; c.res(ok); }
  au.addEventListener('ended', () => { if (cur && !cur.clockOnly) endClip(true); });
  au.addEventListener('error', () => { if (cur && !cur.clockOnly && au.src) { failed.add(cur.id); cur.clockOnly = true; cur.t0 = clk; } });
  /** seconds into the clip that is playing (the audio element is the clock while it really plays) */
  function clipT(): number {
    if (!cur) return -1;
    if (!cur.clockOnly) {
      if (!au.paused && au.readyState >= 2 && au.currentTime > 0) { cur.waitAt = 0; return au.currentTime; }
      if (cur.waitAt && clk - cur.waitAt > 1.5) { cur.clockOnly = true; cur.t0 = clk; failed.add(cur.id); return 0; }   // never stall on a slow clip
      return au.currentTime || 0;
    }
    return clk - cur.t0;
  }
  function envOf(who: string): number {
    if (reduced || !cur || cur.who !== who) return 0;
    const c = clips[cur.id], t = clipT();
    if (!c || t < 0) return 0;
    const x = t * 50, k = Math.floor(x), e = c.env;
    return clamp((((e[k] ?? 0) * (1 - (x - k)) + (e[k + 1] ?? 0) * (x - k)) / 99) * 1.05);
  }
  function setMuted(m: boolean) {
    muted = m;
    soundBtn.hidden = !m;
    if (m && cur && !cur.clockOnly) { const t = clipT(); au.pause(); cur.clockOnly = true; cur.t0 = clk - Math.max(0, t); }
  }
  const tourAmp = () => { const l = player.level(); return l.who === 'tour' ? l.amp : 0; };
  /** a reaction from the guide, only when nothing else talks */
  function react(id: string | null) { if (id && !cur && !player.pending) void say(id); }

  /* ---------------- narration captions (2-6 words a page, revealed by the clip clock) ---------------- */
  interface CapItem { el: HTMLElement; w: Word; page: number }
  let capId = '', capItems: CapItem[] = [], capEndAt = -9;
  function paginate(words: Word[]): number[] {
    const pages: number[] = []; let pg = 0, n = 0;
    words.forEach((w, i) => {
      pages.push(pg); n++;
      const end = /[.!?]$/.test(w[0]) && !/\.\.\.$/.test(w[0]);
      const left = words.length - i - 1;
      if (left && ((end && n >= 2) || n >= 6 || (/[,—]$/.test(w[0]) && n >= 3 && left > 1))) { pg++; n = 0; }
    });
    return pages;
  }
  function startCaps(id: string) {
    const c = clips[id];
    capId = id;
    const pg = paginate(c.words);
    capItems = c.words.map((w, i) => ({ el: h('span', { class: 'tu-w' }, w[0].replace(/\.\.\./g, '…')), w, page: pg[i] }));
    capSr.textContent = c.words.map((w) => w[0]).join(' ');
    capLine.replaceChildren();
  }
  const LEAD = 0.04;
  function renderCaps() {
    const live = cur && cur.cap && cur.id === capId;
    if (live) capEndAt = clk;
    const showing = live || clk - capEndAt < 1.1;
    root.classList.toggle('speaking', !!showing && capItems.length > 0);
    if (!showing || !capItems.length) return;
    const t = live ? clipT() : 99;
    let pg = 0;
    for (const x of capItems) if (t >= x.w[1] - LEAD) pg = x.page;
    const nodes: HTMLElement[] = [];
    for (const x of capItems) {
      if (x.page !== pg) continue;
      const on = t >= x.w[1] - LEAD;
      if (on && !x.el.classList.contains('on')) { capLog.push({ clip: capId, word: x.w[0], due: x.w[1], at: t, audio: live && cur && !cur.clockOnly ? au.currentTime : null }); if (capLog.length > 800) capLog.shift(); }
      x.el.classList.toggle('on', on);
      nodes.push(x.el);
    }
    const same = nodes.length === capLine.childNodes.length && nodes.every((n, j) => capLine.childNodes[j] === n);
    if (!same) capLine.replaceChildren(...nodes);
  }

  /* ---------------- steps ---------------- */
  const stepT = () => clk - stepAt;
  let cues: Array<{ at: number; fn: () => void; done?: boolean; cam?: boolean }> = [];
  let tookOver = false;
  function enterStep(i: number) {
    const from = step;
    step = i; stepAt = clk; stepTok++; narrDone = false; narrStarted = false; narrEndAt = 0; lastAct = clk; tookOver = false;
    root.dataset.step = sid();
    note('step ' + sid());
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i - 1));
    dots.classList.toggle('off', !featStep());
    PANELS.forEach((p, k) => { p.el.inert = k !== i - 1; });
    hintLine.textContent = HINT[sid()] || '';
    skipStep.hidden = !featStep();
    nextBtn.hidden = sid() === 'outro';
    startBtn.hidden = sid() !== 'outro';
    cues = [];
    const k = i - 1;
    if (sid() !== 'voices') map.deactivate();
    if (featStep()) {
      goto(restShot(k), from === 0 ? 2.1 : 1.6, from === 0 ? 900 : 650);
      const detail = DETAIL[k];
      if (detail) cues.push({ at: 2.1, cam: true, fn: () => goto(detail, 1.3) });
      // Voices: once the camera reaches the panel, the map dives in over the whole stage
      if (sid() === 'voices') cues.push({ at: reduced ? 0 : 1.15, fn: () => { map.activate(); requestAnimationFrame(() => { if (sid() === 'voices' && !typing()) map.el.focus({ preventScroll: true }); }); } });
    } else if (sid() === 'outro') {
      goto(shotWide, 2.0, 300);
      requestAnimationFrame(() => startBtn.focus({ preventScroll: true }));
    } else goto(shotHello, 0);
  }
  const DETAIL: Array<(() => Pose) | null> = [
    shotRect(0, () => ({ x: 0, y: 44, w: P.chat.w, h: 270 }), 1.28),
    shotRect(1, () => elRect(P.tts, P.tts.el.querySelector('.tu-editor') as HTMLElement), 1.32),
    shotRect(2, () => elRect(P.vc, P.vc.el.querySelector('.tu-recp') as HTMLElement), 1.3),
    null,
  ];
  /** narration of the step: starts once the camera is nearly there and nothing else is talking */
  function stepNarration() {
    if (narrStarted || stepT() < (step === 0 ? 0.5 : 0.75) || cur) return;
    narrStarted = true;
    // the user already started doing something on this panel: do not talk over it afterwards
    if (tookOver) { narrDone = true; narrEndAt = clk; return; }
    const tok = stepTok;
    void say(NARR[sid()]).then(() => {
      if (tok !== stepTok) return;   // the user already moved on: this promise belongs to an old step
      narrDone = true; narrEndAt = clk; act();
      onNarrated(tok);
    });
  }
  function onNarrated(tok: number) {
    const s = sid();
    if (!featStep()) return;
    const k = step - 1;
    if (!tookOver && DETAIL[k]) goto(restShot(k), 1.0);
    if (s === 'voices' && !tookOver) void surf(tok);
  }
  function go(i: number) {
    if (leaving) return;
    if (i >= STEPS.length) { finish('finished'); return; }
    abortActivity();
    stopClip();
    if (typing()) (document.activeElement as HTMLElement).blur();
    enterStep(i);
  }
  function next() {
    if (!started || leaving) return;
    const s = sid();
    if (s === 'outro') { finish('finished'); return; }
    const reacted = featStep() && did[s];
    go(step + 1);
    if (reacted) react(pick(POOL.next));
  }
  function skipThis() {
    if (!featStep() || leaving) return;
    go(step + 1);
    react(pick(POOL.skip));
  }
  /** user took over a step: drop scripted pushes, frame the whole panel */
  function takeOver() {
    act();
    if (tookOver || !featStep()) return;
    tookOver = true;
    for (const c of cues) if (c.cam) c.done = true;
    const k = step - 1;
    if (sid() !== 'voices') goto(restShot(k), 0.8);
  }
  function busy(): boolean {
    return chat.busy || tts.busy || cur != null || map.surfing || sea.fly != null || player.pending > 0 || player.busy;
  }
  /** no timers that move on: after a long quiet spell, ONE soft line per step (never pushes, no visual) */
  function patience() {
    if (!started || !narrDone || busy() || nudged.has(step) || sid() === 'outro') return;
    if (clk - lastAct < NUDGE_AFTER) return;
    nudged.add(step);
    const id = pick(POOL.nudge);
    note('nudge ' + (id || 'none'));
    if (id) void say(id).then(() => act());
  }
  function abortActivity() {
    chat.abort(); tts.abort(); sea.stop(); map.stopVoice();
    if (cur && cur.who !== 'guide') stopClip();
  }

  /* ---------------- Chat panel: a real reply from Strix ---------------- */
  const chat = (() => {
    const p: ChatPanel = P.chat;
    let gen = 0, ctrl: AbortController | null = null;
    const st = { busy: false, abort() { gen++; ctrl?.abort(); ctrl = null; if (player.speaker === 'tour' || player.pending) player.stop(); st.busy = false; status(''); } };
    function status(s: string, dots = false) { p.status.replaceChildren(s ? h('span', null, s) : '', dots ? h('span', { class: 'vx-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')) : ''); }
    async function send(text: string) {
      text = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!text || st.busy) return;
      takeOver(); did.chat = true; stopClip(); player.stop();
      const my = ++gen;
      st.busy = true;
      p.input.value = ''; p.send.disabled = true;
      p.you.textContent = text; p.you.classList.add('on');
      p.caps.clear(); p.caps.block('r');
      status('Thinking', true);
      note('chat send');
      let persona: Persona | null = null;
      try { const cs = await loadCharacters(); const c = cs.find((x) => x.id === 'strix') || cs[0]; if (c) persona = fromCharacter(c); } catch { /* fallback below */ }
      let spoke = 0, n = 0;
      const speakChunk = (raw: string) => {
        const t = raw.trim();
        if (!t || !persona || my !== gen || !/[\p{L}\p{N}]/u.test(t.replace(/\[[^\]]*\]/g, ''))) return;
        const id = `tour:${my}:${n++}`;
        p.caps.add(id, t);
        player.speak(ttsText(persona, t), {
          voiceId: persona.voiceId || DEFAULT_VOICE, who: 'tour', meta: { sid: id, a: 0, b: t.length },
          onStart: () => { if (my === gen) status(''); },
          onEnd: (ok) => { if (my !== gen) return; if (ok) { spoke++; p.caps.finish(id); } else p.caps.fail(id); },
        });
      };
      const ch = chunker(speakChunk, 160, 40);
      try {
        if (!persona) throw new Error('no persona');
        ctrl = new AbortController();
        await streamChat({ persona, memory: false, messages: [{ role: 'user', content: text }], speak: true, signal: ctrl.signal, onText: (d) => { if (my === gen) ch.push(d); } });
        if (my !== gen) return;
        ch.flush();
        note('chat streamed');
        await player.waitIdle(60000);
        if (my !== gen) return;
        note('chat spoken ' + spoke);
      } catch (e) {
        if (my !== gen || (e as { code?: string })?.code === 'aborted') return;
        note('chat fallback ' + ((e as Error)?.message || ''));
        p.caps.clear(); p.caps.block('rest'); p.caps.show(REST_TEXT);
        status('');
        await say('r_rest', { who: 'chat', cap: false });
      }
      if (my !== gen) return;
      st.busy = false; status(''); act();
    }
    p.form.addEventListener('submit', (e) => { e.preventDefault(); void send(p.input.value); });
    p.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(p.input.value); } });
    p.input.addEventListener('input', () => { takeOver(); p.send.disabled = !p.input.value.trim(); });
    p.input.addEventListener('focus', () => { takeOver(); setTimeout(layout, 350); });
    p.input.addEventListener('blur', () => setTimeout(layout, 120));
    p.send.disabled = true;
    p.chips.forEach((b) => { b.onclick = () => void send(b.textContent || ''); });
    p.mic.onclick = () => { takeOver(); status('Voice input works in Chat. Type here for now.'); p.input.focus({ preventScroll: true }); };
    return st;
  })();

  /* ---------------- TTS panel: auto tag + play ---------------- */
  const tts = (() => {
    const p: TtsPanel = P.tts;
    let tagged: string | null = null, tagging = false, liveFailed = false, gen = 0;
    const heard = new Set<string>();
    const st = { busy: false, abort() { gen++; if (player.speaker === 'tour' || player.pending) player.stop(); if (cur?.who === 'tts') stopClip(); setPlay(false); st.busy = false; } };
    function paint(text: string, fresh: boolean) {
      const nodes: Node[] = [];
      for (const part of text.split(/(\[[^\]]*\])/)) if (part) nodes.push(part.startsWith('[') ? h('mark', { class: 'tg' + (fresh ? ' new' : '') }, part) : document.createTextNode(part));
      p.text.replaceChildren(...nodes);
      p.count.textContent = `${bareWords(text).length} chars`;
    }
    function setPlay(on: boolean) { p.play.innerHTML = S(on ? 'stop' : 'play'); p.play.append(h('span', null, on ? 'Stop' : 'Play')); }
    paint(TTS_TEXT, false);
    p.fx.onclick = async () => {
      if (tagging || tagged) return;
      takeOver(); did.tts = true; tagging = true; st.busy = true;
      const my = ++gen;
      p.fx.classList.add('busy'); p.fx.querySelector('span')!.textContent = 'Adding tags…';
      const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 8000);
      let out = TTS_FX;
      try { const r = await autoTag(TTS_TEXT, 'normal', ctrl.signal); if (/\[[^\]]+\]/.test(r.text)) out = r.text; note('autotag live'); }
      catch (e) { note('autotag fallback ' + ((e as Error)?.message || '')); }
      clearTimeout(to);
      tagging = false; p.fx.classList.remove('busy');
      if (my !== gen) { p.fx.querySelector('span')!.textContent = 'Make it expressive'; st.busy = false; return; }
      tagged = out;
      paint(out, true);
      p.fx.querySelector('span')!.textContent = 'Expressive';
      p.fx.disabled = true;
      p.note.textContent = 'Now press Play to hear it.';
      st.busy = false; act();
      react(pick(['r_tagged']));
    };
    p.play.onclick = () => {
      if (st.busy && !tagging) { st.abort(); act(); return; }
      if (tagging) return;
      takeOver(); did.tts = true;
      const my = ++gen, text = tagged || TTS_TEXT, kind = tagged ? 'fx' : 'plain';
      st.busy = true; setPlay(true); stopClip();
      const done = (ok: boolean) => {
        if (my !== gen) return;
        st.busy = false; setPlay(false); act();
        if (!ok) return;
        heard.add(kind);
        if (heard.size === 2) react(pick(['r_hear_tts']));
      };
      const statik = () => { note('tts static ' + kind); void say(kind === 'fx' ? 'tts_fx' : 'tts_plain', { who: 'tts', cap: false }).then(done); };
      if (liveFailed) { statik(); return; }
      note('tts live ' + kind);
      player.stop();
      player.speak(text, { voiceId: strixVoice(), who: 'tour', onEnd: (ok) => { if (my !== gen) return; if (ok) done(true); else { liveFailed = true; statik(); } } });
    };
    return st;
  })();

  /* ---------------- Voice Changer panel: before / after ---------------- */
  (() => {
    const p: VcPanel = P.vc;
    const heard = new Set<string>();
    p.rows.forEach((r) => {
      r.btn.onclick = () => {
        takeOver(); did.vc = true;
        if (cur?.who === 'vc:' + r.clip) { stopClip(); return; }
        p.rows.forEach((x) => x.el.classList.remove('nudge'));
        void say(r.clip, { who: 'vc:' + r.clip, cap: false }).then((ok) => {
          act();
          if (!ok) return;
          heard.add(r.clip);
          if (heard.size === 2) react(pick(['r_hear_vc']));
        });
      };
    });
    p.rec.onclick = () => {
      takeOver();
      p.recNote.textContent = 'Recording lives in the app. Try these:';
      p.rows.forEach((x) => { x.el.classList.remove('nudge'); void x.el.offsetWidth; x.el.classList.add('nudge'); });
    };
  })();

  /* ---------------- Voices: the voice MAP (map.ts) ----------------
     The panel (shown while the camera flies in and in the outro) holds a small static preview of the map's voices and
     the collection slots; once the camera is there the panel dissolves and the map dives in over the whole stage. */
  const sea = {
    rect: { x: 0, y: 0, w: 0, h: 0 } as Rect, gen: 0, v2said: false, heard: '',
    preview: [] as Array<{ u: number; v: number; r: number }>,
    fly: null as null | { voice: MapVoice; slot: number; t0: number; from: [number, number, number] },
    coll: [HERO, null, null, null] as Array<OrbSpec | null>, collIds: ['', '', '', ''] as string[],
    stop() { this.gen++; map.surfStop(); },
  };
  function measureSea() {
    const p: VoicesPanel = P.voices;
    const r = elRect(p, p.sea);
    sea.rect = r;
    // a static honeycomb of map voices inside the panel's sea (4 / 3 / 4 / 3)
    const ROWS = [4, 3, 4, 3], out: Array<{ u: number; v: number; r: number }> = [];
    ROWS.forEach((c, row) => { for (let k = 0; k < c; k++) out.push({ u: r.x + ((k + 0.5 + (4 - c) / 2) / 4) * r.w, v: r.y + ((row + 0.5) / ROWS.length) * r.h, r: Math.min(r.w / 8.6, r.h / 8.6) }); });
    sea.preview = out;
  }
  const mapVoices = () => (map.voices.length ? map.voices : STATIC_MAP);
  function invite(tok: number) {
    if (sea.v2said || tok !== stepTok || cur) return;
    sea.v2said = true;
    void say('t_voices2').then(() => { if (tok === stepTok) act(); });
  }
  /** "Just... listen for a sec": the camera glides to a voice in each of the biggest clusters, each speaks a moment */
  async function surf(tok: number) {
    const my = ++sea.gen;
    note('surf start');
    const ok = await map.surf(3, () => my === sea.gen && tok === stepTok);
    if (!ok || my !== sea.gen || tok !== stepTok) return;
    note('surf end');
    invite(tok);
  }
  const collFull = () => !sea.coll.includes(null);
  function addVoice(v: MapVoice, from: { x: number; y: number; r: number }): boolean {
    const slot = sea.coll.indexOf(null);
    if (slot < 0 || sea.collIds.includes(v.id) || sea.fly) return false;
    takeOver(); did.voices = true; sea.stop();
    sea.fly = { voice: v, slot, t0: clk, from: [from.x, from.y, from.r] };
    sea.collIds[slot] = v.id;   // reserved now (the button shows "Added" at once)
    note('add ' + v.name);
    return true;
  }
  function landFly() {
    const f = sea.fly!;
    sea.coll[f.slot] = f.voice.spec; sea.fly = null;
    const slots = collRow.children;
    slots[f.slot]?.replaceWith(collOrb(f.voice.spec));
    P.voices.collNote.textContent = `Your collection · ${f.voice.name} added`;
    map.paintCard();
    act();
    react(pick(['r_added']));
  }
  const collRow = h('div', { class: 'tu-mcoll', 'aria-label': 'Your collection (this tour only)' }, collOrb(HERO), collOrb(null), collOrb(null), collOrb(null));
  const map = new VoiceMap({
    reduced: () => reduced,
    guideBusy: () => !!cur && cur.who === 'guide',
    sayClip: (clip, who) => { if (player.busy) player.stop(); return say(clip, { who, cap: false }); },
    stopClip: () => { if (cur && cur.who !== 'guide') stopClip(); else if (cur && cur.who === 'guide') stopClip(); },
    clipAmp: (who) => envOf(who),
    clipPlaying: (who) => cur?.who === who,
    onUser: (kind) => {
      act();
      if (sid() !== 'voices') return;
      if (map.surfing) { sea.stop(); note('surf stopped by user'); }
      takeOver();
      if (!narrDone && kind !== 'nav') { narrDone = true; narrEndAt = clk; }
    },
    onHeard: (v) => {
      did.voices = true; sea.heard = v.id; P.voices.now.textContent = `${v.name} · ${v.desc}`;
      const tok = stepTok;
      // the invitation, once, after the first voice the user chose has had a moment
      setTimeout(() => { if (tok === stepTok && !cur && !player.busy) invite(tok); }, 4500);
    },
    onAdd: addVoice,
    inCollection: (id) => sea.collIds.includes(id),
    collectionFull: collFull,
  }, collRow);
  map.el.hidden = true; map.hud.hidden = true;
  root.insertBefore(map.el, flabels[0] || narr); root.insertBefore(map.hud, narr);
  void loadMapVoices(STATIC_MAP).then((r) => { if (!open) return; map.setVoices(r.voices, r.source, r.note); note('map voices ' + r.source + ' ' + r.voices.length + (r.note ? ' (' + r.note + ')' : '')); });
  let rr0: DOMRect | null = null;
  const rootRect = () => (rr0 ??= root.getBoundingClientRect());

  /* ---------------- render ---------------- */

  const pstate = PANELS.map(() => ({ op: 0, tf: '', blur: '', z: '', shown: false }));
  let pal = PALS.hello, palFrom = PALS.hello, palAt = -9, palSid: StepId = 'hello';
  let lastFocus: Rich | null = null;
  const mixHex = (a: string, b: string, k: number): Rgb => { const A = hexToRgb(a), B = hexToRgb(b); return [lerp(A[0], B[0], k), lerp(A[1], B[1], k), lerp(A[2], B[2], k)]; };

  function featLayout(i: number): { x: number; y: number; r: number } {
    if (L.mobile) {
      const col = i % 2, row = Math.floor(i / 2);
      return { x: L.W / 2 + (col ? 1 : -1) * Math.min(L.W * 0.23, 110), y: L.areaTop + L.areaH * (0.64 + row * 0.22), r: clamp(L.W * 0.07, 22, 34) };
    }
    const gap = Math.min(210, L.W * 0.16);
    return { x: L.W / 2 + (i - 1.5) * gap, y: L.areaTop + L.areaH * 0.8, r: clamp(L.areaH * 0.065, 26, 40) };
  }
  function helloGuide(): { x: number; y: number; r: number } {
    return L.mobile ? { x: L.W / 2, y: L.areaTop + L.areaH * 0.3, r: clamp(L.W * 0.24, 70, 104) } : { x: L.W / 2, y: L.areaTop + L.areaH * 0.36, r: clamp(L.areaH * 0.2, 80, 130) };
  }
  function wordAt(id: string, re: RegExp, fallback: number): number { const w = clips[id]?.words.find((x) => re.test(x[0])); return w ? w[1] : fallback; }

  function render() {
    const W = L.W, H = L.H;
    pose = camPose();
    const v = view(pose, W, H, L.cx, L.cy, F);

    const T = reduced ? 0 : clk;
    const s = sid();
    const fdist = Math.max(200, (() => { const q = project(v, pose.tgt); return q ? q.z : 1000; })());
    const rich: Rich[] = [], dots: Dot[] = [], bdots: Dot[] = [];
    const places = PANELS.map((_, i) => place(i));

    /* panels: opacity eases to its target; matrix3d from the camera; blur by distance from the focus plane */
    PANELS.forEach((p, i) => {
      const ps = pstate[i];
      let target = 0;
      if (s === 'outro') target = 0.8;
      else if (featStep()) target = i === step - 1 ? (step === 1 && stepT() < 0.9 && !reduced ? 0 : 1) : Math.abs(i - (step - 1)) === 1 && !L.mobile && !L.kb ? 0.42 : 0;
      if (map.active && s === 'voices') target = 0;   // the map took over the stage
      const k = reduced ? 1 : 1 - Math.exp(-dt * 4.2);
      ps.op += (target - ps.op) * k;
      if (Math.abs(ps.op - target) < 0.004) ps.op = target;
      const mx = ps.op > 0.004 ? matrix(v, places[i]) : null;
      const show = !!mx;
      if (show !== ps.shown) { p.el.hidden = !show; ps.shown = show; }
      if (!mx) return;
      if (mx !== ps.tf) { p.el.style.transform = mx; ps.tf = mx; }
      const o = ps.op.toFixed(3);
      if (p.el.style.opacity !== o) p.el.style.opacity = o;
      const q = project(v, places[i].c);
      const bl = s === 'outro' ? 2.5 : q ? Math.round(clamp((Math.abs(q.z - fdist) / fdist) * 10, 0, 6) * 2) / 2 : 0;
      const fl = bl > 0.25 && !reduced ? `blur(${bl}px)` : '';
      if (fl !== ps.blur) { p.el.style.filter = fl; ps.blur = fl; }
      const z = String(q ? Math.round(10000 - q.z) : 0);
      if (z !== ps.z) { p.el.style.zIndex = z; ps.z = z; }
    });
    const blurOf = (i: number) => (pstate[i].blur ? parseFloat(pstate[i].blur.slice(5)) : 0);
    /** an orb inside panel i at a slot / local point; culled when a nearer, opaque panel covers it */
    const panelOrb = (i: number, P3: V3, rw: number, spec: OrbSpec, o: Partial<Rich> = {}): Rich | null => {
      const op = pstate[i].op;
      if (op < 0.01 || !pstate[i].shown) return null;
      const q = project(v, P3);
      if (!q) return null;
      for (let j = 0; j < PANELS.length; j++) {
        if (j === i || pstate[j].op < 0.5 || !pstate[j].shown) continue;
        const qj = project(v, places[j].c);
        if (qj && qj.z < q.z - 20 && inQuad(v, places[j], q.x, q.y)) return null;
      }
      const r = rw * q.s;
      const b: Rich = { id: o.id || 'p' + i, x: q.x, y: q.y, r, spec, alpha: op * (o.alpha ?? 1), blur: clamp((blurOf(i) / Math.max(4, r)) * 1.1 + (o.blur ?? 0), 0, 1.2), amp: o.amp, z: o.z ?? 20 + i };
      rich.push(b);
      return b;
    };
    const slotPos = (i: number, name: string): [V3, number] | null => { const sl = PANELS[i].slots[name]; return sl ? [local(places[i], sl.u, sl.v), sl.r] : null; };

    /* chat panel orb (handed over from the hello feature orb when the first flight lands) */
    const fly1 = step === 1 && !reduced ? easeInOutCubic(prog(stepT(), 0, 2.0)) : 1;
    if (step >= 1) {
      const sc = slotPos(0, 'orb');
      if (sc && fly1 >= 1) panelOrb(0, sc[0], sc[1], HERO, { id: 'chat', amp: Math.max(tourAmp(), envOf('chat')) });
      const tv = slotPos(1, 'voice');
      if (tv) panelOrb(1, tv[0], tv[1], HERO, { id: 'tts', amp: tts.busy ? Math.max(tourAmp(), envOf('tts')) : 0 });
      const b4 = slotPos(2, 'before'), af = slotPos(2, 'after');
      if (b4) panelOrb(2, b4[0], b4[1], YOU, { amp: envOf('vc:vc_in') });
      if (af) panelOrb(2, af[0], af[1], HERO, { amp: envOf('vc:vc_out') });
      // collection slots: filled = orb, empty = a soft ring
      for (let c = 0; c < 4; c++) {
        const sp = slotPos(3, 'col' + c);
        if (!sp) continue;
        const spec = sea.coll[c];
        if (spec) panelOrb(3, sp[0], sp[1], spec, { id: 'col' + c });
        else if (pstate[3].op > 0.01) { const q = project(v, sp[0]); if (q) dots.push({ x: q.x, y: q.y, r: sp[1] * q.s * 0.98, mode: 1, alpha: 0.5 * pstate[3].op, c0: [0.6, 0.62, 0.7], c1: [0.6, 0.62, 0.7], c2: [1, 1, 1] }); }
      }
      // the panel's static preview of the map (only while the panel is visible: fly-in / outro)
      if (pstate[3].op > 0.01 && pstate[3].shown) {
        const mv = mapVoices();
        sea.preview.forEach((pp, j) => { const vv = mv[j % mv.length]; if (vv && j < mv.length) panelOrb(3, local(places[3], pp.u, pp.v), pp.r, vv.spec, { id: 'pv' + j, z: 30 }); });
      }
      vlabel.classList.remove('on');
      // the voice map (full stage) while it is active / fading
      map.frame(dt, T, rich, dots, bdots);
      // add: the orb flies from the map into its slot in the HUD collection row
      if (sea.fly) {
        const f = sea.fly, k = reduced ? 1 : easeInOutCubic(clamp((clk - f.t0) / 0.75));
        const el = collRow.children[f.slot] as HTMLElement | undefined, rr = rootRect();
        const er = el && !map.hud.hidden ? el.getBoundingClientRect() : null;
        const tx = er ? er.left + er.width / 2 - rr.left : L.cx, ty = er ? er.top + er.height / 2 - rr.top : L.H, tr = er ? er.width * 0.44 : 8;
        rich.push({ id: 'fly', x: lerp(f.from[0], tx, k), y: lerp(f.from[1], ty, k) - Math.sin(Math.PI * k) * 60, r: lerp(f.from[2], tr, k), spec: f.voice.spec, z: 60 });
        if (k >= 1) landFly();
      }
    }

    /* the guide (Strix) and the hello feature orbs */
    const hg = helloGuide();
    const gNarr = { x: L.guideX, y: L.narrY, r: L.guideR };
    const gk = s === 'hello' || s === 'outro' ? 0 : step === 1 && !reduced ? easeInOutCubic(prog(stepT(), 0.1, 1.5)) : 1;
    const outroK = s === 'outro' ? (reduced ? 1 : easeInOutCubic(prog(stepT(), 0, 1.6))) : 0;
    const gAmp = envOf('guide');
    const outroPos = { x: L.W / 2, y: L.areaTop + L.areaH * (L.mobile ? 0.26 : 0.3), r: clamp(Math.min(L.areaW, L.areaH) * 0.15, 48, 96) };
    const gx = s === 'outro' ? lerp(gNarr.x, outroPos.x, outroK) : lerp(hg.x, gNarr.x, gk);
    const gy = s === 'outro' ? lerp(gNarr.y, outroPos.y, outroK) : lerp(hg.y, gNarr.y, gk);
    let gr = s === 'outro' ? lerp(gNarr.r, outroPos.r, outroK) : lerp(hg.r, gNarr.r, gk);
    const intro = s === 'hello' && !reduced ? spring(clk - 0.05, 0.6, 6) : 1;
    gr *= (0.4 + 0.6 * Math.min(1.1, intro)) * (1 + gAmp * 0.07);
    if (L.kb) gr = 0;
    const gRich: Rich = { id: 'guide', x: gx, y: gy, r: gr, spec: HERO, amp: gAmp, alpha: s === 'hello' && !reduced ? easeOutCubic(prog(clk, 0, 0.8)) : 1, z: 50 };
    if (gr > 1) rich.push(gRich);
    if (gAmp > 0.05 && gr > 1) dots.push({ x: gx, y: gy, r: gr * 1.7, blur: 1.4, alpha: gAmp * 0.3, c0: HERO.colors[1], c1: HERO.colors[2], c2: HERO.colors[3] });
    lastFocus = gRich;

    // hello: four labelled feature orbs appear on their words; then they fly to their panels
    const showFeat = started && (s === 'hello' || (step === 1 && fly1 < 1));
    FEATURES.forEach((ft, i) => {
      const lab = flabels[i];
      if (!showFeat) { if (lab.classList.contains('on')) lab.classList.remove('on'); return; }
      const at = wordAt('t_hello', ft.word, 1.4 + i * 1.3) + 0.5;   // narration starts ~0.5 s into hello
      const appear = s === 'hello' ? (reduced ? (stepT() >= at ? 1 : 0) : spring(stepT() - at, 0.5, 11)) : 1;
      const fl = featLayout(i);
      let x = fl.x, y = fl.y, r = fl.r * Math.max(0, appear), alpha = Math.min(1, appear * 1.5);
      if (s !== 'hello') {
        const sp = i === 3 ? (() => { const pp = sea.preview[5]; return pp ? [local(places[3], pp.u, pp.v), pp.r] as [V3, number] : null; })() : slotPos(i, ['orb', 'voice', 'after'][i]);
        const q = sp ? project(v, sp[0]) : null;
        const tx = q ? q.x : x, ty = q ? q.y : y + L.H, tr = q && sp ? sp[1] * q.s : r * 0.5;
        x = lerp(x, tx, fly1); y = lerp(y, ty, fly1); r = lerp(r, tr, fly1);
        alpha = i === 0 ? 1 : 1 - easeInOutCubic(prog(fly1, 0.35, 0.9));
      }
      // the Chat orb turns into Strix (the chat panel's persona) while it flies in
      const wipe = i === 0 && s !== 'hello' ? easeInOutCubic(prog(fly1, 0.2, 0.9)) : 0;
      if (r > 0.5 && alpha > 0.01) rich.push({ id: 'f' + i, x, y, r, spec: FEAT_SPEC[i], to: wipe > 0 ? HERO : null, wipe, wipeDir: [0, 1], alpha, z: 40, amp: 0.05 });
      const lon = s === 'hello' && appear > 0.3;
      lab.classList.toggle('on', lon);
      lab.style.transform = `translate3d(${x.toFixed(1)}px,${(y + fl.r + 10).toFixed(1)}px,0) translateX(-50%)`;
    });

    /* background: palette per step (blended), glows near the guide / panel, bokeh with camera parallax */
    if (palSid !== s) { palFrom = pal; palSid = s; palAt = clk; }
    const pk = reduced ? 1 : easeInOutCubic(prog(clk, palAt, palAt + 1.4));
    const to = PALS[s];
    pal = pk >= 1 ? to : pal;
    const bg: Bg = {
      top: mixHex(palFrom.top, to.top, pk), bot: mixHex(palFrom.bot, to.bot, pk), glow: mixHex(palFrom.glow, to.glow, pk), glow2: mixHex(palFrom.glow2, to.glow2, pk),
      g: [s === 'hello' || s === 'outro' ? gx : L.cx, s === 'hello' || s === 'outro' ? gy : L.cy, Math.max(W, H) * 0.42],
      g2: [W * (0.28 + 0.12 * Math.sin(T * 0.07)), H * (0.88 + 0.05 * Math.cos(T * 0.05)), Math.max(W, H) * 0.45],
    };
    const R = rng(77), Smin = Math.min(W, H);
    for (let i = 0; i < (L.mobile ? 12 : 20); i++) {
      const x0 = R(), y0 = R(), z = 0.25 + R() * 1.1, sp = 0.004 + R() * 0.01, ph = R() * 6.28;
      const px = -pose.yaw * W * 0.5 * z - pose.p[0] * 0.08 * z, py = -pose.p[1] * 0.1 * z;
      const x = ((((x0 + T * sp * z + px / W) % 1.2) + 1.2) % 1.2 - 0.1) * W, y = (y0 * 1.1 - 0.05) * H + Math.sin(T * 0.3 + ph) * 12 + py;
      const ka = 1 - map.alpha * 0.85;   // the map brings its own depth (dust)
      if (ka > 0.02) bdots.push({ x, y, r: (6 + 30 * z) * (Smin / 700), blur: 0.6 + (1.2 - z) * 0.5, alpha: (0.08 + 0.14 * z) * ka, seed: R(), c0: HERO.colors[0], c1: HERO.colors[1], c2: HERO.colors[3] });
    }
    lastBg = bg;
    back.draw(bg, [], bdots, T);
    front.draw(null, rich, dots, T);
    lastRich = rich; lastDots = dots;
  }
  let lastBg: Bg | null = null, lastRich: Rich[] = [], lastDots: Dot[] = [];

  /* ---------------- the loop (never dies: an error in a frame is logged and the next frame still comes) ---------------- */
  let dt = 0, frames = 0;
  function tick(now: number) {
    raf = 0;
    if (!root.isConnected || leaving) return;
    try {
      dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now; frames++;
      if (!fps.t0) fps.t0 = now;
      fps.frames++;
      if (dt > fps.worst && started && fps.samples.length) fps.worst = dt;
      if (now - fps.t0 >= 1000) { fps.value = Math.round((fps.frames * 1000) / (now - fps.t0)); if (started) fps.samples.push(fps.value); if (fps.samples.length > 150) fps.samples.shift(); fps.frames = 0; fps.t0 = now; }
      clk += dt;
      if (started) {
        if (cur && cur.clockOnly && clipT() >= (clips[cur.id]?.dur ?? 0)) endClip(true);
        stepNarration();
        for (const c of cues) if (!c.done && stepT() >= c.at) { c.done = true; if (!(c.cam && tookOver)) c.fn(); }
        patience();
        if (player.pending > 0) P.chat.caps.tick(player.speechNow(), tourAmp());
        renderCaps();
        root.classList.toggle('hint-on', narrDone && !L.kb && sid() !== 'outro');
        vcProgress();
      }
      if (measured) render();
      root.classList.remove('pending');
    } catch (e) {
      errors.push(String((e as Error)?.stack || e).slice(0, 300)); if (errors.length > 20) errors.shift();
      console.error('tour frame', e);
    }
    if (open) schedule();
  }
  const schedule = () => { if (!raf && !document.hidden && !leaving) raf = requestAnimationFrame(tick); };
  function vcProgress() {
    for (const r of P.vc.rows) {
      const on = cur?.who === 'vc:' + r.clip;
      const p = on ? clamp(clipT() / (clips[r.clip]?.dur || 1)) : 0;
      const w = (p * 100).toFixed(1) + '%';
      if (r.bar.style.width !== w) r.bar.style.width = w;
      r.el.classList.toggle('playing', on);
      const icon = on ? 'stop' : 'play';
      if (r.btn.dataset.ic !== icon) { r.btn.dataset.ic = icon; r.btn.innerHTML = S(icon); }
    }
  }

  /* ---------------- start: by itself when allowed, else one gesture ---------------- */
  let manifest: Promise<boolean> | null = null;
  function load(): Promise<boolean> {
    manifest ??= fetch('/intro/tour.json', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))).then((m: { clips: Record<string, Clip> }) => {
      clips = m.clips || {};
      for (const [id, c] of Object.entries(clips)) fetch(c.src).then((r) => (r.ok ? r.blob() : null)).then((b) => { if (b && open) blobs[id] = URL.createObjectURL(b); }).catch(() => {});
      return true;
    }).catch((e) => { console.warn('tour: no assets', e); return false; });
    return manifest;
  }
  function start(withSound: boolean) {
    if (started || leaving) return;
    started = true;
    root.classList.remove('gated');
    gate.setAttribute('aria-hidden', 'true');
    setTimeout(() => gate.remove(), 600);
    if (!withSound) setMuted(true);
    note('start sound=' + withSound);
    enterStep(0);
    requestAnimationFrame(() => nextBtn.focus({ preventScroll: true }));
  }
  function unlock(): Promise<boolean> {
    if (!clips.t_hello) return Promise.resolve(false);
    au.src = urlOf('t_hello');
    const p = au.play();
    if (!p) return Promise.resolve(true);
    return p.then(() => { au.pause(); try { au.currentTime = 0; } catch { /* */ } return true; }).catch((e: DOMException) => e?.name !== 'NotAllowedError');
  }
  void load().then((ok) => {
    if (!open) return;
    if (!ok) { gSkip.hidden = false; skipTour.hidden = false; root.classList.add('ask'); return; }  // assets missing: never trap the user
    void unlock().then((can) => { if (!open || started) return; if (can) start(true); else root.classList.add('ask'); });
    setTimeout(() => root.classList.add('ask'), 450);
  });
  gPlay.onclick = () => { void load().then((ok) => (ok ? unlock() : false)).then((can) => start(!!can)); };
  gSkip.onclick = () => finish('skipped');

  /* ---------------- controls ---------------- */
  nextBtn.onclick = () => next();
  skipStep.onclick = () => skipThis();
  startBtn.onclick = () => finish('finished');
  skipTour.onclick = () => finish('skipped');
  soundBtn.onclick = () => setMuted(false);
  world.addEventListener('pointerdown', () => act(), true);
  world.addEventListener('keydown', () => act(), true);
  function onKey(e: KeyboardEvent) {
    if (leaving) return;
    const k = e.key, tgt = e.target as HTMLElement;
    const inField = tgt?.tagName === 'TEXTAREA' || tgt?.tagName === 'INPUT';
    if (k === 'Escape') { if (inField) { tgt.blur(); return; } e.preventDefault(); e.stopPropagation(); if (!skipTour.hidden) finish('skipped'); return; }  // Esc only skips while the skip button is available
    if (!started) { if (k === 'Enter' && tgt?.tagName !== 'BUTTON') { e.preventDefault(); gPlay.click(); } return; }
    if (inField) return;
    // the voice map handles its own keys (arrows pan, +/- zoom, Enter, A)
    if (tgt === map.el && k !== 'm' && k !== 'M') { act(); return; }
    act();
    if (k === 'ArrowRight' && sid() !== 'outro') { e.preventDefault(); next(); }
    else if ((k === 'm' || k === 'M')) { e.preventDefault(); setMuted(!muted); }
    else if (k === 'Enter' && sid() === 'outro' && tgt?.tagName !== 'BUTTON') { e.preventDefault(); finish('finished'); }
  }
  addEventListener('keydown', onKey, true);
  let wasPlaying = false;
  const onVis = () => {
    if (document.hidden) { wasPlaying = !!cur && !au.paused; if (wasPlaying) au.pause(); if (raf) cancelAnimationFrame(raf); raf = 0; last = 0; }
    else { if (wasPlaying && cur && !cur.clockOnly) au.play().catch(() => {}); last = 0; schedule(); }
  };
  document.addEventListener('visibilitychange', onVis);
  const onResize = () => { layout(); schedule(); };
  addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('scroll', onResize);
  const onReduce = () => { reduced = reduceMq.matches; root.classList.toggle('reduced', reduced); };
  reduceMq.addEventListener?.('change', onReduce);
  root.classList.toggle('reduced', reduced);

  /* ---------------- end: Strix's orb flies into the Chat orb; the stage dissolves; the app rises in ---------------- */
  function finish(how: 'finished' | 'skipped') {
    if (!open) return;
    open = false; leaving = true;
    note('finish ' + how);
    if (raf) cancelAnimationFrame(raf); raf = 0;
    stepTok++;
    chat.abort(); tts.abort(); sea.stop(); map.dispose(); stopClip();
    if (player.speaker === 'tour' || player.pending) player.stop();
    removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('scroll', onResize);
    reduceMq.removeEventListener?.('change', onReduce);
    au.removeAttribute('src'); au.load();
    for (const u of Object.values(blobs)) URL.revokeObjectURL(u);
    (document.activeElement as HTMLElement | null)?.blur?.();
    opts.onDone?.(how);
    transitionOut();
  }
  function transitionOut() {
    root.classList.add('leaving');
    root.setAttribute('aria-hidden', 'true');
    const t0 = performance.now(), wall0 = Date.now();
    const done = () => { root.remove(); html.classList.remove('intro-open', 'intro-reveal', 'intro-landed'); (window as unknown as { __trailerOut?: unknown }).__trailerOut = { done: true, ms: Math.round(performance.now() - t0), wall0 }; };
    if (reduced || !started) { root.classList.add('fade'); html.classList.remove('intro-open'); setTimeout(done, 320); return; }
    const target = chatOrb();
    const tr = target?.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    const from: Rich = lastFocus && lastFocus.r > 4 ? { ...lastFocus } : { id: 'hero', x: L.W / 2, y: L.cy, r: 60, spec: HERO };
    const FLY = 620, END = 860;
    const toSpec = target?._spec ?? HERO;
    const live = (target as unknown as { _live?: { time: number } } | null)?._live;
    const fromTime = from.time ?? HERO.t0 + clk * 0.45 * (HERO.speed ?? 1);
    const toTime = () => (live ? fromTime + (FLY / 1000) * 0.45 : toSpec.t0);
    const tx = tr ? tr.left + tr.width / 2 - rr.left : from.x, ty = tr ? tr.top + tr.height / 2 - rr.top : from.y;
    const tR = tr ? tr.width * 0.44 : from.r * 0.4;
    const bg = lastBg;
    html.classList.add('intro-reveal');
    html.classList.remove('intro-open');
    const step2 = () => {
      const el = performance.now() - t0;
      const p = easeInOutCubic(clamp(el / FLY));
      const fade = 1 - easeOutCubic(clamp(el / 460));
      const ball: Rich = {
        id: 'out', x: lerp(from.x, tx, p), y: lerp(from.y, ty, p), r: lerp(from.r, tR, p), spec: HERO,
        to: HERO.key !== toSpec.key ? toSpec : null, wipe: p, wipeDir: [0, 1], amp: lerp(from.amp ?? 0, 0, p),
        alpha: tr ? 1 - clamp((el - FLY) / (END - FLY - 40)) : 1 - p,
        time: Math.abs(toTime() - fromTime) < 4 ? lerp(fromTime, toTime(), p) : fromTime + (el / 1000) * 0.45,
      };
      if (el >= FLY && !html.classList.contains('intro-landed')) { html.classList.add('intro-landed'); if (live) live.time = ball.time!; }
      if (bg) back.draw({ ...bg, fade }, [], [], clk);
      front.draw(null, [ball], [], clk);
      if (el < END) requestAnimationFrame(step2); else done();
    };
    requestAnimationFrame(step2);
  }

  /* ---------------- test hook ---------------- */
  (window as unknown as { __tour?: unknown }).__tour = () => ({
    step: sid(), stepT: stepT(), clk, frames, narrEndAt, started, muted, reduced, leaving, narrDone, busy: started ? busy() : false, tookOver, did: { ...did }, kb: L.kb, errors: errors.slice(),
    clip: cur ? { id: cur.id, who: cur.who, t: clipT(), clockOnly: cur.clockOnly, audioT: au.currentTime, paused: au.paused } : null,
    caption: capLine.textContent, hint: hintLine.textContent, chatCaption: P.chat.caps.el.textContent, chatStatus: P.chat.status.textContent, chatBusy: chat.busy,
    ttsText: P.tts.text.textContent, ttsTags: P.tts.text.querySelectorAll('mark.tg').length, ttsBusy: tts.busy,
    sea: { surfing: map.surfing, coll: sea.collIds.slice(), heard: sea.heard, v2said: sea.v2said },
    map: () => map.state(),
    capLog: capLog.slice(), chatCaps: P.chat.caps.log.slice(), log: log.slice(), renderer: front.kind,
    fps: { now: fps.value, samples: fps.samples.slice(), worstFrameMs: Math.round(fps.worst * 1000) },
    panels: PANELS.map((p, i) => ({ id: p.id, op: +pstate[i].op.toFixed(3), shown: pstate[i].shown, blur: pstate[i].blur, h: p.h })),
    orbs: lastRich.map((b) => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), r: +b.r.toFixed(1) })),
    next: () => next(), skip: () => skipThis(), go: (i: number) => go(i), mute: (m: boolean) => setMuted(m), idle: (s: number) => { lastAct = clk - s; },
    probe: (max = 40) => front.probe(lastRich, lastDots, clk, max),
  });

  layout();
  schedule();
  requestAnimationFrame(() => gPlay.focus({ preventScroll: true }));
}
