/* God's Eye View — service worker offline-first (rutas relativas) */
const VERSION = 'v1.1.8';
const CACHE_PREFIX = 'gev-';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${VERSION}`;

const SW_URL = new URL(self.location.href);
const BASE_URL = new URL('./', SW_URL);
const INDEX_URL = new URL('index.html', BASE_URL);
const ROOT_URL = BASE_URL;

const scopedUrl = (path) => new URL(path.replace(/^\/+/, ''), BASE_URL);

const CORE_ASSETS = [
  'manifest.json',
  'icons/favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
].map((path) => scopedUrl(path).href);

const cacheAsset = async (cache, assetUrl, seen) => {
  if (!assetUrl || seen.has(assetUrl)) return;
  seen.add(assetUrl);

  try {
    const response = await fetch(assetUrl, { cache: 'reload' });
    if (!response.ok) return;
    await cache.put(assetUrl, response.clone());
    if (!assetUrl.endsWith('.css')) return;

    const css = await response.text();
    const references = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    await Promise.allSettled(
      references.map((match) => {
        const reference = match[2];
        if (!reference || reference.startsWith('data:') || reference.startsWith('#')) {
          return Promise.resolve();
        }
        let resolved;
        try {
          resolved = new URL(reference, assetUrl);
        } catch {
          return Promise.resolve();
        }
        if (resolved.origin !== self.location.origin) return Promise.resolve();
        return cacheAsset(cache, resolved.href, seen);
      }),
    );
  } catch {
    // Missing asset: keep the rest of the shell cacheable.
  }
};

const precacheAppShell = async () => {
  const cache = await caches.open(SHELL_CACHE);
  const indexResponse = await fetch(new Request(INDEX_URL.href, { cache: 'reload' }));
  if (!indexResponse.ok) throw new Error('No se pudo precachear index.html');

  await cache.put(INDEX_URL.href, indexResponse.clone());
  await cache.put(ROOT_URL.href, indexResponse.clone());

  const html = await indexResponse.text();
  const discovered = new Set(CORE_ASSETS);
  for (const match of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
    const reference = match[1];
    if (!reference || reference.startsWith('data:')) continue;
    let resolved;
    try {
      resolved = new URL(reference, INDEX_URL);
    } catch {
      continue;
    }
    if (resolved.origin !== self.location.origin) continue;
    discovered.add(resolved.href);
  }

  await Promise.allSettled(
    [...discovered].map((asset) => cacheAsset(cache, asset, new Set())),
  );
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    precacheAppShell()
      .then(() => self.skipWaiting())
      .catch((error) => console.error('[GEV] Precarga offline fallida:', error)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

const offlineFallback = async () => {
  const cached =
    (await caches.match(ROOT_URL.href, { ignoreVary: true })) ??
    (await caches.match(INDEX_URL.href, { ignoreVary: true }));
  if (cached) return cached;
  return new Response(
    '<!doctype html><html lang="es"><meta charset="utf-8"><title>Sin conexión</title><body style="background:#020617;color:#e2e8f0;font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0"><main style="text-align:center;padding:2rem"><h1>Sin conexión</h1><p>Abre la app de nuevo cuando tengas internet para completar la instalación.</p></main></body></html>',
    {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    },
  );
};

const networkFirstNavigation = async (request) => {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(INDEX_URL.href, response.clone());
      await cache.put(ROOT_URL.href, response.clone());
      return response;
    }
    return (await caches.match(ROOT_URL.href, { ignoreVary: true })) ?? response;
  } catch {
    return offlineFallback();
  }
};

const cacheFirst = async (request) => {
  const cached = await caches.match(request, { ignoreSearch: true, ignoreVary: true });
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic' && !request.headers.has('range')) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return Response.error();
  }
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname === SW_URL.pathname) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
