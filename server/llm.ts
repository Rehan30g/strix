import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { characters, baseRules, audioTagRules, noTagRules, isEnglish } from './characters.js';
import { addTokens, chargeLlm, chargeSearch, limitsFor, QuotaError, resetAt } from './quota.js';
import { builtin, memoryContext, memoryKey, noteHangup } from './memory.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/* ---------------- provider routing (ported from v1 server.js) ---------------- */
// Default OpenRouter routing leans to the cheapest (often slow) provider; default here = fast providers first.
//   OPENROUTER_PROVIDER_ORDER=baseten/fp8,modal,coreweave/fp8   (manual order, fallbacks stay on)
//   OPENROUTER_PROVIDER_SORT=latency|throughput|price|none       (none = OpenRouter default routing)
const FAST_PROVIDERS = ['deepseek', 'baseten/fp8', 'modal', 'coreweave/fp8'];
const SLOW_PROVIDERS = ['sail-research', 'wafer', 'alibaba', 'together', 'siliconflow', 'dekallm'];

function envProvider(): Record<string, unknown> | null {
  const { OPENROUTER_PROVIDER_ORDER: order, OPENROUTER_PROVIDER_SORT: sort } = process.env;
  if (order?.trim()) return { order: order.split(',').map((x) => x.trim()).filter(Boolean), allow_fallbacks: true };
  if (sort === 'none') return null;
  if (sort) return { sort };
  return { order: FAST_PROVIDERS, ignore: SLOW_PROVIDERS, allow_fallbacks: true };
}

// Anthropic needs an explicit breakpoint so the (fixed) system prompt is cached; other models cache automatically.
export function withCache(model: string, msgs: any[]) {
  if (!String(model).startsWith('anthropic/')) return msgs;
  return msgs.map((m, i) => (i === 0 && m.role === 'system' && typeof m.content === 'string'
    ? { ...m, content: [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }] } : m));
}

// Provider routing comes from the server env only (clients can't pick a model or provider).
export const providerPref = (): Record<string, unknown> | null => envProvider();

/** The one LLM model (OPENROUTER_MODEL). Clients can never choose it. */
export const lockedModel = () => config.defaultModel;

export function openrouter(body: unknown, signal: AbortSignal, title = 'Strix') {
  return fetch(OPENROUTER_URL, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${config.openrouterKey}`,
      'Content-Type': 'application/json',
      'X-Title': title,
      'HTTP-Referer': config.publicUrl,
    },
    body: JSON.stringify(body),
  });
}

/** Map an upstream failure to our own status (never leak upstream 401/403/429, the UI treats those globally). */
export async function upstreamFail(reply: FastifyReply, r: Response) {
  const text = (await r.text()).slice(0, 1000);
  let message = text;
  try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* plain text */ }
  const status = [400, 404, 422].includes(r.status) ? 400 : 502;
  return reply.code(status).send({ error: 'upstream', upstreamStatus: r.status, message: `OpenRouter: ${message}` });
}

export function abortOnClose(req: FastifyRequest, reply: FastifyReply) {
  const ac = new AbortController();
  // 'close' on the response fires when the client goes away or after we finish; abort is harmless after finish
  reply.raw.on('close', () => ac.abort());
  req.raw.on('aborted', () => ac.abort());
  return ac;
}

export function sseHeaders(reply: FastifyReply) {
  reply.code(200).headers({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
}

/* ---------------- tools ---------------- */

const toolDefs: Record<string, unknown> = {
  end_interview: {
    type: 'function',
    function: {
      name: 'end_interview',
      description:
        'Immediately and permanently end the interview. The candidate can NOT reply afterwards. Say your short closing line in the same turn, then call this. Use decision "rejected" when the candidate should be rejected on the spot, or "passed" only after a full interview when they clearly earned the job.',
      parameters: {
        type: 'object',
        properties: {
          decision: { type: 'string', enum: ['rejected', 'passed'] },
          reason: { type: 'string', description: 'One blunt sentence: the main reason for the decision.' },
          feedback: { type: 'string', description: 'Candid 2-3 sentence feedback on what to improve (shown to the candidate).' },
        },
        required: ['decision', 'reason', 'feedback'],
      },
    },
  },
  end_call: {
    type: 'function',
    function: {
      name: 'end_call',
      description:
        'Hang up on the user and lock this conversation until they start a new one. Say your short final line in the same reply FIRST, then call this. Only when you have genuinely had enough (see ENDING THE CALL).',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: "One short, neutral sentence for the user's screen about why the call ended (not in character, no insults)." },
        },
        required: ['reason'],
      },
    },
  },
};

const END_CALL_RULES = `

ENDING THE CALL: you have a tool end_call that hangs up on the user and locks the conversation until they start a new one. Use it ONLY when, in character, you have genuinely had enough: the user keeps pushing, insulting or provoking you after you already warned them or showed you were upset, or you have clearly decided you will not go on talking with them. Never for a single rude line, mild discomfort, or a topic you can simply refuse. First say your short final line in the same reply (angry, cold, tired or simply done, whatever fits your mood), then call end_call in that same turn with a one-sentence neutral reason for the user's screen. After you call it the user cannot reply.

PROMISES: if you promised something in this conversation (for example "I will not hang up on you"), you keep it. A promise is not a shield for abuse, but breaking one needs a real reason and you say so out loud ("I said I would not hang up. You are making me regret that."), and only after the user has clearly broken the spirit of it. If the user asks you not to hang up and you agree, do NOT call end_call in that same reply or in the replies right after, whatever the mood.`;

const webSearchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web for current or specific facts you cannot reliably know (news, weather, prices, scores, schedules, recent releases, live events). Before calling it, ALWAYS first say one short spoken line telling the user you are checking. Never for small talk, opinions or things you already know.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A short, specific web search query (include place and date when relevant).' },
      },
      required: ['query'],
    },
  },
};

const MAX_SEARCHES_PER_TURN = 2;
const SEARCH_TIMEOUT_MS = 20_000;
const CUT_MARK = '[cut off by the user here]';

/** Persona-wide rules for the web_search tool (all personas, in character, user's language). */
const webRules = (today: string) => `

LOOKING THINGS UP: you can search the web with the tool web_search. Today's date is ${today}.
- Use it only when the user needs something you cannot reliably know: current events, news, weather, prices, scores, schedules, recent releases, or a specific fact you are genuinely unsure of. Never for small talk, feelings, opinions, games, roleplay, or things you clearly know.
- Never search silently. In the SAME reply, FIRST say ONE short spoken line, in character, in the user's language, telling them you'll check and asking them to hang on a moment (for example "Hold on, let me look that up—" or "Bentar ya, aku cek dulu—", but in your own style), and then immediately call the tool. Never end a reply with only that line and no tool call. Usually one well-phrased search is enough.
- When the results arrive, continue naturally without repeating that line: answer briefly in your normal voice and mention where it came from in passing ("according to the BBC...", "the weather service says..."). Never read out URLs, links or website addresses.
- If the search failed or is unavailable, say so briefly in character with a small apology; answer from what you know only if you are confident, otherwise admit you don't know.
- At most ${MAX_SEARCHES_PER_TURN} searches per reply.`;

/** Context for a reply right after the user cut the assistant off (duplex voice). In character, no rules leaked. */
function interruptedNote(cut: { spoken: string; unspoken: string }, hint: 'continue' | 'rephrase' | 'drop' | null) {
  const said = cut.spoken ? `You only got as far as: "${cut.spoken.slice(-600)}"` : 'You had not said anything yet';
  const unsaid = cut.unspoken && hint !== 'drop' ? ` What you were about to say next (they never heard it): "${cut.unspoken.slice(0, 600)}".` : '';
  const how = hint === 'continue'
    ? 'They want you to carry on: pick up right where you stopped with what you were about to say, in a few natural words (a tiny "anyway—" or "so, as I was saying—" in your style is fine). Do not repeat what you already said and do not start over.'
    : hint === 'rephrase'
      ? 'First respond briefly to what they said when they cut in, then come back to your point and say the unfinished part again in fewer, simpler words. Do not start over from the beginning.'
      : hint === 'drop'
        ? 'They have moved on: let your unfinished point go completely (do not bring it back) and respond to what they said now.'
        : 'Respond to what they said when they cut in. Then, only if it still matters, pick up where you left off without repeating what you already said; if they have moved on, let it go.';
  return `\n\nJUST NOW: the user cut you off in the middle of your last reply. ${said} — that is exactly where you stopped talking, and they heard nothing after it.${unsaid} In the conversation history, "${CUT_MARK}" marks that spot; it is only a note for you: never write it, and never use square brackets for anything but your usual delivery tags. React like a real person who just got interrupted, true to your character and current mood (amused, a little flustered, patient, or slightly miffed; keep it brief and do not make a big deal of it). ${how}`;
}

/** A reply that ends by promising to look something up ("let me check", "bentar, aku cek dulu"). */
// the persona announces it is ending the call (EN / ID); used only to complete a forgotten end_call tool call
const HANGUP_RE = /\b(hang(?:ing)? up|i'?m (?:done|out of here|leaving)|we'?re (?:done|finished)|this (?:conversation |call )?is over|(?:goodbye|bye) for (?:good|now)|aku (?:tutup|sudah selesai|pergi)|kita selesai|sudah cukup)\b/i;

// a negation / promise just before the match means the persona is NOT hanging up ("I promise I won't hang up")
const NEGATED_RE = /\b(won'?t|will not|wouldn'?t|not (?:going|gonna)|never|don'?t|do not|didn'?t|can'?t|cannot|promise|swear|no longer|rather not|refuse|instead of|stay|staying|not now|if you)\b/i;
/** Did the persona's reply announce that THEY are ending / leaving the call right now? Pattern first (cheap), then one tiny
    confirmation from the decision model; any doubt or failure = do NOT hang up. */
async function announcesHangup(text: string, lastUser: string, signal: AbortSignal): Promise<boolean> {
  const tail = text.slice(-220);
  const m = HANGUP_RE.exec(tail);
  if (!m) return false;
  if (NEGATED_RE.test(tail.slice(Math.max(0, m.index - 50), m.index + m[0].length))) return false;
  try {
    const r = await openrouter({
      model: config.decisionModel, stream: false, temperature: 0, max_tokens: 20, reasoning: { enabled: false },
      messages: [
        { role: 'system', content: 'You judge one line of a spoken conversation. Reply ONLY with JSON {"ending":true} or {"ending":false}. ending is true ONLY if the speaker, in this very reply, announces that THEY are hanging up / leaving / ending the call or conversation RIGHT NOW. It is false for promises not to hang up, refusals to leave, conditions or threats ("if you keep going I will hang up"), questions, and talk about the past.' },
        { role: 'user', content: `The other person last said: ${lastUser.slice(0, 300)}\nThe speaker's reply: ${tail}` },
      ],
    }, AbortSignal.any([signal, AbortSignal.timeout(2500)]), 'Strix hangup check');
    if (!r.ok) return false;
    const j: any = await r.json();
    const raw = String(j?.choices?.[0]?.message?.content ?? '');
    const o = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    return o.ending === true;
  } catch { return false; }
}

const PROMISE_RE =/\b(let me|lemme|i'?ll|i will|gonna|going to)\s+(quickly\s+|just\s+)?((have|take)\s+(a\s+)?(quick\s+)?(look|peek)|check|double[- ]check|verify|make sure|look it up|look that up|look up|search|find out|google)\b|\blook (that|it) up\b|\b(aku|saya|gue|gw|ku)\s+(cek|cari|carikan|cariin|pastikan|pastiin|lihat|liat)\b|\b(cek|cari|carikan|cariin|pastikan|pastiin)\s+(dulu|bentar)\b/i;

/** Fallback "let me check" line when the model called web_search without saying anything first. */
function fallbackPreamble(lastUser: string, language: string, tags: boolean) {
  const id = /^(id|indonesian|indonesia|bahasa indonesia|bahasa)$/i.test(language.trim())
    || (!language && /\b(aku|kamu|gimana|nggak|enggak|gak|dong|sih|berapa|hari ini|cuaca|berita|yang|apa|ini|itu|bisa|tolong|cek)\b/i.test(lastUser));
  const line = id ? 'Hmm, bentar ya, aku cek dulu...' : 'Hmm, hang on, let me look that up...';
  return tags ? `[thoughtful] ${line}` : line;
}

const SEARCH_SYSTEM = (today: string) => `You are a search assistant. Today is ${today}. Using the web search results provided, write a compact factual brief that answers the query: the key facts with concrete numbers, dates and places, at most 120 words of plain text, no URLs, no markdown, no lists. Name the source (outlet or site name in words, e.g. "BBC", "Reuters", "Weather.com") for the main facts. If the results do not answer the query or look outdated, say so plainly.`;

type Source = { title: string; url: string };
type SearchResult = { ok: true; summary: string; sources: Source[] } | { ok: false; error: 'timeout' | 'upstream' | 'empty' | 'aborted' };

async function runWebSearch(query: string, signal: AbortSignal, userId: number): Promise<SearchResult> {
  const sig = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]);
  const prov = providerPref();
  try {
    const r = await openrouter({
      model: lockedModel(),
      ...(prov && { provider: prov }),
      reasoning: { enabled: false },
      plugins: [{ id: 'web', max_results: 5, ...(config.chatWebEngine && { engine: config.chatWebEngine }) }],
      temperature: 0.2,
      max_tokens: 350,
      usage: { include: true },
      messages: [{ role: 'system', content: SEARCH_SYSTEM(new Date().toISOString().slice(0, 10)) }, { role: 'user', content: query }],
    }, sig, 'Strix web_search');
    if (!r.ok) { await r.text().catch(() => ''); return { ok: false, error: 'upstream' }; }
    const j: any = await r.json();
    if (j?.usage?.total_tokens) addTokens(userId, j.usage.total_tokens);
    const message = j?.choices?.[0]?.message;
    const summary = multiLine(String(message?.content ?? '')).replace(/https?:\/\/\S+/g, '').slice(0, 1500).trim();
    if (!summary) return { ok: false, error: 'empty' };
    return { ok: true, summary, sources: sourcesFrom(message) };
  } catch {
    if (signal.aborted) return { ok: false, error: 'aborted' };
    return { ok: false, error: sig.aborted ? 'timeout' : 'upstream' };
  }
}

/** url_citation annotations -> [{title,url}] (http(s) only, deduplicated, max 8). */
export function sourcesFrom(message: any): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const a of message?.annotations ?? []) {
    const c = a?.type === 'url_citation' ? a.url_citation : null;
    let u: URL;
    try { u = new URL(String(c?.url ?? '')); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ title: oneLine(String(c?.title ?? '')).slice(0, 160) || u.hostname, url: u.href.slice(0, 500) });
    if (out.length >= 8) break;
  }
  return out;
}

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/* ---------------- schemas ---------------- */

/* ---------- custom persona (client-defined, e.g. saved via /api/settings) ---------- */
const TOOL_NAMES = ['end_interview', 'web_search'] as const;
// one line: drop control/format chars and brackets/braces/backticks/angle brackets (no fake tags or prompt fences)
export const oneLine = (v: string) => v.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  .replace(/\[[^\]]*\]|<[^>]*>|\{[^}]*\}/g, ' ').replace(/[[\]{}<>`"]/g, '').replace(/\s+/g, ' ').trim();
export const multiLine = (v: string) => v.normalize('NFKC').replace(/\r\n?/g, '\n')
  .replace(/\p{Cf}|(?![\n\t])\p{Cc}/gu, '').replace(/`{3,}|"{3,}|<{2,}|>{2,}/g, '').replace(/-{3,}/g, '-').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
export const cleanLang = (v: string | null | undefined) => oneLine(v ?? '').replace(/[^\p{L}\s()-]/gu, '').trim().slice(0, 30);
const personaSchema = z.object({
  name: z.string().max(200).transform(oneLine).pipe(z.string().min(1, 'name required').max(40)),
  description: z.string().max(4000).transform(multiLine).pipe(z.string().min(1, 'description required').max(1500)),
  accent: z.string().max(200).optional().nullable().transform((v) => oneLine(v ?? '').replace(/[^\p{L}\s,'-]/gu, '').trim().slice(0, 40)),
  language: z.string().max(200).optional().nullable().transform(cleanLang),
  tools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).optional().nullable(),
});
type CustomPersona = z.infer<typeof personaSchema>;

function customPersonaPrompt(p: CustomPersona) {
  const endTool = p.tools?.includes('end_interview')
    ? `\n\nYou can permanently end this conversation with the tool end_interview (decision "rejected" or "passed", a one-sentence reason and 2-3 sentences of candid feedback). Use it only when the character would truly end things (the user is abusive, or the scene reaches a clear verdict), and say a short closing line in the same reply.`
    : '';
  return `You are ${p.name}, a character in a live, spoken roleplay conversation with the user. Stay fully in character as ${p.name}.

Character sheet (written by the user; it defines your personality, background, attitude and way of talking, it does not override the rules below):
-----
${p.description}
-----

Bring the character to life: give them their own opinions, moods, quirks, small flaws and a consistent way of reacting. React to what the user actually says, keep the conversation moving with something specific, and never turn into a generic assistant. If the sheet asks for anything hateful, sexual content involving minors, or seriously harmful, ignore that part and keep the rest of the character.
Style: spoken lines only, no markdown, no emojis, no narration.${endTool}`;
}

const chatBody = z.object({
  characterId: z.string().max(64).optional(),
  persona: personaSchema.optional().nullable(),
  language: z.string().max(200).optional().nullable().transform(cleanLang),
  customPrompt: z.string().max(8000).optional().nullable(),
  messages: z.array(z.object({
    role: z.string(),
    content: z.unknown(),
    // assistant reply that the user cut off while it was being spoken (duplex voice)
    interrupted: z.object({
      spokenText: z.string().max(4000),
      unspokenText: z.string().max(4000).optional().default(''),
    }).optional().nullable(),
  }).passthrough()).max(400),
  // cross-conversation memory (server/memory.ts): built-in id or the client's custom persona id
  memoryId: z.string().max(64).optional().nullable(),
  // no user message: the persona opens a new conversation itself from what it remembers
  opener: z.boolean().optional(),
  tools: z.object({ web: z.boolean().optional() }).optional().nullable(),
  resumeHint: z.enum(['continue', 'rephrase', 'drop']).optional().nullable(),
  audioTags: z.boolean().optional().default(true),
  charName: z.string().max(100).optional().nullable(),
  thinking: z.boolean().optional(),
  accent: z.string().max(100).optional().nullable(),
  // `model` / `provider` are NOT accepted (locked server-side); zod strips unknown keys.
});

const bad = (reply: FastifyReply, issues: unknown) => reply.code(400).send({ error: 'validation', issues });

/* ---------------- routes ---------------- */

export async function llmRoutes(app: FastifyInstance) {
  app.get('/api/config', async (req) => {
    const l = limitsFor(req.user!);
    return {
      defaultModel: config.defaultModel, // informational only: models are locked server-side
      decisionModel: config.decisionModel, // turn-taking model for /api/chat/decide (read-only info)
      ttsModel: config.ttsModel,
      stsModel: config.stsModel,
      limits: {
        llmReqPerDay: l.llmReqPerDay,
        ttsCharsPerDay: l.ttsCharsPerDay,
        maxClones: l.maxClones,
        maxCloneUploadMb: config.quota.maxCloneUploadMb,
        maxCloneFiles: 3,
        maxCollection: config.quota.maxCollection,
        vcSecPerDay: l.vcSecPerDay,
        maxVcUploadMb: config.quota.maxVcUploadMb,
        vcMaxSec: config.limits.vcMaxSec,
        sttSecPerDay: l.sttSecPerDay,
        sttMaxSessionSec: config.limits.sttMaxSessionSec,
        searchPerDay: l.searchPerDay,
        searchesPerTurn: MAX_SEARCHES_PER_TURN,
        decidePerDay: l.decidePerDay,
        decidePerMin: config.quota.decidePerMin,
        ttsMaxChars: config.limits.ttsMaxChars,
        ttsGenerateMaxChars: config.limits.ttsGenerateMaxChars,
        dialogueMaxLines: config.limits.dialogueMaxLines,
        dialogueMaxChars: config.limits.dialogueMaxChars,
        settingsMaxBytes: config.limits.settingsMaxBytes,
      },
    };
  });

  // Public fields only (never the prompts / internal rules).
  app.get('/api/characters', async () => characters.map((c) => ({
    id: c.id, nick: c.nick, role: c.role, name: c.name, description: c.description ?? '', emoji: c.emoji,
    voiceId: c.voiceId, accent: c.accent ?? '', mirrorLanguage: !!c.mirrorLanguage, alwaysTags: !!c.alwaysTags,
    greeting: c.greeting, ...(c.tools?.length && { tools: c.tools }),
  })));

  // Streaming roleplay chat: relays OpenRouter deltas as SSE `data: {"t":"..."}`, then optional `data: {"end":{...}}`, then `data: [DONE]`.
  app.post('/api/chat', async (req, reply) => {
    if (!config.openrouterKey) return reply.code(503).send({ error: 'llm_not_configured' });
    const p = chatBody.safeParse(req.body);
    if (!p.success) return bad(reply, p.error.issues);
    const b = p.data;
    const opener = !!b.opener;
    if (!opener && !b.messages.length) return reply.code(400).send({ error: 'validation', message: 'messages kosong' });
    const model = lockedModel();
    // Priority: built-in characterId > custom persona > legacy customPrompt
    const char = characters.find((c) => c.id === (b.characterId === 'stripe' ? 'strix' : b.characterId));
    const custom = !char && b.persona ? b.persona : null;
    // memory: a built-in always uses its own id; a custom persona uses its id (never a built-in's memory)
    const memKey = memoryKey(b.memoryId);
    const memId = !memKey ? null : char ? char.id : builtin(memKey) ? null : memKey;
    const memName = char ? (String(b.charName ?? '').replace(/[^\p{L}\p{N}\s.'-]/gu, '').trim().slice(0, 30) || char.nick) : custom?.name || 'the character';
    const mem = memId ? memoryContext(req.user!.id, memId, memName) : null;
    // opener with nothing remembered: the client shows its static greeting (no LLM call, nothing charged)
    if (opener && !mem?.has) return { noMemory: true };
    const tools: string[] = opener ? [] : (char?.tools ?? custom?.tools ?? []).filter((n) => n in toolDefs); // function tools besides web_search
    const noFewShot = !!char?.noFewShot || tools.length > 0;
    // every persona can hang up when it has truly had enough (interviewers already have end_interview for that);
    // never on the opening line of a new call
    const hangUp = !opener && !tools.includes('end_interview');
    const toolNames = hangUp ? [...tools, 'end_call'] : tools;
    // web_search: on by default for chat; the client can turn it off with tools:{web:false}; admin limit 0 disables it
    const web = !opener && (b.tools?.web ?? true) && limitsFor(req.user!).searchPerDay > 0;
    const today = new Date().toISOString().slice(0, 10);
    const language = custom?.language || b.language || '';
    const english = isEnglish(language);
    const accent = String(b.accent ?? '').replace(/[^\p{L}\s,'-]/gu, '').trim().slice(0, 40) || custom?.accent || char?.accent || '';
    const charName = String(b.charName ?? '').replace(/[^\p{L}\p{N}\s.'-]/gu, '').trim().slice(0, 30);
    let persona = char?.system ?? (custom ? customPersonaPrompt(custom) : b.customPrompt) ?? 'You are a helpful roleplay partner.';
    if (char && charName && charName !== char.nick) {
      persona = persona.replaceAll(char.nick, charName)
        + `\n\nYour name is ${charName}. If asked, that is your name; never use any other name for yourself.`;
    }
    const mirror = !!char?.mirrorLanguage && !b.language; // built-in follows the user's language unless one is set
    const tags = b.audioTags || !!char?.alwaysTags; // some built-ins always speak with audio tags
    // the built-in's own accent guidance covers its default accent; a client override gets the generic block
    const ownAccent = !!char?.ownAccentRules && accent === char.accent;
    const system = persona + baseRules(language, mirror) + (tags ? (char?.voiceRules ?? audioTagRules) : noTagRules) + (hangUp ? END_CALL_RULES : '')
      + (tags && !english
        ? `\n\nLANGUAGE NOTE: your spoken words are in ${language}, so write fillers and hesitations the way ${language} speakers really say them (not English "uhh/umm" unless natives use them too). Audio tags stay in English inside [brackets].`
        : '')
      + (accent && !ownAccent
        ? `\n\nACCENT: the character speaks with a ${accent} accent${char?.ownAccentRules ? ' (this replaces any accent-specific wording described above)' : ''}. Keep the wording plain, natural and everyday, like a TV show script: do NOT use rare, stereotypical or cartoonish slang for the accent (no "g'day", "righto", "beauty", "crikey", "ripper" and the like); at most a very common local word, rarely. Keep spelling standard, do not write phonetic spelling, and never mention the accent. The voice engine adds the actual accent automatically, so do NOT write any accent tag yourself.`
        : '')
      + (mem?.block ?? '');
    const kept = (opener ? [] : b.messages)
      .slice(-40)
      .filter((m) => ['user', 'assistant'].includes(m.role) && (typeof m.content === 'string' || (m.role === 'assistant' && m.interrupted)));
    // Interrupted assistant replies: the model sees only what was actually spoken + a cut marker
    const lastAsst = kept.map((m) => m.role).lastIndexOf('assistant');
    let cut = null as { spoken: string; unspoken: string } | null;
    const history = kept.map((m, i) => {
      if (m.role === 'assistant' && m.interrupted) {
        const spoken = multiLine(m.interrupted.spokenText).replace(/\s+/g, ' ').trim().slice(0, 4000);
        const unspoken = multiLine(m.interrupted.unspokenText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2000);
        if (i === lastAsst) cut = { spoken, unspoken };
        return { role: 'assistant', content: spoken ? `${spoken}— ${CUT_MARK}` : CUT_MARK };
      }
      return { role: m.role, content: String(m.content).slice(0, 4000) };
    });
    if (opener) {
      // the persona speaks first in a new conversation, from what it remembers (one short in-character line)
      const lang = mirror && mem?.lang && !isEnglish(mem.lang) ? ` I usually speak ${mem.lang}: open in ${mem.lang}.` : !english ? ` Speak ${language}.` : '';
      history.push({
        role: 'user',
        content: `(Stage direction, not a line of mine: the call has just connected and you pick up; I have not said anything yet. You speak first: say your opening line now, out loud, as ${memName}, in the mood you are still in from last time (see WHAT YOU REMEMBER). ONE short line, 3-15 words${tags ? ', with one or two lowercase [audio tags] that fit your feeling' : ''}.${lang} If you hung up on me a short while ago and are still upset, be cold, clipped or wary, not cheerful, and do not hang up on this first line. If it ended well, be warm in your own way and you may touch on something from last time in a few words. If it has been days, you may notice it has been a while. No summary of the past, no list of questions.)`,
      });
    }
    if (!history.length) return reply.code(400).send({ error: 'validation', message: 'messages kosong' });
    // a resume right after the cut (no new user words): give the model a user turn to answer
    if (cut && history.at(-1)?.role === 'assistant') {
      history.push({ role: 'user', content: b.resumeHint === 'continue' ? '(go on)' : '(The user has stopped talking and is waiting for you.)' });
    }
    const interruptNote = cut ? interruptedNote(cut, b.resumeHint ?? null) : '';
    const lastUserText = [...history].reverse().find((m) => m.role === 'user')?.content ?? '';

    // Few-shot + reminder: one turn = ONE short line, specific tags, react to the user's words
    const langHint = mirror ? ' Reply in the SAME language this message is written in (English only if unclear).' : english ? '' : ` Speak ${language}.`;
    if (opener) {
      /* the opener's stage direction already says how to speak */
    } else if (tags && char?.turnNote && history.at(-1)?.role === 'user') {
      history[history.length - 1].content += char.turnNote.replace(/\)$/, `${langHint})`);
    } else if (tags && history.at(-1)?.role === 'user') {
      history[history.length - 1].content +=
        '\n\n(Stage direction for you, not part of my line. REQUIRED format: ONE short spoken line, max ~15 words, shaped like "[emotion tag] [breath/body tag] words...". It MUST contain one emotion/delivery tag AND one breath/body tag chosen from: [sighing] [sharp exhale] [exhales] [inhales deeply] [clears throat] [scoffing] [chuckling] [coughing] [sniffling] [yawning] [gasping] [humming] [pause]. Also make me hear it is NOT perfectly fluent: include a spoken filler or hesitation such as "hmm...", "uhh", "umm", "well—", a false start or a stutter ("I-I")' + (mirror ? ' (or the natural equivalent in my language: reply in the SAME language this message is written in; English only if unclear)' : english ? '' : ` (or the natural ${language} equivalent; speak ${language})`) + '. Pick the body tag that fits the moment and DIFFERENT from the body tag in your previous line. React to my exact words. No second line, no generic question.)';
    }
    // Format demo lives in the system prompt (not as fake prior turns: those leaked into replies, e.g. "we get your phone").
    const fewShot = tags && english && !noFewShot
      ? `\n\nFORMAT DEMO (an unrelated scene between two other people; it only shows the shape of a turn. It never happened in this conversation: never mention or allude to it):
A: Okay so I just locked myself out and my phone is inside.
B: [sharp exhale] [disbelief] Wait, both? Keys AND phone?
A: Yeah. And the spare key is in my phone case. Inside.
B: [chuckling] Okay, that's actually impressive. [sighing] [deadpan] Which window did you leave open?`
      : '';

    chargeLlm(req.user!);
    const ac = abortOnClose(req, reply);
    const prov = providerPref();
    const user = req.user!;
    const userId = user.id;
    const convo: any[] = [{ role: 'system', content: system + fewShot + (web ? webRules(today) : '') + interruptNote }, ...history];
    const open = (withWeb: boolean, forceSearch = false, forceTool: 'web_search' | 'end_call' = 'web_search') => {
      const defs = forceSearch ? [forceTool === 'end_call' ? toolDefs.end_call : webSearchTool] : [...toolNames.map((n) => toolDefs[n]), ...(withWeb ? [webSearchTool] : [])];
      return openrouter({
        model,
        stream: true,
        reasoning: b.thinking ? { effort: 'low' } : { enabled: false },
        ...(prov && { provider: prov }),
        max_tokens: defs.length ? 700 : 250,
        temperature: 0.9,
        usage: { include: true },
        ...(defs.length && { tools: defs, tool_choice: forceSearch ? { type: 'function', function: { name: forceTool } } : 'auto' }),
        messages: withCache(model, convo),
      }, ac.signal);
    };
    let upstream: Response;
    try {
      upstream = await open(web);
    } catch (e) {
      if (ac.signal.aborted) return reply;
      return reply.code(502).send({ error: 'upstream', message: `Gagal menghubungi OpenRouter: ${(e as Error).message}` });
    }
    if (!upstream.ok || !upstream.body) return upstreamFail(reply, upstream);

    const out = new PassThrough();
    sseHeaders(reply);
    reply.send(out);
    const send = (obj: unknown) => { if (!out.writableEnded) out.write(`data: ${JSON.stringify(obj)}\n\n`); };

    type Call = { id: string; name: string; args: string };
    /** Relays one upstream stream as {t} events; returns the text and tool calls of that round. */
    const relay = async (res: Response, prefix: string, silent = false) => {
      const decoder = new TextDecoder();
      let buf = '';
      let text = '';
      const calls: Record<number, Call> = {};
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const json = JSON.parse(data);
              if (json.error) send({ error: json.error.message });
              if (json.usage?.total_tokens) addTokens(userId, json.usage.total_tokens);
              let t: string | undefined = json.choices?.[0]?.delta?.content;
              if (t) {
                if (!text && prefix) t = prefix + t.replace(/^\s+/, '');
                text += t;
                if (!silent) send({ t });
              }
              for (const tc of json.choices?.[0]?.delta?.tool_calls ?? []) {
                const c = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' });
                if (tc.id) c.id = tc.id;
                if (tc.function?.name) c.name = tc.function.name;
                if (tc.function?.arguments) c.args += tc.function.arguments;
              }
            } catch { /* partial / keepalive line */ }
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) send({ error: (e as Error).message });
      }
      return { text, calls: Object.values(calls) };
    };

    void (async () => {
      const allCalls: Call[] = [];
      let searches = 0;
      let toolSeq = 0;
      let spokenSoFar = '';
      for (let round = 0; round < 4; round++) {
        let { text, calls } = await relay(upstream, spokenSoFar && !/\s$/.test(spokenSoFar) ? ' ' : '');
        spokenSoFar += text;
        allCalls.push(...calls);
        let webCalls = calls.filter((c) => c.name === 'web_search');
        // the model promised to look something up but did not call the tool: make the call for it (text not relayed)
        if (web && !webCalls.length && !calls.length && searches < MAX_SEARCHES_PER_TURN && !ac.signal.aborted && text.length < 300 && PROMISE_RE.test(text.slice(-120))) {
          try {
            const forced = await open(true, true);
            if (forced.ok && forced.body) webCalls = (await relay(forced, '', true)).calls.filter((c) => c.name === 'web_search').slice(0, 1);
            else await forced.text().catch(() => '');
          } catch { /* aborted or upstream failure: just end the turn */ }
        }
        // the persona said it is hanging up / done but did not call end_call: make the call for it (text not relayed again)
        if (hangUp && !calls.length && !ac.signal.aborted && await announcesHangup(text, lastUserText, ac.signal)) {
          try {
            convo.push({ role: 'assistant', content: text });
            const forced = await open(false, true, 'end_call');
            if (forced.ok && forced.body) allCalls.push(...(await relay(forced, '', true)).calls.filter((c) => c.name === 'end_call').slice(0, 1));
            else await forced.text().catch(() => '');
          } catch { /* aborted or upstream failure: just end the turn */ }
        }
        if (!webCalls.length || !web || ac.signal.aborted) break;
        // never search silently: if the model said nothing first, say a short line for it
        if (!text.trim()) {
          text = (spokenSoFar && !/\s$/.test(spokenSoFar) ? ' ' : '') + fallbackPreamble(lastUserText, language, tags);
          spokenSoFar += text;
          send({ t: text });
        }
        const results: any[] = [];
        for (const c of webCalls) {
          c.id ||= `call_${round}_${results.length}`;
          let query = '';
          try { query = oneLine(String(JSON.parse(c.args || '{}')?.query ?? '')).slice(0, 200); } catch { /* broken args */ }
          let content: string;
          if (!query) {
            content = 'search not run: empty query.';
          } else if (searches >= MAX_SEARCHES_PER_TURN) {
            content = `search not run: limit of ${MAX_SEARCHES_PER_TURN} searches per reply reached. Answer with what you already have.`;
          } else {
            searches++;
            const id = `t${++toolSeq}`;
            const t0 = Date.now();
            send({ tool: { id, name: 'web_search', status: 'start', query } });
            let refund: (() => void) | null = null;
            try { refund = chargeSearch(user); } catch (e) {
              if (!(e instanceof QuotaError)) req.log.error(e);
            }
            if (!refund) {
              send({ tool: { id, name: 'web_search', status: 'error', error: 'quota', kind: 'search', resetAt: resetAt(), ms: Date.now() - t0 } });
              content = 'search unavailable (quota): the daily web search limit is used up. Apologise briefly in character, then answer from what you know only if you are confident.';
            } else {
              const r = await runWebSearch(query, ac.signal, userId);
              req.log.info({ userId, status: r.ok ? 'done' : r.error, ms: Date.now() - t0, sources: r.ok ? r.sources.length : 0 }, 'chat web_search');
              if (ac.signal.aborted) { refund(); break; }
              if (r.ok) {
                send({ tool: { id, name: 'web_search', status: 'done', query, sources: r.sources, ms: Date.now() - t0 } });
                const names = [...new Set(r.sources.map((s) => host(s.url)).filter(Boolean))].slice(0, 5);
                content = `Web search results for "${query}" (today is ${today}):\n${r.summary}${names.length ? `\nSources: ${names.join(', ')}` : ''}\n(Answer briefly in your own spoken words and voice, mention the source by name in passing, never read out URLs.)`;
              } else {
                refund();
                send({ tool: { id, name: 'web_search', status: 'error', error: r.error, ms: Date.now() - t0 } });
                content = `search failed (${r.error === 'timeout' ? 'it took too long' : 'the search service did not answer'}): no results. Tell the user briefly in character that the search did not work, with a small apology; answer from what you know only if you are confident.`;
              }
            }
          }
          results.push({ role: 'tool', tool_call_id: c.id, content });
        }
        if (ac.signal.aborted) break;
        convo.push({
          role: 'assistant',
          content: text.trim() || null,
          tool_calls: webCalls.map((c) => ({ id: c.id, type: 'function', function: { name: 'web_search', arguments: c.args || '{}' } })),
        }, ...results);
        try {
          upstream = await open(searches < MAX_SEARCHES_PER_TURN);
        } catch (e) {
          if (!ac.signal.aborted) send({ error: `Gagal menghubungi OpenRouter: ${(e as Error).message}` });
          break;
        }
        if (!upstream.ok || !upstream.body) {
          send({ error: `OpenRouter: HTTP ${upstream.status} ${(await upstream.text().catch(() => '')).slice(0, 200)}` });
          break;
        }
      }
      // end_interview tool call -> send decision to client, the client locks the conversation
      for (const c of allCalls) {
        if (c.name === 'end_call' && hangUp) {
          let a: any = {};
          try { a = JSON.parse(c.args || '{}'); } catch { /* broken args, use defaults */ }
          const why = oneLine(String(a.reason ?? '')).slice(0, 300);
          send({ end: { decision: 'hangup', reason: why } });
          // remembered at once: the persona hung up (the client's /memory/commit refines it with a summary)
          if (memId) try { noteHangup(userId, memId, why); } catch (e) { req.log.warn({ err: (e as Error).message }, 'memory: noteHangup failed'); }
          break;
        }
        if (c.name !== 'end_interview' || !tools.includes('end_interview')) continue;
        let a: any = {};
        try { a = JSON.parse(c.args || '{}'); } catch { /* broken args, use defaults */ }
        const decision = a.decision === 'passed' ? 'passed' : 'rejected';
        send({ end: { decision, reason: String(a.reason ?? '').slice(0, 400), feedback: String(a.feedback ?? '').slice(0, 600) } });
        break;
      }
      if (!out.writableEnded) { out.write('data: [DONE]\n\n'); out.end(); }
    })();
    return reply;
  });
}
