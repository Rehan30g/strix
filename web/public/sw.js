/* Service worker: only for Web Push (a reply to a quota request). It caches nothing. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { /* plain text */ }
  event.waitUntil(self.registration.showNotification(d.title || 'Strix', {
    body: d.body || '',
    tag: d.tag || 'strix',
    renotify: true,
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: { url: d.url || '/#/messages' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/#/messages';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) { await c.focus(); if ('navigate' in c) { try { await c.navigate(url); } catch { /* ignore */ } } return; }
    }
    await self.clients.openWindow(url);
  })());
});
