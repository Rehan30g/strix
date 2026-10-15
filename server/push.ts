import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { z } from 'zod';
import { config } from './config.js';
import { all, db, one, run } from './db.js';

/* Web Push: a tester can opt in (from the Messages page) to get a notification when the host replies to a quota
   request. The VAPID key pair is generated once and kept in the database, so no environment change is needed. */
db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
CREATE TABLE IF NOT EXISTS push_keys (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_key TEXT NOT NULL);`);

let keys = one<{ public_key: string; private_key: string }>('SELECT public_key, private_key FROM push_keys WHERE id = 1');
if (!keys) {
  const k = webpush.generateVAPIDKeys();
  run('INSERT INTO push_keys (id, public_key, private_key) VALUES (1, ?, ?)', k.publicKey, k.privateKey);
  keys = { public_key: k.publicKey, private_key: k.privateKey };
}
webpush.setVapidDetails(config.publicUrl.startsWith('https://') ? config.publicUrl : 'mailto:admin@localhost.invalid', keys.public_key, keys.private_key);

/** Fire-and-forget: never lets a push failure break the request that triggered it. */
export function notifyUser(userId: number, payload: { title: string; body: string; url: string; tag?: string }): void {
  const subs = all<{ endpoint: string; p256dh: string; auth: string }>('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?', userId);
  const body = JSON.stringify(payload);
  for (const s of subs) {
    webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 60 * 60 * 24, urgency: 'normal' })
      .catch((e: { statusCode?: number }) => { if (e?.statusCode === 404 || e?.statusCode === 410) run('DELETE FROM push_subs WHERE endpoint = ?', s.endpoint); });
  }
}

export async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push/key', { config: {} }, async () => ({ key: keys!.public_key }));
  const sub = z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) });
  app.post('/api/push/subscribe', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const p = sub.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation' });
    const uid = req.user!.id;
    run(`INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`, p.data.endpoint, uid, p.data.keys.p256dh, p.data.keys.auth, Date.now());
    // keep the newest 5 devices per person
    run('DELETE FROM push_subs WHERE user_id = ? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE user_id = ? ORDER BY created_at DESC LIMIT 5)', uid, uid);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', { config: {} }, async (req) => {
    const ep = String((req.body as { endpoint?: string } | null)?.endpoint || '');
    if (ep) run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', ep, req.user!.id);
    return { ok: true };
  });
}
