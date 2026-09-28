import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// A tiny in-memory localStorage (installed before i18n.js reads preferences).
class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
globalThis.localStorage = new MemoryStorage();

const i18n = await import('../js/i18n.js');
const en = (await import('../js/i18n/en/index.js')).default;
const my = (await import('../js/i18n/my/index.js')).default;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ISSUED = new Date('2026-09-28T12:30:00Z'); // 19:00 in Yangon (UTC+06:30)

function reset() {
  globalThis.localStorage.clear();
  i18n.initI18n({ navigatorLanguages: ['en-GB'], dev: false });
  i18n.setLang('en');
  i18n.setUnits('metric');
}

test('language default: saved choice, else a Burmese browser, else English', () => {
  globalThis.localStorage.clear();
  assert.equal(i18n.initI18n({ navigatorLanguages: ['en-US'], dev: false }), 'en');
  assert.equal(i18n.initI18n({ navigatorLanguages: ['my-MM'], dev: false }), 'my');
  assert.equal(i18n.initI18n({ navigatorLanguages: ['my'], dev: false }), 'my');
  assert.equal(i18n.initI18n({ navigatorLanguages: ['mya'], dev: false }), 'en', 'only the "my" code counts');
  globalThis.localStorage.setItem('ysw.lang', 'en');
  assert.equal(i18n.initI18n({ navigatorLanguages: ['my-MM'], dev: false }), 'en', 'saved choice wins');
  reset();
});

test('setLang persists, notifies once and ignores unknown codes', () => {
  reset();
  const seen = [];
  const off = i18n.onLangChange((l) => seen.push(l));
  i18n.setLang('my');
  i18n.setLang('my');
  i18n.setLang('fr');
  off();
  i18n.setLang('en');
  assert.deepEqual(seen, ['my']);
  assert.equal(globalThis.localStorage.getItem('ysw.lang'), 'en');
});

test('t(): current language, English fallback, then the key', () => {
  reset();
  assert.equal(i18n.t('status.levelName.danger'), 'Danger — act now');
  i18n.setLang('my');
  // Burmese dictionaries are placeholders for now: English shows instead.
  assert.equal(i18n.t('status.levelName.danger'), 'Danger — act now');
  assert.equal(i18n.t('no.such.key'), 'no.such.key');
  i18n.setLang('en');
  assert.equal(i18n.t('check.progress', { done: 5, total: 20 }), '5 of 20 done');
});

test('Burmese uses Burmese digits (Intl locale "my")', () => {
  reset();
  i18n.setLang('my');
  assert.equal(i18n.formatNumber(1234), '၁,၂၃၄');
  assert.equal(i18n.formatTime(ISSUED), '၁၉:၀၀');
  assert.match(i18n.formatDistance(89.4), /^၈၉ /);
  assert.equal(i18n.formatHour(ISSUED), '၁၉');
  // Day/month names come from the dictionary (Chrome has no ICU data for 'my'),
  // so they fall back to English until translated — but the digits are Burmese.
  assert.match(i18n.formatDay(ISSUED), /၂၈/);
  assert.match(i18n.formatRelative(new Date(ISSUED - 4 * 60e3), ISSUED), /၄/);
  assert.match(i18n.formatWhen(ISSUED, ISSUED), /၁၉:၀၀/);
  i18n.setLang('en');
  assert.equal(i18n.formatDay(ISSUED, { weekdayOnly: true }), 'Mon');
  assert.equal(i18n.formatDay(ISSUED, { long: true }), 'Monday 28 September');
  assert.equal(i18n.formatRelative(new Date(ISSUED - 60e3), ISSUED), '1 minute ago');
  assert.equal(i18n.formatHour(ISSUED), '19');
});

test('times are always Yangon time, whatever the viewer zone', () => {
  reset();
  assert.equal(i18n.formatTime(ISSUED), '19:00');
  assert.equal(i18n.formatDay(ISSUED), 'Mon 28 Sep');
  assert.equal(i18n.formatDateTime(ISSUED), 'Mon 28 Sep, 19:00');
  assert.equal(i18n.yangonDateKey(new Date('2026-09-28T17:29:00Z')), '2026-09-28');
  assert.equal(i18n.yangonDateKey(new Date('2026-09-28T17:30:00Z')), '2026-09-29', 'Yangon midnight is 17:30 UTC');
  const now = new Date('2026-09-28T15:00:00Z'); // 21:30 Yangon
  assert.equal(i18n.formatWhen(ISSUED, now), 'today 19:00');
  assert.equal(i18n.formatWhen(new Date('2026-09-28T22:30:00Z'), now), 'tomorrow 05:00');
  assert.equal(i18n.formatWhen(new Date('2026-09-27T12:30:00Z'), now), 'yesterday 19:00');
  assert.equal(i18n.formatWhen(new Date('2026-10-01T02:30:00Z'), now), 'Thu 1 Oct 09:00');
});

test('relative times', () => {
  reset();
  const now = new Date('2026-09-28T15:00:00Z');
  assert.equal(i18n.formatRelative(new Date(now - 20e3), now), 'just now');
  assert.equal(i18n.formatRelative(new Date(now - 4 * 60e3), now), '4 minutes ago');
  assert.equal(i18n.formatRelative(new Date(now - 3 * 3600e3), now), '3 hours ago');
  assert.equal(i18n.formatRelative(new Date(now.getTime() + 2 * 3600e3), now), 'in 2 hours');
  assert.equal(i18n.formatRelative(new Date(now - 5 * 86400e3), now), '5 days ago');
});

test('units: metric ⇄ imperial, persisted, storm winds show both', () => {
  reset();
  assert.equal(i18n.formatWind(62), '62 km/h');
  assert.equal(i18n.formatWind(62, { alt: true }), '62 km/h (39 mph)');
  assert.equal(i18n.formatWindKt(34), '63 km/h (39 mph)');
  assert.equal(i18n.formatDistance(89.4), '89 km');
  assert.equal(i18n.formatDistance(854), '850 km', 'rounded to 10 above 100');
  assert.equal(i18n.formatRain(7.46), '7.5 mm');
  assert.equal(i18n.formatRain(115.6), '116 mm');
  const seen = [];
  i18n.onUnitsChange((u) => seen.push(u));
  i18n.setUnits('imperial');
  assert.deepEqual(seen, ['imperial']);
  assert.equal(globalThis.localStorage.getItem('ysw.units'), 'imperial');
  assert.equal(i18n.formatWind(100, { alt: true }), '62 mph (100 km/h)');
  assert.equal(i18n.formatDistance(160.9), '100 mi');
  assert.equal(i18n.formatRain(25.4), '1 in');
  assert.equal(i18n.formatRain(12.7), '0.5 in');
  assert.equal(i18n.formatTemp(25.4), '25°C');
  assert.equal(i18n.formatWind(null), '–');
  i18n.setUnits('metric');
});

test('tReason formats params by name (km, kmh, mm, time, compass, stage, system, cls, potential, title)', () => {
  reset();
  const dmh = i18n.tReason({ code: 'dmh.stage', level: 3, source: 'dmh', params: { stage: 'brown', system: 'deep-depression', km: 89.4, compass: 'ENE', time: ISSUED } });
  assert.match(dmh, /Deep depression/);
  assert.match(dmh, /Brown stage/);
  assert.match(dmh, /89 km east-northeast of Yangon/);
  assert.match(dmh, /19:00/);
  const gust = i18n.tReason({ code: 'weather.gust', level: 3, source: 'weather', params: { kmh: 94.9, time: ISSUED } });
  assert.match(gust, /95 km\/h \(59 mph\)/);
  const invest = i18n.tReason({ code: 'storm.invest', level: 1, source: 'storm', params: { name: 'Invest 92W', km: 335, potential: 'HIGH' } });
  assert.match(invest, /Invest 92W/);
  assert.match(invest, /340 km/);
  assert.match(invest, /high/);
  const track = i18n.tReason({ code: 'storm.trackNear', level: 3, source: 'storm', params: { name: 'Demo', km: 102, hours: 36.2, cls: 'imd.scs' } });
  assert.match(track, /Severe cyclonic storm/);
  assert.match(track, /36 hours/);
  const other = i18n.tReason({ code: 'dmh.otherWarning', level: 1, source: 'dmh', params: { title: { en: 'Heavy Rainfall Warning', my: '' }, time: ISSUED } });
  assert.match(other, /Heavy Rainfall Warning/);
  // A missing param leaves no stray gap.
  const noCompass = i18n.tReason({ code: 'storm.currentNear', level: 2, source: 'storm', params: { name: 'X', km: 120, compass: null } });
  assert.doesNotMatch(noCompass, /\s{2}|\{/);
  assert.equal(i18n.tReason({ code: 'no.such.code', params: {} }), '');
  assert.equal(i18n.tReason(null), '');
});

test('withLang() switches temporarily without notifying or persisting', () => {
  reset();
  let calls = 0;
  const off = i18n.onLangChange(() => calls++);
  const inside = i18n.withLang('my', () => i18n.formatNumber(5));
  off();
  assert.equal(inside, '၅');
  assert.equal(i18n.getLang(), 'en');
  assert.equal(calls, 0);
});

test('dictionaries: English complete for every reason code risk.js can emit', () => {
  const src = readFileSync(join(ROOT, 'js/risk.js'), 'utf8');
  const codes = new Set([...src.matchAll(/reason\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
  assert.ok(codes.size >= 15, `found ${codes.size} codes`);
  for (const code of codes) assert.ok(Object.hasOwn(en, `reason.${code}`), `missing reason.${code}`);
});

test('dictionaries: every literal key the page uses exists in English', () => {
  const files = ['js/main.js', 'js/charts.js', ...readdirSync(join(ROOT, 'js/ui')).map((f) => `js/ui/${f}`)];
  const missing = [];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\b(?:t|tFormat)\(\s*'([a-zA-Z0-9_.-]+)'/g)) if (!Object.hasOwn(en, m[1])) missing.push(`${f}: ${m[1]}`);
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) if (!Object.hasOwn(en, m[1])) missing.push(`index.html: ${m[1]}`);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const part of m[1].split(';')) {
      const key = part.split(':')[1];
      if (key && !Object.hasOwn(en, key)) missing.push(`index.html attr: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('dictionaries: keys built at runtime exist (levels, stages, checklist, contacts, sources, wmo, demo)', async () => {
  const config = await import('../js/config.js');
  const keys = [
    ...['calm', 'monitor', 'prepare', 'danger', 'unknown'].flatMap((k) => [`status.levelName.${k}`, `level.${k}.headline`, `level.${k}.advice`]),
    ...Object.values(config.DMH_STAGES).flatMap((s) => [s.key, `${s.key}.meaning`]),
    ...config.CHECKLIST.flatMap((g) => [`check.group.${g.group}`, ...g.ids.map((id) => `check.${id}`)]),
    ...config.EMERGENCY_CONTACTS.flatMap((c) => [c.key, c.noteKey].filter(Boolean)),
    ...config.OFFICIAL_SOURCES.flatMap((s) => [s.key, s.noteKey].filter(Boolean)),
    ...config.IMD_CLASSES.map((c) => c.key),
    ...new Set(config.SEASON_BY_MONTH),
    ...['dmh', 'storms', 'gdacs', 'jtwc', 'weather'].map((g) => `gap.${g}`),
    ...['calm', 'watch', 'approach', 'today'].flatMap((n) => [`demo.name.${n}`, `demo.desc.${n}`]),
    ...[0, 1, 2, 3, 45, 51, 61, 63, 65, 80, 81, 82, 95, 96, 99].map((c) => `wmo.${c}`),
    ...['monitor', 'prepare', 'danger'].flatMap((b) => ['gust', 'wind', 'rain'].map((k) => `outlook.flag.${k}.${b}`)),
    ...['warning', 'tcfa'].map((k) => `sys.kind.${k}`),
    ...['NIO', 'WPAC', 'EPAC', 'CPAC', 'ATL', 'SH'].map((b) => `basin.${b}`),
    ...config.SURGE_TOWNSHIPS.map((n) => `township.${n}`),
  ];
  const missing = keys.filter((k) => !Object.hasOwn(en, k));
  assert.deepEqual(missing, []);
});

test('Burmese dictionaries are valid (placeholders merge into one object)', () => {
  assert.equal(typeof my, 'object');
  for (const [k, v] of Object.entries(my)) assert.equal(typeof v, 'string', k);
  assert.ok(i18n.missingTranslations('my').length > 0);
});
