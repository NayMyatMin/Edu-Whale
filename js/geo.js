// Small spherical-geometry helpers. Inputs are {lat, lon} in degrees;
// distances are kilometres.

const R_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/** Wrap a longitude difference into [-180, 180). */
export function wrapLonDelta(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(wrapLonDelta(b.lon - a.lon));
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial great-circle bearing from `from` to `to`, 0–360 (0 = north). */
export function bearingDeg(from, to) {
  const φ1 = toRad(from.lat);
  const φ2 = toRad(to.lat);
  const Δλ = toRad(wrapLonDelta(to.lon - from.lon));
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-point compass code for a bearing, e.g. 247 -> 'WSW'. */
export function compass16(deg) {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_16[i];
}

export function destinationPoint(from, bearing, km) {
  const δ = km / R_KM;
  const θ = toRad(bearing);
  const φ1 = toRad(from.lat);
  const λ1 = toRad(from.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: wrapLonDelta(toDeg(λ2)) };
}

/**
 * Closest point to `p` on the segment a–b. Uses a local equirectangular
 * projection centred on `p` (accurate to well under 1% for the < 3000 km
 * scales used here) and handles the ±180° seam.
 * @returns {{t:number, point:{lat:number, lon:number}, distanceKm:number}}
 */
export function closestPointOnSegment(p, a, b) {
  const kx = Math.cos(toRad(p.lat));
  const ax = wrapLonDelta(a.lon - p.lon) * kx;
  const ay = a.lat - p.lat;
  const bx = wrapLonDelta(b.lon - p.lon) * kx;
  const by = b.lat - p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const point = interpolate(a, b, t);
  return { t, point, distanceKm: haversineKm(p, point) };
}

/** Linear interpolation between two positions (lon-seam aware). */
export function interpolate(a, b, t) {
  const lon = a.lon + wrapLonDelta(b.lon - a.lon) * t;
  return { lat: a.lat + (b.lat - a.lat) * t, lon: wrapLonDelta(lon) };
}

/** Ring of [lat, lon] pairs approximating a circle (for Leaflet polygons). */
export function circlePolygon(center, km, n = 96) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const d = destinationPoint(center, (360 * i) / n, km);
    pts.push([d.lat, center.lon + wrapLonDelta(d.lon - center.lon)]);
  }
  return pts;
}

export function inBbox(p, bbox) {
  return p.lat >= bbox.south && p.lat <= bbox.north && p.lon >= bbox.west && p.lon <= bbox.east;
}

/**
 * Point-in-polygon for GeoJSON Polygon / MultiPolygon geometries
 * (coordinates are [lon, lat]). Holes are respected.
 */
export function pointInGeometry(p, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygonRings(p, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((poly) => pointInPolygonRings(p, poly));
  return false;
}

function pointInPolygonRings(p, rings) {
  if (!rings || !rings.length || !pointInRing(p, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i])) return false;
  return true;
}

function pointInRing(p, ring) {
  let inside = false;
  const x = p.lon;
  const y = p.lat;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = p.lon + wrapLonDelta(ring[i][0] - p.lon);
    const yi = ring[i][1];
    const xj = p.lon + wrapLonDelta(ring[j][0] - p.lon);
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
