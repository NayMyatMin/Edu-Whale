import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeSystem, imdClassKey, jtwcClassOf, mergeSystems, sortAnalyses, titleCase } from '../js/systems.js';
import { parseEventList, toSystem } from '../js/gdacs.js';
import { parseTcfaText, parseWarningText } from '../js/jtwc.js';
import { HOME } from '../js/config.js';
import { circlePolygon, haversineKm } from '../js/geo.js';

const gdacsFix = (n) => JSON.parse(readFileSync(new URL(`./fixtures/gdacs/${n}`, import.meta.url), 'utf8'));
const jtwcFix = (n) => readFileSync(new URL(`./fixtures/jtwc/${n}`, import.meta.url), 'utf8');
const iso = (d) => d.toISOString();
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);

const NOW = new Date('2026-09-28T15:30:00Z');
const H = 3600e3;
const events = parseEventList(gdacsFix('eventlist.json'));
const gdacsSurigae = () =>
  toSystem(events.find((e) => e.eventName === 'SURIGAE-26'), gdacsFix('geometry_SURIGAE-26.json'), gdacsFix('timeline_SURIGAE-26.json'));
const gdacsOne = (withTimeline = true) =>
  toSystem(
    events.find((e) => e.eventName === 'ONE-26'),
    gdacsFix('geometry_ONE-26.json'),
    withTimeline ? gdacsFix('timeline_ONE-26.json') : null,
  );
const jtwc25W = () => parseWarningText(jtwcFix('wp2526web.txt'), NOW);
const tcfa92W = () => parseTcfaText(jtwcFix('wp9226web.txt'), NOW);

/** Minimal TropicalSystem for synthetic cases. */
function makeSystem(fields) {
  return {
    id: 'test:1',
    sources: ['jtwc'],
    kind: 'warning',
    name: 'Test',
    designation: null,
    basin: 'NIO',
    issuedAt: null,
    position: null,
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

test('imdClassKey / jtwcClassOf / titleCase', () => {
  assert.equal(imdClassKey(null), 'imd.low');
  assert.equal(imdClassKey(undefined), 'imd.low');
  assert.equal(imdClassKey(NaN), 'imd.low');
  assert.equal(imdClassKey(10), 'imd.low');
  assert.equal(imdClassKey(17), 'imd.d');
  assert.equal(imdClassKey(27), 'imd.d');
  assert.equal(imdClassKey(28), 'imd.dd');
  assert.equal(imdClassKey(34), 'imd.cs');
  assert.equal(imdClassKey(48), 'imd.scs');
  assert.equal(imdClassKey(64), 'imd.vscs');
  assert.equal(imdClassKey(90), 'imd.escs');
  assert.equal(imdClassKey(120), 'imd.sucs');
  assert.equal(imdClassKey(165), 'imd.sucs');

  assert.equal(jtwcClassOf(null), null);
  assert.equal(jtwcClassOf(25), 'TD');
  assert.equal(jtwcClassOf(33.9), 'TD');
  assert.equal(jtwcClassOf(34), 'TS');
  assert.equal(jtwcClassOf(63), 'TS');
  assert.equal(jtwcClassOf(64), 'HU');

  assert.equal(titleCase('SURIGAE'), 'Surigae');
  assert.equal(titleCase('FUNG-WONG'), 'Fung-Wong');
  assert.equal(titleCase('TWENTYSIX'), 'Twentysix');
  assert.equal(titleCase(''), '');
});

test('mergeSystems: GDACS SURIGAE-26 + JTWC 25W → one system with both sources', () => {
  const g = gdacsSurigae();
  const j = { ...jtwc25W(), links: { jtwcText: 'https://www.metoc.navy.mil/jtwc/products/wp2526web.txt' } };
  const merged = mergeSystems([g], [j, tcfa92W()]);
  assert.equal(merged.length, 2, 'Surigae merged; 92W stays separate');
  const s = merged.find((x) => x.designation === '25W');
  assert.equal(s.id, 'jtwc:25W');
  assert.deepEqual(s.sources.sort(), ['gdacs', 'jtwc']);
  assert.equal(s.kind, 'warning');
  assert.equal(s.name, 'Surigae');
  assert.equal(s.basin, 'WPAC');
  // JTWC's warning (15:00Z) is newer than GDACS's (12:00Z): its numbers win.
  assert.equal(iso(s.issuedAt), '2026-09-28T15:00:00.000Z');
  assert.equal(s.windKt, 90);
  assert.equal(s.gustKt, 110);
  assert.deepEqual(s.movement, { bearing: 65, speedKt: 12 });
  // GDACS keeps its polygons, alert level and report link.
  assert.ok(s.cone);
  assert.equal(s.windAreas.length, 21);
  assert.ok(s.swath.kmh120);
  assert.equal(s.alertLevel, 'Green');
  assert.ok(s.links.gdacsReport.includes('eventid=1001327'));
  assert.ok(s.links.jtwcText.endsWith('wp2526web.txt'));
  // GDACS history is kept before JTWC's current + forecast points.
  assert.equal(s.track.length, 21 + 7);
  for (let i = 1; i < s.track.length; i++) assert.ok(s.track[i].time > s.track[i - 1].time, `chronological at ${i}`);
  assert.equal(s.track.filter((p) => !p.forecast).length, 22);
  assert.equal(iso(s.track[0].time), '2026-09-23T06:00:00.000Z');
});

test('mergeSystems: position/time match without names; name-only match needs proximity', () => {
  const t0 = new Date('2026-10-10T00:00:00Z');
  const g = makeSystem({
    id: 'gdacs:1',
    sources: ['gdacs'],
    name: 'Four',
    issuedAt: t0,
    position: { lat: 15.0, lon: 90.0, time: t0 },
    windKt: 35,
    cone: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } },
    alertLevel: 'Orange',
  });
  const j = makeSystem({
    id: 'jtwc:94B',
    kind: 'tcfa',
    name: 'Invest 94B',
    designation: '94B',
    issuedAt: new Date(+t0 - 3 * H),
    position: { lat: 15.9, lon: 90.8, time: new Date(+t0 - 3 * H) },
    potential: 'HIGH',
    tcfa: { from: { lat: 15, lon: 90 }, to: { lat: 17, lon: 92 }, halfWidthKm: 200, validUntil: null },
  });
  assert.ok(haversineKm(g.position, j.position) < 300);
  const [m, ...rest] = mergeSystems([g], [j]);
  assert.equal(rest.length, 0);
  assert.equal(m.id, 'jtwc:94B');
  assert.equal(m.kind, 'warning', 'GDACS already warns on it');
  assert.equal(m.name, 'Four', 'GDACS name beats "Invest 94B"');
  assert.equal(m.windKt, 35, 'GDACS newer');
  assert.equal(m.potential, 'HIGH');
  assert.ok(m.tcfa);
  assert.equal(m.alertLevel, 'Orange');

  // Too far apart in time → separate.
  const late = { ...j, position: { ...j.position, time: new Date(+t0 - 20 * H) } };
  assert.equal(mergeSystems([g], [late]).length, 2);
  // Same generic name in another basin → separate.
  const epac = makeSystem({ id: 'jtwc:01E', name: 'Four', designation: '01E', position: { lat: 15, lon: -110, time: t0 } });
  assert.equal(mergeSystems([g], [epac]).length, 2);

  // Two different invests never match by their generic names.
  const inv = (id, lat) =>
    makeSystem({ id, kind: 'invest', name: `Invest ${id}`, designation: id, position: { lat, lon: 90, time: t0 } });
  assert.equal(mergeSystems([{ ...inv('92B', 10), sources: ['gdacs'] }], [inv('93B', 18)]).length, 2);

  assert.deepEqual(mergeSystems(null, undefined), []);
  assert.equal(mergeSystems([g], null).length, 1);
});

test('analyzeSystem: Nargis-like track into Yangon', () => {
  const now = new Date('2026-05-02T06:00:00Z');
  const at = (h) => new Date(Date.UTC(2026, 4, 2, 0) + h * H); // hours after 2 May 00Z
  const s = makeSystem({
    name: 'Nargis-like',
    issuedAt: at(3),
    position: { lat: 15.8, lon: 93.0, time: at(0) },
    windKt: 100,
    track: [
      { time: at(-6), lat: 15.5, lon: 91.8, forecast: false, windKt: 95, cls: 'HU' },
      { time: at(0), lat: 15.8, lon: 93.0, forecast: false, windKt: 100, cls: 'HU' },
      { time: at(12), lat: 16.0, lon: 94.6, forecast: true, windKt: 100, cls: 'HU' },
      { time: at(24), lat: 16.9, lon: 96.1, forecast: true, windKt: 65, cls: 'HU' },
      { time: at(36), lat: 18.2, lon: 97.8, forecast: true, windKt: null, cls: null },
    ],
  });
  const a = analyzeSystem(s, HOME, now);

  near(a.distanceKm, haversineKm(HOME, { lat: 15.8, lon: 93.0 }), 1e-9);
  assert.equal(a.compassFromHome, 'WSW');
  assert.equal(a.imdClassKey, 'imd.escs');
  assert.equal(a.jtwcClass, 'HU');
  assert.equal(a.inRegion, true);
  assert.equal(a.relevant, true);

  // Movement from the last two observed points (no JTWC movement given).
  assert.equal(a.movement.compass, 'ENE');
  near(a.movement.speedKmh, haversineKm({ lat: 15.5, lon: 91.8 }, { lat: 15.8, lon: 93.0 }) / 6, 1e-9);

  // Samples: current position, then hourly to +36 h.
  assert.equal(a.samples.length, 1 + 36);
  assert.equal(a.samples[0].forecast, false);
  assert.equal(a.samples[0].windKt, 100);
  near(a.samples[0].hoursFromNow, -6, 1e-9);
  for (let i = 1; i < a.samples.length; i++) {
    const dt = a.samples[i].time - a.samples[i - 1].time;
    assert.ok(dt > 0 && dt <= H, `step ${i} is ${dt / H} h`);
    assert.equal(a.samples[i].forecast, true);
  }
  const atTime = (h) => a.samples.find((x) => +x.time === +at(h));
  assert.equal(atTime(12).windKt, 100);
  assert.equal(atTime(18).windKt, 82.5, 'wind interpolated linearly');
  assert.equal(atTime(24).windKt, 65);
  assert.equal(atTime(30).windKt, null, 'null when an end is unknown');
  assert.equal(atTime(36).windKt, null);
  near(atTime(18).lat, 16.45, 1e-9);

  // Closest approach: over Yangon about 18 h from now, as a forecast.
  assert.ok(a.closest.distanceKm <= 50, `closest ${a.closest.distanceKm} km`);
  assert.ok(a.closest.hoursFromNow > 15 && a.closest.hoursFromNow < 21, `at +${a.closest.hoursFromNow} h`);
  assert.equal(a.closest.isForecast, true);
  assert.ok(a.closest.distanceKm <= Math.min(...a.samples.map((x) => x.distanceKm)));
  assert.equal(a.tcfa, null);
  assert.equal(a.insideCone, false);
  assert.equal(a.insideWindKmh, 0);
});

test('analyzeSystem: JTWC TCFA 92W — Yangon inside the formation corridor', () => {
  const a = analyzeSystem(tcfa92W(), HOME, NOW);
  near(a.distanceKm, 335, 5);
  assert.equal(a.compassFromHome, 'SE');
  assert.equal(a.movement.compass, 'WSW');
  near(a.movement.speedKmh, 3 * 1.852, 1e-9);
  assert.equal(a.imdClassKey, 'imd.dd', '28 kt');
  assert.equal(a.jtwcClass, 'TD');
  assert.equal(a.inRegion, true);
  assert.equal(a.relevant, true);
  near(a.tcfa.distanceToLineKm, 55, 3);
  assert.equal(a.tcfa.insideCorridor, true);
  assert.equal(a.samples.length, 1, 'no forecast track in a TCFA');
  assert.equal(a.closest.isForecast, false);
  near(a.closest.distanceKm, a.distanceKm, 1e-9);
});

test('analyzeSystem: cone and wind areas (the latest one at or before now, and later ones)', () => {
  const ring = (km) => [circlePolygon(HOME, km, 48).map(([lat, lon]) => [lon, lat])];
  const feature = (coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } });
  const farRing = [[[80, 5], [82, 5], [82, 7], [80, 7], [80, 5]]];
  const s = makeSystem({
    sources: ['gdacs'],
    position: { lat: 15, lon: 92, time: NOW },
    windKt: 70,
    cone: feature(ring(300)),
    windAreas: [
      { kmh: 120, time: new Date(+NOW - 16 * H), feature: feature(ring(100)) }, // too old
      { kmh: 60, time: new Date(+NOW + 6 * H), feature: feature(ring(200)) },
      { kmh: 90, time: new Date(+NOW + 6 * H), feature: feature(farRing) }, // elsewhere
    ],
  });
  const a = analyzeSystem(s, HOME, NOW);
  assert.equal(a.insideCone, true);
  assert.equal(a.insideWindKmh, 60);
  assert.deepEqual(a.insideWind.map((x) => [x.kmh, x.hoursFromNow]), [[60, 6]], 'with its lead time');

  s.windAreas.push({ kmh: 90, time: new Date(+NOW - 2 * H), feature: feature(ring(150)) });
  assert.equal(analyzeSystem(s, HOME, NOW).insideWindKmh, 90);

  // GDACS areas come 12 h apart: 6 h after one, it still describes the storm (the next is 6 h ahead).
  s.windAreas.push({ kmh: 120, time: new Date(+NOW - 6 * H), feature: feature(ring(100)) }, { kmh: 120, time: new Date(+NOW + 6 * H), feature: feature(farRing) });
  assert.equal(analyzeSystem(s, HOME, NOW).insideWindKmh, 120, 'area 6 h old kept: the storm is still inside its wind field');

  const one = analyzeSystem(gdacsOne(), HOME, new Date('2026-09-24T03:00:00Z'));
  assert.equal(one.insideCone, false);
  assert.equal(one.insideWindKmh, 0);
});

test('analyzeSystem: GDACS system without timeline, and far-away systems', () => {
  const t = new Date('2026-09-24T03:00:00Z');
  const one = analyzeSystem(gdacsOne(false), HOME, t);
  assert.equal(one.system.windKt, null);
  assert.equal(one.imdClassKey, 'imd.cs', 'warning without wind: class from the TS track label');
  assert.equal(one.jtwcClass, 'TS');
  assert.ok(one.samples.every((x) => x.windKt === null));
  assert.equal(one.samples.length, 1 + 24, '2 forecast points, 12 h apart');
  assert.equal(one.inRegion, true);
  assert.equal(one.movement.compass, 'N', 'last two GDACS observations: 17.8N → 18.1N');

  const invest = analyzeSystem(makeSystem({ kind: 'invest', position: { lat: 12, lon: 88, time: null } }), HOME, NOW);
  assert.equal(invest.imdClassKey, 'imd.low');
  assert.equal(+invest.samples[0].time, +NOW, 'unknown position time → now');
  assert.equal(invest.movement, null);

  const surigae = analyzeSystem(mergeSystems([gdacsSurigae()], [jtwc25W()])[0], HOME, NOW);
  assert.equal(surigae.inRegion, false);
  assert.equal(surigae.relevant, false, '3 933 km > 2 500 km: listed under "Elsewhere", not near Myanmar');
  near(surigae.samples[1].hoursFromNow, -2.5, 1e-9, 'first hourly step after the 12Z fix');

  const polo = analyzeSystem(makeSystem({ position: { lat: 23.6, lon: -113.8, time: NOW } }), HOME, NOW);
  assert.equal(polo.relevant, false);
  assert.equal(polo.imdClassKey, 'imd.d', 'warning with no wind and no class: at least a depression');

  const fay = events.find((e) => e.eventName === 'FAY-26');
  const fayA = analyzeSystem(toSystem(fay), HOME, NOW);
  assert.equal(fayA.imdClassKey, 'imd.d');
  assert.equal(fayA.jtwcClass, 'TD');
  const poloA = analyzeSystem(toSystem(events.find((e) => e.eventName === 'POLO-26')), HOME, NOW);
  assert.equal(poloA.imdClassKey, 'imd.vscs', 'hurricane now → at least VSCS');
  assert.equal(poloA.system.windKt, null);
});

test('sortAnalyses: threat level desc, then distance', () => {
  const mk = (id, distanceKm, level) => ({ id, distanceKm, level });
  const list = [mk('a', 900, 1), mk('b', 200, 1), mk('c', 3000, 3), mk('d', 50, null), mk('e', 100, 0)];
  const sorted = sortAnalyses(list, (x) => x.level);
  assert.deepEqual(sorted.map((x) => x.id), ['c', 'b', 'a', 'e', 'd']);
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c', 'd', 'e'], 'input not mutated');
  assert.deepEqual(sortAnalyses(list, (x) => ({ level: x.level, reasons: [] })).map((x) => x.id), ['c', 'b', 'a', 'e', 'd']);
  assert.deepEqual(sortAnalyses(list).map((x) => x.id), ['d', 'e', 'b', 'a', 'c'], 'distance only');
});

// ---------------------------------------------------------------------------
// Review fixes: stale fixes, merged tracks, class wind floors
// ---------------------------------------------------------------------------

const { stormThreat } = await import('../js/risk.js');
const { parseAdvisoryText } = await import('../js/jtwc.js');

test('a storm with no forecast track keeps its last position "now" (advisory summary read hours later)', () => {
  const fix = new Date('2026-09-28T12:00:00Z');
  const summary = makeSystem({ issuedAt: fix, position: { lat: 16.0, lon: 95.9, time: fix }, windKt: 55, track: [{ time: fix, lat: 16.0, lon: 95.9, forecast: false, windKt: 55, cls: 'TS' }] });
  const at = (h) => {
    const t = new Date(+fix + h * H);
    return stormThreat(analyzeSystem(summary, HOME, t), t);
  };
  assert.equal(at(0.5).level, 3, 'fresh fix');
  assert.equal(at(4).level, 3, '4 h later: still a tropical storm ~100 km away');
  assert.ok(at(4).reasons.some((r) => r.code === 'storm.trackNear'));
  assert.equal(at(30).level, 1, 'a day and more later the old fix no longer counts as "now"');
});

test('merge: a JTWC advisory summary does not wipe out the GDACS forecast track', () => {
  const summary = parseAdvisoryText(jtwcFix('abpwweb.txt'), NOW).find((s) => s.designation === '25W');
  assert.ok(summary && summary.track.length === 1);
  const g = gdacsSurigae();
  const gForecast = g.track.filter((p) => p.forecast && +p.time > +summary.position.time + 30 * 60e3);
  const merged = mergeSystems([g], [summary])[0];
  assert.equal(merged.id, 'jtwc:25W');
  assert.deepEqual(merged.position, summary.position, 'position from the newer JTWC product');
  assert.deepEqual(merged.issuedAt, summary.issuedAt);
  const fc = merged.track.filter((p) => p.forecast);
  assert.equal(fc.length, gForecast.length);
  assert.ok(fc.length >= 5);
  for (let i = 1; i < merged.track.length; i++) assert.ok(merged.track[i].time >= merged.track[i - 1].time, 'chronological');
});

/** Move a whole GDACS storm (geometry, timeline, event) by dlat/dlon degrees. */
function shifted(dlat, dlon) {
  const moveCoords = (c) => (typeof c[0] === 'number' ? [c[0] + dlon, c[1] + dlat, ...c.slice(2)] : c.map(moveCoords));
  const geo = gdacsFix('geometry_SURIGAE-26.json');
  for (const f of geo.features) if (f.geometry?.coordinates) f.geometry.coordinates = moveCoords(f.geometry.coordinates);
  const tl = gdacsFix('timeline_SURIGAE-26.json');
  const items = Array.isArray(tl.channel.item) ? tl.channel.item : [tl.channel.item];
  for (const it of items) {
    it.latitude = String(+it.latitude + dlat);
    it.longitude = String(+it.longitude + dlon);
  }
  const ev = { ...events.find((e) => e.eventName === 'SURIGAE-26') };
  ev.lat += dlat;
  ev.lon += dlon;
  return { ev, geo, tl };
}

test('GDACS storm without its wind timeline: TS/HU labels still count as that strength', () => {
  const { ev, geo, tl } = shifted(-13.9, -41.4);
  const at = new Date('2026-09-28T13:00:00Z');
  const withTl = toSystem(ev, geo, tl);
  const noTl = toSystem(ev, geo, null);
  for (const s of [withTl, noTl]) s.windAreas = []; // only the track rules here
  const lvlWith = stormThreat(analyzeSystem(withTl, HOME, at), at).level;
  const lvlWithout = stormThreat(analyzeSystem(noTl, HOME, at), at).level;
  assert.equal(noTl.windKt, null);
  assert.ok(noTl.track.some((p) => p.windKtMin === 64), 'HU segments give a 64 kt floor');
  assert.equal(lvlWith, 3);
  assert.equal(lvlWithout, lvlWith, 'the missing timeline does not lower the level');
});
