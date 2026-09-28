// The "Share summary" text is what the family abroad forwards: it must carry
// the same caveats as the page (data age, sources not checked, a stale DMH check).

import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const i18n = await import('../js/i18n.js');
const { buildShareText } = await import('../js/ui/status.js');
const { assessRisk } = await import('../js/risk.js');
const { evaluateDmh } = await import('../js/dmh.js');

i18n.initI18n({ navigatorLanguages: ['en-GB'], dev: false });
i18n.setLang('en');

const NOW = new Date('2026-09-29T02:06:00Z');
const weather = { current: { temperature: 25, windSpeed: 14, windGusts: 27 }, derived: { next72h: {} } };

test('share text: a DMH check 8 h old is not "no current cyclone bulletin", and the gaps are listed', () => {
  const dmh = evaluateDmh({ schema: 1, checkedAt: new Date(NOW - 8 * 3600e3).toISOString(), ok: true, cyclone: null, recentCyclone: [] }, undefined, NOW);
  assert.equal(dmh.checkStale, true);
  const risk = assessRisk({ systems: [], dmh, weather, now: NOW });
  const text = buildShareText(risk, [], dmh, weather, 'en', { now: NOW, dataTime: new Date(NOW - 8 * 3600e3), dmhFetchState: 'cached', weatherStale: true });
  assert.doesNotMatch(text, /no current cyclone bulletin/);
  assert.match(text, /not checked since .*8 hours ago/);
  assert.match(text, /Could not check: DMH bulletins/);
  assert.match(text, /Information from .*8 hours ago/);
  assert.doesNotMatch(text, /Yangon now:/, 'an old forecast is not "now"');
});

test('share text: a fresh quiet check still says so plainly', () => {
  const dmh = evaluateDmh({ schema: 1, checkedAt: new Date(NOW - 10 * 60e3).toISOString(), ok: true, cyclone: null, recentCyclone: [] }, undefined, NOW);
  const risk = assessRisk({ systems: [], dmh, weather, now: NOW });
  const text = buildShareText(risk, [], dmh, weather, 'en', { now: NOW, dataTime: new Date(NOW - 60e3), dmhFetchState: 'ok', weatherStale: false });
  assert.match(text, /Official DMH: no current cyclone bulletin\./);
  assert.doesNotMatch(text, /Could not check|Information from/);
  assert.match(text, /Yangon now: /);
});

test('"How this works" table is built from THRESHOLDS (DMH distance bands, wind-area hours)', async () => {
  const { levelRules } = await import('../js/ui/about.js');
  const rows = levelRules();
  const text = (level) => rows.find((r) => r.level === level).rules.join(' | ');
  assert.match(text(3), /Brown.*within 300 km.*200 km/);
  assert.match(text(3), /within the next 48 hours/);
  assert.match(text(2), /Brown.*further away/);
  assert.match(text(2), /alert area could not be read/);
  assert.match(text(0), /DMH was checked in the last 3 hours/);
  for (const r of rows) for (const rule of r.rules) assert.doesNotMatch(rule, /[{}]/);
});
