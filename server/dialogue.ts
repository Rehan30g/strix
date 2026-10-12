import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { run } from './db.js';
import { acquireTts, canUseVoice, releaseTts, ttsRequest } from './eleven.js';
import { chargeTts } from './quota.js';
import { silentMp3Frame, splitMp3, type Mp3Audio } from './audio.js';
import { tuneSchema, voiceSettings } from './tts.js';

/*
 * POST /api/tts/dialogue - multi-speaker script -> ONE mp3.
 * Every line is rendered with /v1/text-to-speech (eleven_v4_turbo, the line's own voice + tune), at most 2 lines in
 * flight (each holds a slot of the shared TTS semaphore), results kept in script order. The mp3s are joined WITHOUT
 * decoding: ID3 tags and the Xing/Info header frame of every part are dropped, the remaining MPEG frames are appended,
 * and the pause between lines is made of valid silent MP3 frames with the same header (format) as the audio.
 * Why not ElevenLabs /v1/text-to-dialogue: see CONTRACT-NOTES.md ("Multi-speaker dialogue").
 */

const FORMAT = 'mp3_44100_128';
const PARALLEL = 2;

const cleanSpeaker = (s: string) => s.replace(/[\u0000-\u001f\u007f[\]<>{}"`]/g, '').replace(/\s+/g, ' ').trim();

const lineSchema = z.object({
  speaker: z.string().max(200).transform(cleanSpeaker).pipe(z.string().min(1).max(40)),
  text: z.string().trim().min(1),
  voiceId: z.string().regex(/^[\w-]{10,40}$/, 'voiceId tidak valid'),
  tune: tuneSchema.optional().nullable(),
});
const body = z.object({
  lines: z.array(lineSchema).min(1),
  pauseMs: z.number().int().min(0).max(2000).optional().default(250),
  download: z.boolean().optional().default(false),
  // model is NOT accepted (locked to eleven_v4_turbo); unknown keys are stripped
});
type Line = z.infer<typeof lineSchema>;

async function upstreamMessage(r: Response) {
  const text = (await r.text().catch(() => '')).slice(0, 1000);
  let message: unknown = text;
  try { const j = JSON.parse(text); message = j?.detail?.message ?? j?.detail ?? text; } catch { /* plain */ }
  return `ElevenLabs: ${typeof message === 'string' ? message : JSON.stringify(message)}`;
}

class LineError extends Error {
  constructor(public index: number, public upstreamStatus: number, message: string) { super(message); }
}

/** Render one line (holds one TTS semaphore slot). One retry on a 5xx / network hiccup. */
async function renderLine(line: Line, index: number, signal: AbortSignal): Promise<Mp3Audio> {
  for (let attempt = 0; ; attempt++) {
    await acquireTts(signal);
    try {
      const r = await ttsRequest({ text: line.text, voiceId: line.voiceId, model: config.ttsModel, format: FORMAT, voiceSettings: voiceSettings(line.tune), stream: false }, signal);
      if (!r.ok) {
        const msg = await upstreamMessage(r);
        if (r.status >= 500 && attempt < 1) continue;
        throw new LineError(index, r.status, msg);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      try { return splitMp3(buf); } catch (e) { throw new LineError(index, 0, `ElevenLabs: audio baris ${index + 1} tidak bisa dibaca (${(e as Error).message})`); }
    } catch (e) {
      if (e instanceof LineError || signal.aborted || attempt >= 1) throw e;
      // network error: retry once
    } finally {
      releaseTts();
    }
  }
}

/** Render all lines, PARALLEL at a time, results in script order. Rejects on the first failure (and aborts the rest). */
async function renderAll(lines: Line[], signal: AbortSignal): Promise<Mp3Audio[]> {
  const ac = new AbortController();
  const sig = AbortSignal.any([signal, ac.signal]);
  const out: Mp3Audio[] = new Array(lines.length);
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const i = next++;
      out[i] = await renderLine(lines[i], i, sig);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, lines.length) }, worker));
  } catch (e) {
    ac.abort();
    throw e;
  }
  return out;
}

/** Join rendered lines with `pauseMs` of silence between them. Returns the mp3 + per-line start/duration (seconds). */
export function joinMp3(parts: Mp3Audio[], pauseMs: number) {
  const ref = parts[0];
  const frameSec = ref.spf / ref.sampleRate;
  const silent = silentMp3Frame(ref.header);
  const gapFrames = Math.round(pauseMs / 1000 / frameSec);
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  const durations: number[] = [];
  let frames = 0;
  parts.forEach((p, i) => {
    if (p.sampleRate !== ref.sampleRate || p.spf !== ref.spf) throw new Error('mixed mp3 formats');
    if (i > 0) for (let k = 0; k < gapFrames; k++) { chunks.push(silent); frames++; }
    offsets.push(frames * frameSec);
    durations.push(p.frames.length * frameSec);
    chunks.push(...p.frames);
    frames += p.frames.length;
  });
  return { audio: Buffer.concat(chunks), offsets, durations, duration: frames * frameSec };
}

const fail = (reply: FastifyReply, status: number, payload: Record<string, unknown>) => reply.code(status).send(payload);

export async function dialogueRoutes(app: FastifyInstance) {
  app.post('/api/tts/dialogue', async (req, reply) => {
    if (!config.elevenKey) return fail(reply, 503, { error: 'tts_not_configured' });
    const raw = req.body as { lines?: unknown } | null;
    const maxLines = config.limits.dialogueMaxLines;
    if (Array.isArray(raw?.lines) && raw.lines.length > maxLines) return fail(reply, 400, { error: 'too_many_lines', max: maxLines });
    const p = body.safeParse(raw ?? {});
    if (!p.success) return fail(reply, 400, { error: 'validation', issues: p.error.issues });
    const { lines, pauseMs, download } = p.data;
    const lineMax = config.limits.ttsMaxChars;
    const longLine = lines.findIndex((l) => l.text.length > lineMax);
    if (longLine >= 0) return fail(reply, 400, { error: 'text_too_long', max: lineMax, line: longLine });
    const chars = lines.reduce((n, l) => n + l.text.length, 0);
    if (chars > config.limits.dialogueMaxChars) return fail(reply, 400, { error: 'text_too_long', max: config.limits.dialogueMaxChars, total: chars });

    const user = req.user!;
    for (const id of new Set(lines.map((l) => l.voiceId))) {
      if (!(await canUseVoice(user.id, id))) return fail(reply, 403, { error: 'voice_forbidden', voiceId: id });
    }
    const refund = chargeTts(user, chars); // throws QuotaError -> 429 {error:'quota', kind:'tts'}

    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.sent) ac.abort(); });
    req.raw.on('aborted', () => ac.abort());
    let joined: ReturnType<typeof joinMp3>;
    try {
      joined = joinMp3(await renderAll(lines, ac.signal), pauseMs);
    } catch (e) {
      refund(); // the client gets no audio at all -> every character is refunded, also when only some lines failed
      if (ac.signal.aborted) return reply;
      if (e instanceof LineError) {
        const status = [400, 404, 422].includes(e.upstreamStatus) ? 400 : 502;
        return fail(reply, status, { error: 'upstream', upstreamStatus: e.upstreamStatus, line: e.index, message: e.message });
      }
      return fail(reply, 502, { error: 'upstream', message: `Gagal membuat dialog: ${(e as Error).message}` });
    }

    const cast: { name: string; voiceId: string }[] = [];
    for (const l of lines) if (!cast.some((c) => c.name.toLowerCase() === l.speaker.toLowerCase())) cast.push({ name: l.speaker, voiceId: l.voiceId });
    const script = lines.map((l) => `${l.speaker}: ${l.text.replace(/\s*\n\s*/g, ' ')}`).join('\n');
    run('INSERT INTO tts_history (user_id, text, voice_id, model, chars, created_at, kind, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      user.id, script, lines[0].voiceId, config.ttsModel, chars, Date.now(), 'dialogue',
      JSON.stringify({ cast, lines: lines.length, pauseMs, durationSec: +joined.duration.toFixed(3) }));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const fmt = (a: number[]) => a.map((x) => x.toFixed(3)).join(',');
    return reply.code(200).headers({
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(joined.audio.length),
      'Cache-Control': 'no-store',
      'X-Line-Offsets': fmt(joined.offsets),
      'X-Line-Durations': fmt(joined.durations),
      'X-Audio-Duration': joined.duration.toFixed(3),
      'X-Tts-Charged-Chars': String(chars),
      ...(download && { 'Content-Disposition': `attachment; filename="dialog-${stamp}.mp3"` }),
    }).send(joined.audio);
  });
}
