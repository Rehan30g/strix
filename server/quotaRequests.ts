import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { all, db, iso, one, run } from './db.js';
import { notifyUser } from './push.js';

/* Quota appeals as a chat: a tester whose daily quota ran out writes to the admin (one thread per person), the admin
   answers from the panel (and raises that user's quota override there). A closed thread can be reopened by a new message. */
db.exec(`CREATE TABLE IF NOT EXISTS quota_threads (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '',
  open INTEGER NOT NULL DEFAULT 1,
  user_seen INTEGER NOT NULL DEFAULT 0,        -- id of the last message the user has read
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS quota_msgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_admin INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quota_msgs_user ON quota_msgs(user_id, id);
DROP TABLE IF EXISTS quota_requests;`);

if (!(db.prepare('PRAGMA table_info(quota_msgs)').all() as { name: string }[]).some((c) => c.name === 'image')) db.exec('ALTER TABLE quota_msgs ADD COLUMN image INTEGER NOT NULL DEFAULT 0');
const IMG_DIR = path.join(path.dirname(config.dbFile), 'appeal');
const IMG_MAX = 1_500_000;   // bytes after decoding (the client shrinks photos to about 1280 px)
const imgPath = (id: number) => path.join(IMG_DIR, id + '.jpg');
const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
function saveImage(msgId: number, b64: string): boolean {
  const buf = Buffer.from(b64, 'base64');
  if (!isJpeg(buf) || buf.length > IMG_MAX) return false;
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.writeFileSync(imgPath(msgId), buf);
  run('UPDATE quota_msgs SET image = 1 WHERE id = ?', msgId);
  return true;
}

const MIN_FIRST = 15, DAY_MAX = 6;
type Msg = { id: number; from_admin: number; text: string; image: number; created_at: number };
const msgsOf = (uid: number) => all<Msg>('SELECT id, from_admin, text, image, created_at FROM quota_msgs WHERE user_id = ? ORDER BY id', uid)
  .map((m) => ({ id: m.id, fromAdmin: !!m.from_admin, text: m.text, image: !!m.image, at: iso(m.created_at) }));
const idOf = (p: unknown) => Number((p as { id: string }).id) || 0;

export async function quotaRequestRoutes(app: FastifyInstance) {
  const txt = z.object({ kind: z.string().trim().max(20).optional(), text: z.string().trim().max(400).default(''), image: z.string().max(2_100_000).optional() })
    .refine((v) => v.text.length > 0 || !!v.image);
  const bigBody = { bodyLimit: 2_400_000 };

  app.get('/api/quota/thread', { config: {} }, async (req) => {
    const uid = req.user!.id;
    const t = one<{ open: number; user_seen: number }>('SELECT open, user_seen FROM quota_threads WHERE user_id = ?', uid);
    if (!t) return { exists: false, open: false, messages: [], unread: 0 };
    const messages = msgsOf(uid);
    return { exists: true, open: !!t.open, messages, unread: messages.filter((m) => m.fromAdmin && m.id > t.user_seen).length };
  });
  app.post('/api/quota/thread/seen', { config: {} }, async (req) => {
    const uid = req.user!.id;
    run('UPDATE quota_threads SET user_seen = COALESCE((SELECT MAX(id) FROM quota_msgs WHERE user_id = ?), 0) WHERE user_id = ?', uid, uid);
    return { ok: true };
  });
  app.post('/api/quota/message', { ...bigBody, config: { rateLimit: { max: 12, timeWindow: '1 hour' } } }, async (req, reply) => {
    const p = txt.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const uid = req.user!.id;
    const t = one<{ open: number }>('SELECT open FROM quota_threads WHERE user_id = ?', uid);
    if ((!t || !t.open) && p.data.text.length < MIN_FIRST) return reply.code(400).send({ error: 'too_short' });
    const today = one<{ n: number }>('SELECT COUNT(*) AS n FROM quota_msgs WHERE user_id = ? AND from_admin = 0 AND created_at > ?', uid, Date.now() - 864e5)!.n;
    if (today >= DAY_MAX) return reply.code(429).send({ error: 'too_many' });
    const now = Date.now();
    run(`INSERT INTO quota_threads (user_id, kind, open, user_seen, updated_at) VALUES (?, ?, 1, 0, ?)
         ON CONFLICT(user_id) DO UPDATE SET open = 1, kind = CASE WHEN excluded.kind != '' THEN excluded.kind ELSE kind END, updated_at = excluded.updated_at`, uid, p.data.kind ?? '', now);
    const id = Number(run('INSERT INTO quota_msgs (user_id, from_admin, text, created_at) VALUES (?, 0, ?, ?)', uid, p.data.text, now).lastInsertRowid);
    if (p.data.image && !saveImage(id, p.data.image)) { run('DELETE FROM quota_msgs WHERE id = ?', id); return reply.code(400).send({ error: 'bad_image' }); }
    run('UPDATE quota_threads SET user_seen = (SELECT MAX(id) FROM quota_msgs WHERE user_id = ?) WHERE user_id = ?', uid, uid);
    return { ok: true };
  });

  // a photo in a thread: only the person the thread belongs to, or an admin
  app.get('/api/quota/image/:id', { config: {} }, async (req, reply) => {
    const id = idOf(req.params);
    const m = one<{ user_id: number; image: number }>('SELECT user_id, image FROM quota_msgs WHERE id = ?', id);
    if (!m || !m.image || (m.user_id !== req.user!.id && !req.user!.is_admin)) return reply.code(404).send({ error: 'not_found' });
    const f = imgPath(id);
    if (!fs.existsSync(f)) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', 'private, max-age=86400').header('X-Content-Type-Options', 'nosniff').send(fs.readFileSync(f));
  });

  const admin = { config: { access: 'admin' as const } };
  app.get('/api/admin/threads', admin, async () => ({
    threads: all<{ user_id: number; email: string; name: string | null; picture: string | null; kind: string; open: number; updated_at: number; last_admin: number; last_text: string; last_image: number; last_at: number | null }>(
      `SELECT t.user_id, u.email, u.name, u.picture, t.kind, t.open, t.updated_at,
              (SELECT from_admin FROM quota_msgs m WHERE m.user_id = t.user_id ORDER BY id DESC LIMIT 1) AS last_admin,
              (SELECT text FROM quota_msgs m WHERE m.user_id = t.user_id ORDER BY id DESC LIMIT 1) AS last_text,
              (SELECT image FROM quota_msgs m WHERE m.user_id = t.user_id ORDER BY id DESC LIMIT 1) AS last_image,
              (SELECT created_at FROM quota_msgs m WHERE m.user_id = t.user_id ORDER BY id DESC LIMIT 1) AS last_at
       FROM quota_threads t JOIN users u ON u.id = t.user_id ORDER BY t.open DESC, t.updated_at DESC`)
      .map((t) => ({ userId: t.user_id, email: t.email, name: t.name || '', picture: t.picture || null, kind: t.kind, open: !!t.open, awaiting: !!t.open && !t.last_admin,
        last: t.last_text, lastFromAdmin: !!t.last_admin, lastImage: !!t.last_image, lastAt: iso(t.last_at ?? t.updated_at), updatedAt: iso(t.updated_at) })),
  }));
  app.get('/api/admin/threads/:id', admin, async (req) => ({ messages: msgsOf(idOf(req.params)) }));
  app.post('/api/admin/threads/:id/reply', { ...bigBody, ...admin }, async (req, reply) => {
    const p = z.object({ text: z.string().trim().max(400).optional(), image: z.string().max(2_100_000).optional(), close: z.boolean().optional() }).safeParse(req.body ?? {});
    const uid = idOf(req.params);
    if (!p.success || !uid || !one('SELECT 1 FROM quota_threads WHERE user_id = ?', uid)) return reply.code(400).send({ error: 'validation' });
    const now = Date.now();
    if (p.data.text || p.data.image) {
      const id = Number(run('INSERT INTO quota_msgs (user_id, from_admin, text, created_at) VALUES (?, 1, ?, ?)', uid, p.data.text ?? '', now).lastInsertRowid);
      if (p.data.image && !saveImage(id, p.data.image)) { run('DELETE FROM quota_msgs WHERE id = ?', id); return reply.code(400).send({ error: 'bad_image' }); }
    }
    run('UPDATE quota_threads SET open = ?, updated_at = ? WHERE user_id = ?', p.data.close ? 0 : 1, now, uid);
    if (p.data.text || p.data.image) notifyUser(uid, { title: 'Strix', body: (p.data.text || '').slice(0, 90) || 'Photo', url: '/#/messages', tag: 'reply' });
    return { ok: true };
  });
}
