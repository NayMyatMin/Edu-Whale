// Local Yangon forecast from Open-Meteo (CORS-enabled, no key), normalised
// to WeatherData (see SPEC.md). Missing numbers become null, never NaN, so
// the risk table and charts can tell "no data" from "zero".

import { HOME, THRESHOLDS, URLS } from './config.js';
import { fetchJson } from './net.js';

const CURRENT_VARS = [
  'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'precipitation', 'weather_code',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl', 'cloud_cover', 'is_day',
];
const HOURLY_VARS = [
  'temperature_2m', 'precipitation', 'precipitation_probability', 'weather_code',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'pressure_msl',
];
const DAILY_VARS = [
  'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max',
  'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant', 'sunrise', 'sunset',
];
const HOUR_MS = 3600e3;

/** Open-Meteo forecast URL for `home` (same variables as the captured fixture). */
export function buildForecastUrl(home = HOME) {
  const params = new URLSearchParams({
    latitude: String(home.lat),
    longitude: String(home.lon),
    current: CURRENT_VARS.join(','),
    hourly: HOURLY_VARS.join(','),
    daily: DAILY_VARS.join(','),
    timezone: home.tz || 'Asia/Yangon',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
    forecast_days: '10',
    past_days: '1',
  });
  return `${URLS.openMeteo}?${params}`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const at = (arr, i) => (Array.isArray(arr) ? num(arr[i]) : null);

/**
 * Open-Meteo time -> Date. Unix seconds normally; ISO local strings
 * ("2026-09-28T21:00", no offset) are shifted by the response's UTC offset.
 */
function toDate(v, offsetSec) {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v !== 'string' || !v) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(v);
  const t = Date.parse(hasZone ? v : `${v.length === 10 ? `${v}T00:00` : v}Z`);
  if (!Number.isFinite(t)) return null;
  return new Date(hasZone ? t : t - offsetSec * 1000);
}

function localDateString(date, offsetSec) {
  return new Date(date.getTime() + offsetSec * 1000).toISOString().slice(0, 10);
}

function maxOf(entries, key) {
  let best = null;
  for (const e of entries) {
    const v = e[key];
    if (v != null && (best == null || v > best.value)) best = { value: v, time: e.time };
  }
  return best;
}

/**
 * Largest total over any `hours`-long run of hourly values (value at T = rain
 * in the hour ending at T). Windows shorter than `hours` at the end of the
 * data still count, as a lower bound.
 */
function maxRollingSum(entries, hours) {
  let best = null;
  let sum = 0;
  let known = 0;
  let start = 0;
  for (let end = 0; end < entries.length; end++) {
    const v = entries[end].precipitation;
    if (v != null) {
      sum += v;
      known++;
    }
    while (entries[end].time - entries[start].time >= hours * HOUR_MS) {
      const old = entries[start].precipitation;
      if (old != null) {
        sum -= old;
        known--;
      }
      start++;
    }
    if (known > 0 && (best == null || sum > best.value + 1e-9)) best = { value: round(sum, 1), end: entries[end].time };
  }
  return best;
}

function round(v, digits) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Linear interpolation of hourly pressure at `t`, or null outside the data. */
function pressureAt(hourly, t) {
  for (let i = 0; i < hourly.length - 1; i++) {
    const a = hourly[i];
    const b = hourly[i + 1];
    if (a.time <= t && t <= b.time) {
      if (a.pressure == null || b.pressure == null) return a.time.getTime() === t.getTime() ? a.pressure : null;
      const span = b.time - a.time;
      return span ? a.pressure + ((b.pressure - a.pressure) * (t - a.time)) / span : a.pressure;
    }
  }
  return null;
}

function derive(hourly, now) {
  const horizonEnd = now.getTime() + THRESHOLDS.weather.horizonHours * HOUR_MS;
  // First hourly value at or after now: its value covers the hour we're in.
  const i0 = hourly.findIndex((h) => h.time.getTime() >= now.getTime());
  const window = i0 < 0 ? [] : hourly.slice(i0).filter((h) => h.time.getTime() <= horizonEnd);

  const gust = maxOf(window, 'windGusts');
  const wind = maxOf(window, 'windSpeed');
  const rainHour = maxOf(window, 'precipitation');
  const r24 = maxRollingSum(window, 24);
  const r48 = maxRollingSum(window, 48);
  const r72 = maxRollingSum(window, 72);

  const pNow = pressureAt(hourly, now);
  const p3h = pressureAt(hourly, new Date(now.getTime() - 3 * HOUR_MS));
  return {
    pressureTrend3h: pNow != null && p3h != null ? round(pNow - p3h, 1) : null,
    next72h: {
      maxGust: gust?.value ?? null,
      maxGustTime: gust?.time ?? null,
      maxWind: wind?.value ?? null,
      maxWindTime: wind?.time ?? null,
      maxRain24h: r24?.value ?? null,
      maxRain24hEnd: r24?.end ?? null,
      maxRain48h: r48?.value ?? null,
      maxRain72h: r72?.value ?? null,
      maxRainHour: rainHour?.value ?? null,
      maxRainHourTime: rainHour?.time ?? null,
    },
  };
}

/**
 * Raw Open-Meteo JSON -> WeatherData, or null when the response is unusable
 * (not an object, an API error, or no times at all).
 * @param {object} json
 * @param {Date} [now]
 */
export function normalizeWeather(json, now = new Date()) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.error) return null;
  const off = num(json.utc_offset_seconds) ?? 0;
  const c = json.current && typeof json.current === 'object' ? json.current : null;
  const h = json.hourly && typeof json.hourly === 'object' ? json.hourly : {};
  const d = json.daily && typeof json.daily === 'object' ? json.daily : {};

  // Always an object so renderers can read fields without guarding; all null when absent.
  const cur = c || {};
  const current = {
    time: c ? toDate(c.time, off) : null,
    temperature: num(cur.temperature_2m),
    apparentTemperature: num(cur.apparent_temperature),
    humidity: num(cur.relative_humidity_2m),
    precipitation: num(cur.precipitation),
    weatherCode: num(cur.weather_code),
    windSpeed: num(cur.wind_speed_10m),
    windDirection: num(cur.wind_direction_10m),
    windGusts: num(cur.wind_gusts_10m),
    pressure: num(cur.pressure_msl),
    cloudCover: num(cur.cloud_cover),
    isDay: cur.is_day === 1 || cur.is_day === true ? true : cur.is_day === 0 || cur.is_day === false ? false : null,
  };

  const hourly = [];
  (Array.isArray(h.time) ? h.time : []).forEach((t, i) => {
    const time = toDate(t, off);
    if (!time) return;
    hourly.push({
      time,
      temperature: at(h.temperature_2m, i),
      precipitation: at(h.precipitation, i),
      precipProbability: at(h.precipitation_probability, i),
      weatherCode: at(h.weather_code, i),
      windSpeed: at(h.wind_speed_10m, i),
      windDirection: at(h.wind_direction_10m, i),
      windGusts: at(h.wind_gusts_10m, i),
      pressure: at(h.pressure_msl, i),
    });
  });
  hourly.sort((a, b) => a.time - b.time);

  const daily = [];
  (Array.isArray(d.time) ? d.time : []).forEach((t, i) => {
    const time = toDate(t, off);
    if (!time) return;
    const sun = (arr) => (Array.isArray(arr) ? toDate(arr[i], off) : null);
    daily.push({
      date: localDateString(time, off),
      time,
      weatherCode: at(d.weather_code, i),
      tMax: at(d.temperature_2m_max, i),
      tMin: at(d.temperature_2m_min, i),
      precipSum: at(d.precipitation_sum, i),
      precipProbMax: at(d.precipitation_probability_max, i),
      windMax: at(d.wind_speed_10m_max, i),
      gustMax: at(d.wind_gusts_10m_max, i),
      windDirDominant: at(d.wind_direction_10m_dominant, i),
      sunrise: sun(d.sunrise),
      sunset: sun(d.sunset),
    });
  });

  if (!current.time && !hourly.length && !daily.length) return null;
  const nowDate = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  return { fetchedAt: nowDate, utcOffsetSeconds: off, current, hourly, daily, derived: derive(hourly, nowDate) };
}

/**
 * Recompute `derived` for a different "now" (e.g. a cached WeatherData shown
 * hours after it was fetched), so the 72 h windows never include the past.
 */
export function rederiveWeather(weather, now = new Date()) {
  if (!weather || !Array.isArray(weather.hourly)) return weather;
  return { ...weather, derived: derive(weather.hourly, now) };
}

/** Fetch + normalise. Rejects on network/HTTP errors or an unusable response. */
export async function fetchWeather(home = HOME, now = new Date(), opts = {}) {
  const json = await fetchJson(buildForecastUrl(home), opts);
  const data = normalizeWeather(json, now);
  if (!data) throw new Error(json?.reason ? `Open-Meteo: ${json.reason}` : 'Open-Meteo returned no usable forecast');
  data.fetchedAt = new Date();
  return data;
}
