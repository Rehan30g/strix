import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export type UserStatus = 'pending' | 'active' | 'suspended';

export interface UserRow {
  id: number;
  google_sub: string;
  email: string;
  name: string;
  picture: string | null;
  status: UserStatus;
  is_admin: number;
  invite_id: number | null;
  created_at: number;
  quota_json: string | null;
}

export interface InviteRow {
  id: number;
  code: string;
  max_uses: number;
  used_count: number;
  expires_at: number;
  note: string | null;
  revoked: number;
  created_by: number | null;
  created_at: number;
}

export interface VoiceRow {
  id: number;
  user_id: number;
  eleven_voice_id: string;
  name: string;
  description: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  picture TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  is_admin INTEGER NOT NULL DEFAULT 0,
  invite_id INTEGER REFERENCES invites(id),
  created_at INTEGER NOT NULL,
  quota_json TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 4),
  used_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  note TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  llm_req INTEGER NOT NULL DEFAULT 0,
  tts_chars INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  vc_sec INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  eleven_voice_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS voices_user ON voices(user_id);
CREATE TABLE IF NOT EXISTS tts_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  model TEXT NOT NULL,
  chars INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tts_history_user ON tts_history(user_id, created_at);
CREATE TABLE IF NOT EXISTS user_voices (   -- per-user collection of account (premade/library) voices
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  voice_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, voice_id)
);
-- public Voice Library voices added to the ElevenLabs account ONCE and shared by every user who added them
CREATE TABLE IF NOT EXISTS shared_voice_map (
  public_owner_id TEXT NOT NULL,
  source_voice_id TEXT NOT NULL,
  account_voice_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  meta_json TEXT,                     -- display fields from the library listing (labels, description, preview_url)
  created INTEGER NOT NULL DEFAULT 1, -- 1 = this app added it (cleanup may delete it), 0 = it was already on the account
  added_at INTEGER NOT NULL,
  refs INTEGER NOT NULL DEFAULT 0,    -- users who have it in user_voices (kept in sync, recomputed by admin)
  PRIMARY KEY (public_owner_id, source_voice_id)
);
CREATE INDEX IF NOT EXISTS shared_voice_map_acct ON shared_voice_map(account_voice_id);
CREATE INDEX IF NOT EXISTS user_voices_voice ON user_voices(voice_id);
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
-- cross-conversation memory of a chat persona, per user (server/memory.ts). persona_id = built-in id or the client's
-- custom persona id. summary <= 1200 chars, facts_json <= 20 short strings, mood_json {label,intensity,reason,at}
CREATE TABLE IF NOT EXISTS persona_memory (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  facts_json TEXT NOT NULL DEFAULT '[]',
  mood_json TEXT,
  last_end_at INTEGER,
  last_end_reason TEXT,               -- hangup | quit (left a group call quietly) | restart | switch | idle | duo
  last_end_note TEXT,                 -- end_call reason (neutral sentence) when the persona hung up
  lang TEXT,                          -- language the user spoke last time (for the opener)
  turns INTEGER NOT NULL DEFAULT 0,   -- user turns summarised so far
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, persona_id)
);
-- "news that spreads": events from a call with one built-in persona that the connected built-ins (Strix <-> Lena) know
-- about. <= 30 per user (older ones are folded into one compacted line).
CREATE TABLE IF NOT EXISTS shared_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_persona_id TEXT NOT NULL,    -- the persona the event happened with
  persona_ids_json TEXT NOT NULL,     -- personas who heard about it
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shared_events_user ON shared_events(user_id, created_at);
-- personas that have been on a call together (duo / group calls, server/duo.ts): news from one reaches the other.
-- Strix <-> Lena are always connected (memory.ts CONNECTED); custom personas only through links.
CREATE TABLE IF NOT EXISTS persona_links (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  persona_id TEXT NOT NULL,
  other_id TEXT NOT NULL,
  other_name TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, persona_id, other_id)
);
`;

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(SCHEMA);

/* ---------- additive migrations for databases created by older versions ---------- */
function addColumnIfMissing(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumnIfMissing('users', 'email_key', 'TEXT'); // canonical email (gmail dots / +tags removed): one person, one account
addColumnIfMissing('users', 'device_id', 'TEXT'); // random per-browser id (cookie) set when an invite is redeemed
addColumnIfMissing('usage', 'vc_sec', 'INTEGER NOT NULL DEFAULT 0'); // Voice Changer seconds (v2 lite)
addColumnIfMissing('usage', 'stt_sec', 'INTEGER NOT NULL DEFAULT 0'); // speech-to-text (Scribe Realtime) seconds
addColumnIfMissing('usage', 'search_req', 'INTEGER NOT NULL DEFAULT 0'); // chat web_search tool executions
addColumnIfMissing('usage', 'decide_req', 'INTEGER NOT NULL DEFAULT 0'); // /api/chat/decide calls
addColumnIfMissing('usage', 'memory_req', 'INTEGER NOT NULL DEFAULT 0'); // /api/memory/commit summaries (LLM calls)
addColumnIfMissing('usage', 'call_req', 'INTEGER NOT NULL DEFAULT 0'); // duo: persona calls placed (POST /api/duo/ring)
addColumnIfMissing('shared_events', 'kind', "TEXT NOT NULL DEFAULT 'solo'"); // solo | duo (witnessed on a shared call) | missed (call not answered)
addColumnIfMissing('tts_history', 'kind', "TEXT NOT NULL DEFAULT 'tts'"); // 'tts' | 'dialogue' (multi-speaker)
addColumnIfMissing('tts_history', 'meta_json', 'TEXT'); // dialogue: {cast:[{name,voiceId}], lines, pauseMs, durationSec}

/** Run fn inside a transaction (synchronous; node:sqlite is sync). */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const one = <T>(sql: string, ...params: any[]) => db.prepare(sql).get(...params) as T | undefined;
export const all = <T>(sql: string, ...params: any[]) => db.prepare(sql).all(...params) as T[];
export const run = (sql: string, ...params: any[]) => db.prepare(sql).run(...params);

export const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
