/* Voice layer (port of coffee-voice.js minus the audio engine, which is the shared ctx.player):
   - turns text into speakable text (numbers / rupiah / invoice numbers in words), queues it per sentence chunk
   - streaming: first full sentence of a model reply is spoken while the model is still writing
   - keeps REV (how far each text is "typed") in sync with the audio
   - matches spoken answers to ask_user options */
import type { ScreenCtx } from '../../ctx';

export interface CvSettings {
  on: boolean; tags: boolean; hands: boolean; readCoffee: boolean;
  userSpeech: 'always' | 'mutecall' | 'never';
  player: 'stream' | 'full' | 'simple';
  agentPreset: string; coffeePreset: string;
  superExpr: boolean; free: boolean; fxOn: boolean; fxLevel: 'light' | 'medium' | 'strong';
  readAsk: boolean; fast: boolean; showTags: boolean;
  agentName: string; agentAccent: string; agentTrait: string; coffeeAccent: string; coffeeTrait: string;
  agentVoice: string; coffeeVoice: string;
}

/** Text revealed in sync with speech: off[sid] = chars of the raw text already spoken; done = show all. */
export interface Rev { off: Record<string, number>; done: Set<string>; doneAll(): void }
export const createRev = (): Rev => ({ off: {}, done: new Set(), doneAll() { for (const k in this.off) this.done.add(k); } });

export type Speaker = 'agent' | 'coffee' | 'contact';
export interface VoiceRef { sid: string; start: number; end: number }
export interface VoicePick { voiceId: string; accent: string }

/* ---------- text -> speech ---------- */
const sat = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];
function tb(n: number): string {
  n = Math.floor(n);
  if (n < 12) return sat[n];
  if (n < 20) return tb(n - 10) + ' belas';
  if (n < 100) return tb(Math.floor(n / 10)) + ' puluh' + (n % 10 ? ' ' + tb(n % 10) : '');
  if (n < 200) return 'seratus' + (n > 100 ? ' ' + tb(n - 100) : '');
  if (n < 1000) return tb(Math.floor(n / 100)) + ' ratus' + (n % 100 ? ' ' + tb(n % 100) : '');
  if (n < 2000) return 'seribu' + (n > 1000 ? ' ' + tb(n - 1000) : '');
  if (n < 1e6) return tb(Math.floor(n / 1000)) + ' ribu' + (n % 1000 ? ' ' + tb(n % 1000) : '');
  if (n < 1e9) return tb(Math.floor(n / 1e6)) + ' juta' + (n % 1e6 ? ' ' + tb(n % 1e6) : '');
  if (n < 1e12) return tb(Math.floor(n / 1e9)) + ' miliar' + (n % 1e9 ? ' ' + tb(n % 1e9) : '');
  return String(n);
}
const en1 = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const en10 = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function te(n: number): string {
  n = Math.floor(n);
  if (n < 20) return en1[n];
  if (n < 100) return en10[Math.floor(n / 10)] + (n % 10 ? '-' + en1[n % 10] : '');
  if (n < 1000) return en1[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + te(n % 100) : '');
  if (n < 1e6) return te(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + te(n % 1000) : '');
  if (n < 1e9) return te(Math.floor(n / 1e6)) + ' million' + (n % 1e6 ? ' ' + te(n % 1e6) : '');
  if (n < 1e12) return te(Math.floor(n / 1e9)) + ' billion' + (n % 1e9 ? ' ' + te(n % 1e9) : '');
  return String(n);
}

export function cleanForSpeech(text: string, lang: 'en' | 'id', keepTags: boolean): string {
  const words = (n: number) => (lang === 'id' ? tb(n) : te(n));
  let t = String(text ?? '');
  t = t.replace(/\b(?:invoice\s+)?INV-(\d{1,6})\b/gi, (_, d: string) => 'invoice number ' + [...d].map((x) => (lang === 'id' ? sat[+x] : en1[+x])).join(' '));
  if (!keepTags) t = t.replace(/\[[^\]\n]{1,80}\]\s*/g, '');
  t = t.replace(/(?:Rp\.?|IDR)\s?(\d{1,3}(?:[.,]\d{3})+|\d+)(?:,\d{1,2})?/gi, (_, d: string) => words(+d.replace(/[.,]/g, '')) + ' rupiah')
    .replace(/\b\d{1,3}(?:[.,]\d{3})+\b/g, (d) => words(+d.replace(/[.,]/g, '')))
    .replace(/\p{Extended_Pictographic}/gu, '').replace(/[*_`#>|]/g, '').replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ').replace(/([?!])\s*\./g, '$1').replace(/\.\s+\./g, '.').replace(/\s{2,}/g, ' ');
  return t.replace(/^[.,;\s]+/, '').trim();
}

/* ---------- spoken answer -> ask_user option ---------- */
const ORD = [['satu', 'pertama', '1', 'one', 'first'], ['dua', 'kedua', '2', 'two', 'second'], ['tiga', 'ketiga', '3', 'three', 'third'], ['empat', 'keempat', '4', 'four', 'fourth']];
const norm = (s: string) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
export function matchAnswer(opts: string[], text: string): { index: number } | null {
  if (!Array.isArray(opts) || !opts.length) return null;
  const t = norm(text);
  if (!t || /\d{4,}/.test(t)) return null;                      // long numbers (codes) = free answer
  const ord = t.match(/^(?:opsi |pilihan |nomor |yang |pilih |nomer |option |number |the |choice |pick |go with |i ll take |i ll go with )*(\S+)(?: aja| saja| deh| please| one)?$/);
  if (ord) { const i = ORD.findIndex((o) => o.includes(ord[1])); if (i >= 0 && i < opts.length) return { index: i }; }
  const words = new Set(t.split(' '));
  const scores = opts.map((o) => {
    const ow = norm(o).split(' ').filter((w) => w.length > 1);
    if (!ow.length) return 0;
    if (t.includes(norm(o))) return 1;
    return ow.filter((w) => words.has(w)).length / ow.length;
  });
  const best = Math.max(...scores), i = scores.indexOf(best);
  if (best >= 0.6 && scores.filter((s) => s >= best - 0.15).length === 1) return { index: i };
  return null;
}

/* ---------- the voice layer ---------- */
export function createVoice(o: {
  ctx: ScreenCtx; st: () => CvSettings; lang: () => 'en' | 'id'; callOpen: () => boolean; rev: Rev;
}) {
  const { ctx, rev } = o;
  const player = ctx.player;
  const userMuted = () => { const st = o.st(); return st.userSpeech === 'never' || (st.userSpeech === 'mutecall' && o.callOpen()); };
  const newSid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ttsModel = () => ctx.settings.prefs().ttsModel || undefined;

  /** Speak text as `who`. kind 'chat' = inside the phone call (FX, never muted by userSpeech). ref = text range for synced typing. */
  function say(who: Speaker, text: string, kind?: 'chat', ref?: VoiceRef | null, pick?: VoicePick) {
    const st = o.st();
    if (!st.on) return;
    if (kind === 'chat' && !st.readCoffee) return;          // the agent <-> other party conversation is skipped when off
    if (userMuted() && kind !== 'chat') return;              // agent -> user speech stays text only
    const t = cleanForSpeech(text, o.lang(), st.tags);
    if (!t) return;
    player.mode = st.player; player.fxLevel = st.fxLevel;
    const voiceId = pick?.voiceId || (who === 'coffee' ? st.coffeeVoice : st.agentVoice);
    const accent = pick ? pick.accent : who === 'coffee' ? st.coffeeAccent : st.agentAccent;
    const pre = st.tags && accent ? `[strong ${accent} accent] ` : '';
    const fx = kind === 'chat' && st.fxOn;                  // FX only for the phone conversation
    const parts = ctx.text.splitChunks(t, 420), total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let acc = 0;
    for (const c of parts) {
      const f0 = acc / total; acc += c.length; const f1 = acc / total;
      const meta = ref ? { sid: ref.sid, kind: kind || 'user', a: ref.start + f0 * (ref.end - ref.start), b: ref.start + f1 * (ref.end - ref.start) } : null;
      const gen = player.generation;
      player.speak(pre + c, { voiceId, fx, who, call: kind === 'chat', meta, model: ttsModel(),
        onEnd: () => { if (meta && gen === player.generation) rev.off[meta.sid] = Math.max(rev.off[meta.sid] || 0, meta.b); } });
    }
  }

  /* streaming: the first full sentence (min ~20 chars, later ~70) is spoken as soon as it exists */
  const ABBR = /\b(?:Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr|vs|etc)\.$/i;
  type SK = 'agent' | 'other';
  const SM: Record<SK, { buf: string; first: boolean; sid: string | null; off: number; who: Speaker; pick?: VoicePick }> = {
    agent: { buf: '', first: true, sid: null, off: 0, who: 'agent' },
    other: { buf: '', first: true, sid: null, off: 0, who: 'coffee' },
  };
  const key = (who: Speaker): SK => (who === 'agent' ? 'agent' : 'other');
  function emit(k: SK, raw: string) {
    const m = SM[k];
    const ref = { sid: m.sid!, start: m.off, end: m.off + raw.length }; m.off += raw.length;
    say(m.who, raw, m.who === 'agent' ? undefined : 'chat', ref, m.pick);
  }
  function drain(k: SK, final: boolean) {
    const m = SM[k], re = /[.!?…]+["')\]]*\s/g;
    for (;;) {
      re.lastIndex = m.first ? 20 : 70;
      let x: RegExpExecArray | null;
      while ((x = re.exec(m.buf)) && ABBR.test(m.buf.slice(0, x.index + 1))) { /* skip "Mr." etc. */ }
      if (!x) break;
      const cut = x.index + x[0].length;
      emit(k, m.buf.slice(0, cut)); m.buf = m.buf.slice(cut); m.first = false;
    }
    if (final && m.buf.trim()) { emit(k, m.buf); m.buf = ''; }
  }
  const streamStart = (who: Speaker, pick?: VoicePick) => { const m = SM[key(who)]; Object.assign(m, { buf: '', first: true, sid: newSid(), off: 0, who, pick }); return m.sid!; };
  const streamSid = (who: Speaker) => (who === 'agent' && userMuted() ? null : SM[key(who)].sid);
  const streamDelta = (who: Speaker, t: string) => { SM[key(who)].buf += t; drain(key(who), false); };
  const streamFlush = (who: Speaker) => drain(key(who), true);

  /** The ask_user question is spoken (options never are). */
  function sayAsk(question: string, tcId: string) {
    if (!o.st().readAsk) return;
    say('agent', question, undefined, { sid: 'ask:' + tcId, start: 0, end: String(question).length });
  }

  return {
    say, sayAsk, newSid, streamStart, streamSid, streamDelta, streamFlush, streamEnd: streamFlush, userMuted,
    speaksUser: () => o.st().on && !userMuted(),
    streaming: () => o.st().on && o.st().fast,
    extra: () => (o.st().on && o.st().fast ? { reasoning: { enabled: false } } : {}),
    /** Voice sync: resolves when all queued speech has played. */
    wait: (maxMs = 90000) => (o.st().on ? player.waitIdle(maxMs) : Promise.resolve()),
    pending: () => player.pending,
  };
}
export type Voice = ReturnType<typeof createVoice>;
