/**
 * @file components/activity/run-formatters.ts
 * @description Pure display formatters shared by the run surfaces (table,
 * run detail, chat tool summary).
 *
 * These live outside `RunsTable.tsx` on purpose: that module is a client
 * component that reaches auth, routing and filter state, so importing it
 * just to format a number pulled the whole tree — and its dependencies —
 * into unrelated consumers and their tests.
 *
 * Both formatters render `undefined` as an em dash rather than a zero:
 * "no value was recorded" and "the value was zero" are different facts
 * (ARUN-007/008), and only one of them is safe to state as a number.
 */

/** Token count with a K suffix; "—" when nothing was recorded. */
export function formatTokens(count: number | undefined): string {
  if (count === undefined) return '—';
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return String(count);
}

/** Human duration ("450ms" / "4.5s" / "6m 52s"); "—" when unknowable. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  const roundedSeconds = Math.round(seconds);
  if (roundedSeconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
