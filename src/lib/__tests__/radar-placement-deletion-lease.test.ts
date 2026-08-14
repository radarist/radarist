/**
 * @file radar-placement-deletion-lease.test.ts
 * @description GRAPH-066 #3 — the parent-deletion lease barrier.
 */
import {
  PLACEMENT_PARENT_DELETION_LEASE_COLLECTION,
  buildPlacementParentDeletionLease,
  isPlacementParentDeletionLeaseActive,
  placementParentDeletionLeaseId,
} from '../radar-placement-deletion-lease';

describe('placement parent deletion lease', () => {
  it('keys leases deterministically per parent kind + id', () => {
    expect(placementParentDeletionLeaseId('radar', 'r1')).toBe('radar:r1');
    expect(placementParentDeletionLeaseId('technology', 't1')).toBe('technology:t1');
  });

  it('a fresh lease is active; an expired one is not', () => {
    const lease = buildPlacementParentDeletionLease('radar', 'r1', 1_000);
    expect(isPlacementParentDeletionLeaseActive(lease, 1_500)).toBe(true);
    expect(isPlacementParentDeletionLeaseActive(lease, lease.expiresAt + 1)).toBe(false); // self-expires
  });

  it('malformed leases are inactive (fail closed)', () => {
    expect(isPlacementParentDeletionLeaseActive(null)).toBe(false);
    expect(isPlacementParentDeletionLeaseActive({ parentKind: 'nope', parentId: 'x', expiresAt: Infinity })).toBe(
      false
    );
    expect(isPlacementParentDeletionLeaseActive({ parentKind: 'radar', parentId: '', expiresAt: 1e15 })).toBe(false);
  });

  it('exposes the canonical server-owned collection', () => {
    expect(PLACEMENT_PARENT_DELETION_LEASE_COLLECTION).toBe('placementParentDeletionLeases');
  });
});
