/* Shared transitions: ONE vocabulary for every change of screen / visual style.
   - enter / leave: cross-dissolve with a small slide / scale (Web Animations; 200-350 ms; transform + opacity only, so
     no layout shift). Under prefers-reduced-motion only a short fade.
   - swap: run a DOM change inside a View Transition when the browser has it (cross-dissolve of the whole page), else
     leave + enter on the given element.
   - orb match-cut: a page hands a live orb element over (handOff), the next page receives it (receiveOrb) and the orb
     flies / shrinks onto its own orb (uniform scale only: it stays perfectly round), then the real one takes over. */
import { orb, type OrbSpec } from './orb';
export const EASE = 'cubic-bezier(.2,.7,.2,1)';
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export interface MoveOpts { dx?: number; dy?: number; scale?: number; ms?: number; delay?: number }

/** Fade + slide / scale in. */
export function enter(el: HTMLElement, o: MoveOpts = {}): Animation | null {
  if (!el.animate) return null;
  const red = reducedMotion();
  const from: Keyframe = red ? { opacity: 0 } : { opacity: 0, transform: `translate3d(${o.dx ?? 0}px,${o.dy ?? 8}px,0) scale(${o.scale ?? 1})` };
  const to: Keyframe = red ? { opacity: 1 } : { opacity: 1, transform: 'none' };
  return el.animate([from, to], { duration: red ? 120 : o.ms ?? 260, delay: o.delay ?? 0, easing: EASE, fill: 'backwards' });
}
/** Fade + slide / scale out; resolves when done (immediately without animation support). */
export function leave(el: HTMLElement, o: MoveOpts = {}): Promise<void> {
  if (!el.animate || !el.isConnected) return Promise.resolve();
  const red = reducedMotion();
  const to: Keyframe = red ? { opacity: 0 } : { opacity: 0, transform: `translate3d(${o.dx ?? 0}px,${o.dy ?? -6}px,0) scale(${o.scale ?? 1})` };
  const a = el.animate([{ opacity: 1, transform: 'none' }, to], { duration: red ? 100 : o.ms ?? 160, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' });
  return a.finished.then(() => undefined, () => undefined);
}
/** A DOM change as a cross-dissolve: View Transitions when available, else leave / enter on `el`. */
export async function swap(el: HTMLElement | null, change: () => void | Promise<void>, o: MoveOpts = {}): Promise<void> {
  const d = document as Document & { startViewTransition?: (cb: () => unknown) => { finished: Promise<void> } };
  if (d.startViewTransition && !reducedMotion() && document.visibilityState === 'visible') {
    try { const vt = d.startViewTransition(change); await vt.finished.catch(() => {}); return; } catch { /* fall through */ }
  }
  if (el) await leave(el, o);
  await change();
  if (el?.isConnected) { el.getAnimations?.().forEach((a) => a.cancel()); enter(el, o); }
}

/* ---------------- orb match-cut ---------------- */
type LiveOrb = HTMLElement & { _spec?: OrbSpec; _live?: { time: number } | null };
/* expiry is left to the timer in handOff (no clock comparisons: some environments report odd performance.now() jumps) */
/* Hand-offs are kept per key: '' = the one main orb (Chat, forge, ...); other keys let several orbs fly at once
   (e.g. the group call: 'duo:strix', 'duo:lena'). */
const handedBy = new Map<string, { el: LiveOrb }>();
const flights = new Map<string, { fly: LiveOrb; target: HTMLElement; done: () => void; p: Promise<void> }>();
const timeOf = (el: LiveOrb | null | undefined) => (el?._live ? el._live.time : el?._spec?.t0 ?? null);
/** Hand a (fixed-position, page-level) orb element over to whatever opens next. If nobody takes it, it fades away. */
export function handOff(el: HTMLElement, ttl = 1500, key = ''): void {
  const old = handedBy.get(key);
  if (old && old.el !== el) old.el.remove();
  handedBy.set(key, { el: el as LiveOrb });
  setTimeout(() => { if (handedBy.get(key)?.el === el) { handedBy.delete(key); void leave(el, { scale: 0.9, dy: 0, ms: 220 }).then(() => el.remove()); } }, ttl);
}
/** Is an orb waiting to be received under `key`? */
export const hasHandOff = (key = '') => !!handedBy.get(key)?.el.isConnected;
/** For receivers that draw the orb themselves (the persona forge): take the handed orb (rect + animation time) and
    remove it. null when there is none. */
export function takeHandOff(key = ''): { rect: DOMRect; time: number | null; spec: OrbSpec | null } | null {
  const h = handedBy.get(key) ?? null; handedBy.delete(key);
  if (!h || !h.el.isConnected) { h?.el.remove(); return null; }
  const out = { rect: h.el.getBoundingClientRect(), time: timeOf(h.el), spec: h.el._spec || null };
  h.el.remove();
  return out;
}
/** A page-level live copy of an orb element at its current place / size, same spec and same animation time. */
export function orbGhost(src: HTMLElement | null | undefined): HTMLElement | null {
  const s = src as LiveOrb | null | undefined;
  if (!s?._spec || !s.isConnected) return null;
  const r = s.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  const g = orb(s._spec, { size: Math.round(r.width), cls: 'orb-ghost', live: !reducedMotion() }) as LiveOrb;
  const t = timeOf(s);
  if (g._live && t != null) g._live.time = t;
  g.style.left = r.left.toFixed(1) + 'px'; g.style.top = r.top.toFixed(1) + 'px';
  document.body.append(g);
  return g;
}
/** Fly the handed-over orb onto `target` (followed every frame, e.g. while its sheet slides in), then reveal `target`;
    the target takes over the animation time (no jump in the pattern). A new flight ends the previous one at once
    (fast clicks never leave a ghost behind). Resolves at once (target visible) when there is nothing to receive. */
export function receiveOrb(target: HTMLElement, ms = 460, key = ''): Promise<void> {
  const h = handedBy.get(key) ?? null;
  handedBy.delete(key);
  const flight = flights.get(key) ?? null;
  if (!h || !h.el.isConnected) {
    h?.el.remove();
    // nothing new to receive, but an orb is already flying onto this target: wait for that one
    if (flight && flight.target === target) return flight.p;
    return Promise.resolve();
  }
  flight?.done();
  const fly = h.el;
  const r0 = fly.getBoundingClientRect();
  target.style.visibility = 'hidden';
  const red = reducedMotion();
  const t0 = performance.now(), dur = red ? 1 : ms;
  let resolveP: () => void = () => {};
  const p = new Promise<void>((r) => { resolveP = r; });
  {
    const res = resolveP;
    let over = false;
    const done = () => {
      if (over) return; over = true;
      const t = timeOf(fly), tg = target as LiveOrb;
      if (t != null && tg._live) tg._live.time = t;
      target.style.visibility = '';
      fly.remove();
      if (flights.get(key)?.fly === fly) flights.delete(key);
      res();
    };
    flights.set(key, { fly, target, done, p });
    const step = (now: number) => {
      if (over) return;
      const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      if (!target.isConnected) { done(); return; }
      const r1 = target.getBoundingClientRect();
      if (r1.width < 2) { done(); return; }
      const cx0 = r0.left + r0.width / 2, cy0 = r0.top + r0.height / 2, cx1 = r1.left + r1.width / 2, cy1 = r1.top + r1.height / 2;
      const s = (r0.width + (r1.width - r0.width) * e) / r0.width;   // one scale for both axes: always round
      const arc = Math.sin(Math.PI * e) * -Math.min(24, Math.hypot(cx1 - cx0, cy1 - cy0) * 0.12);
      fly.style.transform = `translate3d(${(cx0 + (cx1 - cx0) * e - cx0).toFixed(2)}px,${(cy0 + (cy1 - cy0) * e - cy0 + arc).toFixed(2)}px,0) scale(${s.toFixed(4)})`;
      if (k < 1) { requestAnimationFrame(step); return; }
      requestAnimationFrame(done);
    };
    requestAnimationFrame(step);
  }
  return p;
}
/** Shared element: a copy of `from` flies onto `to` (both stay where they are; `to` is hidden until it lands). */
export function flyOrb(from: HTMLElement | null | undefined, to: HTMLElement | null | undefined, ms = 460, key = ''): Promise<void> {
  if (!to) return Promise.resolve();
  const g = orbGhost(from);
  if (!g) return Promise.resolve();
  handOff(g, 1500, key);
  return receiveOrb(to, ms, key);
}
/** Cross-morph: the orb element changes its look under a fading copy of the old look (no hard cut). */
export function morphOrb(el: HTMLElement, apply: () => void, ms = 380): void {
  const g = el.isConnected && el.style.visibility !== 'hidden' && !reducedMotion() ? orbGhost(el) : null;
  apply();
  if (!g) return;
  g.style.zIndex = '15';
  void leave(g, { dy: 0, scale: 1, ms }).then(() => g.remove());
}
