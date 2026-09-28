// Page orchestration: paint the last saved snapshot at once, fetch every
// source in parallel (Promise.allSettled — one failing source never breaks
// the page), run the pipeline (merge → analyse → DMH → risk), render, save.
// Refreshes every 10 min, when the tab comes back (> 5 min old), when the
// connection returns, and on the Refresh button. ?demo=<name> swaps the
// network for js/demo.js scenarios.

import { APP_VERSION, HOME, REFRESH_MS, STALE_AFTER_MS } from './config.js';
import {
  applyStaticTranslations,
  formatDateTime,
  formatDistance,
  formatNumber,
  formatRelative,
  formatWhen,
  formatWind,
  getLang,
  getUnits,
  initI18n,
  onLangChange,
  onUnitsChange,
  setLang,
  setUnits,
  t,
} from './i18n.js';
import { loadEntry, save } from './cache.js';
import {
  buildShareText,
  renderAbout,
  renderChecklist,
  renderContacts,
  renderFreshness,
  renderNow,
  renderOfficial,
  renderOutlook,
  renderSources,
  renderStatus,
  renderSystems,
} from './ui.js';
import { renderHourlyCharts, setChartsBusy } from './charts.js';
import { h, icon } from './ui/dom.js';

const SNAPSHOT_KEY = 'snapshot';
const THEME_KEY = 'ysw.theme';
const DEMO_NAMES = ['calm', 'watch', 'approach', 'today'];
const VISIBLE_REFRESH_MS = 5 * 60e3;
const CLOCK_MS = 15e3;
const RETRY_DELAY_MS = 2000;
// A saved forecast older than this is not shown at all.
const WEATHER_KEEP_MS = 36 * 3600e3;
const SOURCE_MODULES = {
  weather: () => import('./weather.js'),
  gdacs: () => import('./gdacs.js'),
  jtwc: () => import('./jtwc.js'),
  dmh: () => import('./dmh.js'),
  pipeline: () => import('./ui/pipeline.js'),
};

const $ = (sel) => document.querySelector(sel);

const els = {};
const app = {
  demo: null,
  sources: emptySources(),
  state: null,
  now: new Date(),
  updatedAt: null,
  fromCache: false,
  refreshing: null,
  map: null,
  mapLoading: null,
  mods: null,
  toastTimer: 0,
};

function emptySources() {
  return {
    weather: { data: null, ok: false, fetchedAt: null },
    gdacs: { systems: [], ok: false, fetchedAt: null },
    jtwc: { systems: [], ok: false, fetchedAt: null },
    dmh: { json: null, state: 'error', fetchedAt: null },
    override: { json: null },
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  Object.assign(els, {
    status: $('#status'),
    statusBody: $('#status-body'),
    officialBody: $('#official-body'),
    systemsBody: $('#systems-body'),
    nowBody: $('#now-body'),
    forecastBody: $('#forecast-body'),
    outlookBody: $('#outlook-body'),
    prepareBody: $('#prepare-body'),
    contactsBody: $('#contacts-body'),
    sourcesBody: $('#sources-body'),
    aboutBody: $('#about-body'),
    freshness: $('#freshness'),
    refreshBtn: $('#refresh'),
    unitsBtn: $('#units-toggle'),
    themeBtn: $('#theme-toggle'),
    demoBanner: $('#demo-banner'),
    toast: $('#toast'),
    mapSection: $('#map'),
    mapCanvas: $('#map-canvas'),
    mapControls: $('#map-controls'),
    windyPanel: $('#map-windy'),
  });
  document.documentElement.classList.add('js');

  initI18n();
  const params = new URLSearchParams(location.search);
  const demo = params.get('demo');
  if (demo && DEMO_NAMES.includes(demo)) app.demo = demo;

  bindHeader();
  applyLanguage();
  onLangChange(() => {
    applyLanguage();
    renderStatic();
    renderAll();
    app.map?.setLang(getLang(), t, mapFormatters());
  });
  onUnitsChange(() => {
    updateUnitsButton();
    renderStatic();
    renderAll();
    app.map?.setLang(getLang(), t, mapFormatters());
  });

  renderStatic();
  if (!app.demo) paintSnapshot();
  else renderAll();

  refresh();
  setInterval(() => refresh(), REFRESH_MS);
  setInterval(() => renderFreshnessLine(), CLOCK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    renderFreshnessLine();
    if (!app.updatedAt || Date.now() - app.updatedAt.getTime() > VISIBLE_REFRESH_MS) refresh();
  });
  addEventListener('online', () => {
    renderFreshnessLine();
    refresh();
  });
  addEventListener('offline', () => renderFreshnessLine());

  setupLazyMap();
  registerServiceWorker();
}

// ---------------------------------------------------------------------------
// Header controls: language, units, theme, refresh
// ---------------------------------------------------------------------------

function bindHeader() {
  for (const btn of document.querySelectorAll('[data-set-lang]')) {
    btn.addEventListener('click', () => setLang(btn.dataset.setLang));
  }
  els.unitsBtn?.addEventListener('click', () => setUnits(getUnits() === 'metric' ? 'imperial' : 'metric'));
  els.themeBtn?.addEventListener('click', toggleTheme);
  els.refreshBtn?.addEventListener('click', () => refresh({ userAsked: true }));
  updateThemeButton();
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', updateThemeButton);
}

function applyLanguage() {
  applyStaticTranslations(document);
  for (const btn of document.querySelectorAll('[data-set-lang]')) btn.setAttribute('aria-pressed', String(btn.dataset.setLang === getLang()));
  document.title = app.demo ? `${t('demo.titlePrefix')} ${t('app.title')}` : t('app.title');
  if (els.demoBanner) {
    els.demoBanner.hidden = !app.demo;
    if (app.demo) {
      els.demoBanner.replaceChildren(
        h('strong', { text: t('demo.banner') }),
        h('span', { text: ` ${t(`demo.name.${app.demo}`)}. ` }),
        h('a', { href: location.pathname, text: t('demo.exit') }),
      );
    }
  }
  updateUnitsButton();
  updateThemeButton();
}

function updateUnitsButton() {
  if (!els.unitsBtn) return;
  const metric = getUnits() === 'metric';
  els.unitsBtn.querySelector('.units-label').textContent = t(metric ? 'unit.kmh' : 'unit.mph');
  els.unitsBtn.setAttribute('aria-label', t(metric ? 'header.unitsToImperial' : 'header.unitsToMetric'));
  els.unitsBtn.title = els.unitsBtn.getAttribute('aria-label');
}

function effectiveTheme() {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* not remembered */
  }
  updateThemeButton();
  app.map?.setTheme(next);
}

function updateThemeButton() {
  if (!els.themeBtn) return;
  const dark = effectiveTheme() === 'dark';
  els.themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon', { size: 22 }));
  const label = t(dark ? 'header.themeToLight' : 'header.themeToDark');
  els.themeBtn.setAttribute('aria-label', label);
  els.themeBtn.title = label;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (document.documentElement.dataset.theme) meta.setAttribute('content', dark ? '#0d0d0d' : '#f9f9f7');
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function loadModules() {
  if (!app.mods) {
    const names = Object.keys(SOURCE_MODULES);
    app.mods = Promise.allSettled(names.map((n) => SOURCE_MODULES[n]())).then((results) => {
      const mods = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') mods[names[i]] = r.value;
        else console.error(`[main] could not load ${names[i]} module`, r.reason);
      });
      return mods;
    });
  }
  return app.mods;
}

const ageMs = (d, now) => (d instanceof Date ? now.getTime() - d.getTime() : Infinity);

/** A failed storm feed falls back to its last good copy while that is < 12 h old. */
function stormFallback(prev, now) {
  if (prev && Array.isArray(prev.systems) && (prev.ok || prev.stale) && ageMs(prev.fetchedAt, now) <= STALE_AFTER_MS.storms) {
    return { systems: prev.systems, ok: false, stale: true, fetchedAt: prev.fetchedAt };
  }
  return { systems: [], ok: false, stale: false, fetchedAt: prev?.fetchedAt ?? null };
}

async function fetchLive(now) {
  const mods = await loadModules();
  const need = (m, fn) => (m ? fn(m) : Promise.reject(new Error('module unavailable')));
  // Mobile connections drop requests; the two single-request sources get one retry.
  const retryOnce = (fn) => fn().catch(() => new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS)).then(fn));
  const [w, g, j, d, o] = await Promise.allSettled([
    need(mods.weather, (m) => retryOnce(() => m.fetchWeather(HOME, now))),
    need(mods.gdacs, (m) => m.fetchGdacs(now, HOME)),
    need(mods.jtwc, (m) => m.fetchJtwc(now, HOME)),
    need(mods.dmh, (m) => retryOnce(() => m.fetchDmhJson({ now: now.getTime() }))),
    need(mods.dmh, (m) => m.fetchOverride({ now: now.getTime() })),
  ]);
  const prev = app.sources;
  const next = emptySources();

  if (w.status === 'fulfilled' && w.value) next.weather = { data: w.value, ok: true, fetchedAt: now };
  else {
    logFailure('weather', w.reason);
    next.weather = prev.weather.data && ageMs(prev.weather.fetchedAt, now) <= WEATHER_KEEP_MS ? { ...prev.weather, ok: false, stale: true } : { data: null, ok: false, fetchedAt: null };
  }

  for (const [key, res] of [
    ['gdacs', g],
    ['jtwc', j],
  ]) {
    if (res.status === 'fulfilled' && res.value?.ok) next[key] = { systems: res.value.systems ?? [], ok: true, fetchedAt: now };
    else {
      logFailure(key, res.status === 'fulfilled' ? res.value?.error : res.reason);
      const fallback = stormFallback(prev[key], now);
      const partial = res.status === 'fulfilled' && Array.isArray(res.value?.systems) ? res.value.systems : [];
      if (partial.length) {
        // Part of the feed answered (e.g. the Indian Ocean advisory but not the
        // RSS): never throw a nearby formation alert away. The feed still counts
        // as failed (gap), so this can never make the page say "Calm".
        const ids = new Set(partial.map((s) => s?.id));
        next[key] = {
          systems: [...partial, ...fallback.systems.filter((s) => !ids.has(s?.id))],
          ok: false,
          stale: true,
          fetchedAt: fallback.stale ? fallback.fetchedAt : null,
        };
      } else next[key] = fallback;
    }
  }

  if (d.status === 'fulfilled') next.dmh = d.value ? { json: d.value, state: 'ok', fetchedAt: now } : { json: null, state: 'missing', fetchedAt: now };
  else {
    logFailure('dmh', d.reason);
    next.dmh = prev.dmh.json ? { ...prev.dmh, state: 'cached' } : { json: null, state: 'error', fetchedAt: null };
  }

  // An override can only raise the level: keep the last known one if the fetch fails.
  next.override = o.status === 'fulfilled' ? { json: o.value } : prev.override;
  app.sources = next;
  app.fromCache = false;
}

function logFailure(name, reason) {
  if (reason) console.warn(`[main] ${name} unavailable:`, reason?.message ?? reason);
}

async function loadDemo(now) {
  const [{ getDemo }, mods] = await Promise.all([import('./demo.js'), loadModules()]);
  const demo = getDemo(app.demo, now);
  const weather = mods.weather ? mods.weather.normalizeWeather(demo.weatherJson, now) : null;
  app.sources = {
    weather: { data: weather, ok: Boolean(weather), fetchedAt: now },
    gdacs: { systems: demo.gdacsSystems, ok: true, fetchedAt: now },
    jtwc: { systems: demo.jtwcSystems, ok: true, fetchedAt: now },
    dmh: { json: demo.dmhJson, state: 'ok', fetchedAt: now },
    override: { json: demo.override },
  };
}

/** Fetch (or build the demo), recompute, render, save. Concurrent calls share one run. */
function refresh({ userAsked = false } = {}) {
  if (app.refreshing) return app.refreshing;
  app.refreshing = (async () => {
    setBusy(true);
    const now = new Date();
    try {
      if (app.demo) await loadDemo(now);
      else await fetchLive(now);
      app.updatedAt = now;
      await recompute(now);
      renderAll();
      if (!app.demo) saveSnapshot();
      if (userAsked) showToast(t('toast.updated'));
    } catch (err) {
      console.error('[main] refresh failed', err);
      if (userAsked) showToast(t('toast.failed'));
    } finally {
      app.refreshing = null;
      setBusy(false);
    }
  })();
  return app.refreshing;
}

async function recompute(now = new Date()) {
  app.now = now;
  const mods = await loadModules();
  const s = app.sources;
  let weather = s.weather.data;
  if (weather && mods.weather?.rederiveWeather) weather = mods.weather.rederiveWeather(weather, now);
  if (!mods.pipeline) {
    app.state = partialState(mods, weather, now);
    return;
  }
  try {
    app.state = mods.pipeline.buildState({
      gdacs: s.gdacs,
      jtwc: s.jtwc,
      dmhJson: s.dmh.json,
      weather,
      overrideJson: s.override.json,
      extraGaps: s.weather.ok ? [] : ['weather'],
      now,
    });
  } catch (err) {
    console.error('[main] pipeline failed', err);
    app.state = partialState(mods, weather, now);
  }
}

/** Without the pipeline: still show DMH and the forecast, and say "Unknown — check DMH". */
function partialState(mods, weather, now) {
  let dmh = null;
  try {
    dmh = mods.dmh ? mods.dmh.evaluateDmh(app.sources.dmh.json, HOME, now) : null;
  } catch {
    dmh = null;
  }
  return {
    now,
    analyses: [],
    relevant: [],
    elsewhere: [],
    threats: new Map(),
    stormsKnown: false,
    dmh,
    weather: weather ?? null,
    override: null,
    risk: { level: null, reasons: [{ code: 'unknown', level: null, source: 'dmh', params: {} }], gaps: ['storms'], generatedAt: now },
  };
}

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

const NO_SWATH = { kmh60: null, kmh90: null, kmh120: null };

/** Lighter copies for a full storage quota: first the drawing-only swath, then all geometry. */
function slimSystems(list, level) {
  return (list ?? []).map((s) => (level === 1 ? { ...s, swath: NO_SWATH } : { ...s, swath: NO_SWATH, windAreas: [], cone: null }));
}

function saveSnapshot() {
  const s = app.sources;
  if (save(SNAPSHOT_KEY, { app: APP_VERSION, sources: s })) return;
  for (const level of [1, 2]) {
    const slim = { ...s, gdacs: { ...s.gdacs, systems: slimSystems(s.gdacs.systems, level) }, jtwc: { ...s.jtwc, systems: slimSystems(s.jtwc.systems, level) } };
    if (save(SNAPSHOT_KEY, { app: APP_VERSION, sources: slim })) return;
  }
}

async function paintSnapshot() {
  const entry = loadEntry(SNAPSHOT_KEY);
  const snap = entry?.value;
  // Another app version may have saved other shapes: start fresh rather than risk a broken paint.
  if (!snap?.sources || snap.app !== APP_VERSION) {
    renderAll();
    return;
  }
  const now = new Date();
  const src = { ...emptySources(), ...snap.sources };
  // Cached sources count as they were when saved only while still fresh.
  for (const key of ['gdacs', 'jtwc']) {
    const f = src[key];
    if (f && ageMs(f.fetchedAt, now) > STALE_AFTER_MS.storms) src[key] = { ...f, ok: false, stale: false, systems: [] };
  }
  if (src.weather?.data && ageMs(src.weather.fetchedAt, now) > WEATHER_KEEP_MS) src.weather = { data: null, ok: false, fetchedAt: null };
  else if (src.weather && ageMs(src.weather.fetchedAt, now) > STALE_AFTER_MS.weather) src.weather = { ...src.weather, ok: false, stale: true };
  app.sources = src;
  app.fromCache = true;
  app.updatedAt = entry.savedAt;
  await recompute(now);
  // The live fetch may have finished first; never paint older data over it.
  if (app.fromCache) renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const summaryKey = (d) => d.dataset.key || d.querySelector('summary')?.textContent?.replace(/\s*\(.*\)\s*$/, '') || '';

function safeRender(name, el, fn) {
  if (!el) return;
  // Re-rendering must not close what the reader opened (e.g. the DMH stage explainer).
  const open = new Set([...el.querySelectorAll('details[open]')].map(summaryKey));
  try {
    fn();
    if (open.size) for (const d of el.querySelectorAll('details')) if (open.has(summaryKey(d))) d.open = true;
  } catch (err) {
    console.error(`[main] could not render ${name}`, err);
    el.replaceChildren(h('p', { class: 'notice notice-warn' }, icon('alert', { size: 20 }), h('span', { text: t('error.section') })));
  }
}

function statusNotices(now) {
  const s = app.sources;
  const out = [];
  if (app.fromCache && app.updatedAt) out.push({ kind: 'info', text: t('notice.cached', { ago: formatRelative(app.updatedAt, now) }) });
  if (!navigator.onLine) out.push({ kind: 'warn', text: t('notice.offline') });
  if (!app.fromCache) {
    for (const key of ['gdacs', 'jtwc']) {
      if (s[key].stale && s[key].fetchedAt) out.push({ kind: 'info', text: t(`notice.${key}Old`, { ago: formatRelative(s[key].fetchedAt, now) }) });
    }
    if (s.weather.stale && s.weather.fetchedAt) out.push({ kind: 'info', text: t('notice.weatherOld', { ago: formatRelative(s.weather.fetchedAt, now) }) });
  }
  return out;
}

function renderAll() {
  const now = app.now ?? new Date();
  const st = app.state;
  const s = app.sources;
  renderFreshnessLine();
  safeRender('status', els.statusBody, () =>
    renderStatus(els.statusBody, st ?? { risk: { level: null, reasons: [{ code: 'unknown', level: null, params: {} }], gaps: [] } }, { now, notices: statusNotices(now), demo: Boolean(app.demo), onShare: share }),
  );
  safeRender('official', els.officialBody, () => renderOfficial(els.officialBody, st?.dmh ?? null, { now, fetchState: s.dmh.state, demo: Boolean(app.demo) }));
  safeRender('systems', els.systemsBody, () => renderSystems(els.systemsBody, st ?? { stormsKnown: false }, { now, onShowOnMap: showOnMap, feedNotes: feedNotes() }));
  safeRender('now', els.nowBody, () => renderNow(els.nowBody, st?.weather ?? null, { now, stale: Boolean(s.weather.stale) }));
  safeRender('forecast', els.forecastBody, () => renderHourlyCharts(els.forecastBody, st?.weather ?? null, { now, hours: 48 }));
  safeRender('outlook', els.outlookBody, () => renderOutlook(els.outlookBody, st?.weather ?? null, { now }));
  if (app.map && st) {
    try {
      app.map.setData({ analyses: st.analyses, dmh: st.dmh });
    } catch (err) {
      console.error('[main] map update failed', err);
    }
  }
}

/** Sections that depend only on language and units, not on fetched data. */
function renderStatic() {
  safeRender('prepare', els.prepareBody, () => renderChecklist(els.prepareBody));
  safeRender('contacts', els.contactsBody, () => renderContacts(els.contactsBody));
  safeRender('sources', els.sourcesBody, () => renderSources(els.sourcesBody));
  safeRender('about', els.aboutBody, () => renderAbout(els.aboutBody));
}

function feedNotes() {
  const s = app.sources;
  const notes = [];
  if (!s.gdacs.ok && !s.gdacs.stale && s.jtwc.ok) notes.push(t('sys.gdacsDown'));
  if (!s.jtwc.ok && !s.jtwc.stale && s.gdacs.ok) notes.push(t('sys.jtwcDown'));
  return notes;
}

function renderFreshnessLine() {
  if (!els.freshness) return;
  try {
    renderFreshness(els.freshness, { now: new Date(), updatedAt: app.updatedAt, refreshing: Boolean(app.refreshing), offline: !navigator.onLine, demo: Boolean(app.demo) });
  } catch (err) {
    console.error('[main] freshness', err);
  }
}

function setBusy(busy) {
  els.refreshBtn?.classList.toggle('is-spinning', busy);
  els.refreshBtn?.setAttribute('aria-busy', String(busy));
  els.status?.setAttribute('aria-busy', String(busy));
  setChartsBusy(els.forecastBody, busy && Boolean(app.state?.weather));
  renderFreshnessLine();
}

// ---------------------------------------------------------------------------
// Share
// ---------------------------------------------------------------------------

async function share() {
  const st = app.state;
  const text = buildShareText(st?.risk ?? { level: null, reasons: [], gaps: [] }, st?.analyses ?? [], st?.dmh ?? null, st?.weather ?? null, getLang(), { now: new Date(), demo: Boolean(app.demo) });
  if (navigator.share) {
    try {
      await navigator.share({ title: t('app.name'), text });
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }
  if (await copyText(text)) showToast(t('toast.copied'));
  else showToast(t('toast.copyFailed'));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'visually-hidden', readonly: true });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function showToast(message) {
  if (!els.toast) return;
  els.toast.textContent = message;
  els.toast.hidden = false;
  els.toast.classList.add('is-visible');
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => {
    els.toast.classList.remove('is-visible');
    els.toast.hidden = true;
  }, 3500);
}

// ---------------------------------------------------------------------------
// Map (created lazily when its section nears the viewport)
// ---------------------------------------------------------------------------

function mapFormatters() {
  return {
    distance: formatDistance,
    wind: (kmh) => formatWind(kmh, { alt: true }),
    time: (d) => formatWhen(d, new Date()),
    dateTime: formatDateTime,
    number: (n) => formatNumber(n),
  };
}

function ensureMap() {
  if (app.map) return Promise.resolve(app.map);
  if (!app.mapLoading) {
    app.mapLoading = import('./map.js')
      .then((m) => {
        app.map = m.createMap(els.mapCanvas, {
          home: HOME,
          theme: effectiveTheme(),
          lang: getLang(),
          t,
          fmt: mapFormatters(),
          controlsEl: els.mapControls,
          windyEl: els.windyPanel,
          now: () => new Date(),
        });
        if (app.state) app.map.setData({ analyses: app.state.analyses, dmh: app.state.dmh });
        return app.map;
      })
      .catch((err) => {
        console.error('[main] map could not load', err);
        els.mapCanvas?.replaceChildren(h('p', { class: 'notice notice-warn' }, icon('alert', { size: 20 }), h('span', { text: t('map.unavailable') })));
        app.mapLoading = null;
        return null;
      });
  }
  return app.mapLoading;
}

function setupLazyMap() {
  if (!els.mapSection || !els.mapCanvas) return;
  if (!('IntersectionObserver' in globalThis)) {
    ensureMap();
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        io.disconnect();
        ensureMap();
      }
    },
    { rootMargin: '400px 0px' },
  );
  io.observe(els.mapSection);
}

async function showOnMap(id) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  els.mapSection?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  const map = await ensureMap();
  if (!map) return;
  map.invalidate();
  map.focusSystem(id);
}

// ---------------------------------------------------------------------------
// Service worker (offline copy of the page, checklist and phone numbers)
// ---------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (location.protocol !== 'https:' && !local) return;
  navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`).catch((err) => console.warn('[main] service worker not registered', err?.message ?? err));
}

try {
  boot();
} catch (err) {
  console.error('[main] boot failed', err);
}
