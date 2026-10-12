/* Voice Changer client: POST /api/vc (multipart, XHR for upload progress) -> audio/mpeg blob. */
import { ApiError, toError, api } from '../api';

export interface VcParams {
  file: File;
  voiceId: string;
  removeBackgroundNoise: boolean;
  stability: number;
  similarity: number;
  style: number;
  durationSec?: number | null;
}
export interface VcResult { blob: Blob; name: string; chargedSec: number | null }

export function convertVoice(p: VcParams, opts: { signal?: AbortSignal; onProgress?: (phase: 'upload' | 'process', p: number) => void } = {}): Promise<VcResult> {
  const fd = new FormData();
  fd.append('voiceId', p.voiceId);
  fd.append('removeBackgroundNoise', String(!!p.removeBackgroundNoise));
  fd.append('stability', String(p.stability));
  fd.append('similarity', String(p.similarity));
  fd.append('style', String(p.style));
  if (p.durationSec && Number.isFinite(p.durationSec)) fd.append('durationSec', String(Math.ceil(p.durationSec)));
  fd.append('file', p.file, p.file.name || 'audio');   // file last: the server can validate fields before reading it

  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/vc');
    x.withCredentials = true;
    x.responseType = 'blob';
    x.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.('upload', e.loaded / e.total); };
    x.upload.onload = () => opts.onProgress?.('process', 0);
    x.onload = async () => {
      const blob = x.response as Blob;
      if (x.status >= 200 && x.status < 300) {
        const cd = x.getResponseHeader('Content-Disposition') || '';
        const name = /filename="?([^";]+)"?/i.exec(cd)?.[1] || `voice-changer-${Date.now()}.mp3`;
        api.usageChanged();
        const ch = Number(x.getResponseHeader('X-Vc-Charged-Sec'));
        return resolve({ blob, name, chargedSec: Number.isFinite(ch) && ch > 0 ? ch : null });
      }
      const res = new Response(blob, { status: x.status, headers: { 'Content-Type': x.getResponseHeader('Content-Type') || 'application/json' } });
      const err = await toError(res, '/vc');
      reject(err);
    };
    x.onerror = () => reject(new ApiError(0, 'network', 'Upload gagal: koneksi terputus.', null));
    x.onabort = () => reject(new ApiError(0, 'aborted', 'Dibatalkan', null));
    opts.signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.send(fd);
  });
}
