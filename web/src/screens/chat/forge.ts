/* The persona "forge": making a persona = shaping its orb and stepping inside it.
   The sphere IS the persona's orb: drawn with the app's own orb shader (forgegl.ts), so at rest it is pixel-identical
   to the 2D orb of the same size and the orb arrives from / leaves to the app's orbs without a visible change; only when
   the camera starts to move does it wrap onto a sphere and the glass (grid, rim) fade in.
   (a) Outside: the orb, big, that turns when dragged like a ball in your hand (then the glass grid appears). Below it, a tray of six ingredients (Nama, Sifat, Aksen, Bahasa, Suara, Sapaan),
       each with its current value. "Bantu AI" (Strix) or "Masuk ke bola".
   (b) An ingredient dragged / tapped into the sphere breaks the surface (ripple, a drop of colour, a squash) and the ink
       rises as the persona gets filled (colours of the persona's orb: the voice's, or the AI's iconic colours).
   (c) The camera dives through the membrane; the screen IS the inside of the sphere (a concave grid curving away). The
       form is a ring of panels on the inner wall, nearly full screen on phones; the camera turns from panel to panel.
       Strix researches from in here (a scan line; each result flies to its panel; sources as small links).
   (d) "Simpan" = back out through the surface; the glass falls away, the stage dissolves to the app, and the persona's
       orb flies onto the orb of "Persona siap" (match-cut, ui/transition.ts).
   Look: one neutral dark stage, hairline panels, one accent colour taken from the persona's own orb; effects only
   where they mean something (ripples, depth). One WebGL canvas (forgegl.ts; Canvas 2D fallback); panels are DOM with
   CSS 3D transforms from the SAME camera yaw. Phone keyboard: the edited panel lies flat in the visible area (--vvh).
   Keyboard: Tab / Enter everywhere, Left / Right turn panels, Esc closes. Reduced motion: the classic form (creator.ts).
   Test hook: window.__forge(). */
import './forge.css';
import type { ScreenCtx } from '../../ctx';
import type { CustomPersona } from '../../lib/persona';
import { chatPrefs, DEFAULT_VOICE, LANGS, cleanName, cleanAccent } from '../../lib/persona';
import { BRAND } from '../../lib/brand';
import { h } from '../../ui/dom';
import { field } from '../../ui/controls';
import { orb, personaOrb, thinkingLevel, emptyOrbSpec, type Rgb, type OrbSpec, type CustomOrb, type OrbEl } from '../../ui/orb';
import { handOff, takeHandOff } from '../../ui/transition';
import { ForgeGL, basis, type ForgeCam, type Ripple, type V3 } from './forgegl';
import type { PersonaForm, FormField } from './creator';

type PanelKey = 'ai' | FormField;
const PANELS: Array<{ k: PanelKey; label: string; title: string; lead: string }> = [
  { k: 'ai', label: 'Strix', title: 'Bantu AI', lead: 'Ceritakan idenya. Strix mencari referensi, lalu mengisi bahan-bahannya untukmu.' },
  { k: 'name', label: 'Nama', title: 'Nama', lead: 'Nama yang dipakai dan dipanggil.' },
  { k: 'desc', label: 'Sifat', title: 'Sifat', lead: 'Siapa dia, sifatnya, dan cara bicaranya. Ini inti persona.' },
  { k: 'accent', label: 'Aksen', title: 'Aksen', lead: 'Logat saat berbicara. Kosongkan bila netral.' },
  { k: 'lang', label: 'Bahasa', title: 'Bahasa', lead: 'Bahasa yang dipakai saat membalas.' },
  { k: 'voice', label: 'Suara', title: 'Suara & bola', lead: 'Suara dari koleksimu. Bola mengikuti warna suara, atau warna pilihan Strix.' },
  { k: 'greet', label: 'Sapaan', title: 'Sapaan', lead: 'Kalimat pertama saat percakapan dimulai. Opsional.' },
];
const INGREDIENTS: Array<{ k: FormField; label: string }> = [
  { k: 'name', label: 'Nama' }, { k: 'desc', label: 'Sifat' }, { k: 'accent', label: 'Aksen' },
  { k: 'lang', label: 'Bahasa' }, { k: 'voice', label: 'Suara' }, { k: 'greet', label: 'Sapaan' },
];
const STEP = (Math.PI * 2) / PANELS.length;
const D_OUT = 3.3;
/** inside, the camera stays a bit behind the centre: the far wall then reads as a bowl curving away */
const D_IN = 0.5;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x: number) => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const BG_A: Rgb = [0.075, 0.078, 0.09], BG_B: Rgb = [0.03, 0.031, 0.037];
const lumOf = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const hex = (c: Rgb) => '#' + c.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('');
/** the persona's accent for the UI: its most saturated orb colour, lifted until it reads on the dark stage */
function accentOf(s: OrbSpec): { bg: string; fg: string } {
  const cand = [s.colors[1], s.colors[2], s.colors[3], s.colors[0]];
  let best = cand[0], bc = -1;
  for (const c of cand) { const ch = Math.max(...c) - Math.min(...c); if (ch > bc) { bc = ch; best = c; } }
  let c: Rgb = [...best] as Rgb;
  for (let i = 0; i < 8 && lumOf(c) < 0.42; i++) c = c.map((v) => v + (1 - v) * 0.18) as Rgb;
  return { bg: hex(c), fg: lumOf(c) > 0.5 ? '#0b0b0e' : '#ffffff' };
}
function strixSpec(): OrbSpec {
  let o: { orb?: unknown; voiceId?: string } = {};
  try { o = chatPrefs()?.over?.strix || {}; } catch { /* settings not ready */ }
  return personaOrb(o.voiceId || DEFAULT_VOICE, BRAND, (o.orb as CustomOrb | null) || null);
}

export function openForge(ctx: ScreenCtx, f: PersonaForm, onSaved: (p: CustomPersona, isNew: boolean) => void, onClosed?: (saved: boolean) => void): void {
  const S = ctx.icons.svg;
  const noGL = !!(window as unknown as { __forgeNoGL?: boolean }).__forgeNoGL;
  const gl = new ForgeGL(noGL);

  /* ---------------- DOM ---------------- */
  const closeBtn = h('button', { type: 'button', class: 'pf-x', 'aria-label': 'Tutup', html: S('x') }) as HTMLButtonElement;
  const title = h('div', { class: 'pf-title' }, f.isNew ? 'Persona baru' : 'Edit persona');
  const topSave = h('button', { type: 'button', class: 'pf-tsave' }, 'Simpan') as HTMLButtonElement;
  const top = h('div', { class: 'pf-top' }, closeBtn, title, topSave);

  // outside
  const capH = h('h2', null, f.isNew ? 'Bola ini masih kosong' : 'Bola persona');
  const capP = h('p', null, f.isNew ? 'Seret bahan ke dalam bola, atau ketuk. Strix bisa membantu.' : 'Ketuk bahan untuk mengubahnya.');
  const caption = h('div', { class: 'pf-cap' }, capH, capP);
  const tiles = INGREDIENTS.map((g, i) => h('button', { type: 'button', class: 'pf-ing', 'data-k': g.k, 'data-i': String(i) },
    h('span', { class: 'pf-ing-h' }, h('span', { class: 'pf-n' }, String(i + 1).padStart(2, '0')), h('b', null, g.label)), h('span', { class: 'pf-ing-v' })) as HTMLButtonElement);
  const tray = h('div', { class: 'pf-tray', role: 'group', 'aria-label': 'Bahan persona' }, ...tiles);
  const aiBtn = h('button', { type: 'button', class: 'pf-btn', html: S('sparkle') }, h('span', null, 'Bantu AI')) as HTMLButtonElement;
  const inBtn = h('button', { type: 'button', class: 'pf-btn primary' }, h('span', null, 'Masuk ke bola')) as HTMLButtonElement;
  const outSave = h('button', { type: 'button', class: 'pf-btn primary' }, h('span', null, 'Simpan')) as HTMLButtonElement;
  const outBar = h('div', { class: 'pf-obar' }, aiBtn, inBtn, outSave);
  const outside = h('div', { class: 'pf-out' }, caption, h('div', { class: 'pf-bottom' }, tray, outBar));

  // inside: panels on the inner wall
  const strix = orb(strixSpec(), { size: 44, cls: 'pf-strix', label: BRAND });
  const aiLoading = h('div', { class: 'pf-aiload', hidden: true }, h('span', { class: 'pf-scanbar', 'aria-hidden': 'true' }), f.stageText, f.cancelBtn);
  const aiForm = h('div', { class: 'pf-aiform' },
    field('Ide karakter', f.idea, 'Satu kalimat cukup. Contoh: tokoh fiksi, tokoh publik, atau sebuah vibe.'),
    f.ideaChips, field('Bahasa persona', f.ideaLang), f.researchBtn, f.aiErr);
  const orbRows: Array<{ o: OrbEl; t: HTMLElement }> = [];
  const orbRow = (big: boolean) => {
    const o = orb(f.spec(), { size: big ? 64 : 40, cls: 'pf-vorb' });
    const t = h('span', { class: 'pf-orbt' });
    const b = h('button', { type: 'button', class: 'pf-link' }, 'Ubah') as HTMLButtonElement;
    b.onclick = () => f.openStudio();
    orbRows.push({ o, t });
    return h('div', { class: 'pf-orbrow' }, o, t, b);
  };
  const aiOrbRow = orbRow(false);
  aiOrbRow.hidden = true;
  const body: Record<PanelKey, Node[]> = {
    ai: [h('div', { class: 'pf-strixrow' }, strix, h('span', null, `${BRAND} mengisi dari dalam bola`)), aiForm, aiLoading, aiOrbRow, f.aiInfo],
    name: [field('Nama', f.name)],
    desc: [field('Deskripsi & sifat', f.desc), f.clauseBox, h('div', { class: 'pf-row' }, f.refineBtn, f.undoBtn)],
    accent: [field('Aksen', h('div', { style: 'display:contents' }, f.acc, f.accList))],
    lang: [field('Bahasa', f.lang)],
    voice: [field('Suara', f.vp), orbRow(true)],
    greet: [field('Kalimat pembuka', f.greet, 'Boleh pakai audio tag seperti [laughs].')],
  };
  const panels = PANELS.map((p, i) => h('section', { class: 'pf-panel' + (p.k === 'ai' ? '' : ' solo'), 'data-k': p.k, 'data-i': String(i), tabindex: '-1', 'aria-label': p.title },
    h('header', null, h('span', { class: 'pf-n' }, `${String(i + 1).padStart(2, '0')} / ${String(PANELS.length).padStart(2, '0')}`), h('h3', null, p.title), h('p', null, p.lead)),
    h('div', { class: 'pf-pb' }, ...body[p.k])));
  const world = h('div', { class: 'pf-world' }, ...panels);
  const tabs = PANELS.map((p, i) => h('button', { type: 'button', class: 'pf-tab', 'data-i': String(i), role: 'tab' }, h('span', { class: 'pf-n' }, String(i + 1)), h('span', null, p.label)) as HTMLButtonElement);
  const tabRow = h('div', { class: 'pf-tabs', role: 'tablist', 'aria-label': 'Bagian persona' }, ...tabs);
  const backOut = h('button', { type: 'button', class: 'pf-btn', 'aria-label': 'Keluar dari bola' }, h('span', null, 'Keluar')) as HTMLButtonElement;
  const prev = h('button', { type: 'button', class: 'pf-btn icon', 'aria-label': 'Bagian sebelumnya', html: S('chevronLeft') }) as HTMLButtonElement;
  const next = h('button', { type: 'button', class: 'pf-btn icon', 'aria-label': 'Bagian berikutnya', html: S('chevronRight') }) as HTMLButtonElement;
  const inSave = h('button', { type: 'button', class: 'pf-btn primary' }, h('span', null, 'Simpan')) as HTMLButtonElement;
  const inBar = h('div', { class: 'pf-ibar' }, backOut, h('div', { class: 'pf-pn' }, prev, next), inSave);
  const msgBox = h('div', { class: 'pf-msg' }, f.msg);
  const inside = h('div', { class: 'pf-in' }, world, tabRow, inBar, msgBox);
  // the inside (panels, fields, voice picker...) is not laid out until the first dive: opening the editor stays cheap
  inside.style.display = 'none';
  const wakeInside = () => { if (inside.style.display === 'none') { inside.style.display = ''; layout(); } };
  const fly = h('div', { class: 'pf-fly', 'aria-hidden': 'true' }, h('span'));
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const root = h('div', { class: 'pf mode-out', role: 'dialog', 'aria-modal': 'true', 'aria-label': f.isNew ? 'Buat persona baru' : 'Edit persona' }, gl.canvas, outside, inside, top, fly, live);
  document.body.append(root);
  // no WebGL: the sphere's orb is a real DOM orb under the (transparent) canvas
  const DORB = 400;
  // a real DOM orb stands in for the sphere while the GL program is still being built (and without WebGL): the editor
  // is usable at once and looks the same at rest
  const dorb = orb(f.spec(), { size: DORB, cls: 'pf-dorb', live: !matchMedia('(prefers-reduced-motion: reduce)').matches }) as OrbEl & { _live: { time: number } | null };
  root.insertBefore(dorb, gl.canvas);
  let usedGL = false;
  let lastRS = 0, lastCtr: [number, number] = [0, 0], testHold = false, testRS = 0, testView = false;
  const app = document.getElementById('app');
  const appWasInert = !!app?.inert;
  if (app) app.inert = true;

  /* ---------------- state ---------------- */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // at rest the camera looks straight at the orb (yaw 0, pitch 0): the orb's own frame
  const cam = { d: D_OUT, yaw: 0, pitch: 0, vyaw: 0, vpitch: 0 };
  const REST = basis({ yaw: 0, pitch: 0 });
  let mode: 'out' | 'dive' | 'in' | 'surface' | 'leave' = 'out';
  let leaveAt = 0;
  let revealBall: HTMLElement | null = null;
  let tween: { from: number; to: number; t0: number; dur: number; yaw0: number; yaw1: number; pitch1: number; done: () => void } | null = null;
  let active = 1, yawT = 0, dragYaw: { x: number; yaw0: number; id: number; lx: number; v: number } | null = null;
  let T = 0, last = 0, raf = 0, closed = false, frames = 0;
  const ripples: Ripple[] = [];
  let drops = 0, scan = 0, flash = 0, sq = 0, vsq = 0, glass = 0, k3 = 0;
  // the orb: one look (spec) + its animation clock, inherited from the orb that arrived (no jump in the pattern)
  const arrived = takeHandOff();
  // a new persona without any ingredient is EMPTY: a neutral grey glass orb; its colours appear with the first ingredient
  const EMPTYSPEC = emptyOrbSpec();
  const isEmpty = () => { if (!f.isNew || drops > 0 || f.aiOrb() || f.orb()) return false; const fl = f.filled(); return !(fl.name || fl.desc || fl.accent || fl.greet); };
  const lookNow = () => (isEmpty() ? EMPTYSPEC : f.spec());
  let spec = lookNow(), orbTime = arrived?.time ?? spec.t0;
  let specB: OrbSpec | null = null, timeB = 0, morph = 1, specWant = spec.key, specAt = 0;
  /** engaged = the camera has moved (drag / dive / drop): the orb is wrapped on the sphere and the glass shows */
  let engaged = false, settleRest = false;
  let arrive = arrived && !reduced ? { r: arrived.rect, t0: 0 } : null;
  let tourGen = 0;
  const log: string[] = [];
  const note = (s: string) => { log.push(`${T.toFixed(2)} ${s}`); if (log.length > 200) log.shift(); };
  note('arrived ' + (arrived ? Math.round(arrived.rect.width) + '@' + Math.round(arrived.rect.left) : 'none') + ' reduced=' + reduced);
  const L = { W: 0, H: 0, P: 600, Fout: 700, kb: false, ctrOut: [0, 0] as [number, number], ctrIn: [0, 0] as [number, number], rOut: 120 };
  const hMax: Record<number, number> = {};

  /* ---------------- layout ---------------- */
  const typing = () => { const a = document.activeElement as HTMLElement | null; return !!a && root.contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.tagName === 'SELECT'); };
  function layout() {
    const vv = window.visualViewport;
    const W = innerWidth, vh = Math.round(vv ? vv.height : innerHeight);
    if (!typing()) hMax[W] = Math.max(hMax[W] || 0, vh);
    const kb = mode === 'in' && typing() && vh < (hMax[W] || vh) - 120;
    L.kb = kb;
    root.classList.toggle('kb', kb);
    root.style.setProperty('--vvh', vh + 'px');
    root.style.top = kb && vv ? Math.round(vv.offsetTop) + 'px' : '';
    root.style.height = kb ? vh + 'px' : '';
    const H = kb ? vh : innerHeight;
    L.W = W; L.H = H;
    L.P = clamp(Math.min(W, innerHeight * 1.05) * 0.85, 300, 760);
    root.style.setProperty('--pp', L.P + 'px');
    // outside: the sphere fills the space between the caption and the tray
    const capB = caption.offsetTop + caption.offsetHeight, trayT = (outside.querySelector('.pf-bottom') as HTMLElement).offsetTop;
    const room = Math.max(120, trayT - capB);
    L.rOut = clamp(Math.min(W * 0.4, room / 2 - 18), 70, 280);
    L.ctrOut = [0, capB + room / 2 - H / 2];
    L.Fout = L.rOut * Math.sqrt(D_OUT * D_OUT - 1);
    // inside: the panel area between the tabs and the bottom bar
    const pTop = tabRow.offsetTop + tabRow.offsetHeight + 10, pBot = H - inBar.offsetHeight - (H - inBar.offsetTop - inBar.offsetHeight) - 10;
    root.style.setProperty('--pt', pTop + 'px');
    root.style.setProperty('--ph', Math.max(200, pBot - pTop) + 'px');
    L.ctrIn = [0, (pTop + pBot) / 2 - H / 2];
    world.style.perspectiveOrigin = `50% ${((pTop + pBot) / 2).toFixed(0)}px`;
    gl.resize(W, H);
    if (kb) {
      // keep the edited field in view by scrolling its panel only
      const a = document.activeElement as HTMLElement | null, pnl = a?.closest('.pf-panel') as HTMLElement | null;
      if (a && pnl) requestAnimationFrame(() => { const ar = a.getBoundingClientRect(), pr = pnl.getBoundingClientRect(); pnl.scrollTop += ar.top - pr.top - Math.max(0, (pr.height - ar.height) / 2) * 0.4; });
    }
  }

  /* ---------------- camera ---------------- */
  const inMix = () => clamp((D_OUT - cam.d) / (D_OUT - 1.2));   // 0 outside .. 1 at the surface and in
  const camF = () => L.P + (L.Fout - L.P) * clamp((cam.d - 0.9) / (D_OUT - 0.9));
  const ctrNow = (): [number, number] => { const k = ease(inMix()); return [L.ctrOut[0] + (L.ctrIn[0] - L.ctrOut[0]) * k, L.ctrOut[1] + (L.ctrIn[1] - L.ctrOut[1]) * k]; };
  const camNow = (): ForgeCam => {
    const B = basis({ yaw: cam.yaw, pitch: cam.pitch });
    return { pos: [-B.Fw[0] * cam.d, -B.Fw[1] * cam.d, -B.Fw[2] * cam.d], yaw: cam.yaw, pitch: cam.pitch, f: camF() };
  };
  const panelYaw = (i: number) => i * STEP;
  function dive(to: 'in' | 'out', panel = active, dur = 1.5, after?: () => void) {
    const goingIn = to === 'in';
    if (goingIn) wakeInside();
    if (goingIn) engaged = true;
    if (goingIn) active = panel;
    const yaw1 = goingIn ? cam.yaw + wrapA(panelYaw(panel) - cam.yaw) : cam.yaw;
    mode = goingIn ? 'dive' : (mode === 'leave' ? 'leave' : 'surface');
    root.classList.remove('mode-out', 'mode-in');
    root.classList.add('mode-move');
    tween = {
      from: cam.d, to: goingIn ? D_IN : D_OUT, t0: T, dur: reduced ? 0.01 : dur, yaw0: cam.yaw, yaw1, pitch1: 0,
      done: () => {
        tween = null;
        root.classList.remove('mode-move');
        if (goingIn) { mode = 'in'; yawT = yaw1; root.classList.add('mode-in'); paintPanels(true); }
        else if (mode !== 'leave') { mode = 'out'; root.classList.add('mode-out'); }
        layout();
        after?.();
      },
    };
    note(`dive ${to} ${PANELS[panel].k}`);
  }
  function goPanel(i: number, focus = false) {
    i = ((i % PANELS.length) + PANELS.length) % PANELS.length;
    active = i;
    yawT = cam.yaw + wrapA(panelYaw(i) - cam.yaw);
    paintPanels(true);
    // scroll only the tab rail (scrollIntoView would also pan the page / visual viewport on phones)
    const t = tabs[i]; tabRow.scrollTo({ left: t.offsetLeft - (tabRow.clientWidth - t.offsetWidth) / 2, behavior: reduced ? 'auto' : 'smooth' });
    if (focus) setTimeout(() => focusPanel(i), reduced ? 0 : 420);
  }
  function focusPanel(i: number) {
    const el = panels[i].querySelector<HTMLElement>('input, textarea, select, .vp-btn');
    (el || panels[i]).focus({ preventScroll: true });
  }

  /* ---------------- panels (CSS 3D from the camera yaw) ---------------- */
  const pstate = panels.map(() => ({ tf: '', op: '', face: '' }));
  function paintPanels(force = false) {
    tabs.forEach((t, i) => { const on = i === active; if (force || t.getAttribute('aria-selected') !== String(on)) { t.setAttribute('aria-selected', String(on)); t.classList.toggle('on', on); } });
    panels.forEach((p, i) => { p.inert = i !== active || mode !== 'in'; p.classList.toggle('on', i === active); });
    const filled = f.filled();
    tabs.forEach((t, i) => { const k = PANELS[i].k; t.classList.toggle('filled', k !== 'ai' && filled[k as FormField]); });
  }
  function placePanels() {
    const inK = clamp((0.92 - cam.d) / 0.36);
    panels.forEach((p, i) => {
      const rel = wrapA(panelYaw(i) - cam.yaw);
      let tf = '', op = 0;
      if (L.kb) { tf = 'none'; op = i === active ? 1 : 0; }
      else if (Math.abs(rel) < 1.45 && inK > 0) {
        const P = L.P, sc = 0.94 + 0.06 * inK;
        tf = `translateX(-50%) translateZ(${P.toFixed(1)}px) rotateY(${(-rel * 180 / Math.PI).toFixed(2)}deg) translateZ(${(-P).toFixed(1)}px) scale(${sc.toFixed(3)})`;
        op = inK * clamp(1 - (Math.abs(rel) - 0.06) / 0.5);   // neighbours only show while turning
      }
      const ops = op.toFixed(3);
      // orbs never show foreshortened: inside a turned panel they fade out and come back once it faces the camera
      const face = L.kb ? '1' : clamp(1 - (Math.abs(rel) - 0.02) / 0.06).toFixed(2);
      if (face !== pstate[i].face) { p.style.setProperty('--face', face); pstate[i].face = face; }
      if (tf !== pstate[i].tf) { p.style.transform = tf; pstate[i].tf = tf; }
      if (ops !== pstate[i].op) { p.style.opacity = ops; p.style.visibility = op > 0.01 ? 'visible' : 'hidden'; pstate[i].op = ops; }
    });
  }

  /* ---------------- outside: ingredients ---------------- */
  const sphere = () => { const c = ctrNow(); return { x: L.W / 2 + c[0], y: L.H / 2 + c[1], r: ForgeGL.radius(camNow()) }; };
  let cdrag: { i: number; id: number; x0: number; y0: number; x: number; y: number; moved: boolean } | null = null;
  let flying: { i: number; k: FormField; x0: number; y0: number; t0: number } | null = null;
  function dropIngredient(i: number, x: number, y: number) {
    if (flying || mode !== 'out') return;
    flying = { i, k: INGREDIENTS[i].k, x0: x, y0: y, t0: T };
    (fly.firstChild as HTMLElement).textContent = INGREDIENTS[i].label;
    fly.classList.add('on');
    tiles[i].classList.add('used');
    note('drop ' + INGREDIENTS[i].k);
  }
  function landIngredient() {
    const fl = flying!; flying = null;
    fly.classList.remove('on');
    tiles[fl.i].classList.remove('used');
    const s = sphere(), dx = (fl.x0 - s.x) / Math.max(1, s.r), dy = (fl.y0 - s.y) / Math.max(1, s.r);
    const m = Math.hypot(dx, dy), nx = m > 0.9 ? (dx / m) * 0.9 : dx, ny = m > 0.9 ? (dy / m) * 0.9 : dy;
    const nz = -Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    const B = basis({ yaw: cam.yaw, pitch: cam.pitch });
    const dir: V3 = [B.R[0] * nx - B.Up[0] * ny + B.Fw[0] * nz, B.R[1] * nx - B.Up[1] * ny + B.Fw[1] * nz, B.R[2] * nx - B.Up[2] * ny + B.Fw[2] * nz];
    addRipple(dir, specColor(fl.i));
    drops++; vsq += 2.6; engaged = true;
    const k = PANELS.findIndex((p) => p.k === fl.k);
    setTimeout(() => { if (!closed && mode === 'out') dive('in', k, 1.5, () => focusPanel(k)); }, reduced ? 0 : 380);
  }
  function addRipple(dir: V3, c: Rgb) { const m = Math.hypot(...dir) || 1; ripples.push({ dir: [dir[0] / m, dir[1] / m, dir[2] / m], t0: T, c }); if (ripples.length > 8) ripples.shift(); }
  const specColor = (i: number): Rgb => { const s = f.spec(); return s.colors[[1, 2, 3, 1, 2, 0][i % 6]]; };

  /* ---------------- research tour: each result flies to its panel ---------------- */
  let flyIn: { t0: number; x0: number; y0: number; x1: number; y1: number } | null = null;
  async function resultTour(changed: FormField[]) {
    const my = ++tourGen;
    const wait = (s: number) => new Promise((r) => setTimeout(r, reduced ? 0 : s * 1000));
    for (const k of changed) {
      if (my !== tourGen || closed || mode !== 'in') return;
      const i = PANELS.findIndex((p) => p.k === k);
      goPanel(i);
      await wait(0.55);
      if (my !== tourGen) return;
      const fx = panels[i].querySelector<HTMLElement>('.field') || panels[i];
      const r = fx.getBoundingClientRect(), rr = root.getBoundingClientRect();
      flyIn = { t0: T, x0: L.W / 2, y0: L.H - 90, x1: r.left - rr.left + Math.min(120, r.width / 2), y1: r.top - rr.top + 24 };
      (fly.firstChild as HTMLElement).textContent = PANELS[i].title;
      fly.classList.add('on');
      await wait(0.5);
      if (my !== tourGen) return;
      panels[i].classList.remove('flash'); void panels[i].offsetWidth; panels[i].classList.add('flash');
      addRipple([Math.sin(panelYaw(i)), -0.3, Math.cos(panelYaw(i))], specColor(i));
      await wait(0.35);
    }
    if (my !== tourGen || mode !== 'in') return;
    goPanel(1);
  }

  /* ---------------- form events / painting ---------------- */
  function paintAll() {
    const sp = f.spec(), a = accentOf(sp);
    root.style.setProperty('--pa', a.bg); root.style.setProperty('--pa-fg', a.fg);
    for (const r of orbRows) { r.o.setSpec(sp); r.t.textContent = f.aiOrb() ? 'Warna dari Strix, sesuai karakternya' : f.orb() ? 'Bola buatanmu' : 'Bola mengikuti suara'; }
    aiOrbRow.hidden = !f.aiOrb();
    paintPanels(); paintOut();
  }
  const offForm = f.on((e) => {
    if (e.type === 'change' || e.type === 'undo') paintAll();
    if (e.type === 'busy') {
      aiForm.hidden = e.on && e.kind === 'research'; aiLoading.hidden = !e.on || e.kind !== 'research';
      strix.setLive(e.on, thinkingLevel());
      f.refineBtn.disabled = e.on;
      live.textContent = e.on ? (e.kind === 'research' ? 'Strix sedang riset...' : 'Merapikan persona...') : '';
    }
    if (e.type === 'stage') live.textContent = e.text;
    if (e.type === 'applied') {
      paintAll(); vsq += 1.6;
      if (f.aiOrb()) addRipple([Math.sin(cam.yaw), 0.6, Math.cos(cam.yaw)], f.spec().colors[2]);
      void resultTour(e.changed); note('applied ' + e.changed.join(',') + (f.aiOrb() ? ' +orb' : ''));
    }
  });
  const valueOf = (k: FormField): string => {
    if (k === 'name') return cleanName(f.name.value);
    if (k === 'desc') return f.desc.value.trim().split(/\s+/).slice(0, 6).join(' ');
    if (k === 'accent') return cleanAccent(f.acc.value);
    if (k === 'lang') return LANGS.find((l) => l[0] === f.lang.value)?.[1] || '';
    if (k === 'voice') return (f.vp.querySelector('.vp-name')?.textContent || '').trim();
    return f.greet.value.replace(/\[[^\]]*\]/g, '').trim();
  };
  function paintOut() {
    outSave.hidden = !(f.hasDraft() || f.filled().name);
    const fl = f.filled();
    tiles.forEach((t, i) => {
      const k = INGREDIENTS[i].k, v = valueOf(k);
      (t.querySelector('.pf-ing-v') as HTMLElement).textContent = v || 'Kosong';
      t.classList.toggle('filled', !!v && fl[k]);
    });
    if (!f.isNew) return;
    const n = Object.values(fl).filter(Boolean).length;
    capH.textContent = n <= 2 && !drops ? 'Bola ini masih kosong' : n >= 5 ? 'Bolanya hampir penuh' : 'Bolanya mulai terisi';
  }
  /* ---------------- save: out of the sphere, the glass falls away, the orb flies on ---------------- */
  function trySave() {
    if (mode === 'leave') return;
    const c = f.check();
    if (c) {
      f.msg.replaceChildren(h('div', { class: 'notice warn', html: S('alert') }, h('span', null, c.problem)));
      const i = PANELS.findIndex((p) => p.k === c.field);
      if (mode === 'out') dive('in', i, 1.3, () => focusPanel(i)); else goPanel(i, true);
      note('save blocked ' + c.field);
      return;
    }
    f.msg.replaceChildren();
    const out = f.result();
    tourGen++;
    (document.activeElement as HTMLElement | null)?.blur?.();
    note('save');
    mode = 'leave';
    root.classList.add('leaving');
    const reveal = () => {
      // back to the orb's own front view, then the glass and the sphere mapping fall away: what is left is exactly the
      // 2D orb; a real orb element with the same look and clock takes its place and the stage dissolves into the app
      settleRest = true;   // turn back to the front view first; `engaged` drops (flatten) once it is there
      const t0 = T;
      let ball: (OrbEl & { _live: { time: number } | null }) | null = null;
      const step = () => {
        if (closed) return;
        const restOk = reduced || (Math.abs(wrapA(cam.yaw)) < 0.004 && Math.abs(cam.pitch) < 0.004 && k3 < 0.002 && glass < 0.002 && !specB);
        if (!ball && (restOk || T - t0 > 1.6)) {
          const s0 = sphere();
          // a DOM orb's visible radius is .88 of half its box (ui/orb.ts): size the element so the disc matches
          const box = (s0.r * 2) / 0.88;
          ball = orb(spec, { size: Math.round(box), cls: 'pf-handoff', live: !reduced }) as OrbEl & { _live: { time: number } | null };
          if (ball._live) ball._live.time = orbTime;
          ball.style.left = (s0.x - Math.round(box) / 2).toFixed(1) + 'px'; ball.style.top = (s0.y - Math.round(box) / 2).toFixed(1) + 'px';
          document.body.append(ball); revealBall = ball;
          note('handoff');
          leaveAt = T;
        }
        if (ball) {
          const k = (T - leaveAt) / (reduced ? 0.05 : 0.32);
          root.style.opacity = (1 - clamp(k)).toFixed(3);   // dark stage -> the app; the orb stays
          if (k >= 1) { handOff(ball, 1600); revealBall = null; close(true); onSaved(out, f.isNew); onClosed?.(true); return; }
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    if (cam.d < D_OUT - 0.05) dive('out', active, reduced ? 0.01 : 1.2, reveal); else reveal();
  }
  function close(saved = false) {
    if (closed) return;
    closed = true;
    tourGen++;
    f.abort();
    offForm();
    if (raf) cancelAnimationFrame(raf);
    removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('resize', onResize);
    window.visualViewport?.removeEventListener('scroll', onResize);
    removeEventListener('hashchange', onHash);
    if (app) app.inert = appWasInert;
    if (saved) root.remove();
    else {
      // not saved (X, Esc, route change): the orb does not vanish, a real orb element takes its place and is handed over
      // (the opener flies it back home, e.g. onto the Chat orb); from inside the sphere it leaves from the outside view
      revealBall?.remove(); revealBall = null;
      const inside = cam.d < 1.25 || mode === 'in' || mode === 'dive';
      const sp = inside ? { x: L.W / 2 + L.ctrOut[0], y: L.H / 2 + L.ctrOut[1], r: L.rOut } : { x: L.W / 2 + lastCtr[0], y: L.H / 2 + lastCtr[1], r: lastRS || L.rOut };
      const rr = root.getBoundingClientRect();
      const box = (sp.r * 2) / 0.88;
      const ball = orb(spec, { size: Math.round(box), cls: 'pf-handoff', live: !reduced }) as OrbEl & { _live: { time: number } | null };
      if (ball._live) ball._live.time = orbTime;
      ball.style.left = (rr.left + sp.x - Math.round(box) / 2).toFixed(1) + 'px'; ball.style.top = (rr.top + sp.y - Math.round(box) / 2).toFixed(1) + 'px';
      document.body.append(ball);
      handOff(ball, 900);
      root.classList.add('closing'); setTimeout(() => root.remove(), reduced ? 0 : 240);
    }
    (window as unknown as { __forge?: unknown }).__forge = undefined;
    if (!saved) onClosed?.(false);
  }

  /* ---------------- input ---------------- */
  closeBtn.onclick = () => close();
  topSave.onclick = outSave.onclick = inSave.onclick = () => trySave();
  aiBtn.onclick = () => dive('in', 0, 1.5, () => focusPanel(0));
  inBtn.onclick = () => { const fl = f.filled(); const i = !fl.name ? 1 : !fl.desc ? 2 : 1; dive('in', i, 1.5, () => focusPanel(i)); };
  backOut.onclick = () => { tourGen++; (document.activeElement as HTMLElement | null)?.blur?.(); dive('out'); };
  prev.onclick = () => { tourGen++; goPanel(active - 1); };
  next.onclick = () => { tourGen++; goPanel(active + 1); };
  tabs.forEach((t, i) => { t.onclick = () => { tourGen++; goPanel(i, true); }; });
  root.addEventListener('focusin', (e) => {
    const p = (e.target as HTMLElement).closest?.('.pf-panel') as HTMLElement | null;
    if (p && mode === 'in') { const i = Number(p.dataset.i); if (i !== active) goPanel(i); }
    if (typing()) setTimeout(layout, 320);
  });
  root.addEventListener('focusout', () => setTimeout(layout, 140));
  root.addEventListener('pointerdown', () => { if (mode === 'in' && flyIn == null) tourGen++; }, true);
  // ingredient tiles: drag into the sphere, or tap
  tiles.forEach((c, i) => {
    c.addEventListener('pointerdown', (e) => {
      if (mode !== 'out' || flying) return;
      cdrag = { i, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, moved: false };
      try { c.setPointerCapture(e.pointerId); } catch { /* */ }
      e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!cdrag || cdrag.id !== e.pointerId) return;
      cdrag.x = e.clientX; cdrag.y = e.clientY;
      if (!cdrag.moved && Math.hypot(e.clientX - cdrag.x0, e.clientY - cdrag.y0) > 8) { cdrag.moved = true; (fly.firstChild as HTMLElement).textContent = INGREDIENTS[i].label; fly.classList.add('on', 'drag'); c.classList.add('used'); }
    });
    const up = (e: PointerEvent) => {
      if (!cdrag || cdrag.id !== e.pointerId) return;
      const d = cdrag; cdrag = null;
      fly.classList.remove('drag');
      if (e.type === 'pointercancel') { fly.classList.remove('on'); c.classList.remove('used'); return; }
      const s = sphere(), rr = root.getBoundingClientRect();
      const x = e.clientX - rr.left, y = e.clientY - rr.top;
      if (!d.moved || Math.hypot(x - s.x, y - s.y) < s.r * 1.1) {
        const cr = c.getBoundingClientRect();
        dropIngredient(i, d.moved ? x : cr.left + cr.width / 2 - rr.left, d.moved ? y : cr.top + cr.height / 2 - rr.top);
      } else { fly.classList.remove('on'); c.classList.remove('used'); }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    // keyboard: Enter / Space = click without a pointer
    c.addEventListener('click', (e) => { if (e.detail === 0) { const cr = c.getBoundingClientRect(), rr = root.getBoundingClientRect(); dropIngredient(i, cr.left + cr.width / 2 - rr.left, cr.top + cr.height / 2 - rr.top); } });
  });
  // stage drag. Outside: the sphere turns like a ball in your hand (drag right = its front moves right, drag up = up).
  // Inside: the wall turns with the finger and snaps to a panel.
  let sdrag: { id: number; x: number; y: number; x0: number; y0: number; t: number; moved: boolean } | null = null;
  const ROT = 0.006;
  gl.canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'out' && mode !== 'in') return;
    sdrag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), moved: false };
    if (mode === 'out') { cam.vyaw = 0; cam.vpitch = 0; engaged = true; }
    if (mode === 'in') dragYaw = { x: e.clientX, yaw0: cam.yaw, id: e.pointerId, lx: e.clientX, v: 0 };
    try { gl.canvas.setPointerCapture(e.pointerId); } catch { /* */ }
  });
  gl.canvas.addEventListener('pointermove', (e) => {
    if (!sdrag || sdrag.id !== e.pointerId) return;
    const dx = e.clientX - sdrag.x, dy = e.clientY - sdrag.y, now = performance.now(), dt = Math.max(0.008, (now - sdrag.t) / 1000);
    sdrag.x = e.clientX; sdrag.y = e.clientY; sdrag.t = now;
    if (!sdrag.moved && Math.hypot(e.clientX - sdrag.x0, e.clientY - sdrag.y0) > 6) sdrag.moved = true;
    if (mode === 'out') {
      // the camera orbits the other way round: the surface under the finger follows the finger
      cam.yaw += dx * ROT; cam.pitch = clamp(cam.pitch - dy * ROT, -1.1, 1.1);
      cam.vyaw = (dx * ROT) / dt; cam.vpitch = (-dy * ROT) / dt; vsq += Math.min(0.5, Math.abs(dx) * 0.008);
    } else if (dragYaw) { const d = -(e.clientX - dragYaw.x) / L.P; yawT = dragYaw.yaw0 + d; dragYaw.v = -(e.clientX - dragYaw.lx) / L.P / dt; dragYaw.lx = e.clientX; tourGen++; }
  });
  const sup = (e: PointerEvent) => {
    if (!sdrag || sdrag.id !== e.pointerId) return;
    const s = sdrag; sdrag = null;
    if (performance.now() - s.t > 90) { cam.vyaw = 0; cam.vpitch = 0; }   // held still before letting go: no fling
    if (mode === 'in' && dragYaw) {
      const proj = yawT + clamp(dragYaw.v, -6, 6) * 0.18;
      dragYaw = null;
      goPanel(Math.round(proj / STEP));
      return;
    }
    if (mode === 'out' && !s.moved && e.type !== 'pointercancel') {
      const sp = sphere(), rr = root.getBoundingClientRect();
      if (Math.hypot(e.clientX - rr.left - sp.x, e.clientY - rr.top - sp.y) < sp.r) inBtn.click();
    }
  };
  gl.canvas.addEventListener('pointerup', sup); gl.canvas.addEventListener('pointercancel', sup);
  function onKey(e: KeyboardEvent) {
    if (closed || document.querySelector('.dlg-scrim')) return;   // a sheet (voice list, Studio Bola) is on top
    const t = e.target as HTMLElement, inField = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.tagName === 'SELECT';
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (inField) { t.blur(); return; } if (mode !== 'leave') close(); return; }
    if (inField || mode !== 'in') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); tourGen++; goPanel(active + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); tourGen++; goPanel(active - 1); }
  }
  addEventListener('keydown', onKey, true);
  const onResize = () => layout();
  addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('resize', onResize);
  window.visualViewport?.addEventListener('scroll', onResize);
  const onHash = () => close();
  addEventListener('hashchange', onHash);

  /* ---------------- frame ---------------- */
  function tick(now: number) {
    raf = 0;
    if (closed) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
    last = now; T += dt; frames++;
    try {
      if (tween) {
        const k = ease((T - tween.t0) / tween.dur);
        cam.d = tween.from + (tween.to - tween.from) * k;
        cam.yaw = tween.yaw0 + (tween.yaw1 - tween.yaw0) * ease(k * 1.4);
        cam.pitch += (tween.pitch1 - cam.pitch) * Math.min(1, dt * 5);
        if (k >= 1) tween.done();
      } else if (mode === 'in') {
        if (!dragYaw) cam.yaw += (yawT - cam.yaw) * (reduced ? 1 : 1 - Math.exp(-dt * 7)); else cam.yaw = yawT;
        cam.pitch *= Math.exp(-dt * 6);
      } else if (mode === 'out' || mode === 'leave') {
        if (!sdrag) {
          cam.yaw += cam.vyaw * dt; cam.pitch = clamp(cam.pitch + cam.vpitch * dt, -1.1, 1.1);
          const k = Math.exp(-dt * 2.4); cam.vyaw *= k; cam.vpitch *= k;
          if (settleRest) {
            // leaving: back to the front view (shortest way round)
            const ky = 1 - Math.exp(-dt * 8);
            cam.yaw = wrapA(cam.yaw) * (1 - ky); cam.pitch -= cam.pitch * ky; cam.vyaw = cam.vpitch = 0;
            if (Math.abs(cam.yaw) < 0.004 && Math.abs(cam.pitch) < 0.004) { cam.yaw = 0; cam.pitch = 0; engaged = false; }
          } else if (engaged && !testView) {
            if (!reduced && mode === 'out' && Math.abs(cam.vyaw) < 0.05) cam.yaw += dt * 0.05;   // a slow idle turn
            if (Math.abs(cam.vpitch) < 0.05) cam.pitch += (0.12 - cam.pitch) * dt * 0.8;
          }
        }
      }
      flash = Math.exp(-Math.pow((cam.d - 1) / 0.13, 2)) * (tween ? 1 : 0);
      gl.canvas.style.filter = flash > 0.1 && !reduced ? `blur(${(flash * 4).toFixed(1)}px)` : '';
      vsq += (-90 * sq - 7 * vsq) * dt; sq += vsq * dt; sq = clamp(sq, -0.1, 0.1);
      // the orb's clock runs exactly like a resting 2D orb's (ui/orb.ts live loop, no sound)
      if (!testHold) orbTime += Math.min(0.05, dt) * 0.32 * (spec.speed ?? 1);
      if (specB) timeB += Math.min(0.05, dt) * 0.32 * (specB.speed ?? 1);
      // a new look (voice, name, AI colours, Studio): once the typing settles, cross-dissolve old -> new
      const want = lookNow();
      if (want.key !== specWant) { specWant = want.key; specAt = T; }
      if (want.key !== spec.key && T - specAt > 0.45 && !specB && mode !== 'leave') { specB = spec; timeB = orbTime; spec = want; orbTime = want.t0; morph = reduced ? 1 : 0; }
      if (specB) { morph = Math.min(1, morph + dt / 0.6); if (morph >= 1) specB = null; }
      // the sphere mapping and the glass follow `engaged`
      const kT = engaged ? 1 : 0;
      k3 += (kT - k3) * (reduced ? 1 : 1 - Math.exp(-dt * 9)); if (Math.abs(k3 - kT) < 0.001) k3 = kT;
      // the empty orb shows its glass grid at rest too (flat orb + grid: still the same disc as the 2D orb)
      const gT = engaged ? 1 : spec === EMPTYSPEC && !arrive && mode !== 'leave' && !settleRest && !testHold ? 0.6 : 0;
      glass += (gT - glass) * (reduced ? 1 : 1 - Math.exp(-dt * (gT > glass ? 3 : 9))); if (Math.abs(glass - gT) < 0.001) glass = gT;
      scan += ((f.busy() ? 1 : 0) - scan) * Math.min(1, dt * 3);
      const c = camNow();
      // arriving from a button / another orb: the flat orb grows from there to its place on the stage
      let rS = ForgeGL.radius(c) || L.rOut, ctr = ctrNow();
      if (arrive) {
        if (!arrive.t0) arrive.t0 = T;
        const a = ease((T - arrive.t0) / 0.55), rr = root.getBoundingClientRect();
        const ax = arrive.r.left + arrive.r.width / 2 - rr.left - L.W / 2, ay = arrive.r.top + arrive.r.height / 2 - rr.top - L.H / 2;
        const r0 = (arrive.r.width / 2) * 0.88;   // the arriving DOM orb's visible radius
        rS = r0 + (rS - r0) * a; ctr = [ax + (ctr[0] - ax) * a, ay + (ctr[1] - ay) * a];
        if (a >= 1) arrive = null;
      }
      if (testRS) rS = testRS;
      lastRS = rS; lastCtr = ctr;
      usedGL = gl.draw({ cam: c, T, spec, time: orbTime, specB, timeB, morph, k: k3, rS, ctr, glass, scan, flash, squash: [1 + sq * k3, 1 - sq * k3, 1 + sq * k3], ripples, bgA: BG_A, bgB: BG_B, rest: REST });
      dorb.style.display = usedGL ? 'none' : '';
      if (!usedGL) {
        // no WebGL: a real DOM orb stands in for the sphere outside
        if (dorb._spec.key !== spec.key) dorb.setSpec(spec);
        if (dorb._live) dorb._live.time = orbTime;   // same clock as the GL orb: switching over is seamless
        const box = (rS * 2) / 0.88, x = L.W / 2 + ctr[0] - box / 2, y = L.H / 2 + ctr[1] - box / 2;
        dorb.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${(box / DORB).toFixed(4)})`;
        dorb.style.opacity = clamp((cam.d - 1.6) / 0.8).toFixed(3);
      }
      const outK = clamp((cam.d - 2.2) / 0.8);
      outside.style.opacity = (mode === 'leave' ? 0 : outK).toFixed(3);
      outside.style.visibility = outK > 0.01 && mode !== 'leave' ? 'visible' : 'hidden';
      placePanels();
      const inK = clamp((0.92 - cam.d) / 0.36);
      inside.style.opacity = (mode === 'leave' ? 0 : inK).toFixed(3);
      inside.style.visibility = inK > 0.01 && mode !== 'leave' ? 'visible' : 'hidden';
      const rr = cdrag?.moved ? root.getBoundingClientRect() : null;
      if (cdrag?.moved && rr) fly.style.transform = `translate3d(${(cdrag.x - rr.left).toFixed(1)}px,${(cdrag.y - rr.top).toFixed(1)}px,0) translate(-50%,-50%)`;
      else if (flying) {
        const k = ease((T - flying.t0) / (reduced ? 0.01 : 0.5)), s = sphere();
        const tx = s.x + (flying.x0 - s.x) * 0.3, ty = s.y + (flying.y0 - s.y) * 0.3;
        fly.style.transform = `translate3d(${(flying.x0 + (tx - flying.x0) * k).toFixed(1)}px,${(flying.y0 + (ty - flying.y0) * k).toFixed(1)}px,0) translate(-50%,-50%) scale(${(1 - 0.55 * k).toFixed(3)})`;
        fly.style.opacity = (1 - k).toFixed(3);
        if (k >= 1) landIngredient();
      } else if (flyIn) {
        const k = ease((T - flyIn.t0) / (reduced ? 0.01 : 0.5));
        fly.style.transform = `translate3d(${(flyIn.x0 + (flyIn.x1 - flyIn.x0) * k).toFixed(1)}px,${(flyIn.y0 + (flyIn.y1 - flyIn.y0) * k).toFixed(1)}px,0) translate(-50%,-50%) scale(${(1 - 0.3 * k).toFixed(3)})`;
        fly.style.opacity = (1 - k * 0.8).toFixed(3);
        if (k >= 1) { flyIn = null; fly.classList.remove('on'); }
      }
      if (!flying && !flyIn && !cdrag?.moved) fly.style.opacity = '';
    } catch (e) { console.error('forge frame', e); }
    if (!closed) raf = requestAnimationFrame(tick);
  }

  /* ---------------- test hook ---------------- */
  (window as unknown as { __forge?: unknown }).__forge = () => ({
    mode, active: PANELS[active].k, cam: { d: +cam.d.toFixed(3), yaw: +cam.yaw.toFixed(3), pitch: +cam.pitch.toFixed(3), f: +camF().toFixed(1) }, scan: +scan.toFixed(2), drops, glass: +glass.toFixed(3), k: +k3.toFixed(3),
    orbTime, specKey: spec.key, morph, engaged, arriving: !!arrive, rS: lastRS, ctr: lastCtr,
    renderer: gl.kind, glReady: gl.ready, kb: L.kb, frames, busy: f.busy(), filled: f.filled(), aiOrb: f.aiOrb(), orb: f.orb(), ripples: ripples.length, log: log.slice(), msg: f.msg.textContent,
    sphere: sphere(), chips: tiles.map((c) => { const r = c.getBoundingClientRect(); return { k: c.dataset.k, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }),
    panelRects: panels.map((p) => { const r = p.getBoundingClientRect(); return { k: p.dataset.k, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), op: p.style.opacity }; }),
    /** screen position of a world point (e.g. the sphere's front point) */
    screenOf: (p: V3) => ForgeGL.project(camNow(), L.W, L.H, ctrNow(), p),
    front: () => { const B = basis({ yaw: cam.yaw, pitch: cam.pitch }); return [-B.Fw[0], -B.Fw[1], -B.Fw[2]] as V3; },
    go: (k: PanelKey) => goPanel(PANELS.findIndex((p) => p.k === k), true), dive: (to: 'in' | 'out', k: PanelKey = 'name') => dive(to, PANELS.findIndex((p) => p.k === k)),
    stopSpin: () => { cam.vyaw = 0; cam.vpitch = 0; },
    /** tests: hold the orb clock at t (default: the still frame t0) and force the resting screen radius */
    hold: (t?: number, r?: number) => { testHold = true; glass = 0; orbTime = t ?? spec.t0; testRS = r || 0; },
    release: () => { testHold = false; testRS = 0; },
    view: (y: number, p: number) => { engaged = true; testView = true; cam.yaw = y; cam.pitch = p; cam.vyaw = cam.vpitch = 0; },
    empty: () => spec === EMPTYSPEC,
    spec: () => spec,
  });

  layout();
  paintAll(); placePanels();
  requestAnimationFrame(() => layout());
  raf = requestAnimationFrame(tick);
  requestAnimationFrame(() => (f.isNew ? inBtn : inBtn).focus({ preventScroll: true }));
  // editing an existing persona: a look at its sphere, then straight inside to the name
  if (!f.isNew) setTimeout(() => { if (!closed && mode === 'out') dive('in', 1, 1.4); }, reduced ? 0 : 900);
}
