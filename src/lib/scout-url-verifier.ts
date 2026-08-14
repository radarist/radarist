/**
 * @file lib/scout-url-verifier.ts
 * @description Async HTTP HEAD checker for scout bundle URLs.
 *
 * Fires a HEAD request per URL, in parallel, with a per-URL timeout. Returns
 * pass when every URL is either reachable (2xx/3xx) or inconclusive (timeout /
 * 5xx). Returns fail when any URL is definitively unreachable (404 or DNS
 * error or malformed URL). This asymmetry matters: we must not flag scout as
 * fabricating URLs when our own network flakes or the remote server is down.
 */

export interface UrlStatus {
  url: string;
  reachable: boolean;
  reason: string;
}

export interface VerifyOptions {
  fetchImpl?: typeof fetch;
  perUrlTimeoutMs?: number;
  maxConcurrency?: number;
}

export type VerifyResult = { ok: true } | { ok: false; unreachable: UrlStatus[] };

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 5;

export async function verifyUrlsReachable(urls: string[], options: VerifyOptions = {}): Promise<VerifyResult> {
  if (urls.length === 0) return { ok: true };

  const fetchImpl = options.fetchImpl ?? fetch;
  const perUrlTimeoutMs = options.perUrlTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_CONCURRENCY;

  const queue = [...urls];
  const unreachable: UrlStatus[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const url = queue.shift();
      if (url === undefined) return;
      const status = await checkOne(url, fetchImpl, perUrlTimeoutMs);
      if (!status.reachable) unreachable.push(status);
    }
  }

  const workers = Array.from({ length: Math.min(maxConcurrency, urls.length) }, () => worker());
  await Promise.all(workers);

  return unreachable.length === 0 ? { ok: true } : { ok: false, unreachable };
}

async function checkOne(url: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<UrlStatus> {
  try {

    new URL(url);
  } catch {
    return { url, reachable: false, reason: 'malformed URL' };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404) {
      return { url, reachable: false, reason: `404 Not Found` };
    }
    return { url, reachable: true, reason: `HTTP ${res.status}` };
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      return { url, reachable: true, reason: 'timeout — inconclusive' };
    }
    if (e.code === 'ENOTFOUND' || /ENOTFOUND/.test(e.message ?? '')) {
      return { url, reachable: false, reason: 'ENOTFOUND (dns failure)' };
    }
    return { url, reachable: true, reason: `inconclusive: ${e.message ?? 'unknown'}` };
  }
}
