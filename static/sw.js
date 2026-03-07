// MedTrack Service Worker v3
// KEY: This SW is the ONLY notification path on mobile.
// Android Chrome blocks new Notification() constructor entirely.
// All showNotification() calls must come through this SW.

self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e  => e.waitUntil(self.clients.claim()));

// Handle notification tap — focus existing window or open dashboard
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/dashboard';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});

// Future: server-push support
self.addEventListener('push', e => {
  let d = { title: 'MedTrack', body: 'Medicine reminder',
            icon: '/static/images/logo.jpg', tag: 'medtrack',
            urgent: false, url: '/dashboard' };
  try { Object.assign(d, e.data.json()); } catch(_) {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, icon: d.icon, badge: d.icon, tag: d.tag,
    vibrate: d.urgent ? [300,100,300,100,400] : [200,100,200],
    requireInteraction: false,  // never lock screen on mobile
    silent: false, data: { url: d.url }
  }));
});
