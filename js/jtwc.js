// JTWC (Joint Typhoon Warning Center): RSS feed, warning texts, formation
// alerts (TCFA) and the daily significant tropical weather advisories that
// list invest areas. JTWC often flags early Bay of Bengal / Andaman systems
// before GDACS lists them at all. Parsing is regex-based so it runs in Node.

import { HOME, NM_TO_KM, URLS } from './config.js';
import { haversineKm, wrapLonDelta } from './geo.js';
import { fetchText, mapLimit } from './net.js';
import { jtwcClassOf, titleCase } from './systems.js';

const HOUR_MS = 3600e3;
const MAX_IN_FLIGHT = 4;
// Basins whose product texts we fetch (North Indian Ocean, western North Pacific).
const FETCH_PREFIXES = new Set(['io', 'wp']);
// Far-off western Pacific systems are left to GDACS ("Elsewhere").
const WPAC_KEEP_WEST_OF_LON = 110;
const WPAC_KEEP_WITHIN_KM = 2500;
const KIND_RANK = { warning: 3, tcfa: 2, invest: 1 };
// An invest this close to a warned system (in space and time) is that system.
const SAME_SYSTEM_KM = 300;
const SAME_SYSTEM_HOURS = 24;
// Two fixes this close (degrees) are the same fix repeated.
const SAME_FIX_DEG = 0.1;
const FETCH_OPTS = { cache: 'no-cache' };

// "14.4N 98.0E" (also tolerates "14.4 N 98.0 E").
const LATLON = String.raw`(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3}(?:\.\d+)?)\s*([EW])`;

const COMPASS_WORDS = {
  NORTH: 0,
  'NORTH-NORTHEAST': 22.5,
  NORTHEAST: 45,
  'EAST-NORTHEAST': 67.5,
  EAST: 90,
  'EAST-SOUTHEAST': 112.5,
  SOUTHEAST: 135,
  'SOUTH-SOUTHEAST': 157.5,
  SOUTH: 180,
  'SOUTH-SOUTHWEST': 202.5,
  SOUTHWEST: 225,
  'WEST-SOUTHWEST': 247.5,
  WEST: 270,
  'WEST-NORTHWEST': 292.5,
  NORTHWEST: 315,
  'NORTH-NORTHWEST': 337.5,
};

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a JTWC "DDHHMM" (optionally with trailing Z) to a Date: of the
 * candidate months around `ref`, pick the one closest to `ref` (handles
 * month and year rollover).
 */
export function parseDayTime(ddhhmm, ref = new Date()) {
  const m = /^(\d{2})(\d{2})(\d{2})Z?$/.exec(String(ddhhmm ?? '').trim());
  if (!m) return null;
  const [day, hour, minute] = [+m[1], +m[2], +m[3]];
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const r = ref instanceof Date && !Number.isNaN(+ref) ? ref : new Date();
  let best = null;
  for (let delta = -1; delta <= 1; delta++) {
    const d = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + delta, day, hour, minute));
    if (d.getUTCDate() !== day) continue; // e.g. 31 in a 30-day month
    if (!best || Math.abs(d - r) < Math.abs(best - r)) best = d;
  }
  return best;
}

function latLon(latS, ns, lonS, ew) {
  const lat = parseFloat(latS) * (ns === 'S' ? -1 : 1);
  const lon = parseFloat(lonS) * (ew === 'W' ? -1 : 1);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon: lon > 180 || lon < -180 ? wrapLonDelta(lon) : lon };
}

const flat = (text) => String(text ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();

/** Storm name from a feed, as display text: markup and control characters dropped, title case. */
function cleanName(raw) {
  const s = String(raw ?? '').replace(/[<>\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return s ? titleCase(s) : null;
}

/** WMO header, e.g. "WTPN31 PGTW 281500" → { header: 'WTPN31', issuedAt }. */
function parseHeader(text, now) {
  const m = /(?:^|\s)([A-Z]{4}\d{2})\s+([A-Z]{4})\s+(\d{6})\b/.exec(String(text ?? '').slice(0, 400));
  return m ? { header: m[1], issuedAt: parseDayTime(m[3], now) } : { header: null, issuedAt: null };
}

/**
 * Basin: an Indian Ocean product header wins (JTWC numbers some Andaman Sea
 * systems with a W suffix, e.g. today's 92W); otherwise the designation
 * suffix, then the product-file prefix.
 */
function basinOf(header, designation, prefix) {
  const h = String(header ?? '').slice(0, 4);
  if (h === 'WTIO' || h === 'ABIO') return 'NIO';
  if (h === 'WTXS' || h === 'WTPS' || h === 'WTSH') return 'SH';
  const suffix = /\d{2}([A-Z])$/.exec(designation ?? '')?.[1];
  const bySuffix = { A: 'NIO', B: 'NIO', W: 'WPAC', E: 'EPAC', C: 'CPAC', L: 'ATL', S: 'SH', P: 'SH', U: 'SH' }[suffix];
  if (bySuffix) return bySuffix;
  return { io: 'NIO', wp: 'WPAC', ep: 'EPAC', cp: 'CPAC', sh: 'SH' }[prefix] ?? null;
}

function movementFrom(word, speed) {
  const bearing = COMPASS_WORDS[String(word ?? '').toUpperCase()];
  const speedKt = parseFloat(speed);
  if (bearing === undefined || !Number.isFinite(speedKt) || speedKt <= 0) return null;
  return { bearing, speedKt };
}

/** "23 TO 28 KNOTS" → 28 (upper bound), "25 KNOTS" → 25. */
function windUpper(lo, hi) {
  const v = parseFloat(hi ?? lo);
  return Number.isFinite(v) ? v : null;
}

function potentialIn(t) {
  const m =
    /POTENTIAL FOR THE DEVELOPMENT OF A SIGNIFICANT TROPICAL CYCLONE[^.]*?\b(?:IS\s+(?:(?:UPGRADED|DOWNGRADED)\s+TO\s+|NOW\s+)?|REMAINS\s+)(LOW|MEDIUM|HIGH)\b/.exec(t);
  return m ? m[1] : null;
}

function blankSystem(fields) {
  return {
    sources: ['jtwc'],
    designation: null,
    basin: null,
    issuedAt: null,
    windKt: null,
    gustKt: null,
    movement: null,
    potential: null,
    track: [],
    cone: null,
    windAreas: [],
    swath: { kmh60: null, kmh90: null, kmh120: null },
    tcfa: null,
    alertLevel: null,
    final: false,
    links: {},
    ...fields,
  };
}

const point = (time, pos, windKt, forecast) => ({
  time,
  lat: pos.lat,
  lon: pos.lon,
  forecast,
  windKt,
  cls: jtwcClassOf(windKt),
});

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}

const stripTags = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Absolute product URL rebuilt from the file name (keeps us on the known CORS host). */
function productUrl(href) {
  const file = /([a-z0-9_]+\.(?:txt|gif|jpg))(?:[?#].*)?$/i.exec(String(href ?? ''))?.[1];
  return file ? URLS.jtwcProducts + file : null;
}

/**
 * Parse the JTWC RSS feed into product entries (warnings and TCFAs).
 * @returns {Array<{title:string, kind:'warning'|'tcfa', designation:string|null, name:string|null,
 *   issuedText:string|null, textUrl:string, graphicUrl:string|null, final:boolean, basinPrefix:string}>}
 */
export function parseRss(xmlText) {
  const out = [];
  const xml = String(xmlText ?? '');
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const d = /<description\b[^>]*>([\s\S]*?)<\/description>/i.exec(item)?.[1] ?? '';
    const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(d);
    const html = cdata ? cdata[1] : decodeEntities(d);
    // Each product block ends with its <ul> of links.
    for (const block of html.split(/<\/ul>/i)) {
      const issued = /\bIssued at\s+(\d{2}\/\d{4}Z)/.exec(block);
      if (!issued) continue;
      const title = stripTags(block.slice(0, issued.index));
      const kind = /formation alert/i.test(title) ? 'tcfa' : /warning/i.test(title) ? 'warning' : null;
      const hrefs = [...block.matchAll(/href\s*=\s*['"]([^'"]+)['"]/gi)].map((m) => decodeEntities(m[1]));
      const textHref = hrefs.find((h) => /\/[a-z]{2}\d{4}web\.txt(?:$|[?#])/i.test(h));
      if (!kind || !textHref) continue;
      const file = /\/([a-z]{2})(\d{2})(\d{2})web\.txt/i.exec(textHref);
      const basinPrefix = file[1].toLowerCase();
      const graphicHref = hrefs.find((h) => /\/[a-z]{2}\d{4}\.gif(?:$|[?#])/i.test(h));
      const sairDes = hrefs.map((h) => /\/(\d{2}[A-Z])_\d{6}sair\.jpg/i.exec(h)?.[1]).find(Boolean);
      const letter = { wp: 'W', ep: 'E', cp: 'C' }[basinPrefix];
      const designation =
        /\b(\d{2}[A-Z])\b/.exec(title)?.[1]?.toUpperCase() ??
        sairDes?.toUpperCase() ??
        (letter ? `${file[2]}${letter}` : null);
      const nameRaw = kind === 'warning' ? /\(([^)]+)\)/.exec(title)?.[1] : null;
      out.push({
        title,
        kind,
        designation,
        name: cleanName(nameRaw),
        issuedText: issued[1],
        textUrl: productUrl(textHref),
        graphicUrl: graphicHref ? productUrl(graphicHref) : null,
        final: /final warning/i.test(title),
        basinPrefix,
        // Product file key ('io93', 'wp92'): identifies a product even when its designation letter is unknown.
        productKey: `${basinPrefix}${file[2]}`,
        cancelled: /cancel/i.test(title),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Warning text (e.g. wp2526web.txt)
// ---------------------------------------------------------------------------

/**
 * Parse a numbered JTWC warning.
 * @returns TropicalSystem (kind 'warning') or null if the text is not a warning.
 */
export function parseWarningText(text, now = new Date()) {
  const t = flat(text).toUpperCase();
  const { header, issuedAt } = parseHeader(t, now);
  const ref = issuedAt ?? now;
  const subj = /SUBJ\/(.*?)\s*(\d{2}[A-Z])(?:\s*\(([^)]*)\))?\s+WARNING\s+NR\s+(\d+)/.exec(t);
  const posM = new RegExp(String.raw`WARNING POSITION:\s*(\d{6})Z\s*-+\s*NEAR\s+${LATLON}`).exec(t);
  if (!subj || !posM) return null;
  const designation = subj[2];
  const position = { ...latLon(posM[2], posM[3], posM[4], posM[5]), time: parseDayTime(posM[1], ref) };

  const forecastStart = t.indexOf('FORECASTS:');
  const present = t.slice(posM.index, forecastStart > posM.index ? forecastStart : undefined);
  const windM = /MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT(?:,\s*GUSTS\s*(\d+)\s*KT)?/.exec(present);
  const moveM = /MOVEMENT PAST SIX HOURS\s*-\s*(\d{1,3})\s*DEGREES AT\s*(\d+)\s*KTS/.exec(present);
  const windKt = windM ? +windM[1] : null;

  const track = [point(position.time, position, windKt, false)];
  if (forecastStart > 0) {
    const remarks = t.indexOf('REMARKS:', forecastStart);
    const section = t.slice(forecastStart, remarks > 0 ? remarks : undefined);
    const heads = [...section.matchAll(new RegExp(String.raw`(\d+)\s*HRS,\s*VALID AT:\s*(\d{6})Z\s*-+\s*${LATLON}`, 'g'))];
    heads.forEach((h, i) => {
      const body = section.slice(h.index, heads[i + 1]?.index);
      const w = /MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT/.exec(body);
      const pos = latLon(h[3], h[4], h[5], h[6]);
      const time = parseDayTime(h[2], ref);
      if (pos && time) track.push(point(time, pos, w ? +w[1] : null, true));
    });
  }
  track.sort((a, b) => a.time - b.time);

  const nameRaw = subj[3]?.trim();
  return blankSystem({
    id: `jtwc:${designation}`,
    kind: 'warning',
    name: cleanName(nameRaw) ?? designation,
    designation,
    basin: basinOf(header, designation, null),
    issuedAt,
    position,
    windKt,
    gustKt: windM?.[2] ? +windM[2] : null,
    movement: moveM ? { bearing: +moveM[1] % 360, speedKt: +moveM[2] } : null,
    track,
    final: /FINAL WARNING/.test(t),
  });
}

// ---------------------------------------------------------------------------
// Tropical Cyclone Formation Alert (e.g. wp9226web.txt)
// ---------------------------------------------------------------------------

/**
 * Parse a TCFA. A cancellation notice becomes an 'invest' (position and
 * potential only) so a system that just moved inland is not silently lost.
 * @returns TropicalSystem (kind 'tcfa' | 'invest') or null.
 */
export function parseTcfaText(text, now = new Date()) {
  const t = flat(text).toUpperCase();
  const { header, issuedAt } = parseHeader(t, now);
  const ref = issuedAt ?? now;
  const designation = /\(INVEST\s+(\d{2}[A-Z])\)/.exec(t)?.[1] ?? /\bINVEST\s+(\d{2}[A-Z])\b/.exec(t)?.[1] ?? null;
  if (!designation) return null;

  const centreM =
    new RegExp(String.raw`AT\s+(\d{6})Z\s+INDICATES THAT A CIRCULATION CENTER IS LOCATED\s+NEAR\s+${LATLON}`).exec(t) ??
    new RegExp(String.raw`NOW LOCATED NEAR\s+${LATLON}`).exec(t) ??
    new RegExp(String.raw`LOCATED NEAR\s+${LATLON}`).exec(t);
  if (!centreM) return null;
  const hasTime = centreM.length === 6;
  const pos = hasTime ? latLon(centreM[2], centreM[3], centreM[4], centreM[5]) : latLon(centreM[1], centreM[2], centreM[3], centreM[4]);
  if (!pos) return null;
  const time = (hasTime ? parseDayTime(centreM[1], ref) : null) ?? issuedAt;

  const windM = /WINDS IN THE AREA ARE ESTIMATED TO BE\s+(\d+)(?:\s*(?:TO|-)\s*(\d+))?\s*KNOTS/.exec(t) ??
    /MAXIMUM SUSTAINED SURFACE WINDS ARE ESTIMATED AT\s+(\d+)(?:\s*(?:TO|-)\s*(\d+))?\s*KNOTS/.exec(t);
  const windKt = windM ? windUpper(windM[1], windM[2]) : null;
  const moveM = /\bMOVING\s+([A-Z]+(?:-[A-Z]+)?)WARD\s+AT\s+(\d+)\s*KNOTS/.exec(t);

  const cancelled = /SUBJ\/[^/]*CANCEL/.test(t) || /\bTCFA IS CANCELLED\b|\bALERT IS CANCELLED\b/.test(t);
  let tcfa = null;
  if (!cancelled) {
    const corr = new RegExp(String.raw`WITHIN\s+(\d+)\s*NM\s+EITHER SIDE OF A LINE FROM\s+${LATLON}\s+TO\s+${LATLON}`).exec(t);
    const until = /(?:CANCELLED|EXPIRED?)\s+BY\s+(\d{6})Z/.exec(t);
    if (corr) {
      tcfa = {
        from: latLon(corr[2], corr[3], corr[4], corr[5]),
        to: latLon(corr[6], corr[7], corr[8], corr[9]),
        halfWidthKm: +corr[1] * NM_TO_KM,
        validUntil: until ? parseDayTime(until[1], ref) : null,
      };
    }
  }

  const position = { ...pos, time };
  return blankSystem({
    id: `jtwc:${designation}`,
    kind: cancelled ? 'invest' : 'tcfa',
    name: `Invest ${designation}`,
    designation,
    basin: basinOf(header, designation, null),
    issuedAt,
    position,
    windKt,
    movement: moveM ? movementFrom(moveM[1], moveM[2]) : null,
    potential: potentialIn(t),
    track: [point(time, pos, windKt, false)],
    tcfa,
  });
}

// ---------------------------------------------------------------------------
// Significant tropical weather advisories (abioweb.txt / abpwweb.txt)
// ---------------------------------------------------------------------------

/**
 * Parse section 1 (North Indian Ocean for ABIO, western North Pacific for
 * ABPW): invest areas with position/potential ('invest'), and warned-TC
 * summaries ('warning', no forecast track).
 * @returns TropicalSystem[]
 */
export function parseAdvisoryText(text, now = new Date()) {
  return parseAdvisory(text, now).systems;
}

/**
 * Advisory parse plus the invest designations it cross-references to a
 * formation alert ("SEE REF A ..." where "REF A IS A TROPICAL CYCLONE
 * FORMATION ALERT"), so a TCFA is still recognised when the RSS is down.
 */
function parseAdvisory(text, now) {
  const t = flat(text).toUpperCase();
  const { header, issuedAt } = parseHeader(t, now);
  // "REF A IS A TROPICAL CYCLONE FORMATION ALERT" (but not "... ALERT CANCELLATION").
  const tcfaRefs = new Set([...t.matchAll(/\bREF\s+([A-Z])\s+IS\s+A\s+TROPICAL\s+CYCLONE\s+FORMATION\s+ALERT\b(?!\s+CANCEL)/g)].map((m) => m[1]));
  // "REF/A/MSG/.../271721ZSEP2026//": when each referenced message was issued (with its year).
  const refTimes = new Map();
  for (const m of t.matchAll(/\bREF\/([A-Z])\/(?:[^/]*\/)*?(\d{2})(\d{2})(\d{2})Z([A-Z]{3})(\d{4})\b/g)) {
    const mo = MONTHS[m[5]];
    if (mo !== undefined) refTimes.set(m[1], new Date(Date.UTC(+m[6], mo, +m[2], +m[3], +m[4])));
  }
  const start = /(?:^|\s)1\.\s+[A-Z][A-Z ]*?AREA\b/.exec(t);
  if (!start) return { systems: [], tcfaDesignations: [], issuedAt, recognised: false };
  const rest = t.slice(start.index + start[0].length);
  const end = /\s2\.\s+[A-Z][A-Z ]*?AREA\b|\s3\.\s+JUSTIFICATION/.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;

  const partOf = (from, to) => {
    const i = section.search(from);
    if (i < 0) return '';
    const s = section.slice(i);
    const j = s.search(to);
    return j > 0 ? s.slice(0, j) : s;
  };
  const tcPart = partOf(/A\.\s+TROPICAL CYCLONE SUMMARY/, /\sB\.\s+TROPICAL DISTURBANCE SUMMARY/);
  const disturbPart = partOf(/B\.\s+TROPICAL DISTURBANCE SUMMARY/, /\sC\.\s+SUBTROPICAL/);
  const items = (part) => part.split(/\(\d{1,2}\)\s+/).slice(1);

  const systems = [];
  const tcfaDesignations = [];
  for (const it of items(tcPart)) {
    const s = parseTcSummary(it, header, issuedAt);
    if (s) systems.push(s);
  }
  for (const it of items(disturbPart)) {
    const s = parseInvestItem(it, header, issuedAt);
    if (!s) continue;
    systems.push(s);
    const ref = /\bSEE\s+REF\s+([A-Z])\b/.exec(it)?.[1];
    if (s.designation && ref && tcfaRefs.has(ref)) tcfaDesignations.push({ designation: s.designation, issuedAt: refTimes.get(ref) ?? issuedAt });
  }
  return { systems, tcfaDesignations, issuedAt, recognised: /^\s*AB[A-Z]{2}\d{2}\s+PGTW\s+\d{6}/.test(t) };
}

function parseTcSummary(it, header, issuedAt) {
  const m = new RegExp(String.raw`\b(\d{2}[A-Z])\s*(?:\(([^)]+)\)\s*)?WAS LOCATED NEAR\s+${LATLON}`).exec(it);
  if (!m) return null;
  const designation = m[1];
  const pos = latLon(m[3], m[4], m[5], m[6]);
  if (!pos) return null;
  const at = /\bAT\s+(\d{2})([A-Z]{3})(\d{2})\s+(\d{2})(\d{2})Z/.exec(it);
  const time =
    at && MONTHS[at[2]] !== undefined
      ? new Date(Date.UTC(2000 + +at[3], MONTHS[at[2]], +at[1], +at[4], +at[5]))
      : issuedAt;
  const w = /SUSTAINED SURFACE WINDS WERE ESTIMATED AT\s+(\d+)\s*KNOTS(?:\s+GUSTING TO\s+(\d+)\s*KNOTS)?/.exec(it);
  const mv = /TRACKED\s+([A-Z]+(?:-[A-Z]+)?)WARD\s+AT\s+(\d+)\s*KNOTS/.exec(it);
  const windKt = w ? +w[1] : null;
  return blankSystem({
    id: `jtwc:${designation}`,
    kind: 'warning',
    name: cleanName(m[2]) ?? designation,
    designation,
    basin: basinOf(header, designation, null),
    issuedAt,
    position: { ...pos, time },
    windKt,
    gustKt: w?.[2] ? +w[2] : null,
    movement: mv ? movementFrom(mv[1], mv[2]) : null,
    track: [point(time, pos, windKt, false)],
    final: /FINAL WARNING/.test(it),
  });
}

function parseInvestItem(it, header, issuedAt) {
  const nowM = new RegExp(String.raw`NOW LOCATED NEAR\s+${LATLON}`).exec(it);
  const any = nowM ?? new RegExp(String.raw`(?:LOCATED|PERSISTED|DEVELOPED|FORMED|CENTERED|CENTRED)\s+NEAR\s+${LATLON}`).exec(it);
  // "...PREVIOUSLY LOCATED NEAR x HAS DISSIPATED / IS NO LONGER SUSPECT" → gone;
  // "...HAS BEEN UPGRADED TO TROPICAL CYCLONE 01B, SEE PARA 1.A.(1)" → now a warning.
  if (!nowM && /DISSIPATED|NO LONGER (?:SUSPECT|CONSIDERED)|HAS BEEN (?:DROPPED|REMOVED)/.test(it)) return null;
  if (/UPGRADED TO (?:A )?(?:TROPICAL (?:CYCLONE|DEPRESSION|STORM)|TC|WARNING)\b|DEVELOPED INTO (?:A )?(?:TROPICAL|TC)\b|SEE PARA(?:GRAPH)?\.?\s*1\.A\b/.test(it)) return null;
  if (!any) return null;
  const pos = latLon(any[1], any[2], any[3], any[4]);
  if (!pos) return null;
  const designation = /\bINVEST\s+(\d{2}[A-Z])\b/.exec(it)?.[1] ?? null;
  const w = /SUSTAINED SURFACE WINDS ARE ESTIMATED AT\s+(\d+)(?:\s*(?:TO|-)\s*(\d+))?\s*KNOTS/.exec(it);
  const windKt = w ? windUpper(w[1], w[2]) : null;
  const id = designation ? `jtwc:${designation}` : `jtwc:area:${pos.lat.toFixed(1)},${pos.lon.toFixed(1)}`;
  return blankSystem({
    id,
    kind: 'invest',
    name: designation ? `Invest ${designation}` : 'Invest area',
    designation,
    basin: basinOf(header, designation, null),
    issuedAt,
    position: { ...pos, time: issuedAt },
    windKt,
    potential: potentialIn(it),
    track: [point(issuedAt, pos, windKt, false)],
  });
}

// ---------------------------------------------------------------------------
// Fetch + dedupe
// ---------------------------------------------------------------------------

const ms = (d) => (d instanceof Date && !Number.isNaN(+d) ? +d : -Infinity);

/** One system per designation: warning > tcfa > invest, keeping the newest potential/position. */
function combine(group) {
  const sorted = [...group].sort(
    (a, b) =>
      (KIND_RANK[b.kind] ?? 0) - (KIND_RANK[a.kind] ?? 0) ||
      (b.track?.length ?? 0) - (a.track?.length ?? 0) ||
      ms(b.issuedAt) - ms(a.issuedAt),
  );
  const best = { ...sorted[0] };
  const newestFirst = [...group].sort((a, b) => ms(b.issuedAt) - ms(a.issuedAt));
  best.potential = newestFirst.find((s) => s.potential)?.potential ?? null;
  best.issuedAt = newestFirst[0].issuedAt ?? best.issuedAt;
  best.links = Object.assign({}, ...sorted.map((s) => s.links ?? {}).reverse());
  best.final = sorted.some((s) => s.final && s.kind === 'warning');
  best.movement = best.movement ?? sorted.find((s) => s.movement)?.movement ?? null;

  // Without a forecast track, a newer fix from another product is the better "now"
  // — unless it only repeats an older fix's coordinates (an advisory reissued
  // with the old text): then the older fix keeps its real time.
  const hasForecast = (best.track ?? []).some((p) => p.forecast);
  if (!hasForecast) {
    const sameSpot = (a, b) => a && b && Math.abs(a.lat - b.lat) <= SAME_FIX_DEG && Math.abs(wrapLonDelta(a.lon - b.lon)) <= SAME_FIX_DEG;
    const fixes = [...group].filter((s) => s.position).sort((a, b) => ms(b.position?.time) - ms(a.position?.time));
    let newestPos = fixes[0];
    if (newestPos) {
      const firstAtSpot = [...fixes].reverse().find((s) => sameSpot(s.position, newestPos.position));
      if (firstAtSpot) newestPos = { ...newestPos, position: firstAtSpot.position };
    }
    if (newestPos && ms(newestPos.position?.time) > ms(best.position?.time)) {
      best.position = newestPos.position;
      best.windKt = newestPos.windKt ?? best.windKt;
    } else if (newestPos && sameSpot(newestPos.position, best.position) && ms(newestPos.position?.time) < ms(best.position?.time)) {
      best.position = newestPos.position;
    }
    const seen = new Set();
    const observed = [];
    for (const p of group.flatMap((s) => (s.track ?? []).filter((q) => !q.forecast)).sort((a, b) => a.time - b.time)) {
      if (seen.has(+p.time)) continue;
      seen.add(+p.time);
      // The same fix repeated later is not a second position.
      if (observed.length && sameSpot(observed[observed.length - 1], p)) continue;
      observed.push(p);
    }
    best.track = observed;
  }
  return best;
}

function dedupe(systems) {
  const groups = new Map();
  for (const s of systems) {
    const key = s.designation ?? s.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  return absorbIntoWarnings([...groups.values()].map(combine));
}

/**
 * JTWC renumbers an invest when it upgrades it (92B → 01B); drop invest/TCFA
 * entries sitting on a warned system at about the same time.
 */
function absorbIntoWarnings(systems) {
  const warnings = systems.filter((s) => s.kind === 'warning');
  return systems.filter(
    (s) =>
      s.kind === 'warning' ||
      !warnings.some(
        (w) =>
          haversineKm(w.position, s.position) <= SAME_SYSTEM_KM &&
          Math.abs(ms(w.position.time) - ms(s.position.time)) <= SAME_SYSTEM_HOURS * HOUR_MS,
      ),
  );
}

function keep(s, home) {
  if (s.basin !== 'WPAC') return true;
  const eastOf = wrapLonDelta(s.position.lon - WPAC_KEEP_WEST_OF_LON) > 0;
  return !eastOf || haversineKm(home, s.position) <= WPAC_KEEP_WITHIN_KM;
}

const errText = (e) => (e && e.message) || String(e);

/** A real JTWC RSS document (a quiet feed may list no products at all). */
const looksLikeRss = (text) => /<rss\b|<channel\b/i.test(String(text ?? '').slice(0, 5000));

/**
 * Current JTWC systems relevant to South/South-East Asia. Never throws.
 * `ok` means every product JTWC lists was read: the RSS (or, when it is
 * down, both advisories and every formation alert they refer to), each
 * warning / formation-alert text it lists, and both advisories. Anything
 * less is `ok: false` with the systems that could be read kept, so the page
 * records a gap instead of treating a partial read as full coverage.
 * @returns {Promise<{systems: object[], ok: boolean, error?: string, errors: string[]}>}
 */
export async function fetchJtwc(now = new Date(), home = HOME) {
  const errors = [];
  try {
    let items = null;
    try {
      const text = await fetchText(URLS.jtwcRss, FETCH_OPTS);
      if (!looksLikeRss(text)) throw new Error('not an RSS feed');
      items = parseRss(text);
    } catch (err) {
      errors.push(`JTWC RSS: ${errText(err)}`);
    }

    const tasks = (items ?? [])
      .filter((it) => FETCH_PREFIXES.has(it.basinPrefix) && it.textUrl)
      .map((it) => ({ type: it.kind, url: it.textUrl, item: it }));
    tasks.push(
      { type: 'advisory', url: URLS.jtwcIndianOceanAdvisory, key: 'abio' },
      { type: 'advisory', url: URLS.jtwcWestPacificAdvisory, key: 'abpw' },
    );

    const run = async (task) => {
      const file = task.url.split('/').pop();
      let text;
      try {
        text = await fetchText(task.url, FETCH_OPTS);
      } catch (err) {
        errors.push(`JTWC ${file}: ${errText(err)}`);
        return { task, ok: false, systems: [] };
      }
      const parsed = parseProduct(task, text, now);
      if (!parsed.recognised) {
        errors.push(`JTWC ${file}: unrecognised content`);
        return { task, ok: false, ...parsed };
      }
      return { task, ok: true, ...parsed };
    };
    const results = await mapLimit(tasks, MAX_IN_FLIGHT, run);
    const done = results.filter(Boolean);

    // RSS down: a formation alert an advisory refers to ("SEE REF A") still has a
    // predictable text URL, and that text carries the alert corridor.
    const extraTasks = [];
    if (items === null) {
      const haveText = new Set(done.filter((r) => r.ok && r.task.type !== 'advisory').flatMap((r) => r.systems.map((x) => x.designation)));
      const refs = done.flatMap((r) => r.tcfaDesignations ?? []);
      const seen = new Set();
      for (const ref of refs) {
        if (!ref?.designation || haveText.has(ref.designation) || seen.has(ref.designation)) continue;
        seen.add(ref.designation);
        const url = productTextUrl(ref.designation, ref.issuedAt ?? now);
        if (url && !tasks.some((task) => task.url === url)) extraTasks.push({ type: 'tcfa', url });
      }
      if (extraTasks.length) done.push(...(await mapLimit(extraTasks, MAX_IN_FLIGHT, run)).filter(Boolean));
    }
    const advisoryOk = (key) => done.some((r) => r.task.key === key && r.ok);
    const productsOk = done.filter((r) => r.task.type !== 'advisory').every((r) => r.ok);
    const ok = advisoryOk('abio') && advisoryOk('abpw') && productsOk;

    let systems = dedupe(done.flatMap((r) => r.systems));
    // A TCFA listed in the RSS or referenced by an advisory is in force even
    // when its own text could not be fetched — unless we saw it cancelled.
    // Products are also matched by file ("io93"), because a cancelled Bay of
    // Bengal alert's RSS entry may not say its designation letter.
    const keyOf = (designation) => {
      const m = /^(\d{2})([A-Z])$/.exec(String(designation ?? ''));
      return m && SUFFIX_PREFIX[m[2]] ? `${SUFFIX_PREFIX[m[2]]}${m[1]}` : null;
    };
    const rssTcfa = (items ?? []).filter((i) => i.kind === 'tcfa');
    const cancelled = new Set(done.filter((r) => r.task.type === 'tcfa').flatMap((r) => r.systems.filter((s) => s.kind === 'invest').map((s) => s.designation)));
    const cancelledKeys = new Set(rssTcfa.filter((i) => i.cancelled).map((i) => i.productKey));
    for (const i of rssTcfa) if (i.cancelled && i.designation) cancelled.add(i.designation);
    const tcfaDesignations = new Set([
      ...rssTcfa.filter((i) => !i.cancelled && i.designation).map((i) => i.designation),
      ...done.flatMap((r) => (r.tcfaDesignations ?? []).map((x) => x.designation)),
    ]);
    const tcfaKeys = new Set(rssTcfa.filter((i) => !i.cancelled).map((i) => i.productKey));
    systems = systems.map((s) => {
      if (s.kind !== 'invest' || !s.designation) return s;
      const key = keyOf(s.designation);
      if (cancelled.has(s.designation) || (key && cancelledKeys.has(key))) return s;
      return tcfaDesignations.has(s.designation) || (key && tcfaKeys.has(key)) ? { ...s, kind: 'tcfa' } : s;
    });
    systems = systems.filter((s) => keep(s, home));

    return ok
      ? { systems, ok: true, errors }
      : { systems, ok: false, error: errors.join('; ') || 'JTWC unavailable', errors };
  } catch (err) {
    return { systems: [], ok: false, error: `JTWC: ${errText(err)}`, errors };
  }
}

// Designation suffix → JTWC product file prefix (92W → wp9226web.txt, 03B → io0326web.txt).
const SUFFIX_PREFIX = { W: 'wp', B: 'io', A: 'io', S: 'sh', P: 'sh', E: 'ep', C: 'cp' };

/**
 * Text product URL for a designation, or null (only basins we fetch). The
 * file's two-digit year is that of the message referring to it (`issuedAt`),
 * so an alert issued on 31 Dec is still found on 1 Jan.
 */
function productTextUrl(designation, issuedAt) {
  const m = /^(\d{2})([A-Z])$/.exec(String(designation ?? '').toUpperCase());
  const prefix = m ? SUFFIX_PREFIX[m[2]] : null;
  if (!prefix || !FETCH_PREFIXES.has(prefix)) return null;
  const at = issuedAt instanceof Date && !Number.isNaN(+issuedAt) ? issuedAt : new Date();
  const yy = String(at.getUTCFullYear() % 100).padStart(2, '0');
  return `${URLS.jtwcProducts}${prefix}${m[1]}${yy}web.txt`;
}

/**
 * @returns {{systems: object[], tcfaDesignations?: Array<{designation: string, issuedAt: Date|null}>, recognised: boolean}}
 *   `recognised` is false for anything that is not the JTWC product we asked
 *   for (an HTML error page served with status 200, a truncated file…).
 */
function parseProduct(task, text, now) {
  try {
    if (task.type === 'advisory') {
      const { systems, tcfaDesignations, recognised } = parseAdvisory(text, now);
      return { systems: systems.map((s) => ({ ...s, links: { ...s.links, jtwcText: task.url } })), tcfaDesignations, recognised };
    }
    const head = String(text).slice(0, 600);
    const isTcfa = /FORMATION ALERT/i.test(head);
    const s = isTcfa ? parseTcfaText(text, now) : parseWarningText(text, now);
    // A cancellation notice without a position is still a real, readable product.
    if (!s) return { systems: [], recognised: isTcfa && /CANCEL/i.test(head) && /\bPGTW\b/.test(head) };
    const links = { jtwcText: task.url };
    if (task.item?.graphicUrl) links.jtwcGraphic = task.item.graphicUrl;
    return { systems: [{ ...s, final: s.final || Boolean(task.item?.final && s.kind === 'warning'), links }], recognised: true };
  } catch {
    return { systems: [], recognised: false };
  }
}
