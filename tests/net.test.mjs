// A download that stalls half-way must fail within the timeout: otherwise one
// stuck request freezes every later refresh (refresh() runs one at a time).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { fetchJson, fetchText, HttpError, withDeadline } from '../js/net.js';

function server(handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const srv = createServer(handler);
    srv.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    srv.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${srv.address().port}/`;
      resolve({ url, close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(r); }) });
    });
  });
}

test('fetchJson / fetchText: a body that stalls after the headers rejects within the timeout', async () => {
  const srv = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '400000' });
    res.write('{"features":[');
    // …and nothing more.
  });
  try {
    for (const fn of [fetchJson, fetchText]) {
      const t0 = Date.now();
      await assert.rejects(fn(srv.url, { timeoutMs: 400 }), (err) => err.name === 'AbortError' || /abort/i.test(String(err)));
      assert.ok(Date.now() - t0 < 2000, `${fn.name} settled in ${Date.now() - t0} ms`);
    }
  } finally {
    await srv.close();
  }
});

test('fetchJson: slow headers but a quick body still resolve; errors and empty bodies as before', async () => {
  const srv = await server((req, res) => {
    if (req.url === '/404') {
      res.writeHead(404);
      res.end('nope');
    } else if (req.url === '/204') {
      res.writeHead(204);
      res.end();
    } else {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      }, 100);
    }
  });
  try {
    assert.deepEqual(await fetchJson(srv.url, { timeoutMs: 1000 }), { ok: true });
    assert.equal(await fetchJson(`${srv.url}204`, { timeoutMs: 1000 }), null);
    await assert.rejects(fetchJson(`${srv.url}404`, { timeoutMs: 1000 }), (err) => err instanceof HttpError && err.status === 404);
    let date = null;
    await fetchText(srv.url, { timeoutMs: 1000, onResponse: (res) => (date = res.headers.get('date')) });
    assert.ok(date && Number.isFinite(Date.parse(date)), 'onResponse sees the headers');
  } finally {
    await srv.close();
  }
});

test('withDeadline: rejects a promise that never settles', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 50, 'gdacs'), /gdacs: no answer/);
  assert.equal(await withDeadline(Promise.resolve(7), 50), 7);
});
