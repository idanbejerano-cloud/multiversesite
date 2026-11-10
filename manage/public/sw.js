// Service worker of the management app (/manage/): keeps the app's own files so it opens
// fast and still opens without a connection. Always tries the network first, so a new
// version of the app shows up on the next open. Never touches GitHub, GoatCounter or the site.
const CACHE = 'mv-manage-v1';
const FILES = ['./', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'fonts/Karantina-Bold.woff', 'fonts/IBMPlexSansHebrew-Regular.woff', 'fonts/IBMPlexSansHebrew-Medium.woff',
  'fonts/IBMPlexSansHebrew-SemiBold.woff', 'fonts/IBMPlexSansHebrew-Bold.woff'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mv-manage-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? './' : req, copy));
    }
    return res;
  }).catch(() => caches.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true })
    .then((r) => r || caches.match('./'))));
});
