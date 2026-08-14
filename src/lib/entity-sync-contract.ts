/**
 * @file lib/entity-sync-contract.ts
 * @description Client-safe vocabulary shared by entity sync delivery and its
 * durable recovery anchor.
 *
 * Keep this module free of transport, Firebase, and outbox imports. Both the
 * delivery path and recovery persistence depend on it, so it is the stable
 * lower-level boundary that prevents those modules from importing each other.
 */

import type { EntityType } from '@/lib/types';

export const LIBRARY_ENTITY_SYNC_TYPES = [
  'company',
  'technology',
  'strategy',
  'useCase',
  'prototype',
  'orgUnit',
  'initiative',
  'painPoint',
] as const satisfies readonly EntityType[];

export type LibraryEntitySyncType = (typeof LIBRARY_ENTITY_SYNC_TYPES)[number];

export const ENTITY_GRAPH_SYNC_ANCHOR_RECEIPT_CONTRACT =
  'entity-graph-sync-anchor-recorded/v1' as const;
export const ENTITY_GRAPH_SYNC_HANDOFF_ERROR =
  'Graph synchronization handoff was not acknowledged' as const;

export type EntityGraphSyncAnchorReceiptOperation = 'create' | 'update';

/**
 * Exact server attestation that a failed create/update handoff already left a
 * durable Admin-SDK recovery anchor. The browser trusts this only when it also
 * arrived as a 503 from the same-origin entity-sync route.
 */
export type EntityGraphSyncAnchorRecordedResponse = {
  error: typeof ENTITY_GRAPH_SYNC_HANDOFF_ERROR;
  recovery: {
    contract: typeof ENTITY_GRAPH_SYNC_ANCHOR_RECEIPT_CONTRACT;
    anchorRecorded: true;
    entityType: LibraryEntitySyncType;
    entityId: string;
    operation: EntityGraphSyncAnchorReceiptOperation;
  };
};

export function buildEntityGraphSyncAnchorRecordedResponse(options: {
  entityType: LibraryEntitySyncType;
  entityId: string;
  operation: EntityGraphSyncAnchorReceiptOperation;
}): EntityGraphSyncAnchorRecordedResponse {
  return {
    error: ENTITY_GRAPH_SYNC_HANDOFF_ERROR,
    recovery: {
      contract: ENTITY_GRAPH_SYNC_ANCHOR_RECEIPT_CONTRACT,
      anchorRecorded: true,
      entityType: options.entityType,
      entityId: options.entityId,
      operation: options.operation,
    },
  };
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

/** Fail closed on extra, missing, stale, or cross-entity receipt fields. */
export function parseEntityGraphSyncAnchorRecordedResponse(
  value: unknown,
  expected: {
    entityType: LibraryEntitySyncType;
    entityId: string;
    operation: EntityGraphSyncAnchorReceiptOperation;
  }
): EntityGraphSyncAnchorRecordedResponse | null {
  if (!isExactObject(value, ['error', 'recovery'])) return null;
  if (value.error !== ENTITY_GRAPH_SYNC_HANDOFF_ERROR) return null;
  if (!isExactObject(value.recovery, ['contract', 'anchorRecorded', 'entityType', 'entityId', 'operation'])) {
    return null;
  }

  const recovery = value.recovery;
  if (
    recovery.contract !== ENTITY_GRAPH_SYNC_ANCHOR_RECEIPT_CONTRACT ||
    recovery.anchorRecorded !== true ||
    recovery.entityType !== expected.entityType ||
    recovery.entityId !== expected.entityId ||
    recovery.operation !== expected.operation
  ) {
    return null;
  }

  return value as EntityGraphSyncAnchorRecordedResponse;
}

export function isLibraryEntitySyncType(entityType: EntityType): entityType is LibraryEntitySyncType {
  return (LIBRARY_ENTITY_SYNC_TYPES as readonly EntityType[]).includes(entityType);
}
