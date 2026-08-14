/**
 * @file reports/[id]/print-report-iframe.ts
 * @description Print handler for the report detail page (P-F5).
 *
 * Extracted from page.tsx so the guard logic is unit-testable without
 * rendering the page — App Router page files can't carry extra named
 * exports (same pattern as src/app/library/initiatives/date-range.ts).
 *
 * The active report preview is intentionally opaque-origin and cannot be
 * inspected or printed by its authenticated parent. Printing therefore uses
 * a second, static iframe: it is same-origin so the parent can invoke print,
 * but scripts are not permitted in that frame. Safari/Firefox only honor
 * `contentWindow.print()` after the window has received focus, so `focus()` is
 * called first (a harmless no-op on Chrome).
 */

/**
 * The preview receives no sandbox capability. Report scripts and event handlers
 * are removed before loading; the empty sandbox is the independent browser
 * backstop that also denies origin, navigation, forms, popups, downloads, and
 * modals.
 */
export const REPORT_IFRAME_SANDBOX = '';

/**
 * The print-only frame is readable by the parent and may open the browser print
 * dialog, but its content is static and the sandbox deliberately omits scripts.
 */
export const REPORT_PRINT_IFRAME_SANDBOX = 'allow-same-origin allow-modals';

export interface PrintableIframe {
  contentWindow: Pick<Window, 'focus' | 'print'> | null;
}

/**
 * Prints the report iframe's document. Returns `false` (and prints
 * nothing) when the iframe hasn't finished loading yet or has no window
 * to print — both true for the brief window between mount and the
 * iframe's `load` event, during which the Print button is already
 * clickable.
 */
export function printReportIframe(iframe: PrintableIframe | null, loaded: boolean): boolean {
  if (!loaded) return false;
  const contentWindow = iframe?.contentWindow;
  if (!contentWindow) return false;
  try {
    contentWindow.focus();
    contentWindow.print();
    return true;
  } catch {
    return false;
  }
}
