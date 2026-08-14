/**
 * @file build-preview-readiness.ts
 * @description Bounded readiness probe for a restarted build-artifact preview
 * (BUILD-026).
 *
 * `POST /api/missions/:id/start` revives a stopped sandbox container and
 * relaunches its dev server. `docker start` returning and the exec launching
 * are self-reports — neither proves the preview is actually serving. Before the
 * route claims the artifact started, it probes the preview URL until it answers
 * with a successful 2xx response or a bounded budget elapses, so a dead,
 * missing, or compile-error preview is never reported as a live one.
 *
 * Fully injectable (fetch + sleep) so it unit-tests without real sockets or
 * real waiting.
 */

export interface PreviewReadinessOptions {
  /** Max number of probe attempts (default 20). */
  attempts?: number;
  /** Delay between attempts in ms (default 1000). */
  delayMs?: number;
  /** Per-attempt request timeout in ms (default 3000). */
  timeoutMs?: number;
  /** Maximum same-origin redirects followed within one attempt (default 5, hard cap 10). */
  maxRedirects?: number;
  /** Injectable fetch (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (defaults to a real setTimeout-based sleep). */
  sleepImpl?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;
const MAX_REDIRECTS_HARD_LIMIT = 10;

function normalizedUrl(value: string | URL, base?: URL): URL | null {
  try {
    const url = base ? new URL(value, base) : new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Fragments are not sent over HTTP and must not create distinct loop keys.
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

async function probePreview(
  previewUrl: URL,
  doFetch: typeof fetch,
  signal: AbortSignal,
  maxRedirects: number
): Promise<boolean> {
  let currentUrl = previewUrl;
  let redirectCount = 0;
  const visited = new Set([currentUrl.href]);

  while (true) {
    const response = await doFetch(currentUrl.href, { signal, redirect: 'manual' });
    if (response.status >= 200 && response.status < 300) return true;
    if (!REDIRECT_STATUSES.has(response.status)) return false;
    if (redirectCount >= maxRedirects) return false;

    const location = response.headers.get('location');
    if (!location) return false;

    const nextUrl = normalizedUrl(location, currentUrl);
    if (!nextUrl || nextUrl.origin !== previewUrl.origin || visited.has(nextUrl.href)) return false;

    visited.add(nextUrl.href);
    currentUrl = nextUrl;
    redirectCount += 1;
  }
}

/**
 * Resolves `true` as soon as `previewUrl` answers successfully (2xx), `false` if it is
 * still unreachable after the whole attempt budget. Never throws — a refused
 * connection or an aborted timeout is just "not ready yet".
 */
export async function waitForPreviewReady(previewUrl: string, opts: PreviewReadinessOptions = {}): Promise<boolean> {
  const attempts = opts.attempts ?? 20;
  const delayMs = opts.delayMs ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const requestedMaxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxRedirects = Number.isFinite(requestedMaxRedirects)
    ? Math.min(MAX_REDIRECTS_HARD_LIMIT, Math.max(0, Math.floor(requestedMaxRedirects)))
    : 0;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? realSleep;
  const initialUrl = normalizedUrl(previewUrl);

  if (!initialUrl) return false;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      if (await probePreview(initialUrl, doFetch, controller.signal, maxRedirects)) return true;
    } catch {
      // ECONNREFUSED / abort — the server isn't accepting connections yet.
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  return false;
}
