// Client side of the DMH pipeline: reads data/dmh.json (written by
// scripts/fetch-dmh.mjs in GitHub Actions) and data/override.json, and
// turns them into a DmhStatus / Override relative to Yangon and "now".
// Everything here treats the JSON as untrusted: missing, stale or malformed
// data must degrade to "unavailable", never throw or invent a warning.

import { DMH_STAGES, HOME, STALE_AFTER_MS, THRESHOLDS, URLS } from './config.js';
import { bearingDeg, compass16, haversineKm } from './geo.js';
import { fetchJson, HttpError } from './net.js';

const DMH_SYSTEMS = new Set(['low', 'well-marked-low', 'depression', 'deep-depression', 'cs', 'scs', 'vscs', 'escs', 'sucs']);
const OTHER_TYPES = new Set(['flood', 'flash-flood', 'heavy-rain', 'strong-wind', 'water-level', 'other']);
const CACHE_BUCKET_MS = 5 * 60 * 1000;
// A post date far in the future is a typo; never let it keep a bulletin "current" for days.
const FUTURE_TOLERANCE_MS = 6 * 3600e3;
const RECENT_MAX = 6;
const OTHER_MAX = 8;

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');

function toDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Only http(s) links may reach an href. */
function safeUrl(v) {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function pair(v, map = str) {
  const o = isObj(v) ? v : {};
  return { en: map(o.en), my: map(o.my) };
}

function withinHours(date, now, hours) {
  if (!date) return false;
  const age = now.getTime() - date.getTime();
  return age <= hours * 3600e3 && age >= -FUTURE_TOLERANCE_MS;
}

function cleanWind(w) {
  if (!isObj(w)) return null;
  const min = finite(w.min);
  const max = finite(w.max);
  if (min == null && max == null) return null;
  return { min: min ?? max, max: max ?? min, text: str(w.text, 200) };
}

/** Common DmhBulletin fields, validated; null when the entry is unusable. */
function cleanBulletin(b) {
  if (!isObj(b)) return null;
  const issuedAtDate = toDate(b.issuedAt);
  if (!issuedAtDate) return null;
  const lat = finite(b.lat);
  const lon = finite(b.lon);
  const validPos = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return {
    id: b.id == null ? null : String(b.id).slice(0, 40),
    kind: b.kind === 'warning' || b.kind === 'news' ? b.kind : null,
    system: DMH_SYSTEMS.has(b.system) ? b.system : null,
    number: finite(b.number),
    year: finite(b.year),
    stage: typeof b.stage === 'string' && Object.hasOwn(DMH_STAGES, b.stage) ? b.stage : null,
    issuedAt: issuedAtDate.toISOString(),
    issuedAtDate,
    lat: validPos ? lat : null,
    lon: validPos ? lon : null,
    pressureHpa: finite(b.pressureHpa),
    windMph: cleanWind(b.windMph),
    mentionsYangon: b.mentionsYangon === true,
    weakening: b.weakening === true,
    title: pair(b.title, (s) => str(s, 300)),
    url: pair(b.url, safeUrl),
    summary: pair(b.summary, (s) => str(s, 2000)),
  };
}

/** Add position relative to home, `near` and `isCurrent`. */
function locate(b, home, now) {
  const hasPos = b.lat != null && b.lon != null;
  const distanceKm = hasPos ? haversineKm(home, { lat: b.lat, lon: b.lon }) : null;
  const bearingFromHome = hasPos ? bearingDeg(home, { lat: b.lat, lon: b.lon }) : null;
  return {
    ...b,
    isCurrent: withinHours(b.issuedAtDate, now, THRESHOLDS.dmh.currentHours),
    distanceKm,
    bearingFromHome,
    compassFromHome: bearingFromHome == null ? null : compass16(bearingFromHome),
    near: (distanceKm != null && distanceKm <= THRESHOLDS.dmh.nearKm) || b.mentionsYangon,
  };
}

function cleanAnnouncement(a) {
  if (!isObj(a)) return null;
  const text = pair(a.text, (s) => str(s, 3000));
  if (!text.en && !text.my) return null;
  const issuedAtDate = toDate(a.issuedAt);
  return { issuedAt: issuedAtDate ? issuedAtDate.toISOString() : null, issuedAtDate, text, url: pair(a.url, safeUrl) };
}

function cleanOtherWarning(w, now) {
  if (!isObj(w)) return null;
  const issuedAtDate = toDate(w.issuedAt);
  if (!issuedAtDate) return null;
  return {
    type: OTHER_TYPES.has(w.type) ? w.type : 'other',
    issuedAt: issuedAtDate.toISOString(),
    issuedAtDate,
    isCurrent: withinHours(issuedAtDate, now, THRESHOLDS.dmh.currentHours),
    title: pair(w.title, (s) => str(s, 300)),
    url: pair(w.url, safeUrl),
    mentionsYangon: w.mentionsYangon === true,
    isNil: w.isNil === true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Same-origin data/dmh.json, cache-busted per 5-minute bucket.
 * Resolves null when the file does not exist yet (404); other failures reject.
 */
export async function fetchDmhJson({ now = Date.now(), ...opts } = {}) {
  const bucket = Math.floor(Number(now) / CACHE_BUCKET_MS);
  try {
    return await fetchJson(`${URLS.dmhJson}?t=${bucket}`, opts);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * DmhStatus for the UI and risk.js. Never throws; `available:false` when
 * there is no usable file (missing, garbage, or never checked successfully).
 * @param {object|null} json  parsed data/dmh.json
 * @param {{lat:number, lon:number}} [home]
 * @param {Date} [now]
 */
export function evaluateDmh(json, home = HOME, now = new Date()) {
  const empty = { available: false, ok: false, checkedAt: null, attemptedAt: null, checkStale: true, errors: [], bulletin: null, announcement: null, otherWarnings: [], recent: [] };
  if (!isObj(json)) return empty;
  const nowDate = toDate(now) ?? new Date();

  const checkedAt = toDate(json.checkedAt);
  const age = checkedAt ? nowDate.getTime() - checkedAt.getTime() : Infinity;
  const cyclone = cleanBulletin(json.cyclone);
  const recent = (Array.isArray(json.recentCyclone) ? json.recentCyclone : [])
    .map(cleanBulletin)
    .filter(Boolean)
    .sort((a, b) => b.issuedAtDate - a.issuedAtDate)
    .slice(0, RECENT_MAX)
    .map(({ summary, ...b }) => locate(b, home, nowDate));

  return {
    available: checkedAt !== null,
    ok: json.ok === true,
    checkedAt,
    attemptedAt: toDate(json.attemptedAt),
    checkStale: !(age <= STALE_AFTER_MS.dmhCheck),
    errors: (Array.isArray(json.errors) ? json.errors : []).filter((e) => typeof e === 'string').slice(0, 20),
    bulletin: cyclone ? locate(cyclone, home, nowDate) : null,
    announcement: cleanAnnouncement(json.announcement),
    otherWarnings: (Array.isArray(json.otherWarnings) ? json.otherWarnings : [])
      .map((w) => cleanOtherWarning(w, nowDate))
      .filter(Boolean)
      .slice(0, OTHER_MAX),
    recent,
  };
}

/** Same-origin data/override.json; null when absent. */
export async function fetchOverride({ now = Date.now(), ...opts } = {}) {
  const bucket = Math.floor(Number(now) / CACHE_BUCKET_MS);
  try {
    return await fetchJson(`${URLS.overrideJson}?t=${bucket}`, opts);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The hand-edited floor, or null when it is disabled, expired or malformed.
 * @returns {{enabled:true, minLevel:0|1|2|3, expires:Date|null, message:{en:string,my:string}}|null}
 */
export function evaluateOverride(json, now = new Date()) {
  if (!isObj(json) || json.enabled !== true) return null;
  const minLevel = typeof json.minLevel === 'number' ? json.minLevel : Number.NaN;
  if (!Number.isInteger(minLevel) || minLevel < 0 || minLevel > 3) return null;
  let expires = null;
  if (json.expires != null && json.expires !== '') {
    expires = toDate(json.expires);
    // An unreadable expiry could otherwise pin the level forever.
    if (!expires) return null;
    const nowDate = toDate(now) ?? new Date();
    if (expires.getTime() <= nowDate.getTime()) return null;
  }
  return { enabled: true, minLevel, expires, message: pair(json.message, (s) => str(s, 1000)) };
}
