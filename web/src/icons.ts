/* Inline SVG icon set (24x24, stroke = currentColor). No emoji anywhere in the UI.
   Names used by the old coffee-icons.js are kept identical so the Coffee port can use icons.IC.<name> unchanged. */

const P: Record<string, string> = {
  // --- names from the old coffee-icons.js (keep) ---
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/>',
  speaker: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  speakerOff: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6m0-6-5 6"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
  cup: '<path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3v2M12 3v2"/>',
  wallet: '<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3"/><path d="M21 9h-5a2 2 0 0 0 0 4h5z"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  send: '<path d="M7 17 17 7M8 7h9v9"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  help: '<circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"/>',
  bank: '<path d="M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  flame: '<path d="M12 3c1 4 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 .3 1.4 1 2 2 2-1-3 0-5 1-8z"/>',
  headset: '<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  smartphone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',

  // --- app set ---
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>',
  message: '<path d="M20 4H4a1 1 0 0 0-1 1v15l4-3.5h13a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z"/><path d="M7.5 9h9M7.5 12.5h5.5"/>',
  waveform: '<path d="M3 12h1M7 8v8M11 4v16M15 7v10M19 10v4M22 12h-1"/>',
  studio: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
  voices: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M17 5.5a5 5 0 0 1 0 7M19.5 3a8.5 8.5 0 0 1 0 12"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  micOff: '<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 5.1 2.1"/><path d="M19 11a7 7 0 0 1-1.2 3.9M5 11a7 7 0 0 0 11 5.7M12 18v3M9 21h6M3 3l18 18"/>',
  play: '<path d="M7 4.5v15l12.5-7.5z"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3"/>',
  check: '<path d="M4.5 12.5l5 5 10-11"/>',
  checkCircle: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  xCircle: '<circle cx="12" cy="12" r="9.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5M12 8h.01"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  moreV: '<circle cx="12" cy="5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="19" r="1.3"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z"/><path d="M14 6v2M14 11v2M14 16v2"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  ban: '<circle cx="12" cy="12" r="9.5"/><path d="M5.3 5.3l13.4 13.4"/>',
  clock: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7v5l3 2"/>',
  // persona memory: a speech bubble holding a small clock hand (remembered conversations)
  memory: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z"/><path d="M12 6.5v3.5l2.3 1.5"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6L3.5 8.5"/><path d="M3.5 4v4.5H8M12 8v4l3 2"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  wand: '<path d="M15 4V2M15 10V8M11 6h2M17 6h2M4 20 14 10"/><path d="M19 13v2M18 14h2"/>',
  tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  record: '<circle cx="12" cy="12" r="6" class="fill"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  fileAudio: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M10 17.5V12l4-1v5"/><circle cx="8.8" cy="17.5" r="1.3"/><circle cx="12.8" cy="16" r="1.3"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/>',
  globe: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.6 4 6 4 9.5s-1.4 6.9-4 9.5c-2.6-2.6-4-6-4-9.5s1.4-6.9 4-9.5z"/>',
  languages: '<path d="M4 5h9M8.5 3v2M6 5c.5 3 3 6 6 7.5M11 5c-.5 3-3 6-7 8"/><path d="M13 21l4-9 4 9M14.5 18h5"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.3-1.7-.4-1 .3-2.3 1.5-2.3H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  hash: '<path d="M5 9h15M4 15h15M10 3 8 21M16 3l-2 18"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.5 18a9.5 9.5 0 1 1 17 0z"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>',
  phoneOff: '<path d="M10.7 13.3a16 16 0 0 0 3.3 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9"/><path d="M22 2 2 22"/>',
  google: '',
  changer: '<path d="M3 9h2M7 6v6M11 4v10"/><path d="M13 15h8M18 12l3 3-3 3"/><path d="M15 20h-2"/>',
  swap: '<path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.4 3.9 4 7.3 4c2 0 3.4 1.1 4.7 2.7C13.3 5.1 14.7 4 16.7 4c3.4 0 5.6 3.4 4.5 6.7C19.5 15.4 12 20 12 20z"/>',
  mask: '<path d="M3 6c3 1.3 6 1.3 9 0 3 1.3 6 1.3 9 0v5c0 5-4 9-9 9s-9-4-9-9z"/><path d="M7.5 11.5c.8-.7 2.2-.7 3 0M13.5 11.5c.8-.7 2.2-.7 3 0M9.5 16c1.5.9 3.5.9 5 0"/>',
  compass: '<circle cx="12" cy="12" r="9.5"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  smile: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14c1 1.5 2.4 2.2 4 2.2s3-.7 4-2.2M9 9.5h.01M15 9.5h.01"/>',
};

const SPECIAL: Record<string, string> = {
  google: '<svg class="ic ic-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" stroke="none" d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
  record: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/></svg>',
  play: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/></svg>',
  pause: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none"/></svg>',
  stop: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/></svg>',
};

export type IconName = keyof typeof P;

/** SVG markup for an icon (class "ic"; inherits color + font size). Unknown names render an empty box, never throw. */
export function svg(name: string, cls = ''): string {
  const special = SPECIAL[name];
  if (special) return cls ? special.replace('class="ic', `class="ic ${cls}`) : special;
  const body = P[name] ?? '';
  return `<svg class="ic${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** Icon as a DOM element. */
export function el(name: string, cls = ''): SVGElement {
  const t = document.createElement('template');
  t.innerHTML = svg(name, cls);
  return t.content.firstElementChild as SVGElement;
}

/** Fill every `[data-ic="name"]` element below `root` with its icon (same as the old IC.apply). */
export function apply(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-ic]').forEach((e) => { e.innerHTML = svg(e.dataset.ic || ''); });
}

/** Compatibility map like the old window.IC: IC.mic === '<svg ...>'. */
export const IC: Record<string, string> = Object.fromEntries(Object.keys(P).map((k) => [k, svg(k)]));

export const names = Object.keys(P);

export const icons = { svg, el, apply, IC, names };
export type Icons = typeof icons;
