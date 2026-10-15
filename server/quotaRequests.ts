import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, db, iso, one, run } from './db.js';

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

const MIN_FIRST = 15, DAY_MAX = 6;
type Msg = { id: number; from_admin: number; text: string; created_at: number };
const msgsOf = (uid: number) => all<Msg>('SELECT id, from_admin, text, created_at FROM quota_msgs WHERE user_id = ? ORDER BY id', uid)
  .map((m) => ({ id: m.id, fromAdmin: !!m.from_admin, text: m.text, at: iso(m.created_at) }));
const idOf = (p: unknown) => Number((p as { id: string }).id) || 0;

export async function quotaRequestRoutes(app: FastifyInstance) {
  const txt = z.object({ kind: z.string().trim().max(20).optional(), text: z.string().trim().min(1).max(400) });

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
  app.post('/api/quota/message', { config: { rateLimit: { max: 12, timeWindow: '1 hour' } } }, async (req, reply) => {
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
    run('INSERT INTO quota_msgs (user_id, from_admin, text, created_at) VALUES (?, 0, ?, ?)', uid, p.data.text, now);
    run('UPDATE quota_threads SET user_seen = (SELECT MAX(id) FROM quota_msgs WHERE user_id = ?) WHERE user_id = ?', uid, uid);
    return { ok: true };
  });

  const admin = { config: { access: 'admin' as const } };
  app.get('/api/admin/threads', admin, async () => ({
    threads: all<{ user_id: number; email: string; kind: string; open: number; updated_at: number; last_admin: number; last_text: string }>(
      `SELECT t.user_id, u.email, t.kind, t.open, t.updated_at,
              (SELECT from_admin FROM quota_msgs m WHERE m.user_id = t.user_id ORDER BY id DESC LIMIT 1) AS last_admin,
              (SELECT text FROM quota_msgs m WHERE m.user_id = t.user_id ORDER BY id DESC LIMIT 1) AS last_text
       FROM quota_threads t JOIN users u ON u.id = t.user_id ORDER BY t.open DESC, t.updated_at DESC`)
      .map((t) => ({ userId: t.user_id, email: t.email, kind: t.kind, open: !!t.open, awaiting: !!t.open && !t.last_admin, last: t.last_text, updatedAt: iso(t.updated_at) })),
  }));
  app.get('/api/admin/threads/:id', admin, async (req) => ({ messages: msgsOf(idOf(req.params)) }));
  app.post('/api/admin/threads/:id/reply', admin, async (req, reply) => {
    const p = z.object({ text: z.string().trim().max(400).optional(), close: z.boolean().optional() }).safeParse(req.body ?? {});
    const uid = idOf(req.params);
    if (!p.success || !uid || !one('SELECT 1 FROM quota_threads WHERE user_id = ?', uid)) return reply.code(400).send({ error: 'validation' });
    const now = Date.now();
    if (p.data.text) run('INSERT INTO quota_msgs (user_id, from_admin, text, created_at) VALUES (?, 1, ?, ?)', uid, p.data.text, now);
    run('UPDATE quota_threads SET open = ?, updated_at = ? WHERE user_id = ?', p.data.close ? 0 : 1, now, uid);
    return { ok: true };
  });
}
