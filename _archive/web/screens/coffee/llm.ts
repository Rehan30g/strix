/* LLM calls through the server pass-through (/api/llm). */
import type { ScreenCtx } from '../../ctx';
import type { ToolCall } from './types';
import type { Speaker, Voice, VoicePick } from './voice';

export interface LlmMsg { content: string; tool_calls?: ToolCall[]; _spoken?: boolean; _sid?: string | null }

export async function chat(ctx: ScreenCtx, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ msg: LlmMsg; usage: unknown }> {
  const data = await ctx.api.llm<any>(body, signal);
  if (data?.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error).slice(0, 300));
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error('respons kosong dari model');
  return { msg: { content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) }, usage: data.usage };
}

/** Streaming version for voice mode: the opening sentence is spoken as soon as the model writes it,
    without waiting for the tool call to be written. Same result shape as chat(). */
export async function chatVoice(ctx: ScreenCtx, voice: Voice, body: Record<string, unknown>, who: Speaker,
  opts: { onText?: (t: string) => void; signal?: AbortSignal; pick?: VoicePick } = {}): Promise<{ msg: LlmMsg; usage: unknown }> {
  if (!voice.streaming()) return chat(ctx, body, opts.signal);
  let content = '', usage: unknown = null, err: string | null = null;
  const calls: ToolCall[] = [];
  voice.streamStart(who, opts.pick);
  try {
    await ctx.api.llmStream({ ...body, ...voice.extra() }, (j: any) => {
      if (err) return;
      if (j?.error) { err = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error)).slice(0, 300); return; }
      if (j?.usage) usage = j.usage;
      const dl = j?.choices?.[0]?.delta;
      if (!dl) return;
      if (dl.content) { content += dl.content; voice.streamDelta(who, dl.content); opts.onText?.(content); }
      for (const tc of dl.tool_calls || []) {
        const c = (calls[tc.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name = tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
        voice.streamFlush(who);                 // content finished, the rest is a tool call: speak the lead-in now
      }
    }, opts.signal);
  } finally { voice.streamEnd(who); }
  if (err) throw new Error(err);
  const tcs = calls.filter(Boolean);
  tcs.forEach((c) => { if (!c.id) c.id = 'call_' + Math.random().toString(36).slice(2, 10); });
  if (!content && !tcs.length) throw new Error('respons kosong dari model');
  return { msg: { content, _spoken: true, _sid: voice.streamSid(who), ...(tcs.length ? { tool_calls: tcs } : {}) }, usage };
}
