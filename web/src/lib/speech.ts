/* Web Speech API (speech-to-text) wrapper. Chrome / Edge only; check hasSpeech() first. */

const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
export const hasSpeech = (): boolean => !!SR;

export interface ListenOpts {
  lang: string;
  continuous?: boolean;
  onText?: (text: string, isFinal: boolean) => void;   // live transcript (interim + final)
  onEnd: (finalText: string) => void;                   // recognition ended (text may be '')
  onError?: (code: string, message: string) => void;
}
export interface Listening { stop: () => void; abort: () => void }

const ERR: Record<string, string> = {
  'not-allowed': 'Izin mikrofon ditolak. Aktifkan di pengaturan browser.',
  'service-not-allowed': 'Izin mikrofon ditolak. Aktifkan di pengaturan browser.',
  'audio-capture': 'Mikrofon tidak ditemukan.',
  network: 'Pengenalan suara butuh koneksi internet.',
  'no-speech': '',
  aborted: '',
};

export function listen(o: ListenOpts): Listening | null {
  if (!SR) { o.onError?.('unsupported', 'Browser ini tidak mendukung pengenalan suara. Pakai Chrome atau Edge.'); return null; }
  const rec = new SR();
  rec.lang = o.lang; rec.interimResults = true; rec.continuous = !!o.continuous;
  let finalText = '', last = '', ended = false;
  rec.onresult = (e: any) => {
    let t = ''; for (const r of e.results) t += r[0].transcript;
    last = t;
    const isFinal = e.results[e.results.length - 1].isFinal;
    if (isFinal) finalText = t;
    o.onText?.(t, isFinal);
  };
  rec.onerror = (e: any) => { const m = ERR[e.error] ?? `Mic error: ${e.error}`; if (m) o.onError?.(e.error, m); };
  rec.onend = () => { if (ended) return; ended = true; o.onEnd((finalText || last).trim()); };
  try { rec.start(); } catch { return null; }
  return {
    stop: () => { try { rec.stop(); } catch { /* ignore */ } },
    abort: () => { ended = true; rec.onend = null; try { rec.abort(); } catch { /* ignore */ } },
  };
}
