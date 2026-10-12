/* Shared transitions: ONE vocabulary for every change of screen / visual style.
   - enter / leave: cross-dissolve with a small slide / scale (Web Animations; 200-350 ms; transform + opacity only, so
     no layout shift). Under prefers-reduced-motion only a short fade.
   - swap: run a DOM change inside a View Transition when the browser has it (cross-dissolve of the whole page), else
     leave + enter on the given element.
   - orb match-cut: a page hands a live orb element over (handOff), the next page receives it (receiveOrb) and the orb
     flies / shrinks onto its own orb (uniform scale only: it stays perfectly round), then the real one takes over. */
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
let handed: { el: HTMLElement; until: number } | null = null;
/** Hand a (fixed-position, page-level) orb element over to whatever opens next. It is removed if nobody takes it. */
export function handOff(el: HTMLElement, ttl = 1500): void {
  handed?.el.remove();
  handed = { el, until: performance.now() + ttl };
  // nobody took it (e.g. an edit, no "Persona siap"): it fades away
  setTimeout(() => { if (handed?.el === el) { handed = null; void leave(el, { scale: 0.9, dy: 0, ms: 220 }).then(() => el.remove()); } }, ttl);
}
/** Fly the handed-over orb onto `target` (followed every frame, e.g. while its sheet slides in), then reveal `target`.
    Resolves at once (target visible) when there is nothing to receive. */
export function receiveOrb(target: HTMLElement, ms = 520): Promise<void> {
  const h = handed;
  handed = null;
  if (!h || performance.now() > h.until || !h.el.isConnected) { h?.el.remove(); return Promise.resolve(); }
  const fly = h.el;
  const r0 = fly.getBoundingClientRect();
  target.style.visibility = 'hidden';
  const red = reducedMotion();
  const t0 = performance.now(), dur = red ? 1 : ms;
  return new Promise((res) => {
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      const r1 = target.getBoundingClientRect();
      const cx0 = r0.left + r0.width / 2, cy0 = r0.top + r0.height / 2, cx1 = r1.left + r1.width / 2, cy1 = r1.top + r1.height / 2;
      const s = (r0.width + (r1.width - r0.width) * e) / r0.width;   // one scale for both axes: always round
      const arc = Math.sin(Math.PI * e) * -24;
      fly.style.transform = `translate3d(${(cx0 + (cx1 - cx0) * e - cx0).toFixed(2)}px,${(cy0 + (cy1 - cy0) * e - cy0 + arc).toFixed(2)}px,0) scale(${s.toFixed(4)})`;
      if (k < 1) { requestAnimationFrame(step); return; }
      target.style.visibility = '';
      requestAnimationFrame(() => { fly.remove(); res(); });
    };
    requestAnimationFrame(step);
  });
}
