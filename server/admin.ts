import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { all, iso, one, run, type InviteRow, type UserRow } from './db.js';
import { deleteUserVoices } from './eleven.js';
import { adminSlots, cleanupUnreferenced } from './library.js';
import { generateCode } from './invites.js';
import { forgetAllMemory } from './memory.js';
import { limitsFor, overridesOf, usageToday } from './quota.js';

const admin = { config: { access: 'admin' as const } };
const bad = (reply: FastifyReply, issues: unknown) => reply.code(400).send({ error: 'validation', issues });
const idParam = (p: unknown) => {
  const id = Number((p as { id: string }).id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

const createInvite = z.object({
  maxUses: z.number().int().min(1).max(4),
  // either an absolute expiry or a duration; default 7 days
  expiresAt: z.union([z.string().datetime({ offset: true }), z.number().int()]).optional(),
  expiresInHours: z.number().positive().max(24 * 365).optional(),
  note: z.string().trim().max(200).optional().nullable(),
});

const quotaBody = z.object({
  llmReqPerDay: z.number().int().min(0).max(1_000_000).nullable().optional(),
  ttsCharsPerDay: z.number().int().min(0).max(100_000_000).nullable().optional(),
  maxClones: z.number().int().min(0).max(50).nullable().optional(),
  vcSecPerDay: z.number().int().min(0).max(10_000_000).nullable().optional(),
  sttSecPerDay: z.number().int().min(0).max(10_000_000).nullable().optional(),
  searchPerDay: z.number().int().min(0).max(1_000_000).nullable().optional(),
  decidePerDay: z.number().int().min(0).max(10_000_000).nullable().optional(),
  memoryPerDay: z.number().int().min(0).max(1_000_000).nullable().optional(),
  callPerDay: z.number().int().min(0).max(100_000).nullable().optional(), // duo: persona calls (POST /api/duo/ring)
});

function inviteOut(r: InviteRow & { created_by_email?: string | null }, users: { email: string; invite_id: number }[]) {
  const now = Date.now();
  return {
    id: r.id,
    code: r.code,
    maxUses: r.max_uses,
    usedCount: r.used_count,
    expiresAt: iso(r.expires_at),
    note: r.note,
    revoked: !!r.revoked,
    status: r.revoked ? 'revoked' : r.expires_at <= now ? 'expired' : r.used_count >= r.max_uses ? 'full' : 'active',
    createdBy: r.created_by_email ?? null,
    createdAt: iso(r.created_at),
    users: users.filter((u) => u.invite_id === r.id).map((u) => u.email),
  };
}

export async function adminRoutes(app: FastifyInstance) {
  app.get('/api/admin/invites', admin, async () => {
    const rows = all<InviteRow & { created_by_email: string | null }>(
      'SELECT i.*, u.email AS created_by_email FROM invites i LEFT JOIN users u ON u.id = i.created_by ORDER BY i.created_at DESC, i.id DESC');
    const users = all<{ email: string; invite_id: number }>('SELECT email, invite_id FROM users WHERE invite_id IS NOT NULL');
    return { invites: rows.map((r) => inviteOut(r, users)) };
  });

  app.post('/api/admin/invites', admin, async (req, reply) => {
    const p = createInvite.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues);
    const now = Date.now();
    let expires = now + 7 * 86400_000;
    if (p.data.expiresAt != null) expires = typeof p.data.expiresAt === 'number' ? p.data.expiresAt : Date.parse(p.data.expiresAt);
    else if (p.data.expiresInHours) expires = now + p.data.expiresInHours * 3600_000;
    if (!Number.isFinite(expires) || expires <= now) return reply.code(400).send({ error: 'validation', message: 'expiry must be in the future' });
    let id = 0;
    for (let i = 0; i < 5 && !id; i++) {
      try {
        id = Number(run('INSERT INTO invites (code, max_uses, expires_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          generateCode(), p.data.maxUses, expires, p.data.note || null, req.user!.id, now).lastInsertRowid);
      } catch { /* code collision, retry */ }
    }
    const row = one<InviteRow>('SELECT * FROM invites WHERE id = ?', id)!;
    return reply.code(201).send({ invite: inviteOut({ ...row, created_by_email: req.user!.email }, []) });
  });

  app.post('/api/admin/invites/:id/revoke', admin, async (req, reply) => {
    const id = idParam(req.params);
    if (!id) return reply.code(400).send({ error: 'validation' });
    const r = run('UPDATE invites SET revoked = 1 WHERE id = ?', id);
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get('/api/admin/users', admin, async () => {
    const users = all<UserRow & { invite_code: string | null; clones: number }>(
      `SELECT u.*, i.code AS invite_code, (SELECT COUNT(*) FROM voices v WHERE v.user_id = u.id) AS clones
       FROM users u LEFT JOIN invites i ON i.id = u.invite_id ORDER BY u.created_at DESC, u.id DESC`);
    const usage = usageToday(users.map((u) => u.id));
    return {
      users: users.map((u) => {
        const us = usage.get(u.id);
        return {
          id: u.id,
          email: u.email,
          name: u.name,
          picture: u.picture,
          status: u.status,
          isAdmin: !!u.is_admin,
          inviteCode: u.invite_code,
          createdAt: iso(u.created_at),
          clones: u.clones,
          usageToday: { llm: us?.llm_req ?? 0, tts: us?.tts_chars ?? 0, tokens: us?.llm_tokens ?? 0, vc: us?.vc_sec ?? 0, stt: us?.stt_sec ?? 0, search: us?.search_req ?? 0, decide: us?.decide_req ?? 0, memory: us?.memory_req ?? 0 },
          limits: limitsFor(u),
          quotaOverrides: overridesOf(u),
        };
      }),
    };
  });

  for (const action of ['suspend', 'unsuspend'] as const) {
    app.post(`/api/admin/users/:id/${action}`, admin, async (req, reply) => {
      const id = idParam(req.params);
      if (!id) return reply.code(400).send({ error: 'validation' });
      const u = one<UserRow>('SELECT * FROM users WHERE id = ?', id);
      if (!u) return reply.code(404).send({ error: 'not_found' });
      if (action === 'suspend') {
        if (u.id === req.user!.id) return reply.code(400).send({ error: 'cannot_suspend_self' });
        run("UPDATE users SET status = 'suspended' WHERE id = ?", id);
      } else {
        run('UPDATE users SET status = ? WHERE id = ?', u.invite_id != null || u.is_admin ? 'active' : 'pending', id);
      }
      return { ok: true, status: one<{ status: string }>('SELECT status FROM users WHERE id = ?', id)!.status };
    });
  }

  // body: {llmReqPerDay?, ttsCharsPerDay?, maxClones?, vcSecPerDay?}; null removes an override (back to env default)
  app.put('/api/admin/users/:id/quota', admin, async (req, reply) => {
    const id = idParam(req.params);
    if (!id) return reply.code(400).send({ error: 'validation' });
    const p = quotaBody.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues);
    const u = one<UserRow>('SELECT * FROM users WHERE id = ?', id);
    if (!u) return reply.code(404).send({ error: 'not_found' });
    const o: Record<string, unknown> = { ...overridesOf(u) };
    for (const [k, v] of Object.entries(p.data)) {
      if (v === undefined) continue;
      if (v === null) delete o[k]; else o[k] = v;
    }
    const json = Object.keys(o).length ? JSON.stringify(o) : null;
    run('UPDATE users SET quota_json = ? WHERE id = ?', json, id);
    return { ok: true, quotaOverrides: o, limits: limitsFor({ quota_json: json }) };
  });

  app.delete('/api/admin/users/:id/voices', admin, async (req, reply) => {
    const id = idParam(req.params);
    if (!id) return reply.code(400).send({ error: 'validation' });
    if (!one('SELECT 1 FROM users WHERE id = ?', id)) return reply.code(404).send({ error: 'not_found' });
    try {
      return { ok: true, deleted: await deleteUserVoices(id) };
    } catch (e) {
      return reply.code(502).send({ error: 'upstream', message: (e as Error).message });
    }
  });

  // Chat memory of a user (persona_memory + shared_events), e.g. on request or before suspending an account
  app.delete('/api/admin/users/:id/memory', admin, async (req, reply) => {
    const id = idParam(req.params);
    if (!id) return reply.code(400).send({ error: 'validation' });
    if (!one('SELECT 1 FROM users WHERE id = ?', id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true, ...forgetAllMemory(id) };
  });

  // Public Voice Library slots on the ElevenLabs account
  app.get('/api/admin/voice-slots', admin, async (_req, reply) => {
    try { return await adminSlots(); }
    catch (e) { return reply.code(502).send({ error: 'upstream', message: (e as Error).message }); }
  });
  app.post('/api/admin/voice-slots/cleanup', admin, async (_req, reply) => {
    try { return await cleanupUnreferenced(); }
    catch (e) { return reply.code(502).send({ error: 'upstream', message: (e as Error).message }); }
  });
}
