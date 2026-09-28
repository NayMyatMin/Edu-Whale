import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessRisk, stormThreat, weatherThreat, dmhThreat } from '../js/risk.js';
import { HOME, THRESHOLDS } from '../js/config.js';
import { evaluateDmh, evaluateOverride } from '../js/dmh.js';
import { normalizeWeather } from '../js/weather.js';
import { buildDmhJson } from '../scripts/lib/dmh-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (p) => readFileSync(join(ROOT, 'tests/fixtures', p), 'utf8');
const S = THRESHOLDS.storm;
const W = THRESHOLDS.weather;
const D = THRESHOLDS.dmh;
const NOW = new Date('2026-09-28T15:00:00Z');
const EPS = 0.01;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const EMPTY_NEXT = { maxGust: null, maxGustTime: null, maxWind: null, maxWindTime: null, maxRain24h: null, maxRain24hEnd: null, maxRain48h: null, maxRain72h: null, maxRainHour: null, maxRainHourTime: null };
const weatherWith = (next = {}) => ({ derived: { pressureTrend3h: null, next72h: { ...EMPTY_NEXT, ...next } } });
const CALM_WEATHER = weatherWith({ maxGust: 20, maxWind: 10, maxRain24h: 5, maxRain48h: 6, maxRain72h: 7, maxRainHour: 1 });

const sample = (h, km, windKt = null, forecast = h > 0) => ({ time: new Date(NOW.getTime() + h * 3600e3), hoursFromNow: h, distanceKm: km, windKt, forecast, lat: 0, lon: 0 });

function analysis({ kind = 'warning', name = 'Test', km = 3000, compass = 'WSW', samples, inRegion = false, insideWindKmh = 0, insideCone = false, tcfa = null, potential = null, windKt = null } = {}) {
  return {
    system: { id: `x:${name}`, kind, name, potential, windKt },
    distanceKm: km,
    compassFromHome: compass,
    samples: samples ?? [sample(0, km, windKt, false)],
    imdClassKey: 'imd.cs',
    inRegion,
    insideCone,
    insideWindKmh,
    tcfa,
  };
}

function dmhStatus({ stage = null, kind = 'warning', near = true, km = 89, isCurrent = true, system = 'deep-depression', otherWarnings = [], available = true, checkStale = false } = {}) {
  return {
    available,
    checkStale,
    checkedAt: NOW,
    bulletin: { kind, stage, system, isCurrent, near, distanceKm: km, compassFromHome: km == null ? null : 'ENE', issuedAt: '2026-09-28T12:30:00Z', issuedAtDate: new Date('2026-09-28T12:30:00Z') },
    otherWarnings,
    recent: [],
    announcement: null,
  };
}

const codes = (r) => r.reasons.map((x) => x.code);

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

test('weatherThreat: each metric at and just below every threshold', () => {
  const metrics = {
    gustKmh: ['maxGust', 'weather.gust', 'kmh'],
    windKmh: ['maxWind', 'weather.wind', 'kmh'],
    rain24hMm: ['maxRain24h', 'weather.rain24h', 'mm'],
    rain48hMm: ['maxRain48h', 'weather.rain48h', 'mm'],
    rain72hMm: ['maxRain72h', 'weather.rain72h', 'mm'],
    rainHourMm: ['maxRainHour', 'weather.rainHour', 'mm'],
  };
  let checked = 0;
  for (const [band, level] of [['danger', 3], ['prepare', 2], ['monitor', 1]]) {
    for (const [key, limit] of Object.entries(W[band])) {
      const [field, code, param] = metrics[key];
      const at = weatherThreat(weatherWith({ [field]: limit }));
      assert.equal(at.level, level, `${band}.${key} at ${limit}`);
      assert.equal(at.reasons[0].code, code);
      assert.equal(at.reasons[0].params[param], limit);
      assert.equal(at.reasons[0].source, 'weather');
      const below = weatherThreat(weatherWith({ [field]: limit - EPS }));
      assert.ok(below.level < level, `${band}.${key} just below ${limit} -> ${below.level}`);
      checked++;
    }
  }
  assert.equal(checked, Object.keys(W.danger).length + Object.keys(W.prepare).length + Object.keys(W.monitor).length);
  assert.deepEqual(weatherThreat(null), { level: 0, reasons: [] });
  assert.equal(weatherThreat(CALM_WEATHER).level, 0);
});

test('weatherThreat: one reason per metric, highest band, sorted, times passed through', () => {
  const t = new Date('2026-09-29T06:00:00Z');
  const r = weatherThreat(weatherWith({ maxGust: W.danger.gustKmh + 5, maxGustTime: t, maxRainHour: W.monitor.rainHourMm, maxRainHourTime: t, maxRain72h: W.prepare.rain72hMm }));
  assert.equal(r.level, 3);
  assert.deepEqual(codes(r), ['weather.gust', 'weather.rain72h', 'weather.rainHour']);
  assert.deepEqual(r.reasons.map((x) => x.level), [3, 2, 1]);
  assert.deepEqual(r.reasons[0].params, { kmh: W.danger.gustKmh + 5, time: t });
  assert.deepEqual(r.reasons[1].params, { mm: W.prepare.rain72hMm });
});

test("weatherThreat on the real 28-Sep Open-Meteo forecast is calm (model misses the depression's winds)", () => {
  const raw = JSON.parse(fx('openmeteo/yangon_2026-09-28.json'));
  const w = normalizeWeather(raw, new Date(raw.current.time * 1000));
  assert.equal(weatherThreat(w).level, 0);
});

// ---------------------------------------------------------------------------
// Storms
// ---------------------------------------------------------------------------

test('storm danger: TS within trackKmTS / trackHoursTS', () => {
  const ts = (km, h, kt = 34) => stormThreat(analysis({ samples: [sample(0, 900, kt, false), sample(h, km, kt)] }), NOW);
  const at = ts(S.danger.trackKmTS, 10);
  assert.equal(at.level, 3);
  assert.equal(at.reasons[0].code, 'storm.trackNear');
  assert.equal(at.reasons[0].params.km, S.danger.trackKmTS);
  assert.equal(at.reasons[0].params.hours, 10);
  assert.equal(at.reasons[0].params.cls, 'imd.cs');
  assert.equal(ts(S.danger.trackKmTS + EPS, 10).level, 2, 'just outside 150 km: still within 300 km -> prepare');
  assert.equal(ts(S.danger.trackKmTS, S.danger.trackHoursTS).level, 3);
  assert.equal(ts(S.danger.trackKmTS, S.danger.trackHoursTS + EPS).level, 2);
  assert.equal(ts(S.danger.trackKmTS, 10, 33).level, 2, 'below TS strength');
  const r = ts(100, 10);
  assert.equal(r.reasons.filter((x) => x.code === 'storm.trackNear').length, 1, 'one reason per rule');
});

test('storm danger: hurricane within trackKmHU / trackHoursHU; prepare within 600 km / 72 h', () => {
  const hu = (km, h, kt = 64) => stormThreat(analysis({ samples: [sample(0, 2000, kt, false), sample(h, km, kt)] }), NOW);
  assert.equal(hu(S.danger.trackKmHU, 20).level, 3);
  assert.ok(codes(hu(S.danger.trackKmHU, 20)).includes('storm.hurricaneNear'));
  assert.equal(hu(S.danger.trackKmHU, 20, 63).level, 2, '63 kt is not HU; still ≤ 300 km any-wind prepare');
  assert.equal(hu(S.danger.trackKmHU + EPS, 20).level, 2);
  assert.equal(hu(S.prepare.trackKmHU, S.prepare.trackHoursHU).level, 2);
  assert.equal(hu(S.prepare.trackKmHU, S.prepare.trackHoursHU).reasons[0].code, 'storm.hurricaneNear');
  assert.equal(hu(S.prepare.trackKmHU + EPS, 40).level, 0, 'just beyond 600 km and far away: nothing');
  assert.equal(hu(S.prepare.trackKmHU, S.prepare.trackHoursHU + EPS).level, 1, 'after 72 h: monitor (forecast within 600 km)');
});

test('storm prepare: any warned system within trackKmAny / trackHoursAny; not for invests', () => {
  const any = (km, h, kind = 'warning') => stormThreat(analysis({ kind, samples: [sample(0, 2000, null, false), sample(h, km, null)] }), NOW);
  assert.equal(any(S.prepare.trackKmAny, S.prepare.trackHoursAny).level, 2);
  assert.equal(any(S.prepare.trackKmAny + EPS, 10).level, 1, 'monitor: forecast within 600 km');
  assert.equal(any(S.prepare.trackKmAny, S.prepare.trackHoursAny + EPS).level, 1);
  assert.equal(any(100, 10, 'invest').level, 1, 'invest forecast points: monitor only');
});

test('storm prepare: current centre within currentKm (warning or TCFA)', () => {
  const cur = (km, kind) => stormThreat(analysis({ kind, km, samples: [sample(0, km, 25, false)] }), NOW);
  for (const kind of ['warning', 'tcfa']) {
    const r = cur(S.prepare.currentKm, kind);
    assert.equal(r.level, 2, kind);
    assert.ok(codes(r).includes('storm.currentNear'));
    assert.deepEqual(r.reasons.find((x) => x.code === 'storm.currentNear').params, { name: 'Test', km: S.prepare.currentKm, compass: 'WSW' });
    assert.equal(cur(S.prepare.currentKm + EPS, kind).level, 1, `${kind} just outside -> monitor (nearby)`);
  }
});

test('storm: GDACS wind areas and cone', () => {
  const a = (opts) => stormThreat(analysis({ km: 800, ...opts }), NOW);
  assert.equal(a({ insideWindKmh: 120 }).level, 3);
  assert.equal(a({ insideWindKmh: S.danger.insideSwathKmh }).level, 3);
  assert.deepEqual(a({ insideWindKmh: 90 }).reasons[0].params, { name: 'Test', kmh: 90 });
  assert.equal(a({ insideWindKmh: S.prepare.insideSwathKmh }).level, 2);
  assert.equal(a({ insideCone: true }).level, 2);
  assert.equal(a({ insideCone: true }).reasons[0].code, 'storm.insideCone');
});

test('storm: TCFA centre within tcfaKm or Yangon inside the corridor', () => {
  const t = (opts) => stormThreat(analysis({ kind: 'tcfa', ...opts }), NOW);
  assert.ok(codes(t({ km: S.prepare.tcfaKm })).includes('storm.tcfaNear'));
  const corridor = t({ km: 700, tcfa: { distanceToLineKm: 40, insideCorridor: true } });
  assert.equal(corridor.level, 2);
  assert.equal(corridor.reasons[0].code, 'storm.tcfaNear');
  assert.equal(t({ km: 700, tcfa: { distanceToLineKm: 400, insideCorridor: false } }).level, 1, 'TCFA within 1000 km -> monitor');
});

test('storm monitor: region, nearby, forecast track, invests', () => {
  const far = (opts) => stormThreat(analysis({ km: 2500, ...opts }), NOW);
  assert.equal(far({}).level, 0);
  assert.equal(far({ inRegion: true }).level, 1);
  assert.equal(far({ inRegion: true }).reasons[0].code, 'storm.inRegion');
  assert.equal(far({ km: S.monitor.nearbyKm }).level, 1);
  assert.equal(far({ km: S.monitor.nearbyKm + EPS }).level, 0);
  assert.equal(far({ kind: 'invest', inRegion: true }).level, 0, 'an invest far away in the region is not enough');
  const inv = (km, potential) => stormThreat(analysis({ kind: 'invest', km, potential, name: 'Invest 92W' }), NOW);
  assert.equal(inv(S.monitor.investKm, 'HIGH').level, 1);
  assert.deepEqual(inv(S.monitor.investKm, 'HIGH').reasons[0].params, { name: 'Invest 92W', km: S.monitor.investKm, potential: 'HIGH' });
  assert.equal(inv(S.monitor.investKm, null).reasons[0].params.potential, 'UNKNOWN');
  assert.equal(inv(S.monitor.investKm + EPS, 'HIGH').level, 0);
  assert.equal(inv(100, 'LOW').level, 1, 'invest centre close: monitor, not prepare');
  const fc = stormThreat(analysis({ km: 2500, samples: [sample(0, 2500, 40, false), sample(96, S.monitor.trackKm, 40)] }), NOW);
  assert.equal(fc.level, 1);
  assert.deepEqual(fc.reasons[0], { code: 'storm.forecastWithin', level: 1, source: 'storm', params: { name: 'Test', km: S.monitor.trackKm } });
});

test('storm: samples older than 1 h are ignored; final warnings still count by position', () => {
  const old = stormThreat(analysis({ km: 2000, samples: [sample(-3, 50, 80, false)] }), NOW);
  assert.equal(old.level, 0);
  const recent = stormThreat(analysis({ km: 2000, samples: [sample(-1, 50, 80, false)] }), NOW);
  assert.equal(recent.level, 3);
  const a = analysis({ km: 120, samples: [sample(0, 120, 30, false)] });
  a.system.final = true;
  assert.equal(stormThreat(a, NOW).level, 2);
  assert.deepEqual(stormThreat(null, NOW), { level: 0, reasons: [] });
  assert.deepEqual(stormThreat({}, NOW), { level: 0, reasons: [] });
});

// ---------------------------------------------------------------------------
// DMH
// ---------------------------------------------------------------------------

test('dmhThreat: stage floors near / far from THRESHOLDS.dmh.stageFloor', () => {
  for (const [stage, [nearLevel, farLevel]] of Object.entries(D.stageFloor)) {
    const near = dmhThreat(dmhStatus({ stage, near: true }));
    const far = dmhThreat(dmhStatus({ stage, near: false, km: 900 }));
    assert.equal(near.level, nearLevel, `${stage} near`);
    assert.equal(far.level, farLevel, `${stage} far`);
    const code = stage === 'green' ? 'dmh.passed' : 'dmh.stage';
    assert.equal(near.reasons[0].code, code);
    assert.equal(near.reasons[0].source, 'dmh');
  }
  const b = dmhThreat(dmhStatus({ stage: 'brown' })).reasons[0];
  assert.deepEqual(b.params, { stage: 'brown', system: 'deep-depression', km: 89, compass: 'ENE', time: new Date('2026-09-28T12:30:00Z') });
  assert.deepEqual(dmhThreat(dmhStatus({ stage: 'green' })).reasons[0].params, { system: 'deep-depression', time: new Date('2026-09-28T12:30:00Z') });
  assert.equal(dmhThreat(dmhStatus({ stage: 'red', km: null })).reasons[0].code, 'dmh.stageNoPos');
});

test('dmhThreat: news, warnings without a stage, stale bulletins', () => {
  const news = dmhThreat(dmhStatus({ kind: 'news', stage: null, near: false }));
  assert.equal(news.level, D.newsFloor);
  assert.deepEqual(news.reasons[0].params, { system: 'deep-depression', time: new Date('2026-09-28T12:30:00Z') });
  const warn = dmhThreat(dmhStatus({ kind: 'warning', stage: null, near: true, system: null }));
  assert.equal(warn.level, D.stageFloor.orange[0]);
  assert.equal(warn.reasons[0].code, 'dmh.warning');
  assert.equal(warn.reasons[0].params.system, 'unknown');
  assert.equal(dmhThreat(dmhStatus({ stage: 'brown', isCurrent: false })).level, 0);
  assert.equal(dmhThreat(dmhStatus({ stage: 'brown' }), new Date('2026-09-29T13:30:00Z')).level, 0, '25 h later');
  assert.equal(dmhThreat(dmhStatus({ stage: 'brown' }), new Date('2026-09-29T12:30:00Z')).level, 3, 'exactly 24 h');
  assert.deepEqual(dmhThreat(null), { level: 0, reasons: [] });
  assert.deepEqual(dmhThreat({ available: false }), { level: 0, reasons: [] });
});

test('dmhThreat: other DMH warnings that name Yangon, recent and not nil', () => {
  const w = (o) => ({ type: 'flood', isCurrent: true, mentionsYangon: true, isNil: false, issuedAtDate: new Date('2026-09-28T05:30:00Z'), title: { en: 'Flood Bulletin', my: 'x' }, ...o });
  const run = (list) => dmhThreat({ ...dmhStatus(), bulletin: null, otherWarnings: list });
  const r = run([w(), w({ issuedAtDate: new Date('2026-09-28T02:00:00Z') }), w({ type: 'heavy-rain' })]);
  assert.equal(r.level, D.otherWarningFloor);
  assert.equal(r.reasons.length, 2, 'one reason per warning type');
  assert.deepEqual(r.reasons[0].params, { title: { en: 'Flood Bulletin', my: 'x' }, type: 'flood', time: new Date('2026-09-28T05:30:00Z') });
  assert.equal(run([w({ isNil: true })]).level, 0);
  assert.equal(run([w({ mentionsYangon: false })]).level, 0);
  assert.equal(run([w({ isCurrent: false })]).level, 0);
});

// ---------------------------------------------------------------------------
// assessRisk
// ---------------------------------------------------------------------------

test('assessRisk: final level is the max over all sources; reasons sorted by level', () => {
  const r = assessRisk({
    systems: [analysis({ km: 250, kind: 'tcfa', samples: [sample(0, 250, 30, false)] })],
    dmh: dmhStatus({ kind: 'news', stage: null }),
    weather: weatherWith({ maxGust: W.danger.gustKmh }),
    now: NOW,
  });
  assert.equal(r.level, 3);
  assert.deepEqual(r.reasons.map((x) => x.level), [...r.reasons.map((x) => x.level)].sort((a, b) => b - a));
  assert.equal(r.reasons[0].code, 'weather.gust');
  assert.ok(codes(r).includes('dmh.news') && codes(r).includes('storm.currentNear'));
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.generatedAt, NOW);
  // Model winds never lower what a storm set.
  const low = assessRisk({ systems: [analysis({ km: 100, samples: [sample(0, 100, 50, false)] })], dmh: dmhStatus({ stage: 'yellow', near: false }), weather: CALM_WEATHER, now: NOW });
  assert.equal(low.level, 3);
});

test('assessRisk: calm only with every source present and quiet', () => {
  const r = assessRisk({ systems: [], dmh: { ...dmhStatus(), bulletin: null }, weather: CALM_WEATHER, now: NOW });
  assert.equal(r.level, 0);
  assert.deepEqual(codes(r), ['calm']);
});

test('assessRisk: unknown rule and gaps', () => {
  const unknown = assessRisk({ systems: null, dmh: null, weather: CALM_WEATHER, now: NOW });
  assert.equal(unknown.level, null);
  assert.equal(unknown.reasons[0].code, 'unknown');
  assert.deepEqual(unknown.gaps, ['dmh', 'storms']);

  const stale = assessRisk({ systems: null, dmh: { ...dmhStatus(), bulletin: null, checkStale: true }, weather: null, now: NOW });
  assert.equal(stale.level, null);
  assert.deepEqual(stale.gaps, ['dmh', 'storms', 'weather']);

  const monitorOnly = assessRisk({ systems: null, dmh: null, weather: weatherWith({ maxRainHour: W.monitor.rainHourMm }), now: NOW });
  assert.equal(monitorOnly.level, null, 'level 1 is not enough to override unknown');
  assert.deepEqual(codes(monitorOnly), ['unknown', 'weather.rainHour']);

  const prepare = assessRisk({ systems: null, dmh: null, weather: weatherWith({ maxGust: W.prepare.gustKmh }), now: NOW });
  assert.equal(prepare.level, 2, 'Prepare+ is shown even when sources are missing');
  assert.ok(!codes(prepare).includes('unknown'));

  const dmhOk = assessRisk({ systems: null, dmh: { ...dmhStatus(), bulletin: null }, weather: CALM_WEATHER, now: NOW, gaps: ['gdacs', 'jtwc'] });
  assert.equal(dmhOk.level, 0, 'fresh DMH check covers missing storm feeds');
  assert.deepEqual(dmhOk.gaps, ['storms', 'gdacs', 'jtwc']);

  const stormsOk = assessRisk({ systems: [], dmh: null, weather: CALM_WEATHER, now: NOW });
  assert.equal(stormsOk.level, 0, 'GDACS + JTWC both fine');
  assert.deepEqual(stormsOk.gaps, ['dmh']);
});

test('regression: GDACS-only data on 28 Sep never says Calm when DMH and JTWC are unavailable', () => {
  // GDACS listed nothing for the Bay of Bengal that day.
  const r = assessRisk({ systems: [], dmh: null, weather: CALM_WEATHER, now: NOW, gaps: ['jtwc'] });
  assert.equal(r.level, null);
  assert.equal(r.reasons[0].code, 'unknown');
  assert.deepEqual(r.gaps, ['dmh', 'jtwc']);
});

test('assessRisk: override floor and expiry', () => {
  const base = { systems: [], dmh: { ...dmhStatus(), bulletin: null }, weather: CALM_WEATHER, now: NOW };
  const msg = { en: 'DMH warning for Yangon', my: 'မိုးဇလ' };
  const on = assessRisk({ ...base, override: { enabled: true, minLevel: 2, expires: new Date('2026-09-29T00:00:00Z'), message: msg } });
  assert.equal(on.level, 2);
  assert.deepEqual(on.reasons[0], { code: 'override', level: 2, source: 'override', params: { message: msg } });
  const expired = assessRisk({ ...base, override: { enabled: true, minLevel: 3, expires: new Date('2026-09-28T14:00:00Z'), message: msg } });
  assert.equal(expired.level, 0);
  assert.ok(!codes(expired).includes('override'));
  const isoExpiry = assessRisk({ ...base, override: { enabled: true, minLevel: 3, expires: '2026-09-28T14:00:00Z', message: msg } });
  assert.equal(isoExpiry.level, 0);
  assert.equal(assessRisk({ ...base, override: { enabled: false, minLevel: 3, expires: null, message: msg } }).level, 0);
  // An override never lowers the level.
  const high = assessRisk({ ...base, weather: weatherWith({ maxGust: W.danger.gustKmh }), override: { enabled: true, minLevel: 1, expires: null, message: msg } });
  assert.equal(high.level, 3);
  // Through evaluateOverride (as main.js does).
  const ov = evaluateOverride({ enabled: true, minLevel: 3, expires: '2026-09-28T16:00:00Z', message: msg }, NOW);
  assert.equal(assessRisk({ ...base, override: ov }).level, 3);
  assert.equal(assessRisk({ ...base, override: ov, now: new Date('2026-09-28T16:00:01Z') }).level, 0, 'expires even if evaluated earlier');
});

test('regression 28 Sep 2026: DMH brown stage near Yangon => Danger even with calm weather and no storms', () => {
  const json = JSON.parse(JSON.stringify(buildDmhJson({
    rssEn: fx('dmh/rss_en.xml'), rssMy: fx('dmh/rss_my.xml'), homeEn: fx('dmh/home_en.html'), homeMy: fx('dmh/home_my.html'),
    cycloneNewsEn: fx('dmh/cyclone-news_en.html'), now: NOW,
  })));
  const raw = JSON.parse(fx('openmeteo/yangon_2026-09-28.json'));
  const weather = normalizeWeather(raw, NOW);
  const dmh = evaluateDmh(json, HOME, NOW);
  const r = assessRisk({ systems: [], dmh, weather, override: evaluateOverride(JSON.parse(readFileSync(join(ROOT, 'data/override.json'), 'utf8')), NOW), now: NOW });
  assert.equal(r.level, 3);
  const top = r.reasons[0];
  assert.equal(top.code, 'dmh.stage');
  assert.equal(top.level, 3);
  assert.equal(top.params.stage, 'brown');
  assert.equal(top.params.system, 'deep-depression');
  assert.equal(top.params.compass, 'ENE');
  assert.ok(top.params.km > 85 && top.params.km < 95);
  assert.deepEqual(top.params.time, new Date('2026-09-28T12:30:00Z'));
  assert.deepEqual(r.gaps, []);

  // Even if the storm feeds failed and the DMH check went stale, the current bulletin still counts.
  const later = new Date('2026-09-28T19:00:00Z');
  const staleDmh = evaluateDmh(json, HOME, later);
  assert.equal(staleDmh.checkStale, true);
  const r2 = assessRisk({ systems: null, dmh: staleDmh, weather, now: later });
  assert.equal(r2.level, 3);
  assert.deepEqual(r2.gaps, ['dmh', 'storms']);

  // 25 h after issue, with nothing else: not Danger any more.
  const dayLater = new Date('2026-09-29T13:30:00Z');
  const r3 = assessRisk({ systems: [], dmh: evaluateDmh({ ...json, checkedAt: dayLater.toISOString() }, HOME, dayLater), weather, now: dayLater });
  assert.equal(r3.level, 0);
});

// ---------------------------------------------------------------------------
// English strings cover everything risk.js can emit
// ---------------------------------------------------------------------------

test('js/i18n/en/core.js has a template for every reason, with matching placeholders', async () => {
  const { default: en } = await import('../js/i18n/en/core.js');
  const { IMD_CLASSES, DMH_STAGES, SEASON_BY_MONTH, LEVELS, UNKNOWN_LEVEL } = await import('../js/config.js');
  const reasons = [];
  const collect = (r) => reasons.push(...r.reasons);
  collect(assessRisk({ systems: null, dmh: null, weather: null, now: NOW }));
  collect(assessRisk({ systems: [], dmh: { ...dmhStatus(), bulletin: null }, weather: CALM_WEATHER, now: NOW }));
  for (const stage of Object.keys(D.stageFloor)) collect(dmhThreat(dmhStatus({ stage })));
  collect(dmhThreat(dmhStatus({ stage: 'red', km: null })));
  collect(dmhThreat(dmhStatus({ kind: 'news' })));
  collect(dmhThreat(dmhStatus({ kind: 'warning' })));
  collect(dmhThreat({ ...dmhStatus(), bulletin: null, otherWarnings: [{ type: 'flood', isCurrent: true, mentionsYangon: true, isNil: false, issuedAtDate: NOW, title: { en: 'x', my: 'y' } }] }));
  collect(stormThreat(analysis({ km: 100, insideWindKmh: 120, insideCone: true, inRegion: true, samples: [sample(0, 100, 70, false), sample(12, 50, 70)] }), NOW));
  collect(stormThreat(analysis({ kind: 'tcfa', km: 200, inRegion: true }), NOW));
  collect(stormThreat(analysis({ kind: 'invest', km: 200 }), NOW));
  collect(stormThreat(analysis({ km: 2500, samples: [sample(0, 2500, 40, false), sample(96, 500, 40)] }), NOW));
  collect(weatherThreat(weatherWith({ maxGust: 99, maxWind: 99, maxRain24h: 999, maxRain48h: 999, maxRain72h: 999, maxRainHour: 99 })));
  collect(weatherThreat(weatherWith({ maxRain72h: W.monitor.rain72hMm })));
  collect(assessRisk({ systems: [], dmh: null, weather: CALM_WEATHER, override: { enabled: true, minLevel: 1, expires: null, message: { en: 'm', my: 'm' } }, now: NOW }));

  const seen = new Set();
  for (const r of reasons) {
    const key = `reason.${r.code}`;
    assert.equal(typeof en[key], 'string', `missing ${key}`);
    for (const [, name] of en[key].matchAll(/\{(\w+)\}/g)) assert.ok(name in r.params, `${key} uses {${name}} but ${r.code} has no such param`);
    seen.add(r.code);
  }
  for (const code of ['dmh.stage', 'dmh.stageNoPos', 'dmh.warning', 'dmh.news', 'dmh.passed', 'dmh.otherWarning', 'storm.insideWind', 'storm.insideCone',
    'storm.trackNear', 'storm.currentNear', 'storm.tcfaNear', 'storm.hurricaneNear', 'storm.inRegion', 'storm.forecastWithin', 'storm.invest',
    'weather.gust', 'weather.wind', 'weather.rain24h', 'weather.rain48h', 'weather.rain72h', 'weather.rainHour', 'override', 'calm', 'unknown']) {
    assert.ok(seen.has(code), `scenario for ${code}`);
  }
  for (const l of [...LEVELS, UNKNOWN_LEVEL]) for (const part of ['name', 'headline', 'advice']) assert.ok(en[`level.${l.key}.${part}`], `level.${l.key}.${part}`);
  for (const c of IMD_CLASSES) assert.ok(en[c.key], c.key);
  for (const s of Object.values(DMH_STAGES)) assert.ok(en[s.key] && en[`${s.key}.meaning`], s.key);
  for (const k of new Set(SEASON_BY_MONTH)) assert.ok(en[k], k);
  for (const d of ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']) assert.match(en[`dir.${d}`], /^[a-z-]+$/);
  for (const s of ['low', 'well-marked-low', 'depression', 'deep-depression', 'cs', 'scs', 'vscs', 'escs', 'sucs', 'unknown']) assert.ok(en[`dmh.system.${s}`], s);
  for (const k of ['jtwc.TD', 'jtwc.TS', 'jtwc.HU', 'jtwc.kind.warning', 'jtwc.kind.tcfa', 'jtwc.kind.invest', 'jtwc.potential.LOW', 'jtwc.potential.MEDIUM', 'jtwc.potential.HIGH', 'jtwc.potential.UNKNOWN',
    'dmh.kind.warning', 'dmh.kind.news', 'unit.kmh', 'unit.mph', 'unit.km', 'unit.mi', 'unit.mm', 'unit.in', 'unit.hpa', 'unit.kt', 'unit.c']) {
    assert.ok(en[k], k);
  }
  assert.ok(Object.values(en).every((v) => typeof v === 'string' && v.trim() === v && v.length > 0));
});
