/**
 * @file agent-runs-client.test.ts
 * @description Locks the client-SDK read of the `agentRuns` collection used by
 * the dashboard (DISC-008): correct query (newest-first, capped) and graceful
 * empty-on-error degradation.
 *
 * @jest-environment node
 */

export {}; // make this file a module so its mock consts stay file-scoped

const mockGetDocs = jest.fn();
const mockCollection = jest.fn(() => 'agentRuns-col');
const mockQuery = jest.fn((...args: unknown[]) => ({ __query: args }));
const mockWhere = jest.fn((...args: unknown[]) => ({ __where: args }));
const mockOrderBy = jest.fn((...args: unknown[]) => ({ __orderBy: args }));
const mockLimit = jest.fn((...args: unknown[]) => ({ __limit: args }));

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  collection: mockCollection,
  getDocs: mockGetDocs,
  query: mockQuery,
  where: mockWhere,
  orderBy: mockOrderBy,
  limit: mockLimit,
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { getRecentAgentRuns } = require('../agent-runs-client');
const { observabilityPrincipals } = require('../system-principals');

const UID = 'user-1';

describe('getRecentAgentRuns', () => {
  beforeEach(() => jest.clearAllMocks());

  it('queries the user+system principals newest-first with the requested cap and returns the docs', async () => {
    mockGetDocs.mockResolvedValue({
      docs: [{ data: () => ({ id: 'r1' }) }, { data: () => ({ id: 'r2' }) }],
    });

    const runs = await getRecentAgentRuns(UID, 10);

    expect(mockCollection).toHaveBeenCalledWith({}, 'agentRuns');
    // AUDIT-019 / ARUN-005: scoped to the observability principal union —
    // the user's own runs plus system-initiated work, NOT a blind uid filter
    // and NOT an unscoped collection read.
    expect(mockWhere).toHaveBeenCalledWith('userId', 'in', observabilityPrincipals(UID));
    expect(mockOrderBy).toHaveBeenCalledWith('createdAt', 'desc');
    expect(mockLimit).toHaveBeenCalledWith(10);
    expect(runs).toEqual([{ id: 'r1' }, { id: 'r2' }]);
  });

  it('defaults to a 50-run cap', async () => {
    mockGetDocs.mockResolvedValue({ docs: [] });
    await getRecentAgentRuns(UID);
    expect(mockLimit).toHaveBeenCalledWith(50);
  });

  it('degrades to [] (never throws) on a read error so the dashboard stays up', async () => {
    mockGetDocs.mockRejectedValue(new Error('permission denied'));
    await expect(getRecentAgentRuns(UID, 5)).resolves.toEqual([]);
  });
});
