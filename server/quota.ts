import { config } from './config.js';
import { one, run, all, type UserRow } from './db.js';

export interface QuotaOverrides {
  llmReqPerDay?: number | null;
  ttsCharsPerDay?: number | null;
  maxClones?: number | null;
  vcSecPerDay?: number | null;
  sttSecPerDay?: number | null;
  searchPerDay?: number | null;
  decidePerDay?: number | null;
  memoryPerDay?: number | null;
}

export interface Limits {
  llmReqPerDay: number;
  ttsCharsPerDay: number;
  maxClones: number;
  vcSecPerDay: number;
  sttSecPerDay: number;
  searchPerDay: number;
  decidePerDay: number;
  memoryPerDay: number;
}

export const today = () => new Date().toISOString().slice(0, 10); // UTC day

export function resetAt(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

export function overridesOf(user: Pick<UserRow, 'quota_json'>): QuotaOverrides {
  try { return user.quota_json ? JSON.parse(user.quota_json) : {}; } catch { return {}; }
}

export function limitsFor(user: Pick<UserRow, 'quota_json'>): Limits {
  const o = overridesOf(user);
  const pick = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
  return {
    llmReqPerDay: pick(o.llmReqPerDay, config.quota.llmReqPerDay),
    ttsCharsPerDay: pick(o.ttsCharsPerDay, config.quota.ttsCharsPerDay),
    maxClones: pick(o.maxClones, config.quota.maxClones),
    vcSecPerDay: pick(o.vcSecPerDay, config.quota.vcSecPerDay),
    sttSecPerDay: pick(o.sttSecPerDay, config.quota.sttSecPerDay),
    searchPerDay: pick(o.searchPerDay, config.quota.searchPerDay),
    decidePerDay: pick(o.decidePerDay, config.quota.decidePerDay),
    memoryPerDay: pick(o.memoryPerDay, config.quota.memoryPerDay),
  };
}

interface UsageRow { llm_req: number; tts_chars: number; llm_tokens: number; vc_sec: number; stt_sec: number; search_req: number; decide_req: number; memory_req: number }

export function usageOf(userId: number, day = today()): UsageRow {
  return one<UsageRow>('SELECT llm_req, tts_chars, llm_tokens, vc_sec, stt_sec, search_req, decide_req, memory_req FROM usage WHERE user_id = ? AND day = ?', userId, day)
    ?? { llm_req: 0, tts_chars: 0, llm_tokens: 0, vc_sec: 0, stt_sec: 0, search_req: 0, decide_req: 0, memory_req: 0 };
}

export function usageToday(userIds: number[]): Map<number, UsageRow> {
  const rows = all<UsageRow & { user_id: number }>('SELECT user_id, llm_req, tts_chars, llm_tokens, vc_sec, stt_sec, search_req, decide_req, memory_req FROM usage WHERE day = ?', today());
  const m = new Map<number, UsageRow>();
  for (const r of rows) if (userIds.includes(r.user_id)) m.set(r.user_id, r);
  return m;
}

export function quotaSummary(user: UserRow) {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  return {
    llm: { used: u.llm_req, limit: l.llmReqPerDay },
    tts: { used: u.tts_chars, limit: l.ttsCharsPerDay },
    vc: { used: u.vc_sec, limit: l.vcSecPerDay },
    stt: { used: u.stt_sec, limit: l.sttSecPerDay },
    search: { used: u.search_req, limit: l.searchPerDay },
    decide: { used: u.decide_req, limit: l.decidePerDay },
    memory: { used: u.memory_req, limit: l.memoryPerDay },
    resetAt: resetAt(),
  };
}

export class QuotaError extends Error {
  constructor(public kind: 'llm' | 'tts' | 'clone' | 'vc' | 'stt' | 'search' | 'decide' | 'memory', public resetAt: string | null) {
    super(`quota exceeded: ${kind}`);
  }
}

const UPSERT = `INSERT INTO usage (user_id, day, llm_req, tts_chars, llm_tokens) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(user_id, day) DO UPDATE SET llm_req = llm_req + excluded.llm_req,
  tts_chars = tts_chars + excluded.tts_chars, llm_tokens = llm_tokens + excluded.llm_tokens`;

/** Atomically checks and reserves one LLM request. Throws QuotaError when over the limit. */
export function chargeLlm(user: UserRow) {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  if (u.llm_req + 1 > l.llmReqPerDay) throw new QuotaError('llm', resetAt());
  run(UPSERT, user.id, today(), 1, 0, 0);
}

export function addTokens(userId: number, tokens: number) {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  run(UPSERT, userId, today(), 0, 0, Math.round(tokens));
}

/** Checks and reserves `chars` TTS characters. Returns a refund function (for upstream failures). */
export function chargeTts(user: UserRow, chars: number): () => void {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  if (u.tts_chars + chars > l.ttsCharsPerDay) throw new QuotaError('tts', resetAt());
  const day = today();
  run(UPSERT, user.id, day, 0, chars, 0);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run('UPDATE usage SET tts_chars = MAX(0, tts_chars - ?) WHERE user_id = ? AND day = ?', chars, user.id, day);
  };
}

/** Adds `sec` seconds of speech-to-text usage (already capped by the caller; may end slightly over the limit). */
export function addStt(userId: number, sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return;
  run('INSERT INTO usage (user_id, day, stt_sec) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET stt_sec = stt_sec + excluded.stt_sec', userId, today(), Math.ceil(sec));
}

/** Checks and reserves `sec` seconds of Voice Changer input audio. Returns a refund function. */
export function chargeVc(user: UserRow, sec: number): () => void {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  if (u.vc_sec + sec > l.vcSecPerDay) throw new QuotaError('vc', resetAt());
  const day = today();
  run('INSERT INTO usage (user_id, day, vc_sec) VALUES (?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET vc_sec = vc_sec + excluded.vc_sec', user.id, day, sec);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run('UPDATE usage SET vc_sec = MAX(0, vc_sec - ?) WHERE user_id = ? AND day = ?', sec, user.id, day);
  };
}

/** Checks and reserves one web search (chat tool). Returns a refund function (search failed upstream). */
export function chargeSearch(user: UserRow): () => void {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  if (u.search_req + 1 > l.searchPerDay) throw new QuotaError('search', resetAt());
  const day = today();
  run('INSERT INTO usage (user_id, day, search_req) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET search_req = search_req + 1', user.id, day);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run('UPDATE usage SET search_req = MAX(0, search_req - 1) WHERE user_id = ? AND day = ?', user.id, day);
  };
}

/** Counts one /api/chat/decide call (separate from the LLM request quota). */
export function chargeDecide(user: UserRow) {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  if (u.decide_req + 1 > l.decidePerDay) throw new QuotaError('decide', resetAt());
  run('INSERT INTO usage (user_id, day, decide_req) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET decide_req = decide_req + 1', user.id, today());
}

/** Counts one memory summary (POST /api/memory/commit LLM call; separate from the LLM request quota).
    Returns a refund function (the summary failed upstream). */
export function chargeMemory(user: UserRow): () => void {
  const l = limitsFor(user);
  const u = usageOf(user.id);
  if (u.memory_req + 1 > l.memoryPerDay) throw new QuotaError('memory', resetAt());
  const day = today();
  run('INSERT INTO usage (user_id, day, memory_req) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET memory_req = memory_req + 1', user.id, day);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    run('UPDATE usage SET memory_req = MAX(0, memory_req - 1) WHERE user_id = ? AND day = ?', user.id, day);
  };
}