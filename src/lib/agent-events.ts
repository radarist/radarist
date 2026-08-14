/**
 * @file agent-events.ts
 * @description Firestore-backed agent event emitter for the SSE gateway.
 *
 * Writes validated events to the `agent-events` collection with:
 * - Auto-generated event ID and timestamp
 * - Per-user monotonically increasing sequence numbers
 * - Zod validation before write
 * - 24h TTL for automatic cleanup
 *
 * IMPORTANT: Uses the Firebase Admin SDK (not client SDK) because this module
 * is called from Inngest functions and API routes — server-side contexts where
 * there is no authenticated Firebase Auth user. The client SDK would silently
 * fail Firestore security rule checks.
 *
 * @phase Phase 3: SSE Event Gateway
 */

import { Timestamp } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { observabilityPrincipals } from '@/lib/system-principals';
import { agentEventSchema, type AgentEvent } from '@/lib/schemas/agent-event';

const COLLECTION = 'agent-events';
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a durable, monotonically increasing sequence number.
 *
 * Uses microsecond-precision timestamp to guarantee ordering across
 * server restarts and multi-instance deployments. The sequence is
 * Date.now() * 1000 + a sub-millisecond counter to avoid collisions
 * within the same millisecond on a single instance.
 */
let lastTimestamp = 0;
let subMillisCounter = 0;

function nextSequence(): number {
  const now = Date.now() * 1000;
  if (now <= lastTimestamp) {
    subMillisCounter++;
  } else {
    lastTimestamp = now;
    subMillisCounter = 0;
  }
  return lastTimestamp + subMillisCounter;
}

/**
 * Emit an agent event to Firestore.
 *
 * Auto-generates `id`, `timestamp`, and `sequence`. Validates with Zod
 * before writing. Throws on validation failure.
 *
 * Sequence numbers are timestamp-derived (microsecond precision) so they
 * remain monotonic across server restarts and multi-instance deployments.
 */
export async function emitAgentEvent(
  partial: Omit<AgentEvent, 'id' | 'timestamp' | 'sequence'> & {
    type: AgentEvent['type'];
    userId: string;
    data: Record<string, unknown>;
  }
): Promise<AgentEvent> {
  const event: AgentEvent = {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    sequence: nextSequence(),
    ...partial,
  };

  // Validate with Zod before writing — throws ZodError on invalid shape
  agentEventSchema.parse(event);

  await db.collection(COLLECTION).add({
    ...event,
    _createdAt: Timestamp.now(),
    _ttl: Timestamp.fromDate(new Date(Date.now() + TTL_MS)),
  });

  return event;
}

/**
 * Get events for a user after a given sequence number.
 * Used by the SSE endpoint for cursor-based polling.
 *
 * Uses the (userId, sequence) composite index deployed 2026-04-19 so
 * userId filtering happens inside Firestore. The index declaration
 * lives in firestore.indexes.json but deploys must also be explicit
 * via `firebase deploy --only firestore:indexes` (or gcloud) —
 * declaring it in the file alone does NOT create it.
 */
export async function getEventsAfterSequence(
  userId: string,
  afterSequence: number,
  maxResults = 50
): Promise<AgentEvent[]> {
  // ARUN-005: union in system-principal events (sweep phases, discovery)
  // — sequence is timestamp-derived and globally monotonic, so one cursor
  // works across principals. The union list is compiled in, never client-fed.
  const snapshot = await db
    .collection(COLLECTION)
    .where('userId', 'in', observabilityPrincipals(userId))
    .where('sequence', '>', afterSequence)
    .orderBy('sequence', 'asc')
    .limit(maxResults)
    .get();

  return snapshot.docs.map((doc) => doc.data() as AgentEvent);
}

export interface GetEventsForRunResult {
  events: AgentEvent[];
  /** True when the mission or sweep sub-query returned exactly `maxResults`
   * docs. Neither sub-query has an `orderBy` (see below), so Firestore's
   * unspecified ordering on an unindexed equality query means a run past
   * the cap yields an ARBITRARY subset, not reliably the earliest/latest N.
   * Callers must render an honest partial-history note rather than
   * silently showing a truncated set as the full run. */
  truncated: boolean;
}

/**
 * Get the persisted event history for one run (mission or sweep), ascending
 * by sequence. Powers the run detail page's step history: completed/failed
 * runs render this directly; in-flight runs seed with it and live-tail SSE
 * events on top.
 *
 * Uses two equality-only queries — `(userId ==, missionId ==)` and
 * `(userId ==, sweepId ==)` — merged in memory. Equality-only queries are
 * served by Firestore's automatic single-field indexes via zig-zag index
 * merging, so unlike `getEventsAfterSequence` above this needs NO composite
 * index (there is deliberately no `orderBy` in the query; ordering happens
 * in memory — adding one would require a composite index per query). Events
 * older than the 24h `_ttl` are gone by design — callers must treat an
 * empty result for a known run as "history expired", not "run never
 * emitted events". See `truncated` above for the >maxResults case.
 */
export async function getEventsForRun(userId: string, runId: string, maxResults = 500): Promise<GetEventsForRunResult> {
  const [missionSnap, sweepSnap] = await Promise.all([
    db.collection(COLLECTION).where('userId', 'in', observabilityPrincipals(userId)).where('missionId', '==', runId).limit(maxResults).get(),
    db.collection(COLLECTION).where('userId', 'in', observabilityPrincipals(userId)).where('sweepId', '==', runId).limit(maxResults).get(),
  ]);

  const truncated = missionSnap.docs.length === maxResults || sweepSnap.docs.length === maxResults;

  const byId = new Map<string, AgentEvent>();
  for (const doc of [...missionSnap.docs, ...sweepSnap.docs]) {
    const event = doc.data() as AgentEvent;
    if (!byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }

  const events = [...byId.values()].sort((a, b) => a.sequence - b.sequence).slice(0, maxResults);
  return { events, truncated };
}

/**
 * Reset sequence state (for testing).
 * @internal
 */
export function _resetSequence(_userId?: string): void {
  lastTimestamp = 0;
  subMillisCounter = 0;
}
