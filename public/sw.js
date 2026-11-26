// Proprigo : service minimal pour l'installation sur l'écran d'accueil.
// Rien n'est mis en cache : l'application affiche toujours les données à jour.
// Sans connexion, une page simple explique qu'il faut du réseau.
const OFFLINE = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proprigo</title><body style="font-family:system-ui,sans-serif;background:#f2f5ff;color:#0f1430;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px">
<div><p style="font-size:28px;font-weight:800;color:#1f4fff;margin:0">proprigo</p><h1 style="font-size:22px">Pas de connexion Internet</h1>
<p>Proprigo a besoin d'Internet pour afficher vos ménages à jour. Vérifiez votre connexion puis réessayez.</p>
<button onclick="location.reload()" style="background:#ff6a3d;border:0;border-radius:14px;padding:14px 22px;font-weight:700;font-size:16px">Réessayer</button></div></body></html>`;
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

// Notifications sur téléphone : nouvelle mission (intervenante), « en route », changement (client).
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Proprigo', {
    body: data.body || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: data.tag || undefined, renotify: Boolean(data.tag),
    data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.focus(); return c.navigate ? c.navigate(url) : null; }
    return self.clients.openWindow(url);
  }));
});
