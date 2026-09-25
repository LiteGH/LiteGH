const CACHE_NAME = 'litegh-v1';
const APP_SHELL = [
  '/',
  '/404.html',
  '/manifest.webmanifest',
  '/icons/favicon.ico',
  '/icons/icon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const CDN_ASSETS = new Set([
  'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.4.16/purify.min.js',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'
]);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

const staleWhileRevalidate = async (request) => {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return cached || (await network) || Response.error();
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isGitHubData = url.hostname === 'api.github.com' || url.hostname === 'raw.githubusercontent.com';
  if (CDN_ASSETS.has(request.url)) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  if (sameOrigin && request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        return (await caches.match(request)) || (await caches.match(new URL('/', self.registration.scope).href));
      }
    })());
    return;
  }
  if (sameOrigin && !isGitHubData) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
