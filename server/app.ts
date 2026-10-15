import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { accessHook, authRoutes } from './auth.js';
import { inviteRoutes } from './invites.js';
import { quotaRequestRoutes } from './quotaRequests.js';
import { pushRoutes } from './push.js';
import { adminRoutes } from './admin.js';
import { llmRoutes } from './llm.js'; // /config /characters /chat (generic /api/llm archived in _archive/server)
import { ttsRoutes } from './tts.js';
import { dialogueRoutes } from './dialogue.js';
import { voiceRoutes } from './voices.js';
import { vcRoutes } from './vc.js';
import { settingsRoutes } from './settings.js';
import { personaRoutes } from './persona.js';
import { autotagRoutes } from './autotag.js';
import { sttRoutes } from './stt.js';
import { decideRoutes } from './decide.js';
import { memoryRoutes } from './memory.js';
import { duoRoutes } from './duo.js';
import { QuotaError } from './quota.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
  });

  app.decorateRequest('user', null);
  app.decorateRequest('sessionId', null);

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        mediaSrc: ["'self'", 'blob:', 'data:', 'https:'],
        // Scribe Realtime STT: the browser opens the ElevenLabs WebSocket itself (single-use token, see stt.ts)
        connectSrc: ["'self'", `wss://${config.sttHost}`],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'", 'https://accounts.google.com'],
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.isProd,
  });
  app.addHook('onRequest', async (_req, reply) => {
    reply.header('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  });

  await app.register(rateLimit, {
    global: true,
    max: config.rate.globalPerMin,
    timeWindow: '1 minute',
    allowList: (req) => !req.url.startsWith('/api/') || req.url === '/api/healthz',
    errorResponseBuilder: (_req, ctx) => ({ statusCode: ctx.statusCode, error: 'rate_limited', retryAfter: ctx.after }),
  });
  await app.register(multipart, { limits: { fileSize: Math.max(config.quota.maxCloneUploadMb, config.quota.maxVcUploadMb) * 1024 * 1024, files: 3 } });

  accessHook(app);

  app.setErrorHandler((err: FastifyError & { error?: string; retryAfter?: string }, req, reply) => {
    if (err instanceof QuotaError) return reply.code(429).send({ error: 'quota', kind: err.kind, resetAt: err.resetAt });
    if (err.error === 'rate_limited') return reply.code(429).send({ error: 'rate_limited', retryAfter: err.retryAfter });
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'body_too_large' });
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  const health = async () => ({ ok: true });
  app.get('/healthz', { config: { access: 'public' } }, health);
  app.get('/api/healthz', { config: { access: 'public' } }, health);

  await app.register(authRoutes);
  await app.register(inviteRoutes);
  await app.register(quotaRequestRoutes);
  await app.register(pushRoutes);
  await app.register(adminRoutes);
  await app.register(llmRoutes);
  await app.register(ttsRoutes);
  await app.register(dialogueRoutes);
  await app.register(voiceRoutes);
  await app.register(vcRoutes);
  await app.register(settingsRoutes);
  await app.register(personaRoutes);
  await app.register(autotagRoutes);
  await app.register(sttRoutes);
  await app.register(decideRoutes);
  await app.register(memoryRoutes);
  await app.register(duoRoutes);

  // Built SPA (web/dist) + history fallback
  const indexHtml = path.join(config.webDist, 'index.html');
  const hasWeb = fs.existsSync(indexHtml);
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      prefix: '/',
      index: ['index.html'],
      setHeaders: (res, file) => {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache');
      },
    });
  } else {
    app.log.warn(`web build not found at ${config.webDist} (run "npm run build:web"); only /api is served`);
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/') || req.url === '/api') return reply.code(404).send({ error: 'not_found' });
    const isAsset = req.url.startsWith('/assets/') || /\.[a-z0-9]{1,5}(\?|$)/i.test(req.url);
    if (hasWeb && !isAsset && (req.method === 'GET' || req.method === 'HEAD')) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).type('text/plain').send(hasWeb ? 'Not found' : 'Web UI not built. In dev use the Vite server (npm run dev:web).');
  });

  return app;
}
