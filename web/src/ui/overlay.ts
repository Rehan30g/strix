/* Toasts, dialogs, drawers, popover menus.
   Rules (spam-safe): ONE instance per key (modal: its cls or title; drawer: title; popover: its anchor; toast: its text).
   Opening a modal / drawer that is already open returns without stacking a second one (the duplicate's onClose runs at
   once so promises still settle); one closing with its exit animation is removed at once when the same one reopens.
   A popover toggles: clicking its anchor again closes it; opening one closes any other. Every close removes its
   listeners and DOM. */
import { h } from './dom';
import { svg } from '../icons';
import { drag, rubber, settle, haptic } from './gesture';

/* ---------- toast ---------- */
let toastBox: HTMLElement | null = null;
export type ToastKind = 'info' | 'ok' | 'warn' | 'bad';
export function toast(message: string, opts: { kind?: ToastKind; title?: string; timeout?: number } = {}): () => void {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'region', 'aria-live': 'polite', 'aria-label': 'Notifikasi' }); document.body.append(toastBox); }
  const kind = opts.kind || 'info';
  const iconName = { info: 'info', ok: 'checkCircle', warn: 'alert', bad: 'xCircle' }[kind];
  const x = h('button', { class: 't-x', 'aria-label': 'Tutup', html: svg('x') });
  const t = h('div', { class: 'toast ' + kind, role: kind === 'bad' ? 'alert' : 'status', html: svg(iconName) },
    h('div', { class: 't-body' }, opts.title ? h('div', { class: 't-title' }, opts.title) : null, h('div', null, message)), x);
  // the same message again while it is still showing: keep the one there (restart its timer) instead of stacking
  const same = [...toastBox.children].find((c) => !(c as HTMLElement).classList.contains('out') && (c as HTMLElement).dataset.msg === kind + '|' + message) as (HTMLElement & { _close?: () => void; _arm?: (ms: number) => void }) | undefined;
  const ms = opts.timeout ?? (kind === 'bad' ? 7000 : 4000);
  if (same?._close) { same._arm?.(ms); return same._close; }
  t.dataset.msg = kind + '|' + message;
  let gone = false, timer: ReturnType<typeof setTimeout> | null = null;
  const close = () => { if (gone) return; gone = true; if (timer) clearTimeout(timer); t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  const arm = (m: number) => { if (timer) clearTimeout(timer); timer = m > 0 ? setTimeout(close, m) : null; };
  Object.assign(t, { _close: close, _arm: arm });
  x.onclick = close;
  toastBox.append(t);
  while (toastBox.children.length > 4) toastBox.firstElementChild?.remove();
  arm(ms);
  return close;
}

/* ---------- focus trap helper ---------- */
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
function trap(container: HTMLElement, onEsc: () => void): () => void {
  const prev = document.activeElement as HTMLElement | null;
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); onEsc(); return; }
    if (e.key !== 'Tab') return;
    const f = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  container.addEventListener('keydown', key);
  return () => { container.removeEventListener('keydown', key); prev?.focus?.(); };
}

/* ---------- modal dialog ---------- */
export interface ModalHandle { close: () => void; root: HTMLElement; body: HTMLElement; footer: HTMLElement }
const openModals = new Map<string, { scrim: HTMLElement; closing: boolean; handle: ModalHandle }>();
export function modal(opts: { title: string; body?: Node | string; wide?: boolean; cls?: string; onClose?: () => void; actions?: HTMLElement[]; key?: string }): ModalHandle {
  const key = opts.key || opts.cls || 'title:' + opts.title;
  const prevM = openModals.get(key);
  if (prevM && !prevM.closing && prevM.scrim.isConnected) {
    // already open (e.g. a double / spam click on its opener): do not stack a second one
    queueMicrotask(() => opts.onClose?.());
    return { close: () => {}, root: h('div'), body: h('div'), footer: h('div') };
  }
  if (prevM) { prevM.scrim.remove(); openModals.delete(key); }
  const body = h('div', { class: 'dlg-b' });
  if (typeof opts.body === 'string') body.textContent = opts.body; else if (opts.body) body.append(opts.body);
  const footer = h('div', { class: 'dlg-f', hidden: !opts.actions?.length }, ...(opts.actions || []));
  const titleId = 'dlg-' + Math.random().toString(36).slice(2, 8);
  const xb = h('button', { class: 'btn ghost icon sm', 'aria-label': 'Tutup', html: svg('x') });
  const grab = h('div', { class: 'dlg-grab', 'aria-hidden': 'true' }, h('i'));
  const head = h('div', { class: 'dlg-h' }, h('h2', { id: titleId }, opts.title), xb);
  const dlg = h('div', { class: 'dlg' + (opts.wide ? ' wide' : '') + (opts.cls ? ' ' + opts.cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    },
    grab, head, body, footer);
  const scrim = h('div', { class: 'dlg-scrim' }, dlg);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true; release(); removeEventListener('hashchange', close);
    const rec = openModals.get(key); if (rec?.scrim === scrim) rec.closing = true;
    scrim.classList.add('out');
    setTimeout(() => { scrim.remove(); if (openModals.get(key)?.scrim === scrim) openModals.delete(key); }, 160);
    opts.onClose?.();
  };
  xb.onclick = close;
  /* bottom sheet (phones): drag the handle / header down to close, rubber-band upwards */
  const sheet = () => matchMedia('(max-width: 640px)').matches;
  for (const zone of [grab, head]) {
    drag(zone, {
      axis: 'y', mouse: true, slop: 6,
      accept: (e) => sheet() && !(e.target as Element).closest('button'),
      onStart: () => { dlg.style.transition = ''; dlg.style.animation = 'none'; },
      onMove: (s) => {
        const y = s.dy >= 0 ? s.dy : -rubber(-s.dy, 40);
        dlg.style.transform = `translate3d(0,${y}px,0)`;
        scrim.style.backgroundColor = s.dy > 0 ? `color-mix(in srgb, var(--scrim) ${Math.round(100 - Math.min(100, (s.dy / dlg.offsetHeight) * 100))}%, transparent)` : '';
      },
      onEnd: async (s, cancelled) => {
        const hgt = dlg.offsetHeight;
        if (!cancelled && s.dy > 0 && (s.dy > hgt * 0.28 || (s.vy > 0.55 && s.dy > 24))) {
          haptic();
          await settle(dlg, `translate3d(0,${hgt + 20}px,0)`, 180);
          close();
        } else { scrim.style.backgroundColor = ''; await settle(dlg, 'translate3d(0,0,0)', 240); dlg.style.transform = ''; }
      },
    });
  }
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  addEventListener('hashchange', close);
  const release = trap(dlg, close);
  // touch devices: do not pop the keyboard up by focusing a text field
  const touch = matchMedia('(pointer: coarse)').matches;
  dlg.tabIndex = -1;
  requestAnimationFrame(() => (touch ? dlg : (dlg.querySelector<HTMLElement>('[autofocus]') || dlg.querySelector<HTMLElement>('.dlg-b input:not([type=checkbox]):not([type=range]),.dlg-b textarea') || footer.querySelector<HTMLElement>('.primary,.danger') || xb)).focus({ preventScroll: true }));
  const handle = { close, root: dlg, body, footer };
  openModals.set(key, { scrim, closing: false, handle });
  return handle;
}

export function confirmDialog(opts: { title: string; message: string; confirm?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const ok = h('button', { class: 'btn ' + (opts.danger ? 'danger' : 'primary'), type: 'button' }, opts.confirm || 'OK');
    const no = h('button', { class: 'btn', type: 'button' }, opts.cancel || 'Batal');
    const m = modal({ title: opts.title, body: opts.message, actions: [no, ok], onClose: () => resolve(result) });
    ok.onclick = () => { result = true; m.close(); };
    no.onclick = () => m.close();
  });
}

/* ---------- drawer ---------- */
const openDrawers = new Map<string, { close: () => void; root: HTMLElement }>();
export function drawer(opts: { title: string; body: Node; onClose?: () => void; width?: number }): { close: () => void; root: HTMLElement } {
  const was = openDrawers.get(opts.title);
  if (was && was.root.isConnected) { queueMicrotask(() => opts.onClose?.()); return { close: () => {}, root: h('div') }; }
  const xb = h('button', { class: 'btn ghost icon', 'aria-label': 'Tutup', html: svg('x') });
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title, style: opts.width ? `width:min(${opts.width}px,100%)` : '' },
    h('div', { class: 'drawer-h' }, h('h2', null, opts.title), xb), h('div', { class: 'drawer-b' }, opts.body));
  const scrim = h('div', { class: 'drawer-scrim' });
  let closed = false;
  const close = () => { if (closed) return; closed = true; release(); panel.remove(); scrim.remove(); openDrawers.delete(opts.title); opts.onClose?.(); };
  xb.onclick = close; scrim.onclick = close;
  openDrawers.set(opts.title, { close, root: panel });
  document.body.append(scrim, panel);
  const release = trap(panel, close);
  requestAnimationFrame(() => xb.focus());
  return { close, root: panel };
}

/* ---------- popover menu anchored to a button ---------- */
let openPop: { anchor: HTMLElement; close: () => void; at: number } | null = null;
export function popover(anchor: HTMLElement, content: HTMLElement, opts: { align?: 'start' | 'end'; placement?: 'below' | 'above' | 'right' } = {}): () => void {
  // toggle: the same anchor again closes it (a fast double click within 250 ms of opening is ignored, not a toggle)
  if (openPop) {
    const p = openPop;
    if (p.anchor === anchor) { if (performance.now() - p.at > 250) p.close(); return p.close; }
    p.close();
  }
  const menu = h('div', { class: 'menu', role: 'menu' }, content);
  document.body.append(menu);
  const place = () => {
    const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight;
    let top: number, left: number;
    if (opts.placement === 'right') { left = r.right + 8; top = Math.min(r.top, vh - m.height - 8); }
    else if (opts.placement === 'above' || (r.bottom + m.height + 8 > vh && r.top - m.height - 8 > 0)) { top = r.top - m.height - 8; left = opts.align === 'start' ? r.left : r.right - m.width; }
    else { top = r.bottom + 8; left = opts.align === 'start' ? r.left : r.right - m.width; }
    left = Math.max(8, Math.min(left, vw - m.width - 8)); top = Math.max(8, top);
    menu.style.top = top + scrollY + 'px'; menu.style.left = left + scrollX + 'px';
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    menu.remove(); anchor.setAttribute('aria-expanded', 'false');
    if (openPop?.close === close) openPop = null;
    clearTimeout(armT);
    document.removeEventListener('mousedown', outside, true); removeEventListener('resize', onResize); removeEventListener('hashchange', close); document.removeEventListener('keydown', esc, true);
  };
  const outside = (e: Event) => { if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  const armT = setTimeout(() => { if (closed) return; document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); addEventListener('resize', onResize); addEventListener('hashchange', close); });
  // phones fire resize when the URL bar moves: only a real width change closes the menu
  const w0 = innerWidth;
  const onResize = () => { if (innerWidth !== w0) close(); else place(); };
  menu.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('.menu-item')) close(); });
  if (!matchMedia('(pointer: coarse)').matches) requestAnimationFrame(() => { if (!closed) menu.querySelector<HTMLElement>('.menu-item')?.focus({ preventScroll: true }); });
  openPop = { anchor, close, at: performance.now() };
  return close;
}

export function menuItem(label: string, icon: string, onClick: () => void, cls = ''): HTMLElement {
  const b = h('button', { class: 'menu-item ' + cls, role: 'menuitem', type: 'button', html: svg(icon) }, label);
  b.onclick = onClick;
  return b;
}
