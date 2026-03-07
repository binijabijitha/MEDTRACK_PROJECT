// MedTrack Service Worker v2 — OS-level push notifications
const CACHE = 'medtrack-v2';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Triggered by swReg.showNotification() from app.js
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/dashboard';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.focus(); return; }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

// Handle server-sent push events (for future backend push support)
self.addEventListener('push', e => {
  let data = {
    title: 'MedTrack',
    body:  'Medicine reminder',
    icon:  '/static/images/logo.jpg',
    tag:   'medtrack',
    urgent: false,
    url:   '/dashboard'
  };
  try { Object.assign(data, e.data.json()); } catch(_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:               data.body,
      icon:               data.icon,
      badge:              data.icon,
      tag:                data.tag,
      vibrate:            data.urgent ? [300,100,300,100,400] : [200,100,200],
      requireInteraction: !!data.urgent,
      silent:             false,
      data:               { url: data.url }
    })
  );
});
