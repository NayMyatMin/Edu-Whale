import { FETCH_TIMEOUT_MS } from './config.js';

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/**
 * fetch() with a timeout. Resolves to the Response for 2xx, throws
 * HttpError otherwise (and on timeout, an AbortError).
 */
export async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new HttpError(res.status, url);
    return res;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** JSON body, or null for 204 / empty bodies (GDACS returns 204 for "no events"). */
export async function fetchJson(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text.trim()) return null;
  return JSON.parse(text);
}

export async function fetchText(url, opts) {
  const res = await fetchWithTimeout(url, opts);
  return res.text();
}

/** Run async `fn` over `items` with at most `limit` in flight. Never rejects; failures become null. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
