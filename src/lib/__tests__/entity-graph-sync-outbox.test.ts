/**
 * GRAPH-056 — the anchor is the only durable trace that a committed mutation
 * still owes Neo4j a write, so a malformed record must never be coerced into a
 * usable one, and the attempt bound must actually terminate.
 */

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

import {
  ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION,
  MAX_ENTITY_GRAPH_SYNC_ATTEMPTS,
  MAX_OUTBOX_ERROR_LENGTH,
  advanceEntityGraphSyncOutboxRecord,
  buildEntityGraphSyncOutboxRecord,
  entityGraphSyncOutboxDocumentId,
  markEntityGraphSyncOutboxDispatched,
  normalizeOutboxError,
  parseEntityGraphSyncOutboxRecord,
  type EntityGraphSyncOutboxRecord,
} from '@/lib/entity-graph-sync-outbox';

const TIMESTAMP = 1_752_000_000_000;

function validRecord(overrides: Partial<EntityGraphSyncOutboxRecord> = {}): EntityGraphSyncOutboxRecord {
  return {
    ...buildEntityGraphSyncOutboxRecord({
      entityType: 'company',
      entityId: 'company-1',
      operation: 'update',
      observedUpdatedAt: TIMESTAMP,
      timestamp: TIMESTAMP,
    }),
    ...overrides,
  };
}

const VALID_DOCUMENT_ID = entityGraphSyncOutboxDocumentId('company', 'company-1');

describe('entity graph sync outbox record', () => {
  it('names its collection', () => {
    expect(ENTITY_GRAPH_SYNC_OUTBOX_COLLECTION).toBe('entityGraphSyncOutbox');
  });

  describe('document id', () => {
    it('is deterministic so repeated failures collapse onto one anchor', () => {
      expect(entityGraphSyncOutboxDocumentId('company', 'company-1')).toBe('company__company-1');
      expect(entityGraphSyncOutboxDocumentId('company', 'company-1')).toBe(
        entityGraphSyncOutboxDocumentId('company', 'company-1')
      );
    });

    it('separates the same id across entity types', () => {
      expect(entityGraphSyncOutboxDocumentId('company', 'shared-id')).not.toBe(
        entityGraphSyncOutboxDocumentId('technology', 'shared-id')
      );
    });

    it('never produces a Firestore-reserved __id__ shape', () => {
      expect(entityGraphSyncOutboxDocumentId('company', '__proto__')).toBe('company____proto__');
      expect(entityGraphSyncOutboxDocumentId('company', '__proto__')).not.toMatch(/^__.*__$/);
    });

    it.each([
      ['empty', ''],
      ['whitespace only', '   '],
    ])('rejects an %s id', (_label, entityId) => {
      expect(() => entityGraphSyncOutboxDocumentId('company', entityId)).toThrow(/must not be empty/);
    });

    it('rejects an untrimmed id rather than silently normalizing it', () => {
      // Silent trimming would let two callers address the same anchor by
      // different ids and disagree about whether it exists.
      expect(() => entityGraphSyncOutboxDocumentId('company', ' company-1')).toThrow(/already be trimmed/);
    });

    it('rejects a path separator rather than escaping it', () => {
      expect(() => entityGraphSyncOutboxDocumentId('company', 'a/b')).toThrow(/path separator/);
    });
  });

  describe('building', () => {
    it('starts pending with a zero attempt count', () => {
      const record = validRecord();
      expect(record).toMatchObject({
        entityType: 'company',
        entityId: 'company-1',
        operation: 'update',
        attempt: 0,
        status: 'pending',
        observedUpdatedAt: TIMESTAMP,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      });
      expect(record.generation).toMatch(/^[0-9a-f]{32}$/);
    });

    it('gives same-millisecond mutations distinct immutable generations', () => {
      const first = validRecord();
      const second = validRecord();
      expect(first.updatedAt).toBe(second.updatedAt);
      expect(first.generation).not.toBe(second.generation);
    });

    it('stores a single stable timestamp across both clocks', () => {
      const record = validRecord();
      expect(record.createdAt).toBe(record.updatedAt);
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
    ])('nulls a non-finite observedUpdatedAt (%s)', (_label, observedUpdatedAt) => {
      const record = buildEntityGraphSyncOutboxRecord({
        entityType: 'company',
        entityId: 'company-1',
        operation: 'create',
        observedUpdatedAt: observedUpdatedAt as number | null | undefined,
        timestamp: TIMESTAMP,
      });
      expect(record.observedUpdatedAt).toBeNull();
    });
  });

  describe('error normalization', () => {
    it('reads the message off an Error', () => {
      expect(normalizeOutboxError(new Error('handoff timed out'))).toBe('handoff timed out');
    });

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['blank string', '   '],
    ])('stores null for %s', (_label, value) => {
      expect(normalizeOutboxError(value)).toBeNull();
    });

    it('bounds a pathological message', () => {
      const normalized = normalizeOutboxError(new Error('x'.repeat(5_000)));
      expect(normalized).toHaveLength(MAX_OUTBOX_ERROR_LENGTH);
    });
  });

  describe('advancing after a failed retry', () => {
    it('increments the attempt and stays pending below the bound', () => {
      const advanced = advanceEntityGraphSyncOutboxRecord(validRecord(), {
        lastError: new Error('still unreachable'),
        timestamp: TIMESTAMP + 1,
      });
      expect(advanced).toMatchObject({ attempt: 1, status: 'pending', lastError: 'still unreachable' });
      expect(advanced.updatedAt).toBe(TIMESTAMP + 1);
    });

    it('terminates at the bound instead of retrying forever', () => {
      // The gap this closes: relationSyncOutbox increments without a cap and
      // has no terminal status, so an impossible marker retries indefinitely.
      let record = validRecord();
      for (let index = 0; index < MAX_ENTITY_GRAPH_SYNC_ATTEMPTS; index++) {
        record = advanceEntityGraphSyncOutboxRecord(record, { timestamp: TIMESTAMP });
      }
      expect(record).toMatchObject({ attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS, status: 'exhausted' });
    });

    it('does not exceed the bound on further advances', () => {
      let record = validRecord({ attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS, status: 'exhausted' });
      record = advanceEntityGraphSyncOutboxRecord(record, { timestamp: TIMESTAMP });
      expect(record.attempt).toBe(MAX_ENTITY_GRAPH_SYNC_ATTEMPTS);
      expect(record.status).toBe('exhausted');
    });

    it('retains the previous error when the retry reports none', () => {
      const seeded = validRecord({ lastError: 'first failure' });
      expect(advanceEntityGraphSyncOutboxRecord(seeded, { timestamp: TIMESTAMP }).lastError).toBe('first failure');
    });
  });

  describe('recording an accepted retry', () => {
    it('stamps the dispatch without clearing the anchor or resetting attempts', () => {
      // The exact defect GRAPH-056 reopens on: an acknowledged queue handoff is
      // not a graph write, so it must not retire the recovery record.
      const seeded = advanceEntityGraphSyncOutboxRecord(validRecord(), { timestamp: TIMESTAMP });
      const dispatched = markEntityGraphSyncOutboxDispatched(seeded, TIMESTAMP + 5);

      expect(dispatched.lastDispatchedAt).toBe(TIMESTAMP + 5);
      expect(dispatched.updatedAt).toBe(TIMESTAMP + 5);
      expect(dispatched.attempt).toBe(seeded.attempt);
      expect(dispatched.status).toBe(seeded.status);
    });

    it('starts unset so a never-retried anchor is distinguishable', () => {
      expect(validRecord().lastDispatchedAt).toBeNull();
    });
  });

  describe('parsing', () => {
    it('accepts a well-formed record', () => {
      expect(parseEntityGraphSyncOutboxRecord(VALID_DOCUMENT_ID, validRecord())).not.toBeNull();
    });

    it('accepts an exhausted record at the attempt bound', () => {
      const record = validRecord({ attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS, status: 'exhausted' });
      expect(parseEntityGraphSyncOutboxRecord(VALID_DOCUMENT_ID, record)).not.toBeNull();
    });

    it('accepts a null observedUpdatedAt and a null lastError', () => {
      const record = validRecord({ observedUpdatedAt: null, lastError: null });
      expect(parseEntityGraphSyncOutboxRecord(VALID_DOCUMENT_ID, record)).not.toBeNull();
    });

    it('rejects a record whose id does not match its own coordinates', () => {
      // A mismatched anchor would let one entity's failure be reported against
      // another entity's projection.
      expect(parseEntityGraphSyncOutboxRecord('company__other', validRecord())).toBeNull();
    });

    it('rejects a record filed under the wrong entity type', () => {
      expect(
        parseEntityGraphSyncOutboxRecord(entityGraphSyncOutboxDocumentId('technology', 'company-1'), validRecord())
      ).toBeNull();
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['string', 'nope'],
      ['array', []],
    ])('rejects a non-object value (%s)', (_label, value) => {
      expect(parseEntityGraphSyncOutboxRecord(VALID_DOCUMENT_ID, value)).toBeNull();
    });

    it.each<[string, Partial<EntityGraphSyncOutboxRecord>]>([
      ['unknown entity type', { entityType: 'radar' as never }],
      ['non-string entity type', { entityType: 42 as never }],
      ['empty entity id', { entityId: '' }],
      ['non-string entity id', { entityId: 7 as never }],
      ['missing generation', { generation: undefined as never }],
      ['uppercase generation', { generation: 'A'.repeat(32) }],
      ['short generation', { generation: 'a'.repeat(31) }],
      ['delete operation', { operation: 'delete' as never }],
      ['unknown operation', { operation: 'upsert' as never }],
      ['unknown status', { status: 'claimed' as never }],
      ['fractional attempt', { attempt: 1.5 }],
      ['negative attempt', { attempt: -1 }],
      ['attempt above the bound', { attempt: MAX_ENTITY_GRAPH_SYNC_ATTEMPTS + 1 }],
      ['non-number attempt', { attempt: '1' as never }],
      ['non-finite observedUpdatedAt', { observedUpdatedAt: Number.NaN }],
      ['negative observedUpdatedAt', { observedUpdatedAt: -1 }],
      ['non-number observedUpdatedAt', { observedUpdatedAt: 'yesterday' as never }],
      ['non-finite lastDispatchedAt', { lastDispatchedAt: Number.NaN }],
      ['negative lastDispatchedAt', { lastDispatchedAt: -1 }],
      ['non-number lastDispatchedAt', { lastDispatchedAt: 'today' as never }],
      ['non-string lastError', { lastError: 5 as never }],
      ['oversized lastError', { lastError: 'x'.repeat(MAX_OUTBOX_ERROR_LENGTH + 1) }],
      ['non-finite createdAt', { createdAt: Number.POSITIVE_INFINITY }],
      ['negative createdAt', { createdAt: -1 }],
      ['missing updatedAt', { updatedAt: undefined as never }],
      ['non-number updatedAt', { updatedAt: '2026' as never }],
    ])('rejects %s', (_label, overrides) => {
      expect(parseEntityGraphSyncOutboxRecord(VALID_DOCUMENT_ID, validRecord(overrides))).toBeNull();
    });
  });
});
