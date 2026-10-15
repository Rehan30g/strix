/* Speech-to-text via ElevenLabs Scribe Realtime (scribe_v2_realtime).
   mic (getUserMedia, echo cancellation + noise suppression) -> AudioWorklet (/stt-worklet.js; ScriptProcessor fallback)
   -> PCM16 mono 16 kHz, ~100 ms chunks -> ElevenLabs WebSocket opened with a single-use token from POST /api/stt/token
   (the API key stays on the server). Partial transcripts stream in; committed transcripts are final.
   - mode 'ptt' (push-to-talk, manual commit): stop() commits, waits for the committed text, calls onFinal(full text) once.
   - mode 'vad' (hands-free): the server commits on silence; onFinal(segment) per committed segment.
   Audio captured while the socket is still connecting is buffered and sent once it opens (no lost first word).
   Usage (cumulative audio seconds) is reported to POST /api/stt/usage every 15 s and at the end.
   If no token can be had (server not configured, quota, network) and the browser has Web Speech, it falls back to that
   (session.backend === 'webspeech', onFallback fires) so the UI can mark it. */
import { api, ApiError } from '../api';
import { hasSpeech, listen } from './speech';
import { t } from '../i18n';

export type SttMode = 'ptt' | 'vad';
export type SttState = 'connecting' | 'listening' | 'finishing' | 'closed';
export interface SttOpts {
  /** BCP-47 or ISO-639 ('en-US', 'id', ...). Omit / '' = auto-detect. */
  lang?: string;
  mode?: SttMode;
  onPartial?: (text: string) => void;
  onFinal?: (text: string) => void;
  /** mic loudness 0..1 (~10 per second) */
  onLevel?: (level: number) => void;
  onError?: (code: string, message: string) => void;
  onState?: (s: SttState) => void;
  /** the session is over (after the last onFinal); `text` = all committed text */
  onEnd?: (text: string) => void;
  /** Scribe unavailable; using the browser's Web Speech instead */
  onFallback?: (reason: string) => void;
  /** VAD silence before a commit (seconds), default 0.9 */
  vadSilenceSec?: number;
  /** allow the Web Speech fallback (default true) */
  fallback?: boolean;
  /** conversation mode: keep the session open; at the per-session limit the socket is renewed with a fresh token
      (audio is buffered meanwhile) instead of stopping. Needs mode 'vad'. */
  continuous?: boolean;
  /** called when a renewed socket is being opened (continuous) */
  onRenew?: (n: number) => void;
}
export interface SttSession {
  /** finish: commit what was said and end (onFinal / onEnd follow) */
  stop(): void;
  /** end now without a final result */
  abort(): void;
  readonly backend: 'scribe' | 'webspeech';
}
interface TokenRes { token: string; url: string; expiresInSec: number; model: string; maxSessionSec: number; sessionId: string; sampleRate?: number }

const RATE = 16000;
const CHUNK_BYTES = RATE * 2 / 10;           // 100 ms
const MAX_BUFFER_BYTES = RATE * 2 * 15;      // 15 s of audio kept while (re)connecting
const MAX_RECONNECTS = 2;

/* One token may be fetched ahead of time (prewarmStt) so pressing the mic skips that round trip (~0.5-1 s).
   Tokens are single-use and valid 15 min; a cached one is used within 5 min. Each issued token costs 1 s of quota. */
let warm: { at: number; p: Promise<TokenRes> } | null = null;
const WARM_MS = 5 * 60_000;
function takeToken(): Promise<TokenRes> {
  const w = warm; warm = null;
  if (w && Date.now() - w.at < WARM_MS) return w.p.catch(() => api.post<TokenRes>('/stt/token', {}));
  return api.post<TokenRes>('/stt/token', {});
}
/** Fetch a token in the background for the next startStt() (no-op if one is cached). */
export function prewarmStt(): void {
  if (warm && Date.now() - warm.at < WARM_MS) return;
  if (!navigator.mediaDevices?.getUserMedia) return;
  // plain fetch: a failure here must stay silent (no global quota toast); startStt() then asks again normally
  const p = fetch('/api/stt/token', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(async (r) => { if (!r.ok) throw new Error(String(r.status)); return (await r.json()) as TokenRes; });
  p.catch(() => { if (warm?.p === p) warm = null; });
  warm = { at: Date.now(), p };
}

export const sttSupported = (): boolean =>
  (!!navigator.mediaDevices?.getUserMedia && typeof WebSocket !== 'undefined' && !!(window.AudioContext || (window as any).webkitAudioContext)) || hasSpeech();

const MIC_ERR: Record<string, [string, string]> = {
  NotAllowedError: ['mic_denied', t('Izin mikrofon ditolak. Izinkan mikrofon untuk situs ini di pengaturan browser.')],
  SecurityError: ['mic_denied', t('Izin mikrofon ditolak. Izinkan mikrofon untuk situs ini di pengaturan browser.')],
  NotFoundError: ['mic_missing', t('Mikrofon tidak ditemukan.')],
  OverconstrainedError: ['mic_missing', t('Mikrofon tidak ditemukan.')],
  NotReadableError: ['mic_busy', t('Mikrofon sedang dipakai aplikasi lain.')],
  AbortError: ['mic_busy', t('Mikrofon tidak bisa dibuka.')],
};
const WS_ERR: Record<string, string> = {
  auth_error: t('Token suara ditolak. Coba lagi.'),
  quota_exceeded: t('Kuota layanan pengenalan suara (ElevenLabs) habis.'),
  rate_limited: t('Layanan pengenalan suara sedang sibuk. Coba lagi sebentar.'),
  resource_exhausted: t('Layanan pengenalan suara sedang sibuk. Coba lagi sebentar.'),
  queue_overflow: t('Koneksi terlalu lambat untuk pengenalan suara.'),
  unaccepted_terms: t('Layanan pengenalan suara belum diaktifkan di akun ElevenLabs.'),
};

/** ISO-639-1 code for Scribe (language_code), '' = auto */
const langCode = (l?: string) => { const c = String(l || '').trim().toLowerCase().split(/[-_]/)[0]; return /^[a-z]{2,3}$/.test(c) ? c : ''; };

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

/** ScriptProcessor fallback of public/stt-worklet.js (same averaging decimator). */
class Decimator {
  private acc = 0; private cnt = 0; private phase = 0; private sq = 0; private n = 0;
  private buf: Int16Array;
  constructor(private rate: number, private emit: (pcm: ArrayBuffer, rms: number) => void, chunk = RATE / 10) { this.buf = new Int16Array(chunk); }
  push(ch: Float32Array) {
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.phase += RATE;
      if (this.phase >= this.rate) {
        this.phase -= this.rate;
        let v = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
        v = Math.max(-1, Math.min(1, v));
        this.sq += v * v;
        this.buf[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.n === this.buf.length) this.flush();
      }
    }
  }
  flush() {
    if (!this.n) return;
    const out = this.buf.slice(0, this.n);
    this.emit(out.buffer, Math.sqrt(this.sq / this.n));
    this.n = 0; this.sq = 0;
  }
}

export function startStt(o: SttOpts): SttSession {
  const mode: SttMode = o.mode || 'ptt';
  let backend: 'scribe' | 'webspeech' = 'scribe';
  let ended = false, stopping = false, aborted = false;
  let state: SttState = 'connecting';
  const setState = (s: SttState) => { if (state !== s) { state = s; o.onState?.(s); } };

  let stream: MediaStream | null = null;
  let actx: AudioContext | null = null;
  let node: AudioWorkletNode | ScriptProcessorNode | null = null;
  let srcNode: MediaStreamAudioSourceNode | null = null;
  let dec: Decimator | null = null;
  let ws: WebSocket | null = null;
  let tok: TokenRes | null = null;
  let reconnects = 0;
  let pending: Uint8Array[] = []; let pendingBytes = 0;
  let sentBytes = 0, reportedSec = 0, reportT: ReturnType<typeof setInterval> | null = null;
  let committed: string[] = [];
  let partial = '';
  let finishT: ReturnType<typeof setTimeout> | null = null;
  let connectT: ReturnType<typeof setTimeout> | null = null;
  let speech: ReturnType<typeof listen> = null;
  const fullText = () => [...committed, partial].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

  /* ---------- teardown ---------- */
  function releaseAudio() {
    try { srcNode?.disconnect(); } catch { /* ignore */ }
    try { node?.disconnect(); } catch { /* ignore */ }
    if (node && 'port' in node) { try { node.port.postMessage('stop'); node.port.onmessage = null; } catch { /* ignore */ } }
    if (node && 'onaudioprocess' in node) node.onaudioprocess = null;
    node = null; srcNode = null;
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    actx?.close().catch(() => {}); actx = null;
    o.onLevel?.(0);
  }
  function closeWs() {
    if (!ws) return;
    const w = ws; ws = null;
    w.onopen = w.onmessage = w.onerror = w.onclose = null;
    try { w.close(1000); } catch { /* ignore */ }
  }
  function report(final = false) {
    if (!tok) return;
    const sec = Math.round(sentBytes / (RATE * 2) * 10) / 10;
    if (sec <= reportedSec) return; // cumulative + idempotent on the server, so `final` needs nothing extra
    void final;
    reportedSec = sec;
    const body = JSON.stringify({ sessionId: tok.sessionId, seconds: sec });
    fetch('/api/stt/usage', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body })
      .then(() => api.usageChanged()).catch(() => {});
  }
  function finish(withFinal: boolean) {
    if (ended) return;
    ended = true;
    if (finishT) clearTimeout(finishT);
    if (connectT) clearTimeout(connectT);
    if (reportT) clearInterval(reportT);
    releaseAudio();
    closeWs();
    report(true);
    setState('closed');
    const text = fullText();
    if (withFinal && mode === 'ptt' && text) o.onFinal?.(text);
    if (withFinal && mode === 'vad' && partial.trim()) o.onFinal?.(partial.trim());
    o.onEnd?.(withFinal ? text : '');
  }
  function fail(code: string, msg: string) {
    if (ended) return;
    o.onError?.(code, msg);
    finish(true);
  }

  /* ---------- audio ---------- */
  function onPcm(buf: ArrayBuffer, rms: number) {
    if (ended) return;
    o.onLevel?.(Math.min(1, Math.sqrt(rms) * 2.2));
    const bytes = new Uint8Array(buf);
    if (ws && ws.readyState === WebSocket.OPEN && !pendingBytes) sendAudio(bytes, false);
    else {
      pending.push(bytes); pendingBytes += bytes.length;
      while (pendingBytes > MAX_BUFFER_BYTES && pending.length) pendingBytes -= pending.shift()!.length;
    }
  }
  function sendAudio(bytes: Uint8Array, commit: boolean) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64(bytes), commit, sample_rate: RATE }));
    sentBytes += bytes.length;
    if (tok && sentBytes / (RATE * 2) >= tok.maxSessionSec && !stopping) {
      if (o.continuous && mode === 'vad') { renew(); return; }
      o.onError?.('session_limit', t('Batas {min} menit per sesi tercapai.', { min: Math.round(tok.maxSessionSec / 60) || 1 }));
      stop();
    }
  }
  function flushPending() {
    if (!pending.length) return;
    // merge into ~100 ms chunks
    const all = new Uint8Array(pendingBytes); let p = 0;
    for (const c of pending) { all.set(c, p); p += c.length; }
    pending = []; pendingBytes = 0;
    for (let i = 0; i < all.length; i += CHUNK_BYTES) sendAudio(all.subarray(i, i + CHUNK_BYTES), false);
  }
  async function openMic(): Promise<void> {
    const AC: typeof AudioContext = window.AudioContext || (window as any).webkitAudioContext;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (ended) { releaseAudio(); return; }
    actx = new AC();
    if (actx.state === 'suspended') await actx.resume().catch(() => {});
    srcNode = actx.createMediaStreamSource(stream);
    let worklet = false;
    if (actx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await actx.audioWorklet.addModule('/stt-worklet.js');
        if (ended || !actx) return;
        const wn = new AudioWorkletNode(actx, 'pcm16-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, processorOptions: { targetRate: RATE, chunkMs: 100 } });
        wn.port.onmessage = (e) => onPcm(e.data.pcm, e.data.rms);
        node = wn; worklet = true;
      } catch { worklet = false; }
    }
    if (!worklet) {
      const sp = actx.createScriptProcessor(4096, 1, 1);
      dec = new Decimator(actx.sampleRate, onPcm);
      sp.onaudioprocess = (e) => dec?.push(e.inputBuffer.getChannelData(0));
      node = sp;
    }
    srcNode.connect(node!);
    // a node must reach the destination to be pulled; it outputs silence
    const mute = actx.createGain(); mute.gain.value = 0;
    node!.connect(mute).connect(actx.destination);
  }

  /* ---------- socket ---------- */
  let firstToken = true;
  async function getToken(): Promise<TokenRes> {
    if (firstToken) { firstToken = false; return takeToken(); }
    return api.post<TokenRes>('/stt/token', {});
  }
  function connect(tok: TokenRes) {
    const u = new URL(tok.url);
    u.searchParams.set('token', tok.token);
    u.searchParams.set('commit_strategy', mode === 'vad' ? 'vad' : 'manual');
    const lc = langCode(o.lang);
    if (lc) u.searchParams.set('language_code', lc);
    if (mode === 'vad') {
      u.searchParams.set('vad_silence_threshold_secs', String(o.vadSilenceSec ?? 0.9));
      u.searchParams.set('min_speech_duration_ms', '120');
    }
    const w = new WebSocket(u.toString());
    ws = w;
    if (connectT) clearTimeout(connectT);
    connectT = setTimeout(() => { if (ws === w && w.readyState !== WebSocket.OPEN) { closeWs(); retryOrFail('timeout', t('Koneksi pengenalan suara terlalu lama.')); } }, 9000);
    w.onmessage = (e) => {
      let m: any; try { m = JSON.parse(String(e.data)); } catch { return; }
      const type = m?.message_type;
      if (type === 'session_started') {
        if (connectT) clearTimeout(connectT);
        reconnects = 0;   // MAX_RECONNECTS counts consecutive failures only
        setState(stopping ? 'finishing' : 'listening');
        flushPending();
        if (stopping) sendCommit();
      } else if (type === 'partial_transcript') {
        partial = String(m.text || '').trim();
        if (partial || mode === 'ptt') o.onPartial?.(mode === 'ptt' ? fullText() : partial);
      } else if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
        if (type === 'committed_transcript_with_timestamps' && committed.length) return; // same segment twice
        const t = String(m.text || '').trim();
        partial = '';
        if (t) {
          committed.push(t);
          if (mode === 'vad') o.onFinal?.(t);
          else o.onPartial?.(fullText());
        }
        if (stopping) finish(true);
      } else if (type === 'insufficient_audio_activity') {
        if (stopping) finish(true);
      } else if (type === 'session_time_limit_exceeded') {
        if (o.continuous && mode === 'vad') { renew(); return; }
        closeWs(); retryOrFail(type, t('Sesi pengenalan suara berakhir.'));
      } else if (type === 'commit_throttled' || type === 'warning') {
        /* ignore */
      } else if (type && (m.error || /error|exceeded|limited|exhausted|overflow|invalid|unaccepted/.test(type))) {
        if (stopping && type === 'input_error') { finish(true); return; }
        closeWs();
        if (type === 'auth_error' || type === 'transcriber_error' || type === 'queue_overflow' || type === 'resource_exhausted') retryOrFail(type, WS_ERR[type] || t('Pengenalan suara gagal.'));
        else fail(type, WS_ERR[type] || t('Pengenalan suara gagal: {error}', { error: String(m.error || type).slice(0, 120) }));
      }
    };
    w.onclose = (ev) => {
      if (ws !== w) return;
      ws = null;
      if (ended) return;
      if (stopping) { finish(true); return; }
      retryOrFail('closed', ev.code === 1006 ? t('Koneksi pengenalan suara terputus.') : t('Koneksi pengenalan suara ditutup ({code}).', { code: ev.code }));
    };
    w.onerror = () => { /* onclose follows */ };
  }
  async function retryOrFail(code: string, msg: string) {
    if (ended) return;
    if (stopping && !pendingBytes) { finish(true); return; }
    if (reconnects >= MAX_RECONNECTS) { fail(code, msg); return; }
    reconnects++;
    setState('connecting');
    if (partial) committed.push(partial);
    partial = '';
    try {
      report();
      const t = await getToken();
      if (ended) return;
      tok = t; sentBytes = 0; reportedSec = 0;
      connect(t);
    } catch (e: any) {
      fail(e?.code || 'token', tokenMessage(e));
    }
  }
  /** continuous mode: replace the socket with a fresh session (new token); audio is buffered while it connects */
  let renewing = false, renewals = 0;
  async function renew() {
    if (ended || renewing) return;
    renewing = true;
    report(true);
    closeWs();
    if (partial.trim()) { const p = partial.trim(); partial = ''; committed.push(p); o.onFinal?.(p); }
    setState('connecting');
    o.onRenew?.(++renewals);
    try {
      const t = await api.post<TokenRes>('/stt/token', {});
      if (ended) return;
      tok = t; sentBytes = 0; reportedSec = 0;
      connect(t);
    } catch (e: any) {
      fail(e?.code || 'token', tokenMessage(e));
    } finally { renewing = false; }
  }
  function sendCommit() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // a short silent tail carries the commit flag
    sendAudio(new Uint8Array(CHUNK_BYTES), true);
    finishT = setTimeout(() => finish(true), 4000); // no committed transcript: use what we have
  }

  /* ---------- control ---------- */
  function stop() {
    if (ended || stopping) return;
    stopping = true;
    if (backend === 'webspeech') { speech?.stop(); return; }
    setState('finishing');
    if (node && 'port' in node) { try { node.port.postMessage('flush'); } catch { /* ignore */ } } else dec?.flush();
    // let the last worklet chunk arrive, then commit
    setTimeout(() => {
      if (ended) return;
      // stop capturing; keep the socket for the commit
      releaseAudio();
      if (ws && ws.readyState === WebSocket.OPEN) { flushPending(); if (mode === 'ptt' || committed.length || partial) sendCommit(); else finish(true); }
      else if (!ws && !tok) { /* still fetching the token: session_started will commit */ finishT = setTimeout(() => finish(true), 9000); }
      else finishT = setTimeout(() => finish(true), 9000);
    }, 120);
  }
  function abort() {
    if (ended) return;
    aborted = true;
    if (backend === 'webspeech') { ended = true; speech?.abort(); setState('closed'); return; }
    finish(false);
  }

  function tokenMessage(e: any): string {
    if (e instanceof ApiError) {
      if (e.status === 429 && e.code === 'quota') return e.message || t('Kuota harian input suara habis.');
      if (e.code === 'tts_not_configured') return t('Layanan pengenalan suara belum dikonfigurasi di server.');
      return e.message || t('Token pengenalan suara gagal.');
    }
    return t('Token pengenalan suara gagal.');
  }

  /* ---------- Web Speech fallback ---------- */
  function useWebSpeech(reason: string) {
    backend = 'webspeech';
    releaseAudio(); closeWs();
    o.onFallback?.(reason);
    speech = listen({
      lang: o.lang || navigator.language || 'en-US',
      onText: (t) => { partial = t; o.onPartial?.(t); },
      onEnd: (t) => {
        if (ended) return;
        ended = true; setState('closed');
        if (!aborted && t) o.onFinal?.(t);
        o.onEnd?.(aborted ? '' : t);
      },
      onError: (c, m) => o.onError?.(c, m),
    });
    if (!speech) { ended = true; setState('closed'); o.onEnd?.(''); return; }
    setState(stopping ? 'finishing' : 'listening');
    if (stopping) speech.stop();
  }

  /* ---------- start ---------- */
  (async () => {
    await Promise.resolve(); // never call back before startStt() has returned (callers reference the session)
    if (ended) return;
    o.onState?.('connecting');
    if (!navigator.mediaDevices?.getUserMedia) {
      if (hasSpeech() && o.fallback !== false) useWebSpeech('no_mic_api');
      else fail('unsupported', window.isSecureContext ? t('Browser ini tidak bisa merekam mikrofon.') : t('Mikrofon hanya bisa dipakai lewat HTTPS.'));
      return;
    }
    const tokP = getToken().then((t) => ({ t, e: null as any }), (e) => ({ t: null as TokenRes | null, e }));
    try {
      await openMic();
    } catch (e: any) {
      const [code, msg] = MIC_ERR[e?.name] || ['mic_error', e?.message ? t('Mikrofon tidak bisa dibuka: {error}', { error: e.message }) : t('Mikrofon tidak bisa dibuka.')];
      tokP.then(({ t }) => { if (t) { tok = t; report(true); } });
      fail(code, msg);
      return;
    }
    if (ended) return;
    const { t: tk, e } = await tokP;
    if (ended) { if (tk) { tok = tk; report(true); } return; }
    if (!tk) {
      const authish = e instanceof ApiError && (e.status === 401 || e.status === 403);
      if (!authish && o.fallback !== false && hasSpeech()) {
        if (!(e instanceof ApiError && e.status === 429)) o.onError?.('fallback', tokenMessage(e) + ' ' + t('Memakai pengenalan suara bawaan browser.'));
        useWebSpeech(e?.code || 'token');
      } else fail(e?.code || 'token', tokenMessage(e));
      return;
    }
    tok = tk;
    reportT = setInterval(() => report(), 15000);
    connect(tk);
  })();

  return {
    stop, abort,
    get backend() { return backend; },
  };
}
