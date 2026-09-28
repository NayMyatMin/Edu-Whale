// End-to-end regression for the real 28 September 2026 situation, in pure
// Node: every fixture goes through the real parsers and fetchers (with a
// stubbed global fetch serving the captured responses), then merge →
// analyse → DMH → risk, exactly as the page does it.
//
// That day a Deep Depression crossed the coast ~90 km ENE of Yangon under a
// DMH Brown-stage warning, JTWC only had it as a formation alert (92W), and
// GDACS did not list it at all. The page must say Danger — and with DMH and
// JTWC unavailable it must say Unknown, never Calm.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOME, URLS } from '../js/config.js';
import { buildDmhJson } from '../scripts/lib/dmh-parse.mjs';
import { evaluateDmh, evaluateOverride } from '../js/dmh.js';
import { fetchJtwc } from '../js/jtwc.js';
import { fetchGdacs } from '../js/gdacs.js';
import { normalizeWeather } from '../js/weather.js';
import { analyzeSystem, mergeSystems, sortAnalyses } from '../js/systems.js';
import { assessRisk, stormThreat } from '../js/risk.js';
import { buildState } from '../js/ui/pipeline.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (p) => readFileSync(join(ROOT, 'tests/fixtures', p), 'utf8');
const json = (p) => JSON.parse(fx(p));

const NOW = new Date('2026-09-28T13:00:00Z'); // 19:30 in Yangon, just after DMH Warning No.3

// ---------------------------------------------------------------------------
// Stubbed network: every URL the fetchers ask for maps to a fixture file.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const GDACS_TIMELINE = 'https://www.gdacs.org/gdacsapi/api/export/gettimeline?id=990001';

function gdacsRoutes() {
  // Surigae (≈3 900 km away) is the only current event near enough for detail;
  // the captured eventdata document belongs to ONE, so point its timeline at Surigae's.
  const eventData = json('gdacs/eventdata_ONE-26.json');
  eventData.properties.impacts[0].resource.timeline = GDACS_TIMELINE;
  return [
    [/\/events\/geteventlist\//, fx('gdacs/eventlist.json')],
    [/\/polygons\/getgeometry\?eventtype=TC&eventid=1001327(&|$)/, fx('gdacs/geometry_SURIGAE-26.json')],
    [/\/events\/geteventdata\?eventtype=TC&eventid=1001327(&|$)/, JSON.stringify(eventData)],
    [/\/export\/gettimeline\?id=990001$/, fx('gdacs/timeline_SURIGAE-26.json')],
  ];
}

function jtwcRoutes() {
  const file = (name) => [new RegExp(`^${URLS.jtwcProducts.replace(/[.]/g, '\\.')}${name.replace('.', '\\.')}$`), fx(`jtwc/${name}`)];
  return [
    [new RegExp(`^${URLS.jtwcRss.replace(/[.]/g, '\\.')}$`), fx('jtwc/jtwc.rss')],
    file('wp9226web.txt'),
    file('wp2526web.txt'),
    file('abioweb.txt'),
    file('abpwweb.txt'),
  ];
}

/** Serve fixtures; anything else is a 404. `down` = regexes that fail like a dead network. */
function stubFetch(routes, { down = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input);
    calls.push(url);
    if (down.some((re) => re.test(url))) throw new TypeError('Failed to fetch');
    for (const [re, body] of routes) if (re.test(url)) return new Response(body, { status: 200 });
    return new Response('Not Found', { status: 404 });
  };
  return calls;
}

// ---------------------------------------------------------------------------
// Pipeline pieces
// ---------------------------------------------------------------------------

function dmhJsonFromFixtures(now = NOW) {
  const built = buildDmhJson({
    rssEn: fx('dmh/rss_en.xml'),
    rssMy: fx('dmh/rss_my.xml'),
    homeEn: fx('dmh/home_en.html'),
    homeMy: fx('dmh/home_my.html'),
    cycloneNewsEn: fx('dmh/cyclone-news_en.html'),
    now,
  });
  // Round-trip through JSON exactly like data/dmh.json.
  return JSON.parse(JSON.stringify(built));
}

async function liveFeeds(now = NOW) {
  stubFetch([...gdacsRoutes(), ...jtwcRoutes()]);
  const [gdacs, jtwc] = await Promise.all([fetchGdacs(now, HOME), fetchJtwc(now, HOME)]);
  return { gdacs, jtwc };
}

function analyse(systems, now = NOW) {
  const analyses = systems.map((s) => analyzeSystem(s, HOME, now));
  const threats = new Map(analyses.map((a) => [a.system.id, stormThreat(a, now)]));
  return { analyses: sortAnalyses(analyses, (a) => threats.get(a.system.id).level), threats };
}

const override = () => evaluateOverride(JSON.parse(readFileSync(join(ROOT, 'data/override.json'), 'utf8')), NOW);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('28 Sep 2026: DMH fixtures → Brown-stage Deep Depression ~89 km ENE, current', () => {
  const dmh = evaluateDmh(dmhJsonFromFixtures(), HOME, NOW);
  assert.equal(dmh.available, true);
  assert.equal(dmh.checkStale, false);
  const b = dmh.bulletin;
  assert.ok(b, 'a cyclone bulletin');
  assert.equal(b.kind, 'warning');
  assert.equal(b.stage, 'brown');
  assert.equal(b.system, 'deep-depression');
  assert.equal(b.number, 3);
  assert.equal(b.isCurrent, true);
  assert.equal(b.near, true);
  assert.equal(b.compassFromHome, 'ENE');
  assert.ok(b.distanceKm > 80 && b.distanceKm < 100, `distance ${b.distanceKm}`);
  assert.ok(b.title.en && b.title.my, 'bilingual title');
  assert.ok(b.summary.en.length > 50 && b.summary.my.length > 50, 'bilingual summary');
});

test('28 Sep 2026: JTWC + GDACS fixtures via the real fetchers → 92W formation alert ~335 km away', async () => {
  const { gdacs, jtwc } = await liveFeeds();
  assert.equal(gdacs.ok, true);
  assert.equal(jtwc.ok, true);
  assert.deepEqual(jtwc.errors, []);
  assert.deepEqual(gdacs.errors, []);
  const gSurigae = gdacs.systems.find((s) => s.name === 'Surigae');
  assert.ok(gSurigae, 'GDACS lists Surigae');
  assert.equal(gSurigae.windKt, 90, 'detail (geometry + timeline) fetched for the storm within 4000 km');
  assert.equal(gSurigae.track.length, 28);
  assert.ok(!gdacs.systems.some((s) => /92W/i.test(s.designation ?? '')), 'GDACS did not list the Yangon system');

  const merged = mergeSystems(gdacs.systems, jtwc.systems);
  const { analyses, threats } = analyse(merged);
  const a92 = analyses.find((a) => a.system.designation === '92W');
  assert.ok(a92, '92W present after merge');
  assert.equal(a92.system.kind, 'tcfa');
  assert.ok(Math.abs(a92.distanceKm - 335) <= 15, `92W distance ${a92.distanceKm.toFixed(1)} km`);
  assert.equal(a92.relevant, true);
  assert.equal(a92.inRegion, true);
  assert.ok(a92.tcfa?.insideCorridor, 'Yangon inside the TCFA corridor');
  assert.equal(threats.get(a92.system.id).level, 2, 'the formation alert alone means Prepare');
  assert.equal(analyses[0], a92, 'the most threatening system sorts first');

  const surigae = analyses.find((a) => a.system.name === 'Surigae');
  assert.ok(surigae && surigae.distanceKm > 3500, 'Surigae is far away');
  assert.equal(threats.get(surigae.system.id).level, 0);
});

test('28 Sep 2026: full pipeline with every source → Danger (3) led by the DMH stage', async () => {
  const { gdacs, jtwc } = await liveFeeds();
  const weather = normalizeWeather(json('openmeteo/yangon_2026-09-28.json'), NOW);
  assert.ok(weather, 'forecast usable');
  const dmh = evaluateDmh(dmhJsonFromFixtures(), HOME, NOW);
  const { analyses } = analyse(mergeSystems(gdacs.systems, jtwc.systems));

  const risk = assessRisk({ systems: analyses, dmh, weather, override: override(), now: NOW, gaps: [] });
  assert.equal(risk.level, 3);
  assert.deepEqual(risk.gaps, []);
  const top = risk.reasons[0];
  assert.equal(top.code, 'dmh.stage');
  assert.equal(top.source, 'dmh');
  assert.equal(top.level, 3);
  assert.equal(top.params.stage, 'brown');
  assert.equal(top.params.compass, 'ENE');
  assert.ok(risk.reasons.some((r) => r.code === 'storm.tcfaNear' && r.params.name === 'Invest 92W'), '92W formation alert listed');
  assert.ok(!risk.reasons.some((r) => r.code === 'calm' || r.code === 'unknown'));

  // The same through the page's own pipeline (main.js → js/ui/pipeline.js).
  const state = buildState({
    gdacs: { ...gdacs, fetchedAt: NOW },
    jtwc: { ...jtwc, fetchedAt: NOW },
    dmhJson: dmhJsonFromFixtures(),
    weather,
    overrideJson: JSON.parse(readFileSync(join(ROOT, 'data/override.json'), 'utf8')),
    now: NOW,
  });
  assert.equal(state.risk.level, 3);
  assert.equal(state.risk.reasons[0].code, 'dmh.stage');
  assert.equal(state.dmh.bulletin.stage, 'brown');
  assert.equal(state.relevant[0].system.designation, '92W');
});

test('28 Sep 2026: DMH alone still gives Danger when every storm feed is down', async () => {
  stubFetch([], { down: [/./] });
  const [gdacs, jtwc] = await Promise.all([fetchGdacs(NOW, HOME), fetchJtwc(NOW, HOME)]);
  assert.equal(gdacs.ok, false);
  assert.equal(jtwc.ok, false);
  const dmh = evaluateDmh(dmhJsonFromFixtures(), HOME, NOW);
  const risk = assessRisk({ systems: null, dmh, weather: null, now: NOW, gaps: ['gdacs', 'jtwc'] });
  assert.equal(risk.level, 3);
  assert.equal(risk.reasons[0].code, 'dmh.stage');
  assert.deepEqual(risk.gaps, ['storms', 'gdacs', 'jtwc', 'weather']);
});

test('28 Sep 2026: DMH unavailable and storms unknown → level null (Unknown), never Calm', async () => {
  const weather = normalizeWeather(json('openmeteo/yangon_2026-09-28.json'), NOW);
  const noDmh = evaluateDmh(null, HOME, NOW);
  assert.equal(noDmh.available, false);

  const r = assessRisk({ systems: null, dmh: noDmh, weather, now: NOW, gaps: ['gdacs', 'jtwc'] });
  assert.equal(r.level, null);
  assert.notEqual(r.level, 0);
  assert.equal(r.reasons[0].code, 'unknown');
  assert.equal(r.reasons[0].level, null);
  assert.ok(!r.reasons.some((x) => x.code === 'calm'));
  assert.ok(r.gaps.includes('dmh') && r.gaps.includes('storms'));

  // Also with no forecast at all.
  const r0 = assessRisk({ systems: null, dmh: null, weather: null, now: NOW });
  assert.equal(r0.level, null);

  // GDACS-only (as on the day: it did not list the storm) with DMH and JTWC down → still Unknown.
  const { gdacs } = await liveFeeds();
  stubFetch([...gdacsRoutes()], { down: [/metoc\.navy\.mil/] });
  const jtwcDown = await fetchJtwc(NOW, HOME);
  assert.equal(jtwcDown.ok, false);
  const state = buildState({
    gdacs: { ...gdacs, fetchedAt: NOW },
    jtwc: { ...jtwcDown, fetchedAt: null },
    dmhJson: null,
    weather,
    overrideJson: null,
    now: NOW,
  });
  assert.equal(state.stormsKnown, true);
  assert.equal(state.risk.level, null, 'GDACS alone is not enough to call it calm');
  assert.equal(state.risk.reasons[0].code, 'unknown');

  // A stale DMH check (no current bulletin) is no better than a missing one.
  const oldJson = dmhJsonFromFixtures(new Date('2026-09-20T00:00:00Z'));
  oldJson.cyclone = null;
  const stale = evaluateDmh(oldJson, HOME, NOW);
  assert.equal(stale.checkStale, true);
  assert.equal(assessRisk({ systems: null, dmh: stale, weather, now: NOW }).level, null);
});
