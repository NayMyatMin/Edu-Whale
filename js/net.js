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
 *
 * The timeout only covers the response headers unless `read` is given:
 * `read(res)` then runs inside it (a body that stalls half-way would
 * otherwise hang for ever) and its result is returned instead of the
 * Response. `onResponse(res)` sees the Response (e.g. its Date header).
 */
export async function fetchWithTimeout(url, { timeoutMs = FETCH_TIMEOUT_MS, signal, read, onResponse, ...init } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) ctrl.abort();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      res.body?.cancel?.().catch(() => {});
      throw new HttpError(res.status, url);
    }
    try {
      onResponse?.(res);
    } catch {
      /* a listener must not break the fetch */
    }
    return read ? await read(res) : res;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

const readText = (res) => (res.status === 204 ? '' : res.text());

/** JSON body, or null for 204 / empty bodies (GDACS returns 204 for "no events"). */
export async function fetchJson(url, opts) {
  const text = await fetchWithTimeout(url, { ...opts, read: readText });
  if (!text.trim()) return null;
  return JSON.parse(text);
}

/** Text body; the timeout covers the whole download. */
export async function fetchText(url, opts) {
  return fetchWithTimeout(url, { ...opts, read: readText });
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

/** `promise`, or a rejection with a TimeoutError after `ms` (the promise itself keeps running). */
export function withDeadline(promise, ms, label = 'request') {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label}: no answer within ${Math.round(ms / 1000)} s`);
      err.name = 'TimeoutError';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}
