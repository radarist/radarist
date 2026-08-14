/**
 * @file lib/reports/select-canonical-report.ts
 * @description REPORT-002 — the ONE client-safe rule that resolves a mission's
 * canonical owner-scoped Report from an already-fetched catalog list.
 *
 * Activity (AgentLog) and the run-detail Output card both deep-link a run to
 * "the Report its mission produced". Before this each did its own ad-hoc
 * lookup — a first-wins `Map` build in one surface, an `Array.find` in the
 * other — over the `/api/reports` list. That was wrong in two ways:
 *
 *  - a mission that published more than one Report (multiple slots) resolved to
 *    an ARBITRARY one: whichever the catalog's `createdAt`-desc order happened
 *    to place first, with NO tiebreaker on equal timestamps — so the winner
 *    could differ between reads and between the two surfaces; and
 *  - the two surfaces re-implemented the rule independently, free to drift.
 *
 * This module is the single selector both surfaces call. It mirrors the SERVER
 * canonical rule in `getReportsByMissionIdOwnedBy` (`src/lib/reports.ts`):
 * newest-first by `createdAt`, with report `id` as a stable tiebreaker, so
 * equal timestamps produce exactly ONE deterministic winner and Activity and
 * run detail always agree.
 *
 * It is a pure function over already-fetched Report list items — no server
 * imports — so `"use client"` components can call it directly.
 *
 * Owner scope: the catalog is owner-scoped server-side (`listReportsOwnedBy`),
 * so a foreign Report can never reach here in normal operation. As
 * defense-in-depth this selector ALSO:
 *  - refuses any Report that carries no `ownerId` (an ownerless legacy record
 *    can never become a run's linked canonical Report); and
 *  - when the caller passes the authenticated `ownerId`, refuses any Report
 *    whose `ownerId` differs — so even a mis-scoped list can never surface a
 *    foreign Report as a run's output.
 */

/** Minimal shape both call sites already satisfy (`Report` / `ReportListItem`). */
export interface CanonicalReportCandidate {
  id?: string;
  missionId?: string;
  ownerId?: string;
  createdAt?: string;
}

/**
 * Newest-first by `createdAt`, report `id` as the deterministic tiebreaker.
 * Byte-identical ordering to `getReportsByMissionIdOwnedBy` so the client and
 * server resolve the same canonical Report. Returns < 0 when `a` is canonical
 * relative to `b`.
 */
function byCanonicalOrder(a: CanonicalReportCandidate, b: CanonicalReportCandidate): number {
  const byCreatedAt = String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
  return byCreatedAt !== 0 ? byCreatedAt : String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

/**
 * True only for a Report that may be selected as a run's canonical output:
 * a real `missionId` match, a non-empty `ownerId`, and — when `ownerId` is
 * supplied — an exact owner match.
 */
function isSelectable(report: CanonicalReportCandidate, missionId: string, ownerId: string | undefined): boolean {
  if (!report.missionId || report.missionId !== missionId) return false;
  if (!report.ownerId) return false;
  if (ownerId !== undefined && report.ownerId !== ownerId) return false;
  return true;
}

/**
 * The single canonical Report a mission produced, or `undefined` when none is
 * selectable. Deterministic on equal timestamps (id tiebreaker).
 *
 * @param reports  already-fetched catalog list (owner-scoped upstream).
 * @param missionId the mission whose canonical Report is wanted.
 * @param ownerId  optional authenticated owner — when passed, foreign Reports
 *                 are refused defensively even if a mis-scoped list included one.
 */
export function selectCanonicalMissionReport<T extends CanonicalReportCandidate>(
  reports: readonly T[],
  missionId: string | undefined | null,
  ownerId?: string
): T | undefined {
  if (!missionId) return undefined;
  let best: T | undefined;
  for (const report of reports) {
    if (!isSelectable(report, missionId, ownerId)) continue;
    if (best === undefined || byCanonicalOrder(report, best) < 0) best = report;
  }
  return best;
}

/**
 * Build a `missionId → canonical Report` map applying the same rule as
 * `selectCanonicalMissionReport` for every mission present in the list. Used by
 * AgentLog, which resolves many history rows against one memoized lookup.
 */
export function buildCanonicalReportsByMission<T extends CanonicalReportCandidate>(
  reports: readonly T[],
  ownerId?: string
): Map<string, T> {
  const map = new Map<string, T>();
  for (const report of reports) {
    const missionId = report.missionId;
    if (missionId === undefined || !isSelectable(report, missionId, ownerId)) continue;
    const current = map.get(missionId);
    if (current === undefined || byCanonicalOrder(report, current) < 0) map.set(missionId, report);
  }
  return map;
}
