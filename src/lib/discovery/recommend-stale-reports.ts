/**
 * @file discovery/recommend-stale-reports.ts
 * @description Proactive source for UPDATE recommendations: find reports that have gone
 * stale and stage "refresh report X" recommendations in the Assessments inbox (deduped by
 * the target report, never auto-runs). The user approves to regenerate the report in place.
 * Server-only; called from the sweep.
 */
import 'server-only';
import { createLogger } from '@/lib/logger';
import { listReportsOwnedBy } from '@/lib/reports';
import { createProposedArtifactIfNotExists } from '@/lib/proposed-artifacts-admin';

const log = createLogger('discovery/recommend-stale-reports');

const DEFAULT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stage update recommendations for reports older than `staleMs`. Returns how many were
 * newly recommended (the dedup keeps re-runs from piling up duplicates). `now` is injected
 * for deterministic tests.
 */
export async function recommendStaleReportUpdates(
  userId: string,
  opts: { staleMs?: number; limit?: number; now?: number } = {}
): Promise<number> {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const limit = opts.limit ?? 3;
  const now = opts.now ?? Date.now();

  // SEC-009: resolve through the owner boundary rather than filtering a global
  // listing in memory. The old guard (`if (ownerId && ownerId !== userId)`)
  // let OWNERLESS legacy reports fall through, so a pre-ownership report's
  // title and id were staged into every user's recommendation inbox — the one
  // surface that could surface a report the authenticated routes deny.
  const reports = await listReportsOwnedBy(userId);
  let created = 0;
  for (const r of reports) {
    if (created >= limit) break;
    const ageMs = now - new Date(r.createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < staleMs) continue;

    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    const { created: didCreate } = await createProposedArtifactIfNotExists({
      artifactKind: 'report',
      title: `Refresh: ${r.title}`,
      rationale: `This report is ${days} days old — regenerate it with the latest radar data.`,
      scope: { entityIds: [], query: r.title },
      updateOf: { type: 'report', id: r.id },
      sourceUserId: userId,
    });
    if (didCreate) created += 1;
  }

  log.info('stale-report update recommendations staged', { userId, created });
  return created;
}
