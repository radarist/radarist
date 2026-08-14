/**
 * @file lib/build-mission-ui.ts
 * @description Pure presentation helpers for build missions — kept out of
 * the component so they're unit-testable and client-safe.
 */
import type { Mission } from '@/lib/schemas/mission';

/** Display order of the methodology phases (mirrors mission-build schema). */
export const MISSION_BUILD_PHASES: NonNullable<Mission['buildPhase']>[] = [
  '00-inception',
  '01-brainstorm',
  '02-user-flows',
  '03-design-system',
  '04-user-stories',
  '05-architecture',
  '06-build',
  '07-self-test',
  '08-qa',
  'published',
];

/** Human title from the brief's `# Mission: X` heading, else the first line. */
export function missionTitle(mission: Pick<Mission, 'prompt' | 'id'>): string {
  const heading = mission.prompt.match(/^#\s*Mission:\s*(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const firstLine = mission.prompt
    .split('\n')[0]
    ?.replace(/^#+\s*/, '')
    .trim();
  return firstLine || mission.id;
}

/**
 * The gate currently awaiting a human, derived from buildState (the
 * supervisor parks at waitForEvent exactly while these states are set).
 */
export function pendingGate(mission: Pick<Mission, 'status' | 'buildState'>): 'budget' | 'stall' | 'final' | null {
  if (mission.status !== 'running') return null;
  switch (mission.buildState) {
    case 'awaiting-budget':
      return 'budget';
    case 'awaiting-stall':
      return 'stall';
    case 'awaiting-approval':
      return 'final';
    default:
      return null;
  }
}

/** Outcome of a bulk artifact delete: which ids failed, and how many succeeded. */
export interface BulkArtifactDeleteOutcome {
  failedIds: string[];
  succeeded: number;
}

/**
 * BUILD-025 — orchestrate a bulk artifact delete without swallowing failures.
 * Deletes each id independently (a failure never aborts the others) and returns
 * the ids that FAILED so the caller can keep exactly those rows selected for
 * retry, instead of clearing the whole selection on any error. Preserves input
 * order in `failedIds`.
 */
export async function runBulkArtifactDelete(
  ids: readonly string[],
  deleteOne: (id: string) => Promise<unknown>
): Promise<BulkArtifactDeleteOutcome> {
  const results = await Promise.allSettled(ids.map((id) => deleteOne(id)));
  const failedIds = ids.filter((_, i) => results[i].status === 'rejected');
  return { failedIds, succeeded: ids.length - failedIds.length };
}
