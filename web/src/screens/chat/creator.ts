/* Persona creator / editor.
   The form logic (fields, "Bantu AI" research = POST /api/persona/assist {mode:'research'}, "Rapikan dengan AI" = mode
   'refine' with undo, the public-figure "Roleplay rules" clause kept apart, voice / language / accent / greeting, Studio
   Bola, validation) lives in ONE model, `personaForm()`. Two views use it:
   - the immersive "forge" (forge.ts): a glass sphere you fill with ingredients and step into (default);
   - the classic modal (below), used under prefers-reduced-motion (a plain form, no motion).
   Public API unchanged: openPersonaEditor(), createPersonaFlow(), offerAfterPersona(). */
import type { ScreenCtx } from '../../ctx';
import type { AssistResult, PersonaDraft } from '../../api';
import { h } from '../../ui/dom';
import { field, seg } from '../../ui/controls';
import { voicePicker, type VoicePicker } from '../../ui/voicepicker';
import { orb, thinkingLevel, cleanOrb, type CustomOrb, type OrbSpec } from '../../ui/orb';
import { receiveOrb, orbGhost, handOff } from '../../ui/transition';
import { openOrbStudio } from '../../ui/orbstudio';
import { type CustomPersona, LANGS, ACCENTS, cleanName, cleanAccent, langKey, langName, newId, orbSpecFor, splitClause, joinClause, saveCustom } from '../../lib/persona';
import { openForge } from './forge';
import { t } from '../../i18n';

export const IDEAS = [
  t('Kapten bajak laut tua yang bijak tapi suka melebih-lebihkan cerita'),
  t('Karakter seperti Sherlock Holmes dari cerita Arthur Conan Doyle'),
  t('Penyiar radio larut malam yang tenang dan puitis'),
];
const STAGES = [t('Membaca idemu...'), t('Mencari referensi...'), t('Membaca sumber...'), t('Menyusun sifat dan gaya bicara...'), t('Menulis kalimat pembuka...'), t('Hampir selesai...')];

export type FormField = 'name' | 'desc' | 'accent' | 'lang' | 'voice' | 'greet';
export type FormEvent =
  | { type: 'change'; field: FormField }
  | { type: 'busy'; on: boolean; kind: 'research' | 'refine' }
  | { type: 'stage'; text: string }
  | { type: 'applied'; kind: 'research' | 'refine'; result: AssistResult; changed: FormField[] }
  | { type: 'error'; kind: 'research' | 'refine'; text: string }
  | { type: 'undo' };

/** The persona form model: elements + behaviour, shared by the forge and the classic modal. */
export interface PersonaForm {
  isNew: boolean;
  name: HTMLInputElement; desc: HTMLTextAreaElement; clauseBox: HTMLElement; lang: HTMLSelectElement;
  acc: HTMLInputElement; accList: HTMLElement; vp: VoicePicker; greet: HTMLTextAreaElement;
  refineBtn: HTMLButtonElement; undoBtn: HTMLButtonElement; aiInfo: HTMLElement; msg: HTMLElement;
  idea: HTMLTextAreaElement; ideaLang: HTMLSelectElement; ideaChips: HTMLElement; researchBtn: HTMLButtonElement; stageText: HTMLElement; cancelBtn: HTMLButtonElement; aiErr: HTMLElement;
  voice(): string; orb(): CustomOrb | null; aiOrb(): boolean; spec(): OrbSpec; hasDraft(): boolean; busy(): boolean; filled(): Record<FormField, boolean>;
  assist(kind: 'research' | 'refine'): Promise<void>; abort(): void; openStudio(): void;
  /** null when it can be saved, else the problem and the field to show */
  check(): { problem: string; field: FormField } | null;
  result(): CustomPersona;
  on(fn: (e: FormEvent) => void): () => void;
  paintAi(): void;
}

export function personaForm(ctx: ScreenCtx, existing: CustomPersona | null, opts: { voiceId?: string } = {}): PersonaForm {
  const { ui, icons, api } = ctx;
  const S = icons.svg;
  const isNew = !existing;
  const d: CustomPersona = existing ? { ...existing } : { id: newId(), name: '', description: '', accent: '', lang: 'en', voiceId: opts.voiceId || '', greeting: '', createdAt: Date.now() };
  let ctrl: AbortController | null = null;
  let hasDraft = !isNew;
  let orbCustom = d.orb || null;
  let aiOrb = false;
  const subs = new Set<(e: FormEvent) => void>();
  const emit = (e: FormEvent) => subs.forEach((fn) => { try { fn(e); } catch (x) { console.error(x); } });

  // the server's "Roleplay rules" clause (public figures) is kept apart so editing can never drop it
  let clause = '';
  const name = h('input', { class: 'input', value: d.name, maxLength: 30, placeholder: t('mis. Kapten Rara'), autocomplete: 'off' }) as HTMLInputElement;
  const desc = h('textarea', { class: 'textarea', rows: 5, maxLength: 1500, placeholder: t('Siapa dia, sifatnya, cara bicaranya, situasinya.') }) as HTMLTextAreaElement;
  const clauseBox = h('div', { class: 'notice info pa-clause', hidden: true, html: S('shield') }, h('span', null, t('Aturan roleplay tokoh publik (simulasi AI, tidak mengaku sebagai orang aslinya) disertakan otomatis dan tetap tersimpan saat kamu mengedit.')));
  const setDesc = (full: string) => {
    const sp = splitClause(full);
    if (sp.clause) clause = sp.clause;
    desc.value = sp.base;
    desc.maxLength = Math.max(200, 1500 - (clause ? clause.length + 2 : 0));
    clauseBox.hidden = !clause;
  };
  setDesc(d.description);
  const lang = h('select', { class: 'select' }, ...LANGS.map(([k, l]) => new Option(l, k))) as HTMLSelectElement;
  lang.value = d.lang;
  const accId = 'acc-' + Math.random().toString(36).slice(2, 7);
  const acc = h('input', { class: 'input', value: d.accent, placeholder: t('Kosong = tanpa aksen khusus'), autocomplete: 'off', maxLength: 40 }) as HTMLInputElement;
  acc.setAttribute('list', accId);
  const accList = h('datalist', { id: accId }, ...ACCENTS.map((a) => h('option', { value: a })));
  const firstVoice = (ctx.store.get().voices || [])[0]?.id || '';
  let voice = d.voiceId || firstVoice;
  const vp = voicePicker({ value: voice, onChange: (v) => { voice = v; emit({ type: 'change', field: 'voice' }); }, emptyLabel: undefined, unknownLabel: t('Suara di luar koleksi') });
  const greet = h('textarea', { class: 'textarea', rows: 2, maxLength: 300, placeholder: t('Opsional. Contoh: Hey! Ready for an adventure?') }) as HTMLTextAreaElement;
  greet.value = d.greeting;
  const refineBtn = h('button', { type: 'button', class: 'btn soft sm', html: S('wand') }, h('span', null, t('Rapikan dengan AI'))) as HTMLButtonElement;
  const undoBtn = h('button', { type: 'button', class: 'btn ghost sm', hidden: true, html: S('refresh') }, h('span', null, t('Kembalikan'))) as HTMLButtonElement;
  const aiInfo = h('div', { class: 'pa-info' });
  const msg = h('div', { class: 'pa-msg' });
  name.addEventListener('input', () => emit({ type: 'change', field: 'name' }));
  desc.addEventListener('input', () => emit({ type: 'change', field: 'desc' }));
  acc.addEventListener('input', () => emit({ type: 'change', field: 'accent' }));
  lang.addEventListener('change', () => emit({ type: 'change', field: 'lang' }));
  greet.addEventListener('input', () => emit({ type: 'change', field: 'greet' }));

  /* ---------- AI path ---------- */
  const idea = h('textarea', { class: 'textarea', rows: 3, maxLength: 500, placeholder: t('Contoh: "karakter seperti Sherlock Holmes dari cerita Arthur Conan Doyle", atau vibe: ramah, sarkastis, suka kopi.') }) as HTMLTextAreaElement;
  const ideaLang = h('select', { class: 'select' }, new Option(t('Otomatis'), ''), ...LANGS.map(([k, l]) => new Option(l, k))) as HTMLSelectElement;
  const ideaChips = h('div', { class: 'pa-chips' }, ...IDEAS.map((s) => h('button', { type: 'button', class: 'chip', onclick: () => { idea.value = s; idea.focus({ preventScroll: true }); paintAi(); } }, s)));
  const researchBtn = h('button', { type: 'button', class: 'btn primary block lg', html: S('search') }, h('span', null, t('Cari referensi'))) as HTMLButtonElement;
  const stageText = h('div', { class: 'pa-stage', 'aria-live': 'polite' });
  const cancelBtn = ui.btn({ label: t('Batal'), cls: 'sm ghost', onClick: () => ctrl?.abort() });
  const aiErr = h('div');
  function paintAi() {
    researchBtn.disabled = !idea.value.trim() || !!ctrl;
    researchBtn.querySelector('span')!.textContent = hasDraft ? t('Cari ulang') : t('Cari referensi');
    ideaChips.hidden = hasDraft;
  }
  idea.addEventListener('input', paintAi);

  const draftNow = (): Partial<PersonaDraft> => ({ name: cleanName(name.value), description: joinClause(desc.value, clause), accent: cleanAccent(acc.value), language: langName(lang.value), greeting: greet.value.trim() });
  let undo: Partial<PersonaDraft> & { lang?: string } | null = null;

  function apply(r: AssistResult): FormField[] {
    const p = r.persona || ({} as PersonaDraft);
    const before = { name: name.value, desc: desc.value, accent: acc.value, lang: lang.value, greet: greet.value };
    if (p.name) name.value = cleanName(p.name);
    if (p.description) setDesc(String(p.description));
    if (p.accent !== undefined) acc.value = cleanAccent(p.accent);
    if (p.language) lang.value = langKey(p.language, lang.value);
    if (p.greeting !== undefined) greet.value = String(p.greeting).slice(0, 300);
    const srcs = (r.sources || []).filter((s) => { try { return /^https?:$/.test(new URL(s.url).protocol); } catch { return false; } }).slice(0, 8);
    const parts: Node[] = [];
    if (r.notes) parts.push(h('div', { class: 'notice ' + (r.redirected ? 'warn' : 'info'), html: S(r.redirected ? 'alert' : 'info') }, h('span', null, r.notes)));
    if (srcs.length) parts.push(h('div', { class: 'pa-sources' }, h('span', { class: 'label' }, t('Sumber')),
      h('ul', null, ...srcs.map((s) => h('li', null, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: 'src-link', html: S('external') },
        h('span', null, s.title || new URL(s.url).hostname), h('small', null, new URL(s.url).hostname.replace(/^www\./, ''))))))));
    aiInfo.replaceChildren(...parts);
    hasDraft = true;
    // the AI's orb (iconic colours / style of the character): applied right away; Studio Bola can change it
    const ao = r.orb ? cleanOrb({ colors: r.orb.colors, style: r.orb.style, speed: r.orb.speed, soft: r.orb.smooth, shape: r.orb.shape }) : null;
    if (ao) { orbCustom = ao; aiOrb = true; }
    const changed: FormField[] = [];
    if (name.value !== before.name) changed.push('name');
    if (desc.value !== before.desc) changed.push('desc');
    if (acc.value !== before.accent) changed.push('accent');
    if (lang.value !== before.lang) changed.push('lang');
    if (greet.value !== before.greet) changed.push('greet');
    return changed;
  }

  async function assist(kind: 'research' | 'refine') {
    if (ctrl) return;
    const ideaText = kind === 'research' ? idea.value.trim() : (desc.value.trim() || name.value.trim());
    if (!ideaText) {
      const text = kind === 'research' ? t('Tulis idenya dulu.') : t('Isi nama atau deskripsi dulu, lalu rapikan.');
      (kind === 'research' ? aiErr : msg).replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, text)));
      emit({ type: 'error', kind, text });
      return;
    }
    msg.replaceChildren(); aiErr.replaceChildren();
    if (kind === 'refine') undo = { ...draftNow(), lang: lang.value };
    ctrl = new AbortController();
    let i = 0;
    const stage = (tx: string) => { stageText.textContent = tx; emit({ type: 'stage', text: tx }); };
    stage(kind === 'refine' ? t('Merapikan persona...') : STAGES[0]);
    const timer = setInterval(() => { i = Math.min(STAGES.length - 1, i + 1); if (kind === 'research') stage(STAGES[i]); }, 2600);
    emit({ type: 'busy', on: true, kind });
    paintAi();
    try {
      const lg = kind === 'research' ? ideaLang.value : lang.value;
      // refine sends the draft itself (idea is limited to 500 chars and only meant for research)
      const r = await api.personaAssist({ mode: kind, idea: kind === 'research' ? ideaText.slice(0, 500) : '', ...(kind === 'refine' ? { draft: draftNow() } : {}), ...(lg ? { language: langName(lg) } : {}) }, ctrl.signal);
      const changed = apply(r);
      undoBtn.hidden = kind !== 'refine';
      ui.toast(kind === 'refine' ? t('Persona dirapikan. Periksa lalu simpan.') : t('Draf persona siap. Ubah sesukamu lalu simpan.'), { kind: 'ok', timeout: 2600 });
      clearInterval(timer); ctrl = null;
      emit({ type: 'busy', on: false, kind });
      emit({ type: 'applied', kind, result: r, changed });
    } catch (e: any) {
      clearInterval(timer); ctrl = null;
      emit({ type: 'busy', on: false, kind });
      if (e?.code !== 'aborted') {
        const text = e?.status === 404 ? t('Fitur Bantu AI belum tersedia di server.') : e?.message || t('Gagal menghubungi AI.');
        const box = kind === 'research' ? aiErr : msg;
        box.replaceChildren(h('div', { class: 'notice bad', html: S('alert') }, h('span', null, text),
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => assist(kind) }, t('Coba lagi'))));
        emit({ type: 'error', kind, text });
      }
    } finally {
      paintAi();
    }
  }
  researchBtn.onclick = () => assist('research');
  refineBtn.onclick = () => assist('refine');
  undoBtn.onclick = () => {
    if (!undo) return;
    name.value = undo.name || ''; setDesc(undo.description || ''); acc.value = undo.accent || ''; greet.value = undo.greeting || ''; if (undo.lang) lang.value = undo.lang;
    undo = null; undoBtn.hidden = true; aiInfo.replaceChildren();
    emit({ type: 'undo' });
  };

  const form: PersonaForm = {
    isNew, name, desc, clauseBox, lang, acc, accList, vp, greet, refineBtn, undoBtn, aiInfo, msg, idea, ideaLang, ideaChips, researchBtn, stageText, cancelBtn, aiErr,
    voice: () => voice, orb: () => orbCustom, aiOrb: () => aiOrb,
    spec: () => orbSpecFor({ voiceId: voice, name: cleanName(name.value) || 'Persona', orb: orbCustom }),
    hasDraft: () => hasDraft, busy: () => !!ctrl,
    filled: () => ({ name: !!cleanName(name.value), desc: !!desc.value.trim(), accent: !!cleanAccent(acc.value), lang: true, voice: !!voice, greet: !!greet.value.trim() }),
    assist, abort: () => ctrl?.abort(), paintAi,
    openStudio: () => {
      const nm = cleanName(name.value) || 'Persona';
      openOrbStudio({
        title: t('Studio Bola'), subtitle: t('Bola untuk {nm}', { nm }), initial: orbCustom, base: orbSpecFor({ voiceId: voice, name: nm }), seedKey: 'p:' + nm.toLowerCase(),
        resetLabel: t('Ikuti bola suara'), onSave: (o) => { orbCustom = o; aiOrb = false; emit({ type: 'change', field: 'voice' }); },
      });
    },
    check: () => {
      const nm = cleanName(name.value), ds = desc.value.trim();
      if (!nm) return { problem: t('Isi nama persona.'), field: 'name' };
      if (!ds) return { problem: t('Isi deskripsi dan sifat persona.'), field: 'desc' };
      if (!voice) return { problem: t('Pilih suara dari koleksimu (atau tambahkan dulu dari Library).'), field: 'voice' };
      return null;
    },
    result: () => ({ ...d, name: cleanName(name.value), description: joinClause(desc.value.trim(), clause), orb: orbCustom, lang: lang.value, accent: cleanAccent(acc.value), voiceId: voice, greeting: greet.value.trim() }),
    on: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
  paintAi();
  // the collection may still be loading: pick its first voice for a new persona
  if (!voice) ctx.data.voices().then((l) => { if (!voice && l[0]) { voice = l[0].id; vp.setValue(voice); emit({ type: 'change', field: 'voice' }); } }).catch(() => {});
  return form;
}

const reduceMq = matchMedia('(prefers-reduced-motion: reduce)');

/** `onClosed(saved)` runs once the editor is gone (saved or not), e.g. to bring the screen's own orb back. */
export function openPersonaEditor(ctx: ScreenCtx, existing: CustomPersona | null, onSaved: (p: CustomPersona, isNew: boolean) => void, opts: { voiceId?: string; onClosed?: (saved: boolean) => void } = {}): void {
  // one editor at a time (a double / spam click on an opener does not stack a second one)
  if (document.querySelector('.pf:not(.closing)')) return;
  // reduced motion: the plain form (no sphere, no flights); otherwise the immersive forge
  if (reduceMq.matches || (window as unknown as { __classicPersona?: boolean }).__classicPersona) { openClassicEditor(ctx, existing, onSaved, opts); return; }
  openForge(ctx, personaForm(ctx, existing, opts), onSaved, opts.onClosed);
}

/** The plain modal editor (reduced motion). */
export function openClassicEditor(ctx: ScreenCtx, existing: CustomPersona | null, onSaved: (p: CustomPersona, isNew: boolean) => void, opts: { voiceId?: string; onClosed?: (saved: boolean) => void } = {}): void {
  const { ui, icons } = ctx;
  const S = icons.svg;
  const f = personaForm(ctx, existing, opts);
  const isNew = f.isNew;
  let mode: 'ai' | 'manual' = isNew ? 'ai' : 'manual';
  const formEl = h('div', { class: 'stack pa-form' },
    h('div', { class: 'pa-form-h' }, h('span', { class: 'label' }, t('Detail persona')), h('div', { class: 'row' }, f.undoBtn, f.refineBtn)),
    field(t('Nama'), f.name),
    field(t('Deskripsi & sifat'), f.desc, t('Bahasa Indonesia atau Inggris, bebas.')),
    f.clauseBox,
    h('div', { class: 'grid-2' }, field(t('Bahasa'), f.lang), field(t('Aksen'), h('div', { style: 'display:contents' }, f.acc, f.accList))),
    field(t('Suara'), f.vp),
    field(t('Kalimat pembuka'), f.greet, t('Ditampilkan saat percakapan dimulai. Boleh pakai audio tag seperti [laughs].')),
    f.aiInfo);
  const headOrb = orb(f.spec(), { size: 64, cls: 'pa-orb' });
  const headName = h('b');
  const headSub = h('span');
  const orbBtn = h('button', { type: 'button', class: 'btn sm soft pa-orbbtn', html: S('palette') }, h('span', null, t('Bola')));
  orbBtn.title = t('Bentuk bola persona ini (Studio Bola)');
  orbBtn.onclick = () => f.openStudio();
  const head = h('div', { class: 'pa-head' }, headOrb, h('div', { class: 'pa-head-t' }, headName, headSub), orbBtn);
  function paintHead() {
    headOrb.setSpec(f.spec());
    headName.textContent = cleanName(f.name.value) || (isNew ? t('Persona baru') : t('Persona'));
    headSub.textContent = [LANGS.find((l) => l[0] === f.lang.value)?.[1], cleanAccent(f.acc.value) ? t('aksen {accent}', { accent: cleanAccent(f.acc.value) }) : ''].filter(Boolean).join(' · ');
  }
  const loadOrb = orb(f.spec(), { size: 96 });
  const loading = h('div', { class: 'pa-loading', hidden: true },
    loadOrb, f.stageText,
    h('div', { class: 'pa-skel' }, h('span', { class: 'skel', style: 'height:14px;width:70%' }), h('span', { class: 'skel', style: 'height:12px;width:92%' }), h('span', { class: 'skel', style: 'height:12px;width:84%' })),
    f.cancelBtn);
  const aiPane = h('div', { class: 'stack pa-ai' },
    field(t('Ide karakter'), f.idea, t('Tulis singkat. AI mencari referensi lalu menyusun draf yang bisa kamu ubah.')),
    f.ideaChips, field(t('Bahasa persona'), f.ideaLang), f.researchBtn, f.aiErr);
  const modeSeg = seg<'ai' | 'manual'>([['ai', t('Bantu AI'), 'sparkle'], ['manual', t('Manual'), 'edit']], mode, (v) => { mode = v; paint(); }, t('Cara membuat'), true);
  const body = h('div', { class: 'stack pa' }, head, isNew ? modeSeg : null, aiPane, loading, formEl, f.msg);
  const save = ui.btn({ label: isNew ? t('Simpan persona') : t('Simpan'), cls: 'primary' });
  const cancel = ui.btn({ label: t('Batal'), cls: 'ghost' });
  let savedIt = false;
  const m = ui.modal({ title: isNew ? t('Persona baru') : t('Edit persona'), cls: 'persona-dlg', body, actions: [cancel, save], onClose: () => { f.abort(); queueMicrotask(() => opts.onClosed?.(savedIt)); } });
  function paint() {
    const busy = f.busy();
    aiPane.hidden = mode !== 'ai' || busy;
    loading.hidden = !busy;
    formEl.hidden = busy || (mode === 'ai' && !f.hasDraft());
    f.refineBtn.hidden = mode === 'ai' && !f.hasDraft();
    save.disabled = busy || (mode === 'ai' && !f.hasDraft());
    f.paintAi();
  }
  f.on((e) => {
    if (e.type === 'change' || e.type === 'undo') paintHead();
    if (e.type === 'busy') { if (e.on) { loadOrb.setSpec(f.spec()); loadOrb.setLive(true, thinkingLevel()); } else loadOrb.setLive(false); paint(); }
    if (e.type === 'applied') { paintHead(); if (e.kind === 'research') requestAnimationFrame(() => formEl.scrollIntoView({ block: 'start', behavior: 'smooth' })); }
  });
  cancel.onclick = () => m.close();
  save.onclick = () => {
    const c = f.check();
    if (c) {
      f.msg.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, c.problem)));
      (c.field === 'name' ? f.name : c.field === 'desc' ? f.desc : f.vp).scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const out = f.result();
    savedIt = true;
    m.close();
    onSaved(out, isNew);   // (onClosed runs after this, in a microtask)
  };
  paintHead(); paint();
}

/** One flow for "Buat persona" everywhere (Chat, after a clone, intro): editor -> save -> offer Studio Bola / start talking. */
export function createPersonaFlow(ctx: ScreenCtx, opts: { voiceId?: string; onCreated?: (p: CustomPersona) => void; onClosed?: (saved: boolean) => void } = {}): void {
  openPersonaEditor(ctx, null, (out) => {
    saveCustom(out);
    opts.onCreated?.(out);
    offerAfterPersona(ctx, out);
  }, { voiceId: opts.voiceId, onClosed: opts.onClosed });
}

/** "Persona siap": big orb, start talking, or shape its orb first. */
export function offerAfterPersona(ctx: ScreenCtx, p: CustomPersona): void {
  const { ui, icons } = ctx;
  const S = icons.svg;
  let cur = p;
  const big = orb(orbSpecFor(cur), { size: 132, cls: 'offer-orb', live: true, label: t('Bola {name}', { name: cur.name }) });
  const talk = h('button', { type: 'button', class: 'btn primary lg block', html: S('chat') }, h('span', null, t('Ngobrol dengan {name}', { name: cur.name })));
  const shape = h('button', { type: 'button', class: 'btn soft lg block', html: S('palette') }, h('span', null, cur.orb ? t('Ubah bolanya') : t('Bentuk bolanya')));
  const m = ui.modal({ title: t('Persona siap'), cls: 'offer-dlg', body: h('div', { class: 'offer' }, big,
    h('h3', null, cur.name), h('p', null, t('Kamu bisa langsung ngobrol dengan suara, atau bentuk dulu bola miliknya di Studio Bola.')), talk, shape) });
  // match-cut: the persona editor hands its orb over; it flies onto this one (nothing happens otherwise)
  void receiveOrb(big);
  // shared element: this orb flies onto the chat's big orb
  talk.onclick = () => { const g = orbGhost(big); m.close(); if (g) handOff(g); ctx.navigate('chat/' + encodeURIComponent(cur.id)); };
  shape.onclick = () => openOrbStudio({
    title: t('Studio Bola'), subtitle: t('Bola untuk {nm}', { nm: cur.name }), initial: cur.orb || null, base: orbSpecFor({ voiceId: cur.voiceId, name: cur.name }), seedKey: 'p:' + cur.name.toLowerCase(),
    resetLabel: t('Ikuti bola suara'),
    onSave: (o) => { cur = { ...cur, orb: o }; saveCustom(cur); big.setSpec(orbSpecFor(cur)); shape.querySelector('span')!.textContent = t('Ubah bolanya'); ui.toast(t('Bola tersimpan.'), { kind: 'ok', timeout: 1800 }); },
  });
}
