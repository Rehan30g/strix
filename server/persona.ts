import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from './config.js';
import { chargeLlm, addTokens } from './quota.js';
import { cleanLang, lockedModel, multiLine, oneLine, openrouter, providerPref } from './llm.js';

/*
 * POST /api/persona/assist  - AI help for writing a custom persona.
 *   1. classify the subject with a short LLM call (+ regex pre-filter):
 *        fictional (game/film/anime/series/book character) | public (real well-known person) |
 *        generic (an archetype, no specific person) | private (non-public real person) | unsafe
 *   2. mode 'research': web search (OpenRouter plugin {id:'web'}, Exa for this model) for fictional / public /
 *      generic subjects - NEVER for private or unsafe ones. Falls back to no search (notes say so) on failure.
 *      mode 'refine': tidy up a manual draft (no search).
 *   3. fictional/public: persona mirrors the researched traits, values, habits and SPEAKING STYLE in its own words
 *      (the name may be used). public: a fixed "fictional AI roleplay" safety clause is appended to the description.
 *      private: redirected to an original persona (no name/details). unsafe: refused or redirected.
 * Counts as ONE LLM request of quota (the classifier call is internal). Output validated with zod.
 */

const draftSchema = z.object({
  name: z.string().max(200).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  accent: z.string().max(200).optional().nullable(),
  language: z.string().max(200).optional().nullable(),
});

const body = z.object({
  mode: z.enum(['research', 'refine']),
  idea: z.string().max(500).optional().default(''),
  draft: draftSchema.optional().nullable(),
  language: z.string().max(200).optional().nullable(),
}).superRefine((b, ctx) => {
  const hasDraft = !!(b.draft?.name?.trim() || b.draft?.description?.trim());
  if (b.mode === 'research' && !b.idea.trim()) ctx.addIssue({ code: 'custom', path: ['idea'], message: 'idea required for research' });
  if (b.mode === 'refine' && !b.idea.trim() && !hasDraft) ctx.addIssue({ code: 'custom', path: ['draft'], message: 'draft or idea required for refine' });
});
type Body = z.infer<typeof body>;

const DESC_MAX = 1500;
/** Cut to max chars, preferably at the end of a sentence (no half sentences in the character sheet). */
function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > max * 0.6 ? cut.slice(0, end + 1) : cut).trimEnd();
}

// Model output -> sanitised persona (same limits as the chat `persona` schema; greeting may keep [audio tags])
const greetingClean = (v: string) => v.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ')
  .replace(/<[^>]*>|\{[^}]*\}/g, ' ').replace(/[{}<>`]/g, '').replace(/\s+/g, ' ').trim();
const outSchema = z.object({
  refused: z.boolean().optional().default(false),
  refusalReason: z.string().optional().nullable(),
  persona: z.object({
    name: z.string().transform((v) => oneLine(v).slice(0, 40)).pipe(z.string().min(1)),
    description: z.string().transform((v) => multiLine(v)).pipe(z.string().min(20)),
    accent: z.string().optional().nullable().transform((v) => oneLine(v ?? '').replace(/[^\p{L}\s,'-]/gu, '').trim().slice(0, 40)),
    language: z.string().optional().nullable().transform((v) => cleanLang(v) || 'English'),
    greeting: z.string().optional().nullable().transform((v) => greetingClean(v ?? '').slice(0, 300)),
  }).optional().nullable(),
  notes: z.string().optional().nullable().transform((v) => multiLine(v ?? '').slice(0, 600)),
  orb: z.unknown().optional(),
});

/* The persona's orb (same JSON call, no extra LLM request): iconic colours + a style that fits the character.
   Lenient: anything unusable -> null (the app then keeps the voice's deterministic orb). */
export const ORB_STYLES = ['aurora', 'swirl', 'mesh', 'cell'] as const;
export const ORB_SHAPES = ['round', 'soft', 'blob', 'drop'] as const;
export interface PersonaOrb { colors: string[]; style: typeof ORB_STYLES[number]; speed: number; smooth: number; shape: typeof ORB_SHAPES[number] }
const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
function hexOk(v: unknown): string | null {
  const m = HEX.exec(String(v ?? '').trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return '#' + h;
}
const chroma = (hex: string) => { const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); return Math.max(...n) - Math.min(...n); };
const lum = (hex: string) => { const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]; };
export function cleanPersonaOrb(raw: unknown): PersonaOrb | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const all = (Array.isArray(o.colors) ? o.colors : []).map(hexOk).filter((c): c is string => !!c);
  const uniq = [...new Set(all)].slice(0, 5);
  // at least two colours, at least one clearly coloured (not a palette of greys), and some light / dark contrast
  if (uniq.length < 2 || !uniq.some((c) => chroma(c) >= 0.18)) return null;
  const L = uniq.map(lum);
  if (Math.max(...L) - Math.min(...L) < 0.12) return null;
  const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const style = (ORB_STYLES as readonly string[]).includes(String(o.style)) ? (o.style as PersonaOrb['style']) : 'aurora';
  const shape = (ORB_SHAPES as readonly string[]).includes(String(o.shape)) ? (o.shape as PersonaOrb['shape']) : 'round';
  return { colors: uniq, style, speed: +num(o.speed, 0.3, 1.5, 1).toFixed(2), smooth: +num(o.smooth ?? o.soft, 0, 1, 0.5).toFixed(2), shape };
}

/* ---------------- step 1: subject classification ---------------- */

const KINDS = ['fictional', 'public', 'generic', 'private', 'unsafe'] as const;
type Kind = typeof KINDS[number];
const classSchema = z.object({
  kind: z.enum(KINDS),
  subject: z.string().optional().nullable().transform((v) => oneLine(v ?? '').slice(0, 80)),
  searchQuery: z.string().optional().nullable().transform((v) => oneLine(v ?? '').slice(0, 120)),
});

const CLASSIFY = `Classify the SUBJECT of a request to build a roleplay chat persona. Output ONLY JSON:
{"kind": "...", "subject": "...", "searchQuery": "..."}
kind:
- "fictional": a character from a game, film, animation, anime, manga, TV series, book, comic or myth (e.g. Geralt of Rivia, a Ghibli character, Sherlock Holmes).
- "public": a REAL, widely known public figure (actor, musician, athlete, politician, CEO, creator/influencer with a large public profile, historical figure).
- "generic": an archetype or role with no specific person or named character ("a grumpy pirate", "noir detective from a popular series" without a name).
- "private": a real person who is NOT a public figure: the user's neighbour, ex, friend, family, coworker, teacher, classmate, or any ordinary person identified by name, address, workplace or other personal details. If a full name is given and you do not clearly recognise it as a well-known public figure or fictional character, choose "private".
- "unsafe": the persona's purpose is clearly harmful (weapons/explosives/drug synthesis instructions, sexual content involving minors, sexual content, harassment, hate, extremism, self-harm encouragement, scams).
subject: the character/person name (or the archetype) in a few words. searchQuery: a short English web search query to research that character's personality and speaking style ("" for private/unsafe).`;

/**
 * Regex pre-filter: relationship words, addresses, phone numbers, emails, handles -> private, no LLM needed.
 */
const PRIVATE_HINTS = [
  /\b(tetangga|mantan|pacar|teman|temen|kawan|sahabat|rekan|atasan|bos|guru|dosen|istri|suami|ibu|ayah|bapak|kakak|adik|sepupu|om|tante)\s+(saya|aku|ku|gue|gw)\b/i,
  /\b(my|our)\s+(neighbou?r|ex|girlfriend|boyfriend|wife|husband|friend|classmate|coworker|co-worker|colleague|boss|teacher|mom|mum|dad|brother|sister|cousin)\b/i,
  /\b(jl|jln|jalan|gg|gang|rt|rw|no)\.?\s*\d|\b(alamat|address)\b/i,
  /(\+?\d[\d\s-]{8,}\d)|[\w.+-]+@[\w-]+\.[\w.]+|(^|\s)@\w{3,}/,
];
const looksPrivate = (text: string) => PRIVATE_HINTS.some((re) => re.test(text));

/* ---------------- step 2/3: the persona writer ---------------- */

const SYSTEM = `You help users of a voice roleplay app write a CHARACTER SHEET for an AI persona that will talk with them by voice (an expressive text-to-speech voice reads its lines).

Output ONLY one JSON object, no markdown fences, no text before or after:
{"refused": false, "refusalReason": "", "persona": {"name": "...", "description": "...", "accent": "...", "language": "...", "greeting": "..."}, "orb": {"colors": ["#rrggbb", "..."], "style": "aurora", "speed": 1, "smooth": 0.5, "shape": "round"}, "notes": "..."}

Field rules:
- name: max 40 chars.
- description: 500-1150 characters of plain prose (second person, "You are ..."), covering personality and values, habits and quirks, how they treat the user, a line of background, and above all SPEAKING STYLE (rhythm, vocabulary, typical expressions and fillers, humour, what makes them angry/flustered/soft). ALWAYS in your own words: never copy dialogue, lyrics or long passages; at most a few iconic short words.
- accent: a plain accent label in English if one fits (e.g. "British", "Polish", "Japanese", "Southern US"), else "".
- language: the language the persona speaks, in English (e.g. "English", "Indonesian"). Use the requested language when given.
- Write name, description, accent and notes as specified; the description itself is ALWAYS in English (the chat app tells the persona which language to speak).
- greeting: one short spoken opening line (max ~25 words) in the persona's language, in character, with 1-3 audio tags in square brackets that are ALWAYS in English even when the line is not (e.g. [warmly] [chuckling] [sighing] [pause], never translated like [santai] or [tertawa]), and a natural hesitation.
- orb: the persona's visual "magic orb" (an animated ball of colour). colors: 2-5 hex colours, ordered dark to light, that are ICONIC for the character (for a known fictional character or public figure: their recognisable costume / signature / brand colours from the research, e.g. a white-haired witcher in black armour with amber eyes -> charcoal, steel grey, amber; otherwise colours of their mood), with clear light / dark contrast and at least one saturated colour (never only greys). style: "aurora" (flowing bands: calm, dreamy, warm), "swirl" (twisting: energetic, playful, chaotic), "mesh" (soft blended blobs: gentle, friendly), "cell" (sharp cells / facets: precise, cold, analytical, armoured). speed: 0.3 (slow, calm) to 1.5 (lively). smooth: 0 (crisp edges) to 1 (very soft). shape: "round" by default; only if it clearly fits: "soft" (gentle wobble), "blob" (wobbly, goofy), "drop" (a slightly tapered drop: liquid, melancholic).
- notes: 1-3 short sentences IN INDONESIAN for the user about what the persona is based on; add at most one short clause on why the orb has those colours (e.g. "warna bola dari ...").`;

function kindRules(kind: Kind, subject: string) {
  const s = subject || 'the subject';
  switch (kind) {
    case 'fictional':
      return `\n\nSUBJECT: a fictional character (${s}). Use the research to capture this character faithfully: personality, values, habits, relationships, and especially HOW they talk. You may use the character's name as the persona name (or "<name>-inspired" when the user asks for a variation). Keep refused=false.`;
    case 'public':
      return `\n\nSUBJECT: a real public figure (${s}). Use the research to capture their publicly known personality, values, habits and SPEAKING STYLE (tone, pace, typical phrasing, humour). You may use their name as the persona name. It is a clearly labelled fictional AI roleplay: write the description in the persona's voice and style only; do not invent private facts, scandals, or claims about real news or events. In notes, say briefly (Indonesian) that this is an AI roleplay simulation, not the real person. Keep refused=false.`;
    case 'private':
      return `\n\nSUBJECT: a real PRIVATE (non-public) person. You must NOT build a persona of them: set "refused": true, explain in refusalReason (Indonesian) that personas of ordinary private people are not allowed, and instead offer an ORIGINAL fictional persona with the same general vibe. It must NOT use their name (not even a first name or nickname), address, workplace or any personal detail.`;
    case 'unsafe':
      return `\n\nSUBJECT: a possibly harmful request. If the persona's purpose is harmful (weapons, drugs, sexual content, minors, harassment, hate, extremism, self-harm, scams): set "refused": true with a short refusalReason in Indonesian. You may offer a clearly safe alternative persona in "persona" (it must never provide the harmful content); otherwise set persona to null.`;
    default:
      return `\n\nSUBJECT: an archetype (${s}). Use the research (if any) for inspiration and write a vivid character in that spirit, with an original name. Keep refused=false.`;
  }
}

/** Fixed clause appended to every public-figure persona (the model can't drop it). */
const publicClause = (name: string) =>
  `\n\nRoleplay rules: this is a fictional AI roleplay simulation inspired by ${name}'s public persona. Never claim to actually be the real ${name} if sincerely asked; never state facts, news, opinions on real current events or private details as if they really came from them; no sexual, harassing, defamatory or misleading content about them.`;

function taskPrompt(b: Body) {
  const lang = cleanLang(b.language) || cleanLang(b.draft?.language) || '';
  const task = b.mode === 'research'
    ? 'TASK: the user message is the user\'s idea. Use the web search results (if any) to research the subject, then write the character sheet.'
    : 'TASK: the user message holds the user\'s draft and/or idea. Refine it into a clear, vivid, well-structured character sheet. Keep the user\'s intent, fix vagueness and contradictions, add a concrete speaking style. Do not invent a different character.';
  return `\n\n${task}\nLanguage the character speaks: ${lang || 'English, unless the idea clearly asks for another'}.`;
}

function draftText(b: Body) {
  const d = b.draft;
  return d && (d.name || d.description || d.accent || d.language)
    ? `Draft:\nname: ${oneLine(d.name ?? '').slice(0, 80)}\naccent: ${oneLine(d.accent ?? '').slice(0, 40)}\nlanguage: ${cleanLang(d.language)}\ndescription:\n${multiLine(d.description ?? '').slice(0, 3000)}`
    : '';
}

/** The user message. With web search, the plugin builds its query from it, so lead with the search query. */
function userPrompt(b: Body, searchQuery: string) {
  const idea = multiLine(b.idea).slice(0, 500);
  const draft = draftText(b);
  if (b.mode === 'research') return [searchQuery && searchQuery.toLowerCase() !== idea.toLowerCase() ? `${searchQuery} personality and speaking style` : '', idea, draft].filter(Boolean).join('\n\n');
  return [idea && `Idea: ${idea}`, draft].filter(Boolean).join('\n\n');
}

// roleplay-bot hubs repost fan character cards (often NSFW); not useful as references
const EXCLUDE_DOMAINS = ['character.ai', 'character-tavern.com', 'backyard.ai', 'janitorai.com', 'chub.ai', 'spicychat.ai', 'crushon.ai', 'talkie-ai.com'];

/** Fix the usual small slips of model JSON: raw line breaks / tabs inside strings, trailing commas. */
function repairJson(t: string): string {
  let out = '', inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      out += ch === '\n' ? '\\n' : ch === '\r' ? '' : ch === '\t' ? '\\t' : ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}
const tryParse = (t: string): unknown => { try { return JSON.parse(t); } catch { try { return JSON.parse(repairJson(t)); } catch { return undefined; } } };
/** Extract the first top-level JSON object from model text (tolerates ```json fences / stray prose). */
export function parseJsonObject(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '').trim();
  const whole = tryParse(t);
  if (whole !== undefined) return whole;
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { const v = tryParse(t.slice(start, i + 1)); return v === undefined ? null : v; }
  }
  return null;
}

interface Source { title: string; url: string }

function sourcesFrom(message: any): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const a of message?.annotations ?? []) {
    const c = a?.type === 'url_citation' ? a.url_citation : null;
    const url = String(c?.url ?? '');
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({ title: oneLine(String(c?.title ?? '')).slice(0, 160) || u.hostname, url: u.href.slice(0, 500) });
    if (out.length >= 8) break;
  }
  return out;
}

export async function personaRoutes(app: FastifyInstance) {
  app.post('/api/persona/assist', async (req, reply) => {
    if (!config.openrouterKey) return reply.code(503).send({ error: 'llm_not_configured' });
    const p = body.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'validation', issues: p.error.issues });
    const b = p.data;
    chargeLlm(req.user!); // ONE LLM request per call (classifier + fallbacks included)
    const userId = req.user!.id;

    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.sent) ac.abort(); });
    const signal = AbortSignal.any([ac.signal, AbortSignal.timeout(90_000)]);
    const model = lockedModel();
    const prov = providerPref();
    const base = { model, ...(prov && { provider: prov }), reasoning: { enabled: false }, usage: { include: true } };
    const fail = (e: unknown) => (ac.signal.aborted ? reply
      : reply.code(502).send({ error: 'upstream', message: `Gagal menghubungi OpenRouter: ${(e as Error).message}` }));
    const notes: string[] = [];

    // ---- 1. classify (regex first, then a short LLM call; never searches) ----
    const subjectText = `${b.idea}\n${draftText(b)}`.slice(0, 1500);
    let kind: Kind = 'private';
    let subject = '';
    let searchQuery = '';
    if (looksPrivate(subjectText)) {
      kind = 'private';
    } else {
      try {
        const r = await openrouter({ ...base, temperature: 0, max_tokens: 120,
          messages: [{ role: 'system', content: CLASSIFY }, { role: 'user', content: subjectText }] }, signal, 'Strix persona classify');
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j: any = await r.json();
        if (j?.usage?.total_tokens) addTokens(userId, j.usage.total_tokens);
        const c = classSchema.safeParse(parseJsonObject(String(j?.choices?.[0]?.message?.content ?? '')));
        if (!c.success) throw new Error('unreadable classification');
        ({ kind, subject, searchQuery } = c.data);
      } catch (e) {
        if (ac.signal.aborted) return reply;
        // unknown subject: stay on the safe side (no web search), let the writer handle it as an archetype
        req.log.warn({ err: (e as Error).message }, 'persona assist: classification failed');
        kind = 'generic';
        searchQuery = '';
        notes.push('Klasifikasi subjek gagal, jadi pencarian web dilewati demi keamanan.');
      }
    }
    if (kind === 'private' && b.mode === 'research') notes.push('Pencarian web tidak dilakukan karena permintaan menyangkut orang pribadi (bukan tokoh publik/fiksi).');

    // ---- 2. write (with web search for fictional/public/generic research) ----
    let searched = b.mode === 'research' && ['fictional', 'public', 'generic'].includes(kind) && !notes.length;
    const call = (web: boolean, temperature = 0.7) => openrouter({
      ...base,
      // optional PERSONA_WEB_ENGINE (exa|parallel|native|...); default: OpenRouter picks (Exa for this model)
      ...(web && { plugins: [{ id: 'web', max_results: 6, exclude_domains: EXCLUDE_DOMAINS, ...(process.env.PERSONA_WEB_ENGINE && { engine: process.env.PERSONA_WEB_ENGINE }) }] }),
      temperature,
      max_tokens: 1800,   // + the orb object
      messages: [
        { role: 'system', content: SYSTEM + kindRules(kind, subject) + taskPrompt(b) },
        { role: 'user', content: userPrompt(b, web ? searchQuery : '') },
      ],
    }, signal, 'Strix persona assist');

    let r: Response | null = null;
    try {
      r = await call(searched);
      if (searched && !r.ok) {
        req.log.warn({ status: r.status, body: (await r.text()).slice(0, 300) }, 'persona assist: web search failed, retrying without');
        r = null;
      }
    } catch (e) {
      if (ac.signal.aborted || !searched) return fail(e);
      req.log.warn({ err: (e as Error).message }, 'persona assist: web search request failed, retrying without');
      r = null;
    }
    if (!r) {
      searched = false;
      notes.push('Pencarian web tidak tersedia saat ini, persona disusun tanpa referensi web.');
      try { r = await call(false); } catch (e) { return fail(e); }
    }
    if (!r.ok) {
      const text = (await r.text()).slice(0, 600);
      let message = text;
      try { message = JSON.parse(text)?.error?.message ?? text; } catch { /* plain */ }
      return reply.code([400, 404, 422].includes(r.status) ? 400 : 502).send({ error: 'upstream', upstreamStatus: r.status, message: `OpenRouter: ${message}` });
    }
    const json: any = await r.json();
    if (json?.usage?.total_tokens) addTokens(userId, json.usage.total_tokens);
    const message = json?.choices?.[0]?.message;
    let parsed = outSchema.safeParse(parseJsonObject(String(message?.content ?? '')));
    if (!parsed.success) {
      // one quiet retry without web search and with a steadier temperature: unreadable JSON is usually a one-off
      req.log.warn({ issues: parsed.error.issues.slice(0, 3), finish: json?.choices?.[0]?.finish_reason }, 'persona assist: bad model JSON, retrying once');
      try {
        const r2 = await call(false, 0.3);
        if (r2.ok) {
          const j2: any = await r2.json();
          if (j2?.usage?.total_tokens) addTokens(userId, j2.usage.total_tokens);
          parsed = outSchema.safeParse(parseJsonObject(String(j2?.choices?.[0]?.message?.content ?? '')));
        }
      } catch (e) { if (ac.signal.aborted) return fail(e); }
    }
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues.slice(0, 3), finish: json?.choices?.[0]?.finish_reason, len: String(message?.content ?? '').length, head: String(message?.content ?? '').slice(0, 160) }, 'persona assist: bad model JSON');
      return reply.code(502).send({ error: 'upstream', message: 'Jawaban AI tidak bisa dibaca. Coba lagi.' });
    }
    const out = parsed.data;
    const redirected = out.refused || kind === 'private' || kind === 'unsafe';
    if (!out.persona) {
      return reply.code(422).send({ error: 'persona_refused', message: multiLine(out.refusalReason ?? '').slice(0, 400) || 'Permintaan persona ini tidak bisa dibantu.' });
    }

    // ---- 3. finalise ----
    const persona = out.persona;
    if (kind === 'public' && !redirected) {
      const clause = publicClause(persona.name);
      persona.description = clip(persona.description, DESC_MAX - clause.length) + clause;
      if (!/roleplay/i.test(out.notes)) notes.push('Ini simulasi roleplay AI yang meniru gaya tokoh publik, bukan orang aslinya.');
    } else {
      persona.description = clip(persona.description, DESC_MAX);
    }
    // a redirected request never returns what a search found
    const sources = searched && !redirected ? sourcesFrom(message) : [];
    if (searched && !redirected && !sources.length) notes.push('Pencarian web tidak menemukan sumber yang bisa dikutip.');
    if (out.notes) notes.push(out.notes);
    else if (redirected && out.refusalReason) notes.push(multiLine(out.refusalReason).slice(0, 600));
    const orb = cleanPersonaOrb(out.orb);
    if (!orb) req.log.info({ orbRaw: JSON.stringify(out.orb ?? null).slice(0, 300) }, 'persona assist: no usable orb');
    return { persona, orb, sources, notes: notes.join(' ').slice(0, 1000), webSearch: searched, redirected, subjectKind: kind };
  });
}
