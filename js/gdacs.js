// GDACS tropical cyclones: event list, geometry (track, cone, wind areas)
// and timeline (per-point wind). Format notes: research_gdacs-format.md.
// GDACS lags and can miss Bay of Bengal systems entirely, so an empty list
// is never an "all clear" on its own (risk.js decides that).

import { HOME, REGION_BBOX, URLS } from './config.js';
import { haversineKm, inBbox, wrapLonDelta } from './geo.js';
import { fetchJson, mapLimit } from './net.js';
import { classMinWindKt, jtwcClassOf, titleCase } from './systems.js';

const MS_TO_KT = 1.943844;
const HOUR_MS = 3600e3;
const LOOKBACK_DAYS = 14;
// GDACS keeps `iscurrent` "true" for days after a storm ends.
const ACTIVE_MAX_AGE_MS = 24 * HOUR_MS;
// Only storms this close (or inside REGION_BBOX) get the heavier detail fetches.
const DETAIL_RADIUS_KM = 4000;
// A failed detail fetch for a storm this close (or in REGION_BBOX) is a gap in coverage.
const DETAIL_MATTERS_KM = 2500;
// Geometry and timeline only change with a new GDACS episode: keep them per episode.
const EPISODE_CACHE_MAX = 12;
const MAX_IN_FLIGHT = 4;
// Track circles are centred exactly on the point (research: ≤ 0.01° error).
const MATCH_TOL_DEG = 0.02;
// ~100 m: plenty for drawing and point-in-polygon, halves cached size.
const COORD_DECIMALS = 3;
const AREA_KMH = { Poly_Green: 60, Poly_Orange: 90, Poly_Red: 120 };
const FETCH_OPTS = { cache: 'no-cache' };
const GDACS_ORIGIN = 'https://www.gdacs.org/';

// ---------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------

const isTrue = (v) => v === true || String(v).trim().toLowerCase() === 'true';

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/** GDACS ISO strings carry no zone but are UTC. */
function parseUtc(s) {
  if (!s || typeof s !== 'string') return null;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** Timeline `advisory_datetime`, e.g. "22 Sep 2026 18:00" (UTC). */
function parseAdvisoryDatetime(s) {
  const m = /(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(s ?? ''));
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (mo !== undefined) return new Date(Date.UTC(+m[3], mo, +m[1], +m[4], +m[5]));
  }
  return parseUtc(s);
}

/**
 * Month/day/hour/minute with the year taken from `ref`: a month more than
 * six months after the reference month belongs to the previous year, more
 * than six before to the next (Dec→Jan storms).
 */
function withInferredYear(month, day, hour, minute, ref) {
  if (!(ref instanceof Date) || !(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const refMonth = ref.getUTCMonth() + 1;
  let year = ref.getUTCFullYear();
  if (month - refMonth > 6) year -= 1;
  else if (refMonth - month > 6) year += 1;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return d.getUTCDate() === day ? d : null;
}

/** Time of a track point from `key` "MMDDHHmm", or its label "dd/mm HH:MM UTC". */
function pointTime(props, ref) {
  const k = /^(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(props.key ?? ''));
  if (k) return withInferredYear(+k[1], +k[2], +k[3], +k[4], ref);
  const l = /(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/.exec(String(props.polygonlabel ?? ''));
  if (l) return withInferredYear(+l[2], +l[1], +l[3], +l[4], ref);
  return null;
}

const isArea = (g) =>
  (g?.type === 'Polygon' || g?.type === 'MultiPolygon') && Array.isArray(g.coordinates) && g.coordinates.length > 0;

function roundCoords(c) {
  if (Array.isArray(c)) return c.map(roundCoords);
  const f = 10 ** COORD_DECIMALS;
  return typeof c === 'number' ? Math.round(c * f) / f : c;
}

/** A light GeoJSON Feature: GDACS repeats all event properties on every feature. */
function slimFeature(g) {
  return { type: 'Feature', properties: {}, geometry: { type: g.type, coordinates: roundCoords(g.coordinates) } };
}

const round2 = (x) => Math.round(x * 100) / 100 + 0; // + 0 turns -0 into 0

/** Mean of a circle polygon's vertices (seam-aware), rounded to 0.01°. */
function circleCentre(g) {
  if (g?.type === 'Point') return { lat: num(g.coordinates?.[1]), lon: num(g.coordinates?.[0]) };
  const ring = g?.type === 'Polygon' ? g.coordinates?.[0] : g?.type === 'MultiPolygon' ? g.coordinates?.[0]?.[0] : null;
  if (!Array.isArray(ring) || !ring.length) return null;
  let n = ring.length;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[n - 1];
  if (n > 1 && fx === lx && fy === ly) n -= 1; // closing vertex
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += wrapLonDelta(ring[i][0] - fx);
    sy += ring[i][1];
  }
  return { lat: round2(sy / n), lon: round2(wrapLonDelta(fx + sx / n)) };
}

const near = (p, lon, lat) =>
  Math.abs(p.lat - lat) <= MATCH_TOL_DEG && Math.abs(wrapLonDelta(p.lon - lon)) <= MATCH_TOL_DEG;

// ---------------------------------------------------------------------------
// Event list
// ---------------------------------------------------------------------------

/** Event-list URL: TCs of every alert level updated in the last 14 days. */
export function buildEventListUrl(now = new Date()) {
  const from = new Date(+now - LOOKBACK_DAYS * 24 * HOUR_MS).toISOString().slice(0, 10);
  return `${URLS.gdacsBase}/events/geteventlist/SEARCH?eventlist=TC&alertlevel=Green;Orange;Red&fromdate=${from}`;
}

/**
 * Parse the event list (null for GDACS's 204 "no events" → []).
 * @returns {Array<{eventId:number, episodeId:number|null, eventName:string, name:string,
 *   fromDate:Date|null, toDate:Date|null, isCurrent:boolean, alertLevel:string|null,
 *   episodeAlertLevel:string|null, source:string|null, country:string|null, lat:number, lon:number,
 *   severityKmh:number|null}>}
 */
export function parseEventList(json) {
  const features = Array.isArray(json?.features) ? json.features : [];
  const byId = new Map();
  for (const f of features) {
    const p = f?.properties;
    if (!p || (p.eventtype ?? 'TC') !== 'TC') continue;
    const eventId = num(p.eventid);
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    const lon = num(c?.[0]);
    const lat = num(c?.[1]);
    if (eventId === null || lat === null || lon === null) continue;
    const eventName = String(p.eventname ?? p.name ?? '').trim();
    const ev = {
      eventId,
      episodeId: num(p.episodeid),
      eventName,
      name: displayName(eventName || p.name),
      fromDate: parseUtc(p.fromdate),
      toDate: parseUtc(p.todate),
      isCurrent: isTrue(p.iscurrent),
      alertLevel: alertLevel(p.alertlevel),
      episodeAlertLevel: alertLevel(p.episodealertlevel),
      source: p.source ? String(p.source) : null,
      country: p.country ? String(p.country) : null,
      lat,
      lon,
      severityKmh: num(p.severitydata?.severity), // lifetime MAXIMUM — never the current wind
      // The category word of `severitytext` is the CURRENT state (its number is the lifetime max).
      statusCls: clsFromStatus(p.severitydata?.severitytext),
    };
    const prev = byId.get(eventId);
    if (!prev || (ev.episodeId ?? -1) >= (prev.episodeId ?? -1)) byId.set(eventId, ev);
  }
  return [...byId.values()];
}

function alertLevel(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'green' ? 'Green' : s === 'orange' ? 'Orange' : s === 'red' ? 'Red' : null;
}

/** "Hurricane/Typhoon > 74 mph (maximum …)" → 'HU'; RSMC wording included. */
function clsFromStatus(text) {
  const word = String(text ?? '').replace(/\(.*$/, '').trim();
  if (/hurricane|typhoon|intense tropical cyclone|^tropical cyclone/i.test(word)) return 'HU';
  if (/tropical storm/i.test(word)) return 'TS';
  if (/depression/i.test(word)) return 'TD';
  return null;
}

/** 'SURIGAE-26' / 'Tropical Cyclone SURIGAE-26' → 'Surigae'. Markup and control characters are dropped. */
function displayName(s) {
  const bare = String(s ?? '')
    .replace(/[<>\u0000-\u001f\u007f]/g, '')
    .replace(/^\s*tropical\s+cyclone\s+/i, '')
    .replace(/-\d{2}\s*$/, '')
    .trim()
    .slice(0, 40);
  return titleCase(bare);
}

/** Active now: GDACS says current AND the latest advisory is < 24 h old. */
export function isActiveEvent(ev, now = new Date()) {
  const t = ev?.toDate instanceof Date ? ev.toDate.getTime() : NaN;
  return Boolean(ev?.isCurrent) && Number.isFinite(t) && +now - t < ACTIVE_MAX_AGE_MS;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Parse `getgeometry` GeoJSON.
 * Points come from the `Point_Polygon_Point_N` circles (centre = mean of
 * vertices); times from `key` with the year inferred against `polygondate`
 * (the advisory time); forecast = time > advisory time. Class labels come
 * from `Line_Line_N` segments matched to their later endpoint by position —
 * line order and line `forecast` flags are unreliable and ignored.
 * @returns {{points: object[], cone: object|null, windAreas: object[],
 *   swath: {kmh60, kmh90, kmh120}, advisoryTime: Date|null}}
 */
export function parseGeometry(json) {
  const features = Array.isArray(json?.features) ? json.features : [];
  const circles = [];
  const lines = [];
  const radii = [];
  let cone = null;
  const swath = { kmh60: null, kmh90: null, kmh120: null };

  for (const f of features) {
    const p = f?.properties ?? {};
    const cls = String(p.Class ?? '');
    const g = f?.geometry;
    const m = /^Point_Polygon_Point_(\d+)$/.exec(cls);
    if (m) circles.push({ n: +m[1], p, g });
    else if (/^Line_Line_\d+$/.test(cls)) lines.push({ label: String(p.polygonlabel ?? '').trim().toUpperCase(), g });
    else if (cls === 'Poly_Cones') {
      if (!cone && isArea(g)) cone = slimFeature(g);
    } else if (cls in AREA_KMH && isArea(g)) {
      if (p.featuretype === 'WindRadii') radii.push({ kmh: AREA_KMH[cls], p, g });
      else if (!p.featuretype) swath[`kmh${AREA_KMH[cls]}`] = slimFeature(g);
    }
  }

  circles.sort((a, b) => a.n - b.n);
  const advisoryTime = parseUtc(circles.find((c) => c.p.polygondate)?.p.polygondate);

  const points = [];
  for (const c of circles) {
    const centre = circleCentre(c.g);
    const time = pointTime(c.p, advisoryTime);
    if (!centre || centre.lat === null || centre.lon === null || !time) continue;
    points.push({
      time,
      lat: centre.lat,
      lon: centre.lon,
      forecast: advisoryTime ? time > advisoryTime : false,
      windKt: null,
      cls: null,
      clsMatched: false,
    });
  }
  points.sort((a, b) => a.time - b.time); // stable: keeps N order on ties

  assignLineClasses(points, lines);

  const windAreas = radii
    .map(({ kmh, p, g }) => ({ kmh, time: parseUtc(p.polygondate) ?? pointTime(p, advisoryTime), feature: slimFeature(g) }))
    .filter((a) => a.time)
    .sort((a, b) => a.time - b.time || a.kmh - b.kmh);

  return { points, cone, windAreas, swath, advisoryTime };
}

/** A line's TD/TS/HU label describes its later endpoint (JTWC/NOAA). */
function assignLineClasses(points, lines) {
  const matches = (c) =>
    Array.isArray(c) ? points.flatMap((p, i) => (near(p, num(c[0]), num(c[1])) ? [i] : [])) : [];
  for (const { label, g } of lines) {
    if (!/^(TD|TS|HU)$/.test(label) || g?.type !== 'LineString' || !(g.coordinates?.length >= 2)) continue;
    const a = matches(g.coordinates[0]);
    const b = matches(g.coordinates[g.coordinates.length - 1]);
    // Split ±180 pieces match only one end and are skipped; gaps get filled below.
    let target = -1;
    for (const i of a)
      for (const j of b)
        if (Math.abs(i - j) === 1) {
          const k = Math.max(i, j);
          if (target < 0 || (points[target].cls && !points[k].cls)) target = k;
        }
    if (target > 0 && !points[target].cls) {
      points[target].cls = label;
      points[target].clsMatched = true;
    }
  }
  for (let i = 1; i < points.length; i++) if (!points[i].cls) points[i].cls = points[i - 1].cls;
  for (let i = points.length - 2; i >= 0; i--) if (!points[i].cls) points[i].cls = points[i + 1].cls;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Parse `gettimeline` JSON (items may be an array or a single object).
 * Wind is m/s in the feed; converted to knots.
 * @returns {Array<{time:Date, lat, lon, forecast:boolean, current:boolean, windKt:number|null,
 *   gustKt:number|null, pressureHpa:number|null, status:string|null}>} chronological
 */
export function parseTimeline(json) {
  const raw = json?.channel?.item;
  const items = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const time = parseAdvisoryDatetime(it.advisory_datetime);
    const lat = num(it.latitude);
    const lon = num(it.longitude);
    if (!time || lat === null || lon === null) continue;
    const ws = num(it.wind_speed);
    const wg = num(it.wind_gusts);
    const pr = num(it.pressure);
    const status = Array.isArray(it.storm_status) ? it.storm_status[0] : it.storm_status;
    out.push({
      time,
      lat,
      lon,
      forecast: !isTrue(it.actual),
      current: isTrue(it.current),
      windKt: ws !== null && ws > 0 ? Math.round(ws * MS_TO_KT) : null,
      gustKt: wg !== null && wg > 0 ? Math.round(wg * MS_TO_KT) : null,
      pressureHpa: pr !== null && pr > 0 ? pr : null, // "0" = missing
      status: status ? String(status) : null,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}

// ---------------------------------------------------------------------------
// TropicalSystem
// ---------------------------------------------------------------------------

/**
 * Merge timeline wind into geometry points by index (when times agree) or by
 * time. Without a wind value, a TS/HU label that came from GDACS's own line
 * for that point becomes `windKtMin` (34/64 kt), so risk.js still knows the
 * storm is at least that strong.
 */
function mergeTrack(points, timeline) {
  const fromTimeline = (t) => ({
    time: t.time,
    lat: t.lat,
    lon: t.lon,
    forecast: t.forecast,
    windKt: t.windKt,
    cls: jtwcClassOf(t.windKt),
  });
  if (!points.length) return timeline.map(fromTimeline);
  const sameIndex =
    points.length === timeline.length && points.every((p, i) => Math.abs(p.time - timeline[i].time) < 60e3);
  const byTime = new Map(timeline.map((t) => [t.time.getTime(), t]));
  return points.map((p, i) => {
    const t = sameIndex ? timeline[i] : byTime.get(p.time.getTime());
    const windKt = t?.windKt ?? null;
    const out = { time: p.time, lat: p.lat, lon: p.lon, forecast: p.forecast, windKt, cls: jtwcClassOf(windKt) ?? p.cls };
    const floor = windKt === null && p.clsMatched ? classMinWindKt(p.cls) : null;
    if (floor !== null) out.windKtMin = floor;
    return out;
  });
}

/** Rough basin from position (GDACS gives none). Only NIO vs WPAC matters here. */
function basinOf(lat, lon) {
  if (lat < 0) return 'SH';
  if (lon >= 30 && lon < 100) return 'NIO';
  if (lon >= 100) return 'WPAC';
  if (lon < -140) return 'CPAC';
  if (lon < -100 || (lon < -85 && lat < 15.5)) return 'EPAC';
  return 'ATL';
}

/**
 * Build a TropicalSystem from an event (parseEventList item) plus optional
 * geometry and timeline (raw GDACS JSON or already parsed).
 * Current wind comes from the timeline's current point only — the event's
 * `severity` is the lifetime maximum and would overstate a weakening storm.
 */
export function toSystem(event, geometry = null, timeline = null) {
  const geo = geometry?.features ? parseGeometry(geometry) : geometry?.points ? geometry : null;
  const tl = Array.isArray(timeline) ? timeline : timeline ? parseTimeline(timeline) : [];
  let track = mergeTrack(geo?.points ?? [], tl);

  // Candidates for "now": the timeline's current point, the geometry's latest
  // observed point, the event-list centroid. The newest wins.
  const lastObs = (list) => [...list].reverse().find((p) => !p.forecast) ?? null;
  const tlCurrent = tl.find((t) => t.current) ?? lastObs(tl);
  const candidates = [
    tlCurrent && { lat: tlCurrent.lat, lon: tlCurrent.lon, time: tlCurrent.time },
    lastObs(geo?.points ?? []),
    { lat: event.lat, lon: event.lon, time: event.toDate ?? null },
  ].filter((c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon));
  const best = candidates.reduce((a, c) => ((c.time?.getTime() ?? -Infinity) > (a.time?.getTime() ?? -Infinity) ? c : a));
  const position = { lat: best.lat, lon: best.lon, time: best.time ?? null };

  let windKt = null;
  let gustKt = null;
  if (tlCurrent && position.time && Math.abs(tlCurrent.time - position.time) <= 6 * HOUR_MS) {
    windKt = tlCurrent.windKt;
    gustKt = tlCurrent.gustKt;
  }
  const atPosition = position.time ? track.find((p) => +p.time === +position.time && p.windKt !== null) : null;
  if (atPosition) windKt = atPosition.windKt;
  // No detail fetched (far away): the current fix alone, classed from the event's status word.
  if (!track.length && position.time) {
    track = [{ time: position.time, lat: position.lat, lon: position.lon, forecast: false, windKt: null, cls: event.statusCls ?? null }];
  }
  // Wind unknown but the class at the current position is: its floor (never the event's lifetime maximum).
  let windKtMin = null;
  if (windKt === null && position.time) {
    const here = track.find((p) => +p.time === +position.time);
    windKtMin = Number.isFinite(here?.windKtMin) ? here.windKtMin : null;
  }

  const issued = [geo?.advisoryTime, event.toDate].filter((d) => d instanceof Date);
  return {
    id: `gdacs:${event.eventId}`,
    sources: ['gdacs'],
    kind: 'warning',
    name: event.name || displayName(event.eventName) || `GDACS ${event.eventId}`,
    designation: null,
    basin: basinOf(position.lat, position.lon),
    issuedAt: issued.length ? new Date(Math.max(...issued.map(Number))) : null,
    position,
    windKt,
    windKtMin,
    gustKt,
    movement: null, // analyzeSystem derives it from the last two observed points
    potential: null,
    track,
    cone: geo?.cone ?? null,
    windAreas: geo?.windAreas ?? [],
    swath: geo?.swath ?? { kmh60: null, kmh90: null, kmh120: null },
    tcfa: null,
    alertLevel: event.alertLevel ?? null,
    final: !event.isCurrent,
    links: { gdacsReport: URLS.gdacsReport(event.eventId, event.episodeId ?? '') },
  };
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

function wantsDetail(ev, home) {
  return haversineKm(home, ev) <= DETAIL_RADIUS_KM || inBbox(ev, REGION_BBOX);
}

/** Close enough that missing detail (track, wind) weakens the attention level. */
function detailMatters(ev, home) {
  return haversineKm(home, ev) <= DETAIL_MATTERS_KM || inBbox(ev, REGION_BBOX);
}

function geometryUrl(ev) {
  const ep = ev.episodeId !== null ? `&episodeid=${ev.episodeId}` : '';
  return `${URLS.gdacsBase}/polygons/getgeometry?eventtype=TC&eventid=${ev.eventId}${ep}`;
}

const eventDataUrl = (ev) => `${URLS.gdacsBase}/events/geteventdata?eventtype=TC&eventid=${ev.eventId}`;

/** The episode's timeline URL from `geteventdata` (only GDACS URLs are trusted). */
function timelineUrlFrom(eventData, source) {
  const impacts = eventData?.properties?.impacts ?? eventData?.impacts;
  if (!Array.isArray(impacts)) return null;
  const pick = impacts.find((i) => i?.source === source && i?.resource?.timeline) ?? impacts.find((i) => i?.resource?.timeline);
  const url = pick?.resource?.timeline;
  return typeof url === 'string' && url.startsWith(GDACS_ORIGIN) ? url : null;
}

const errText = (e) => (e && e.message) || String(e);

// Parsed geometry + timeline per `${eventId}:${episodeId}` (only complete ones are kept).
const episodeCache = new Map();

/** Forget cached episode detail (tests). */
export function clearGdacsCache() {
  episodeCache.clear();
}

/**
 * Current GDACS systems. Never throws. `partial` is true when the track or
 * wind detail of a storm near Myanmar could not be loaded: the systems are
 * still usable, but GDACS coverage is incomplete.
 * @returns {Promise<{systems: object[], ok: boolean, partial?: boolean, error?: string, errors: string[]}>}
 */
export async function fetchGdacs(now = new Date(), home = HOME) {
  let events;
  try {
    events = parseEventList(await fetchJson(buildEventListUrl(now), FETCH_OPTS));
  } catch (err) {
    return { systems: [], ok: false, error: `GDACS event list: ${errText(err)}`, errors: [] };
  }
  const errors = [];
  let partial = false;
  try {
    const active = events.filter((ev) => isActiveEvent(ev, now));
    const activeKeys = new Set(active.map((ev) => `${ev.eventId}:${ev.episodeId}`));
    for (const key of episodeCache.keys()) if (!activeKeys.has(key)) episodeCache.delete(key);
    const systems = await mapLimit(active, MAX_IN_FLIGHT, async (ev) => {
      if (!wantsDetail(ev, home)) return toSystem(ev);
      const key = `${ev.eventId}:${ev.episodeId}`;
      const cached = ev.episodeId !== null ? episodeCache.get(key) : null;
      if (cached) return toSystem(ev, cached.geometry, cached.timeline);
      // Sequential per event so mapLimit's limit is the real in-flight limit.
      let geometry = null;
      let timeline = null;
      const missing = [];
      try {
        geometry = await fetchJson(geometryUrl(ev), FETCH_OPTS);
        if (!geometry?.features) missing.push('geometry');
      } catch (err) {
        missing.push('geometry');
        errors.push(`GDACS geometry ${ev.eventName}: ${errText(err)}`);
      }
      try {
        const url = timelineUrlFrom(await fetchJson(eventDataUrl(ev), FETCH_OPTS), ev.source);
        if (url) timeline = await fetchJson(url, FETCH_OPTS);
        if (!url) errors.push(`GDACS timeline ${ev.eventName}: no timeline in the event data`);
        else if (!parseTimeline(timeline).length) errors.push(`GDACS timeline ${ev.eventName}: empty timeline`);
        if (!url || !parseTimeline(timeline).length) missing.push('timeline');
      } catch (err) {
        missing.push('timeline');
        errors.push(`GDACS timeline ${ev.eventName}: ${errText(err)}`);
      }
      if (missing.length && detailMatters(ev, home)) partial = true;
      try {
        const geo = geometry?.features ? parseGeometry(geometry) : null;
        const tl = timeline ? parseTimeline(timeline) : null;
        if (!missing.length && ev.episodeId !== null) {
          episodeCache.set(key, { geometry: geo, timeline: tl });
          while (episodeCache.size > EPISODE_CACHE_MAX) episodeCache.delete(episodeCache.keys().next().value);
        }
        return toSystem(ev, geo, tl);
      } catch (err) {
        errors.push(`GDACS parse ${ev.eventName}: ${errText(err)}`);
        partial = partial || detailMatters(ev, home);
        return toSystem(ev);
      }
    });
    return { systems: systems.filter(Boolean), ok: true, partial, errors };
  } catch (err) {
    return { systems: [], ok: false, error: `GDACS: ${errText(err)}`, errors };
  }
}
