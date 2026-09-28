import test from 'node:test';
import assert from 'node:assert/strict';

import { DEMO_EXPECTED_LEVEL, DEMO_NAMES, getDemo } from '../js/demo.js';

// The pipeline modules are written by other builders; skip (not fail) if one
// is missing so this file stays useful mid-build.
let pipeline = null;
let weather = null;
let loadError = null;
try {
  pipeline = await import('../js/ui/pipeline.js');
  weather = await import('../js/weather.js');
} catch (err) {
  loadError = err;
}

const NOWS = [
  new Date(),
  new Date('2026-09-28T16:20:00Z'),
  new Date('2026-12-31T17:10:00Z'), // just before Yangon midnight on New Year's Eve
  new Date('2027-01-01T03:00:00Z'),
  new Date('2027-05-10T08:45:00Z'),
];

function run(name, now) {
  const d = getDemo(name, now);
  return pipeline.buildState({
    gdacs: { systems: d.gdacsSystems, ok: true },
    jtwc: { systems: d.jtwcSystems, ok: true },
    dmhJson: d.dmhJson,
    weather: weather.normalizeWeather(d.weatherJson, now),
    overrideJson: d.override,
    now,
  });
}

test('getDemo: unknown names give null; every scenario has the documented shape', () => {
  assert.equal(getDemo('nope', new Date()), null);
  const now = new Date('2026-09-28T16:20:00Z');
  for (const name of DEMO_NAMES) {
    const d = getDemo(name, now);
    assert.ok(Array.isArray(d.gdacsSystems) && Array.isArray(d.jtwcSystems), name);
    for (const s of [...d.gdacsSystems, ...d.jtwcSystems]) {
      assert.ok(s.id && s.kind && s.position && Number.isFinite(s.position.lat), `${name} ${s.id}`);
      assert.ok(s.position.time instanceof Date, `${name} ${s.id} position.time`);
      for (const p of s.track) assert.ok(p.time instanceof Date && typeof p.forecast === 'boolean');
      for (const a of s.windAreas) assert.ok([60, 90, 120].includes(a.kmh) && a.feature.geometry.type === 'Polygon');
    }
    assert.equal(d.dmhJson.schema, 1);
    assert.ok(Date.parse(d.dmhJson.checkedAt) <= now.getTime(), `${name}: checkedAt not in the future`);
    const w = d.weatherJson;
    assert.equal(w.utc_offset_seconds, 23400);
    assert.equal(w.hourly.time.length, 264);
    assert.ok(w.hourly.time.every((t) => Number.isInteger(t)), 'unixtime');
    assert.ok(w.hourly.time.every((t) => (t + 23400) % 3600 === 0), 'on Yangon whole hours');
    assert.equal(w.daily.time.length, 11);
    for (const k of ['temperature_2m', 'precipitation', 'wind_gusts_10m', 'wind_speed_10m', 'weather_code']) assert.equal(w.hourly[k].length, 264, k);
  }
});

for (const name of DEMO_NAMES) {
  test(`demo "${name}" yields level ${DEMO_EXPECTED_LEVEL[name]} through the real pipeline`, (t) => {
    if (!pipeline) return t.skip(`pipeline modules not available: ${loadError?.message}`);
    for (const now of NOWS) {
      const st = run(name, now);
      assert.equal(st.risk.level, DEMO_EXPECTED_LEVEL[name], `${name} at ${now.toISOString()}: ${st.risk.reasons.map((r) => r.code).join(', ')}`);
      assert.deepEqual(st.risk.gaps, [], 'no source gaps in a demo');
    }
  });
}

test('demo "today" replays 28 Sep 2026: DMH brown stage ~90 km ENE shown, JTWC TCFA 92W, nothing from GDACS nearby', (t) => {
  if (!pipeline) return t.skip('pipeline modules not available');
  const now = new Date();
  const st = run('today', now);
  const b = st.dmh.bulletin;
  assert.equal(b.stage, 'brown');
  assert.equal(b.isCurrent, true);
  assert.equal(b.compassFromHome, 'ENE');
  assert.ok(b.distanceKm > 85 && b.distanceKm < 95, `${b.distanceKm}`);
  assert.equal(st.risk.reasons[0].code, 'dmh.stage');
  const tcfa = st.relevant.find((a) => a.system.designation === '92W');
  assert.equal(tcfa?.system.kind, 'tcfa');
  assert.equal(tcfa.tcfa.insideCorridor, true);
  assert.ok(st.relevant.every((a) => a.system.sources.includes('jtwc') || !a.inRegion), 'GDACS lists nothing in the region');
});

test('GDACS-only data from that day never says Calm when DMH and JTWC are unavailable', (t) => {
  if (!pipeline) return t.skip('pipeline modules not available');
  const now = new Date();
  const d = getDemo('today', now);
  const st = pipeline.buildState({
    gdacs: { systems: d.gdacsSystems, ok: true },
    jtwc: { systems: [], ok: false },
    dmhJson: null,
    weather: weather.normalizeWeather(d.weatherJson, now),
    overrideJson: null,
    now,
  });
  assert.equal(st.risk.level, null);
  assert.equal(st.risk.reasons[0].code, 'unknown');
  assert.ok(st.risk.gaps.includes('dmh') && st.risk.gaps.includes('jtwc'));
});

test('demo "approach": closest forecast pass ~100 km in ~36 h; model gusts ~95 km/h and ~180 mm/24 h', (t) => {
  if (!pipeline) return t.skip('pipeline modules not available');
  const now = new Date();
  const st = run('approach', now);
  const a = st.relevant[0];
  assert.ok(a.closest.distanceKm > 80 && a.closest.distanceKm < 125, `${a.closest.distanceKm}`);
  assert.ok(a.closest.hoursFromNow > 30 && a.closest.hoursFromNow < 42, `${a.closest.hoursFromNow}`);
  assert.equal(a.imdClassKey, 'imd.scs');
  assert.ok(a.system.cone && a.system.windAreas.length > 0);
  const n = st.weather.derived.next72h;
  assert.ok(n.maxGust >= 90 && n.maxGust <= 100, `${n.maxGust}`);
  assert.ok(n.maxRain24h >= 160 && n.maxRain24h < 200, `${n.maxRain24h}`);
  assert.equal(st.dmh.bulletin.stage, 'red');
  assert.deepEqual(st.dmh.recent.map((r) => r.stage), ['red', 'orange', 'orange']);
});

test('demo "watch": a depression ~700 km away heading north; DMH yellow-stage news', (t) => {
  if (!pipeline) return t.skip('pipeline modules not available');
  const st = run('watch', new Date());
  const a = st.relevant.find((x) => x.system.designation === '03B');
  assert.ok(a.distanceKm > 600 && a.distanceKm < 760, `${a.distanceKm}`);
  assert.ok(a.movement && (a.movement.compass === 'N' || a.movement.compass === 'NNW'), a.movement?.compass);
  assert.equal(a.system.sources.length, 2, 'GDACS and JTWC merged into one system');
  assert.equal(st.dmh.bulletin.kind, 'news');
  assert.equal(st.dmh.bulletin.stage, 'yellow');
});

test('demo "calm": no current DMH bulletin, nothing nearby, dry weather', (t) => {
  if (!pipeline) return t.skip('pipeline modules not available');
  const st = run('calm', new Date());
  assert.equal(st.dmh.available, true);
  assert.equal(st.dmh.bulletin.isCurrent, false);
  assert.equal(st.relevant.length, 0);
  assert.ok(st.elsewhere.length >= 1);
  assert.equal(st.weather.derived.next72h.maxRain72h, 0);
  assert.equal(st.risk.reasons.at(-1).code, 'calm');
});
