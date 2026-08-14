/**
 * @file agent-events.test.ts
 * @description Unit tests for the Firestore agent event emitter.
 *
 * @phase Phase 3: SSE Event Gateway
 */
export {}; // make this a module so its top-level mock consts don't collide in the global test scope

// Mock the admin Timestamp
const mockTimestamp = {
  now: jest.fn(() => ({ seconds: 1000, nanoseconds: 0 })),
  fromDate: jest.fn((d: Date) => ({ seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 })),
};

jest.mock('firebase-admin/firestore', () => ({
  Timestamp: {
    now: () => mockTimestamp.now(),
    fromDate: (d: Date) => mockTimestamp.fromDate(d),
  },
}));

// Mock the admin Firestore db with chainable query builder
const mockAdd = jest.fn().mockResolvedValue({ id: 'doc-1' });
const mockGet = jest.fn().mockResolvedValue({ docs: [] });

const mockQueryBuilder = {
  where: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  get: mockGet,
};

const mockCollection = jest.fn().mockReturnValue({
  add: mockAdd,
  where: mockQueryBuilder.where,
  orderBy: mockQueryBuilder.orderBy,
  limit: mockQueryBuilder.limit,
  get: mockQueryBuilder.get,
});

// Chain returns itself for where/orderBy/limit
mockQueryBuilder.where.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.orderBy.mockReturnValue(mockQueryBuilder);
mockQueryBuilder.limit.mockReturnValue(mockQueryBuilder);

jest.mock('@/lib/firebase-admin', () => ({
  db: { collection: mockCollection },
}));

const { emitAgentEvent, getEventsAfterSequence, getEventsForRun, _resetSequence } = require('../agent-events');

describe('Agent Events Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetSequence('user-1');
    // Re-wire chain returns after clearAllMocks
    mockQueryBuilder.where.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.orderBy.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.limit.mockReturnValue(mockQueryBuilder);
    mockGet.mockResolvedValue({ docs: [] });
    mockAdd.mockResolvedValue({ id: 'doc-1' });
  });

  describe('emitAgentEvent', () => {
    it('should validate event before writing — rejects invalid type', async () => {
      await expect(emitAgentEvent({ type: 'invalid.type', userId: 'user-1', data: {} })).rejects.toThrow();
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('should validate event before writing — rejects missing userId', async () => {
      await expect(emitAgentEvent({ type: 'agent.started', data: {} })).rejects.toThrow();
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('should write valid event to Firestore', async () => {
      const result = await emitAgentEvent({
        type: 'agent.started',
        userId: 'user-1',
        missionId: 'mission-1',
        data: { agentName: 'scout' },
      });

      expect(mockCollection).toHaveBeenCalledWith('agent-events');
      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('agent.started');
      expect(result.userId).toBe('user-1');
      expect(result.missionId).toBe('mission-1');
      expect(result.id).toMatch(/^evt-/);
      // Sequence is now timestamp-derived (microsecond precision)
      expect(result.sequence).toBeGreaterThan(0);
      expect(Number.isInteger(result.sequence)).toBe(true);
    });

    it('should auto-increment sequence per user', async () => {
      const evt1 = await emitAgentEvent({
        type: 'agent.started',
        userId: 'user-1',
        data: {},
      });
      const evt2 = await emitAgentEvent({
        type: 'agent.completed',
        userId: 'user-1',
        data: {},
      });

      // Sequences are timestamp-derived and monotonically increasing
      expect(evt1.sequence).toBeGreaterThan(0);
      expect(evt2.sequence).toBeGreaterThan(evt1.sequence);
    });

    it('should set 24h TTL on written document', async () => {
      await emitAgentEvent({
        type: 'agent.started',
        userId: 'user-1',
        data: {},
      });

      const writtenData = mockAdd.mock.calls[0][0];
      expect(writtenData._ttl).toBeDefined();
      expect(writtenData._createdAt).toBeDefined();
      expect(mockTimestamp.fromDate).toHaveBeenCalled();
    });

    it('should include optional fields when provided', async () => {
      const result = await emitAgentEvent({
        type: 'sweep.phase',
        userId: 'user-1',
        sweepId: 'sweep-abc',
        agentType: 'scout',
        data: { phase: 'SENSE' },
      });

      expect(result.sweepId).toBe('sweep-abc');
      expect(result.agentType).toBe('scout');
    });
  });

  describe('getEventsAfterSequence', () => {
    it('filters on the principal union in the Firestore query (uses (userId, sequence) composite index)', async () => {
      // With the (userId, sequence) composite index deployed, Firestore
      // pre-filters by userId; the mock returns only matching rows.
      mockGet.mockResolvedValue({
        docs: [
          { data: () => ({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 5, data: {} }) },
          { data: () => ({ id: 'evt-2', type: 'agent.completed', userId: 'user-1', sequence: 6, data: {} }) },
        ],
      });

      const events = await getEventsAfterSequence('user-1', 4);

      expect(mockCollection).toHaveBeenCalledWith('agent-events');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('userId', 'in', [
        'user-1',
        'system',
        'system-sweep',
        'system-discovery',
      ]);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('sequence', '>', 4);
      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('sequence', 'asc');
      expect(events).toHaveLength(2);
      expect(events[0].userId).toBe('user-1');
      expect(events[1].userId).toBe('user-1');
    });

    it('should return empty array when no events', async () => {
      mockGet.mockResolvedValue({ docs: [] });

      const events = await getEventsAfterSequence('user-1', 0);
      expect(events).toHaveLength(0);
    });
  });

  describe('getEventsForRun', () => {
    const doc = (event: Record<string, unknown>) => ({ data: () => event });

    it('queries missionId and sweepId with the principal union + equality filters (no orderBy)', async () => {
      mockGet.mockResolvedValue({ docs: [] });

      await getEventsForRun('user-1', 'mission-1');

      expect(mockCollection).toHaveBeenCalledWith('agent-events');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('userId', 'in', [
        'user-1',
        'system',
        'system-sweep',
        'system-discovery',
      ]);
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('missionId', '==', 'mission-1');
      expect(mockQueryBuilder.where).toHaveBeenCalledWith('sweepId', '==', 'mission-1');
      // No orderBy — ordering is in-memory so no composite index is needed.
      expect(mockQueryBuilder.orderBy).not.toHaveBeenCalled();
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(500);
    });

    it('merges mission + sweep results, dedups by id, and sorts by sequence ascending', async () => {
      // Promise.all builds the mission query first, then the sweep query.
      mockGet
        .mockResolvedValueOnce({
          docs: [
            doc({ id: 'evt-2', type: 'agent.thinking', userId: 'user-1', sequence: 20, data: {} }),
            doc({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 10, data: {} }),
          ],
        })
        .mockResolvedValueOnce({
          docs: [
            // Duplicate of evt-1 (an event carrying BOTH missionId and sweepId
            // matches both queries) — must render once.
            doc({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 10, data: {} }),
            doc({ id: 'evt-3', type: 'agent.completed', userId: 'user-1', sequence: 30, data: {} }),
          ],
        });

      const result = await getEventsForRun('user-1', 'run-x');

      expect(result.events.map((e: { id: string }) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
      expect(result.events.map((e: { sequence: number }) => e.sequence)).toEqual([10, 20, 30]);
      expect(result.truncated).toBe(false);
    });

    it('respects maxResults after the merge', async () => {
      mockGet
        .mockResolvedValueOnce({
          docs: [
            doc({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 10, data: {} }),
            doc({ id: 'evt-2', type: 'agent.thinking', userId: 'user-1', sequence: 20, data: {} }),
          ],
        })
        .mockResolvedValueOnce({
          docs: [doc({ id: 'evt-3', type: 'agent.completed', userId: 'user-1', sequence: 30, data: {} })],
        });

      const result = await getEventsForRun('user-1', 'run-x', 2);

      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(2);
      expect(result.events.map((e: { id: string }) => e.id)).toEqual(['evt-1', 'evt-2']);
    });

    it('returns an empty events array + truncated: false when neither query matches (unknown or TTL-expired run)', async () => {
      mockGet.mockResolvedValue({ docs: [] });

      const result = await getEventsForRun('user-1', 'nonexistent');
      expect(result.events).toEqual([]);
      expect(result.truncated).toBe(false);
    });

    it('sets truncated: true when the mission sub-query hits the maxResults cap', async () => {
      // Exactly maxResults (2) docs on the mission leg — Firestore's
      // unspecified ordering on this unindexed equality query means these
      // could be an arbitrary subset of a larger true result set.
      mockGet
        .mockResolvedValueOnce({
          docs: [
            doc({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 10, data: {} }),
            doc({ id: 'evt-2', type: 'agent.thinking', userId: 'user-1', sequence: 20, data: {} }),
          ],
        })
        .mockResolvedValueOnce({ docs: [] });

      const result = await getEventsForRun('user-1', 'run-x', 2);
      expect(result.truncated).toBe(true);
    });

    it('sets truncated: true when the sweep sub-query hits the maxResults cap', async () => {
      mockGet.mockResolvedValueOnce({ docs: [] }).mockResolvedValueOnce({
        docs: [
          doc({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 10, data: {} }),
          doc({ id: 'evt-2', type: 'agent.thinking', userId: 'user-1', sequence: 20, data: {} }),
        ],
      });

      const result = await getEventsForRun('user-1', 'sweep-x', 2);
      expect(result.truncated).toBe(true);
    });

    it('sets truncated: false when the sub-query count is one below the cap', async () => {
      mockGet
        .mockResolvedValueOnce({
          docs: [doc({ id: 'evt-1', type: 'agent.started', userId: 'user-1', sequence: 10, data: {} })],
        })
        .mockResolvedValueOnce({ docs: [] });

      const result = await getEventsForRun('user-1', 'run-x', 2);
      expect(result.truncated).toBe(false);
    });
  });
});
