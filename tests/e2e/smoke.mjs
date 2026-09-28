#!/usr/bin/env node
// Browser smoke test for Yangon Storm Watch (NOT part of `npm test`).
//
//   npx --yes http-server -p 8181 -c-1 .          # in another terminal
//   node tests/e2e/smoke.mjs [BASE_URL] [--modes live,calm,...] [--shots <dir>] [--quick]
//
// BASE_URL defaults to $BASE_URL or http://localhost:8181/. Needs Playwright
// (a local `playwright` package, or the PW_LAUNCHER module path in $PW_LAUNCHER).
// For every mode (live data and ?demo=calm|watch|approach|today) it loads the
// page at 375×812 and 1440×900, light and dark, English and Burmese (clicking
// the language toggle), and checks: no console/page errors, no failed
// same-origin requests, no horizontal overflow, a status level with a
// headline, the DMH card, the systems section, the charts (when a forecast
// is available), the map after scrolling to it, and the language, units,
// checklist and theme controls. Exit code 1 if any check failed.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--quick'));
const BASE_URL = new URL(positional[0] || process.env.BASE_URL || 'http://localhost:8181/').href;
const MODES = (flag('--modes') || 'live,calm,watch,approach,today').split(',').filter(Boolean);
const SHOTS = flag('--shots') || process.env.SHOTS_DIR || join(process.cwd(), 'smoke-shots');
const QUICK = args.includes('--quick');
const VIEWPORTS = QUICK ? [{ width: 375, height: 812 }] : [{ width: 375, height: 812 }, { width: 1440, height: 900 }];
const SCHEMES = QUICK ? ['light'] : ['light', 'dark'];
const ORIGIN = new URL(BASE_URL).origin;

mkdirSync(SHOTS, { recursive: true });

async function getLauncher() {
  const candidates = [process.env.PW_LAUNCHER, '/tmp/claude-0/-home-user-Edu-Whale/fd6190f4-f725-56e0-9fc5-bdf2b21e37da/scratchpad/pw.mjs'].filter(Boolean);
  for (const path of candidates) {
    try {
      const mod = await import(path);
      if (typeof mod.launch === 'function') {
        // Loopback must not go through the container's HTTPS proxy.
        const server = process.env.HTTPS_PROXY || process.env.https_proxy;
        return (opts = {}) => mod.launch(server ? { proxy: { server, bypass: '<-loopback>,localhost,127.0.0.1' }, ...opts } : opts);
      }
    } catch {
      /* try the next one */
    }
  }
  const { chromium } = await import('playwright');
  return (opts = {}) => chromium.launch(opts);
}

const results = [];
let failures = 0;

function record(combo, name, ok, detail = '') {
  const entry = { combo, name, ok, detail };
  results.push(entry);
  if (!ok) failures++;
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${combo} :: ${name}${detail ? ` — ${detail}` : ''}`);
}

function pageUrl(mode) {
  return mode === 'live' ? BASE_URL : `${BASE_URL}?demo=${mode}`;
}

/** Wait until the first render and the first refresh have finished. */
async function waitReady(page) {
  await page.waitForFunction(() => document.querySelector('#status-body .status-card:not(.status-static)'), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#refresh')?.getAttribute('aria-busy') === 'false', null, { timeout: 60000 });
  await page.waitForTimeout(400);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    // Visible elements poking out of the viewport (inside no scrolling box).
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.leaflet-container, .table-scroll, .chipnav ul, .hc-table, [data-scroll-x], .visually-hidden, .skip-link')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.position === 'fixed') continue;
      if (r.right > vw + 1 || r.left < -1) offenders.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} [${Math.round(r.left)}..${Math.round(r.right)}]`);
      if (offenders.length > 8) break;
    }
    const status = document.querySelector('#status-body .status-card');
    const hasWeather = Boolean(document.querySelector('#now-body .tile'));
    return {
      lang: document.documentElement.lang,
      theme: document.documentElement.dataset.theme || null,
      scrollW: document.documentElement.scrollWidth,
      innerW: vw,
      offenders,
      level: status?.dataset.level ?? null,
      levelName: status?.querySelector('.status-level')?.textContent.trim() ?? '',
      headline: status?.querySelector('.status-headline')?.textContent.trim() ?? '',
      reasons: [...(status?.querySelectorAll(':scope > .status-reasons li') ?? [])].map((li) => li.textContent.trim()),
      gaps: status?.querySelector('.status-gaps')?.textContent.trim() ?? '',
      official: document.querySelector('#official-body .bulletin, #official-body .bulletin-none, #official-body .notice') ? document.querySelector('#official-body').innerText.replace(/\s+/g, ' ').trim().slice(0, 500) : '',
      dmhCard: Boolean(document.querySelector('#official #official-body > *:not(.official-links)')),
      systemsSection: Boolean(document.querySelector('#systems #systems-body > *:not(.muted)')),
      systems: [...document.querySelectorAll('#systems-body .sys-name')].map((e) => e.textContent.trim()),
      hasWeather,
      chartPaths: document.querySelectorAll('#forecast-body svg.hc-svg path').length,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      fresh: document.querySelector('#freshness')?.innerText.trim() ?? '',
    };
  });
}

function checkSnapshot(combo, s, { expectLang }) {
  record(combo, 'no horizontal overflow', s.scrollW <= s.innerW, `scrollWidth ${s.scrollW} vs ${s.innerW}${s.offenders.length ? `; out of view: ${s.offenders.join(', ')}` : ''}`);
  if (s.offenders.length) record(combo, 'no element outside the viewport', false, s.offenders.join(', '));
  record(combo, 'status level + headline', Boolean(s.level && s.levelName && s.headline), `${s.level} · ${s.levelName} · ${s.headline.slice(0, 80)}`);
  record(combo, 'DMH card present', s.dmhCard, s.official.slice(0, 120));
  record(combo, 'systems section present', s.systemsSection, s.systems.join(', '));
  if (s.hasWeather) record(combo, 'charts rendered', s.chartPaths > 0, `${s.chartPaths} paths`);
  if (expectLang) record(combo, `<html lang="${expectLang}">`, s.lang === expectLang, s.lang);
}

async function checkMap(page, combo) {
  await page.evaluate(() => document.querySelector('#map')?.scrollIntoView({ block: 'start' }));
  const ok = await page
    .waitForFunction(() => document.querySelector('#map-canvas.leaflet-container, #map-canvas .leaflet-container') && document.querySelector('#map-canvas .leaflet-marker-icon, #map-canvas svg path'), null, { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const info = await page.evaluate(() => ({
    controls: document.querySelectorAll('#map-controls button, #map-controls input').length,
    tiles: document.querySelectorAll('#map-canvas .leaflet-tile').length,
    paths: document.querySelectorAll('#map-canvas .leaflet-pane svg path').length,
    markers: document.querySelectorAll('#map-canvas .leaflet-marker-icon').length,
  }));
  record(combo, 'map initialises after scrolling to it', ok && info.controls > 0, JSON.stringify(info));
  await page.waitForTimeout(1200); // let tiles settle before the screenshot
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await page.waitForTimeout(200);
}

async function checkUnits(page, combo) {
  const read = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('#now-body .tile-value, #systems-body .sys-facts, #outlook-body .ol-gust')].find((e) => /km\/h|mph/.test(e.textContent));
      return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
    });
  const before = await read();
  if (!before) {
    record(combo, 'units toggle changes a wind value', true, 'skipped: no wind value on the page');
    return;
  }
  await page.click('#units-toggle');
  await page.waitForTimeout(250);
  const after = await read();
  const ok = /km\/h/.test(before) && /mph/.test(after ?? '') && !/km\/h/.test((after ?? '').replace(/\(.*?\)/g, ''));
  record(combo, 'units toggle changes a wind value', ok, `${before} → ${after}`);
  await page.click('#units-toggle');
  await page.waitForTimeout(150);
  const back = await read();
  record(combo, 'units toggle switches back', /km\/h/.test(back ?? ''), back ?? '');
}

async function checkTheme(page, combo) {
  const before = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme || null, bg: getComputedStyle(document.body).backgroundColor, label: document.querySelector('#theme-toggle').getAttribute('aria-label') }));
  await page.click('#theme-toggle');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme || null, bg: getComputedStyle(document.body).backgroundColor, label: document.querySelector('#theme-toggle').getAttribute('aria-label'), stored: (() => { try { return localStorage.getItem('ysw.theme'); } catch { return null; } })() }));
  record(combo, 'theme toggle works', after.theme && after.theme !== before.theme && after.bg !== before.bg && after.label !== before.label && after.stored === after.theme, `${before.theme ?? 'auto'}/${before.bg} → ${after.theme}/${after.bg}`);
  await page.click('#theme-toggle');
  await page.waitForTimeout(150);
}

async function checkChecklist(page, combo) {
  const id = '#chk-numbers';
  if (!(await page.$(id))) {
    record(combo, 'checklist persists across reload', false, 'no checklist');
    return;
  }
  const was = await page.isChecked(id);
  await page.click(`label[for="chk-numbers"]`);
  const now = await page.isChecked(id);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(page);
  const kept = await page.isChecked(id);
  const count = await page.textContent('#prepare-body .check-count');
  record(combo, 'checklist persists across reload', now !== was && kept === now, `checked ${was} → ${now}, after reload ${kept}; "${count?.trim()}"`);
  if (kept !== was) await page.click(`label[for="chk-numbers"]`);
}

async function run() {
  const launch = await getLauncher();
  const browser = await launch();
  const summary = {};
  try {
    for (const mode of MODES) {
      for (const vp of VIEWPORTS) {
        for (const scheme of SCHEMES) {
          const base = `${mode}@${vp.width}/${scheme}`;
          const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, locale: 'en-GB', timezoneId: 'Europe/London', serviceWorkers: 'block' });
          const page = await ctx.newPage();
          await page.emulateMedia({ colorScheme: scheme });
          const errors = [];
          const external = [];
          page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
          page.on('console', (m) => {
            if (m.type() !== 'error') return;
            const src = m.location()?.url || '';
            // Third-party tiles/APIs failing is the network's fault, not the page's; report separately.
            // Chromium reports a third-party API's error reply without CORS headers (e.g. Open-Meteo's 429
            // rate limit) as a CORS failure; the page handles it (retry, then a "could not check" gap).
            const cors = /^Access to fetch at '(https?:[^']+)' from origin '[^']+' has been blocked by CORS policy/.exec(m.text());
            if (/Failed to load resource/.test(m.text()) && src && !src.startsWith(ORIGIN)) external.push(`${m.text()} ${src}`);
            else if (cors && !cors[1].startsWith(ORIGIN)) external.push(`CORS-blocked error reply from ${cors[1].slice(0, 80)}`);
            else errors.push(`console: ${m.text()}${src ? ` (${src})` : ''}`);
          });
          page.on('requestfailed', (r) => {
            const u = r.url();
            const why = r.failure()?.errorText ?? '';
            if (u.startsWith(ORIGIN) && !/ERR_ABORTED/.test(why)) errors.push(`requestfailed: ${u} ${why}`);
          });
          page.on('response', (r) => {
            if (r.url().startsWith(ORIGIN) && r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`);
          });

          try {
            await page.goto(pageUrl(mode), { waitUntil: 'domcontentloaded' });
            await waitReady(page);
            const en = await snapshot(page);
            checkSnapshot(`${base}/en`, en, { expectLang: 'en' });
            await checkMap(page, `${base}/en`);
            const shotName = `${mode}-${vp.width}-${scheme}-en.png`;
            await page.screenshot({ path: join(SHOTS, shotName), fullPage: true });
            if (vp.width === 375 && scheme === 'light') await page.screenshot({ path: join(SHOTS, `${mode}.png`), fullPage: true });

            if (scheme === 'light') {
              await checkUnits(page, `${base}/en`);
              await checkTheme(page, `${base}/en`);
              await checkChecklist(page, `${base}/en`);
            }

            // Burmese via the header toggle.
            await page.click('[data-set-lang="my"]');
            await page.waitForFunction(() => document.documentElement.lang === 'my', null, { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(500);
            const my = await snapshot(page);
            checkSnapshot(`${base}/my`, my, { expectLang: 'my' });
            const myDigits = /[\u1040-\u1049]/.test(`${my.fresh} ${my.reasons.join(' ')} ${my.official}`);
            record(`${base}/my`, 'Burmese numbers use Burmese digits', myDigits, my.fresh.replace(/\s+/g, ' ').slice(0, 80));
            if (my.levelName === en.levelName) console.log(`note ${base}/my :: level name still English ("${my.levelName}") — Burmese dictionary not filled in yet`);
            await page.screenshot({ path: join(SHOTS, `${mode}-${vp.width}-${scheme}-my.png`), fullPage: true });
            await page.click('[data-set-lang="en"]');
            await page.waitForTimeout(200);
            record(`${base}/en`, 'language toggle switches back to English', (await page.evaluate(() => document.documentElement.lang)) === 'en');

            summary[base] = { level: en.level, levelName: en.levelName, headline: en.headline, reasons: en.reasons, gaps: en.gaps, official: en.official.slice(0, 300), systems: en.systems, hasWeather: en.hasWeather, fresh: en.fresh };
          } catch (err) {
            record(base, 'page run', false, err.message.split('\n')[0]);
          }
          record(base, 'no console or page errors', errors.length === 0, errors.slice(0, 6).join(' | '));
          if (external.length) console.log(`note ${base} :: ${external.length} third-party resource failure(s), e.g. ${external[0]}`);
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log('\nSUMMARY');
  for (const [k, v] of Object.entries(summary)) {
    if (!k.includes('/light') || !k.includes('@375')) continue;
    console.log(`${k}: level ${v.level} "${v.levelName}" — ${v.headline}`);
    for (const r of v.reasons) console.log(`   • ${r}`);
    if (v.gaps) console.log(`   gaps: ${v.gaps}`);
    console.log(`   DMH: ${v.official.slice(0, 220)}`);
    console.log(`   systems: ${v.systems.join(', ') || '(none)'}; weather: ${v.hasWeather}; ${v.fresh}`);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${SHOTS}`);
  process.exitCode = failed.length ? 1 : 0;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
