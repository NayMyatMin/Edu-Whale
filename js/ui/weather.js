// "Now in Yangon" tiles and the 10-day outlook, from WeatherData (weather.js).

import { THRESHOLDS } from '../config.js';
import {
  compassLabel,
  formatDay,
  formatPercent,
  formatPressure,
  formatRain,
  formatRelative,
  formatTemp,
  formatWind,
  formatNumber,
  t,
  yangonDateKey,
} from '../i18n.js';
import { compass16 } from '../geo.js';
import { fill, h, icon, notice } from './dom.js';

const W = THRESHOLDS.weather;
const KNOWN_WMO = new Set([0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);

export function wmoText(code) {
  return code != null && KNOWN_WMO.has(code) ? t(`wmo.${code}`) : t('wmo.unknown');
}

export function wmoIcon(code, isDay = true) {
  if (code == null) return 'cloud';
  if (code === 0) return isDay ? 'sun' : 'moon';
  if (code === 1 || code === 2) return isDay ? 'cloudSun' : 'cloudMoon';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if (code >= 95) return 'thunder';
  return 'cloud';
}

function tile(iconName, label, value, sub, extra) {
  return h(
    'div',
    { class: 'tile' },
    h('p', { class: 'tile-label' }, icon(iconName, { size: 20 }), h('span', { text: label })),
    h('p', { class: 'tile-value' }, value, extra ?? null),
    sub ? h('p', { class: 'tile-sub', text: sub }) : null,
  );
}

/** Rain in the last full hour from the hourly series (value at T = rain in the hour ending at T). */
function rainLastHour(weather, now) {
  let last = null;
  for (const hr of weather.hourly ?? []) {
    if (hr.time.getTime() <= now.getTime()) last = hr;
    else break;
  }
  return last?.precipitation ?? weather.current?.precipitation ?? null;
}

function pressureTrend(trend) {
  if (trend == null) return null;
  if (trend <= -W.pressureFallHpa3h) return t('now.pressureFallingFast', { hpa: formatNumber(Math.abs(trend), { maximumFractionDigits: 1 }) });
  if (trend <= -0.5) return t('now.pressureFalling', { hpa: formatNumber(Math.abs(trend), { maximumFractionDigits: 1 }) });
  if (trend >= 0.5) return t('now.pressureRising', { hpa: formatNumber(trend, { maximumFractionDigits: 1 }) });
  return t('now.pressureSteady');
}

/**
 * @param {HTMLElement} el #now-body
 * @param {object|null} weather WeatherData
 * @param {{now: Date, stale?: boolean}} ctx
 */
export function renderNow(el, weather, ctx = {}) {
  const now = ctx.now ?? new Date();
  if (!weather?.current) {
    fill(el, notice('warn', t('now.unavailable')));
    return;
  }
  const c = weather.current;
  const dir = c.windDirection;
  const windExtra =
    dir != null
      ? h('span', { class: 'wind-arrow', title: t('now.windFrom', { dir: compassLabel(compass16(dir)) }) }, icon('arrowUp', { size: 22, rotate: dir + 180 }))
      : null;
  const trend = weather.derived?.pressureTrend3h ?? null;
  const tiles = [
    tile('thermometer', t('now.temperature'), formatTemp(c.temperature), c.apparentTemperature != null ? t('now.feelsLike', { temp: formatTemp(c.apparentTemperature) }) : null),
    tile(wmoIcon(c.weatherCode, c.isDay !== false), t('now.sky'), wmoText(c.weatherCode), c.cloudCover != null ? t('now.cloud', { pct: formatPercent(c.cloudCover) }) : null),
    tile(
      'wind',
      t('now.wind'),
      formatWind(c.windSpeed),
      [c.windGusts != null ? t('now.gusts', { wind: formatWind(c.windGusts) }) : null, dir != null ? t('now.windFrom', { dir: compassLabel(compass16(dir)) }) : null].filter(Boolean).join(' · '),
      windExtra,
    ),
    tile('umbrella', t('now.rainHour'), formatRain(rainLastHour(weather, now)), null),
    tile('gauge', t('now.pressure'), formatPressure(c.pressure), pressureTrend(trend)),
    tile('droplet', t('now.humidity'), formatPercent(c.humidity), null),
  ];
  const obs = c.time ? t('now.modelNote', { ago: formatRelative(c.time, now) }) : t('now.modelNoteNoTime');
  fill(
    el,
    ctx.stale ? notice('warn', t('now.stale', { ago: formatRelative(weather.fetchedAt, now) })) : null,
    h('div', { class: 'tiles' }, tiles),
    h('p', { class: 'muted small', text: obs }),
  );
}

/** Highest weather-threshold band a day crosses: {level, key} or null. */
export function dayFlag(day) {
  const bands = [
    ['danger', 3],
    ['prepare', 2],
    ['monitor', 1],
  ];
  for (const [band, level] of bands) {
    const th = W[band];
    if (day.gustMax != null && th.gustKmh != null && day.gustMax >= th.gustKmh) return { level, key: `outlook.flag.gust.${band}` };
    if (day.windMax != null && th.windKmh != null && day.windMax >= th.windKmh) return { level, key: `outlook.flag.wind.${band}` };
    if (day.precipSum != null && th.rain24hMm != null && day.precipSum >= th.rain24hMm) return { level, key: `outlook.flag.rain.${band}` };
  }
  return null;
}

function dayLabel(day, now) {
  const todayKey = yangonDateKey(now);
  const tomorrowKey = yangonDateKey(new Date(now.getTime() + 86400e3));
  if (day.date === todayKey) return t('outlook.today');
  if (day.date === tomorrowKey) return t('outlook.tomorrow');
  return formatDay(day.time);
}

/**
 * @param {HTMLElement} el #outlook-body
 * @param {object|null} weather WeatherData
 * @param {{now: Date}} ctx
 */
export function renderOutlook(el, weather, ctx = {}) {
  const now = ctx.now ?? new Date();
  const todayKey = yangonDateKey(now);
  const days = (weather?.daily ?? []).filter((d) => d.date >= todayKey).slice(0, 10);
  if (!days.length) {
    fill(el, notice('warn', t('outlook.unavailable')));
    return;
  }
  const maxRain = Math.max(50, ...days.map((d) => d.precipSum ?? 0));
  const rows = days.map((d) => {
    const flag = dayFlag(d);
    const pct = d.precipSum != null ? Math.max(d.precipSum > 0 ? 2 : 0, Math.min(100, (d.precipSum / maxRain) * 100)) : 0;
    return h(
      'li',
      { class: 'ol-row' },
      h('p', { class: 'ol-day', text: dayLabel(d, now) }),
      h('p', { class: 'ol-sky' }, icon(wmoIcon(d.weatherCode, true), { size: 24 }), h('span', { text: wmoText(d.weatherCode) })),
      h(
        'p',
        { class: 'ol-temp' },
        h('span', { class: 'visually-hidden', text: `${t('outlook.tempLabel')} ` }),
        h('span', { class: 'ol-max', text: formatTemp(d.tMax) }),
        h('span', { class: 'ol-min', text: ` / ${formatTemp(d.tMin)}` }),
      ),
      h(
        'div',
        { class: 'ol-rain' },
        h(
          'p',
          { class: 'ol-rain-text' },
          h('span', { class: 'visually-hidden', text: `${t('outlook.rainLabel')} ` }),
          h('span', { text: formatRain(d.precipSum) }),
          d.precipProbMax != null ? h('span', { class: 'muted', text: ` · ${formatPercent(d.precipProbMax)}` }) : null,
        ),
        h('span', { class: 'ol-bar', 'aria-hidden': 'true' }, h('span', { class: 'ol-bar-fill', style: { width: `${pct}%` } })),
      ),
      h('p', { class: 'ol-gust' }, h('span', { class: 'ol-gust-label', text: `${t('outlook.gustLabel')} ` }), h('span', { text: formatWind(d.gustMax) })),
      flag ? h('p', { class: 'ol-flag' }, h('span', { class: `pill pill-level lvl-${['calm', 'monitor', 'prepare', 'danger'][flag.level]}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text: t(flag.key) }))) : null,
    );
  });
  fill(el, h('ol', { class: 'outlook-list' }, rows), h('p', { class: 'muted small', text: t('outlook.note') }));
}
