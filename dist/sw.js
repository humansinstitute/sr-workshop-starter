const CACHE_NAME = 'super-based-todo-v16';

const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/js/app.js',
  '/js/db.js',
  '/js/nostr.js',
  '/js/nostr-cvm.js',
  '/js/utils.js',
  '/js/secure-store.js',
  '/js/keyteleport.js',
  '/js/superbased.js',
  '/js/sync-notifier.js',
  '/css/app.css',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.png',
  '/manifest.webmanifest'
];

// External CDN resources to cache
const CDN_ASSETS = [
  'https://esm.sh/alpinejs@3.14.8',
  'https://esm.sh/dexie@4.0.10',
  'https://esm.sh/nostr-tools@2.7.2',
  'https://esm.sh/nostr-tools@2.7.2/nip19',
  'https://esm.sh/nostr-tools@2.7.2/nip44',
  'https://esm.sh/@noble/hashes@1.7.1/sha256',
  'https://esm.sh/@scure/base@1.2.4'
];

// Install: cache all static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Cache local assets
      const localCaching = cache.addAll(ASSETS_TO_CACHE);

      // Cache CDN assets (don't fail install if CDN is down)
      const cdnCaching = Promise.all(
        CDN_ASSETS.map((url) =>
          fetch(url, { mode: 'cors' })
            .then((response) => {
              if (response.ok) {
                return cache.put(url, response);
              }
            })
            .catch(() => {
              console.log('Failed to cache CDN asset:', url);
            })
        )
      );

      return Promise.all([localCaching, cdnCaching]);
    }).then(() => {
      // Activate immediately
      return self.skipWaiting();
    })
  );
});

// Activate: clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => {
      // Take control of all pages immediately
      return self.clients.claim();
    })
  );
});

// Fetch: cache-first for static assets, network-first for CDN
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // For same-origin requests, use cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(event.request).then((response) => {
          // Cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
    return;
  }

  // For CDN requests (esm.sh), try cache first, then network
  if (url.hostname === 'esm.sh') {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(() => {
          // Return cached version if available, even if stale
          return caches.match(event.request);
        });
      })
    );
    return;
  }

  // For other external requests, just fetch normally
  event.respondWith(fetch(event.request));
});
