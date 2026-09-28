// Interactive storm map (Leaflet 1.9.4, loaded as the classic global `L`).
//
// Layers, bottom to top, each in its own pane so the dark-theme CSS filter
// only touches the OSM base tiles:
//   base (OSM) -> satellite (GIBS Himawari IR) -> radar (RainViewer)
//   -> overlays (cones, wind areas, TCFA corridors, invest circles, rings)
//   -> tracks -> markers (storms, DMH) -> home (Yangon pin, always on top).
//
// The pure helpers in the first half are exported for unit tests; nothing in
// this module touches `window`, `document` or `L` at import time.
// Untrusted strings (system names, DMH text) only ever reach the DOM through
// textContent; innerHTML is used for static icon markup alone.

import {
  DMH_STAGES,
  HOME,
  IMD_CLASSES,
  INTENSITY_COLORS,
  KT_TO_KMH,
  RANGE_RINGS_KM,
  SATELLITE,
  URLS,
} from './config.js';
import { bearingDeg, circlePolygon, compass16, destinationPoint, haversineKm, wrapLonDelta } from './geo.js';
import { fetchJson, fetchText } from './net.js';
import { imdClassKey } from './systems.js';
import enMap from './i18n/en/map.js';

const MIN_MS = 60e3;
const HOUR_MS = 3600e3;

// GIBS time list window and a hard cap on expanded times (a malformed
// <Domain> must not make us build a huge array).
const DOMAIN_WINDOW_H = 8;
const MAX_DOMAIN_TIMES = 5000;
// Himawari skips its full-disk scan at these UTC times every day.
const HIMAWARI_DAILY_GAPS = new Set(['02:40', '14:40']);

const LOOP_FRAME_MS = 700;
const LOOP_HOLD_MS = 1500;
const LOOP_PRELOAD_TIMEOUT_MS = 12000;
const NETWORK_TIMEOUT_MS = 12000;
const SAT_REFRESH_MS = 10 * MIN_MS;
const RADAR_REFRESH_MS = 10 * MIN_MS;
const RADAR_OPACITY = 0.7;
const RADAR_MAX_NATIVE_ZOOM = 7;

// Same rule as systems.js `insideWindKmh`, so the map shows exactly the wind
// areas the status reasons talk about.
const WIND_AREA_MAX_AGE_MS = 3 * HOUR_MS;
const WIND_STRENGTHS = [60, 90, 120];
const WIND_FILL_OPACITY = { 60: 0.1, 90: 0.14, 120: 0.18 };
const CONE_FILL_OPACITY = 0.12;
const INVEST_RADIUS_KM = 150;
// A focused system brings Yangon into view only when it is reasonably close.
const FOCUS_WITH_HOME_KM = 1500;
// The default view fits relevant systems in the region or this close; a
// typhoon near Japan would otherwise zoom the map out until Yangon is a dot.
const FIT_NEAR_KM = 2500;
// Ring labels closer than this to Yangon on screen are hidden (zoomed out).
const RING_LABEL_MIN_PX = 40;

const FIT_MAX_ZOOM = 7;
// Left: clear the zoom and fit buttons (about 56 px) plus half a centred label
// such as "Yangon" above its pin, so the label is never hidden
// behind them; bottom: clear the attribution line.
const FIT_PADDING_TL = [100, 28];
const FIT_PADDING_BR = [36, 40];
const DEFAULT_VIEW = Object.freeze({ lat: 15, lon: 90, zoom: 4, wideZoom: 5, wideMinPx: 900 });

const CLS_TO_IMD = { TD: 'imd.d', TS: 'imd.cs', HU: 'imd.vscs' };
const LAYER_NAMES = ['satellite', 'radar', 'tracks', 'wind', 'rings'];
const LAYER_DEFAULTS = Object.freeze({ satellite: true, radar: false, tracks: true, wind: true, rings: true });
const STORAGE_KEY = 'ysw.map.layers.v1';

const PANES = Object.freeze({
  base: ['ymap-base', 200],
  satellite: ['ymap-sat', 250],
  radar: ['ymap-radar', 300],
  overlays: ['ymap-overlays', 410],
  tracks: ['ymap-tracks', 420],
  markers: ['ymap-markers', 610],
  home: ['ymap-home', 630],
});
const PANE = Object.fromEntries(Object.entries(PANES).map(([k, [name]]) => [k, name]));

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const validLatLon = (p) => Boolean(p) && isFiniteNum(p.lat) && isFiniteNum(p.lon) && Math.abs(p.lat) <= 90;

function timeMs(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'string' || typeof v === 'number') {
    const ms = new Date(v).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** GIBS wants second precision and a Z: 2026-09-28T14:30:00Z (…T14:30Z is a 400). */
export function gibsTime(date) {
  return new Date(date).toISOString().slice(0, 19) + 'Z';
}

/**
 * DescribeDomains URL for [now − 8 h, now]. The end is rounded down to the
 * minute so the 30-minute CDN cache cannot hand back an old list.
 */
export function gibsDomainsUrl(now = new Date(), windowHours = DOMAIN_WINDOW_H) {
  const end = Math.floor(+now / MIN_MS) * MIN_MS;
  return URLS.gibsDomains(gibsTime(end - windowHours * HOUR_MS), gibsTime(end));
}

/** 'PT10M' -> 600000. Null for anything that is not a positive ISO 8601 duration. */
export function parseIsoDurationMs(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const [, d = 0, h = 0, mi = 0, sec = 0] = m;
  const ms = ((Number(d) * 24 + Number(h)) * 60 + Number(mi)) * MIN_MS + Number(sec) * 1000;
  return ms > 0 ? ms : null;
}

/**
 * Expand a GIBS DescribeDomains response
 * (`<Domain>start/end/PT10M,start/end/PT10M</Domain>`, comma-separated when
 * there are gaps) into sorted, unique Dates. Regex-based so it runs in Node.
 */
export function parseGibsDomains(xml) {
  const m = /<Domain>([^<]*)<\/Domain>/.exec(String(xml ?? ''));
  if (!m) return [];
  const out = new Set();
  for (const part of m[1].split(',')) {
    const [startText, endText, periodText] = part.trim().split('/');
    const start = timeMs(startText);
    if (start === null) continue;
    const end = endText ? timeMs(endText) : null;
    const step = parseIsoDurationMs(periodText);
    if (end === null || step === null || end < start) {
      out.add(start);
      continue;
    }
    for (let t = start; t <= end && out.size < MAX_DOMAIN_TIMES; t += step) out.add(t);
  }
  return [...out].sort((a, b) => a - b).map((t) => new Date(t));
}

/**
 * Choose the loop frames: drop times newer than now − safetyLag (GIBS lists
 * frames before every server can deliver them), then walk back from the
 * newest kept time in `stepMin` buckets taking the latest available time in
 * each bucket. Returns chronological Dates (newest last), or [].
 */
export function pickSatelliteFrames(times, now = new Date(), opts = {}) {
  const frames = opts.frames ?? SATELLITE.frames;
  const stepMs = (opts.stepMin ?? SATELLITE.frameStepMin) * MIN_MS;
  const cutoff = +now - (opts.lagMin ?? SATELLITE.safetyLagMin) * MIN_MS;
  const avail = (times ?? [])
    .map(timeMs)
    .filter((t) => t !== null && t <= cutoff)
    .sort((a, b) => a - b);
  if (!avail.length || !(frames > 0) || !(stepMs > 0)) return [];
  const newest = avail[avail.length - 1];
  const out = [newest];
  let idx = avail.length - 1;
  for (let k = 1; out.length < frames; k++) {
    const target = newest - k * stepMs;
    if (target < avail[0] - stepMs) break;
    while (idx >= 0 && avail[idx] > target) idx--;
    if (idx < 0) break;
    // Only accept a time inside this bucket, so spacing stays regular across gaps.
    if (avail[idx] > target - stepMs && avail[idx] < out[out.length - 1]) out.push(avail[idx]);
  }
  return out.reverse().map((t) => new Date(t));
}

/** When the time list cannot be fetched: now − 60 min, floored to 10 min, skipping Himawari's daily gaps. */
export function fallbackSatelliteTime(now = new Date()) {
  const step = 10 * MIN_MS;
  let t = Math.floor((+now - 60 * MIN_MS) / step) * step;
  if (HIMAWARI_DAILY_GAPS.has(new Date(t).toISOString().slice(11, 16))) t -= step;
  return new Date(t);
}

/** RainViewer index -> { url, time } for the newest past radar frame, or null. */
export function radarTileInfo(index) {
  const past = index?.radar?.past;
  if (!Array.isArray(past) || !past.length) return null;
  const last = past[past.length - 1];
  const host = typeof index.host === 'string' ? index.host : '';
  // These strings end up in a tile URL template: allow plain hosts and paths only.
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(host)) return null;
  if (typeof last?.path !== 'string' || !/^\/[A-Za-z0-9/_.-]+$/.test(last.path)) return null;
  const time = isFiniteNum(last.time) ? new Date(last.time * 1000) : null;
  return { url: `${host}${last.path}/256/{z}/{x}/{y}/2/1_1.png`, time };
}

/** Longitude moved by whole turns to within ±180° of `ref` (keeps shapes continuous across the dateline). */
export function unwrapLon(lon, ref) {
  const d = lon - ref;
  // Leave in-range values untouched so coordinates stay bit-exact.
  return d >= -180 && d < 180 ? lon : ref + wrapLonDelta(d);
}

/** [{lat, lon}] -> [[lat, lon]] with each longitude unwrapped against the previous one (the first against `ref`). */
export function unwrapPath(points, ref = HOME.lon) {
  const out = [];
  let prev = ref;
  for (const p of points ?? []) {
    if (!validLatLon(p)) continue;
    const lon = unwrapLon(p.lon, prev);
    out.push([p.lat, lon]);
    prev = lon;
  }
  return out;
}

/**
 * GeoJSON Polygon / MultiPolygon -> Leaflet latlngs: an array of polygons,
 * each an array of rings of [lat, lon] (unwrapped around `ref`).
 */
export function geometryToPolygons(geometry, ref = HOME.lon) {
  if (!geometry) return [];
  let polys = [];
  if (geometry.type === 'Polygon') polys = [geometry.coordinates];
  else if (geometry.type === 'MultiPolygon') polys = geometry.coordinates;
  return (Array.isArray(polys) ? polys : [])
    .map((rings) =>
      (Array.isArray(rings) ? rings : [])
        .map((ring) =>
          unwrapPath(
            (Array.isArray(ring) ? ring : []).filter(Array.isArray).map(([lon, lat]) => ({ lat, lon })),
            ref,
          ),
        )
        .filter((r) => r.length >= 3),
    )
    .filter((p) => p.length);
}

/** Shoelace area of a [lat, lon] ring (x = lon); positive = counter-clockwise. */
export function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][1] - ring[i][1]) * (ring[j][0] + ring[i][0]);
  return a / 2;
}

/**
 * Outer rings of several geometries, all turned the same way round. Drawn as
 * one path with fill-rule "nonzero" they then paint as a union, so overlapping
 * forecast times do not stack into darker patches.
 */
export function unionRings(geometries, ref = HOME.lon) {
  const rings = [];
  for (const g of geometries ?? []) {
    for (const poly of geometryToPolygons(g, ref)) {
      const outer = poly[0];
      rings.push(signedArea(outer) < 0 ? outer.slice().reverse() : outer);
    }
  }
  return rings;
}

/** GDACS wind areas valid now or later (time ≥ now − 3 h), grouped by strength. */
export function activeWindAreas(windAreas, now = new Date(), maxAgeMs = WIND_AREA_MAX_AGE_MS) {
  const out = { 60: [], 90: [], 120: [] };
  for (const a of Array.isArray(windAreas) ? windAreas : []) {
    if (!a || !Object.hasOwn(out, a.kmh) || !a.feature?.geometry) continue;
    const t = timeMs(a.time);
    if (t === null || t < +now - maxAgeMs) continue;
    out[a.kmh].push(a);
  }
  return out;
}

/**
 * JTWC formation-alert corridor ("within N nm either side of a line from A
 * to B") as a stadium-shaped ring of [lat, lon]: both long sides at
 * `halfWidthKm` from the line, with rounded ends.
 */
export function corridorPolygon(from, to, halfWidthKm, capSteps = 10) {
  if (!validLatLon(from) || !validLatLon(to) || !(halfWidthKm > 0)) return [];
  const toU = { lat: to.lat, lon: unwrapLon(to.lon, from.lon) };
  const startBearing = bearingDeg(from, toU);
  const endBearing = (bearingDeg(toU, from) + 180) % 360;
  const pts = [];
  for (let i = 0; i <= capSteps; i++) pts.push(destinationPoint(toU, endBearing - 90 + (180 * i) / capSteps, halfWidthKm));
  for (let i = 0; i <= capSteps; i++) pts.push(destinationPoint(from, startBearing + 90 + (180 * i) / capSteps, halfWidthKm));
  return unwrapPath(pts, from.lon);
}

/** Arrow head at `to` for a line from `from` (a 3-point [lat, lon] polyline). */
export function arrowHead(from, to, lengthKm) {
  if (!validLatLon(from) || !validLatLon(to)) return [];
  const toU = { lat: to.lat, lon: unwrapLon(to.lon, from.lon) };
  const back = bearingDeg(toU, from);
  const len = lengthKm ?? Math.min(120, Math.max(40, haversineKm(from, toU) * 0.2));
  return unwrapPath([destinationPoint(toU, back - 28, len), toU, destinationPoint(toU, back + 28, len)], toU.lon);
}

/** IMD class key for a track point: its wind when known, else its GDACS/JTWC label. */
export function pointClassKey(p) {
  if (isFiniteNum(p?.windKt)) return imdClassKey(p.windKt);
  return CLS_TO_IMD[p?.cls] ?? 'imd.low';
}

/** Points ([lat, lon]) that describe where a system is now and is forecast to go. */
export function systemFitPoints(analysis, home = HOME, now = new Date()) {
  const s = analysis?.system;
  if (!s || !validLatLon(s.position)) return [];
  const ref = unwrapLon(s.position.lon, home.lon);
  const pts = [[s.position.lat, ref]];
  const nowMs = +now;
  const future = (Array.isArray(s.track) ? s.track : []).filter((p) => {
    if (!p?.forecast || !validLatLon(p)) return false;
    const t = timeMs(p.time);
    return t === null || t >= nowMs - HOUR_MS;
  });
  pts.push(...unwrapPath(future, ref));
  if (validLatLon(s.tcfa?.from) && validLatLon(s.tcfa?.to)) pts.push(...unwrapPath([s.tcfa.from, s.tcfa.to], ref));
  return pts;
}

/**
 * Everything the default view should show: Yangon, every relevant system in
 * the region or within FIT_NEAR_KM (position, forecast track, TCFA corridor)
 * and a current DMH position. Empty when there is nothing but Yangon (the
 * caller then uses the Bay of Bengal default view).
 */
export function fitPoints(analyses, dmh, home = HOME, now = new Date()) {
  const pts = [];
  for (const a of Array.isArray(analyses) ? analyses : []) {
    if (a?.relevant && (a.inRegion || a.distanceKm <= FIT_NEAR_KM)) pts.push(...systemFitPoints(a, home, now));
  }
  const b = dmh?.bulletin;
  if (b?.isCurrent && validLatLon(b)) pts.push([b.lat, unwrapLon(b.lon, home.lon)]);
  return pts.length ? [[home.lat, home.lon], ...pts] : [];
}

// ---------------------------------------------------------------------------
// Formatting fallbacks (the page normally passes t and fmt)
// ---------------------------------------------------------------------------

function fillParams(text, params) {
  if (!params) return text;
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (params[k] == null ? m : String(params[k])));
}

function fallbackT(key, params) {
  return fillParams(enMap[key] ?? key, params);
}

const YANGON_TIME = { timeZone: HOME.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

function normaliseFmt(f = {}) {
  const fn = (v) => (typeof v === 'function' ? v : null);
  const time = fn(f?.time) ?? ((d) => new Intl.DateTimeFormat('en-GB', YANGON_TIME).format(d));
  return {
    distance: fn(f?.distance) ?? ((km) => `${Math.round(km)} km`),
    wind: fn(f?.wind) ?? ((kmh) => `${Math.round(kmh)} km/h`),
    time,
    dateTime:
      fn(f?.dateTime) ??
      (f?.time ? time : (d) => new Intl.DateTimeFormat('en-GB', { ...YANGON_TIME, weekday: 'short', day: 'numeric', month: 'short' }).format(d)),
    number: fn(f?.number),
  };
}

// ---------------------------------------------------------------------------
// Static icon markup (constants only — never interpolate data into these)
// ---------------------------------------------------------------------------

const SVG_ATTRS = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  satellite: `<svg ${SVG_ATTRS} ${STROKE}><path d="M7.2 18.5h9.6a3.9 3.9 0 0 0 .5-7.77A5.6 5.6 0 0 0 6.4 11.9a3.3 3.3 0 0 0 .8 6.6Z"/></svg>`,
  radar: `<svg ${SVG_ATTRS} ${STROKE}><path d="M7 14.5a4.5 4.5 0 0 1 .3-9 5.2 5.2 0 0 1 9.9 1.3 3.9 3.9 0 0 1-.4 7.7"/><path d="M9 17l-1 2.5M13 16l-1 2.5M17 17l-1 2.5"/></svg>`,
  tracks: `<svg ${SVG_ATTRS} ${STROKE}><path d="M4.5 19.5c3-.8 4.4-3.6 6-6.5s3.6-6.3 9-7.5" stroke-dasharray="3 2.6"/><circle cx="4.5" cy="19.5" r="1.6"/><circle cx="19.5" cy="5.5" r="1.6"/></svg>`,
  wind: `<svg ${SVG_ATTRS} ${STROKE}><path d="M3.5 8.5h10a3 3 0 1 0-3-3"/><path d="M3.5 12.5h14.5a3 3 0 1 1-3 3"/><path d="M3.5 16.5h7"/></svg>`,
  rings: `<svg ${SVG_ATTRS} ${STROKE}><circle cx="12" cy="12" r="2"/><circle cx="12" cy="12" r="5.8"/><circle cx="12" cy="12" r="9.5"/></svg>`,
  check: `<svg ${SVG_ATTRS} fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12.5l4.2 4.2 8.8-9.4"/></svg>`,
  play: `<svg ${SVG_ATTRS}><path fill="currentColor" d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2Z"/></svg>`,
  pause: `<svg ${SVG_ATTRS}><rect fill="currentColor" x="6.5" y="5" width="4" height="14" rx="1"/><rect fill="currentColor" x="13.5" y="5" width="4" height="14" rx="1"/></svg>`,
  step: `<svg ${SVG_ATTRS}><path fill="currentColor" d="M5.5 5.6v12.8a.8.8 0 0 0 1.2.7l9-6.4a.8.8 0 0 0 0-1.4l-9-6.4a.8.8 0 0 0-1.2.7Z"/><rect fill="currentColor" x="16.5" y="5" width="2.6" height="14" rx="1"/></svg>`,
  fit: `<svg ${SVG_ATTRS} ${STROKE}><path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/><circle cx="12" cy="12" r="2.5"/></svg>`,
};

// Northern-hemisphere tropical cyclone symbol: filled eye with two arms.
const GLYPH_ARMS = 'M15.4 11.2C16.3 6.6 12.9 3.2 7.6 3.6M8.6 12.8C7.7 17.4 11.1 20.8 16.4 20.4';
const safeColor = (c) => (/^#[0-9a-f]{3,8}$/i.test(String(c)) ? c : '#9a988f');

function glyphSvg(color, size = 34) {
  const c = safeColor(color);
  return (
    `<svg class="ymap-glyph" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false">` +
    `<path class="ymap-glyph-casing" d="${GLYPH_ARMS}" fill="none" stroke-width="5" stroke-linecap="round"/>` +
    `<path d="${GLYPH_ARMS}" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>` +
    `<circle class="ymap-glyph-core" cx="12" cy="12" r="4" fill="${c}" stroke-width="1.6"/></svg>`
  );
}

const HOME_PIN =
  '<svg class="ymap-pin" viewBox="0 0 32 40" width="32" height="40" aria-hidden="true" focusable="false">' +
  '<path class="ymap-pin-body" d="M16 38.5S4 26.6 4 16.2a12 12 0 0 1 24 0C28 26.6 16 38.5 16 38.5Z" stroke-width="2"/>' +
  '<path class="ymap-pin-house" d="M10 16.8 16 11.5l6 5.3V23h-4.2v-4h-3.6v4H10Z"/></svg>';

function lineSwatch(dashed) {
  const dash = dashed ? ' stroke-dasharray="7 6"' : '';
  return (
    '<svg class="ymap-sw" viewBox="0 0 40 14" width="40" height="14" aria-hidden="true" focusable="false">' +
    `<line class="ymap-sw-casing" x1="3" y1="7" x2="37" y2="7" stroke-width="5" stroke-linecap="round"/>` +
    `<line class="ymap-sw-track" x1="3" y1="7" x2="37" y2="7" stroke-width="2"${dash}/></svg>`
  );
}

function areaSwatch(cls, { dashed = false, round = false } = {}) {
  const dash = dashed ? ' stroke-dasharray="4 3"' : '';
  const shape = round
    ? `<circle class="${cls}" cx="20" cy="9" r="7.5" stroke-width="1.5"${dash}/>`
    : `<rect class="${cls}" x="2" y="2" width="36" height="14" rx="3" stroke-width="1.5"${dash}/>`;
  return `<svg class="ymap-sw" viewBox="0 0 40 18" width="40" height="18" aria-hidden="true" focusable="false">${shape}</svg>`;
}

function dotSwatch(color) {
  return (
    '<svg class="ymap-sw ymap-sw-dot" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">' +
    `<circle class="ymap-pt-swatch" cx="8" cy="8" r="5.5" fill="${safeColor(color)}" stroke-width="2"/></svg>`
  );
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

let uidCounter = 0;
const uid = (prefix) => `${prefix}-${++uidCounter}`;

/** Tiny element builder. `text` -> textContent; `html` is for the static ICONS only. */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c);
  }
  return node;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loadLayerState() {
  const state = { ...LAYER_DEFAULTS };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      for (const k of LAYER_NAMES) if (typeof saved[k] === 'boolean') state[k] = saved[k];
    }
  } catch {
    /* storage blocked or corrupt: defaults */
  }
  return state;
}

function saveLayerState(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Windy
// ---------------------------------------------------------------------------

/**
 * Create the Windy.com embed inside `container` (once). Nothing is loaded
 * from Windy until this is called.
 * @returns {HTMLIFrameElement|null}
 */
export function mountWindy(container, home = HOME, { title } = {}) {
  if (!container) return null;
  const existing = container.querySelector('iframe.ymap-windy-frame');
  if (existing) return existing;
  const lat = (validLatLon(home) ? home : HOME).lat.toFixed(3);
  const lon = (validLatLon(home) ? home : HOME).lon.toFixed(3);
  const iframe = document.createElement('iframe');
  iframe.className = 'ymap-windy-frame';
  iframe.title = title || enMap['map.windy.title'];
  iframe.loading = 'lazy';
  iframe.setAttribute('loading', 'lazy');
  iframe.allowFullscreen = true;
  iframe.setAttribute('allowfullscreen', '');
  iframe.src = URLS.windyEmbed(lat, lon);
  container.append(iframe);
  return iframe;
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

function unavailableController(el, t) {
  el?.replaceChildren(h('p', { class: 'ymap-unavailable', text: t('map.unavailable') }));
  const noop = () => {};
  return { setData: noop, setTheme: noop, setLang: noop, focusSystem: () => false, fitAll: noop, invalidate: noop, destroy: noop, map: null };
}

/**
 * Create the storm map in `el`.
 * @param {HTMLElement} el  map container (gets class "ymap")
 * @param {object} [options]
 * @param {{lat:number, lon:number}} [options.home]
 * @param {string} [options.theme]  informational; colours follow the CSS theme tokens
 * @param {string} [options.lang]   'en' | 'my'
 * @param {(key:string, params?:object)=>string} [options.t]
 * @param {{distance:(km)=>string, wind:(kmh)=>string, time:(Date)=>string, dateTime?:(Date)=>string, number?:(n)=>string}} [options.fmt]
 * @param {HTMLElement} [options.controlsEl]  where the control bar is rendered (created above `el` if omitted)
 * @param {HTMLElement} [options.windyEl]     panel for the Windy tab (created after `el` if omitted)
 * @param {() => Date} [options.now]
 */
export function createMap(el, options = {}) {
  let t = typeof options.t === 'function' ? options.t : fallbackT;
  if (!el) throw new TypeError('createMap: a container element is required');
  const L = globalThis.L;
  if (!L || typeof L.map !== 'function') return unavailableController(el, t);

  const home = validLatLon(options.home) ? options.home : HOME;
  const nowFn = typeof options.now === 'function' ? options.now : () => new Date();
  let fmt = normaliseFmt(options.fmt);
  let lang = options.lang || 'en';
  let theme = options.theme || 'auto';
  let data = { analyses: [], dmh: null };
  let destroyed = false;
  let userMoved = false;
  let activeTab = 'map';
  const layerState = loadLayerState();
  const markerById = new Map();
  const cleanups = [];

  const mq = (q) => (typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia(q) : null);
  const mqReduce = mq('(prefers-reduced-motion: reduce)');
  const reduced = () => Boolean(mqReduce?.matches);
  const coarse = Boolean(mq('(pointer: coarse)')?.matches);

  const on = (target, type, fn, opts) => {
    target?.addEventListener?.(type, fn, opts);
    cleanups.push(() => target?.removeEventListener?.(type, fn, opts));
  };
  const safe = (fn, fallback = '') => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const num = (n) =>
    fmt.number
      ? safe(() => fmt.number(n), String(n))
      : safe(() => new Intl.NumberFormat(lang === 'my' ? 'my-u-nu-mymr' : 'en').format(n), String(n));
  const fDist = (km) => (isFiniteNum(km) ? safe(() => fmt.distance(km)) : '');
  const fWind = (kmh) => (isFiniteNum(kmh) ? safe(() => fmt.wind(kmh)) : '');
  const fTime = (d) => (timeMs(d) !== null ? safe(() => fmt.time(new Date(timeMs(d)))) : '');
  const fDateTime = (d) => (timeMs(d) !== null ? safe(() => fmt.dateTime(new Date(timeMs(d)))) : '');
  const dirLabel = (code) => (code ? t(`dir.${code}`) : '');
  // "JTWC warning" only when JTWC really is a source; GDACS-only storms get a neutral label.
  const kindLabel = (s) =>
    s?.kind === 'tcfa' || s?.kind === 'invest'
      ? t(`jtwc.kind.${s.kind}`)
      : (s?.sources ?? []).includes('jtwc')
        ? t('jtwc.kind.warning')
        : t('map.kind.warning');

  // --- containers ----------------------------------------------------------
  el.classList.add('ymap');
  if (!el.id) el.id = uid('ymap-map');
  el.setAttribute('role', 'tabpanel');

  const ownControls = !options.controlsEl;
  const controlsEl = options.controlsEl || h('div', { class: 'ymap-controls' });
  if (ownControls) el.before(controlsEl);

  const ownWindy = !options.windyEl;
  const windyEl = options.windyEl || h('div');
  windyEl.classList.add('ymap-windy');
  if (!windyEl.id) windyEl.id = uid('ymap-windy');
  windyEl.setAttribute('role', 'tabpanel');
  windyEl.hidden = true;
  const windyNote = h('p', { class: 'ymap-windy-note' });
  const windyFrameWrap = h('div', { class: 'ymap-windy-wrap' });
  windyEl.replaceChildren(windyNote, windyFrameWrap);
  if (ownWindy) el.after(windyEl);

  // --- Leaflet map -----------------------------------------------------------
  const defaultZoom = () => (el.clientWidth >= DEFAULT_VIEW.wideMinPx ? DEFAULT_VIEW.wideZoom : DEFAULT_VIEW.zoom);
  let map;
  try {
    // No initial view: it is set by the first setData() (or a default a tick
    // later), so tiles for a view that is replaced at once are never fetched.
    map = L.map(el, {
      minZoom: 2,
      maxZoom: 11,
      zoomControl: false,
      scrollWheelZoom: false,
      // On touch screens one-finger drags scroll the page until the map is tapped.
      dragging: !coarse,
      fadeAnimation: !reduced(),
      zoomAnimation: !reduced(),
      markerZoomAnimation: !reduced(),
      keyboard: true,
      attributionControl: true,
    });
  } catch (err) {
    console.warn('[map] Leaflet could not start', err);
    if (ownControls) controlsEl.remove();
    if (ownWindy) windyEl.remove();
    return unavailableController(el, t);
  }
  for (const [name, z] of Object.values(PANES)) map.createPane(name).style.zIndex = String(z);

  L.tileLayer(URLS.osmTiles, {
    pane: PANE.base,
    maxZoom: 19,
    className: 'ymap-base-tiles',
  }).addTo(map);

  const groups = {
    satellite: L.layerGroup(),
    radar: L.layerGroup(),
    tracks: L.layerGroup(),
    wind: L.layerGroup(),
    rings: L.layerGroup(),
  };
  const markersGroup = L.layerGroup().addTo(map);
  const homeGroup = L.layerGroup().addTo(map);

  let zoomControl = null;
  let fitControl = null;
  let attribution = '';
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');

  function buildAttribution() {
    const e = (k) => escapeHtml(t(k));
    return (
      `© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ${e('map.attr.contributors')}` +
      ` | ${e('map.attr.imagery')} <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a> / JMA Himawari` +
      ` | ${e('map.attr.radar')} <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>` +
      ` | ${e('map.attr.tracks')} JTWC, GDACS`
    );
  }

  function buildMapControls() {
    zoomControl?.remove();
    fitControl?.remove();
    zoomControl = L.control.zoom({ position: 'topleft', zoomInTitle: t('map.zoomIn'), zoomOutTitle: t('map.zoomOut') }).addTo(map);
    const Fit = L.Control.extend({
      onAdd() {
        const wrap = L.DomUtil.create('div', 'leaflet-bar ymap-fit');
        const btn = L.DomUtil.create('a', '', wrap);
        btn.href = '#';
        btn.setAttribute('role', 'button');
        btn.title = t('map.fit');
        btn.setAttribute('aria-label', t('map.fit'));
        btn.innerHTML = ICONS.fit;
        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.on(btn, 'click', (ev) => {
          L.DomEvent.preventDefault(ev);
          controller.fitAll();
        });
        return wrap;
      },
    });
    fitControl = new Fit({ position: 'topleft' }).addTo(map);
    if (attribution) map.attributionControl.removeAttribution(attribution);
    attribution = buildAttribution();
    map.attributionControl.addAttribution(attribution);
  }

  // --- control bar -------------------------------------------------------------
  const ui = buildControlBar();

  function buildControlBar() {
    const tabMap = h('button', { type: 'button', role: 'tab', class: 'ymap-tab', id: uid('ymap-tab'), 'aria-controls': el.id, 'aria-selected': 'true' });
    const tabWindy = h('button', { type: 'button', role: 'tab', class: 'ymap-tab', id: uid('ymap-tab'), 'aria-controls': windyEl.id, 'aria-selected': 'false', tabindex: '-1' });
    const tabs = h('div', { class: 'ymap-tabs', role: 'tablist' }, tabMap, tabWindy);
    // The map panel keeps its own descriptive aria-label (set in applyText).
    windyEl.setAttribute('aria-labelledby', tabWindy.id);

    const toggles = {};
    const layersRow = h('div', { class: 'ymap-layers', role: 'group' });
    for (const name of LAYER_NAMES) {
      const text = h('span', { class: 'ymap-toggle-text' });
      const button = h(
        'button',
        { type: 'button', class: 'ymap-toggle', 'data-layer': name, 'aria-pressed': String(layerState[name]) },
        h('span', { class: 'ymap-toggle-box', html: ICONS.check }),
        h('span', { class: 'ymap-toggle-icon', html: ICONS[name] }),
        text,
      );
      toggles[name] = { button, text };
      layersRow.append(button);
    }

    const playIcon = h('span', { class: 'ymap-play-icon' });
    const playText = h('span', { class: 'ymap-play-text' });
    const play = h('button', { type: 'button', class: 'ymap-play', disabled: true }, playIcon, playText);
    const slider = h('input', { type: 'range', class: 'ymap-slider', min: '0', max: '0', step: '1', value: '0', disabled: true });
    const satTime = h('span', { class: 'ymap-sattime' });
    const satRow = h('div', { class: 'ymap-satrow', role: 'group' }, play, slider, satTime);
    const radarTime = h('p', { class: 'ymap-radartime', hidden: true });

    const legendSummary = h('summary', { class: 'ymap-legend-summary' });
    const legendBody = h('div', { class: 'ymap-legend-body' });
    const legend = h('details', { class: 'ymap-legend' }, legendSummary, legendBody);
    const hint = h('p', { class: 'ymap-hint', id: uid('ymap-hint') });
    el.setAttribute('aria-describedby', hint.id);

    const mapOnly = h('div', { class: 'ymap-maponly' }, layersRow, satRow, radarTime, legend, hint);
    const status = h('p', { class: 'ymap-status', role: 'status', 'aria-live': 'polite' });
    const bar = h('div', { class: 'ymap-bar' }, tabs, mapOnly, status);
    controlsEl.replaceChildren(bar);

    on(tabMap, 'click', () => selectTab('map'));
    on(tabWindy, 'click', () => selectTab('windy'));
    on(tabs, 'keydown', (ev) => {
      const order = ['map', 'windy'];
      let next = null;
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') next = order[(order.indexOf(activeTab) + 1) % 2];
      else if (ev.key === 'Home') next = 'map';
      else if (ev.key === 'End') next = 'windy';
      if (!next) return;
      ev.preventDefault();
      selectTab(next);
      (next === 'map' ? tabMap : tabWindy).focus();
    });
    for (const name of LAYER_NAMES) on(toggles[name].button, 'click', () => setLayer(name, !layerState[name]));
    on(play, 'click', () => {
      if (reduced()) satStep();
      else if (sat.playing) satPause();
      else satPlay();
    });
    on(slider, 'input', () => {
      satPause();
      satShow(Number(slider.value));
    });

    return { tabs, tabMap, tabWindy, toggles, layersRow, play, playIcon, playText, slider, satTime, satRow, radarTime, legend, legendSummary, legendBody, hint, mapOnly, status };
  }

  function setStatus(text) {
    if (ui.status.textContent !== text) ui.status.textContent = text || '';
  }

  function applyText() {
    ui.tabs.setAttribute('aria-label', t('map.tabs.label'));
    ui.tabMap.textContent = t('map.tab.map');
    ui.tabWindy.textContent = t('map.tab.windy');
    ui.layersRow.setAttribute('aria-label', t('map.layers.label'));
    for (const name of LAYER_NAMES) ui.toggles[name].text.textContent = t(`map.layer.${name}`);
    ui.satRow.setAttribute('aria-label', t('map.sat.group'));
    ui.slider.setAttribute('aria-label', t('map.sat.slider'));
    ui.legendSummary.textContent = t('map.legend.title');
    ui.hint.textContent = t(coarse ? 'map.hint.touch' : 'map.hint.mouse');
    el.setAttribute('aria-label', t('map.aria'));
    windyNote.textContent = t('map.windy.note');
    const frame = windyFrameWrap.querySelector('iframe');
    if (frame) frame.title = t('map.windy.title');
    buildLegend();
  }

  function buildLegend() {
    const row = (swatchHtml, text) => h('li', { class: 'ymap-lg-row' }, h('span', { class: 'ymap-lg-sw', html: swatchHtml }), h('span', { text }));
    const section = (title, ...items) => h('div', { class: 'ymap-lg-section' }, h('p', { class: 'ymap-lg-title', text: title }), h('ul', { class: 'ymap-lg-list' }, ...items));

    const classes = [...IMD_CLASSES].reverse().map((c) => {
      const label = c.minKt > 0 ? `${t(c.key)} (${t('map.legend.from', { wind: fWind(Math.round(c.minKt * KT_TO_KMH)) })})` : t(c.key);
      return row(dotSwatch(INTENSITY_COLORS[c.key]), label);
    });
    const dmhBadge = `<span class="ymap-dmh-badge ymap-dmh-badge-static"><span class="ymap-dmh-swatch"></span>${escapeHtml(t('map.dmh.badge'))}</span>`;

    const satImg = h('img', { class: 'ymap-lg-img', src: URLS.gibsLegend, alt: t('map.legend.satImg'), loading: 'lazy', width: '420', height: '95' });
    satImg.addEventListener('error', () => satImg.remove(), { once: true });

    ui.legendBody.replaceChildren(
      section(
        t('map.legend.tracks'),
        row(lineSwatch(false), t('map.legend.trackObserved')),
        row(lineSwatch(true), t('map.legend.trackForecast')),
        row(glyphSvg(INTENSITY_COLORS['imd.cs'], 22), t('map.legend.position')),
        row(areaSwatch('ymap-sw-cone', { dashed: true }), t('map.legend.cone')),
        row(areaSwatch('ymap-sw-tcfa', { dashed: true }), t('map.legend.tcfa')),
        row(areaSwatch('ymap-sw-invest', { dashed: true, round: true }), t('map.legend.invest')),
      ),
      h('div', { class: 'ymap-lg-section' }, h('p', { class: 'ymap-lg-title', text: t('map.legend.points') }), h('ul', { class: 'ymap-lg-list ymap-lg-classes' }, ...classes)),
      section(
        t('map.legend.windTitle'),
        ...WIND_STRENGTHS.map((kmh) => row(areaSwatch(`ymap-sw-wind-${kmh}`), t('map.legend.wind', { wind: fWind(kmh) }))),
      ),
      section(
        t('map.legend.placesTitle'),
        row(dmhBadge, t('map.legend.dmh')),
        row(HOME_PIN.replace('width="32" height="40"', 'width="16" height="20"'), t('map.legend.home')),
        row(areaSwatch('ymap-sw-ring', { round: true }), t('map.legend.rings')),
      ),
      h('div', { class: 'ymap-lg-section ymap-lg-wide' }, h('p', { class: 'ymap-lg-title', text: t('map.legend.satTitle') }), h('p', { class: 'ymap-lg-text', text: t('map.legend.sat') }), h('div', { class: 'ymap-lg-imgwrap' }, satImg)),
      h('div', { class: 'ymap-lg-section ymap-lg-wide' }, h('p', { class: 'ymap-lg-title', text: t('map.legend.radarTitle') }), h('p', { class: 'ymap-lg-text', text: t('map.legend.radar') })),
      h('p', { class: 'ymap-lg-note', text: t('map.legend.note') }),
    );
  }

  // --- tabs ------------------------------------------------------------------
  function selectTab(name) {
    if (name !== 'map' && name !== 'windy') return;
    activeTab = name;
    const isMap = name === 'map';
    ui.tabMap.setAttribute('aria-selected', String(isMap));
    ui.tabWindy.setAttribute('aria-selected', String(!isMap));
    ui.tabMap.tabIndex = isMap ? 0 : -1;
    ui.tabWindy.tabIndex = isMap ? -1 : 0;
    el.hidden = !isMap;
    windyEl.hidden = isMap;
    ui.mapOnly.hidden = !isMap;
    if (isMap) {
      map.invalidateSize();
    } else {
      satPause();
      mountWindy(windyFrameWrap, home, { title: t('map.windy.title') });
    }
    satUpdateUi();
  }

  // --- layer switches ----------------------------------------------------------
  function setLayer(name, value) {
    if (!LAYER_NAMES.includes(name)) return;
    layerState[name] = Boolean(value);
    if (layerState[name]) groups[name].addTo(map);
    else groups[name].remove();
    ui.toggles[name].button.setAttribute('aria-pressed', String(layerState[name]));
    saveLayerState(layerState);
    if (name === 'satellite') {
      if (!layerState.satellite) satPause();
      else if (!sat.frames.length || Date.now() - sat.fetchedAt > SAT_REFRESH_MS) satRefresh();
      satUpdateUi();
    }
    if (name === 'radar') {
      if (layerState.radar) radarRefresh();
      radarUpdateUi();
    }
  }

  // --- satellite (GIBS Himawari IR) ---------------------------------------------------
  const sat = { frames: [], layers: [], ready: [], index: -1, playing: false, loading: false, timer: 0, steppedBack: false, fetchedAt: 0, refreshing: false, source: 'none' };

  async function satRefresh() {
    if (sat.refreshing || sat.playing || destroyed) return;
    sat.refreshing = true;
    satUpdateUi();
    const now = nowFn();
    let frames = [];
    let source = 'domains';
    try {
      const xml = await fetchText(gibsDomainsUrl(now), { timeoutMs: NETWORK_TIMEOUT_MS });
      frames = pickSatelliteFrames(parseGibsDomains(xml), now);
    } catch {
      frames = [];
    }
    if (!frames.length) {
      frames = [fallbackSatelliteTime(now)];
      source = 'fallback';
    }
    sat.refreshing = false;
    if (destroyed || sat.playing) return;
    sat.fetchedAt = Date.now();
    const unchanged = frames.length === sat.frames.length && frames.every((f, i) => +f === +sat.frames[i]);
    if (!unchanged) satSetFrames(frames, source);
    else satUpdateUi();
  }

  function satClearLayers() {
    for (const layer of sat.layers) if (layer) groups.satellite.removeLayer(layer);
    sat.layers = [];
    sat.ready = [];
  }

  function satSetFrames(frames, source) {
    satClearLayers();
    sat.frames = frames;
    sat.layers = frames.map(() => null);
    sat.ready = frames.map(() => false);
    sat.steppedBack = false;
    sat.source = source;
    sat.index = -1;
    satShow(frames.length - 1);
  }

  function satEnsureLayer(i) {
    if (sat.layers[i]) return sat.layers[i];
    const layer = L.tileLayer(URLS.gibsTile, {
      time: gibsTime(sat.frames[i]),
      pane: PANE.satellite,
      opacity: 0,
      maxNativeZoom: SATELLITE.maxNativeZoom,
      maxZoom: 12,
      crossOrigin: 'anonymous',
      className: 'ymap-sat-frame',
    });
    layer.on('loading', () => {
      const k = sat.layers.indexOf(layer);
      if (k >= 0) sat.ready[k] = false;
    });
    layer.on('load', () => {
      const k = sat.layers.indexOf(layer);
      if (k >= 0) sat.ready[k] = true;
    });
    // GIBS lists frames before every one of its servers can deliver them, so
    // the newest frame can come back with holes (some tiles 404 at random for
    // a while). Any failed tile in the newest frame: fall back 10 min, once.
    layer.on('tileerror', () => {
      const k = sat.layers.indexOf(layer);
      if (sat.steppedBack || k !== sat.frames.length - 1) return;
      sat.steppedBack = true;
      const wasCurrent = sat.index === k;
      groups.satellite.removeLayer(layer);
      const older = new Date(+sat.frames[k] - 10 * MIN_MS);
      if (k > 0 && +sat.frames[k - 1] >= +older) {
        sat.frames.splice(k, 1);
        sat.layers.splice(k, 1);
        sat.ready.splice(k, 1);
      } else {
        sat.frames[k] = older;
        sat.layers[k] = null;
        sat.ready[k] = false;
      }
      if (wasCurrent) {
        sat.index = -1;
        satShow(sat.frames.length - 1);
      } else satUpdateUi();
    });
    sat.layers[i] = layer;
    sat.ready[i] = false;
    groups.satellite.addLayer(layer);
    return layer;
  }

  /** Show frame i. The previous frame stays visible until i has loaded, so scrubbing never flashes blank. */
  function satShow(i) {
    const n = sat.frames.length;
    if (!n) return satUpdateUi();
    const k = Math.max(0, Math.min(n - 1, Math.round(i)));
    const layer = satEnsureLayer(k);
    layer.setOpacity(SATELLITE.opacity);
    sat.index = k;
    const hideOthers = () => {
      if (sat.index !== k) return;
      sat.layers.forEach((l, j) => {
        if (l && j !== k) l.setOpacity(0);
      });
    };
    if (sat.ready[k] || !layerState.satellite) hideOthers();
    else {
      layer.once('load', hideOthers);
      setTimeout(hideOthers, 5000);
    }
    satUpdateUi();
  }

  function waitForLayer(i, timeoutMs) {
    const layer = sat.layers[i];
    if (!layer || sat.ready[i]) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done() {
        clearTimeout(timer);
        layer.off('load', done);
        resolve();
      }
      layer.on('load', done);
    });
  }

  async function satPlay() {
    if (sat.playing || sat.frames.length < 2 || !layerState.satellite || reduced()) return;
    sat.playing = true;
    sat.loading = true;
    satUpdateUi();
    setStatus(t('map.sat.loading'));
    sat.frames.forEach((_, i) => satEnsureLayer(i));
    await Promise.all(sat.frames.map((_, i) => waitForLayer(i, LOOP_PRELOAD_TIMEOUT_MS)));
    sat.loading = false;
    setStatus('');
    if (!sat.playing || destroyed) return satUpdateUi();
    let i = sat.index >= sat.frames.length - 1 ? 0 : sat.index + 1;
    const tick = () => {
      if (!sat.playing || destroyed) return;
      const n = sat.frames.length;
      if (n < 2) return satPause();
      i = Math.min(i, n - 1);
      satEnsureLayer(i); // a frame replaced after a tile error needs a fresh layer
      // During the loop every frame is preloaded, so switch opacity directly (CSS cross-fades it).
      sat.layers.forEach((l, j) => l?.setOpacity(j === i ? SATELLITE.opacity : 0));
      sat.index = i;
      satUpdateUi();
      const delay = i === n - 1 ? LOOP_HOLD_MS : LOOP_FRAME_MS;
      i = (i + 1) % n;
      sat.timer = setTimeout(tick, delay);
    };
    tick();
  }

  function satPause() {
    const was = sat.playing;
    sat.playing = false;
    sat.loading = false;
    clearTimeout(sat.timer);
    if (was) {
      setStatus('');
      satUpdateUi();
    }
  }

  function satStep() {
    if (sat.frames.length < 2) return;
    satPause();
    satShow((sat.index + 1) % sat.frames.length);
  }

  function ago(d) {
    const minutes = Math.max(0, Math.round((+nowFn() - +d) / MIN_MS));
    return minutes < 120 ? t('map.ago.minutes', { n: num(minutes) }) : t('map.ago.hours', { n: num(Math.round(minutes / 60)) });
  }

  function satUpdateUi() {
    const n = sat.frames.length;
    const onMap = layerState.satellite && activeTab === 'map';
    const canMove = onMap && n >= 2;
    const mode = reduced() ? 'step' : sat.playing ? 'pause' : 'play';
    ui.play.disabled = !canMove;
    ui.play.dataset.mode = mode;
    ui.playIcon.innerHTML = ICONS[mode];
    ui.playText.textContent = t(`map.sat.${mode}`);
    ui.play.setAttribute('aria-label', t(`map.sat.${mode}Label`));
    ui.play.setAttribute('aria-busy', String(sat.loading));
    ui.slider.disabled = !canMove;
    ui.slider.max = String(Math.max(0, n - 1));
    ui.slider.value = String(Math.max(0, sat.index));

    let text;
    let valueText = '';
    if (!layerState.satellite) text = t('map.sat.off');
    else if (!n || sat.index < 0) text = sat.refreshing ? t('map.sat.loading') : t('map.sat.unavailable');
    else {
      const d = sat.frames[sat.index];
      valueText = fTime(d);
      const parts = [t('map.sat.time', { when: valueText }), ago(d)];
      if (sat.index === n - 1) parts.push(t('map.sat.newest'));
      text = parts.join(' · ');
      if (sat.source === 'fallback') text += ` — ${t('map.sat.latestOnly')}`;
    }
    ui.satTime.textContent = text;
    if (valueText) ui.slider.setAttribute('aria-valuetext', valueText);
    else ui.slider.removeAttribute('aria-valuetext');
  }

  // --- rain radar (RainViewer) -----------------------------------------------------
  const radar = { layer: null, time: null, fetchedAt: 0, loading: false, failed: false };

  async function radarRefresh() {
    if (radar.loading || destroyed) return;
    if (radar.layer && Date.now() - radar.fetchedAt < RADAR_REFRESH_MS) return;
    radar.loading = true;
    radarUpdateUi();
    try {
      const info = radarTileInfo(await fetchJson(URLS.rainviewerIndex, { timeoutMs: NETWORK_TIMEOUT_MS }));
      if (!info) throw new Error('no radar frame in the RainViewer index');
      if (destroyed) return;
      if (radar.layer) radar.layer.setUrl(info.url);
      else {
        radar.layer = L.tileLayer(info.url, {
          pane: PANE.radar,
          opacity: RADAR_OPACITY,
          maxNativeZoom: RADAR_MAX_NATIVE_ZOOM,
          maxZoom: 12,
          className: 'ymap-radar-tiles',
        });
        groups.radar.addLayer(radar.layer);
      }
      radar.time = info.time;
      radar.fetchedAt = Date.now();
      radar.failed = false;
    } catch {
      radar.failed = true;
    } finally {
      radar.loading = false;
      radarUpdateUi();
    }
  }

  function radarUpdateUi() {
    const show = layerState.radar;
    ui.radarTime.hidden = !show;
    if (!show) return;
    if (radar.loading && !radar.layer) ui.radarTime.textContent = t('map.radar.loading');
    else if (radar.failed && !radar.layer) ui.radarTime.textContent = t('map.radar.unavailable');
    else if (radar.time) ui.radarTime.textContent = `${t('map.radar.time', { when: fTime(radar.time) })} · ${ago(radar.time)}`;
    else ui.radarTime.textContent = '';
  }

  // --- static layers: Yangon pin and range rings ----------------------------------------
  function renderStatic() {
    homeGroup.clearLayers();
    groups.rings.clearLayers();
    ringLabels.length = 0;
    const pin = h('div', { class: 'ymap-home' }, h('span', { class: 'ymap-home-pin', html: HOME_PIN }), h('span', { class: 'ymap-label ymap-home-label', text: t('map.home') }));
    L.marker([home.lat, home.lon], {
      icon: L.divIcon({ className: 'ymap-home-icon', html: pin, iconSize: [32, 40], iconAnchor: [16, 39] }),
      pane: PANE.home,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(homeGroup);

    for (const km of RANGE_RINGS_KM) {
      L.polygon(circlePolygon(home, km, 144), {
        pane: PANE.overlays,
        className: 'ymap-ring',
        color: '#6f6d68',
        weight: 1,
        opacity: 0.8,
        fill: false,
        interactive: false,
      }).addTo(groups.rings);
      // Labels sit due south, over the Gulf of Mottama, away from most place names.
      const at = destinationPoint(home, 180, km);
      const label = L.marker([at.lat, at.lon], {
        icon: L.divIcon({ className: 'ymap-ring-icon', html: h('span', { class: 'ymap-ring-label', text: fDist(km) }), iconSize: [0, 0], iconAnchor: [0, 0] }),
        pane: PANE.overlays,
        interactive: false,
        keyboard: false,
      });
      label.on('add', placeLabels);
      ringLabels.push(label);
      label.addTo(groups.rings);
    }
  }

  // --- data layers: systems and DMH --------------------------------------------------
  function renderData() {
    groups.tracks.clearLayers();
    groups.wind.clearLayers();
    markersGroup.clearLayers();
    markerById.clear();
    labelled.length = 0;
    const now = nowFn();
    for (const a of data.analyses) {
      try {
        drawSystem(a, now);
      } catch (err) {
        console.warn('[map] skipped a system that could not be drawn', a?.system?.id, err);
      }
    }
    try {
      drawDmh();
    } catch (err) {
      console.warn('[map] could not draw the DMH position', err);
    }
    placeLabels();
  }

  function systemLabel(s) {
    return String(s?.name || s?.designation || '').trim() || '—';
  }

  function drawSystem(a, now) {
    const s = a?.system;
    if (!s || !validLatLon(s.position)) return;
    const ref = unwrapLon(s.position.lon, home.lon);
    const label = systemLabel(s);
    const classKey = a.imdClassKey || 'imd.low';
    const color = INTENSITY_COLORS[classKey] ?? INTENSITY_COLORS['imd.low'];
    const pos = [s.position.lat, ref];

    // Forecast cone.
    const cone = geometryToPolygons(s.cone?.geometry, ref);
    if (cone.length) {
      L.polygon(cone, {
        pane: PANE.overlays,
        className: 'ymap-cone',
        color: '#52514e',
        weight: 1.5,
        opacity: 0.75,
        dashArray: '5 5',
        fillOpacity: CONE_FILL_OPACITY,
      })
        .bindTooltip(t('map.cone', { label }), { sticky: true, className: 'ymap-tip' })
        .addTo(groups.tracks);
    }

    // Wind areas: union per strength of every area valid from now on.
    const active = activeWindAreas(s.windAreas, now);
    for (const kmh of WIND_STRENGTHS) {
      const rings = unionRings(active[kmh].map((w) => w.feature.geometry), ref);
      if (!rings.length) continue;
      L.polygon(
        rings.map((r) => [r]),
        {
          pane: PANE.overlays,
          className: `ymap-wind ymap-wind-${kmh}`,
          weight: 1.25,
          opacity: 0.75,
          fillOpacity: WIND_FILL_OPACITY[kmh],
          fillRule: 'nonzero',
        },
      )
        .bindTooltip(t('map.windArea', { label, wind: fWind(kmh) }), { sticky: true, className: 'ymap-tip' })
        .addTo(groups.wind);
    }

    // JTWC formation-alert corridor with a direction arrow.
    const tcfa = s.tcfa;
    if (validLatLon(tcfa?.from) && validLatLon(tcfa?.to) && tcfa.halfWidthKm > 0) {
      const from = { lat: tcfa.from.lat, lon: unwrapLon(tcfa.from.lon, ref) };
      const to = { lat: tcfa.to.lat, lon: unwrapLon(tcfa.to.lon, from.lon) };
      const band = corridorPolygon(from, to, tcfa.halfWidthKm);
      if (band.length) {
        L.polygon(band, { pane: PANE.overlays, className: 'ymap-tcfa', weight: 1.5, opacity: 0.9, dashArray: '6 4', fillOpacity: 0.14 })
          .bindTooltip(t('map.tcfa', { label }), { sticky: true, className: 'ymap-tip' })
          .addTo(groups.tracks);
        const axisOpts = { pane: PANE.tracks, className: 'ymap-tcfa-axis', weight: 2.5, opacity: 0.95, interactive: false, lineCap: 'round', lineJoin: 'round' };
        L.polyline(unwrapPath([from, to], from.lon), axisOpts).addTo(groups.tracks);
        L.polyline(arrowHead(from, to), axisOpts).addTo(groups.tracks);
      }
    }

    // Invest: dashed circle around the disturbance.
    if (s.kind === 'invest') {
      L.polygon(circlePolygon({ lat: s.position.lat, lon: ref }, INVEST_RADIUS_KM, 72), {
        pane: PANE.overlays,
        className: 'ymap-invest',
        weight: 2,
        dashArray: '6 6',
        fillOpacity: 0.06,
        interactive: false,
      }).addTo(groups.tracks);
    }

    // Track: observed solid, forecast dashed, both with a casing so they read over satellite imagery.
    const posMs = timeMs(s.position.time);
    const track = (Array.isArray(s.track) ? s.track : [])
      .filter((p) => validLatLon(p))
      .map((p) => ({ ...p, _t: timeMs(p.time) }))
      .sort((x, y) => (x._t ?? 0) - (y._t ?? 0));
    const observed = track.filter((p) => !p.forecast && (posMs === null || p._t === null || p._t <= posMs));
    const forecast = track.filter((p) => p.forecast && (posMs === null || p._t === null || p._t > posMs));
    const obsPath = unwrapPath([...observed, s.position], ref);
    const fcPath = unwrapPath([s.position, ...forecast], ref);
    const line = (path, dashed) => {
      if (path.length < 2) return;
      L.polyline(path, { pane: PANE.tracks, className: 'ymap-track-casing', weight: 5, opacity: 0.85, interactive: false, lineCap: 'round', lineJoin: 'round' }).addTo(groups.tracks);
      L.polyline(path, { pane: PANE.tracks, className: 'ymap-track', weight: 2, interactive: false, dashArray: dashed ? '7 6' : null, lineJoin: 'round' }).addTo(groups.tracks);
    };
    line(obsPath, false);
    line(fcPath, true);

    let prevLon = ref;
    for (const p of track) {
      const lon = unwrapLon(p.lon, prevLon);
      prevLon = lon;
      const key = pointClassKey(p);
      const params = {
        kind: t(p.forecast ? 'map.popup.forecast' : 'map.popup.observed'),
        when: fDateTime(p.time),
        strength: t(key),
        wind: isFiniteNum(p.windKt) ? fWind(p.windKt * KT_TO_KMH) : '',
      };
      L.circleMarker([p.lat, lon], {
        pane: PANE.tracks,
        className: 'ymap-pt',
        radius: 5,
        weight: 2,
        color: '#fcfcfb',
        fillColor: INTENSITY_COLORS[key] ?? INTENSITY_COLORS['imd.low'],
        fillOpacity: 1,
      })
        .bindTooltip(t(params.wind ? 'map.point' : 'map.point.noWind', params), { className: 'ymap-tip', direction: 'top', offset: [0, -6] })
        .addTo(groups.tracks);
    }

    // Current position.
    const where = t('map.popup.distance', { dist: fDist(a.distanceKm), dir: dirLabel(a.compassFromHome) });
    const kind = kindLabel(s);
    const tag =
      s.kind === 'invest' && s.potential ? t('map.invest', { label, chance: t(`jtwc.potential.${s.potential}`) }) : label;
    const iconEl = h('div', { class: 'ymap-sys' }, h('span', { class: 'ymap-sys-glyph', html: glyphSvg(color) }), h('span', { class: 'ymap-label ymap-sys-label', text: tag }));
    const aria = t('map.system.label', { label, kind, where });
    const marker = L.marker(pos, {
      icon: L.divIcon({ className: 'ymap-sys-icon', html: iconEl, iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -14] }),
      pane: PANE.markers,
      keyboard: true,
      riseOnHover: true,
      zIndexOffset: 100,
    })
      .bindPopup(() => systemPopup(a), { className: 'ymap-popup', maxWidth: 300, autoPanPadding: [16, 16] });
    marker.on('add', () => marker.getElement()?.setAttribute('aria-label', aria));
    marker.addTo(markersGroup);
    labelled.push({ marker, root: iconEl });
    markerById.set(s.id, { marker, analysis: a });
  }

  function popupRoot(title, subtitle) {
    const root = h('div', { class: 'ymap-pop', lang });
    root.append(h('p', { class: 'ymap-pop-title', text: title }));
    if (subtitle) root.append(h('p', { class: 'ymap-pop-sub', text: subtitle }));
    return root;
  }

  function systemPopup(a) {
    const s = a.system;
    const kindText = kindLabel(s);
    const root = popupRoot(systemLabel(s), [kindText, t(a.imdClassKey || 'imd.low')].join(' · '));
    const lines = [];
    if (isFiniteNum(a.distanceKm)) lines.push(t('map.popup.distance', { dist: fDist(a.distanceKm), dir: dirLabel(a.compassFromHome) }));
    lines.push(isFiniteNum(s.windKt) ? t('map.popup.wind', { wind: fWind(s.windKt * KT_TO_KMH) }) : t('map.popup.windUnknown'));
    if (timeMs(s.position?.time) !== null) lines.push(t('map.popup.time', { when: fDateTime(s.position.time) }));
    if (a.movement && isFiniteNum(a.movement.speedKmh)) lines.push(t('map.popup.moving', { dir: dirLabel(a.movement.compass), speed: fWind(a.movement.speedKmh) }));
    const c = a.closest;
    if (c?.isForecast && isFiniteNum(c.distanceKm) && isFiniteNum(c.hoursFromNow) && c.hoursFromNow > 0) {
      lines.push(t('map.popup.closest', { dist: fDist(c.distanceKm), when: fDateTime(c.time) }));
    }
    if (s.potential && (s.kind === 'invest' || s.kind === 'tcfa')) lines.push(t('map.popup.potential', { chance: t(`jtwc.potential.${s.potential}`) }));
    if (s.tcfa && timeMs(s.tcfa.validUntil) !== null) lines.push(t('map.popup.validUntil', { when: fDateTime(s.tcfa.validUntil) }));
    const sources = (Array.isArray(s.sources) ? s.sources : []).map((x) => String(x).toUpperCase()).join(', ');
    if (sources) lines.push(t('map.popup.sources', { list: sources }));
    root.append(h('ul', { class: 'ymap-pop-list' }, ...lines.map((text) => h('li', { text }))));
    return root;
  }

  function drawDmh() {
    const b = data.dmh?.bulletin;
    if (!b?.isCurrent || !validLatLon(b)) return;
    const lon = unwrapLon(b.lon, home.lon);
    const swatch = DMH_STAGES[b.stage]?.swatch ?? null;
    const badge = h('span', { class: 'ymap-dmh-badge' });
    if (swatch) {
      const sw = h('span', { class: 'ymap-dmh-swatch' });
      sw.style.background = safeColor(swatch);
      badge.append(sw);
    }
    badge.append(h('span', { text: t('map.dmh.badge') }));
    const iconEl = h('div', { class: 'ymap-dmh' }, h('span', { class: 'ymap-dmh-dot' }), badge);
    const distanceKm = isFiniteNum(b.distanceKm) ? b.distanceKm : haversineKm(home, b);
    const compass = b.compassFromHome || compass16(bearingDeg(home, b));
    const where = t('map.popup.distance', { dist: fDist(distanceKm), dir: dirLabel(compass) });
    const aria = t('map.dmh.label', { sys: t(`dmh.system.${b.system || 'unknown'}`), where });
    const marker = L.marker([b.lat, lon], {
      icon: L.divIcon({ className: 'ymap-dmh-icon', html: iconEl, iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10] }),
      pane: PANE.markers,
      keyboard: true,
      riseOnHover: true,
      zIndexOffset: 500,
    })
      .bindPopup(() => dmhPopup(b, where), { className: 'ymap-popup', maxWidth: 300, autoPanPadding: [16, 16] });
    marker.on('add', () => marker.getElement()?.setAttribute('aria-label', aria));
    marker.addTo(markersGroup);
  }

  function dmhPopup(b, where) {
    const root = popupRoot(t('map.dmh.title'), t(`dmh.system.${b.system || 'unknown'}`));
    if (b.stage && DMH_STAGES[b.stage]) {
      const sw = h('span', { class: 'ymap-pop-swatch' });
      sw.style.background = safeColor(DMH_STAGES[b.stage].swatch);
      root.append(h('p', { class: 'ymap-pop-stage' }, sw, h('span', { text: t(`dmh.stage.${b.stage}`) })));
    }
    const lines = [where];
    const w = b.windMph;
    if (w && (isFiniteNum(w.min) || isFiniteNum(w.max))) {
      const lo = isFiniteNum(w.min) ? w.min : w.max;
      const hi = isFiniteNum(w.max) ? w.max : w.min;
      const range = lo === hi ? num(lo) : `${num(lo)}–${num(hi)}`;
      lines.push(t('map.dmh.wind', { wind: `${range} ${t('unit.mph')}` }));
    }
    const issued = b.issuedAtDate ?? b.issuedAt;
    if (timeMs(issued) !== null) lines.push(t('map.dmh.issued', { when: fDateTime(issued) }));
    root.append(h('ul', { class: 'ymap-pop-list' }, ...lines.map((text) => h('li', { text }))));
    const href = (lang === 'my' ? b.url?.my : b.url?.en) || b.url?.en || b.url?.my;
    if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
      const link = h('a', { class: 'ymap-pop-link', target: '_blank', rel: 'noopener', text: `${t('map.dmh.read')} ↗` });
      link.href = href;
      root.append(h('p', {}, link));
    }
    return root;
  }

  // --- view ------------------------------------------------------------------------
  let viewSet = false;
  function fitTo(points, { maxZoom = FIT_MAX_ZOOM } = {}) {
    const animate = viewSet && !reduced();
    viewSet = true;
    if (points.length >= 2) map.fitBounds(L.latLngBounds(points), { paddingTopLeft: FIT_PADDING_TL, paddingBottomRight: FIT_PADDING_BR, maxZoom, animate });
    else if (points.length === 1) map.setView(points[0], Math.min(6, maxZoom), { animate });
    else map.setView([DEFAULT_VIEW.lat, DEFAULT_VIEW.lon], defaultZoom(), { animate });
  }

  function autoFit() {
    if (activeTab !== 'map' || !el.clientWidth) return;
    fitTo(fitPoints(data.analyses, data.dmh, home, nowFn()));
  }

  // Labels sit right of their marker; near the right edge they flip left so
  // a storm name is never cut off.
  const labelled = [];
  const ringLabels = [];
  function placeLabels() {
    if (!viewSet || !el.clientWidth) return;
    const width = el.clientWidth;
    const homePt = map.latLngToLayerPoint([home.lat, home.lon]);
    for (const marker of ringLabels) {
      const node = marker.getElement();
      if (node) node.style.visibility = map.latLngToLayerPoint(marker.getLatLng()).distanceTo(homePt) < RING_LABEL_MIN_PX ? 'hidden' : '';
    }
    for (const { marker, root } of labelled) {
      const label = root.querySelector('.ymap-label');
      if (!label || !marker._map) continue;
      const x = map.latLngToContainerPoint(marker.getLatLng()).x;
      root.classList.toggle('ymap-flip', x + 24 + label.offsetWidth > width - 8 && x - 24 - label.offsetWidth > 8);
    }
  }
  map.on('zoomend moveend resize', placeLabels);

  // --- interaction -------------------------------------------------------------
  // Scroll-wheel zoom (and one-finger panning on touch screens) only once the
  // map has been clicked or focused, so the page scrolls past it normally.
  const engage = () => {
    map.scrollWheelZoom.enable();
    if (coarse) map.dragging.enable();
  };
  map.on('click', engage);
  on(el, 'focusin', engage);
  on(el, 'focusout', (ev) => {
    if (el.contains(ev.relatedTarget)) return;
    map.scrollWheelZoom.disable();
    if (coarse) map.dragging.disable();
  });
  on(el, 'mouseleave', () => map.scrollWheelZoom.disable());
  const markUser = () => {
    userMoved = true;
  };
  on(el, 'pointerdown', markUser, { passive: true });
  on(el, 'keydown', markUser);
  on(el, 'wheel', () => map.scrollWheelZoom.enabled() && markUser(), { passive: true });
  on(globalThis.document, 'visibilitychange', () => {
    if (globalThis.document?.hidden) satPause();
  });
  const onMotionChange = () => {
    if (reduced()) satPause();
    satUpdateUi();
  };
  mqReduce?.addEventListener?.('change', onMotionChange);
  cleanups.push(() => mqReduce?.removeEventListener?.('change', onMotionChange));
  if (typeof globalThis.ResizeObserver === 'function') {
    let raf = 0;
    const ro = new globalThis.ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => !destroyed && map.invalidateSize({ pan: false }));
    });
    ro.observe(el);
    cleanups.push(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    });
  }

  // --- controller ------------------------------------------------------------------
  const controller = {
    /** Leaflet map instance (for debugging / advanced integration). */
    map,

    /** Draw systems and the DMH position. Re-fits the view unless the reader has moved the map. */
    setData({ analyses = [], dmh = null } = {}) {
      if (destroyed) return;
      data = { analyses: Array.isArray(analyses) ? analyses.filter(Boolean) : [], dmh: dmh ?? null };
      renderData();
      if (!userMoved) autoFit();
      if (layerState.satellite && !sat.playing && Date.now() - sat.fetchedAt > SAT_REFRESH_MS) satRefresh();
      if (layerState.radar) radarRefresh();
      radarUpdateUi();
    },

    /** Colours follow the CSS theme tokens; this only records the theme. */
    setTheme(next) {
      theme = next || theme;
      el.dataset.ymapTheme = theme;
    },

    /** New language and/or formatters (also call this when units change). */
    setLang(nextLang, nextT, nextFmt) {
      if (destroyed) return;
      if (nextLang) lang = nextLang;
      if (typeof nextT === 'function') t = nextT;
      if (nextFmt) fmt = normaliseFmt(nextFmt);
      buildMapControls();
      applyText();
      renderStatic();
      renderData();
      satUpdateUi();
      radarUpdateUi();
      map.closePopup();
    },

    /** Zoom to one system (by TropicalSystem id) and open its popup. Returns false if it is not on the map. */
    focusSystem(id) {
      if (destroyed) return false;
      const entry = markerById.get(id);
      if (!entry) return false;
      if (activeTab !== 'map') selectTab('map');
      userMoved = true;
      const pts = systemFitPoints(entry.analysis, home, nowFn());
      if (isFiniteNum(entry.analysis.distanceKm) && entry.analysis.distanceKm <= FOCUS_WITH_HOME_KM) pts.push([home.lat, home.lon]);
      fitTo(pts);
      entry.marker.openPopup();
      return true;
    },

    /** Back to the default view: Yangon and every relevant system (resumes auto-fitting on refresh). */
    fitAll() {
      if (destroyed) return;
      userMoved = false;
      map.closePopup();
      autoFit();
    },

    invalidate() {
      if (!destroyed) map.invalidateSize();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      satPause();
      clearTimeout(sat.timer);
      for (const fn of cleanups.splice(0)) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      map.remove();
      for (const c of [...el.classList]) if (c === 'ymap' || c.startsWith('leaflet-')) el.classList.remove(c);
      for (const a of ['role', 'aria-label', 'aria-describedby', 'data-ymap-theme']) el.removeAttribute(a);
      if (ownControls) controlsEl.remove();
      else controlsEl.replaceChildren();
      if (ownWindy) windyEl.remove();
      else windyEl.replaceChildren();
      el.hidden = false;
    },
  };

  // --- initial render ----------------------------------------------------------------
  el.dataset.ymapTheme = theme;
  buildMapControls();
  applyText();
  renderStatic();
  for (const name of LAYER_NAMES) if (layerState[name]) groups[name].addTo(map);
  satUpdateUi();
  radarUpdateUi();
  if (layerState.satellite) satRefresh();
  if (layerState.radar) radarRefresh();
  setTimeout(() => {
    if (!destroyed && !viewSet) fitTo([]);
  }, 0);

  return controller;
}
