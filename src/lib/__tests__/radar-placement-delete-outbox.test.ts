/**
 * @file radar-placement-delete-outbox.test.ts
 * @description GRAPH-060 defect #1 — a placement delete must leave DURABLE
 * evidence of what to remove from the graph, committed atomically with the
 * Firestore placement + pair-lock deletion, so scheduled reconciliation can
 * redrive an unacknowledged delete without needing the already-deleted Firestore
 * doc to reconstruct the id/endpoints. Mirrors the relation-delete outbox.
 */
import {
  RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION,
  buildRadarPlacementDeleteOutboxRecord,
  createRadarPlacementDeleteToken,
  radarPlacementDeleteSyncEventId,
  parseRadarPlacementDeleteOutboxRecord,
} from '../radar-placement-delete-outbox';

const placement = { id: 'placement-1', pairKey: 'rpk1_abc', radarId: 'radar-1', technologyId: 'tech-1' };

describe('buildRadarPlacementDeleteOutboxRecord', () => {
  it('captures the placement id + pair key + endpoints as durable recovery evidence', () => {
    const record = buildRadarPlacementDeleteOutboxRecord(placement, 'tok-1', 1_000);
    expect(record).toMatchObject({
      placementId: 'placement-1',
      deleteToken: 'tok-1',
      pairKey: 'rpk1_abc',
      radarId: 'radar-1',
      technologyId: 'tech-1',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
    });
    // Redrive is scheduled a bounded delay out so a normal in-flight delete wins first.
    expect(record.nextAttemptAt).toBeGreaterThan(record.createdAt);
  });
});

describe('createRadarPlacementDeleteToken', () => {
  it('is unique per call and namespaced by placement id', () => {
    const a = createRadarPlacementDeleteToken('placement-1');
    const b = createRadarPlacementDeleteToken('placement-1');
    expect(a).not.toBe(b);
    expect(a.startsWith('placement-1:')).toBe(true);
  });
});

describe('radarPlacementDeleteSyncEventId', () => {
  it('is deterministic per (token, attempt) so redelivery is idempotent', () => {
    expect(radarPlacementDeleteSyncEventId('tok-1', 2)).toBe(radarPlacementDeleteSyncEventId('tok-1', 2));
    expect(radarPlacementDeleteSyncEventId('tok-1', 2)).not.toBe(radarPlacementDeleteSyncEventId('tok-1', 3));
  });
});

describe('parseRadarPlacementDeleteOutboxRecord', () => {
  it('round-trips a well-formed record keyed by placement id', () => {
    const record = buildRadarPlacementDeleteOutboxRecord(placement, 'tok-1', 1_000);
    expect(parseRadarPlacementDeleteOutboxRecord('placement-1', record)).not.toBeNull();
  });

  it('rejects a record whose id does not match the doc id (fail closed)', () => {
    const record = buildRadarPlacementDeleteOutboxRecord(placement, 'tok-1', 1_000);
    expect(parseRadarPlacementDeleteOutboxRecord('placement-OTHER', record)).toBeNull();
  });

  it('rejects malformed / missing required fields', () => {
    expect(parseRadarPlacementDeleteOutboxRecord('placement-1', null)).toBeNull();
    expect(parseRadarPlacementDeleteOutboxRecord('placement-1', { placementId: 'placement-1' })).toBeNull();
    const record = buildRadarPlacementDeleteOutboxRecord(placement, 'tok-1', 1_000);
    expect(parseRadarPlacementDeleteOutboxRecord('placement-1', { ...record, pairKey: '' })).toBeNull();
    expect(parseRadarPlacementDeleteOutboxRecord('placement-1', { ...record, status: 'done' })).toBeNull();
  });

  it('exposes the canonical collection name', () => {
    expect(RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION).toBe('radarPlacementDeleteOutbox');
  });
});
