const REPORT_BRAND_CSS_PATH = '/css/report-brand.css';
export const REPORT_BRAND_CSS_TIMEOUT_MS = 2_000;

interface LoadReportBrandCssOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Optional report branding must never block access to sanitized report HTML. */
export async function loadReportBrandCss({
  signal,
  timeoutMs = REPORT_BRAND_CSS_TIMEOUT_MS,
}: LoadReportBrandCssOptions = {}): Promise<string | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });

  const timeoutId = setTimeout(abort, timeoutMs);
  try {
    const response = await fetch(REPORT_BRAND_CSS_PATH, { signal: controller.signal });
    return response.ok ? await response.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }
}
