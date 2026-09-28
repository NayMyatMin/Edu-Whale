import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateDmh, evaluateOverride, fetchDmhJson, fetchOverride } from '../js/dmh.js';
import { HOME, STALE_AFTER_MS, THRESHOLDS } from '../js/config.js';
import { buildDmhJson } from '../scripts/lib/dmh-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fx = (name) => readFileSync(join(ROOT, 'tests/fixtures/dmh', name), 'utf8');
const CHECKED = new Date('2026-09-28T15:00:00Z');
const ISSUED = new Date('2026-09-28T12:30:00Z');

/** data/dmh.json exactly as the fetcher writes it (JSON round trip). */
function fixtureJson() {
  const j = buildDmhJson({
    rssEn: fx('rss_en.xml'), rssMy: fx('rss_my.xml'), homeEn: fx('home_en.html'), homeMy: fx('home_my.html'), cycloneNewsEn: fx('cyclone-news_en.html'), now: CHECKED,
  });
  return JSON.parse(JSON.stringify(j));
}

test("evaluateDmh on today's data: brown-stage bulletin ~89 km ENE, near, current", () => {
  const s = evaluateDmh(fixtureJson(), HOME, CHECKED);
  assert.equal(s.available, true);
  assert.equal(s.ok, true);
  assert.equal(s.checkStale, false);
  assert.deepEqual(s.checkedAt, CHECKED);
  const b = s.bulletin;
  assert.equal(b.stage, 'brown');
  assert.equal(b.kind, 'warning');
  assert.deepEqual(b.issuedAtDate, ISSUED);
  assert.equal(b.isCurrent, true);
  assert.ok(b.distanceKm > 85 && b.distanceKm < 95, `distance ${b.distanceKm}`);
  assert.ok(b.bearingFromHome > 56 && b.bearingFromHome < 79, `bearing ${b.bearingFromHome}`);
  assert.equal(b.compassFromHome, 'ENE');
  assert.equal(b.near, true);
  assert.match(b.summary.en, /brown stage/);
  assert.equal(s.recent.length, 6);
  assert.ok(s.recent.every((r) => r.issuedAtDate instanceof Date && r.summary === undefined));
  assert.equal(s.recent[1].stage, 'red');
  assert.ok(s.announcement.issuedAtDate instanceof Date);
  assert.equal(s.otherWarnings.length, 3);
  assert.ok(s.otherWarnings.every((w) => w.issuedAtDate instanceof Date && typeof w.isCurrent === 'boolean'));
});

test('bulletin is current up to THRESHOLDS.dmh.currentHours, not 25 h later', () => {
  const json = fixtureJson();
  const at = (h) => new Date(ISSUED.getTime() + h * 3600e3);
  assert.equal(evaluateDmh(json, HOME, at(THRESHOLDS.dmh.currentHours)).bulletin.isCurrent, true);
  assert.equal(evaluateDmh(json, HOME, at(25)).bulletin.isCurrent, false);
  // A post date far in the future is a typo: counted from when our check saw
  // it, never silently dropped, and flagged so the page cannot say Calm.
  const future = { ...json, cyclone: { ...json.cyclone, issuedAt: '2027-09-28T12:30:00Z' } };
  const s = evaluateDmh(future, HOME, CHECKED);
  assert.equal(s.bulletin.isCurrent, true);
  assert.equal(s.bulletin.dateSuspect, true);
  assert.equal(s.dateSuspect, true);
  assert.deepEqual(s.bulletin.effectiveIssuedDate, CHECKED);
  assert.equal(evaluateDmh(future, HOME, new Date(CHECKED.getTime() + 25 * 3600e3)).bulletin.isCurrent, false, 'a day after our check');
});

test('checkStale follows STALE_AFTER_MS.dmhCheck', () => {
  const json = fixtureJson();
  const limit = STALE_AFTER_MS.dmhCheck;
  assert.equal(evaluateDmh(json, HOME, new Date(CHECKED.getTime() + limit)).checkStale, false);
  assert.equal(evaluateDmh(json, HOME, new Date(CHECKED.getTime() + limit + 1)).checkStale, true);
  const failed = { ...json, ok: false, errors: ['rssEn: timeout'] };
  const s = evaluateDmh(failed, HOME, new Date(CHECKED.getTime() + limit + 60e3));
  assert.equal(s.available, true, 'old content is still shown');
  assert.equal(s.ok, false);
  assert.equal(s.checkStale, true);
  assert.deepEqual(s.errors, ['rssEn: timeout']);
});

test('near: within nearKm, or DMH names Yangon', () => {
  const json = fixtureJson();
  const far = { ...json, cyclone: { ...json.cyclone, lat: 20.1, lon: 92.9, mentionsYangon: false } }; // Sittwe, ~510 km
  const s = evaluateDmh(far, HOME, CHECKED);
  assert.ok(s.bulletin.distanceKm > THRESHOLDS.dmh.nearKm);
  assert.equal(s.bulletin.near, false);
  far.cyclone.mentionsYangon = true;
  assert.equal(evaluateDmh(far, HOME, CHECKED).bulletin.near, true);
  const noPos = { ...json, cyclone: { ...json.cyclone, lat: null, lon: 97, mentionsYangon: false } };
  const n = evaluateDmh(noPos, HOME, CHECKED).bulletin;
  assert.equal(n.distanceKm, null);
  assert.equal(n.compassFromHome, null);
  assert.equal(n.near, false);
});

test('garbage input never throws and is never "available"', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { checkedAt: 'nope' }, { cyclone: 'x', recentCyclone: 'y', otherWarnings: {} }]) {
    const s = evaluateDmh(bad, HOME, CHECKED);
    assert.equal(s.available, false, JSON.stringify(bad));
    assert.equal(s.checkStale, true);
    assert.equal(s.bulletin, null);
    assert.deepEqual(s.recent, []);
    assert.deepEqual(s.otherWarnings, []);
  }
  const s = evaluateDmh({
    checkedAt: CHECKED.toISOString(),
    cyclone: { issuedAt: 'garbage', stage: 'brown' },
    recentCyclone: [null, 5, { issuedAt: ISSUED.toISOString(), stage: 'purple', lat: 999, lon: 97, windMph: 'fast', title: 7 }],
    otherWarnings: [{ issuedAt: 'x' }, { type: 'bogus', issuedAt: ISSUED.toISOString(), url: { en: 'javascript:alert(1)', my: 'https://www.moezala.gov.mm/my/bulletin/1' } }],
    announcement: { text: { en: 5 } },
  }, HOME, CHECKED);
  assert.equal(s.available, true);
  assert.equal(s.bulletin, null, 'unparseable issuedAt');
  assert.equal(s.recent.length, 1);
  assert.equal(s.recent[0].stage, null);
  assert.equal(s.recent[0].lat, null);
  assert.equal(s.recent[0].distanceKm, null);
  assert.equal(s.recent[0].windMph, null);
  assert.deepEqual(s.recent[0].title, { en: '', my: '' });
  assert.equal(s.otherWarnings.length, 1);
  assert.equal(s.otherWarnings[0].type, 'other');
  assert.equal(s.otherWarnings[0].url.en, null, 'javascript: URL dropped');
  assert.equal(s.announcement, null);
});

test('evaluateOverride: enabled, level range, expiry', () => {
  const now = new Date('2026-09-28T15:00:00Z');
  const base = { enabled: true, minLevel: 2, expires: null, message: { en: 'Follow DMH.', my: 'မိုးဇလ' } };
  assert.deepEqual(evaluateOverride(base, now), { enabled: true, minLevel: 2, expires: null, message: { en: 'Follow DMH.', my: 'မိုးဇလ' } });
  assert.equal(evaluateOverride({ ...base, enabled: false }, now), null);
  assert.equal(evaluateOverride({ ...base, enabled: 'true' }, now), null);
  assert.equal(evaluateOverride({ ...base, minLevel: 4 }, now), null);
  assert.equal(evaluateOverride({ ...base, minLevel: '3' }, now), null);
  assert.equal(evaluateOverride({ ...base, expires: '2026-09-28T14:59:59Z' }, now), null, 'expired');
  assert.equal(evaluateOverride({ ...base, expires: 'next week' }, now), null, 'unreadable expiry');
  const future = evaluateOverride({ ...base, expires: '2026-10-01T09:00:00+06:30' }, now);
  assert.deepEqual(future.expires, new Date('2026-10-01T02:30:00Z'));
  assert.deepEqual(evaluateOverride({ ...base, message: null }, now).message, { en: '', my: '' });
  for (const bad of [null, 'x', [], {}]) assert.equal(evaluateOverride(bad, now), null);
});

test('the committed data/override.json is valid and disabled', () => {
  const json = JSON.parse(readFileSync(join(ROOT, 'data/override.json'), 'utf8'));
  assert.equal(json.enabled, false);
  assert.ok(Number.isInteger(json.minLevel));
  assert.ok(json.message.en && json.message.my);
  assert.equal(evaluateOverride(json, new Date()), null);
  assert.equal(evaluateOverride({ ...json, enabled: true }, new Date()).minLevel, json.minLevel);
});

test('fetchDmhJson / fetchOverride: cache-busted same-origin URL, 404 -> null, other errors reject', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  const calls = [];
  let status = 200;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(status === 200 ? '{"schema":1}' : 'nope', { status });
  };
  const now = Date.parse('2026-09-28T15:07:00Z');
  assert.deepEqual(await fetchDmhJson({ now }), { schema: 1 });
  assert.equal(calls[0], `data/dmh.json?t=${Math.floor(now / 300000)}`);
  assert.deepEqual(await fetchOverride({ now }), { schema: 1 });
  assert.match(calls[1], /^data\/override\.json\?t=\d+$/);
  status = 404;
  assert.equal(await fetchDmhJson({ now }), null);
  assert.equal(await fetchOverride({ now }), null);
  status = 500;
  await assert.rejects(fetchDmhJson({ now }), /HTTP 500/);
});
