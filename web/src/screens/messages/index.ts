/* "Pesan": the thread with the person who invited you (quota appeals), as a full-height chat page: the list scrolls,
   the composer stays at the bottom (above the on-screen keyboard; the tab bar is hidden here like in any chat). */
import type { ScreenCtx } from '../../ctx';
import { testerThread } from '../../ui/appeal';
import { h } from '../../ui/dom';
import { inbox, refreshMessages } from '../../lib/inbox';

export function mount(root: HTMLElement, ctx: ScreenCtx) {
  const kind = ctx.route.params.get('kind') || '';
  ctx.shell.setBack(() => ctx.navigate('/chat'));
  ctx.shell.setTabbar(false);
  root.classList.add('fill');
  // keep the header badge in step (only when it could be stale: unread shown, or the thread was just started)
  const t = testerThread(kind, (r) => { if (inbox.unread || inbox.exists !== r.messages.length > 0) void refreshMessages(); });
  root.append(h('div', { class: 'ap-page' }, t.el));
  return () => t.destroy();
}
