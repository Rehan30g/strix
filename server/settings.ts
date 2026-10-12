import type { FastifyInstance } from 'fastify';
import { config } from './config.js';
import { all, iso, one, run } from './db.js';

const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export async function settingsRoutes(app: FastifyInstance) {
  // all keys at once (handy for app bootstrap)
  app.get('/api/settings', async (req) => {
    const rows = all<{ key: string; value_json: string }>('SELECT key, value_json FROM user_settings WHERE user_id = ?', req.user!.id);
    return { settings: Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)])) };
  });

  app.get('/api/settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'validation', message: 'bad key' });
    const row = one<{ value_json: string; updated_at: number }>('SELECT value_json, updated_at FROM user_settings WHERE user_id = ? AND key = ?', req.user!.id, key);
    return { key, value: row ? JSON.parse(row.value_json) : null, updatedAt: row ? iso(row.updated_at) : null };
  });

  // body: {value: <any JSON>}  (value_json <= 64 KB)
  app.put('/api/settings/:key', { bodyLimit: config.limits.settingsMaxBytes + 4096 }, async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'validation', message: 'bad key' });
    const body = req.body as { value?: unknown } | undefined;
    if (!body || typeof body !== 'object' || !('value' in body)) return reply.code(400).send({ error: 'validation', message: 'body must be {value}' });
    const json = JSON.stringify(body.value ?? null);
    if (Buffer.byteLength(json) > config.limits.settingsMaxBytes) return reply.code(413).send({ error: 'too_large', maxBytes: config.limits.settingsMaxBytes });
    const uid = req.user!.id;
    const exists = one('SELECT 1 FROM user_settings WHERE user_id = ? AND key = ?', uid, key);
    if (!exists) {
      const n = one<{ n: number }>('SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?', uid)!.n;
      if (n >= config.limits.settingsMaxKeys) return reply.code(400).send({ error: 'too_many_keys', max: config.limits.settingsMaxKeys });
    }
    const now = Date.now();
    run(`INSERT INTO user_settings (user_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`, uid, key, json, now);
    return { ok: true, key, updatedAt: iso(now) };
  });

  app.delete('/api/settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    if (!KEY_RE.test(key)) return reply.code(400).send({ error: 'validation', message: 'bad key' });
    run('DELETE FROM user_settings WHERE user_id = ? AND key = ?', req.user!.id, key);
    return { ok: true };
  });
}
