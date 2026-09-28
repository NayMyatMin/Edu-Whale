// "Official DMH bulletin" card. Shows DMH's own words and colour stage exactly
// as DMH states them, visually distinct from this site's attention level.

import { DMH_LINKS, DMH_STAGES, KMH_TO_MPH } from '../config.js';
import {
  compassLabel,
  formatDistance,
  formatNumber,
  formatPressure,
  formatRelative,
  formatWhen,
  getLang,
  pickLang,
  t,
} from '../i18n.js';
import { extLink, fill, h, icon, notice } from './dom.js';

const MPH_TO_KMH = 1 / KMH_TO_MPH;

/** Language code of the text actually shown for a {en, my} pair. */
function langOf(pair) {
  const l = getLang();
  if (pair && typeof pair[l] === 'string' && pair[l].trim()) return l;
  return l === 'en' ? 'my' : 'en';
}

function textBlock(pair, className) {
  const text = pickLang(pair);
  if (!text) return null;
  const wrap = h('div', { class: className, lang: langOf(pair) });
  for (const para of text.split(/\n{2,}/)) if (para.trim()) wrap.append(h('p', { text: para.trim() }));
  return wrap;
}

/** Colour swatch + DMH's stage words, e.g. "Brown stage — The storm is crossing the coast now." */
export function stageChip(stage, { withMeaning = true, small = false } = {}) {
  const s = DMH_STAGES[stage];
  if (!s) return null;
  return h(
    'p',
    { class: small ? 'stage-chip stage-chip-sm' : 'stage-chip' },
    h('span', { class: 'stage-swatch', style: { backgroundColor: s.swatch }, 'aria-hidden': 'true' }),
    h('strong', { text: t(s.key) }),
    withMeaning ? h('span', { class: 'stage-meaning', text: `\u00a0— ${t(`${s.key}.meaning`)}` }) : null,
  );
}

function windText(w) {
  if (!w || (w.min == null && w.max == null)) return null;
  const n = (v) => formatNumber(Math.round(v));
  const min = w.min ?? w.max;
  const max = w.max ?? w.min;
  const range = (a, b) => (a === b ? n(a) : `${n(a)}–${n(b)}`);
  const mph = `${range(min, max)} ${t('unit.mph')}`;
  const kmh = `${range(min * MPH_TO_KMH, max * MPH_TO_KMH)} ${t('unit.kmh')}`;
  // Exactly as DMH states it (mph), with km/h alongside in either unit mode.
  return `${mph} (${kmh})`;
}

function latLon(lat, lon) {
  const f = (v) => formatNumber(Math.abs(v), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return t('geo.latLon', { lat: f(lat), ns: t(lat >= 0 ? 'geo.n' : 'geo.s'), lon: f(lon), ew: t(lon >= 0 ? 'geo.e' : 'geo.w') });
}

function fact(label, value) {
  if (value == null || value === '') return null;
  return [h('dt', { text: label }), h('dd', {}, value)];
}

function currentBulletin(b, now) {
  const issued = b.issuedAtDate ?? new Date(b.issuedAt);
  const kindKey = b.kind === 'warning' || b.kind === 'news' ? b.kind : null;
  const systemName = t(`dmh.system.${b.system ?? 'unknown'}`);
  const url = pickLang(b.url);
  const position =
    b.lat != null && b.lon != null
      ? [
          h('span', { class: 'nowrap', text: latLon(b.lat, b.lon) }),
          b.distanceKm != null ? h('span', { text: ` — ${t('dmh.position.from', { dist: formatDistance(b.distanceKm), dir: compassLabel(b.compassFromHome) })}` }) : null,
        ]
      : null;

  return h(
    'article',
    { class: 'bulletin' },
    h(
      'p',
      { class: 'bulletin-kind' },
      kindKey ? h('span', { class: `badge badge-${kindKey}`, text: t(`dmh.kind.${kindKey}`) }) : null,
      h('span', { text: systemName }),
    ),
    h('h3', { class: 'bulletin-title', lang: langOf(b.title), text: pickLang(b.title) || systemName }),
    b.stage ? stageChip(b.stage) : null,
    kindKey ? h('p', { class: 'bulletin-kind-meaning', text: t(`dmh.kind.${kindKey}.meaning`) }) : null,
    h(
      'dl',
      { class: 'facts' },
      fact(t('official.issued'), `${formatWhen(issued, now)} (${formatRelative(issued, now)})`),
      fact(t('official.position'), position),
      fact(t('official.wind'), windText(b.windMph)),
      fact(t('official.pressure'), b.pressureHpa != null ? formatPressure(b.pressureHpa) : null),
    ),
    b.weakening ? h('p', { class: 'bulletin-note', text: t('official.weakening') }) : null,
    textBlock(b.summary, 'bulletin-summary'),
    url ? h('p', { class: 'bulletin-link' }, extLink(url, t('official.readFull'), { className: 'btn btn-secondary' })) : null,
  );
}

function noCurrent(b, now) {
  const last =
    b && b.issuedAtDate
      ? h(
          'p',
          { class: 'muted' },
          t('official.lastWas'),
          ' ',
          pickLang(b.url) ? extLink(pickLang(b.url), pickLang(b.title) || t(`dmh.system.${b.system ?? 'unknown'}`), { lang: langOf(b.title) }) : h('span', { lang: langOf(b.title), text: pickLang(b.title) }),
          ` (${formatWhen(b.issuedAtDate, now)}, ${formatRelative(b.issuedAtDate, now)})`,
        )
      : null;
  return h('div', { class: 'bulletin bulletin-none' }, h('p', { class: 'bulletin-none-title', text: t('official.none') }), h('p', { text: t('official.noneExplain') }), last);
}

/** DMH "Top Announcement". Collapsed when a current bulletin is already shown (it usually repeats it). */
function announcement(a, now, collapsed) {
  if (!a) return null;
  const url = pickLang(a.url);
  const body = [
    textBlock(a.text, 'dmh-ann-text'),
    h(
      'p',
      { class: 'muted small' },
      a.issuedAtDate ? `${t('official.published', { time: formatWhen(a.issuedAtDate, now) })} ` : '',
      url ? extLink(url, t('official.openDmh')) : null,
    ),
  ];
  if (collapsed) return h('details', { class: 'dmh-sub dmh-ann' }, h('summary', { text: t('official.announcement') }), body);
  return h('section', { class: 'dmh-sub', 'aria-labelledby': 'dmh-ann-title' }, h('h3', { id: 'dmh-ann-title', text: t('official.announcement') }), body);
}

function otherWarnings(list, now) {
  if (!list?.length) return null;
  return h(
    'section',
    { class: 'dmh-sub', 'aria-labelledby': 'dmh-other-title' },
    h('h3', { id: 'dmh-other-title', text: t('official.otherWarnings') }),
    h(
      'ul',
      { class: 'other-list' },
      list.map((w) => {
        const url = pickLang(w.url);
        const title = pickLang(w.title) || t(`dmh.otherType.${w.type}`);
        return h(
          'li',
          { class: w.isCurrent ? 'is-current' : 'is-old' },
          h('span', { class: 'badge', text: t(`dmh.otherType.${w.type}`) }),
          ' ',
          url ? extLink(url, title, { lang: langOf(w.title) }) : h('span', { lang: langOf(w.title), text: title }),
          h(
            'span',
            { class: 'muted small other-meta' },
            ` · ${formatWhen(w.issuedAtDate, now)}`,
            w.mentionsYangon ? ` · ${t('official.mentionsYangon')}` : '',
            w.isNil ? ` · ${t('official.nil')}` : '',
          ),
        );
      }),
    ),
  );
}

function recentList(recent, currentId, now) {
  const items = (recent ?? []).filter((r) => r.id !== currentId);
  if (!items.length) return null;
  return h(
    'details',
    { class: 'dmh-recent' },
    h('summary', { text: t('official.earlier', { n: items.length }) }),
    h(
      'ul',
      {},
      items.map((r) => {
        const url = pickLang(r.url);
        const title = pickLang(r.title) || t(`dmh.system.${r.system ?? 'unknown'}`);
        return h(
          'li',
          {},
          url ? extLink(url, title, { lang: langOf(r.title) }) : h('span', { text: title }),
          r.stage ? stageChip(r.stage, { withMeaning: false, small: true }) : null,
          h('span', { class: 'muted small', text: ` ${formatWhen(r.issuedAtDate, now)}` }),
        );
      }),
    ),
  );
}

function stageExplainer() {
  return h(
    'details',
    { class: 'stage-explainer' },
    h('summary', { text: t('official.stagesTitle') }),
    h('p', { text: t('official.stagesIntro') }),
    h(
      'ol',
      { class: 'stage-list' },
      Object.keys(DMH_STAGES).map((stage) => h('li', {}, stageChip(stage))),
    ),
    h('p', { class: 'muted small', text: t('official.stagesNote') }),
  );
}

/**
 * @param {HTMLElement} el #official-body
 * @param {object} dmh DmhStatus (evaluateDmh)
 * @param {{now: Date, fetchState: 'ok'|'missing'|'error'|'cached', demo?: boolean}} ctx
 */
export function renderOfficial(el, dmh, ctx = {}) {
  const now = ctx.now ?? new Date();
  const lang = getLang();
  const parts = [];

  if (!dmh || !dmh.available) {
    parts.push(
      notice('warn', ctx.fetchState === 'missing' ? t('official.notSetUp') : t('official.unreachable')),
      h('p', {}, extLink(lang === 'my' ? DMH_LINKS.cycloneMy : DMH_LINKS.cycloneEn, t('official.openCyclone'), { className: 'btn btn-primary' })),
    );
  } else {
    if (dmh.checkStale) {
      parts.push(notice('warn', t('official.stale', { ago: formatRelative(dmh.checkedAt, now) })));
    } else if (ctx.fetchState === 'error' || ctx.fetchState === 'cached') {
      parts.push(notice('info', t('official.savedCopy')));
    }
    const b = dmh.bulletin;
    parts.push(b && b.isCurrent ? currentBulletin(b, now) : noCurrent(b, now));
    parts.push(announcement(dmh.announcement, now, Boolean(b && b.isCurrent)));
    parts.push(otherWarnings(dmh.otherWarnings, now));
    parts.push(recentList(dmh.recent, b?.id ?? null, now));
    parts.push(
      h(
        'p',
        { class: 'checked-line muted small' },
        icon('clock', { size: 16 }),
        h('span', { text: t('official.checked', { ago: formatRelative(dmh.checkedAt, now) }) }),
      ),
    );
  }
  parts.push(stageExplainer());
  parts.push(
    h(
      'p',
      { class: 'official-links' },
      extLink(lang === 'my' ? DMH_LINKS.cycloneMy : DMH_LINKS.cycloneEn, t('official.linkCyclone')),
      extLink(lang === 'my' ? DMH_LINKS.homeMy : DMH_LINKS.homeEn, t('official.linkHome')),
    ),
  );

  const head = h(
    'div',
    { class: 'official-head' },
    icon('official', { size: 22 }),
    h('span', { class: 'official-badge', text: t('official.badge') }),
    ctx.demo ? h('span', { class: 'badge badge-demo', text: t('demo.chip') }) : null,
  );
  fill(el, head, h('div', { class: 'official-content' }, parts));
}
