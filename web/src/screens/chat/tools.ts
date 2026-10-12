/* Chat tool calls, shown openly (never silently): a chip near the orb while a tool runs ("Mencari di web: <query>"),
   then a small "Dicari di web · N sumber" chip that opens the source links. Generic by `tool.name`: a new tool only needs
   an entry in TOOLS (label / icon); unknown tools get a neutral label. */
import { h } from '../../ui/dom';
import { svg } from '../../icons';
import { popover } from '../../ui/overlay';
import type { ToolEvent, ToolSource } from '../../lib/persona';

interface ToolMeta { icon: string; running: (q?: string) => string; done: string; failed: string; quota: string }
export const TOOLS: Record<string, ToolMeta> = {
  web_search: {
    icon: 'search',
    running: (q) => (q ? `Mencari di web: ${q}` : 'Mencari di web'),
    done: 'Dicari di web',
    failed: 'Pencarian web gagal',
    quota: 'Kuota pencarian web habis',
  },
};
export function toolMeta(name: string): ToolMeta {
  return TOOLS[name] || {
    icon: 'bolt',
    running: () => `Memakai alat: ${name.replace(/_/g, ' ')}`,
    done: `Alat dipakai: ${name.replace(/_/g, ' ')}`,
    failed: `Alat gagal: ${name.replace(/_/g, ' ')}`,
    quota: 'Kuota alat habis',
  };
}
export const isQuota = (t: ToolEvent) => t.code === 'quota' || /quota|kuota/i.test(t.error || '');

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** List of source links (opened in a new tab, no opener). */
export function sourceList(sources: ToolSource[]): HTMLElement {
  return h('ul', { class: 'tl-src' }, ...sources.map((s) => h('li', null,
    h('a', { class: 'src-link', href: s.url, target: '_blank', rel: 'noopener noreferrer', html: svg('external') },
      h('span', null, s.title || host(s.url) || s.url), h('small', null, host(s.url))))));
}

/** The chip for one tool event (state from `t.status`). */
export function toolChip(t: ToolEvent): HTMLElement {
  const m = toolMeta(t.name);
  if (t.status === 'start') {
    const label = m.running(t.query);
    return h('div', { class: 'tl-chip run', role: 'status', title: label, dataset: { tool: t.name } },
      h('span', { class: 'tl-ic', html: svg(m.icon) }), h('span', { class: 'tl-t' }, label), h('span', { class: 'tl-sheen', 'aria-hidden': 'true' }));
  }
  if (t.status === 'error') {
    return h('div', { class: 'tl-chip bad', role: 'status', title: t.error || '', dataset: { tool: t.name } },
      h('span', { class: 'tl-ic', html: svg('alert') }), h('span', { class: 'tl-t' }, isQuota(t) ? m.quota : m.failed));
  }
  const n = t.sources?.length || 0;
  const b = h('button', { type: 'button', class: 'tl-chip done', 'aria-haspopup': n ? 'dialog' : null, dataset: { tool: t.name }, title: t.query ? `${m.done}: ${t.query}` : m.done },
    h('span', { class: 'tl-ic', html: svg(m.icon) }), h('span', { class: 'tl-t' }, m.done), n ? h('span', { class: 'tl-n' }, `${n} sumber`) : null);
  if (n) {
    b.onclick = () => popover(b, h('div', { class: 'tl-pop' },
      h('div', { class: 'tl-pop-h' }, h('b', null, m.done), t.query ? h('span', null, t.query) : null),
      sourceList(t.sources!)), { align: 'start', placement: 'above' });
  } else b.disabled = true;
  return b;
}

/** Transcript line for a tool event. */
export function toolLine(t: ToolEvent): HTMLElement {
  const m = toolMeta(t.name);
  // done: the header row of the message already says "Dicari di web" -> show the query and the sources
  const head = t.status === 'error' ? (isQuota(t) ? m.quota : m.failed) : t.status === 'start' ? m.running() : '';
  const n = t.sources?.length || 0;
  return h('div', { class: 'tr-tool' + (t.status === 'error' ? ' bad' : '') },
    h('div', { class: 'tr-tool-h', html: svg(t.status === 'error' ? 'alert' : m.icon) }, head ? h('span', null, head) : null, t.query ? h('q', null, t.query) : null,
      t.status === 'done' ? h('small', null, n ? `${n} sumber` : 'tanpa sumber') : null),
    n ? sourceList(t.sources!.slice(0, 5)) : null);
}
