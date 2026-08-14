import { format } from 'date-fns';

/**
 * Wraps date-fns `format` so a malformed/invalid date renders a safe
 * fallback ('—' by default) instead of throwing `RangeError: Invalid time
 * value`. Record tables must never crash on a bad timestamp (CONV-DATE).
 */
export function safeFormatDate(date: string | number | Date, pattern: string, fallback = '—'): string {
  try {
    return format(new Date(date), pattern);
  } catch {
    return fallback;
  }
}
