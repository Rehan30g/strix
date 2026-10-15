/* "Pesan": the thread with the person who invited you (quota appeals), as a normal page. */
import type { ScreenCtx } from '../../ctx';
import { testerThread } from '../../ui/appeal';
import { h } from '../../ui/dom';
import { refreshMessages } from '../../lib/inbox';

export function mount(root: HTMLElement, ctx: ScreenCtx) {
  const kind = ctx.route.params.get('kind') || '';
  ctx.shell.setBack(() => ctx.navigate('/chat'));
  const t = testerThread(kind, () => { void refreshMessages(); });
  root.append(h('div', { class: 'page' }, h('div', { class: 'page-inner ap-page' },
    h('div', { class: 'ap-head' }, h('h2', null, 'Pesan'), h('p', { class: 'hint' }, 'Percakapan dengan pengundangmu soal tambahan kuota.')),
    t.el)));
  return () => t.destroy();
}
