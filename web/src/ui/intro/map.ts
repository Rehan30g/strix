/* Voices step of the tour: a navigable VOICE MAP (like a map / star chart), drawn on the tour's orb canvases.
   - A wide 2.5D space: every ball is ONE distinct voice (no duplicates: ids and preview URLs are de-duplicated), grouped
     in clusters by an attribute (accent / gender / age; switchable, the balls glide to their new cluster).
   - Real depth: a pinhole camera above the plane; balls live at different depths z, so panning gives parallax (near balls
     slide faster than far ones), zooming is a dolly (near layers grow faster), depth of field follows the focused ball
     (rack focus: near / far balls blur), far balls fade into the fog, dust specks at many depths.
   - Navigation: one finger / mouse drag = pan with inertia; two fingers = pinch zoom (+ pan); ctrl+wheel / trackpad pinch
     = zoom, wheel = pan; +/- buttons; keyboard arrows / + / - / Enter / A. Double tap = zoom to the ball (or the point).
     The camera always moves on springs (no jumps; cuts under reduced motion).
   - The ball nearest the screen centre becomes the candidate; when the camera rests on it (debounce) it is focused and
     speaks its preview (only after the user has navigated, never over the guide). Tap = centre + hear it; tap the focused
     ball again (or "Add") = add it to the tour's local collection. One audio at a time.
   - Minimap (top right) with the viewport; tap it to fly there.
   Voices: GET /api/voices/library/random?n=24&diverse=1 (shared voice library, same-origin preview proxy). Until that
   route exists (404) a MOCK picks a diverse set from GET /api/voices/library (see loadMapVoices; delete the mock block
   once the route ships). Any other failure (quota / network) -> the tour's static clips. */
import { h } from '../dom';
import { svg } from '../../icons';
import { api } from '../../api';
import { player } from '../../player';
import { defaultVoiceOrb, orb as orbEl, type OrbSpec, type OrbEl, type Rgb } from '../orb';
import type { Rich, Dot } from './stage';
import { clamp, rng } from './kit';

export interface MapVoice {
  id: string; name: string; desc: string;
  attrs: { accent: string; gender: string; age: string; use: string; lang: string };
  previewUrl?: string; clip?: string; spec: OrbSpec;
}
export type MapSource = 'api' | 'mock' | 'static';
export type GroupKey = 'lang' | 'gender' | 'age' | 'accent';
const GROUP_LABEL: Record<GroupKey, string> = { lang: 'Language', gender: 'Gender', age: 'Age', accent: 'Accent' };
let langNames: Intl.DisplayNames | null = null;
try { langNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { /* old browser */ }
const langLabel = (code: string) => { const c = String(code || '').trim(); if (!c) return 'Other'; try { return langNames?.of(c) || c.toUpperCase(); } catch { return c.toUpperCase(); } };

/* ---------------- data ---------------- */
const cap = (s: string) => s.replace(/_/g, ' ').replace(/(^|\s)(\p{L})/gu, (_m, a: string, c: string) => a + c.toUpperCase()).trim();
function sameOrigin(u: unknown): string {
  if (typeof u !== 'string' || !u) return '';
  try { const x = new URL(u, location.href); return x.origin === location.origin ? x.pathname + x.search : ''; } catch { return ''; }
}
/** Library payload (array, {voices} or {items}) -> MapVoices: one per id and per preview, same-origin previews only. */
export function normVoices(r: unknown): MapVoice[] {
  const o = r as { voices?: unknown[]; items?: unknown[] } | unknown[];
  const arr = (Array.isArray(o) ? o : o?.voices || o?.items || []) as Array<Record<string, any>>;
  const out: MapVoice[] = [], ids = new Set<string>(), urls = new Set<string>();
  for (const v of arr) {
    const id = typeof v?.id === 'string' ? v.id : typeof v?.voiceId === 'string' ? v.voiceId : '';
    const url = sameOrigin(v?.previewUrl);
    if (!id || !url || ids.has(id) || urls.has(url)) continue;
    ids.add(id); urls.add(url);
    const raw = String(v.name || 'Voice').trim();
    const [nm, ...rest] = raw.split(/\s+[-–—]\s+/);
    const l = (v.labels || {}) as Record<string, string>;
    out.push({
      id, name: nm.slice(0, 28) || 'Voice', desc: (rest.join(' - ') || cap(String(l.descriptive || l.description || ''))).slice(0, 60),
      attrs: { accent: cap(String(l.accent || v.accent || 'other')) || 'Other', gender: cap(String(l.gender || v.gender || 'other')) || 'Other', age: cap(String(l.age || v.age || 'other')) || 'Other', use: cap(String(l.use_case || v.useCase || '')), lang: langLabel(String(l.language || v.language || '')) },
      previewUrl: url, spec: defaultVoiceOrb(id),
    });
  }
  return out;
}
/** Round-robin over accent x gender buckets so a small set is still varied. */
export function diversePick<T extends MapVoice>(list: T[], n: number): T[] {
  const R = Math.random;
  const buckets = new Map<string, T[]>();
  for (const v of [...list].sort(() => R() - 0.5)) { const k = v.attrs.accent + '|' + v.attrs.gender; if (!buckets.has(k)) buckets.set(k, []); buckets.get(k)!.push(v); }
  const qs = [...buckets.values()].sort(() => R() - 0.5), out: T[] = [];
  while (out.length < n && qs.some((q) => q.length)) for (const q of qs) { const v = q.shift(); if (v && out.length < n) out.push(v); }
  return out;
}
export async function loadMapVoices(fallback: MapVoice[]): Promise<{ voices: MapVoice[]; source: MapSource; note: string }> {
  let note = '';
  try {
    const vs = normVoices(await api.get('/voices/library/random?n=24&diverse=1'));
    if (vs.length >= 6) return { voices: vs.slice(0, 24), source: 'api', note };
    note = 'random: only ' + vs.length;
  } catch (e) {
    const st = (e as { status?: number })?.status;
    note = 'random: ' + (st || (e as Error)?.message);
    if (st !== 404 && st !== 405) return { voices: fallback, source: 'static', note };   // quota / network: static clips
  }
  // ---- MOCK (until /voices/library/random ships): a diverse pick from the normal library. Delete this block then. ----
  try {
    const vs = diversePick(normVoices(await api.get('/voices/library?pageSize=50')), 24);
    if (vs.length >= 6) return { voices: vs, source: 'mock', note };
  } catch (e) { note += '; mock: ' + ((e as { status?: number })?.status || (e as Error)?.message); }
  // ---- end MOCK ----
  return { voices: fallback, source: 'static', note };
}

/* ---------------- the map ---------------- */
interface Ball { v: MapVoice; i: number; x: number; y: number; z: number; tx: number; ty: number; tz: number; vx: number; vy: number; vz: number; R: number; ph: number }
interface Proj { b: Ball; x: number; y: number; r: number; depth: number; s: number }
export interface MapDeps {
  reduced: () => boolean;
  /** a scripted guide line / reaction is audible (auto-play waits for it) */
  guideBusy: () => boolean;
  sayClip: (clip: string, who: string) => Promise<boolean>;
  stopClip: () => void;
  clipAmp: (who: string) => number;
  clipPlaying: (who: string) => boolean;
  /** the user did something on the map (pan / zoom / tap / key) */
  onUser: (kind: 'nav' | 'tap' | 'add') => void;
  /** a voice was heard because the user chose it (tap / auto focus after navigating) */
  onHeard: (v: MapVoice) => void;
  /** add to the tour collection; returns the DOM slot it lands in, or null when full / already there */
  onAdd: (v: MapVoice, from: { x: number; y: number; r: number }) => boolean;
  inCollection: (id: string) => boolean;
  collectionFull: () => boolean;
}
const F = 1000;
const D_MIN = 380, D_MAX = 3800, D_HOME = 1500;
const Z_LAYERS = [0, 420, -150, 850, 200, 1250, 60, 620];

export class VoiceMap {
  readonly el: HTMLElement;            // hit layer (full stage)
  readonly hud: HTMLElement;
  voices: MapVoice[] = [];
  source: MapSource = 'static';
  note = '';
  private balls: Ball[] = [];
  private group: GroupKey = 'lang';
  private clusters: Array<{ label: string; x: number; y: number; r: number; n: number; el: HTMLElement }> = [];
  // camera (world units on the z=0 plane; D = distance to that plane)
  cam = { x: 0, y: 0, D: D_MAX, vx: 0, vy: 0, vD: 0, fz: 0, vfz: 0 };
  private fly: { x: number; y: number; D: number; k: number } | null = null;
  private free = { vx: 0, vy: 0 };     // inertia (world units / s)
  // layout
  private W = 390; private H = 844; private cx = 195; private cy = 400; private U = 1; private top = 54; private bottom = 666;
  // state
  active = false; alpha = 0; private t = 0;
  focus: Ball | null = null; private cand: Ball | null = null; private candAt = 0; private lastAuto = '';
  navigated = false; private surfLock = false; private snapped = true; private restT = 0;
  playing = ''; private playGen = 0; private loadingId = '';
  private blobs = new Map<string, Promise<string>>();
  private failed = new Set<string>();
  private pointers = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private pinch: { d: number; mx: number; my: number } | null = null;
  private moved = false; private lastTap = { t: 0, x: 0, y: 0 };
  private track: Array<{ t: number; x: number; y: number }> = [];
  private dust: Array<{ x: number; y: number; z: number; r: number; c: Rgb }> = [];
  private lastProj: Proj[] = [];
  private fps = { n: 0, t0: 0, v: 0, samples: [] as number[], worst: 0 };
  // HUD
  private zIn: HTMLButtonElement; private zOut: HTMLButtonElement; private home: HTMLButtonElement;
  private chips: HTMLElement; private mini: HTMLCanvasElement; private miniCtx: CanvasRenderingContext2D | null;
  private card: HTMLElement; private cName: HTMLElement; private cDesc: HTMLElement; private cAttrs: HTMLElement; private cPlay: HTMLButtonElement; private cAdd: HTMLButtonElement; private cHint: HTMLElement;
  private label: HTMLElement;
  readonly collRow: HTMLElement;
  log: string[] = [];

  constructor(private deps: MapDeps, collRow: HTMLElement) {
    this.collRow = collRow;
    this.el = h('div', { class: 'tu-map', tabindex: '0', role: 'application', 'aria-roledescription': 'voice map', 'aria-label': 'Voice map. Drag or use the arrow keys to explore, plus and minus to zoom, Enter to hear the voice in the middle, A to add it.' });
    this.zIn = h('button', { type: 'button', class: 'tu-mbtn', 'aria-label': 'Zoom in', html: svg('plus') }) as HTMLButtonElement;
    this.zOut = h('button', { type: 'button', class: 'tu-mbtn', 'aria-label': 'Zoom out' }, h('span', { class: 'tu-minus', 'aria-hidden': 'true' })) as HTMLButtonElement;
    this.home = h('button', { type: 'button', class: 'tu-mbtn', 'aria-label': 'Show the whole map', html: svg('compass') }) as HTMLButtonElement;
    this.chips = h('div', { class: 'tu-mgroup', role: 'radiogroup', 'aria-label': 'Group voices by' },
      ...(Object.keys(GROUP_LABEL) as GroupKey[]).map((k) => { const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(k === this.group), 'data-k': k }, GROUP_LABEL[k]); b.onclick = () => { this.user('nav'); this.regroup(k); }; return b; }));
    this.mini = h('canvas', { class: 'tu-mini', width: 96, height: 96, 'aria-label': 'Minimap: tap to fly there', role: 'img' }) as HTMLCanvasElement;
    this.miniCtx = this.mini.getContext('2d');
    this.cName = h('b'); this.cDesc = h('span', { class: 'tu-mdesc' }); this.cAttrs = h('div', { class: 'tu-mattrs' });
    this.cPlay = h('button', { type: 'button', class: 'tu-mplay', 'aria-label': 'Play', html: svg('play') }) as HTMLButtonElement;
    this.cAdd = h('button', { type: 'button', class: 'tu-madd', html: svg('plus') }, h('span', null, 'Add')) as HTMLButtonElement;
    this.cHint = h('p', { class: 'tu-mhint' }, 'Drag to explore · pinch or +/− to zoom · tap a voice');
    this.card = h('div', { class: 'tu-mcard' },
      h('div', { class: 'tu-mrow' }, h('div', { class: 'tu-mt' }, this.cName, this.cDesc), this.cPlay, this.cAdd),
      h('div', { class: 'tu-mrow2' }, this.cAttrs, collRow), this.cHint);
    this.label = h('div', { class: 'tu-mlabel', 'aria-hidden': 'true' }, h('b'), h('span'));
    const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    this.hud = h('div', { class: 'tu-mhud' }, this.chips, this.mini, h('div', { class: 'tu-mzoom' }, this.zIn, this.zOut, this.home), this.card, this.label, live);
    this.live = live;
    this.zIn.onclick = () => { this.user('nav'); this.zoomBy(0.62); };
    this.zOut.onclick = () => { this.user('nav'); this.zoomBy(1.6); };
    this.home.onclick = () => { this.user('nav'); this.overview(); };
    this.cPlay.onclick = () => { const b = this.focus; if (!b) return; this.user('tap'); if (this.isPlaying(b.v)) this.stopVoice(); else void this.hear(b, true); };
    this.cAdd.onclick = () => { const b = this.focus; if (b) this.add(b); };
    this.mini.addEventListener('pointerdown', (e) => this.miniTap(e));
    this.bindInput();
    const R = rng(4242);
    for (let i = 0; i < 70; i++) this.dust.push({ x: R() * 4000 - 2000, y: R() * 4000 - 2000, z: -250 + R() * 3200, r: 0.8 + R() * 2.2, c: [0.55 + R() * 0.4, 0.8 + R() * 0.2, 0.9 + R() * 0.1] });
  }
  private live: HTMLElement;

  /* ---------- data / layout ---------- */
  setVoices(vs: MapVoice[], source: MapSource, note = ''): void {
    const seen = new Set<string>();
    this.voices = vs.filter((v) => (seen.has(v.id) ? false : (seen.add(v.id), true)));
    this.source = source; this.note = note;
    const R = rng(77);
    this.balls = this.voices.map((v, i) => ({ v, i, x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, vx: 0, vy: 0, vz: 0, R: 74 + R() * 38, ph: R() * 6.28 }));
    this.layoutGroups(true);
    this.paintCard();
    // library previews can take seconds upstream: warm them in the background (2 at a time), the surf's voices and the
    // middle of the first cluster first, so a voice usually starts at once when it is focused
    const c0 = this.clusters[0];
    const order = [...this.surfPicks(3), ...[...this.balls].sort((a, b) => Math.hypot(a.tx - (c0?.x || 0), a.ty - (c0?.y || 0)) - Math.hypot(b.tx - (c0?.x || 0), b.ty - (c0?.y || 0)))];
    this.warmQ = [...new Set(order.map((b) => b.v))].filter((v) => v.previewUrl);
    for (let i = 0; i < 2; i++) this.warmNext();
  }
  private warmQ: MapVoice[] = [];
  private warmNext(): void {
    const v = this.warmQ.shift();
    if (!v) return;
    this.blobUrl(v).catch(() => { this.failed.add(v.id); }).finally(() => this.warmNext());
  }
  private surfPicks(n: number): Ball[] {
    const picks: Ball[] = [];
    for (const c of this.clusters) {
      const bs = this.balls.filter((b) => !this.failed.has(b.v.id) && Math.hypot(b.tx - c.x, b.ty - c.y) < c.r + 10).sort((a, b) => Math.hypot(a.tx - c.x, a.ty - c.y) - Math.hypot(b.tx - c.x, b.ty - c.y));
      if (bs[0] && !picks.includes(bs[0])) picks.push(bs[0]);
      if (picks.length >= n) break;
    }
    return picks;
  }
  private keyOf(v: MapVoice): string { return v.attrs[this.group] || 'Other'; }
  private layoutGroups(snap: boolean): void {
    const groups = new Map<string, Ball[]>();
    for (const b of this.balls) { const k = this.keyOf(b.v); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(b); }
    let list = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    // too many tiny groups (e.g. every accent different): the singles share one "Other" cluster
    if (list.length > 6) {
      const singles = list.filter(([, bs]) => bs.length === 1).flatMap(([, bs]) => bs);
      if (singles.length > 1) list = [...list.filter(([, bs]) => bs.length > 1), ['Other', singles] as [string, Ball[]]].sort((a, b) => b[1].length - a[1].length);
    }
    const placed: Array<{ x: number; y: number; r: number }> = [];
    const R = rng(91 + this.group.length);
    for (const c of this.clusters) c.el.remove();
    this.clusters = [];
    list.forEach(([label, bs], j) => {
      const cr = 130 + 160 * Math.sqrt(bs.length);
      // greedy spiral: the first cluster in the middle, the others around it without overlapping
      let cx = 0, cy = 0;
      if (j > 0) for (let t = 1.2; t < 60; t += 0.07) {
        const rr = 260 * t, x = Math.cos(t * 1.9 + j) * rr, y = Math.sin(t * 1.9 + j) * rr * 0.78;
        if (placed.every((p) => Math.hypot(p.x - x, p.y - y) > p.r + cr + 40)) { cx = x; cy = y; break; }
      }
      placed.push({ x: cx, y: cy, r: cr });
      bs.forEach((b, i) => {
        const a = i * 2.39996 + j * 1.3, rad = i === 0 ? 0 : 160 * Math.sqrt(i + 0.15);
        b.tx = cx + Math.cos(a) * rad + (R() - 0.5) * 40; b.ty = cy + Math.sin(a) * rad * 0.86 + (R() - 0.5) * 40;
        b.tz = Z_LAYERS[(i + j * 3) % Z_LAYERS.length] + (R() - 0.5) * 120;
        if (snap) { b.x = b.tx; b.y = b.ty; b.z = b.tz; }
      });
      const el = h('div', { class: 'tu-mcl', 'aria-hidden': 'true' }, h('b', null, label), h('span', null, String(bs.length)));
      this.hud.prepend(el);
      this.clusters.push({ label, x: cx, y: cy, r: cr, n: bs.length, el });
    });
  }
  regroup(k: GroupKey): void {
    if (k === this.group) return;
    this.group = k;
    for (const b of this.chips.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.k === k));
    this.layoutGroups(this.deps.reduced());
    this.note2('group ' + k);
    const c = this.clusters[0];
    if (c) this.flyTo(c.x, c.y, Math.max(D_HOME, this.cam.D), 22);
  }
  resize(o: { W: number; H: number; areaTop: number; areaH: number; mobile: boolean }): void {
    this.W = o.W; this.H = o.H;
    this.top = o.areaTop + (o.mobile ? 44 : 50); this.bottom = o.areaTop + o.areaH - (o.mobile ? 104 : 108);
    this.cx = o.W / 2; this.cy = (this.top + this.bottom) / 2;
    this.U = clamp(Math.min(o.W, o.areaH) / 620, 0.55, 1.35);
    this.hud.style.setProperty('--mtop', o.areaTop + 'px');
    this.hud.style.setProperty('--mbot', o.H - (o.areaTop + o.areaH) + 'px');
  }

  /* ---------- activation ---------- */
  activate(): void {
    if (this.active) return;
    this.active = true;
    this.el.hidden = false; this.hud.hidden = false;
    this.navigated = false; this.lastAuto = '';
    // dive in: from far away to the home view of the biggest cluster
    const c = this.clusters[0];
    this.cam.x = c ? c.x : 0; this.cam.y = c ? c.y : 0;
    this.cam.D = this.deps.reduced() ? D_HOME : D_MAX * 1.25; this.cam.vD = 0;
    this.flyTo(this.cam.x, this.cam.y, D_HOME, 26);
  }
  deactivate(): void {
    if (!this.active) return;
    this.active = false;
    this.stopVoice();
    this.el.hidden = true;
    this.pointers.clear(); this.pinch = null;
    this.label.classList.remove('on');
  }

  /* ---------- camera ---------- */
  private flyTo(x: number, y: number, D: number, k = 34): void {
    if (this.deps.reduced()) { this.cam.x = x; this.cam.y = y; this.cam.D = clamp(D, D_MIN, D_MAX); this.fly = null; this.free.vx = this.free.vy = 0; return; }
    this.fly = { x, y, D: clamp(D, D_MIN, D_MAX), k }; this.free.vx = this.free.vy = 0;
  }
  private zoomBy(f: number, sx = this.cx, sy = this.cy): void {
    const tD = clamp((this.fly ? this.fly.D : this.cam.D) * f, D_MIN, D_MAX);
    const base = this.fly || this.cam;
    // keep the world point under (sx, sy) on the z=0 plane where it is
    const wx = base.x + (sx - this.cx) / (this.U * F / base.D), wy = base.y + (sy - this.cy) / (this.U * F / base.D);
    this.flyTo(wx - (sx - this.cx) / (this.U * F / tD), wy - (sy - this.cy) / (this.U * F / tD), tD, 40);
  }
  overview(): void {
    if (!this.balls.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of this.balls) { x0 = Math.min(x0, b.tx - b.R); x1 = Math.max(x1, b.tx + b.R); y0 = Math.min(y0, b.ty - b.R); y1 = Math.max(y1, b.ty + b.R); }
    const w = (x1 - x0) * this.U, hh = (y1 - y0) * this.U;
    const D = Math.max((F * w) / (this.W * 0.86), (F * hh) / ((this.bottom - this.top) * 0.86));
    this.flyTo((x0 + x1) / 2, (y0 + y1) / 2, D, 26);
  }
  /** focus framing: the ball sits in the middle at ~22 % of the short side */
  private frameBall(b: Ball, closer = 1): void {
    const want = Math.min(this.W, this.bottom - this.top) * 0.16 * closer;
    const depth = (F * b.R * this.U) / want;
    const D = clamp(depth - b.z, D_MIN, Math.max(D_MIN, Math.min(D_MAX, this.cam.D)));
    // centre it: for a ball at depth z the screen x is (b.x - cam.x) * U * F / (D + z) -> cam.x = b.x
    this.flyTo(b.x, b.y, closer > 1 ? D : Math.min(this.cam.D, D), 34);
  }
  private screenToWorld(dx: number, dy: number): [number, number] { const s = (this.U * F) / this.cam.D; return [dx / s, dy / s]; }
  private bounds() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of this.balls) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y); }
    return { x0: x0 - 300, x1: x1 + 300, y0: y0 - 300, y1: y1 + 300 };
  }
  private stepCam(dt: number): void {
    const c = this.cam, red = this.deps.reduced();
    if (this.fly) {
      const f = this.fly, k = f.k, d = 2 * Math.sqrt(k);
      c.vx += (k * (f.x - c.x) - d * c.vx) * dt; c.vy += (k * (f.y - c.y) - d * c.vy) * dt;
      c.vD += (k * (f.D - c.D) - d * c.vD) * dt;
      c.x += c.vx * dt; c.y += c.vy * dt; c.D += c.vD * dt;
      if (Math.abs(f.x - c.x) + Math.abs(f.y - c.y) < 0.5 && Math.abs(f.D - c.D) < 0.5 && Math.hypot(c.vx, c.vy, c.vD) < 2) { c.x = f.x; c.y = f.y; c.D = f.D; c.vx = c.vy = c.vD = 0; this.fly = null; }
    } else if (!this.pointers.size) {
      c.x += this.free.vx * dt; c.y += this.free.vy * dt;
      const k = Math.exp(-dt * 3.4); this.free.vx *= k; this.free.vy *= k;
      if (Math.hypot(this.free.vx, this.free.vy) < 4) this.free.vx = this.free.vy = 0;
      // soft edges: the camera drifts back inside the map
      const B = this.bounds();
      if (!red && this.balls.length) {
        const ox = c.x < B.x0 ? B.x0 - c.x : c.x > B.x1 ? B.x1 - c.x : 0, oy = c.y < B.y0 ? B.y0 - c.y : c.y > B.y1 ? B.y1 - c.y : 0;
        c.x += ox * Math.min(1, dt * 4); c.y += oy * Math.min(1, dt * 4);
      }
    }
    c.D = clamp(c.D, D_MIN * 0.9, D_MAX * 1.3);
    // rack focus follows the focused ball's depth (else the reference plane)
    const fz = this.focus ? this.focus.z : 0;
    if (red) c.fz = fz; else { c.vfz += (30 * (fz - c.fz) - 11 * c.vfz) * dt; c.fz += c.vfz * dt; }
  }
  private moving(): number { return Math.hypot(this.cam.vx, this.cam.vy) + Math.abs(this.cam.vD) * 0.3 + Math.hypot(this.free.vx, this.free.vy) + (this.pointers.size ? 999 : 0); }

  /* ---------- input ---------- */
  private user(kind: 'nav' | 'tap' | 'add'): void { if (kind === 'nav') { this.navigated = true; this.snapped = false; this.restT = 0; } this.deps.onUser(kind); }
  private bindInput(): void {
    const el = this.el;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      el.focus({ preventScroll: true });
      try { el.setPointerCapture(e.pointerId); } catch { /* */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
      if (this.pointers.size === 1) { this.moved = false; this.track = [{ t: performance.now(), x: e.clientX, y: e.clientY }]; this.fly = null; this.free.vx = this.free.vy = 0; this.cam.vx = this.cam.vy = this.cam.vD = 0; }
      if (this.pointers.size === 2) { this.moved = true; this.pinch = this.pinchState(); this.user('nav'); }
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size >= 2 && this.pinch) {
        const n = this.pinchState(), o = this.pinch;
        // pan by the midpoint, zoom around it
        const [wx, wy] = this.screenToWorld(n.mx - o.mx, n.my - o.my);
        this.cam.x -= wx; this.cam.y -= wy;
        const D2 = clamp(this.cam.D * (o.d / Math.max(10, n.d)), D_MIN, D_MAX);
        const r = this.rootOff();
        const sx = n.mx - r.left, sy = n.my - r.top;
        const ax = this.cam.x + (sx - this.cx) / (this.U * F / this.cam.D), ay = this.cam.y + (sy - this.cy) / (this.U * F / this.cam.D);
        this.cam.D = D2;
        this.cam.x = ax - (sx - this.cx) / (this.U * F / D2); this.cam.y = ay - (sy - this.cy) / (this.U * F / D2);
        this.pinch = n;
        return;
      }
      if (!this.moved && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > 8) { this.moved = true; this.user('nav'); }
      if (!this.moved) return;
      const [wx, wy] = this.screenToWorld(dx, dy);
      this.cam.x -= wx; this.cam.y -= wy;
      const now = performance.now();
      this.track.push({ t: now, x: e.clientX, y: e.clientY });
      while (this.track.length > 2 && now - this.track[0].t > 90) this.track.shift();
    });
    const up = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 1) { this.pinch = null; const q = [...this.pointers.values()][0]; this.track = [{ t: performance.now(), x: q.x, y: q.y }]; return; }
      if (this.pointers.size) return;
      this.pinch = null;
      if (e.type === 'pointercancel') return;
      if (this.moved) {
        // fling: velocity from the last ~90 ms
        const a = this.track[0], b = this.track[this.track.length - 1];
        const dt = Math.max(0.016, (b.t - a.t) / 1000);
        if (!this.deps.reduced() && b.t - a.t < 200 && performance.now() - b.t < 80) {
          const [wx, wy] = this.screenToWorld((b.x - a.x) / dt, (b.y - a.y) / dt);
          this.free.vx = -clamp(wx, -6000, 6000); this.free.vy = -clamp(wy, -6000, 6000);
        }
        return;
      }
      const r = this.rootOff();
      this.tap(e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.user('nav');
      const r = this.rootOff();
      const k = e.deltaMode === 1 ? 30 : e.deltaMode === 2 ? 300 : 1;
      if (e.ctrlKey || e.metaKey) this.zoomBy(Math.exp(clamp(e.deltaY * k, -120, 120) * 0.006), e.clientX - r.left, e.clientY - r.top);
      else {
        this.fly = null;
        const [wx, wy] = this.screenToWorld((e.shiftKey ? e.deltaY : e.deltaX) * k, (e.shiftKey ? 0 : e.deltaY) * k);
        this.cam.x += wx; this.cam.y += wy;
      }
    }, { passive: false });
    el.addEventListener('keydown', (e) => {
      if (!this.active) return;
      const k = e.key, step = 260;
      const base = this.fly || this.cam, s = (this.U * F) / base.D, w = step / s;
      let used = true;
      if (k === 'ArrowLeft') this.flyTo(base.x - w, base.y, base.D, 40);
      else if (k === 'ArrowRight') this.flyTo(base.x + w, base.y, base.D, 40);
      else if (k === 'ArrowUp') this.flyTo(base.x, base.y - w, base.D, 40);
      else if (k === 'ArrowDown') this.flyTo(base.x, base.y + w, base.D, 40);
      else if (k === '+' || k === '=') this.zoomBy(0.62);
      else if (k === '-' || k === '_') this.zoomBy(1.6);
      else if (k === '0') this.overview();
      else if (k === 'Enter' || k === ' ') { const b = this.focus || this.cand; if (b) { this.user('tap'); if (this.isPlaying(b.v)) this.stopVoice(); else { this.setFocus(b); void this.hear(b, true); } } }
      else if (k === 'a' || k === 'A') { const b = this.focus || this.cand; if (b) this.add(b); }
      else used = false;
      if (used) { e.preventDefault(); e.stopPropagation(); if (k.startsWith('Arrow') || k === '+' || k === '=' || k === '-' || k === '_' || k === '0') this.user('nav'); }
    });
  }
  private rootOff(): DOMRect { return (this.el.parentElement || this.el).getBoundingClientRect(); }
  private pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  /** top-most ball whose visible circle contains (x, y) */
  hit(x: number, y: number): Ball | null {
    let best: Proj | null = null;
    for (const p of this.lastProj) if (Math.hypot(p.x - x, p.y - y) <= p.r && (!best || p.depth < best.depth)) best = p;
    return best ? best.b : null;
  }
  private tap(x: number, y: number): void {
    const now = performance.now();
    const dbl = now - this.lastTap.t < 320 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 40;
    this.lastTap = { t: dbl ? 0 : now, x, y };
    const b = this.hit(x, y);
    if (dbl) {
      this.user('nav');
      if (b) { this.setFocus(b); this.frameBall(b, 1.9); } else this.zoomBy(0.5, x, y);
      return;
    }
    if (!b) return;
    if (this.focus === b && (this.isPlaying(b.v) || this.lastAuto === b.v.id || this.heardIds.has(b.v.id)) && !this.deps.inCollection(b.v.id)) {
      // second tap on the focused voice: keep it (double tap is handled above)
      setTimeout(() => { if (this.lastTap.t === now) this.add(b); }, 330);
      return;
    }
    this.user('tap');
    this.setFocus(b);
    this.frameBall(b);
    void this.hear(b, true);
  }
  private heardIds = new Set<string>();
  private miniTap(e: PointerEvent): void {
    e.preventDefault(); e.stopPropagation();
    const r = this.mini.getBoundingClientRect(), m = this.miniMap();
    if (!m) return;
    const x = m.x0 + ((e.clientX - r.left) / r.width) * m.w, y = m.y0 + ((e.clientY - r.top) / r.height) * m.h;
    this.user('nav');
    this.flyTo(x, y, this.cam.D, 30);
  }

  /* ---------- audio ---------- */
  private who(v: MapVoice): string { return 'tourmap:' + v.id; }
  isPlaying(v: MapVoice): boolean {
    if (v.clip && !v.previewUrl) return this.deps.clipPlaying('voice:' + v.id);
    return this.playing === v.id && (player.speaker === this.who(v) || (player.busy && this.loadingId === v.id) || this.loadingId === v.id);
  }
  private amp(v: MapVoice): number {
    if (v.clip && !v.previewUrl) return this.deps.clipAmp('voice:' + v.id);
    const l = player.level();
    return l.who === this.who(v) ? l.amp : 0;
  }
  private blobUrl(v: MapVoice): Promise<string> {
    let p = this.blobs.get(v.id);
    if (!p) {
      p = fetch(v.previewUrl!, { credentials: 'same-origin' }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status)))).then((b) => URL.createObjectURL(b));
      p.catch(() => this.blobs.delete(v.id));
      this.blobs.set(v.id, p);
    }
    return p;
  }
  prefetch(v: MapVoice): void { if (v.previewUrl && !this.failed.has(v.id)) this.blobUrl(v).catch(() => {}); }
  stopVoice(): void {
    this.playGen++;
    const was = this.playing; this.playing = ''; this.loadingId = '';
    if (was && player.speaker?.startsWith('tourmap:')) player.stop();
    else if (was && player.busy && !player.pending) player.stop();
    const v = this.voices.find((x) => x.id === was);
    if (v?.clip && this.deps.clipPlaying('voice:' + v.id)) this.deps.stopClip();
    this.paintCard();
  }
  /** play a voice's preview (cut after `cut` s for the surf). Resolves when it ends / is replaced. One audio at a time. */
  async play(v: MapVoice, cut = 0): Promise<boolean> {
    const my = ++this.playGen;
    this.deps.stopClip();
    if (player.busy) player.stop();
    this.playing = v.id;
    this.heardIds.add(v.id);
    this.paintCard();
    this.note2('play ' + v.name);
    if (!v.previewUrl || this.failed.has(v.id)) {
      if (!v.clip) { this.playing = ''; this.paintCard(); return false; }
      const ok = await this.deps.sayClip(v.clip, 'voice:' + v.id);
      if (my === this.playGen) { this.playing = ''; this.paintCard(); }
      return ok;
    }
    this.loadingId = v.id;
    let src = '';
    try { src = await this.blobUrl(v); } catch { src = ''; }
    if (my !== this.playGen) return false;
    if (!src) { this.note2('preview failed ' + v.name + ' (fetch)'); this.failed.add(v.id); this.loadingId = ''; this.playing = ''; this.paintCard(); return false; }
    try { await player.playUrl(src, this.who(v)); }
    catch (e) {
      if (my !== this.playGen || (e as Error)?.name === 'AbortError') return false;
      this.note2('preview failed ' + v.name + ' ' + ((e as Error)?.name || ''));
      this.failed.add(v.id); this.loadingId = ''; this.playing = ''; this.paintCard();
      return false;
    }
    if (my !== this.playGen) return false;
    this.loadingId = '';
    this.paintCard();
    return new Promise<boolean>((res) => {
      let done = false;
      const end = (ok: boolean) => { if (done) return; done = true; off(); if (t) clearTimeout(t); if (my === this.playGen) { this.playing = ''; this.paintCard(); } res(ok); };
      const off = player.on('change', () => { if (my !== this.playGen || player.speaker !== this.who(v) || !player.busy) end(my === this.playGen); });
      const t = cut > 0 ? setTimeout(() => { if (my === this.playGen && player.speaker === this.who(v)) void player.fadeStop(260).then(() => end(true)); else end(my === this.playGen); }, cut * 1000) : 0;
      if (my !== this.playGen || !player.busy) end(my === this.playGen);
    });
  }
  /** focus + play; `user` = chosen by the user (counts as heard) */
  async hear(b: Ball, user: boolean, cut = 0): Promise<boolean> {
    this.setFocus(b);
    if (user) { this.lastAuto = b.v.id; this.deps.onHeard(b.v); }
    return this.play(b.v, cut);
  }
  setFocus(b: Ball | null): void {
    if (this.focus === b) return;
    this.focus = b;
    if (b) { this.live.textContent = `${b.v.name}. ${[b.v.desc, b.v.attrs.lang, b.v.attrs.accent, b.v.attrs.gender, b.v.attrs.age].filter(Boolean).join(', ')}`; this.prefetch(b.v); }
    this.paintCard();
  }
  add(b: Ball): void {
    if (this.deps.inCollection(b.v.id) || this.deps.collectionFull()) { this.paintCard(); return; }
    const p = this.lastProj.find((q) => q.b === b);
    const ok = this.deps.onAdd(b.v, p ? { x: p.x, y: p.y, r: p.r } : { x: this.cx, y: this.cy, r: 30 });
    if (ok) this.user('add');
    this.paintCard();
  }
  /** the scripted fly-through ("channel surfing") of a few voices; cancelled by any user input via surfStop() */
  private surfGen = 0;
  async surf(n = 3, onEach?: () => boolean): Promise<boolean> {
    const my = ++this.surfGen;
    this.surfLock = true;
    // one voice from each of the biggest clusters, near the middle of the cluster
    const picks = this.surfPicks(n);
    for (const b of picks) this.prefetch(b.v);
    for (const b of picks) {
      if (my !== this.surfGen || (onEach && !onEach())) return false;
      this.setFocus(b); this.frameBall(b);
      await new Promise((r) => setTimeout(r, this.deps.reduced() ? 50 : 650));
      if (my !== this.surfGen) return false;
      await this.hear(b, false, 2.8);
      if (my !== this.surfGen) return false;
      await new Promise((r) => setTimeout(r, 180));
    }
    if (my !== this.surfGen) return false;
    this.surfLock = false;
    const c0 = this.clusters[0];
    this.flyTo(c0 ? c0.x : this.cam.x, c0 ? c0.y : this.cam.y, D_HOME, 20);
    return true;
  }
  surfStop(): void { this.surfGen++; this.surfLock = false; }
  get surfing(): boolean { return this.surfLock; }

  /* ---------- HUD ---------- */
  paintCard(): void {
    const b = this.focus;
    this.card.classList.toggle('empty', !b);
    if (!b) { this.cName.textContent = this.voices.length ? 'Voice map' : 'Loading voices…'; this.cDesc.textContent = this.voices.length ? `${this.voices.length} voices` : ''; this.cAttrs.replaceChildren(); this.cPlay.disabled = true; this.cAdd.disabled = true; return; }
    const v = b.v;
    this.cName.textContent = v.name;
    this.cDesc.textContent = this.failed.has(v.id) && !v.clip ? 'Preview unavailable right now' : v.desc;
    this.cAttrs.replaceChildren(...[v.attrs.lang, v.attrs.accent, v.attrs.gender, v.attrs.age].filter((x, i, a) => x && x !== 'Other' && a.indexOf(x) === i).map((x) => h('span', null, x)));
    const on = this.isPlaying(v), loading = this.loadingId === v.id;
    this.cPlay.disabled = false;
    this.cPlay.classList.toggle('loading', loading);
    const ic = on ? 'stop' : 'play';
    if (this.cPlay.dataset.ic !== ic) { this.cPlay.dataset.ic = ic; this.cPlay.innerHTML = svg(ic); this.cPlay.setAttribute('aria-label', on ? `Stop ${v.name}` : `Play ${v.name}`); }
    const inC = this.deps.inCollection(v.id);
    this.cAdd.disabled = inC || this.deps.collectionFull();
    const lab = inC ? 'Added' : this.deps.collectionFull() ? 'Full' : 'Add';
    if (this.cAdd.dataset.l !== lab) { this.cAdd.dataset.l = lab; this.cAdd.innerHTML = svg(inC ? 'check' : 'plus'); this.cAdd.append(h('span', null, lab)); this.cAdd.setAttribute('aria-label', inC ? `${v.name} is in your collection` : `Add ${v.name} to your collection`); }
  }
  private note2(s: string): void { this.log.push(`${this.t.toFixed(2)} ${s}`); if (this.log.length > 200) this.log.shift(); }
  private miniMap() {
    if (!this.balls.length) return null;
    const B = this.bounds();
    const w = B.x1 - B.x0, hh = B.y1 - B.y0, m = Math.max(w, hh);
    return { x0: (B.x0 + B.x1) / 2 - m / 2, y0: (B.y0 + B.y1) / 2 - m / 2, w: m, h: m };
  }
  private drawMini(): void {
    const c = this.miniCtx, m = this.miniMap();
    if (!c || !m) return;
    const S = this.mini.width;
    c.clearRect(0, 0, S, S);
    const X = (x: number) => ((x - m.x0) / m.w) * S, Y = (y: number) => ((y - m.y0) / m.h) * S;
    for (const b of this.balls) {
      const col = b.v.spec.colors[1];
      c.fillStyle = `rgb(${col.map((x) => Math.round(x * 255)).join(',')})`;
      c.globalAlpha = b === this.focus ? 1 : 0.75;
      c.beginPath(); c.arc(X(b.x), Y(b.y), b === this.focus ? 4.2 : 2.8, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
    // viewport on the z=0 plane
    const s = (this.U * F) / this.cam.D;
    const vx0 = this.cam.x - this.cx / s, vx1 = this.cam.x + (this.W - this.cx) / s, vy0 = this.cam.y - (this.cy - this.top + 20) / s, vy1 = this.cam.y + (this.bottom - this.cy + 20) / s;
    c.strokeStyle = 'rgba(255,255,255,.85)'; c.lineWidth = 1.5;
    const rx0 = clamp(X(vx0), 1, S - 1), rx1 = clamp(X(vx1), 1, S - 1), ry0 = clamp(Y(vy0), 1, S - 1), ry1 = clamp(Y(vy1), 1, S - 1);
    c.strokeRect(rx0, ry0, Math.max(3, rx1 - rx0), Math.max(3, ry1 - ry0));
  }

  /* ---------- frame ---------- */
  /** advance + draw into the tour's lists (front orbs / dots, back dust) */
  frame(dt: number, T: number, rich: Rich[], dots: Dot[], bdots: Dot[]): void {
    this.t += dt;
    const red = this.deps.reduced();
    const target = this.active ? 1 : 0;
    this.alpha += (target - this.alpha) * (red ? 1 : 1 - Math.exp(-dt * 5));
    if (Math.abs(this.alpha - target) < 0.003) this.alpha = target;
    if (this.alpha <= 0.002) { this.hud.hidden = true; this.lastProj = []; for (const c of this.clusters) c.el.style.opacity = '0'; return; }
    this.hud.hidden = false;
    this.hud.style.opacity = String(clamp(this.alpha * 1.4 - 0.4));
    // fps (only while active)
    const now = performance.now();
    if (!this.fps.t0) this.fps.t0 = now;
    this.fps.n++;
    if (dt > this.fps.worst && this.fps.samples.length) this.fps.worst = dt;
    if (now - this.fps.t0 >= 1000) { this.fps.v = Math.round((this.fps.n * 1000) / (now - this.fps.t0)); this.fps.samples.push(this.fps.v); if (this.fps.samples.length > 120) this.fps.samples.shift(); this.fps.n = 0; this.fps.t0 = now; }

    // balls glide to their (re)grouped spots
    for (const b of this.balls) {
      if (red) { b.x = b.tx; b.y = b.ty; b.z = b.tz; continue; }
      const k = 16, d = 7;
      b.vx += (k * (b.tx - b.x) - d * b.vx) * dt; b.vy += (k * (b.ty - b.y) - d * b.vy) * dt; b.vz += (k * (b.tz - b.z) - d * b.vz) * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    }
    this.stepCam(dt);

    const c = this.cam, U = this.U, A = this.alpha;
    const fdepth = Math.max(120, c.D + c.fz);
    const proj: Proj[] = [];
    for (const b of this.balls) {
      const bob = red ? 0 : 1;
      const z = b.z + Math.sin(T * 0.4 + b.ph) * 18 * bob;
      const depth = c.D + z;
      if (depth < 90) continue;
      const s = F / depth;
      const x = this.cx + (b.x + Math.sin(T * 0.23 + b.ph) * 10 * bob - c.x) * U * s;
      const y = this.cy + (b.y + Math.cos(T * 0.19 + b.ph * 1.7) * 8 * bob - c.y) * U * s;
      const amp = b === this.focus ? this.amp(b.v) : 0;
      const r = b.R * U * s * (1 + amp * 0.06) * (b === this.focus ? 1.04 : 1);
      if (x + r < -40 || x - r > this.W + 40 || y + r < -40 || y - r > this.H + 40) continue;   // culled
      proj.push({ b, x, y, r, depth, s });
    }
    proj.sort((a, b) => b.depth - a.depth);   // far first
    this.lastProj = proj.filter((p) => p.r > 6);

    // candidate = nearest to the centre (within its own radius + a margin), only when the camera rests
    let cand: Proj | null = null, cd = Infinity;
    for (const p of proj) { const d = Math.hypot(p.x - this.cx, p.y - this.cy); if (d < Math.max(p.r, 46) + 20 && d - p.r * 0.3 < cd && p.r > 14) { cd = d - p.r * 0.3; cand = p; } }
    const resting = this.moving() < 30 && !this.pinch;
    if (!this.fly && !this.pointers.size && Math.hypot(this.free.vx, this.free.vy) < 4 && this.navigated && !this.snapped && !this.surfLock && this.active) {
      this.restT += dt;
      if (this.restT > 0.18) {
        this.snapped = true;
        const lim = Math.min(this.W, this.bottom - this.top) * 0.36;
        let best: Proj | null = null, bd = Infinity;
        for (const p of proj) { if (p.r < 18) continue; const d = Math.hypot(p.x - this.cx, p.y - this.cy) / Math.max(1, Math.sqrt(p.r)); if (Math.hypot(p.x - this.cx, p.y - this.cy) < lim + p.r * 0.5 && d < bd) { bd = d; best = p; } }
        if (best && Math.hypot(best.x - this.cx, best.y - this.cy) > 4) { this.note2('snap ' + best.b.v.name); this.flyTo(best.b.x, best.b.y, this.cam.D, 16); }
      }
    } else if (this.pointers.size || this.fly) this.restT = 0;
    if (cand?.b !== this.cand) { this.cand = cand?.b || null; this.candAt = this.t; if (this.cand) this.prefetch(this.cand.v); }
    if (this.active && resting && this.cand && !this.surfLock && this.navigated && this.t - this.candAt > 0.45 && this.lastAuto !== this.cand.v.id && !this.failed.has(this.cand.v.id) && !this.deps.guideBusy()) {
      this.lastAuto = this.cand.v.id;
      this.note2('auto ' + this.cand.v.name);
      void this.hear(this.cand, true);
    }
    if (this.active && resting && this.cand && this.cand !== this.focus && !this.surfLock && this.navigated && this.t - this.candAt > 0.45 && !(this.focus && this.isPlaying(this.focus.v))) this.setFocus(this.cand);

    for (const p of proj) {
      const on = p.b === this.focus;
      const rel = (p.depth - fdepth) / fdepth;
      const blurDof = rel > 0 ? rel * 0.5 : -rel * 0.9;
      const fog = 1 - clamp(rel * 0.38, 0, 0.6);
      const nearFade = clamp((p.depth - 110) / 190);
      // balls behind the bottom card / narration and the top bar fade out (the HUD stays readable)
      const hud = clamp((this.bottom + 70 - p.y) / 120) * clamp((p.y - this.top + 70) / 90);
      const alpha = A * fog * nearFade * (0.25 + 0.75 * hud) * (this.focus && !on ? 0.94 : 1);
      if (p.r < 9) { dots.push({ x: p.x, y: p.y, r: p.r, blur: 0.8, alpha: alpha * 0.8, c0: p.b.v.spec.colors[0], c1: p.b.v.spec.colors[1], c2: p.b.v.spec.colors[3], seed: p.b.ph }); continue; }
      const amp = on ? this.amp(p.b.v) : 0;
      rich.push({ id: 'm' + p.b.i, x: p.x, y: p.y, r: p.r, spec: p.b.v.spec, amp, alpha, blur: clamp(blurDof, 0, 0.7) * (red ? 0.6 : 1), z: 5 + (10000 - p.depth) / 1000 });
      if (on) {
        dots.push({ x: p.x, y: p.y, r: p.r * 1.13, mode: 1, alpha: 0.5 * A, c0: [1, 1, 1], c1: p.b.v.spec.colors[3], c2: [1, 1, 1] });
        if (amp > 0.04) dots.push({ x: p.x, y: p.y, r: p.r * 1.55, blur: 1.4, alpha: amp * 0.32 * A, c0: p.b.v.spec.colors[1], c1: p.b.v.spec.colors[2], c2: p.b.v.spec.colors[3] });
        if (this.loadingId === p.b.v.id) dots.push({ x: p.x, y: p.y, r: p.r * (1.2 + 0.06 * Math.sin(this.t * 8)), mode: 1, alpha: 0.35 * A, c0: p.b.v.spec.colors[2], c1: p.b.v.spec.colors[3], c2: [1, 1, 1] });
      } else if (p.b === this.cand && !this.focus) dots.push({ x: p.x, y: p.y, r: p.r * 1.1, mode: 1, alpha: 0.28 * A, c0: [1, 1, 1], c1: [1, 1, 1], c2: [1, 1, 1] });
    }
    // dust at many depths (wraps around the camera): parallax you can feel while panning / zooming
    for (const d of this.dust) {
      const box = 4000;
      const wx = c.x + ((((d.x - c.x) % box) + box * 1.5) % box) - box / 2, wy = c.y + ((((d.y - c.y) % box) + box * 1.5) % box) - box / 2;
      const depth = c.D + d.z;
      if (depth < 60) continue;
      const s = F / depth, x = this.cx + (wx - c.x) * U * s, y = this.cy + (wy - c.y) * U * s;
      if (x < -10 || x > this.W + 10 || y < -10 || y > this.H + 10) continue;
      const near = depth < c.D * 0.8;
      (near ? dots : bdots).push({ x, y, r: Math.max(0.7, d.r * s * 1.6), blur: near ? 1.2 : 0.6, alpha: A * clamp(0.5 - (depth - c.D) / 9000, 0.08, 0.45), c0: d.c, c1: d.c, c2: [1, 1, 1] });
    }

    // cluster labels above each cluster (on the z=0 plane), fade with zoom
    const s0 = (U * F) / c.D;
    for (const cl of this.clusters) {
      const x = this.cx + (cl.x - c.x) * s0, y = this.cy + (cl.y - cl.r * 0.9 - c.y) * s0;
      const vis = A * clamp((c.D - 700) / 600) * (x > -60 && x < this.W + 60 && y > this.top - 10 && y < this.bottom ? 1 : 0);
      cl.el.style.opacity = vis.toFixed(2);
      if (vis > 0) cl.el.style.transform = `translate3d(${x.toFixed(1)}px,${Math.max(this.top + 4, y).toFixed(1)}px,0) translate(-50%,-50%)`;
    }
    // focused label
    const fp = this.focus ? proj.find((p) => p.b === this.focus) : null;
    const lon = !!fp && A > 0.5 && fp.r > 12;
    this.label.classList.toggle('on', lon);
    if (fp && lon) {
      (this.label.firstChild as HTMLElement).textContent = fp.b.v.name;
      (this.label.lastChild as HTMLElement).textContent = [fp.b.v.attrs.lang, fp.b.v.attrs.gender].filter((x) => x && x !== 'Other').join(' · ');
      this.label.style.transform = `translate3d(${fp.x.toFixed(1)}px,${Math.max(this.top + 22, fp.y - fp.r - 10).toFixed(1)}px,0) translate(-50%,-100%)`;
    }
    if ((this.fps.n & 1) === 0) this.drawMini();
    // keep the card's play icon in sync with the player
    if (this.focus) { const on = this.isPlaying(this.focus.v); if ((this.cPlay.dataset.ic === 'stop') !== on) this.paintCard(); }
  }

  /* ---------- test hook ---------- */
  state() {
    const ids = this.voices.map((v) => v.id), urls = this.voices.map((v) => v.previewUrl || v.clip || '');
    return {
      source: this.source, note: this.note, n: ids.length, ids, uniqueIds: new Set(ids).size === ids.length, uniquePreviews: new Set(urls).size === urls.length,
      group: this.group, clusters: this.clusters.map((c) => ({ label: c.label, n: c.n })),
      cam: { x: +this.cam.x.toFixed(1), y: +this.cam.y.toFixed(1), D: +this.cam.D.toFixed(1), fz: +this.cam.fz.toFixed(1), flying: !!this.fly, inertia: +Math.hypot(this.free.vx, this.free.vy).toFixed(1) },
      amp: this.focus ? +this.amp(this.focus.v).toFixed(3) : 0, focus: this.focus?.v.name || null, focusId: this.focus?.v.id || null, cand: this.cand?.v.name || null, playing: this.playing, speaker: player.speaker, navigated: this.navigated, surfing: this.surfLock,
      active: this.active, alpha: +this.alpha.toFixed(2), log: this.log.slice(),
      fps: { now: this.fps.v, samples: this.fps.samples.slice(), worstFrameMs: Math.round(this.fps.worst * 1000) },
      balls: this.lastProj.map((p) => ({ id: p.b.v.id, name: p.b.v.name, x: Math.round(p.x), y: Math.round(p.y), r: +p.r.toFixed(1), depth: Math.round(p.depth) })),
      center: { x: this.cx, y: this.cy },
    };
  }
  dispose(): void { this.stopVoice(); for (const p of this.blobs.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {}); this.blobs.clear(); }
}

/** small DOM orb for the HUD collection row */
export function collOrb(spec: OrbSpec | null): HTMLElement {
  if (!spec) return h('span', { class: 'tu-mslot' });
  const o: OrbEl = orbEl(spec, { size: 26 });
  return h('span', { class: 'tu-mslot full' }, o);
}
