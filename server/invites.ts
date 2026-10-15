import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { all, one, run, tx, type InviteRow } from './db.js';

// No ambiguous characters (0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateCode(len = 10) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s;
}

export const normalizeCode = (c: string) => c.toUpperCase().replace(/[\s-]/g, '');

/** gmail ignores dots and +tags, so a.b+x@gmail.com is the same mailbox as ab@gmail.com */
export function canonicalEmail(email: string): string {
  const [l = '', dom = ''] = email.toLowerCase().trim().split('@');
  if (dom === 'gmail.com' || dom === 'googlemail.com') return l.split('+')[0].replaceAll('.', '') + '@gmail.com';
  return l + '@' + dom;
}

type RedeemResult = { ok: true; already?: boolean } | { status: number; error: string };

export function redeem(userId: number, rawCode: string, deviceId: string | null = null): RedeemResult {
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
    // one person, one account: the same mailbox (alias) or the same browser may not redeem a second time
    if (config.isProd) {
      const me = one<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)!;
      const key = canonicalEmail(me.email);
      if (one('SELECT 1 FROM users WHERE id != ? AND invite_id IS NOT NULL AND email_key = ?', userId, key)) return { status: 409, error: 'duplicate_account' };
      if (deviceId && one('SELECT 1 FROM users WHERE id != ? AND invite_id IS NOT NULL AND device_id = ?', userId, deviceId)) return { status: 409, error: 'device_used' };
    }
    if (inv.revoked) return { status: 410, error: 'code_revoked' };
    if (inv.expires_at <= Date.now()) return { status: 410, error: 'code_expired' };
    if (inv.used_count >= inv.max_uses) return { status: 409, error: 'code_full' };
    run('UPDATE invites SET used_count = used_count + 1 WHERE id = ?', inv.id);
    run("UPDATE users SET invite_id = ?, status = 'active', device_id = ? WHERE id = ?", inv.id, deviceId, userId);
    const em = one<{ email: string }>('SELECT email FROM users WHERE id = ?', userId)!;
    run('UPDATE users SET email_key = ? WHERE id = ?', canonicalEmail(em.email), userId);
    return { ok: true } as const;
  });
}

export async function inviteRoutes(app: FastifyInstance) {
  // accounts that redeemed before this check existed
  for (const u of all<{ id: number; email: string }>('SELECT id, email FROM users WHERE invite_id IS NOT NULL AND email_key IS NULL')) run('UPDATE users SET email_key = ? WHERE id = ?', canonicalEmail(u.email), u.id);
  const body = z.object({ code: z.string().trim().min(4).max(32) });
  app.post('/api/invite/redeem', {
    config: { access: 'auth', rateLimit: { max: config.rate.authPerMin, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const p = body.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    // long-lived signed per-browser id (survives logout), so a second Google account on this browser is recognised
    let dev: string | null = null;
    const raw = req.cookies?.sm_dev; const un = raw ? req.unsignCookie(raw) : null;
    if (un?.valid && un.value) dev = un.value;
    else { dev = crypto.randomBytes(16).toString('hex'); reply.setCookie('sm_dev', dev, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.isProd, signed: true, maxAge: 60 * 60 * 24 * 730 }); }
    const r = redeem(req.user!.id, p.data.code, dev);
    if ('error' in r) return reply.code(r.status).send({ error: r.error });
    return { ok: true };
  });
}
