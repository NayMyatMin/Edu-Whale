// The data pipeline shared by the live page, the demo scenarios and the
// tests: merge storm feeds → analyse each system against Yangon → evaluate
// DMH and the override → assess the attention level. Pure (no DOM, no
// fetching), and defensive: one malformed system must never break the page.

import { HOME } from '../config.js';
import { analyzeSystem, mergeSystems, sortAnalyses } from '../systems.js';
import { evaluateDmh, evaluateOverride } from '../dmh.js';
import { assessRisk, stormThreat } from '../risk.js';

/**
 * @typedef {{systems: object[], ok: boolean, stale?: boolean, fetchedAt?: Date|null}} StormFeed
 *   `ok` = fetched just now; `stale` = a cached copy standing in for a failed fetch.
 */

const hasData = (feed) => Boolean(feed && Array.isArray(feed.systems) && (feed.ok || feed.stale));

/**
 * @param {object} src
 * @param {StormFeed|null} src.gdacs
 * @param {StormFeed|null} src.jtwc
 * @param {object|null} src.dmhJson     parsed data/dmh.json (null = missing / not set up)
 * @param {object|null} src.weather     WeatherData (weather.js)
 * @param {object|null} src.overrideJson parsed data/override.json
 * @param {string[]} [src.extraGaps]    e.g. 'weather' when only a stale forecast is available
 * @param {Date} [src.now]
 * @param {{lat:number, lon:number}} [src.home]
 */
export function buildState(src = {}) {
  const now = src.now instanceof Date ? src.now : new Date();
  const home = src.home ?? HOME;
  const gaps = [];
  if (!src.gdacs?.ok) gaps.push('gdacs');
  if (!src.jtwc?.ok) gaps.push('jtwc');
  for (const g of src.extraGaps ?? []) if (!gaps.includes(g)) gaps.push(g);

  const stormsKnown = hasData(src.gdacs) || hasData(src.jtwc);
  let merged = [];
  try {
    merged = mergeSystems(hasData(src.gdacs) ? src.gdacs.systems : [], hasData(src.jtwc) ? src.jtwc.systems : []);
  } catch (err) {
    console.error('[pipeline] merge failed', err);
    merged = [...(hasData(src.jtwc) ? src.jtwc.systems : []), ...(hasData(src.gdacs) ? src.gdacs.systems : [])];
  }

  const analyses = [];
  for (const system of merged) {
    try {
      analyses.push(analyzeSystem(system, home, now));
    } catch (err) {
      console.error('[pipeline] could not analyse', system?.id, err);
    }
  }

  const threats = new Map();
  for (const a of analyses) {
    try {
      threats.set(a.system.id, stormThreat(a, now));
    } catch {
      threats.set(a.system.id, { level: 0, reasons: [] });
    }
  }
  const sorted = sortAnalyses(analyses, (a) => threats.get(a.system.id)?.level ?? 0);

  const dmh = evaluateDmh(src.dmhJson ?? null, home, now);
  const override = evaluateOverride(src.overrideJson ?? null, now);
  const weather = src.weather ?? null;
  const risk = assessRisk({ systems: stormsKnown ? sorted : null, dmh, weather, override, now, gaps });

  return {
    now,
    analyses: sorted,
    relevant: sorted.filter((a) => a.relevant),
    elsewhere: sorted.filter((a) => !a.relevant),
    threats,
    stormsKnown,
    dmh,
    weather,
    override,
    risk,
  };
}
