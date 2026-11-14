// Service worker of the management app. It no longer keeps a copy of the app: everything the app
// does needs the server anyway, and a saved copy hid sign-in pages and network problems behind an
// old screen ("no internet" while the browser could have shown the real reason). All it does now is
// remove the copies earlier versions saved; every request goes straight to the network.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mv-manage-')).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
