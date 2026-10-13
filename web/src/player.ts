/* Single shared audio player (ported from old coffee-voice.js / voice.js).
   - ONE <audio> element reused for everything (avoids "media removed" errors, keeps the FX graph attached)
   - speak(): each chunk's TTS request starts immediately (parallel fetch) but chunks PLAY strictly in order
   - stream mode: MediaSource + SourceBuffer('audio/mpeg'), playback starts once ~0.35 s is buffered
   - full / simple modes: download whole mp3 then play from a Blob (simple = no Web Audio graph at all)
   - stop(): bumps the generation, aborts all in-flight/queued TTS requests and silences the element
   - speechNow(): progress (0..1) inside the chunk currently playing, for text typed in sync with speech
   - optional "cheap microphone" FX + analyser (level()) via Web Audio, initialised lazily
   - duck()/unduck(): lower / restore the output volume (full-duplex chat: the user starts talking)
   - fadeStop(): short fade (< 150 ms) then stop() (an interruption must not click) */
import { api, type Tune } from './api';
import { tune as savedTune } from './settings';

export type PlayerMode = 'stream' | 'full' | 'simple';
export type FxLevel = 'light' | 'medium' | 'strong';
export interface SpeechMeta { sid: string; kind?: string; a: number; b: number }
export interface SpeakOptions {
  voiceId: string;
  tune?: Partial<Tune>;         // default: the user's saved tune (settings 'tune')
  fx?: boolean;                  // cheap-mic FX for this chunk (needs mode !== 'simple')
  who?: string | null;           // who is talking (UI: 'agent' | 'coffee' | character id …)
  call?: boolean;                // spoken inside a phone call
  meta?: SpeechMeta | null;      // text range this chunk covers (for speechNow)
  onStart?: () => void;
  onEnd?: (completed: boolean) => void;   // completed=false when stopped/failed
}
export interface SpeechNow {
  sid: string; kind?: string; who: string; a: number; b: number; p: number;
  /** seconds played inside the current chunk (the element's real currentTime) */
  t: number;
  /** chunk duration in seconds when known (0 = unknown yet) */
  dur: number;
  /** true once the whole chunk is buffered, so `dur` is final */
  final: boolean;
  /** seconds buffered so far (lower bound of the duration while streaming) */
  buffered: number;
  /** estimated output latency in seconds (audio graph + device) */
  lat: number;
  /** the element is actually playing (not waiting for data) */
  playing: boolean;
}
export interface Level { who: string | null; call: boolean; amp: number; freq: Uint8Array | null }
export type PlayerEvent = 'change' | 'error';

const FX_LEVELS: Record<FxLevel, { hp: number; lp: number; pk: number; drive: number; noise: number; gain: number }> = {
  light: { hp: 250, lp: 5200, pk: 2, drive: 2, noise: 0.004, gain: 1.0 },
  medium: { hp: 380, lp: 3600, pk: 5, drive: 6, noise: 0.010, gain: 1.15 },
  strong: { hp: 520, lp: 2800, pk: 8, drive: 14, noise: 0.022, gain: 1.3 },
};

function satCurve(k: number): Float32Array<ArrayBuffer> {
  const n = 1024, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
  return c;
}

interface FxGraph { dry: GainNode; wet: GainNode; hp: BiquadFilterNode; lp: BiquadFilterNode; pk: BiquadFilterNode; ws: WaveShaperNode; ng: GainNode; kg: GainNode; master: GainNode }

export class Player {
  readonly el: HTMLAudioElement;
  readonly canMSE = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
  mode: PlayerMode = 'stream';
  fxLevel: FxLevel = 'medium';
  /** Last error message ('' when fine). */
  err = '';
  readonly fxLog: Array<Record<string, unknown>> = [];

  private gen = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private cancel: (() => void) | null = null;
  private ctrl = new AbortController();
  private _pending = 0;
  private who: string | null = null;
  private call = false;
  private meta: SpeechMeta | null = null;
  private bytes = 0;
  private final = false;
  private actx: AudioContext | null = null;
  private fxg: FxGraph | null = null;
  private an: AnalyserNode | null = null;
  private warmT: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<() => void> = [];
  private subs = new Map<PlayerEvent, Set<(p?: any) => void>>();
  private tbuf = new Uint8Array(512);
  private fbuf = new Uint8Array(256);
  private previewing = false;
  private duckTo = 1;
  private fadeT: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => { if (this.previewing) { this.previewing = false; this.who = null; this.emit('change'); } });
  }

  /* ---------- state ---------- */
  /** Number of queued + playing chunks. */
  get pending(): number { return this._pending; }
  /** True while any chunk is queued/playing or a preview URL is playing. */
  get busy(): boolean { return this._pending > 0 || this.previewing; }
  /** Who is audible right now (null between chunks). */
  get speaker(): string | null { return this.who; }
  get inCall(): boolean { return this.call; }
  /** Generation counter: changes on every stop(). Capture it to detect cancellation. */
  get generation(): number { return this.gen; }
  ctxState(): string { return this.actx?.state || 'none'; }

  on(ev: PlayerEvent, fn: (p?: any) => void): () => void {
    let s = this.subs.get(ev); if (!s) this.subs.set(ev, (s = new Set()));
    s.add(fn); return () => { s!.delete(fn); };
  }
  private emit(ev: PlayerEvent, p?: unknown) {
    if (ev === 'change') this.flushWaiters();
    this.subs.get(ev)?.forEach((fn) => { try { fn(p); } catch (e) { console.error(e); } });
  }

  /* ---------- stop ---------- */
  stop(): void {
    if (this.fadeT) { clearTimeout(this.fadeT); this.fadeT = null; }
    this.gen++; this._pending = 0; this.who = null; this.call = false; this.meta = null; this.previewing = false;
    this.lineOff();
    this.ctrl.abort(); this.ctrl = new AbortController();
    this.gaps.forEach((g) => g()); this.gaps.clear();
    const c = this.cancel; this.cancel = null; c?.();
    this.el.pause(); this.el.removeAttribute('src'); this.el.load();
    if (this.plain && !this.plain.paused) this.plain.pause();
    this.setGain(1, 0);
    this.emit('change');
  }

  /* ---------- duck / fade (full-duplex chat) ---------- */
  /** true while the output is ducked */
  get ducked(): boolean { return this.duckTo < 1; }
  /** current output gain target (1 = normal) */
  get gainTarget(): number { return this.duckTo; }
  private setGain(v: number, sec: number) {
    this.duckTo = v;
    const out = this.mute ? 0 : v;
    const f = this.fxg, a = this.actx;
    if (f && a) {
      const g = f.master.gain, t = a.currentTime;
      g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
      if (sec <= 0) g.setValueAtTime(out, t); else g.linearRampToValueAtTime(out, t + sec);
    } else this.el.volume = Math.max(0, Math.min(1, out));
  }
  private mute = false;
  /** Silence the output without stopping it (group call "Bisukan"): playback, clocks and captions go on. */
  setMuted(on: boolean): void { this.mute = on; this.setGain(this.duckTo, 0.08); }
  get muted(): boolean { return this.mute; }
  /** Lower the volume quickly (default -14 dB in 60 ms). */
  duck(to = 0.2, sec = 0.06): void { if (this.fadeT) return; this.setGain(to, sec); }
  /** Restore the volume. */
  unduck(sec = 0.25): void { if (this.fadeT) return; this.setGain(1, sec); }
  /** Fade out in `ms` (default 120) and stop everything (queued chunks + requests). */
  fadeStop(ms = 120): Promise<void> {
    if (this.fadeT) clearTimeout(this.fadeT);
    if (this.el.paused || !this.who) { this.stop(); return Promise.resolve(); }
    this.setGain(0, ms / 1000);
    return new Promise((res) => { this.fadeT = setTimeout(() => { this.fadeT = null; this.stop(); res(); }, ms + 8); });
  }

  /* ---------- speak ---------- */
  /** Queue one chunk of text. The TTS request starts now; playback waits for earlier chunks.
      Resolves when the chunk finished playing, failed, or was cancelled by stop(). Never rejects. */
  speak(text: string, opts: SpeakOptions): Promise<void> {
    text = String(text || '').trim();
    if (!text) return Promise.resolve();
    const gen = this.gen;
    const t = { ...savedTune(), ...(opts.tune || {}) };
    const req = api.tts({ text, voiceId: opts.voiceId, tune: t }, this.ctrl.signal);
    req.catch(() => {});                              // reported in the chain
    if (this.mode !== 'simple') { this.initFx(); this.warm(); }
    this._pending++; this.err = ''; this.emit('change');
    let completed = false;
    const run = this.chain
      .then(async () => { if (gen === this.gen) { completed = await this.play(req, gen, opts); } })
      .catch((e: any) => {
        if (gen !== this.gen || e?.code === 'aborted') return;
        this.err = e?.message || String(e); console.warn('TTS:', this.err); this.emit('error', e);
      })
      .finally(() => {
        try { opts.onEnd?.(completed && gen === this.gen); } catch (e) { console.error(e); }
        if (gen === this.gen) { this._pending--; this.emit('change'); }
        api.usageChanged();
      });
    this.chain = run;
    return run.then(() => undefined);
  }

  private gaps = new Set<() => void>();
  /** Queue a silent pause of `ms` after everything queued so far (e.g. between dialogue lines). Counts as pending;
      stop() ends it at once. */
  gap(ms: number): Promise<void> {
    const gen = this.gen;
    this._pending++; this.emit('change');
    const run = this.chain.then(() => (gen !== this.gen || ms <= 0) ? undefined : new Promise<void>((res) => {
      const end = () => { clearTimeout(t); this.gaps.delete(end); res(); };
      const t = setTimeout(end, ms);
      this.gaps.add(end);
    })).finally(() => { if (gen === this.gen) { this._pending--; this.emit('change'); } });
    this.chain = run;
    return run;
  }

  private async play(req: Promise<Response>, gen: number, opts: SpeakOptions): Promise<boolean> {
    const r = await req;
    if (gen !== this.gen) return false;
    if (this.mode !== 'simple') await this.setFx(!!opts.fx);
    if (gen !== this.gen) return false;
    this.who = opts.who ?? 'tts'; this.call = !!opts.call; this.meta = opts.meta || null; this.bytes = 0; this.final = false;
    const el = this.el; let url = '';
    let ok = false;
    await new Promise<void>((done) => {
      const hard = setTimeout(() => finish(), 60000);       // safety: one chunk max 60 s
      const finish = (good = false) => { clearTimeout(hard); ok = ok || good; this.cancel = null; done(); };
      this.cancel = () => finish();
      el.onended = () => finish(true);
      el.onerror = () => finish();
      el.onplaying = () => { try { opts.onStart?.(); } catch { /* ignore */ } el.onplaying = null; };
      if (!this.canMSE || this.mode !== 'stream') {
        r.blob().then((b) => {
          if (gen !== this.gen) return finish();
          this.bytes = b.size; this.final = true; el.src = url = URL.createObjectURL(b);
          el.play().catch(() => finish());
        }, () => finish());
        return;
      }
      const ms = new MediaSource();
      el.src = url = URL.createObjectURL(ms);
      ms.addEventListener('sourceopen', async () => {
        try {
          const sb = ms.addSourceBuffer('audio/mpeg');
          const reader = r.body!.getReader();
          let started = false;
          const startPlay = () => { if (started) return; started = true; try { el.currentTime = 0; } catch { /* ignore */ } el.play().catch(() => finish()); };
          for (;;) {
            const { done, value } = await reader.read();
            if (done || gen !== this.gen) { if (gen !== this.gen) reader.cancel().catch(() => {}); break; }
            this.bytes += value.length;
            await new Promise((res) => { sb.addEventListener('updateend', res, { once: true }); sb.appendBuffer(value); });
            if (!started && el.buffered.length && el.buffered.end(el.buffered.length - 1) >= 0.35) startPlay();
          }
          if (gen === this.gen) { startPlay(); if (ms.readyState === 'open') ms.endOfStream(); this.final = true; }
        } catch { finish(); }
      }, { once: true });
    });
    if (url) URL.revokeObjectURL(url);
    this.lineOff();
    if (gen === this.gen) { this.who = null; this.call = false; this.meta = null; }
    return ok;
  }

  /** Play a URL (voice preview) or Blob. Same-origin / blob audio goes through the shared element (so level() works);
      a cross-origin URL is played on a separate plain element that is never connected to Web Audio
      (a MediaElementSource fed by a CORS-restricted file only outputs zeroes). Stops anything queued. */
  async playUrl(src: string | Blob, who = 'preview'): Promise<void> {
    this.stop();
    const gen = this.gen;
    this.previewing = true; this.who = null;
    this.emit('change');
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    let cross = false;
    try { cross = typeof src === 'string' && new URL(url, location.href).origin !== location.origin && !url.startsWith('blob:') && !url.startsWith('data:'); } catch { /* relative */ }
    if (cross) {
      const p = this.plain ??= (() => { const a = new Audio(); a.addEventListener('ended', () => { if (this.previewing) { this.previewing = false; this.who = null; this.emit('change'); } }); return a; })();
      this.who = who;
      p.src = url;
      try { await p.play(); } catch (e) { this.previewing = false; this.who = null; this.emit('change'); throw e; }
      return;
    }
    if (this.mode !== 'simple') await this.setFx(false);   // same-origin: analyser gives level() for the orb
    if (gen !== this.gen) return;                 // stopped meanwhile
    this.who = who;
    this.el.src = url;
    try { await this.el.play(); } catch (e) { this.previewing = false; this.who = null; this.emit('change'); throw e; }
  }
  private plain: HTMLAudioElement | null = null;

  /** Resolve when nothing is queued/playing (or after maxMs). */
  waitIdle(maxMs = 90000): Promise<void> {
    if (this._pending === 0) return Promise.resolve();
    return new Promise((res) => {
      const w = () => { clearTimeout(t); res(); };
      const t = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); res(); }, maxMs);
      this.waiters.push(w);
    });
  }
  private flushWaiters() { if (this._pending === 0) while (this.waiters.length) this.waiters.shift()!(); }

  /** Position inside the chunk currently audible: p in 0..1 of the [a,b] text range from meta. */
  speechNow(): SpeechNow | null {
    const m = this.meta;
    if (!m || !this.who) return null;
    const el = this.el;
    const known = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    const buffered = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0;
    const dur = known || this.bytes / 16000;   // mp3 128 kbps = 16000 B/s
    return {
      sid: m.sid, kind: m.kind, who: this.who, a: m.a, b: m.b, p: Math.min(1, el.currentTime / Math.max(dur, 0.25)),
      t: el.currentTime, dur: this.final ? (known || buffered) : 0, final: this.final, buffered, lat: this.latency(), playing: !el.paused && el.currentTime > 0,
    };
  }
  /** Output latency (Web Audio graph + device), seconds. Words shown in sync with speech subtract it. */
  latency(): number {
    const a = this.actx as (AudioContext & { outputLatency?: number }) | null;
    if (!a) return 0;
    return Math.min(0.4, (a.baseLatency || 0) + (a.outputLatency || 0));
  }

  /* ---------- Web Audio: FX + analyser ---------- */
  /** Build the graph once (createMediaElementSource can be called only once per element). Returns false if unavailable. */
  initFx(): boolean {
    if (this.fxg) return true;
    const AC: typeof AudioContext | undefined = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return false;
    try {
      const actx = new AC();
      const src = actx.createMediaElementSource(this.el);
      const dry = actx.createGain();
      const wet = actx.createGain(); wet.gain.value = 0;
      const hp = actx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.8;
      const lp = actx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
      const pk = actx.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 1800; pk.Q.value = 1;
      const ws = actx.createWaveShaper(); ws.oversample = '2x';
      const comp = actx.createDynamicsCompressor();
      const an = actx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.55; src.connect(an);
      const master = actx.createGain(); master.gain.value = this.mute ? 0 : this.duckTo; master.connect(actx.destination);
      src.connect(dry); dry.connect(master);
      src.connect(hp); hp.connect(lp); lp.connect(pk); pk.connect(ws); ws.connect(comp); comp.connect(wet); wet.connect(master);
      const nb = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate), d = nb.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const ns = actx.createBufferSource(); ns.buffer = nb; ns.loop = true;
      const ng = actx.createGain(); ng.gain.value = 0; ns.connect(ng); ng.connect(actx.destination); ns.start();
      // keep-alive: inaudible noise while talking so Bluetooth devices do not sleep and clip the first syllable
      const ka = actx.createBufferSource(); ka.buffer = nb; ka.loop = true;
      const kg = actx.createGain(); kg.gain.value = 0; ka.connect(kg); kg.connect(actx.destination); ka.start();
      actx.onstatechange = () => { if (actx.state !== 'running') actx.resume().catch(() => {}); };
      this.actx = actx; this.an = an;
      this.fxg = { dry, wet, hp, lp, pk, ws, ng, kg, master };
    } catch (e: any) { console.warn('FX tidak tersedia:', e?.message); this.fxg = null; this.actx = null; return false; }
    return true;
  }
  private lineOff() {
    const f = this.fxg, a = this.actx; if (!f || !a) return;
    const t = a.currentTime;
    f.ng.gain.cancelScheduledValues(t); f.ng.gain.setTargetAtTime(0, t, 0.04);
    f.dry.gain.cancelScheduledValues(t); f.dry.gain.setValueAtTime(1, t);
    f.wet.gain.cancelScheduledValues(t); f.wet.gain.setValueAtTime(0, t);
  }
  /** Keep the audio device awake for ~9 s (call when speech is about to start). */
  warm(): void {
    const f = this.fxg, a = this.actx; if (!f || !a) return;
    const t = a.currentTime;
    f.kg.gain.cancelScheduledValues(t); f.kg.gain.setTargetAtTime(0.0007, t, 0.05);
    if (this.warmT) clearTimeout(this.warmT);
    this.warmT = setTimeout(() => { if (this.fxg && this.actx) this.fxg.kg.gain.setTargetAtTime(0, this.actx.currentTime, 0.4); }, 9000);
  }
  private async ensureRunning(maxMs = 2500) {
    const a = this.actx; if (!a) return;
    const t0 = performance.now();
    while ((a.state as string) !== 'running' && performance.now() - t0 < maxMs) {
      try { await a.resume(); } catch { /* ignore */ }
      if ((a.state as string) !== 'running') await new Promise((r) => setTimeout(r, 80));
    }
  }
  /** Switch the cheap-mic effect on/off for what plays next. */
  async setFx(on: boolean): Promise<void> {
    if (!this.initFx()) return;
    await this.ensureRunning();
    const f = this.fxg!, a = this.actx!, t = a.currentTime;
    if (on) {
      const L = FX_LEVELS[this.fxLevel] || FX_LEVELS.medium;
      f.hp.frequency.value = L.hp; f.lp.frequency.value = L.lp; f.pk.gain.value = L.pk; f.ws.curve = satCurve(L.drive);
      f.dry.gain.setValueAtTime(0, t); f.wet.gain.setValueAtTime(L.gain, t); f.ng.gain.setTargetAtTime(L.noise, t, 0.05);
    } else {
      f.dry.gain.setValueAtTime(1, t); f.wet.gain.setValueAtTime(0, t); f.ng.gain.setTargetAtTime(0, t, 0.05);
    }
    this.fxLog.push({ fx: on, ctx: a.state, wet: +f.wet.gain.value.toFixed(2), dry: +f.dry.gain.value.toFixed(2) });
    if (this.fxLog.length > 50) this.fxLog.shift();
  }
  /** Current line-noise gain (debug). */
  lineNoise(): number { return this.fxg ? +this.fxg.ng.gain.value.toFixed(4) : 0; }

  /** Loudness + spectrum of what is playing (for waveform / orb UIs). Needs initFx(). */
  level(): Level {
    if (!this.an || !this.who) return { who: null, call: false, amp: 0, freq: null };
    this.an.getByteTimeDomainData(this.tbuf);
    let sum = 0;
    for (let i = 0; i < this.tbuf.length; i++) { const v = (this.tbuf[i] - 128) / 128; sum += v * v; }
    this.an.getByteFrequencyData(this.fbuf);
    return { who: this.who, call: this.call, amp: Math.min(1, Math.sqrt(sum / this.tbuf.length) * 3.4), freq: this.fbuf };
  }
}

export const player = new Player();
addEventListener('pagehide', () => player.stop());

/* ---------- text chunking helpers (shared by chat / voice / coffee) ---------- */
const ABBR = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc)\.$/i;

/** One line = one TTS request so emotion carries across sentences; long replies are cut at a sentence end after `min` chars.
    The first cut may happen earlier (`first`) so audio starts quickly. */
export function chunker(onChunk: (s: string) => void, min = 160, first = min) {
  let buf = '', isFirst = true;
  const re = /[.!?…]+["')\]]*\s/g;
  const drain = (final: boolean) => {
    for (;;) {
      re.lastIndex = isFirst ? first : min;
      let m: RegExpExecArray | null;
      while ((m = re.exec(buf)) && ABBR.test(buf.slice(0, m.index + 1))) { /* skip "Mr." etc. */ }
      if (!m) break;
      const cut = m.index + m[0].length;
      onChunk(buf.slice(0, cut)); buf = buf.slice(cut); isFirst = false;
    }
    if (final && buf.trim()) { onChunk(buf); buf = ''; }
  };
  /** flush(again): speak what is buffered now; with `again` the next cut may come early again (e.g. after a tool call) */
  return { push(t: string) { buf += t; drain(false); }, flush(again = false) { drain(true); if (again) isFirst = true; } };
}

/** Split text into sentence chunks of at most `max` chars (keeps abbreviations together). */
export function splitChunks(t: string, max = 420): string[] {
  const sentences: string[] = [];
  for (const p of t.split(/(?<=[.!?…])\s+/)) {
    if (sentences.length && ABBR.test(sentences[sentences.length - 1])) sentences[sentences.length - 1] += ' ' + p; else sentences.push(p);
  }
  const out: string[] = []; let buf = '';
  for (const part of sentences) {
    if (buf && (buf + ' ' + part).length > max) { out.push(buf); buf = part; } else buf = buf ? buf + ' ' + part : part;
  }
  if (buf) out.push(buf);
  return out;
}
