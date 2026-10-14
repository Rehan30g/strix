import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { one, run, type UserRow } from './db.js';
import { limitsFor, quotaSummary } from './quota.js';

export type Access = 'public' | 'auth' | 'active' | 'admin';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionId: string | null;
  }
  interface FastifyContextConfig {
    access?: Access;
  }
}

const SID_COOKIE = config.isProd ? '__Host-sm_sid' : 'sm_sid';
const OAUTH_COOKIE = config.isProd ? '__Host-sm_oauth' : 'sm_oauth';
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

const cookieBase = () => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.isProd, signed: true });

/* ---------------- sessions ---------------- */

export function createSession(reply: FastifyReply, userId: number) {
  const token = b64url(crypto.randomBytes(32));
  const now = Date.now();
  const expires = now + config.sessionDays * 86400_000;
  run('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', sha256(token), userId, expires, now);
  reply.setCookie(SID_COOKIE, token, { ...cookieBase(), expires: new Date(expires) });
}

export function destroySession(req: FastifyRequest, reply: FastifyReply) {
  if (req.sessionId) run('DELETE FROM sessions WHERE id = ?', req.sessionId);
  reply.clearCookie(SID_COOKIE, { path: '/' });
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
}

function loadSession(req: FastifyRequest) {
  req.user = null;
  req.sessionId = null;
  const raw = req.cookies?.[SID_COOKIE];
  if (!raw) return;
  const un = req.unsignCookie(raw);
  if (!un.valid || !un.value) return;
  const sid = sha256(un.value);
  const row = one<UserRow & { expires_at: number }>(
    'SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?', sid);
  if (!row) return;
  if (row.expires_at < Date.now()) { run('DELETE FROM sessions WHERE id = ?', sid); return; }
  const { expires_at: _e, ...user } = row;
  // admin flag follows ADMIN_EMAILS live
  const isAdmin = config.adminEmails.has(user.email.toLowerCase()) ? 1 : 0;
  if (isAdmin !== user.is_admin) {
    run('UPDATE users SET is_admin = ? WHERE id = ?', isAdmin, user.id);
    user.is_admin = isAdmin;
  }
  if (isAdmin && user.status === 'pending') {
    run("UPDATE users SET status = 'active' WHERE id = ?", user.id);
    user.status = 'active';
  }
  req.user = user as UserRow;
  req.sessionId = sid;
}

/* ---------------- users ---------------- */

export function upsertGoogleUser(p: { sub: string; email: string; name: string; picture: string | null }): UserRow {
  const isAdmin = config.adminEmails.has(p.email.toLowerCase()) ? 1 : 0;
  const existing = one<UserRow>('SELECT * FROM users WHERE google_sub = ?', p.sub);
  if (existing) {
    const status = isAdmin && existing.status === 'pending' ? 'active' : existing.status;
    run('UPDATE users SET email = ?, name = ?, picture = ?, is_admin = ?, status = ? WHERE id = ?',
      p.email, p.name, p.picture, isAdmin, status, existing.id);
    return one<UserRow>('SELECT * FROM users WHERE id = ?', existing.id)!;
  }
  const r = run('INSERT INTO users (google_sub, email, name, picture, status, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    p.sub, p.email, p.name, p.picture, isAdmin ? 'active' : 'pending', isAdmin, Date.now());
  return one<UserRow>('SELECT * FROM users WHERE id = ?', Number(r.lastInsertRowid))!;
}

export function publicUser(u: UserRow) {
  return { id: u.id, email: u.email, name: u.name, picture: u.picture, status: u.status, isAdmin: !!u.is_admin };
}

/* ---------------- access control ---------------- */

export function accessHook(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    loadSession(req);
    if (!req.routeOptions.url?.startsWith('/api/')) return; // unknown route / static wildcard -> 404 handler
    const access: Access = req.routeOptions.config?.access ?? 'active';
    if (access === 'public') return;
    const u = req.user;
    if (!u) return reply.code(401).send({ error: 'unauthenticated' });
    if (access === 'auth') return;
    if (u.status === 'suspended') return reply.code(403).send({ error: 'suspended' });
    if (u.status !== 'active') return reply.code(403).send({ error: 'invite_required' });
    if (access === 'admin' && !u.is_admin) return reply.code(403).send({ error: 'admin_only' });
  });

  // CSRF defence in depth (cookie is SameSite=Lax): state-changing requests must come from our own origin.
  const allowed = new Set([new URL(config.publicUrl).origin, ...config.extraOrigins]);
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (!origin) return; // non-browser clients (curl) / same-origin navigations without Origin
    let ok = allowed.has(origin);
    if (!ok) {
      try {
        const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '');
        ok = new URL(origin).host === host;
      } catch { ok = false; }
    }
    if (!ok) return reply.code(403).send({ error: 'bad_origin' });
  });
}

/* ---------------- Google OAuth (authorization code + PKCE) ---------------- */

const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;

let jwksCache: { at: number; keys: Record<string, crypto.KeyObject> } = { at: 0, keys: {} };
async function googleKey(kid: string): Promise<crypto.KeyObject | undefined> {
  if (!jwksCache.keys[kid] || Date.now() - jwksCache.at > 3600_000) {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!r.ok) throw new Error(`JWKS ${r.status}`);
    const { keys } = (await r.json()) as { keys: (Record<string, unknown> & { kid: string })[] };
    jwksCache = { at: Date.now(), keys: Object.fromEntries(keys.map((k) => [k.kid, crypto.createPublicKey({ key: k as any, format: 'jwk' })])) };
  }
  return jwksCache.keys[kid];
}

async function verifyIdToken(idToken: string, nonce: string) {
  const [h, p, s] = idToken.split('.');
  if (!h || !p || !s) throw new Error('malformed id_token');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error('unexpected alg');
  const key = await googleKey(header.kid);
  if (!key) throw new Error('unknown kid');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('bad signature');
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(c.iss)) throw new Error('bad iss');
  if (c.aud !== config.google.clientId) throw new Error('bad aud');
  if (typeof c.exp !== 'number' || c.exp < now - 60) throw new Error('expired');
  if (c.nonce !== nonce) throw new Error('bad nonce');
  if (!c.sub || !c.email || c.email_verified !== true) throw new Error('email not verified');
  return { sub: String(c.sub), email: String(c.email).toLowerCase(), name: String(c.name ?? c.email), picture: c.picture ? String(c.picture) : null };
}

const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);

export async function authRoutes(app: FastifyInstance) {
  const authRate = { max: config.rate.authPerMin, timeWindow: '1 minute' };

  app.get('/api/auth/config', { config: { access: 'public' } }, async () => ({
    google: googleConfigured(),
    devLogin: config.devFakeLogin,
    testEnd: config.testEnd,
  }));

  app.get('/api/auth/google/start', { config: { access: 'public', rateLimit: authRate } }, async (_req, reply) => {
    if (!googleConfigured()) return reply.code(503).send({ error: 'google_not_configured' });
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state, nonce, verifier }), { ...cookieBase(), maxAge: 600 });
    const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.search = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return reply.redirect(u.toString(), 302);
  });

  app.get('/api/auth/google/callback', { config: { access: 'public', rateLimit: authRate } }, async (req, reply) => {
    const fail = (code: string) => {
      req.log.warn({ code }, 'google login failed');
      return reply.redirect(`/#/login?error=${encodeURIComponent(code)}`, 302);
    };
    if (!googleConfigured()) return fail('google_not_configured');
    const q = req.query as Record<string, string | undefined>;
    const raw = req.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: '/' });
    if (q.error) return fail(q.error === 'access_denied' ? 'access_denied' : 'google_error');
    const un = raw ? req.unsignCookie(raw) : null;
    if (!un?.valid || !un.value) return fail('state_missing');
    let st: { state: string; nonce: string; verifier: string };
    try { st = JSON.parse(un.value); } catch { return fail('state_missing'); }
    if (!q.state || !q.code || q.state !== st.state) return fail('state_mismatch');
    try {
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: q.code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri(),
          grant_type: 'authorization_code',
          code_verifier: st.verifier,
        }),
      });
      if (!r.ok) { req.log.warn({ status: r.status, body: (await r.text()).slice(0, 300) }, 'token exchange'); return fail('token_exchange'); }
      const tok = (await r.json()) as { id_token?: string };
      if (!tok.id_token) return fail('no_id_token');
      const profile = await verifyIdToken(tok.id_token, st.nonce);
      const user = upsertGoogleUser(profile);
      createSession(reply, user.id);
      return reply.redirect(user.status === 'pending' ? '/#/redeem' : '/', 302);
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'google callback');
      return fail('verify_failed');
    }
  });

  if (config.devFakeLogin) {
    if (config.isProd) throw new Error('DEV_FAKE_LOGIN refused in production');
    const q = z.object({
      email: z.string().email().max(200).optional(),
      name: z.string().max(100).optional(),
      redirect: z.string().regex(/^\/(?!\/)/).max(200).optional(),
    });
    app.get('/api/auth/dev-login', { config: { access: 'public' } }, async (req, reply) => {
      const p = q.safeParse(req.query);
      if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
      const email = (p.data.email ?? config.devFakeEmail).toLowerCase();
      const user = upsertGoogleUser({ sub: `dev:${email}`, email, name: p.data.name ?? (p.data.email ? email.split('@')[0] : config.devFakeName), picture: null });
      if (req.sessionId) run('DELETE FROM sessions WHERE id = ?', req.sessionId);
      createSession(reply, user.id);
      if (p.data.redirect) return reply.redirect(p.data.redirect, 302);
      return { ok: true, user: publicUser(user) };
    });
  }

  app.post('/api/auth/logout', { config: { access: 'public' } }, async (req, reply) => {
    destroySession(req, reply);
    return { ok: true };
  });

  app.get('/api/me', { config: { access: 'auth' } }, async (req) => {
    const u = req.user!;
    return {
      user: publicUser(u),
      quota: quotaSummary(u),
      features: {
        clone: !!config.elevenKey && u.status === 'active' && limitsFor(u).maxClones > 0,
        vc: !!config.elevenKey && u.status === 'active' && limitsFor(u).vcSecPerDay > 0,
        stt: !!config.elevenKey && u.status === 'active' && limitsFor(u).sttSecPerDay > 0,
        webSearch: !!config.openrouterKey && u.status === 'active' && limitsFor(u).searchPerDay > 0,
      },
    };
  });
}
