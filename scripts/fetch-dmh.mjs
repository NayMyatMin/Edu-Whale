#!/usr/bin/env node
// Fetch DMH Myanmar's official cyclone bulletins and write data/dmh.json.
//
// DMH (www.moezala.gov.mm) sends no CORS headers, so the browser cannot read
// it; GitHub Actions runs this every 30 minutes and deploys the JSON with the
// site. It must never fail the deploy: on any error it keeps the previous
// content (ok:false, errors[], the OLD checkedAt) and exits 0.
//
// Usage:
//   node scripts/fetch-dmh.mjs --out data/dmh.json [--previous <url|file>]
//   node scripts/fetch-dmh.mjs --out /tmp/dmh.json --fixtures tests/fixtures/dmh [--now 2026-09-28T15:00:00Z]
//
// --fixtures <dir> runs fully offline: URLs map to rss_en.xml, rss_my.xml,
// home_en.html, home_my.html, cyclone-news_en.html and <type>_<id>_<lang>.html;
// a missing file behaves like an HTTP 404.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { buildDmhJson, pagesToFetch, DMH_ORIGIN, RECENT_MAX } from './lib/dmh-parse.mjs';

const TIMEOUT_MS = 20_000;
const MAX_PAGE_FETCHES = RECENT_MAX; // on top of the 5 fixed documents
const USER_AGENT = 'YangonStormWatch/1.0 (+https://eduwhale.info)';

const SOURCES = {
  rssEn: `${DMH_ORIGIN}/en/rss.xml`,
  rssMy: `${DMH_ORIGIN}/my/rss.xml`,
  homeEn: `${DMH_ORIGIN}/en`,
  homeMy: `${DMH_ORIGIN}/my`,
  cycloneNewsEn: `${DMH_ORIGIN}/en/cyclone-news`,
};

function parseArgs(argv) {
  const args = { out: 'data/dmh.json', previous: null, fixtures: null, now: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--previous') args.previous = next();
    else if (a === '--fixtures') args.fixtures = next();
    else if (a === '--now') args.now = next();
    else if (a === '--help' || a === '-h') args.help = true;
    else console.warn(`fetch-dmh: ignoring unknown argument ${a}`);
  }
  return args;
}

async function fetchLive(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function fixtureFetcher(dir) {
  const fixed = {
    [SOURCES.rssEn]: 'rss_en.xml',
    [SOURCES.rssMy]: 'rss_my.xml',
    [SOURCES.homeEn]: 'home_en.html',
    [SOURCES.homeMy]: 'home_my.html',
    [SOURCES.cycloneNewsEn]: 'cyclone-news_en.html',
  };
  return async (url) => {
    let name = fixed[url];
    if (!name) {
      const m = /\/(en|my)\/([a-z-]+)\/(\d+)$/.exec(new URL(url).pathname);
      if (!m) throw new Error('HTTP 404 (no fixture)');
      name = `${m[2]}_${m[3]}_${m[1]}.html`;
    }
    try {
      return await readFile(join(dir, name), 'utf8');
    } catch {
      throw new Error(`HTTP 404 (no fixture ${name})`);
    }
  };
}

function describeError(err) {
  const cause = err?.cause?.code || err?.cause?.message;
  const msg = err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS / 1000} s` : err?.message || String(err);
  return cause && !msg.includes(cause) ? `${msg} (${cause})` : msg;
}

async function loadPrevious(ref, fetcher) {
  if (!ref) return null;
  try {
    const text = /^https?:\/\//i.test(ref) ? await fetcher(ref) : await readFile(ref, 'utf8');
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && json.schema === 1) return json;
    console.warn(`fetch-dmh: previous ${ref} is not schema 1; ignoring it`);
  } catch (err) {
    console.warn(`fetch-dmh: no previous data from ${ref}: ${describeError(err)}`);
  }
  return null;
}

async function collect(fetchText) {
  const errors = [];
  const get = async (key, url) => {
    try {
      return await fetchText(url);
    } catch (err) {
      errors.push(`${key} ${url}: ${describeError(err)}`);
      return null;
    }
  };
  const settled = await Promise.allSettled(Object.values(SOURCES).map((url) => fetchText(url)));
  const inputs = {};
  Object.entries(SOURCES).forEach(([key, url], i) => {
    const r = settled[i];
    inputs[key] = r.status === 'fulfilled' ? r.value : null;
    if (r.status === 'rejected') errors.push(`${key} ${url}: ${describeError(r.reason)}`);
  });
  inputs.pages = {};

  // Bulletin pages: only what the feeds could not tell us, a few at a time.
  const attempted = new Set();
  let budget = MAX_PAGE_FETCHES;
  for (let round = 0; round < 3 && budget > 0; round++) {
    const want = pagesToFetch(inputs, { limit: budget, attempted });
    if (!want.length) break;
    budget -= want.length;
    for (const url of want) attempted.add(url);
    for (let i = 0; i < want.length; i += 2) {
      const batch = want.slice(i, i + 2);
      const texts = await Promise.all(batch.map((url) => get('page', url)));
      batch.forEach((url, j) => {
        if (texts[j]) inputs.pages[url] = texts[j];
      });
    }
  }
  return { inputs, errors, pageFetches: attempted.size };
}

function summaryLine(json) {
  const c = json.cyclone;
  const what = c ? `${c.title?.en || c.id} (${c.kind}${c.stage ? `, ${c.stage} stage` : ''}) issued ${c.issuedAt}` : 'no cyclone bulletin';
  return `DMH ${json.ok ? 'ok' : 'UNREACHABLE (kept previous data)'}: ${what}; ${json.otherWarnings.length} other warning(s); ${json.errors.length} error(s)`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/fetch-dmh.mjs --out data/dmh.json [--previous <url|file>] [--fixtures <dir>] [--now <iso>]');
    return;
  }
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error(`invalid --now ${args.now}`);
  const fetchText = args.fixtures ? fixtureFetcher(resolve(args.fixtures)) : fetchLive;
  const outPath = resolve(args.out);

  let json;
  let previous = null;
  try {
    // --previous is the deployed site's copy: read it with the live fetcher even in fixture mode.
    previous = await loadPrevious(args.previous, fetchLive);
    const { inputs, errors, pageFetches } = await collect(fetchText);
    json = buildDmhJson({ ...inputs, errors, now, previous });
    console.log(`fetch-dmh: ${pageFetches} bulletin page fetch(es)`);
  } catch (err) {
    // A parser bug must not take the site's DMH data down with it.
    console.error(err);
    json = buildDmhJson({ errors: [`fetch-dmh crashed: ${describeError(err)}`], now, previous });
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(summaryLine(json));
  for (const e of json.errors) console.log(`  - ${e}`);
  if (!json.ok) console.log(`::warning title=DMH check failed::${json.errors[0] || 'unknown error'}`);
}

main().catch((err) => {
  // Last resort: still exit 0 so the scheduled deploy goes ahead.
  console.error('fetch-dmh: unexpected failure', err);
  process.exitCode = 0;
});
