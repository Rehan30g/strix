/* The tour's panels: small, real pieces of the app's own screens (same markup classes and CSS tokens as Chat, TTS,
   Voice Changer and Voices), isolated in `.tu-panel` so nothing here touches the real screens. They are flat cards
   that the camera (cam.ts) places in 3D. Orbs are NOT drawn in the DOM: each orb position is an empty `.tu-slot`
   whose centre / size the tour reads once and draws on the canvas, so every orb stays perfectly round whatever the
   panel's tilt. Behaviour lives in tour.ts; these builders only make the DOM and hand back references. */
import { h } from '../dom';
import { svg } from '../../icons';
import { Captions } from '../../lib/captions';

export const PW = 340;
export interface Slot { el: HTMLElement; u: number; v: number; r: number }
export interface PanelBase { id: 'chat' | 'tts' | 'vc' | 'voices'; el: HTMLElement; w: number; h: number; slots: Record<string, Slot>; title: string }

const S = svg;
const slot = (name: string, size: number, cls = '') => h('span', { class: 'tu-slot ' + cls, 'data-slot': name, style: `--s:${size}px`, 'aria-hidden': 'true' });
/** hgt 0 = as tall as its content (read back by measure) */
function card(id: PanelBase['id'], title: string, icon: string, hgt: number, ...kids: Array<Node | null>): HTMLElement {
  return h('section', { class: `tu-panel tu-${id}`, style: `width:${PW}px;` + (hgt ? `height:${hgt}px` : ''), 'aria-label': title, hidden: true },
    h('header', { class: 'tu-ph' }, h('span', { class: 'tu-ph-ic', html: S(icon) }), h('b', null, title)), ...kids);
}
/** read slot centres (panel-local px) once the panel is laid out */
export function measure(p: PanelBase): void {
  p.h = p.el.offsetHeight || p.h;
  p.el.querySelectorAll<HTMLElement>('.tu-slot').forEach((el) => {
    let u = el.offsetWidth / 2, v = el.offsetHeight / 2, n: HTMLElement | null = el;
    while (n && n !== p.el) { u += n.offsetLeft; v += n.offsetTop; n = n.offsetParent as HTMLElement | null; }
    p.slots[el.dataset.slot!] = { el, u, v, r: (el.offsetWidth / 2) * 0.88 };
  });
}

/* ---------- Chat ---------- */
export interface ChatPanel extends PanelBase { caps: Captions; you: HTMLElement; status: HTMLElement; input: HTMLTextAreaElement; send: HTMLButtonElement; mic: HTMLButtonElement; form: HTMLFormElement; chips: HTMLButtonElement[] }
export const CHIPS = ['Hi Strix!', 'Tell me something weird'];
/** normal height of the chat panel (with the keyboard open the tour fits it to the visible area) */
export const CHAT_H = 452;
export function chatPanel(): ChatPanel {
  const caps = new Captions(2);
  const you = h('div', { class: 'vx-you' });
  const status = h('div', { class: 'vx-status tu-status' });
  const chips = CHIPS.map((c) => h('button', { type: 'button', class: 'vx-chip tu-chip' }, h('span', null, c)) as HTMLButtonElement);
  const input = h('textarea', { class: 'vx-input', rows: 1, placeholder: 'Say hi…', 'aria-label': 'Message to Strix', enterkeyhint: 'send', maxLength: 200 }) as HTMLTextAreaElement;
  const mic = h('button', { type: 'button', class: 'vx-mic', 'aria-label': 'Microphone', html: S('mic') }) as HTMLButtonElement;
  const send = h('button', { type: 'submit', class: 'vx-send', 'aria-label': 'Send', html: S('arrowUp') }) as HTMLButtonElement;
  const form = h('form', { class: 'vx-bar tu-bar' }, mic, input, send) as HTMLFormElement;
  const el = card('chat', 'Chat', 'chat', CHAT_H,
    h('div', { class: 'tu-who' }, h('span', null, 'Strix'), h('span', { class: 'tu-who-c', html: S('chevronDown') })),
    h('div', { class: 'tu-cstage' }, caps.el, caps.live),
    you, h('div', { class: 'tu-orbrow' }, slot('orb', 112)), status,
    h('div', { class: 'tu-chips' }, ...chips), h('div', { class: 'tu-barwrap' }, form));
  caps.block('hi', 'prev'); caps.show('Hey! What would you like to talk about?');
  return { id: 'chat', el, w: PW, h: CHAT_H, slots: {}, title: 'Chat', caps, you, status, input, send, mic, form, chips };
}

/* ---------- Text to Speech ---------- */
export interface TtsPanel extends PanelBase { text: HTMLElement; fx: HTMLButtonElement; play: HTMLButtonElement; note: HTMLElement; count: HTMLElement }
export const TTS_TEXT = "I can't believe you remembered. Honestly, you're the best.";
export function ttsPanel(): TtsPanel {
  const text = h('div', { class: 'tu-ttxt' });
  const count = h('span', { class: 'tts-count' });
  const fx = h('button', { type: 'button', class: 'btn sm soft tu-fx', html: S('wand') }, h('span', null, 'Make it expressive')) as HTMLButtonElement;
  const play = h('button', { type: 'button', class: 'btn primary lg block tu-play', html: S('play') }, h('span', null, 'Play')) as HTMLButtonElement;
  const note = h('p', { class: 'hint tu-note' }, 'Purple [tags] tell the voice how to say it.');
  const el = card('tts', 'Text to Speech', 'studio', 0,
    h('div', { class: 'vp-btn tu-vp' }, slot('voice', 40), h('span', { class: 'vp-t' }, h('span', { class: 'vp-name' }, 'Strix'), h('span', { class: 'vp-meta' }, 'Voice'))),
    h('div', { class: 'tts-editor tu-editor' }, text, h('div', { class: 'tts-editor-meta' }, fx, count)),
    play, note);
  return { id: 'tts', el, w: PW, h: 420, slots: {}, title: 'Text to Speech', text, fx, play, note, count };
}

/* ---------- Voice Changer ---------- */
export interface AbRow { el: HTMLElement; btn: HTMLButtonElement; bar: HTMLElement; clip: string }
export interface VcPanel extends PanelBase { rec: HTMLButtonElement; recNote: HTMLElement; rows: AbRow[] }
export function vcPanel(): VcPanel {
  const rec = h('button', { type: 'button', class: 'rec-btn tu-rec', 'aria-label': 'Record', html: S('mic') }) as HTMLButtonElement;
  const recNote = h('div', { class: 'rec-time tu-rectime' }, 'Record your voice');
  const row = (clip: string, name: string, sub: string, slotName: string): AbRow => {
    const btn = h('button', { type: 'button', class: 'mp-btn', 'aria-label': `Play ${name}`, html: S('play') }) as HTMLButtonElement;
    const bar = h('i');
    const el = h('div', { class: 'mp tu-mp' + (clip === 'vc_out' ? ' accent' : '') }, btn, slot(slotName, 36),
      h('div', { class: 'mp-main' }, h('div', { class: 'mp-head' }, h('b', null, name), h('span', null, sub)), h('div', { class: 'tu-prog' }, bar)));
    return { el, btn, bar, clip };
  };
  const rows = [row('vc_in', 'Before', 'your voice', 'before'), row('vc_out', 'After', 'as Strix', 'after')];
  const el = card('vc', 'Voice Changer', 'changer', 0,
    h('div', { class: 'rec-panel tu-recp' }, rec, recNote, h('div', { class: 'hint' }, 'Same words, same timing. A new voice.')),
    h('div', { class: 'tu-ab' }, ...rows.map((r) => r.el)));
  return { id: 'vc', el, w: PW, h: 440, slots: {}, title: 'Voice Changer', rec, recNote, rows };
}

/* ---------- Voices ---------- */
export interface VoicesPanel extends PanelBase { sea: HTMLElement; now: HTMLElement; add: HTMLButtonElement; coll: HTMLElement; collNote: HTMLElement }
export function voicesPanel(): VoicesPanel {
  const sea = h('div', { class: 'tu-sea', role: 'group', 'aria-label': 'Voices. Tap one to hear it.' });
  const now = h('span', { class: 'tu-now' }, 'Tap a voice to hear it');
  const add = h('button', { type: 'button', class: 'btn sm primary tu-add', html: S('plus'), disabled: true }, h('span', null, 'Add')) as HTMLButtonElement;
  const coll = h('div', { class: 'tu-coll' }, slot('col0', 40, 'full'), slot('col1', 40), slot('col2', 40), slot('col3', 40));
  const collNote = h('span', { class: 'hint' }, 'Your collection');
  const el = card('voices', 'Voices', 'voices', 520,
    h('div', { class: 'search-wrap tu-search', html: S('search') }, h('input', { class: 'input', readOnly: true, tabIndex: -1, placeholder: 'Search thousands of voices', 'aria-hidden': 'true' })),
    sea, h('div', { class: 'tu-seabar' }, now, add),
    h('div', { class: 'tu-collw' }, collNote, coll));
  return { id: 'voices', el, w: PW, h: 520, slots: {}, title: 'Voices', sea, now, add, coll, collNote };
}
