/* Reusable form controls bound to settings. */
import { h, onDisconnect } from './dom';
import { svg } from '../icons';
import { settings, TUNE_DEFAULT } from '../settings';
import type { Tune } from '../api';
import { t } from '../i18n';

let uid = 0;
const nextId = (p: string) => `${p}-${++uid}`;

export function field(label: string, control: HTMLElement, hint?: string | Node): HTMLElement {
  const target: HTMLElement = (control as any).input || control;
  const id = target.id || nextId('f');
  target.id = id;
  const hintEl = hint ? h('div', { class: 'hint', id: id + '-hint' }, hint) : null;
  if (hintEl) target.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, hintEl);
}

export function switchRow(label: string, checked: boolean, onChange: (v: boolean) => void, hint?: string): HTMLLabelElement & { input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', role: 'switch', checked }) as HTMLInputElement;
  input.onchange = () => onChange(input.checked);
  const el = h('label', { class: 'switch' }, h('span', { class: 'sw-text' }, label, hint ? h('small', null, hint) : null), input) as HTMLLabelElement & { input: HTMLInputElement };
  el.input = input;
  return el;
}

export function slider(o: { label: string; min: number; max: number; step: number; value: number; onInput: (v: number) => void; hint?: string; fmt?: (v: number) => string }): HTMLElement & { setValue: (v: number) => void } {
  const id = nextId('rng');
  const fmt = o.fmt || ((v: number) => v.toFixed(2));
  const out = h('output', { for: id }, fmt(o.value));
  const input = h('input', { type: 'range', id, min: String(o.min), max: String(o.max), step: String(o.step), value: String(o.value) }) as HTMLInputElement;
  input.oninput = () => { const v = Number(input.value); out.textContent = fmt(v); o.onInput(v); };
  const el = h('div', { class: 'slider' }, h('label', { class: 'label', for: id }, o.label), out, input, o.hint ? h('div', { class: 'hint' }, o.hint) : null) as unknown as HTMLElement & { setValue: (v: number) => void };
  el.setValue = (v) => { input.value = String(v); out.textContent = fmt(v); };
  return el;
}

export function seg<T extends string>(options: Array<[T, string, string?]>, value: T, onChange: (v: T) => void, label: string, block = false): HTMLElement & { setValue: (v: T) => void } {
  const el = h('div', { class: 'seg' + (block ? ' block' : ''), role: 'group', 'aria-label': label }) as unknown as HTMLElement & { setValue: (v: T) => void };
  const btns = options.map(([v, text, icon]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value), html: icon ? svg(icon) : '' }, text);
    b.onclick = () => { el.setValue(v); onChange(v); };
    el.append(b);
    return [v, b] as const;
  });
  el.setValue = (v) => btns.forEach(([x, b]) => b.setAttribute('aria-pressed', String(x === v)));
  return el;
}

export const ACCENTS = ['American', 'British', 'Australian', 'Irish', 'Scottish', 'Canadian', 'Indian', 'Southern US', 'New York', 'Jamaican', 'South African', 'French', 'German', 'Italian', 'Spanish', 'Russian', 'Japanese', 'Korean', 'Indonesian', 'Brazilian'];
export function accentInput(o: { value: string; onChange: (v: string) => void; id?: string }): HTMLElement & { input: HTMLInputElement } {
  const listId = nextId('accents');
  const input = h('input', { class: 'input', id: o.id, value: o.value, placeholder: t('Kosong = bawaan, atau ketik bebas'), autocomplete: 'off' }) as HTMLInputElement;
  input.setAttribute('list', listId);
  input.addEventListener('change', () => o.onChange(input.value.replace(/[^\p{L}\s,'-]/gu, '').trim().slice(0, 40)));
  const dl = h('datalist', { id: listId }, ...ACCENTS.map((a) => h('option', { value: a })));
  const wrap = h('div', { style: 'display:contents' }, input, dl) as unknown as HTMLElement & { input: HTMLInputElement };
  wrap.input = input;
  return wrap;
}

/* ---------- TTS tune ---------- */
export function tuneControls(opts: { compact?: boolean } = {}): HTMLElement {
  const tn = settings.tune();
  const set = (k: keyof Tune) => (v: number) => settings.setTune({ [k]: v } as Partial<Tune>);
  const rows = {
    stability: slider({ label: 'Stability', min: 0, max: 1, step: 0.05, value: tn.stability, onInput: set('stability'), hint: opts.compact ? undefined : t('Rendah = ekspresif (audio tag lebih kuat). Tinggi = stabil/monoton.') }),
    similarity: slider({ label: 'Similarity', min: 0, max: 1, step: 0.05, value: tn.similarity, onInput: set('similarity'), hint: opts.compact ? undefined : t('Tinggi = lebih mirip suara asli/clone.') }),
    style: slider({ label: 'Style', min: 0, max: 1, step: 0.05, value: tn.style, onInput: set('style'), hint: opts.compact ? undefined : t('Menambah gaya; tinggi bisa menjauh dari clone.') }),
    speed: slider({ label: 'Speed', min: 0.7, max: 1.2, step: 0.05, value: tn.speed, onInput: set('speed'), fmt: (v) => v.toFixed(2) + 'x' }),
  };
  const boost = switchRow('Speaker boost', tn.speakerBoost, (v) => settings.setTune({ speakerBoost: v }), opts.compact ? undefined : t('Sedikit lebih jernih, sedikit lebih lambat.'));
  const reset = h('button', { type: 'button', class: 'btn sm ghost', html: svg('refresh') }, t('Reset tuning'));
  const sync = (v: Tune) => { (Object.keys(rows) as Array<keyof typeof rows>).forEach((k) => rows[k].setValue(v[k])); boost.input.checked = !!v.speakerBoost; };
  reset.onclick = () => { settings.set('tune', { ...TUNE_DEFAULT }); };
  const el = h('div', { class: 'stack', style: 'gap:14px' }, rows.stability, rows.similarity, rows.style, rows.speed, boost, h('div', null, reset));
  onDisconnect(el, settings.subscribe<Tune>('tune', sync));
  return el;
}

export const STT_LANGS: Array<[string, string]> = [['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['en-AU', 'English (Australia)'], ['id-ID', t('Indonesia')]];
export function sttSelect(value: string, onChange: (v: string) => void): HTMLSelectElement {
  const s = h('select', { class: 'select' }, ...STT_LANGS.map(([v, l]) => new Option(l, v))) as HTMLSelectElement;
  s.value = value; s.onchange = () => onChange(s.value);
  return s;
}
