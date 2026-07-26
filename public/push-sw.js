// Push notification handlers for MyStore Hub.
//
// This file is IMPORTED into the Workbox-generated service worker via
// `workbox.importScripts` in vite.config.js — it is NOT the whole service
// worker. Workbox owns precaching/routing/autoUpdate; this file adds only the
// `push` and `notificationclick` behaviour, which Workbox never generates.
// Keep it dependency-free and self-contained: it runs inside the SW global
// scope, not the app bundle.

// Shape of the JSON payload sent by api/_lib/pushNotify.js. Everything is
// defended with fallbacks so a malformed/empty push can never throw inside the
// event handler (an unhandled throw here would drop the notification silently).
self.addEventListener('push', (event) => {
  let payload;
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // Non-JSON payload (shouldn't happen from our sender) — show a generic
    // notification rather than nothing at all.
    payload = {};
  }

  const title = payload.title || 'MyStore Hub';
  const options = {
    body: payload.body || '',
    // Reuse the installed PWA icons so the notification is branded on Android.
    icon: payload.icon || '/icon-192.png',
    badge: '/icon-192.png',
    // `tag` collapses repeats of the same logical event into one notification
    // instead of stacking duplicates. `data.url` is the deep-link target the
    // click handler below opens.
    tag: payload.tag || undefined,
    data: { url: payload.url || '/' },
    // Order/cancellation pushes are actionable — keep them on screen until the
    // seller acknowledges rather than auto-dismissing.
    requireInteraction: payload.requireInteraction ?? false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  // Focus an already-open MyStore Hub tab if there is one (and navigate it to
  // the deep link), otherwise open a new window. Matching on origin only —
  // never on the exact path — so a tab sitting on any page still gets reused.
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
            return client.focus().then((focused) => {
              if ('navigate' in focused) {
                return focused.navigate(targetUrl);
              }
              return focused;
            });
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      })
  );
});
