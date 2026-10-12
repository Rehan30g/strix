/* POST /api/chat/decide client (full-duplex turn-taking). Plain fetch: a failure must stay silent (no global toasts).
   Falls back to the local heuristic (lib/duplex.ts localDecide) when the endpoint is missing (404, remembered 60 s),
   slow (> 2.5 s), rate limited / out of quota, or failing. */
import { localDecide, type Decision, type DecideAction, type ResumeHint } from './duplex';

export interface DecideReq {
  personaName?: string;
  state: 'speaking' | 'listening' | 'thinking' | 'idle';
  /** what the assistant has really said out loud in the current reply */
  spoken: string;
  /** what it still planned to say */
  remaining?: string;
  /** what the mic heard */
  userPartial: string;
  /** true = committed transcript (the user finished) */
  userFinal?: boolean;
  speechMs?: number;
  lang?: string;
}
export interface DecideRes extends Decision { source: string; ms: number }

const ACTIONS: DecideAction[] = ['ignore', 'backchannel', 'yield', 'stop', 'resume'];
const RESUMES: ResumeHint[] = ['continue', 'rephrase', 'drop'];
let missingUntil = 0;
/** last results (test hook / debugging) */
export const decideLog: Array<DecideReq & { res: DecideRes; at: number }> = [];

export async function decide(req: DecideReq, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DecideRes> {
  const t0 = performance.now();
  const done = (r: DecideRes) => { decideLog.push({ ...req, res: r, at: Date.now() }); if (decideLog.length > 100) decideLog.shift(); return r; };
  const local = (why: string): DecideRes => {
    const d = localDecide({ state: req.state, userPartial: req.userFinal ? undefined : req.userPartial, userFinal: req.userFinal ? req.userPartial : undefined, spoken: req.spoken });
    let out: Decision = d || { action: 'ignore', reason: 'wait for more words' };
    if (out.action === 'resume' && !(req.remaining || '').trim()) out = { action: 'yield', reason: out.reason };
    if (out.action === 'resume' && (req.state === 'speaking' || req.state === 'thinking')) out = { action: 'backchannel', reason: out.reason };
    return done({ ...out, source: 'local:' + why, ms: Math.round(performance.now() - t0) });
  };
  if (Date.now() < missingUntil) return local('missing');
  const ac = new AbortController();
  const kill = () => ac.abort();
  opts.signal?.addEventListener('abort', kill, { once: true });
  const timer = setTimeout(kill, opts.timeoutMs ?? 2500);
  try {
    const r = await fetch('/api/chat/decide', {
      method: 'POST', credentials: 'same-origin', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...req, spoken: req.spoken.slice(-6000), remaining: (req.remaining || '').slice(0, 6000), userPartial: req.userPartial.slice(0, 1000) }),
    });
    if (r.status === 404) { missingUntil = Date.now() + 60_000; return local('404'); }
    if (!r.ok) return local('http' + r.status);
    const j: any = await r.json();
    const action = ACTIONS.includes(j?.action) ? j.action as DecideAction : null;
    if (!action) return local('bad');
    const resume = RESUMES.includes(j?.resume) ? j.resume as ResumeHint : undefined;
    return done({ action, reason: String(j?.reason || ''), ...(resume ? { resume } : {}), source: String(j?.source || 'server'), ms: Math.round(performance.now() - t0) });
  } catch (e) {
    if (opts.signal?.aborted) throw e;
    return local(ac.signal.aborted ? 'timeout' : 'error');
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', kill);
  }
}
