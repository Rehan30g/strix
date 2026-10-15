/* Tiny DOM helpers. All user/AI text goes through textContent (never innerHTML). */
import { svg } from '../icons';
import { t, locale } from '../i18n';

type Child = Node | string | number | null | undefined | false | Child[];
export type Attrs = Record<string, unknown> & {
  class?: string; style?: string | Partial<CSSStyleDeclaration>; html?: string; text?: string;
  dataset?: Record<string, string>; ref?: (el: HTMLElement) => void;
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); }
      else if (k === 'html') el.innerHTML = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v as Record<string, string>);
      else if (k === 'ref') (v as (e: HTMLElement) => void)(el);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (v === true) el.setAttribute(k, '');
      else if (k in el && !k.includes('-') && k !== 'list' && k !== 'form') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Element containing an icon (span by default). */
export function ic(name: string, cls = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.style.display = 'contents';
  s.innerHTML = svg(name, cls);
  return s;
}

/** Button with optional icon + label. */
export function btn(opts: { label?: string; icon?: string; cls?: string; title?: string; onClick?: (e: MouseEvent) => void; type?: 'button' | 'submit'; disabled?: boolean; iconRight?: string }): HTMLButtonElement {
  const b = h('button', { type: opts.type || 'button', class: 'btn ' + (opts.cls || ''), title: opts.title, disabled: opts.disabled });
  if (opts.title && !opts.label) b.setAttribute('aria-label', opts.title);
  if (opts.icon) b.insertAdjacentHTML('beforeend', svg(opts.icon));
  if (opts.label) b.append(h('span', null, opts.label));
  if (opts.iconRight) b.insertAdjacentHTML('beforeend', svg(opts.iconRight));
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

/** Replace a button's content while busy, restore after. */
export async function busy<T>(b: HTMLButtonElement, fn: () => Promise<T>, label?: string): Promise<T> {
  const old = b.innerHTML, w = b.offsetWidth;
  b.disabled = true; b.style.minWidth = w + 'px';
  b.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + (label ? `<span>${escapeHtml(label)}</span>` : '');
  b.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { b.innerHTML = old; b.disabled = false; b.style.minWidth = ''; b.removeAttribute('aria-busy'); }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
export const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];

/** Render text with [audio tags] as styled spans (or hidden). */
export function renderTagged(el: HTMLElement, text: string, opts: { hideTags?: boolean } = {}): void {
  el.textContent = '';
  for (const p of text.split(/(\[[^\]]*\]?)/)) {
    if (!p) continue;
    if (p.startsWith('[')) { if (!opts.hideTags) el.append(h('span', { class: 'tag' }, p)); }
    else el.append(p);
  }
}

export function initials(name: string): string {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Avatar: image with initials fallback (image may be blocked by CSP or fail). */
export function avatar(name: string, picture?: string | null, cls = ''): HTMLElement {
  const a = h('span', { class: 'avatar ' + cls, 'aria-hidden': 'true' }, initials(name));
  if (picture) {
    const img = h('img', { src: picture, alt: '', referrerPolicy: 'no-referrer' });
    img.onload = () => { a.textContent = ''; a.append(img); };
  }
  return a;
}

/** Run fn once `el` has been attached and later removed from the document (auto-cleanup for subscriptions). */
const watchers = new Set<{ el: Element; fn: () => void; seen: boolean }>();
let mo: MutationObserver | null = null;
export function onDisconnect(el: Element, fn: () => void): void {
  watchers.add({ el, fn, seen: el.isConnected });
  if (!mo) {
    mo = new MutationObserver(() => {
      for (const w of watchers) {
        if (w.el.isConnected) w.seen = true;
        else if (w.seen) { watchers.delete(w); try { w.fn(); } catch (e) { console.error(e); } }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
}

export function fmtNum(n: number): string { return new Intl.NumberFormat(locale()).format(n); }
export function fmtDate(v: string | number | Date | null | undefined, withTime = true): string {
  if (v == null || v === '') return '–';
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  if (Number.isNaN(+d)) return String(v);
  return d.toLocaleString(locale(), withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
export function relTime(v: string | number | Date): string {
  const d = new Date(typeof v === 'number' && v < 1e12 ? v * 1000 : v);
  const s = (Date.now() - +d) / 1000;
  if (Number.isNaN(s)) return '';
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const abs = Math.abs(s);
  if (abs < 60) return t('baru saja');
  if (abs < 3600) return rtf.format(-Math.round(s / 60), 'minute');
  if (abs < 86400) return rtf.format(-Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(-Math.round(s / 86400), 'day');
  return fmtDate(d, false);
}
