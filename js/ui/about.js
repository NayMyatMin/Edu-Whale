// "How this works": sources and cadence, the attention-level table rendered
// from THRESHOLDS (so the page explains exactly the numbers risk.js applies),
// limitations, disclaimer, attribution and demo links.

import { DMH_STAGES, JTWC_CLASSES, KT_TO_KMH, REFRESH_MS, STALE_AFTER_MS, THRESHOLDS } from '../config.js';
import { formatNumber, t, tFormat } from '../i18n.js';
import { extLink, fill, h, levelPill } from './dom.js';
import { levelName, listFormat } from './status.js';

// Same as DEMO_NAMES in js/demo.js (not imported: the demo data loads only on demand).
const DEMO_NAMES = ['calm', 'watch', 'approach', 'today'];
const S = THRESHOLDS.storm;
const W = THRESHOLDS.weather;
const D = THRESHOLDS.dmh;
const TS_KMH = JTWC_CLASSES.find((c) => c.key === 'TS').minKt * KT_TO_KMH;
const HU_KMH = JTWC_CLASSES.find((c) => c.key === 'HU').minKt * KT_TO_KMH;

// In DMH's own order: Yellow → Orange → Red → Brown → Green.
function stagesAt(level, index) {
  return Object.keys(DMH_STAGES)
    .filter((stage) => D.stageFloor[stage]?.[index] === level)
    .map((stage) => t(`dmh.stage.${stage}`));
}

function weatherRule(band) {
  const th = W[band] ?? {};
  const parts = [];
  if (th.gustKmh != null) parts.push(tFormat('about.w.gust', { kmh: th.gustKmh }));
  if (th.windKmh != null) parts.push(tFormat('about.w.wind', { kmh: th.windKmh }));
  if (th.rainHourMm != null) parts.push(tFormat('about.w.rainHour', { mm: th.rainHourMm }));
  if (th.rain24hMm != null) parts.push(tFormat('about.w.rain24h', { mm: th.rain24hMm }));
  if (th.rain48hMm != null) parts.push(tFormat('about.w.rain48h', { mm: th.rain48hMm }));
  if (th.rain72hMm != null) parts.push(tFormat('about.w.rain72h', { mm: th.rain72hMm }));
  return parts.length ? tFormat('about.rule.weather', { hours: W.horizonHours, list: listFormat(parts, 'disjunction') }) : null;
}

function dmhRules(level) {
  const out = [];
  const near = stagesAt(level, 0);
  const far = stagesAt(level, 1).filter((s) => !near.includes(s));
  if (near.length) out.push(tFormat('about.rule.dmhNear', { stages: listFormat(near, 'disjunction'), km: D.nearKm }));
  if (far.length) out.push(tFormat('about.rule.dmhFar', { stages: listFormat(far, 'disjunction'), km: D.nearKm }));
  if (D.newsFloor === level) out.push(tFormat('about.rule.dmhNews'));
  if (D.otherWarningFloor === level) out.push(tFormat('about.rule.dmhOther'));
  return out;
}

/** Rules per level, straight from THRESHOLDS. Exported for tests. */
export function levelRules() {
  return [
    {
      level: 3,
      rules: [
        ...dmhRules(3),
        tFormat('about.rule.trackTS', { kmh: TS_KMH, km: S.danger.trackKmTS, hours: S.danger.trackHoursTS }),
        tFormat('about.rule.trackHU', { kmh: HU_KMH, km: S.danger.trackKmHU, hours: S.danger.trackHoursHU }),
        tFormat('about.rule.insideWind', { kmh: S.danger.insideSwathKmh }),
        weatherRule('danger'),
      ],
    },
    {
      level: 2,
      rules: [
        ...dmhRules(2),
        tFormat('about.rule.trackAny', { km: S.prepare.trackKmAny, hours: S.prepare.trackHoursAny }),
        tFormat('about.rule.current', { km: S.prepare.currentKm }),
        tFormat('about.rule.trackHU', { kmh: HU_KMH, km: S.prepare.trackKmHU, hours: S.prepare.trackHoursHU }),
        tFormat('about.rule.insideWindOrCone', { kmh: S.prepare.insideSwathKmh }),
        tFormat('about.rule.tcfa', { km: S.prepare.tcfaKm }),
        weatherRule('prepare'),
      ],
    },
    {
      level: 1,
      rules: [
        ...dmhRules(1),
        S.monitor.inRegion ? tFormat('about.rule.region', { km: S.monitor.nearbyKm }) : tFormat('about.rule.nearby', { km: S.monitor.nearbyKm }),
        tFormat('about.rule.forecastWithin', { km: S.monitor.trackKm }),
        tFormat('about.rule.invest', { km: S.monitor.investKm }),
        weatherRule('monitor'),
      ],
    },
    { level: 0, rules: [tFormat('about.rule.calm')] },
    { level: null, rules: [tFormat('about.rule.unknown', { hours: STALE_AFTER_MS.dmhCheck / 3600e3 })] },
  ].map((row) => ({ ...row, rules: row.rules.filter(Boolean) }));
}

function levelTable() {
  return h(
    'table',
    { class: 'level-table' },
    h('caption', { class: 'visually-hidden', text: t('about.tableCaption') }),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: t('about.col.level') }), h('th', { scope: 'col', text: t('about.col.when') }))),
    h(
      'tbody',
      {},
      levelRules().map((row) =>
        h(
          'tr',
          {},
          h('th', { scope: 'row' }, levelPill(row.level, levelName(row.level))),
          h('td', {}, h('ul', {}, row.rules.map((r) => h('li', { text: r })))),
        ),
      ),
    ),
  );
}

function para(key, params) {
  return h('p', { text: params ? tFormat(key, params) : t(key) });
}

/** @param {HTMLElement} el #about-body */
export function renderAbout(el) {
  const demoLinks = h(
    'ul',
    { class: 'demo-links' },
    DEMO_NAMES.map((name) => h('li', {}, h('a', { href: `?demo=${name}`, text: t(`demo.name.${name}`) }), h('span', { class: 'muted', text: ` — ${t(`demo.desc.${name}`)}` }))),
  );
  fill(
    el,
    h('h3', { text: t('about.sourcesTitle') }),
    h(
      'ul',
      { class: 'about-list' },
      h('li', { text: t('about.src.dmh') }),
      h('li', { text: t('about.src.jtwc') }),
      h('li', { text: t('about.src.gdacs') }),
      h('li', { text: t('about.src.openMeteo') }),
      h('li', { text: t('about.src.map') }),
    ),
    para('about.cadence', { minutes: formatNumber(REFRESH_MS / 60000) }),
    h('h3', { text: t('about.levelsTitle') }),
    para('about.levelsIntro'),
    h('div', { class: 'table-scroll' }, levelTable()),
    h('p', { class: 'muted small', text: tFormat('about.levelsNote', { hours: D.currentHours, km: D.nearKm }) }),
    para('about.override'),
    h('h3', { text: t('about.limitsTitle') }),
    h(
      'ul',
      { class: 'about-list' },
      h('li', { text: t('about.limit.model') }),
      h('li', { text: t('about.limit.early') }),
      h('li', { text: t('about.limit.gdacs') }),
      h('li', { text: t('about.limit.thresholds') }),
      h('li', { text: t('about.limit.translation') }),
    ),
    h('h3', { text: t('about.disclaimerTitle') }),
    h('p', { class: 'disclaimer', text: t('about.disclaimer') }),
    h('h3', { text: t('about.creditsTitle') }),
    h(
      'ul',
      { class: 'about-list credits' },
      h('li', {}, extLink('https://open-meteo.com/', t('about.credit.openMeteo')), ' ', h('span', { text: t('about.credit.openMeteoLicence') }), ' ', extLink('https://creativecommons.org/licenses/by/4.0/', 'CC BY 4.0')),
      h('li', {}, extLink('https://www.moezala.gov.mm/', t('about.credit.dmh'))),
      h('li', {}, extLink('https://www.metoc.navy.mil/jtwc/jtwc.html', t('about.credit.jtwc'))),
      h('li', {}, extLink('https://www.gdacs.org/', t('about.credit.gdacs'))),
      h('li', {}, extLink('https://earthdata.nasa.gov/gibs', t('about.credit.gibs'))),
      h('li', {}, extLink('https://www.rainviewer.com/', t('about.credit.rainviewer'))),
      h('li', {}, extLink('https://www.openstreetmap.org/copyright', t('about.credit.osm'))),
      h('li', {}, extLink('https://leafletjs.com/', t('about.credit.leaflet'))),
      h('li', {}, extLink('https://fonts.google.com/noto/specimen/Noto+Sans+Myanmar', t('about.credit.font'))),
    ),
    h('h3', { text: t('about.demoTitle') }),
    para('about.demoIntro'),
    demoLinks,
  );
}
