/**
 * @file lib/entity-graph-sync-outbox.ts
 * @description Durable recovery anchor for a committed entity mutation whose
 * Neo4j handoff was not acknowledged.
 *
 * GRAPH-056. Deletes already own a natural anchor: `requestEntityGraphDeletion`
 * is awaited *before* the Firestore document is removed, so a failed handoff
 * leaves the document itself as proof that work is outstanding
 * (`entity-sync.ts`). Creates and updates have no such anchor — a committed
 * document looks identical whether or not the graph received the memo — so the
 * pending work has to be recorded explicitly.
 *
 * **The anchor deliberately carries no version.** It is a marker that an entity
 * owes the graph a write, not a claim about which version is owed. It is
 * written from the browser, whose service-layer entity object is not
 * byte-identical to the stored document, so a client-computed fingerprint could
 * disagree with the worker's. The server settles the debt instead, by comparing
 * the fingerprint it stamped on the node against the one it derives from the
 * authoritative document (`entity-source-version.ts`).
 *
 * That comparison is what makes a delayed completion safe. Sync events carry
 * identifiers only and the worker always re-reads Firestore, so a late v1 event
 * writes *current* content rather than stale content. The anchor clears only
 * when node and document agree; if the document moved during the write, they
 * do not agree and the anchor survives for the next round.
 *
 * Two notes on how this differs from `relation-sync-outbox.ts`:
 *
 * - Attempts are **bounded** and terminate in `exhausted`. That used to be a
 *   departure; GRAPH-059 gave the relation delete outbox the same property, so
 *   both durable outboxes now terminate rather than retrying a permanently
 *   failing marker forever. The bound here is a *client* retry budget (it stops
 *   the in-session Retry button); the relation one is a server replay budget.
 * - There is still **no lease or claim field**, because nothing polls this
 *   collection. The version-aware reconciler is the server-side replayer and
 *   derives its work from fingerprint drift, not from these records — so an
 *   anchor can never be the reason a repair is missed, and two workers cannot
 *   contend.
 */

import { LIBRARY_ENTITY_SYNC_TYPES, type LibraryEntitySyncType } from '@/lib/entity-sync-contract';
import { MAX_OUTBOX_ERROR_LENGTH, normalizeOutboxError } from '@/lib/outbox-error';

export { MAX_OUTBOX_ERROR_LENGTH, normalizeOutboxError };

export const ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION = 'entityGraphSyncOutbox';

/**
 * Client-side retry budget. Reaching it stops the in-session Retry loop and
 * marks the anchor `exhausted`; it does not stop reconciliation, which repairs
 * from fingerprint drift regardless of anchor state.
 */
export const MAX_ENTITY_GRAPH_SYNC_ATTEMPTS = 3;

/** Deletes stay fail-closed on their own document anchor and are never recorded here. */
export type EntityGraphSyncOutboxOperation = 'create' | 'update';

export type EntityGraphSyncOutboxStatus = 'pending' | 'exhausted';

/**
 * Document and entity-document link both have dedicated projection writers but
 * share the same recovery contract.
 *
 * GRAPH-069 added `entityDocumentLink`. A link is not a library entity — its
 * anchor is keyed by the LINK id, and its convergence proof is an exact
 * relationship projection rather than a node fingerprint — but the anchor
 * itself (deterministic id, immutable generation, bounded attempts, strict
 * parse, generation-CAS clear) is identical, so it reuses this record instead
 * of forking a fourth outbox. Like `document`, it is settled server-side only
 * and never rendered by the browser recovery UI.
 */
export type EntityGraphSyncAnchorType = LibraryEntitySyncType | 'document' | 'entityDocumentLink';

const ENTITY_GRAPH_SYNC_ANCHOR_TYPES: readonly EntityGraphSyncAnchorType[] = [
  ...LIBRARY_ENTITY_SYNC_TYPES,
  'document',
  'entityDocumentLink',
];

/** Firestore's hard limit on a document ID, in UTF-8 bytes. */
const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1500;

export const ENTITY_GRAPH_SYNC_GENERATION_LENGTH = 32;
const ENTITY_GRAPH_SYNC_GENERATION_PATTERN = /^[0-9a-f]{32}$/;

export interface EntityGraphSyncOutboxRecord {
  entityType: EntityGraphSyncAnchorType;
  entityId: string;
  /** Immutable random CAS token. Timestamps are diagnostic and never identify a mutation. */
  generation: string;
  operation: EntityGraphSyncOutboxOperation;
  /**
   * Diagnostic only — the source `updatedAt` seen when the handoff failed, so
   * the UI can say how stale the projection is. Never the clear key: entity
   * `updatedAt` is a client-clock `Date.now()` and is not a reliable version.
   */
  observedUpdatedAt: number | null;
  /**
   * When a retry was last accepted by the queue. An acknowledged dispatch is
   * NOT convergence — the graph write has not happened yet — so it must not
   * clear the anchor. Recording it lets the UI say "queued, confirming" instead
   * of looking as though the retry did nothing, without lying about delivery.
   */
  lastDispatchedAt: number | null;
  attempt: number;
  status: EntityGraphSyncOutboxStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

const OUTBOX_OPERATIONS: readonly EntityGraphSyncOutboxOperation[] = ['create', 'update'];
const OUTBOX_STATUSES: readonly EntityGraphSyncOutboxStatus[] = ['pending', 'exhausted'];

export function isLibraryEntitySyncTypeValue(value: unknown): value is LibraryEntitySyncType {
  return typeof value === 'string' && (LIBRARY_ENTITY_SYNC_TYPES as readonly string[]).includes(value);
}

export function isEntityGraphSyncAnchorType(value: unknown): value is EntityGraphSyncAnchorType {
  return typeof value === 'string' && (ENTITY_GRAPH_SYNC_ANCHOR_TYPES as readonly string[]).includes(value);
}

export function createEntityGraphSyncGeneration(): string {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('Secure entity graph sync generation is unavailable');
  }
  const bytes = new Uint8Array(ENTITY_GRAPH_SYNC_GENERATION_LENGTH / 2);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic document id, so repeated failures for one entity collapse onto
 * a single anchor instead of accumulating duplicates.
 *
 * Firestore reserves ids matching `__.*__`; the entity-type prefix means a
 * generated id can never produce one. A `/` would split the path, so it is
 * rejected rather than escaped.
 */
export function entityGraphSyncOutboxDocumentId(entityType: EntityGraphSyncAnchorType, entityId: string): string {
  const normalized = entityId.trim();
  if (!normalized) throw new Error('Entity graph sync outbox id must not be empty');
  if (normalized !== entityId) throw new Error('Entity graph sync outbox id must already be trimmed');
  if (normalized.includes('/')) throw new Error('Entity graph sync outbox id must not contain a path separator');
  const documentId = `${entityType}__${normalized}`;
  // Entity-document link ids are themselves derived from an endpoint triple and
  // may approach Firestore's own limit, so the prefix can push the anchor id
  // over it. Fail with the reason rather than an opaque INVALID_ARGUMENT.
  // `TextEncoder`, not `Buffer` — this module is in the browser bundle.
  const encodedBytes = new TextEncoder().encode(documentId).length;
  if (encodedBytes > FIRESTORE_DOCUMENT_ID_MAX_BYTES) {
    throw new Error(
      `Entity graph sync outbox id encodes to ${encodedBytes} bytes; ` +
        `Firestore document IDs allow at most ${FIRESTORE_DOCUMENT_ID_MAX_BYTES}`
    );
  }
  return documentId;
}

export function buildEntityGraphSyncOutboxRecord(options: {
  entityType: EntityGraphSyncAnchorType;
  entityId: string;
  operation: EntityGraphSyncOutboxOperation;
  generation?: string;
  observedUpdatedAt?: number | null;
  lastError?: unknown;
  timestamp?: number;
}): EntityGraphSyncOutboxRecord {
  const timestamp = options.timestamp ?? Date.now();
  const observedUpdatedAt =
    typeof options.observedUpdatedAt === 'number' && Number.isFinite(options.observedUpdatedAt)
      ? options.observedUpdatedAt
      : null;
  const generation = options.generation ?? createEntityGraphSyncGeneration();
  if (!ENTITY_GRAPH_SYNC_GENERATION_PATTERN.test(generation)) {
    throw new Error('Entity graph sync generation must be 32 lowercase hexadecimal characters');
  }
  return {
    entityType: options.entityType,
    entityId: options.entityId,
    generation,
    operation: options.operation,
    observedUpdatedAt,
    lastDispatchedAt: null,
    attempt: 0,
    status: 'pending',
    lastError: normalizeOutboxError(options.lastError),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Advance an anchor after a failed retry. Reaching the attempt bound flips the
 * record to `exhausted` so the UI stops offering a retry that keeps failing.
 */
export function advanceEntityGraphSyncOutboxRecord(
  record: EntityGraphSyncOutboxRecord,
  options: { lastError?: unknown; timestamp?: number; maxAttempts?: number } = {}
): EntityGraphSyncOutboxRecord {
  const maxAttempts = options.maxAttempts ?? MAX_ENTITY_GRAPH_SYNC_ATTEMPTS;
  const attempt = Math.min(record.attempt + 1, maxAttempts);
  return {
    ...record,
    attempt,
    status: attempt >= maxAttempts ? 'exhausted' : 'pending',
    lastError: normalizeOutboxError(options.lastError) ?? record.lastError,
    updatedAt: options.timestamp ?? Date.now(),
  };
}

/**
 * Record that a retry reached the queue.
 *
 * This deliberately does NOT clear the anchor and does NOT reset the attempt
 * count. The defect being fixed is precisely that recovery state was discarded
 * on queue acknowledgement while Neo4j stayed stale; only the server, having
 * compared the projected fingerprint against the authoritative document, may
 * retire an anchor.
 */
export function markEntityGraphSyncOutboxDispatched(
  record: EntityGraphSyncOutboxRecord,
  timestamp = Date.now()
): EntityGraphSyncOutboxRecord {
  return { ...record, lastDispatchedAt: timestamp, updatedAt: timestamp };
}

/**
 * Strict reader. A malformed anchor is returned as `null` so callers can decide
 * whether to repair or surface it; it is never coerced into a usable record.
 */
export function parseEntityGraphSyncOutboxRecord(
  documentId: string,
  value: unknown
): EntityGraphSyncOutboxRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (!isEntityGraphSyncAnchorType(record.entityType)) return null;
  if (typeof record.entityId !== 'string' || record.entityId.length === 0) return null;
  if (typeof record.generation !== 'string' || !ENTITY_GRAPH_SYNC_GENERATION_PATTERN.test(record.generation)) {
    return null;
  }

  let expectedId: string;
  try {
    expectedId = entityGraphSyncOutboxDocumentId(record.entityType, record.entityId);
  } catch {
    return null;
  }
  if (expectedId !== documentId) return null;

  if (!OUTBOX_OPERATIONS.includes(record.operation as EntityGraphSyncOutboxOperation)) return null;
  if (!OUTBOX_STATUSES.includes(record.status as EntityGraphSyncOutboxStatus)) return null;

  if (
    record.observedUpdatedAt !== null &&
    (typeof record.observedUpdatedAt !== 'number' ||
      !Number.isFinite(record.observedUpdatedAt) ||
      record.observedUpdatedAt < 0)
  ) {
    return null;
  }

  if (
    typeof record.attempt !== 'number' ||
    !Number.isInteger(record.attempt) ||
    record.attempt < 0 ||
    record.attempt > MAX_ENTITY_GRAPH_SYNC_ATTEMPTS
  ) {
    return null;
  }

  if (
    record.lastDispatchedAt !== null &&
    (typeof record.lastDispatchedAt !== 'number' ||
      !Number.isFinite(record.lastDispatchedAt) ||
      record.lastDispatchedAt < 0)
  ) {
    return null;
  }

  if (record.lastError !== null && typeof record.lastError !== 'string') return null;
  if (typeof record.lastError === 'string' && record.lastError.length > MAX_OUTBOX_ERROR_LENGTH) return null;

  for (const key of ['createdAt', 'updatedAt'] as const) {
    const timestamp = record[key];
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0) return null;
  }

  return record as unknown as EntityGraphSyncOutboxRecord;
}
