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
  sentenceEnd,
  setUnits,
  t,
} from './i18n.js';
import { loadEntry, save } from './cache.js';
import { withDeadline } from './net.js';
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
// After a refresh where nothing could be reached, coming back retries sooner.
const VISIBLE_RETRY_MS = 60e3;
const CLOCK_MS = 15e3;
const RETRY_DELAY_MS = 2000;
// Each source gets an overall deadline so one stuck feed can never hold the others.
const SOURCE_DEADLINE_MS = { weather: 45e3, gdacs: 90e3, jtwc: 90e3, dmh: 45e3, override: 30e3 };
// DMH (same origin) is shown this soon even while slow third-party feeds are still loading.
const INTERIM_RENDER_MS = 3500;
// A refresh still "running" after this is abandoned and a new one may start.
const REFRESH_WATCHDOG_MS = 120e3;
// Data on screen older than this (e.g. a phone waking up) is aged before the refresh finishes.
const AGE_ON_SCREEN_MS = 30 * 60e3;
// A device clock this far from the server's is corrected and pointed out.
const CLOCK_SKEW_MS = 10 * 60e3;
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

/** "Now" corrected for a device clock that is set wrong (see noteServerTime). */
function appNow() {
  return new Date(Date.now() + app.clockOffsetMs);
}

const els = {};
const app = {
  demo: null,
  sources: emptySources(),
  state: null,
  now: new Date(),
  updatedAt: null,
  fromCache: false,
  refreshing: null,
  refreshStartedAt: 0,
  generation: 0,
  pendingRefresh: null,
  lastAttemptAt: null,
  lastFailed: false,
  dataAt: null,
  clockOffsetMs: 0,
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
    dmh: { json: null, state: 'loading', fetchedAt: null },
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
  // A hidden page does not need fresh data; coming back refreshes it (below).
  setInterval(() => {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  setInterval(() => {
    renderFreshnessLine();
    ageOnScreen();
  }, CLOCK_MS);
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    renderFreshnessLine();
    ageOnScreen();
    const last = app.lastAttemptAt ?? app.updatedAt;
    const wait = app.lastFailed ? VISIBLE_RETRY_MS : VISIBLE_REFRESH_MS;
    if (!last || appNow() - last > wait) refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  addEventListener('pageshow', (ev) => ev.persisted && onVisible());
  addEventListener('online', () => {
    renderFreshnessLine();
    refresh({ trigger: 'online' });
  });
  addEventListener('offline', () => renderFreshnessLine());

  setupLazyMap();
  setupChipNav();
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
        h('span', { text: ` ${t(`demo.name.${app.demo}`)}${sentenceEnd()} ` }),
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
  const visible = t(metric ? 'unit.kmh' : 'unit.mph');
  els.unitsBtn.querySelector('.units-label').textContent = visible;
  // The accessible name starts with the visible text, so speech input ("tap km/h") works.
  els.unitsBtn.setAttribute('aria-label', `${visible} — ${t(metric ? 'header.unitsToImperial' : 'header.unitsToMetric')}`);
  els.unitsBtn.title = t(metric ? 'header.unitsToImperial' : 'header.unitsToMetric');
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

/**
 * Sources as they stand when some are older than their "fresh" window: a
 * saved or long-idle copy never counts as a live check. Storm feeds become
 * stale stand-ins (a gap, so they cannot make the page say Calm), dropped
 * after 12 h; the forecast is marked stale after 3 h and dropped after 36 h.
 */
function ageSources(src, now, { restored = false } = {}) {
  const out = { ...src };
  for (const key of ['gdacs', 'jtwc']) {
    const f = out[key];
    if (!f) continue;
    if (ageMs(f.fetchedAt, now) > STALE_AFTER_MS.storms) out[key] = { ...f, ok: false, stale: false, systems: [] };
    else if (restored || f.ok) out[key] = { ...f, ok: false, stale: Boolean(Array.isArray(f.systems) && (f.ok || f.stale)) };
  }
  const w = out.weather;
  if (w?.data && ageMs(w.fetchedAt, now) > WEATHER_KEEP_MS) out.weather = { data: null, ok: false, fetchedAt: null };
  else if (w && ageMs(w.fetchedAt, now) > STALE_AFTER_MS.weather) out.weather = { ...w, ok: false, stale: true };
  return out;
}

/** Correct a wrong device clock from the server's Date header / DMH's check time. */
function noteServerTime(serverMs) {
  if (!Number.isFinite(serverMs)) return;
  const skew = serverMs - Date.now();
  if (Math.abs(skew) > CLOCK_SKEW_MS) app.clockOffsetMs = skew;
  else if (Math.abs(app.clockOffsetMs) > 0 && Math.abs(skew) <= CLOCK_SKEW_MS / 2) app.clockOffsetMs = 0;
}

function fetchTasks(mods, now) {
  const need = (m, fn) => (m ? fn(m) : Promise.reject(new Error('module unavailable')));
  // Mobile connections drop requests; the two single-request sources get one retry.
  const retryOnce = (fn) => fn().catch(() => new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS)).then(fn));
  const onResponse = (res) => noteServerTime(Date.parse(res.headers.get('date') ?? ''));
  return {
    weather: need(mods.weather, (m) => retryOnce(() => m.fetchWeather(HOME, now))),
    gdacs: need(mods.gdacs, (m) => m.fetchGdacs(now, HOME)),
    jtwc: need(mods.jtwc, (m) => m.fetchJtwc(now, HOME)),
    dmh: need(mods.dmh, (m) => retryOnce(() => m.fetchDmhJson({ now: now.getTime(), onResponse }))),
    override: need(mods.dmh, (m) => m.fetchOverride({ now: now.getTime() })),
  };
}

/**
 * Next sources from settled fetch results (`results[key]` = allSettled-style
 * entry, or undefined while still pending: then the previous copy stands in
 * as a gap). Returns the sources and what actually succeeded.
 */
function combineSources(prev, results, now, { log = true } = {}) {
  const next = emptySources();
  const fulfilled = (k) => results[k]?.status === 'fulfilled';
  const w = results.weather;
  if (fulfilled('weather') && w.value) next.weather = { data: w.value, ok: true, fetchedAt: now };
  else {
    if (log && w) logFailure('weather', w.reason);
    next.weather = prev.weather.data && ageMs(prev.weather.fetchedAt, now) <= WEATHER_KEEP_MS ? { ...prev.weather, ok: false, stale: true } : { data: null, ok: false, fetchedAt: null };
  }

  for (const key of ['gdacs', 'jtwc']) {
    const res = results[key];
    const value = fulfilled(key) ? res.value : null;
    // GDACS "partial": a nearby storm's track or wind detail could not be loaded.
    if (value?.ok && !value.partial) {
      next[key] = { systems: value.systems ?? [], ok: true, fetchedAt: now };
      continue;
    }
    if (log && res) logFailure(key, value ? value.error ?? 'incomplete' : res.reason);
    const fallback = stormFallback(prev[key], now);
    const partial = Array.isArray(value?.systems) ? value.systems : [];
    if (partial.length) {
      // Part of the feed answered (e.g. the Indian Ocean advisory but not the
      // RSS): never throw a nearby formation alert away. The feed still counts
      // as failed (gap), so this can never make the page say "Calm".
      const cached = new Map(fallback.systems.map((s) => [s?.id, s]));
      next[key] = {
        systems: [
          // A formation alert whose text failed this time keeps the corridor from the last good copy.
          ...partial.map((s) => (s?.kind === 'tcfa' && !s.tcfa && cached.get(s.id)?.tcfa ? { ...s, tcfa: cached.get(s.id).tcfa } : s)),
          ...fallback.systems.filter((s) => !partial.some((p) => p?.id === s?.id)),
        ],
        ok: false,
        stale: true,
        fetchedAt: fallback.stale ? fallback.fetchedAt : now,
      };
    } else next[key] = fallback;
  }

  const d = results.dmh;
  if (fulfilled('dmh')) next.dmh = d.value ? { json: d.value, state: 'ok', fetchedAt: now } : { json: null, state: 'missing', fetchedAt: now };
  else {
    if (log && d) logFailure('dmh', d.reason);
    if (!d && prev.dmh.state === 'loading') next.dmh = prev.dmh;
    else next.dmh = prev.dmh.json ? { ...prev.dmh, state: 'cached' } : { json: null, state: d ? 'error' : prev.dmh.state, fetchedAt: prev.dmh.fetchedAt ?? null };
  }
  // DMH checks the site's clock too: data/dmh.json can never have been checked in the future.
  const checked = Date.parse(next.dmh.json?.checkedAt ?? '');
  if (Number.isFinite(checked) && checked - Date.now() > CLOCK_SKEW_MS) app.clockOffsetMs = Math.max(app.clockOffsetMs, checked - Date.now());

  // An override can only raise the level: keep the last known one if the fetch fails.
  next.override = fulfilled('override') ? { json: results.override.value } : prev.override;

  const dmhOk = fulfilled('dmh');
  const summary = {
    anyOk: dmhOk || next.gdacs.ok || next.jtwc.ok,
    allOk: dmhOk && next.gdacs.ok && next.jtwc.ok && next.weather.ok,
  };
  return { sources: next, summary };
}

async function fetchLive(now, gen) {
  const mods = await loadModules();
  const tasks = fetchTasks(mods, now);
  const results = {};
  const all = Promise.all(
    Object.entries(tasks).map(([key, p]) =>
      withDeadline(p, SOURCE_DEADLINE_MS[key], key).then(
        (value) => (results[key] = { status: 'fulfilled', value }),
        (reason) => (results[key] = { status: 'rejected', reason }),
      ),
    ),
  );
  // Show DMH (same origin, quick) without waiting for the slowest third-party feed.
  let done = false;
  all.then(() => (done = true));
  await Promise.race([all, new Promise((r) => setTimeout(r, INTERIM_RENDER_MS))]);
  if (!done && gen === app.generation) await interimRender(now, results);
  await all;
  if (gen !== app.generation) return null;
  const { sources, summary } = combineSources(app.sources, results, now);
  app.sources = sources;
  app.fromCache = false;
  return summary;
}

/**
 * Render what has arrived while other feeds are still loading. Feeds still
 * pending count as gaps, and a "Calm" is never shown early: the status is
 * only replaced when something already warrants attention.
 */
async function interimRender(now, results) {
  if (!results.dmh) return;
  try {
    const { sources } = combineSources(app.sources, results, now, { log: false });
    const state = await buildAppState(sources, now);
    if (!state) return;
    safeRender('official', els.officialBody, () => renderOfficial(els.officialBody, state.dmh ?? null, { now, fetchState: sources.dmh.state, demo: false }));
    if (state.risk.level != null && state.risk.level >= 1 && state.risk.level >= (app.state?.risk?.level ?? -1)) {
      app.state = state;
      app.now = now;
      safeRender('status', els.statusBody, () => renderStatus(els.statusBody, state, { now, notices: statusNotices(now), demo: false, onShare: share }));
    }
  } catch (err) {
    console.warn('[main] interim render skipped', err);
  }
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

/**
 * Fetch (or build the demo), recompute, render, save. A call while a run is
 * going queues one follow-up (after a run that could not reach everything,
 * or to show the Refresh button's toast); a run stuck for two minutes is
 * abandoned so later refreshes can recover.
 */
function refresh({ userAsked = false } = {}) {
  if (app.refreshing) {
    if (Date.now() - app.refreshStartedAt < REFRESH_WATCHDOG_MS) {
      app.pendingRefresh = { userAsked: userAsked || Boolean(app.pendingRefresh?.userAsked) };
      return app.refreshing;
    }
    console.warn('[main] abandoning a refresh that never finished');
  }
  const gen = ++app.generation;
  app.refreshStartedAt = Date.now();
  const run = (async () => {
    setBusy(true);
    const now = appNow();
    let summary = null;
    try {
      if (app.demo) {
        await loadDemo(now);
        summary = { anyOk: true, allOk: true };
      } else summary = await fetchLive(now, gen);
      if (gen !== app.generation) return;
      app.lastAttemptAt = now;
      app.lastFailed = !summary?.anyOk;
      // "Updated just now" only when something was actually fetched.
      if (summary?.anyOk) app.updatedAt = now;
      await recompute(appNow());
      if (gen !== app.generation) return;
      renderAll();
      if (!app.demo && summary?.anyOk) saveSnapshot();
      if (userAsked) showToast(t(summary?.anyOk ? 'toast.updated' : 'toast.failed'));
    } catch (err) {
      console.error('[main] refresh failed', err);
      if (userAsked) showToast(t('toast.failed'));
    } finally {
      if (gen === app.generation) {
        app.refreshing = null;
        setBusy(false);
        const pending = app.pendingRefresh;
        app.pendingRefresh = null;
        if (pending && !summary?.allOk) refresh(pending);
        else if (pending?.userAsked) showToast(t(summary?.anyOk ? 'toast.updated' : 'toast.failed'));
      }
    }
  })();
  app.refreshing = run;
  return run;
}

/** Age what is on screen when it has sat for a while (a phone waking up), before the refresh lands. */
function ageOnScreen() {
  if (app.demo || !app.updatedAt || app.fromCache) return;
  const now = appNow();
  if (now - app.updatedAt <= AGE_ON_SCREEN_MS) return;
  app.sources = ageSources(app.sources, now);
  app.fromCache = true;
  recompute(now).then(() => {
    if (app.fromCache) renderAll();
  });
}

/** The pipeline's state for `sources` at `now` (null only if nothing could be computed). */
async function buildAppState(sources, now) {
  const mods = await loadModules();
  let weather = sources.weather.data;
  if (weather && mods.weather?.rederiveWeather) weather = mods.weather.rederiveWeather(weather, now);
  if (!mods.pipeline) return partialState(mods, weather, now, sources);
  try {
    return mods.pipeline.buildState({
      gdacs: sources.gdacs,
      jtwc: sources.jtwc,
      dmhJson: sources.dmh.json,
      weather,
      overrideJson: sources.override.json,
      extraGaps: sources.weather.ok ? [] : ['weather'],
      now,
    });
  } catch (err) {
    console.error('[main] pipeline failed', err);
    return partialState(mods, weather, now, sources);
  }
}

async function recompute(now = appNow()) {
  app.now = now;
  app.state = await buildAppState(app.sources, now);
}

/** Without the pipeline: still show DMH and the forecast, and say "Unknown — check DMH". */
function partialState(mods, weather, now, sources = app.sources) {
  let dmh = null;
  try {
    dmh = mods.dmh ? mods.dmh.evaluateDmh(sources.dmh.json, HOME, now) : null;
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
  // When the data itself is from: the oldest source the page is showing.
  const times = [s.dmh.json ? s.dmh.fetchedAt : null, s.gdacs.fetchedAt, s.jtwc.fetchedAt].filter((d) => d instanceof Date);
  const dataAt = times.length ? new Date(Math.min(...times.map(Number))) : app.updatedAt;
  if (save(SNAPSHOT_KEY, { app: APP_VERSION, sources: s, dataAt })) return;
  for (const level of [1, 2]) {
    const slim = { ...s, gdacs: { ...s.gdacs, systems: slimSystems(s.gdacs.systems, level) }, jtwc: { ...s.jtwc, systems: slimSystems(s.jtwc.systems, level) } };
    if (save(SNAPSHOT_KEY, { app: APP_VERSION, sources: slim, dataAt })) return;
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
  const now = appNow();
  // A saved copy is never a live check: storm feeds count as stale stand-ins (gaps).
  const src = ageSources({ ...emptySources(), ...snap.sources }, now, { restored: true });
  if (src.dmh?.state === 'ok' || src.dmh?.state === 'missing') src.dmh = { ...src.dmh, state: src.dmh.json ? 'cached' : 'loading' };
  app.sources = src;
  app.fromCache = true;
  app.updatedAt = entry.savedAt;
  app.dataAt = snap.dataAt instanceof Date ? snap.dataAt : entry.savedAt;
  await recompute(now);
  // The live fetch may have finished first; never paint older data over it.
  if (app.fromCache) renderAll();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const summaryKey = (d) => d.dataset.key || d.querySelector('summary')?.textContent?.replace(/\s*\(.*\)\s*$/, '') || '';

const FOCUSABLE = 'a[href], button, summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Enough to find a focused control again once its section is rebuilt. */
function focusKey(node, root) {
  if (node.dataset?.focusKey) return { focusKey: node.dataset.focusKey };
  const list = [...root.querySelectorAll(FOCUSABLE)];
  return { tag: node.tagName, cls: node.className, text: (node.textContent ?? '').trim().slice(0, 80), index: list.indexOf(node) };
}

function restoreFocus(root, key) {
  const list = [...root.querySelectorAll(FOCUSABLE)];
  const target = key.focusKey
    ? list.find((n) => n.dataset?.focusKey === key.focusKey)
    : (list.find((n) => n.tagName === key.tag && n.className === key.cls && (n.textContent ?? '').trim().slice(0, 80) === key.text) ??
      (list[key.index]?.tagName === key.tag ? list[key.index] : null));
  target?.focus({ preventScroll: true });
}

function safeRender(name, el, fn) {
  if (!el) return;
  // Re-rendering must not close what the reader opened (e.g. the DMH stage explainer)...
  const open = new Set([...el.querySelectorAll('details[open]')].map(summaryKey));
  // ...nor drop keyboard / screen-reader focus to the top of the page.
  const active = document.activeElement;
  const key = active && active !== document.body && el.contains(active) ? focusKey(active, el) : null;
  try {
    fn();
    if (open.size) for (const d of el.querySelectorAll('details')) if (open.has(summaryKey(d))) d.open = true;
    if (key && !el.contains(document.activeElement)) restoreFocus(el, key);
  } catch (err) {
    console.error(`[main] could not render ${name}`, err);
    el.replaceChildren(h('p', { class: 'notice notice-warn' }, icon('alert', { size: 20 }), h('span', { text: t('error.section') })));
  }
}

/** Notices inside the status card; `key` identifies each one whatever its (changing) "… ago" text. */
function statusNotices(now) {
  const s = app.sources;
  const out = [];
  const savedAt = app.dataAt ?? app.updatedAt;
  if (app.fromCache && savedAt) out.push({ kind: 'info', key: 'cached', text: t('notice.cached', { ago: formatRelative(savedAt, now) }) });
  if (!navigator.onLine) out.push({ kind: 'warn', key: 'offline', text: t('notice.offline') });
  if (Math.abs(app.clockOffsetMs) > CLOCK_SKEW_MS) {
    out.push({ kind: 'warn', key: 'clock', text: t('notice.clock', { hours: formatNumber(Math.round(Math.abs(app.clockOffsetMs) / 360e3) / 10) }) });
  }
  if (!app.fromCache) {
    for (const key of ['gdacs', 'jtwc']) {
      if (s[key].stale && s[key].fetchedAt) out.push({ kind: 'info', key: `${key}Old`, text: t(`notice.${key}Old`, { ago: formatRelative(s[key].fetchedAt, now) }) });
    }
    if (s.weather.stale && s.weather.fetchedAt) out.push({ kind: 'info', key: 'weatherOld', text: t('notice.weatherOld', { ago: formatRelative(s.weather.fetchedAt, now) }) });
  }
  return out;
}

function renderAll() {
  const now = app.now ?? appNow();
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
    renderFreshness(els.freshness, { now: appNow(), updatedAt: app.updatedAt, refreshing: Boolean(app.refreshing), offline: !navigator.onLine, failed: app.lastFailed && !app.refreshing, demo: Boolean(app.demo) });
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
  const s = app.sources;
  const text = buildShareText(st?.risk ?? { level: null, reasons: [], gaps: [] }, st?.analyses ?? [], st?.dmh ?? null, st?.weather ?? null, getLang(), {
    now: appNow(),
    demo: Boolean(app.demo),
    dataTime: app.updatedAt,
    dmhFetchState: s.dmh.state,
    weatherStale: !s.weather.ok,
  });
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
    time: (d) => formatWhen(d, appNow()),
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
          now: () => appNow(),
          // No data yet: wait for it rather than download tiles for a view that is replaced at once.
          initialViewDelayMs: app.state ? 0 : 10000,
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
  const invoker = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const map = await ensureMap();
  if (!map) return;
  map.invalidate();
  // Focus moves into the storm's popup (and back to the button when it closes).
  if (map.focusSystem(id, { moveFocus: true, returnFocus: invoker })) return;
  const heading = els.mapSection?.querySelector('h2');
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
}

/**
 * The chip row scrolls sideways on phones: keep the focused chip fully in
 * view, and fade the edge that has more chips behind it.
 */
function setupChipNav() {
  const list = document.querySelector('.chipnav ul');
  if (!list) return;
  const edges = () => {
    const more = list.scrollWidth - list.clientWidth;
    list.classList.toggle('more-right', more > 2 && list.scrollLeft < more - 2);
    list.classList.toggle('more-left', more > 2 && list.scrollLeft > 2);
  };
  list.addEventListener('focusin', (ev) => {
    const a = ev.target instanceof Element ? ev.target.closest('a') : null;
    if (!a) return;
    const lr = list.getBoundingClientRect();
    const ar = a.getBoundingClientRect();
    const pad = 24;
    if (ar.left < lr.left + pad) list.scrollLeft -= lr.left + pad - ar.left;
    else if (ar.right > lr.right - pad) list.scrollLeft += ar.right - (lr.right - pad);
    edges();
  });
  list.addEventListener('scroll', edges, { passive: true });
  addEventListener('resize', edges, { passive: true });
  edges();
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
