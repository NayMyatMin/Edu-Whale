import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decodeEntities, cleanText, htmlToText, burmeseDigitsToAscii, toIso, classifyLink, nodeIdFromUrl, langUrls,
  isCycloneTitle, systemFromTitle, numberFromTitle, parseRssItems, parseListingLinks, extractBulletinPage,
  parseCycloneBulletin, classifyOtherWarning, isNilBulletin, splitSections, truncateText, buildDmhJson,
  pagesToFetch, SUMMARY_MAX_CHARS,
} from '../scripts/lib/dmh-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = join(ROOT, 'tests/fixtures/dmh');
const fx = (name) => readFileSync(join(FIX, name), 'utf8');
const ALL = () => ({
  rssEn: fx('rss_en.xml'), rssMy: fx('rss_my.xml'), homeEn: fx('home_en.html'), homeMy: fx('home_my.html'), cycloneNewsEn: fx('cyclone-news_en.html'),
});
const NOW = new Date('2026-09-28T15:00:00Z');

/** Minimal schema check for data/dmh.json (schema 1). */
function assertDmhSchema(j) {
  assert.equal(j.schema, 1);
  assert.equal(j.generator, 'scripts/fetch-dmh.mjs');
  assert.equal(typeof j.ok, 'boolean');
  assert.ok(Array.isArray(j.errors) && j.errors.every((e) => typeof e === 'string'));
  assert.ok(j.checkedAt === null || Number.isFinite(Date.parse(j.checkedAt)));
  const pair = (p, allowNull = false) => {
    assert.ok(p && typeof p === 'object', 'expected {en, my}');
    for (const k of ['en', 'my']) assert.ok(typeof p[k] === 'string' || (allowNull && p[k] === null), `pair.${k}`);
  };
  const bulletin = (b, withSummary) => {
    assert.equal(typeof b.id, 'string');
    assert.ok(['warning', 'news'].includes(b.kind));
    assert.ok(b.system === null || ['low', 'well-marked-low', 'depression', 'deep-depression', 'cs', 'scs', 'vscs', 'escs', 'sucs'].includes(b.system));
    assert.ok(b.stage === null || ['yellow', 'orange', 'red', 'brown', 'green'].includes(b.stage));
    assert.ok(Number.isFinite(Date.parse(b.issuedAt)));
    for (const k of ['number', 'year', 'lat', 'lon', 'pressureHpa']) assert.ok(b[k] === null || Number.isFinite(b[k]), k);
    assert.ok(b.windMph === null || (Number.isFinite(b.windMph.min) && Number.isFinite(b.windMph.max) && typeof b.windMph.text === 'string'));
    assert.equal(typeof b.mentionsYangon, 'boolean');
    assert.equal(typeof b.weakening, 'boolean');
    pair(b.title);
    pair(b.url, true);
    if (withSummary) {
      pair(b.summary);
      assert.ok(b.summary.en.length <= SUMMARY_MAX_CHARS && b.summary.my.length <= SUMMARY_MAX_CHARS);
    } else assert.equal(b.summary, undefined);
  };
  if (j.cyclone !== null) bulletin(j.cyclone, true);
  assert.ok(Array.isArray(j.recentCyclone) && j.recentCyclone.length <= 6);
  j.recentCyclone.forEach((b) => bulletin(b, false));
  if (j.announcement !== null) {
    assert.ok(j.announcement.issuedAt === null || Number.isFinite(Date.parse(j.announcement.issuedAt)));
    pair(j.announcement.text);
    pair(j.announcement.url, true);
  }
  assert.ok(Array.isArray(j.otherWarnings));
  for (const w of j.otherWarnings) {
    assert.ok(['flood', 'flash-flood', 'heavy-rain', 'strong-wind', 'water-level', 'other'].includes(w.type));
    assert.ok(Number.isFinite(Date.parse(w.issuedAt)));
    pair(w.title);
    pair(w.url, true);
    assert.equal(typeof w.mentionsYangon, 'boolean');
    assert.equal(typeof w.isNil, 'boolean');
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

test('decodeEntities handles named, numeric and hex references in one pass', () => {
  assert.equal(decodeEntities('A &amp; B &quot;C&quot; &#39;d&#039; &#x41;&#8211;'), 'A & B "C" \'d\' A–');
  assert.equal(decodeEntities('&amp;nbsp;'), '&nbsp;', 'no double decoding');
  assert.equal(decodeEntities('x&nbsp;y'), 'x\u00a0y');
  assert.equal(decodeEntities('&bogus; &#xZZ;'), '&bogus; &#xZZ;');
  assert.equal(decodeEntities(null), '');
});

test('cleanText removes ZWNJ and soft hyphens and collapses whitespace', () => {
  assert.equal(cleanText('  (\u00ad\u00ad\u00adက)\u00a0\u00a0 မိုး\u200cလေ\n\t ဝသ  '), '(က) မိုးလေ ဝသ');
  assert.equal(cleanText(undefined), '');
});

test('htmlToText keeps paragraphs and strips tags', () => {
  const html = '<p><span style="x"><strong>Deep Depression </strong></span><span>Warning,&nbsp;No.3</span></p><p>Line&nbsp;&nbsp;two<br>three</p><script>bad()</script>';
  assert.equal(htmlToText(html), 'Deep Depression Warning, No.3\nLine two\nthree');
});

test('burmeseDigitsToAscii converts digits, including the letter ဝ typed for zero', () => {
  assert.equal(burmeseDigitsToAscii('၁၇.၁ / ၉၇.၀'), '17.1 / 97.0');
  assert.equal(burmeseDigitsToAscii('(ဝ၃/၂ဝ၂၆)'), '(03/2026)');
  assert.equal(burmeseDigitsToAscii('ဝန်ကြီး'), 'ဝန်ကြီး', 'a real letter ဝ is left alone');
});

test('toIso normalises offsets and drops milliseconds', () => {
  assert.equal(toIso('2026-09-28T21:11:09+06:30'), '2026-09-28T14:41:09Z');
  assert.equal(toIso('nope'), null);
  assert.equal(toIso(null), null);
});

// ---------------------------------------------------------------------------
// URLs and titles
// ---------------------------------------------------------------------------

test('classifyLink / nodeIdFromUrl / langUrls', () => {
  assert.equal(classifyLink('/en/warning/133841'), 'warning');
  assert.equal(classifyLink('https://www.moezala.gov.mm/my/news/133804'), 'news');
  assert.equal(classifyLink('/index.php/en/top-announcement/133837'), 'top-announcement');
  assert.equal(classifyLink('/en/bulletin/133827'), 'bulletin');
  assert.equal(classifyLink('/my/forecast/133835'), 'forecast');
  assert.equal(classifyLink('/en/cyclone-news'), 'other');
  assert.equal(classifyLink('javascript:alert(1)'), 'other');
  assert.equal(nodeIdFromUrl('/index.php/en/top-announcement/133837'), '133837');
  assert.deepEqual(langUrls('https://www.moezala.gov.mm/my/warning/133841'), {
    en: 'https://www.moezala.gov.mm/en/warning/133841',
    my: 'https://www.moezala.gov.mm/my/warning/133841',
  });
});

test('isCycloneTitle accepts lows/depressions/cyclones in both languages and rejects the rest', () => {
  for (const t of ['Deep Depression Warning, No.3, 2026', 'Low Pressure Area Condition', 'Cyclonic Storm "Mocha" Warning', 'Storm Surge Warning',
    'အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၃/၂၀၂၆)', 'လေဖိအားနည်းရပ်ဝန်းအခြေအနေ']) {
    assert.ok(isCycloneTitle(t), t);
  }
  for (const t of ['Flood Bulletin', 'New Rainfall Record of September', 'Thunderstorm outlook', '',
    '၂၀၂၀ ပြည့်နှစ် အထွေထွေရွေးကောက်ပွဲတွင် စိစစ်တွေ့ရှိရသည့် “မဲမသမာမှုနှင့်တရားမဲ့ပြုကျင့်မှုများ"']) {
    assert.ok(!isCycloneTitle(t), t);
  }
});

test('systemFromTitle picks the most specific DMH class', () => {
  const cases = {
    'Deep Depression Warning, No.3, 2026': 'deep-depression',
    'Depression Warning, No.1, 2026': 'depression',
    'Well Marked Low Pressure Area Condition': 'well-marked-low',
    'Low Pressure Area Condition': 'low',
    'Cyclonic Storm (MOCHA) Warning': 'cs',
    'Severe Cyclonic Storm Warning': 'scs',
    'Very Severe Cyclonic Storm Warning': 'vscs',
    'Extremely Severe Cyclonic Storm (MOCHA) Warning No.9': 'escs',
    'Super Cyclonic Storm Warning': 'sucs',
    'အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက်': 'deep-depression',
    'မုန်တိုင်းငယ်သတိပေးချက်': 'depression',
    'အားကောင်းသောဆိုင်ကလုန်းမုန်တိုင်းသတိပေးချက်': 'scs',
    'လေဖိအားနည်းရပ်ဝန်းအခြေအနေ': 'low',
    'Flood Bulletin': null,
  };
  for (const [title, want] of Object.entries(cases)) assert.equal(systemFromTitle(title), want, title);
});

test('numberFromTitle reads EN and Burmese numbering', () => {
  assert.deepEqual(numberFromTitle(' Deep Depression Warning, No.3, 2026'), { number: 3, year: 2026 });
  assert.deepEqual(numberFromTitle('အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၃/၂၀၂၆)'), { number: 3, year: 2026 });
  assert.deepEqual(numberFromTitle('Low Pressure Area Condition'), { number: null, year: null });
});

// ---------------------------------------------------------------------------
// RSS, listings and pages
// ---------------------------------------------------------------------------

test('parseRssItems reads the EN feed: Burmese <title>, English body, /my/ link', () => {
  const items = parseRssItems(fx('rss_en.xml'));
  assert.equal(items.length, 10);
  const w = items[0];
  assert.equal(w.id, '133841');
  assert.equal(w.kind, 'warning');
  assert.equal(w.link, 'https://www.moezala.gov.mm/my/warning/133841');
  assert.match(w.title, /အားကောင်းသောမုန်တိုင်းငယ်/);
  assert.equal(w.bodyTitle, 'Deep Depression Warning, No.3, 2026');
  assert.equal(w.postIso, '2026-09-28T12:30:00Z');
  assert.equal(w.createdIso, '2026-09-28T14:41:09Z');
  assert.match(w.bodyText, /coded as brown stage/);
  assert.doesNotMatch(w.bodyText, /[<>]|&nbsp;|&amp;|\u200c|\u00ad/);
  assert.ok(w.bodyText.includes('\n'), 'paragraphs kept');
  const kinds = items.map((i) => i.kind);
  assert.deepEqual([...new Set(kinds)].sort(), ['bulletin', 'top-announcement', 'warning']);
});

test('parseRssItems on garbage returns []', () => {
  assert.deepEqual(parseRssItems('<html>not rss</html>'), []);
  assert.deepEqual(parseRssItems(null), []);
});

test('parseListingLinks: cyclone-news rows with post dates; unrelated news ignored later', () => {
  const links = parseListingLinks(fx('cyclone-news_en.html'));
  const n = links.find((l) => l.id === '133804');
  assert.equal(n.kind, 'news');
  assert.equal(n.title, 'Well Marked Low Pressure Area Condition');
  assert.equal(n.postIso, '2026-09-28T00:30:00Z');
  const politics = links.find((l) => l.id === '129907');
  assert.ok(politics, 'the sidebar link is seen...');
  assert.ok(!isCycloneTitle(politics.title), '...but it is not cyclone-related');
  const home = parseListingLinks(fx('home_en.html'));
  assert.ok(home.some((l) => l.url === 'https://www.moezala.gov.mm/en/warning/133841' && l.title === 'Deep Depression Warning, No.3, 2026'));
  assert.ok(home.some((l) => l.url === 'https://www.moezala.gov.mm/en/top-announcement/133837'), '/index.php/ stripped');
  assert.ok(home.every((l) => !/^read more/i.test(l.title)));
});

test('extractBulletinPage reads title, post date and body', () => {
  const en = extractBulletinPage(fx('warning_133841_en.html'));
  assert.equal(en.title, 'Deep Depression Warning, No.3, 2026');
  assert.equal(en.postIso, '2026-09-28T12:30:00Z');
  assert.match(en.bodyText, /Latitude 17\.1 degree North/);
  const my = extractBulletinPage(fx('warning_133841_my.html'));
  assert.equal(my.title, 'အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၃/၂၀၂၆)');
  assert.match(my.bodyText, /အညိုရောင်အဆင့်/);
  const news = extractBulletinPage(fx('news_133804_en.html'));
  assert.equal(news.title, 'Well Marked Low Pressure Area Condition');
  assert.equal(news.postIso, '2026-09-28T00:30:00Z');
  assert.equal(extractBulletinPage('<html><body>no article</body></html>'), null);
});

// ---------------------------------------------------------------------------
// Bulletin parsing
// ---------------------------------------------------------------------------

function todaysBulletin(opts = {}) {
  const en = parseRssItems(fx('rss_en.xml')).find((i) => i.id === '133841');
  const my = parseRssItems(fx('rss_my.xml')).find((i) => i.id === '133841');
  return parseCycloneBulletin({
    id: '133841', kind: 'warning', titleEn: en.bodyTitle, bodyEn: en.bodyText, titleMy: my.title, bodyMy: my.bodyText,
    url: en.link, postIso: en.postIso, ...opts,
  });
}

test("today's Deep Depression Warning No.3 (brown stage)", () => {
  const b = todaysBulletin();
  assert.equal(b.id, '133841');
  assert.equal(b.kind, 'warning');
  assert.equal(b.system, 'deep-depression');
  assert.equal(b.number, 3);
  assert.equal(b.year, 2026);
  assert.equal(b.stage, 'brown');
  assert.equal(b.issuedAt, '2026-09-28T12:30:00Z');
  assert.equal(b.lat, 17.1);
  assert.equal(b.lon, 97.0);
  assert.equal(b.pressureHpa, 1000);
  assert.equal(b.windMph.min, 35);
  assert.equal(b.windMph.max, 40);
  assert.match(b.windMph.text, /35-40/);
  assert.equal(b.mentionsYangon, true);
  assert.equal(b.weakening, false);
  assert.deepEqual(b.title, { en: 'Deep Depression Warning, No.3, 2026', my: 'အားကောင်းသောမုန်တိုင်းငယ်သတိပေးချက် အမှတ်စဉ်(၀၃/၂၀၂၆)' });
  assert.deepEqual(b.url, { en: 'https://www.moezala.gov.mm/en/warning/133841', my: 'https://www.moezala.gov.mm/my/warning/133841' });
  for (const lang of ['en', 'my']) {
    assert.ok(b.summary[lang].length > 200 && b.summary[lang].length <= SUMMARY_MAX_CHARS, `${lang} length ${b.summary[lang].length}`);
  }
  assert.match(b.summary.en, /^According to the observations at 18:30/);
  assert.match(b.summary.en, /continue to cross Bago, Yangon/, 'forecast paragraph kept');
  assert.doesNotMatch(b.summary.en, /Advisory|People should be awared/, 'advisory not in summary');
  assert.match(b.summary.my, /ရန်ကုန်တိုင်းဒေသကြီး/);
  assert.doesNotMatch(b.summary.my, /^\(၁\)/, 'enumerator stripped');
});

test('parseCycloneBulletin works from the Burmese text alone', () => {
  const my = parseRssItems(fx('rss_my.xml')).find((i) => i.id === '133841');
  const b = parseCycloneBulletin({ titleMy: my.title, bodyMy: my.bodyText, url: my.link, postIso: my.postIso });
  assert.equal(b.stage, 'brown');
  assert.equal(b.system, 'deep-depression');
  assert.equal(b.lat, 17.1);
  assert.equal(b.lon, 97.0);
  assert.equal(b.pressureHpa, 1000);
  assert.deepEqual([b.windMph.min, b.windMph.max], [35, 40]);
  assert.equal(b.number, 3);
  assert.equal(b.mentionsYangon, true);
  assert.equal(b.title.en, b.title.my, 'missing language falls back to the other title');
  assert.equal(b.summary.en, '');
});

test('earlier bulletins: red stage and Depression No.1', () => {
  const items = parseRssItems(fx('rss_en.xml'));
  const no1 = items.find((i) => i.id === '133839');
  const b = parseCycloneBulletin({ titleEn: no1.bodyTitle, bodyEn: no1.bodyText, url: no1.link, postIso: no1.postIso, light: true });
  assert.equal(b.stage, 'red');
  assert.equal(b.system, 'depression');
  assert.equal(b.number, 1);
  assert.deepEqual([b.lat, b.lon, b.pressureHpa], [15.6, 97.6, 1002]);
  assert.deepEqual([b.windMph.min, b.windMph.max], [35, 35]);
  assert.equal(b.summary, undefined, 'light bulletins have no summary');
});

test('mentionsYangon ignores the regional rain list but not the track, weakening from the forecast', () => {
  const body = [
    'Cyclonic Storm Condition',
    'The Cyclonic Storm is centred about 300 nautical miles west of Sittwe. It present state is coded as red stage.',
    'Next 48 hours forecast',
    'It is likely to move northwards and weaken into a Depression, crossing the Bangladesh coast.',
    'General caution',
    'Rain or thundershowers are likely in Yangon, Bago and Ayeyarwady Regions. Squalls with rough seas off Rakhine.',
  ].join('\n');
  const far = parseCycloneBulletin({ titleEn: 'Cyclonic Storm Warning No.4', bodyEn: body, url: '/en/warning/1', postIso: '2026-05-01T00:00:00Z' });
  assert.equal(far.mentionsYangon, false);
  assert.equal(far.weakening, true);
  assert.equal(far.stage, 'red');
  const surge = parseCycloneBulletin({ titleEn: 'Cyclonic Storm Warning No.5', bodyEn: `${body}\nStorm surge of 8-10 feet is likely in the coastal areas of Yangon Region.`, url: '/en/warning/2', postIso: '2026-05-01T03:00:00Z' });
  assert.equal(surge.mentionsYangon, true, 'surge naming Yangon counts');
});

test('issue time falls back to the "Issued at … M.S.T" line', () => {
  const b = parseCycloneBulletin({ titleEn: 'Depression Warning, No.1', bodyEn: 'Issued at 13:00 hours M.S.T on 28-9-2026\nDepression Condition\nx', url: '/en/warning/9' });
  assert.equal(b.issuedAt, '2026-09-28T06:30:00Z');
});

test('splitSections / truncateText', () => {
  const s = splitSections('Title, No.1, 2026\nIssued at 07:00 hours M.S.T on 28-9-2026\nLow Pressure Area Condition\nAccording to x.\nNext 24 hours forecast\nIt may move.\nGeneral caution\nRain.');
  assert.deepEqual(s.condition, ['According to x.']);
  assert.deepEqual(s.forecast, ['It may move.']);
  assert.deepEqual(s.caution, ['Rain.']);
  assert.equal(truncateText('One two. Three four. Five six.', 20), 'One two. …');
  assert.ok(truncateText('x'.repeat(50), 10).length <= 10);
});

test('other warnings: types and nil bulletins', () => {
  assert.equal(classifyOtherWarning('Flood Bulletin'), 'flood');
  assert.equal(classifyOtherWarning('Flash Flood Guidance Bulletin'), 'flash-flood');
  assert.equal(classifyOtherWarning('လျှပ်တပြက်ရေကြီးနိုင်မှုဆန်းစစ်ခြင်းအခြေအနေ'), 'flash-flood');
  assert.equal(classifyOtherWarning('Significant Water Level Bulletin'), 'water-level');
  assert.equal(classifyOtherWarning('ထူးခြားမြစ်ရေအခြေအနေသတင်း'), 'water-level');
  assert.equal(classifyOtherWarning('Heavy Rainfall Warning'), 'heavy-rain');
  assert.equal(classifyOtherWarning('Strong Wind Warning'), 'strong-wind');
  assert.equal(classifyOtherWarning('New Rainfall Record of September'), null);
  assert.equal(classifyOtherWarning('Deep Depression Warning, No.3, 2026'), null);
  assert.ok(isNilBulletin('There is no Flood Bulletin issued.'));
  assert.ok(isNilBulletin('There is no Significant Water Level Bulletin.'));
  assert.ok(isNilBulletin('ထူးခြားမြစ်ရေအခြေအနေသတင်း ထုတ်ပြန်ထာခြင်းမရှိပါ။'));
  assert.ok(!isNilBulletin('Heavy rain is likely in Yangon Region.'));
});

// ---------------------------------------------------------------------------
// buildDmhJson
// ---------------------------------------------------------------------------

test('buildDmhJson on the 28-Sep fixtures', () => {
  const j = buildDmhJson({ ...ALL(), now: NOW });
  assertDmhSchema(j);
  assert.equal(j.ok, true);
  assert.deepEqual(j.errors, []);
  assert.equal(j.checkedAt, '2026-09-28T15:00:00Z');
  assert.equal(j.cyclone.id, '133841');
  assert.equal(j.cyclone.stage, 'brown');
  assert.equal(j.cyclone.issuedAt, '2026-09-28T12:30:00Z');
  assert.deepEqual(j.recentCyclone.map((b) => b.id), ['133841', '133840', '133839', '133804', '133802', '133798']);
  assert.ok(!j.recentCyclone.some((b) => b.id === '129907'), 'politics link ignored');
  assert.equal(j.announcement.issuedAt, '2026-09-28T14:07:20Z');
  assert.match(j.announcement.text.en, /^According to the observations at 18:30/);
  assert.match(j.announcement.text.my, /ကျိုက်ထိုမြို့/);
  assert.deepEqual(j.announcement.url, {
    en: 'https://www.moezala.gov.mm/en/top-announcement/133837',
    my: 'https://www.moezala.gov.mm/my/top-announcement/133836',
  });
  const byType = Object.fromEntries(j.otherWarnings.map((w) => [w.type, w]));
  assert.deepEqual(Object.keys(byType).sort(), ['flash-flood', 'flood', 'water-level']);
  assert.equal(byType.flood.isNil, true);
  assert.equal(byType['water-level'].isNil, true);
  assert.equal(byType['water-level'].title.my, 'ထူးခြားမြစ်ရေအခြေအနေသတင်း');
  assert.equal(byType['water-level'].url.my, 'https://www.moezala.gov.mm/my/bulletin/133818');
  assert.equal(byType['flash-flood'].isNil, false);
  assert.equal(byType['flash-flood'].title.en, 'Flash Flood Guidance Bulletin');
  assert.ok(j.otherWarnings.every((w) => w.mentionsYangon === false));
});

test('newest cyclone bulletin is chosen by post date, not node id', () => {
  const inputs = ALL();
  const marker = 'datetime="2026-09-28T09:30:00Z"';
  assert.equal(inputs.rssEn.split(marker).length, 2, 'fixture has one No.2 post date');
  inputs.rssEn = inputs.rssEn.replace(marker, 'datetime="2026-09-28T13:30:00Z"');
  const j = buildDmhJson({ ...inputs, now: NOW });
  assert.equal(j.cyclone.id, '133840');
  assert.equal(j.cyclone.stage, 'red');
  assert.equal(j.recentCyclone[0].id, '133840');
});

test('buildDmhJson keeps previous content when DMH is unreachable', () => {
  const good = buildDmhJson({ ...ALL(), now: NOW });
  const later = new Date('2026-09-28T18:00:00Z');
  const failed = buildDmhJson({ errors: ['rssEn: timeout'], now: later, previous: good });
  assertDmhSchema(failed);
  assert.equal(failed.ok, false);
  assert.equal(failed.checkedAt, '2026-09-28T15:00:00Z', 'old checkedAt kept');
  assert.equal(failed.attemptedAt, '2026-09-28T18:00:00Z');
  assert.deepEqual(failed.errors, ['rssEn: timeout']);
  assert.deepEqual(failed.cyclone, good.cyclone);
  const none = buildDmhJson({ errors: ['x'], now: later });
  assertDmhSchema(none);
  assert.equal(none.cyclone, null);
  assert.equal(none.checkedAt, null);
  const garbage = buildDmhJson({ rssEn: '<html>Service Unavailable</html>', now: later, previous: good });
  assert.equal(garbage.ok, false);
  assert.match(garbage.errors[0], /no DMH bulletins could be parsed/);
});

test('a newer previous bulletin survives when it has scrolled out of the feeds', () => {
  const good = buildDmhJson({ ...ALL(), now: NOW });
  const newer = { ...good.cyclone, id: '999999', issuedAt: '2026-09-28T15:30:00Z', title: { en: 'Deep Depression Warning, No.4, 2026', my: 'x' } };
  const j = buildDmhJson({ ...ALL(), now: new Date('2026-09-28T16:00:00Z'), previous: { ...good, cyclone: newer } });
  assert.equal(j.cyclone.id, '999999');
  assert.equal(j.recentCyclone[0].id, '999999');
  assert.equal(j.recentCyclone[0].summary, undefined);
});

test('pagesToFetch asks for undated listing-only warnings first, then missing languages', () => {
  const inputs = { homeEn: fx('home_en.html'), homeMy: fx('home_my.html'), cycloneNewsEn: fx('cyclone-news_en.html') };
  const first = pagesToFetch(inputs);
  assert.deepEqual(first, [
    'https://www.moezala.gov.mm/en/warning/133841',
    'https://www.moezala.gov.mm/en/warning/133840',
    'https://www.moezala.gov.mm/en/warning/133839',
  ]);
  const pages = { [first[0]]: fx('warning_133841_en.html') };
  const second = pagesToFetch({ ...inputs, pages }, { attempted: new Set(first) });
  assert.deepEqual(second, ['https://www.moezala.gov.mm/my/warning/133841']);
  assert.deepEqual(pagesToFetch(ALL()), [], 'nothing to fetch when the RSS has both languages');
});

// ---------------------------------------------------------------------------
// scripts/fetch-dmh.mjs end to end (offline)
// ---------------------------------------------------------------------------

function runFetch(args) {
  return execFileSync(process.execPath, [join(ROOT, 'scripts/fetch-dmh.mjs'), ...args], { encoding: 'utf8', timeout: 30000 });
}

test('fetch-dmh --fixtures writes schema-valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmh-'));
  try {
    const out = join(dir, 'data', 'dmh.json');
    const log = runFetch(['--out', out, '--fixtures', FIX, '--now', '2026-09-28T15:00:00Z']);
    assert.match(log, /DMH ok: Deep Depression Warning, No\.3, 2026 \(warning, brown stage\)/);
    const text = readFileSync(out, 'utf8');
    assert.ok(text.startsWith('{\n  "schema": 1'), 'pretty-printed');
    const j = JSON.parse(text);
    assertDmhSchema(j);
    assert.equal(j.ok, true);
    assert.equal(j.checkedAt, '2026-09-28T15:00:00Z');
    assert.equal(j.cyclone.stage, 'brown');
    assert.equal(j.cyclone.lat, 17.1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch-dmh without RSS falls back to listing + bulletin pages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmh-'));
  try {
    for (const f of ['home_en.html', 'home_my.html', 'cyclone-news_en.html', 'warning_133841_en.html', 'warning_133841_my.html', 'news_133804_en.html']) {
      copyFileSync(join(FIX, f), join(dir, f));
    }
    const out = join(dir, 'dmh.json');
    runFetch(['--out', out, '--fixtures', dir, '--now', '2026-09-28T15:00:00Z']);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    assertDmhSchema(j);
    assert.equal(j.ok, true);
    assert.ok(j.errors.some((e) => /rssEn/.test(e)));
    assert.equal(j.cyclone.id, '133841');
    assert.equal(j.cyclone.stage, 'brown');
    assert.equal(j.cyclone.issuedAt, '2026-09-28T12:30:00Z');
    assert.ok(j.cyclone.summary.en.length > 100 && j.cyclone.summary.my.length > 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch-dmh exits 0 and keeps previous data when DMH is unreachable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmh-'));
  try {
    const prevPath = join(dir, 'prev.json');
    writeFileSync(prevPath, JSON.stringify(buildDmhJson({ ...ALL(), now: NOW })));
    const out = join(dir, 'dmh.json');
    runFetch(['--out', out, '--fixtures', join(dir, 'missing'), '--previous', prevPath, '--now', '2026-09-28T18:00:00Z']);
    const j = JSON.parse(readFileSync(out, 'utf8'));
    assertDmhSchema(j);
    assert.equal(j.ok, false);
    assert.equal(j.checkedAt, '2026-09-28T15:00:00Z');
    assert.equal(j.errors.length, 5);
    assert.equal(j.cyclone.id, '133841');
    runFetch(['--out', out, '--fixtures', join(dir, 'missing')]);
    const none = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(none.ok, false);
    assert.equal(none.cyclone, null);
    assert.equal(none.checkedAt, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
