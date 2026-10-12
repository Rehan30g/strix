/* Touch gestures built on Pointer Events (+ Touch Events for pull-to-refresh, which has to cancel native scrolling).
   Every gesture here has a button / keyboard alternative in the UI. */

const coarse = () => matchMedia('(pointer: coarse)').matches;

/** Light haptic tick (only after a user interaction, where the browser allows it). */
export function haptic(ms = 8): void {
  try {
    const ua = (navigator as any).userActivation;
    if (typeof navigator.vibrate === 'function' && coarse() && (!ua || ua.hasBeenActive)) navigator.vibrate(ms);
  } catch { /* ignore */ }
}

/** Rubber-band: resistance that grows with distance (iOS-like). */
export const rubber = (x: number, lim = 120) => (x <= 0 ? 0 : lim * (1 - 1 / (x / lim * 0.55 + 1)));

const NO_DRAG = 'input,textarea,select,[contenteditable="true"],input[type=range],.mp,.tag-row,.seg,.no-swipe,audio,video';

export interface DragState { dx: number; dy: number; vx: number; vy: number; e: PointerEvent }
export interface DragOpts {
  axis: 'x' | 'y';
  /** Return false to ignore this pointer (checked on pointerdown). */
  accept?: (e: PointerEvent) => boolean;
  /** Also allow mouse (default: touch + pen only). */
  mouse?: boolean;
  slop?: number;
  /** Return false to refuse the drag once the direction is known. */
  onStart?: (s: DragState) => boolean | void;
  onMove: (s: DragState) => void;
  onEnd: (s: DragState, cancelled: boolean) => void;
}

/** Axis-locked drag. Gives up (lets the browser scroll) when the first movement is along the other axis. */
export function drag(el: HTMLElement, o: DragOpts): () => void {
  let id = -1, x0 = 0, y0 = 0, locked = false, dead = false;
  let samples: Array<[number, number, number]> = [];
  const state = (e: PointerEvent): DragState => {
    const now = performance.now();
    samples.push([e.clientX, e.clientY, now]);
    while (samples.length > 2 && now - samples[0][2] > 90) samples.shift();
    const [sx, sy, st] = samples[0], dt = Math.max(1, now - st);
    return { dx: e.clientX - x0, dy: e.clientY - y0, vx: (e.clientX - sx) / dt, vy: (e.clientY - sy) / dt, e };
  };
  const down = (e: PointerEvent) => {
    if (id !== -1 || !e.isPrimary || e.button > 0) return;
    if (e.pointerType === 'mouse' && !o.mouse) return;
    if ((e.target as Element).closest?.(NO_DRAG)) return;
    if (o.accept && !o.accept(e)) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; locked = false; dead = false; samples = [[x0, y0, performance.now()]];
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id || dead) return;
    const s = state(e);
    if (!locked) {
      const ax = Math.abs(s.dx), ay = Math.abs(s.dy), slop = o.slop ?? 10;
      if (Math.max(ax, ay) < slop) return;
      const along = o.axis === 'x' ? ax > ay * 1.3 : ay > ax * 1.3;
      if (!along || o.onStart?.(s) === false) { dead = true; id = -1; return; }
      locked = true;
      try { el.setPointerCapture(id); } catch { /* ignore */ }
    }
    if (e.cancelable) e.preventDefault();
    o.onMove(s);
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    const wasLocked = locked;
    id = -1; locked = false;
    if (!wasLocked) return;
    const s = state(e);
    // swallow the click that follows a drag (rows are links / buttons)
    const swallow = (c: Event) => { c.stopPropagation(); c.preventDefault(); };
    el.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => el.removeEventListener('click', swallow, true), 350);
    o.onEnd(s, e.type === 'pointercancel');
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  return () => {
    el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end);
  };
}

/** Animate a transform and resolve when done. */
export function settle(el: HTMLElement, transform: string, ms = 220): Promise<void> {
  return new Promise((res) => {
    el.style.transition = `transform ${ms}ms cubic-bezier(.2,.7,.2,1)`;
    el.style.transform = transform;
    let done = false;
    const fin = () => { if (done) return; done = true; el.style.transition = ''; res(); };
    el.addEventListener('transitionend', fin, { once: true });
    setTimeout(fin, ms + 60);
  });
}

/* ---------------- swipe row actions ---------------- */
export interface RowAction { label: string; icon: string; cls?: string; run: () => void }
let openRow: { close: () => void } | null = null;
/** Swipe a row left to reveal action buttons (iOS-style). `row` must be inside `host`; returns the host element. */
export function swipeRow(content: HTMLElement, actions: RowAction[], svg: (n: string) => string): HTMLElement {
  const btns = actions.map((a) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sr-act ' + (a.cls || ''); b.tabIndex = -1;
    b.innerHTML = svg(a.icon) + `<span></span>`; b.querySelector('span')!.textContent = a.label;
    b.onclick = (e) => { e.stopPropagation(); close(); a.run(); };
    return b;
  });
  const tray = document.createElement('div'); tray.className = 'sr-tray'; tray.setAttribute('aria-hidden', 'true'); tray.append(...btns);
  const host = document.createElement('div'); host.className = 'sr'; host.dataset.hswipe = '1';
  content.classList.add('sr-c');
  host.append(tray, content);
  const W = () => btns.length * 76;
  let x = 0, base = 0;
  const set = (v: number) => { x = v; content.style.transform = v ? `translate3d(${v}px,0,0)` : ''; host.classList.toggle('sr-open', v < -4); };
  const close = () => { if (openRow === handle) openRow = null; content.style.transition = 'transform .2s cubic-bezier(.2,.7,.2,1)'; set(0); setTimeout(() => (content.style.transition = ''), 220); };
  const handle = { close };
  drag(host, {
    axis: 'x',
    onStart: () => { if (openRow && openRow !== handle) openRow.close(); base = x; content.style.transition = ''; },
    onMove: (s) => {
      let v = base + s.dx;
      const w = W();
      if (v > 0) v = rubber(v, 40); else if (v < -w) v = -w - rubber(-w - v, 60);
      set(v);
    },
    onEnd: (s, cancelled) => {
      const w = W();
      const open = !cancelled && (x < -w * 0.45 || s.vx < -0.45) && s.vx < 0.45;
      content.style.transition = 'transform .22s cubic-bezier(.2,.7,.2,1)';
      set(open ? -w : 0);
      setTimeout(() => (content.style.transition = ''), 240);
      if (open) { openRow = handle; haptic(); }
      else if (openRow === handle) openRow = null;
    },
  });
  return host;
}
document.addEventListener('pointerdown', (e) => {
  if (openRow && !(e.target as Element).closest?.('.sr-open')) openRow.close();
}, true);

/* ---------------- pull to refresh ---------------- */
export function pullToRefresh(scroller: HTMLElement, host: HTMLElement, onRefresh: () => Promise<unknown>, svg: (n: string) => string): () => void {
  const ind = document.createElement('div');
  ind.className = 'ptr'; ind.setAttribute('aria-hidden', 'true'); ind.innerHTML = svg('refresh');
  host.prepend(ind);
  let y0 = -1, pull = 0, busy = false;
  const TH = 70;
  const paint = () => {
    ind.style.transform = `translate(-50%, ${Math.min(pull, 110) - 46}px) rotate(${pull * 3}deg)`;
    ind.style.opacity = String(Math.min(1, pull / TH));
    ind.classList.toggle('arm', pull >= TH);
  };
  const start = (e: TouchEvent) => { if (busy || e.touches.length !== 1 || scroller.scrollTop > 0) { y0 = -1; return; } y0 = e.touches[0].clientY; pull = 0; };
  const move = (e: TouchEvent) => {
    if (y0 < 0 || busy) return;
    const dy = e.touches[0].clientY - y0;
    if (dy <= 0 || scroller.scrollTop > 0) { if (pull) { pull = 0; paint(); } return; }
    if (e.cancelable) e.preventDefault();
    const was = pull >= TH;
    pull = rubber(dy, 160);
    if (!was && pull >= TH) haptic(6);
    ind.style.transition = ''; paint();
  };
  const end = async () => {
    if (y0 < 0) return;
    y0 = -1;
    if (pull >= TH && !busy) {
      busy = true; pull = TH; ind.classList.add('spin'); paint();
      try { await onRefresh(); } finally { busy = false; ind.classList.remove('spin'); }
    }
    pull = 0; ind.style.transition = 'transform .25s, opacity .25s'; paint();
  };
  scroller.addEventListener('touchstart', start, { passive: true });
  scroller.addEventListener('touchmove', move, { passive: false });
  scroller.addEventListener('touchend', end);
  scroller.addEventListener('touchcancel', end);
  return () => {
    scroller.removeEventListener('touchstart', start); scroller.removeEventListener('touchmove', move);
    scroller.removeEventListener('touchend', end); scroller.removeEventListener('touchcancel', end); ind.remove();
  };
}
