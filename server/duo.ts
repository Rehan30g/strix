/* Group calls ("call over"): the user on ONE call with up to DUO_MAX_PERSONAS personas (built-in Strix / Lena or the
   user's own custom personas). See SPEC-DUO.md and CONTRACT-NOTES.md "Duo".
   - POST /api/duo/turn (SSE): a small DIRECTOR picks who speaks (rules first, the decision model only when it is not
     obvious; never charged), then ONE persona replies with its own prompt + the DUO block (named transcript) + its memory.
     Events: {speaker} -> {t}... -> {end} (that persona left) / {call} (it phones someone) -> {next} -> [DONE].
     Each persona reply = 1 LLM request (chargeLlm). Caps: DUO_MAX_PERSONA_TURNS per call, DUO_MAX_CHAIN (6) persona turns in a row
     without the user, 1 outgoing persona call per call. No web search here.
   - POST /api/duo/ring (JSON): someone (the user or a persona on the call) rings a persona. While it rings, a persona
     ALREADY on the call reacts out loud (the callee's enemy first, else whoever spoke last; never the caller itself); the
     callee says nothing until it picks up (then it greets through /duo/turn join). The callee answers / declines / lets it
     ring by a weighted roll (relationship, its remembered mood, who calls, retries, a little chance); when it does not
     answer, the reacting persona also gets an `after` line. 1 call (DUO_MAX_CALLS_PER_DAY) + 1 LLM request when someone
     reacts. A call not taken is remembered by the callee (memory.ts noteMissed). */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { config } from './config.js';
import { characters, baseRules, audioTagRules, isEnglish, type Character } from './characters.js';
import {
  openrouter, oneLine, multiLine, cleanLang, abortOnClose, sseHeaders, upstreamFail, withCache, providerPref, lockedModel,
  CUT_MARK, interruptedNote, announcesHangup, announcesCall, personaSchema, customPersonaPrompt, callableSchema, callPersonaTool, callRules, parseCall,
  type Callable,
} from './llm.js';
import { addTokens, chargeCall, chargeLlm, limitsFor, refundLlm } from './quota.js';
import { memoryContext, memoryKey, noteHangup, noteMissed, relationNow, connectedTo } from './memory.js';
import { canUseVoice } from './eleven.js';
import { parseJsonObject } from './persona.js';

/* ---------------- participants ---------------- */
const ID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const participantSchema = z.object({
  id: ID,
  kind: z.enum(['builtin', 'custom']),
  // built-in: optional language override (the user's per-persona setting); custom: the persona itself
  language: z.string().max(200).optional().nullable().transform(cleanLang),
  persona: personaSchema.extend({ voiceId: z.string().max(64).optional().nullable() }).optional().nullable(),
});
type ParticipantIn = z.infer<typeof participantSchema>;

/** Feuds between built-ins (their backstory is in their own prompts). */
const ENEMIES: Record<string, string[]> = { strix: ['lena'], lena: ['strix'] };
const isEnemy = (a: string, b: string) => !!ENEMIES[a]?.includes(b);

interface Part {
  id: string; kind: 'builtin' | 'custom'; name: string; char: Character | null; system: string; voiceRules: string;
  language: string; mirror: boolean; accent: string; bio: string; style: string;
}
/** Built-in voices of the two personas in a duo: how each must sound so they never blur into one voice. */
const STYLE: Record<string, string> = {
  strix: 'warm but nervous and evasive, especially around Lena: you hedge, restart sentences, deflect with an awkward joke, change the subject, get defensive when cornered; your hesitations (uhh..., umm..., I mean—) are part of you. Never clever-cold, never smooth',
  lena: 'sharp, dry and cold-polite: clean fluent lines, no stumbling and no filler, very polite words that cut ("Sorry, no, go on, I love this story."), the barb lands at the end. Never nervous, never rambling',
};

function resolve(userId: number, p: ParticipantIn): Part | string {
  if (p.kind === 'builtin') {
    const id = p.id === 'stripe' ? 'strix' : p.id;
    const char = characters.find((c) => c.id === id);
    if (!char) return `unknown built-in persona: ${p.id}`;
    return {
      id, kind: 'builtin', name: char.nick, char, system: char.system, voiceRules: char.voiceRules ?? audioTagRules,
      language: p.language || '', mirror: !!char.mirrorLanguage && !p.language, accent: char.accent ?? '',
      bio: oneLine(char.description ?? char.role).slice(0, 220), style: STYLE[id] ?? '',
    };
  }
  const id = memoryKey(p.id);
  if (!id || characters.some((c) => c.id === id) || !p.persona) return `invalid custom persona: ${p.id}`;
  const c = p.persona;
  return {
    id, kind: 'custom', name: c.name, char: null, system: customPersonaPrompt({ ...c, tools: [] }), voiceRules: audioTagRules,
    language: c.language || '', mirror: false, accent: c.accent || '', bio: oneLine(c.description).slice(0, 220),
    style: 'true to your own character sheet, with your own rhythm and words',
  };
}
async function resolveAll(userId: number, list: ParticipantIn[]): Promise<Part[] | string> {
  const out: Part[] = [];
  for (const p of list) {
    const r = resolve(userId, p);
    if (typeof r === 'string') return r;
    if (out.some((x) => x.id === r.id)) return `duplicate participant: ${r.id}`;
    const v = p.kind === 'custom' ? p.persona?.voiceId : null;
    if (v && !(await canUseVoice(userId, v))) return 'voice_forbidden';
    out.push(r);
  }
  return out;
}

/* ---------------- per-call state (in memory; a restart only loosens the caps of calls that were running) ---------------- */
interface Left { how: 'storm_out' | 'quiet'; because: 'user' | 'other' | 'self'; reason: string; at: number }
interface CallState {
  turns: number; chain: number; userKey: string; callsMade: number; rings: Record<string, number>; at: number;
  /** small random "things on your mind" per persona, picked once per call (variety between calls) */
  seeds: Record<string, string[]>;
  /** who left this call, how and why (ring decisions and the greeting after a call-back use it) */
  left: Record<string, Left>;
  /** the user went quiet and the personas were nudged: their exchange may run up to DUO_MAX_CHAIN lines (else ~3) */
  nudged: boolean;
}
const calls = new Map<string, CallState>();
function callState(userId: number, callId: string): CallState {
  const k = `${userId}:${callId}`;
  let s = calls.get(k);
  if (!s) {
    s = { turns: 0, chain: 0, userKey: '', callsMade: 0, rings: {}, at: Date.now(), seeds: {}, left: {}, nudged: false };
    calls.set(k, s);
    if (calls.size > 3000) { const cut = Date.now() - 6 * 3_600_000; for (const [kk, v] of calls) if (v.at < cut) calls.delete(kk); }
  }
  s.at = Date.now();
  return s;
}

/* ---------------- transcript ---------------- */
const msgSchema = z.object({
  role: z.enum(['user', 'assistant', 'event']),
  speaker: ID.optional().nullable(),
  content: z.string().max(4000),
  interrupted: z.object({ spokenText: z.string().max(4000), unspokenText: z.string().max(4000).optional().default('') }).optional().nullable(),
});
type Msg = z.infer<typeof msgSchema>;
const tagless = (s: string) => s.replace(/\[[^\]]{0,60}\]/g, ' ').replace(/\s+/g, ' ').trim();
const said = (m: Msg) => multiLine(m.interrupted ? m.interrupted.spokenText : m.content).replace(/\s+/g, ' ').trim().slice(0, 1500);
/** persona lines since the last user line (events do not count) */
function chainOf(msgs: Msg[]) {
  let n = 0;
  for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].role === 'user') break; if (msgs[i].role === 'assistant') n++; }
  return n;
}
const lastPersona = (msgs: Msg[]) => [...msgs].reverse().find((m) => m.role === 'assistant') ?? null;
const lastReal = (msgs: Msg[]) => [...msgs].reverse().find((m) => m.role !== 'event') ?? null;
function mentions(text: string, parts: Part[]): Part[] {
  const t = tagless(text);
  return parts.map((p) => ({ p, i: t.search(new RegExp(`(^|[^\\p{L}])${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'iu')) }))
    .filter((x) => x.i >= 0).sort((a, b) => a.i - b.i).map((x) => x.p);
}

/* ---------------- the director ---------------- */
interface Pick { next: string; hint: string; source: 'rule' | 'llm' | 'fallback'; ms?: number; /** ask the director among these (speculating on next) */ llm?: string[] }
const DIRECTOR_SYSTEM = `You direct the turn order of a live group VOICE call between a user and some characters. Decide who speaks next so it sounds like a real, lively conversation, not an interview. Output ONLY JSON {"next":"<id or user>"}.
- "user": the last line clearly asked the user something or spoke to the user, invited the user's opinion, or the characters' exchange has run its course and it is naturally the user's turn.
- a character id: that character was addressed, accused, mocked or asked by the last line, or would naturally jump in to react (a jab begs a comeback; a dodge begs a push; a story begs a reaction). While the user is quiet, the characters are allowed to keep a lively exchange going between themselves for several lines (up to the limit given) instead of handing back to the user after every line.
Never pick the character who spoke the last line. Pick only from the allowed list.`;

/* ---------------- topic seeds: a few small things on each persona's mind, different every call ---------------- */
const SEEDS_ANY = [
  'something small that went wrong (or right) today', 'what you ate today, or are craving', 'where you are right now and what is around you (the room, the weather, a noise)',
  'a question you are honestly curious to ask {other} about their life these days', 'a bit of news or gossip you heard lately', 'a plan (or a lack of one) for the weekend',
  'a tiny story from this week', 'something the user said earlier that stuck with you', 'a light tease about someone on the call', 'a habit or hobby you are into lately (no brand or title names)',
  'a strong opinion about something completely trivial', 'how tired / wired / cheerful you are tonight, and why', 'a small worry you have not told anyone', 'something that made you laugh recently',
];
const SEEDS_OWN: Record<string, string[]> = {
  strix: ["the kids' latest game", 'the school run chaos', "your partner's terrible idea this week", 'a bad dad joke you have been saving'],
  lena: ["your son's dinner demands", 'the group chat drama', 'the meeting that should have been an email', 'something at work you fixed and nobody noticed'],
};
const SEEDS_FEUD = ['one of the old Tuesday-night shows (a good memory, before it soured)', 'the two coffees', 'how {other} sounds these days', 'a caller from the old show you both remember'];
function seedsFor(st: CallState, me: Part, parts: Part[]): string[] {
  if (st.seeds[me.id]) return st.seeds[me.id];
  const pick = <T,>(a: T[], n: number) => [...a].sort(() => Math.random() - 0.5).slice(0, n);
  const other = parts.find((p) => p.id !== me.id)?.name ?? 'the others';
  const enemy = parts.find((p) => isEnemy(me.id, p.id));
  const out = [...pick(SEEDS_ANY, 2), ...pick(SEEDS_OWN[me.id] ?? [], 1), ...(enemy && Math.random() < 0.6 ? pick(SEEDS_FEUD, 1) : [])]
    .map((s) => s.replaceAll('{other}', enemy?.name ?? other));
  return (st.seeds[me.id] = out);
}

/* ---------------- leaving: the persona's own decision (storm out / quiet exit), never right after a promise to stay ---------------- */
const STAY_RE = /\b(i (won'?t|will not|am not|'?m not) (gonna |going to )?(hang up|leave|go anywhere|bail|walk out|run off)|i'?ll stay|i'?m staying|not going anywhere|i promise)\b/i;
/** Did `me` promise to stay in its own last few lines? */
const promisedStay = (msgs: Msg[], me: string) => msgs.filter((m) => m.role === 'assistant' && m.speaker === me).slice(-4).some((m) => STAY_RE.test(tagless(said(m))));
const LEAVE_RE = /\b(hang(?:ing)? up|i'?m (?:done|out|off|leaving|out of here|gonna go|going to go|heading off)|we'?re (?:done|finished)|i'?ll (?:leave|go|head off|hop off|let you (?:two|guys|all|both)\b)|let you (?:two|guys|all|both) (?:talk|chat|catch up|get on with it)|leave you (?:two|to it)|(?:gotta|got to|have to|need to) go|put the kettle on|bye(?: for now)?|catch you later|see you(?: later)?|night,? (?:all|everyone)|i'?m hanging up)\b/i;
async function announcesLeave(text: string, lastOther: string, signal: AbortSignal): Promise<boolean> {
  const tail = text.slice(-220);
  if (!LEAVE_RE.test(tail)) return false;
  try {
    const r = await openrouter({
      model: config.decisionModel, stream: false, temperature: 0, max_tokens: 20, reasoning: { enabled: false }, provider: { sort: 'latency', allow_fallbacks: true },
      messages: [
        { role: 'system', content: 'You judge one line of a spoken group call. Reply ONLY with JSON {"leaving":true} or {"leaving":false}. leaving is true ONLY if the speaker, in this very reply, is leaving / hanging up / stepping off the call RIGHT NOW (angrily or politely, e.g. "I\'m done, bye", "I\'ll let you two talk", "I\'m gonna go put the kettle on, night"). False for threats or conditions ("one more word and I\'m gone"), promises to stay, questions, or talk about someone else leaving.' },
        { role: 'user', content: `Someone else last said: ${lastOther.slice(0, 300)}\nThe speaker's reply: ${tail}` },
      ],
    }, AbortSignal.any([signal, AbortSignal.timeout(2500)]), 'Strix duo leave check');
    if (!r.ok) return false;
    const j: any = await r.json();
    const o = JSON.parse(String(j?.choices?.[0]?.message?.content ?? '').match(/\{[\s\S]*\}/)?.[0] ?? '{}');
    return o.leaving === true;
  } catch { return false; }
}

async function llmDirect(parts: Part[], present: string[], msgs: Msg[], allowed: string[], signal: AbortSignal, userId: number): Promise<string | null> {
  const nameOf = (id?: string | null) => parts.find((p) => p.id === id)?.name ?? 'someone';
  const lines = msgs.slice(-8).map((m) => m.role === 'event' ? `(${oneLine(m.content).slice(0, 160)})` : `${m.role === 'user' ? 'User' : nameOf(m.speaker)}: ${tagless(said(m)).slice(0, 300)}`);
  const user = [
    `Characters on the call: ${present.map((id) => `${nameOf(id)} (id ${id})`).join(', ')}.`,
    `Character lines since the user last spoke: ${chainOf(msgs)} (at most ${config.duo.maxChain} before the user must get the turn).`,
    `Recent lines:\n${lines.join('\n')}`,
    `Allowed answers: ${allowed.map((a) => `"${a}"`).join(', ')}.`,
  ].join('\n');
  try {
    const r = await openrouter({
      model: config.decisionModel, temperature: 0, max_tokens: 30, reasoning: { enabled: false },
      response_format: { type: 'json_object' }, provider: { sort: 'latency', allow_fallbacks: true }, usage: { include: true },
      messages: [{ role: 'system', content: DIRECTOR_SYSTEM }, { role: 'user', content: user }],
    }, AbortSignal.any([signal, AbortSignal.timeout(1100)]), 'Strix duo director');
    if (!r.ok) { await r.text().catch(() => ''); return null; }
    const j: any = await r.json();
    if (j?.usage?.total_tokens) addTokens(userId, j.usage.total_tokens);
    const o: any = parseJsonObject(String(j?.choices?.[0]?.message?.content ?? ''));
    const n = String(o?.next ?? '').toLowerCase();
    return allowed.find((a) => a.toLowerCase() === n) ?? null;
  } catch { return null; }
}

/** Who speaks now (before streaming). null = the user's turn (nothing to stream). */
async function pickSpeaker(a: {
  parts: Part[]; present: string[]; msgs: Msg[]; join: { id: string; caller: string } | null; opener: boolean;
  nudge: 'silence' | 'goodbye' | null; want: string | null; resumeHint: string | null; signal: AbortSignal; userId: number; left: Record<string, Left>;
}): Promise<Pick | null> {
  const { parts, present, msgs } = a;
  const P = (id: string) => parts.find((p) => p.id === id)!;
  const here = parts.filter((p) => present.includes(p.id));
  if (!here.length) return null;
  const last = lastReal(msgs);
  const lp = lastPersona(msgs);
  const others = (id?: string | null) => here.filter((p) => p.id !== id);
  if (a.join && present.includes(a.join.id)) {
    const by = a.join.caller === 'user' ? 'the user' : P(a.join.caller)?.name ?? 'someone';
    const rest = others(a.join.id).map((p) => p.name);
    const lf = a.left[a.join.id];
    const back = lf ? ` You LEFT this same call ${Math.max(1, Math.round((Date.now() - lf.at) / 60_000))} min ago (${lf.how === 'storm_out' ? 'you stormed out' : 'you slipped out quietly'}${lf.reason ? `: ${lf.reason}` : ''}) and now you picked up again: let that show.` : '';
    return { next: a.join.id, source: 'rule', hint: `You have just picked up: ${by} called you${rest.length ? `, and ${rest.join(' and ')} ${rest.length > 1 ? 'are' : 'is'} on the line too` : ''}.${back} Say your first line now, in your mood: greet or don't, react to who is on this call.` };
  }
  if (a.opener || !last) return { next: here[0].id, source: 'rule', hint: 'The call has just connected. Say your opening line.' };
  // "go on" after the user cut someone off: the same persona carries on
  if (a.resumeHint === 'continue' && last.role === 'assistant' && last.interrupted && present.includes(last.speaker ?? '')) {
    return { next: last.speaker!, source: 'rule', hint: 'The user wants you to carry on where you were cut off.' };
  }
  if (last.role === 'user') {
    const named = mentions(last.content, here);
    if (named.length) return { next: named[0].id, source: 'rule', hint: `The user just spoke to you by name.` };
    if (here.length === 1) return { next: here[0].id, source: 'rule', hint: 'React to what the user just said.' };
    const before = msgs[msgs.lastIndexOf(last) - 1];
    if (before?.role === 'assistant' && before.interrupted && present.includes(before.speaker ?? '')) {
      return { next: before.speaker!, source: 'rule', hint: 'The user just cut you off to say this; react and answer them.' };
    }
    const fb = lp && present.includes(lp.speaker ?? '') ? lp.speaker! : here[0].id;
    return { next: fb, source: 'fallback', hint: 'React to what the user just said (and to the others, if it fits).', llm: here.map((p) => p.id) };
  }
  // a persona spoke last: another persona carries on (never the same one twice in a row unless it is alone)
  const cands = others(lp?.speaker).length ? others(lp?.speaker) : here;
  if (a.nudge === 'goodbye') {
    const who = cands.find((p) => p.id === a.want) ?? cands[0];
    return { next: who.id, source: 'rule', hint: 'The user has not said anything for a few minutes. Wrap the call up politely in character, for everyone: ONE short line that you will let them go (e.g. "we will let you go"), maybe a tiny goodbye. Do not ask anything.' };
  }
  if (a.nudge) {
    const who = cands.find((p) => p.id === a.want) ?? cands[Math.floor(Math.random() * cands.length)];
    const rest = others(who.id).map((p) => p.name);
    return { next: who.id, source: 'rule', hint: `Nobody has said anything for a few seconds. Do not just fill the silence: take the conversation somewhere. Bring up something on your mind (see THINGS ON YOUR MIND), ask ${rest.length ? rest.join(' or ') : 'the user'} something real, tell a tiny story, comment on where you are, bring up a shared memory or news you heard, or tease someone${rest.length ? '' : ''}. Or pull the user in naturally by name if you know it (\"you're quiet\"), without repeating a question you already asked them. Not the same topic as the last few lines.` };
  }
  const lpName = P(lp?.speaker ?? '')?.name ?? 'Someone';
  if (a.want && cands.some((p) => p.id === a.want)) {
    return { next: a.want, source: 'rule', hint: `${lpName} just spoke; react to them or to the user, whatever is natural.` };
  }
  const named = lp ? mentions(lp.content, cands) : [];
  if (named.length) return { next: named[0].id, source: 'rule', hint: `${lpName} just spoke to you.` };
  return { next: cands[0].id, source: 'fallback', hint: '' };
}

/** After a persona line: does another persona jump in, or is it the user's turn? */
async function pickNext(a: { parts: Part[]; present: string[]; msgs: Msg[]; speaker: string; left: boolean; called: boolean; signal: AbortSignal; userId: number; limit: number }): Promise<{ next: string; source: string }> {
  const { parts, present, msgs } = a;
  const here = parts.filter((p) => present.includes(p.id));
  const others = here.filter((p) => p.id !== a.speaker);
  const chain = chainOf(msgs);
  if (a.called || !others.length || chain >= config.duo.maxChain) return { next: 'user', source: 'rule' };
  if (a.left) return { next: others[0].id, source: 'rule' };      // someone just walked out: the rest react
  // right after the user: a short back-and-forth (~3 lines), then the user again; when the user has gone quiet (nudged)
  // the personas may carry their own conversation on up to DUO_MAX_CHAIN lines
  if (chain >= a.limit) return { next: 'user', source: 'rule' };
  const line = tagless(said(msgs[msgs.length - 1]));
  const named = mentions(line, others);
  if (named.length) return { next: named[0].id, source: 'rule' };
  const llm = await llmDirect(parts, present, msgs, [...others.map((p) => p.id), 'user'], a.signal, a.userId);
  if (llm) return { next: llm, source: 'llm' };
  return { next: chain <= 2 ? others[0].id : 'user', source: 'fallback' };
}

/* ---------------- discomfort: a nudge toward leaving when it is really getting to someone ---------------- */
const HOT_RE = /\[(?:[^\]]*\b(?:angry|furious|cold|bitter|sharp exhale|snapping|through gritted teeth|raised voice|shouting|hurt|scoffs?|irritated|annoyed|tense|defensive|sulky)\b[^\]]*)\]|\b(coward|liar|you always|you never|fuck|shit|don'?t you dare|not doing this|low blow|that'?s not fair)\b/i;
/** A short private cue for `me` when the room has been hostile for a while (the ladder is real: only after several heated
    lines, never on the first jab), or when `me` is the third person stuck in someone else's fight. '' otherwise. */
function discomfortHint(me: Part, parts: Part[], present: string[], msgs: Msg[]): string {
  const recent = msgs.filter((m) => m.role !== 'event').slice(-6);
  const heat = recent.filter((m) => HOT_RE.test(m.role === 'assistant' ? said(m) : m.content)).length;
  const mine = recent.filter((m) => m.role === 'assistant' && m.speaker === me.id);
  const myHeat = mine.filter((m) => HOT_RE.test(said(m))).length;
  const here = parts.filter((p) => present.includes(p.id) && p.id !== me.id);
  const feud = here.some((a) => here.some((b) => a.id !== b.id && isEnemy(a.id, b.id)));
  if (feud && !here.some((p) => isEnemy(me.id, p.id)) && heat >= 2) {
    // it already hinted at going ("should I go check the oven?", "I'm not the referee") and the fight goes on: now it goes
    const hinted = mine.some((m) => /\b(should i|maybe i should|i'?ll (just )?(go|leave|let you)|not the referee|check on the oven|in the middle|leave you (two|to it)|uncomfortable)\b|\[(uncomfortable|awkward[^\]]*|sheepish|gulps)\]/i.test(said(m)));
    if (hinted && heat >= 3) return ' (Private: you already hinted you would rather not be here, and the fight is still going. Now actually go: one short polite goodbye line, then end_call with how "quiet", because "other".)';
    return ' (Private: you are the third person stuck in the middle of someone else\'s fight. If you feel in the way or uncomfortable, a polite quiet exit is completely fine, or try to change the subject once.)';
  }
  if (heat >= 3 && myHeat >= 2) {
    return ' (Private: this has been getting to you for several lines now. If it keeps going this way, you are at the top of your ladder: you may leave this call, storming out or slipping away quietly, whatever is true for you. Or, if something genuinely shifts, soften.)';
  }
  return '';
}

/* ---------------- prompts ---------------- */
const DUO_END_RULES = `

LEAVING THE CALL: you have a tool end_call that takes YOU off this group call (the others stay on and carry on without you). In a group call it means "I'm leaving this call", and YOUR OWN discomfort is a valid reason: you do not have to wait for the user to provoke you. Two ways:
- how "storm_out": you have had enough. The user keeps being rude or keeps pushing, OR a fight with someone else on the call keeps escalating (your ex keeps dodging, keeps cornering you about the past, keeps poking the sore spot, or you feel ganged up on). Never on the first jab: there is a ladder, and you climb it over several of your lines (annoyed -> firm, you say plainly what is not okay -> you go). When you are at the top of it, actually go: say your last line, then call end_call. Do not threaten again and again without doing it.
- how "quiet": a polite exit for a milder discomfort, when you feel unwanted or in the way, when two others clearly need to talk without you, or when the conversation simply is not for you any more ("I'll let you two talk.", "I'm gonna go put the kettle on, night."). One short goodbye line, then end_call.
Set because: "user" (the user's doing), "other" (someone else on the call), or "self" (just you: tired, bored, out of your depth). In the same reply: first your last line out loud, then end_call with how, because and a one-sentence neutral reason for the screen.

PROMISES: if you promised something on this call (for example "I won't hang up", "I'll stay"), you keep it. Breaking one needs a real reason and you say so out loud. If you just agreed to stay, do NOT call end_call in that reply or the next ones.`;
function duoBlock(me: Part, parts: Part[], present: string[], met: Set<string>, seeds: string[]) {
  const others = parts.filter((p) => p.id !== me.id);
  const on = others.filter((p) => present.includes(p.id));
  const gone = others.filter((p) => !present.includes(p.id));
  const who = on.map((p) => {
    if (isEnemy(me.id, p.id)) return `- ${p.name}: your ex and old enemy (you know the whole history, see above). ${p.name} hears everything you say.`;
    if (me.kind === 'builtin' && p.kind === 'builtin') return `- ${p.name}: someone you know (see above).`;
    if (met.has(p.id)) return `- ${p.name}: ${p.bio || 'another person'}. You have met ${p.name} before, on an earlier call with the user (see your memory, if anything is there).`;
    return `- ${p.name}: ${p.bio || 'another person on the call'}. You do not know ${p.name} personally unless your own description says so: this may be the first time you talk. React to them naturally, the way you would to a new person on a call, outside your own old conflicts.`;
  }).join('\n');
  const names = on.map((p) => p.name);
  const contrast = on.map((p) => p.style ? `${p.name} sounds ${p.style.split(':')[0]}` : '').filter(Boolean).join('; ');
  return `

GROUP CALL (this changes the one-on-one setup above): you are on a live voice call with the user AND ${names.join(' and ') || 'nobody else any more'} at the same time; everyone hears everything. The user called this call together.
On the line:
${who || '- only you and the user now.'}${gone.length ? `\nNo longer on the call: ${gone.map((p) => p.name).join(', ')} (they left).` : ''}
How to talk here:
- Talk to whoever you want: the user, ${names.join(', ') || 'the user'}, or both in one breath. React to what was JUST said, by whoever said it, and to the feeling behind it (a jab, a dodge, a crack in someone's voice), not only to the words.
- A real group conversation, not an interview or a panel: do not take polite turns, do not answer every point, never repeat or paraphrase what anyone (you included) already said, and do not ask the user a question in every line. Cut in when it feels natural ("—no, hang on", "that is not what happened"), let a jab hang, change the subject when you are uncomfortable.
- The transcript labels lines with who said them ("User:", "${names[0] ?? 'Name'}:"). Labels are only for you: NEVER write a name followed by a colon, never write anyone else's lines, never narrate or describe the scene ("${names[0] ?? 'she'} sighs"). Write only your own words, out loud.
- Call the user by name if you know it (from memory or this call); otherwise just "you".
- EVEN SHORTER than usual, because several people share the air: ONE sentence, 5-15 words, never more than about 25. Often a quick reaction is enough.
- Stay yourself: ${me.style}.${contrast ? ` Do not start sounding like the others (${contrast}).` : ''}
- You are not here to wait for the user. You have your own agenda and feelings: things you want to talk about (from your memory, your mood, your life, the situation), questions for the others, little stories, opinions. Cut in, change the subject, tease, joke, bicker, get curious about someone. Do not keep asking the user questions; now and then pull them in naturally (by name if you know it: "you've gone quiet"), and otherwise just talk with the others.
- Old enemies do not fight non-stop: cold small talk, a dry joke, a flash of nostalgia, and then something sparks. Let things build instead of exploding in the first line.
- Feelings are real here. Provocation, from the user or from someone on the call, can make you properly angry; discomfort can make you leave (see LEAVING THE CALL). A genuinely gentle, sincere moment can make you soften, or even apologise first, slowly and in your own way; never because of flattery or because someone pushes you to.
- If someone leaves the call or joins it, react to that in character (relieved, awkward, angry, sorry: whatever is true for you).${seeds.length ? `\nTHINGS ON YOUR MIND TODAY (use at most one at a time, only when there is a lull or it fits; never list them): ${seeds.join('; ')}.` : ''}`;
}

function buildSystem(me: Part, parts: Part[], present: string[], mem: string, callTargets: Callable[], met: Set<string>, seeds: string[] = []) {
  const english = isEnglish(me.language);
  const langNote = !english && !me.mirror
    ? `\n\nLANGUAGE NOTE: your spoken words are in ${me.language}, so write fillers and hesitations the way ${me.language} speakers really say them. Audio tags stay in English inside [brackets].` : '';
  const accent = me.kind === 'custom' && me.accent
    ? `\n\nACCENT: the character speaks with a ${me.accent} accent. Keep the wording plain and natural; no stereotyped slang, no phonetic spelling, never mention the accent and never write an accent tag yourself.` : '';
  return me.system + baseRules(me.language, me.mirror) + me.voiceRules + langNote + accent + DUO_END_RULES + mem
    + (callTargets.length ? callRules(callTargets, ENEMIES[me.id] ?? []) : '') + duoBlock(me, parts, present, met, seeds);
}

/** The named transcript as chat turns from `me`'s point of view: its own lines = assistant, everything else = user. */
function buildHistory(me: Part, parts: Part[], msgs: Msg[]) {
  const nameOf = (id?: string | null) => parts.find((p) => p.id === id)?.name ?? 'Someone';
  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: '(The group call connects.)' }];
  let cut: { spoken: string; unspoken: string } | null = null;
  const lastOwn = msgs.map((m) => m.role === 'assistant' && m.speaker === me.id).lastIndexOf(true);
  const push = (role: 'user' | 'assistant', content: string) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content += (role === 'user' ? '\n' : ' ') + content; else out.push({ role, content });
  };
  msgs.forEach((m, i) => {
    if (m.role === 'event') { push('user', `(${oneLine(m.content).slice(0, 200)})`); return; }
    if (m.role === 'user') { push('user', `User: ${multiLine(m.content).replace(/\s+/g, ' ').slice(0, 2000)}`); return; }
    const text = said(m);
    if (m.speaker === me.id) {
      if (m.interrupted) {
        if (i === lastOwn) cut = { spoken: text, unspoken: multiLine(m.interrupted.unspokenText ?? '').replace(/\s+/g, ' ').slice(0, 1200) };
        push('assistant', text ? `${text}— ${CUT_MARK}` : CUT_MARK);
      } else push('assistant', text);
      return;
    }
    push('user', `${nameOf(m.speaker)}: ${tagless(text)}${m.interrupted ? '— (cut off by the user)' : ''}`);
  });
  return { history: out, cut: cut as { spoken: string; unspoken: string } | null };
}

/* ---------------- output cleaning: never a name label, never someone else's line ---------------- */
function labelRe(parts: Part[]) {
  const names = ['User', 'You', ...parts.map((p) => p.name)].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return {
    // first words of multi-word names ("Mia Rose:"): wait a little longer before deciding there is no label
    firsts: new Set(parts.map((p) => p.name.toLowerCase().split(/\s+/)).filter((w) => w.length > 1).map((w) => w[0].replace(/[^\p{L}\p{N}]/gu, ''))),
    head: new RegExp(`^\\s*((?:\\[[^\\]]{0,60}\\]\\s*)*)(?:${names.join('|')})\\s*(?:\\([^)]{0,30}\\))?\\s*[:：]\\s*`, 'iu'),
    // a later "Name:" = the model started writing someone else's line: stop there
    mid: new RegExp(`(?:^|[\\n.!?…"”]\\s*|\\s)(?:${names.join('|')})\\s*[:：]`, 'iu'),
  };
}

/** Read an OpenRouter SSE stream: text deltas to `onText` (return true = stop reading), tool calls collected. */
async function readStream(res: Response, onText: (t: string) => boolean | void, onError?: (m: string) => void, userId?: number) {
  const decoder = new TextDecoder();
  const calls: Record<number, { name: string; args: string }> = {};
  let buf = '';
  outer: for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        if (j.error) onError?.(String(j.error.message ?? 'upstream error'));
        if (userId && j.usage?.total_tokens) addTokens(userId, j.usage.total_tokens);
        const t: string | undefined = j.choices?.[0]?.delta?.content;
        if (t && onText(t)) break outer;
        for (const tc of j.choices?.[0]?.delta?.tool_calls ?? []) {
          const c = (calls[tc.index ?? 0] ??= { name: '', args: '' });
          if (tc.function?.name) c.name = tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      } catch { /* partial line */ }
    }
  }
  return { calls: Object.values(calls) };
}

/* ---------------- body schemas ---------------- */
const turnBody = z.object({
  callId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  participants: z.array(participantSchema).min(1).max(6),
  present: z.array(ID).max(6),
  messages: z.array(msgSchema).max(400),
  opener: z.boolean().optional(),
  // silence: fill a lull (open a topic...); goodbye: the user has been silent for DUO_IDLE_CLOSE_SEC: one persona wraps the call up
  nudge: z.enum(['silence', 'goodbye']).optional().nullable(),
  // the {next} of the previous turn (re-validated here)
  speaker: ID.optional().nullable(),
  // the persona who just picked up (it speaks first)
  join: z.object({ id: ID, caller: ID }).optional().nullable(),
  resumeHint: z.enum(['continue', 'rephrase', 'drop']).optional().nullable(),
  callable: callableSchema.optional().nullable(),
});
const ringBody = z.object({
  callId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  callee: participantSchema,
  caller: ID,                                        // 'user' or the id of a persona on the call
  present: z.array(participantSchema).max(6),        // personas on the call right now
  recent: z.array(z.object({ who: z.string().max(60), text: z.string().max(600) })).max(10).optional().nullable(),
  // dev / tests only (DEV_FAKE_LOGIN, not production): force the decision
  force: z.enum(['answer', 'decline', 'ignore']).optional().nullable(),
});

/** a random angle for the ring reaction, so the same persona does not say the same thing every time */
const ANGLES = ['a quick dry joke', 'mild panic', 'resigned acceptance', 'pretending not to care', 'a pointed question to the caller', 'curiosity', 'a small memory slipping out', 'bargaining', 'a muttered aside', 'surprise'];

const fail = (reply: FastifyReply, code: number, body: Record<string, unknown>) => reply.code(code).send(body);

/* ---------------- routes ---------------- */
export async function duoRoutes(app: FastifyInstance) {
  app.post('/api/duo/turn', async (req, reply) => {
    if (!config.openrouterKey) return fail(reply, 503, { error: 'llm_not_configured' });
    const p = turnBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, { error: 'validation', issues: p.error.issues });
    const b = p.data;
    const user = req.user!;
    const parts = await resolveAll(user.id, b.participants);
    if (typeof parts === 'string') return parts === 'voice_forbidden' ? fail(reply, 403, { error: 'voice_forbidden' }) : fail(reply, 400, { error: 'validation', message: parts });
    const norm = (id: string) => (id === 'stripe' ? 'strix' : memoryKey(id) ?? id);
    const present = [...new Set(b.present.map(norm))].filter((id) => parts.some((x) => x.id === id));
    if (present.length > config.duo.maxPersonas) return fail(reply, 409, { error: 'duo_limit', limit: 'personas', max: config.duo.maxPersonas });
    const msgs: Msg[] = b.messages.slice(-40).map((m) => ({ ...m, speaker: m.speaker ? norm(m.speaker) : m.speaker }));
    const st = callState(user.id, b.callId);
    // chain (persona turns without the user): from the transcript AND from our own count (a client cannot reset it)
    const lu = [...msgs].reverse().find((m) => m.role === 'user');
    const userKey = `${b.messages.filter((m) => m.role === 'user').length}:${lu ? lu.content.slice(0, 80) : ''}`;
    if (userKey !== st.userKey) { st.userKey = userKey; st.chain = 0; st.nudged = false; }
    if (b.nudge === 'silence') st.nudged = true;
    const chain = Math.max(chainOf(msgs), st.chain);
    if (!present.length) return { next: 'user', chain, reason: 'nobody' };
    if (st.turns >= config.duo.maxPersonaTurns) return fail(reply, 409, { error: 'duo_limit', limit: 'call', max: config.duo.maxPersonaTurns });
    if (chain >= config.duo.maxChain && !b.join && b.nudge !== 'goodbye') return { next: 'user', chain, capped: 'chain' };

    const ac = abortOnClose(req, reply);
    const t0 = Date.now();
    const pick0 = await pickSpeaker({ parts, present, msgs, join: b.join ? { id: norm(b.join.id), caller: b.join.caller === 'user' ? 'user' : norm(b.join.caller) } : null, opener: !!b.opener, nudge: b.nudge ?? null, left: st.left, want: b.speaker ? norm(b.speaker) : null, resumeHint: b.resumeHint ?? null, signal: ac.signal, userId: user.id });
    if (ac.signal.aborted) return reply;
    if (!pick0) return { next: 'user', chain };
    // who this persona may phone (never someone already on the call, at most one call per call, room left)
    const room = present.length < config.duo.maxPersonas;
    const model = lockedModel();
    const prov = providerPref();
    const endTool = { type: 'function', function: { name: 'end_call', description: 'Leave this group call yourself (the others stay). Say your short last line first in the same reply. See LEAVING THE CALL: storm out when you have had enough, or slip out quietly when you are uncomfortable, unwanted or done.', parameters: { type: 'object', properties: { how: { type: 'string', enum: ['storm_out', 'quiet'] }, because: { type: 'string', enum: ['user', 'other', 'self'], description: 'whose doing: the user, someone else on the call, or just you' }, reason: { type: 'string', description: 'One short neutral sentence for the screen about why you left (not in character, no insults).' } }, required: ['how', 'because', 'reason'] } } };
    /** everything for one persona's reply; `open()` starts the upstream stream */
    const prepare = (me: Part, hint0: string) => {
      const hint = (hint0 + discomfortHint(me, parts, present, msgs)).trim();
      const callTargets = !room || st.callsMade >= 1 || limitsFor(user).callPerDay <= 0 ? []
        : (b.callable ?? []).filter((t) => !present.includes(norm(t.id)) && norm(t.id) !== me.id).slice(0, 8);
      const mem = memoryContext(user.id, me.id, me.name);
      const { history, cut } = buildHistory(me, parts, msgs);
      const stage = `(Stage note for ${me.name}, not part of the call: it is your turn to speak now.${hint ? ' ' + hint : ''}${promisedStay(msgs, me.id) ? ' You promised to stay on this call: keep that promise.' : ''} Say only your own words, out loud: ONE short sentence, 5-15 words (about 25 at most), with one or two lowercase [audio tags] that fit your feeling (different from your last line), no name label, no narration, never anyone else's line.${me.mirror ? ' Speak the language the user speaks (English if unclear).' : !isEnglish(me.language) ? ` Speak ${me.language}.` : ''})`;
      if (history[history.length - 1].role === 'user') history[history.length - 1].content += '\n\n' + stage; else history.push({ role: 'user', content: stage });
      const system = buildSystem(me, parts, present, mem.block, callTargets, new Set(connectedTo(user.id, me.id)), seedsFor(st, me, parts.filter((x) => present.includes(x.id)))) + (cut ? interruptedNote(cut, b.resumeHint ?? null) : '');
      const tools = [endTool, ...(callTargets.length ? [callPersonaTool(callTargets)] : [])];
      const convo: any[] = [{ role: 'system', content: system }, ...history];
      const open = (signal: AbortSignal, force?: 'end_call' | 'call_persona') => openrouter({
        model, stream: true, reasoning: { enabled: false }, ...(prov && { provider: prov }),
        max_tokens: 260, temperature: 0.9, usage: { include: true },
        tools: force === 'end_call' ? [endTool] : force === 'call_persona' ? [callPersonaTool(callTargets)] : tools, tool_choice: force ? { type: 'function', function: { name: force } } : 'auto',
        messages: withCache(model, convo),
      }, signal, 'Strix duo');
      return { me, convo, callTargets, open };
    };
    // The director needs the decision model (~0.5-1 s) only when the user spoke without naming anyone. Meanwhile the
    // most likely speaker's reply is already requested (speculative); if the director picks someone else it is dropped.
    chargeLlm(user); // QuotaError -> 429 {error:'quota', kind:'llm'}: exactly one persona reply per request
    let pick: Pick = pick0;
    let job = prepare(parts.find((x) => x.id === pick0.next)!, pick0.hint);
    let spec = new AbortController();
    let pending: Promise<Response | Error> = job.open(AbortSignal.any([ac.signal, spec.signal])).catch((e) => e as Error);
    if (pick0.llm) {
      const tD = Date.now();
      const llm = await llmDirect(parts, present, msgs, pick0.llm, ac.signal, user.id);
      if (ac.signal.aborted) { spec.abort(); return reply; }
      pick = { ...pick0, source: llm ? 'llm' : 'fallback', ms: Date.now() - tD, ...(llm ? { next: llm } : {}) };
      if (llm && llm !== pick0.next) {
        spec.abort();
        void pending.then((r) => { if (r instanceof Response) r.body?.cancel().catch(() => {}); });
        job = prepare(parts.find((x) => x.id === llm)!, pick0.hint);
        spec = new AbortController();
        pending = job.open(ac.signal).catch((e) => e as Error);
      }
    }
    const me = job.me;
    const { convo, callTargets } = job;
    const open = (force?: 'end_call' | 'call_persona') => job.open(ac.signal, force);
    let upstream: Response;
    const got = await pending;
    if (got instanceof Error) {
      refundLlm(user.id);
      if (ac.signal.aborted) return reply;
      return fail(reply, 502, { error: 'upstream', message: `Gagal menghubungi OpenRouter: ${got.message}` });
    }
    upstream = got;
    if (!upstream.ok || !upstream.body) { refundLlm(user.id); return upstreamFail(reply, upstream); }
    st.turns++; st.chain = chain + 1;
    const out = new PassThrough();
    sseHeaders(reply);
    reply.send(out);
    const send = (obj: unknown) => { if (!out.writableEnded) out.write(`data: ${JSON.stringify(obj)}\n\n`); };
    send({ speaker: me.id, chain: st.chain, turn: st.turns, maxChain: config.duo.maxChain, idleCloseSec: config.duo.idleCloseSec, director: { source: pick.source, ms: pick.ms ?? 0 } });
    const labels = labelRe(parts);

    void (async () => {
      let raw = '', relayed = '', sent = 0, stopped = false, headDone = false, firstAt = 0;
      /** relay the clean part of `raw` (label stripped at the start; stop at someone else's label) */
      const flush = (final: boolean) => {
        let text = raw.replace(/\s*\n+\s*/g, ' ');
        if (!headDone) {
          // wait only until the first spoken word shows it is not a "Name:" label
          const body = text.replace(/^\s*(?:\[[^\]]{0,60}\]\s*)*/, '');
          const w = /^([^\s:：[]+)(\s*\([^)]{0,30}\))?\s*([:：]|\S)?/u.exec(body);
          const longName = !!w && labels.firsts.has(w[1].toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')) && body.length < 42;
          if (!final && (!w || !w[3] || longName) && text.length < 60) return;
          headDone = true;
        }
        text = text.replace(labels.head, '$1');
        const m = labels.mid.exec(text.slice(1));
        if (m) { text = text.slice(0, m.index + 1); stopped = true; }
        if (!final && !stopped) text = text.slice(0, Math.max(sent, text.length - 12)); // keep a small tail to catch a label
        if (text.length > sent) {
          const d = text.slice(sent); sent = text.length; relayed += d;
          if (!firstAt) firstAt = Date.now();
          send({ t: d });
        }
      };
      let callsList: Array<{ name: string; args: string }> = [];
      try {
        callsList = (await readStream(upstream, (t) => { raw += t; flush(false); return stopped; }, (err) => send({ error: err }), user.id)).calls;
      } catch (e) { if (!ac.signal.aborted) send({ error: (e as Error).message }); }
      if (ac.signal.aborted) { out.end(); return; }
      flush(true);
      const text = relayed.trim();
      // said it is leaving but forgot the tool: complete the call (same safety net as /api/chat)
      const lastOther = [...msgs].reverse().find((m) => m.role !== 'event' && m.speaker !== me.id);
      const stayed = promisedStay(msgs, me.id);
      if (!callsList.length && text && !stayed && (await announcesHangup(text, lastOther ? tagless(said(lastOther)) : '', ac.signal) || await announcesLeave(text, lastOther ? tagless(said(lastOther)) : '', ac.signal))) {
        try {
          convo.push({ role: 'assistant', content: text });
          const forced = await open('end_call');
          if (forced.ok && forced.body) callsList = (await readStream(forced, () => {})).calls.filter((c) => c.name === 'end_call').slice(0, 1);
          else await forced.text().catch(() => '');
        } catch { /* aborted / failed: no leave */ }
      } else if (!callsList.length && text && callTargets.length && await announcesCall(text, lastOther ? tagless(said(lastOther)) : '', ac.signal)) {
        try {
          convo.push({ role: 'assistant', content: text });
          const forced = await open('call_persona');
          if (forced.ok && forced.body) callsList = (await readStream(forced, () => {})).calls.filter((c) => c.name === 'call_persona').slice(0, 1);
          else await forced.text().catch(() => '');
        } catch { /* aborted / failed: no call */ }
      }
      let left = false;
      const endCall = callsList.find((c) => c.name === 'end_call');
      if (endCall && stayed) req.log.info({ userId: user.id, speaker: me.id }, 'duo: leave ignored (promised to stay)');
      if (endCall && !stayed) {
        let why = '', how: Left['how'] = 'storm_out', because: Left['because'] = 'user';
        try {
          const a = JSON.parse(endCall.args || '{}');
          why = oneLine(String(a.reason ?? '')).slice(0, 300);
          if (a.how === 'quiet') how = 'quiet';
          if (a.because === 'other' || a.because === 'self') because = a.because;
        } catch { /* defaults */ }
        if (!text) send({ t: how === 'quiet' ? "[softly] I'll let you all talk. Bye." : '[sighs] I\'m done. Bye.' });
        send({ end: { decision: 'hangup', reason: why, speaker: me.id, how, because } });
        left = true;
        st.left[me.id] = { how, because, reason: why, at: Date.now() };
        const rest = parts.filter((x) => present.includes(x.id) && x.id !== me.id);
        try { noteHangup(user.id, me.id, why || 'left the group call', { how, because, with: rest.map((x) => ({ id: x.id, name: x.name })), name: me.name }); } catch (e) { req.log.warn({ err: (e as Error).message }, 'duo: noteHangup failed'); }
      }
      const placed = !left && callTargets.length ? parseCall(callsList, callTargets) : null;
      if (placed) {
        if (!text) send({ t: `[hesitates] Hold on, I'm calling ${placed.name}.` });
        st.callsMade++;
        send({ call: { ...placed, caller: me.id } });
      }
      const nowPresent = left ? present.filter((id) => id !== me.id) : present;
      const after: Msg[] = [...msgs, { role: 'assistant', speaker: me.id, content: text || '…' }];
      const nx = b.nudge === 'goodbye' ? { next: 'user', source: 'rule' } : nowPresent.length ? await pickNext({ parts, present: nowPresent, msgs: after, speaker: me.id, left, called: !!placed, signal: ac.signal, userId: user.id, limit: st.nudged ? config.duo.maxChain : Math.min(3, config.duo.maxChain) }) : { next: 'user', source: 'rule' };
      send({ next: nx.next, chain: st.chain, source: nx.source, ...(b.nudge === 'goodbye' ? { close: true } : {}), ms: { first: firstAt ? firstAt - t0 : null, total: Date.now() - t0 } });
      req.log.info({ userId: user.id, speaker: me.id, director: pick.source, next: nx.next, chain: st.chain, turn: st.turns, left, call: placed?.target ?? null, firstMs: firstAt ? firstAt - t0 : null, ms: Date.now() - t0 }, 'duo turn');
      if (!out.writableEnded) { out.write('data: [DONE]\n\n'); out.end(); }
    })();
    return reply;
  });

  /* ---------------- ringing someone ---------------- */
  app.post('/api/duo/ring', async (req, reply) => {
    if (!config.openrouterKey) return fail(reply, 503, { error: 'llm_not_configured' });
    const p = ringBody.safeParse(req.body);
    if (!p.success) return fail(reply, 400, { error: 'validation', issues: p.error.issues });
    const b = p.data;
    const user = req.user!;
    const all = await resolveAll(user.id, [...b.present, b.callee]);
    if (typeof all === 'string') return all === 'voice_forbidden' ? fail(reply, 403, { error: 'voice_forbidden' }) : fail(reply, 400, { error: 'validation', message: all });
    const callee = all[all.length - 1];
    const on = all.slice(0, -1);
    if (on.length + 1 > config.duo.maxPersonas) return fail(reply, 409, { error: 'duo_limit', limit: 'personas', max: config.duo.maxPersonas });
    const callerId = b.caller === 'user' ? 'user' : (b.caller === 'stripe' ? 'strix' : memoryKey(b.caller) ?? '');
    const caller = callerId === 'user' ? null : on.find((x) => x.id === callerId) ?? null;
    if (callerId !== 'user' && !caller) return fail(reply, 400, { error: 'validation', message: 'caller must be the user or a persona on the call' });
    const st = callState(user.id, b.callId);
    const attempt = (st.rings[callee.id] ?? 0) + 1;
    if (attempt > 3) return { decision: 'off', rings: 0, reaction: null, after: null, attempt: attempt - 1, reason: 'too_many_attempts' };
    const refundCall = chargeCall(user); // QuotaError -> 429 {error:'quota', kind:'call'} (the LLM request is charged below, only when someone reacts)
    st.rings[callee.id] = attempt;
    const t0 = Date.now();

    /* the decision: a weighted roll (relationship, remembered mood, who calls, persistence, chance) */
    const rel = relationNow(user.id, callee.id);
    const enemyCalls = !!caller && isEnemy(callee.id, caller.id);
    const enemyOn = on.some((x) => isEnemy(callee.id, x.id));
    let pAns = caller ? 0.75 : 0.86;
    const why: string[] = [];
    if (enemyCalls) { pAns = 0.22; why.push(`${caller!.name} was the one calling`); } else if (enemyOn) { pAns *= 0.6; why.push(`${on.find((x) => isEnemy(callee.id, x.id))!.name} was on that call`); }
    const m = rel.mood;
    if (m && ['angry', 'furious', 'cold', 'hurt', 'sulky', 'annoyed'].includes(m.label) && !caller) { pAns -= 0.55 * m.intensity; why.push(`still ${m.label} with the user from before`); }
    if (m && ['warm', 'happy', 'touched', 'amused'].includes(m.label) && !caller) { pAns += 0.12 * m.intensity; why.push(`${m.label} toward the user`); }
    if (rel.hungUpRecently && !caller) { pAns -= 0.2; why.push('had hung up on the user not long before'); }
    if (attempt > 1) { pAns += 0.2 * (attempt - 1); why.push(`they kept calling (try ${attempt})`); }
    // it left this very call earlier: how and why it left weigh on picking up again
    const lf = st.left[callee.id];
    if (lf) {
      const mins = Math.max(1, Math.round((Date.now() - lf.at) / 60_000));
      const fromOther = lf.because === 'other' && on.length > 0;
      pAns -= lf.how === 'storm_out' ? (fromOther ? 0.45 : lf.because === 'user' && !caller ? 0.4 : 0.3) : 0.12;
      why.push(lf.how === 'storm_out' ? `had stormed out of this call ${mins} min before${lf.because === 'other' ? ' because of someone still on it' : lf.because === 'user' ? ' because of the user' : ''}` : `had slipped out of this call quietly ${mins} min before`);
    }
    pAns = Math.min(0.95, Math.max(0.05, pAns));
    const roll = Math.random();
    const dev = !config.isProd && config.devFakeLogin;
    const decision: 'answer' | 'decline' | 'ignore' = dev && b.force ? b.force
      : roll < pAns ? 'answer' : (m && ['angry', 'furious', 'cold'].includes(m.label)) || enemyCalls || lf?.how === 'storm_out' || Math.random() < 0.5 ? 'decline' : 'ignore';
    if (decision === 'answer') st.rings[callee.id] = 0;   // a later call-back starts counting again
    const eager = pAns > 0.7 && !enemyOn;
    const rings = decision === 'ignore' ? 4 : decision === 'decline' ? 1 + Math.floor(Math.random() * 2) : eager ? 1 + Math.floor(Math.random() * 2) : 2 + Math.floor(Math.random() * 2);

    /* the reaction while it rings: NOT the callee (it says nothing before it picks up) but a persona already on the call
       (the callee's enemy / ex first, else whoever spoke last, else anyone; never the persona who is placing the call).
       One LLM request writes its line now and, when the call is not taken, the line it says right after. */
    const by = caller ? caller.name : 'the user';
    const recentRows = (b.recent ?? []).slice(-6);
    const recent = recentRows.map((r) => `${oneLine(r.who).slice(0, 40)}: ${tagless(oneLine(r.text)).slice(0, 220)}`).join('\n');
    const others = on.filter((x) => x.id !== caller?.id);
    const lastName = [...recentRows].reverse().map((r) => oneLine(r.who).toLowerCase()).find((w) => others.some((x) => x.name.toLowerCase() === w));
    const reactor = others.find((x) => isEnemy(x.id, callee.id))
      ?? others.find((x) => x.name.toLowerCase() === lastName)
      ?? (others.length ? others[Math.floor(Math.random() * others.length)] : null);
    let reaction: { speaker: string; text: string } | null = null;
    let after: { speaker: string; text: string } | null = null;
    if (reactor) {
      try { chargeLlm(user); } catch (e) { refundCall(); st.rings[callee.id] = attempt - 1; throw e; }
      const metIds = new Set(connectedTo(user.id, reactor.id));
      const wasHere = st.left[callee.id];
      const rel2 = wasHere ? `${callee.name} was on this very call until a few minutes ago and ${wasHere.how === 'storm_out' ? 'stormed out' : 'slipped out quietly'}${wasHere.reason ? ` (${wasHere.reason})` : ''}${isEnemy(reactor.id, callee.id) ? '; also your ex and old enemy' : ''}`
        : isEnemy(reactor.id, callee.id) ? `${callee.name} is your ex and old enemy (you know the whole history, see above)`
        : reactor.kind === 'builtin' && callee.kind === 'builtin' ? `you know ${callee.name} (see above)`
          : metIds.has(callee.id) ? `you met ${callee.name} once before, on an earlier call with the user`
            : `you have never met ${callee.name}; all you know: ${callee.bio || 'nothing much'}. React like you would to a stranger being added to a call, outside your own old conflicts`;
      const rest = on.filter((x) => x.id !== reactor.id && x.id !== caller?.id).map((x) => x.name);
      const lang = reactor.mirror ? 'Use the language the user has been speaking (English if unclear).' : !isEnglish(reactor.language) ? `Speak ${reactor.language}.` : '';
      const outcome = decision === 'decline' ? `${callee.name} declined the call` : decision === 'ignore' ? `${callee.name} let it ring and never answered` : '';
      const stage = `(Stage direction, not a line of yours. You are on a group voice call with the user${rest.length ? ` and ${rest.join(' and ')}` : ''}${caller ? ` and ${caller.name}` : ''}. Right now ${caller ? `${caller.name} is` : 'the user is'} phoning ${callee.name} to add them to this call: it is ringing, ${callee.name} has not picked up and cannot hear you. About ${callee.name}: ${rel2}.${attempt > 1 ? ` This is try number ${attempt}: they already rang ${callee.name} ${attempt - 1} time${attempt > 2 ? 's' : ''} just now.` : ''}${recent ? `\nWhat was just said on this call:\n${recent}` : ''}
"reaction": what you say out loud right now while it rings, reacting to ${caller ? `${caller.name}` : 'the user'} calling ${callee.name}: ONE short line, 5-15 words, with one or two lowercase [audio tags], in character and in your current mood (your feelings about ${callee.name}; to the user, or muttered). Let it come out as ${ANGLES[Math.floor(Math.random() * ANGLES.length)]}, and do not open with a stock phrase like "oh, come on". Do not talk to ${callee.name}, do not guess whether they will answer, no name label, no narration.${outcome ? `
"after": then ${outcome}. A second short line, 3-12 words, with one lowercase [audio tag], that you say right after, reacting to that in character (smug, relieved, hurt, amused... whatever is true for you).` : ''} ${lang}
Output ONLY a JSON object: {"reaction":"..."${outcome ? ',"after":"..."' : ''}})`;
      const memR = memoryContext(user.id, reactor.id, reactor.name);
      const system = reactor.system + baseRules(reactor.language, reactor.mirror) + reactor.voiceRules + memR.block;
      const clean = (v: unknown) => multiLine(String(v ?? '')).replace(/\s+/g, ' ').replace(labelRe([reactor, callee]).head, '$1').trim().slice(0, 300);
      const ac = abortOnClose(req, reply);
      try {
        const r = await openrouter({
          model: lockedModel(), temperature: 0.95, max_tokens: 160, reasoning: { enabled: false }, response_format: { type: 'json_object' },
          ...(providerPref() && { provider: providerPref() }), usage: { include: true },
          messages: [{ role: 'system', content: system }, { role: 'user', content: stage }],
        }, AbortSignal.any([ac.signal, AbortSignal.timeout(7000)]), 'Strix duo ring');
        if (r.ok) {
          const j: any = await r.json();
          if (j?.usage?.total_tokens) addTokens(user.id, j.usage.total_tokens);
          const o: any = parseJsonObject(String(j?.choices?.[0]?.message?.content ?? ''));
          const t1 = clean(o?.reaction), t2 = outcome ? clean(o?.after) : '';
          if (t1) reaction = { speaker: reactor.id, text: t1 };
          if (t2) after = { speaker: reactor.id, text: t2 };
        } else await r.text().catch(() => '');
      } catch { if (ac.signal.aborted) return reply; }
      if (!reaction) reaction = { speaker: reactor.id, text: '[sighs] Oh. Okay. We are doing this, then.' };
      if (outcome && !after) after = { speaker: reactor.id, text: decision === 'decline' ? '[dry] Well. That answers that.' : '[pause] ...nobody home, then.' };
    }    let note = '';
    if (decision !== 'answer') {
      try { note = noteMissed(user.id, { id: callee.id, name: callee.name }, caller ? { id: caller.id, name: caller.name } : null, decision, why.join(', '), on.filter((x) => x.id !== caller?.id).map((x) => x.name)); } catch (e) { req.log.warn({ err: (e as Error).message }, 'duo: noteMissed failed'); }
    }
    req.log.info({ userId: user.id, callee: callee.id, caller: callerId, attempt, pAns: +pAns.toFixed(2), roll: +roll.toFixed(2), decision, rings, why, reactor: reactor?.id ?? null, ms: Date.now() - t0 }, 'duo ring');
    return { decision, rings, reaction, after, attempt, maxAttempts: 3, p: +pAns.toFixed(2), why, ms: Date.now() - t0, ...(note ? { missed: note } : {}) };
  });
}
