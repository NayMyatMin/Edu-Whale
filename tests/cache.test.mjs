import test from 'node:test';
import assert from 'node:assert/strict';

import { decode, encode, load, loadEntry, remove, save } from '../js/cache.js';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function withStorage(storage, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => (typeof storage === 'function' ? storage() : storage) });
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
}

test('encode/decode keeps Dates (nested, in arrays) and drops invalid ones to null', () => {
  const value = {
    fetchedAt: new Date('2026-09-28T15:00:00Z'),
    systems: [{ position: { lat: 17.1, lon: 97, time: new Date('2026-09-28T12:30:00Z') }, track: [{ time: new Date(0) }] }],
    bad: new Date('nope'),
    text: 'plain',
    lookalike: { $date: 'x', other: 1 },
  };
  const text = encode(value);
  assert.match(text, /"\$date":"2026-09-28T15:00:00.000Z"/);
  const back = decode(text);
  assert.ok(back.fetchedAt instanceof Date);
  assert.equal(back.fetchedAt.toISOString(), '2026-09-28T15:00:00.000Z');
  assert.ok(back.systems[0].position.time instanceof Date);
  assert.equal(back.systems[0].track[0].time.getTime(), 0);
  assert.equal(back.bad, null);
  assert.equal(back.text, 'plain');
  assert.deepEqual(back.lookalike, { $date: 'x', other: 1 }, 'only exact {$date} objects are revived');
});

test('save/load round trip with save time', () => {
  const store = new MemoryStorage();
  withStorage(store, () => {
    const savedAt = new Date('2026-09-28T15:00:00Z');
    assert.equal(save('snapshot', { at: new Date('2026-09-28T14:00:00Z'), n: 3 }, savedAt), true);
    const entry = loadEntry('snapshot');
    assert.equal(entry.savedAt.toISOString(), savedAt.toISOString());
    assert.equal(entry.value.n, 3);
    assert.ok(entry.value.at instanceof Date);
    assert.deepEqual(load('snapshot'), entry.value);
    assert.ok([...store.map.keys()].every((k) => k.startsWith('ysw.cache.')), 'namespaced keys');
    remove('snapshot');
    assert.equal(load('snapshot'), null);
  });
});

test('missing, corrupt or foreign entries load as null', () => {
  const store = new MemoryStorage();
  withStorage(store, () => {
    assert.equal(load('nothing'), null);
    store.setItem('ysw.cache.bad', '{not json');
    assert.equal(load('bad'), null);
    store.setItem('ysw.cache.old', JSON.stringify({ v: 0, value: 1 }));
    assert.equal(load('old'), null);
  });
});

test('never throws when storage is missing, blocked or full', () => {
  withStorage(undefined, () => {
    assert.equal(save('x', 1), false);
    assert.equal(load('x'), null);
  });
  withStorage(
    () => {
      throw new Error('SecurityError');
    },
    () => {
      assert.equal(save('x', 1), false);
      assert.equal(load('x'), null);
      assert.doesNotThrow(() => remove('x'));
    },
  );
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  withStorage(full, () => assert.equal(save('x', { big: 'x'.repeat(10) }), false));
});
