// Service worker for push notifications.
// Registered by index.html; the browser keeps it alive in the background to
// receive pushes even when the site isn't open.

self.addEventListener('push', (event) => {
  let data = { title: '⚾ Home Run!', body: '', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; }
  catch (e) { if (event.data) data.body = event.data.text(); }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/favicon-192.png',     // graceful fallback if not present
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
      // Focus an existing tab if there is one
      for (const c of list) {
        if (c.url.includes(self.registration.scope) && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

// Skip waiting so updates pick up on next page load
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
