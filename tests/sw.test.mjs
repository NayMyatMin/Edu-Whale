// The service worker precaches the app shell so the page (checklist, phone
// numbers, last saved status) opens offline. Every script, stylesheet and
// dictionary the page can load must be in its SHELL list, or an offline
// visit breaks as soon as a module import fails.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sw = readFileSync(join(ROOT, 'sw.js'), 'utf8');
const shellBlock = /const SHELL = \[([\s\S]*?)\];/.exec(sw)?.[1] ?? '';
const SHELL = [...shellBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [relative(ROOT, p).split('\\').join('/')];
  });
}

test('sw.js SHELL lists every file under js/ and css/', () => {
  assert.ok(SHELL.length > 10, 'SHELL list parsed');
  const files = [...walk(join(ROOT, 'js')), ...walk(join(ROOT, 'css'))].filter((f) => /\.(js|css)$/.test(f));
  const missing = files.filter((f) => !SHELL.includes(f));
  assert.deepEqual(missing, [], 'add these to SHELL in sw.js');
});

test('every SHELL entry exists', () => {
  const absent = SHELL.filter((p) => p !== './' && !existsSync(join(ROOT, p)));
  assert.deepEqual(absent, []);
});

test('index.html only references files that exist', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\b(?:src|href)="([^"#:?]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('//'));
  const absent = refs.filter((p) => !existsSync(join(ROOT, p)));
  assert.deepEqual(absent, []);
});

test('sw.js: data files are network-only, app files network-first, install all-or-nothing', () => {
  assert.doesNotMatch(sw, /ignoreSearch/, 'a query-less match returns the oldest cached copy');
  assert.ok(!SHELL.some((p) => p.startsWith('data/')), 'no data file in the shell');
  assert.match(sw, /startsWith\(`\$\{scopePath\}data\/`\)\) return;/, 'data/*.json goes straight to the network');
  assert.match(sw, /cache\.addAll\(CRITICAL\.map\(fresh\)\)/);
  assert.match(sw, /cache: 'no-cache'/);
  assert.doesNotMatch(sw, /cache: 'reload'/, 'unchanged files revalidate (304) instead of downloading again');
});
