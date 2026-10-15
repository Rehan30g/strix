/* "Pesan": the thread with the person who invited you (quota appeals), as a full-height chat page: the list scrolls,
   the composer stays at the bottom (above the on-screen keyboard; the tab bar is hidden here like in any chat). */
import type { ScreenCtx } from '../../ctx';
import { testerThread } from '../../ui/appeal';
import { h } from '../../ui/dom';
import { svg } from '../../icons';
import { toast } from '../../ui/overlay';
import { t } from '../../i18n';
import { inbox, refreshMessages } from '../../lib/inbox';
import { enablePush, pushState, type PushState } from '../../lib/push';

export function mount(root: HTMLElement, ctx: ScreenCtx) {
  const kind = ctx.route.params.get('kind') || '';
  ctx.shell.setBack(() => ctx.navigate('/chat'));
  ctx.shell.setTabbar(false);
  root.classList.add('fill');
  // keep the header badge in step (only when it could be stale: unread shown, or the thread was just started)
  const th = testerThread(kind, (r) => { if (inbox.unread || inbox.exists !== r.messages.length > 0) void refreshMessages(); });

  /* Offer notifications for the reply (browsers only allow the permission prompt after a tap, so it is a button). */
  const notify = h('div', { class: 'ap-notify', hidden: true });
  const paintNotify = (s: PushState) => {
    notify.hidden = s === 'unsupported' || s === 'on';
    if (notify.hidden) return;
    if (s === 'blocked') { notify.replaceChildren(h('span', { html: svg('info') }), h('p', null, t('Notifikasi diblokir di browser. Aktifkan lewat pengaturan situs untuk dapat kabar saat ada balasan.'))); return; }
    const go = h('button', { type: 'button', class: 'btn sm primary' }, t('Aktifkan notifikasi')) as HTMLButtonElement;
    go.onclick = async () => {
      go.disabled = true;
      try { const n = await enablePush(); paintNotify(n); if (n === 'on') toast(t('Notifikasi aktif. Kamu akan dikabari saat ada balasan.'), { kind: 'ok' }); }
      catch { toast(t('Notifikasi gagal diaktifkan. Coba lagi nanti.'), { kind: 'bad' }); go.disabled = false; }
    };
    notify.replaceChildren(h('span', { html: svg('bell') }), h('p', null, t('Mau dikabari saat ada balasan? Aktifkan notifikasi supaya tidak perlu cek terus.')), go);
  };
  void pushState().then(paintNotify);

  root.append(h('div', { class: 'ap-page' }, notify, th.el));
  return () => th.destroy();
}
