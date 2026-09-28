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
  const kind = sys.kind;
  const warnedOrAlert = kind === 'warning' || kind === 'tcfa';
  const km = finite(analysis.distanceKm) ? analysis.distanceKm : null;
  const samples = (Array.isArray(analysis.samples) ? analysis.samples : [])
    .map((s) => ({ ...s, h: hoursOf(s, now) }))
    .filter((s) => finite(s.h) && s.h >= -1 && finite(s.distanceKm));
  const hasWind = (min) => (s) => finite(s.windKt) && s.windKt >= min;
  const trackParams = (s) => ({ name, km: s.distanceKm, hours: Math.max(0, Math.round(s.h)), time: s.time ?? null, cls: imdKeyFor(s.windKt) ?? analysis.imdClassKey ?? null });
  const out = [];

  // Danger (3)
  const ts = closestMatch(samples, S.danger.trackHoursTS, S.danger.trackKmTS, hasWind(TS_KT));
  if (ts) out.push(reason('storm.trackNear', 3, 'storm', trackParams(ts)));
  const hu = closestMatch(samples, S.danger.trackHoursHU, S.danger.trackKmHU, hasWind(HU_KT));
  if (hu) out.push(reason('storm.hurricaneNear', 3, 'storm', { name, km: hu.distanceKm, hours: Math.max(0, Math.round(hu.h)), time: hu.time ?? null }));
  const insideKmh = finite(analysis.insideWindKmh) ? analysis.insideWindKmh : 0;
  if (insideKmh >= S.danger.insideSwathKmh) out.push(reason('storm.insideWind', 3, 'storm', { name, kmh: insideKmh }));

  // Prepare (2)
  if (kind === 'warning') {
    const any = closestMatch(samples, S.prepare.trackHoursAny, S.prepare.trackKmAny);
    if (any) out.push(reason('storm.trackNear', 2, 'storm', trackParams(any)));
  }
  if (warnedOrAlert && km != null && km <= S.prepare.currentKm) {
    out.push(reason('storm.currentNear', 2, 'storm', { name, km, compass: analysis.compassFromHome ?? null }));
  }
  const huFar = closestMatch(samples, S.prepare.trackHoursHU, S.prepare.trackKmHU, hasWind(HU_KT));
  if (huFar) out.push(reason('storm.hurricaneNear', 2, 'storm', { name, km: huFar.distanceKm, hours: Math.max(0, Math.round(huFar.h)), time: huFar.time ?? null }));
  if (insideKmh >= S.prepare.insideSwathKmh) out.push(reason('storm.insideWind', 2, 'storm', { name, kmh: insideKmh }));
  if (analysis.insideCone === true) out.push(reason('storm.insideCone', 2, 'storm', { name }));
  if (kind === 'tcfa' && ((km != null && km <= S.prepare.tcfaKm) || analysis.tcfa?.insideCorridor === true)) {
    out.push(reason('storm.tcfaNear', 2, 'storm', { name, km }));
  }

  // Monitor (1)
  if (warnedOrAlert && ((S.monitor.inRegion && analysis.inRegion === true) || (km != null && km <= S.monitor.nearbyKm))) {
    out.push(reason('storm.inRegion', 1, 'storm', { name, km, compass: analysis.compassFromHome ?? null }));
  }
  const fc = closestMatch(samples.filter((s) => s.forecast), Infinity, S.monitor.trackKm);
  if (fc) out.push(reason('storm.forecastWithin', 1, 'storm', { name, km: fc.distanceKm }));
  if (kind === 'invest' && km != null && km <= S.monitor.investKm) {
    out.push(reason('storm.invest', 1, 'storm', { name, km, potential: sys.potential ?? 'UNKNOWN' }));
  }

  const reasons = sortReasons(onePerCode(out));
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

function isCurrentAt(item, now) {
  if (!now) return item.isCurrent === true;
  const d = item.issuedAtDate instanceof Date ? item.issuedAtDate : new Date(item.issuedAt);
  const age = now.getTime() - d.getTime();
  return Number.isFinite(age) && age <= D.currentHours * HOUR_MS && (item.isCurrent === true || age >= 0);
}

/**
 * Attention floor from DMH (DmhStatus from dmh.js). A current bulletin
 * counts even if the check itself is stale: an official warning is never ignored.
 * @param {object|null} status
 * @param {Date} [now] re-check "current" against this time (defaults to evaluateDmh's flags)
 */
export function dmhThreat(status, now) {
  if (!status || typeof status !== 'object') return { level: 0, reasons: [] };
  const out = [];
  const b = status.bulletin;
  if (b && isCurrentAt(b, now)) {
    const time = b.issuedAtDate ?? (b.issuedAt ? new Date(b.issuedAt) : null);
    const system = b.system ?? 'unknown';
    const floors = b.stage ? D.stageFloor[b.stage] : null;
    const hasPos = finite(b.distanceKm);
    if (floors) {
      const level = floors[b.near ? 0 : 1];
      if (b.stage === 'green') out.push(reason('dmh.passed', level, 'dmh', { system, time }));
      else if (hasPos) out.push(reason('dmh.stage', level, 'dmh', { stage: b.stage, system, km: b.distanceKm, compass: b.compassFromHome ?? null, time }));
      else out.push(reason('dmh.stageNoPos', level, 'dmh', { stage: b.stage, system, time }));
    } else if (b.kind === 'news') {
      out.push(reason('dmh.news', D.newsFloor, 'dmh', { system, time }));
    } else if (b.kind === 'warning') {
      // A DMH "Warning" means Myanmar is threatened even if we could not read
      // its colour stage: assume the standby (orange) stage.
      const level = D.stageFloor.orange[b.near ? 0 : 1];
      out.push(reason('dmh.warning', level, 'dmh', { system, km: hasPos ? b.distanceKm : null, compass: b.compassFromHome ?? null, time }));
    }
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
  const dmhMissing = !dmh || dmh.available !== true || dmh.checkStale === true;
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

  // JTWC is what catches early systems GDACS misses (28 Sep 2026), so
  // GDACS alone is not enough coverage to call it calm.
  const stormsMissing = systems == null || gapSet.has('storms') || gapSet.has('jtwc');
  if (dmhMissing && stormsMissing && level < 2) {
    level = null;
    reasons = [reason('unknown', null, 'dmh', {}), ...reasons];
  } else if (level === 0) {
    reasons = [...reasons, reason('calm', 0, 'storm', {})];
  }

  return {
    level,
    reasons,
    gaps: GAP_ORDER.filter((g) => gapSet.has(g)).concat([...gapSet].filter((g) => !GAP_ORDER.includes(g))),
    generatedAt: now,
  };
}
