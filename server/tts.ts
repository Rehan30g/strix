import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { all, iso, run } from './db.js';
import { acquireTts, canUseVoice, releaseTts, ttsRequest } from './eleven.js';
import { chargeTts } from './quota.js';

const FORMATS = ['mp3_44100_128', 'mp3_44100_64', 'mp3_44100_96', 'mp3_44100_32', 'mp3_22050_32', 'mp3_24000_48', 'mp3_44100_192'] as const;

const num = (lo: number, hi: number) => z.number().min(lo).max(hi).optional().nullable();
export const tuneSchema = z.object({
  stability: num(0, 1),
  similarity: num(0, 1),
  style: num(0, 1),
  speakerBoost: z.boolean().optional().nullable(),
  boost: z.boolean().optional().nullable(), // legacy v1 name
  speed: num(0.7, 1.2),
}).partial();

const ttsBody = z.object({
  text: z.string().trim().min(1),
  voiceId: z.string().regex(/^[\w-]{10,40}$/, 'voiceId tidak valid'),
  // model is NOT accepted: TTS is locked to config.ttsModel (eleven_v4_turbo); unknown keys are stripped.
  tune: tuneSchema.optional().nullable(),
  settings: tuneSchema.optional().nullable(), // legacy v1 name for tune
  format: z.enum(FORMATS).optional().nullable(),
  saveHistory: z.boolean().optional(),
});
type TtsBody = z.infer<typeof ttsBody>;

export function voiceSettings(t: TtsBody['tune']) {
  if (!t) return {};
  const out: Record<string, number | boolean> = {};
  if (t.stability != null) out.stability = t.stability;
  if (t.similarity != null) out.similarity_boost = t.similarity;
  if (t.style != null) out.style = t.style;
  if (t.speed != null) out.speed = t.speed;
  const boost = t.speakerBoost ?? t.boost;
  if (boost != null) out.use_speaker_boost = boost;
  return out;
}

async function upstreamFail(reply: FastifyReply, r: Response) {
  const text = (await r.text()).slice(0, 1000);
  let message = text;
  try { const j = JSON.parse(text); message = j?.detail?.message ?? j?.detail ?? text; } catch { /* plain */ }
  const status = [400, 404, 422].includes(r.status) ? 400 : 502;
  return reply.code(status).send({ error: 'upstream', upstreamStatus: r.status, message: `ElevenLabs: ${typeof message === 'string' ? message : JSON.stringify(message)}` });
}

async function handleTts(req: FastifyRequest, reply: FastifyReply, mode: 'stream' | 'download') {
  if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
  const p = ttsBody.safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
  const b = p.data;
  const max = mode === 'stream' ? config.limits.ttsMaxChars : config.limits.ttsGenerateMaxChars;
  if (b.text.length > max) return reply.code(400).send({ error: 'text_too_long', max });
  const user = req.user!;
  if (!(await canUseVoice(user.id, b.voiceId))) return reply.code(403).send({ error: 'voice_forbidden' });
  const model = config.ttsModel;
  const format = b.format || 'mp3_44100_128';
  const refund = chargeTts(user, b.text.length);

  const ac = new AbortController();
  reply.raw.on('close', () => ac.abort());
  req.raw.on('aborted', () => ac.abort());
  let held = false;
  const release = () => { if (held) { held = false; releaseTts(); } };
  try {
    await acquireTts(ac.signal);
    held = true;
    const r = await ttsRequest({ text: b.text, voiceId: b.voiceId, model, format, voiceSettings: voiceSettings(b.tune ?? b.settings), stream: mode === 'stream' }, ac.signal);
    if (!r.ok || !r.body) { release(); refund(); return upstreamFail(reply, r); }

    const record = () => run('INSERT INTO tts_history (user_id, text, voice_id, model, chars, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      user.id, b.text, b.voiceId, model, b.text.length, Date.now());

    if (mode === 'download') {
      const buf = Buffer.from(await r.arrayBuffer());
      release();
      record();
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return reply.code(200).headers({
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(buf.length),
        'Content-Disposition': `attachment; filename="tts-${stamp}.mp3"`,
        'Cache-Control': 'no-store',
      }).send(buf);
    }

    if (b.saveHistory) record();
    // Stream chunks to the client as ElevenLabs generates them; hold the semaphore until done/aborted.
    const body = Readable.fromWeb(r.body as any);
    body.once('close', release);
    body.once('error', release);
    reply.code(200).headers({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache, no-store' });
    return reply.send(body);
  } catch (e) {
    release();
    if (ac.signal.aborted) { refund(); return reply; }
    refund();
    return reply.code(502).send({ error: 'upstream', message: `Gagal menghubungi ElevenLabs: ${(e as Error).message}` });
  }
}

export async function ttsRoutes(app: FastifyInstance) {
  app.post('/api/tts', async (req, reply) => handleTts(req, reply, 'stream'));
  app.post('/api/tts/generate', async (req, reply) => handleTts(req, reply, 'download'));

  app.get('/api/tts/history', async (req) => {
    const rows = all<{ id: number; text: string; voice_id: string; model: string; chars: number; created_at: number; kind: string | null; meta_json: string | null }>(
      'SELECT id, text, voice_id, model, chars, created_at, kind, meta_json FROM tts_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', req.user!.id);
    return {
      items: rows.map((r) => {
        const base = { id: r.id, text: r.text, voiceId: r.voice_id, model: r.model, chars: r.chars, createdAt: iso(r.created_at) };
        if (r.kind !== 'dialogue') return { ...base, kind: 'tts' as const };
        let meta: { cast?: { name: string; voiceId: string }[]; lines?: number; pauseMs?: number; durationSec?: number } = {};
        try { meta = r.meta_json ? JSON.parse(r.meta_json) : {}; } catch { /* keep {} */ }
        const cast = Array.isArray(meta.cast) ? meta.cast : [];
        return { ...base, kind: 'dialogue' as const, speakers: cast.length, cast, lines: meta.lines ?? null, pauseMs: meta.pauseMs ?? null, durationSec: meta.durationSec ?? null };
      }),
    };
  });

  app.delete('/api/tts/history/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'validation' });
    const r = run('DELETE FROM tts_history WHERE id = ? AND user_id = ?', id, req.user!.id);
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
