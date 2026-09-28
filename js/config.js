// Shared configuration for Yangon Storm Watch.
// Every threshold used by the attention-level logic lives here so the
// "How this works" section can render the exact same numbers it applies.

export const APP_VERSION = '1.0.0';

export const HOME = Object.freeze({
  id: 'yangon',
  lat: 16.8661,
  lon: 96.1951,
  tz: 'Asia/Yangon',
});

// Bay of Bengal, Andaman Sea and the Gulf of Mottama, plus the land
// corridor systems cross on their way to Myanmar.
export const REGION_BBOX = Object.freeze({ south: 5, north: 25, west: 78, east: 105 });

export const RANGE_RINGS_KM = Object.freeze([150, 300, 600]);

export const REFRESH_MS = 10 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15000;

// How old a cached snapshot or source may be before it is shown as stale.
export const STALE_AFTER_MS = Object.freeze({
  weather: 3 * 3600e3,
  storms: 12 * 3600e3,
  dmhCheck: 3 * 3600e3, // data/dmh.json `checkedAt`
});

export const URLS = Object.freeze({
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  gdacsBase: 'https://www.gdacs.org/gdacsapi/api',
  gdacsReport: (id, ep) => `https://www.gdacs.org/report.aspx?eventid=${id}&episodeid=${ep}&eventtype=TC`,
  jtwcRss: 'https://www.metoc.navy.mil/jtwc/rss/jtwc.rss',
  jtwcProducts: 'https://www.metoc.navy.mil/jtwc/products/',
  jtwcIndianOceanAdvisory: 'https://www.metoc.navy.mil/jtwc/products/abioweb.txt',
  jtwcWestPacificAdvisory: 'https://www.metoc.navy.mil/jtwc/products/abpwweb.txt',
  dmhJson: 'data/dmh.json', // produced by .github/workflows/deploy.yml (scripts/fetch-dmh.mjs)
  overrideJson: 'data/override.json', // optional, hand-edited
  gibsTile: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/Himawari_AHI_Band13_Clean_Infrared/default/{time}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png',
  gibsDomains: (startIso, endIso) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/Himawari_AHI_Band13_Clean_Infrared/default/GoogleMapsCompatible_Level6/all/${startIso}--${endIso}.xml`,
  gibsLegend: 'https://gibs.earthdata.nasa.gov/legends/Clean_Longwave_Infrared_Window_Band_H.png',
  rainviewerIndex: 'https://api.rainviewer.com/public/weather-maps.json',
  osmTiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  windyEmbed: (lat, lon) =>
    'https://embed.windy.com/embed.html?type=map&location=coordinates&metricRain=mm&metricTemp=%C2%B0C' +
    `&metricWind=km%2Fh&zoom=5&overlay=wind&product=ecmwf&level=surface&lat=${lat}&lon=${lon}` +
    `&detailLat=${lat}&detailLon=${lon}&detail=true&marker=true&message=true`,
});

// Satellite loop: GIBS frames are every 10 min but are only reliably served
// ~40 min after their nominal time.
export const SATELLITE = Object.freeze({
  frameStepMin: 30,
  frames: 12,
  safetyLagMin: 45,
  opacity: 0.6,
  maxNativeZoom: 6,
});

// ---------------------------------------------------------------------------
// Intensity scales
// ---------------------------------------------------------------------------
export const KT_TO_KMH = 1.852;
export const KMH_TO_MPH = 0.621371;
export const KM_TO_MI = 0.621371;
export const NM_TO_KM = 1.852;
export const MM_TO_IN = 1 / 25.4;

// IMD (RSMC New Delhi) classes — the scale DMH Myanmar also uses.
// Lower bound in knots (inclusive). JTWC/GDACS winds are 1-minute means and
// run ~10–25% above IMD 3-minute means, so the mapping is approximate.
export const IMD_CLASSES = Object.freeze([
  { key: 'imd.sucs', minKt: 120 },
  { key: 'imd.escs', minKt: 90 },
  { key: 'imd.vscs', minKt: 64 },
  { key: 'imd.scs', minKt: 48 },
  { key: 'imd.cs', minKt: 34 },
  { key: 'imd.dd', minKt: 28 },
  { key: 'imd.d', minKt: 17 },
  { key: 'imd.low', minKt: 0 },
]);

// Saffir–Simpson style buckets used by GDACS/JTWC line labels.
export const JTWC_CLASSES = Object.freeze([
  { key: 'HU', minKt: 64 },
  { key: 'TS', minKt: 34 },
  { key: 'TD', minKt: 0 },
]);

// Colour ramp for track points and storm badges (semantic heat; always shown
// with a legend). Keyed by IMD class.
export const INTENSITY_COLORS = Object.freeze({
  'imd.low': '#9a988f',
  'imd.d': '#6da7ec',
  'imd.dd': '#3987e5',
  'imd.cs': '#1baf7a',
  'imd.scs': '#eda100',
  'imd.vscs': '#eb6834',
  'imd.escs': '#e34948',
  'imd.sucs': '#b0307a',
});

// ---------------------------------------------------------------------------
// Attention levels (this site's own, unofficial reading of the data).
// Deliberately NOT named after DMH's colour stages.
// ---------------------------------------------------------------------------
export const LEVELS = Object.freeze([
  { level: 0, key: 'calm', color: '#0ca30c', icon: 'check' },
  { level: 1, key: 'monitor', color: '#fab219', icon: 'eye' },
  { level: 2, key: 'prepare', color: '#ec835a', icon: 'alert' },
  { level: 3, key: 'danger', color: '#d03b3b', icon: 'siren' },
]);
export const UNKNOWN_LEVEL = Object.freeze({ level: null, key: 'unknown', color: '#898781', icon: 'question' });

export const THRESHOLDS = Object.freeze({
  // Tropical systems (GDACS + JTWC). Distances are from Yangon to the
  // current position or to the forecast track line (not just its points).
  storm: {
    danger: {
      trackKmTS: 150, // TS+ (>= 34 kt) forecast within this distance...
      trackHoursTS: 48, // ...within this many hours
      trackKmHU: 300, // HU (>= 64 kt) forecast within this distance...
      trackHoursHU: 48,
      insideSwathKmh: 90, // Yangon inside a forecast >= 90 km/h wind area
    },
    prepare: {
      trackKmAny: 300, // any warned system (TD+) forecast within this distance...
      trackHoursAny: 72, // ...within this many hours
      currentKm: 300, // or its centre is already this close
      trackKmHU: 600, // a HU forecast within this distance within 72 h
      trackHoursHU: 72,
      insideSwathKmh: 60, // Yangon inside the >= 60 km/h wind area or the uncertainty cone
      tcfaKm: 300, // a JTWC formation alert centred this close
    },
    monitor: {
      nearbyKm: 1000, // any active system within this distance...
      inRegion: true, // ...or anywhere in REGION_BBOX
      trackKm: 600, // or any forecast point within this distance
      investKm: 600, // an invest area (any potential) this close
    },
  },
  // Open-Meteo local forecast for Yangon, next 72 hours.
  weather: {
    horizonHours: 72,
    danger: { gustKmh: 90, windKmh: 62, rain24hMm: 200, rain48hMm: 250 },
    prepare: { gustKmh: 75, windKmh: 50, rain24hMm: 115.6, rain72hMm: 250 },
    monitor: { gustKmh: 50, windKmh: 40, rain24hMm: 64.5, rainHourMm: 20, rain72hMm: 150 },
    pressureFallHpa3h: 3, // shown as a note, never raises the level on its own
  },
  // DMH official bulletins (data/dmh.json). A bulletin counts as current if
  // issued within `currentHours`. `nearKm` decides whether an official stage
  // applies to Yangon itself (DMH stages are national).
  dmh: {
    currentHours: 24,
    nearKm: 500,
    // stage -> [level if near Yangon or bulletin names Yangon, level otherwise]
    stageFloor: {
      brown: [3, 2],
      red: [3, 2],
      orange: [2, 1],
      yellow: [1, 1],
      green: [1, 0],
    },
    newsFloor: 1, // a DMH "News" bulletin (system not heading for Myanmar)
    otherWarningFloor: 1, // flood / heavy rain / strong wind warning naming Yangon
  },
});

// DMH colour stages, shown exactly as DMH words them (never re-used for this
// site's own levels). Swatch colours are for identification only.
export const DMH_STAGES = Object.freeze({
  yellow: { key: 'dmh.stage.yellow', swatch: '#f2c200' },
  orange: { key: 'dmh.stage.orange', swatch: '#f08c00' },
  red: { key: 'dmh.stage.red', swatch: '#d62828' },
  brown: { key: 'dmh.stage.brown', swatch: '#7b4a1e' },
  green: { key: 'dmh.stage.green', swatch: '#2f9e44' },
});

// ---------------------------------------------------------------------------
// People-facing reference data
// ---------------------------------------------------------------------------
// Short codes work only from phones inside Myanmar. Verified from >= 2
// sources unless `noteKey` says otherwise (see README "Sources").
export const EMERGENCY_CONTACTS = Object.freeze([
  { key: 'contact.fire', number: '191', tel: '191', noteKey: 'contact.fire.note' },
  { key: 'contact.ambulance', number: '192', tel: '192', noteKey: 'contact.ambulance.note' },
  { key: 'contact.police', number: '199', tel: '199' },
  { key: 'contact.dmhPhone', number: '01-667766', tel: '+951667766', noteKey: 'contact.dmhPhone.note' },
  { key: 'contact.dmhPhoneNpt', number: '067-411252', tel: '+9567411252' },
  { key: 'contact.redCross', number: '01-383683', tel: '+951383683', noteKey: 'contact.redCross.note' },
]);

export const OFFICIAL_SOURCES = Object.freeze([
  { key: 'source.dmhCyclone', urlEn: 'https://www.moezala.gov.mm/en/cyclone-news', urlMy: 'https://www.moezala.gov.mm/my/cyclone-news', official: true },
  { key: 'source.dmhHome', urlEn: 'https://www.moezala.gov.mm/en', urlMy: 'https://www.moezala.gov.mm/my', official: true },
  { key: 'source.dmhFacebook', urlEn: 'https://www.facebook.com/dmhmoezalanaypyitaw', urlMy: 'https://www.facebook.com/dmhmoezalanaypyitaw', official: true, noteKey: 'source.dmhFacebook.note' },
  { key: 'source.rsmc', urlEn: 'https://rsmcnewdelhi.imd.gov.in/', urlMy: 'https://rsmcnewdelhi.imd.gov.in/', official: true },
  { key: 'source.jtwc', urlEn: 'https://www.metoc.navy.mil/jtwc/jtwc.html?north-indian-ocean', urlMy: 'https://www.metoc.navy.mil/jtwc/jtwc.html?north-indian-ocean' },
  { key: 'source.gdacs', urlEn: 'https://www.gdacs.org/Alerts/default.aspx', urlMy: 'https://www.gdacs.org/Alerts/default.aspx' },
  { key: 'source.zoomEarth', urlEn: 'https://zoom.earth/maps/satellite/#view=16.87,94.5,5z', urlMy: 'https://zoom.earth/maps/satellite/#view=16.87,94.5,5z' },
  { key: 'source.windy', urlEn: 'https://www.windy.com/?16.866,96.195,6', urlMy: 'https://www.windy.com/?16.866,96.195,6' },
]);

export const DMH_LINKS = Object.freeze({
  cycloneEn: 'https://www.moezala.gov.mm/en/cyclone-news',
  cycloneMy: 'https://www.moezala.gov.mm/my/cyclone-news',
  homeEn: 'https://www.moezala.gov.mm/en',
  homeMy: 'https://www.moezala.gov.mm/my',
});

// Preparedness checklist: ids are stable (they key saved progress); text
// lives in the i18n dictionaries as `check.<id>`.
export const CHECKLIST = Object.freeze([
  { group: 'before', ids: ['numbers', 'gobag', 'documents', 'shelter', 'roof', 'family', 'radio'] },
  { group: 'warned', ids: ['followDmh', 'water', 'charge', 'secure', 'moveEarly'] },
  { group: 'during', ids: ['indoors', 'floor', 'eye', 'power', 'floodwater'] },
  { group: 'after', ids: ['lines', 'drinking', 'mosquito'] },
]);
export const SURGE_TOWNSHIPS = Object.freeze([
  'Dala', 'Seikgyikanaungto', 'Kyauktada', 'Thanlyin', 'Kyauktan', 'Twante', 'Kungyangon', 'Kawhmu', 'Thongwa',
]);

// Seasonal context for the "no storms" state (month index 0–11 -> key).
export const SEASON_BY_MONTH = Object.freeze([
  'season.quiet', 'season.quiet', 'season.quiet',
  'season.peak', 'season.peak', // Apr, May
  'season.monsoon', 'season.monsoon', 'season.monsoon', 'season.monsoon', // Jun–Sep
  'season.second', 'season.second', 'season.second', // Oct–Dec
]);
