/**
 * @file lib/firecrawl-fetch.ts
 * @description ARUN-022 — the ONE server-only Firecrawl fetch boundary.
 *
 * Two HTTP routes (`/api/documents/url` and `/api/documents/reprocess-url`)
 * previously carried byte-identical inline Firecrawl + basic-fetch logic
 * ("copied from url/route.ts for self-contained endpoint"). That duplication
 * meant the paid Firecrawl provider call had no single chokepoint, so it could
 * not be receipted without double counting. This module is that chokepoint.
 *
 * Receipt contract (requirement: one provider call produces one receipt):
 *   - When `FIRECRAWL_API_KEY` is set and a scrape is ATTEMPTED, exactly ONE
 *     operation-usage capture is emitted into the ambient sink — whether the
 *     scrape returned markdown, returned an HTTP error, or threw. Firecrawl is
 *     credit-based and reports no per-call amount here, so the fee is
 *     `applicable-but-unknown` (never read as $0), and usage is `unreported`
 *     (the scrape API returns no token counters).
 *   - The basic HTTP fallback is ZERO-PROVIDER (a plain `fetch(url)` against the
 *     target site, billed by nobody) and must NEVER fabricate a receipt.
 *
 * Capture is a strict no-op when no operation-usage sink is active, and never
 * throws into the fetch path. No URL, body, title, or page content enters the
 * receipt — capture is content-free.
 *
 * @author Radarist Team
 * @created 2026-07-24
 */

import 'server-only';
import { captureProviderUsage } from '@/lib/operation-context';
import { createLogger } from '@/lib/logger';

const log = createLogger('firecrawl-fetch');

export interface FirecrawlFetchResult {
  success: boolean;
  content?: string;
  title?: string;
  error?: string;
  /** True when a PAID Firecrawl provider call was actually made. */
  usedFirecrawl: boolean;
}

/**
 * ARUN-022 — record exactly ONE Firecrawl provider call into the ambient
 * operation-usage sink. No-op without a sink, and never throws. Firecrawl
 * reports no per-call token counters and no per-call amount, so the honest
 * receipt is `unreported` usage with an `applicable-but-unknown` fee.
 */
function captureFirecrawlCall(): void {
  try {
    captureProviderUsage({
      provider: 'firecrawl',
      operation: 'firecrawl.scrape',
      counters: {},
      usageCompleteness: 'unreported',
      occurredAt: new Date().toISOString(),
      // Firecrawl is a paid credit-based provider; the per-call charge is not
      // reported, so it must never read as $0.
      feeState: 'applicable-but-unknown',
    });
  } catch (captureError) {
    log.debug('firecrawl usage capture skipped (non-fatal)', {
      error: captureError instanceof Error ? captureError.message : String(captureError),
    });
  }
}

/**
 * Zero-provider basic HTTP fetch with simple HTML→text extraction. Used as a
 * fallback when Firecrawl is not configured or fails. This is NOT a provider
 * call (it is a plain fetch against the target URL) and emits NO receipt.
 */
async function basicFetchUrlContent(url: string): Promise<FirecrawlFetchResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Radarist/1.0 (Knowledge Tab; Research Bot)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      return {
        success: false,
        usedFirecrawl: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : undefined;
    const content = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return { success: true, usedFirecrawl: false, content, title };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, usedFirecrawl: false, error: 'Request timeout' };
    }
    return {
      success: false,
      usedFirecrawl: false,
      error: error instanceof Error ? error.message : 'Failed to fetch URL',
    };
  }
}

/**
 * Fetch URL content using the Firecrawl API when configured, falling back to a
 * zero-provider basic fetch. Emits exactly ONE operation-usage capture per
 * Firecrawl provider call (success or failure); the basic fallback emits none.
 */
export async function fetchUrlContent(url: string): Promise<FirecrawlFetchResult> {
  const firecrawlApiKey = process.env.FIRECRAWL_API_KEY;

  if (!firecrawlApiKey) {
    return basicFetchUrlContent(url);
  }

  // One PAID Firecrawl provider call. Settle the fetch promise exactly once so a
  // single capture is emitted whether the scrape returned markdown, returned an
  // HTTP error, or threw — the call is billed regardless of outcome.
  const attempt: { response?: Response; error?: unknown } = await fetch(
    'https://api.firecrawl.dev/v1/scrape',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${firecrawlApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
    }
  )
    .then((response) => ({ response }))
    .catch((error) => ({ error }));

  // ARUN-022 — exactly one receipt per Firecrawl provider call.
  captureFirecrawlCall();

  if (attempt.response) {
    const response = attempt.response;
    if (response.ok) {
      try {
        const data = await response.json();
        if (data.success && data.data) {
          return {
            success: true,
            usedFirecrawl: true,
            content: data.data.markdown || data.data.content,
            title: data.data.metadata?.title,
          };
        }
      } catch (parseError) {
        log.warn('Firecrawl response parse failed, falling back to basic fetch', {
          error: parseError instanceof Error ? parseError.message : String(parseError),
        });
      }
    } else {
      log.warn('Firecrawl request failed, falling back to basic fetch');
    }
  } else {
    log.warn('Firecrawl error, falling back to basic fetch');
  }

  // Paid call was made (already captured); fall back to the zero-provider basic
  // fetch to still return content when possible. usedFirecrawl stays true so the
  // caller knows the provider was billed even though the fallback produced text.
  const fallback = await basicFetchUrlContent(url);
  return { ...fallback, usedFirecrawl: true };
}

/**
 * ARUN-022 — fetch a URL AND durably receipt any Firecrawl provider call under
 * the given owner/correlation. Opens an ambient operation-usage sink around the
 * fetch, then flushes the capture as a standalone (`mcp`-correlated) receipt —
 * the schema's slot for a standalone external provider call with no bound
 * mission/agent-run, which is exactly what a document-ingest scrape is.
 *
 * The flush is best-effort and non-fatal: a ledger write failure is logged and
 * swallowed (the durable accounting marker inside the flush records the loss
 * when it can) and never breaks the document pipeline. When no Firecrawl call
 * was made (`usedFirecrawl: false`, e.g. no API key configured), there is no
 * capture and the flush records nothing.
 *
 * `correlationId` MUST be stable for the logical operation (e.g. the document
 * id or a reserved request id) so a legitimate retry is idempotent rather than
 * a duplicate.
 */
export async function fetchUrlContentReceipted(
  url: string,
  correlation: { owner: string; correlationId: string }
): Promise<FirecrawlFetchResult> {
  // Guard ONLY the instrumentation import: a load failure degrades to "no sink"
  // and the fetch still runs (uncaptured). The fetch's own errors propagate.
  let instrument: typeof import('@/lib/operation-receipt-instrument') | undefined;
  try {
    instrument = await import('@/lib/operation-receipt-instrument');
  } catch (instrumentationError) {
    log.warn('operation-usage instrumentation unavailable; Firecrawl call will not emit a receipt', {
      error: instrumentationError instanceof Error ? instrumentationError.message : String(instrumentationError),
    });
  }

  if (!instrument) {
    return fetchUrlContent(url);
  }

  const { result, captured } = await instrument.withCapturedUsage(() => fetchUrlContent(url));

  if (captured.length > 0) {
    try {
      await instrument.flushCapturedUsage(
        {
          parentType: 'mcp',
          owner: correlation.owner,
          correlationId: correlation.correlationId,
        },
        captured,
        // Stable prefix derived from the correlation so an exact retry is
        // idempotent, not a duplicate.
        `firecrawl-${correlation.correlationId}`,
        // A document-ingest scrape has no parent headline to fold into.
        'standalone'
      );
    } catch (flushError) {
      log.warn('Firecrawl receipt flush failed (best-effort, non-fatal)', {
        owner: correlation.owner,
        correlationId: correlation.correlationId,
        captured: captured.length,
        error: flushError instanceof Error ? flushError.message : String(flushError),
      });
    }
  }

  return result;
}
