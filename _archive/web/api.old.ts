/* Fetch wrapper for /api. Handles 401 / 403 / 429 globally (emits events the shell reacts to),
   JSON helpers, raw streaming responses (TTS audio), SSE parsing and multipart upload with progress. */

export class ApiError extends Error {
  status: number; code: string; data: any;
  constructor(status: number, code: string, message: string, data: any) {
    super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.data = data;
  }
  get isAbort() { return this.code === 'aborted'; }
}

export type ApiEvent =
  | { type: 'unauthorized' }
  | { type: 'invite_required' }
  | { type: 'suspended' }
  | { type: 'forbidden'; code: string }
  | { type: 'quota'; kind: string; resetAt?: string; message: string }
  | { type: 'usage' };              // a request that counts against quota finished (refresh the meter)

type Listener = (e: ApiEvent) => void;
const listeners = new Set<Listener>();
export function onApiEvent(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function emit(e: ApiEvent) { for (const l of listeners) { try { l(e); } catch (err) { console.error(err); } } }

const QUOTA_LABEL: Record<string, string> = { llm: 'permintaan AI', tts: 'karakter suara', clone: 'clone suara', clones: 'clone suara' };
const MESSAGES: Record<string, string> = {
  invite_required: 'Akun kamu belum aktif. Masukkan kode undangan dulu.',
  suspended: 'Akun kamu ditangguhkan. Hubungi admin.',
  forbidden: 'Kamu tidak punya akses ke fitur ini.',
  admin_only: 'Hanya admin.',
  unauthenticated: 'Sesi berakhir. Silakan masuk lagi.',
  unauthorized: 'Sesi berakhir. Silakan masuk lagi.',
  code_full: 'Kode ini sudah dipakai sampai batas maksimal.',
  code_expired: 'Kode ini sudah kedaluwarsa.',
  code_revoked: 'Kode ini sudah dicabut.',
  invalid_code: 'Kode tidak ditemukan. Periksa lagi penulisannya.',
  already_redeemed: 'Akun kamu sudah memakai kode undangan lain.',
  not_found: 'Tidak ditemukan.',
  voice_forbidden: 'Suara ini tidak boleh dipakai akunmu.',
  tts_not_configured: 'Layanan suara (ElevenLabs) belum dikonfigurasi di server.',
  llm_not_configured: 'Layanan AI (OpenRouter) belum dikonfigurasi di server.',
  text_too_long: 'Teks terlalu panjang.',
  consent_required: 'Centang persetujuan dulu.',
  bad_file_type: 'Jenis file tidak didukung. Pakai file audio.',
  file_too_large: 'File terlalu besar.',
  body_too_large: 'Data terlalu besar.',
  too_large: 'Data terlalu besar.',
  too_many_files: 'Terlalu banyak file (maksimal 3).',
  files_required: 'Tambahkan minimal satu sampel audio.',
  cannot_suspend_self: 'Kamu tidak bisa menangguhkan akunmu sendiri.',
  bad_origin: 'Permintaan ditolak (origin tidak cocok).',
  validation: 'Data yang dikirim tidak valid.',
  rate_limited: 'Terlalu banyak permintaan. Tunggu sebentar.',
  upstream: 'Layanan eksternal sedang bermasalah. Coba lagi.',
  internal: 'Terjadi kesalahan di server.',
};

export function resetText(resetAt?: string): string {
  if (!resetAt) return '';
  const d = new Date(resetAt);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleString('id-ID', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Turn a non-OK response body into an ApiError (and fire the global events). */
async function toError(r: Response, path: string): Promise<ApiError> {
  let data: any = null;
  const text = await r.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  const rawErr = data?.error;
  const code: string = typeof rawErr === 'string' ? rawErr : (rawErr?.code || data?.code || `http_${r.status}`);
  let message: string = (code !== 'validation' && typeof data?.message === 'string' && data.message) || (typeof rawErr === 'object' && rawErr?.message) || MESSAGES[code] || (typeof rawErr === 'string' && rawErr) || r.statusText || `HTTP ${r.status}`;
  if (code === 'text_too_long' && data?.max) message = `Teks terlalu panjang (maksimal ${data.max} karakter).`;
  if (code === 'file_too_large' && data?.maxMb) message = `File terlalu besar (maksimal ${data.maxMb} MB per file).`;
  if (r.status === 401) {
    if (!path.startsWith('/me')) emit({ type: 'unauthorized' });
    message = MESSAGES.unauthorized;
  } else if (r.status === 403) {
    if (code === 'invite_required') emit({ type: 'invite_required' });
    else if (code === 'bad_origin' || code === 'voice_forbidden') { /* local error, no global reaction */ }
    else if (code === 'suspended') emit({ type: 'suspended' });
    else emit({ type: 'forbidden', code });
  } else if (r.status === 429) {
    if (code === 'quota') {
      const kind = String(data?.kind || '');
      const when = resetText(data?.resetAt);
      message = kind === 'clone' ? 'Batas jumlah clone suara untuk akunmu sudah tercapai.' : `Kuota harian ${QUOTA_LABEL[kind] || kind} habis.${when ? ` Direset ${when}.` : ''}`;
      emit({ type: 'quota', kind, resetAt: data?.resetAt, message });
    } else {
      message = MESSAGES.rate_limited;
    }
  }
  return new ApiError(r.status, code, message, data);
}

export interface ReqOpts { signal?: AbortSignal; headers?: Record<string, string>; quiet?: boolean }

async function rawFetch(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch('/api' + path, { credentials: 'same-origin', ...init });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new ApiError(0, 'aborted', 'Dibatalkan', null);
    throw new ApiError(0, 'network', 'Tidak bisa terhubung ke server. Periksa koneksi.', null);
  }
}

/** Raw response (for audio streams / downloads). Throws ApiError if not ok. */
export async function raw(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string> || {}) };
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; rest.body = JSON.stringify(json); }
  const r = await rawFetch(path, { ...rest, headers });
  if (!r.ok) throw await toError(r, path);
  return r;
}

async function json<T>(method: string, path: string, body?: unknown, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers || {}) };
  const init: RequestInit = { method, headers, signal: opts.signal };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await rawFetch(path, init);
  if (!r.ok) throw await toError(r, path);
  if (r.status === 204) return undefined as T;
  const t = await r.text();
  return (t ? JSON.parse(t) : undefined) as T;
}

export interface SseOpts { signal?: AbortSignal; onEvent: (data: any, event?: string) => void; onRaw?: (line: string) => void }

/** POST a JSON body and read an SSE response. `data: [DONE]` ends it; each `data:` payload is JSON-parsed if possible. */
export async function sse(path: string, body: unknown, opts: SseOpts): Promise<void> {
  const r = await raw(path, { method: 'POST', json: body, signal: opts.signal, headers: { Accept: 'text/event-stream' } });
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('event-stream')) {               // server answered with plain JSON (non-stream)
    const t = await r.text();
    try { opts.onEvent(JSON.parse(t)); } catch { opts.onEvent(t); }
    return;
  }
  await readSse(r, opts);
}

export async function readSse(r: Response, opts: SseOpts): Promise<void> {
  const reader = r.body!.getReader(), dec = new TextDecoder();
  let buf = '';
  const flushBlock = (block: string) => {
    let event: string | undefined; const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) return false;
    const payload = data.join('\n');
    opts.onRaw?.(payload);
    if (payload === '[DONE]') return true;
    let parsed: any = payload;
    try { parsed = JSON.parse(payload); } catch { /* keep text */ }
    opts.onEvent(parsed, event);
    return false;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/); buf = parts.pop()!;
      for (const p of parts) if (flushBlock(p)) { reader.cancel().catch(() => {}); return; }
    }
    if (buf.trim()) flushBlock(buf);
  } catch (e: any) {
    if (e?.name === 'AbortError' || opts.signal?.aborted) throw new ApiError(0, 'aborted', 'Dibatalkan', null);
    throw e;
  } finally {
    emit({ type: 'usage' });
  }
}

/** Multipart upload with progress (XHR, because fetch has no upload progress). */
export function upload<T = any>(path: string, form: FormData, opts: { onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api' + path);
    x.withCredentials = true;
    x.responseType = 'text';
    x.upload.onprogress = (e) => { if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total); };
    x.onload = async () => {
      const res = new Response(x.response, { status: x.status, headers: { 'Content-Type': x.getResponseHeader('Content-Type') || 'application/json' } });
      if (x.status >= 200 && x.status < 300) { try { resolve(x.response ? JSON.parse(x.response) : undefined); } catch { resolve(x.response); } }
      else reject(await toError(res, path));
    };
    x.onerror = () => reject(new ApiError(0, 'network', 'Upload gagal: koneksi terputus.', null));
    x.onabort = () => reject(new ApiError(0, 'aborted', 'Dibatalkan', null));
    opts.signal?.addEventListener('abort', () => x.abort(), { once: true });
    x.send(form);
  });
}

/* ---------- typed contract ---------- */
export interface User { id: number | string; email: string; name: string; picture?: string | null; status: 'pending' | 'active' | 'suspended'; isAdmin: boolean }
export interface Quota { llm: { used: number; limit: number }; tts: { used: number; limit: number }; resetAt?: string }
export interface Me { user: User; quota: Quota; features: { clone: boolean } }
export interface Config { defaultModel: string; ttsModel: string; models: string[]; ttsModels?: string[]; limits?: Record<string, number> }
export interface Character { id: string; nick?: string; role?: string; name: string; emoji?: string; voiceId?: string; greeting: string; tools?: string[] }
export interface Voice { id: string; name: string; category: 'premade' | 'cloned' | 'library' | string; previewUrl?: string | null; own: boolean; labels?: Record<string, string>; description?: string }
export interface Tune { stability: number; similarity: number; style: number; speed: number; speakerBoost: boolean }
export interface TtsBody { text: string; voiceId: string; model?: string; tune?: Partial<Tune>; format?: string }

export const api = {
  get: <T = any>(path: string, opts?: ReqOpts) => json<T>('GET', path, undefined, opts),
  post: <T = any>(path: string, body?: unknown, opts?: ReqOpts) => json<T>('POST', path, body ?? {}, opts),
  put: <T = any>(path: string, body?: unknown, opts?: ReqOpts) => json<T>('PUT', path, body, opts),
  del: <T = any>(path: string, opts?: ReqOpts) => json<T>('DELETE', path, undefined, opts),
  raw, sse, readSse, upload,

  me: () => json<Me>('GET', '/me'),
  config: () => json<Config>('GET', '/config'),
  logout: () => json<{ ok: boolean }>('POST', '/auth/logout', {}),
  redeem: (code: string) => json<{ ok: boolean }>('POST', '/invite/redeem', { code }),
  characters: async () => { const r = await json<any>('GET', '/characters'); return (Array.isArray(r) ? r : r?.characters || []) as Character[]; },
  voices: async () => { const r = await json<any>('GET', '/voices'); return (Array.isArray(r) ? r : r?.voices || []) as Voice[]; },
  /** Streamed TTS: returns the audio/mpeg Response (body is a ReadableStream). Counts characters. */
  tts: async (body: TtsBody, signal?: AbortSignal) => { const r = await raw('/tts', { method: 'POST', json: body, signal }); return r; },
  /** POST /llm (generic pass-through used by the Coffee simulation). stream:false → JSON; use llmStream for SSE. */
  llm: async <T = any>(body: Record<string, unknown>, signal?: AbortSignal) => { const r = await json<T>('POST', '/llm', { ...body, stream: false }, { signal }); emit({ type: 'usage' }); return r; },
  /** POST /llm with stream:true; calls onChunk with each parsed OpenRouter SSE chunk (choices[0].delta …). */
  llmStream: (body: Record<string, unknown>, onChunk: (chunk: any) => void, signal?: AbortSignal) => sse('/llm', { ...body, stream: true }, { signal, onEvent: onChunk }),
  usageChanged: () => emit({ type: 'usage' }),
  on: onApiEvent,
};
export type Api = typeof api;
