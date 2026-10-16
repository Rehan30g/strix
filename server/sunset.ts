/* After the closed test ends (TEST_END_DATE, end of that day in Jakarta time) the whole site becomes one quiet page
   (web/public/end): no sign-in, no API, no paid calls. /end/ is always reachable so it can be previewed. */
import type { FastifyInstance } from 'fastify';
import { config } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const closesAt = (): number => Date.parse(`${config.testEnd}T00:00:00+07:00`) + DAY_MS;
/** FORCE_CLOSED=1 lets you rehearse the ending without waiting for the date. */
export const isClosed = (): boolean => process.env.FORCE_CLOSED === '1' || Date.now() >= closesAt();

export function sunsetHook(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (!isClosed()) return;
    const url = req.url.split('?')[0];
    if (url === '/healthz' || url === '/api/healthz' || url === '/favicon.svg' || url === '/sw.js' || url.startsWith('/end/')) return;
    if (url.startsWith('/api/')) return reply.code(410).send({ error: 'closed' });
    const page = (req.method === 'GET' || req.method === 'HEAD') && !url.startsWith('/assets/') && !/\.[a-z0-9]{1,5}$/i.test(url);
    if (page) return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').sendFile('end/index.html');
    return reply.code(410).type('text/plain').send('closed');
  });
}
