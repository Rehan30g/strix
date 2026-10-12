import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { one, run, tx, type InviteRow } from './db.js';

// No ambiguous characters (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(len = 10) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export const normalizeCode = (c: string) => c.toUpperCase().replace(/[\s-]/g, '');

type RedeemResult = { ok: true; already?: boolean } | { status: number; error: string };

export function redeem(userId: number, rawCode: string): RedeemResult {
  const code = normalizeCode(rawCode);
  return tx(() => {
    const user = one<{ invite_id: number | null; status: string }>('SELECT invite_id, status FROM users WHERE id = ?', userId);
    if (!user) return { status: 401, error: 'unauthenticated' };
    if (user.status === 'suspended') return { status: 403, error: 'suspended' };
    const inv = one<InviteRow>('SELECT * FROM invites WHERE code = ?', code);
    if (user.invite_id != null) {
      // same code twice -> no-op; a different code -> refused
      if (inv && inv.id === user.invite_id) return { ok: true, already: true } as const;
      return { status: 409, error: 'already_redeemed' };
    }
    if (!inv) return { status: 404, error: 'invalid_code' };
    if (inv.revoked) return { status: 410, error: 'code_revoked' };
    if (inv.expires_at <= Date.now()) return { status: 410, error: 'code_expired' };
    if (inv.used_count >= inv.max_uses) return { status: 409, error: 'code_full' };
    run('UPDATE invites SET used_count = used_count + 1 WHERE id = ?', inv.id);
    run("UPDATE users SET invite_id = ?, status = 'active' WHERE id = ?", inv.id, userId);
    return { ok: true } as const;
  });
}

export async function inviteRoutes(app: FastifyInstance) {
  const body = z.object({ code: z.string().trim().min(4).max(32) });
  app.post('/api/invite/redeem', {
    config: { access: 'auth', rateLimit: { max: config.rate.authPerMin, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const p = body.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const r = redeem(req.user!.id, p.data.code);
    if ('error' in r) return reply.code(r.status).send({ error: r.error });
    return { ok: true };
  });
}
