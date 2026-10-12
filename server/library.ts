/* Public ElevenLabs Voice Library (GET /v1/shared-voices): browse, preview, and add to a user's collection.
   A public voice is added to the ElevenLabs account at most ONCE (POST /v1/voices/add/{owner}/{id}) and shared by every
   user who adds it (table shared_voice_map, refs = users having it). Only voices with refs=0 that this app added are
   ever removed from the account (admin cleanup). */
import { config } from './config.js';
import { all, one, run, tx } from './db.js';
import { accountVoices, deleteElevenVoice, elevenHeaders, invalidateVoiceCache, isSharedVoice, previewProxyUrl, UpstreamError } from './eleven.js';
import { characters } from './characters.js';

const API = 'https://api.elevenlabs.io';

export interface SharedVoiceRaw {
  public_owner_id: string;
  voice_id: string;
  name: string;
  accent?: string | null;
  gender?: string | null;
  age?: string | null;
  descriptive?: string | null;
  use_case?: string | null;
  category?: string | null;
  language?: string | null;
  locale?: string | null;
  description?: string | null;
  preview_url?: string | null;
  usage_character_count_1y?: number;
  cloned_by_count?: number;
  rate?: number | null;
  free_users_allowed?: boolean;
  live_moderation_enabled?: boolean;
  featured?: boolean;
  notice_period?: number | null;
}

export interface LibraryWarning { code: 'notice_period' | 'live_moderation' | 'custom_rate' | 'not_on_plan'; level: 'info' | 'warn'; message: string; days?: number; rate?: number }

export interface LibraryVoice {
  id: string; ownerId: string; name: string; description?: string; previewUrl?: string;
  gender?: string; age?: string; accent?: string; language?: string; locale?: string; useCase?: string; descriptive?: string; category?: string;
  labels: Record<string, string>;
  clonedBy: number; usage1y: number; featured: boolean;
  noticePeriodDays: number | null; liveModeration: boolean; freeUsersAllowed: boolean; rate: number | null;
  inCollection: boolean; collectionId?: string; addable: boolean; warnings: LibraryWarning[];
}

export interface MapRow {
  public_owner_id: string; source_voice_id: string; account_voice_id: string; name: string;
  meta_json: string | null; created: number; added_at: number; refs: number;
}

/* ---------------- static facets (cheap, no upstream call) ---------------- */

export const SORTS = { trending: 'trending', created: 'created_date', usage: 'usage_character_count_1y', cloned: 'cloned_by_count' } as const;
export type SortKey = keyof typeof SORTS;
export const FACETS = {
  genders: ['female', 'male', 'neutral'],
  ages: ['young', 'middle_aged', 'old'],
  accents: ['american', 'british', 'australian', 'standard', 'indian', 'irish', 'scottish', 'canadian', 'african', 'south african',
    'new zealand', 'latin american', 'peninsular', 'mexican', 'brazilian', 'european', 'parisian', 'quebec', 'jakarta', 'malaysian', 'singaporean', 'filipino'],
  languages: [['en', 'English'], ['id', 'Indonesia'], ['ms', 'Melayu'], ['ja', 'Jepang'], ['ko', 'Korea'], ['zh', 'Mandarin'], ['hi', 'Hindi'],
    ['ar', 'Arab'], ['es', 'Spanyol'], ['pt', 'Portugis'], ['fr', 'Prancis'], ['de', 'Jerman'], ['it', 'Italia'], ['nl', 'Belanda'],
    ['ru', 'Rusia'], ['pl', 'Polandia'], ['tr', 'Turki'], ['sv', 'Swedia'], ['vi', 'Vietnam'], ['th', 'Thai'], ['fil', 'Filipino'],
    ['ta', 'Tamil'], ['uk', 'Ukraina'], ['cs', 'Ceko'], ['el', 'Yunani'], ['ro', 'Rumania'], ['da', 'Denmark'], ['fi', 'Finlandia'], ['no', 'Norwegia'], ['hu', 'Hungaria']]
    .map(([code, name]) => ({ code, name })),
  // measured: category=professional (and generated) returns the whole library, high_quality ~5k, famous 0
  categories: ['high_quality', 'professional'],
  useCases: ['conversational', 'narrative_story', 'characters_animation', 'social_media', 'entertainment_tv', 'advertisement', 'informative_educational'],
  sorts: Object.keys(SORTS),
};

/* ---------------- subscription (slots) ---------------- */

interface Sub { tier: string; voice_slots_used: number; voice_limit: number }
let subCache: { at: number; sub: Sub } | null = null;
export async function subscription(force = false): Promise<Sub> {
  if (!force && subCache && Date.now() - subCache.at < 60_000) return subCache.sub;
  const r = await fetch(`${API}/v1/user/subscription`, { headers: elevenHeaders(), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new UpstreamError(r.status, `ElevenLabs: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as Partial<Sub>;
  const sub = { tier: String(j.tier ?? ''), voice_slots_used: Number(j.voice_slots_used ?? 0), voice_limit: Number(j.voice_limit ?? 0) };
  subCache = { at: Date.now(), sub };
  return sub;
}
const isFreeTier = (tier: string) => !tier || tier === 'free';

/**
 * Slots in use, as this app counts them. ElevenLabs' `voice_slots_used` did NOT go up when a library voice was added
 * (measured 2026-10-12, creator tier), so library voices this app added are counted on top (conservative).
 */
export async function slotStatus(force = false) {
  const sub = await subscription(force);
  const appAdded = one<{ n: number }>('SELECT COUNT(*) AS n FROM shared_voice_map WHERE created = 1')?.n ?? 0;
  const used = sub.voice_slots_used + appAdded;
  const reserve = config.quota.voiceSlotReserve;
  const cap = config.quota.maxAccountVoiceSlotsUsed ?? Math.max(0, sub.voice_limit - reserve);
  return { used, accountSlotsUsed: sub.voice_slots_used, appAdded, limit: sub.voice_limit, cap, reserve, tier: sub.tier };
}

/* ---------------- listing (proxy + short cache) ---------------- */

const LIST_TTL = 2 * 60_000;
const listCache = new Map<string, { at: number; data: { voices: SharedVoiceRaw[]; has_more: boolean; total_count?: number } }>();
const listInflight = new Map<string, Promise<{ voices: SharedVoiceRaw[]; has_more: boolean; total_count?: number }>>();
/** voice_id -> last seen raw listing entry (for preview + add lookups without another search) */
const seen = new Map<string, { at: number; v: SharedVoiceRaw }>();
const SEEN_MAX = 6000;
function remember(v: SharedVoiceRaw) {
  if (seen.size >= SEEN_MAX) { let i = 0; for (const k of seen.keys()) { seen.delete(k); if (++i > 500) break; } }
  seen.delete(v.voice_id);
  seen.set(v.voice_id, { at: Date.now(), v });
}

async function fetchShared(params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  sp.sort();
  const key = sp.toString();
  const c = listCache.get(key);
  if (c && Date.now() - c.at < LIST_TTL) return c.data;
  let p = listInflight.get(key);
  if (!p) {
    p = (async () => {
      try {
        const r = await fetch(`${API}/v1/shared-voices?${key}`, { headers: elevenHeaders(), signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new UpstreamError(r.status, `ElevenLabs: ${(await r.text()).slice(0, 300)}`);
        const j = (await r.json()) as { voices?: SharedVoiceRaw[]; has_more?: boolean; total_count?: number };
        const data = { voices: Array.isArray(j.voices) ? j.voices : [], has_more: !!j.has_more, total_count: j.total_count };
        for (const v of data.voices) if (v?.voice_id) remember(v);
        if (listCache.size > 300) listCache.delete(listCache.keys().next().value!);
        listCache.set(key, { at: Date.now(), data });
        return data;
      } finally { listInflight.delete(key); }
    })();
    listInflight.set(key, p);
  }
  return p;
}

const clean = (s: unknown, max = 600) => String(s ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function warningsFor(v: SharedVoiceRaw, freeTier: boolean): LibraryWarning[] {
  const w: LibraryWarning[] = [];
  const days = typeof v.notice_period === 'number' && v.notice_period > 0 ? v.notice_period : null;
  if (days) {
    w.push({ code: 'notice_period', level: days < 365 ? 'warn' : 'info', days,
      message: `Pemilik bisa menarik suara ini; setelah ditarik suara masih bisa dipakai ${days} hari.` });
  }
  if (v.live_moderation_enabled) w.push({ code: 'live_moderation', level: 'warn', message: 'Teks yang dibacakan dimoderasi langsung oleh ElevenLabs; teks tertentu bisa ditolak.' });
  if (typeof v.rate === 'number' && v.rate > 1) w.push({ code: 'custom_rate', level: 'warn', rate: v.rate, message: `Tarif khusus pemilik: ${v.rate}x kredit per karakter.` });
  if (freeTier && v.free_users_allowed === false) w.push({ code: 'not_on_plan', level: 'warn', message: 'Tidak bisa dipakai pada paket akun server ini.' });
  return w;
}

function collectionMap(userId: number) {
  // collection ids of this user + map rows (source -> account id)
  const ids = new Set(all<{ voice_id: string }>('SELECT voice_id FROM user_voices WHERE user_id = ?', userId).map((r) => r.voice_id));
  return ids;
}

function sourceToAccount(sourceIds: string[]) {
  if (!sourceIds.length) return new Map<string, string>();
  const rows = all<{ source_voice_id: string; account_voice_id: string }>(
    `SELECT source_voice_id, account_voice_id FROM shared_voice_map WHERE source_voice_id IN (${sourceIds.map(() => '?').join(',')})`, ...sourceIds);
  return new Map(rows.map((r) => [r.source_voice_id, r.account_voice_id]));
}

export function toLibraryVoice(v: SharedVoiceRaw, coll: Set<string>, acctOf: Map<string, string>, freeTier: boolean): LibraryVoice {
  const accountId = acctOf.get(v.voice_id) ?? v.voice_id;
  const inCollection = coll.has(accountId) || coll.has(v.voice_id);
  const labels: Record<string, string> = {};
  for (const [k, val] of [['gender', v.gender], ['age', v.age], ['accent', v.accent], ['language', v.language], ['locale', v.locale], ['use_case', v.use_case], ['descriptive', v.descriptive]] as const) {
    let s = clean(val, 60);
    if (k === 'age' || k === 'gender') s = s.toLowerCase().replace(/[\s-]+/g, '_');
    if (s) labels[k] = s;
  }
  const warnings = warningsFor(v, freeTier);
  return {
    id: v.voice_id,
    ownerId: v.public_owner_id,
    name: clean(v.name, 100) || 'Tanpa nama',
    ...(clean(v.description) && { description: clean(v.description) }),
    ...(v.preview_url && { previewUrl: `${previewProxyUrl(v.voice_id)}?owner=${encodeURIComponent(v.public_owner_id)}` }),
    ...(labels.gender && { gender: labels.gender }),
    ...(labels.age && { age: labels.age }),
    ...(labels.accent && { accent: labels.accent }),
    ...(labels.language && { language: labels.language }),
    ...(labels.locale && { locale: labels.locale }),
    ...(labels.use_case && { useCase: labels.use_case }),
    ...(labels.descriptive && { descriptive: labels.descriptive }),
    ...(v.category && { category: clean(v.category, 40) }),
    labels,
    clonedBy: Number(v.cloned_by_count ?? 0) || 0,
    usage1y: Number(v.usage_character_count_1y ?? 0) || 0,
    featured: !!v.featured,
    noticePeriodDays: typeof v.notice_period === 'number' ? v.notice_period : null,
    liveModeration: !!v.live_moderation_enabled,
    freeUsersAllowed: v.free_users_allowed !== false,
    rate: typeof v.rate === 'number' ? v.rate : null,
    inCollection,
    ...(inCollection && { collectionId: accountId }),
    addable: !(freeTier && v.free_users_allowed === false),
    warnings,
  };
}

export interface LibraryQuery {
  q?: string; gender?: string; age?: string; accent?: string; language?: string; category?: string; useCase?: string;
  sort?: SortKey; page?: number; pageSize?: number; featured?: boolean;
}

async function freeTierSafe() {
  try { return isFreeTier((await subscription()).tier); } catch { return false; }
}

export async function libraryList(userId: number, q: LibraryQuery) {
  const pageSize = Math.min(100, Math.max(1, q.pageSize || 30));
  const page = Math.min(500, Math.max(1, q.page || 1));
  const params: Record<string, string> = { page_size: String(pageSize), page: String(page - 1), sort: SORTS[q.sort ?? 'trending'] };
  if (q.q) params.search = q.q;
  if (q.gender) params.gender = q.gender;
  if (q.age) params.age = q.age;
  if (q.accent) params.accent = q.accent;
  if (q.language) params.language = q.language;
  if (q.category) params.category = q.category;
  if (q.useCase) params.use_cases = q.useCase;
  if (q.featured) params.featured = 'true';
  const [data, freeTier] = await Promise.all([fetchShared(params), freeTierSafe()]);
  const coll = collectionMap(userId);
  const acctOf = sourceToAccount(data.voices.map((v) => v.voice_id));
  return {
    voices: data.voices.filter((v) => v?.voice_id && v.public_owner_id).map((v) => toLibraryVoice(v, coll, acctOf, freeTier)),
    page, pageSize, hasMore: data.has_more,
    total: typeof data.total_count === 'number' && data.total_count > 0 ? data.total_count : null,
    facets: FACETS,
  };
}

/* ---------------- random diverse sample (tour) ---------------- */

const POOL_TTL = 10 * 60_000;
let pool: { at: number; voices: SharedVoiceRaw[] } | null = null;
let poolInflight: Promise<{ at: number; voices: SharedVoiceRaw[] }> | null = null;
const POOL_QUERIES: Record<string, string>[] = [
  { sort: 'trending' }, { sort: 'cloned_by_count' },
  { gender: 'female', sort: 'trending' }, { gender: 'male', age: 'old' }, { age: 'young', gender: 'female' }, { age: 'old', gender: 'female' },
  { accent: 'british' }, { accent: 'australian' }, { accent: 'indian' }, { accent: 'irish' },
  { language: 'id' }, { language: 'ja' }, { language: 'es' }, { language: 'fr' }, { language: 'de' }, { language: 'ko' }, { language: 'pt' }, { language: 'hi' },
  { use_cases: 'characters_animation' }, { use_cases: 'conversational' },
];

async function randomPool() {
  if (pool && Date.now() - pool.at < POOL_TTL) return pool;
  poolInflight ??= (async () => {
    try {
      const res = await Promise.allSettled(POOL_QUERIES.map((p) => fetchShared({ page_size: '30', page: '0', sort: 'trending', ...p })));
      const byId = new Map<string, SharedVoiceRaw>();
      for (const r of res) if (r.status === 'fulfilled') for (const v of r.value.voices) if (v.preview_url && v.public_owner_id) byId.set(v.voice_id, v);
      if (!byId.size) {
        const err = res.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        throw err?.reason ?? new UpstreamError(0, 'ElevenLabs: empty library');
      }
      pool = { at: Date.now(), voices: [...byId.values()] };
      return pool;
    } finally { poolInflight = null; }
  })();
  return poolInflight;
}

function shuffle<T>(a: T[]) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export async function libraryRandom(userId: number, n: number, diverse: boolean) {
  const [p, freeTier] = await Promise.all([randomPool(), freeTierSafe()]);
  const cand = shuffle(p.voices.filter((v) => !(freeTier && v.free_users_allowed === false) && !v.live_moderation_enabled
    && v.gender && v.age && v.language && v.accent));
  let picked: SharedVoiceRaw[];
  if (!diverse) picked = cand.slice(0, n);
  else {
    // greedy: each pick maximises novelty of (gender, age, accent, language) vs what is already chosen
    picked = [];
    const cnt = { g: new Map<string, number>(), a: new Map<string, number>(), ac: new Map<string, number>(), l: new Map<string, number>() };
    const k = (v: SharedVoiceRaw) => ({ g: String(v.gender ?? ''), a: String(v.age ?? '').replace(/[\s-]+/g, '_'), ac: String(v.accent ?? ''), l: String(v.language ?? '') });
    const rest = cand.slice();
    while (picked.length < n && rest.length) {
      let best = 0, bestScore = Infinity;
      for (let i = 0; i < Math.min(rest.length, 400); i++) {
        const x = k(rest[i]);
        const s = (cnt.g.get(x.g) ?? 0) * 1.0 + (cnt.a.get(x.a) ?? 0) * 0.8 + (cnt.ac.get(x.ac) ?? 0) * 1.6 + (cnt.l.get(x.l) ?? 0) * 1.4;
        if (s < bestScore) { bestScore = s; best = i; }
      }
      const v = rest.splice(best, 1)[0];
      const x = k(v);
      cnt.g.set(x.g, (cnt.g.get(x.g) ?? 0) + 1); cnt.a.set(x.a, (cnt.a.get(x.a) ?? 0) + 1);
      cnt.ac.set(x.ac, (cnt.ac.get(x.ac) ?? 0) + 1); cnt.l.set(x.l, (cnt.l.get(x.l) ?? 0) + 1);
      picked.push(v);
    }
  }
  const coll = collectionMap(userId);
  const acctOf = sourceToAccount(picked.map((v) => v.voice_id));
  return { voices: picked.map((v) => toLibraryVoice(v, coll, acctOf, freeTier)), at: p.at };
}

/* ---------------- lookup one public voice ---------------- */

/** Find a public library voice by id (recently listed, else a search by its id). null = not a public voice. */
export async function findLibraryVoice(voiceId: string, ownerId?: string): Promise<SharedVoiceRaw | null> {
  const s = seen.get(voiceId);
  if (s && Date.now() - s.at < 30 * 60_000 && (!ownerId || s.v.public_owner_id === ownerId)) return s.v;
  const params: Record<string, string> = { page_size: '10', page: '0', search: voiceId };
  if (ownerId) params.owner_id = ownerId;
  const d = await fetchShared(params);
  const hit = d.voices.find((v) => v.voice_id === voiceId && (!ownerId || v.public_owner_id === ownerId));
  return hit ?? null;
}

/** Preview URL of a public library voice (only voices that really are in the public library). */
export async function libraryPreviewUrl(voiceId: string, ownerId?: string): Promise<string | null> {
  const v = await findLibraryVoice(voiceId, ownerId);
  return v?.preview_url ?? null;
}

/* ---------------- add / remove (dedupe + slots) ---------------- */

export class SlotsFullError extends Error { constructor(public used: number, public cap: number) { super('slots_full'); } }
export class NotAddableError extends Error { constructor(public reason: string, message: string) { super(message); } }

export function mapRowByAccount(accountVoiceId: string) {
  return one<MapRow>('SELECT * FROM shared_voice_map WHERE account_voice_id = ?', accountVoiceId);
}
export function mapRowBySource(sourceVoiceId: string) {
  return one<MapRow>('SELECT * FROM shared_voice_map WHERE source_voice_id = ?', sourceVoiceId);
}

/** Recompute refs of the map row(s) for an account voice id from user_voices (source of truth). */
export function syncRefs(accountVoiceId: string) {
  run(`UPDATE shared_voice_map SET refs = (SELECT COUNT(*) FROM user_voices WHERE voice_id = ?) WHERE account_voice_id = ?`, accountVoiceId, accountVoiceId);
}
export function syncAllRefs() {
  run('UPDATE shared_voice_map SET refs = (SELECT COUNT(*) FROM user_voices u WHERE u.voice_id = shared_voice_map.account_voice_id)');
}

// adds are serialised: the slot check + upstream add + map insert must not race (cap could be exceeded)
let addChain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = addChain.then(fn, fn);
  addChain = p.catch(() => {});
  return p;
}

const metaOf = (v: SharedVoiceRaw) => JSON.stringify({
  name: v.name, description: v.description ?? null, preview_url: v.preview_url ?? null, category: v.category ?? null,
  labels: { gender: v.gender, age: v.age, accent: v.accent, language: v.language, locale: v.locale, use_case: v.use_case, descriptive: v.descriptive },
  notice_period: v.notice_period ?? null, live_moderation_enabled: !!v.live_moderation_enabled, rate: v.rate ?? null,
});

/**
 * Make sure a public voice exists on the ElevenLabs account (dedupe: at most one slot per voice) and return its
 * account voice id + whether a new slot was used. Throws SlotsFullError / NotAddableError / UpstreamError.
 */
export async function ensureOnAccount(voiceId: string, ownerId: string): Promise<{ accountVoiceId: string; added: boolean }> {
  return serial(async () => {
    const existing = one<MapRow>('SELECT * FROM shared_voice_map WHERE public_owner_id = ? AND source_voice_id = ?', ownerId, voiceId);
    if (existing) return { accountVoiceId: existing.account_voice_id, added: false };
    const v = await findLibraryVoice(voiceId, ownerId);
    if (!v) throw new NotAddableError('not_in_library', 'Suara ini tidak ada di Voice Library publik.');
    const sub = await subscription();
    if (isFreeTier(sub.tier) && v.free_users_allowed === false) {
      throw new NotAddableError('not_on_plan', 'Suara ini tidak bisa dipakai pada paket akun server.');
    }
    // already on the account (added by hand earlier, or a premade): no new slot, never cleaned up by the app
    const acct = await accountVoices();
    if (acct.some((a) => a.voice_id === voiceId)) {
      run(`INSERT OR IGNORE INTO shared_voice_map (public_owner_id, source_voice_id, account_voice_id, name, meta_json, created, added_at, refs)
           VALUES (?, ?, ?, ?, ?, 0, ?, 0)`, ownerId, voiceId, voiceId, clean(v.name, 100), metaOf(v), Date.now());
      return { accountVoiceId: voiceId, added: false };
    }
    const st = await slotStatus(true);
    if (st.used >= st.cap) throw new SlotsFullError(st.used, st.cap);
    const r = await fetch(`${API}/v1/voices/add/${encodeURIComponent(ownerId)}/${encodeURIComponent(voiceId)}`, {
      method: 'POST',
      headers: elevenHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ new_name: clean(v.name, 100) || voiceId, bookmarked: false }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    if (!r.ok) {
      let message = text.slice(0, 400);
      try { const j = JSON.parse(text); message = j?.detail?.message ?? (typeof j?.detail === 'string' ? j.detail : message); } catch { /* plain */ }
      if (/voice[_ ]?limit|slots?|maximum (amount|number) of (custom )?voices/i.test(message)) throw new SlotsFullError(st.used, st.cap);
      throw new UpstreamError(r.status, `ElevenLabs: ${message}`);
    }
    const accountVoiceId = String((JSON.parse(text) as { voice_id?: string }).voice_id || voiceId);
    run(`INSERT OR REPLACE INTO shared_voice_map (public_owner_id, source_voice_id, account_voice_id, name, meta_json, created, added_at, refs)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0)`, ownerId, voiceId, accountVoiceId, clean(v.name, 100), metaOf(v), Date.now());
    invalidateVoiceCache();
    subCache = null;
    return { accountVoiceId, added: true };
  });
}

/** Collection entries rendered from the map (public library voices), keyed by account voice id. */
export function mappedCollection(userId: number) {
  return all<MapRow>(`SELECT m.* FROM shared_voice_map m JOIN user_voices u ON u.voice_id = m.account_voice_id WHERE u.user_id = ?`, userId);
}

export function isMappedVoice(accountVoiceId: string) {
  return !!mapRowByAccount(accountVoiceId);
}

/* ---------------- admin ---------------- */

const protectedIds = () => new Set([
  ...config.sharedVoiceIds,
  ...characters.map((c) => c.voiceId),
  ...all<{ eleven_voice_id: string }>('SELECT eleven_voice_id FROM voices').map((r) => r.eleven_voice_id),
]);

export async function adminSlots() {
  syncAllRefs();
  const rows = all<MapRow>('SELECT * FROM shared_voice_map ORDER BY added_at DESC');
  const st = await slotStatus(true);
  return {
    used: st.used, accountSlotsUsed: st.accountSlotsUsed, appAdded: st.appAdded, limit: st.limit, cap: st.cap, reserve: st.reserve, tier: st.tier,
    mapped: rows.map((r) => ({ sourceId: r.source_voice_id, ownerId: r.public_owner_id, accountVoiceId: r.account_voice_id, name: r.name, refs: r.refs, created: !!r.created, addedAt: new Date(r.added_at).toISOString() })),
    unreferenced: rows.filter((r) => r.refs === 0 && r.created).length,
  };
}

/** Remove from the ElevenLabs account ONLY library voices this app added that no user references (refs=0). */
export async function cleanupUnreferenced() {
  syncAllRefs();
  const prot = protectedIds();
  const rows = all<MapRow>('SELECT * FROM shared_voice_map WHERE refs = 0');
  let removed = 0, failed = 0, forgotten = 0;
  for (const r of rows) {
    // double-check right before deleting (a user may have added it meanwhile)
    const still = one<{ n: number }>('SELECT COUNT(*) AS n FROM user_voices WHERE voice_id = ?', r.account_voice_id)?.n ?? 0;
    if (still) continue;
    if (!r.created || prot.has(r.account_voice_id) || isSharedVoice(r.account_voice_id)) {
      // not ours to delete: just forget the mapping
      run('DELETE FROM shared_voice_map WHERE public_owner_id = ? AND source_voice_id = ?', r.public_owner_id, r.source_voice_id);
      forgotten++;
      continue;
    }
    try {
      await deleteElevenVoice(r.account_voice_id);
      tx(() => run('DELETE FROM shared_voice_map WHERE public_owner_id = ? AND source_voice_id = ?', r.public_owner_id, r.source_voice_id));
      removed++;
    } catch { failed++; }
  }
  subCache = null;
  return { ok: true, removed, failed, forgotten };
}
