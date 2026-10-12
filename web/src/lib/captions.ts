/* Spoken captions: words appear only while they are being spoken.
   Each TTS chunk (one player.speak call, identified by meta.sid) becomes a segment. Its words get a start time from a
   weight map (letters + pauses for punctuation and audio tags such as [pause] / [laughs]) scaled to the chunk's REAL
   audio duration, and are revealed by the element's real currentTime from player.speechNow() minus the output latency.
   While a chunk is still streaming its duration is unknown: then a deliberately slow estimate (and at least the
   buffered length) is used, so words can come a little late but not early; once the stream is complete the true
   duration takes over. Audio tags are never shown. Failed audio -> the segment is shown statically. */
import type { SpeechNow } from '../player';

interface Word { text: string; f: number; gate: boolean; el: HTMLSpanElement | null }
interface Seg { sid: string; block: Block; words: Word[]; next: number; total: number; done: boolean; text: string; dur: number }
interface Block { id: string; el: HTMLElement }

/** weight units ~ characters; ~13 units per second at normal speed is slower than real ElevenLabs speech (late, not early) */
const SLOW_RATE = 12.5;
/** leading silence in a TTS chunk (s) */
const LEAD = 0.06;
/** extra safety margin (s) */
const SAFETY = 0.02;
/** loudness above which the voice counts as audible, and the longest a phrase start waits for it (s) */
const VOICED = 0.05;
const GATE_MAX = 0.9;

const PAUSE_TAG = /^(long\s+)?pause$/i;
const SOUND_TAG = /laugh|chuckl|giggl|sigh|gasp|cough|clears?\s+throat|cr(y|ies|ying)|sob|sniff|snort|groan|scream|yawn|exhal|inhal|breath/i;

/** Split text into display words with their start fraction (0..1) of the spoken duration. */
export function wordTimeline(text: string): { words: Array<{ text: string; f: number; gate: boolean }>; total: number } {
  const out: Array<{ text: string; w0: number; gate: boolean }> = [];
  let w = 0, gate = true;   // gate = the word starts a new phrase (first word, after a sentence end or a pause / sound tag)
  for (const part of text.split(/(\[[^\]]*\]?)/)) {
    if (!part) continue;
    if (part.startsWith('[')) {
      const tag = part.replace(/^\[|\]$/g, '').trim();
      const tw = PAUSE_TAG.test(tag) ? (/long/i.test(tag) ? 22 : 11) : SOUND_TAG.test(tag) ? 10 : 0;
      w += tw; if (tw) gate = true;
      continue;
    }
    for (const tok of part.split(/\s+/)) {
      if (!tok) continue;
      if (!/[\p{L}\p{N}]/u.test(tok)) { if (out.length) out[out.length - 1].text += tok; if (/[.!?…]/.test(tok)) { w += 6; gate = true; } else w += 2; continue; }
      out.push({ text: tok, w0: w, gate });
      gate = false;
      const letters = tok.replace(/[^\p{L}\p{N}]/gu, '').length;
      w += letters + 1.2;
      if (/[.!?…]["')\]]*$/.test(tok)) { w += 6; gate = true; }
      else if (/[,;:]["')\]]*$/.test(tok)) { w += 3; gate = true; }
      else if (/[-–—]$/.test(tok)) w += 2;
    }
  }
  const total = Math.max(1, w);
  return { words: out.map((x) => ({ text: x.text, f: x.w0 / total, gate: x.gate })), total };
}

export interface RevealLog { sid: string; i: number; word: string; f: number; t: number; lat: number; dur: number; final: boolean; at: number }

export class Captions {
  readonly el: HTMLElement;
  private sr: HTMLElement;
  private blocks: Block[] = [];
  private segs = new Map<string, Seg>();
  private order: Seg[] = [];
  private reduce = matchMedia('(prefers-reduced-motion: reduce)');
  /** reveal log (for sync tests): word reveal time vs the audio clock */
  readonly log: RevealLog[] = [];
  readonly durs: Record<string, number> = {};
  speed = 1;

  constructor(private maxBlocks = 3) {
    this.sr = document.createElement('div');
    this.sr.className = 'sr-only'; this.sr.setAttribute('aria-live', 'polite');
    this.el = document.createElement('div');
    this.el.className = 'caps';
    this.el.setAttribute('aria-hidden', 'true');
  }
  /** visually hidden live region (one announcement per finished chunk, not per word) */
  get live(): HTMLElement { return this.sr; }

  /** Start a new caption block (one per reply). Older blocks fade and scroll up. */
  block(id: string, cls = ''): void {
    for (const b of this.blocks) b.el.classList.add('old');
    const el = document.createElement('p');
    el.className = 'cap-b' + (cls ? ' ' + cls : '');
    this.el.append(el);
    this.blocks.push({ id, el });
    while (this.blocks.length > this.maxBlocks) {
      const b = this.blocks.shift()!;
      b.el.classList.add('gone');
      setTimeout(() => b.el.remove(), 400);
      for (const s of this.order) if (s.block === b) this.segs.delete(s.sid);
      this.order = this.order.filter((s) => s.block !== b);
    }
  }
  private cur(): Block { if (!this.blocks.length) this.block('auto'); return this.blocks[this.blocks.length - 1]; }

  /** Queue a spoken chunk: its words wait for the audio. */
  add(sid: string, text: string): void {
    const tl = wordTimeline(text);
    const s: Seg = { sid, block: this.cur(), words: tl.words.map((w) => ({ ...w, el: null })), next: 0, total: tl.total, done: false, text, dur: 0 };
    this.segs.set(sid, s); this.order.push(s);
  }
  /** Show text at once (no audio: greeting, history, failed TTS). */
  show(text: string, cls = ''): void {
    const b = this.cur();
    if (cls) b.el.classList.add(...cls.split(' ').filter(Boolean));
    for (const w of wordTimeline(text).words) this.put(b, w.text, true);
    this.announce(text);
  }
  /** Reveal one word now (animated), e.g. for a silent demo. */
  reveal(text: string): void { this.put(this.cur(), text); }
  private put(b: Block, text: string, still = false): HTMLSpanElement {
    const sp = document.createElement('span');
    sp.className = still || this.reduce.matches ? 'w st' : 'w';
    sp.textContent = text;
    if (b.el.childNodes.length) b.el.append(' ');
    b.el.append(sp);
    return sp;
  }
  private announce(text: string) { this.sr.textContent = text.replace(/\[[^\]]*\]?/g, ' ').replace(/\s+/g, ' ').trim(); }

  /** Called every frame with the player's clock and the current loudness (0..1). A word that starts a new phrase also waits
      until the voice is audible again (a TTS pause after a sentence or a [pause] tag is often longer than the weights say),
      unless the model time is already well past. */
  tick(now: SpeechNow | null, amp = 1): void {
    if (!now || !now.playing) return;
    const s = this.segs.get(now.sid);
    if (!s || s.done) return;
    // earlier chunks that never got their "end" (should not happen): complete them
    for (const o of this.order) { if (o === s) break; if (!o.done) this.finish(o.sid); }
    const est = Math.max(now.buffered, s.total / (SLOW_RATE * this.speed));
    const dur = now.final && now.dur > 0 ? now.dur : est;
    if (now.final && now.dur > 0) { s.dur = now.dur; this.durs[s.sid] = now.dur; }
    const t = now.t - now.lat - SAFETY;
    while (s.next < s.words.length) {
      const w = s.words[s.next];
      const at = LEAD + w.f * Math.max(0.1, dur - LEAD);
      if (t < at) break;
      if (w.gate && amp < VOICED && t < at + GATE_MAX) break;
      w.el = this.put(s.block, w.text);
      this.log.push({ sid: s.sid, i: s.next, word: w.text, f: w.f, t: now.t, lat: now.lat, dur, final: now.final, at: performance.now() });
      if (this.log.length > 2000) this.log.shift();
      s.next++;
    }
  }
  /** The chunk finished playing: reveal what is left (normally nothing or the last word). */
  finish(sid: string): void {
    const s = this.segs.get(sid); if (!s || s.done) return;
    while (s.next < s.words.length) { s.words[s.next].el = this.put(s.block, s.words[s.next].text); s.next++; }
    s.done = true; this.announce(s.text);
  }
  /** The chunk could not be spoken: show its text statically. */
  fail(sid: string): void {
    const s = this.segs.get(sid); if (!s || s.done) return;
    while (s.next < s.words.length) { s.words[s.next].el = this.put(s.block, s.words[s.next].text, true); s.next++; }
    s.done = true; this.announce(s.text);
  }
  /** Interrupted (full-duplex): freeze at the last word really spoken. The unspoken rest of the chunk that was playing
      is shown dimmed and fades away; queued chunks are dropped. Returns the number of words revealed per chunk sid. */
  cut(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.order) {
      out[s.sid] = s.next;
      if (!s.done && s.next > 0 && s.next < s.words.length) {
        const sp = document.createElement('span');
        sp.className = 'w cut';
        sp.textContent = s.words.slice(s.next).map((w) => w.text).join(' ');
        s.block.el.append(' ', sp);
        s.block.el.classList.add('cut');
        setTimeout(() => sp.remove(), this.reduce.matches ? 400 : 1800);
      }
      s.done = true;
    }
    return out;
  }
  /** Words revealed so far per chunk sid (what has really been heard). */
  revealed(): Record<string, number> { const out: Record<string, number> = {}; for (const s of this.order) out[s.sid] = s.next; return out; }
  /** Drop chunks that will never play (stopped by the user); shown words stay. */
  cancelPending(): void { for (const s of this.order) s.done = true; }
  pending(): boolean { return this.order.some((s) => !s.done); }
  clear(): void { this.el.replaceChildren(); this.blocks = []; this.segs.clear(); this.order = []; this.sr.textContent = ''; }
  get empty(): boolean { return !this.blocks.length; }
}
