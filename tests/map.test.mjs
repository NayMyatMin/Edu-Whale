import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  activeWindAreas,
  arrowHead,
  corridorPolygon,
  fallbackSatelliteTime,
  fitPoints,
  geometryToPolygons,
  gibsDomainsUrl,
  gibsTime,
  parseGibsDomains,
  parseIsoDurationMs,
  pickSatelliteFrames,
  pointClassKey,
  radarTileInfo,
  signedArea,
  systemFitPoints,
  unionRings,
  unwrapLon,
  unwrapPath,
} from '../js/map.js';
import { HOME, SATELLITE } from '../js/config.js';
import { closestPointOnSegment, haversineKm } from '../js/geo.js';
import { parseGeometry } from '../js/gdacs.js';
import { parseTcfaText } from '../js/jtwc.js';
import { analyzeSystem } from '../js/systems.js';
import enMap from '../js/i18n/en/map.js';

const fixture = (p) => new URL(`./fixtures/${p}`, import.meta.url);
const iso = (d) => d.toISOString();

// Captured from GIBS DescribeDomains on 2026-09-28 at 15:41Z (note the 14:40 gap).
const DOMAINS_XML =
  "<Domains xmlns:ows='http://www.opengis.net/ows/1.1'><SpaceDomain><BoundingBox miny='-20037508.342789' maxy='20037508.342789' maxx='20037508.342789' minx='-20037508.342789' crs='urn:ogc:def:crs:EPSG::3857'/></SpaceDomain><DimensionDomain><ows:Identifier>time</ows:Identifier><Domain>2026-09-28T07:50:00Z/2026-09-28T14:30:00Z/PT10M,2026-09-28T14:50:00Z/2026-09-28T15:10:00Z/PT10M</Domain><Size>2</Size></DimensionDomain></Domains>";

test('gibsTime uses second precision with Z and no milliseconds', () => {
  assert.equal(gibsTime(new Date('2026-09-28T14:30:00.000Z')), '2026-09-28T14:30:00Z');
  assert.equal(gibsTime(Date.UTC(2026, 8, 28, 3, 7, 9, 500)), '2026-09-28T03:07:09Z');
});

test('gibsDomainsUrl covers the last 8 hours ending at the current minute', () => {
  const url = gibsDomainsUrl(new Date('2026-09-28T15:41:37.250Z'));
  assert.match(url, /\/all\/2026-09-28T07:41:00Z--2026-09-28T15:41:00Z\.xml$/);
  assert.match(url, /^https:\/\/gibs\.earthdata\.nasa\.gov\/wmts\/epsg3857\/best\/1\.0\.0\/Himawari_AHI_Band13_Clean_Infrared\//);
});

test('parseIsoDurationMs', () => {
  assert.equal(parseIsoDurationMs('PT10M'), 600000);
  assert.equal(parseIsoDurationMs('PT1H'), 3600000);
  assert.equal(parseIsoDurationMs('P1DT30M'), 86400000 + 1800000);
  assert.equal(parseIsoDurationMs('PT0M'), null);
  assert.equal(parseIsoDurationMs('P'), null);
  assert.equal(parseIsoDurationMs('10 minutes'), null);
  assert.equal(parseIsoDurationMs(undefined), null);
});

test('parseGibsDomains expands comma-separated ranges and skips the gap', () => {
  const times = parseGibsDomains(DOMAINS_XML);
  assert.equal(times.length, 41 + 3);
  assert.equal(iso(times[0]), '2026-09-28T07:50:00.000Z');
  assert.equal(iso(times.at(-1)), '2026-09-28T15:10:00.000Z');
  const set = new Set(times.map(iso));
  assert.ok(set.has('2026-09-28T14:30:00.000Z'));
  assert.ok(!set.has('2026-09-28T14:40:00.000Z'), 'daily Himawari gap is not invented');
  assert.ok(set.has('2026-09-28T14:50:00.000Z'));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'sorted, unique');
});

test('parseGibsDomains tolerates single times, junk and missing domains', () => {
  assert.deepEqual(parseGibsDomains(''), []);
  assert.deepEqual(parseGibsDomains(null), []);
  assert.deepEqual(parseGibsDomains('<html>error</html>'), []);
  const t = parseGibsDomains('<Domain>2026-09-28T10:00:00Z, nonsense ,2026-09-28T09:00:00Z/2026-09-28T09:20:00Z/PT10M</Domain>');
  assert.deepEqual(t.map(iso), [
    '2026-09-28T09:00:00.000Z',
    '2026-09-28T09:10:00.000Z',
    '2026-09-28T09:20:00.000Z',
    '2026-09-28T10:00:00.000Z',
  ]);
  // A reversed or zero-period range yields only its start, never a runaway loop.
  assert.equal(parseGibsDomains('<Domain>2026-09-28T10:00:00Z/2026-09-28T09:00:00Z/PT10M</Domain>').length, 1);
  assert.equal(parseGibsDomains('<Domain>2020-01-01T00:00:00Z/2026-01-01T00:00:00Z/PT1M</Domain>').length <= 5000, true);
});

test('pickSatelliteFrames drops frames younger than the safety lag and keeps 30-min spacing', () => {
  const now = new Date('2026-09-28T15:41:00Z');
  const frames = pickSatelliteFrames(parseGibsDomains(DOMAINS_XML), now);
  assert.equal(frames.length, SATELLITE.frames);
  // now − 45 min = 14:56 -> 15:00 and 15:10 are dropped; newest kept is 14:50.
  assert.equal(iso(frames.at(-1)), '2026-09-28T14:50:00.000Z');
  // 14:20, 13:50, … every 30 minutes, oldest last in the walk back.
  assert.equal(iso(frames.at(-2)), '2026-09-28T14:20:00.000Z');
  assert.equal(iso(frames[0]), '2026-09-28T09:20:00.000Z');
  for (let i = 1; i < frames.length; i++) assert.equal(frames[i] - frames[i - 1], 30 * 60e3);
});

test('pickSatelliteFrames bridges a gap by taking the latest time in each bucket', () => {
  // Frames every 10 min but 14:30–14:40 missing; newest 15:00.
  const times = [];
  for (let t = Date.parse('2026-09-28T12:00:00Z'); t <= Date.parse('2026-09-28T15:00:00Z'); t += 600e3) {
    const s = new Date(t).toISOString();
    if (!s.includes('T14:30') && !s.includes('T14:40')) times.push(new Date(t));
  }
  const frames = pickSatelliteFrames(times, new Date('2026-09-28T16:00:00Z'), { frames: 4, stepMin: 30, lagMin: 45 });
  assert.deepEqual(frames.map(iso), [
    '2026-09-28T13:30:00.000Z',
    '2026-09-28T14:00:00.000Z',
    '2026-09-28T14:20:00.000Z', // 14:30 missing -> latest in (14:00, 14:30]
    '2026-09-28T15:00:00.000Z',
  ]);
});

test('pickSatelliteFrames returns [] when nothing is old enough', () => {
  const now = new Date('2026-09-28T15:00:00Z');
  assert.deepEqual(pickSatelliteFrames([new Date('2026-09-28T14:50:00Z')], now), []);
  assert.deepEqual(pickSatelliteFrames([], now), []);
  assert.deepEqual(pickSatelliteFrames(null, now), []);
});

test('fallbackSatelliteTime is now − 60 min floored to 10 min, avoiding the daily gaps', () => {
  assert.equal(iso(fallbackSatelliteTime(new Date('2026-09-28T12:37:10Z'))), '2026-09-28T11:30:00.000Z');
  assert.equal(iso(fallbackSatelliteTime(new Date('2026-09-28T15:41:00Z'))), '2026-09-28T14:30:00.000Z');
  assert.equal(iso(fallbackSatelliteTime(new Date('2026-09-28T03:45:00Z'))), '2026-09-28T02:30:00.000Z');
});

test('radarTileInfo builds the newest RainViewer tile URL and rejects odd strings', () => {
  const index = {
    host: 'https://tilecache.rainviewer.com',
    radar: { past: [{ time: 1790602800, path: '/v2/radar/de3ad329f99b' }, { time: 1790610000, path: '/v2/radar/fa676e8cc079' }] },
  };
  const info = radarTileInfo(index);
  assert.equal(info.url, 'https://tilecache.rainviewer.com/v2/radar/fa676e8cc079/256/{z}/{x}/{y}/2/1_1.png');
  assert.equal(info.time.getTime(), 1790610000 * 1000);
  assert.equal(radarTileInfo(null), null);
  assert.equal(radarTileInfo({ host: 'https://x.test', radar: { past: [] } }), null);
  assert.equal(radarTileInfo({ ...index, host: 'javascript:alert(1)' }), null);
  assert.equal(radarTileInfo({ ...index, host: 'http://tilecache.rainviewer.com' }), null);
  assert.equal(radarTileInfo({ ...index, radar: { past: [{ time: 1, path: '/v2/{evil}' }] } }), null);
});

test('unwrapLon / unwrapPath keep tracks continuous across the dateline', () => {
  assert.equal(unwrapLon(-170, 170), 190);
  assert.equal(unwrapLon(96, 96), 96);
  const path = unwrapPath([{ lat: 10, lon: 178 }, { lat: 11, lon: -179 }, { lat: 12, lon: -175 }, { lat: 13, lon: NaN }], 170);
  assert.deepEqual(path, [
    [10, 178],
    [11, 181],
    [12, 185],
  ]);
});

test('geometryToPolygons converts GeoJSON [lon, lat] to Leaflet [lat, lon]', () => {
  const poly = { type: 'Polygon', coordinates: [[[90, 10], [92, 10], [92, 12], [90, 10]]] };
  assert.deepEqual(geometryToPolygons(poly, 96), [[[[10, 90], [10, 92], [12, 92], [10, 90]]]]);
  const multi = { type: 'MultiPolygon', coordinates: [poly.coordinates, [[[1, 1], [2, 2]]]] };
  assert.equal(geometryToPolygons(multi, 96).length, 1, 'rings with < 3 points are dropped');
  assert.deepEqual(geometryToPolygons(null), []);
  assert.deepEqual(geometryToPolygons({ type: 'Point', coordinates: [1, 2] }), []);
});

test('signedArea / unionRings give every outer ring the same orientation', () => {
  const ccw = [[0, 0], [0, 1], [1, 1], [1, 0]]; // [lat, lon]: x=lon, y=lat -> (0,0) (1,0) (1,1) (0,1) = CCW
  assert.ok(signedArea(ccw) > 0);
  assert.ok(signedArea(ccw.slice().reverse()) < 0);
  const a = { type: 'Polygon', coordinates: [[[90, 10], [91, 10], [91, 11], [90, 11], [90, 10]]] };
  const b = { type: 'Polygon', coordinates: [[[90.5, 10.5], [90.5, 11.5], [91.5, 11.5], [91.5, 10.5], [90.5, 10.5]]] };
  const rings = unionRings([a, b], 96);
  assert.equal(rings.length, 2);
  assert.ok(rings.every((r) => signedArea(r) > 0));
});

test('activeWindAreas keeps areas valid from now − 3 h on, grouped by strength', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  const f = { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[90, 10], [91, 10], [91, 11], [90, 10]]] } };
  const areas = [
    { kmh: 60, time: new Date('2026-09-28T06:00:00Z'), feature: f }, // too old
    { kmh: 60, time: new Date('2026-09-28T09:30:00Z'), feature: f },
    { kmh: 90, time: '2026-09-29T00:00:00Z', feature: f },
    { kmh: 120, time: new Date('2026-09-29T12:00:00Z'), feature: f },
    { kmh: 75, time: now, feature: f }, // unknown strength
    { kmh: 60, time: now, feature: null },
    null,
  ];
  const out = activeWindAreas(areas, now);
  assert.equal(out[60].length, 1);
  assert.equal(out[90].length, 1);
  assert.equal(out[120].length, 1);
  assert.deepEqual(activeWindAreas(undefined, now), { 60: [], 90: [], 120: [] });
});

test('corridorPolygon: every vertex is halfWidthKm from the corridor axis (JTWC 92W TCFA)', () => {
  const now = new Date('2026-09-28T15:00:00Z');
  const tcfa = parseTcfaText(fs.readFileSync(fixture('jtwc/wp9226web.txt'), 'utf8'), now).tcfa;
  const ring = corridorPolygon(tcfa.from, tcfa.to, tcfa.halfWidthKm);
  assert.ok(ring.length >= 20);
  for (const [lat, lon] of ring) {
    const d = closestPointOnSegment({ lat, lon }, tcfa.from, tcfa.to).distanceKm;
    assert.ok(Math.abs(d - tcfa.halfWidthKm) < tcfa.halfWidthKm * 0.02, `vertex ${lat},${lon} is ${d} km from the axis`);
  }
  // Yangon is inside the 92W corridor (the real-world case from 28 Sep 2026).
  assert.ok(closestPointOnSegment(HOME, tcfa.from, tcfa.to).distanceKm < tcfa.halfWidthKm);
  assert.deepEqual(corridorPolygon(tcfa.from, tcfa.to, 0), []);
  assert.deepEqual(corridorPolygon(null, tcfa.to, 100), []);
});

test('corridorPolygon and arrowHead work across the dateline', () => {
  const ring = corridorPolygon({ lat: 10, lon: 179 }, { lat: 12, lon: -178 }, 100);
  const lons = ring.map(([, lon]) => lon);
  assert.ok(Math.max(...lons) - Math.min(...lons) < 10, 'no wrap-around sliver');
  const head = arrowHead({ lat: 10, lon: 179 }, { lat: 12, lon: -178 });
  assert.equal(head.length, 3);
  assert.ok(Math.abs(head[1][1] - 182) < 1e-9);
  for (const p of [head[0], head[2]]) {
    const km = haversineKm({ lat: p[0], lon: p[1] }, { lat: 12, lon: -178 });
    assert.ok(km >= 40 && km <= 120);
  }
});

test('pointClassKey uses wind first, then the GDACS/JTWC class label', () => {
  assert.equal(pointClassKey({ windKt: 70 }), 'imd.vscs');
  assert.equal(pointClassKey({ windKt: 30 }), 'imd.dd');
  assert.equal(pointClassKey({ windKt: null, cls: 'TS' }), 'imd.cs');
  assert.equal(pointClassKey({ windKt: null, cls: 'HU' }), 'imd.vscs');
  assert.equal(pointClassKey({}), 'imd.low');
});

test('fitPoints: Yangon + relevant systems + current DMH position; empty when nothing relevant', () => {
  const now = new Date('2026-09-29T00:00:00Z');
  const geometry = parseGeometry(JSON.parse(fs.readFileSync(fixture('gdacs/geometry_SURIGAE-26.json'), 'utf8')));
  const pts = geometry.points;
  const last = pts.filter((p) => !p.forecast).at(-1) ?? pts[0];
  const system = {
    id: 'gdacs:1', sources: ['gdacs'], kind: 'warning', name: 'Surigae', designation: null, basin: 'WPAC',
    issuedAt: now, position: { lat: last.lat, lon: last.lon, time: last.time }, windKt: 50, gustKt: null,
    movement: null, potential: null, track: pts, cone: geometry.cone, windAreas: geometry.windAreas,
    swath: geometry.swath, tcfa: null, alertLevel: 'Green', final: false, links: {},
  };
  const analysis = analyzeSystem(system, HOME, now);
  const far = { ...analysis, relevant: false };
  assert.deepEqual(fitPoints([far], null, HOME, now), []);
  assert.deepEqual(fitPoints(null, null, HOME, now), []);

  const dmh = { bulletin: { lat: 17.1, lon: 97.0, isCurrent: true } };
  const onlyDmh = fitPoints([], dmh, HOME, now);
  assert.deepEqual(onlyDmh, [[HOME.lat, HOME.lon], [17.1, 97.0]]);
  assert.deepEqual(fitPoints([], { bulletin: { ...dmh.bulletin, isCurrent: false } }, HOME, now), []);

  // Relevant but ~3000 km away (a typhoon near Japan): not part of the default view.
  assert.ok(analysis.distanceKm > 2500);
  assert.deepEqual(fitPoints([{ ...analysis, relevant: true, inRegion: false }], null, HOME, now), []);
  const withSystem = fitPoints([{ ...analysis, relevant: true, inRegion: true }], dmh, HOME, now);
  assert.deepEqual(withSystem[0], [HOME.lat, HOME.lon]);
  assert.ok(withSystem.length >= 3);
  const near = fitPoints([{ ...analysis, relevant: true, inRegion: false, distanceKm: 900 }], null, HOME, now);
  assert.ok(near.length >= 3, 'a relevant system within 2500 km is fitted');
  const own = systemFitPoints(analysis, HOME, now);
  assert.deepEqual(own[0], [system.position.lat, unwrapLon(system.position.lon, HOME.lon)]);
  assert.ok(own.length > 1, 'forecast points are included');
});

test('systemFitPoints includes a TCFA corridor', () => {
  const now = new Date('2026-09-28T15:00:00Z');
  const tcfa = parseTcfaText(fs.readFileSync(fixture('jtwc/wp9226web.txt'), 'utf8'), now);
  const pts = systemFitPoints({ system: tcfa }, HOME, now);
  assert.ok(pts.some(([lat, lon]) => lat === tcfa.tcfa.to.lat && lon === tcfa.tcfa.to.lon));
  assert.deepEqual(systemFitPoints({ system: { position: { lat: NaN, lon: 1 } } }), []);
});

test('English map dictionary: map.* keys only, no reason-convention params', () => {
  const reserved = /\{(km|kmh|mm|hpa|hours|time|name|compass|stage|system|cls|potential|title|message)\}/;
  for (const [key, text] of Object.entries(enMap)) {
    assert.match(key, /^map\./, key);
    assert.equal(typeof text, 'string');
    assert.ok(text.trim(), `${key} is empty`);
    assert.doesNotMatch(text, reserved, `${key} uses a reserved param name`);
  }
});

test('map.js reads only map.* keys that exist, plus known core keys', () => {
  const src = fs.readFileSync(new URL('../js/map.js', import.meta.url), 'utf8');
  const keys = new Set([...src.matchAll(/t\(\s*'(map\.[\w.]+)'/g)].map((m) => m[1]));
  assert.ok(keys.size > 30);
  for (const k of keys) assert.ok(Object.hasOwn(enMap, k), `missing en key ${k}`);
  for (const m of src.matchAll(/t\(`(map\.[\w.]+)\$\{/g)) {
    assert.ok(Object.keys(enMap).some((k) => k.startsWith(m[1])), `no en keys for template ${m[1]}`);
  }
});
