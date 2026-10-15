import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, db, iso, run } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS quota_requests (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);

/** A tester whose daily quota ran out can ask the admin for more (one open request per person). The admin answers by
    raising that user's override in the Users tab and closing the request. */
export async function quotaRequestRoutes(app: FastifyInstance) {
  const body = z.object({ kind: z.string().trim().max(20).optional(), note: z.string().trim().max(300).optional() });
  app.post('/api/quota/request', { config: { access: 'auth', rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req, reply) => {
    const p = body.safeParse(req.body ?? {});
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    run(`INSERT INTO quota_requests (user_id, kind, note, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, note = excluded.note, created_at = excluded.created_at`,
      req.user!.id, p.data.kind ?? '', p.data.note ?? '', Date.now());
    return { ok: true };
  });
  app.get('/api/admin/requests', { config: { access: 'admin' } }, async () => ({
    requests: all<{ user_id: number; email: string; kind: string; note: string; created_at: number }>(
      'SELECT r.user_id, u.email, r.kind, r.note, r.created_at FROM quota_requests r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC')
      .map((r) => ({ userId: r.user_id, email: r.email, kind: r.kind, note: r.note, createdAt: iso(r.created_at) })),
  }));
  app.delete('/api/admin/requests/:id', { config: { access: 'admin' } }, async (req) => {
    run('DELETE FROM quota_requests WHERE user_id = ?', Number((req.params as { id: string }).id) || 0);
    return { ok: true };
  });
}
