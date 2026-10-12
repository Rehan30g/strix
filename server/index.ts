import { config, validateConfig } from './config.js';

let warnings: string[];
try {
  warnings = validateConfig();
} catch (e) {
  console.error(`FATAL: ${(e as Error).message}`);
  process.exit(1);
}

// Import after config validation (db.ts opens the database on import).
const { buildApp } = await import('./app.js');
const { purgeExpiredSessions } = await import('./auth.js');
const { db } = await import('./db.js');

const app = await buildApp();
for (const w of warnings) app.log.warn(w);
if (config.devFakeLogin) app.log.warn('DEV_FAKE_LOGIN=1: GET /api/auth/dev-login?email=... signs in without Google (dev only)');

purgeExpiredSessions();
const timer = setInterval(purgeExpiredSessions, 3600_000);
timer.unref();

const shutdown = async (sig: string) => {
  app.log.info(`${sig} received, shutting down`);
  try { await app.close(); } finally { db.close(); process.exit(0); }
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`Strix on http://localhost:${config.port} (public URL ${config.publicUrl})`);
} catch (e) {
  app.log.error(e);
  process.exit(1);
}
