/* Full-duplex conversation logic: pure, DOM-free (unit-tested in Node).
   - DuplexMachine: ONE explicit state machine for the turn-taking (idle / listening / thinking / speaking / ducked /
     interrupted). Events come from the mic (voice level, Scribe partial/final), the player (audible/quiet), the decision
     endpoint and the text input; the reducer returns effects (duck, decide, cut, send, ...) that the chat screen runs.
     Stale async results are rejected by utterance id, so two quick interruptions in a row cannot race.
   - isEcho(): is a partial transcript just the assistant's own voice coming back through the mic?
   - splitAtWord(): the exact interruption point inside a raw (tagged) chunk = the words that were really heard.
   - localDecide(): offline fallback of POST /api/chat/decide (used when the endpoint is missing / slow / failing). */

export type DState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'ducked' | 'interrupted';
export type DecideAction = 'ignore' | 'backchannel' | 'yield' | 'stop' | 'resume';
export type ResumeHint = 'continue' | 'rephrase' | 'drop';
export interface Decision { action: DecideAction; reason?: string; resume?: ResumeHint }

export type DEvent =
  | { type: 'mic'; on: boolean }                          // conversation mic open / closed
  | { type: 'think' }                                     // a reply was requested (not audible yet)
  | { type: 'audible' }                                   // assistant audio is playing
  | { type: 'quiet' }                                     // nothing playing, nothing pending
  | { type: 'voice'; utt: number }                        // meaningful voice level from the mic (>= 250 ms)
  | { type: 'partial'; utt: number; text: string }        // non-echo partial transcript
  | { type: 'final'; utt: number; text: string }          // committed transcript (non-echo)
  | { type: 'decision'; utt: number; d: Decision; text: string; final: boolean }   // the answer for `text` of `utt`
  | { type: 'hush'; utt: number }                         // the voice stopped without words (blip / cough)
  | { type: 'typing'; on: boolean }                       // text box has text + focus while the assistant talks
  | { type: 'submit'; text: string }                      // Enter in the text box
  | { type: 'stop' }                                      // orb tap / Esc / stop button: cut, nothing to send
  | { type: 'timeout' }                                   // waited too long for the interrupting utterance
  | { type: 'release' };                                  // still ducked by a voice that went quiet with nothing left to decide

export type Effect =
  | { type: 'duck' }
  | { type: 'unduck' }
  | { type: 'decide'; utt: number; text: string; final: boolean }
  | { type: 'cut' }                                       // fade out, drop queued TTS + LLM stream, save the cut point
  | { type: 'cancel' }                                    // cancel a reply that is not audible yet
  | { type: 'send'; text: string; merge: boolean; interrupted: boolean }
  | { type: 'heard' }                                     // small "heard you" dot (backchannel)
  | { type: 'drop'; utt: number };                        // this utterance is consumed: its final is not sent

export interface MachineSnap { state: DState; mic: boolean; utt: number; uttText: string; uttFinal: boolean; duckBy: 'voice' | 'typing' | null; mergeNext: boolean }

const wordCount = (t: string) => String(t || '').replace(/\[[^\]]*\]?/g, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

export class DuplexMachine {
  state: DState = 'idle';
  mic = false;
  /** utterance under consideration while the assistant talks (0 = none) */
  utt = 0;
  uttText = '';
  uttFinal = false;
  duckBy: 'voice' | 'typing' | null = null;
  /** a not-yet-audible reply was cancelled: the next user text is merged into the last user message */
  mergeNext = false;
  /** utterances already judged as not-a-turn (backchannel / noise / stop): utt -> words judged. If the same utterance
      grows by 2+ words ("yeah... but what about X") it is considered again; otherwise its final is not sent. */
  private consumed = new Map<number, number>();
  /** transition log (tests / debugging) */
  readonly trace: Array<{ ev: string; from: DState; to: DState; fx: string[] }> = [];
  onChange: ((s: DState, prev: DState) => void) | null = null;

  private base(): DState { return this.mic ? 'listening' : 'idle'; }
  private talking(): boolean { return this.state === 'speaking' || this.state === 'ducked'; }
  private resetUtt() { this.utt = 0; this.uttText = ''; this.uttFinal = false; }
  private consume(utt: number, text: string) { if (utt) this.consumed.set(utt, wordCount(text)); if (this.consumed.size > 50) this.consumed.delete(this.consumed.keys().next().value!); }
  /** true = this text of the utterance was already judged (no new content) */
  private isConsumed(utt: number, text: string): boolean {
    const c = this.consumed.get(utt);
    if (c == null) return false;
    if (wordCount(text) <= c + 1) return true;
    this.consumed.delete(utt);
    return false;
  }

  snap(): MachineSnap { return { state: this.state, mic: this.mic, utt: this.utt, uttText: this.uttText, uttFinal: this.uttFinal, duckBy: this.duckBy, mergeNext: this.mergeNext }; }

  dispatch(ev: DEvent): Effect[] {
    const from = this.state;
    const fx = this.step(ev);
    if (this.trace.length > 400) this.trace.shift();
    this.trace.push({ ev: ev.type + ('utt' in ev ? '#' + ev.utt : '') + ('d' in ev ? ':' + ev.d.action : ''), from, to: this.state, fx: fx.map((f) => f.type) });
    if (from !== this.state) this.onChange?.(this.state, from);
    return fx;
  }

  private send(text: string, merge: boolean, interrupted: boolean): Effect[] {
    this.state = 'thinking'; this.duckBy = null; this.resetUtt();
    this.mergeNext = false;
    return [{ type: 'send', text, merge, interrupted }];
  }

  private step(ev: DEvent): Effect[] {
    const s = this.state;
    switch (ev.type) {
      case 'mic':
        this.mic = ev.on;
        if (s === 'idle' || s === 'listening') this.state = this.base();
        return [];
      case 'think':
        if (s === 'speaking' || s === 'ducked') return [];
        this.state = 'thinking';
        return [];
      case 'audible':
        if (s === 'thinking' || s === 'idle' || s === 'listening') { this.state = 'speaking'; return []; }
        return [];
      case 'quiet': {
        if (s === 'interrupted') return [];
        if (s === 'speaking' || s === 'ducked' || s === 'thinking') {
          const fx: Effect[] = s === 'ducked' ? [{ type: 'unduck' }] : [];
          this.state = this.base(); this.duckBy = null;
          // an utterance that was still being decided is now simply the next turn
          if (this.uttFinal && this.utt && this.uttText) { const t = this.uttText; return [...fx, ...this.send(t, this.mergeNext, false)]; }
          return fx;
        }
        return [];
      }
      case 'voice':
        if (s === 'speaking') { this.state = 'ducked'; this.duckBy = 'voice'; this.utt = ev.utt; this.uttText = ''; this.uttFinal = false; return [{ type: 'duck' }]; }
        return [];
      case 'hush':
        if (s === 'ducked' && this.duckBy === 'voice' && ev.utt === this.utt && !this.uttText) { this.state = 'speaking'; this.duckBy = null; this.resetUtt(); return [{ type: 'unduck' }]; }
        return [];
      case 'partial': {
        if (!ev.text.trim() || this.isConsumed(ev.utt, ev.text)) return [];
        if (this.talking()) {
          const fx: Effect[] = [];
          if (s === 'speaking') fx.push({ type: 'duck' });
          this.state = 'ducked'; this.duckBy = 'voice';
          if (ev.utt !== this.utt) { this.utt = ev.utt; this.uttFinal = false; }
          this.uttText = ev.text;
          fx.push({ type: 'decide', utt: ev.utt, text: ev.text, final: false });
          return fx;
        }
        if (s === 'thinking') { this.state = this.base(); this.mergeNext = true; return [{ type: 'cancel' }]; }
        if (s === 'interrupted') { this.uttText = ev.text; if (!this.utt) this.utt = ev.utt; }
        return [];
      }
      case 'final': {
        const text = ev.text.trim();
        if (!text) return [];
        if (this.isConsumed(ev.utt, text)) { this.consumed.delete(ev.utt); return []; }
        if (this.talking()) {
          const fx: Effect[] = [];
          if (s === 'speaking') fx.push({ type: 'duck' });
          this.state = 'ducked'; this.duckBy = 'voice';
          this.utt = ev.utt; this.uttText = text; this.uttFinal = true;
          fx.push({ type: 'decide', utt: ev.utt, text, final: true });
          return fx;
        }
        if (s === 'interrupted') return this.send(text, false, true);
        if (s === 'thinking') return [{ type: 'cancel' }, ...this.send(text, true, false)];
        return this.send(text, this.mergeNext, false);
      }
      case 'decision': {
        if (!ev.utt || ev.utt !== this.utt) return [];
        let a = ev.d.action;
        const turn = a === 'yield' || a === 'stop';
        const grown = wordCount(this.uttText) > wordCount(ev.text) + 1;
        // "not a turn" about an older, shorter text of this utterance: a newer request answers the current text.
        // yield / stop stay valid (the user did cut in); "wait" + more words = they take the turn.
        if (!turn && (ev.final !== this.uttFinal || grown)) return [];
        if (a === 'stop' && grown) a = 'yield';
        const notTurn = a === 'backchannel' || a === 'resume' || (a === 'ignore' && ev.final);
        if (notTurn) this.consume(ev.utt, ev.text);
        if (s !== 'ducked' || this.duckBy !== 'voice') {
          if (notTurn && this.uttFinal) this.resetUtt();
          return notTurn ? [{ type: 'drop', utt: ev.utt }] : [];
        }
        if (a === 'ignore' && !ev.final) {
          // not a turn (yet): volume back, keep listening to this utterance (more words -> decided again)
          this.state = 'speaking'; this.duckBy = null;
          return [{ type: 'unduck' }];
        }
        if (notTurn) {
          const u = this.utt;
          this.state = 'speaking'; this.duckBy = null; this.resetUtt();
          return a === 'backchannel' ? [{ type: 'unduck' }, { type: 'heard' }, { type: 'drop', utt: u }] : [{ type: 'unduck' }, { type: 'drop', utt: u }];
        }
        if (a === 'stop') {
          const u = this.utt; this.consume(u, ev.text);
          this.state = this.base(); this.duckBy = null; this.resetUtt();
          return [{ type: 'cut' }, { type: 'drop', utt: u }];
        }
        // yield: the user takes the turn
        if (this.uttFinal) { const t = this.uttText; return [{ type: 'cut' }, ...this.send(t, false, true)]; }
        this.state = 'interrupted'; this.duckBy = null;
        return [{ type: 'cut' }];
      }
      case 'typing':
        if (ev.on && s === 'speaking') { this.state = 'ducked'; this.duckBy = 'typing'; return [{ type: 'duck' }]; }
        if (!ev.on && s === 'ducked' && this.duckBy === 'typing') { this.state = 'speaking'; this.duckBy = null; return [{ type: 'unduck' }]; }
        return [];
      case 'submit': {
        const text = ev.text.trim();
        if (!text) return [];
        const fx: Effect[] = [];
        if (this.utt) { fx.push({ type: 'drop', utt: this.utt }); this.consume(this.utt, this.uttText); }
        if (this.talking()) return [...fx, { type: 'cut' }, ...this.send(text, false, true)];
        if (s === 'thinking') return [...fx, { type: 'cancel' }, ...this.send(text, true, false)];
        if (s === 'interrupted') return [...fx, ...this.send(text, false, true)];
        return [...fx, ...this.send(text, this.mergeNext, false)];
      }
      case 'stop': {
        const fx: Effect[] = [];
        if (this.utt) { fx.push({ type: 'drop', utt: this.utt }); this.consume(this.utt, this.uttText); }
        if (this.talking()) { this.state = this.base(); this.duckBy = null; this.resetUtt(); return [{ type: 'cut' }, ...fx]; }
        if (s === 'thinking') { this.state = this.base(); this.resetUtt(); this.mergeNext = false; return [{ type: 'cancel' }, ...fx]; }
        if (s === 'interrupted') { this.state = this.base(); this.resetUtt(); return fx; }
        return [];
      }
      case 'timeout':
        if (s === 'interrupted') { this.state = this.base(); this.resetUtt(); }
        return [];
      case 'release':
        // the duck would otherwise last until the reply ends (its final was dropped as echo / empty, or a decision got
        // lost): volume back, the utterance is forgotten (not consumed: real words arriving later are judged again)
        if (s === 'ducked' && this.duckBy === 'voice') { this.state = 'speaking'; this.duckBy = null; this.resetUtt(); return [{ type: 'unduck' }]; }
        return [];
    }
  }
}

/* ---------------- words / echo ---------------- */

const norm = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
/** Display words of a text (audio tags removed), normalised for comparison. */
export function words(text: string): string[] {
  return String(text || '').replace(/\[[^\]]*\]?/g, ' ').split(/\s+/).map(norm).filter(Boolean);
}
function near(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 1) return a.startsWith(b) || b.startsWith(a);
  // edit distance <= 1
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}
function lcs(p: string[], r: string[]): number {
  const dp = new Array(r.length + 1).fill(0);
  for (let i = 1; i <= p.length; i++) {
    let prev = 0;
    for (let j = 1; j <= r.length; j++) {
      const tmp = dp[j];
      dp[j] = near(p[i - 1], r[j - 1]) ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[r.length];
}
/** Is `partial` (what the mic transcribed) just the assistant's own voice? `ref` = the assistant text around the audio
    position (recently spoken words + a few words ahead, because transcripts lag). Echo = the partial is (almost) a
    contiguous run of the reference words. */
export function isEcho(partial: string, ref: string): boolean {
  const p = words(partial);
  if (!p.length) return true;
  const r = words(ref);
  if (!r.length) return false;
  const win = p.length + 3;
  let best = 0;
  for (let s = 0; s < Math.max(1, r.length - win + 1); s++) {
    best = Math.max(best, lcs(p, r.slice(s, s + win)));
    if (best === p.length) break;
  }
  const ratio = best / p.length;
  return p.length <= 2 ? ratio === 1 : ratio >= 0.7;
}

/* ---------------- interruption point ---------------- */

/** Split a raw chunk (may contain [audio tags]) after its first `n` display words (the same word rules as the captions:
    a word has a letter or digit; punctuation-only tokens stick to the word before). Tags after the cut word belong to
    the unspoken part. */
export function splitAtWord(raw: string, n: number): { spoken: string; unspoken: string } {
  if (n <= 0) return { spoken: '', unspoken: raw };
  const re = /\[[^\]]*\]?|[^\s[]+/g;
  let m: RegExpExecArray | null, count = 0, end = -1;
  while ((m = re.exec(raw))) {
    const tok = m[0];
    if (tok.startsWith('[')) { if (count >= n) break; continue; }
    if (/[\p{L}\p{N}]/u.test(tok)) {
      if (count >= n) break;
      count++; end = m.index + tok.length;
    } else if (count > 0 && end >= 0 && count <= n) end = m.index + tok.length;   // trailing punctuation of the last word
  }
  if (end < 0) return { spoken: '', unspoken: raw };
  return { spoken: raw.slice(0, end), unspoken: raw.slice(end) };
}

/** Visible text (no tags, tidy spaces). */
export const plain = (t: string) => String(t || '').replace(/\[[^\]]*\]?/g, ' ').replace(/\s+([,.!?…])/g, '$1').replace(/\s+/g, ' ').trim();

/* ---------------- local decision (fallback) ---------------- */

const BACK = /^(m+-?h+m+|mhm+|hm+|mm+|uh-?huh|uh+ huh|yeah|yea|yes|yep|yup|right|ok(ay)?|sure|i see|true|wow|nice|cool|oh|ah|aha|ha(ha)+|iya+|ya+|yoi|oke+|okey|he+-?em|betul|benar|sip|mantap|oh gitu|gitu|terus|lalu)$/;
const STOP = /^((stop|wait|hold on|hang on|hold up|one sec(ond)?|sh+|shush|shut up|quiet|enough|berhenti|stop dulu|tunggu( dulu| sebentar)?|sebentar|bentar|diam|udah|sudah)( please| dulu| ya)? ?)+$/;
const STOP_START = /^(wait|stop|hold on|hang on|hold up|tunggu|bentar|sebentar|berhenti)( |$)/;
const RESUME = /^(go on|go ahead|continue|keep going|carry on|please continue|and then|then what|lanjut(kan)?( aja| dong| saja)?|terus(kan)?( aja| dong)?|teruskan|ayo lanjut|silakan lanjut|lanjutin)$/;

export function localDecide(a: { state: string; userPartial?: string; userFinal?: string; spoken?: string }): Decision | null {
  const final = a.userFinal != null;
  const raw = (a.userFinal ?? a.userPartial ?? '').toLowerCase().replace(/[.!?,…]+/g, ' ').replace(/\s+/g, ' ').trim();
  const w = raw ? raw.split(' ') : [];
  if (!w.length || raw.replace(/[^\p{L}\p{N}]/gu, '').length < 2) return final ? { action: 'ignore', reason: 'noise' } : null;
  if (RESUME.test(raw)) return { action: 'resume', reason: 'asks to continue', resume: 'continue' };
  if (STOP.test(raw)) return { action: 'stop', reason: 'asks to stop' };
  if (BACK.test(raw) || (w.length <= 3 && w.every((x) => BACK.test(x)))) return { action: 'backchannel', reason: 'acknowledgement' };
  if (w.length >= 3 || /\?/.test(a.userFinal ?? a.userPartial ?? '')) return { action: 'yield', reason: 'takes the turn' };
  return final ? { action: 'yield', reason: 'short turn' } : null;
}

/** Instant client-side answer for unmistakable cut-ins (no network round trip): "stop" / "wait" alone = stop;
    "wait, ..." followed by more words = the user takes the turn. null = ask the server. */
export function fastDecide(text: string): Decision | null {
  const raw = text.toLowerCase().replace(/[.!?,…—-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  if (STOP.test(raw)) return { action: 'stop', reason: 'stop word' };
  if (STOP_START.test(raw) && raw.split(' ').length >= 3) return { action: 'yield', reason: 'cuts in with a stop word' };
  return null;
}
