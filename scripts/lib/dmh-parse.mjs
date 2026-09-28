// Pure parsers for the DMH Myanmar website (www.moezala.gov.mm): RSS feeds,
// listing pages and bulletin pages in, plain objects out. No I/O here so the
// whole pipeline can be tested against the captured fixtures.
//
// Site facts this relies on (checked 2026-09-28):
// - Drupal 9. Node URLs look like /<lang>/<type>/<id>, type one of warning,
//   news, top-announcement, bulletin, forecast. /index.php/ may prefix them.
// - Cyclone bulletins titled "Warning" live under /warning/ (Myanmar is
//   threatened); "News" under /news/ (it is not). "... Condition" posts
//   appear under both, and DMH also files "Nothing Special" nil notices
//   titled "Cyclone Warning" / "Cyclone News": the title and body decide the
//   kind, not the URL.
// - The EN RSS feed repeats shared nodes with their Burmese <title> but the
//   English body, and links them under /my/; the English title is the first
//   `field-name-title` span inside the description.
// - Warnings/news carry the official issue time in a
//   `field-name-field-{warning,news,bulletin}-post-date` <time datetime> (UTC).
//   Node ids follow upload order, not issue order.

import { HOME } from '../../js/config.js';
import { rankDmhBulletins } from '../../js/dmh.js';

export const DMH_ORIGIN = 'https://www.moezala.gov.mm';
export const GENERATOR = 'scripts/fetch-dmh.mjs';
export const SUMMARY_MAX_CHARS = 900;
export const RECENT_MAX = 6;

const KNOWN_KINDS = new Set(['warning', 'news', 'top-announcement', 'bulletin', 'forecast']);
const STAGES = ['yellow', 'orange', 'red', 'brown', 'green'];
const STAGE_MY = { အဝါ: 'yellow', လိမ္မော်: 'orange', အနီ: 'red', အညို: 'brown', အစိမ်း: 'green' };
const MYANMAR_SCRIPT = /[\u1000-\u109f]/;
const LATIN_WORD = /[A-Za-z]{3,}/;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', deg: '°', middot: '·',
  zwnj: '\u200c', zwj: '\u200d', shy: '\u00ad', bull: '•', times: '×',
};

/** Decode HTML/XML character references in one pass (so "&amp;nbsp;" -> "&nbsp;"). */
export function decodeEntities(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const named = NAMED_ENTITIES[ref.toLowerCase()];
    return named ?? m;
  });
}

// Zero-width space/non-joiner, soft hyphen and BOM: DMH copy-pastes them
// into Burmese text where they break searching and matching.
const INVISIBLE = /[\u200b\u200c\u00ad\ufeff]/g;

/**
 * Single-line clean-up: invisible characters removed, whitespace collapsed,
 * NFC-normalised (DMH types "င့်" as U+103A U+1037; NFC puts the marks in
 * canonical order so Burmese patterns match however it was typed).
 */
export function cleanText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(INVISIBLE, '').replace(/[\s\u00a0]+/g, ' ').trim().normalize('NFC');
}

/** Strip tags and decode entities from an inline HTML fragment (one line). */
export function inlineText(html) {
  if (typeof html !== 'string') return '';
  return cleanText(decodeEntities(html.replace(/<[^>]*>/g, '')));
}

const BLOCK_TAG = /<\/?(?:p|div|h[1-6]|li|ul|ol|tr|table|tbody|thead|section|article|header|footer|blockquote|main|aside|nav)\b[^>]*>/gi;

/**
 * HTML -> plain text that keeps paragraph structure: one paragraph per line
 * (joined with "\n"), each line cleaned, empty lines dropped.
 */
export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  const s = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(BLOCK_TAG, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(s)
    .split('\n')
    .map(cleanText)
    .filter(Boolean)
    .join('\n');
}

/** Burmese digits -> ASCII. Also fixes the letter ဝ typed for the digit ၀ inside numbers. */
export function burmeseDigitsToAscii(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/(?<=[\u1040-\u1049])\u101d|\u101d(?=[\u1040-\u1049])/g, '\u1040')
    .replace(/[\u1040-\u1049]/g, (d) => String(d.charCodeAt(0) - 0x1040));
}

/** Any date string -> "YYYY-MM-DDTHH:MM:SSZ", or null. */
export function toIso(value) {
  if (value == null || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function unwrapCdata(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? { text: m[1], cdata: true } : { text: s, cdata: false };
}

function xmlField(xml, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return '';
  const { text, cdata } = unwrapCdata(m[1]);
  return cdata ? text : decodeEntities(text);
}

function isBurmese(s) {
  return MYANMAR_SCRIPT.test(s) && !LATIN_WORD.test(s.replace(/\([^)]*\)/g, ''));
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Absolute DMH URL with /index.php removed, or null for non-http(s) links. */
export function normalizeUrl(href, base = DMH_ORIGIN) {
  if (typeof href !== 'string' || !href.trim()) return null;
  let u;
  try {
    u = new URL(decodeEntities(href.trim()), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  u.pathname = u.pathname.replace(/^\/index\.php(?=\/)/, '');
  u.hash = '';
  return u.href;
}

function pathInfo(url) {
  const abs = normalizeUrl(url);
  if (!abs) return null;
  const m = /^\/(?:(en|my)\/)?([a-z-]+)\/(\d+)\/?$/.exec(new URL(abs).pathname);
  return m ? { lang: m[1] || null, type: m[2], id: m[3] } : null;
}

/** 'warning' | 'news' | 'top-announcement' | 'bulletin' | 'forecast' | 'other' */
export function classifyLink(url) {
  const info = pathInfo(url);
  return info && KNOWN_KINDS.has(info.type) ? info.type : 'other';
}

export function nodeIdFromUrl(url) {
  return pathInfo(url)?.id ?? null;
}

/** Both language versions of a DMH node URL (DMH serves the same node under /en/ and /my/). */
export function langUrls(url) {
  const info = pathInfo(url);
  if (!info) {
    const abs = normalizeUrl(url);
    return { en: abs, my: abs };
  }
  return {
    en: `${DMH_ORIGIN}/en/${info.type}/${info.id}`,
    my: `${DMH_ORIGIN}/my/${info.type}/${info.id}`,
  };
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const CYCLONE_TITLE_EN = /\b(?:low[\s-]+pressure|depression|cyclon\w*|storm|typhoon)\b/i;
const CYCLONE_TITLE_MY = /လေဖိအားနည်း|မုန်တိုင်း|ဆိုင်ကလုန်း/;
const NOT_CYCLONE_MY = /မိုးသက်မုန်တိုင်း|မိုးကြိုးမုန်တိုင်း/; // thunderstorm

/** Clean text with run-together words split: DMH sometimes titles "WellMarkedLowPressureAreaCondition". */
export function titleWords(s) {
  return cleanText(s).replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** True for titles about lows, depressions and cyclones (either language). */
export function isCycloneTitle(title) {
  const t = titleWords(title);
  if (!t) return false;
  if (CYCLONE_TITLE_EN.test(t)) return true;
  return CYCLONE_TITLE_MY.test(t) && !NOT_CYCLONE_MY.test(t);
}

// Most specific first: several names contain shorter ones. Western Pacific
// names map to the nearest IMD class (typhoon ≈ very severe cyclonic storm).
// A bare "Cyclone Warning" / "Cyclone News" (DMH's generic, often nil,
// notice) names no system.
const SYSTEM_RULES = [
  ['sucs', /super\s+cyclonic|super\s+typhoon/i, /စူပါ\s*ဆိုင်ကလုန်း/],
  ['escs', /extremely\s+severe/i, /အလွန့်\s*အလွန်\s*အားကောင်းသော\s*ဆိုင်ကလုန်း/],
  ['vscs', /very\s+severe|\btyphoon\b/i, /(?:အားအလွန်ကောင်းသော|အလွန်အားကောင်းသော)\s*ဆိုင်ကလုန်း|တိုင်ဖွန်း/],
  ['scs', /severe\s+cyclonic|severe\s+tropical\s+storm/i, /အားကောင်းသော\s*ဆိုင်ကလုန်း/],
  ['cs', /cyclonic\s+storm|\btropical\s+storm\b|\bcyclone\b(?!\s+(?:warning|news)\b)/i, /ဆိုင်ကလုန်း/],
  ['deep-depression', /deep\s+depression/i, /အားကောင်းသော\s*မုန်တိုင်းငယ်/],
  ['depression', /depression/i, /မုန်တိုင်းငယ်/],
  ['well-marked-low', /well[\s-]*marked\s+low/i, /အားကောင်းသော\s*လေဖိအားနည်း/],
  ['low', /low[\s-]+pressure/i, /လေဖိအားနည်း/],
];

/** DMH system key from a bulletin title (EN or MY), or null. */
export function systemFromTitle(title) {
  const t = titleWords(title);
  if (!t) return null;
  for (const [key, en, my] of SYSTEM_RULES) if (en.test(t) || my.test(t)) return key;
  return null;
}

/**
 * 'warning' | 'news' from a bulletin's titles (DMH files "… Condition" posts
 * and nil notices under either path), else the URL's type.
 */
export function kindFromTitles(titleEn, titleMy, pathKind = null) {
  const en = titleWords(titleEn);
  if (/\bwarning\b/i.test(en)) return 'warning';
  if (/\b(?:news|condition)\b/i.test(en)) return 'news';
  const my = cleanText(titleMy);
  if (/သတိပေးချက်/.test(my)) return 'warning';
  if (/အခြေအနေ|သတင်း/.test(my)) return 'news';
  return pathKind === 'warning' || pathKind === 'news' ? pathKind : null;
}

/**
 * DMH's nil notice: a "Cyclone Warning" / "Cyclone News" whose whole text is
 * "Nothing Special" (Burmese "မရှိပါ"). `text` is a body (one paragraph per
 * line; an RSS copy starts with the title and "Issued at" lines).
 */
export function isNilCycloneBody(text, title = '') {
  const t0 = cleanText(title);
  const lines = String(text ?? '')
    .split('\n')
    .map(cleanText)
    .filter((l) => l && l !== t0 && !(META_LINE.test(l) && l.length < 120));
  const t = lines.join(' ');
  if (!t || t.length > 200) return false;
  return /\bnothing\s+special\b/i.test(t) || /^မရှိပါ/.test(t) || isNilBulletin(t);
}

/** {number, year} from "Deep Depression Warning, No.3, 2026" or "…အမှတ်စဉ်(၀၃/၂၀၂၆)". */
export function numberFromTitle(title) {
  const t = burmeseDigitsToAscii(cleanText(title));
  let m = /\bNo\s*\.?\s*\(?\s*(\d{1,3})\s*\)?\s*(?:[,/]\s*(\d{4}))?/i.exec(t);
  if (!m) m = /\(\s*(\d{1,3})\s*\/\s*(\d{4})\s*\)/.exec(t);
  if (!m) return { number: null, year: null };
  return { number: Number(m[1]), year: m[2] ? Number(m[2]) : null };
}

// ---------------------------------------------------------------------------
// RSS
// ---------------------------------------------------------------------------

function firstTimeAfter(html, markerRe) {
  const m = markerRe.exec(html);
  if (!m) return null;
  const t = /<time\b[^>]*\bdatetime="([^"]+)"/i.exec(html.slice(m.index));
  return t ? toIso(t[1]) : null;
}

const POST_DATE_MARKER = /field-name-field-[a-z-]*post-date/i;
const CREATED_MARKER = /field-name-created\b/i;
const BODY_MARKER = /<div\b[^>]*class="[^"]*\bfield-name-body\b[^"]*"[^>]*>/i;
const TITLE_SPAN = /<span\b[^>]*class="[^"]*\bfield-name-title\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i;

function bodyHtmlOf(html) {
  const m = BODY_MARKER.exec(html);
  return m ? html.slice(m.index + m[0].length) : '';
}

/**
 * Items of a DMH RSS feed.
 * @returns {Array<{title:string, link:string|null, pubDate:string|null, createdIso:string|null,
 *   postIso:string|null, bodyTitle:string, bodyText:string, id:string|null, kind:string}>}
 */
export function parseRssItems(xml) {
  if (typeof xml !== 'string') return [];
  const out = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const itemXml = m[1];
    const html = xmlField(itemXml, 'description');
    const link = normalizeUrl(cleanText(xmlField(itemXml, 'link')));
    const titleSpan = TITLE_SPAN.exec(html);
    out.push({
      title: cleanText(xmlField(itemXml, 'title')),
      link,
      pubDate: cleanText(xmlField(itemXml, 'pubDate')) || null,
      createdIso: firstTimeAfter(html, CREATED_MARKER),
      postIso: firstTimeAfter(html, POST_DATE_MARKER),
      bodyTitle: titleSpan ? inlineText(titleSpan[1]) : '',
      bodyText: htmlToText(bodyHtmlOf(html)),
      id: link ? nodeIdFromUrl(link) : null,
      kind: link ? classifyLink(link) : 'other',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Listing and bulletin pages
// ---------------------------------------------------------------------------

/**
 * Bulletin links on a DMH listing page (home page teasers or the
 * cyclone-news view), in page order, one entry per URL.
 * @returns {Array<{url, id, kind, lang, title, postIso: string|null, teaser: string}>}
 */
export function parseListingLinks(html, baseUrl = DMH_ORIGIN) {
  if (typeof html !== 'string') return [];
  const rows = html.split(/<div class="views-row">/i);
  const byUrl = new Map();
  rows.forEach((row, rowIndex) => {
    let firstInRow = true;
    for (const a of row.matchAll(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = normalizeUrl(a[1], baseUrl);
      const info = url && pathInfo(url);
      if (!info || !KNOWN_KINDS.has(info.type)) continue;
      const title = inlineText(a[2]);
      const readMore = /^read more\b/i.test(title);
      let entry = byUrl.get(url);
      if (!entry) {
        entry = { url, id: info.id, kind: info.type, lang: info.lang, title: '', postIso: null, teaser: '' };
        byUrl.set(url, entry);
      }
      if (!entry.title && !readMore) entry.title = title;
      // Row metadata belongs to the row's first bulletin link (the title);
      // the last row also swallows the page footer, so only the first counts.
      if (firstInRow && rowIndex > 0) {
        entry.postIso ??= firstTimeAfter(row, /field-[a-z-]*post-date/i);
        if (!entry.teaser) entry.teaser = htmlToText(bodyHtmlOf(row).split(/<div\b[^>]*class="[^"]*\bnode__links\b/i)[0]).replace(/\n/g, ' ');
        firstInRow = false;
      }
    }
  });
  return [...byUrl.values()];
}

/** Title, official post date and body text of a single bulletin page, or null. */
export function extractBulletinPage(html) {
  if (typeof html !== 'string') return null;
  const start = html.search(/<article\b[^>]*\bnode--view-mode-full\b/i);
  const from = start >= 0 ? start : html.search(/<article\b/i);
  if (from < 0) return null;
  const end = html.indexOf('</article>', from);
  const article = html.slice(from, end > from ? end : undefined);
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(article);
  let title = h1 ? inlineText(h1[1]) : '';
  if (!title) {
    const t = /<title>([\s\S]*?)<\/title>/i.exec(html);
    title = t ? inlineText(t[1]).replace(/\s*\|\s*Department of Meteorology and Hydrology\s*$/i, '') : '';
  }
  return {
    title,
    postIso: firstTimeAfter(article, POST_DATE_MARKER),
    bodyText: htmlToText(bodyHtmlOf(article)),
  };
}

// ---------------------------------------------------------------------------
// Bulletin body sections
// ---------------------------------------------------------------------------

// EN headings seen in DMH warnings/news. `rest` after a heading is kept as
// content when a heading and its paragraph share one line.
// DMH's 2023 bulletins bracket their numbers: "During next (32) hours forecast".
const EN_HEADINGS = [
  ['position', /^position of\b[^.]{0,80}?\b(?:wind|winds|pressure)\b\s*[:.\-–]?\s*/i],
  ['forecast', /^(?:(?:during\s+)?(?:the\s+)?next\s*\(?\s*\d+\s*\)?\s*(?:hours|hrs)\.?\s*forecast|forecast\s+for\s+(?:the\s+)?next\s*\(?\s*\d+\s*\)?\s*(?:hours|hrs)\.?)\s*[:.\-–]?\s*/i],
  ['caution', /^(?:general\s+)?caution\s*[:.\-–]?\s*/i],
  ['advisory', /^(?:advisory|advice)\s*[:.\-–]?\s*/i],
];
// Burmese headings are matched by their words first, with an optional
// letter enumerator: the letters shift between bulletins ((ဃ) or (ဂ) can be
// the caution heading), so the letter alone is only the last resort.
const MY_ENUM = String.raw`(?:\(\s*[က-အ]\s*\)\s*)?`;
const MY_HEADINGS = [
  ['caution', new RegExp(`^${MY_ENUM}သတိပေးနှိုးဆော်ချက်\\s*`)],
  ['advisory', new RegExp(`^${MY_ENUM}အကြံပြုချက်\\s*`)],
  ['forecast', new RegExp(`^${MY_ENUM}နောက်\\s*\\(?\\s*[\\d၀-၉]+\\s*\\)?\\s*နာရီအတွင်း\\s*ခန့်မှန်းချက်\\s*`)],
  ['position', new RegExp(`^${MY_ENUM}\\S*တည်နေရာ`)],
  ['condition', /^\(\s*က\s*\)\s*/],
  ['position', /^\(\s*ခ\s*\)\s*/],
  ['forecast', /^\(\s*ဂ\s*\)\s*/],
];
const META_LINE = /^(?:issued at\b|ထုတ်ပြန်ချက်$)|မြန်မာစံတော်ချိန်\s*[\d၀-၉:]+\s*နာရီအချိန်\s*ထုတ်ပြန်ချက်$|\b(?:warning|news)\s*,?\s*no\s*\.?\s*\d+|အမှတ်စဉ်\s*\(/i;

function headingOf(line) {
  for (const [key, re] of [...EN_HEADINGS, ...MY_HEADINGS]) {
    const m = re.exec(line);
    if (!m) continue;
    let rest = line.slice(m[0].length).trim();
    // "(က) အားကောင်းသောမုန်တိုင်းငယ်အခြေအနေ": the rest is the heading's own text.
    if (rest && rest.length < 80 && !/[.။]/.test(rest)) rest = '';
    return { key, rest };
  }
  const cond = /^((?:[\w-]+\s+){0,5}conditions?)\s*[:.\-–]?\s*(.*)$/i.exec(line);
  if (cond && (!cond[2] || /^according\b/i.test(cond[2]))) return { key: 'condition', rest: cond[2] };
  return null;
}

/**
 * Split a bulletin body (one paragraph per line) into
 * {preamble, condition, position, forecast, caution, advisory} paragraph lists.
 */
export function splitSections(bodyText) {
  const sections = { preamble: [], condition: [], position: [], forecast: [], caution: [], advisory: [] };
  let current = 'preamble';
  for (const raw of String(bodyText || '').split('\n')) {
    const line = cleanText(raw);
    if (!line) continue;
    const h = headingOf(line);
    if (h) {
      current = h.key;
      if (h.rest) sections[current].push(stripEnumerator(h.rest));
      continue;
    }
    if (META_LINE.test(line) && line.length < 120) continue;
    sections[current].push(stripEnumerator(line));
  }
  // Unstructured body: treat everything as the condition text.
  if (!sections.condition.length && !sections.forecast.length && !sections.position.length) {
    sections.condition = sections.preamble;
    sections.preamble = [];
  }
  return sections;
}

function stripEnumerator(s) {
  return s.replace(/^\(\s*[\d၀-၉]{1,2}\s*\)\s*/, '');
}

function sentencesOf(text) {
  return text
    .split(/(?<=။)\s*|(?<=[.!?])\s+(?=[A-Z("“])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Cut `text` to ≤ max chars at a sentence (or word) boundary, marking the cut with "…". */
export function truncateText(text, max) {
  if (!text || max <= 1) return '';
  if (text.length <= max) return text;
  let out = '';
  for (const s of sentencesOf(text)) {
    const next = out ? `${out} ${s}` : s;
    if (next.length + 2 > max) break;
    out = next;
  }
  if (out) return `${out} …`;
  // No whole sentence fits: cut at a space or Burmese comma (၊), else at a
  // character boundary that does not split a Burmese syllable.
  const cut = text.slice(0, max - 1);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('၊') + 1);
  if (at > max * 0.5) return `${cut.slice(0, at).trim()}…`;
  let safe = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(cut)) {
    if (safe.length + segment.length > max - 1) break;
    safe += segment;
  }
  return `${safe.replace(/[\u1039\u103a]+$/, '').trim()}…`;
}

/** Condition + forecast + caution paragraphs, ≤ SUMMARY_MAX_CHARS, forecast never squeezed out. */
export function buildSummary(sections, max = SUMMARY_MAX_CHARS) {
  const join = (list) => list.join(' ').trim();
  const sep = '\n\n';
  const forecast = truncateText(join(sections.forecast), Math.min(360, max));
  let room = max - (forecast ? forecast.length + sep.length : 0);
  const condition = truncateText(join(sections.condition), room);
  room -= condition ? condition.length + sep.length : 0;
  const caution = room >= 80 ? truncateText(join(sections.caution), room) : '';
  return [condition, forecast, caution].filter(Boolean).join(sep);
}

// ---------------------------------------------------------------------------
// Cyclone bulletins
// ---------------------------------------------------------------------------

function num(s) {
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function inRange(n, lo, hi) {
  return n != null && n >= lo && n <= hi ? n : null;
}

const STAGE_RANK = { green: 0, yellow: 1, orange: 2, red: 3, brown: 4 };
const STAGE_WORD_EN = String.raw`(yellow|orange|red|brown|green)`;
const STAGE_WORD_MY = '(အဝါ|လိမ္မော်|အနီ|အညို|အစိမ်း)';
const MY_LETTERS = /(?<=[က-႟])\s+(?=[က-႟])/g;

/**
 * DMH colour stage and whether it applies to Yangon. Late in a storm DMH
 * codes stages per region ("the present stage for Sagaing … is coded brown
 * stage … for Rakhine and Chin States is coded green stage"): a clause
 * naming Yangon wins; if the stages are scoped to other regions only, the
 * most severe is kept for display with `scope: 'other-regions'`. Several
 * unscoped stages: the most severe (a later "red" never loses to an earlier
 * "green"). Burmese words split by a line-wrap space still match.
 * @returns {{stage: string|null, scope: 'yangon'|'other-regions'|null}}
 */
function parseStage(en, myAscii) {
  const scoped = [];
  const unscoped = [];
  for (const sentence of sentencesOf(en)) {
    for (const m of sentence.matchAll(new RegExp(String.raw`stage\s+for\s+(.+?)\s+(?:is|are)\s+(?:coded|designated)\s+(?:as\s+)?(?:the\s+)?["'“‘]?\s*${STAGE_WORD_EN}\b`, 'gi'))) {
      scoped.push({ stage: m[2].toLowerCase(), yangon: YANGON_EN.test(m[1]) });
    }
    const any = [
      ...sentence.matchAll(new RegExp(String.raw`coded\s+as\s+(?:the\s+)?["'“‘]?\s*${STAGE_WORD_EN}\b`, 'gi')),
      ...sentence.matchAll(new RegExp(String.raw`\b${STAGE_WORD_EN}\s+(?:emergency\s+|condition\s+)?stage\b`, 'gi')),
    ];
    if (!/stage\s+for\s+/i.test(sentence)) for (const m of any) unscoped.push(m[1].toLowerCase());
  }
  const my = String(myAscii || '').replace(MY_LETTERS, '');
  for (const sentence of my.split('။')) {
    const m = new RegExp(`${STAGE_WORD_MY}ရောင်(?:အဆင့်|အရေးပေါ်)?`).exec(sentence);
    if (!m) continue;
    const stage = STAGE_MY[m[1]];
    // "ရန်ကုန်…တို့ကို … အညိုရောင်အဆင့်": a Burmese sentence that lists regions before the stage.
    const regions = sentence.slice(0, m.index);
    if (/တိုင်းဒေသကြီး|ပြည်နယ်/.test(regions) && /(?:တို့ကို|တို့အတွက်|အတွက်)/.test(regions)) scoped.push({ stage, yangon: YANGON_MY.test(regions), my: true });
    else unscoped.push(stage);
  }
  const worst = (list) => list.reduce((a, b) => (a === null || STAGE_RANK[b] > STAGE_RANK[a] ? b : a), null);
  const forYangon = scoped.filter((c) => c.yangon).map((c) => c.stage);
  if (forYangon.length) return { stage: worst(forYangon), scope: 'yangon' };
  if (unscoped.length) return { stage: worst(unscoped), scope: null };
  if (scoped.length) return { stage: worst(scoped.map((c) => c.stage)), scope: 'other-regions' };
  return { stage: null, scope: null };
}

// DMH's 2023 bulletins bracket every number: "Latitude (20.0) degree North", "(944) hPa", "(120-130) miles per hour".
function parsePosition(en, myAscii) {
  const m = /Latitude\s*\(?\s*([\d.]+)\s*\)?\s*°?\s*(?:degrees?)?\s*(North|South|N|S)\b[\s\S]{0,40}?Longitude\s*\(?\s*([\d.]+)\s*\)?\s*°?\s*(?:degrees?)?\s*(East|West|E|W)\b/i.exec(en);
  if (m) {
    const lat = inRange(num(m[1]), 0, 90);
    const lon = inRange(num(m[3]), 0, 180);
    if (lat != null && lon != null) return { lat: /^s/i.test(m[2]) ? -lat : lat, lon: /^w/i.test(m[4]) ? -lon : lon };
  }
  const y = /(မြောက်|တောင်)\s*လတ္တီကျု\s*\(?\s*([\d.]+)\s*\)?\s*ဒီဂရီ[\s\S]{0,40}?(အရှေ့|အနောက်)\s*လောင်ဂျီကျု\s*\(?\s*([\d.]+)/.exec(myAscii);
  if (y) {
    const lat = inRange(num(y[2]), 0, 90);
    const lon = inRange(num(y[4]), 0, 180);
    if (lat != null && lon != null) return { lat: y[1] === 'တောင်' ? -lat : lat, lon: y[3] === 'အနောက်' ? -lon : lon };
  }
  return { lat: null, lon: null };
}

function parsePressure(enPos, en, myAscii) {
  for (const s of [enPos, en]) {
    const m = /\(?(\d{3,4})\)?\s*hPa\b/i.exec(s);
    if (m) return inRange(num(m[1]), 850, 1050);
  }
  const y = /\(?(\d{3,4})\)?\s*ဟက်တိုပါစကယ်/.exec(myAscii);
  return y ? inRange(num(y[1]), 850, 1050) : null;
}

function windResult(text, a, b) {
  const lo = inRange(num(a), 0, 300);
  const hi = b != null ? inRange(num(b), 0, 300) : lo;
  if (lo == null) return null;
  return { min: Math.min(lo, hi ?? lo), max: Math.max(lo, hi ?? lo), text: cleanText(text) };
}

function parseWind(enPos, en, myPosAscii) {
  let m = /\(?(\d{1,3})\)?(?:\s*(?:-|–|to)\s*\(?(\d{1,3})\)?)?\s*(?:miles\s+per\s+hour|mph)\b/i.exec(enPos);
  if (!m) m = /\(?(\d{1,3})\)?(?:\s*(?:-|–|to)\s*\(?(\d{1,3})\)?)?\s*miles\s+per\s+hour/i.exec(en);
  if (m) return windResult(`${m[1]}${m[2] ? `-${m[2]}` : ''} mph`, m[1], m[2]);
  const y = /တစ်နာရီ(?:လျှင်|ကို)\s*(?:မိုင်\s*)?\(?(\d{1,3})\)?\s*(?:မိုင်)?(?:\s*မှ\s*(?:မိုင်\s*)?\(?(\d{1,3}))?/.exec(myPosAscii);
  return y ? windResult(`${y[1]}${y[2] ? `-${y[2]}` : ''} mph`, y[1], y[2]) : null;
}

/** "Issued at 19:00 hours M.S.T on 28-9-2026" -> ISO (MST = UTC+06:30). */
function issuedFromText(en) {
  const m = /Issued\s+at\s+(\d{1,2})[:.]?(\d{2})\s*(?:hours|hrs)?\s*M\.?\s*S\.?\s*T\.?\s*(?:on|,)?\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{4})/i.exec(en);
  if (!m) return null;
  const [h, min, d, mo, y] = m.slice(1).map(Number);
  if (h > 23 || min > 59 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return toIso(Date.UTC(y, mo - 1, d, h, min) - 6.5 * 3600e3);
}

const YANGON_EN = /\byangon\b|\brangoon\b/i;
const YANGON_MY = /ရန်ကုန်/;
const SURGE = /surge|ဒီရေ/i;

/**
 * Does the bulletin name Yangon as affected by the system itself? Uses the
 * condition and forecast (track) paragraphs, plus caution sentences that
 * pair Yangon with storm surge. Deliberately NOT the caution paragraph's
 * list of regions expecting rain: nearly every monsoon bulletin lists
 * Yangon there, which would make a far-away storm look like a direct threat.
 */
function mentionsYangonIn(sections, re) {
  if ([...sections.condition, ...sections.forecast].some((p) => re.test(p))) return true;
  return sections.caution.some((p) => sentencesOf(p).some((s) => re.test(s) && SURGE.test(s)));
}

/** "This is the last news/warning for the …" — DMH closes the series. */
const FINAL_EN = /\bthis\s+is\s+the\s+(?:last|final)\s+(?:news|warning|bulletin)\b/i;

function isWeakening(enSections, mySections, final = false) {
  // Last bulletins have no forecast section: their condition text says where it goes.
  const pick = (sec) => (sec.forecast.length ? sec.forecast : final ? sec.condition : []).join(' ');
  const f = pick(enSections);
  if (/weaken|dissipat/i.test(f)) return true;
  if (/low\s+pressure\s+area/i.test(f) && !/intensif/i.test(f)) return true;
  if (final && f) return true;
  return /အားပျော့|အားလျော့|ပျောက်ကွယ်/.test(pick(mySections));
}

/**
 * DMH cyclone bulletin (warning or news) from its English and/or Burmese
 * title and body text. Bodies are plain text with one paragraph per line.
 * @returns {object} DmhBulletin (see SPEC.md); `summary` omitted when `light`.
 */
export function parseCycloneBulletin({ id = null, kind = null, titleEn = '', bodyEn = '', titleMy = '', bodyMy = '', url = null, postIso = null, light = false } = {}) {
  const tEn = titleWords(titleEn);
  const tMy = cleanText(titleMy);
  const en = String(bodyEn || '');
  const my = String(bodyMy || '');
  const enFlat = cleanText(en);
  const myAscii = burmeseDigitsToAscii(cleanText(my));
  const enSec = splitSections(en);
  const mySec = splitSections(my);
  const enPos = cleanText(enSec.position.join(' '));
  const myPosAscii = burmeseDigitsToAscii(cleanText(mySec.position.join(' '))) || myAscii;

  const { stage, scope } = parseStage(enFlat, myAscii);
  const { lat, lon } = parsePosition(enFlat, myAscii);
  const { number, year } = tEn ? numberFromTitle(tEn) : { number: null, year: null };
  const fromMy = numberFromTitle(tMy);
  const k = kind || kindFromTitles(tEn, tMy, url ? classifyLink(url) : null);
  const final = FINAL_EN.test(enFlat);

  const bulletin = {
    id: id != null ? String(id) : url ? nodeIdFromUrl(url) : null,
    kind: k === 'warning' || k === 'news' ? k : null,
    system: systemFromTitle(tEn) ?? systemFromTitle(tMy),
    number: number ?? fromMy.number,
    year: year ?? fromMy.year,
    stage: STAGES.includes(stage) ? stage : null,
    ...(scope === 'other-regions' ? { stageScope: 'other-regions' } : {}),
    issuedAt: toIso(postIso) ?? issuedFromText(enFlat),
    lat,
    lon,
    pressureHpa: parsePressure(enPos, enFlat, myPosAscii),
    windMph: parseWind(enPos, enFlat, myPosAscii),
    // A stage DMH scoped to other regions never counts as naming Yangon.
    mentionsYangon: scope === 'other-regions' ? false : mentionsYangonIn(enSec, YANGON_EN) || mentionsYangonIn(mySec, YANGON_MY),
    weakening: isWeakening(enSec, mySec, final),
    final,
    title: { en: tEn || tMy, my: tMy || tEn },
    url: url ? langUrls(url) : { en: null, my: null },
  };
  if (!light) bulletin.summary = { en: buildSummary(enSec), my: buildSummary(mySec) };
  return bulletin;
}

// ---------------------------------------------------------------------------
// Other DMH warnings (flood, heavy rain, strong wind, water level)
// ---------------------------------------------------------------------------

const OTHER_RULES = [
  ['flash-flood', /flash\s*flood/i, /လျှပ်တစ?ပြက်\s*ရေကြီး|ရုတ်တရက်\s*ရေကြီး/],
  ['water-level', /water\s*level|river\s*(?:level|condition)/i, /မြစ်ရေ|ရေမျက်နှာပြင်/],
  ['flood', /\bflood/i, /ရေကြီး/],
  ['heavy-rain', /heavy\s*rain/i, /မိုးသည်းထန်|မိုးကြီး/],
  ['strong-wind', /strong\s*wind|squall/i, /လေပြင်း/],
];

/** Other-warning type from a title, or null for unrelated bulletins (records, forecasts…). */
export function classifyOtherWarning(title) {
  const t = cleanText(title);
  if (!t || isCycloneTitle(t)) return null;
  for (const [type, en, my] of OTHER_RULES) if (en.test(t) || my.test(t)) return type;
  if (/\bwarning\b|သတိပေးချက်/i.test(t) && !/\brecord|စံချိန်/i.test(t)) return 'other';
  return null;
}

/** "There is no Flood Bulletin issued." / "…ထုတ်ပြန်ထားခြင်းမရှိပါ။" */
export function isNilBulletin(text) {
  const t = cleanText(text);
  if (!t) return false;
  return /\bthere\s+(?:is|are)\s+no\b/i.test(t) || /\bno\s+[\w\s]{0,40}(?:bulletin|warning)\s+(?:is\s+|has\s+been\s+)?issued\b/i.test(t) || /ထုတ်ပြန်\s*(?:ထား|ထာ)?\s*ခြင်း\s*မရှိ/.test(t);
}

// ---------------------------------------------------------------------------
// Assembling data/dmh.json
// ---------------------------------------------------------------------------

function newRecord(id, kind) {
  return { id, kind, postIso: null, createdIso: null, en: { title: '', body: '', url: null }, my: { title: '', body: '', url: null } };
}

function putTitle(rec, title, langHint) {
  const t = titleWords(title);
  if (!t || /^top announcement$/i.test(t)) return;
  const lang = isBurmese(t) ? 'my' : MYANMAR_SCRIPT.test(t) ? langHint : 'en';
  if (!rec[lang].title) rec[lang].title = t;
}

function pageKey(lang, kind, id) {
  return `${DMH_ORIGIN}/${lang}/${kind}/${id}`;
}

/** A listing link that is a bulletin entry rather than site navigation. */
function isBulletinLink(link) {
  return Boolean(link.postIso) || link.kind === 'top-announcement' || link.kind === 'warning' || isCycloneTitle(link.title) || classifyOtherWarning(link.title) !== null;
}

/** Index everything we know about each DMH node id from the fetched documents. */
export function collectRecords({ rssEn = null, rssMy = null, homeEn = null, homeMy = null, cycloneNewsEn = null, pages = {} } = {}) {
  const records = new Map();
  const get = (id, kind) => {
    let r = records.get(id);
    if (!r) records.set(id, (r = newRecord(id, kind)));
    return r;
  };
  const stats = { rssEn: 0, rssMy: 0, homeEn: 0, homeMy: 0, cycloneNewsEn: 0 };

  for (const [lang, xml, key] of [['en', rssEn, 'rssEn'], ['my', rssMy, 'rssMy']]) {
    for (const item of parseRssItems(xml)) {
      if (!item.id || item.kind === 'other') continue;
      stats[key]++;
      const r = get(item.id, item.kind);
      r.postIso ??= item.postIso;
      r.createdIso ??= item.createdIso;
      if (item.bodyTitle) putTitle(r, item.bodyTitle, lang);
      putTitle(r, item.title, lang);
      if (!r[lang].body) r[lang].body = item.bodyText;
      r[lang].url ??= item.link;
    }
  }
  for (const [lang, html, key] of [['en', homeEn, 'homeEn'], ['my', homeMy, 'homeMy'], ['en', cycloneNewsEn, 'cycloneNewsEn']]) {
    for (const link of parseListingLinks(html)) {
      // Site chrome (e.g. a sidebar article linked from every page) must not
      // make a page whose bulletin links no longer parse look healthy.
      if (isBulletinLink(link)) stats[key]++;
      const r = get(link.id, link.kind);
      const linkLang = link.lang || lang;
      putTitle(r, link.title, linkLang);
      r.postIso ??= link.postIso;
      if (link.kind === 'top-announcement' && link.teaser) r[linkLang].teaser ||= link.teaser;
      r[linkLang].url ??= link.url;
    }
  }
  for (const [url, html] of Object.entries(pages || {})) {
    const info = pathInfo(url);
    const page = extractBulletinPage(html);
    if (!info || !page) continue;
    const lang = info.lang || 'en';
    const r = get(info.id, info.type);
    if (page.postIso) r.postIso = page.postIso;
    putTitle(r, page.title, lang);
    if (!r[lang].body && page.bodyText) r[lang].body = page.bodyText;
  }
  return { records, stats };
}

function recordTitle(r) {
  return r.en.title || r.my.title;
}

function isCycloneRecord(r) {
  return (r.kind === 'warning' || r.kind === 'news') && (isCycloneTitle(r.en.title) || isCycloneTitle(r.my.title));
}

/** A DMH "Nothing Special" notice (in either language). */
function isNilRecord(r) {
  return isNilCycloneBody(r.en.body, r.en.title) || isNilCycloneBody(r.my.body, r.my.title);
}

function byPostDesc(a, b) {
  const d = Date.parse(b.postIso) - Date.parse(a.postIso);
  return d || Number(b.id) - Number(a.id);
}

// Separate EN and MY nodes for the same bulletin share kind + post time.
function mergeTranslations(list) {
  const out = [];
  for (const r of list) {
    const twin = out.find((o) => o.kind === r.kind && o.postIso && o.postIso === r.postIso && systemFromTitle(recordTitle(o)) === systemFromTitle(recordTitle(r)));
    if (!twin) {
      out.push({ ...r, en: { ...r.en }, my: { ...r.my } });
      continue;
    }
    for (const lang of ['en', 'my']) {
      if (!twin[lang].body && r[lang].body) {
        twin[lang].body = r[lang].body;
        twin[lang].url = r[lang].url;
      }
      if (!twin[lang].title && r[lang].title) twin[lang].title = r[lang].title;
    }
  }
  return out;
}

const HOUR_MS = 3600e3;
// DMH types post dates by hand (fixtures: uploaded up to 8 h after the post date).
const POST_AFTER_UPLOAD_MAX_MS = 6 * HOUR_MS;
const POST_BEFORE_UPLOAD_MAX_MS = 48 * HOUR_MS;
const FUTURE_TOLERANCE_MS = 6 * HOUR_MS;
const CURRENT_MS = 24 * HOUR_MS;

/**
 * When a bulletin was issued: its typed post date, unless that is
 * implausible next to its upload time (a day or year typo) or in the
 * future; then the upload time (or when we first saw it), flagged estimated.
 * Records with no date at all give null.
 */
function effectiveIssue(r, now, prevById = new Map()) {
  const nowMs = +now;
  const post = r.postIso ? Date.parse(r.postIso) : Number.NaN;
  const created = r.createdIso ? Date.parse(r.createdIso) : Number.NaN;
  if (Number.isFinite(post)) {
    if (Number.isFinite(created) && (post > created + POST_AFTER_UPLOAD_MAX_MS || post < created - POST_BEFORE_UPLOAD_MAX_MS)) {
      return { iso: toIso(Math.min(created, nowMs)), estimated: true };
    }
    if (post > nowMs + FUTURE_TOLERANCE_MS) {
      const prev = prevById.get(r.id);
      const firstSeen = prev?.issuedAtEstimated === true && Date.parse(prev.issuedAt) <= nowMs ? Date.parse(prev.issuedAt) : nowMs;
      return { iso: toIso(firstSeen), estimated: true };
    }
    return { iso: toIso(post), estimated: false };
  }
  if (Number.isFinite(created)) return { iso: toIso(Math.min(created, nowMs)), estimated: true };
  return null;
}

/**
 * Cyclone bulletins with a usable issue time (`issuedIso`, `estimated`),
 * newest first. Nil "Nothing Special" notices are left out.
 */
function cycloneCandidates(records, now = new Date(), prevById = new Map()) {
  const dated = [...records.values()].filter((r) => isCycloneRecord(r) && !isNilRecord(r) && (r.postIso || r.createdIso)).sort(byPostDesc);
  const out = [];
  for (const r of mergeTranslations(dated)) {
    const eff = effectiveIssue(r, now, prevById);
    if (eff) out.push({ ...r, issuedIso: eff.iso, estimated: eff.estimated });
  }
  return out.sort((a, b) => Date.parse(b.issuedIso) - Date.parse(a.issuedIso) || Number(b.id) - Number(a.id));
}

/**
 * Which bulletin pages still need fetching: cyclone bulletins seen only on a
 * listing (no date yet), then the missing language bodies of every current
 * one (DMH can run several series at once, and a nil "Nothing Special"
 * notice is only recognised from its body).
 */
export function pagesToFetch(inputs, { limit = RECENT_MAX, attempted = new Set(), now = new Date() } = {}) {
  const { records } = collectRecords(inputs);
  const want = [];
  const add = (url) => {
    if (url && !attempted.has(url) && !(inputs.pages && url in inputs.pages) && !want.includes(url)) want.push(url);
  };
  const undated = [...records.values()]
    .filter((r) => isCycloneRecord(r) && !r.postIso && !attempted.has(pageKey('en', r.kind, r.id)))
    .sort((a, b) => (a.kind === b.kind ? Number(b.id) - Number(a.id) : a.kind === 'warning' ? -1 : 1));
  for (const r of undated.slice(0, 3)) add(pageKey('en', r.kind, r.id));
  // Only once every candidate has a date do we know which ones are current.
  if (!want.length) {
    const candidates = cycloneCandidates(records, now);
    // Only bulletins still in force (not replaced by a newer one about the same system).
    const { inForce } = rankDmhBulletins(candidates.map((r) => recordToBulletin(r, true)), { now, checkedAt: now });
    const live = new Set(inForce.map((b) => b.id));
    const current = candidates.filter((r) => live.has(r.id) && +now - Date.parse(r.issuedIso) <= CURRENT_MS);
    for (const r of current.length ? current : candidates.slice(0, 1)) {
      for (const lang of ['en', 'my']) if (!r[lang].body) add(pageKey(lang, r.kind, r.id));
    }
  }
  return want.slice(0, Math.max(0, limit));
}

function recordToBulletin(r, light) {
  const url = r.en.url || r.my.url || pageKey('en', r.kind, r.id);
  const b = parseCycloneBulletin({
    id: r.id,
    kind: kindFromTitles(r.en.title, r.my.title, r.kind),
    titleEn: r.en.title,
    bodyEn: r.en.body,
    titleMy: r.my.title,
    bodyMy: r.my.body,
    url,
    postIso: r.issuedIso ?? r.postIso,
    light,
  });
  if (r.estimated) b.issuedAtEstimated = true;
  // Separate EN/MY nodes keep their own URLs.
  if (r.en.url && r.my.url && nodeIdFromUrl(r.en.url) !== nodeIdFromUrl(r.my.url)) {
    b.url = { en: langUrls(r.en.url).en, my: langUrls(r.my.url).my };
  }
  return b;
}

function isBulletinLike(b) {
  return b && typeof b === 'object' && typeof b.issuedAt === 'string' && Number.isFinite(Date.parse(b.issuedAt));
}

function lighten(b) {
  const { summary, ...rest } = b;
  return rest;
}

function fillFromPrevious(b, prev) {
  if (!prev || prev.id !== b.id) return b;
  for (const field of ['title', 'summary']) {
    if (!b[field] || !prev[field]) continue;
    for (const lang of ['en', 'my']) if (!b[field][lang] && prev[field][lang]) b[field][lang] = prev[field][lang];
  }
  for (const field of ['stage', 'lat', 'lon', 'pressureHpa', 'windMph', 'system', 'number', 'year']) {
    if (b[field] == null && prev[field] != null) b[field] = prev[field];
  }
  if (!b.mentionsYangon && prev.mentionsYangon === true) b.mentionsYangon = true;
  return b;
}

function buildAnnouncement(records, previous) {
  const items = [...records.values()].filter((r) => r.kind === 'top-announcement');
  const newest = (lang) =>
    items
      .filter((r) => r[lang].body || r[lang].teaser)
      .sort((a, b) => (Date.parse(b.createdIso || b.postIso) || 0) - (Date.parse(a.createdIso || a.postIso) || 0) || Number(b.id) - Number(a.id))[0];
  const en = newest('en');
  const my = newest('my');
  if (!en && !my) return previous?.announcement ?? null;
  const text = (r, lang) => (r ? truncateText(r[lang].body || r[lang].teaser || '', 1200) : '');
  const times = [en?.createdIso, en?.postIso, my?.createdIso, my?.postIso].filter(Boolean).map(Date.parse);
  const urlEn = en ? langUrls(en.en.url || pageKey('en', 'top-announcement', en.id)).en : null;
  const urlMy = my ? langUrls(my.my.url || pageKey('my', 'top-announcement', my.id)).my : null;
  return {
    issuedAt: times.length ? toIso(Math.max(...times)) : null,
    text: { en: text(en, 'en'), my: text(my, 'my') },
    url: { en: urlEn || (urlMy && langUrls(urlMy).en), my: urlMy || (urlEn && langUrls(urlEn).my) },
  };
}

function buildOtherWarnings(records) {
  const list = [];
  for (const r of records.values()) {
    if (isCycloneRecord(r)) continue;
    const type = classifyOtherWarning(r.en.title) ?? classifyOtherWarning(r.my.title);
    const issuedAt = toIso(r.postIso || r.createdIso);
    if (!type || !issuedAt) continue;
    list.push({ r, type, issuedAt });
  }
  list.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || Number(b.r.id) - Number(a.r.id));
  // DMH posts these as separate EN and MY nodes: group them by type + time.
  const groups = new Map();
  for (const { r, type, issuedAt } of list) {
    const key = `${type}|${issuedAt}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { type, issuedAt, en: null, my: null, bodies: [] }));
    const urls = langUrls(r.en.url || r.my.url || pageKey('en', r.kind, r.id));
    if (!g.en && (r.en.title || r.en.body)) g.en = { title: r.en.title, url: urls.en };
    if (!g.my && (r.my.title || r.my.body)) g.my = { title: r.my.title, url: urls.my };
    g.bodies.push(r.en.body, r.my.body);
  }
  const out = [];
  for (const g of groups.values()) {
    if (out.some((o) => o.type === g.type)) continue; // newest bulletin per type only
    const tEn = g.en?.title || '';
    const tMy = g.my?.title || '';
    const anyUrl = g.en?.url || g.my?.url;
    out.push({
      type: g.type,
      issuedAt: g.issuedAt,
      title: { en: tEn || tMy, my: tMy || tEn },
      url: { en: g.en?.url || langUrls(anyUrl).en, my: g.my?.url || langUrls(anyUrl).my },
      mentionsYangon: g.bodies.some((b) => YANGON_EN.test(b) || YANGON_MY.test(b)),
      isNil: g.bodies.some((b) => isNilBulletin(b)),
    });
  }
  return out;
}

function failure({ previous, errors, now }) {
  const prev = previous && typeof previous === 'object' && previous.schema === 1 ? previous : null;
  return {
    schema: 1,
    generator: GENERATOR,
    checkedAt: prev?.checkedAt ?? null,
    attemptedAt: toIso(now),
    ok: false,
    errors,
    partial: prev?.partial === true,
    cyclone: prev?.cyclone ?? null,
    recentCyclone: Array.isArray(prev?.recentCyclone) ? prev.recentCyclone : [],
    undatedCyclone: Array.isArray(prev?.undatedCyclone) ? prev.undatedCyclone : [],
    announcement: prev?.announcement ?? null,
    otherWarnings: Array.isArray(prev?.otherWarnings) ? prev.otherWarnings : [],
  };
}

/** A previous bulletin re-used in this run; a post date in the future becomes the time we last saw it. */
function carryPrevious(b, prev, now) {
  if (Date.parse(b.issuedAt) <= +now + FUTURE_TOLERANCE_MS) return b;
  const seen = Date.parse(prev?.checkedAt);
  return { ...b, issuedAt: toIso(Number.isFinite(seen) && seen <= +now ? seen : now), issuedAtEstimated: true };
}

const newestFirst = (a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt) || Number(b.id) - Number(a.id);

/**
 * Assemble data/dmh.json (schema 1) from whatever documents were fetched
 * (null = failed). Keeps the previous content, with ok:false and the old
 * checkedAt, when nothing usable came back.
 *
 * `cyclone` is the bulletin that matters most for Yangon among those still
 * in force (DMH can run a Warning for one system and a News for another at
 * the same time; see js/risk.js `inForceDmh`), else the newest. Previous
 * bulletins that scrolled out of the feeds still count while current.
 * Cyclone bulletins DMH lists but whose date could not be read are listed in
 * `undatedCyclone` with `partial: true` (the page then says DMH could not be
 * fully checked) instead of being dropped silently.
 */
export function buildDmhJson({ rssEn = null, rssMy = null, homeEn = null, homeMy = null, cycloneNewsEn = null, pages = {}, errors = [], now = new Date(), previous = null, home = HOME } = {}) {
  const errs = [...errors];
  const { records, stats } = collectRecords({ rssEn, rssMy, homeEn, homeMy, cycloneNewsEn, pages });
  for (const [key, doc] of Object.entries({ rssEn, rssMy, homeEn, homeMy, cycloneNewsEn })) {
    if (typeof doc === 'string' && stats[key] === 0) errs.push(`${key}: fetched but no DMH bulletins could be parsed (page layout changed?)`);
  }
  const usable = stats.rssEn + stats.rssMy + stats.homeEn + stats.homeMy + stats.cycloneNewsEn > 0;
  if (!usable) return failure({ previous, errors: errs, now });

  const prev = previous && typeof previous === 'object' && previous.schema === 1 ? previous : null;
  const prevList = [prev?.cyclone, ...(Array.isArray(prev?.recentCyclone) ? prev.recentCyclone : [])].filter((b) => isBulletinLike(b) && b.id);
  const prevById = new Map();
  for (const b of prevList) if (!prevById.has(b.id)) prevById.set(b.id, b);

  const candidates = cycloneCandidates(records, now, prevById);
  for (const r of candidates) if (r.estimated) errs.push(`cyclone bulletin ${r.kind}/${r.id}: post date ${r.postIso ?? 'missing'} looks wrong; using ${r.issuedIso}`);
  const newestId = candidates.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  const undated = [...records.values()].filter((r) => isCycloneRecord(r) && !r.postIso && !r.createdIso && !isNilRecord(r));
  for (const r of undated) errs.push(`cyclone bulletin ${r.kind}/${r.id} has no issue time; listed as unread`);
  // Node ids follow upload order: an undated bulletin newer than every dated one may be the one that matters.
  const unread = undated.filter((r) => !candidates.length || Number(r.id) > newestId).sort((a, b) => Number(b.id) - Number(a.id));

  const all = new Map();
  for (const r of candidates.slice(0, RECENT_MAX * 2)) {
    const b = recordToBulletin(r, false);
    if (isBulletinLike(b)) all.set(b.id, fillFromPrevious(b, prevById.get(b.id)));
  }
  for (const b of prevList) if (!all.has(b.id)) all.set(b.id, carryPrevious(b, prev, now));
  const list = [...all.values()].sort(newestFirst);

  const { inForce, lead } = rankDmhBulletins(list, { home, now, checkedAt: now });
  const leadId = lead?.id ?? null;
  let cyclone = leadId != null && all.has(leadId) ? all.get(leadId) : (list[0] ?? null);
  if (cyclone && !cyclone.summary) cyclone = { ...cyclone, summary: { en: '', my: '' } };

  const recentCyclone = [];
  const seen = new Set();
  const cap = Math.max(RECENT_MAX, inForce.length);
  for (const b of [...inForce.map((x) => all.get(x.id)), ...list]) {
    if (!b || seen.has(b.id) || recentCyclone.length >= cap) continue;
    seen.add(b.id);
    recentCyclone.push(lighten(b));
  }
  recentCyclone.sort(newestFirst);

  return {
    schema: 1,
    generator: GENERATOR,
    checkedAt: toIso(now),
    attemptedAt: toIso(now),
    ok: true,
    errors: errs,
    partial: unread.length > 0,
    cyclone,
    recentCyclone,
    undatedCyclone: unread.map((r) => {
      const urls = langUrls(r.en.url || r.my.url || pageKey('en', r.kind, r.id));
      return { id: r.id, kind: kindFromTitles(r.en.title, r.my.title, r.kind), title: { en: r.en.title || r.my.title, my: r.my.title || r.en.title }, url: urls };
    }),
    announcement: buildAnnouncement(records, prev),
    otherWarnings: buildOtherWarnings(records),
  };
}
