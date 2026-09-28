import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildForecastUrl, normalizeWeather, fetchWeather } from '../js/weather.js';
import { HOME, THRESHOLDS } from '../js/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/openmeteo/yangon_2026-09-28.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(RAW));
const NOW = new Date(RAW.current.time * 1000); // 2026-09-28T15:00Z = 21:30 Yangon
const H = 3600e3;

/** Every number anywhere in the object is finite (null is fine, NaN is not). */
function assertNoNaN(value, path = 'weather') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (value instanceof Date) assert.ok(Number.isFinite(value.getTime()), `${path} invalid date`);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertNoNaN(v, `${path}.${k}`);
}

test('buildForecastUrl asks for exactly the fixture variables, unixtime, Yangon tz, 10 + 1 days', () => {
  const url = new URL(buildForecastUrl(HOME));
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.open-meteo.com/v1/forecast');
  const p = url.searchParams;
  assert.equal(p.get('latitude'), '16.8661');
  assert.equal(p.get('longitude'), '96.1951');
  assert.equal(p.get('timezone'), 'Asia/Yangon');
  assert.equal(p.get('timeformat'), 'unixtime');
  assert.equal(p.get('wind_speed_unit'), 'kmh');
  assert.equal(p.get('forecast_days'), '10');
  assert.equal(p.get('past_days'), '1');
  const vars = (units) => Object.keys(units).filter((k) => k !== 'time' && k !== 'interval').sort();
  assert.deepEqual(p.get('current').split(',').sort(), vars(RAW.current_units));
  assert.deepEqual(p.get('hourly').split(',').sort(), vars(RAW.hourly_units));
  assert.deepEqual(p.get('daily').split(',').sort(), vars(RAW.daily_units));
});

test('normalizeWeather on the 28-Sep fixture', () => {
  const w = normalizeWeather(clone(), NOW);
  assertNoNaN(w);
  assert.deepEqual(w.fetchedAt, NOW);
  assert.equal(w.utcOffsetSeconds, 23400);
  assert.deepEqual(w.current, {
    time: NOW, temperature: 25, apparentTemperature: 29.3, humidity: 96, precipitation: 0.3, weatherCode: 55,
    windSpeed: 13.5, windDirection: 236, windGusts: 27, pressure: 1008.9, cloudCover: 100, isDay: false,
  });
  assert.equal(w.hourly.length, 264);
  assert.deepEqual(Object.keys(w.hourly[0]).sort(), ['precipProbability', 'precipitation', 'pressure', 'temperature', 'time', 'weatherCode', 'windDirection', 'windGusts', 'windSpeed']);
  assert.equal(w.hourly[0].time.toISOString(), '2026-09-26T17:30:00.000Z', 'local midnight 27 Sep');
  assert.equal(w.daily.length, 11);
  assert.equal(w.daily[0].date, '2026-09-27');
  assert.equal(w.daily[1].date, '2026-09-28');
  assert.equal(w.daily[10].date, '2026-10-07');
  assert.ok(w.daily[1].sunrise instanceof Date && w.daily[1].sunset > w.daily[1].sunrise);
  assert.deepEqual(Object.keys(w.daily[0]).sort(), ['date', 'gustMax', 'precipProbMax', 'precipSum', 'sunrise', 'sunset', 'tMax', 'tMin', 'time', 'weatherCode', 'windDirDominant', 'windMax']);
});

test('derived next-72 h windows start at the first hourly value at/after now', () => {
  const w = normalizeWeather(clone(), NOW);
  const n = w.derived.next72h;
  // Independent brute force over the raw arrays.
  const t = RAW.hourly.time.map((s) => s * 1000);
  const i0 = t.findIndex((x) => x >= NOW.getTime());
  const idx = [];
  for (let i = i0; i < t.length && t[i] <= NOW.getTime() + THRESHOLDS.weather.horizonHours * H; i++) idx.push(i);
  assert.equal(idx.length, 72);
  const max = (arr) => Math.max(...idx.map((i) => arr[i]));
  const sumMax = (len) => {
    let best = -1;
    for (let k = 0; k + len <= idx.length; k++) {
      const s = idx.slice(k, k + len).reduce((a, i) => a + RAW.hourly.precipitation[i], 0);
      best = Math.max(best, s);
    }
    return Math.round(best * 10) / 10;
  };
  assert.equal(n.maxGust, max(RAW.hourly.wind_gusts_10m));
  assert.equal(n.maxGust, 37.8);
  assert.equal(n.maxWind, max(RAW.hourly.wind_speed_10m));
  assert.equal(n.maxRainHour, max(RAW.hourly.precipitation));
  assert.equal(n.maxRain24h, sumMax(24));
  assert.equal(n.maxRain48h, sumMax(48));
  assert.equal(n.maxRain72h, sumMax(72));
  assert.ok(n.maxRain24h <= n.maxRain48h && n.maxRain48h <= n.maxRain72h);
  for (const k of ['maxGustTime', 'maxWindTime', 'maxRain24hEnd', 'maxRainHourTime']) {
    assert.ok(n[k] instanceof Date && n[k] >= NOW && n[k] <= new Date(NOW.getTime() + 72 * H), k);
  }
  assert.equal(RAW.hourly.wind_gusts_10m[t.indexOf(n.maxGustTime.getTime())], n.maxGust);
  assert.equal(typeof w.derived.pressureTrend3h, 'number');
});

test('rolling rain windows on a synthetic series', () => {
  const start = Date.UTC(2026, 8, 28, 0) / 1000;
  const hours = 120;
  const time = Array.from({ length: hours }, (_, i) => start + i * 3600);
  const rain = Array.from({ length: hours }, (_, i) => (i >= 10 && i < 34 ? 5 : i >= 60 && i < 66 ? 30 : 0));
  const json = { utc_offset_seconds: 23400, hourly: { time, precipitation: rain } };
  const now = new Date((start + 3 * 3600) * 1000 - 1); // just before hour 3
  const d = normalizeWeather(json, now).derived.next72h;
  assert.equal(d.maxRainHour, 30);
  assert.equal(d.maxRain24h, 180, '6 h of 30 mm');
  assert.equal(d.maxRain24hEnd.getTime(), (start + 65 * 3600) * 1000, 'window ends at the last wet hour');
  assert.equal(d.maxRain48h, 16 * 5 + 180, 'hours 18..65: tail of the first event + the burst');
  assert.equal(d.maxRain72h, 5 * 24 + 180, 'hours 3..74 cover both events');
  assert.equal(d.maxWind, null, 'missing array -> null, not NaN');
  assert.equal(d.maxGust, null);
  // The window starts at the first value at/after now (the value stamped at
  // hour 65 is the rain in the hour ending then).
  const late = normalizeWeather(json, new Date((start + 65 * 3600) * 1000)).derived.next72h;
  assert.equal(late.maxRainHour, 30, 'value stamped exactly at now is included');
  const after = normalizeWeather(json, new Date((start + 65 * 3600) * 1000 + 1)).derived.next72h;
  assert.equal(after.maxRainHour, 0, 'values before now are not');
});

test('nulls and missing arrays become null, never NaN', () => {
  const raw = clone();
  raw.hourly.wind_gusts_10m = raw.hourly.wind_gusts_10m.map(() => null);
  raw.hourly.precipitation[40] = null;
  raw.hourly.pressure_msl = 'broken';
  delete raw.hourly.temperature_2m;
  raw.current.temperature_2m = null;
  raw.current.is_day = undefined;
  delete raw.daily.sunrise;
  raw.daily.precipitation_sum[2] = Number.NaN;
  const w = normalizeWeather(raw, NOW);
  assertNoNaN(w);
  assert.equal(w.current.temperature, null);
  assert.equal(w.current.isDay, null);
  assert.equal(w.hourly[0].temperature, null);
  assert.equal(w.hourly[40].precipitation, null);
  assert.equal(w.hourly[5].pressure, null);
  assert.equal(w.daily[0].sunrise, null);
  assert.equal(w.daily[2].precipSum, null);
  assert.equal(w.derived.next72h.maxGust, null);
  assert.equal(w.derived.next72h.maxGustTime, null);
  assert.equal(w.derived.pressureTrend3h, null);
  assert.equal(typeof w.derived.next72h.maxRain24h, 'number');

  const bare = normalizeWeather({ current: { time: RAW.current.time } }, NOW);
  assert.deepEqual(bare.hourly, []);
  assert.deepEqual(bare.daily, []);
  assert.equal(bare.derived.next72h.maxRain72h, null);
  assertNoNaN(bare);
});

test('unusable responses -> null', () => {
  for (const bad of [null, undefined, 'x', [], {}, { error: true, reason: 'Daily API request limit exceeded' }, { hourly: { time: 'x' } }]) {
    assert.equal(normalizeWeather(bad, NOW), null, JSON.stringify(bad));
  }
});

test('ISO local time strings are read with the UTC offset', () => {
  const w = normalizeWeather({
    utc_offset_seconds: 23400,
    current: { time: '2026-09-28T21:15', temperature_2m: 25.2 },
    hourly: { time: ['2026-09-28T21:00', '2026-09-28T22:00'], precipitation: [1, 0.6] },
    daily: { time: ['2026-09-28'], sunrise: ['2026-09-28T05:54'] },
  }, new Date('2026-09-28T15:00:00Z'));
  assert.equal(w.current.time.toISOString(), '2026-09-28T14:45:00.000Z');
  assert.equal(w.hourly[1].time.toISOString(), '2026-09-28T15:30:00.000Z');
  assert.equal(w.daily[0].date, '2026-09-28');
  assert.equal(w.daily[0].sunrise.toISOString(), '2026-09-27T23:24:00.000Z');
});

test('fetchWeather: fetches the built URL, rejects on API errors', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let body = JSON.stringify(RAW);
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(body, { status: 200 });
  };
  const w = await fetchWeather(HOME, NOW);
  assert.equal(urls[0], buildForecastUrl(HOME));
  assert.equal(w.hourly.length, 264);
  body = JSON.stringify({ error: true, reason: 'Daily API request limit exceeded' });
  await assert.rejects(fetchWeather(HOME, NOW), /limit exceeded/);
});

test('rederiveWeather moves the 72 h window to a later now', async () => {
  const { rederiveWeather } = await import('../js/weather.js');
  const w = normalizeWeather(clone(), NOW);
  const later = new Date(NOW.getTime() + 48 * H);
  const r = rederiveWeather(w, later);
  assert.notEqual(r, w);
  assert.equal(r.hourly, w.hourly);
  assert.ok(r.derived.next72h.maxGustTime >= later);
  assert.equal(rederiveWeather(null, later), null);
});
