// Freshness line under the header: "Updated 4 minutes ago · Yangon 20:52 Mon
// (MMT) · Your time 16:22". The viewer's own time is left out when their
// clock already shows Yangon time.

import { formatDay, formatLocalTime, formatRelative, formatTime, isViewerInYangon, t } from '../i18n.js';
import { fill, h } from './dom.js';

/**
 * @param {HTMLElement} el #freshness
 * @param {{now: Date, updatedAt: Date|null, refreshing?: boolean, offline?: boolean, demo?: boolean}} ctx
 */
export function renderFreshness(el, ctx = {}) {
  const now = ctx.now ?? new Date();
  const parts = [];
  if (ctx.updatedAt) parts.push(h('span', { class: 'fresh-updated', text: t('fresh.updated', { ago: formatRelative(ctx.updatedAt, now) }) }));
  else parts.push(h('span', { class: 'fresh-updated', text: t(ctx.refreshing ? 'fresh.loading' : 'fresh.never') }));
  parts.push(
    h(
      'span',
      { class: 'fresh-clock' },
      h('time', { datetime: now.toISOString(), text: t('fresh.yangon', { time: formatTime(now), day: formatDay(now, { weekdayOnly: true }), zone: t('time.zone') }) }),
    ),
  );
  if (!isViewerInYangon(now)) parts.push(h('span', { class: 'fresh-local', text: t('fresh.yourTime', { time: formatLocalTime(now) }) }));
  if (ctx.offline) parts.push(h('span', { class: 'fresh-offline', text: t('fresh.offline') }));
  fill(el, parts);
}
