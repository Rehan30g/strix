/* "Jadi Coffee" (human mode) voicer.
   The human's reply is spoken EXACTLY as typed: the model only CHOOSES audio tags per sentence (JSON), the code
   reassembles the text by inserting "[tag] " before each sentence, so the words can never be rewritten.
   Optional trimming only DROPS whole sentences (verified as a subsequence of the original). */
import type { ScreenCtx } from '../../ctx';
import { chat } from './llm';
import { isSubsequence, normWords, sentenceSpans } from './util';

const TAG_OK = /^[a-z][a-z ,'-]{1,28}$/;

async function llmJson(ctx: ScreenCtx, model: string, system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<any> {
  const { msg } = await chat(ctx, { model, temperature: 0.4, max_tokens: maxTokens, reasoning: { enabled: false },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, signal);
  const m = String(msg.content || '').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

/** Optional: drop less important sentences of a long reply (never changes a word). */
export async function trimOnly(ctx: ScreenCtx, model: string, text: string, signal?: AbortSignal): Promise<string> {
  const parts = sentenceSpans(text).map((p) => p.text.trim());
  if (parts.length < 3 || normWords(text).length <= 22) return text;
  try {
    const j = await llmJson(ctx, model, `A cashier typed a long reply that will be spoken on a phone call. Pick which numbered sentences to KEEP so the spoken reply is short (about 1-3 sentences) but keeps every essential fact (answers, prices, items, invoice numbers, yes/no). Do not rewrite anything. Reply ONLY with JSON: {"keep":[1,3]} using the sentence numbers in order.`,
      parts.map((p, i) => `${i + 1}. ${p}`).join('\n'), 80, signal);
    const keep = (Array.isArray(j?.keep) ? j.keep : []).filter((n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= parts.length) as number[];
    if (!keep.length) return text;
    const out = [...new Set(keep)].sort((a, b) => a - b).map((n) => parts[n - 1]).join(' ');
    return isSubsequence(normWords(out), normWords(text)) ? out : text;
  } catch { return text; }
}

/** Insert the chosen tags before each sentence. Pure: the text between tags is byte-identical to the input. */
export function applyTags(text: string, tags: unknown[]): string {
  const spans = sentenceSpans(text);
  let out = '', pos = 0;
  spans.forEach((sp, i) => {
    const t = (Array.isArray(tags[i]) ? (tags[i] as unknown[]) : []).map((x) => String(x).toLowerCase().trim()).filter((x) => TAG_OK.test(x)).slice(0, 2);
    out += text.slice(pos, sp.start) + t.map((x) => `[${x}] `).join('');
    pos = sp.start;
  });
  return out + text.slice(pos);
}
/** Inverse of applyTags (removes exactly the "[tag] " tokens it inserted). */
export const removeInsertedTags = (t: string) => t.replace(/\[[a-z][a-z ,'-]{1,28}\] /g, '');

export async function addTagsOnly(ctx: ScreenCtx, model: string, text: string, signal?: AbortSignal): Promise<string> {
  const parts = sentenceSpans(text).map((p) => p.text.trim());
  if (!parts.length) return text;
  try {
    const j = await llmJson(ctx, model, `You are a voice director. For each numbered sentence, choose 0 to 2 lowercase English audio tags describing how a voice actor should deliver it, judged only from its meaning and mood. Examples of tags: cheerful, warmly, apologetic, pause, short pause, chuckling, sighs, whispers, excited, curious, thoughtful, surprised, firmly, gently. Do NOT rewrite, translate or output the sentences. Reply ONLY with JSON: {"tags":[["cheerful"],["pause","warmly"],[]]} with exactly one array per sentence, in order.`,
      parts.map((p, i) => `${i + 1}. ${p}`).join('\n'), 200, signal);
    const out = applyTags(text, Array.isArray(j?.tags) ? j.tags : []);
    return removeInsertedTags(out) === text ? out : text;      // safety net: never speak changed words
  } catch { return text; }
}

export async function shortenWithTags(ctx: ScreenCtx, model: string, text: string, o: { shorten: boolean; voicer: boolean; signal?: AbortSignal }): Promise<string> {
  let out = text;
  if (o.shorten) out = await trimOnly(ctx, model, out, o.signal);
  if (o.voicer) out = await addTagsOnly(ctx, model, out, o.signal);
  return out;
}
