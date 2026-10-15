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

const QUOTA_LABEL: Record<string, string> = { llm: 'chat AI', tts: 'karakter TTS', vc: 'detik Voice Changer', stt: 'detik input suara', search: 'pencarian web', decide: 'keputusan percakapan', clone: 'clone suara', clones: 'clone suara', call: 'panggilan persona', memory: 'ingatan persona' };
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
  duplicate_account: 'Email ini sama dengan akun lain yang sudah memakai undangan. Satu orang satu akun.',
  device_used: 'Perangkat ini sudah dipakai akun lain. Minta kode baru ke pengundang kalau ini orang yang berbeda.',
  already_redeemed: 'Akun kamu sudah memakai kode undangan lain.',
  not_found: 'Tidak ditemukan.',
  voice_forbidden: 'Suara ini belum ada di koleksimu. Tambahkan dulu dari Library (tab Voices).',
  voice_not_found: 'Suara tidak ditemukan di Library.',
  not_in_library: 'Suara ini tidak ada di Library.',
  not_removable: 'Suara ini tidak bisa dihapus dari koleksi.',
  shared_voice: 'Suara bersama tidak bisa dihapus.',
  persona_refused: 'Permintaan persona ini tidak bisa dibuat. Coba ide lain.',
  no_preview: 'Suara ini tidak punya contoh audio.',
  already_in_collection: 'Suara ini sudah ada di koleksimu.',
  collection_full: 'Koleksi suaramu sudah penuh. Hapus salah satu dulu.',
  slots_full: 'Slot suara server penuh. Pilih suara lain yang sudah dipakai, atau minta admin membersihkan slot.',
  not_addable: 'Suara ini tidak bisa dipakai pada paket akun server.',
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
  network: 'Tidak bisa terhubung ke server. Periksa koneksi.',
  audio_too_long: 'Audio terlalu panjang (maksimal 5 menit).',
  audio_too_short: 'Audio terlalu pendek.',
  file_required: 'Pilih atau rekam audio dulu.',
  voice_required: 'Pilih suara target dulu.',
};

export function resetText(resetAt?: string): string {
  if (!resetAt) return '';
  const d = new Date(resetAt);
  if (Number.isNaN(+d)) return '';
  return d.toLocaleString('id-ID', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Turn a non-OK response body into an ApiError (and fire the global events). */
export async function toError(r: Response, path: string): Promise<ApiError> {
  let data: any = null;
  const text = await r.text().catch(() => '');
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 300) }; }
  const rawErr = data?.error;
  const code: string = typeof rawErr === 'string' ? rawErr : (rawErr?.code || data?.code || `http_${r.status}`);
  let message: string = (code !== 'validation' && typeof data?.message === 'string' && data.message) || (typeof rawErr === 'object' && rawErr?.message) || MESSAGES[code] || (typeof rawErr === 'string' && rawErr) || r.statusText || `HTTP ${r.status}`;
  if (code === 'text_too_long' && data?.max) message = `Teks terlalu panjang (maksimal ${data.max} karakter).`;
  if (code === 'voice_forbidden') message = MESSAGES.voice_forbidden;
  if (code === 'collection_full') message = `Koleksi suaramu sudah penuh${data?.max ? ` (maksimal ${data.max})` : ''}. Hapus salah satu dulu.`;
  if (code === 'file_too_large' && data?.maxMb)message = `File terlalu besar (maksimal ${data.maxMb} MB per file).`;
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
export interface QuotaItem { used: number; limit: number }
export interface Quota { llm: QuotaItem; tts: QuotaItem; vc?: QuotaItem; stt?: QuotaItem; search?: QuotaItem; decide?: QuotaItem; resetAt?: string }
export interface Me { user: User; quota: Quota; features: { clone: boolean; vc?: boolean; stt?: boolean; webSearch?: boolean } }
export interface Config { limits?: Record<string, number>; [k: string]: unknown }
export interface Character { id: string; nick?: string; role?: string; name: string; emoji?: string; voiceId?: string; greeting: string; tools?: string[]; description?: string; accent?: string; language?: string; mirrorLanguage?: boolean }
export interface Voice { id: string; name: string; category: 'premade' | 'cloned' | 'library' | 'shared' | string; previewUrl?: string | null; own: boolean; labels?: Record<string, string>; description?: string; inCollection?: boolean; sourceId?: string; ownerId?: string }
/** One voice of the public ElevenLabs Voice Library (GET /voices/library). `id` = source voice id. */
export interface LibraryWarning { code: 'notice_period' | 'live_moderation' | 'custom_rate' | 'not_on_plan' | string; level: 'info' | 'warn'; message: string; days?: number; rate?: number }
export interface LibraryVoice extends Voice {
  ownerId: string; gender?: string; age?: string; accent?: string; language?: string; locale?: string; useCase?: string; descriptive?: string;
  clonedBy: number; usage1y: number; featured: boolean; noticePeriodDays: number | null; liveModeration: boolean; freeUsersAllowed: boolean; rate: number | null;
  collectionId?: string; addable: boolean; warnings: LibraryWarning[];
}
export interface LibraryFacets { genders: string[]; ages: string[]; accents: string[]; languages: Array<{ code: string; name: string }>; categories: string[]; useCases: string[]; sorts: string[] }
export interface Tune { stability: number; similarity: number; style: number; speed: number; speakerBoost: boolean }
export interface TtsBody { text: string; voiceId: string; tune?: Partial<Tune>; format?: string }
export interface LibraryQuery { q?: string; gender?: string; age?: string; accent?: string; language?: string; category?: string; useCase?: string; sort?: 'trending' | 'created' | 'usage' | 'cloned' | ''; page?: number; pageSize?: number }
export interface LibraryPage { voices: LibraryVoice[]; hasMore: boolean; page: number; total?: number; facets?: LibraryFacets }
export interface PersonaDraft { name: string; description: string; accent: string; language: string; greeting: string }
export interface AssistOrb { colors: string[]; style: string; speed: number; smooth: number; shape?: string }
export interface AssistResult { persona: PersonaDraft; orb?: AssistOrb | null; sources: Array<{ title: string; url: string }>; notes: string; webSearch?: boolean; redirected?: boolean }

async function libraryPage(q: LibraryQuery, signal?: AbortSignal): Promise<LibraryPage> {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== null) sp.set(k, String(v));
  const r = await json<any>('GET', '/voices/library' + (sp.toString() ? '?' + sp : ''), undefined, { signal });
  const voices: LibraryVoice[] = (Array.isArray(r) ? r : r?.voices || r?.items || []).map((v: LibraryVoice) => ({ ...v, own: false, category: v.category || 'library', warnings: v.warnings || [] }));
  const page = Number(r?.page ?? q.page ?? 1) || 1;
  const hasMore = typeof r?.hasMore === 'boolean' ? r.hasMore : typeof r?.pages === 'number' ? page < r.pages
    : typeof r?.total === 'number' ? page * Number(r?.pageSize || Math.max(1, voices.length)) < r.total : false;
  return { voices, hasMore, page, total: typeof r?.total === 'number' ? r.total : undefined, facets: r?.facets || r?.filters };
}

/** Varied random sample of public library voices (all with preview), for the tour. */
async function libraryRandom(n = 24, diverse = true, signal?: AbortSignal): Promise<LibraryVoice[]> {
  const r = await json<any>('GET', `/voices/library/random?n=${n}&diverse=${diverse ? 1 : 0}`, undefined, { signal });
  return (r?.voices || []).map((v: LibraryVoice) => ({ ...v, own: false, category: v.category || 'library', warnings: v.warnings || [] }));
}

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
  library: libraryPage,
  libraryRandom,
  /** Add to the collection. `ownerId` (from the library listing) = public Voice Library voice. */
  addToCollection: (voiceId: string, ownerId?: string) => json<{ ok: boolean; voiceId: string; sourceId: string; inCollection: boolean; added: boolean }>('POST', '/voices/collection', ownerId ? { voiceId, ownerId } : { voiceId }),
  removeFromCollection: (voiceId: string) => json<any>('DELETE', '/voices/collection/' + encodeURIComponent(voiceId)),
  /** AI persona helper: research (from an idea) or refine (a draft). */
  personaAssist: (body: { mode: 'research' | 'refine'; idea: string; draft?: Partial<PersonaDraft>; language?: string }, signal?: AbortSignal) =>
    json<AssistResult>('POST', '/persona/assist', body, { signal }),
  usageChanged: () => emit({ type: 'usage' }),
  on: onApiEvent,
};
export type Api = typeof api;
