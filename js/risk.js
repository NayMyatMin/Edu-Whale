// The attention-level decision table (this site's own, unofficial reading).
// Pure functions over already-normalised data; every number comes from
// THRESHOLDS in config.js so "How this works" can show exactly what is applied.
//
// Principles (see SPEC.md, "Real-world lesson"):
// - The final level is the MAX over every rule: DMH, storms, weather, override.
//   No single feed can lower what another raised.
// - Missing data is never "calm": without DMH and full storm coverage the
//   answer is "unknown — check DMH" unless something already says Prepare+.

import { IMD_CLASSES, JTWC_CLASSES, THRESHOLDS } from './config.js';
import { haversineKm } from './geo.js';

const HOUR_MS = 3600e3;
// Tropical-storm (gale) and hurricane/typhoon strength, 1-min winds in knots.
const TS_KT = JTWC_CLASSES.find((c) => c.key === 'TS').minKt;
const HU_KT = JTWC_CLASSES.find((c) => c.key === 'HU').minKt;
const SOURCE_ORDER = { override: 0, dmh: 1, storm: 2, weather: 3 };
const GAP_ORDER = ['dmh', 'storms', 'gdacs', 'jtwc', 'weather'];

const S = THRESHOLDS.storm;
const W = THRESHOLDS.weather;
const D = THRESHOLDS.dmh;

function imdKeyFor(windKt) {
  if (typeof windKt !== 'number' || !Number.isFinite(windKt)) return null;
  return (IMD_CLASSES.find((c) => windKt >= c.minKt) ?? IMD_CLASSES[IMD_CLASSES.length - 1]).key;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const reason = (code, level, source, params = {}) => ({ code, level, source, params });

/** Keep one reason per code (the highest level; first seen on ties). */
function onePerCode(reasons) {
  const best = new Map();
  for (const r of reasons) {
    const cur = best.get(r.code);
    if (!cur || r.level > cur.level) best.set(r.code, r);
  }
  return [...best.values()];
}

function maxLevel(reasons) {
  return reasons.reduce((m, r) => (finite(r.level) && r.level > m ? r.level : m), 0);
}

function sortReasons(reasons) {
  return reasons
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const la = finite(a.r.level) ? a.r.level : -1;
      const lb = finite(b.r.level) ? b.r.level : -1;
      if (la !== lb) return lb - la;
      const sa = SOURCE_ORDER[a.r.source] ?? 9;
      const sb = SOURCE_ORDER[b.r.source] ?? 9;
      if (sa !== sb) return sa - sb;
      const ka = a.r.params?.km;
      const kb = b.r.params?.km;
      if (finite(ka) && finite(kb) && ka !== kb) return ka - kb;
      return a.i - b.i;
    })
    .map(({ r }) => r);
}

// ---------------------------------------------------------------------------
// Tropical systems
// ---------------------------------------------------------------------------

function hoursOf(sample, now) {
  if (finite(sample.hoursFromNow)) return sample.hoursFromNow;
  const t = sample.time instanceof Date ? sample.time.getTime() : Date.parse(sample.time);
  return Number.isFinite(t) && now ? (t - now.getTime()) / HOUR_MS : Number.NaN;
}

/** Closest sample (within `hours`, ≤ `km`) that passes `test`, or null. */
function closestMatch(samples, hours, km, test = () => true) {
  let best = null;
  for (const s of samples) {
    if (s.h <= hours && s.distanceKm <= km && test(s) && (!best || s.distanceKm < best.distanceKm)) best = s;
  }
  return best;
}

/** Time in ms from a Date / ISO string / number, or null. */
function msOf(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'string' || typeof v === 'number') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * GDACS wind areas that contain Yangon, with their lead time. Falls back to
 * the single `insideWindKmh` (counted as valid now) for older analyses.
 */
function windAreasAtHome(analysis) {
  if (Array.isArray(analysis.insideWind)) return analysis.insideWind.filter((a) => finite(a?.kmh) && a.kmh > 0);
  const kmh = finite(analysis.insideWindKmh) ? analysis.insideWindKmh : 0;
  return kmh > 0 ? [{ kmh, hoursFromNow: 0 }] : [];
}

// A wind area valid within this many hours is "now" (no lead time in the wording).
const WIND_NOW_HOURS = 6;

/**
 * Attention level from one SystemAnalysis.
 * @param {object} analysis SystemAnalysis (systems.js)
 * @param {Date} [now]
 * @returns {{level: 0|1|2|3, reasons: object[]}}
 */
export function stormThreat(analysis, now = new Date()) {
  const sys = analysis?.system;
  if (!sys) return { level: 0, reasons: [] };
  const name = sys.name || sys.designation || '';
  const nowMs = now.getTime();
  // A formation alert long past its "valid until" time without a JTWC update is only an invest.
  const validUntil = msOf(sys.tcfa?.validUntil);
  const kind = sys.kind === 'tcfa' && validUntil !== null && nowMs - validUntil > S.tcfaLapseHours * HOUR_MS ? 'invest' : sys.kind;
  const warnedOrAlert = kind === 'warning' || kind === 'tcfa';
  const km = finite(analysis.distanceKm) ? analysis.distanceKm : null;
  // A position nobody has re-stated for a day is not "where the storm is now"
  // (an advisory re-issuing an older fix does re-state it).
  const fixMs = msOf(sys.position?.time);
  const latestMs = Math.max(fixMs ?? -Infinity, msOf(sys.issuedAt) ?? -Infinity);
  const fixFresh = latestMs === -Infinity || nowMs - latestMs <= S.maxFixAgeHours * HOUR_MS;
  const samples = (Array.isArray(analysis.samples) ? analysis.samples : [])
    .map((s) => ({ ...s, h: hoursOf(s, now) }))
    .filter((s) => finite(s.h) && s.h >= -1 && finite(s.distanceKm));
  // Known wind, else the floor of the storm class GDACS/JTWC gave the point (TS ≥ 34 kt, HU ≥ 64 kt).
  const windOf = (s) => (finite(s.windKt) ? s.windKt : finite(s.minWindKt) ? s.minWindKt : null);
  const hasWind = (min) => (s) => windOf(s) !== null && windOf(s) >= min;
  const trackParams = (s) => ({ name, km: s.distanceKm, hours: Math.max(0, Math.round(s.h)), time: s.time ?? null, cls: imdKeyFor(windOf(s)) ?? analysis.imdClassKey ?? null });
  const out = [];

  // Danger (3)
  const ts = closestMatch(samples, S.danger.trackHoursTS, S.danger.trackKmTS, hasWind(TS_KT));
  if (ts) out.push(reason('storm.trackNear', 3, 'storm', trackParams(ts)));
  const hu = closestMatch(samples, S.danger.trackHoursHU, S.danger.trackKmHU, hasWind(HU_KT));
  if (hu) out.push(reason('storm.hurricaneNear', 3, 'storm', { name, km: hu.distanceKm, hours: Math.max(0, Math.round(hu.h)), time: hu.time ?? null }));
  // Forecast wind areas count by lead time, like the track rules (48 h for Danger, 72 h for Prepare).
  const areas = windAreasAtHome(analysis);
  const windReason = (level, minKmh, maxHours) => {
    const hits = areas.filter((a) => a.kmh >= minKmh && (!finite(a.hoursFromNow) || a.hoursFromNow <= maxHours));
    if (!hits.length) return;
    const kmh = Math.max(...hits.map((a) => a.kmh));
    const hours = Math.min(...hits.filter((a) => a.kmh === kmh).map((a) => (finite(a.hoursFromNow) ? a.hoursFromNow : 0)));
    if (hours <= WIND_NOW_HOURS) out.push(reason('storm.insideWind', level, 'storm', { name, kmh }));
    else out.push(reason('storm.insideWindLater', level, 'storm', { name, kmh, hours: Math.round(hours) }));
  };
  windReason(3, S.danger.insideSwathKmh, S.danger.insideSwathHours);

  // Prepare (2)
  if (kind === 'warning') {
    const any = closestMatch(samples, S.prepare.trackHoursAny, S.prepare.trackKmAny);
    if (any) out.push(reason('storm.trackNear', 2, 'storm', trackParams(any)));
  }
  if (warnedOrAlert && fixFresh && km != null && km <= S.prepare.currentKm) {
    out.push(reason('storm.currentNear', 2, 'storm', { name, km, compass: analysis.compassFromHome ?? null }));
  }
  const huFar = closestMatch(samples, S.prepare.trackHoursHU, S.prepare.trackKmHU, hasWind(HU_KT));
  if (huFar) out.push(reason('storm.hurricaneNear', 2, 'storm', { name, km: huFar.distanceKm, hours: Math.max(0, Math.round(huFar.h)), time: huFar.time ?? null }));
  windReason(2, S.prepare.insideSwathKmh, S.prepare.insideSwathHours);
  if (analysis.insideCone === true) out.push(reason('storm.insideCone', 2, 'storm', { name }));
  if (kind === 'tcfa' && fixFresh && km != null) {
    // A formation alert whose alert area could not be read gets a wider radius.
    const corridorKnown = Boolean(sys.tcfa?.from && sys.tcfa?.to);
    if (km <= S.prepare.tcfaKm || analysis.tcfa?.insideCorridor === true || (!corridorKnown && km <= S.prepare.tcfaNoCorridorKm)) {
      out.push(reason('storm.tcfaNear', 2, 'storm', { name, km }));
    }
  }

  // Monitor (1)
  if (warnedOrAlert && ((S.monitor.inRegion && analysis.inRegion === true) || (km != null && km <= S.monitor.nearbyKm))) {
    out.push(reason('storm.inRegion', 1, 'storm', { name, km, compass: analysis.compassFromHome ?? null }));
  }
  const fc = closestMatch(samples.filter((s) => s.forecast), Infinity, S.monitor.trackKm);
  if (fc) out.push(reason('storm.forecastWithin', 1, 'storm', { name, km: fc.distanceKm }));
  // Beyond those horizons a forecast wind area over Yangon is still worth watching.
  windReason(1, S.prepare.insideSwathKmh, Infinity);
  if (kind === 'invest' && km != null && km <= S.monitor.investKm) {
    out.push(reason('storm.invest', 1, 'storm', { name, km, potential: sys.potential ?? 'UNKNOWN' }));
  }

  // JTWC's final warning: once it is half a day old, the storm counts at most as Monitor.
  const issuedMs = msOf(sys.issuedAt) ?? fixMs;
  const finalExpired = sys.final === true && issuedMs !== null && nowMs - issuedMs > S.finalMaxAgeHours * HOUR_MS;
  const kept = finalExpired ? out.filter((r) => r.level <= 1) : out;

  const reasons = sortReasons(onePerCode(kept));
  return { level: maxLevel(reasons), reasons };
}

// ---------------------------------------------------------------------------
// Local weather (Open-Meteo, next 72 h)
// ---------------------------------------------------------------------------

// THRESHOLDS.weather key -> [reason code, derived.next72h value, time field, param name]
const WEATHER_METRICS = {
  gustKmh: ['weather.gust', 'maxGust', 'maxGustTime', 'kmh'],
  windKmh: ['weather.wind', 'maxWind', 'maxWindTime', 'kmh'],
  rain24hMm: ['weather.rain24h', 'maxRain24h', 'maxRain24hEnd', 'mm'],
  rain48hMm: ['weather.rain48h', 'maxRain48h', null, 'mm'],
  rain72hMm: ['weather.rain72h', 'maxRain72h', null, 'mm'],
  rainHourMm: ['weather.rainHour', 'maxRainHour', 'maxRainHourTime', 'mm'],
};
const WEATHER_LEVELS = [['danger', 3], ['prepare', 2], ['monitor', 1]];

/**
 * Attention level from the local model forecast. Model winds underestimate
 * cyclone cores, so this can only raise the overall level (max rule).
 * @param {object|null} weather WeatherData
 */
export function weatherThreat(weather) {
  const next = weather?.derived?.next72h;
  if (!next) return { level: 0, reasons: [] };
  const out = [];
  for (const [key, [code, field, timeField, param]] of Object.entries(WEATHER_METRICS)) {
    const value = next[field];
    if (!finite(value)) continue;
    for (const [band, level] of WEATHER_LEVELS) {
      const limit = W[band]?.[key];
      if (finite(limit) && value >= limit) {
        const params = { [param]: value };
        if (timeField) params.time = next[timeField] ?? null;
        out.push(reason(code, level, 'weather', params));
        break;
      }
    }
  }
  const reasons = sortReasons(out);
  return { level: maxLevel(reasons), reasons };
}

// ---------------------------------------------------------------------------
// DMH official bulletins
// ---------------------------------------------------------------------------

const DMH_WEAK_SYSTEMS = new Set(['low', 'well-marked-low', 'depression', 'deep-depression']);
// Two positioned bulletins this far apart are about different systems.
const DMH_SAME_SYSTEM_KM = 600;
// A later number in the same series (e.g. Warning No.3 → No.4) continues it.
const DMH_SERIES_MAX_STEP = 3;

function issuedMsOf(b) {
  return msOf(b?.effectiveIssuedDate) ?? msOf(b?.issuedAtDate) ?? msOf(b?.issuedAt);
}

function isCurrentAt(item, now) {
  if (!now) return item.isCurrent === true;
  const t = issuedMsOf(item);
  const age = t === null ? Number.NaN : now.getTime() - t;
  return Number.isFinite(age) && age <= D.currentHours * HOUR_MS && (item.isCurrent === true || age >= 0);
}

const hasLatLon = (b) => finite(b?.lat) && finite(b?.lon);

/**
 * Is the newer DMH bulletin `n` about the same system as the older `o` (so it
 * replaces it)? Positions decide when both have one. Otherwise only a
 * continuation of the same numbered series does, or a Warning following a
 * News. When it cannot tell, the older bulletin stays in force: a News about
 * another system must never cancel a Warning for the storm near Yangon.
 */
export function sameDmhSystem(n, o) {
  if (!n || !o) return false;
  if (hasLatLon(n) && hasLatLon(o)) return haversineKm(n, o) <= DMH_SAME_SYSTEM_KM;
  const sameYear = n.year == null || o.year == null || n.year === o.year;
  if (n.kind && n.kind === o.kind && finite(n.number) && finite(o.number) && sameYear) {
    const step = n.number - o.number;
    if (step > 0 && step <= DMH_SERIES_MAX_STEP) return true;
  }
  // A newer Warning outranks an older News (a Warning's floor is never lower).
  return n.kind === 'warning' && o.kind === 'news';
}

/**
 * The DMH bulletins still in force: current ones not replaced by a newer
 * bulletin about the same system. Newest first. `list` may repeat ids (the
 * first copy wins, so pass the full bulletin before the light ones).
 */
export function inForceDmh(list, now) {
  const seen = new Set();
  const current = [];
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || typeof b !== 'object') continue;
    const key = b.id ?? `${b.issuedAt}|${b.title?.en ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isCurrentAt(b, now)) current.push(b);
  }
  current.sort((a, b) => (issuedMsOf(b) ?? 0) - (issuedMsOf(a) ?? 0));
  return current.filter((b, i) => !current.slice(0, i).some((n) => sameDmhSystem(n, b)));
}

/** 0 = within dangerKm (dangerKmWeak for lows/depressions) or DMH names Yangon, 1 = within nearKm, 2 = further (or unknown). */
export function dmhDistanceBand(b) {
  if (!b) return 2;
  if (b.mentionsYangon === true) return 0;
  if (!finite(b.distanceKm)) return b.near === true ? 0 : 2;
  const dangerKm = DMH_WEAK_SYSTEMS.has(b.system) ? D.dangerKmWeak : D.dangerKm;
  if (b.distanceKm <= dangerKm) return 0;
  return b.distanceKm <= D.nearKm ? 1 : 2;
}

/** The attention reason one DMH cyclone bulletin gives (whether or not it is current), or null. */
export function dmhBulletinReason(b) {
  if (!b || typeof b !== 'object') return null;
  const time = b.issuedAtDate ?? (b.issuedAt ? new Date(b.issuedAt) : null);
  const system = b.system ?? 'unknown';
  const band = dmhDistanceBand(b);
  const floors = b.stage ? D.stageFloor[b.stage] : null;
  const hasPos = finite(b.distanceKm);
  const pick = (f) => f[Math.min(band, f.length - 1)];
  if (floors) {
    // A stage DMH coded for other regions only says little about Yangon.
    const level = b.stageScope === 'other-regions' ? Math.min(pick(floors), D.stageFloor.orange[2]) : pick(floors);
    if (b.stage === 'green') return reason('dmh.passed', level, 'dmh', { system, time });
    if (hasPos) return reason('dmh.stage', level, 'dmh', { stage: b.stage, system, km: b.distanceKm, compass: b.compassFromHome ?? null, time });
    return reason('dmh.stageNoPos', level, 'dmh', { stage: b.stage, system, time });
  }
  // A "Warning" with no stage, number or position is DMH's generic (often
  // "Nothing Special") notice: at most a News.
  const readableWarning = b.kind === 'warning' && (finite(b.number) || hasLatLon(b) || hasPos);
  if (b.kind === 'news' || (b.kind === 'warning' && !readableWarning)) {
    if (b.final === true && b.kind === 'news') return reason('dmh.newsFinal', 0, 'dmh', { system, time });
    return reason('dmh.news', D.newsFloor, 'dmh', { system, time });
  }
  if (b.kind === 'warning') {
    // A DMH "Warning" means Myanmar is threatened even if we could not read
    // its colour stage: assume the standby (orange) stage.
    return reason('dmh.warning', pick(D.stageFloor.orange), 'dmh', { system, km: hasPos ? b.distanceKm : null, compass: b.compassFromHome ?? null, time });
  }
  return null;
}

/**
 * Attention floor from DMH (DmhStatus from dmh.js). Every current bulletin
 * in force counts (DMH runs series for different systems side by side), and
 * a current bulletin counts even if the check itself is stale: an official
 * warning is never ignored.
 * @param {object|null} status
 * @param {Date} [now] re-check "current" against this time (defaults to evaluateDmh's flags)
 */
export function dmhThreat(status, now) {
  if (!status || typeof status !== 'object') return { level: 0, reasons: [] };
  const out = [];
  const list = [status.bulletin, ...(Array.isArray(status.recent) ? status.recent : [])];
  for (const b of inForceDmh(list, now)) {
    const r = dmhBulletinReason(b);
    if (r) out.push(r);
  }
  const seenTypes = new Set();
  const others = (Array.isArray(status.otherWarnings) ? status.otherWarnings : [])
    .filter((w) => w && w.mentionsYangon === true && w.isNil !== true && isCurrentAt(w, now))
    .sort((a, b) => (b.issuedAtDate ?? 0) - (a.issuedAtDate ?? 0));
  for (const w of others) {
    if (seenTypes.has(w.type)) continue;
    seenTypes.add(w.type);
    out.push(reason('dmh.otherWarning', D.otherWarningFloor, 'dmh', { title: w.title, type: w.type, time: w.issuedAtDate ?? null }));
  }
  const reasons = sortReasons(out);
  return { level: maxLevel(reasons), reasons };
}

// ---------------------------------------------------------------------------
// Combination
// ---------------------------------------------------------------------------

function overrideReason(override, now) {
  if (!override || typeof override !== 'object' || override.enabled !== true) return null;
  const level = override.minLevel;
  if (!Number.isInteger(level) || level < 0 || level > 3) return null;
  if (override.expires != null) {
    const exp = override.expires instanceof Date ? override.expires : new Date(override.expires);
    if (!Number.isFinite(exp.getTime()) || exp.getTime() <= now.getTime()) return null;
  }
  return reason('override', level, 'override', { message: override.message ?? { en: '', my: '' } });
}

/**
 * Overall attention level.
 * @param {{systems: object[]|null, dmh: object|null, weather: object|null, override?: object|null,
 *          now?: Date, gaps?: string[]}} input  systems null = GDACS and JTWC both failed
 * @returns {{level: 0|1|2|3|null, reasons: object[], gaps: string[], generatedAt: Date}}
 *   level null = unknown; the `unknown` reason (level null) then comes first.
 */
export function assessRisk({ systems = null, dmh = null, weather = null, override = null, now = new Date(), gaps = [] } = {}) {
  const gapSet = new Set(Array.isArray(gaps) ? gaps : []);
  // Partial (a bulletin DMH lists could not be read) or suspicious dates count as not checked.
  const dmhMissing = !dmh || dmh.available !== true || dmh.checkStale === true || dmh.partial === true || dmh.dateSuspect === true;
  if (dmhMissing) gapSet.add('dmh');
  if (systems == null) gapSet.add('storms');
  if (!weather) gapSet.add('weather');

  const all = [];
  all.push(...dmhThreat(dmh, now).reasons);
  for (const a of Array.isArray(systems) ? systems : []) all.push(...stormThreat(a, now).reasons);
  all.push(...weatherThreat(weather).reasons);
  const ov = overrideReason(override, now);
  if (ov) all.push(ov);

  let reasons = sortReasons(all);
  let level = maxLevel(reasons);

  // DMH is the official source and the one that caught 28 Sep 2026's system
  // first: without a current DMH check the page never says Calm or Monitor,
  // only Prepare/Danger when another source already says so.
  if (dmhMissing && level < 2) {
    level = null;
    reasons = [reason('unknown', null, 'dmh', {}), ...reasons];
  } else if (level === 0) {
    // Only claim "the forecast shows nothing" when the forecast was actually read.
    const stormsUnchecked = systems == null || gapSet.has('storms') || gapSet.has('gdacs') || gapSet.has('jtwc');
    let calm;
    if (stormsUnchecked) calm = reason('calm.partial', 0, 'storm', {});
    else if (gapSet.has('weather')) calm = reason('calm.noForecast', 0, 'storm', {});
    else calm = reason('calm', 0, 'storm', {});
    reasons = [...reasons, calm];
  }

  return {
    level,
    reasons,
    gaps: GAP_ORDER.filter((g) => gapSet.has(g)).concat([...gapSet].filter((g) => !GAP_ORDER.includes(g))),
    generatedAt: now,
  };
}
