import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { acquireTts, canUseVoice, elevenHeaders, releaseTts } from './eleven.js';
import { probeDuration, sniffAudio } from './audio.js';
import { chargeVc, limitsFor, QuotaError, resetAt, usageOf } from './quota.js';

const VOICE_RE = /^[\w-]{10,40}$/;
// When the container doesn't state a duration, assume at most 512 kbps -> a lower bound for the length.
const MAX_BYTES_PER_SEC = 64_000;

// audio/* ; MediaRecorder may label recordings video/webm or video/mp4; some browsers send octet-stream
const okMime = (mime: string) => /^audio\//.test(mime) || /^video\/(webm|mp4|ogg)$/.test(mime) || mime === 'application/octet-stream' || mime === '';

const unit = (v: string | undefined) => {
  if (v == null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : NaN;
};
const bool = (v: string | undefined) => v === 'true' || v === '1' || v === 'on';

export async function vcRoutes(app: FastifyInstance) {
  // Voice Changer (ElevenLabs speech-to-speech). multipart: file, voiceId, removeBackgroundNoise?,
  // stability?, similarity?, style?, durationSec? (client hint)  -> audio/mpeg  (?download=1 => attachment)
  app.post('/api/vc', {
    bodyLimit: (config.quota.maxVcUploadMb + 1) * 1024 * 1024,
  }, async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const user = req.user!;
    const limit = limitsFor(user).vcSecPerDay;
    if (usageOf(user.id).vc_sec >= limit) throw new QuotaError('vc', resetAt()); // before reading the upload
    if (!req.isMultipart()) return reply.code(400).send({ error: 'validation', message: 'multipart/form-data required' });

    const maxMb = config.quota.maxVcUploadMb;
    const fields: Record<string, string> = {};
    let file: { name: string; type: string; data: Buffer } | null = null;
    try {
      for await (const part of req.parts({ limits: { fileSize: maxMb * 1024 * 1024, files: 1, fields: 12, fieldSize: 200 } })) {
        if (part.type === 'file') {
          const data = await part.toBuffer();
          file = { name: part.filename || 'audio', type: part.mimetype || '', data };
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'file_too_large', maxMb });
      if (code === 'FST_FILES_LIMIT') return reply.code(400).send({ error: 'too_many_files', max: 1 });
      if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') return reply.code(400).send({ error: 'validation', message: 'too many fields' });
      throw e;
    }

    // ---- validate fields ----
    if (!file || !file.data.length) return reply.code(400).send({ error: 'file_required' });
    const voiceId = (fields.voiceId ?? '').trim();
    if (!VOICE_RE.test(voiceId)) return reply.code(400).send({ error: 'validation', message: 'voiceId tidak valid' });
    // model is locked server-side (eleven_v4_turbo has no speech-to-speech): a client model field is ignored.
    const model = config.stsModel;
    const tune = { stability: unit(fields.stability), similarity_boost: unit(fields.similarity), style: unit(fields.style) };
    if (Object.values(tune).some((v) => Number.isNaN(v))) return reply.code(400).send({ error: 'validation', message: 'stability/similarity/style harus 0..1' });
    let clientSec: number | undefined;
    if (fields.durationSec != null && fields.durationSec.trim() !== '') {
      clientSec = Number(fields.durationSec);
      if (!Number.isFinite(clientSec) || clientSec <= 0 || clientSec > 24 * 3600) return reply.code(400).send({ error: 'validation', message: 'durationSec tidak valid' });
    }

    // ---- validate audio ----
    const kind = sniffAudio(file.data);
    if (!okMime(file.type) || !kind) return reply.code(400).send({ error: 'bad_file_type', file: file.name, mimetype: file.type });
    const probed = probeDuration(file.data, kind);
    const lowerBound = file.data.length / MAX_BYTES_PER_SEC;
    const durationSec = probed ?? Math.max(lowerBound, clientSec ?? 0);
    const maxSec = config.limits.vcMaxSec;
    if (durationSec > maxSec + 1) return reply.code(400).send({ error: 'audio_too_long', maxSec, durationSec: Math.round(durationSec) });
    if (durationSec < 0.3) return reply.code(400).send({ error: 'audio_too_short', minSec: 0.3 });

    if (!(await canUseVoice(user.id, voiceId))) return reply.code(403).send({ error: 'voice_forbidden' });

    // charge the larger of server estimate and client hint (client can only over-report), min 1 s
    const chargeSec = Math.max(1, Math.ceil(Math.max(durationSec, clientSec ?? 0) - 0.05));
    const refund = chargeVc(user, chargeSec);

    const fd = new FormData();
    fd.append('audio', new Blob([new Uint8Array(file.data)], { type: file.type && file.type !== 'application/octet-stream' ? file.type : 'audio/mpeg' }), file.name);
    fd.append('model_id', model);
    fd.append('remove_background_noise', String(bool(fields.removeBackgroundNoise)));
    const vs = Object.fromEntries(Object.entries(tune).filter(([, v]) => v !== undefined));
    if (Object.keys(vs).length) fd.append('voice_settings', JSON.stringify(vs));
    const url = `https://api.elevenlabs.io/v1/speech-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`;

    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.sent) ac.abort(); });
    req.raw.on('aborted', () => ac.abort());
    let held = false;
    try {
      await acquireTts(ac.signal);
      held = true;
      let r: Response;
      for (let attempt = 0; ; attempt++) {
        r = await fetch(url, { method: 'POST', signal: ac.signal, headers: elevenHeaders({ Accept: 'audio/mpeg' }), body: fd });
        if (r.status !== 429 || attempt >= 3) break;
        await r.body?.cancel();
        await new Promise((ok) => setTimeout(ok, 700 * (attempt + 1)));
      }
      if (!r.ok) {
        refund();
        const text = (await r.text()).slice(0, 1000);
        let message: unknown = text;
        try {
          const j = JSON.parse(text);
          const d = j?.detail;
          message = d?.message ?? (Array.isArray(d) ? d.map((x: { msg?: string }) => x?.msg).filter(Boolean).join('; ') : d) ?? text;
        } catch { /* plain */ }
        return reply.code([400, 404, 422].includes(r.status) ? 400 : 502).send({
          error: 'upstream', upstreamStatus: r.status, message: `ElevenLabs: ${typeof message === 'string' ? message : JSON.stringify(message)}`,
        });
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { refund(); return reply.code(502).send({ error: 'upstream', message: 'ElevenLabs: respons audio kosong' }); }
      const download = ['1', 'true'].includes(String((req.query as Record<string, string>)?.download ?? ''));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return reply.code(200).headers({
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(buf.length),
        'Cache-Control': 'no-store',
        'X-Vc-Charged-Sec': String(chargeSec),
        ...(download && { 'Content-Disposition': `attachment; filename="voice-changer-${stamp}.mp3"` }),
      }).send(buf);
    } catch (e) {
      refund();
      if (ac.signal.aborted) return reply;
      return reply.code(502).send({ error: 'upstream', message: `Gagal menghubungi ElevenLabs: ${(e as Error).message}` });
    } finally {
      if (held) releaseTts();
    }
  });
}
