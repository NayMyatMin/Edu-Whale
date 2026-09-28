// localStorage snapshot cache. Dates survive the JSON round trip as
// {"$date": iso}. Every storage access is wrapped: private windows, full
// quotas and blocked storage must never break the page.

const PREFIX = 'ysw.cache.';
const VERSION = 1;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** JSON with Dates encoded as {"$date": iso} (invalid Dates → null). */
export function encode(value) {
  return JSON.stringify(value, function replacer(key, v) {
    const raw = this[key];
    if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? { $date: raw.toISOString() } : null;
    return v;
  });
}

/** Inverse of encode(). Throws on malformed JSON. */
export function decode(text) {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.$date === 'string' && Object.keys(v).length === 1) {
      const d = new Date(v.$date);
      return Number.isFinite(d.getTime()) ? d : null;
    }
    return v;
  });
}

/**
 * Stored entry with its save time, or null (missing, unreadable, other version).
 * @returns {{value: any, savedAt: Date|null}|null}
 */
export function loadEntry(key) {
  try {
    const text = storage()?.getItem(PREFIX + key);
    if (!text) return null;
    const env = decode(text);
    if (!env || env.v !== VERSION || !('value' in env)) return null;
    return { value: env.value, savedAt: env.savedAt instanceof Date ? env.savedAt : null };
  } catch {
    return null;
  }
}

/** Stored value or null. */
export function load(key) {
  return loadEntry(key)?.value ?? null;
}

/** Save `value`; false when storage is unavailable or full. */
export function save(key, value, savedAt = new Date()) {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(PREFIX + key, encode({ v: VERSION, savedAt, value }));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    storage()?.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}
