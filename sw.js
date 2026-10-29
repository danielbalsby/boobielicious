const VERSION = 'ammetid-v24';
const SHELL = ['./', 'index.html', 'app.js', 'sound.js', 'manifest.json', 'icons/icon.svg', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: cache-first, gemmes ved første besøg
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(VERSION).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        try { const res = await fetch(req); c.put(req, res.clone()); return res; }
        catch { return new Response('', { status: 503 }); }
      })
    );
    return;
  }

  if (url.origin !== location.origin) return;

  // App-skal: netværk først (så opdateringer slår igennem), cache som offline-fallback
  // no-cache: spørg altid serveren, om der er en nyere version (undgår gammel HTML med ny JS)
  e.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});

// ---------- Notifikationer (fra push/worker.js) ----------
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch {}
  const title = msg.title || 'Ammetid';
  e.waitUntil((async () => {
    // Er appen åben på skærmen, spiller den selv lyden – så vis beskeden lydløst og fjern den igen
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const seen = wins.some(w => w.visibilityState === 'visible');
    await self.registration.showNotification(title, {
      body: msg.body || '',
      tag: msg.tag || 'ammetid',
      renotify: true,
      silent: seen,
      requireInteraction: !!msg.alarm && !seen,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
    });
    if (seen) {
      await new Promise(r => setTimeout(r, 1500));
      (await self.registration.getNotifications({ tag: msg.tag || 'ammetid' })).forEach(n => n.close());
    }
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow('./');
  })());
});
