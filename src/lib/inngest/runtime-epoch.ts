/**
 * @file lib/inngest/runtime-epoch.ts
 * @description LOCAL-013 — identity of the local runtime that started a job run.
 *
 * Kept in its own module so the observability writer and the recovery reader
 * share one definition of what an epoch is, without either importing the other.
 */

/** Environment variable the local launcher stamps with the current runtime epoch. */
export const LOCAL_RUNTIME_EPOCH_ENV = 'RADARIST_LOCAL_RUNTIME_EPOCH';

/** Bounded identifier shape — this value is written to Firestore on every job start. */
const RUNTIME_EPOCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Read a runtime epoch, or `undefined` when none was stamped.
 *
 * Returns `undefined` rather than throwing on a malformed value: an unusable
 * epoch must degrade to "cannot prove this run is stale", which leaves the
 * record untouched, not to a crash in the job-start path.
 */
export function parseRuntimeEpoch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return RUNTIME_EPOCH_PATTERN.test(trimmed) ? trimmed : undefined;
}
