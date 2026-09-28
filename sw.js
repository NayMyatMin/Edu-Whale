// Service worker for Yangon Storm Watch.
// - App shell (page, styles, scripts, dictionaries, Leaflet, font, icons) is
//   precached so the checklist, phone numbers and last saved status open
//   offline. Cache names carry APP_VERSION (registered as sw.js?v=<version>).
// - Navigations and same-origin data/*.json: network first, cache fallback.
// - Open-Meteo / GDACS / JTWC: network first; a cached copy is used only while
//   young (so an old forecast or storm list is never passed off as current).
// - Map tiles (OSM, NASA GIBS, RainViewer) are never cached. Non-GET is ignored.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'ysw-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const DATA_CACHE = `${PREFIX}data-${VERSION}`;
const API_CACHE = `${PREFIX}api-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, DATA_CACHE, API_CACHE]);

const NAV_TIMEOUT_MS = 7000;
const API_MAX_ENTRIES = 40;
const STAMP = 'x-ysw-fetched-at';
const HOUR = 3600e3;
const API_HOSTS = new Map([
  ['api.open-meteo.com', 3 * HOUR],
  ['www.gdacs.org', 1 * HOUR],
  ['gdacs.org', 1 * HOUR],
  ['www.metoc.navy.mil', 1 * HOUR],
]);
const NEVER_CACHE_HOSTS = [/(^|\.)tile\.openstreetmap\.org$/, /(^|\.)gibs\.earthdata\.nasa\.gov$/, /(^|\.)rainviewer\.com$/];

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'css/map.css',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'fonts/NotoSansMyanmar-myanmar.woff2',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'js/main.js',
  'js/config.js',
  'js/geo.js',
  'js/net.js',
  'js/cache.js',
  'js/i18n.js',
  'js/i18n/en/index.js',
  'js/i18n/en/core.js',
  'js/i18n/en/map.js',
  'js/i18n/en/ui.js',
  'js/i18n/my/index.js',
  'js/i18n/my/core.js',
  'js/i18n/my/map.js',
  'js/i18n/my/ui.js',
  'js/ui.js',
  'js/ui/dom.js',
  'js/ui/status.js',
  'js/ui/official.js',
  'js/ui/systems.js',
  'js/ui/weather.js',
  'js/ui/prepare.js',
  'js/ui/about.js',
  'js/ui/freshness.js',
  'js/ui/pipeline.js',
  'js/charts.js',
  'js/demo.js',
  'js/map.js',
  'js/gdacs.js',
  'js/jtwc.js',
  'js/systems.js',
  'js/dmh.js',
  'js/weather.js',
  'js/risk.js',
  'data/override.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One missing file must not stop the rest from being cached.
      await Promise.all(
        SHELL.map((path) =>
          cache.add(new Request(path, { cache: 'reload' })).catch((err) => console.warn('[sw] not cached:', path, err?.message ?? err)),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(PREFIX) && !CURRENT.has(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
  if (NEVER_CACHE_HOSTS.some((re) => re.test(url.hostname))) return;

  if (url.origin === self.location.origin) {
    const scopePath = new URL(self.registration.scope).pathname;
    if (request.mode === 'navigate') {
      event.respondWith(navigation(event));
    } else if (url.pathname.startsWith(`${scopePath}data/`) && url.pathname.endsWith('.json')) {
      event.respondWith(networkFirst(request, DATA_CACHE));
    } else if (!url.pathname.endsWith('/sw.js')) {
      event.respondWith(staleWhileRevalidate(event));
    }
    return;
  }

  const maxAge = API_HOSTS.get(url.hostname);
  if (maxAge) event.respondWith(apiNetworkFirst(request, maxAge));
  // Anything else cross-origin (Windy embed, external links) goes straight to the network.
});

async function navigation(event) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(event.request)
    .then((res) => {
      if (res.ok) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), NAV_TIMEOUT_MS));
  const first = await Promise.race([network, timeout]);
  if (first && first !== 'timeout') return first;
  const cached = (await cache.match(event.request, { ignoreSearch: true })) || (await cache.match('./')) || (await cache.match('index.html'));
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const late = await network;
  return late || new Response('Offline. Please check DMH: https://www.moezala.gov.mm/en/cyclone-news', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request)
    .then((res) => {
      if (res.ok && res.type === 'basic') cache.put(event.request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}

async function apiNetworkFirst(request, maxAgeMs) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && res.type !== 'opaque') {
      const body = await res.clone().arrayBuffer();
      const headers = new Headers(res.headers);
      headers.set(STAMP, String(Date.now()));
      await cache.put(request, new Response(body, { status: res.status, statusText: res.statusText, headers }));
      trim(cache).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    const at = Number(cached?.headers.get(STAMP));
    if (cached && Number.isFinite(at) && Date.now() - at <= maxAgeMs) return cached;
    throw err;
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - API_MAX_ENTRIES; i++) await cache.delete(keys[i]);
}
