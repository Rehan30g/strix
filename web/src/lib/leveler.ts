/* Voice auto-leveling ("Samakan volume suara"): every voice and every audio tag comes out of TTS at its own loudness
   (measured with ffmpeg ebur128 on /api/tts, same sentence: Strix -21.8 LUFS, Lena -29.6, a clone -17.7; Strix [whispers]
   -28.0 .. [shouting] -18.6). This module evens that out on the client, without flattening the expression:
   - measure: a K-weighting approximation (high shelf +4 dB @ 1.5 kHz, high-pass 38 Hz) into an AnalyserNode, polled
     every 40 ms; 400 ms windows every 100 ms, gated like EBU R128 (absolute -70, relative -10 LU) = integrated loudness of
     the clip so far. Measured BEFORE the gain, so duck / mute / the leveler itself never bias it.
   - remember: per key (voice id, 'pv:<id>' for preview files, 'static:intro') the last 9 clip loudnesses in localStorage
     (median = the voice's usual level, robust against an occasional [whispers]); built-in voices have measured defaults.
     Per audio tag ('tag:whispers' ...) how far it usually sits from its voice's usual level (measured defaults, learned).
   - correct: gain = (target - usual) - 70% of (this clip - usual): the voice difference is removed, a tag's own
     difference keeps 30% (whisper stays softer, shouting louder: ~9 dB -> ~3 dB). The clip's leading tag gives the
     expected deviation from the first sample on; the measurement takes over within ~0.8 s of speech. An unknown voice
     starts from a prior and adapts within ~0.4 s. Gain -8..+12 dB, smooth setTargetAtTime ramps (no clicks, no pumping:
     the estimate is integrated over the clip, not momentary).
   - protect: makeLimiter() = DynamicsCompressor used as a peak limiter at the end of the chain (about -1 dBFS ceiling),
     with its automatic makeup gain cancelled so quiet material passes at unity.
   Off (account setting prefs.levelVoices = false): gain 1 and the owner bypasses the limiter = the old behaviour. */
import { settings } from '../settings';

export const TARGET_LUFS = -20;
/** share of a clip's own deviation from its voice's usual level that is KEPT (0.3 = 70% corrected) */
export const KEEP = 0.3;
export const G_MIN = -8, G_MAX = 12;
/** the tour's static clips (public/intro/*.mp3) were all mastered to this (ffmpeg ebur128: -18.3 .. -18.8) */
export const STATIC_LUFS = -18.4;

/** measured defaults (ffmpeg ebur128 integrated loudness of /api/tts output, plain sentence) */
const DEFAULTS: Record<string, number> = {
  FjsOoJ0RVxWEQK4p2Wzq: -21.8,   // Strix
  roYauZ4bOLAKvVZTPLre: -29.6,   // Lena
  'static:intro': STATIC_LUFS,
};

/** how far a delivery tag usually sits from the voice's plain level, dB (ffmpeg on /api/tts, same sentence) */
const TAG_DEV: Record<string, number> = {
  whispers: -6.2, softly: -4.1, quietly: -4, gently: -3, sad: -2, tired: -2, sighs: -1.5, dry: -0.6,
  angry: 3, annoyed: 3, shouting: 3.2, excited: 3.5, laughs: 0.5,
};
const TAG_ALIAS: Record<string, string> = {
  whisper: 'whispers', whispering: 'whispers', whispered: 'whispers', soft: 'softly', quiet: 'quietly',
  shout: 'shouting', shouts: 'shouting', yelling: 'shouting', yells: 'shouting', screaming: 'shouting',
  angrily: 'angry', furious: 'angry', laughing: 'laughs', laugh: 'laughs', excitedly: 'excited',
};
/** the delivery tag that shapes a chunk: the first [tag] in its first half that is not an accent / pause / breath ('' = plain) */
export function tagOf(text: string | null | undefined): string {
  const t = String(text || '');
  const re = /\[([^\]]{1,40})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index > t.length / 2) break;
    const k = m[1].trim().toLowerCase();
    if (/accent|pause|breath|inhale|exhale|throat|gulp|^beat$|silence/.test(k)) continue;   // not a delivery
    return TAG_ALIAS[k] || k;
  }
  return '';
}

const db2lin = (d: number) => Math.pow(10, d / 20);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lufsOf = (ms: number) => -0.691 + 10 * Math.log10(Math.max(ms, 1e-12));
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

/* ---------------- setting ---------------- */
/** "Samakan volume suara" (account sheet), default on */
export const levelingOn = (): boolean => settings.prefs().levelVoices !== false;
const listeners = new Set<(on: boolean) => void>();
let lastOn: boolean | null = null;
settings.subscribe('prefs', () => { const on = levelingOn(); if (on !== lastOn) { lastOn = on; listeners.forEach((f) => { try { f(on); } catch (e) { console.error(e); } }); } });
export function onLevelingChange(fn: (on: boolean) => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** volume (0..1) for a plain <audio> playing the tour's static clips: they are 1.6 dB above the target */
export const staticClipVolume = (): number => (levelingOn() ? Math.min(1, db2lin(TARGET_LUFS - STATIC_LUFS)) : 1);

/* ---------------- per-voice memory (localStorage, safe fallback = in memory only) ---------------- */
type Rec = { h: number[]; t: number };
const LS = 'sm2.leveler.v1';
const HIST = 9, MAX_KEYS = 300;
let store: Record<string, Rec> | null = null;
let saveT: ReturnType<typeof setTimeout> | null = null;
function load(): Record<string, Rec> {
  if (store) return store;
  store = {};
  try {
    const v = JSON.parse(localStorage.getItem(LS) || 'null');
    if (v && typeof v === 'object') for (const [k, r] of Object.entries(v as Record<string, Rec>)) {
      const h = Array.isArray(r?.h) ? r.h.filter((x) => typeof x === 'number' && Number.isFinite(x) && x > -70 && x < 15).slice(-HIST) : [];
      if (h.length) store[k] = { h, t: Number(r.t) || 0 };
    }
  } catch { /* private mode / bad JSON: start empty */ }
  return store;
}
function save() {
  if (saveT) clearTimeout(saveT);
  saveT = setTimeout(() => {
    saveT = null;
    const s = load();
    const keys = Object.keys(s);
    if (keys.length > MAX_KEYS) keys.sort((a, b) => s[a].t - s[b].t).slice(0, keys.length - MAX_KEYS).forEach((k) => delete s[k]);
    try { localStorage.setItem(LS, JSON.stringify(s)); } catch { /* quota: keep in memory */ }
  }, 800);
}
/** usual loudness (LUFS) of a key, null = unknown */
export function usualOf(key: string | null): number | null {
  if (!key) return null;
  const h = load()[key]?.h || [];
  const d = DEFAULTS[key];
  const xs = d != null ? [...h, d, d] : h;
  return xs.length ? median(xs) : null;
}
/** expected deviation (dB) of a tagged clip from its voice's usual level (0 = plain / unknown tag) */
export function tagDevOf(tag: string): number {
  if (!tag) return 0;
  const h = load()['tag:' + tag]?.h || [];
  const d = TAG_DEV[tag];
  const xs = d != null ? [...h, d, d] : h;
  return xs.length ? clamp(median(xs), -10, 10) : 0;
}
function record(key: string, l: number, lo = -70, hi = 0) {
  if (!(l > lo && l < hi)) return;
  const s = load();
  const r = s[key] || (s[key] = { h: [], t: 0 });
  r.h.push(+l.toFixed(2)); if (r.h.length > HIST) r.h.shift();
  r.t = Date.now();
  save();
}
/** gain to start an unknown voice with: from the usual level of the other voices of the same kind */
function priorGain(key: string | null): number {
  const s = load();
  const pv = !!key && key.startsWith('pv:');
  const xs = Object.entries(s).filter(([k]) => !k.startsWith('static:') && !k.startsWith('tag:') && k.startsWith('pv:') === pv).map(([, r]) => median(r.h));
  const typical = xs.length >= 3 ? median(xs) : -23;
  return clamp(TARGET_LUFS - typical, -4, 6);
}
/** test hook: forget everything learned */
export function resetLevelMemory(): void { store = {}; try { localStorage.removeItem(LS); } catch { /* ignore */ } }
export function levelMemory(): Record<string, { usual: number | null; h: number[] }> {
  const out: Record<string, { usual: number | null; h: number[] }> = {};
  for (const k of new Set([...Object.keys(DEFAULTS), ...Object.keys(load())])) out[k] = { usual: usualOf(k), h: [...(load()[k]?.h || [])] };
  return out;
}

/* ---------------- limiter ---------------- */
/** Peak limiter: DynamicsCompressor (threshold -3.5 dB, ratio 20, hard knee, 2 ms attack) between two gains that cancel
    its built-in makeup gain ((1/curve(1))^0.6 = +2 dB), so below about -1.5 dBFS the signal passes at unity (checked
    with an OfflineAudioContext sine sweep). */
export function makeLimiter(actx: BaseAudioContext): { input: GainNode; output: GainNode } {
  const thr = -3.5, ratio = 20;
  const makeup = 0.6 * -(thr + (0 - thr) / ratio);           // dB the compressor adds to everything
  const input = actx.createGain(); input.gain.value = db2lin(-makeup);
  const comp = actx.createDynamicsCompressor();
  comp.threshold.value = thr; comp.knee.value = 0; comp.ratio.value = ratio; comp.attack.value = 0.002; comp.release.value = 0.12;
  const output = actx.createGain(); output.gain.value = 1;
  input.connect(comp); comp.connect(output);
  return { input, output };
}

/* ---------------- the leveler ---------------- */
export interface LevelLog { key: string | null; tag: string; usual: number | null; g0: number; lufs: number | null; active: number; gEnd: number; at: number }

export class Leveler {
  /** the leveling gain: feed it from the source, take the output from it */
  readonly gain: GainNode;
  readonly log: LevelLog[] = [];
  private an: AnalyserNode;
  private buf: Float32Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private key: string | null = null;
  private tag = '';
  private dev = 0;
  private usual: number | null = null;
  private g0 = 0;
  private gDb = 0;
  private blocks: Array<{ t: number; ms: number }> = [];
  private wins: number[] = [];
  private lastWin = 0;
  private on = levelingOn();
  private live = false;

  constructor(private actx: BaseAudioContext, src: AudioNode) {
    this.gain = actx.createGain();
    src.connect(this.gain);
    const shelf = actx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1500; shelf.gain.value = 4;
    const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
    this.an = actx.createAnalyser(); this.an.fftSize = 2048; this.an.smoothingTimeConstant = 0;
    this.buf = new Float32Array(this.an.fftSize);
    src.connect(shelf); shelf.connect(hp); hp.connect(this.an);
  }

  get enabled(): boolean { return this.on; }
  /** current leveling gain in dB (0 when off) */
  get currentDb(): number { return this.on ? this.gDb : 0; }
  get clipKey(): string | null { return this.key; }

  setEnabled(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.ramp(on ? this.gDb : 0, 0.08, true);
  }

  /** A new clip of `key` is about to play (silence now): set its starting gain and start measuring.
      `text` (TTS chunk) gives the delivery tag, whose usual deviation is corrected from the first sample on. */
  begin(key: string | null, text?: string | null): void {
    if (this.live) this.end();
    this.key = key; this.usual = usualOf(key);
    this.tag = tagOf(text); this.dev = tagDevOf(this.tag);
    this.g0 = clamp((this.usual != null ? TARGET_LUFS - this.usual : priorGain(key)) - (1 - KEEP) * this.dev, G_MIN, G_MAX);
    this.blocks = []; this.wins = []; this.lastWin = 0;
    this.gDb = this.g0;
    this.ramp(this.g0, 0.012, true);
    this.live = true;
    if (!this.timer) this.timer = setInterval(() => this.tick(), 40);
  }

  /** The clip ended (or was stopped): remember its loudness when enough speech was measured. */
  end(): void {
    if (!this.live) return;
    this.live = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const m = this.integrated();
    if (this.key && m.lufs != null && m.active >= 0.8) {
      // the voice's memory keeps its plain level (a tagged clip minus the tag's usual deviation); the tag learns its own
      record(this.key, m.lufs - this.dev);
      if (this.tag && this.usual != null && (load()[this.key]?.h.length || 0) >= 3) record('tag:' + this.tag, m.lufs - this.usual, -15, 15);
    }
    this.log.push({ key: this.key, tag: this.tag, usual: this.usual, g0: +this.g0.toFixed(2), lufs: m.lufs == null ? null : +m.lufs.toFixed(2), active: +m.active.toFixed(2), gEnd: +this.gDb.toFixed(2), at: Date.now() });
    if (this.log.length > 60) this.log.shift();
  }

  /** integrated (gated) loudness of the clip so far + seconds of gated speech */
  integrated(): { lufs: number | null; active: number } {
    const abs = this.wins.filter((e) => lufsOf(e) > -70);
    if (!abs.length) return { lufs: null, active: 0 };
    const rel = lufsOf(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
    const g = abs.filter((e) => lufsOf(e) > rel);
    return { lufs: lufsOf(g.reduce((a, b) => a + b, 0) / g.length), active: g.length * 0.1 };
  }

  private tick() {
    const now = performance.now();
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0; const b = this.buf;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    this.blocks.push({ t: now, ms: s / b.length });
    while (this.blocks.length && this.blocks[0].t < now - 400) this.blocks.shift();
    if (now - this.lastWin < 100 || this.blocks.length < 2) return;
    this.lastWin = now;
    this.wins.push(this.blocks.reduce((a, x) => a + x.ms, 0) / this.blocks.length);
    const { lufs, active } = this.integrated();
    if (lufs == null || active < 0.15) return;
    let want: number;
    if (this.usual != null) {
      const w = Math.min(1, active / 0.8);
      const dev = (1 - w) * this.dev + w * (lufs - this.usual);
      want = TARGET_LUFS - this.usual - (1 - KEEP) * dev;
    } else {
      // unknown voice: its plain level ~ this clip minus the tag's usual deviation
      const w = Math.min(1, active / 0.4);
      want = this.g0 + w * (TARGET_LUFS - lufs + KEEP * this.dev - this.g0);
    }
    want = clamp(want, G_MIN, G_MAX);
    if (Math.abs(want - this.gDb) < 0.1) return;
    this.gDb = want;
    this.ramp(want, active < 1.2 ? 0.12 : 0.5);
  }

  private ramp(db: number, tau: number, force = false) {
    const g = this.gain.gain, t = this.actx.currentTime;
    const v = this.on ? db2lin(db) : 1;
    if (!force && !this.on) return;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.setTargetAtTime(v, t, tau);
  }
}
