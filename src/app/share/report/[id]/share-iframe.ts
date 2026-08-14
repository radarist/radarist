/**
 * Sandbox policy for the PUBLIC share-report iframe.
 *
 * The public `/share/report/[id]` page is unauthenticated and renders report
 * HTML that may contain executable content. An opaque origin is not enough:
 * report-authored JavaScript can still navigate its own frame and make network
 * requests. The public renderer therefore strips active capabilities and gives
 * the iframe no sandbox permissions at all.
 *
 * The authenticated `/reports/[id]` viewer now uses an even stricter static,
 * scriptless opaque-origin preview. Its Print feature uses a separate
 * scriptless iframe rather than weakening that preview.
 *
 * INVARIANT: this must remain the exact empty string (verified by test).
 */
export const SHARE_REPORT_IFRAME_SANDBOX = '';
