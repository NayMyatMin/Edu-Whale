// Service worker for Yangon Storm Watch.
// - App shell (page, styles, scripts, dictionaries, Leaflet, font, icons) is
//   precached so the checklist, phone numbers and last saved status open
//   offline. Cache names carry APP_VERSION (registered as sw.js?v=<version>).
//   The files the page needs to start are installed all-or-nothing: a failed
//   download keeps the previous, complete version in charge.
// - Same-origin app files and navigations: network first (revalidated, so a
//   deploy is picked up at once and old and new modules never mix), the
//   cached copy after a few seconds or offline.
// - Same-origin data/*.json (DMH bulletins, the override): network only. The
//   page keeps its own last copy and says how old it is; an old copy from here
//   would be passed off as new.
// - Open-Meteo / GDACS / JTWC: network first; a cached copy is used only while
//   young (so an old forecast or storm list is never passed off as current).
// - Map tiles (OSM, NASA GIBS, RainViewer) are never cached. Non-GET is ignored.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'ysw-';
const SHELL_CACHE = `${PREFIX}shell-${VERSION}`;
const API_CACHE = `${PREFIX}api-${VERSION}`;
const CURRENT = new Set([SHELL_CACHE, API_CACHE]);

// Network answers slower than this fall back to the cached copy (the network one still updates the cache).
const APP_TIMEOUT_MS = 3000;
const NAV_TIMEOUT_MS = 5000;
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
];

// What the page needs to start (all-or-nothing); the rest (icons, images, the
// demo data) is cached when it can be.
const CRITICAL = SHELL.filter((p) => p === './' || (/\.(?:html|css|js|webmanifest)$/.test(p) && p !== 'js/demo.js'));
const OPTIONAL = SHELL.filter((p) => !CRITICAL.includes(p));
// Revalidate with the server (a 304 when unchanged), never trust the HTTP cache blindly.
const fresh = (path) => new Request(path, { cache: 'no-cache' });

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        await cache.addAll(CRITICAL.map(fresh));
      } catch (err) {
        // Incomplete: drop it and fail, so the previous worker and its complete cache stay.
        await caches.delete(SHELL_CACHE);
        throw err;
      }
      await Promise.all(OPTIONAL.map((path) => cache.add(fresh(path)).catch((err) => console.warn('[sw] not cached:', path, err?.message ?? err))));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      const complete = (await Promise.all(CRITICAL.map((p) => shell.match(p)))).every(Boolean);
      const names = await caches.keys();
      // Old shells go only once the new one is complete; old data/api caches always go.
      await Promise.all(
        names
          .filter((n) => n.startsWith(PREFIX) && !CURRENT.has(n) && (complete || !n.startsWith(`${PREFIX}shell-`)))
          .map((n) => caches.delete(n)),
      );
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
    if (request.mode === 'navigate') event.respondWith(navigation(event, url, scopePath));
    else if (url.pathname.startsWith(`${scopePath}data/`)) return; // network only (see above)
    else if (!url.pathname.endsWith('/sw.js')) event.respondWith(appFile(event));
    return;
  }

  const maxAge = API_HOSTS.get(url.hostname);
  if (maxAge) event.respondWith(apiNetworkFirst(request, maxAge));
  // Anything else cross-origin (Windy embed, external links) goes straight to the network.
});

const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve('timeout'), ms));

/** A shell file from this version's cache, else from any version's (offline only). */
async function cachedShell(request, cache) {
  return (await cache.match(request)) || (await caches.match(request)) || null;
}

async function appFile(event) {
  const { request } = event;
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(new Request(request, { cache: 'no-cache' }))
    .then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        cache.put(request, copy).catch(() => {});
      }
      return res;
    })
    .catch(() => null);
  const first = await Promise.race([network, timeout(APP_TIMEOUT_MS)]);
  if (first && first !== 'timeout' && first.ok) return first;
  const cached = await cachedShell(request, cache);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const late = first === 'timeout' ? await network : first;
  return late || Response.error();
}

async function navigation(event, url, scopePath) {
  const cache = await caches.open(SHELL_CACHE);
  const isPage = url.pathname === scopePath || url.pathname === `${scopePath}index.html`;
  // One copy of the page whatever the query string (?demo=…): each variant is the same HTML.
  const key = new URL('./', self.registration.scope).href;
  const network = fetch(event.request)
    .then((res) => {
      if (res.ok && isPage) cache.put(key, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  const first = await Promise.race([network, timeout(NAV_TIMEOUT_MS)]);
  if (first && first !== 'timeout') return first;
  const cached = isPage ? (await cache.match(key)) || (await cache.match('index.html')) || (await caches.match(key)) : null;
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const late = await network;
  return late || new Response('Offline. Please check DMH: https://www.moezala.gov.mm/en/cyclone-news', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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
