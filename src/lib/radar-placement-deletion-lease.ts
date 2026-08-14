/**
 * @file radar-placement-deletion-lease.ts
 * @description GRAPH-066 #3 — a transactionally-enforced barrier that stops a
 * concurrent placement create from slipping in AFTER a radar/technology cascade
 * has snapshotted the placements but BEFORE the parent is deleted (which would
 * strand an orphan placement). The cascade sets a lease keyed by the parent; the
 * create transaction reads it and refuses while it is active. The lease carries a
 * MANDATORY bounded expiry so an interrupted cascade can never strand creates
 * permanently (mirrors the checkpoint-barrier contract in firestore.rules).
 */

/** One collection of parent-deletion leases; server-owned. */
export const PLACEMENT_PARENT_DELETION_LEASE_COLLECTION = 'placementParentDeletionLeases';

/** How long a cascade lease stays active before it self-expires. */
export const PLACEMENT_PARENT_DELETION_LEASE_TTL_MS = 2 * 60 * 1000;

export type PlacementParentKind = 'radar' | 'technology';

export interface PlacementParentDeletionLease {
  parentKind: PlacementParentKind;
  parentId: string;
  createdAt: number;
  expiresAt: number;
}

/** Deterministic lease doc id for a parent being cascaded. */
export function placementParentDeletionLeaseId(kind: PlacementParentKind, parentId: string): string {
  return `${kind}:${parentId}`;
}

export function buildPlacementParentDeletionLease(
  kind: PlacementParentKind,
  parentId: string,
  now = Date.now()
): PlacementParentDeletionLease {
  return { parentKind: kind, parentId, createdAt: now, expiresAt: now + PLACEMENT_PARENT_DELETION_LEASE_TTL_MS };
}

/** True when a lease is well-formed AND still within its bounded window. */
export function isPlacementParentDeletionLeaseActive(value: unknown, now = Date.now()): boolean {
  if (!value || typeof value !== 'object') return false;
  const lease = value as Record<string, unknown>;
  return (
    (lease.parentKind === 'radar' || lease.parentKind === 'technology') &&
    typeof lease.parentId === 'string' &&
    lease.parentId.length > 0 &&
    typeof lease.expiresAt === 'number' &&
    Number.isFinite(lease.expiresAt) &&
    lease.expiresAt > now
  );
}
