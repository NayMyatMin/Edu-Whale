import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bearingDeg,
  circlePolygon,
  closestPointOnSegment,
  compass16,
  destinationPoint,
  haversineKm,
  inBbox,
  interpolate,
  pointInGeometry,
  wrapLonDelta,
} from '../js/geo.js';
import { HOME, REGION_BBOX } from '../js/config.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected} ± ${tol}, got ${actual}`);

test('haversineKm matches known distances', () => {
  // 1° of arc on the mean-radius sphere.
  near(haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111.195, 0.01, 'meridian degree');
  near(haversineKm({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111.195, 0.01, 'equator degree');
  // London → Paris ≈ 343.5 km.
  near(haversineKm({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 }), 343.5, 1, 'London–Paris');
  // DMH Deep Depression 28 Sep 2026 at 17.1N 97.0E was "89 km" from Yangon.
  near(haversineKm(HOME, { lat: 17.1, lon: 97.0 }), 89, 1.5, 'DMH position');
  // JTWC: Invest 92W at 14.4N 98.0E "approximately 177 NM southeast of Yangon" (≈ 328 km).
  near(haversineKm(HOME, { lat: 14.4, lon: 98.0 }), 328, 12, '92W');
  assert.equal(haversineKm(HOME, HOME), 0);
  // Symmetric.
  const a = { lat: 10, lon: 90 };
  const b = { lat: 20, lon: 100 };
  near(haversineKm(a, b), haversineKm(b, a), 1e-9);
});

test('bearingDeg and compass16', () => {
  near(bearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 1e-9, 'north');
  near(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 1e-9, 'east');
  near(bearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }), 180, 1e-9, 'south');
  near(bearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 }), 270, 1e-9, 'west');
  assert.equal(compass16(bearingDeg(HOME, { lat: 17.1, lon: 97.0 })), 'ENE'); // DMH: "ENE of Yangon"
  assert.equal(compass16(bearingDeg(HOME, { lat: 14.4, lon: 98.0 })), 'SE'); // JTWC: "southeast of Yangon"

  const cases = [
    [0, 'N'], [11.2, 'N'], [11.3, 'NNE'], [45, 'NE'], [67.5, 'ENE'], [90, 'E'], [180, 'S'],
    [247.5, 'WSW'], [270, 'W'], [348.7, 'NNW'], [348.8, 'N'], [359.9, 'N'], [360, 'N'], [720 + 90, 'E'],
    [-22.5, 'NNW'], [-90, 'W'],
  ];
  for (const [deg, code] of cases) assert.equal(compass16(deg), code, `compass16(${deg})`);
});

test('wrapLonDelta and seam handling', () => {
  assert.equal(wrapLonDelta(0), 0);
  assert.equal(wrapLonDelta(190), -170);
  assert.equal(wrapLonDelta(-190), 170);
  assert.equal(wrapLonDelta(360 + 45), 45);
  // Across the date line the short way round, not 359°.
  near(haversineKm({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }), 111.195, 0.01, 'seam distance');
  near(bearingDeg({ lat: 0, lon: 179.5 }, { lat: 0, lon: -179.5 }), 90, 1e-6, 'seam bearing');
  const mid = interpolate({ lat: 0, lon: 179 }, { lat: 0, lon: -179 }, 0.5);
  near(Math.abs(mid.lon), 180, 1e-9, 'seam midpoint');
  const q = interpolate({ lat: 0, lon: 179 }, { lat: 2, lon: -179 }, 0.25);
  near(q.lon, 179.5, 1e-9);
  near(q.lat, 0.5, 1e-9);
  // Closest point on a segment that crosses the seam.
  const c = closestPointOnSegment({ lat: 1, lon: 180 }, { lat: 0, lon: 179 }, { lat: 0, lon: -179 });
  near(c.t, 0.5, 1e-6);
  near(c.distanceKm, 111.2, 0.5);
});

test('destinationPoint round-trips distance and bearing', () => {
  for (const [brg, km] of [[45, 100], [200, 850], [300, 2500]]) {
    const d = destinationPoint(HOME, brg, km);
    near(haversineKm(HOME, d), km, 0.01, `distance ${km}`);
    near(bearingDeg(HOME, d), brg, 0.01, `bearing ${brg}`);
  }
  const wrapped = destinationPoint({ lat: 0, lon: 179.9 }, 90, 111.195);
  near(wrapped.lon, -179.1, 1e-3, 'wraps past 180');
});

test('closestPointOnSegment', () => {
  // Yangon vs the TCFA 92W axis 14.3N 98.1E → 17.2N 96.6E (the corridor passes just east of the city).
  const r = closestPointOnSegment(HOME, { lat: 14.3, lon: 98.1 }, { lat: 17.2, lon: 96.6 });
  assert.ok(r.t > 0 && r.t < 1);
  near(r.distanceKm, 55, 3);
  // Clamped to the ends.
  const end = closestPointOnSegment({ lat: 0, lon: -5 }, { lat: 0, lon: 0 }, { lat: 0, lon: 10 });
  assert.equal(end.t, 0);
  near(end.distanceKm, 5 * 111.195, 0.1);
  // Degenerate segment.
  const same = closestPointOnSegment({ lat: 1, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 0 });
  assert.equal(same.t, 0);
  near(same.distanceKm, 111.195, 0.01);
});

test('circlePolygon ring radius', () => {
  const ring = circlePolygon(HOME, 150, 36);
  assert.equal(ring.length, 36);
  for (const [lat, lon] of ring) near(haversineKm(HOME, { lat, lon }), 150, 0.01);
});

test('inBbox', () => {
  assert.ok(inBbox(HOME, REGION_BBOX));
  assert.ok(inBbox({ lat: 14.4, lon: 98.0 }, REGION_BBOX));
  assert.ok(!inBbox({ lat: 27.5, lon: 132.8 }, REGION_BBOX));
  assert.ok(inBbox({ lat: 5, lon: 78 }, REGION_BBOX), 'edges are inclusive');
});

test('pointInGeometry: Polygon, holes, MultiPolygon, seam', () => {
  const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
  const poly = { type: 'Polygon', coordinates: [square(90, 10, 100, 20)] };
  assert.ok(pointInGeometry(HOME, poly));
  assert.ok(!pointInGeometry({ lat: 25, lon: 96 }, poly));
  assert.ok(!pointInGeometry({ lat: 15, lon: 101 }, poly));

  const holed = { type: 'Polygon', coordinates: [square(90, 10, 100, 20), square(95, 15, 97, 18)] };
  assert.ok(!pointInGeometry(HOME, holed), 'inside the hole');
  assert.ok(pointInGeometry({ lat: 12, lon: 92 }, holed), 'outside the hole');

  const multi = {
    type: 'MultiPolygon',
    coordinates: [[square(80, 0, 85, 5)], [square(95, 16, 97, 18)]],
  };
  assert.ok(pointInGeometry(HOME, multi), 'in the second polygon');
  assert.ok(pointInGeometry({ lat: 2, lon: 82 }, multi), 'in the first polygon');
  assert.ok(!pointInGeometry({ lat: 10, lon: 90 }, multi));

  // GDACS writes seam-straddling areas with lon jumping 179 → -179.
  const seam = { type: 'Polygon', coordinates: [[[170, -10], [-170, -10], [-170, 10], [170, 10], [170, -10]]] };
  assert.ok(pointInGeometry({ lat: 0, lon: 179.5 }, seam));
  assert.ok(pointInGeometry({ lat: 0, lon: -175 }, seam));
  assert.ok(!pointInGeometry({ lat: 0, lon: 160 }, seam));

  assert.equal(pointInGeometry(HOME, null), false);
  assert.equal(pointInGeometry(HOME, { type: 'Point', coordinates: [96, 16] }), false);
});
