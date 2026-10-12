/* Turn-taking decisions for full-duplex voice chat: POST /api/chat/decide.
   1. fast rules (no LLM): noise, echo of the assistant's own voice, backchannels, stop words, "go on"/"lanjut" (EN + ID)
   2. otherwise a small locked LLM (OPENROUTER_DECISION_MODEL) with temperature 0, ~60 tokens, JSON, 1.5 s timeout
   3. on any LLM failure/timeout: heuristic fallback.
   Not counted as an LLM request: own per-user rate limit (RATE_DECIDE_PER_MIN, 120) and daily quota QUOTA_DECIDE_PER_DAY (3000). */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { addTokens, chargeDecide } from './quota.js';
import { openrouter } from './llm.js';
import { parseJsonObject } from './persona.js';

export const ACTIONS = ['ignore', 'backchannel', 'yield', 'stop', 'resume'] as const;
export const RESUMES = ['continue', 'rephrase', 'drop'] as const;
export type Action = typeof ACTIONS[number];
export type ResumeStyle = typeof RESUMES[number];
export interface Decision { action: Action; reason: string; resume?: ResumeStyle }

export const decideBody = z.object({
  personaName: z.string().max(100).optional().nullable(),
  state: z.enum(['speaking', 'listening', 'thinking', 'idle']),
  spoken: z.string().max(6000).default(''),
  remaining: z.string().max(6000).optional().nullable(),
  userPartial: z.string().max(1000),
  userFinal: z.boolean().optional(),
  speechMs: z.number().finite().min(0).max(600_000).optional(),
  lang: z.string().max(40).optional().nullable(),
});
export type DecideInput = z.infer<typeof decideBody>;

/* ---------------- text helpers ---------------- */
const stripTags = (s: string) => s.replace(/\[[^\]]{0,60}\]/g, ' ');
export function words(s: string): string[] {
  return stripTags(s).normalize('NFKC').toLowerCase()
    .replace(/(\p{L})[-'’](\p{L})/gu, '$1$2') // mm-hm -> mmhm, that's -> thats
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
}

// single-token backchannels / acknowledgements (EN + ID); elongations handled by regexes
const BC_WORDS = new Set([
  'yeah', 'yea', 'yep', 'yup', 'yes', 'ok', 'okay', 'okey', 'oke', 'okie', 'right', 'sure', 'cool', 'nice', 'wow', 'true',
  'totally', 'exactly', 'indeed', 'alright', 'gotcha', 'really', 'seriously', 'definitely', 'absolutely', 'fair', 'lol',
  'i', 'see', 'got', 'it', 'makes', 'sense', 'of', 'course', 'interesting', 'damn', 'oops', 'aw', 'aww', 'yay', 'great',
  'ya', 'iya', 'iyaa', 'sip', 'hooh', 'heeh', 'betul', 'bener', 'benar', 'wah', 'wih', 'mantap', 'gitu', 'begitu', 'kan',
  'loh', 'lho', 'kok', 'masa', 'masak', 'deh', 'dong', 'sih', 'juga', 'oalah', 'paham', 'ngerti', 'siap', 'okelah', 'yaya',
  'ih', 'anjir', 'astaga', 'ooh',
]);
const BC_RE = [/^m+h*m+$/, /^mh+m*$/, /^h+m+$/, /^(uh)+h?uh$/, /^u+h+u+h+$/, /^o+h+$/, /^o+$/, /^a+h+$/, /^a+ha+$/, /^ye+a*h+$/, /^ya+h*$/, /^ok+a*y+$/, /^(ha)+h?$/, /^(he)+h?$/, /^(wk)+w?k?$/, /^i+y+a+$/, /^wa+h+$/, /^wo+w+$/, /^o+ke+$/, /^s+i+p+$/];
const isBcWord = (w: string) => BC_WORDS.has(w) || BC_RE.some((r) => r.test(w));
const FILLER_RE = /^(u+h+|u+m+|e+r+m*|e+h+|e+|a+|e+m+|anu|eee+)$/; // hesitation sounds alone = not a turn yet

const STOP_PHRASES = [
  'stop', 'wait', 'hold on', 'hang on', 'shut up', 'be quiet', 'quiet', 'enough', 'thats enough', 'stop talking', 'pause',
  'one sec', 'one second', 'just a sec', 'just a second', 'a sec', 'a second', 'wait a sec', 'wait a second', 'wait a minute',
  'hold up', 'shh', 'shhh', 'sst', 'ssst', 'psst', 'never mind', 'nevermind', 'cancel', 'stop it', 'halt', 'silence',
  'bentar', 'sebentar', 'tunggu', 'tunggu dulu', 'bentar dulu', 'stop dulu', 'diam', 'diem', 'udah', 'udahan', 'sudah',
  'cukup', 'berhenti', 'jangan ngomong', 'sabar', 'tahan', 'gak usah', 'nggak usah', 'ga usah', 'ntar', 'nanti dulu',
];
const STOP_FILL = new Set(['ok', 'okay', 'oke', 'eh', 'oh', 'hey', 'hei', 'please', 'pls', 'tolong', 'ya', 'yah', 'no', 'nah', 'sorry', 'maaf', 'dulu', 'deh', 'dong', 'sih', 'aja', 'saja', 'a', 'sec', 'second', 'bit', 'moment', 'woy', 'woi', 'wey', 'ah', 'um', 'uh', 'just', 'lah', 'please']);

const RESUME_PHRASES = [
  'go on', 'continue', 'keep going', 'carry on', 'go ahead', 'you were saying', 'as you were saying', 'anyway', 'please continue',
  'sorry go ahead', 'sorry go on', 'sorry continue', 'proceed', 'and then', 'then what', 'what were you saying', 'keep talking',
  'lanjut', 'lanjutkan', 'lanjutin', 'terus', 'terusin', 'teruskan', 'silakan', 'silahkan', 'monggo', 'gimana tadi', 'tadi gimana',
  'tadi apa', 'lanjut aja', 'terus gimana', 'abis itu', 'habis itu', 'trus', 'trs', 'next', 'lanjut lagi', 'ayo lanjut',
];

/** True when `toks` is made only of phrases from `list` (+ filler words), e.g. "okay stop stop please". */
function onlyPhrases(toks: string[], list: string[], filler: Set<string>) {
  const phrases = list.map((p) => p.split(' ')).sort((a, b) => b.length - a.length);
  let i = 0; let hit = false;
  outer: while (i < toks.length) {
    for (const p of phrases) {
      if (p.every((w, k) => toks[i + k] === w)) { i += p.length; hit = true; continue outer; }
    }
    if (filler.has(toks[i])) { i++; continue; }
    return false;
  }
  return hit;
}

/** Echo of the assistant's own voice: the mic text is (mostly) a copy of what was just spoken. */
export function isEcho(user: string[], spoken: string) {
  if (!user.length || !spoken.trim()) return false;
  const sp = words(spoken).slice(-80);
  if (!sp.length) return false;
  if (user.length === 1) return !isBcWord(user[0]) && sp.slice(-10).includes(user[0]) && user[0].length > 2;
  const set = new Set(sp);
  const inSpoken = user.filter((w) => set.has(w)).length / user.length;
  // longest contiguous run of user words found in order in spoken
  let best = 0;
  for (let i = 0; i < user.length; i++) {
    for (let j = 0; j < sp.length; j++) {
      let k = 0;
      while (i + k < user.length && j + k < sp.length && user[i + k] === sp[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return inSpoken >= 0.8 && best >= Math.min(3, user.length);
}

/* ---------------- 1. rules ---------------- */
export function ruleDecide(b: DecideInput): Decision | null {
  const toks = words(b.userPartial);
  const remaining = (b.remaining ?? '').trim();
  const talking = b.state === 'speaking' || b.state === 'thinking';
  const final = b.userFinal ?? false;

  if (!toks.length || toks.every((w) => !/\p{L}/u.test(w))) return { action: 'ignore', reason: 'no words (noise)' };
  if (toks.every((w) => FILLER_RE.test(w)) && !(final && toks.length > 2)) return { action: 'ignore', reason: 'hesitation sound only' };
  if (talking && isEcho(toks, b.spoken)) return { action: 'ignore', reason: 'echo of assistant speech' };
  if (toks.length <= 5 && onlyPhrases(toks, STOP_PHRASES, STOP_FILL)) return { action: 'stop', reason: 'user asked to stop/wait' };
  if (toks.length <= 5 && onlyPhrases(toks, RESUME_PHRASES, STOP_FILL)) {
    if (talking) return { action: 'backchannel', reason: 'encouragement to keep going' };
    if (remaining) return { action: 'resume', resume: 'continue', reason: 'user asked to continue' };
  }
  if (toks.length <= 4 && toks.every(isBcWord)) {
    if (talking) return { action: 'backchannel', reason: 'listener feedback' };
    if (remaining) return { action: 'resume', resume: 'continue', reason: 'acknowledgement after interruption' };
    return null; // a short reply ("yeah") to a finished question is a real turn: let the LLM / fallback see it
  }
  // very short, not final, unknown words while the assistant talks: wait for more words
  if (talking && !final && toks.length <= 1) return { action: 'ignore', reason: 'too short yet, waiting for more' };
  if (talking && b.speechMs != null && b.speechMs < 250 && toks.length <= 2) return { action: 'ignore', reason: 'too brief to be a turn' };
  return null;
}

/* ---------------- 3. heuristic fallback ---------------- */
export function fallbackDecide(b: DecideInput): Decision {
  const toks = words(b.userPartial);
  const talking = b.state === 'speaking' || b.state === 'thinking';
  const remaining = (b.remaining ?? '').trim();
  if (toks.length && toks.length <= 4 && toks.every(isBcWord)) return talking ? { action: 'backchannel', reason: 'fallback: backchannel list' } : { action: 'yield', reason: 'fallback: short reply' };
  if (talking) return toks.length >= 3 ? { action: 'yield', reason: 'fallback: 3+ words' } : { action: 'ignore', reason: 'fallback: too short' };
  if (!toks.length) return { action: 'ignore', reason: 'fallback: empty' };
  if (remaining) return { action: 'resume', resume: toks.length <= 6 ? 'rephrase' : 'drop', reason: 'fallback: after interruption' };
  return { action: 'yield', reason: 'fallback: user turn' };
}

/* ---------------- 2. LLM ---------------- */
export const DECIDE_SYSTEM = `You decide turn-taking in a live VOICE conversation between a user and an AI character, from the live speech-to-text of the user's microphone. Output ONLY a JSON object: {"action":"...","resume":"...","reason":"..."}

Input: state = what the assistant is doing now; spoken = what the assistant has already said out loud in its current reply; remaining = what it still planned to say but has not said; user = what the microphone heard (may be partial or noisy, any language).

action:
- "ignore": noise, nonsense, a fragment with no meaning yet, talk clearly not addressed to the assistant, or the assistant's own voice picked up by the mic (the user text repeats words of "spoken").
- "backchannel": short listener feedback that does not take the turn ("mm-hm", "yeah", "oh really?", "right", "no way", "haha", "iya", "oh gitu", "wah"). The assistant keeps talking.
- "yield": the user takes the turn with real content: a question, objection, correction, new information, or the start of a sentence with content ("but what about", "no that's wrong", "eh tapi", "maksudnya apa"). The assistant stops and listens.
- "stop": the user asks the assistant to stop, wait or be quiet ("stop", "wait", "hold on", "bentar", "diam").
- "resume": ONLY when state is listening or idle AND remaining is not empty (the assistant was cut off). Also set "resume":
  "continue" = the user says go on / lanjut or only acknowledged;
  "rephrase" = the interjection was a short reaction or clarification about what was being said (assistant answers it, then repeats the cut-off part more briefly);
  "drop" = the user changed topic or asked something unrelated (forget the rest).
With state speaking or thinking, use only ignore, backchannel, yield or stop. With state listening/idle and empty remaining, use ignore, stop or yield.
"resume" is "" unless action is "resume". reason: max 8 English words.`;

const llmOut = z.object({
  action: z.enum(ACTIONS),
  resume: z.string().optional().nullable(),
  reason: z.string().optional().nullable(),
});

const clipEnd = (s: string, n: number) => (s.length > n ? '…' + s.slice(-n) : s);
const clipStart = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export function decideUserMessage(b: DecideInput) {
  const q = (s: string) => JSON.stringify(stripTags(s).replace(/\s+/g, ' ').trim());
  return [
    `state: ${b.state}`,
    `spoken: ${q(clipEnd(b.spoken ?? '', 400))}`,
    `remaining: ${q(clipStart(b.remaining ?? '', 240))}`,
    `user: ${q(b.userPartial.slice(0, 300))} (${b.userFinal ? 'final' : 'partial'}${b.speechMs != null ? `, ${Math.round(b.speechMs)} ms of speech` : ''})`,
    b.lang ? `language hint: ${String(b.lang).slice(0, 30)}` : '',
  ].filter(Boolean).join('\n');
}

/** Normalise a model answer into a valid Decision for this state (or null if unusable). */
export function sanitize(raw: unknown, b: DecideInput): Decision | null {
  const p = llmOut.safeParse(raw);
  if (!p.success) return null;
  let { action } = p.data;
  const reason = String(p.data.reason ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 120) || 'llm';
  const talking = b.state === 'speaking' || b.state === 'thinking';
  const remaining = !!(b.remaining ?? '').trim();
  if (action === 'resume' && (talking || !remaining)) action = 'yield';
  if (action === 'backchannel' && !talking) action = remaining ? 'resume' : 'yield';
  // after a cut-off the frontend always needs a resume style: a short interjection = clarification, a long one = new topic
  if (action === 'yield' && !talking && remaining) {
    return { action: 'resume', resume: words(b.userPartial).length <= 6 ? 'rephrase' : 'drop', reason };
  }
  if (action !== 'resume') return { action, reason };
  const r = String(p.data.resume ?? '').toLowerCase();
  return { action, reason, resume: (RESUMES as readonly string[]).includes(r) ? r as ResumeStyle : 'rephrase' };
}

export async function llmDecide(b: DecideInput, signal: AbortSignal, model = config.decisionModel, userId?: number): Promise<Decision | null> {
  const r = await openrouter({
    model,
    temperature: 0,
    max_tokens: 60,
    reasoning: { enabled: false },
    response_format: { type: 'json_object' },
    provider: { sort: 'latency', allow_fallbacks: true },
    usage: { include: true },
    messages: [{ role: 'system', content: DECIDE_SYSTEM }, { role: 'user', content: decideUserMessage(b) }],
  }, signal, 'Strix decide');
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (userId && j?.usage?.total_tokens) addTokens(userId, j.usage.total_tokens);
  return sanitize(parseJsonObject(String(j?.choices?.[0]?.message?.content ?? '')), b);
}

export const DECIDE_TIMEOUT_MS = 1500;

/* ---------------- per-user rate limit (in memory, sliding 60 s window) ---------------- */
const hits = new Map<number, number[]>();
function rateOk(userId: number, max: number) {
  const now = Date.now();
  const arr = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (arr.length >= max) { hits.set(userId, arr); return Math.ceil((60_000 - (now - arr[0])) / 1000); }
  arr.push(now);
  hits.set(userId, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 60_000) hits.delete(k);
  return 0;
}

export async function decideRoutes(app: FastifyInstance) {
  // generous per-IP limit here (the global /api limit would be too tight for a call per speech partial); per-user limit below
  app.post('/api/chat/decide', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
    const p = decideBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const b = p.data;
    const user = req.user!;
    const wait = rateOk(user.id, config.quota.decidePerMin);
    if (wait) return reply.code(429).send({ error: 'rate_limited', retryAfter: `${wait} seconds` });
    chargeDecide(user); // QuotaError -> 429 {error:'quota', kind:'decide'}
    const t0 = Date.now();
    const rule = ruleDecide(b);
    if (rule) return { ...rule, source: 'rule', ms: Date.now() - t0 };
    if (!config.openrouterKey) return { ...fallbackDecide(b), source: 'fallback', ms: Date.now() - t0 };

    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.sent) ac.abort(); });
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(DECIDE_TIMEOUT_MS)]);
    const models = [...new Set([config.decisionModel, config.defaultModel])]; // decision model, then the chat model
    for (const model of models) {
      try {
        const d = await llmDecide(b, signal, model, user.id);
        if (d) return { ...d, source: 'llm', ms: Date.now() - t0 };
        req.log.warn({ model }, 'decide: unreadable model JSON');
      } catch (e) {
        if (ac.signal.aborted) return reply;
        req.log.warn({ model, err: (e as Error).message }, 'decide: llm failed');
      }
      if (signal.aborted || Date.now() - t0 > DECIDE_TIMEOUT_MS - 400) break; // no time left for the fallback model
    }
    return { ...fallbackDecide(b), source: 'fallback', ms: Date.now() - t0 };
  });
}
