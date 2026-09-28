import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildEventListUrl,
  fetchGdacs,
  isActiveEvent,
  parseEventList,
  parseGeometry,
  parseTimeline,
  toSystem,
} from '../js/gdacs.js';
import { HOME } from '../js/config.js';

const FIX = new URL('./fixtures/gdacs/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const iso = (d) => d.toISOString();

const NOW = new Date('2026-09-28T15:06:00Z');

test('buildEventListUrl: 14-day window, all alert levels', () => {
  const url = buildEventListUrl(NOW);
  assert.ok(url.startsWith('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?'));
  assert.match(url, /eventlist=TC/);
  assert.match(url, /alertlevel=Green;Orange;Red/);
  assert.match(url, /fromdate=2026-09-14(&|$)/);
});

test('parseEventList: count, string booleans, 204/empty', () => {
  const events = parseEventList(load('eventlist.json'));
  assert.equal(events.length, 100);
  assert.equal(events.filter((e) => e.isCurrent).length, 7);

  const surigae = events.find((e) => e.eventName === 'SURIGAE-26');
  assert.equal(surigae.eventId, 1001327);
  assert.equal(surigae.episodeId, 22);
  assert.equal(surigae.name, 'Surigae');
  assert.equal(surigae.isCurrent, true);
  assert.equal(surigae.lat, 27.5);
  assert.equal(surigae.lon, 132.8);
  assert.equal(iso(surigae.toDate), '2026-09-28T12:00:00.000Z');
  assert.equal(surigae.alertLevel, 'Green');

  assert.equal(surigae.statusCls, 'HU');
  assert.equal(events.find((e) => e.eventName === 'FAY-26').statusCls, 'TD', 'weakened: TD now, max 111 km/h');

  const one = events.find((e) => e.eventName === 'ONE-26');
  assert.equal(one.isCurrent, false, '"false" string is false');
  assert.equal(one.alertLevel, 'Orange');

  // Active = current AND updated within 24 h: GONZALO-26 (todate 26 Sep 21:00) is stale.
  const active = events.filter((e) => isActiveEvent(e, NOW)).map((e) => e.eventName).sort();
  assert.deepEqual(active, ['FAY-26', 'NOLO-26', 'ODALYS-26', 'POLO-26', 'RACHEL-26', 'SURIGAE-26']);

  assert.deepEqual(parseEventList(null), [], '204 → fetchJson null');
  assert.deepEqual(parseEventList({}), []);
  assert.deepEqual(parseEventList({ features: 'nope' }), []);
  assert.deepEqual(parseEventList({ features: [null, { properties: { eventtype: 'EQ' } }] }), []);
});

test('parseGeometry ONE-26: 8 points, 2 forecast, UTC times, categories', () => {
  const g = parseGeometry(load('geometry_ONE-26.json'));
  assert.equal(iso(g.advisoryTime), '2026-09-24T00:00:00.000Z');
  assert.equal(g.points.length, 8);
  assert.deepEqual(
    g.points.map((p) => iso(p.time)),
    [
      '2026-09-22T18:00:00.000Z',
      '2026-09-23T00:00:00.000Z',
      '2026-09-23T06:00:00.000Z',
      '2026-09-23T12:00:00.000Z',
      '2026-09-23T18:00:00.000Z',
      '2026-09-24T00:00:00.000Z',
      '2026-09-24T12:00:00.000Z',
      '2026-09-25T00:00:00.000Z',
    ],
  );
  assert.deepEqual(g.points.map((p) => p.forecast), [false, false, false, false, false, false, true, true]);
  // Line order is scrambled in the file; labels still land on the right points.
  assert.deepEqual(g.points.map((p) => p.cls), ['TS', 'TS', 'TS', 'TS', 'TS', 'TS', 'TD', 'TD']);
  assert.deepEqual([g.points[5].lat, g.points[5].lon], [18.1, 83.7]);
  assert.deepEqual([g.points[7].lat, g.points[7].lon], [20.1, 82.7]);
  assert.ok(g.points.every((p) => p.windKt === null), 'geometry carries no per-point wind');

  assert.equal(g.cone.type, 'Feature');
  assert.equal(g.cone.geometry.type, 'Polygon');
  assert.equal(g.windAreas.length, 9);
  assert.deepEqual([...new Set(g.windAreas.map((a) => a.kmh))], [60, 90, 120]);
  assert.equal(iso(g.windAreas[0].time), '2026-09-24T00:00:00.000Z');
  assert.equal(iso(g.windAreas.at(-1).time), '2026-09-25T00:00:00.000Z');
  assert.ok(g.swath.kmh60, 'green swath present');
  assert.equal(g.swath.kmh90, null);
  assert.equal(g.swath.kmh120, null);
});

test('parseGeometry GRANT-26: December → January year rollover', () => {
  const g = parseGeometry(load('geometry_GRANT-26.json'));
  assert.equal(g.points.length, 40);
  assert.equal(iso(g.points[0].time), '2025-12-18T12:00:00.000Z');
  assert.equal(iso(g.points[27].time), '2025-12-31T12:00:00.000Z');
  assert.equal(iso(g.points[28].time), '2026-01-01T00:00:00.000Z');
  assert.equal(iso(g.points[39].time), '2026-01-08T00:00:00.000Z');
  for (let i = 1; i < g.points.length; i++) assert.ok(g.points[i].time > g.points[i - 1].time, `chronological at ${i}`);
  assert.equal(g.points.filter((p) => p.forecast).length, 7);
  assert.ok(g.points.every((p) => p.cls), 'every point classified');
  // Degenerate (Point) wind radii are dropped; only real areas remain.
  assert.ok(g.windAreas.every((a) => ['Polygon', 'MultiPolygon'].includes(a.feature.geometry.type)));
  assert.equal(g.windAreas.length, 7);
});

test('parseGeometry URMIL-26: date line', () => {
  const g = parseGeometry(load('geometry_URMIL-26.json'));
  assert.equal(g.points.length, 12);
  assert.equal(g.points[10].lon, 179.2);
  assert.equal(g.points[11].lon, -175.5);
  assert.equal(g.points[11].forecast, true);
  assert.equal(iso(g.points[11].time), '2026-03-01T18:00:00.000Z');
  // The split ±180 line pieces cannot be matched; the class is filled from its neighbour.
  assert.equal(g.points[11].cls, 'TS');
  assert.ok(g.points.every((p) => ['TD', 'TS', 'HU'].includes(p.cls)));
  assert.equal(g.cone.geometry.type, 'MultiPolygon');
  assert.equal(g.swath.kmh60.geometry.type, 'MultiPolygon');
});

test('parseGeometry: empty and malformed input', () => {
  const empty = parseGeometry(null);
  assert.deepEqual(empty.points, []);
  assert.equal(empty.cone, null);
  assert.deepEqual(empty.windAreas, []);
  assert.deepEqual(parseGeometry({ features: [{}, { properties: { Class: 'Point_Polygon_Point_0' } }] }).points, []);
});

test('parseTimeline: wind m/s → kt, actual/current flags, one-item object', () => {
  const tl = parseTimeline(load('timeline_ONE-26.json'));
  assert.equal(tl.length, 8);
  assert.equal(iso(tl[0].time), '2026-09-22T18:00:00.000Z');
  assert.deepEqual(tl.map((p) => p.windKt), [35, 40, 45, 45, 40, 35, 30, 25]); // 18.004 m/s = 35 kt
  assert.deepEqual(tl.map((p) => p.forecast), [false, false, false, false, false, false, true, true]);
  assert.deepEqual(tl.map((p) => p.current), [false, false, false, false, false, true, false, false]);
  assert.equal(tl[0].gustKt, 45);
  assert.equal(tl[0].pressureHpa, null, '"0" pressure = missing');
  assert.equal(tl[0].status, 'Tropical Storm');

  const single = load('timeline_ONE-26.json');
  single.channel.item = single.channel.item[5];
  const one = parseTimeline(single);
  assert.equal(one.length, 1);
  assert.equal(one[0].current, true);
  assert.equal(one[0].windKt, 35);

  assert.deepEqual(parseTimeline(null), []);
  assert.deepEqual(parseTimeline({ channel: {} }), []);
});

test('toSystem ONE-26: current wind from timeline, not lifetime severity', () => {
  const ev = parseEventList(load('eventlist.json')).find((e) => e.eventName === 'ONE-26');
  assert.ok(ev.severityKmh > 83, 'lifetime max 83 km/h (45 kt) in the event list');
  const s = toSystem(ev, load('geometry_ONE-26.json'), load('timeline_ONE-26.json'));
  assert.equal(s.id, 'gdacs:1001326');
  assert.deepEqual(s.sources, ['gdacs']);
  assert.equal(s.kind, 'warning');
  assert.equal(s.name, 'One');
  assert.equal(s.basin, 'NIO');
  assert.equal(s.windKt, 35, 'current point wind');
  assert.equal(s.gustKt, 45);
  assert.deepEqual(s.position, { lat: 18.1, lon: 83.7, time: new Date('2026-09-24T00:00:00Z') });
  assert.equal(iso(s.issuedAt), '2026-09-24T00:00:00.000Z');
  assert.equal(s.track.length, 8);
  assert.deepEqual(s.track.map((p) => p.windKt), [35, 40, 45, 45, 40, 35, 30, 25]);
  assert.deepEqual(s.track.map((p) => p.cls), ['TS', 'TS', 'TS', 'TS', 'TS', 'TS', 'TD', 'TD']);
  assert.equal(s.track.filter((p) => p.forecast).length, 2);
  assert.equal(s.alertLevel, 'Orange');
  assert.equal(s.cone.geometry.type, 'Polygon');
  assert.equal(s.windAreas.length, 9);
  assert.equal(s.links.gdacsReport, 'https://www.gdacs.org/report.aspx?eventid=1001326&episodeid=6&eventtype=TC');

  // Pre-parsed inputs give the same result.
  const again = toSystem(ev, parseGeometry(load('geometry_ONE-26.json')), parseTimeline(load('timeline_ONE-26.json')));
  assert.equal(again.windKt, 35);
  assert.equal(again.track.length, 8);
});

test('toSystem without timeline: wind unknown, class from geometry', () => {
  const ev = parseEventList(load('eventlist.json')).find((e) => e.eventName === 'ONE-26');
  const s = toSystem(ev, load('geometry_ONE-26.json'), null);
  assert.equal(s.windKt, null);
  assert.deepEqual(s.track.map((p) => p.cls), ['TS', 'TS', 'TS', 'TS', 'TS', 'TS', 'TD', 'TD']);
  assert.ok(s.track.every((p) => p.windKt === null));

  const bare = toSystem(ev);
  assert.deepEqual(bare.track, [
    { time: new Date('2026-09-24T00:00:00Z'), lat: 18.1, lon: 83.7, forecast: false, windKt: null, cls: 'TS' },
  ]);
  assert.deepEqual(bare.position, { lat: 18.1, lon: 83.7, time: new Date('2026-09-24T00:00:00Z') });
  assert.equal(bare.windKt, null);
  assert.equal(bare.cone, null);
  assert.deepEqual(bare.windAreas, []);
});

test('toSystem SURIGAE-26: 90 kt now although the lifetime max was 130 kt', () => {
  const ev = parseEventList(load('eventlist.json')).find((e) => e.eventName === 'SURIGAE-26');
  const s = toSystem(ev, load('geometry_SURIGAE-26.json'), load('timeline_SURIGAE-26.json'));
  assert.equal(s.windKt, 90);
  assert.equal(s.basin, 'WPAC');
  assert.equal(s.track.length, 28);
  assert.equal(s.track.filter((p) => p.forecast).length, 6);
  assert.equal(iso(s.track.at(-1).time), '2026-10-01T12:00:00.000Z');
  assert.equal(s.windAreas.length, 21);
  assert.ok(s.swath.kmh60 && s.swath.kmh90 && s.swath.kmh120);
  assert.equal(s.final, false);
});

// ---------------------------------------------------------------------------
// fetchGdacs with a stubbed global fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const TIMELINE_URL = 'https://www.gdacs.org/gdacsapi/api/export/gettimeline?id=900001';

function stubFetch(routes) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      for (const [re, body] of routes) {
        if (re.test(url)) {
          if (body === 204) return new Response(null, { status: 204 });
          return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ title: 'Not Found', status: 404 }), { status: 404 });
    } finally {
      inFlight--;
    }
  };
  return { calls, max: () => maxInFlight };
}

test('fetchGdacs: current events, detail only near home, ≤ 4 in flight', async () => {
  const eventData = load('eventdata_ONE-26.json');
  eventData.properties.impacts[0].resource.timeline = TIMELINE_URL;
  const stub = stubFetch([
    [/geteventlist/, load('eventlist.json')],
    [/getgeometry\?eventtype=TC&eventid=1001327&episodeid=22/, load('geometry_SURIGAE-26.json')],
    [/geteventdata\?eventtype=TC&eventid=1001327/, eventData],
    [/gettimeline\?id=900001/, load('timeline_SURIGAE-26.json')],
  ]);
  const res = await fetchGdacs(NOW, HOME);
  assert.equal(res.ok, true);
  assert.equal(res.systems.length, 6);
  const surigae = res.systems.find((s) => s.id === 'gdacs:1001327');
  assert.equal(surigae.windKt, 90, 'timeline fetched for the storm within 4000 km');
  assert.equal(surigae.track.length, 28);
  // Far-away storms become track-less systems (listed under "Elsewhere").
  const polo = res.systems.find((s) => s.name === 'Polo');
  assert.equal(polo.track.length, 1, 'current fix only');
  assert.equal(polo.track[0].cls, 'HU', 'from the current status word, not the lifetime max');
  assert.equal(polo.windKt, null);
  assert.equal(polo.basin, 'EPAC');
  assert.equal(stub.calls.filter((u) => /getgeometry|geteventdata|gettimeline/.test(u)).length, 3);
  assert.ok(stub.max() <= 4);
});

test('fetchGdacs: detail failures still return the system', async () => {
  stubFetch([[/geteventlist/, load('eventlist.json')]]); // geometry/eventdata → 404
  const res = await fetchGdacs(NOW, HOME);
  assert.equal(res.ok, true);
  const surigae = res.systems.find((s) => s.id === 'gdacs:1001327');
  assert.ok(surigae);
  assert.equal(surigae.windKt, null);
  assert.ok(res.errors.length >= 1);
});

test('fetchGdacs: 204 → ok with no systems', async () => {
  stubFetch([[/geteventlist/, 204]]);
  const res = await fetchGdacs(NOW, HOME);
  assert.deepEqual(res, { systems: [], ok: true, errors: [] });
});

test('fetchGdacs: network failure → ok:false, never throws', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const res = await fetchGdacs(NOW, HOME);
  assert.equal(res.ok, false);
  assert.deepEqual(res.systems, []);
  assert.match(res.error, /Failed to fetch/);

  stubFetch([[/geteventlist/, '<html>maintenance</html>']]);
  const bad = await fetchGdacs(NOW, HOME);
  assert.equal(bad.ok, false, 'non-JSON body');
});
