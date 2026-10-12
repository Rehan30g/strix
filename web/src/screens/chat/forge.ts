/* The persona "forge": making a persona = filling an empty glass sphere and stepping inside it.
   (a) Outside: a big, empty glass sphere (thin latitude / longitude grid in perspective, a faint rim) that turns when
       dragged like a ball in your hand. Below it, a tray of six ingredients (Nama, Sifat, Aksen, Bahasa, Suara, Sapaan),
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
import { orb, personaOrb, thinkingLevel, type Rgb, type OrbSpec, type CustomOrb, type OrbEl } from '../../ui/orb';
import { handOff } from '../../ui/transition';
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
const hash = (s: string) => { let x = 2166136261; for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619); return (x >>> 0) / 4294967296; };
const BG_A: Rgb = [0.075, 0.078, 0.09], BG_B: Rgb = [0.03, 0.031, 0.037];
const EMPTY: [Rgb, Rgb, Rgb, Rgb] = [[0.3, 0.31, 0.34], [0.5, 0.51, 0.55], [0.66, 0.67, 0.7], [0.86, 0.87, 0.9]];
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

export function openForge(ctx: ScreenCtx, f: PersonaForm, onSaved: (p: CustomPersona, isNew: boolean) => void): void {
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
  const fly = h('div', { class: 'pf-fly', 'aria-hidden': 'true' }, h('span'));
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const root = h('div', { class: 'pf mode-out', role: 'dialog', 'aria-modal': 'true', 'aria-label': f.isNew ? 'Buat persona baru' : 'Edit persona' }, gl.canvas, outside, inside, top, fly, live);
  document.body.append(root);
  const app = document.getElementById('app');
  const appWasInert = !!app?.inert;
  if (app) app.inert = true;

  /* ---------------- state ---------------- */
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const cam = { d: D_OUT * 1.2, yaw: 0, pitch: 0.16, vyaw: 0, vpitch: 0 };
  let mode: 'out' | 'dive' | 'in' | 'surface' | 'leave' = 'out';
  let tween: { from: number; to: number; t0: number; dur: number; yaw0: number; yaw1: number; pitch1: number; done: () => void } | null = null;
  let active = 1, yawT = 0, dragYaw: { x: number; yaw0: number; id: number; lx: number; v: number } | null = null;
  let T = 0, last = 0, raf = 0, closed = false, frames = 0;
  const ripples: Ripple[] = [];
  let drops = 0, fill = f.isNew ? 0 : 0.6, scan = 0, flash = 0, sq = 0, vsq = 0, glass = 1;
  let colors: [Rgb, Rgb, Rgb, Rgb] = EMPTY.map((c) => [...c] as Rgb) as [Rgb, Rgb, Rgb, Rgb];
  let tourGen = 0;
  const log: string[] = [];
  const note = (s: string) => { log.push(`${T.toFixed(2)} ${s}`); if (log.length > 200) log.shift(); };
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
    const B = basis({ pos: [0, 0, 0], yaw: cam.yaw, pitch: cam.pitch, f: 1 });
    return { pos: [-B.Fw[0] * cam.d, -B.Fw[1] * cam.d, -B.Fw[2] * cam.d], yaw: cam.yaw, pitch: cam.pitch, f: camF() };
  };
  const panelYaw = (i: number) => i * STEP;
  function dive(to: 'in' | 'out', panel = active, dur = 1.5, after?: () => void) {
    const goingIn = to === 'in';
    if (goingIn) active = panel;
    const yaw1 = goingIn ? cam.yaw + wrapA(panelYaw(panel) - cam.yaw) : cam.yaw;
    mode = goingIn ? 'dive' : (mode === 'leave' ? 'leave' : 'surface');
    root.classList.remove('mode-out', 'mode-in');
    root.classList.add('mode-move');
    tween = {
      from: cam.d, to: goingIn ? D_IN : D_OUT, t0: T, dur: reduced ? 0.01 : dur, yaw0: cam.yaw, yaw1, pitch1: goingIn ? 0 : 0.16,
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
    const B = basis({ pos: [0, 0, 0], yaw: cam.yaw, pitch: cam.pitch, f: 1 });
    const dir: V3 = [B.R[0] * nx - B.Up[0] * ny + B.Fw[0] * nz, B.R[1] * nx - B.Up[1] * ny + B.Fw[1] * nz, B.R[2] * nx - B.Up[2] * ny + B.Fw[2] * nz];
    addRipple(dir, specColor(fl.i));
    drops++; vsq += 2.6;
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
  const fillTarget = () => {
    const fl = f.filled();
    const n = (fl.name ? 1 : 0) + (fl.desc ? 1.4 : 0) + (fl.accent ? 0.6 : 0) + (fl.greet ? 0.8 : 0) + (fl.voice && (fl.name || fl.desc) ? 0.6 : 0);
    return clamp(Math.min(0.24, drops * 0.08) + (n / 4.4) * 0.7, 0, 0.9);
  };

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
      // the glass falls away: only the persona's coloured ball is left, then the stage dissolves into the app while a
      // real orb element (same place, same size) takes over and is handed to "Persona siap"
      const t0 = T;
      const s0 = sphere();
      const ball = orb(f.spec(), { size: Math.round(s0.r * 2), cls: 'pf-handoff', live: true });
      ball.style.left = (s0.x - s0.r).toFixed(1) + 'px'; ball.style.top = (s0.y - s0.r).toFixed(1) + 'px';
      ball.style.opacity = '0';
      document.body.append(ball);
      const step = () => {
        if (closed) return;
        const k = (T - t0) / (reduced ? 0.05 : 0.75);
        glass = 1 - clamp(k / 0.45);                                   // the grid and rim fall away
        ball.style.opacity = clamp((k - 0.3) / 0.3).toFixed(3);       // the real orb takes over the coloured ball
        root.style.opacity = (1 - clamp((k - 0.55) / 0.45)).toFixed(3);   // dark stage -> the app
        if (k < 1) { requestAnimationFrame(step); return; }
        handOff(ball, 1600);
        note('handoff');
        close(true);
        onSaved(out, f.isNew);
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
    else { root.classList.add('closing'); setTimeout(() => root.remove(), reduced ? 0 : 240); }
    (window as unknown as { __forge?: unknown }).__forge = undefined;
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
    if (mode === 'out') { cam.vyaw = 0; cam.vpitch = 0; }
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
          if (!reduced && mode === 'out' && Math.abs(cam.vyaw) < 0.05) cam.yaw += dt * 0.05;   // a slow idle turn
          if (Math.abs(cam.vpitch) < 0.05) cam.pitch += (0.16 - cam.pitch) * dt * 0.8;
        }
        if (!tween && cam.d > D_OUT) cam.d += (D_OUT - cam.d) * (1 - Math.exp(-dt * 2.5));   // the first approach
      }
      flash = Math.exp(-Math.pow((cam.d - 1) / 0.13, 2)) * (tween ? 1 : 0);
      gl.canvas.style.filter = flash > 0.1 && !reduced ? `blur(${(flash * 4).toFixed(1)}px)` : '';
      vsq += (-90 * sq - 7 * vsq) * dt; sq += vsq * dt; sq = clamp(sq, -0.1, 0.1);
      const ft = mode === 'leave' ? Math.max(fillTarget(), 0.85) : fillTarget();
      fill += (ft - fill) * Math.min(1, dt * 1.8);
      const tgt = fill > 0.02 || f.hasDraft() || f.aiOrb() ? f.spec().colors : EMPTY;
      colors = colors.map((c, i) => c.map((v, j) => v + (tgt[i][j] - v) * Math.min(1, dt * 2.5)) as Rgb) as typeof colors;
      scan += ((f.busy() ? 1 : 0) - scan) * Math.min(1, dt * 3);
      const c = camNow();
      gl.draw({ cam: c, T, colors, fill, pat: 2.3 + hash(f.desc.value.slice(0, 200)) * 2.4, scan, flash, squash: [1 + sq, 1 - sq, 1 + sq], ripples, bgA: BG_A, bgB: BG_B, ctr: ctrNow(), glass });
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
    mode, active: PANELS[active].k, cam: { d: +cam.d.toFixed(3), yaw: +cam.yaw.toFixed(3), pitch: +cam.pitch.toFixed(3), f: +camF().toFixed(1) }, fill: +fill.toFixed(3), scan: +scan.toFixed(2), drops, glass,
    renderer: gl.kind, kb: L.kb, frames, busy: f.busy(), filled: f.filled(), aiOrb: f.aiOrb(), orb: f.orb(), ripples: ripples.length, log: log.slice(), msg: f.msg.textContent,
    sphere: sphere(), chips: tiles.map((c) => { const r = c.getBoundingClientRect(); return { k: c.dataset.k, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }),
    panelRects: panels.map((p) => { const r = p.getBoundingClientRect(); return { k: p.dataset.k, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), op: p.style.opacity }; }),
    /** screen position of a world point (e.g. the sphere's front point) */
    screenOf: (p: V3) => ForgeGL.project(camNow(), L.W, L.H, ctrNow(), p),
    front: () => { const B = basis({ pos: [0, 0, 0], yaw: cam.yaw, pitch: cam.pitch, f: 1 }); return [-B.Fw[0], -B.Fw[1], -B.Fw[2]] as V3; },
    go: (k: PanelKey) => goPanel(PANELS.findIndex((p) => p.k === k), true), dive: (to: 'in' | 'out', k: PanelKey = 'name') => dive(to, PANELS.findIndex((p) => p.k === k)),
    stopSpin: () => { cam.vyaw = 0; cam.vpitch = 0; },
  });

  layout();
  paintAll(); placePanels();
  requestAnimationFrame(() => layout());
  raf = requestAnimationFrame(tick);
  requestAnimationFrame(() => (f.isNew ? inBtn : inBtn).focus({ preventScroll: true }));
  // editing an existing persona: a look at its sphere, then straight inside to the name
  if (!f.isNew) setTimeout(() => { if (!closed && mode === 'out') dive('in', 1, 1.4); }, reduced ? 0 : 900);
}
