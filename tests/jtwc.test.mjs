import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchJtwc, parseAdvisoryText, parseDayTime, parseRss, parseTcfaText, parseWarningText } from '../js/jtwc.js';
import { HOME } from '../js/config.js';

const FIX = new URL('./fixtures/jtwc/', import.meta.url);
const load = (name) => readFileSync(new URL(name, FIX), 'utf8');
const iso = (d) => d.toISOString();
const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);

const NOW = new Date('2026-09-28T15:30:00Z');
const PRODUCTS = 'https://www.metoc.navy.mil/jtwc/products/';

test('parseDayTime: DDHHMM relative to now, with month/year rollover', () => {
  assert.equal(iso(parseDayTime('281200', NOW)), '2026-09-28T12:00:00.000Z');
  assert.equal(iso(parseDayTime('281200Z', NOW)), '2026-09-28T12:00:00.000Z');
  assert.equal(iso(parseDayTime('010000', NOW)), '2026-10-01T00:00:00.000Z', 'forecast into next month');
  assert.equal(iso(parseDayTime('301200', new Date('2026-10-01T02:00:00Z'))), '2026-09-30T12:00:00.000Z');
  assert.equal(iso(parseDayTime('311800', new Date('2027-01-01T03:00:00Z'))), '2026-12-31T18:00:00.000Z', 'year back');
  assert.equal(iso(parseDayTime('020600', new Date('2026-12-31T20:00:00Z'))), '2027-01-02T06:00:00.000Z', 'year ahead');
  // 31 Sep does not exist: the nearest real 31st is chosen.
  assert.equal(iso(parseDayTime('310000', NOW)), '2026-08-31T00:00:00.000Z');
  assert.equal(parseDayTime('xx', NOW), null);
  assert.equal(parseDayTime('322400', NOW), null);
});

test('parseRss: warnings and TCFAs with product links', () => {
  const items = parseRss(load('jtwc.rss'));
  assert.equal(items.length, 7, '25W + TCFA 92W + 5 eastern Pacific products');

  const surigae = items[0];
  assert.deepEqual(surigae, {
    title: 'Typhoon 25W (Surigae) Warning #22',
    kind: 'warning',
    designation: '25W',
    name: 'Surigae',
    issuedText: '28/1500Z',
    textUrl: `${PRODUCTS}wp2526web.txt`,
    graphicUrl: `${PRODUCTS}wp2526.gif`,
    final: false,
    basinPrefix: 'wp',
    productKey: 'wp25',
    cancelled: false,
  });

  const tcfa = items[1];
  assert.equal(tcfa.kind, 'tcfa');
  assert.equal(tcfa.designation, '92W');
  assert.equal(tcfa.name, null);
  assert.equal(tcfa.title, 'Tropical Cyclone Formation Alert WTIO21');
  assert.equal(tcfa.textUrl, `${PRODUCTS}wp9226web.txt`);
  assert.equal(tcfa.issuedText, '27/1730Z');
  assert.equal(tcfa.basinPrefix, 'wp');

  const epac = items.slice(2);
  assert.deepEqual(epac.map((i) => i.designation), ['17E', '16E', '15E', '91E', '18E']);
  assert.ok(epac.every((i) => i.basinPrefix === 'ep'));
  const odalys = epac.find((i) => i.name === 'Odalys');
  assert.equal(odalys.final, true, 'Final Warning flag');
  assert.equal(epac.find((i) => i.designation === '91E').kind, 'tcfa');

  assert.deepEqual(parseRss(''), []);
  assert.deepEqual(parseRss('<rss><channel><item><title>x</title></item></channel></rss>'), []);
});

test('parseRss: entity-escaped description (no CDATA)', () => {
  const escaped =
    '<rss><channel><item><description>&lt;p&gt;&lt;b&gt;Tropical Cyclone  01B (One) Warning #03 &lt;/b&gt;&lt;br&gt;' +
    '&lt;b&gt;Issued at 29/0300Z&lt;b&gt;&lt;ul&gt;&lt;li&gt;&lt;a href=\'https://www.metoc.navy.mil/jtwc/products/io0126web.txt\'&gt;TC Warning Text&lt;/a&gt;&lt;/li&gt;&lt;/ul&gt;' +
    '</description></item></channel></rss>';
  const [item] = parseRss(escaped);
  assert.equal(item.designation, '01B');
  assert.equal(item.name, 'One');
  assert.equal(item.basinPrefix, 'io');
  assert.equal(item.textUrl, `${PRODUCTS}io0126web.txt`);
});

test('parseWarningText: Typhoon 25W (Surigae) warning #22', () => {
  const s = parseWarningText(load('wp2526web.txt'), NOW);
  assert.equal(s.id, 'jtwc:25W');
  assert.deepEqual(s.sources, ['jtwc']);
  assert.equal(s.kind, 'warning');
  assert.equal(s.name, 'Surigae');
  assert.equal(s.designation, '25W');
  assert.equal(s.basin, 'WPAC');
  assert.equal(iso(s.issuedAt), '2026-09-28T15:00:00.000Z');
  assert.deepEqual(s.position, { lat: 27.5, lon: 132.8, time: new Date('2026-09-28T12:00:00Z') });
  assert.equal(s.windKt, 90);
  assert.equal(s.gustKt, 110);
  assert.deepEqual(s.movement, { bearing: 65, speedKt: 12 });
  assert.equal(s.final, false);
  assert.equal(s.tcfa, null);

  assert.equal(s.track.length, 7);
  assert.deepEqual(s.track[0], {
    time: new Date('2026-09-28T12:00:00Z'),
    lat: 27.5,
    lon: 132.8,
    forecast: false,
    windKt: 90,
    cls: 'HU',
  });
  const fc = s.track.slice(1);
  assert.ok(fc.every((p) => p.forecast));
  assert.deepEqual(
    fc.map((p) => [iso(p.time), p.lat, p.lon, p.windKt, p.cls]),
    [
      ['2026-09-29T00:00:00.000Z', 28.4, 134.4, 70, 'HU'],
      ['2026-09-29T12:00:00.000Z', 29.4, 136.4, 60, 'TS'],
      ['2026-09-30T00:00:00.000Z', 30.5, 138.2, 55, 'TS'],
      ['2026-09-30T12:00:00.000Z', 31.9, 140.1, 50, 'TS'],
      ['2026-10-01T00:00:00.000Z', 33.7, 142.2, 50, 'TS'], // "010000Z" rolls into October
      ['2026-10-01T12:00:00.000Z', 36.5, 146.3, 50, 'TS'],
    ],
  );
});

test('parseWarningText: final warning, CRLF, southern/western hemispheres', () => {
  const text = [
    'WTIO31 PGTW 020300',
    'SUBJ/TROPICAL CYCLONE 02A (TWO) WARNING NR 009//',
    '   WARNING POSITION:',
    '   020000Z --- NEAR 12.5S 170.2W',
    '     MOVEMENT PAST SIX HOURS - 350 DEGREES AT 05 KTS',
    '   MAX SUSTAINED WINDS - 030 KT, GUSTS 040 KT',
    'REMARKS:',
    'THIS IS THE FINAL WARNING ON THIS SYSTEM BY THE JOINT TYPHOON WRNCEN.//',
  ].join('\r\n');
  const s = parseWarningText(text, new Date('2026-10-02T04:00:00Z'));
  assert.equal(s.designation, '02A');
  assert.equal(s.name, 'Two');
  assert.equal(s.basin, 'NIO');
  assert.deepEqual([s.position.lat, s.position.lon], [-12.5, -170.2]);
  assert.equal(s.final, true);
  assert.equal(s.track.length, 1);
  assert.equal(parseWarningText('garbage', NOW), null);
});

test('parseTcfaText: TCFA for Invest 92W near Yangon', () => {
  const s = parseTcfaText(load('wp9226web.txt'), NOW);
  assert.equal(s.id, 'jtwc:92W');
  assert.equal(s.kind, 'tcfa');
  assert.equal(s.name, 'Invest 92W');
  assert.equal(s.designation, '92W');
  assert.equal(s.basin, 'NIO', 'WTIO header: an Indian Ocean alert despite the W suffix');
  assert.equal(iso(s.issuedAt), '2026-09-27T17:30:00.000Z');
  assert.deepEqual(s.position, { lat: 14.4, lon: 98.0, time: new Date('2026-09-27T12:00:00Z') });
  assert.equal(s.windKt, 28, 'upper bound of "23 TO 28 KNOTS"');
  assert.deepEqual(s.movement, { bearing: 247.5, speedKt: 3 }, 'west-southwestward at 03 knots');
  assert.equal(s.potential, 'HIGH');
  assert.deepEqual(s.tcfa.from, { lat: 14.3, lon: 98.1 });
  assert.deepEqual(s.tcfa.to, { lat: 17.2, lon: 96.6 });
  near(s.tcfa.halfWidthKm, 259.28, 0.01, '140 NM');
  assert.equal(iso(s.tcfa.validUntil), '2026-09-28T17:30:00.000Z');
  assert.equal(s.track.length, 1);
  assert.equal(s.track[0].cls, 'TD');
});

test('parseTcfaText: cancellation becomes an invest (not silently dropped)', () => {
  const text = `WTIO21 PGTW 281730
SUBJ/CANCELLATION OF TROPICAL CYCLONE FORMATION ALERT (INVEST 92W)//
RMKS/
1. THE AREA OF CONVECTION (INVEST 92W) PREVIOUSLY LOCATED NEAR 14.4N
98.0E IS NOW LOCATED NEAR 17.3N 96.9E, HAS MOVED INLAND. THE POTENTIAL
FOR THE DEVELOPMENT OF A SIGNIFICANT TROPICAL CYCLONE WITHIN THE NEXT
24 HOURS IS DOWNGRADED TO LOW.//`;
  const s = parseTcfaText(text, NOW);
  assert.equal(s.kind, 'invest');
  assert.equal(s.tcfa, null);
  assert.deepEqual([s.position.lat, s.position.lon], [17.3, 96.9]);
  assert.equal(s.potential, 'LOW');
});

test('parseAdvisoryText abioweb: Invest 92W, potential upgraded to HIGH', () => {
  const list = parseAdvisoryText(load('abioweb.txt'), NOW);
  assert.equal(list.length, 1);
  const s = list[0];
  assert.equal(s.id, 'jtwc:92W');
  assert.equal(s.kind, 'invest');
  assert.equal(s.name, 'Invest 92W');
  assert.equal(s.basin, 'NIO');
  assert.equal(s.potential, 'HIGH');
  assert.deepEqual([s.position.lat, s.position.lon], [14.4, 98.0], 'NOW LOCATED, not PREVIOUSLY LOCATED');
  assert.equal(s.windKt, 28);
  assert.equal(iso(s.issuedAt), '2026-09-28T08:00:00.000Z');
});

test('parseAdvisoryText abpwweb: warned TC summary + invest 93W', () => {
  const list = parseAdvisoryText(load('abpwweb.txt'), NOW);
  assert.equal(list.length, 2);
  const [tc, inv] = list;
  assert.equal(tc.id, 'jtwc:25W');
  assert.equal(tc.kind, 'warning');
  assert.equal(tc.name, 'Surigae');
  assert.equal(tc.basin, 'WPAC');
  assert.deepEqual(tc.position, { lat: 27.5, lon: 132.8, time: new Date('2026-09-28T12:00:00Z') });
  assert.equal(tc.windKt, 90);
  assert.equal(tc.gustKt, 110);
  assert.deepEqual(tc.movement, { bearing: 67.5, speedKt: 12 });

  assert.equal(inv.id, 'jtwc:93W');
  assert.equal(inv.kind, 'invest');
  assert.equal(inv.potential, 'LOW');
  assert.equal(inv.windKt, 20);
  assert.deepEqual([inv.position.lat, inv.position.lon], [15.2, 156.1]);
});

test('parseAdvisoryText: dissipated areas are skipped, "NONE." yields nothing', () => {
  const text = `ABIO10 PGTW 291800
RMKS/
1. NORTH INDIAN OCEAN AREA (MALAY PENINSULA WEST TO COAST OF AFRICA):
   A. TROPICAL CYCLONE SUMMARY: NONE.
   B. TROPICAL DISTURBANCE SUMMARY:
      (1) THE AREA OF CONVECTION (INVEST 92W) PREVIOUSLY LOCATED NEAR
17.3N 96.9E HAS DISSIPATED.
      (2) AN AREA OF CONVECTION HAS PERSISTED NEAR 10.5N 88.2E. THE POTENTIAL FOR
THE DEVELOPMENT OF A SIGNIFICANT TROPICAL CYCLONE WITHIN THE NEXT 24 HOURS REMAINS LOW.
   C. SUBTROPICAL SYSTEM SUMMARY: NONE.
2. SOUTH INDIAN OCEAN AREA (135E WEST TO COAST OF AFRICA):
   B. TROPICAL DISTURBANCE SUMMARY:
      (1) AN AREA OF CONVECTION (INVEST 99S) HAS PERSISTED NEAR 10.0S 80.0E.
3. JUSTIFICATION FOR REISSUE: NONE.//`;
  const list = parseAdvisoryText(text, NOW);
  assert.equal(list.length, 1, 'only the NIO undesignated area; the SIO invest is out of scope');
  assert.equal(list[0].designation, null);
  assert.equal(list[0].id, 'jtwc:area:10.5,88.2');
  assert.equal(list[0].potential, 'LOW');
  assert.deepEqual(parseAdvisoryText('', NOW), []);
});

// ---------------------------------------------------------------------------
// fetchJtwc with a stubbed global fetch
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(files) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      const name = String(url).split('/').pop().split('?')[0];
      if (files[name] === undefined) return new Response('Forbidden', { status: 403 });
      return new Response(files[name], { status: 200 });
    } finally {
      inFlight--;
    }
  };
  return { calls, max: () => maxInFlight };
}

const ALL = {
  'jtwc.rss': load('jtwc.rss'),
  'wp2526web.txt': load('wp2526web.txt'),
  'wp9226web.txt': load('wp9226web.txt'),
  'abioweb.txt': load('abioweb.txt'),
  'abpwweb.txt': load('abpwweb.txt'),
};

test('fetchJtwc: fixtures → 92W TCFA kept, far WPAC systems dropped, EPAC not fetched', async () => {
  const stub = stubFetch(ALL);
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.systems.map((s) => s.id), ['jtwc:92W']);
  const s = res.systems[0];
  assert.equal(s.kind, 'tcfa', 'TCFA preferred over the advisory invest');
  assert.equal(s.potential, 'HIGH');
  assert.ok(s.tcfa, 'corridor kept');
  assert.deepEqual([s.position.lat, s.position.lon], [14.4, 98.0]);
  // The 28/0800Z advisory was reissued with the TCFA's old text: same point, so the 27/1200Z fix time stands.
  assert.equal(iso(s.position.time), '2026-09-27T12:00:00.000Z', 'repeated fix keeps its real time');
  assert.equal(s.track.filter((p) => !p.forecast).length, 1, 'no second, stationary point for the repeated fix');
  assert.equal(s.links.jtwcText, `${PRODUCTS}wp9226web.txt`);
  assert.equal(s.links.jtwcGraphic, `${PRODUCTS}wp9226.gif`);
  assert.ok(!stub.calls.some((u) => /\/ep\d{4}web\.txt/.test(u)), 'eastern Pacific texts not fetched');
  assert.equal(stub.calls.length, 5);
  assert.ok(stub.max() <= 4);
});

test('fetchJtwc: nearer home, Surigae is kept with its forecast track', async () => {
  stubFetch(ALL);
  const res = await fetchJtwc(NOW, { lat: 26, lon: 128 });
  const s = res.systems.find((x) => x.id === 'jtwc:25W');
  assert.ok(s);
  assert.equal(s.kind, 'warning');
  assert.equal(s.track.length, 7, 'warning text preferred over the advisory summary');
  assert.equal(s.links.jtwcText, `${PRODUCTS}wp2526web.txt`);
});

test('fetchJtwc: TCFA text missing → invest still flagged as a formation alert, but JTWC counts as incomplete', async () => {
  const { 'wp9226web.txt': _omit, ...rest } = ALL;
  stubFetch(rest);
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, false, 'a product the RSS lists could not be read');
  assert.equal(res.errors.length, 1);
  const s = res.systems.find((x) => x.id === 'jtwc:92W');
  assert.equal(s.kind, 'tcfa');
  assert.equal(s.tcfa, null);
  assert.equal(s.potential, 'HIGH');
});

test('fetchJtwc: RSS down but advisories up → still ok, TCFA known from "SEE REF A" and its text fetched by name', async () => {
  const { 'jtwc.rss': _omit, ...rest } = ALL;
  const stub = stubFetch(rest);
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 1);
  assert.deepEqual(res.systems.map((s) => [s.id, s.kind, s.potential]), [['jtwc:92W', 'tcfa', 'HIGH']]);
  assert.ok(stub.calls.includes(`${PRODUCTS}wp9226web.txt`), 'TCFA text URL derived from the designation');
  assert.equal(res.systems[0].links.jtwcText, `${PRODUCTS}wp9226web.txt`);
  assert.ok(res.systems[0].tcfa, 'alert corridor recovered without the RSS');
});

test('fetchJtwc: RSS down and the TCFA text missing → alert still kept from the advisory', async () => {
  const { 'jtwc.rss': _a, 'wp9226web.txt': _b, ...rest } = ALL;
  stubFetch(rest);
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, false);
  assert.equal(res.errors.length, 2);
  assert.deepEqual(res.systems.map((s) => [s.id, s.kind, s.potential]), [['jtwc:92W', 'tcfa', 'HIGH']]);
  assert.equal(res.systems[0].tcfa, null);
  assert.equal(res.systems[0].links.jtwcText, `${PRODUCTS}abioweb.txt`);
});

test('fetchJtwc: RSS and one advisory down → ok:false but partial systems returned', async () => {
  stubFetch({ 'abioweb.txt': ALL['abioweb.txt'] });
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, false);
  assert.equal(res.systems.length, 1);
  assert.match(res.error, /RSS/);
});

const CANCEL_92W = `WTIO21 PGTW 281730
MSGID/GENADMIN/JOINT TYPHOON WRNCEN PEARL HARBOR HI//
SUBJ/CANCELLATION OF TROPICAL CYCLONE FORMATION ALERT (INVEST 92W)//
RMKS/
1. THE AREA OF CONVECTION (INVEST 92W) PREVIOUSLY LOCATED NEAR 14.4N
98.0E IS NOW LOCATED NEAR 17.3N 96.9E, HAS MOVED INLAND. THE POTENTIAL
FOR THE DEVELOPMENT OF A SIGNIFICANT TROPICAL CYCLONE WITHIN THE NEXT
24 HOURS IS LOW.//`;

test('fetchJtwc: a cancelled TCFA is not promoted back by its RSS listing', async () => {
  stubFetch({ ...ALL, 'wp9226web.txt': CANCEL_92W });
  const res = await fetchJtwc(NOW, HOME);
  const s = res.systems.find((x) => x.id === 'jtwc:92W');
  assert.equal(s.kind, 'invest');
  assert.equal(s.tcfa, null);
  assert.deepEqual([s.position.lat, s.position.lon], [17.3, 96.9], 'newest fix');
  assert.equal(s.potential, 'LOW', 'newest potential');
});

const ABIO_UPGRADED = `ABIO10 PGTW 011800
MSGID/GENADMIN/JOINT TYPHOON WRNCEN PEARL HARBOR HI//
REF/A/MSG/JOINT TYPHOON WRNCEN PEARL HARBOR HI/011500ZOCT2026//
AMPN/REF A IS A TROPICAL CYCLONE WARNING.//
RMKS/
1. NORTH INDIAN OCEAN AREA (MALAY PENINSULA WEST TO COAST OF AFRICA):
   A. TROPICAL CYCLONE SUMMARY:
      (1) AT 01OCT26 1200Z, TROPICAL CYCLONE 01B (ONE) WAS LOCATED NEAR
15.0N 90.0E, APPROXIMATELY 380 NM SOUTHWEST OF YANGON, MYANMAR, AND HAD
TRACKED NORTHEASTWARD AT 08 KNOTS OVER THE PAST SIX HOURS. MAXIMUM
SUSTAINED SURFACE WINDS WERE ESTIMATED AT 45 KNOTS GUSTING TO 55 KNOTS.
SEE REF A (WTIO31 PGTW 011500) FOR FURTHER DETAILS.
   B. TROPICAL DISTURBANCE SUMMARY:
      (1) THE AREA OF CONVECTION (INVEST 93B) PREVIOUSLY LOCATED NEAR
14.2N 89.1E HAS BEEN UPGRADED TO TROPICAL CYCLONE 01B. SEE PARA 1.A.(1)
FOR FINAL WARNING.
      (2) AN AREA OF CONVECTION (INVEST 94B) IS NOW LOCATED NEAR 15.5N 90.5E.
THE POTENTIAL FOR THE DEVELOPMENT OF A SIGNIFICANT TROPICAL CYCLONE WITHIN
THE NEXT 24 HOURS IS LOW.
   C. SUBTROPICAL SYSTEM SUMMARY: NONE.
2. SOUTH INDIAN OCEAN AREA (135E WEST TO COAST OF AFRICA):
   A. TROPICAL CYCLONE SUMMARY: NONE.
3. JUSTIFICATION FOR REISSUE: UPGRADED 93B.//`;

test('upgraded invests: skipped in the advisory, and absorbed by a nearby warning', async () => {
  const oct1 = new Date('2026-10-01T19:00:00Z');
  const list = parseAdvisoryText(ABIO_UPGRADED, oct1);
  assert.deepEqual(list.map((s) => [s.id, s.kind]), [['jtwc:01B', 'warning'], ['jtwc:94B', 'invest']]);
  const tc = list[0];
  assert.equal(tc.name, 'One');
  assert.equal(tc.basin, 'NIO');
  assert.deepEqual(tc.movement, { bearing: 45, speedKt: 8 });
  assert.equal(iso(tc.position.time), '2026-10-01T12:00:00.000Z');

  // 94B sits ~80 km from the warned 01B: it is the same storm for the reader.
  stubFetch({ 'jtwc.rss': '<rss><channel></channel></rss>', 'abioweb.txt': ABIO_UPGRADED, 'abpwweb.txt': ALL['abpwweb.txt'] });
  const res = await fetchJtwc(oct1, HOME);
  assert.equal(res.ok, true);
  assert.deepEqual(res.systems.map((s) => s.id), ['jtwc:01B']);
});

test('fetchJtwc: total failure → ok:false, never throws', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, false);
  assert.deepEqual(res.systems, []);
  assert.match(res.error, /Failed to fetch/);
});

// ---------------------------------------------------------------------------
// Coverage is only "ok" when JTWC's products were really read
// ---------------------------------------------------------------------------

test('fetchJtwc: an HTML page (or empty body) served with status 200 is a failure, not an empty feed', async () => {
  for (const body of ['<!DOCTYPE html><html><body>Temporarily unavailable</body></html>', '']) {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    const res = await fetchJtwc(NOW, HOME);
    assert.equal(res.ok, false, JSON.stringify(body.slice(0, 20)));
    assert.deepEqual(res.systems, []);
    assert.ok(res.errors.some((e) => /RSS/.test(e)));
    assert.ok(res.errors.some((e) => /abioweb\.txt: unrecognised content/.test(e)));
  }
});

test('fetchJtwc: RSS up but the Indian Ocean advisory down → ok:false (its invests would be missing)', async () => {
  const { 'abioweb.txt': _omit, ...rest } = ALL;
  stubFetch(rest);
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, false);
  assert.deepEqual(res.systems.map((s) => [s.id, s.kind]), [['jtwc:92W', 'tcfa']], 'what was read is kept');
});

test('fetchJtwc: a quiet RSS with both advisories read is ok', async () => {
  const quietAbio = ALL['abioweb.txt'].replace(/B\. TROPICAL DISTURBANCE SUMMARY:[\s\S]*?(?=\s+C\. SUBTROPICAL|\s+2\.)/, 'B. TROPICAL DISTURBANCE SUMMARY: NONE.');
  stubFetch({ 'jtwc.rss': '<?xml version="1.0"?><rss version="2.0"><channel><title>JTWC</title></channel></rss>', 'abioweb.txt': quietAbio, 'abpwweb.txt': ALL['abpwweb.txt'] });
  const res = await fetchJtwc(NOW, HOME);
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
});

test('advisory: a reference to a cancelled formation alert does not promote the invest', () => {
  const text = ALL['abioweb.txt'].replace('AMPN/REF A IS A TROPICAL CYCLONE FORMATION ALERT.//', 'AMPN/REF A IS A TROPICAL CYCLONE FORMATION ALERT CANCELLATION.//');
  stubFetch({ 'jtwc.rss': '<rss><channel></channel></rss>', 'abioweb.txt': text, 'abpwweb.txt': ALL['abpwweb.txt'] });
  return fetchJtwc(NOW, HOME).then((res) => {
    const s = res.systems.find((x) => x.id === 'jtwc:92W');
    assert.equal(s.kind, 'invest');
  });
});

test('fetchJtwc: a cancelled Bay of Bengal alert whose RSS entry lacks its designation stays cancelled', async () => {
  // Live RSS at 28/1730Z: the cancelled block links only the text and fix files (no "93B_…sair.jpg").
  const rss = `<rss><channel><item><title>North Indian Ocean</title><description><![CDATA[
    <p><b>Tropical Cyclone Formation Alert WTIO21 Cancelled</b><br>Issued at 28/1730Z</p>
    <ul><li><a href="https://www.metoc.navy.mil/jtwc/products/io9326web.txt">TCFA Text</a></li>
    <li><a href="https://www.metoc.navy.mil/jtwc/products/io9326fix.txt">Fix</a></li></ul>
  ]]></description></item></channel></rss>`;
  const abio = ALL['abioweb.txt'].replace(/92W/g, '93B');
  stubFetch({ 'jtwc.rss': rss, 'abioweb.txt': abio, 'abpwweb.txt': ALL['abpwweb.txt'] }); // io9326web.txt → 403
  const items = parseRss(rss);
  assert.equal(items[0].designation, null);
  assert.equal(items[0].productKey, 'io93');
  assert.equal(items[0].cancelled, true);
  const res = await fetchJtwc(NOW, HOME);
  const s = res.systems.find((x) => x.id === 'jtwc:93B');
  assert.equal(s.kind, 'invest', 'the stale advisory\'s "SEE REF A" must not bring the cancelled alert back');
});

test('fetchJtwc: with the RSS down, the alert text URL uses the year of the referring message (Dec → Jan)', async () => {
  const jan1 = new Date('2027-01-01T03:00:00Z');
  const abio = ALL['abioweb.txt']
    .replace('ABIO10 PGTW 280800', 'ABIO10 PGTW 010000')
    .replace('REF/A/MSG/JOINT TYPHOON WRNCEN PEARL HARBOR HI/271721ZSEP2026//', 'REF/A/MSG/JOINT TYPHOON WRNCEN PEARL HARBOR HI/312130ZDEC2026//')
    .replace(/92W/g, '96B');
  const stub = stubFetch({ 'abioweb.txt': abio, 'abpwweb.txt': ALL['abpwweb.txt'] });
  await fetchJtwc(jan1, HOME);
  assert.ok(stub.calls.includes(`${PRODUCTS}io9626web.txt`), stub.calls.join(' '));
  assert.ok(!stub.calls.includes(`${PRODUCTS}io9627web.txt`));
});
