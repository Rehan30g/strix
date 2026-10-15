/* Chat tool calls, shown openly (never silently): a chip near the orb while a tool runs ("Mencari di web: <query>"),
   then a small "Dicari di web · N sumber" chip that opens the source links. Generic by `tool.name`: a new tool only needs
   an entry in TOOLS (label / icon); unknown tools get a neutral label. */
import { h } from '../../ui/dom';
import { t } from '../../i18n';
import { svg } from '../../icons';
import { popover } from '../../ui/overlay';
import type { ToolEvent, ToolSource } from '../../lib/persona';

interface ToolMeta { icon: string; running: (q?: string) => string; done: string; failed: string; quota: string }
export const TOOLS: Record<string, ToolMeta> = {
  web_search: {
    icon: 'search',
    running: (q) => (q ? t('Mencari di web: {q}', { q }) : t('Mencari di web')),
    done: t('Dicari di web'),
    failed: t('Pencarian web gagal'),
    quota: t('Kuota pencarian web habis'),
  },
};
export function toolMeta(name: string): ToolMeta {
  return TOOLS[name] || {
    icon: 'bolt',
    running: () => t('Memakai alat: {name}', { name: name.replace(/_/g, ' ') }),
    done: t('Alat dipakai: {name}', { name: name.replace(/_/g, ' ') }),
    failed: t('Alat gagal: {name}', { name: name.replace(/_/g, ' ') }),
    quota: t('Kuota alat habis'),
  };
}
export const isQuota = (ev: ToolEvent) => ev.code === 'quota' || /quota|kuota/i.test(ev.error || '');
const nSources = (n: number) => (n === 1 ? t('1 sumber') : t('{n} sumber', { n }));

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** List of source links (opened in a new tab, no opener). */
export function sourceList(sources: ToolSource[]): HTMLElement {
  return h('ul', { class: 'tl-src' }, ...sources.map((s) => h('li', null,
    h('a', { class: 'src-link', href: s.url, target: '_blank', rel: 'noopener noreferrer', html: svg('external') },
      h('span', null, s.title || host(s.url) || s.url), h('small', null, host(s.url))))));
}

/** The chip for one tool event (state from `t.status`). */
export function toolChip(ev: ToolEvent): HTMLElement {
  const m = toolMeta(ev.name);
  if (ev.status === 'start') {
    const label = m.running(ev.query);
    return h('div', { class: 'tl-chip run', role: 'status', title: label, dataset: { tool: ev.name } },
      h('span', { class: 'tl-ic', html: svg(m.icon) }), h('span', { class: 'tl-t' }, label), h('span', { class: 'tl-sheen', 'aria-hidden': 'true' }));
  }
  if (ev.status === 'error') {
    return h('div', { class: 'tl-chip bad', role: 'status', title: ev.error || '', dataset: { tool: ev.name } },
      h('span', { class: 'tl-ic', html: svg('alert') }), h('span', { class: 'tl-t' }, isQuota(ev) ? m.quota : m.failed));
  }
  const n = ev.sources?.length || 0;
  const b = h('button', { type: 'button', class: 'tl-chip done', 'aria-haspopup': n ? 'dialog' : null, dataset: { tool: ev.name }, title: ev.query ? `${m.done}: ${ev.query}` : m.done },
    h('span', { class: 'tl-ic', html: svg(m.icon) }), h('span', { class: 'tl-t' }, m.done), n ? h('span', { class: 'tl-n' }, nSources(n)) : null);
  if (n) {
    b.onclick = () => popover(b, h('div', { class: 'tl-pop' },
      h('div', { class: 'tl-pop-h' }, h('b', null, m.done), ev.query ? h('span', null, ev.query) : null),
      sourceList(ev.sources!)), { align: 'start', placement: 'above' });
  } else b.disabled = true;
  return b;
}

/** Transcript line for a tool event. */
export function toolLine(ev: ToolEvent): HTMLElement {
  const m = toolMeta(ev.name);
  // done: the header row of the message already says "Dicari di web" -> show the query and the sources
  const head = ev.status === 'error' ? (isQuota(ev) ? m.quota : m.failed) : ev.status === 'start' ? m.running() : '';
  const n = ev.sources?.length || 0;
  return h('div', { class: 'tr-tool' + (ev.status === 'error' ? ' bad' : '') },
    h('div', { class: 'tr-tool-h', html: svg(ev.status === 'error' ? 'alert' : m.icon) }, head ? h('span', null, head) : null, ev.query ? h('q', null, ev.query) : null,
      ev.status === 'done' ? h('small', null, n ? nSources(n) : t('tanpa sumber')) : null),
    n ? sourceList(ev.sources!.slice(0, 5)) : null);
}
