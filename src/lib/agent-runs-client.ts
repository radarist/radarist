/**
 * @file agent-runs-client.ts
 * @description Client-SDK read of the `agentRuns` collection for dashboard
 * surfaces.
 *
 * The canonical writer/reader of agent runs is `agent-runs.ts`, which uses the
 * firebase-admin SDK and is `server-only` (runs are created inside Inngest
 * mission workers / API routes). But `dashboard.ts` runs in the BROWSER — it is
 * the `queryFn` of the `useDashboardData` TanStack hook — so it cannot import
 * the admin module without dragging firebase-admin into the client bundle.
 *
 * This narrow client read mirrors the `signals-client.ts` pattern: same live
 * collection, client SDK, newest-first. It replaces the dead `agent-activities`
 * collection the dashboard "AI Agent Feed" used to read (nothing ever wrote it,
 * so the feed was permanently empty — DISC-008).
 *
 * `createdAt` is stored as an ISO-8601 string, which sorts lexicographically in
 * the same order as chronologically, so a single-field `orderBy` needs no
 * composite index.
 */

import { db } from '@/lib/firebase';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import type { AgentRun } from '@/lib/schemas/agent-run';
import { observabilityPrincipals } from '@/lib/system-principals';
import { createLogger } from '@/lib/logger';

const log = createLogger('agent-runs-client');
const COLLECTION = 'agentRuns';

/**
 * Fetch the signed-in user's most recent agent runs, newest-first.
 *
 * AUDIT-019: scoped to `userId in observabilityPrincipals(uid)` — the user's
 * own runs plus system-initiated work (sweep/discovery/internal MCP), per the
 * ARUN-005 observability contract. Uses the `agentRuns(userId, createdAt)`
 * composite index.
 *
 * Returns `[]` (never throws) on a read error: the dashboard aggregates many
 * sources and a single failed read must degrade to an empty panel, not blank
 * the whole page. The error is logged loudly so it is never silently masked.
 */
export async function getRecentAgentRuns(uid: string, maxResults = 50): Promise<AgentRun[]> {
  try {
    const q = query(
      collection(db, COLLECTION),
      where('userId', 'in', observabilityPrincipals(uid)),
      orderBy('createdAt', 'desc'),
      limit(maxResults)
    );
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data() as AgentRun);
  } catch (error) {
    log.error('Error fetching recent agent runs', error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}
