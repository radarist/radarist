/**
 * @file radar-placement-delete-outbox.ts
 * @description GRAPH-060 — durable delete evidence for RadarPlacement deletions.
 *
 * A placement delete removes the Firestore doc BEFORE the graph removal lands.
 * Without durable evidence, a reconciliation sweep that finds a Neo4j
 * RadarPlacement node with no Firestore doc cannot know it was legitimately
 * deleted (vs. a missing projection) and cannot reconstruct the pair-lock key /
 * endpoints. This outbox — committed in the SAME transaction as the placement +
 * pair-lock deletion — is that evidence: it names the placement id, its pair key,
 * and both endpoints, so the delete-sync job (and reconciliation redrive) can
 * remove the graph node + edges idempotently and clear the row only after the
 * Neo4j deletion is confirmed. Mirrors `relation-sync-outbox.ts`.
 */

/** One outbox doc per placement id, holding the durable delete identity. */
export const RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION = 'radarPlacementDeleteOutbox';

/** Bounded delay before reconciliation redrives a pending delete (an ordinary
 *  in-flight delete should win first). */
export const RADAR_PLACEMENT_DELETE_REPLAY_DELAY_MS = 5 * 60 * 1000;

export interface RadarPlacementDeleteOutboxRecord {
  placementId: string;
  deleteToken: string;
  /** The deterministic pair-lock key to remove alongside the graph node. */
  pairKey: string;
  radarId: string;
  technologyId: string;
  operation: 'delete';
  status: 'pending';
  attempt: number;
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface RadarPlacementDeleteIdentity {
  id: string;
  pairKey: string;
  radarId: string;
  technologyId: string;
}

export function buildRadarPlacementDeleteOutboxRecord(
  placement: RadarPlacementDeleteIdentity,
  deleteToken: string,
  timestamp = Date.now()
): RadarPlacementDeleteOutboxRecord {
  return {
    placementId: placement.id,
    deleteToken,
    pairKey: placement.pairKey,
    radarId: placement.radarId,
    technologyId: placement.technologyId,
    operation: 'delete',
    status: 'pending',
    attempt: 0,
    nextAttemptAt: timestamp + RADAR_PLACEMENT_DELETE_REPLAY_DELAY_MS,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createRadarPlacementDeleteToken(placementId: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${placementId}:${Date.now()}:${random}`;
}

/** Deterministic Inngest event id so a redelivered delete is deduped. */
export function radarPlacementDeleteSyncEventId(deleteToken: string, attempt: number): string {
  return `radar-placement-delete:${deleteToken}:${attempt}`;
}

export function parseRadarPlacementDeleteOutboxRecord(
  documentId: string,
  value: unknown
): RadarPlacementDeleteOutboxRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.placementId !== documentId ||
    typeof record.deleteToken !== 'string' ||
    record.deleteToken.length === 0 ||
    typeof record.pairKey !== 'string' ||
    record.pairKey.length === 0 ||
    typeof record.radarId !== 'string' ||
    record.radarId.length === 0 ||
    typeof record.technologyId !== 'string' ||
    record.technologyId.length === 0 ||
    record.operation !== 'delete' ||
    record.status !== 'pending' ||
    typeof record.attempt !== 'number' ||
    !Number.isInteger(record.attempt) ||
    record.attempt < 0 ||
    typeof record.nextAttemptAt !== 'number' ||
    !Number.isFinite(record.nextAttemptAt) ||
    record.nextAttemptAt < 0 ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt < 0 ||
    typeof record.updatedAt !== 'number' ||
    !Number.isFinite(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    return null;
  }
  return record as unknown as RadarPlacementDeleteOutboxRecord;
}
