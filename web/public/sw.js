// Service worker: lets browsers install Nothing But Fin as an app. It doesn't cache anything;
// pages and figures always come fresh from the network.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
