// Merging GDACS + JTWC systems into one list, and measuring each system
// against home (Yangon). Pure functions: no fetching, no DOM.

import { HOME, IMD_CLASSES, JTWC_CLASSES, KT_TO_KMH, REGION_BBOX } from './config.js';
import {
  bearingDeg,
  closestPointOnSegment,
  compass16,
  haversineKm,
  inBbox,
  interpolate,
  pointInGeometry,
} from './geo.js';

const HOUR_MS = 3600e3;

/** Systems closer than this (or inside REGION_BBOX) are listed under "Tropical systems". */
export const RELEVANT_KM = 4000;

// Matching rules for the same storm reported by GDACS and JTWC.
const MATCH_KM = 300;
const MATCH_HOURS = 12;
// A shared name alone is not enough across basins/years (e.g. "One").
const NAME_MATCH_MAX_KM = 2000;
// Wind areas older than this are no longer "current".
const WIND_AREA_MAX_AGE_MS = 3 * HOUR_MS;
// Guards against bad timestamps producing huge sample arrays.
const MAX_STEPS_PER_SEGMENT = 400;
// Slower than this counts as stationary (no meaningful direction).
const MIN_MOVING_KMH = 1;

const KIND_RANK = { warning: 3, tcfa: 2, invest: 1 };
// Rough IMD equivalent of a GDACS line label when no wind value is known.
const CLS_TO_IMD = { TD: 'imd.d', TS: 'imd.cs', HU: 'imd.vscs' };

// ---------------------------------------------------------------------------
// Small shared helpers (also used by gdacs.js / jtwc.js)
// ---------------------------------------------------------------------------

/** IMD class i18n key for a 1-minute sustained wind in knots ('imd.low' if unknown). */
export function imdClassKey(windKt) {
  if (!Number.isFinite(windKt)) return 'imd.low';
  const hit = IMD_CLASSES.find((c) => windKt >= c.minKt);
  return hit ? hit.key : 'imd.low';
}

/** 'TD' | 'TS' | 'HU' for a wind in knots, or null if unknown. */
export function jtwcClassOf(windKt) {
  if (!Number.isFinite(windKt)) return null;
  const hit = JTWC_CLASSES.find((c) => windKt >= c.minKt);
  return hit ? hit.key : 'TD';
}

/** 'SURIGAE' -> 'Surigae', 'FUNG-WONG' -> 'Fung-Wong'. */
export function titleCase(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/(^|[\s\-'’])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

const timeOf = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null);
const byTime = (a, b) => a.time - b.time;

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge GDACS and JTWC systems describing the same storm.
 * Match: same designation, same name word (and plausibly close), or
 * positions ≤ 300 km apart with position times ≤ 12 h apart.
 * @returns {object[]} TropicalSystem[]
 */
export function mergeSystems(gdacsSystems, jtwcSystems) {
  const gList = Array.isArray(gdacsSystems) ? gdacsSystems.filter(isUsable) : [];
  const jList = Array.isArray(jtwcSystems) ? jtwcSystems.filter(isUsable) : [];

  // Score every possible pair, then take the best pairs greedily so each
  // system is used at most once.
  const pairs = [];
  gList.forEach((g, gi) =>
    jList.forEach((j, ji) => {
      const score = matchScore(g, j);
      if (score !== null) pairs.push({ gi, ji, score });
    }),
  );
  pairs.sort((a, b) => a.score - b.score);

  const gUsed = new Set();
  const jUsed = new Set();
  const out = [];
  for (const { gi, ji } of pairs) {
    if (gUsed.has(gi) || jUsed.has(ji)) continue;
    gUsed.add(gi);
    jUsed.add(ji);
    out.push(mergePair(gList[gi], jList[ji]));
  }
  jList.forEach((j, i) => jUsed.has(i) || out.push(j));
  gList.forEach((g, i) => gUsed.has(i) || out.push(g));
  return out;
}

function isUsable(s) {
  return s && s.position && Number.isFinite(s.position.lat) && Number.isFinite(s.position.lon);
}

const normName = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Lower is better; null = not the same storm. */
function matchScore(g, j) {
  const currentKm = haversineKm(g.position, j.position);
  if (g.designation && j.designation && g.designation.toUpperCase() === j.designation.toUpperCase()) return 0;
  const gn = normName(g.name);
  const jn = normName(j.name);
  if (gn && gn === jn && !gn.startsWith('invest') && currentKm <= NAME_MATCH_MAX_KM) return 1;

  const gt = timeOf(g.position.time);
  const jt = timeOf(j.position.time);
  if (gt === null || jt === null || Math.abs(gt - jt) > MATCH_HOURS * HOUR_MS) return null;
  // Compare at the same moment where a track allows it.
  const km = Math.min(
    currentKm,
    haversineKm(positionAt(g, jt), j.position),
    haversineKm(g.position, positionAt(j, gt)),
  );
  return km <= MATCH_KM ? 2 + km / 1000 : null;
}

/** Position of a system at `t` (ms), interpolated along its track when covered. */
function positionAt(system, t) {
  const pts = (system.track ?? []).filter((p) => timeOf(p.time) !== null).sort(byTime);
  if (pts.length >= 2 && t >= +pts[0].time && t <= +pts[pts.length - 1].time) {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (t <= +b.time) {
        const span = b.time - a.time;
        return interpolate(a, b, span > 0 ? (t - a.time) / span : 0);
      }
    }
  }
  return system.position;
}

function mergePair(g, j) {
  // Ties go to JTWC: its text products carry movement and gusts.
  const jNewer = (timeOf(j.issuedAt) ?? 0) >= (timeOf(g.issuedAt) ?? 0);
  const newer = jNewer ? j : g;
  const older = jNewer ? g : j;
  const kind = (KIND_RANK[j.kind] ?? 0) >= (KIND_RANK[g.kind] ?? 0) ? j.kind : g.kind;
  return {
    id: j.id,
    sources: [...new Set([...(g.sources ?? ['gdacs']), ...(j.sources ?? ['jtwc'])])],
    kind,
    name: j.kind === 'warning' && j.name ? j.name : g.name || j.name,
    designation: j.designation ?? g.designation ?? null,
    basin: j.basin ?? g.basin ?? null,
    issuedAt: newer.issuedAt ?? older.issuedAt ?? null,
    position: newer.position,
    windKt: newer.windKt ?? older.windKt ?? null,
    gustKt: newer.gustKt ?? older.gustKt ?? null,
    movement: newer.movement ?? older.movement ?? null,
    potential: j.potential ?? g.potential ?? null,
    track: combineTracks(newer.track, older.track),
    cone: g.cone ?? null,
    windAreas: g.windAreas ?? [],
    swath: g.swath ?? { kmh60: null, kmh90: null, kmh120: null },
    tcfa: j.tcfa ?? g.tcfa ?? null,
    alertLevel: g.alertLevel ?? null,
    final: Boolean(j.final || g.final),
    links: { ...(g.links ?? {}), ...(j.links ?? {}) },
  };
}

/**
 * Newest track wins; older observed history before it is kept so the map
 * still shows where the storm came from (JTWC warnings carry no history).
 */
function combineTracks(newerTrack, olderTrack) {
  const newer = (newerTrack ?? []).slice().sort(byTime);
  const older = olderTrack ?? [];
  if (!newer.length) return older.slice().sort(byTime);
  const first = +newer[0].time;
  const history = older.filter((p) => !p.forecast && +p.time < first - 30 * 60e3);
  return [...history, ...newer].sort(byTime);
}

// ---------------------------------------------------------------------------
// Analysis relative to home
// ---------------------------------------------------------------------------

/**
 * Measure a TropicalSystem against `home`.
 * @returns SystemAnalysis (see SPEC.md)
 */
export function analyzeSystem(system, home = HOME, now = new Date()) {
  const nowMs = +now;
  const pos = system.position;
  const distanceKm = haversineKm(home, pos);
  const bearingFromHome = bearingDeg(home, pos);

  const samples = buildSamples(system, home, nowMs);
  const closest = findClosest(samples, home, nowMs);
  const currentCls = currentClass(system);

  let imdKey;
  if (Number.isFinite(system.windKt)) imdKey = imdClassKey(system.windKt);
  else if (system.kind === 'warning') imdKey = CLS_TO_IMD[currentCls] ?? 'imd.d';
  else imdKey = 'imd.low';

  const inRegion = inBbox(pos, REGION_BBOX) || samples.some((s) => inBbox(s, REGION_BBOX));

  const insideCone = Boolean(system.cone?.geometry && pointInGeometry(home, system.cone.geometry));

  let insideWindKmh = 0;
  for (const area of system.windAreas ?? []) {
    const t = timeOf(area.time);
    if (t === null || t < nowMs - WIND_AREA_MAX_AGE_MS) continue;
    if (area.kmh > insideWindKmh && pointInGeometry(home, area.feature?.geometry)) insideWindKmh = area.kmh;
  }

  let tcfa = null;
  if (system.tcfa?.from && system.tcfa?.to) {
    const { distanceKm: d } = closestPointOnSegment(home, system.tcfa.from, system.tcfa.to);
    tcfa = { distanceToLineKm: d, insideCorridor: d <= (system.tcfa.halfWidthKm ?? 0) };
  }

  return {
    system,
    distanceKm,
    bearingFromHome,
    compassFromHome: compass16(bearingFromHome),
    movement: movementOf(system),
    samples,
    closest,
    imdClassKey: imdKey,
    jtwcClass: jtwcClassOf(system.windKt) ?? currentCls ?? null,
    inRegion,
    insideCone,
    insideWindKmh,
    tcfa,
    relevant: inRegion || distanceKm <= RELEVANT_KM,
  };
}

/**
 * Current position, then the future track densified to ≤ 1 h steps with
 * position and wind interpolated linearly (wind null if either end is null).
 */
function buildSamples(system, home, nowMs) {
  const pos = system.position;
  const startMs = timeOf(pos.time) ?? nowMs;
  const anchor = {
    time: new Date(startMs),
    lat: pos.lat,
    lon: pos.lon,
    windKt: Number.isFinite(system.windKt) ? system.windKt : null,
    forecast: false,
  };
  const future = (system.track ?? [])
    .filter((p) => timeOf(p.time) !== null && +p.time > startMs && Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .sort(byTime);

  const mk = (time, p, windKt, forecast) => ({
    time,
    hoursFromNow: (time - nowMs) / HOUR_MS,
    distanceKm: haversineKm(home, p),
    windKt,
    forecast,
    lat: p.lat,
    lon: p.lon,
  });

  const out = [mk(anchor.time, anchor, anchor.windKt, false)];
  let a = anchor;
  for (const b of future) {
    const spanMs = b.time - a.time;
    if (!(spanMs > 0)) continue;
    const n = Math.min(MAX_STEPS_PER_SEGMENT, Math.max(1, Math.ceil(spanMs / HOUR_MS - 1e-9)));
    const aWind = Number.isFinite(a.windKt) ? a.windKt : null;
    const bWind = Number.isFinite(b.windKt) ? b.windKt : null;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const last = k === n;
      const windKt = last ? bWind : aWind !== null && bWind !== null ? round1(aWind + (bWind - aWind) * t) : null;
      out.push(mk(new Date(+a.time + spanMs * t), interpolate(a, b, t), windKt, last ? Boolean(b.forecast) : Boolean(a.forecast || b.forecast)));
    }
    a = b;
  }
  return out;
}

const round1 = (x) => Math.round(x * 10) / 10;

/** Nearest sample, refined onto the neighbouring segments so a track passing overhead reads ~0 km. */
function findClosest(samples, home, nowMs) {
  if (!samples.length) return null;
  let bi = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i].distanceKm < samples[bi].distanceKm) bi = i;
  const best = samples[bi];
  let result = {
    distanceKm: best.distanceKm,
    time: best.time,
    hoursFromNow: best.hoursFromNow,
    lat: best.lat,
    lon: best.lon,
    isForecast: best.forecast,
  };
  for (const [ia, ib] of [[bi - 1, bi], [bi, bi + 1]]) {
    const a = samples[ia];
    const b = samples[ib];
    if (!a || !b) continue;
    const c = closestPointOnSegment(home, a, b);
    if (c.distanceKm < result.distanceKm - 1e-6) {
      const time = new Date(+a.time + (b.time - a.time) * c.t);
      result = {
        distanceKm: c.distanceKm,
        time,
        hoursFromNow: (time - nowMs) / HOUR_MS,
        lat: c.point.lat,
        lon: c.point.lon,
        isForecast: c.t <= 1e-9 ? a.forecast : c.t >= 1 - 1e-9 ? b.forecast : Boolean(a.forecast || b.forecast),
      };
    }
  }
  return result;
}

function movementOf(system) {
  const m = system.movement;
  if (m && Number.isFinite(m.bearing) && Number.isFinite(m.speedKt)) {
    const speedKmh = m.speedKt * KT_TO_KMH;
    return speedKmh >= MIN_MOVING_KMH ? { speedKmh, bearing: m.bearing, compass: compass16(m.bearing) } : null;
  }
  const obs = (system.track ?? []).filter((p) => !p.forecast && timeOf(p.time) !== null).sort(byTime);
  if (obs.length < 2) return null;
  const a = obs[obs.length - 2];
  const b = obs[obs.length - 1];
  const hours = (b.time - a.time) / HOUR_MS;
  if (!(hours > 0) || hours > 24) return null;
  const speedKmh = haversineKm(a, b) / hours;
  if (speedKmh < MIN_MOVING_KMH) return null;
  const bearing = bearingDeg(a, b);
  return { speedKmh, bearing, compass: compass16(bearing) };
}

/** Class label of the track point at the current position (or the last observed one). */
function currentClass(system) {
  const t = timeOf(system.position?.time);
  const track = system.track ?? [];
  const exact = t !== null ? track.find((p) => timeOf(p.time) === t && p.cls) : null;
  if (exact) return exact.cls;
  const observed = track.filter((p) => !p.forecast && p.cls).sort(byTime);
  return observed.length ? observed[observed.length - 1].cls : null;
}

/**
 * Sort analyses by storm threat (desc, unknown last) then distance.
 * `levelOf(analysis)` may return a number, null, or `{ level }`.
 */
export function sortAnalyses(list, levelOf = () => 0) {
  const levelNum = (a) => {
    let v = levelOf(a);
    if (v && typeof v === 'object') v = v.level;
    return Number.isFinite(v) ? v : -1;
  };
  const levels = new Map((list ?? []).map((a) => [a, levelNum(a)]));
  return [...(list ?? [])].sort(
    (a, b) => levels.get(b) - levels.get(a) || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity),
  );
}
