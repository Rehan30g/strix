/* Voice picker: a compact button (magic orb + name) that opens a searchable sheet of the user's COLLECTION
   (own clones, shared, voices added from the Library) with previews and a "Cari di Library" link.
   Used by TTS, Voice Changer and the persona editor. */
import { h, onDisconnect } from './dom';
import { svg } from '../icons';
import { modal, toast } from './overlay';
import { loadVoices, store } from '../store';
import { player } from '../player';
import { orb, voiceOrb, type OrbEl } from './orb';
import { shortName, categoryLabel } from '../lib/collection';
import type { Voice } from '../api';

export { shortName };

export function voiceMeta(v: Voice): string {
  const l = v.labels || {};
  const parts = [l.gender, l.accent, l.age, l.descriptive || l.description].filter(Boolean).map((x) => String(x).replace(/_/g, ' ').replace(/(^|\s)(\p{L})/gu, (_m, a: string, c: string) => a + c.toUpperCase()));
  return parts.slice(0, 3).join(' · ');
}

/** Voice id whose preview is playing right now ('' when none). */
let previewing = '';
player.on('change', () => { if (!player.busy) queueMicrotask(() => { if (!player.busy) previewing = ''; }); });
export const previewingId = () => (player.busy ? previewing : '');

/** Amplitude of a voice's preview (0 when something else plays). */
export const previewLevel = (id: string) => () => { const l = player.level(); return l.who === 'preview:' + id ? l.amp : 0; };

/** Play a short sample of a voice: the (same-origin, proxied) preview mp3 when there is one, otherwise one TTS sentence. */
export async function previewVoice(v: Voice): Promise<void> {
  previewing = v.id;
  if (v.previewUrl) {
    try { await player.playUrl(v.previewUrl, 'preview:' + v.id); }
    catch { previewing = ''; toast('Contoh suara tidak bisa diputar.', { kind: 'bad' }); }
    return;
  }
  player.stop();
  previewing = v.id;
  player.speak(`Hi! This is ${shortName(v)}. Nice to meet you.`, { voiceId: v.id, who: 'preview:' + v.id });
}

/** Orb button that previews a voice (corner badge shows play / stop; the orb animates while it plays). */
export function voiceOrbButton(v: Voice, size = 44): HTMLButtonElement {
  const o = orb(voiceOrb(v.id), { size });
  const badge = h('span', { class: 'ob-badge', html: svg('play') });
  const b = h('button', { type: 'button', class: 'orb-btn', 'aria-label': `Putar contoh ${shortName(v)}` }, o, badge);
  const sync = () => {
    const on = previewingId() === v.id;
    badge.innerHTML = svg(on ? 'stop' : 'play');
    b.classList.toggle('on', on);
    b.setAttribute('aria-label', `${on ? 'Hentikan' : 'Putar'} contoh ${shortName(v)}`);
    o.setLive(on, previewLevel(v.id));
  };
  b.onclick = (e) => { e.stopPropagation(); if (previewingId() === v.id) player.stop(); else previewVoice(v); sync(); };
  onDisconnect(b, player.on('change', sync));
  sync();
  return b;
}

export interface VoicePicker extends HTMLElement { value: string; setValue(id: string): void; orb: OrbEl }

export function voicePicker(o: { value: string; onChange: (id: string) => void; label?: string; emptyLabel?: string; emptyHint?: string; unknownLabel?: string; liveWhenBusy?: () => boolean }): VoicePicker {
  let value = o.value;
  const name = h('span', { class: 'vp-name' });
  const meta = h('span', { class: 'vp-meta' });
  const ob = orb(voiceOrb(value), { size: 40 });
  const btn = h('button', { type: 'button', class: 'vp-btn', 'aria-haspopup': 'dialog', 'aria-label': o.label || 'Pilih suara' },
    ob, h('span', { class: 'vp-t' }, name, meta), h('span', { class: 'vp-chev', html: svg('chevronDown') }));
  const play = h('button', { type: 'button', class: 'btn icon vp-play', title: 'Dengarkan contoh', 'aria-label': 'Dengarkan contoh suara', html: svg('play') });
  const el = h('div', { class: 'vp' }, btn, play) as unknown as VoicePicker;
  el.orb = ob;

  const find = (id: string) => (store.get().voices || []).find((v) => v.id === id);
  /** A voice that is allowed but not in the collection (e.g. a persona's default). */
  const pseudo = (id: string): Voice => ({ id, name: o.unknownLabel || 'Suara bawaan', category: 'premade', own: false });
  const paint = () => {
    const v = find(value);
    ob.setSpec(voiceOrb(value));
    ob.classList.toggle('empty', !value);
    if (!value) { name.textContent = o.emptyLabel || 'Pilih suara'; meta.textContent = o.emptyHint || ''; }
    else if (v) { name.textContent = shortName(v); meta.textContent = [categoryLabel(v), voiceMeta(v)].filter(Boolean).join(' · '); }
    else { name.textContent = store.get().voices ? o.unknownLabel || 'Suara di luar koleksi' : 'Memuat suara...'; meta.textContent = store.get().voices ? 'Ketuk untuk memilih dari koleksimu' : ''; }
    play.disabled = !value || !store.get().voices;
    syncPlay();
  };
  const level = () => { const l = player.level(); return l.who === 'preview:' + value || (o.liveWhenBusy?.() && l.who && !l.who.startsWith('preview:')) ? l.amp : 0; };
  function syncPlay() {
    const mine = previewingId() === value && !!value;
    play.innerHTML = svg(mine ? 'stop' : 'play');
    ob.setLive(!!value && player.busy && (mine || !!o.liveWhenBusy?.()), level);
  }
  Object.defineProperty(el, 'value', { get: () => value, set: (v: string) => { value = v; paint(); } });
  el.setValue = (id) => { value = id; paint(); };

  play.onclick = () => {
    if (!value) return;
    if (previewingId() === value) { player.stop(); return; }
    previewVoice(find(value) || pseudo(value));
  };
  onDisconnect(el, player.on('change', syncPlay));
  onDisconnect(el, store.select((s) => s.voices, paint));
  btn.onclick = () => openVoiceList(value, (id) => { value = id; paint(); o.onChange(id); }, o.emptyLabel, value && !find(value) ? pseudo(value) : null);
  paint();
  loadVoices().then(paint).catch(() => { name.textContent = 'Gagal memuat suara'; });
  return el;
}

function openVoiceList(current: string, pick: (id: string) => void, emptyLabel?: string, extra?: Voice | null) {
  let q = '';
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Cari di koleksimu...', 'aria-label': 'Cari suara', autocomplete: 'off' }) as HTMLInputElement;
  const list = h('div', { class: 'vl', role: 'listbox', 'aria-label': 'Koleksi suara' });
  const libLink = h('a', { class: 'vl-lib', href: '#/voices/library', html: svg('search') }, h('span', null, h('b', null, 'Cari di Library'), h('small', null, 'Tambah suara baru ke koleksimu')), h('span', { class: 'vl-lib-ch', html: svg('chevronRight') }));
  const body = h('div', { class: 'vl-wrap' }, h('div', { class: 'vl-search', html: svg('search') }, search), list, libLink);
  const m = modal({ title: 'Pilih suara', body, cls: 'vl-dlg' });

  const row = (v: Voice | null) => {
    const id = v?.id || '';
    const sel = id === current;
    const lead = v ? voiceOrbButton(v, 40) : h('span', { class: 'vl-play ghost', html: svg('sparkle') });
    const r = h('div', { class: 'vl-row' + (sel ? ' sel' : ''), role: 'option', 'aria-selected': String(sel), tabindex: '0' },
      lead,
      h('div', { class: 'vl-t' }, h('b', null, v ? shortName(v) : emptyLabel || ''), h('span', null, v ? (voiceMeta(v) || categoryLabel(v)) : 'Pakai suara bawaan')),
      v && v.category === 'shared' ? h('span', { class: 'badge accent' }, 'Bersama') : null,
      sel ? h('span', { class: 'vl-check', html: svg('check') }) : null);
    const choose = () => { player.stop(); pick(id); m.close(); };
    r.onclick = choose;
    r.onkeydown = (e) => { if (e.target === r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(); } };
    return r;
  };
  const paint = () => {
    const all = store.get().voices;
    if (!all) { list.replaceChildren(...[0, 1, 2, 3].map(() => h('div', { class: 'skel', style: 'height:52px;margin:4px 0' }))); return; }
    const match = (v: Voice) => !q || `${v.name} ${Object.values(v.labels || {}).join(' ')} ${v.description || ''}`.toLowerCase().includes(q);
    const own = all.filter((v) => v.own && match(v)), shared = all.filter((v) => !v.own && v.category === 'shared' && match(v)), rest = all.filter((v) => !v.own && v.category !== 'shared' && match(v));
    const out: Node[] = [];
    if (emptyLabel !== undefined && !q) out.push(row(null));
    if (extra && !q) out.push(h('div', { class: 'vl-sec' }, 'Bawaan persona'), row(extra));
    if (own.length) out.push(h('div', { class: 'vl-sec' }, 'Milikmu'), ...own.map(row));
    if (shared.length) out.push(h('div', { class: 'vl-sec' }, 'Bersama'), ...shared.map(row));
    if (rest.length) out.push(h('div', { class: 'vl-sec' }, 'Dari Library'), ...rest.map(row));
    if (!own.length && !rest.length && !shared.length) out.push(h('div', { class: 'empty', style: 'padding:28px 8px' }, h('p', null, q ? 'Tidak ada yang cocok di koleksimu.' : 'Koleksimu masih kosong. Tambahkan suara dari Library.')));
    list.replaceChildren(...out);
  };
  search.oninput = () => { q = search.value.trim().toLowerCase(); paint(); };
  onDisconnect(list, store.select((s) => s.voices, paint));
  paint();
  loadVoices().then(paint).catch((e) => list.replaceChildren(h('div', { class: 'notice bad', html: svg('alert') }, h('span', null, e.message))));
  requestAnimationFrame(() => list.querySelector<HTMLElement>('.vl-row.sel')?.scrollIntoView({ block: 'center' }));
}
