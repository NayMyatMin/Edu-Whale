// Small DOM helpers shared by the renderers. Data only ever reaches the page
// through textContent / attributes; icons are built with createElementNS from
// the constant shapes below (no innerHTML anywhere).

import { LEVELS, UNKNOWN_LEVEL } from '../config.js';
import { t } from '../i18n.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Element builder. attrs: `class`, `text`, `on: {event: fn}`, `dataset: {}`,
 * booleans (true → empty attribute, false/null → omitted), everything else
 * via setAttribute. Children: nodes, strings (text nodes), arrays, null.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  append(el, children);
  return el;
}

function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace all children of `el`. */
export function fill(el, ...children) {
  if (!el) return el;
  el.replaceChildren();
  return append(el, children);
}

// 24 px grid, 1.75 px round strokes (see css .icon). [tag, attrs] pairs.
const ICONS = {
  check: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M8 12.4l2.8 2.8 5.4-5.8' }]],
  eye: [['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z' }], ['circle', { cx: 12, cy: 12, r: 2.8 }]],
  alert: [['path', { d: 'M10.3 4.3 2.7 17.5a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z' }], ['path', { d: 'M12 9.5v4.3M12 17.1v.1' }]],
  siren: [['path', { d: 'M7 18v-5.5a5 5 0 0 1 10 0V18' }], ['path', { d: 'M4.5 18h15v2.5h-15z' }], ['path', { d: 'M12 2.5v2.2M4.4 5.4l1.5 1.5M19.6 5.4l-1.5 1.5M2.5 12.5h2M19.5 12.5h2' }], ['path', { d: 'M12 12.5v2' }]],
  question: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9.6 9.3a2.5 2.5 0 0 1 4.8 1c0 1.7-2.4 2.1-2.4 3.7' }], ['path', { d: 'M12 17.1v.1' }]],
  cyclone: [['path', { d: 'M15.4 11.2C16.3 6.6 12.9 3.2 7.6 3.6M8.6 12.8C7.7 17.4 11.1 20.8 16.4 20.4' }], ['circle', { cx: 12, cy: 12, r: 3.2 }]],
  external: [['path', { d: 'M14 4h6v6M20 4l-8.5 8.5' }], ['path', { d: 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10' }]],
  share: [['circle', { cx: 18, cy: 5.5, r: 2.5 }], ['circle', { cx: 6, cy: 12, r: 2.5 }], ['circle', { cx: 18, cy: 18.5, r: 2.5 }], ['path', { d: 'M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1' }]],
  refresh: [['path', { d: 'M19.5 11A7.6 7.6 0 0 0 6 6.6L4 8.6' }], ['path', { d: 'M4 4.2v4.4h4.4' }], ['path', { d: 'M4.5 13A7.6 7.6 0 0 0 18 17.4l2-2' }], ['path', { d: 'M20 19.8v-4.4h-4.4' }]],
  phone: [['path', { d: 'M5.2 3.8h3.6l1.8 4.6-2.3 1.4a11 11 0 0 0 5.9 5.9l1.4-2.3 4.6 1.8v3.6a2 2 0 0 1-2.1 2A16.4 16.4 0 0 1 3.2 5.9a2 2 0 0 1 2-2.1Z' }]],
  sun: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4' }]],
  moon: [['path', { d: 'M19.5 14.6A7.8 7.8 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1Z' }]],
  cloud: [['path', { d: 'M7 18.5h10a4 4 0 0 0 .6-7.95 5.5 5.5 0 0 0-10.7.65A3.7 3.7 0 0 0 7 18.5Z' }]],
  cloudSun: [['path', { d: 'M9 3v1.4M3.9 5.3l1 1M2 10.3h1.4M14.1 5.3l-1 1' }], ['path', { d: 'M5.6 12.4A3.6 3.6 0 0 1 12 8.6' }], ['path', { d: 'M9 20h8.5a3.5 3.5 0 0 0 .5-6.95 4.8 4.8 0 0 0-9.2 1.1A2.9 2.9 0 0 0 9 20Z' }]],
  cloudMoon: [['path', { d: 'M11.8 7.4a3.6 3.6 0 0 1-4.6-4.6 4.4 4.4 0 1 0 4.6 4.6Z' }], ['path', { d: 'M9 20h8.5a3.5 3.5 0 0 0 .5-6.95 4.8 4.8 0 0 0-9.2 1.1A2.9 2.9 0 0 0 9 20Z' }]],
  rain: [['path', { d: 'M7 15.5a3.8 3.8 0 0 1-.2-7.6 5.4 5.4 0 0 1 10.5 1A3.3 3.3 0 0 1 17 15.5' }], ['path', { d: 'M8.5 18.2 7.4 20.6M12.5 18.2l-1.1 2.4M16.5 18.2l-1.1 2.4' }]],
  drizzle: [['path', { d: 'M7 15.5a3.8 3.8 0 0 1-.2-7.6 5.4 5.4 0 0 1 10.5 1A3.3 3.3 0 0 1 17 15.5' }], ['path', { d: 'M8.5 18.5v.1M12 20v.1M15.5 18.5v.1' }]],
  thunder: [['path', { d: 'M7 15.5a3.8 3.8 0 0 1-.2-7.6 5.4 5.4 0 0 1 10.5 1A3.3 3.3 0 0 1 17 15.5' }], ['path', { d: 'M12.8 12.5 10.6 16.5h3l-2.2 4' }]],
  fog: [['path', { d: 'M7 12.5a3.8 3.8 0 0 1-.2-7.6 5.4 5.4 0 0 1 10.5 1A3.3 3.3 0 0 1 17 12.5' }], ['path', { d: 'M4 16h16M6.5 19.5h11' }]],
  wind: [['path', { d: 'M3.5 8.5h10a3 3 0 1 0-3-3' }], ['path', { d: 'M3.5 12.5h14.5a3 3 0 1 1-3 3' }], ['path', { d: 'M3.5 16.5h7' }]],
  droplet: [['path', { d: 'M12 3.5s6 6.4 6 10.4a6 6 0 0 1-12 0c0-4 6-10.4 6-10.4Z' }]],
  gauge: [['path', { d: 'M4.2 17.5a9 9 0 1 1 15.6 0' }], ['path', { d: 'M12 13l3.6-4' }], ['circle', { cx: 12, cy: 13, r: 1.3 }]],
  thermometer: [['path', { d: 'M14 14.6V5a2 2 0 0 0-4 0v9.6a4 4 0 1 0 4 0Z' }], ['path', { d: 'M12 9v7' }]],
  umbrella: [['path', { d: 'M3 12a9 9 0 0 1 18 0Z' }], ['path', { d: 'M12 12v6.5a2 2 0 0 1-4 0' }]],
  arrowUp: [['path', { d: 'M12 20V4.5M6 10.5l6-6 6 6' }]],
  official: [['path', { d: 'M3.5 9 12 4.5 20.5 9' }], ['path', { d: 'M5.5 10v7.5M9.8 10v7.5M14.2 10v7.5M18.5 10v7.5' }], ['path', { d: 'M3.5 20.3h17' }]],
  radio: [['rect', { x: 3.5, y: 8.5, width: 17, height: 11.5, rx: 2 }], ['path', { d: 'M7 8.5 16 4' }], ['circle', { cx: 15.5, cy: 14.2, r: 2.6 }], ['path', { d: 'M6.8 12.2h4M6.8 15.8h4' }]],
  clock: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 7v5l3.2 2' }]],
  table: [['rect', { x: 3.5, y: 4.5, width: 17, height: 15, rx: 1.5 }], ['path', { d: 'M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10' }]],
  chart: [['path', { d: 'M4 19.5h16' }], ['path', { d: 'M5 15.5l4.5-5 3.5 3 6-7' }]],
  mapPin: [['path', { d: 'M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z' }], ['circle', { cx: 12, cy: 10, r: 2.3 }]],
  info: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M12 11v5.5M12 7.8v.1' }]],
  home: [['path', { d: 'M4 11.2 12 4.5l8 6.7' }], ['path', { d: 'M6 9.8v9.7h12V9.8' }], ['path', { d: 'M10 19.5v-5h4v5' }]],
  surge: [['path', { d: 'M3 15c2 0 2-1.5 4.5-1.5S9.6 15 12 15s2.5-1.5 4.5-1.5S19 15 21 15' }], ['path', { d: 'M3 19.2c2 0 2-1.5 4.5-1.5s2.1 1.5 4.5 1.5 2.5-1.5 4.5-1.5 2.5 1.5 4.5 1.5' }], ['path', { d: 'M12 10.5V3.5M9 6.5l3-3 3 3' }]],
  reset: [['path', { d: 'M4.5 12a7.5 7.5 0 1 0 2.3-5.4L4.5 8.8' }], ['path', { d: 'M4.5 4.3v4.5H9' }]],
  chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
  close: [['path', { d: 'M6 6l12 12M18 6 6 18' }]],
  copy: [['rect', { x: 8.5, y: 8.5, width: 11, height: 11, rx: 1.8 }], ['path', { d: 'M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5' }]],
  list: [['path', { d: 'M9 6.5h11M9 12h11M9 17.5h11' }], ['path', { d: 'M4.5 6.5v.1M4.5 12v.1M4.5 17.5v.1' }]],
};

/**
 * Inline SVG icon (decorative unless `label` is given).
 * @param {string} name key of ICONS
 * @param {{size?: number, className?: string, label?: string, rotate?: number}} [opts]
 */
export function icon(name, { size = 24, className = '', label, rotate } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('focusable', 'false');
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of ICONS[name] ?? ICONS.info) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (rotate != null && Number.isFinite(rotate)) node.setAttribute('transform', `rotate(${Math.round(rotate)} 12 12)`);
    svg.append(node);
  }
  return svg;
}

export function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  return el;
}

/** Only http(s) URLs may become links. */
export function safeHref(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url, globalThis.location?.href);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'tel:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Link that opens in a new tab, with an external-link icon and a hidden hint. */
export function extLink(href, text, { className = 'link-ext', lang } = {}) {
  const url = safeHref(href);
  if (!url) return h('span', { class: className, text });
  return h(
    'a',
    { href: url, target: '_blank', rel: 'noopener noreferrer', class: className, lang },
    h('span', { text }),
    icon('external', { size: 16, className: 'icon-ext' }),
    h('span', { class: 'visually-hidden', text: ` ${t('common.newTab')}` }),
  );
}

export function levelMeta(level) {
  return LEVELS.find((l) => l.level === level) ?? UNKNOWN_LEVEL;
}

/** Visible pill with a coloured dot + text (colour never carries meaning alone). */
export function levelPill(level, text) {
  const meta = levelMeta(level);
  return h('span', { class: `pill pill-level lvl-${meta.key}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', { text }));
}

export function notice(kind, ...children) {
  return h('p', { class: `notice notice-${kind}` }, icon(kind === 'warn' ? 'alert' : 'info', { size: 20 }), h('span', {}, ...children));
}
