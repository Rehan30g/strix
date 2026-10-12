/*
 * ARCHIVED (v2 LITE): generic OpenRouter pass-through `POST /api/llm`, used by the removed
 * Coffee/agent simulation. Not part of the build (outside tsconfig "include").
 * To revive: copy this file back to v2/server/llm-passthrough.ts, then in app.ts
 *   import { llmPassthroughRoutes } from './llm-passthrough.js';  await app.register(llmPassthroughRoutes);
 * and restore the `/api/llm` section in server/CONTRACT-NOTES.md (see git/backup history).
 * Contract: whitelisted model,messages,tools,tool_choice,temperature(0-2),max_tokens(<=4000),reasoning,provider,stream;
 * stream:true -> OpenRouter SSE passed through as-is; 1 LLM request of quota per call; body limit 5 MB.
 */
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { abortOnClose, openrouter, pickModel, providerPref, sseHeaders, upstreamFail, withCache } from './llm.js';
import { addTokens, chargeLlm } from './quota.js';

const LLM_BODY_MB = 5;
const MSG_KEYS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning', 'reasoning_details'];
const llmBody = z.object({
  model: z.string().max(120).optional().nullable(),
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant', 'tool', 'developer']) }).passthrough()).min(1).max(1000),
  tools: z.array(z.record(z.string(), z.unknown())).max(64).optional().nullable(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().min(0).max(2).optional().nullable(),
  max_tokens: z.number().int().positive().optional().nullable(),
  reasoning: z.record(z.string(), z.unknown()).optional().nullable(),
  provider: z.record(z.string(), z.unknown()).optional().nullable(),
  stream: z.boolean().optional(),
});

const bad = (reply: FastifyReply, issues: unknown) => reply.code(400).send({ error: 'validation', issues });

export async function llmPassthroughRoutes(app: FastifyInstance) {
  // Generic OpenRouter pass-through (Coffee/agent simulation). Key stays server-side.
  app.post('/api/llm', { bodyLimit: LLM_BODY_MB * 1024 * 1024 }, async (req, reply) => {
    if (!config.openrouterKey) return reply.code(503).send({ error: 'llm_not_configured' });
    const p = llmBody.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues);
    const b = p.data;
    const model = pickModel(b.model);
    const messages = b.messages.map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => MSG_KEYS.includes(k))));
    const body: Record<string, unknown> = {
      model,
      messages: withCache(model, messages),
      ...(b.tools?.length && { tools: b.tools, tool_choice: b.tool_choice ?? 'auto' }),
      ...(b.temperature != null && { temperature: b.temperature }),
      ...(b.max_tokens && { max_tokens: Math.min(4000, b.max_tokens) }),
      ...(b.reasoning && { reasoning: b.reasoning }),
    };
    const prov = providerPref(b.provider);
    if (prov) body.provider = prov;
    const stream = b.stream === true;
    if (stream) { body.stream = true; body.usage = { include: true }; }

    chargeLlm(req.user!);
    const ac = abortOnClose(req, reply);
    let r: Response;
    try {
      r = await openrouter(body, ac.signal, 'SpeakingModel Agent');
    } catch (e) {
      if (ac.signal.aborted) return reply;
      return reply.code(502).send({ error: 'upstream', message: `Gagal menghubungi OpenRouter: ${(e as Error).message}` });
    }
    if (!r.ok || !r.body) return upstreamFail(reply, r);
    const userId = req.user!.id;

    if (!stream) {
      const text = await r.text();
      try { const j = JSON.parse(text); if (j.usage?.total_tokens) addTokens(userId, j.usage.total_tokens); } catch { /* ignore */ }
      return reply.code(200).type('application/json').send(text);
    }

    // SSE passed through as-is (tokens reach the browser as soon as the model emits them)
    const out = new PassThrough();
    sseHeaders(reply);
    reply.send(out);
    void (async () => {
      const dec = new TextDecoder();
      let tail = '';
      try {
        for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
          if (out.writableEnded) break;
          out.write(chunk);
          // best-effort token accounting from the final usage chunk
          tail = (tail + dec.decode(chunk, { stream: true })).slice(-4000);
        }
        const m = tail.match(/"total_tokens"\s*:\s*(\d+)/g);
        if (m) addTokens(userId, Number(m.at(-1)!.replace(/\D+/g, '')));
      } catch (e) {
        if (!ac.signal.aborted && !out.writableEnded) out.write(`data: ${JSON.stringify({ error: { message: (e as Error).message } })}\n\n`);
      }
      if (!out.writableEnded) out.end();
    })();
    return reply;
  });
}
