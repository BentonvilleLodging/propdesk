// PropDesk Service Worker — v5 (VAPID push + same-origin caching; same-origin notification links)
var CACHE   = 'propdesk-v7';
var ASSETS  = ['/'];

// Only ever open PropDesk pages from a notification — never an external site.
function safeTarget(u) {
  var scope = self.registration.scope;
  try {
    var t = new URL(u || scope, scope);
    if (t.origin === new URL(scope).origin) return t.href;
  } catch (_) {}
  return scope;
}

// ── Install ────────────────────────────────────────────────────────────────
self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function(c) { return c.addAll(ASSETS); })
      .then(function()  { return self.skipWaiting(); })
  );
});

// ── Activate ───────────────────────────────────────────────────────────────
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE; })
            .map(function(k)    { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// ── Fetch (network-first, cache fallback) — SAME-ORIGIN ONLY ──────────────
// Cross-origin requests (Supabase JS on jsDelivr, Google Fonts, Supabase API) are never
// touched here: the browser loads them directly under the page's own security policy.
// (Proxying them made the worker's Content-Security-Policy block the Supabase library.)
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  var url;
  try { url = new URL(e.request.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/.netlify/functions') === 0) return;

  e.respondWith(
    fetch(e.request)
      .then(function(res) {
        if (res && res.ok) {
          var clone = res.clone();
          caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
        }
        return res;
      })
      .catch(function() {
        return caches.match(e.request).then(function(hit) { return hit || Response.error(); });
      })
  );
});

// ── Message from page → show in-app notification ──────────────────────────
self.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'SHOW_NOTIFICATION') return;
  var d = e.data;
  e.waitUntil(
    self.registration.showNotification(d.title || 'PropDesk', {
      body:     d.body    || '',
      tag:      d.tag     || 'propdesk',
      icon:     '/apple-touch-icon.png',
      badge:    '/icon-192.png',
      renotify: true,
      data:     { url: safeTarget(d.url) },
    })
  );
});

// ── Server-sent VAPID push ─────────────────────────────────────────────────
// This fires when a push arrives even if the app tab is closed.
self.addEventListener('push', function(e) {
  var payload = {};
  try { payload = e.data ? e.data.json() : {}; } catch(_) {}

  var title = payload.title || 'PropDesk';
  var body  = payload.body  || payload.message || 'New activity.';
  var tag   = payload.tag   || 'propdesk-push';
  var url   = safeTarget(payload.url);

  e.waitUntil(
    self.registration.showNotification(title, {
      body:     body,
      tag:      tag,
      icon:     '/apple-touch-icon.png',
      badge:    '/icon-192.png',
      renotify: true,
      data:     { url: url },
    })
  );
});

// ── Notification click → focus or open app ────────────────────────────────
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var target = safeTarget(e.notification.data && e.notification.data.url);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clients) {
        for (var i = 0; i < clients.length; i++) {
          var c = clients[i];
          if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
            // Deep links (e.g. ?agent_run=ID) reload the open app on that URL
            if (target.indexOf('?') >= 0 && 'navigate' in c) return c.focus().then(function(w) { return (w || c).navigate(target); });
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});
