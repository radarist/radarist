/**
 * @jest-environment node
 */

// Admin-SDK fake. Each method on the chain returns `this` so the test can
// drive the final terminal (`get`, `set`, `update`) via the per-spy mocks.
const mockDigestsGet = jest.fn();
const mockDigestsSet = jest.fn();
const mockDigestsUpdate = jest.fn();
const mockBatchUpdate = jest.fn();
const mockBatchCommit = jest.fn();
const docFake = { get: mockDigestsGet, set: mockDigestsSet, update: mockDigestsUpdate };
const collectionFake = {
  doc: jest.fn(() => docFake),
  where: function () {
    return this;
  },
  limit: function () {
    return this;
  },
  get: mockDigestsGet,
};
const batchFake = { update: mockBatchUpdate, commit: mockBatchCommit };

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => collectionFake),
    batch: jest.fn(() => batchFake),
  },
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const {
  createDigest,
  getUnreadDigests,
  markDigestRead,
  markAllDigestsRead,
  isZeroActivityDigest,
} = require('../digests');

describe('digests', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should create a digest document', async () => {
    mockDigestsSet.mockResolvedValue(undefined);

    await createDigest({
      userId: 'user-1',
      date: '2026-03-14',
      summary: {
        signalsDiscovered: 5,
        connectionsFound: 3,
        entitiesEnriched: 2,
        insightsGenerated: 1,
        tokenUsage: 12000,
        tokenBudget: 100000,
      },
      highlights: [{ type: 'discovery', title: 'Found NeuralScale', entityId: 'tech-1' }],
    });

    expect(mockDigestsSet).toHaveBeenCalledTimes(1);
  });

  it('should generate id from userId and date', async () => {
    mockDigestsSet.mockResolvedValue(undefined);

    await createDigest({
      userId: 'user-1',
      date: '2026-03-14',
      summary: {
        signalsDiscovered: 0,
        connectionsFound: 0,
        entitiesEnriched: 0,
        insightsGenerated: 0,
        tokenUsage: 0,
        tokenBudget: 100000,
      },
      highlights: [],
    });

    // doc('digests', id) is the admin chain entry point.
    expect(collectionFake.doc).toHaveBeenCalled();
  });

  it('should return unread digests for a user', async () => {
    mockDigestsGet.mockResolvedValue({
      docs: [
        {
          id: 'd1',
          data: () => ({
            id: 'd1',
            userId: 'user-1',
            date: '2026-03-14',
            read: false,
            summary: { signalsDiscovered: 2, connectionsFound: 0, insightsGenerated: 0 },
          }),
        },
      ],
    });

    const result = await getUnreadDigests('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].read).toBe(false);
  });

  it('filters out all-zero-activity digests (heals stale legacy backlog without a migration)', async () => {
    mockDigestsGet.mockResolvedValue({
      docs: [
        {
          data: () => ({
            id: 'stale-1',
            userId: 'user-1',
            date: '2026-04-18',
            read: false,
            summary: { signalsDiscovered: 0, connectionsFound: 0, insightsGenerated: 0 },
          }),
        },
        {
          data: () => ({
            id: 'real-1',
            userId: 'user-1',
            date: '2026-04-19',
            read: false,
            summary: { signalsDiscovered: 1, connectionsFound: 0, insightsGenerated: 0 },
          }),
        },
      ],
    });

    const result = await getUnreadDigests('user-1');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('real-1');
  });

  it('caps the returned digests at 10 even when the scan window returns more', async () => {
    const docs = Array.from({ length: 15 }, (_, i) => ({
      data: () => ({
        id: `d${i}`,
        userId: 'user-1',
        date: `2026-04-${10 + i}`,
        read: false,
        summary: { signalsDiscovered: 1, connectionsFound: 0, insightsGenerated: 0 },
      }),
    }));
    mockDigestsGet.mockResolvedValue({ docs });

    const result = await getUnreadDigests('user-1');
    expect(result).toHaveLength(10);
  });

  it('should mark a digest as read', async () => {
    mockDigestsUpdate.mockResolvedValue(undefined);

    await markDigestRead('digest-1');
    expect(mockDigestsUpdate).toHaveBeenCalledTimes(1);
  });

  it('should mark every unread digest read in one batch', async () => {
    const docRefs = [{ id: 'a' }, { id: 'b' }];
    mockDigestsGet.mockResolvedValue({ empty: false, docs: docRefs.map((ref) => ({ ref })) });
    mockBatchCommit.mockResolvedValue(undefined);

    const count = await markAllDigestsRead('user-1');

    expect(mockBatchUpdate).toHaveBeenCalledTimes(2);
    expect(mockBatchCommit).toHaveBeenCalledTimes(1);
    expect(count).toBe(2);
  });

  it('markAllDigestsRead skips the batch write when there is nothing unread', async () => {
    mockDigestsGet.mockResolvedValue({ empty: true, docs: [] });

    const count = await markAllDigestsRead('user-1');

    expect(mockBatchCommit).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  it("markAllDigestsRead chunks at Firestore's 500-write batch cap", async () => {
    const docs = Array.from({ length: 501 }, (_, i) => ({ ref: { id: `d${i}` } }));
    mockDigestsGet.mockResolvedValue({ empty: false, docs });
    mockBatchCommit.mockResolvedValue(undefined);

    const count = await markAllDigestsRead('user-1');

    expect(mockBatchUpdate).toHaveBeenCalledTimes(501);
    expect(mockBatchCommit).toHaveBeenCalledTimes(2); // 500 + 1
    expect(count).toBe(501);
  });

  describe('isZeroActivityDigest', () => {
    it('is true when signals, connections, and insights are all zero', () => {
      expect(
        isZeroActivityDigest({
          signalsDiscovered: 0,
          connectionsFound: 0,
          entitiesEnriched: 3, // deliberately non-zero — not part of the check
          insightsGenerated: 0,
          tokenUsage: 0,
          tokenBudget: 100000,
        })
      ).toBe(true);
    });

    it('is false when any of the three counters is non-zero', () => {
      expect(
        isZeroActivityDigest({
          signalsDiscovered: 0,
          connectionsFound: 1,
          entitiesEnriched: 0,
          insightsGenerated: 0,
          tokenUsage: 0,
          tokenBudget: 100000,
        })
      ).toBe(false);
    });
  });
});
