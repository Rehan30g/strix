import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// dev: v2/server  -> v2 ; prod: v2/dist/server -> v2
export const ROOT = path.basename(path.dirname(here)) === 'dist' ? path.resolve(here, '../..') : path.resolve(here, '..');

// Load v2/.env if present (real environment variables win).
const envFile = process.env.ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch (e) { console.warn(`Could not read ${envFile}: ${(e as Error).message}`); }
}

const env = process.env;
const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
const list = (v: string | undefined) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** SHARED_VOICE_NAMES: JSON object {"voiceId":"Name"} or "voiceId:Name,voiceId:Name". Invalid entries are dropped. */
function voiceNames(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (id: unknown, name: unknown) => {
    const i = String(id ?? '').trim();
    const n = String(name ?? '').replace(/[\p{Cc}\p{Cf}<>[\]{}`"]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (/^[\w-]{10,40}$/.test(i) && n) out[i] = n;
  };
  const s = v.trim();
  if (s.startsWith('{')) {
    try { for (const [id, name] of Object.entries(JSON.parse(s) as Record<string, unknown>)) add(id, name); } catch { console.warn('SHARED_VOICE_NAMES: invalid JSON, ignored'); }
  } else {
    for (const item of list(s)) { const i = item.indexOf(':'); if (i > 0) add(item.slice(0, i), item.slice(i + 1)); }
  }
  return out;
}

const isProd = env.NODE_ENV === 'production';
const port = int(env.PORT, 3000);

export const config = {
  isProd,
  port,
  host: env.HOST || (isProd ? '127.0.0.1' : '0.0.0.0'),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  dbFile: path.resolve(ROOT, env.DB_FILE || 'data/app.db'),
  webDist: path.resolve(ROOT, env.WEB_DIST || 'web/dist'),
  sessionSecret: env.SESSION_SECRET || '',
  sessionDays: 7,
  extraOrigins: list(env.ALLOWED_ORIGINS),

  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
  },
  adminEmails: new Set(list(env.ADMIN_EMAILS).map((e) => e.toLowerCase())),

  devFakeLogin: env.DEV_FAKE_LOGIN === '1',
  devFakeEmail: env.DEV_FAKE_EMAIL || 'dev.user@example.com',
  devFakeName: env.DEV_FAKE_NAME || 'Dev User',

  openrouterKey: env.OPENROUTER_API_KEY || '',
  // Models are LOCKED server-side: clients can never choose them.
  defaultModel: env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash',
  // Small fast model for turn-taking decisions (POST /api/chat/decide), routed by latency. Locked server-side;
  // empty = the chat model. Default picked by benchmark (2026-10-11, 33 cases, LLM only): deepseek-v4.1-flash 32/33,
  // median ~540 ms (gemini-3.1-flash-lite 26/33 ~980 ms, claude-haiku-5.5 32/33 ~1200 ms, gpt-5.4-nano 25/33 ~1080 ms).
  decisionModel: (env.OPENROUTER_DECISION_MODEL ?? '').trim() || 'deepseek/deepseek-v4.1-flash',
  // optional web-search engine for the chat web_search tool (exa|parallel|native|...); default: OpenRouter's choice
  chatWebEngine: (env.CHAT_WEB_ENGINE || env.PERSONA_WEB_ENGINE || '').trim(),

  elevenKey: env.ELEVENLABS_API_KEY || '',
  // TTS is always eleven_v4_turbo (ELEVENLABS_MODEL is ignored on purpose).
  ttsModel: 'eleven_v4_turbo',
  // eleven_v4_turbo cannot do speech-to-speech, so the Voice Changer uses one fixed STS model.
  stsModel: /^eleven_[a-z0-9_]{2,40}$/.test(env.ELEVENLABS_STS_MODEL ?? '') ? env.ELEVENLABS_STS_MODEL! : 'eleven_multilingual_sts_v2',
  // ElevenLabs voices every active user may use (admin's account voices), shown as category 'shared'.
  sharedVoiceIds: env.SHARED_VOICE_IDS !== undefined ? list(env.SHARED_VOICE_IDS) : ['FjsOoJ0RVxWEQK4p2Wzq'],
  // Display names that override the ElevenLabs account name (GET /voices and the library).
  // SHARED_VOICE_NAMES = JSON {"<id>":"Name"} or a list "id:Name,id2:Name 2".
  sharedVoiceNames: env.SHARED_VOICE_NAMES !== undefined ? voiceNames(env.SHARED_VOICE_NAMES) : { FjsOoJ0RVxWEQK4p2Wzq: 'Strix' } as Record<string, string>,
  maxTtsConcurrent: int(env.ELEVENLABS_MAX_CONCURRENT, 3) || 3,
  // Speech-to-text (ElevenLabs Scribe Realtime, browser connects directly with a single-use token)
  sttModel: 'scribe_v2_realtime',
  // WebSocket host for Scribe Realtime (regional hosts allowed, must be *.elevenlabs.io). Also added to CSP connect-src.
  sttHost: /^api(\.[a-z0-9-]+)*\.elevenlabs\.io$/.test(env.ELEVENLABS_STT_HOST ?? '') ? env.ELEVENLABS_STT_HOST! : 'api.elevenlabs.io',

  quota: {
    llmReqPerDay: int(env.QUOTA_LLM_REQ_PER_DAY, 300),
    ttsCharsPerDay: int(env.QUOTA_TTS_CHARS_PER_DAY, 30000),
    maxClones: int(env.MAX_CLONES_PER_USER, 2),
    maxCollection: int(env.MAX_COLLECTION, 50) || 50, // library voices a user can add to their collection
    // public Voice Library: cap on account voice slots in use (clones + library voices this app added).
    // null = account voice_limit - voiceSlotReserve (read from ElevenLabs /v1/user/subscription)
    maxAccountVoiceSlotsUsed: env.MAX_ACCOUNT_VOICE_SLOTS_USED ? int(env.MAX_ACCOUNT_VOICE_SLOTS_USED, 0) : null as number | null,
    voiceSlotReserve: int(env.VOICE_SLOT_RESERVE, 10),
    maxCloneUploadMb: int(env.MAX_CLONE_UPLOAD_MB, 10),
    vcSecPerDay: int(env.QUOTA_VC_SEC_PER_DAY, 600),
    maxVcUploadMb: int(env.MAX_VC_UPLOAD_MB, 15) || 15,
    sttSecPerDay: int(env.QUOTA_STT_SEC_PER_DAY, 1800), // speech-to-text seconds of mic audio per day
    searchPerDay: int(env.QUOTA_SEARCH_PER_DAY, 50), // chat web_search tool executions per day
    decidePerDay: int(env.QUOTA_DECIDE_PER_DAY, 3000), // /api/chat/decide calls per day (not counted as LLM requests)
    decidePerMin: int(env.RATE_DECIDE_PER_MIN, 120) || 120, // /api/chat/decide calls per minute per user
  },
  rate: {
    globalPerMin: int(env.RATE_GLOBAL_PER_MIN, 120),
    authPerMin: int(env.RATE_AUTH_PER_MIN, 20),
  },
  limits: {
    ttsMaxChars: 2000, // /tts (streamed)
    ttsGenerateMaxChars: 5000, // /tts/generate (studio)
    dialogueMaxLines: 40, // /tts/dialogue: lines per request
    dialogueMaxChars: 20000, // /tts/dialogue: total chars per request (also bounded by the daily TTS quota)
    settingsMaxBytes: 64 * 1024,
    settingsMaxKeys: 100,
    vcMaxSec: 300, // /vc: max input length (seconds)
    sttMaxSessionSec: Math.min(3600, Math.max(10, int(env.STT_MAX_SESSION_SEC, 300))), // one STT session (token) max length
  },
};

export type Config = typeof config;

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (config.isProd && config.devFakeLogin) {
    throw new Error('DEV_FAKE_LOGIN=1 is not allowed when NODE_ENV=production. Refusing to start.');
  }
  if (!config.sessionSecret || config.sessionSecret.length < 32) {
    if (config.isProd) throw new Error('SESSION_SECRET must be set (>= 32 chars) in production.');
    config.sessionSecret = 'dev-only-insecure-session-secret-change-me-please!!';
    problems.push('SESSION_SECRET not set: using an insecure dev secret.');
  }
  if (config.isProd && !config.publicUrl.startsWith('https://')) problems.push('PUBLIC_URL should be https:// in production.');
  if (!config.google.clientId || !config.google.clientSecret) problems.push('GOOGLE_CLIENT_ID/SECRET not set: Google login disabled.');
  if (!config.openrouterKey) problems.push('OPENROUTER_API_KEY not set: LLM endpoints will fail.');
  if (!config.elevenKey) problems.push('ELEVENLABS_API_KEY not set: TTS/voice endpoints will fail.');
  if (env.ELEVENLABS_MODEL && env.ELEVENLABS_MODEL !== config.ttsModel) problems.push(`ELEVENLABS_MODEL=${env.ELEVENLABS_MODEL} ignored: TTS is locked to ${config.ttsModel}.`);
  if (!config.adminEmails.size) problems.push('ADMIN_EMAILS empty: nobody can create invite codes.');
  return problems;
}
