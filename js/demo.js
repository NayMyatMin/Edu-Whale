// Demo scenarios (?demo=calm|watch|approach|today). Each returns raw-ish
// inputs — TropicalSystem arrays as gdacs.js / jtwc.js produce them, a
// data/dmh.json object, an Open-Meteo-shaped JSON (unixtime) and an override —
// so the page runs them through the REAL pipeline (merge → analyse → DMH →
// risk). Times are relative to `now` so every scenario always looks current.
// The page shows a "DEMO — NOT REAL DATA" banner whenever one is active.

import { circlePolygon, bearingDeg, destinationPoint } from './geo.js';

export const DEMO_NAMES = Object.freeze(['calm', 'watch', 'approach', 'today']);

/** The attention level each scenario is built to produce (checked by tests/demo.test.mjs). */
export const DEMO_EXPECTED_LEVEL = Object.freeze({ calm: 0, watch: 1, approach: 3, today: 3 });

const HOUR = 3600e3;
const YANGON_OFFSET_S = 23400;
const NM_KM = 1.852;
const DMH_LIST = { en: 'https://www.moezala.gov.mm/en/cyclone-news', my: 'https://www.moezala.gov.mm/my/cyclone-news' };
const JTWC_PRODUCTS = 'https://www.metoc.navy.mil/jtwc/products/';

/**
 * Inputs for one scenario, or null for an unknown name.
 * @returns {{gdacsSystems: object[], jtwcSystems: object[], dmhJson: object, weatherJson: object, override: object|null}|null}
 */
export function getDemo(name, now = new Date()) {
  const at = new Date(Math.floor(now.getTime() / 60e3) * 60e3);
  switch (name) {
    case 'calm':
      return calmScenario(at);
    case 'watch':
      return watchScenario(at);
    case 'approach':
      return approachScenario(at);
    case 'today':
      return todayScenario(at);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const hoursFrom = (now, h) => new Date(now.getTime() + h * HOUR);
const iso = (d) => d.toISOString();
const clsOf = (kt) => (typeof kt !== 'number' ? null : kt >= 64 ? 'HU' : kt >= 34 ? 'TS' : 'TD');

function trackOf(now, pts) {
  return pts.map((p) => ({ time: hoursFrom(now, p.h), lat: p.lat, lon: p.lon, forecast: p.h > 0, windKt: p.kt ?? null, cls: clsOf(p.kt) }));
}

function polygonFeature(latLonRing, properties = {}) {
  const ring = latLonRing.map((p) => [round3(p.lon), round3(p.lat)]);
  ring.push(ring[0]);
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

function circleFeature(center, km, properties) {
  return polygonFeature(
    circlePolygon(center, km, 64).map(([lat, lon]) => ({ lat, lon })),
    properties,
  );
}

/** A band of radius `radiusAt(i)` km around a polyline, with round caps (cone / swath). */
function bufferFeature(points, radiusAt, properties) {
  const n = points.length;
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    const brg = bearingDeg(points[Math.max(0, i - 1)], points[Math.min(n - 1, i + 1)]);
    left.push(destinationPoint(points[i], brg - 90, radiusAt(i)));
    right.push(destinationPoint(points[i], brg + 90, radiusAt(i)));
  }
  const cap = (p, fromBrg, r) => Array.from({ length: 11 }, (_, k) => destinationPoint(p, fromBrg + (180 * (k + 1)) / 12, r));
  const endBrg = bearingDeg(points[n - 2], points[n - 1]);
  const startBrg = bearingDeg(points[0], points[1]);
  const ring = [
    ...left,
    ...cap(points[n - 1], endBrg - 90, radiusAt(n - 1)),
    ...right.reverse(),
    ...cap(points[0], startBrg + 90, radiusAt(0)),
  ];
  return polygonFeature(ring, properties);
}

function system(fields) {
  return {
    sources: ['jtwc'],
    kind: 'warning',
    designation: null,
    basin: 'NIO',
    windKt: null,
    gustKt: null,
    movement: null,
    potential: null,
    track: [],
    cone: null,
    windAreas: [],
    swath: { kmh60: null, kmh90: null, kmh120: null },
    tcfa: null,
    alertLevel: null,
    final: false,
    links: {},
    ...fields,
  };
}

/** A storm far away (listed under "Elsewhere"), as GDACS reports it without a track. */
function farStorm(now, { id, name, lat, lon, kt, basin, alertLevel = 'Green' }) {
  return system({
    id,
    sources: ['gdacs'],
    name,
    basin,
    issuedAt: hoursFrom(now, -3),
    position: { lat, lon, time: hoursFrom(now, -3) },
    windKt: kt,
    alertLevel,
    links: { gdacsReport: 'https://www.gdacs.org/Alerts/default.aspx' },
  });
}

function bulletin(now, b) {
  const issued = hoursFrom(now, -b.hoursAgo);
  return {
    id: b.id,
    kind: b.kind,
    system: b.system,
    number: b.number ?? null,
    year: issued.getUTCFullYear(),
    stage: b.stage ?? null,
    issuedAt: iso(issued),
    lat: b.lat ?? null,
    lon: b.lon ?? null,
    pressureHpa: b.pressureHpa ?? null,
    windMph: b.windMph ?? null,
    mentionsYangon: Boolean(b.mentionsYangon),
    weakening: Boolean(b.weakening),
    title: { en: b.title, my: b.titleMy ?? '' },
    url: b.url ?? DMH_LIST,
    summary: { en: b.summary ?? '', my: b.summaryMy ?? '' },
  };
}

function dmhJson(now, { checkedMinAgo = 12, cyclone = null, recent = [], announcement = null, otherWarnings = [] }) {
  const checkedAt = iso(new Date(now.getTime() - checkedMinAgo * 60e3));
  return {
    schema: 1,
    generator: 'js/demo.js',
    checkedAt,
    attemptedAt: checkedAt,
    ok: true,
    errors: [],
    cyclone,
    recentCyclone: recent.map(({ summary, ...rest }) => rest),
    announcement,
    otherWarnings,
  };
}

function wmoFor(mmPerHour, { thunder = false, cloud = 0.4, isDay = true } = {}) {
  if (mmPerHour >= 0.1) {
    if (thunder) return 95;
    if (mmPerHour >= 7.6) return 65;
    if (mmPerHour >= 2.5) return 63;
    return mmPerHour >= 1 ? 61 : 80;
  }
  if (cloud > 0.85) return 3;
  if (cloud > 0.5) return 2;
  if (cloud > 0.2 || !isDay) return 1;
  return 0;
}

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * Open-Meteo-shaped JSON (timeformat=unixtime, past_days=1, forecast_days=10)
 * from a profile `fn(hoursFromNow, localHour)` → {temp, rain, prob, wind, gust, dir, pmsl, thunder?, cloud?, rh?}.
 */
function weatherJson(now, fn) {
  const nowS = Math.floor(now.getTime() / 1000);
  // Yangon hours fall on :30 UTC; start at Yangon midnight yesterday.
  const localMidnight = Math.floor((nowS + YANGON_OFFSET_S) / 86400) * 86400 - YANGON_OFFSET_S;
  const start = localMidnight - 86400;
  const hourly = { time: [], temperature_2m: [], precipitation: [], precipitation_probability: [], weather_code: [], wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [], pressure_msl: [] };
  const rows = [];
  for (let i = 0; i < 264; i++) {
    const t = start + i * 3600;
    const localHour = (((t + YANGON_OFFSET_S) / 3600) % 24 + 24) % 24;
    const v = fn((t - nowS) / 3600, localHour);
    const isDay = localHour >= 6 && localHour < 18;
    const row = {
      t,
      temp: r1(v.temp),
      rain: r1(Math.max(0, v.rain)),
      prob: Math.round(Math.min(100, Math.max(0, v.prob))),
      code: wmoFor(v.rain, { thunder: v.thunder, cloud: v.cloud ?? 0.5, isDay }),
      wind: r1(Math.max(0, v.wind)),
      dir: Math.round(((v.dir % 360) + 360) % 360),
      gust: r1(Math.max(v.wind, v.gust)),
      pmsl: r1(v.pmsl),
      isDay,
      v,
    };
    rows.push(row);
    hourly.time.push(t);
    hourly.temperature_2m.push(row.temp);
    hourly.precipitation.push(row.rain);
    hourly.precipitation_probability.push(row.prob);
    hourly.weather_code.push(row.code);
    hourly.wind_speed_10m.push(row.wind);
    hourly.wind_direction_10m.push(row.dir);
    hourly.wind_gusts_10m.push(row.gust);
    hourly.pressure_msl.push(row.pmsl);
  }
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], precipitation_probability_max: [], wind_speed_10m_max: [], wind_gusts_10m_max: [], wind_direction_10m_dominant: [], sunrise: [], sunset: [] };
  for (let d = 0; d < 11; d++) {
    const day = rows.slice(d * 24, d * 24 + 24);
    const t = start + d * 86400;
    daily.time.push(t);
    daily.weather_code.push(Math.max(...day.map((r) => r.code)));
    daily.temperature_2m_max.push(Math.max(...day.map((r) => r.temp)));
    daily.temperature_2m_min.push(Math.min(...day.map((r) => r.temp)));
    daily.precipitation_sum.push(r1(day.reduce((s, r) => s + r.rain, 0)));
    daily.precipitation_probability_max.push(Math.max(...day.map((r) => r.prob)));
    daily.wind_speed_10m_max.push(Math.max(...day.map((r) => r.wind)));
    daily.wind_gusts_10m_max.push(Math.max(...day.map((r) => r.gust)));
    daily.wind_direction_10m_dominant.push(day[14].dir);
    daily.sunrise.push(t + 6 * 3600 + 1000);
    daily.sunset.push(t + 18 * 3600 + 500);
  }
  const cur = rows.find((r) => r.t <= nowS && nowS < r.t + 3600) ?? rows[24];
  return {
    latitude: 16.866,
    longitude: 96.195,
    utc_offset_seconds: YANGON_OFFSET_S,
    timezone: 'Asia/Yangon',
    timezone_abbreviation: 'GMT+6:30',
    current: {
      time: Math.floor(nowS / 900) * 900,
      interval: 900,
      temperature_2m: cur.temp,
      apparent_temperature: r1(cur.temp + (cur.v.rh ?? 80) / 25),
      relative_humidity_2m: Math.round(cur.v.rh ?? 80),
      precipitation: cur.rain,
      weather_code: cur.code,
      wind_speed_10m: cur.wind,
      wind_direction_10m: cur.dir,
      wind_gusts_10m: cur.gust,
      pressure_msl: cur.pmsl,
      cloud_cover: Math.round((cur.v.cloud ?? 0.5) * 100),
      is_day: cur.isDay ? 1 : 0,
    },
    hourly,
    daily,
  };
}

const diurnal = (localHour, peakHour) => Math.cos(((localHour - peakHour) / 24) * 2 * Math.PI);

// ---------------------------------------------------------------------------
// Calm: a quiet dry-season day. No systems nearby, no current DMH bulletin.
// ---------------------------------------------------------------------------

function calmScenario(now) {
  const weather = weatherJson(now, (h, lh) => ({
    temp: 27 + 5 * diurnal(lh, 14),
    rain: 0,
    prob: 3,
    wind: 9 + 4 * diurnal(lh, 15),
    gust: 17 + 7 * diurnal(lh, 15),
    dir: 30 + 20 * diurnal(lh, 12),
    pmsl: 1012 + 1.2 * Math.cos(((lh - 10) / 12) * 2 * Math.PI),
    cloud: 0.15 + 0.1 * diurnal(lh, 15),
    rh: 62 - 15 * diurnal(lh, 14),
  }));
  const old = bulletin(now, {
    id: 'demo-old',
    kind: 'news',
    system: 'cs',
    number: 8,
    hoursAgo: 24 * 40,
    title: 'Cyclonic Storm News, No.8',
    summary: 'The Cyclonic Storm over the Southwest Bay of Bengal has weakened into a Low Pressure Area over the coast of India.',
    weakening: true,
  });
  return {
    gdacsSystems: [
      farStorm(now, { id: 'gdacs:demo-far-1', name: 'Demo Typhoon', lat: 24.6, lon: 139.8, kt: 90, basin: 'WPAC', alertLevel: 'Orange' }),
      farStorm(now, { id: 'gdacs:demo-far-2', name: 'Demo Hurricane', lat: 27.2, lon: -61.5, kt: 70, basin: 'ATL' }),
    ],
    jtwcSystems: [],
    dmhJson: dmhJson(now, {
      checkedMinAgo: 14,
      cyclone: old,
      recent: [old],
      announcement: {
        issuedAt: iso(hoursFrom(now, -5)),
        text: { en: 'Weather is partly cloudy over the Andaman Sea and the Bay of Bengal. Nothing special.', my: '' },
        url: { en: 'https://www.moezala.gov.mm/en', my: 'https://www.moezala.gov.mm/my' },
      },
      otherWarnings: [],
    }),
    weatherJson: weather,
    override: { enabled: false, minLevel: 0, expires: null, message: { en: '', my: '' } },
  };
}

// ---------------------------------------------------------------------------
// Watch: a depression near the Andaman Islands moving north, ~700 km away.
// DMH has a Yellow stage News bulletin. Nothing heads for Yangon yet.
// ---------------------------------------------------------------------------

const WATCH_TRACK = [
  { h: -12, lat: 10.7, lon: 93.1, kt: 25 },
  { h: -6, lat: 11.25, lon: 93.0, kt: 28 },
  { h: 0, lat: 11.8, lon: 92.9, kt: 30 },
  { h: 12, lat: 12.9, lon: 92.75, kt: 33 },
  { h: 24, lat: 14.0, lon: 92.6, kt: 35 },
  { h: 36, lat: 15.1, lon: 92.4, kt: 40 },
  { h: 48, lat: 16.2, lon: 92.2, kt: 45 },
  { h: 72, lat: 18.3, lon: 92.0, kt: 50 },
];

function watchScenario(now) {
  const track = trackOf(now, WATCH_TRACK);
  const future = track.slice(2); // from the current position (h = 0) on
  const common = {
    name: 'Demo 03B',
    designation: '03B',
    basin: 'NIO',
    kind: 'warning',
    issuedAt: hoursFrom(now, -1),
    position: { lat: 11.8, lon: 92.9, time: hoursFrom(now, -1) },
    windKt: 30,
  };
  const jtwc = system({
    ...common,
    id: 'jtwc:03B',
    sources: ['jtwc'],
    gustKt: 40,
    movement: { bearing: 355, speedKt: 6 },
    track: track.filter((p) => p.time >= hoursFrom(now, -1)),
    links: { jtwcText: `${JTWC_PRODUCTS}io0326web.txt` },
  });
  const gdacs = system({
    ...common,
    id: 'gdacs:demo-03b',
    sources: ['gdacs'],
    issuedAt: hoursFrom(now, -4),
    track,
    cone: bufferFeature(future, (i) => 30 + i * 32, { polygonlabel: 'Uncertainty cone' }),
    windAreas: [{ kmh: 60, time: hoursFrom(now, 0), feature: circleFeature(track[2], 70, { polygonlabel: '60 km/h' }) }],
    alertLevel: 'Green',
    links: { gdacsReport: 'https://www.gdacs.org/Alerts/default.aspx' },
  });

  const news = bulletin(now, {
    id: 'demo-watch-2',
    kind: 'news',
    system: 'depression',
    number: 2,
    stage: 'yellow',
    hoursAgo: 2,
    lat: 11.8,
    lon: 92.9,
    pressureHpa: 1002,
    windMph: { min: 25, max: 30, text: '25-30 miles per hour' },
    title: 'Depression News, No.2',
    summary:
      'The Depression over the Southeast Bay of Bengal and adjoining Andaman Sea is centred near the Andaman Islands. It is coded as yellow stage. It is likely to move northwards and intensify into a Deep Depression during the next 48 hours. It is not expected to affect Myanmar at present. Please follow further bulletins.',
  });
  const earlier = bulletin(now, {
    id: 'demo-watch-1',
    kind: 'news',
    system: 'well-marked-low',
    number: 1,
    hoursAgo: 14,
    title: 'Well Marked Low Pressure Area Condition',
  });

  const weather = weatherJson(now, (h, lh) => {
    const shower = Math.max(0, Math.sin(((lh - 12) / 12) * Math.PI)) ** 3;
    return {
      temp: 28 + 3 * diurnal(lh, 14),
      rain: 3.2 * shower * (1 + 0.3 * Math.sin(h / 7)),
      prob: 30 + 45 * shower,
      wind: 13 + 4 * diurnal(lh, 15),
      gust: 27 + 12 * shower + 4 * diurnal(lh, 15),
      dir: 230 + 15 * Math.sin(h / 11),
      pmsl: 1006.5 + 1 * Math.cos(((lh - 10) / 12) * 2 * Math.PI) - 0.02 * h,
      thunder: shower > 0.8,
      cloud: 0.55 + 0.4 * shower,
      rh: 82 + 10 * shower,
    };
  });

  return {
    gdacsSystems: [gdacs, farStorm(now, { id: 'gdacs:demo-far-1', name: 'Demo Typhoon', lat: 24.6, lon: 139.8, kt: 90, basin: 'WPAC', alertLevel: 'Orange' })],
    jtwcSystems: [jtwc],
    dmhJson: dmhJson(now, {
      checkedMinAgo: 9,
      cyclone: news,
      recent: [news, earlier],
      announcement: {
        issuedAt: iso(hoursFrom(now, -2)),
        text: { en: 'A Depression has formed over the Southeast Bay of Bengal near the Andaman Islands (yellow stage). Monsoon is moderate over the Andaman Sea.', my: '' },
        url: { en: 'https://www.moezala.gov.mm/en', my: 'https://www.moezala.gov.mm/my' },
      },
    }),
    weatherJson: weather,
    override: null,
  };
}

// ---------------------------------------------------------------------------
// Approach: a Severe Cyclonic Storm forecast to pass ~100 km from Yangon in
// ~36 h. DMH moved from Orange to Red stage and names Yangon.
// ---------------------------------------------------------------------------

const APPROACH_TRACK = [
  { h: -24, lat: 12.6, lon: 89.6, kt: 40 },
  { h: -12, lat: 13.6, lon: 90.8, kt: 48 },
  { h: 0, lat: 14.5, lon: 92.0, kt: 55 },
  { h: 12, lat: 15.35, lon: 93.3, kt: 60 },
  { h: 24, lat: 16.3, lon: 94.4, kt: 60 },
  { h: 36, lat: 17.2, lon: 95.3, kt: 55 },
  { h: 48, lat: 18.2, lon: 95.65, kt: 40 },
  { h: 72, lat: 19.9, lon: 96.0, kt: 25 },
];
// Radii (km) of GDACS-style wind areas: 60 / 90 / 120 km/h.
const APPROACH_WIND_RADII = { 60: 200, 90: 85, 120: 35 };

function approachScenario(now) {
  const track = trackOf(now, APPROACH_TRACK);
  const nowIdx = 2;
  const future = track.slice(nowIdx);
  const common = {
    name: 'Demo Cyclone',
    designation: '04B',
    basin: 'NIO',
    kind: 'warning',
    position: { lat: 14.5, lon: 92.0, time: hoursFrom(now, -1) },
    windKt: 55,
  };
  const jtwc = system({
    ...common,
    id: 'jtwc:04B',
    sources: ['jtwc'],
    issuedAt: hoursFrom(now, -1),
    gustKt: 70,
    movement: { bearing: 48, speedKt: 8 },
    track: future,
    links: { jtwcText: `${JTWC_PRODUCTS}io0426web.txt` },
  });
  const windAreas = [];
  for (const p of future.slice(0, 5)) {
    const scale = (p.windKt ?? 0) / 55;
    for (const kmh of [60, 90, 120]) {
      if (kmh === 120 && (p.windKt ?? 0) < 55) continue;
      if (kmh === 90 && (p.windKt ?? 0) < 45) continue;
      windAreas.push({ kmh, time: p.time, feature: circleFeature(p, APPROACH_WIND_RADII[kmh] * Math.max(0.5, scale), { polygonlabel: `${kmh} km/h` }) });
    }
  }
  const swathFor = (kmh) => bufferFeature(future.slice(0, 6), () => APPROACH_WIND_RADII[kmh] * 0.9, { polygonlabel: `${kmh} km/h` });
  const gdacs = system({
    ...common,
    id: 'gdacs:demo-04b',
    sources: ['gdacs'],
    issuedAt: hoursFrom(now, -3),
    track,
    cone: bufferFeature(future, (i) => 25 + i * 45, { polygonlabel: 'Uncertainty cone' }),
    windAreas,
    swath: { kmh60: swathFor(60), kmh90: swathFor(90), kmh120: bufferFeature(future.slice(0, 4), () => 30, { polygonlabel: '120 km/h' }) },
    alertLevel: 'Red',
    links: { gdacsReport: 'https://www.gdacs.org/Alerts/default.aspx' },
  });

  const red = bulletin(now, {
    id: 'demo-approach-6',
    kind: 'warning',
    system: 'scs',
    number: 6,
    stage: 'red',
    hoursAgo: 1,
    lat: 14.5,
    lon: 92.0,
    pressureHpa: 986,
    windMph: { min: 60, max: 65, text: '60-65 miles per hour' },
    mentionsYangon: true,
    title: 'Severe Cyclonic Storm Warning, No.6',
    summary:
      'The Severe Cyclonic Storm over the East-central Bay of Bengal is moving North-Eastwards. It is coded as red stage. It is forecast to cross the Ayeyarwady Region coast within the next 36 hours and to affect Ayeyarwady, Yangon and Bago Regions. Storm surge of 8 to 12 feet above astronomical tide is likely along the Ayeyarwady and Yangon coasts. Squally winds of 50 to 60 mph and heavy to very heavy rain are likely. People in low-lying coastal areas should move to safe places.',
  });
  const orange5 = bulletin(now, {
    id: 'demo-approach-5',
    kind: 'warning',
    system: 'scs',
    number: 5,
    stage: 'orange',
    hoursAgo: 4,
    lat: 14.1,
    lon: 91.5,
    pressureHpa: 988,
    windMph: { min: 55, max: 60, text: '55-60 miles per hour' },
    mentionsYangon: true,
    title: 'Severe Cyclonic Storm Warning, No.5',
  });
  const orange4 = bulletin(now, {
    id: 'demo-approach-4',
    kind: 'warning',
    system: 'cs',
    number: 4,
    stage: 'orange',
    hoursAgo: 10,
    lat: 13.4,
    lon: 90.6,
    pressureHpa: 992,
    windMph: { min: 45, max: 50, text: '45-50 miles per hour' },
    title: 'Cyclonic Storm Warning, No.4',
  });

  const weather = weatherJson(now, (h, lh) => {
    const storm = Math.exp(-(((h - 36) / 10) ** 2));
    const rainBand = Math.exp(-(((h - 34) / 9) ** 2));
    return {
      temp: 27 + 2.5 * diurnal(lh, 14) * (1 - storm) - 2 * storm,
      rain: 0.4 + 11 * rainBand + (h > 10 && h < 60 ? 0.8 : 0),
      prob: 55 + 45 * Math.min(1, rainBand * 3),
      wind: 14 + 56 * storm,
      gust: 26 + 69 * storm,
      dir: 90 + 1.8 * (h + 20),
      pmsl: 1005 - 17 * storm - 0.03 * Math.max(0, 36 - Math.abs(h - 36)),
      thunder: rainBand > 0.6,
      cloud: 0.75 + 0.25 * Math.min(1, rainBand * 2),
      rh: 85 + 12 * rainBand,
    };
  });

  return {
    gdacsSystems: [gdacs],
    jtwcSystems: [jtwc],
    dmhJson: dmhJson(now, {
      checkedMinAgo: 7,
      cyclone: red,
      recent: [red, orange5, orange4],
      announcement: {
        issuedAt: iso(hoursFrom(now, -1)),
        text: { en: 'Severe Cyclonic Storm Warning (Red stage) for the Ayeyarwady, Yangon and Bago Regions. Follow the instructions of the local authorities.', my: '' },
        url: DMH_LIST,
      },
      otherWarnings: [
        {
          type: 'heavy-rain',
          issuedAt: iso(hoursFrom(now, -3)),
          title: { en: 'Heavy Rainfall Warning (Yangon, Ayeyarwady and Bago Regions)', my: '' },
          url: { en: 'https://www.moezala.gov.mm/en/heavy-rainfall-warning', my: 'https://www.moezala.gov.mm/my/heavy-rainfall-warning' },
          mentionsYangon: true,
          isNil: false,
        },
      ],
    }),
    weatherJson: weather,
    override: null,
  };
}

// ---------------------------------------------------------------------------
// Today: the real situation of 28 Sep 2026, shifted so it looks current.
// DMH Brown stage Deep Depression Warning No.3 at 17.1N 97.0E; JTWC only had
// a formation alert (Invest 92W); GDACS did not list the system at all.
// ---------------------------------------------------------------------------

// When the captured data was read (22:30 Yangon time).
const TODAY_REAL_NOW = Date.UTC(2026, 8, 28, 16, 0);

function todayScenario(now) {
  // Whole hours, rounded down, so Yangon hours stay on the hour and nothing
  // lands in the future.
  const shift = Math.floor((now.getTime() - TODAY_REAL_NOW) / HOUR) * HOUR;
  const sd = (s) => new Date(Date.parse(s) + shift);
  const si = (s) => iso(sd(s));

  const tcfa = system({
    id: 'jtwc:92W',
    sources: ['jtwc'],
    kind: 'tcfa',
    name: 'Invest 92W',
    designation: '92W',
    basin: 'NIO',
    issuedAt: sd('2026-09-27T17:30:00Z'),
    position: { lat: 14.4, lon: 98.0, time: sd('2026-09-27T12:00:00Z') },
    windKt: 28,
    movement: { bearing: 247.5, speedKt: 3 },
    potential: 'HIGH',
    track: [{ time: sd('2026-09-27T12:00:00Z'), lat: 14.4, lon: 98.0, forecast: false, windKt: 28, cls: 'TD' }],
    tcfa: { from: { lat: 14.3, lon: 98.1 }, to: { lat: 17.2, lon: 96.6 }, halfWidthKm: 140 * NM_KM, validUntil: sd('2026-09-28T17:30:00Z') },
    links: { jtwcText: `${JTWC_PRODUCTS}wp9226web.txt` },
  });

  // Storms GDACS listed that day (all far away, reported without tracks here).
  const gdacsEvent = (id, ep, name, lat, lon, basin, alertLevel, toDate) =>
    system({
      id: `gdacs:${id}`,
      sources: ['gdacs'],
      name,
      basin,
      issuedAt: sd(toDate),
      position: { lat, lon, time: sd(toDate) },
      alertLevel,
      links: { gdacsReport: `https://www.gdacs.org/report.aspx?eventid=${id}&episodeid=${ep}&eventtype=TC` },
    });
  const gdacsSystems = [
    gdacsEvent(1001327, 22, 'Surigae', 27.5, 132.8, 'WPAC', 'Green', '2026-09-28T12:00:00Z'),
    gdacsEvent(1001325, 31, 'Polo', 23.6, -113.8, 'EPAC', 'Orange', '2026-09-28T09:00:00Z'),
    gdacsEvent(1001329, 5, 'Rachel', 13.4, -100.4, 'EPAC', 'Green', '2026-09-28T09:00:00Z'),
    gdacsEvent(1001323, 33, 'Fay', 27.9, -44.1, 'ATL', 'Green', '2026-09-28T09:00:00Z'),
  ];

  const dmhUrl = (kind, id) => ({ en: `https://www.moezala.gov.mm/en/${kind}/${id}`, my: `https://www.moezala.gov.mm/my/${kind}/${id}` });
  const b = (x) => ({
    id: x.id,
    kind: x.kind,
    system: x.system,
    number: x.number ?? null,
    year: x.number ? 2026 : null,
    stage: x.stage ?? null,
    issuedAt: si(x.issuedAt),
    lat: x.lat ?? null,
    lon: x.lon ?? null,
    pressureHpa: x.pressureHpa ?? null,
    windMph: x.windMph ?? null,
    mentionsYangon: Boolean(x.mentionsYangon),
    weakening: false,
    title: x.title,
    url: dmhUrl(x.kind, x.id),
    summary: x.summary ?? { en: '', my: '' },
  });
  const no3 = b({
    id: '133841',
    kind: 'warning',
    system: 'deep-depression',
    number: 3,
    stage: 'brown',
    issuedAt: '2026-09-28T12:30:00Z',
    lat: 17.1,
    lon: 97.0,
    pressureHpa: 1000,
    windMph: { min: 35, max: 40, text: '35-40 miles per hour' },
    mentionsYangon: true,
    title: { en: 'Deep Depression Warning, No.3, 2026', my: 'အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၃/၂၀၂၆)' },
    summary: {
      en:
        'According to the observations at 18:30 hrs MST today, the Deep Depression over North Andaman Sea and adjoining Mottama, Mon-Taninthayi Coastal has moved North-Northwestwards and is crossing from the south of Kyaikto, Mon State, near the mouth of the Sittaung River in Myanmar. It is centered at about 35 Nautical miles East-Northeast of Thongwa, 35 Nautical miles East-Southeast of Bago and 90 Nautical miles South-Southeast of Phyu, Myanmar. It present state of Deep Depression is coded as brown stage.\n\n' +
        'It is likely to move North-Northwestwards and continue to cross Bago, Yangon, Naypyitaw, Magway and Mandalay Regions during next 48 hours.\n\n' +
        'Due to the Deep Depression, rain or thundershowers are likely to be fairly widespread to widespread in Naypyitaw, Yangon, Mandalay, Bago, Magway…',
      my:
        'ယနေ့မြန်မာစံတော်ချိန်၁၈:၃၀ နာရီအချိန် တိုင်းထွာချက်များအရကပ္ပလီပင်လယ်ပြင် မြောက်ပိုင်းနှင့် ယင်းနှင့်ဆက်စပ်လျက်ရှိသော မြန်မာနိုင်ငံ၊ မုတ္တမကွေ့၊ မွန်-တနင်္သာရီကမ်းရိုးတန်းတို့တွင်ဖြစ်ပေါ်နေသော အားကောင်းသောမုန်တိုင်းငယ် (Deep Depression) သည်မြောက်-အနောက်မြောက်ဘက်သို့ရွေ့လျားခဲ့ပြီးမြန်မာ နိုင်ငံ၊ စစ်တောင်းမြစ်ဝအနီး မွန်ပြည်နယ်၊ ကျိုက်ထိုမြို့၏ တောင်ဘက်မှ စတင် ဖြတ်ကျော်လျက်ရှိပါသည်။ …\n\n' +
        'အဆိုပါအားကောင်းသောမုန်တိုင်းငယ်သည်မြောက်-အနောက်မြောက်ဘက်သို့ ရွေ့လျား နိုင်ပြီး နောက် ၄၈ နာရီအတွင်း ပဲခူးတိုင်းဒေသကြီး၊ ရန်ကုန်တိုင်းဒေသကြီး၊ နေပြည်တော်၊ မကွေးတိုင်းဒေသကြီးနှင့် မန္တလေးတိုင်းဒေသကြီးတို့ကိုဆက်လက်ဖြတ်ကျော်နိုင်သည်ဟုခန့်မှန်းရပါသည်။',
    },
  });
  const recent = [
    no3,
    b({ id: '133840', kind: 'warning', system: 'deep-depression', number: 2, stage: 'red', issuedAt: '2026-09-28T09:30:00Z', lat: 16.4, lon: 97.3, pressureHpa: 1000, windMph: { min: 35, max: 40, text: '35-40 miles per hour' }, mentionsYangon: true, title: { en: 'Deep Depression Warning, No.2, 2026', my: 'အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၂/၂၀၂၆)' } }),
    b({ id: '133839', kind: 'warning', system: 'depression', number: 1, stage: 'red', issuedAt: '2026-09-28T06:30:00Z', lat: 15.6, lon: 97.6, pressureHpa: 1002, windMph: { min: 35, max: 35, text: '35 miles per hour' }, mentionsYangon: true, title: { en: 'Depression Warning, No.1, 2026', my: 'မုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၁/၂၀၂၆)' } }),
    b({ id: '133804', kind: 'news', system: 'well-marked-low', issuedAt: '2026-09-28T00:30:00Z', title: { en: 'Well Marked Low Pressure Area Condition', my: '' } }),
    b({ id: '133798', kind: 'news', system: 'low', issuedAt: '2026-09-27T12:30:00Z', title: { en: 'Low Pressure Area Condition', my: '' } }),
  ];
  const dmh = {
    schema: 1,
    generator: 'js/demo.js (replay of 28 Sep 2026)',
    checkedAt: si('2026-09-28T15:51:01Z'),
    attemptedAt: si('2026-09-28T15:51:01Z'),
    ok: true,
    errors: [],
    cyclone: no3,
    recentCyclone: recent.map(({ summary, ...rest }) => rest),
    announcement: {
      issuedAt: si('2026-09-28T14:07:20Z'),
      text: {
        en: 'According to the observations at 18:30 hrs MST today, the Deep Depression over North Andaman Sea and adjoining Mottama, Mon-Taninthayi Coastal has moved North-Northwestwards and is crossing from the south of Kyaikto, Mon State, near the mouth of the Sittaung River in Myanmar. Monsoon is strong to vigorous over the Andaman Sea and South Bay of Bengal and moderate elsewhere over the Bay of Bengal.',
        my: 'ယနေ့မြန်မာစံတော်ချိန် ၁၈:၃၀ နာရီအချိန် တိုင်းထွာချက်များအရ ကပ္ပလီပင်လယ်ပြင်မြောက်ပိုင်းနှင့် ယင်းနှင့် ဆက်စပ်လျက်ရှိသော မြန်မာနိုင်ငံ၊ မုတ္တမကွေ့၊ မွန်-တနင်္သာရီကမ်းရိုးတန်းတို့တွင် ဖြစ်ပေါ်နေသော အားကောင်းသောမုန်တိုင်းငယ် (Deep Depression)သည် မြောက်-အနောက်မြောက်ဘက်သို့ရွေ့လျားခဲ့ပြီး မြန်မာနိုင်ငံ၊ စစ်တောင်းမြစ်ဝအနီး မွန်ပြည်နယ်၊ ကျိုက်ထိုမြို့၏ တောင်ဘက်မှ စတင်ဖြတ်ကျော်လျက်ရှိပါသည်။',
      },
      url: { en: 'https://www.moezala.gov.mm/en', my: 'https://www.moezala.gov.mm/my' },
    },
    otherWarnings: [
      { type: 'flash-flood', issuedAt: si('2026-09-28T08:00:00Z'), title: { en: 'Flash Flood Guidance Bulletin', my: 'လျှပ်တပြက်ရေကြီးနိုင်မှုဆန်းစစ်ခြင်းအခြေအနေ' }, url: dmhUrl('bulletin', '133827'), mentionsYangon: false, isNil: false },
      { type: 'water-level', issuedAt: si('2026-09-28T05:30:00Z'), title: { en: 'Significant Water Level Bulletin', my: 'ထူးခြားမြစ်ရေအခြေအနေသတင်း' }, url: dmhUrl('bulletin', '133819'), mentionsYangon: false, isNil: true },
      { type: 'flood', issuedAt: si('2026-09-28T05:30:00Z'), title: { en: 'Flood Bulletin', my: '' }, url: dmhUrl('bulletin', '133817'), mentionsYangon: false, isNil: true },
    ],
  };

  return {
    gdacsSystems,
    jtwcSystems: [tcfa],
    dmhJson: dmh,
    weatherJson: todayWeatherJson(shift / 1000),
    override: { enabled: false, minLevel: 0, expires: null, message: { en: '', my: '' } },
  };
}

function todayWeatherJson(shiftS) {
  const W = TODAY_WEATHER;
  const time = Array.from({ length: W.hours }, (_, i) => W.hourlyStart + i * 3600 + shiftS);
  const shiftAll = (arr) => arr.map((t) => t + shiftS);
  return {
    latitude: 16.836554,
    longitude: 96.20096,
    utc_offset_seconds: YANGON_OFFSET_S,
    timezone: 'Asia/Yangon',
    timezone_abbreviation: 'GMT+6:30',
    current: { ...W.current, time: W.current.time + shiftS },
    hourly: { time, ...W.hourly },
    daily: { ...W.daily, time: shiftAll(W.daily.time), sunrise: shiftAll(W.daily.sunrise), sunset: shiftAll(W.daily.sunset) },
  };
}

// Open-Meteo response for Yangon captured 2026-09-28 (tests/fixtures/openmeteo), compacted.
const TODAY_WEATHER = {
  hourlyStart: 1790443800,
  hours: 264,
  current: {"time":1790607600,"interval":900,"temperature_2m":25,"apparent_temperature":29.3,"relative_humidity_2m":96,"precipitation":0.3,"weather_code":55,"wind_speed_10m":13.5,"wind_direction_10m":236,"wind_gusts_10m":27,"pressure_msl":1008.9,"cloud_cover":100,"is_day":0},
  hourly: {
    temperature_2m: [26.2,26,25.9,25.8,25.8,25.7,26.4,27.3,28.4,29.7,30.9,31,32.3,32,31.4,26.7,27.2,27.4,26.9,26.7,26.5,26.3,26.1,26.1,26.5,26.3,26,25.8,25.8,25.7,25.9,26.2,26.8,28.6,28.1,27.8,26.5,26.7,26.9,27.3,26.4,25.4,25.4,25.3,25.4,25,25,24.8,24.5,24.5,24.6,24.3,24.1,23.9,24.1,24.7,24.9,24.5,26.5,27,26,26.8,25.5,25.8,26.5,26.2,25.7,25.6,25.7,25.5,25.4,25.2,25.1,25,25,25,24.8,24.7,24.8,25.8,27.3,28,29.2,30.1,30.9,30.5,30,27.8,28.6,28.3,26.7,26.2,25.9,25.9,25.7,25.5,25.4,25.3,25.2,24.9,24.9,24.8,25.2,26.5,28,29.2,30.3,30.9,31.5,31.9,31.6,31.2,29.1,28.2,27.6,27.4,27.2,26.9,26.5,26.2,26,25.7,25.6,25.5,25.4,25.4,25.6,26.8,28.4,29.8,30.8,31.7,32.2,32.2,31.8,31,29.4,27.3,25.8,25.4,25.5,25.7,25.7,25.7,25.7,25.6,25.5,25.4,25.3,25.3,25.7,26.8,28.2,29.6,30.6,31.5,32.1,32.6,32.8,32.2,30.4,27.9,25.9,25.2,25.1,25,24.8,24.6,24.5,24.5,24.5,24.5,24.5,24.5,24.8,25.8,27.1,28.2,29.1,29.9,30.4,30.4,29.6,28.5,27.3,26.3,25.6,25.2,25.1,25.1,25.1,25.2,25.1,24.8,24.4,24,23.6,23.4,23.6,24.2,25.2,26.3,27.5,28.4,28.8,28.7,28.2,27.4,26.6,25.8,25.2,24.9,24.6,24.5,24.3,24.2,24.1,24,23.8,23.7,23.6,23.6,23.7,24.1,24.7,25.5,26.2,26.7,27,27,26.8,26.4,25.9,25.5,25.2,25,24.8,24.7,24.5,24.4,24.3,24,23.7,23.4,23.2,23.1,23.4,24.2,25.5,26.9,28.3,29.3,29.8,29.4,28.5,27.2,25.8,24.6,23.8,23.5,23.4,23.5,23.7,23.9],
    precipitation: [0,0,0,0,0,0,0,0.1,0.2,0,0.2,0.5,0.6,0.3,0.6,6.5,1.1,0.3,2.9,0.8,0.5,0,0,0,0,0.2,0,0,0,0,0.2,0.2,0.7,0,0.5,1.2,4.1,1,0.7,2,8.1,7,4.7,1.9,1.4,1,0.6,0.2,0.2,0.1,0.5,0.3,0.2,1.2,2.3,1.4,3.4,2.9,0.5,1.6,9,0.7,2.2,1.7,0.1,0.1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.5,0.8,0.1,0.1,0.2,0.1,1,0,0,0.3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.1,0.1,0.2,0.2,0.2,0.2,0.2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0.1,0.1,0.1,0.3,0.3,0.3,1.1,1.1,1.1,0.1,0.1,0.1,0,0,0,0,0,0,0,0,0,0,0,0,0.1,0.1,0.1,0,0,0,0.2,0.2,0.2,0.9,0.9,0.9,0,0,0,0,0,0,0,0,0,0.1,0.1,0.1,0.2,0.2,0.2,1.4,1.4,1.4,1.4,1.4,1.4,0,0,0,0,0,0,0.8,0.8,0.8,0.8,0.8,0.8,1.2,1.2,1.2,1.2,1.2,1.2,1.3,1.3,1.3,1.3,1.3,1.3,0.1,0.1,0.1,0.1,0.1,0.1,0,0,0,0,0,0,0.4,0.4,0.4,0.4,0.4,0.4,2.1,2.1,2.1,2.1,2.1,2.1,0,0,0,0,0,0,0.2,0.2,0.2,0.2,0.2,0.2,0.4,0.4,0.4,0.4,0.4,0.4,2.6,2.6,2.6,2.6,2.6,2.6,1.2,1.2,1.2,1.2,1.2],
    precipitation_probability: [53,40,26,16,11,10,12,16,22,33,51,74,90,95,95,94,94,94,92,88,84,80,77,75,75,80,87,92,92,90,90,93,97,100,100,99,98,99,99,100,100,99,98,96,93,90,88,87,86,84,83,82,83,84,84,82,79,78,82,89,94,97,98,98,99,99,92,71,42,20,10,7,8,16,30,39,41,39,37,34,30,33,47,66,82,91,97,98,95,88,76,55,30,12,7,9,10,8,5,4,4,6,8,11,14,22,38,58,73,81,84,84,81,75,65,48,26,10,3,1,0,0,0,0,0,0,0,0,0,4,16,33,47,56,61,63,60,54,45,32,17,6,2,2,2,1,0,0,1,2,4,5,5,8,14,22,29,34,39,43,49,55,55,43,24,10,4,3,2,1,1,2,3,4,6,10,16,22,28,34,41,48,55,61,66,70,71,66,57,48,38,28,20,16,14,14,14,15,18,23,29,35,41,48,55,62,69,74,78,82,82,78,71,63,54,45,37,31,25,21,18,16,16,20,26,33,40,49,57,65,74,81,87,91,92,87,78,68,58,46,37,31,27,24,22,21,22,24,28,32,37,42,49,58,69,78,86,94,96,91,82,71,60,47],
    weather_code: [1,0,1,2,2,2,3,51,51,3,95,95,95,51,95,95,55,51,81,53,53,3,3,3,3,51,3,3,3,3,51,51,53,3,95,95,95,55,53,95,96,95,95,80,80,55,53,51,51,51,53,51,51,55,80,80,81,81,53,95,95,53,80,80,51,51,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,53,53,51,51,51,51,55,2,1,51,2,2,2,1,1,3,2,3,3,3,3,0,1,1,51,51,51,51,51,51,51,2,1,2,1,2,1,2,2,2,2,1,2,1,0,1,1,2,3,51,51,51,51,95,95,55,55,55,51,51,51,3,3,3,3,3,3,3,3,3,2,2,1,51,51,51,2,2,2,95,95,51,53,53,53,3,3,3,3,3,3,3,3,3,51,51,51,95,95,95,95,95,95,95,80,80,2,2,2,2,2,2,53,53,53,53,53,53,55,55,55,55,95,95,95,95,95,80,80,80,51,51,51,51,51,51,3,3,3,3,3,3,51,51,51,51,51,51,95,95,95,95,95,95,3,3,3,3,3,3,51,51,51,51,51,51,51,51,51,51,95,95,96,95,95,95,95,95,55,55,55,55,55],
    wind_speed_10m: [11.6,11.1,11,10.7,9.4,10.2,11.8,9.3,9,9.8,12,9.9,11.5,10.8,3.3,14.2,6.5,1.3,3.8,5.6,4.5,5.3,4.1,5.1,7.8,7.9,9.6,9,8.8,6.6,11.6,8.8,8.2,8.9,11.2,12.7,10.9,12.7,12.6,11.5,13.7,14.7,15.6,14.2,12.8,13.5,13.7,13.1,11.6,12.5,14.3,11.8,11.3,10.1,9.4,12.8,13.3,11.4,12.9,15.2,13.8,12.8,15.5,8.7,9.3,9.2,7,6,6.8,7.2,6.9,6.9,5.5,5.3,6.4,7.9,7.8,8.4,6.2,4.6,6.8,7.6,8.7,7.9,8.5,8.8,9.6,9.8,7.8,7.2,8.2,5.1,3.5,3.6,2.9,3.1,4,4.1,3.1,2.6,0.3,1.2,2.7,2,4,2.1,2.3,1.9,2.3,3.1,5.3,7.4,12.3,8.4,6.7,7.3,5.9,6.1,6,6.8,5.4,4.7,5.5,5.2,4.9,4,4,4.3,5.2,5.9,6.3,6.5,6.4,6.2,5.8,5.5,4.9,4.9,5.3,5.5,6.2,6.9,6.8,6.5,6,5.5,4.8,4.6,5,5.7,6.4,7.3,8.5,9.6,9.4,8.7,8.5,9.9,11.8,11.6,7,4.5,7.1,4.2,3.4,7.4,7.5,5.6,3.8,2.6,1.3,0.4,1.1,2,2.5,3,4.3,4.6,2.9,2.7,4.6,5.5,4.5,3.6,2.7,2.2,2,2,1.8,1.6,1.5,1.5,1.8,2.7,4,5.5,6.8,7.7,8,7.3,5.9,4.2,2.7,1.9,2.3,3.2,4.3,5.2,6,6.4,6.4,5.8,4.4,3,1.3,0.5,1.6,2.5,3.4,4.2,4.7,5.2,5.6,6,6.5,7.1,7.5,7.7,7.4,6.1,4.2,2.2,1.9,3.3,4.2,3.8,2.5,0.8,1.4,3.1,4.2,4.5,4.6,4.6,4.7,4.8,4.6,3.8,2.6,1.9,2.7,3.8,4.3,4,3.1,1.9,1.5,1.9,2.3,2.2,1.8,1.6,2,2.8],
    wind_direction_10m: [316,310,312,315,313,315,317,319,329,328,351,1,9,30,331,279,284,278,19,303,310,308,304,321,318,330,323,329,329,327,313,314,299,299,296,310,290,276,270,270,257,247,244,237,236,236,218,228,206,192,207,231,228,221,206,212,196,196,193,196,209,191,206,204,207,192,198,185,177,184,187,186,167,156,164,168,157,161,165,154,178,177,167,168,176,182,188,234,195,202,247,234,231,186,210,216,207,229,239,245,315,39,58,80,18,15,4,299,309,260,208,206,186,203,224,242,232,230,221,228,236,212,238,245,246,240,260,272,282,288,290,289,286,280,272,261,242,219,208,218,237,247,248,246,243,243,239,239,240,242,248,261,275,283,288,292,294,291,289,289,305,23,63,83,198,221,222,222,221,219,214,153,90,85,94,123,147,162,187,262,288,281,277,267,250,228,207,190,186,180,173,159,143,132,126,122,122,121,121,123,125,133,152,197,231,243,248,250,249,248,248,248,249,245,236,135,90,86,87,85,88,90,94,100,109,117,125,131,135,140,149,175,253,283,290,295,300,333,90,97,97,92,81,69,58,48,45,49,65,112,152,169,178,183,193,214,263,304,321,336,354,27,63,79],
    wind_gusts_10m: [22.7,22.7,23,22,21.2,19.8,22,24.1,22.7,24.1,33.5,32.8,31,31,30.6,33.5,29.2,16.2,11.2,10.4,10.8,9.4,10.1,9,10.8,14.8,18.4,18,17.3,16.6,16.6,24.1,18.4,24.5,25.2,30.6,28.4,29.5,28.1,31.7,28.1,29.9,30.6,29.9,27.4,27,25.9,28.1,24.8,24.1,27.7,28.4,22.7,22.3,23,26.3,31.7,32.8,33.5,37.1,37.8,29.5,33.1,34.6,24.8,22.3,18.7,13.7,13.7,14,13.7,13.3,13.3,10.4,12.2,15.5,16.2,18,16.2,12.6,18.4,20.9,24.1,25.2,25.6,27,27,29.5,22.3,19.1,18.4,16.2,10.1,7.6,6.8,5.8,7.2,7.9,7.6,5.8,4.3,2.5,5.8,9,13.7,15.1,13,13,13,14,16.9,19.4,28.8,28.1,17.6,14.8,14.8,12.2,12.6,13,13.3,10.4,10.4,10.8,10.1,9.4,7.9,10.8,14.8,18,19.1,19.4,19.8,20.2,20.5,20.9,21.2,21.2,21.2,21.2,21.2,20.5,18,14.8,12.2,11.2,11.2,11.2,10.8,10.4,11.5,15.5,20.9,24.8,26.3,25.9,25.9,25.9,25.9,26.3,27.4,28.4,28.8,27,24.5,21.6,19.4,16.9,14.8,12.2,9.7,7.9,6.8,6.1,6.5,9,12.2,15.1,16.6,17.6,18,23.4,27.7,32,36.4,38.9,39.2,36.4,30.2,23,15.5,9.4,6.1,5.8,7.9,11.2,14.8,18.4,20.2,20.5,20.5,19.8,18.7,18,18,18.7,19.4,20.9,22,22.7,23,22.7,22,20.9,19.8,18.4,17.3,15.8,14.4,12.6,11.2,10.4,10.4,11.5,13.7,16.2,19.1,21.6,23,23.8,24.5,24.8,24.5,24.1,23,21.2,18.7,15.8,12.6,10.4,8.6,7.9,7.9,8.3,8.6,9.7,10.4,11.5,13,14.4,16.2,17.6,18.7,19.8,20.5,21.2,22,22,22,21.2,20.5,19.1,17.6,16.2],
    pressure_msl: [1006.8,1006.3,1005.6,1005.5,1005.5,1005.6,1005.6,1006.2,1006.5,1006.8,1006.2,1005.3,1004.9,1003.1,1003,1003.5,1003.1,1003.6,1004.6,1005,1005.6,1006.2,1005.8,1005.8,1004.9,1004,1003.6,1003.4,1003.2,1003.6,1004.4,1005.3,1005.1,1005.8,1006.1,1005.2,1005.5,1004.7,1003.7,1003.7,1004.2,1004.8,1005.8,1007,1007.9,1008.9,1009.3,1009.3,1009.2,1009,1008.6,1008.4,1008.7,1008.8,1009.3,1010.8,1011.5,1012.2,1012.3,1011.9,1011.1,1009.9,1009.1,1009.1,1008.8,1009.1,1010.4,1011.3,1012.6,1013.3,1013.3,1012.9,1012.4,1011.9,1011.3,1011.2,1011.4,1011.9,1012.5,1013.2,1014,1014.2,1013.8,1012.9,1011.9,1010.7,1009.6,1009.3,1009.4,1009.9,1010.7,1011.7,1013.3,1013.9,1013.9,1013.6,1013.1,1012.4,1011.7,1011.4,1011.6,1012.1,1013.1,1014.3,1014.6,1014.8,1014.4,1013.6,1012.5,1011.3,1010.4,1009.9,1010.2,1010.5,1011.1,1012.7,1013.9,1014.5,1014.6,1014.1,1013.4,1013,1012.6,1012.3,1012.5,1013.1,1013.9,1014.7,1015.4,1015.7,1015.1,1013.9,1012.8,1011.7,1010.5,1010,1010.5,1011.6,1012.6,1013.5,1014.3,1014.7,1014.5,1013.9,1013.3,1012.9,1012.5,1012.4,1012.7,1013.2,1013.8,1014.5,1015.2,1015.3,1014.6,1013.3,1012,1010.7,1009.3,1008.7,1009.3,1010.6,1011.8,1012.8,1013.7,1014.2,1013.9,1013.1,1012.4,1011.8,1011.3,1011.1,1011.3,1011.9,1012.5,1013.4,1014.4,1014.8,1013.9,1012.3,1011.1,1010.5,1010.4,1010.4,1010.5,1010.5,1010.6,1010.7,1010.8,1011,1011.2,1011.4,1011.5,1011.6,1011.8,1011.9,1012,1012,1012,1011.9,1011.7,1011.4,1011.1,1010.9,1010.8,1010.8,1010.8,1010.9,1011,1011.1,1011.2,1011.3,1011.3,1011.4,1011.4,1011.5,1011.6,1011.7,1011.9,1012,1012.2,1012.3,1012.3,1012.2,1012.1,1011.9,1011.7,1011.5,1011.4,1011.3,1011.2,1011.1,1011.1,1011.1,1011.1,1011.2,1011.4,1011.6,1011.8,1012,1012.2,1012.3,1012.4,1012.5,1012.5,1012.5,1012.5,1012.4,1012.2,1012,1011.8,1011.6,1011.4,1011.2,1011.1,1010.9,1010.8,1010.8,1010.8,1010.9,1011.2,1011.5,1011.8,1012.1],
  },
  daily: {
    time: [1790443800,1790530200,1790616600,1790703000,1790789400,1790875800,1790962200,1791048600,1791135000,1791221400,1791307800],
    weather_code: [95,96,95,55,51,95,95,95,95,95,96],
    temperature_2m_max: [32.3,28.6,27,30.9,31.9,32.2,32.8,30.4,28.8,27,29.8],
    temperature_2m_min: [25.7,24.8,23.9,24.7,24.8,25.4,24.6,24.5,23.4,23.6,23.1],
    precipitation_sum: [14.6,35.7,28.4,3.1,1.2,4.8,3.6,9.3,20.3,15.1,25.2],
    precipitation_probability_max: [95,100,99,98,84,63,55,71,82,92,96],
    wind_speed_10m_max: [14.2,15.6,15.5,9.8,12.3,6.9,11.8,5.5,8,7.7,4.8],
    wind_gusts_10m_max: [33.5,31.7,37.8,29.5,28.8,21.2,28.8,39.2,23,24.8,22],
    wind_direction_10m_dominant: [324,276,202,185,223,254,269,213,179,114,84],
    sunrise: [1790465087,1790551494,1790637902,1790724310,1790810718,1790897126,1790983535,1791069944,1791156354,1791242764,1791329174],
    sunset: [1790508455,1790594805,1790681156,1790767507,1790853859,1790940211,1791026564,1791112917,1791199270,1791285625,1791371981],
  },
};
