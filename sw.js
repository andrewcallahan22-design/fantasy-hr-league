// Service worker for push notifications.
// VERSION is updated on every deploy so iOS detects changes and refetches.
// Format: YYYY-MM-DD-HHmm (UTC build time approximation)
const SW_VERSION = '2026-06-29-go-yard';

self.addEventListener('push', (event) => {
  let data = { title: '⚾ Home Run!', body: '', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; }
  catch (e) { if (event.data) data.body = event.data.text(); }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/favicon-192.png',
    badge: '/favicon-96.png',
    tag: data.tag || 'fantasy-hr',
    data: { url: data.url || '/' },
    vibrate: [80, 40, 80],
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.registration.scope) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Skip waiting immediately so updates apply on the very next page load.
// Combined with clients.claim() this means the new SW takes control of
// all open tabs right away — no need to close and reopen the app.
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control of all clients immediately
      self.clients.claim(),
      // Tell all open tabs to reload so they pick up the new app version
      self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => client.navigate(client.url));
      }),
    ])
  );
});
