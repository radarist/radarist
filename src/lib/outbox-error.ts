/**
 * @file lib/outbox-error.ts
 * @description Shared bound for error text persisted on a durable outbox marker.
 *
 * Both durable outboxes store the last failure so an operator can see *why* a
 * marker is stuck. A pathological driver message must not be able to bloat the
 * document, and the two outboxes must not drift into two different bounds — so
 * the normalizer lives here as a dependency-free leaf that
 * `entity-graph-sync-outbox.ts` and `relation-sync-outbox.ts` both import.
 */

/** Bound stored error text so a pathological message cannot bloat the document. */
export const MAX_OUTBOX_ERROR_LENGTH = 500;

export function normalizeOutboxError(error: unknown): string | null {
  if (error === undefined || error === null) return null;
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_OUTBOX_ERROR_LENGTH);
}
