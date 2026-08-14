/**
 * @file lib/inngest/utils.ts
 * @description Utility functions for Inngest jobs
 *
 * NOTE: This file must NOT import firebase-admin or any server-only modules
 * to avoid polluting client bundles.
 */

import { createLogger } from '@/lib/logger';

const log = createLogger('inngest/utils');

/**
 * Convert various timestamp formats to milliseconds number
 *
 * Handles:
 * - number (already milliseconds)
 * - Firestore Timestamp instances (with toMillis method)
 * - Serialized timestamp objects (from JSON/Inngest events, with seconds/nanoseconds)
 * - Date objects
 * - null/undefined (returns default)
 *
 * This is needed because Firestore timestamps get serialized when passed through
 * Inngest events, losing their toMillis() method and becoming plain objects like:
 * { seconds: 1768679000, nanoseconds: 190000000, type: "firestore/timestamp/1.0" }
 *
 * @param timestamp - The timestamp value to convert
 * @param defaultValue - Value to return if timestamp is null/undefined (default: Date.now())
 * @returns Timestamp as milliseconds number
 */
export function toMillis(timestamp: unknown, defaultValue: number = Date.now()): number {
  if (timestamp === null || timestamp === undefined) {
    return defaultValue;
  }

  // Already a number (milliseconds)
  if (typeof timestamp === 'number') {
    return timestamp;
  }

  // Firestore Timestamp instance with toMillis() method
  if (
    typeof timestamp === 'object' &&
    'toMillis' in timestamp &&
    typeof (timestamp as { toMillis: () => number }).toMillis === 'function'
  ) {
    return (timestamp as { toMillis: () => number }).toMillis();
  }

  // Serialized Firestore timestamp (from JSON/Inngest events) with seconds/nanoseconds
  // This happens when timestamps pass through Inngest event serialization
  if (typeof timestamp === 'object' && timestamp !== null) {
    const ts = timestamp as {
      seconds?: number;
      _seconds?: number;
      nanoseconds?: number;
      _nanoseconds?: number;
    };

    // Check for both public (seconds) and private (_seconds) property names
    const seconds = ts.seconds ?? ts._seconds;
    const nanoseconds = ts.nanoseconds ?? ts._nanoseconds ?? 0;

    if (typeof seconds === 'number') {
      return seconds * 1000 + Math.floor(nanoseconds / 1000000);
    }
  }

  // Date object
  if (timestamp instanceof Date) {
    return timestamp.getTime();
  }

  // Fallback - log warning and return default
  log.warn('Unknown timestamp format, using default', { timestamp: String(timestamp) });
  return defaultValue;
}

/**
 * Extract the ORIGINAL event's data from an Inngest v3 `onFailure` payload.
 *
 * In `onFailure`, the handler receives the internal `inngest/function.failed`
 * event — the original triggering event is nested at `event.data.event`, so
 * reading `event.data.<field>` directly returns `undefined`. This helper
 * unwraps the nesting safely (returning `{}` when any level is absent) so
 * callers can fall back to `'unknown'` per field.
 *
 * Usage:
 * ```typescript
 * onFailure: async ({ error, event }) => {
 *   const data = extractFailureEventData<{ signalId?: string }>(event.data);
 *   const signalId = data.signalId || 'unknown';
 * }
 * ```
 *
 * @param failureEventData - `event.data` as received inside `onFailure`
 * @returns The original event's `data` object, or `{}` if not present
 */
export function extractFailureEventData<T extends object>(failureEventData: unknown): Partial<T> {
  if (!failureEventData || typeof failureEventData !== 'object') return {};
  const originalEvent = (failureEventData as Record<string, unknown>).event;
  if (!originalEvent || typeof originalEvent !== 'object') return {};
  const data = (originalEvent as Record<string, unknown>).data;
  if (!data || typeof data !== 'object') return {};
  return data as Partial<T>;
}
