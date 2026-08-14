/** @jest-environment node */

import {
  buildRelationDeleteOutboxRecord,
  createRelationDeleteToken,
  parseRelationDeleteOutboxRecord,
  planRelationDeleteReplay,
  relationDeleteSyncEventId,
  MAX_RELATION_DELETE_ATTEMPTS,
  RELATION_DELETE_REPLAY_DELAY_MS,
  RELATION_SYNC_OUTBOX_COLLECTION,
} from '../relation-sync-outbox';

const CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

describe('relation-sync-outbox', () => {
  it('uses the dedicated relation delete marker collection', () => {
    expect(RELATION_SYNC_OUTBOX_COLLECTION).toBe('relationSyncOutbox');
  });

  it('builds a pending delete marker with one stable timestamp', () => {
    expect(buildRelationDeleteOutboxRecord('rel-1', 'token-1', 1234)).toEqual({
      relationId: 'rel-1',
      deleteToken: 'token-1',
      operation: 'delete',
      status: 'pending',
      attempt: 0,
      nextAttemptAt: 301234,
      lastError: null,
      exhaustedAt: null,
      createdAt: 1234,
      updatedAt: 1234,
    });
  });

  it('builds and parses a marker carrying one validated correlation token', () => {
    const marker = buildRelationDeleteOutboxRecord('rel-1', 'token-1', 1234, CORRELATION_ID);

    expect(marker).toEqual(expect.objectContaining({ correlationId: CORRELATION_ID }));
    expect(parseRelationDeleteOutboxRecord('rel-1', marker)).toEqual(marker);
  });

  it('rejects malformed correlation text before building a marker', () => {
    expect(() => buildRelationDeleteOutboxRecord('rel-1', 'token-1', 1234, 'private arbitrary text')).toThrow(
      'Invalid correlation ID'
    );
  });

  it('creates non-empty relation-scoped delete tokens', () => {
    const first = createRelationDeleteToken('rel-1');
    const second = createRelationDeleteToken('rel-1');

    expect(first).toMatch(/^rel-1:\d+:.+/);
    expect(second).toMatch(/^rel-1:\d+:.+/);
    expect(second).not.toBe(first);
  });

  it('derives a deterministic event id from the delete token', () => {
    expect(relationDeleteSyncEventId('token-1', 0)).toBe('relation-delete:token-1:0');
    expect(relationDeleteSyncEventId('token-1', 3)).toBe('relation-delete:token-1:3');
  });

  it('continues to parse a legacy marker without correlation metadata', () => {
    const marker = buildRelationDeleteOutboxRecord('rel-1', 'token-1', 1234);

    expect(parseRelationDeleteOutboxRecord('rel-1', marker)).toEqual(marker);
  });

  it('normalizes a pre-GRAPH-059 marker that carries no terminal fields', () => {
    // Exactly the shape written before the bounded policy existed.
    const legacy = {
      relationId: 'rel-1',
      deleteToken: 'token-1',
      operation: 'delete',
      status: 'pending',
      attempt: 4,
      nextAttemptAt: 301234,
      createdAt: 1234,
      updatedAt: 1234,
    };

    expect(parseRelationDeleteOutboxRecord('rel-1', legacy)).toEqual({
      ...legacy,
      lastError: null,
      exhaustedAt: null,
    });
  });

  it('reads back a terminal marker', () => {
    const exhausted = {
      ...buildRelationDeleteOutboxRecord('rel-1', 'token-1', 1234),
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
      status: 'exhausted',
      exhaustedAt: 999,
      lastError: 'graph unavailable',
    };

    expect(parseRelationDeleteOutboxRecord('rel-1', exhausted)).toMatchObject({
      status: 'exhausted',
      attempt: MAX_RELATION_DELETE_ATTEMPTS,
      exhaustedAt: 999,
      lastError: 'graph unavailable',
    });
  });

  describe('planRelationDeleteReplay', () => {
    it('dispatches and re-arms while the budget holds', () => {
      expect(planRelationDeleteReplay({ attempt: 0, lastError: null }, { now: 1000 })).toEqual({
        kind: 'dispatch',
        attempt: 1,
        updates: { attempt: 1, nextAttemptAt: 1000 + RELATION_DELETE_REPLAY_DELAY_MS, updatedAt: 1000 },
      });
    });

    it('spends the whole budget before terminating', () => {
      for (let attempt = 0; attempt < MAX_RELATION_DELETE_ATTEMPTS; attempt += 1) {
        expect(planRelationDeleteReplay({ attempt, lastError: null }, { now: 1000 }).kind).toBe('dispatch');
      }
    });

    it('terminates once the budget is spent, without another dispatch', () => {
      const decision = planRelationDeleteReplay(
        { attempt: MAX_RELATION_DELETE_ATTEMPTS, lastError: null },
        { now: 5000 }
      );

      expect(decision).toEqual({
        kind: 'exhausted',
        attempt: MAX_RELATION_DELETE_ATTEMPTS,
        updates: {
          status: 'exhausted',
          exhaustedAt: 5000,
          updatedAt: 5000,
          lastError: `Relation delete was not confirmed after ${MAX_RELATION_DELETE_ATTEMPTS} replay attempts`,
        },
      });
      // Terminating must NOT re-arm the retry clock — a marker that keeps its
      // due timestamp but never becomes claimable again is what makes the
      // transition unrepeatable.
      expect(decision.updates).not.toHaveProperty('nextAttemptAt');
      expect(decision.updates).not.toHaveProperty('attempt');
    });

    it('preserves an already-recorded reason instead of overwriting it with the generic one', () => {
      const decision = planRelationDeleteReplay(
        { attempt: MAX_RELATION_DELETE_ATTEMPTS, lastError: 'Neo4j refused the connection' },
        { now: 5000 }
      );

      expect(decision.updates).toMatchObject({ lastError: 'Neo4j refused the connection' });
    });

    it('honours an explicit smaller budget', () => {
      expect(planRelationDeleteReplay({ attempt: 1, lastError: null }, { now: 1, maxAttempts: 1 }).kind).toBe(
        'exhausted'
      );
    });
  });

  it.each([
    ['null', null],
    ['array', []],
    ['wrong relation id', { ...buildRelationDeleteOutboxRecord('rel-other', 'token', 1) }],
    ['missing token', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), deleteToken: '' }],
    ['malformed correlation', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), correlationId: 'secret' }],
    ['wrong operation', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), operation: 'update' }],
    ['wrong status', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), status: 'sent' }],
    ['non-numeric attempt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), attempt: '0' }],
    ['fractional attempt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), attempt: 0.5 }],
    ['negative attempt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), attempt: -1 }],
    [
      'attempt beyond the bound',
      { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), attempt: MAX_RELATION_DELETE_ATTEMPTS + 1 },
    ],
    [
      'pending marker claiming a terminal instant',
      { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), exhaustedAt: 5 },
    ],
    [
      'terminal marker with no terminal instant',
      { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), status: 'exhausted' },
    ],
    ['oversize lastError', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), lastError: 'x'.repeat(501) }],
    ['non-string lastError', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), lastError: 7 }],
    ['non-numeric nextAttemptAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), nextAttemptAt: '1' }],
    ['non-finite nextAttemptAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), nextAttemptAt: Infinity }],
    ['negative nextAttemptAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), nextAttemptAt: -1 }],
    ['non-numeric createdAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), createdAt: '1' }],
    ['non-finite createdAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), createdAt: Infinity }],
    ['negative createdAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), createdAt: -1 }],
    ['non-numeric updatedAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), updatedAt: '1' }],
    ['non-finite updatedAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), updatedAt: Number.NaN }],
    ['negative updatedAt', { ...buildRelationDeleteOutboxRecord('rel-1', 'token', 1), updatedAt: -1 }],
  ])('rejects a malformed marker: %s', (_name, value) => {
    expect(parseRelationDeleteOutboxRecord('rel-1', value)).toBeNull();
  });
});
