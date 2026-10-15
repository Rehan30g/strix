/* Microphone recorder (MediaRecorder) with a live level meter. Used by Voice Changer and voice cloning. */

import { t } from '../i18n';

export interface Recording { file: File; duration: number }
export interface Recorder {
  /** Seconds since start. */
  elapsed(): number;
  /** 0..1 loudness right now. */
  level(): number;
  /** Stop and get the file (null if too short / failed). */
  stop(): Promise<Recording | null>;
  /** Stop and throw the audio away. */
  cancel(): void;
}

export const canRecord = () => !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';

export async function startRecording(opts: { maxSec?: number; name?: string; onAutoStop?: (r: Recording | null) => void } = {}): Promise<Recorder> {
  if (!canRecord()) throw new Error(t('Browser ini tidak mendukung perekaman audio.'));
  let stream: MediaStream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); }
  catch (e: any) {
    throw new Error(e?.name === 'NotAllowedError' ? t('Izin mikrofon ditolak. Aktifkan di pengaturan browser.') : e?.name === 'NotFoundError' ? t('Mikrofon tidak ditemukan.') : t('Mikrofon tidak bisa dipakai.'));
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  let ac: AudioContext | null = null, an: AnalyserNode | null = null;
  try { ac = new AudioContext(); an = ac.createAnalyser(); an.fftSize = 512; ac.createMediaStreamSource(stream).connect(an); } catch { /* meter optional */ }
  const buf = new Uint8Array(512);
  const t0 = performance.now();
  let done: Promise<Recording | null> | null = null;
  let cancelled = false;
  const release = () => { stream.getTracks().forEach((t) => t.stop()); ac?.close().catch(() => {}); clearInterval(cap); };

  const finish = (): Promise<Recording | null> => {
    if (done) return done;
    done = new Promise((resolve) => {
      const duration = (performance.now() - t0) / 1000;
      rec.onstop = () => {
        release();
        if (cancelled) return resolve(null);
        const type = (rec.mimeType || 'audio/webm').split(';')[0];
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        const blob = new Blob(chunks, { type });
        if (blob.size < 1500 || duration < 0.6) return resolve(null);
        resolve({ file: new File([blob], `${opts.name || 'rekaman'}.${ext}`, { type }), duration });
      };
      try { rec.stop(); } catch { release(); resolve(null); }
    });
    return done;
  };
  const cap = setInterval(() => {
    if (opts.maxSec && (performance.now() - t0) / 1000 >= opts.maxSec) finish().then((r) => opts.onAutoStop?.(r));
  }, 250);
  rec.start(500);

  return {
    elapsed: () => (performance.now() - t0) / 1000,
    level: () => {
      if (!an) return 0;
      an.getByteTimeDomainData(buf);
      let sum = 0; for (const v of buf) { const x = (v - 128) / 128; sum += x * x; }
      return Math.min(1, Math.sqrt(sum / buf.length) * 4);
    },
    stop: finish,
    cancel: () => { cancelled = true; finish(); },
  };
}

export const fmtDur = (d?: number | null) => (d == null || !Number.isFinite(d) ? '' : `${Math.floor(d / 60)}:${String(Math.floor(d % 60)).padStart(2, '0')}`);

/** Duration of an audio file in seconds (null if the browser cannot tell, e.g. some webm recordings). */
export function probeDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio(); a.preload = 'metadata';
    const done = (v: number | null) => { URL.revokeObjectURL(url); resolve(v); };
    const t = setTimeout(() => done(null), 5000);
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) { clearTimeout(t); done(a.duration); return; }
      // webm from MediaRecorder: seek far to force the browser to compute the duration
      a.ondurationchange = () => { if (Number.isFinite(a.duration) && a.duration > 0) { clearTimeout(t); done(a.duration); } };
      try { a.currentTime = 1e7; } catch { clearTimeout(t); done(null); }
    };
    a.onerror = () => { clearTimeout(t); done(null); };
    a.src = url;
  });
}
