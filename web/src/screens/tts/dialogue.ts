/* TTS "Dialog" mode: a multi-speaker script.
   Syntax: one line = one spoken line. `Name: text` starts a line for a speaker (names are case-insensitive),
   a line without a name continues with the previous speaker. [tags] are painted purple like the single editor.
   The "Pembicara" panel lists the detected speakers (max 6): unique orb, voice from the collection, optional tune.
   Rename / delete / add are written back into the script. Playback streams line by line through the shared player
   (/api/tts per line, a gap between lines); the download is ONE mp3 from POST /api/tts/dialogue. */
import type { ScreenCtx } from '../../ctx';
import type { Tune } from '../../api';
import { h, fmtNum, onDisconnect } from '../../ui/dom';
import { seg, slider, switchRow } from '../../ui/controls';
import { voicePicker, type VoicePicker } from '../../ui/voicepicker';
import { miniPlayer } from '../../ui/audio';
import { orb, personaOrb, type OrbEl } from '../../ui/orb';
import { autoTagLines, INTENSITY, type Intensity } from '../../lib/autotag';

export const MAX_SPEAKERS = 6;
const TAGS = ['laughs', 'chuckling', 'sighing', 'whispering', 'excited', 'warmly', 'sarcastic', 'curious', 'nervous', 'pause', 'gasping', 'shouting'];
const NAMES = ['Maya', 'Raka', 'Dina', 'Bima', 'Sari', 'Tomi', 'Lena', 'Arif'];
export const DIALOG_SAMPLE = `Maya: [excited] Guys, I finally got the tickets! Front row, Saturday night.
Raka: [gasps] No way. How did you even pull that off?
Maya: [laughs] I stayed up until three in the morning refreshing the page. Don't ask.
Dina: [deadpan] So... who's driving? Because it's not going to be me again.
Raka: [chuckles] Fine, I'll drive. But Maya buys the snacks.
Maya: Deal! [warmly] This is going to be the best weekend ever.`;
export type Pace = 'fast' | 'natural' | 'relaxed';
export const PACE: Record<Pace, number> = { fast: 150, natural: 250, relaxed: 350 };
interface CastPref { voiceId: string; tune?: Partial<Tune> | null }
interface DialogPrefs { cast: Record<string, CastPref>; pace: Pace; autotag?: Intensity }

/* ---------- script parsing ---------- */
export interface ScriptLine {
  key: string; name: string; text: string;
  /** offsets in the script: the whole line, the name (named lines only) and the spoken text */
  lineFrom: number; lineTo: number; nameFrom: number; nameTo: number; from: number; to: number;
  named: boolean;
}
const NAME_RE = /^(\s*)(\p{L}[\p{L}\p{N} ._'’-]{0,39}?)\s*:(?!\/\/)[ \t]?/u;
export const speakerKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
export const cleanName = (s: string) => s.replace(/[\[\]:\n\r<>{}"`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);

export function parseScript(src: string): { lines: ScriptLine[]; speakers: Array<{ key: string; name: string }> } {
  const lines: ScriptLine[] = [];
  const speakers: Array<{ key: string; name: string }> = [];
  let cur: { key: string; name: string } | null = null;
  let pos = 0;
  for (const raw of src.split('\n')) {
    const start = pos; pos += raw.length + 1;
    const m = NAME_RE.exec(raw);
    let bodyAt = start, body = raw, nameFrom = -1, nameTo = -1;
    if (m) {
      const name = m[2].replace(/\s+/g, ' ').trim();
      const key = speakerKey(name);
      let sp = speakers.find((s) => s.key === key);
      if (!sp) { sp = { key, name }; speakers.push(sp); }
      cur = sp;
      nameFrom = start + m[1].length; nameTo = nameFrom + m[2].length;
      bodyAt = start + m[0].length; body = raw.slice(m[0].length);
    } else {
      if (!raw.trim()) continue;
      if (!cur) { cur = speakers.find((s) => s.key === 'narator') || { key: 'narator', name: 'Narator' }; if (!speakers.includes(cur)) speakers.push(cur); }
    }
    const lead = body.length - body.trimStart().length;
    const text = body.trim();
    lines.push({ key: cur!.key, name: cur!.name, text, lineFrom: start, lineTo: start + raw.length, nameFrom, nameTo, from: bodyAt + lead, to: bodyAt + lead + text.length, named: !!m });
  }
  return { lines, speakers };
}

export interface DialogApi { el: HTMLElement; load(script: string, cast?: Array<{ name: string; voiceId: string }>): void; cleanup(): void }

export function dialogue(ctx: ScreenCtx, o: { onHistory: () => void }): DialogApi {
  const { settings, player, ui, icons, api } = ctx;
  const S = icons.svg;
  settings.register<DialogPrefs>('studio.dialog', { cast: {}, pace: 'natural' });
  const prefs = () => settings.get<DialogPrefs>('studio.dialog');
  const patch = (p: Partial<DialogPrefs>) => settings.patch<DialogPrefs>('studio.dialog', p);
  const setCast = (key: string, c: Partial<CastPref> | null) => {
    const cast = { ...prefs().cast };
    if (c === null) delete cast[key]; else cast[key] = { ...(cast[key] || { voiceId: '' }), ...c };
    patch({ cast });
  };
  let maxChars = 20000, maxLines = 40, lineMax = 2000;
  let parsed = parseScript('');
  let dlCtrl: AbortController | null = null;

  /* ---------- editor (transparent textarea over a painted backdrop) ---------- */
  const ta = h('textarea', { class: 'tts-text', spellcheck: true, placeholder: 'Maya: Halo! Apa kabar?\nRaka: [laughs] Baik banget...', 'aria-label': 'Naskah dialog' }) as HTMLTextAreaElement;
  ta.value = settings.local.get('studio.dialog.draft', DIALOG_SAMPLE);
  const backIn = h('div', { class: 'tts-back-in' });
  const back = h('div', { class: 'tts-back', 'aria-hidden': 'true' }, backIn);
  const fieldBox = h('div', { class: 'tts-field' }, back, ta);
  const colorOf = (key: string) => Math.max(0, parsed.speakers.findIndex((s) => s.key === key)) % MAX_SPEAKERS;
  function paintBack() {
    const nodes: Node[] = [];
    const tagged = (s: string) => {
      for (const p of s.split(/(\[[^\]\n]*\]?)/)) { if (p) nodes.push(p.startsWith('[') ? h('mark', { class: 'tg' }, p) : document.createTextNode(p)); }
    };
    let at = 0;
    for (const l of parsed.lines) {
      if (!l.named) continue;
      tagged(ta.value.slice(at, l.nameFrom));
      nodes.push(h('span', { class: `spk c${colorOf(l.key)}` }, ta.value.slice(l.nameFrom, l.nameTo)));
      at = l.nameTo;
    }
    tagged(ta.value.slice(at));
    nodes.push(document.createTextNode('\n​'));
    backIn.replaceChildren(...nodes);
    syncBack();
  }
  function syncBack() {
    back.style.width = ta.clientWidth + 'px'; back.style.height = ta.clientHeight + 'px';
    backIn.style.transform = `translate3d(${-ta.scrollLeft}px,${-ta.scrollTop}px,0)`;
  }
  ta.addEventListener('scroll', syncBack, { passive: true });
  const ro = new ResizeObserver(syncBack); ro.observe(ta);
  /** Replace the whole script, keeping native undo where possible. */
  function setText(next: string, caret?: number) {
    let done = false;
    if (matchMedia('(pointer: fine)').matches) {
      try { ta.focus({ preventScroll: true }); ta.select(); done = document.execCommand('insertText', false, next) && ta.value === next; } catch { done = false; }
    }
    if (!done) ta.value = next;
    if (caret != null) { try { ta.setSelectionRange(caret, caret); } catch { /* ignore */ } }
    onText();
  }
  function insertAt(s: number, e: number, ins: string) {
    ta.focus();
    ta.setSelectionRange(s, e);
    let ok = false;
    try { ok = document.execCommand('insertText', false, ins); } catch { ok = false; }
    if (!ok) ta.value = ta.value.slice(0, s) + ins + ta.value.slice(e);
    const pos = s + ins.length;
    ta.setSelectionRange(pos, pos);
    onText();
  }
  /** Start a new line for a speaker below the caret's line. */
  function insertSpeakerLine(name: string) {
    const v = ta.value;
    const caret = document.activeElement === ta ? ta.selectionEnd : v.length;
    const lineStart = v.lastIndexOf('\n', caret - 1) + 1;
    let lineEnd = v.indexOf('\n', caret); if (lineEnd < 0) lineEnd = v.length;
    if (!v.slice(lineStart, lineEnd).trim()) insertAt(lineStart, lineEnd, `${name}: `);
    else insertAt(lineEnd, lineEnd, `\n${name}: `);
  }
  const insertTag = (tag: string) => {
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    const before = ta.value.slice(0, s), after = ta.value.slice(e);
    const rest = after.replace(/^[ \t]+/, '');
    insertAt(s, e + (after.length - rest.length), `${before && !/\s$/.test(before) ? ' ' : ''}[${tag}] `);
  };

  /* ---------- speakers panel ---------- */
  interface Row { key: string; el: HTMLElement; orb: OrbEl; name: HTMLInputElement; vp: VoicePicker; tuneBtn: HTMLButtonElement; count: HTMLElement }
  const rows = new Map<string, Row>();
  const castList = h('div', { class: 'mspk-cast-list', role: 'list' });
  const castCount = h('span', { class: 'mspk-cast-n' });
  const addBtn = h('button', { type: 'button', class: 'btn sm soft', html: S('plus') }, h('span', null, 'Tambah'));
  const castWarn = h('div', { class: 'notice warn mspk-warn', hidden: true, html: S('alert') });
  const castEmpty = h('div', { class: 'mspk-empty' }, h('p', null, 'Tulis naskah dengan format ', h('code', null, 'Nama: kalimat'), '. Pembicara muncul di sini otomatis.'));
  const castBox = h('section', { class: 'mspk-cast', 'aria-label': 'Pembicara' },
    h('div', { class: 'mspk-cast-h' }, h('h2', null, 'Pembicara'), castCount, h('span', { class: 'grow' }), addBtn),
    castEmpty, castList, castWarn);

  const voicesList = () => ctx.store.get().voices || [];
  const voiceOf = (key: string) => prefs().cast[key]?.voiceId || '';
  const orbSpecOf = (key: string, name: string) => personaOrb(voiceOf(key), name);
  /** Give every speaker without a usable voice the first collection voice nobody else uses. */
  function ensureVoices() {
    const vs = voicesList(); if (!vs.length) return;
    const used = new Set<string>();
    for (const s of parsed.speakers.slice(0, MAX_SPEAKERS)) { const v = voiceOf(s.key); if (v && vs.some((x) => x.id === v)) used.add(v); }
    for (const s of parsed.speakers.slice(0, MAX_SPEAKERS)) {
      const v = voiceOf(s.key);
      if (v && vs.some((x) => x.id === v)) continue;
      const pick = vs.find((x) => !used.has(x.id)) || vs[0];
      used.add(pick.id);
      setCast(s.key, { voiceId: pick.id });
    }
  }
  function makeRow(key: string, name: string): Row {
    const ob = orb(orbSpecOf(key, name), { size: 44, cls: 'mspk-orb' });
    const nameIn = h('input', { class: 'input mspk-name', value: name, maxlength: 40, 'aria-label': `Nama pembicara ${name}`, autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
    const count = h('span', { class: 'mspk-row-n' });
    const vp = voicePicker({ value: voiceOf(key), label: `Suara untuk ${name}`, onChange: (v) => { setCast(row.key, { voiceId: v }); repaintOrbs(); paint(); } });
    const tuneBtn = h('button', { type: 'button', class: 'btn icon ghost mspk-tune', title: 'Tuning pembicara', 'aria-label': `Tuning untuk ${name}`, html: S('sliders') });
    const more = h('button', { type: 'button', class: 'btn icon ghost', title: 'Lainnya', 'aria-label': `Menu ${name}`, html: S('moreV') });
    const el = h('div', { class: 'mspk-row', role: 'listitem' },
      h('button', { type: 'button', class: 'mspk-orb-btn', title: `Sisipkan baris ${name}`, 'aria-label': `Sisipkan baris untuk ${name}` }, ob),
      h('div', { class: 'mspk-row-id' }, nameIn, count),
      h('div', { class: 'mspk-row-v' }, vp),
      h('div', { class: 'mspk-row-a' }, tuneBtn, more));
    const row: Row = { key, el, orb: ob, name: nameIn, vp, tuneBtn, count };
    (el.querySelector('.mspk-orb-btn') as HTMLButtonElement).onclick = () => insertSpeakerLine(currentName(row.key));
    const commit = () => rename(row, nameIn.value);
    nameIn.addEventListener('change', commit);
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameIn.blur(); } if (e.key === 'Escape') { nameIn.value = currentName(row.key); nameIn.blur(); } });
    tuneBtn.onclick = () => openTune(row.key);
    more.onclick = () => ui.popover(more, h('div', { class: 'auto-menu' },
      ui.menuItem('Sisipkan baris', 'plus', () => insertSpeakerLine(currentName(row.key))),
      ui.menuItem('Tuning pembicara', 'sliders', () => openTune(row.key)),
      ui.menuItem('Hapus pembicara', 'trash', () => removeSpeaker(row.key), 'danger')), { align: 'end' });
    return row;
  }
  const currentName = (key: string) => parsed.speakers.find((s) => s.key === key)?.name || key;

  function rename(row: Row, raw: string) {
    const name = cleanName(raw);
    const old = currentName(row.key);
    if (!name) { row.name.value = old; ui.toast('Nama pembicara tidak boleh kosong.', { kind: 'warn' }); return; }
    if (name === old) { row.name.value = old; return; }
    const key = speakerKey(name);
    if (key !== row.key && parsed.speakers.some((s) => s.key === key)) { row.name.value = old; ui.toast(`Sudah ada pembicara bernama ${name}.`, { kind: 'warn' }); return; }
    let next = ta.value;
    for (const l of [...parsed.lines].reverse()) if (l.named && l.key === row.key) next = next.slice(0, l.nameFrom) + name + next.slice(l.nameTo);
    if (key !== row.key) {
      const c = prefs().cast[row.key];
      const cast = { ...prefs().cast }; delete cast[row.key]; if (c) cast[key] = c;
      patch({ cast });
      rows.delete(row.key); row.key = key; rows.set(key, row);
    }
    setText(next);
  }
  async function removeSpeaker(key: string) {
    const name = currentName(key);
    const mine = parsed.lines.filter((l) => l.key === key);
    if (mine.some((l) => l.text) && !(await ui.confirm({ title: `Hapus ${name}?`, message: `${mine.length} baris milik ${name} ikut dihapus dari naskah. Kamu bisa mengurungkannya dengan Ctrl+Z.`, confirm: 'Hapus', danger: true }))) return;
    let next = ta.value;
    for (const l of [...mine].reverse()) next = next.slice(0, l.lineFrom) + next.slice(Math.min(next.length, l.lineTo + 1));
    setCast(key, null);
    setText(next.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, ''));
  }
  addBtn.onclick = () => {
    if (parsed.speakers.length >= MAX_SPEAKERS) { ui.toast(`Maksimal ${MAX_SPEAKERS} pembicara.`, { kind: 'warn' }); return; }
    const taken = new Set(parsed.speakers.map((s) => s.key));
    const name = NAMES.find((n) => !taken.has(speakerKey(n))) || `Pembicara ${parsed.speakers.length + 1}`;
    const v = ta.value.replace(/\s+$/, '');
    setText(v ? `${v}\n${name}: ` : `${name}: `);
    ta.setSelectionRange(ta.value.length, ta.value.length); ta.focus();
  };

  /* per-speaker tune (on top of the global "Tuning suara") */
  function openTune(key: string) {
    const name = currentName(key);
    const g = settings.tune();
    let own: Partial<Tune> | null = prefs().cast[key]?.tune || null;
    const eff = () => ({ ...g, ...(own || {}) });
    const set = (k: keyof Tune) => (v: number | boolean) => { own = { ...(own || {}), [k]: v }; follow.input.checked = false; save(); };
    const save = () => setCast(key, { tune: own });
    const sl = {
      stability: slider({ label: 'Stability', min: 0, max: 1, step: 0.05, value: eff().stability, onInput: set('stability') }),
      similarity: slider({ label: 'Similarity', min: 0, max: 1, step: 0.05, value: eff().similarity, onInput: set('similarity') }),
      speed: slider({ label: 'Speed', min: 0.7, max: 1.2, step: 0.05, value: eff().speed, onInput: set('speed'), fmt: (v) => v.toFixed(2) + 'x' }),
    };
    const follow = switchRow('Ikuti tuning global', !own, (on) => {
      if (on) { own = null; const e = eff(); sl.stability.setValue(e.stability); sl.similarity.setValue(e.similarity); sl.speed.setValue(e.speed); save(); }
    }, 'Tuning suara di bawah berlaku untuk semua pembicara');
    ui.modal({ title: `Tuning ${name}`, body: h('div', { class: 'stack', style: 'gap:14px' }, follow, sl.stability, sl.similarity, sl.speed), cls: 'mspk-tune-dlg', onClose: () => paintRows() });
  }

  function syncRows() {
    const keys = parsed.speakers.slice(0, MAX_SPEAKERS).map((s) => s.key);
    for (const [k, r] of rows) if (!keys.includes(k)) { r.el.remove(); rows.delete(k); }
    const order: HTMLElement[] = [];
    for (const s of parsed.speakers.slice(0, MAX_SPEAKERS)) {
      let r = rows.get(s.key);
      if (!r) { r = makeRow(s.key, s.name); rows.set(s.key, r); }
      order.push(r.el);
    }
    order.forEach((el, i) => { if (castList.children[i] !== el) castList.insertBefore(el, castList.children[i] || null); });
    paintRows();
  }
  function paintRows() {
    const counts = new Map<string, number>();
    for (const l of parsed.lines) if (l.text) counts.set(l.key, (counts.get(l.key) || 0) + 1);
    for (const r of rows.values()) {
      const name = currentName(r.key);
      if (document.activeElement !== r.name) r.name.value = name;
      r.name.setAttribute('aria-label', `Nama pembicara ${name}`);
      const n = counts.get(r.key) || 0;
      r.count.textContent = `${n} baris`;
      r.el.dataset.c = String(colorOf(r.key));
      if (r.vp.value !== voiceOf(r.key)) r.vp.setValue(voiceOf(r.key));
      const own = prefs().cast[r.key]?.tune;
      r.tuneBtn.classList.toggle('on', !!own);
      r.tuneBtn.title = own ? 'Tuning khusus aktif' : 'Tuning pembicara (ikut global)';
    }
    repaintOrbs();
    castCount.textContent = `${Math.min(parsed.speakers.length, MAX_SPEAKERS)}/${MAX_SPEAKERS}`;
    castEmpty.hidden = parsed.speakers.length > 0;
    addBtn.disabled = parsed.speakers.length >= MAX_SPEAKERS;
  }
  function repaintOrbs() {
    for (const r of rows.values()) r.orb.setSpec(orbSpecOf(r.key, currentName(r.key)));
    for (const c of chipsSpk.querySelectorAll<HTMLElement>('[data-k]')) { const o = c.querySelector('.orb') as OrbEl | null; o?.setSpec(orbSpecOf(c.dataset.k!, currentName(c.dataset.k!))); }
    paintLines();
  }

  /* ---------- quick insert + tags + auto tag ---------- */
  const chipsSpk = h('div', { class: 'tag-row mspk-spk-row', role: 'group', 'aria-label': 'Sisipkan baris pembicara' });
  function paintChips() {
    chipsSpk.replaceChildren(...parsed.speakers.slice(0, MAX_SPEAKERS).map((s) => {
      const c = h('button', { type: 'button', class: `chip mspk-chip c${colorOf(s.key)}`, 'data-k': s.key, title: `Baris baru untuk ${s.name}` }, orb(orbSpecOf(s.key, s.name), { size: 18 }), s.name);
      c.onclick = () => insertSpeakerLine(s.name);
      return c;
    }), (() => { const b = h('button', { type: 'button', class: 'chip mspk-chip add', html: S('plus') }, 'Pembicara'); b.onclick = () => addBtn.click(); return b; })());
  }
  const chipsTag = h('div', { class: 'tag-row', role: 'group', 'aria-label': 'Sisipkan audio tag' },
    ...TAGS.map((t) => h('button', { type: 'button', class: 'chip tag-chip', onclick: () => insertTag(t) }, `[${t}]`)));
  let tagCtrl: AbortController | null = null;
  let undoText: string | null = null;
  const autoBtn = h('button', { type: 'button', class: 'btn sm soft tts-auto', 'aria-haspopup': 'menu', title: 'Sisipkan audio tag per baris sesuai pembicara (kata tidak diubah)', html: S('wand') }, h('span', null, 'Auto tag'), h('span', { class: 'tts-auto-c', html: S('chevronDown') }));
  const undoBtn = h('button', { type: 'button', class: 'btn sm ghost', hidden: true, title: 'Urungkan auto tag', html: S('refresh') }, h('span', null, 'Urungkan'));
  const sampleBtn = h('button', { type: 'button', class: 'btn sm ghost', title: 'Isi dengan contoh naskah 3 pembicara', html: S('sparkle') }, h('span', null, 'Coba contoh'));
  autoBtn.onclick = () => {
    if (tagCtrl) { tagCtrl.abort(); return; }
    const last = prefs().autotag || 'normal';
    ui.popover(autoBtn, h('div', { class: 'auto-menu' }, h('div', { class: 'menu-h' }, 'Intensitas tag'),
      ...INTENSITY.map(([k, label, hint]) => { const b = ui.menuItem(label, k === last ? 'check' : 'tag', () => runAutoTag(k)); b.append(h('small', null, hint)); return b; })), { align: 'start' });
  };
  async function runAutoTag(k: Intensity) {
    const before = ta.value;
    const ls = parsed.lines.filter((l) => l.text);
    if (!ls.length) { ui.toast('Tulis naskahnya dulu.', { kind: 'warn' }); return; }
    patch({ autotag: k });
    tagCtrl = new AbortController();
    autoBtn.classList.add('busy'); autoBtn.querySelector('span')!.textContent = 'Menandai...';
    try {
      const r = await autoTagLines(ls.map((l) => ({ speaker: l.name, text: l.text })), k, tagCtrl.signal);
      if (ta.value !== before) { ui.toast('Naskah berubah saat menunggu, hasil auto tag tidak dipakai.', { kind: 'warn' }); return; }
      let next = before;
      for (let i = ls.length - 1; i >= 0; i--) next = next.slice(0, ls[i].from) + r.lines[i] + next.slice(ls[i].to);
      if (next === before) { ui.toast(r.fallback ? 'AI belum bisa menambahkan tag kali ini. Coba lagi.' : 'Tidak ada tag baru yang perlu ditambahkan.', { kind: r.fallback ? 'warn' : 'info', timeout: 2600 }); return; }
      undoText = before; undoBtn.hidden = false;
      setText(next);
      ui.toast(r.mock ? 'Tag disisipkan (mode contoh).' : 'Tag disisipkan per baris. Kata-katamu tidak diubah.', { kind: 'ok', timeout: 2600 });
    } catch (e: any) {
      if (e?.code !== 'aborted') ui.toast(e?.message || 'Auto tag gagal.', { kind: 'bad', title: 'Auto tag gagal' });
    } finally { tagCtrl = null; autoBtn.classList.remove('busy'); autoBtn.querySelector('span')!.textContent = 'Auto tag'; }
  }
  undoBtn.onclick = () => { if (undoText == null) return; setText(undoText); undoText = null; undoBtn.hidden = true; };
  sampleBtn.onclick = async () => {
    if (ta.value.trim() && ta.value !== DIALOG_SAMPLE && !(await ui.confirm({ title: 'Ganti dengan contoh?', message: 'Naskahmu diganti dengan contoh dialog 3 pembicara (bisa diurungkan dengan Ctrl+Z).', confirm: 'Ganti' }))) return;
    setText(DIALOG_SAMPLE);
  };
  const counter = h('span', { class: 'tts-count', 'aria-live': 'polite' });
  const clearBtn = h('button', { type: 'button', class: 'btn ghost icon sm', title: 'Kosongkan', 'aria-label': 'Kosongkan naskah', html: S('x') });
  clearBtn.onclick = () => { setText(''); ta.focus(); };
  const editor = h('section', { class: 'tts-editor mspk-editor' },
    fieldBox,
    h('div', { class: 'tts-editor-f' }, h('span', { class: 'tag-label', html: S('users') }, 'Baris'), chipsSpk),
    h('div', { class: 'tts-editor-f' }, h('span', { class: 'tag-label', html: S('tag') }, 'Tag'), chipsTag),
    h('div', { class: 'tts-editor-meta' }, h('div', { class: 'tts-meta-l' }, autoBtn, undoBtn, sampleBtn), h('div', { class: 'tts-meta-r' }, counter, clearBtn)));

  /* ---------- playback ---------- */
  const playBtn = h('button', { type: 'button', class: 'btn primary lg tts-play' });
  const dlBtn = h('button', { type: 'button', class: 'btn lg tts-dl' });
  const pace = seg<Pace>([['fast', 'Cepat'], ['natural', 'Alami'], ['relaxed', 'Santai']], prefs().pace || 'natural', (v) => patch({ pace: v }), 'Jeda antar-baris');
  const problems = h('div', { class: 'notice warn mspk-warn', hidden: true, html: S('alert') });
  const stageOrb = orb(orbSpecOf('', ''), { size: 56 });
  const stageName = h('b', { class: 'mspk-stage-name' });
  const stageText = h('div', { class: 'mspk-stage-text' });
  const stage = h('div', { class: 'mspk-stage', hidden: true, 'aria-live': 'polite' }, stageOrb, h('div', { class: 'mspk-stage-t' }, stageName, stageText));
  const result = h('div', { class: 'tts-result', 'aria-live': 'polite' });
  const lineList = h('ol', { class: 'mspk-lines', 'aria-label': 'Urutan baris' });
  const linesSec = h('section', { class: 'stack mspk-lines-sec', style: 'gap:8px' },
    h('div', { class: 'sec-head' }, h('h2', null, 'Urutan baris'), h('span', { class: 'hint' }, 'Ketuk baris untuk memutar dari sana')), lineList);

  /** Lines that will be spoken (non-empty), with their voice and tune. */
  const playable = () => parsed.lines.filter((l) => l.text && l.text.replace(/\[[^\]]*\]/g, '').trim());
  const tuneOf = (key: string) => prefs().cast[key]?.tune || undefined;
  function issues(): string[] {
    const out: string[] = [];
    const ls = playable();
    if (parsed.speakers.length > MAX_SPEAKERS) out.push(`Maksimal ${MAX_SPEAKERS} pembicara (sekarang ${parsed.speakers.length}). Gabungkan atau hapus beberapa nama.`);
    if (ls.length > maxLines) out.push(`Maksimal ${maxLines} baris (sekarang ${ls.length}).`);
    const long = ls.findIndex((l) => l.text.length > lineMax);
    if (long >= 0) out.push(`Baris ${long + 1} terlalu panjang (maks ${fmtNum(lineMax)} karakter per baris). Pecah jadi beberapa baris.`);
    const total = ls.reduce((n, l) => n + l.text.length, 0);
    if (total > maxChars) out.push(`Naskah terlalu panjang (${fmtNum(total)} / ${fmtNum(maxChars)} karakter).`);
    if (voicesList().length && parsed.speakers.slice(0, MAX_SPEAKERS).some((s) => !voiceOf(s.key))) out.push('Pilih suara untuk setiap pembicara.');
    return out;
  }

  // play state (indices into the `run` snapshot)
  let run: { lines: ScriptLine[]; gen: number; state: Array<'wait' | 'play' | 'done' | 'err'>; active: number; source: 'stream' | 'file' } | null = null;
  let raf = 0;
  const lvl = () => { const l = player.level(); return l.who?.startsWith('dlg:') ? l.amp : 0; };
  function playFrom(start: number) {
    const ls = playable();
    if (!ls.length || issues().length) return;
    player.stop();
    result.querySelectorAll('audio').forEach((a) => a.pause());
    const gap = PACE[prefs().pace] ?? 250;
    const r = run = { lines: ls, gen: player.generation, state: ls.map((_, i) => (i < start ? 'done' : 'wait')) as Array<'wait' | 'play' | 'done' | 'err'>, active: -1, source: 'stream' as const };
    let queued = start, reached = start;
    const feed = () => { while (run === r && queued < ls.length && queued <= reached + 2) enqueue(queued++); };
    const enqueue = (i: number) => {
      const l = ls[i];
      player.speak(l.text, {
        voiceId: voiceOf(l.key), tune: tuneOf(l.key), who: 'dlg:' + i, meta: { sid: 'dlg', kind: 'dialog', a: 0, b: l.text.length },
        onStart: () => { if (run !== r) return; r.active = i; r.state[i] = 'play'; reached = Math.max(reached, i); feed(); paintPlay(); },
        onEnd: (ok) => { if (run !== r) return; r.state[i] = ok ? 'done' : 'err'; reached = Math.max(reached, i + 1); feed(); paintPlay(); },
      });
      if (i < ls.length - 1) player.gap(gap);
    };
    feed();
    paintPlay();
    loop();
  }
  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (!run) return;
      if (run.source === 'stream') {
        const n = player.speechNow();
        const i = n?.who?.startsWith('dlg:') ? Number(n.who.slice(4)) : -1;
        if (n && i >= 0) {
          const d = n.final ? n.dur : Math.max(n.buffered, n.t + 0.6);
          setProg(i, d > 0 ? Math.min(1, n.t / d) : 0);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }
  function setProg(i: number, p: number) {
    const li = lineList.children[i] as HTMLElement | undefined;
    li?.style.setProperty('--p', (p * 100).toFixed(1) + '%');
  }
  function endRun() { run = null; cancelAnimationFrame(raf); paintPlay(); }
  /** Light the active speaker (panel orb + stage), dim the others, mark lines. */
  function paintPlay() {
    const r = run;
    const playing = !!r && (r.source === 'file' || player.pending > 0);
    const act = r && r.active >= 0 ? r.lines[r.active] : null;
    castBox.classList.toggle('playing', playing);
    for (const row of rows.values()) {
      const on = playing && !!act && act.key === row.key;
      row.el.classList.toggle('active', on);
      row.el.classList.toggle('dim', playing && !on);
      row.orb.setLive(on, r?.source === 'file' ? fileLevel : lvl);
    }
    stage.hidden = !playing || !act;
    if (act) {
      stageOrb.setSpec(orbSpecOf(act.key, act.name));
      stageOrb.setLive(playing, r?.source === 'file' ? fileLevel : lvl);
      stage.dataset.c = String(colorOf(act.key));
      stageName.textContent = act.name;
      ui.renderTagged(stageText, act.text, { hideTags: true });
    } else stageOrb.setLive(false);
    if (r) [...lineList.children].forEach((li, i) => {
      const el = li as HTMLElement;
      const st = r.state[i] || 'wait';
      el.dataset.st = st;
      el.classList.toggle('active', i === r.active && playing);
      if (st === 'done') el.style.setProperty('--p', '100%'); else if (st === 'wait') el.style.setProperty('--p', '0%');
    });
    else [...lineList.children].forEach((li) => { const el = li as HTMLElement; delete el.dataset.st; el.classList.remove('active'); el.style.setProperty('--p', '0%'); });
    paint();
  }
  let fileLevel = () => 0;
  function paintLines() {
    const ls = playable();
    const sameRun = run && run.lines.length === ls.length && run.lines.every((l, i) => l.text === ls[i].text && l.key === ls[i].key);
    if (run && !sameRun && run.source === 'stream') { player.stop(); }
    lineList.replaceChildren(...ls.map((l, i) => {
      const li = h('li', { class: 'mspk-line', 'data-c': String(colorOf(l.key)) });
      const txt = h('span', { class: 'mspk-line-text' }); ui.renderTagged(txt, l.text);
      const b = h('button', { type: 'button', class: 'mspk-line-b', 'aria-label': `Putar dari baris ${i + 1}, ${l.name}` },
        orb(orbSpecOf(l.key, l.name), { size: 28 }),
        h('span', { class: 'mspk-line-m' }, h('b', null, l.name), txt),
        h('span', { class: 'mspk-line-i', html: S('play') }));
      b.onclick = () => playFrom(i);
      li.append(b, h('span', { class: 'mspk-line-p', 'aria-hidden': 'true' }));
      return li;
    }));
    linesSec.hidden = !ls.length;
    if (run && sameRun) paintPlay();
  }

  function paint() {
    const ls = playable();
    const iss = issues();
    const total = ls.reduce((n, l) => n + l.text.length, 0);
    counter.textContent = `${ls.length} baris · ${fmtNum(total)} / ${fmtNum(maxChars)}`;
    counter.classList.toggle('over', total > maxChars || ls.length > maxLines);
    problems.hidden = !iss.length;
    problems.replaceChildren(...(problems.hidden ? [] : [h('div', { html: S('alert') }), h('div', null, ...iss.map((t) => h('div', null, t)))]));
    castWarn.hidden = parsed.speakers.length <= MAX_SPEAKERS;
    castWarn.textContent = castWarn.hidden ? '' : `Terdeteksi ${parsed.speakers.length} pembicara: hanya ${MAX_SPEAKERS} yang didukung (${parsed.speakers.slice(MAX_SPEAKERS).map((s) => s.name).join(', ')} belum bisa dipakai).`;
    const ok = ls.length > 0 && !iss.length;
    const playing = !!run && run.source === 'stream' && player.pending > 0;
    playBtn.disabled = !ok && !playing;
    playBtn.innerHTML = S(playing ? 'stop' : 'play') + `<span>${playing ? 'Stop' : 'Putar dialog'}</span>`;
    dlBtn.disabled = !ok || !!dlCtrl;
    dlBtn.innerHTML = dlCtrl ? '<span class="spinner"></span><span>Membuat...</span>' : S('download') + '<span>Unduh MP3</span>';
  }
  playBtn.onclick = () => { if (run && run.source === 'stream' && player.pending > 0) { player.stop(); endRun(); return; } playFrom(0); };

  dlBtn.onclick = async () => {
    const ls = playable(); if (!ls.length || issues().length) return;
    if (run?.source === 'stream') { player.stop(); endRun(); }
    dlCtrl = new AbortController(); paint();
    result.replaceChildren();
    const g = settings.tune();
    const pauseMs = PACE[prefs().pace] ?? 250;
    try {
      const r = await api.raw('/tts/dialogue', { method: 'POST', signal: dlCtrl.signal, json: {
        pauseMs, download: true,
        lines: ls.map((l) => ({ speaker: l.name, text: l.text, voiceId: voiceOf(l.key), tune: { ...g, ...(tuneOf(l.key) || {}) } })),
      } });
      const blob = await r.blob();
      const offsets = (r.headers.get('x-line-offsets') || '').split(',').map(Number).filter((x) => Number.isFinite(x));
      const dur = Number(r.headers.get('x-audio-duration')) || null;
      const cd = r.headers.get('content-disposition') || '';
      const name = /filename="?([^";]+)"?/i.exec(cd)?.[1] || `dialog-${Date.now()}.mp3`;
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      const speakers = new Set(ls.map((l) => l.key)).size;
      const mp = miniPlayer(blob, { label: 'Dialog siap', sub: `${name} · ${speakers} pembicara · ${(blob.size / 1024).toFixed(0)} KB`, orb: orbSpecOf(ls[0].key, ls[0].name), accent: true, knownDuration: dur });
      result.replaceChildren(mp);
      followFile(mp.audio, ls, offsets);
      api.usageChanged(); o.onHistory();
    } catch (e: any) {
      if (e?.code !== 'aborted') ui.toast(e.message, { kind: 'bad', title: 'Gagal membuat MP3 dialog' });
    } finally { dlCtrl = null; paint(); }
  };
  /** While the merged mp3 plays, light the speaker of the line at the current time (X-Line-Offsets). */
  function followFile(a: HTMLAudioElement, ls: ScriptLine[], offsets: number[]) {
    if (offsets.length !== ls.length) return;
    let level = 0;
    fileLevel = () => level;
    const upd = () => {
      if (a.paused) { if (run?.source === 'file') endRun(); return; }
      if (!run || run.source !== 'file') { player.stop(); run = { lines: ls, gen: player.generation, state: ls.map(() => 'wait'), active: -1, source: 'file' }; }
      const t = a.currentTime;
      let i = 0; while (i + 1 < offsets.length && offsets[i + 1] <= t + 0.02) i++;
      const end = i + 1 < offsets.length ? offsets[i + 1] : (a.duration || t + 1);
      run.state = ls.map((_, k) => (k < i ? 'done' : k === i ? 'play' : 'wait'));
      level = 0.35 + 0.25 * Math.sin(t * 9);
      if (run.active !== i) { run.active = i; paintPlay(); }
      setProg(i, Math.min(1, (t - offsets[i]) / Math.max(0.2, end - offsets[i])));
    };
    for (const ev of ['play', 'pause', 'ended', 'timeupdate', 'seeked']) a.addEventListener(ev, upd);
  }

  /* ---------- layout ---------- */
  const el = h('div', { class: 'mspk stack' },
    castBox,
    editor,
    h('div', { class: 'mspk-pace' }, h('span', { class: 'mspk-pace-l' }, 'Jeda antar-baris'), pace),
    problems,
    stage,
    h('div', { class: 'tts-actions' }, playBtn, dlBtn),
    result,
    linesSec);

  function autosize() { ta.style.height = 'auto'; ta.style.height = Math.max(170, Math.min(ta.scrollHeight, 460)) + 'px'; syncBack(); }
  function onText() {
    settings.local.set('studio.dialog.draft', ta.value);
    if (undoText != null && !undoBtn.hidden && ta.value === undoText) { undoText = null; undoBtn.hidden = true; }
    parsed = parseScript(ta.value);
    ensureVoices();
    paintBack();
    syncRows();
    paintChips();
    autosize();
    paint();
  }
  ta.addEventListener('input', onText);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); playBtn.click(); } });

  onDisconnect(ta, player.on('change', () => {
    if (run?.source === 'stream' && (player.generation !== run.gen || player.pending === 0)) endRun();
    else paint();
  }));
  onDisconnect(ta, ctx.store.select((s) => s.voices, () => { ensureVoices(); paintRows(); paint(); }));
  ctx.data.config().then((c) => {
    maxChars = c.limits?.dialogueMaxChars || maxChars; maxLines = c.limits?.dialogueMaxLines || maxLines; lineMax = c.limits?.ttsMaxChars || lineMax;
    paint();
  }).catch(() => {});
  ctx.data.voices().then(() => { ensureVoices(); paintRows(); paint(); }).catch(() => {});
  onText();
  requestAnimationFrame(autosize);

  return {
    el,
    load(script, cast) {
      if (cast) for (const c of cast) if (c?.name && c.voiceId) setCast(speakerKey(c.name), { voiceId: c.voiceId });
      setText(script);
      requestAnimationFrame(autosize);
    },
    cleanup() { cancelAnimationFrame(raf); if (run?.source === 'stream') player.stop(); run = null; dlCtrl?.abort(); tagCtrl?.abort(); ro.disconnect(); },
  };
}
