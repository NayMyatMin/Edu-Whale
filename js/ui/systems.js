// "Tropical systems" list: one card per system near Myanmar, an empty state
// with season context, and a <details> for storms elsewhere in the world.

import { HOME, INTENSITY_COLORS, KT_TO_KMH, SEASON_BY_MONTH } from '../config.js';
import {
  compassLabel,
  formatDistance,
  formatNumber,
  formatWhen,
  formatWind,
  formatWindKt,
  listSep,
  systemName,
  t,
} from '../i18n.js';
import { extLink, fill, h, icon, levelPill, notice } from './dom.js';
import { levelName } from './status.js';

function yangonMonth(now) {
  return new Date(now.getTime() + 390 * 60e3).getUTCMonth();
}

function kindBadge(s) {
  if (s.kind === 'invest') {
    const p = s.potential ? t(`jtwc.potential.${s.potential}`) : t('jtwc.potential.UNKNOWN');
    return t('sys.kind.investPotential', { potential: p });
  }
  return t(`sys.kind.${s.kind === 'tcfa' ? 'tcfa' : 'warning'}`);
}

function windLine(a) {
  const s = a.system;
  if (s.windKt == null) return t('sys.windUnknown');
  if (s.kind === 'tcfa' || s.kind === 'invest') return t('sys.windEstimated', { wind: formatWindKt(s.windKt) });
  const gust = s.gustKt != null ? t('sys.gusts', { wind: formatWind(s.gustKt * KT_TO_KMH) }) : '';
  return `${t('sys.wind', { wind: formatWindKt(s.windKt) })}${gust ? ` ${gust}` : ''}`;
}

function movementLine(a) {
  if (!a.movement) return null;
  return t('sys.moving', { dir: compassLabel(a.movement.compass), speed: formatWind(a.movement.speedKmh) });
}

function closestLine(a, now) {
  const c = a.closest;
  if (!c || !c.isForecast || c.hoursFromNow == null || c.hoursFromNow <= 0.5) return null;
  if (c.distanceKm >= a.distanceKm - 25) return null; // moving away or passing no closer than now
  return t('sys.closest', {
    dist: formatDistance(c.distanceKm),
    when: formatWhen(toWholeYangonHour(c.time), now),
    hours: formatNumber(Math.round(c.hoursFromNow)),
  });
}

/** Nearest whole Yangon hour (Yangon is UTC+06:30, so whole hours fall on :30 UTC). */
function toWholeYangonHour(d) {
  const ms = new Date(d).getTime() + 1800e3;
  return new Date(Math.round(ms / 3600e3) * 3600e3 - 1800e3);
}

function sourcesLine(s, now) {
  const names = (s.sources ?? []).map((x) => (x === 'jtwc' ? 'JTWC' : x === 'gdacs' ? 'GDACS' : x));
  const time = s.issuedAt ? formatWhen(s.issuedAt, now) : null;
  return time ? t('sys.sourcesAt', { list: names.join(' · '), time }) : t('sys.sources', { list: names.join(' · ') });
}

/** "Valid until …", or — once that time has passed without a new JTWC message — say we are waiting for it. */
function tcfaValidity(s, now) {
  const until = s.kind === 'tcfa' ? s.tcfa?.validUntil : null;
  const ms = until instanceof Date ? until.getTime() : Date.parse(until ?? '');
  if (!Number.isFinite(ms)) return null;
  const when = formatWhen(new Date(ms), now);
  return ms >= now.getTime() ? t('sys.tcfaValid', { when }) : t('sys.tcfaLapsed', { when });
}

function systemCard(a, threat, now, ctx) {
  const s = a.system;
  const level = threat?.level ?? 0;
  const links = [];
  if (s.links?.jtwcText) links.push(extLink(s.links.jtwcText, t('sys.link.jtwc')));
  if (s.links?.gdacsReport) links.push(extLink(s.links.gdacsReport, t('sys.link.gdacs')));
  const facts = [
    windLine(a),
    movementLine(a),
    closestLine(a, now),
    tcfaValidity(s, now),
    a.insideCone ? t('sys.insideCone') : null,
    a.insideWindKmh ? t('sys.insideWind', { wind: formatWind(a.insideWindKmh) }) : null,
    s.final ? t('sys.final') : null,
  ].filter(Boolean);

  return h(
    'article',
    { class: `sys-card lvl-${['calm', 'monitor', 'prepare', 'danger'][level] ?? 'calm'}`, 'aria-labelledby': `sys-${cssId(s.id)}` },
    h(
      'header',
      { class: 'sys-head' },
      h('h3', { class: 'sys-name', id: `sys-${cssId(s.id)}`, text: systemName(s.name) || s.designation || t('sys.unnamed') }),
      h(
        'p',
        { class: 'sys-badges' },
        h('span', { class: `badge badge-kind kind-${s.kind}`, text: kindBadge(s) }),
        classBadge(a),
      ),
    ),
    h(
      'p',
      { class: 'sys-distance' },
      h('span', { class: 'sys-km', text: formatDistance(a.distanceKm) }),
      h('span', { class: 'sys-dir', text: t('sys.ofYangon', { dir: compassLabel(a.compassFromHome) }) }),
    ),
    h('ul', { class: 'sys-facts' }, facts.map((f) => h('li', { text: f }))),
    level >= 1 ? h('p', { class: 'sys-attn' }, levelPill(level, t('sys.attention', { level: levelName(level) }))) : null,
    h('p', { class: 'sys-source muted small', text: sourcesLine(s, now) }),
    h(
      'div',
      { class: 'sys-actions' },
      h(
        'button',
        { type: 'button', class: 'btn btn-secondary btn-sm', on: { click: () => ctx.onShowOnMap?.(s.id) } },
        icon('mapPin', { size: 18 }),
        h('span', { text: t('sys.showOnMap') }),
      ),
      links,
    ),
  );
}

/** Strength badge; left out when neither a wind value nor a class is known. */
function classBadge(a) {
  const s = a.system;
  let key = null;
  let color = null;
  if (s.windKt != null) {
    key = a.imdClassKey ?? 'imd.low';
    color = INTENSITY_COLORS[key];
  } else if (a.jtwcClass) {
    key = `jtwc.${a.jtwcClass}`;
    color = INTENSITY_COLORS[{ TD: 'imd.d', TS: 'imd.cs', HU: 'imd.vscs' }[a.jtwcClass]];
  }
  if (!key) return null;
  return h(
    'span',
    { class: 'badge badge-cls' },
    h('span', { class: 'dot', style: { backgroundColor: color ?? INTENSITY_COLORS['imd.low'] }, 'aria-hidden': 'true' }),
    h('span', { text: t(key) }),
  );
}

function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function emptyState(now) {
  const season = SEASON_BY_MONTH[yangonMonth(now)];
  return h(
    'div',
    { class: 'empty-state' },
    icon('check', { size: 28, className: 'empty-icon' }),
    h('p', { class: 'empty-title', text: t('sys.empty') }),
    h('p', { text: t(season) }),
    h('p', { class: 'muted', text: t('sys.emptyDmhFirst') }),
  );
}

function elsewhereList(list, now) {
  if (!list.length) return null;
  return h(
    'details',
    { class: 'elsewhere' },
    h('summary', { text: t('sys.elsewhere', { n: list.length }) }),
    h(
      'ul',
      {},
      list.map((a) =>
        h(
          'li',
          {},
          h('strong', { text: systemName(a.system.name) || a.system.designation || t('sys.unnamed') }),
          h(
            'span',
            { class: 'muted', text: ` — ${[a.system.basin ? t(`basin.${a.system.basin}`) : null, a.system.windKt != null ? t(a.imdClassKey) : null, t('sys.awayFrom', { dist: formatDistance(a.distanceKm) })].filter(Boolean).join(listSep())}` },
          ),
        ),
      ),
    ),
    h('p', { class: 'muted small', text: t('sys.elsewhereNote') }),
  );
}

/**
 * @param {HTMLElement} el #systems-body
 * @param {object} state buildState() result
 * @param {{now: Date, onShowOnMap?: (id: string) => void, feedNotes?: string[]}} ctx
 */
export function renderSystems(el, state, ctx = {}) {
  const now = ctx.now ?? new Date();
  const parts = [];
  if (!state?.stormsKnown) {
    parts.push(notice('warn', t('sys.feedsDown')));
  } else {
    for (const note of ctx.feedNotes ?? []) parts.push(notice('info', note));
    const relevant = state.relevant ?? [];
    if (!relevant.length) parts.push(emptyState(now));
    else parts.push(h('div', { class: 'sys-list' }, relevant.map((a) => systemCard(a, state.threats?.get(a.system.id), now, ctx))));
    parts.push(elsewhereList(state.elsewhere ?? [], now));
  }
  parts.push(h('p', { class: 'muted small sys-foot', text: t('sys.foot', { lat: formatNumber(HOME.lat, { maximumFractionDigits: 2 }), lon: formatNumber(HOME.lon, { maximumFractionDigits: 2 }) }) }));
  fill(el, parts);
}
