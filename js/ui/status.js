// Status block (the first thing on the page) and the plain-text share summary.

import { DMH_LINKS, DMH_STAGES } from '../config.js';
import {
  formatDateTime,
  formatDistance,
  formatWhen,
  formatWind,
  getLang,
  pickLang,
  t,
  tReason,
  withLang,
  formatTemp,
} from '../i18n.js';
import { h, icon, levelMeta, extLink, fill } from './dom.js';

const MAX_REASONS = 3;
const SITE_URL = 'https://eduwhale.info/';

/** 'calm' | 'monitor' | 'prepare' | 'danger' | 'unknown' */
export function levelKey(level) {
  return levelMeta(level).key;
}

/** Full level name as shown to readers ("Danger — act now"). */
export function levelName(level) {
  return t(`status.levelName.${levelKey(level)}`);
}

export function listFormat(items, type = 'conjunction') {
  const list = items.filter(Boolean);
  // Chrome has no Burmese list data (it would print English "and"); use the Burmese comma.
  if (getLang() === 'my') return list.join('၊ ');
  try {
    return new Intl.ListFormat(getLang() === 'my' ? 'my' : 'en', { style: 'long', type }).format(list);
  } catch {
    return list.join(', ');
  }
}

export function dmhCycloneUrl() {
  return getLang() === 'my' ? DMH_LINKS.cycloneMy : DMH_LINKS.cycloneEn;
}

/**
 * Translated reasons split into the lines shown up front and the rest.
 * A storm usually triggers several rules (e.g. "formation alert near Yangon"
 * and "active in our region"); only its strongest reason is shown up front,
 * the others go behind "More reasons" (reasons arrive sorted by level).
 * @returns {{shown: string[], rest: string[]}}
 */
function reasonTexts(risk, max = MAX_REASONS) {
  const seen = new Set();
  const primary = [];
  const secondary = [];
  for (const r of risk?.reasons ?? []) {
    const name = r?.source === 'storm' ? r.params?.name : null;
    const text = tReason(r);
    if (!text) continue;
    if (name && seen.has(name)) secondary.push(text);
    else {
      if (name) seen.add(name);
      primary.push(text);
    }
  }
  return { shown: primary.slice(0, max), rest: [...primary.slice(max), ...secondary] };
}

/**
 * @param {HTMLElement} el   #status-body (aria-live region)
 * @param {object} state     buildState() result
 * @param {object} ctx       { now, notices: Array<{kind, text}>, demo, onShare }
 */
export function renderStatus(el, state, ctx = {}) {
  const risk = state?.risk ?? { level: null, reasons: [], gaps: [] };
  const key = levelKey(risk.level);
  const unknown = risk.level == null;
  const { shown, rest } = reasonTexts(risk);

  const card = h(
    'div',
    { class: `status-card lvl-${key}`, dataset: { level: unknown ? 'unknown' : String(risk.level) } },
    h('div', { class: 'status-band', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'status-top' },
      h('span', { class: 'status-icon' }, icon(levelMeta(risk.level).icon, { size: 30 })),
      h(
        'div',
        { class: 'status-titles' },
        h('p', { class: 'status-kicker', text: t('status.kicker') }),
        h('p', { class: 'status-level', text: levelName(risk.level) }),
      ),
    ),
    h('p', { class: 'status-headline', text: t(`level.${key}.headline`) }),
    shown.length ? h('ul', { class: 'status-reasons' }, shown.map((s) => h('li', { text: s }))) : null,
    rest.length
      ? h(
          'details',
          { class: 'status-more' },
          h('summary', { text: t('status.moreReasons', { n: rest.length }) }),
          h('ul', { class: 'status-reasons' }, rest.map((s) => h('li', { text: s }))),
        )
      : null,
    h('p', { class: 'status-advice', text: t(`level.${key}.advice`) }),
    gapsLine(risk.gaps),
    (ctx.notices ?? []).length ? h('ul', { class: 'status-notices' }, ctx.notices.map((n) => h('li', { class: `notice-${n.kind}` }, icon(n.kind === 'warn' ? 'alert' : 'clock', { size: 18 }), h('span', { text: n.text })))) : null,
    h(
      'div',
      { class: 'status-actions' },
      extLink(dmhCycloneUrl(), unknown ? t('status.checkDmhNow') : t('status.officialDmh'), { className: 'btn btn-primary' }),
      h(
        'button',
        { type: 'button', class: 'btn btn-secondary', on: { click: () => ctx.onShare?.() } },
        icon('share', { size: 20 }),
        h('span', { text: t('status.share') }),
      ),
    ),
    h('p', { class: 'status-smallprint', text: t('status.smallprint') }),
  );
  // Only replace the live region when something changed, so screen readers
  // are not read the whole card again on every quiet refresh.
  const sig = card.textContent;
  if (el.dataset.sig === sig && el.firstElementChild?.classList.contains('status-card')) return;
  el.dataset.sig = sig;
  fill(el, card);
}

function gapsLine(gaps) {
  const all = gaps ?? [];
  // "storm feeds" already covers both of them.
  const shown = all.includes('storms') ? all.filter((g) => g !== 'gdacs' && g !== 'jtwc') : all;
  const list = shown.map((g) => t(`gap.${g}`)).filter((s) => s && !s.startsWith('gap.'));
  if (!list.length) return null;
  return h('p', { class: 'status-gaps' }, icon('info', { size: 18 }), h('span', { text: t('status.gaps', { list: listFormat(list) }) }));
}

/**
 * Short plain-text summary for Viber / Messenger / SMS, in `lang`.
 * @param {object} risk RiskAssessment
 * @param {object[]} analyses SystemAnalysis[] (sorted, most important first)
 * @param {object|null} dmhStatus DmhStatus
 * @param {object|null} weather WeatherData
 * @param {'en'|'my'} [lang]
 * @param {{now?: Date, demo?: boolean, url?: string}} [opts]
 */
export function buildShareText(risk, analyses, dmhStatus, weather, lang = getLang(), opts = {}) {
  return withLang(lang, () => {
    const now = opts.now ?? new Date();
    const lines = [];
    lines.push(t('share.header', { app: t('app.name'), time: formatDateTime(now) }));
    if (opts.demo) lines.push(t('demo.banner'));
    lines.push(t('share.level', { level: levelName(risk?.level ?? null) }));
    lines.push(t(`level.${levelKey(risk?.level ?? null)}.headline`));
    for (const r of reasonTexts(risk).shown) lines.push(`• ${r}`);

    const b = dmhStatus?.bulletin;
    if (b && b.isCurrent) {
      const stage = b.stage && DMH_STAGES[b.stage] ? t(`dmh.stage.${b.stage}`) : null;
      lines.push(
        t(stage ? 'share.dmhStage' : 'share.dmh', {
          title: pickLang(b.title) || t(`dmh.system.${b.system ?? 'unknown'}`),
          stage,
          time: formatWhen(b.issuedAtDate ?? b.issuedAt, now),
        }),
      );
      const url = pickLang(b.url);
      if (url) lines.push(url);
    } else if (dmhStatus?.available) {
      lines.push(t('share.dmhNone'));
    } else {
      lines.push(t('share.dmhUnknown'));
    }

    const top = (analyses ?? []).find((a) => a.relevant);
    if (top && !(b && b.isCurrent)) {
      lines.push(t('share.system', { name: top.system.name, dist: formatDistance(top.distanceKm), dir: t(`dir.${top.compassFromHome}`) }));
    }

    const c = weather?.current;
    if (c && (c.temperature != null || c.windSpeed != null)) {
      lines.push(
        t('share.weather', {
          temp: formatTemp(c.temperature),
          wind: formatWind(c.windSpeed),
          gust: formatWind(c.windGusts),
        }),
      );
    }
    lines.push(t('status.smallprint'));
    const listing = lang === 'my' ? DMH_LINKS.cycloneMy : DMH_LINKS.cycloneEn;
    if (!lines.includes(listing)) lines.push(t('share.dmhLink', { url: listing }));
    lines.push(opts.url ?? siteUrl());
    return lines.filter(Boolean).join('\n');
  });
}

function siteUrl() {
  const loc = globalThis.location;
  if (loc && /^https?:$/.test(loc.protocol) && !/^(localhost|127\.)/.test(loc.hostname)) return `${loc.origin}${loc.pathname}`;
  return SITE_URL;
}
