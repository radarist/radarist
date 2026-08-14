const mockGet = jest.fn();
const mockLimit = jest.fn(() => ({ get: mockGet }));
const mockWhere = jest.fn(() => ({ limit: mockLimit }));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: jest.fn(() => ({ where: mockWhere })),
  },
}));

import {
  buildInitiativeDependencyReplayEvent,
  loadDependentInitiativeIds,
  MAX_DEPENDENT_INITIATIVE_REPLAYS,
} from '../initiative-dependent-replay';

describe('initiative dependent replay', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('loads a sorted, deduplicated, bounded dependency set', async () => {
    mockGet.mockResolvedValue({
      size: 3,
      docs: [{ id: 'initiative-b' }, { id: 'initiative-a' }, { id: 'initiative-b' }],
    });

    await expect(loadDependentInitiativeIds('strategy', 'strategy-1')).resolves.toEqual([
      'initiative-a',
      'initiative-b',
    ]);
    expect(mockWhere).toHaveBeenCalledWith('linkedStrategyIds', 'array-contains', 'strategy-1');
    expect(mockLimit).toHaveBeenCalledWith(MAX_DEPENDENT_INITIATIVE_REPLAYS + 1);
  });

  it('fails instead of silently replaying a partial fan-out', async () => {
    mockGet.mockResolvedValue({
      size: MAX_DEPENDENT_INITIATIVE_REPLAYS + 1,
      docs: Array.from({ length: MAX_DEPENDENT_INITIATIVE_REPLAYS + 1 }, (_, index) => ({
        id: `initiative-${index}`,
      })),
    });

    await expect(loadDependentInitiativeIds('painPoint', 'pain-1')).rejects.toThrow(
      `more than ${MAX_DEPENDENT_INITIATIVE_REPLAYS} dependent initiatives`
    );
  });

  it('builds a stable, target-scoped replay id with no recursive target mutation', () => {
    const first = buildInitiativeDependencyReplayEvent(
      'parent-event',
      'strategy',
      'strategy-1',
      'initiative-1'
    );
    const replay = buildInitiativeDependencyReplayEvent(
      'parent-event',
      'strategy',
      'strategy-1',
      'initiative-1'
    );
    const otherTarget = buildInitiativeDependencyReplayEvent(
      'parent-event',
      'strategy',
      'strategy-2',
      'initiative-1'
    );

    expect(replay).toEqual(first);
    expect(otherTarget.id).not.toBe(first.id);
    expect(first).toMatchObject({
      name: 'app/unified-entity.sync.requested',
      data: { operation: 'update', entityType: 'initiative', entityId: 'initiative-1' },
    });
  });
});
