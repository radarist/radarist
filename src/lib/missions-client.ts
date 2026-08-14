/**
 * @file lib/missions-client.ts
 * @description Client-safe read access to build missions (Firebase client
 * SDK — safe to import from "use client" components, unlike lib/missions.ts
 * which is admin-SDK/server-only).
 *
 * Reads query by userId only and filter/sort client-side per the repo
 * convention (no composite Firestore indexes).
 *
 * ARUN-005: both readers union in system-dispatched missions (sweep /
 * cron-discovery) via the compiled-in principal set from
 * `@/lib/system-principals` — the caller passes ONLY the signed-in uid.
 */
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { createLogger } from '@/lib/logger';
import { SYSTEM_PRINCIPALS, observabilityPrincipals } from '@/lib/system-principals';
import type { Mission } from '@/lib/schemas/mission';

const log = createLogger('missions-client');
const COLLECTION = 'missions';
const MAX_DOCS = 100;

/** Build missions for the user plus system principals, newest first. */
export async function getBuildMissions(userId: string): Promise<Mission[]> {
  try {
    // `in` + equality needs no composite index (unlike where+orderBy);
    // sorting stays client-side per repo convention. Without the kind
    // filter, limit() returns doc-ID order (≈ oldest first) and users with
    // >MAX_DOCS research missions would never see their newest build.
    const snap = await getDocs(
      query(
        collection(db, COLLECTION),
        where('userId', 'in', observabilityPrincipals(userId)),
        where('kind', '==', 'build'),
        limit(MAX_DOCS)
      )
    );
    return snap.docs.map((d) => d.data() as Mission).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch (error) {
    log.error('getBuildMissions failed', error instanceof Error ? error : new Error(String(error)), {
      userId,
    });
    throw error;
  }
}

/**
 * In-flight research missions for a user, newest first — the durable
 * "running" source for `/agents/runs` (ARUN-001). `Mission.kind` is
 * `research | build`; build missions have their own `getBuildMissions` source,
 * so this queries `kind === 'research'` and filters to the non-terminal
 * (`running`/`pending`) statuses client-side. Completed research runs come
 * from the AgentRun history feed; this returns ONLY the in-flight ones that
 * would otherwise be visible solely through the ephemeral SSE stream (and
 * vanish on reload).
 *
 * Both the `kind` AND `status` filters are IN the query — applied before
 * `limit()` — so neither a backlog of long-lived build missions nor a wall of
 * completed research history can consume the doc budget and starve a
 * genuinely-running research mission out of the result (ARUN-001). This needs
 * the `(userId, kind, status)` composite index; the sort stays client-side.
 *
 * ARUN-005: Firestore allows one `in` per query and this one is spent on
 * `status`, so system-principal missions come from one additional query PER
 * system principal — each keeping the same in-query status filter, so the
 * ARUN-001 starvation guarantee holds on every leg — merged in memory.
 */
export async function getRunningMissions(userId: string): Promise<Mission[]> {
  try {
    // ARUN-001: filter status IN THE QUERY (pre-limit), not after fetch. With a
    // status-free query, a user with >MAX_DOCS research missions could have all
    // 100 fetched docs be completed history, starving a genuinely-running
    // mission out of the result. Fetching only the non-terminal statuses means
    // completed docs never consume the doc budget. Needs the (userId, kind,
    // status) composite index (firestore.indexes.json). The client-side status
    // filter below stays as a cheap defensive guard. One query per principal
    // keeps that guarantee on the system legs too (ARUN-005).
    const principals = [userId, ...SYSTEM_PRINCIPALS.filter((p) => p !== userId)];
    const snaps = await Promise.all(
      principals.map((principal) =>
        getDocs(
          query(
            collection(db, COLLECTION),
            where('userId', '==', principal),
            where('kind', '==', 'research'),
            where('status', 'in', ['running', 'pending']),
            limit(MAX_DOCS)
          )
        )
      )
    );
    const byId = new Map<string, Mission>();
    for (const d of snaps.flatMap((s) => s.docs)) {
      const mission = d.data() as Mission;
      if (!byId.has(mission.id)) byId.set(mission.id, mission);
    }
    return [...byId.values()]
      .filter((mission) => mission.status === 'running' || mission.status === 'pending')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  } catch (error) {
    log.error('getRunningMissions failed', error instanceof Error ? error : new Error(String(error)), {
      userId,
    });
    throw error;
  }
}
