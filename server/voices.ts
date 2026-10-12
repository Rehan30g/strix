import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from './config.js';
import { one, run, type VoiceRow } from './db.js';
import { z } from 'zod';
import {
  canPreviewVoice, deleteElevenVoice, elevenHeaders, invalidateVoiceCache, isLibraryVoice, isSharedVoice,
  previewAudio, UpstreamError, voicesFor,
} from './eleven.js';
import {
  ensureOnAccount, findLibraryVoice, libraryList, libraryRandom, mapRowBySource, NotAddableError, SlotsFullError, SORTS, syncRefs,
  type SortKey,
} from './library.js';
import { limitsFor, QuotaError } from './quota.js';

const MAX_FILES = 3;
const VOICE_RE = /^[\w-]{10,40}$/;

const qInt = (max: number) => z.preprocess((v) => (v === '' || v == null ? undefined : Number(v)), z.number().int().min(1).max(max).optional());
const word = (max: number) => z.string().trim().max(max).regex(/^[\p{L}\p{N} _'-]*$/u, 'karakter tidak valid').optional();
const libraryQuery = z.object({
  q: z.string().trim().max(100).optional(),
  gender: word(20),
  age: word(20),
  accent: word(40),
  language: z.string().trim().regex(/^([a-z]{2,3}(-[A-Za-z]{2,4})?)?$/, 'kode bahasa tidak valid').optional(),
  category: word(30),
  useCase: word(40),
  sort: z.enum(Object.keys(SORTS) as [SortKey, ...SortKey[]]).optional(),
  page: qInt(500),
  pageSize: qInt(100),
  featured: z.preprocess((v) => v === '1' || v === 'true', z.boolean()).optional(),
});
const OWNER_RE = /^[A-Za-z0-9_-]{8,100}$/;
const upstreamFail = (reply: FastifyReply, e: unknown) => {
  const status = e instanceof UpstreamError ? e.status : 0;
  return reply.code([400, 404, 422].includes(status) ? 400 : 502).send({ error: 'upstream', upstreamStatus: status || undefined, message: (e as Error).message });
};
const SLOTS_FULL_MSG = 'Slot suara server penuh. Pilih suara yang sudah ada di koleksi orang lain, atau minta admin membersihkan slot yang tidak terpakai.';

// audio/* ; MediaRecorder may label recordings video/webm; some browsers send octet-stream for audio files
const isAudio = (mime: string, filename: string) =>
  /^audio\//.test(mime) || mime === 'video/webm'
  || (mime === 'application/octet-stream' && /\.(mp3|wav|m4a|ogg|oga|webm|flac|aac|opus)$/i.test(filename));

export async function voiceRoutes(app: FastifyInstance) {
  app.get('/api/voices', async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    try {
      return { voices: await voicesFor(req.user!.id) };
    } catch (e) {
      const status = e instanceof UpstreamError ? e.status : 0;
      return reply.code(502).send({ error: 'upstream', upstreamStatus: status || undefined, message: (e as Error).message });
    }
  });

  // Browse the PUBLIC ElevenLabs Voice Library (server-side search/filter/paging, short cache)
  app.get('/api/voices/library', async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const p = libraryQuery.safeParse(req.query ?? {});
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    try {
      return await libraryList(req.user!.id, p.data);
    } catch (e) { return upstreamFail(reply, e); }
  });

  // Varied random sample (tour): ?n=24&diverse=1
  app.get('/api/voices/library/random', async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const p = z.object({ n: qInt(48), diverse: z.enum(['0', '1', 'true', 'false']).optional() }).safeParse(req.query ?? {});
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    try {
      return await libraryRandom(req.user!.id, p.data.n ?? 24, p.data.diverse !== '0' && p.data.diverse !== 'false');
    } catch (e) { return upstreamFail(reply, e); }
  });

  // Add a voice to the caller's collection (idempotent). With ownerId = public Voice Library voice (added to the
  // ElevenLabs account once, shared slot); without = a voice already on the account (premade / earlier library).
  app.post('/api/voices/collection', async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const p = z.object({
      voiceId: z.string().regex(VOICE_RE, 'voiceId tidak valid'),
      ownerId: z.string().regex(OWNER_RE, 'ownerId tidak valid').optional(),
    }).safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const { voiceId, ownerId } = p.data;
    const userId = req.user!.id;
    const has = (id: string) => !!one('SELECT 1 FROM user_voices WHERE user_id = ? AND voice_id = ?', userId, id);
    const mapped = mapRowBySource(voiceId);
    const known = mapped?.account_voice_id ?? voiceId;
    if (has(known)) return { ok: true, voiceId: known, sourceId: voiceId, inCollection: true, added: false };
    if (isSharedVoice(voiceId) || one('SELECT 1 FROM voices WHERE eleven_voice_id = ?', voiceId)) return reply.code(404).send({ error: 'not_in_library' });
    const max = config.quota.maxCollection;
    const count = () => one<{ n: number }>('SELECT COUNT(*) AS n FROM user_voices WHERE user_id = ?', userId)?.n ?? 0;
    if (count() >= max) return reply.code(409).send({ error: 'collection_full', max });

    let accountVoiceId = voiceId;
    let added = false;
    if (ownerId || mapped) {
      try {
        const r = await ensureOnAccount(voiceId, ownerId ?? mapped!.public_owner_id);
        accountVoiceId = r.accountVoiceId; added = r.added;
      } catch (e) {
        if (e instanceof SlotsFullError) return reply.code(409).send({ error: 'slots_full', message: SLOTS_FULL_MSG, used: e.used, cap: e.cap });
        if (e instanceof NotAddableError) {
          return e.reason === 'not_in_library' ? reply.code(404).send({ error: 'not_in_library', message: e.message })
            : reply.code(400).send({ error: 'not_addable', reason: e.reason, message: e.message });
        }
        return upstreamFail(reply, e);
      }
    } else {
      try {
        if (!(await isLibraryVoice(voiceId))) return reply.code(404).send({ error: 'not_in_library' });
      } catch (e) { return upstreamFail(reply, e); }
    }
    if (count() >= max) return reply.code(409).send({ error: 'collection_full', max });
    run('INSERT OR IGNORE INTO user_voices (user_id, voice_id, added_at) VALUES (?, ?, ?)', userId, accountVoiceId, Date.now());
    syncRefs(accountVoiceId);
    return reply.code(201).send({ ok: true, voiceId: accountVoiceId, sourceId: voiceId, inCollection: true, added });
  });

  // Remove a library voice from the collection (clones: DELETE /voices/:id; shared voices can't be removed).
  app.delete('/api/voices/collection/:voiceId', async (req, reply) => {
    const { voiceId } = req.params as { voiceId: string };
    if (isSharedVoice(voiceId)) return reply.code(400).send({ error: 'not_removable', reason: 'shared' });
    if (one('SELECT 1 FROM voices WHERE user_id = ? AND eleven_voice_id = ?', req.user!.id, voiceId)) {
      return reply.code(400).send({ error: 'not_removable', reason: 'clone' });
    }
    let r = run('DELETE FROM user_voices WHERE user_id = ? AND voice_id = ?', req.user!.id, voiceId);
    let acct = voiceId;
    if (!r.changes) { // a library sourceId whose account copy has another id
      const m = mapRowBySource(voiceId);
      if (m) { acct = m.account_voice_id; r = run('DELETE FROM user_voices WHERE user_id = ? AND voice_id = ?', req.user!.id, acct); }
    }
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    syncRefs(acct); // the account copy stays until an admin cleanup removes voices nobody references
    return { ok: true };
  });

  // Same-origin preview audio (ElevenLabs preview hosts have no CORS -> MediaElementAudioSource plays silence).
  app.get('/api/voices/:id/preview', async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const { id } = req.params as { id: string };
    const owner = String((req.query as { owner?: string })?.owner ?? '');
    if (!VOICE_RE.test(id)) return reply.code(400).send({ error: 'validation', message: 'voiceId tidak valid' });
    if (owner && !OWNER_RE.test(owner)) return reply.code(400).send({ error: 'validation', message: 'owner tidak valid' });
    try {
      // public Voice Library voice (?owner=): previewable by every active user without adding it
      const lib = owner ? await findLibraryVoice(id, owner) : null;
      if (!lib && !(await canPreviewVoice(req.user!.id, id))) return reply.code(403).send({ error: 'voice_forbidden' });
      const a = await previewAudio(id, lib?.preview_url ? async () => lib.preview_url ?? null : undefined);
      if (!a) return reply.code(404).send({ error: 'no_preview' });
      return reply.code(200).headers({
        'Content-Type': a.type,
        'Content-Length': String(a.data.length),
        'Cache-Control': 'private, max-age=1800',
        'X-Content-Type-Options': 'nosniff',
      }).send(a.data);
    } catch (e) {
      const status = e instanceof UpstreamError ? e.status : 0;
      return reply.code(502).send({ error: 'upstream', upstreamStatus: status || undefined, message: (e as Error).message });
    }
  });

  // Instant Voice Clone. multipart: name, description?, consent=true, files (1-3, audio/*)
  app.post('/api/voices/clone', {
    bodyLimit: (config.quota.maxCloneUploadMb * MAX_FILES + 1) * 1024 * 1024,
  }, async (req, reply) => {
    if (!config.elevenKey) return reply.code(503).send({ error: 'tts_not_configured' });
    const user = req.user!;
    const max = limitsFor(user).maxClones;
    const count = (one<{ n: number }>('SELECT COUNT(*) AS n FROM voices WHERE user_id = ?', user.id)?.n) ?? 0;
    if (count >= max) throw new QuotaError('clone', null);
    if (!req.isMultipart()) return reply.code(400).send({ error: 'validation', message: 'multipart/form-data required' });

    const fields: Record<string, string> = {};
    const files: { name: string; type: string; data: Buffer }[] = [];
    try {
      for await (const part of req.parts({ limits: { fileSize: config.quota.maxCloneUploadMb * 1024 * 1024, files: MAX_FILES, fields: 10, fieldSize: 2000 } })) {
        if (part.type === 'file') {
          const data = await part.toBuffer();
          if (!isAudio(part.mimetype, part.filename)) {
            return reply.code(400).send({ error: 'bad_file_type', file: part.filename, mimetype: part.mimetype });
          }
          if (data.length) files.push({ name: part.filename || `sample-${files.length + 1}`, type: part.mimetype, data });
        } else {
          fields[part.fieldname] = String(part.value ?? '');
        }
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'file_too_large', maxMb: config.quota.maxCloneUploadMb });
      if (code === 'FST_FILES_LIMIT') return reply.code(400).send({ error: 'too_many_files', max: MAX_FILES });
      if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') return reply.code(400).send({ error: 'validation', message: 'too many fields' });
      throw e;
    }

    const name = (fields.name ?? '').trim();
    const description = (fields.description ?? '').trim();
    if (fields.consent !== 'true') return reply.code(400).send({ error: 'consent_required' });
    if (!name || name.length > 60) return reply.code(400).send({ error: 'validation', message: 'name required (1-60 chars)' });
    if (description.length > 500) return reply.code(400).send({ error: 'validation', message: 'description max 500 chars' });
    if (!files.length) return reply.code(400).send({ error: 'files_required', min: 1, max: MAX_FILES });

    const fd = new FormData();
    fd.append('name', name);
    if (description) fd.append('description', description);
    fd.append('remove_background_noise', 'false');
    for (const f of files) fd.append('files', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
    const r = await fetch('https://api.elevenlabs.io/v1/voices/add', { method: 'POST', headers: elevenHeaders(), body: fd });
    const text = await r.text();
    if (!r.ok) {
      let message = text.slice(0, 600);
      try { const j = JSON.parse(text); message = j?.detail?.message ?? (typeof j?.detail === 'string' ? j.detail : message); } catch { /* plain */ }
      return reply.code([400, 422].includes(r.status) ? 400 : 502).send({ error: 'upstream', upstreamStatus: r.status, message: `ElevenLabs: ${message}` });
    }
    const { voice_id: voiceId } = JSON.parse(text) as { voice_id: string };
    const now = Date.now();
    const ins = run('INSERT INTO voices (user_id, eleven_voice_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)',
      user.id, voiceId, name, description || null, now);
    invalidateVoiceCache();
    return reply.code(201).send({ voice: { id: voiceId, dbId: Number(ins.lastInsertRowid), name, description: description || undefined, category: 'cloned', own: true } });
  });

  // :id = ElevenLabs voice id (the `id` returned by GET /voices)
  app.delete('/api/voices/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (isSharedVoice(id)) return reply.code(403).send({ error: 'shared_voice' });
    const v = one<VoiceRow>('SELECT * FROM voices WHERE user_id = ? AND (eleven_voice_id = ? OR CAST(id AS TEXT) = ?)', req.user!.id, id, id);
    if (!v) return reply.code(404).send({ error: 'not_found' });
    try {
      await deleteElevenVoice(v.eleven_voice_id);
    } catch (e) {
      return reply.code(502).send({ error: 'upstream', message: (e as Error).message });
    }
    run('DELETE FROM voices WHERE id = ?', v.id);
    return { ok: true };
  });
}
