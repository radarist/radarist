/**
 * @file session-memory.ts
 * @description Neo4j session memory service for tracking user->entity interactions.
 *
 * Manages Session nodes and EXPLORED edges for the proactive intelligence system.
 * Sessions represent browsing sessions; EXPLORED edges track entity views.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { runWriteTransaction, runReadTransaction } from './neo4j-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('graph/session-memory');

// ============================================================================
// TYPES
// ============================================================================

export interface SessionNode {
  id: string;
  userId: string;
  startedAt: string;
}

export interface ExploredEntity {
  entityId: string;
  entityType: string;
  name: string;
  viewCount: number;
  lastViewedAt: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default session timeout: 30 minutes */
const DEFAULT_SESSION_MAX_AGE_MS = 30 * 60 * 1000;

/** Default time window for explored entities: 7 days */
const DEFAULT_EXPLORED_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Create a new Session node in Neo4j.
 *
 * @param userId - The authenticated user's ID
 * @returns The created session node
 */
export async function createSession(userId: string): Promise<SessionNode> {
  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  try {
    const result = await runWriteTransaction<{
      id: string;
      userId: string;
      startedAt: string;
    }>(
      `CREATE (s:Session { id: $id, userId: $userId, startedAt: $startedAt })
       RETURN s.id AS id, s.userId AS userId, s.startedAt AS startedAt`,
      { id, userId, startedAt }
    );

    const record = result.records[0];
    const session: SessionNode = {
      id: record.id,
      userId: record.userId,
      startedAt: record.startedAt,
    };

    try {
      const { ensureEdgesForNode } = await import('@/lib/graph/ensure-edges');
      await ensureEdgesForNode(session.id, 'Session', { userId });
    } catch {
      /* best-effort */
    }

    log.info('Session created', { sessionId: id, userId });
    return session;
  } catch (error) {
    log.error('Failed to create session', error instanceof Error ? error : new Error(String(error)), { userId });
    throw error;
  }
}

/**
 * Get the most recent active session for a user, or create a new one.
 *
 * A session is considered "active" if it was started less than `maxAgeMs` ago.
 *
 * @param userId - The authenticated user's ID
 * @param maxAgeMs - Maximum age of a session in milliseconds (default: 30 minutes)
 * @returns The active or newly created session
 */
export async function getOrCreateActiveSession(
  userId: string,
  maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS
): Promise<SessionNode> {
  try {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    const result = await runReadTransaction<{
      id: string;
      userId: string;
      startedAt: string;
    }>(
      `MATCH (s:Session { userId: $userId })
       WHERE s.startedAt > $cutoff
       RETURN s.id AS id, s.userId AS userId, s.startedAt AS startedAt
       ORDER BY s.startedAt DESC
       LIMIT 1`,
      { userId, cutoff }
    );

    if (result.records.length > 0) {
      const record = result.records[0];
      log.debug('Found active session', { sessionId: record.id, userId });
      return {
        id: record.id,
        userId: record.userId,
        startedAt: record.startedAt,
      };
    }

    log.debug('No active session found, creating new one', { userId });
    return await createSession(userId);
  } catch (error) {
    log.error('Failed to get or create active session', error instanceof Error ? error : new Error(String(error)), {
      userId,
    });
    throw error;
  }
}

// ============================================================================
// ENTITY TRACKING
// ============================================================================

/**
 * Track a user viewing an entity by creating/updating an EXPLORED edge.
 *
 * Uses MERGE to avoid duplicate edges for the same entity within a session.
 * Increments `viewCount` and updates `lastViewedAt` on repeated views.
 *
 * M16: the entity MATCH carries the indexed `:Entity` label (an unlabeled
 * `(e { id })` is an AllNodesScan on the hottest write path). When the session
 * or entity node is missing the MATCH binds nothing and the MERGE writes
 * nothing — this returns an HONEST miss (`{ tracked: false }`) rather than
 * silently no-oping while the caller reports success. `tracked` is derived from
 * the write counters (an edge either created or its properties bumped).
 *
 * @param sessionId - The session ID
 * @param entityId - The entity being viewed
 * @param entityType - The type of entity (e.g., 'technology', 'company')
 * @returns `{ tracked }` — false when the MATCH found no session/entity to link.
 */
export async function trackEntityView(
  sessionId: string,
  entityId: string,
  entityType: string
): Promise<{ tracked: boolean }> {
  const now = new Date().toISOString();

  try {
    const result = await runWriteTransaction(
      `MATCH (s:Session { id: $sessionId })
       MATCH (e:Entity { id: $entityId })
       MERGE (s)-[r:EXPLORED]->(e)
       ON CREATE SET r.firstViewedAt = $now, r.viewCount = 1, r.entityType = $entityType
       ON MATCH SET r.lastViewedAt = $now, r.viewCount = r.viewCount + 1`,
      { sessionId, entityId, entityType, now }
    );

    const { relationshipsCreated, propertiesSet } = result.summary.counters;
    const tracked = relationshipsCreated > 0 || propertiesSet > 0;
    if (!tracked) {
      log.warn('Entity view not tracked — session or entity not found in graph', {
        sessionId,
        entityId,
        entityType,
      });
    } else {
      log.debug('Entity view tracked', { sessionId, entityId, entityType });
    }
    return { tracked };
  } catch (error) {
    log.error('Failed to track entity view', error instanceof Error ? error : new Error(String(error)), {
      sessionId,
      entityId,
      entityType,
    });
    throw error;
  }
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Get entities explored by a user within a time window.
 *
 * Aggregates view counts across sessions and returns the most recently
 * viewed entities first.
 *
 * @param userId - The user's ID
 * @param sinceMs - Time window in milliseconds (default: 7 days)
 * @returns List of explored entities with aggregated view counts
 */
export async function getExploredEntities(
  userId: string,
  sinceMs: number = DEFAULT_EXPLORED_SINCE_MS
): Promise<ExploredEntity[]> {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();

  try {
    const result = await runReadTransaction<{
      entityId: string;
      entityType: string;
      name: string;
      viewCount: number;
      lastViewedAt: string;
    }>(
      `MATCH (s:Session { userId: $userId })-[r:EXPLORED]->(e)
       WHERE s.startedAt > $cutoff
       RETURN e.id AS entityId, r.entityType AS entityType,
              coalesce(e.name, e.title) AS name,
              sum(r.viewCount) AS viewCount,
              max(coalesce(r.lastViewedAt, r.firstViewedAt)) AS lastViewedAt
       ORDER BY lastViewedAt DESC`,
      { userId, cutoff }
    );

    return result.records.map((record) => ({
      entityId: record.entityId,
      entityType: record.entityType,
      name: record.name,
      viewCount: record.viewCount,
      lastViewedAt: record.lastViewedAt,
    }));
  } catch (error) {
    log.error('Failed to get explored entities', error instanceof Error ? error : new Error(String(error)), { userId });
    throw error;
  }
}

/**
 * The tags of every entity the user EXPLORED within the window — the raw signal
 * `deriveInterestFromBehavior` turns into interest topics. One row per (session,entity)
 * edge; callers dedupe by entityId. Throws on read failure (a silent [] would dark the
 * interest derivation, exactly like the getExploredEntities contract).
 */
export async function getExploredEntityTags(
  userId: string,
  sinceMs: number = DEFAULT_EXPLORED_SINCE_MS
): Promise<Array<{ entityId: string; tags: string[] }>> {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  const result = await runReadTransaction<{ entityId: string; tags: unknown }>(
    `MATCH (s:Session { userId: $userId })-[r:EXPLORED]->(e)
     WHERE s.startedAt > $cutoff
     RETURN e.id AS entityId, e.tags AS tags`,
    { userId, cutoff }
  );
  return result.records.map((record) => ({
    entityId: record.entityId,
    tags: Array.isArray(record.tags)
      ? (record.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
  }));
}

// ============================================================================
// Task 3.9: Record Exploration (precondition for proactive insights on chat)
// ============================================================================

/**
 * Record that a user explored an entity (from chat or browsing).
 * Creates/updates the EXPLORED edge directly on the user's session.
 * This is the precondition for proactive insights to fire on chat activity.
 */
export async function recordExploration(userId: string, entityId: string): Promise<void> {
  try {
    // Phase 0 step 0.7 fix: delegate to the canonical session + view writers
    // instead of running a parallel MERGE-on-userId Cypher that wrote
    // `startedAt = datetime().epochMillis` (a number) — incompatible with the
    // ISO-string `startedAt` that `createSession` writes and that
    // `getOrCreateActiveSession` queries. The old path produced a sibling
    // session-per-user that no other query could find.
    //
    // `entityType` is read off the entity node itself (best-effort — if the
    // entity doesn't exist or has no entityType, the EXPLORED edge still
    // gets created with an empty-string type field).
    const session = await getOrCreateActiveSession(userId);

    const now = new Date().toISOString();
    await runWriteTransaction(
      `MATCH (s:Session { id: $sessionId })
       MATCH (e { id: $entityId })
       WITH s, e, coalesce(e.entityType, '') AS entityType
       MERGE (s)-[r:EXPLORED]->(e)
       ON CREATE SET r.firstViewedAt = $now, r.viewCount = 1, r.entityType = entityType
       ON MATCH SET r.lastViewedAt = $now, r.viewCount = r.viewCount + 1`,
      { sessionId: session.id, entityId, now }
    );
  } catch (error) {
    log.error('Failed to record exploration', error instanceof Error ? error : new Error(String(error)), {
      userId,
      entityId,
    });
    // Best-effort — don't throw.
  }
}

// ============================================================================
// Active Users
// ============================================================================

/**
 * Get all distinct user IDs that have sessions with recent activity.
 *
 * Used by the sweep cycle to run insight detection for each active user.
 *
 * @param sinceDays - Only consider sessions active within this many days (default: 7)
 * @returns Array of distinct user IDs
 */
export async function getActiveUserIds(sinceDays: number = 7): Promise<string[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const result = await runReadTransaction<{ userId: string }>(
      `MATCH (s:Session)
       WHERE s.startedAt > $since
       RETURN DISTINCT s.userId AS userId`,
      { since }
    );

    return result.records.map((r) => r.userId);
  } catch (error) {
    // Do NOT mask a read failure as "no active users" — that made an infra outage
    // indistinguishable from a healthy empty result (the failure class that hid the
    // original empty briefing). Throw; all callers (daily-digest, sweep REFLECT steps)
    // wrap this and degrade explicitly.
    log.error('Failed to get active user IDs', error instanceof Error ? error : new Error(String(error)));
    throw error instanceof Error ? error : new Error(String(error));
  }
}
