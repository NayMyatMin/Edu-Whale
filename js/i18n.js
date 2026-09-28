// i18n runtime: language + units state, dictionary lookup and every number /
// time formatter the page uses. Importable in Node (no DOM access at import
// time) so the formatting rules can be unit tested.
//
// Times about Yangon are always shown in Yangon time (UTC+06:30, labelled
// "MMT" from the dictionary). Burmese uses Burmese digits (၁၂၃) and
// dictionary day/month names, so it does not depend on the browser's ICU data.

import { KMH_TO_MPH, KM_TO_MI, KT_TO_KMH, MM_TO_IN } from './config.js';
import en from './i18n/en/index.js';
import my from './i18n/my/index.js';

export const LANGS = Object.freeze(['en', 'my']);
export const UNITS = Object.freeze(['metric', 'imperial']);

const DICTS = { en, my };
// en-US gives "Sep" (en-GB now prints "Sept"); English dates are assembled
// from parts in dayMonth() so the order is still "Mon 28 Sep".
const INTL_LOCALE = { en: 'en-US', my: 'my' };
const STORAGE_KEYS = { lang: 'ysw.lang', units: 'ysw.units' };
// Yangon is UTC+06:30 all year (Myanmar has no daylight saving time).
const YANGON_OFFSET_MIN = 390;

let lang = 'en';
let units = 'metric';
let devWarnings = false;
const langListeners = new Set();
const unitListeners = new Set();
const warned = new Set();
const formatCache = new Map();

// ---------------------------------------------------------------------------
// Storage (every access may throw: private mode, blocked storage)
// ---------------------------------------------------------------------------

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPref(key) {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writePref(key, value) {
  try {
    storage()?.setItem(key, value);
  } catch {
    /* preference simply is not remembered */
  }
}

function notify(listeners, value) {
  for (const cb of [...listeners]) {
    try {
      cb(value);
    } catch (err) {
      console.error('[i18n] listener failed', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Language & units state
// ---------------------------------------------------------------------------

/**
 * Pick the language (saved → browser language starting with "my" → English)
 * and units. Safe to call more than once.
 * @param {{navigatorLanguages?: string[], dev?: boolean}} [opts] overrides for tests
 * @returns {string} the language in use
 */
export function initI18n(opts = {}) {
  const saved = readPref(STORAGE_KEYS.lang);
  const nav = opts.navigatorLanguages ?? browserLanguages();
  lang = LANGS.includes(saved) ? saved : nav.some((l) => /^my\b/i.test(String(l)) || /^my-/i.test(String(l))) ? 'my' : 'en';
  const savedUnits = readPref(STORAGE_KEYS.units);
  units = UNITS.includes(savedUnits) ? savedUnits : 'metric';
  const host = globalThis.location?.hostname ?? '';
  devWarnings = opts.dev ?? (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  syncDocumentLang();
  return lang;
}

function browserLanguages() {
  const n = globalThis.navigator;
  if (!n) return [];
  // Only the primary preference counts: a Burmese speaker's phone set to
  // English with Burmese second should still get English first.
  return [n.language || (Array.isArray(n.languages) ? n.languages[0] : '') || ''];
}

function syncDocumentLang() {
  const root = globalThis.document?.documentElement;
  if (root) root.lang = lang;
}

export function getLang() {
  return lang;
}

/** Switch language, remember it and notify listeners. Unknown codes are ignored. */
export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return lang;
  lang = next;
  writePref(STORAGE_KEYS.lang, next);
  syncDocumentLang();
  notify(langListeners, lang);
  return lang;
}

/** @returns {() => void} unsubscribe */
export function onLangChange(cb) {
  langListeners.add(cb);
  return () => langListeners.delete(cb);
}

export function getUnits() {
  return units;
}

export function setUnits(next) {
  if (!UNITS.includes(next) || next === units) return units;
  units = next;
  writePref(STORAGE_KEYS.units, next);
  notify(unitListeners, units);
  return units;
}

/** @returns {() => void} unsubscribe */
export function onUnitsChange(cb) {
  unitListeners.add(cb);
  return () => unitListeners.delete(cb);
}

/**
 * Run `fn` with another language active (no persistence, no listeners),
 * e.g. to build share text in a language other than the page's.
 */
export function withLang(tempLang, fn) {
  if (!LANGS.includes(tempLang) || tempLang === lang) return fn();
  const prev = lang;
  lang = tempLang;
  try {
    return fn();
  } finally {
    lang = prev;
  }
}

/** Intl locale for the current language ('my' → Burmese digits). */
export function getIntlLocale(l = lang) {
  return INTL_LOCALE[l] ?? 'en-US';
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function lookup(key, l = lang) {
  const dict = DICTS[l];
  if (dict && Object.hasOwn(dict, key) && typeof dict[key] === 'string') return dict[key];
  if (l !== 'en' && Object.hasOwn(en, key) && typeof en[key] === 'string') return en[key];
  return undefined;
}

/** True when `key` exists in the current language or in English. */
export function hasKey(key) {
  return lookup(key) !== undefined;
}

function warnMissing(key) {
  if (!devWarnings || warned.has(key)) return;
  warned.add(key);
  console.warn(`[i18n] missing key: ${key}`);
}

function fill(text, params, format) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.hasOwn(params, name)) return match;
    const v = params[name];
    if (v === null || v === undefined) return '';
    return format(name, v);
  });
}

function plainParam(_name, v) {
  if (typeof v === 'number') return formatNumber(v, { maximumFractionDigits: 1 });
  if (v instanceof Date) return formatDateTime(v);
  if (typeof v === 'object') return pickLang(v);
  return String(v);
}

/** Tidy the gaps an empty parameter leaves ("89 km  of" → "89 km of"). */
function tidy(s) {
  return s
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:)၊။])/g, '$1')
    .trim();
}

/**
 * Display name for a storm. JTWC invest areas are named in English by the
 * parsers ("Invest 92W", "Invest area"); give them the translated label.
 */
export function systemName(name, tr = t) {
  const s = String(name ?? '').trim();
  const area = /^Invest area$/i.test(s);
  const m = area ? null : /^Invest\s+(\w+)$/i.exec(s);
  const key = area ? 'sys.investArea' : m ? 'sys.investName' : null;
  if (!key) return s;
  const out = tr(key, m ? { designation: m[1] } : undefined);
  // A translator that doesn't know the key (e.g. the map's fallback) returns it as is.
  return out && out !== key ? out : s;
}

/** List separator for the current language (Burmese uses the ၊ mark). */
export function listSep() {
  return lang === 'my' ? '၊ ' : ', ';
}

/** Sentence end for the current language (Burmese uses the ။ mark). */
export function sentenceEnd() {
  return lang === 'my' ? '။' : '.';
}

/**
 * Translate `key` in the current language (fallback: English, then the key
 * itself). `{name}` placeholders are filled from `params` as plain values.
 */
export function t(key, params) {
  const text = lookup(key);
  if (text === undefined) {
    warnMissing(key);
    return key;
  }
  return params ? fill(text, params, plainParam) : text;
}

/** Pick the current language from a `{en, my}` pair (falls back to the other one). */
export function pickLang(pair, l = lang) {
  if (pair == null) return '';
  if (typeof pair === 'string') return pair;
  if (typeof pair !== 'object') return String(pair);
  const first = pair[l];
  if (typeof first === 'string' && first.trim()) return first;
  const other = l === 'en' ? pair.my : pair.en;
  return typeof other === 'string' ? other : '';
}

// Parameter formatting by name (SPEC "Param naming convention").
const PARAM_FORMATS = {
  km: (v) => formatDistance(v),
  kmh: (v) => formatWind(v, { alt: true }),
  kt: (v) => formatWindKt(v),
  mm: (v) => formatRain(v),
  hpa: (v) => formatPressure(v),
  hours: (v) => formatNumber(Math.round(v)),
  time: (v) => formatWhen(v),
  name: (v) => systemName(v),
  compass: (v) => compassLabel(v),
  stage: (v) => t(`dmh.stage.${v}`),
  system: (v) => t(`dmh.system.${v}`),
  cls: (v) => t(String(v)),
  potential: (v) => t(`jtwc.potential.${v}`),
  type: (v) => t(`dmh.otherType.${v}`),
  title: (v) => pickLang(v),
  message: (v) => pickLang(v),
};

function namedParam(name, v) {
  const f = PARAM_FORMATS[name];
  if (f) {
    if (typeof v === 'number' && !Number.isFinite(v)) return '';
    return f(v);
  }
  return plainParam(name, v);
}

/** Like t(), but raw params are formatted by the naming convention (km, kmh, time, …). */
export function tFormat(key, params) {
  const text = lookup(key);
  if (text === undefined) {
    warnMissing(key);
    return '';
  }
  return tidy(fill(text, params ?? {}, namedParam));
}

/** Text for a risk.js Reason ({code, params}); '' when the code has no text. */
export function tReason(reason) {
  if (!reason || typeof reason.code !== 'string') return '';
  return tFormat(`reason.${reason.code}`, reason.params ?? {});
}

/**
 * Fill `data-i18n="key"` (textContent) and `data-i18n-attr="aria-label:key;title:key"`
 * under `root`. Elements whose key is unknown keep their static text.
 */
export function applyStaticTranslations(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  const nodes = [...root.querySelectorAll('[data-i18n],[data-i18n-attr]')];
  if (root.matches?.('[data-i18n],[data-i18n-attr]')) nodes.unshift(root);
  for (const el of nodes) {
    const key = el.getAttribute('data-i18n');
    if (key) {
      if (hasKey(key)) el.textContent = t(key);
      else warnMissing(key);
    }
    const attrs = el.getAttribute('data-i18n-attr');
    if (attrs) {
      for (const part of attrs.split(';')) {
        const [attr, k] = part.split(':').map((s) => s.trim());
        if (!attr || !k) continue;
        if (hasKey(k)) el.setAttribute(attr, t(k));
        else warnMissing(k);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Numbers & units
// ---------------------------------------------------------------------------

function nf(options) {
  const locale = getIntlLocale();
  const id = `n|${locale}|${JSON.stringify(options)}`;
  let f = formatCache.get(id);
  if (!f) {
    // Chrome has no 'my' locale data; the numbering system still gives Burmese digits.
    f = new Intl.NumberFormat(locale, lang === 'my' ? { ...options, numberingSystem: 'mymr' } : options);
    formatCache.set(id, f);
  }
  return f;
}

/** Locale number (Burmese digits in 'my'); '–' for non-numbers. */
export function formatNumber(n, options = { maximumFractionDigits: 0 }) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  return nf(options).format(n);
}

const unitLabel = (k) => t(`unit.${k}`);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Wind speed in the chosen unit; `{alt:true}` adds the other unit in brackets. */
export function formatWind(kmh, { alt = false } = {}) {
  if (!isNum(kmh)) return '–';
  const k = `${formatNumber(Math.round(kmh))} ${unitLabel('kmh')}`;
  const m = `${formatNumber(Math.round(kmh * KMH_TO_MPH))} ${unitLabel('mph')}`;
  const [main, other] = units === 'imperial' ? [m, k] : [k, m];
  return alt ? `${main} (${other})` : main;
}

/** Storm wind given in knots: always with the second unit (DMH speaks mph). */
export function formatWindKt(kt) {
  return isNum(kt) ? formatWind(kt * KT_TO_KMH, { alt: true }) : '–';
}

/** Distances carry tens of km of uncertainty: round to 10 above 100. */
export function formatDistance(km) {
  if (!isNum(km)) return '–';
  const v = units === 'imperial' ? km * KM_TO_MI : km;
  const r = v >= 100 ? Math.round(v / 10) * 10 : Math.round(v);
  return `${formatNumber(r)} ${unitLabel(units === 'imperial' ? 'mi' : 'km')}`;
}

export function formatRain(mm) {
  if (!isNum(mm)) return '–';
  if (units === 'imperial') {
    const inch = mm * MM_TO_IN;
    const digits = inch < 1 ? 2 : 1;
    return `${formatNumber(inch, { minimumFractionDigits: 0, maximumFractionDigits: digits })} ${unitLabel('in')}`;
  }
  const digits = mm < 10 ? 1 : 0;
  return `${formatNumber(mm, { minimumFractionDigits: 0, maximumFractionDigits: digits })} ${unitLabel('mm')}`;
}

export function formatTemp(c) {
  if (!isNum(c)) return '–';
  return `${formatNumber(Math.round(c))}${unitLabel('c')}`;
}

export function formatPressure(hpa) {
  if (!isNum(hpa)) return '–';
  return `${formatNumber(Math.round(hpa), { maximumFractionDigits: 0, useGrouping: false })} ${unitLabel('hpa')}`;
}

export function formatPercent(p) {
  if (!isNum(p)) return '–';
  return `${formatNumber(Math.round(p))}${unitLabel('percent')}`;
}

/** Wind in the display unit as a bare number (charts, tables). */
export function windValue(kmh) {
  if (!isNum(kmh)) return null;
  return units === 'imperial' ? kmh * KMH_TO_MPH : kmh;
}

export function rainValue(mm) {
  if (!isNum(mm)) return null;
  return units === 'imperial' ? mm * MM_TO_IN : mm;
}

export function windUnitLabel() {
  return unitLabel(units === 'imperial' ? 'mph' : 'kmh');
}

export function rainUnitLabel() {
  return unitLabel(units === 'imperial' ? 'in' : 'mm');
}

export function compassLabel(code) {
  return code ? t(`dir.${code}`) : '';
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------
// Built from the dictionary and plain Date arithmetic rather than ICU:
// Chrome ships no Burmese ('my') date data, so Intl would print English
// month names and Latin digits. Myanmar has no daylight saving time, so
// Yangon time is always UTC+06:30.

function toDate(d) {
  if (d instanceof Date) return Number.isFinite(d.getTime()) ? d : null;
  if (typeof d === 'string' || typeof d === 'number') {
    const x = new Date(d);
    return Number.isFinite(x.getTime()) ? x : null;
  }
  return null;
}

const BURMESE_DIGITS = '၀၁၂၃၄၅၆၇၈၉';

/** Latin digits → Burmese digits in Burmese mode (display only; tel: links keep Latin digits). */
export function localDigits(str) {
  return lang === 'my' ? String(str).replace(/[0-9]/g, (c) => BURMESE_DIGITS[c]) : String(str);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Calendar/clock fields of `x` in Yangon (fixed UTC+06:30). */
function yangonFields(x) {
  const y = new Date(x.getTime() + YANGON_OFFSET_MIN * 60e3);
  return { year: y.getUTCFullYear(), month: y.getUTCMonth(), day: y.getUTCDate(), weekday: y.getUTCDay(), hour: y.getUTCHours(), minute: y.getUTCMinutes() };
}

/** The same fields on the viewer's own clock. */
function localFields(x) {
  return { year: x.getFullYear(), month: x.getMonth(), day: x.getDate(), weekday: x.getDay(), hour: x.getHours(), minute: x.getMinutes() };
}

function weekdayName(f, long = false) {
  return t(`time.${long ? 'weekdayLong' : 'weekday'}.${f.weekday}`);
}

function dayMonthText(f, long = false) {
  return t(long ? 'time.dayMonthLong' : 'time.dayMonth', {
    weekday: weekdayName(f, long),
    day: localDigits(f.day),
    month: t(`time.${long ? 'monthLong' : 'month'}.${f.month}`),
  });
}

const clock = (f) => localDigits(`${pad2(f.hour)}:${pad2(f.minute)}`);

/** "20:52" in Yangon. */
export function formatTime(d) {
  const x = toDate(d);
  return x ? clock(yangonFields(x)) : '–';
}

/** Hour of day in Yangon for axis ticks: "06", "18". */
export function formatHour(d) {
  const x = toDate(d);
  return x ? localDigits(pad2(yangonFields(x).hour)) : '';
}

/** "Mon 28 Sep" (Yangon calendar day). `{long:true}` → "Monday 28 September"; `{weekdayOnly:true}` → "Mon". */
export function formatDay(d, { long = false, weekdayOnly = false } = {}) {
  const x = toDate(d);
  if (!x) return '–';
  const f = yangonFields(x);
  return weekdayOnly ? weekdayName(f, long) : dayMonthText(f, long);
}

/** "Mon 28 Sep, 20:52" in Yangon. */
export function formatDateTime(d) {
  const x = toDate(d);
  if (!x) return '–';
  const f = yangonFields(x);
  return t('time.dateTime', { day: dayMonthText(f), time: clock(f) });
}

/** "2026-09-28" for the Yangon calendar day of `d`. */
export function yangonDateKey(d) {
  const x = toDate(d);
  if (!x) return '';
  return new Date(x.getTime() + YANGON_OFFSET_MIN * 60e3).toISOString().slice(0, 10);
}

/** "today 19:00" / "tomorrow 04:00" / "Wed 1 Oct 14:00" relative to `now`, Yangon time. */
export function formatWhen(d, now = new Date()) {
  const x = toDate(d);
  if (!x) return '–';
  const dayDiff = Math.round((Date.parse(yangonDateKey(x)) - Date.parse(yangonDateKey(now))) / 86400e3);
  const f = yangonFields(x);
  const time = clock(f);
  if (dayDiff === 0) return t('time.todayAt', { time });
  if (dayDiff === 1) return t('time.tomorrowAt', { time });
  if (dayDiff === -1) return t('time.yesterdayAt', { time });
  return t('time.dayAt', { day: dayMonthText(f), time });
}

function pluralCategory(n) {
  try {
    return new Intl.PluralRules(lang === 'my' ? 'my' : 'en').select(n) === 'one' ? 'one' : 'other';
  } catch {
    return n === 1 ? 'one' : 'other';
  }
}

/** "4 minutes ago" / "in 3 hours" / "just now" (dictionary templates, so Burmese can be translated). */
export function formatRelative(d, now = new Date()) {
  const x = toDate(d);
  const ref = toDate(now);
  if (!x || !ref) return '–';
  const diffMs = x.getTime() - ref.getTime();
  const abs = Math.abs(diffMs);
  if (abs < 60e3) return t('time.justNow');
  const [unit, size] = abs < 3600e3 ? ['minute', 60e3] : abs < 48 * 3600e3 ? ['hour', 3600e3] : ['day', 86400e3];
  const n = Math.round(abs / size);
  return t(`time.rel.${unit}.${diffMs < 0 ? 'past' : 'future'}.${pluralCategory(n)}`, { n: formatNumber(n) });
}

/** Viewer's own clock: "16:22" (adds the weekday when their date differs from Yangon's). */
export function formatLocalTime(d) {
  const x = toDate(d);
  if (!x) return '–';
  const f = localFields(x);
  const time = clock(f);
  const y = yangonFields(x);
  if (f.day === y.day && f.month === y.month) return time;
  return t('time.localDayTime', { day: weekdayName(f), time });
}

/** True when the viewer's clock already shows Yangon time (no "Your time" needed). */
export function isViewerInYangon(now = new Date()) {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (zone === 'Asia/Yangon' || zone === 'Asia/Rangoon') return true;
  } catch {
    /* fall through to the offset check */
  }
  return -toDate(now).getTimezoneOffset() === YANGON_OFFSET_MIN;
}

/** Keys in English that the given language does not translate yet (translation helper). */
export function missingTranslations(l = 'my') {
  const dict = DICTS[l] ?? {};
  return Object.keys(en).filter((k) => !Object.hasOwn(dict, k));
}
