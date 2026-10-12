/* Speech-to-text: ElevenLabs Scribe Realtime (model scribe_v2_realtime).
   The browser streams mic audio (PCM16 mono 16 kHz) straight to ElevenLabs' WebSocket with a SINGLE-USE token that
   this server mints with its API key (the key never reaches the client):
     POST /api/stt/token  -> {token, url, expiresInSec, model, maxSessionSec, sessionId, sampleRate, remainingSec}
     POST /api/stt/usage  {sessionId, seconds}  (seconds = CUMULATIVE audio seconds sent in that session; idempotent)
   Quota QUOTA_STT_SEC_PER_DAY counts seconds of mic audio. Accounting: 1 s is charged when a token is issued, then the
   client's cumulative reports are charged on top, each capped by the session limit (maxSessionSec, also enforced by the
   client which stops streaming) and by the wall-clock time since the token was issued. No refunds. */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { elevenHeaders } from './eleven.js';
import { addStt, limitsFor, QuotaError, resetAt, usageOf } from './quota.js';

const TOKEN_TTL_SEC = 15 * 60; // ElevenLabs: single-use token expires after 15 minutes (consumed on use)
const OPEN_CHARGE_SEC = 1;

interface Session { userId: number; issuedAt: number; maxSec: number; charged: number }
const sessions = new Map<string, Session>();

function sweep() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.issuedAt > (TOKEN_TTL_SEC + s.maxSec + 120) * 1000) sessions.delete(id);
}

export function sttWsUrl() {
  return `wss://${config.sttHost}/v1/speech-to-text/realtime?model_id=${config.sttModel}&audio_format=pcm_16000`;
}

const usageBody = z.object({
  sessionId: z.string().regex(/^[\w-]{8,64}$/),
  seconds: z.number().finite().min(0).max(24 * 3600),
});

export async function sttRoutes(app: FastifyInstance) {
  app.post('/api/stt/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const user = req.user!;
    const limit = limitsFor(user).sttSecPerDay;
    const remaining = limit - usageOf(user.id).stt_sec;
    if (remaining < 1) throw new QuotaError('stt', resetAt());

    let r: Response;
    try {
      r = await fetch(`https://${config.sttHost}/v1/single-use-token/realtime_scribe`, {
        method: 'POST', headers: elevenHeaders(), signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      return reply.code(502).send({ error: 'upstream', upstreamStatus: 0, message: `ElevenLabs tidak bisa dihubungi: ${(e as Error).message}` });
    }
    const text = await r.text();
    let token = '';
    try { token = String((JSON.parse(text) as { token?: unknown }).token ?? ''); } catch { /* handled below */ }
    if (!r.ok || !token) {
      req.log.warn({ status: r.status, body: text.slice(0, 300) }, 'stt token');
      return reply.code([400, 404, 422].includes(r.status) ? 400 : 502)
        .send({ error: 'upstream', upstreamStatus: r.status, message: `ElevenLabs: ${text.slice(0, 200) || r.statusText}` });
    }

    sweep();
    const sessionId = crypto.randomBytes(12).toString('base64url');
    const maxSessionSec = Math.max(1, Math.min(config.limits.sttMaxSessionSec, Math.floor(remaining)));
    sessions.set(sessionId, { userId: user.id, issuedAt: Date.now(), maxSec: maxSessionSec, charged: OPEN_CHARGE_SEC });
    addStt(user.id, OPEN_CHARGE_SEC);
    reply.header('Cache-Control', 'no-store');
    return {
      token,
      url: sttWsUrl(), // append &token=...&commit_strategy=...&language_code=...
      expiresInSec: TOKEN_TTL_SEC - 60,
      model: config.sttModel,
      sampleRate: 16000,
      maxSessionSec,
      remainingSec: Math.max(0, Math.floor(remaining - OPEN_CHARGE_SEC)),
      sessionId,
    };
  });

  app.post('/api/stt/usage', async (req, reply) => {
    const p = usageBody.safeParse(typeof req.body === 'string' ? safeJson(req.body) : req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const user = req.user!;
    const s = sessions.get(p.data.sessionId);
    if (!s || s.userId !== user.id) return reply.code(404).send({ error: 'not_found' });
    const elapsed = (Date.now() - s.issuedAt) / 1000 + 2;
    const total = Math.min(p.data.seconds, s.maxSec, elapsed);
    const add = Math.ceil(total) - s.charged;
    if (add > 0) { s.charged += add; addStt(user.id, add); }
    const l = limitsFor(user).sttSecPerDay;
    const used = usageOf(user.id).stt_sec;
    return { ok: true, charged: s.charged, used, limit: l, remainingSec: Math.max(0, l - used) };
  });
}

function safeJson(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }
