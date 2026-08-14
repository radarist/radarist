/**
 * @jest-environment node
 */

import type { Technology } from '@/lib/types';

const DELETE_SENTINEL = Symbol('delete');
const transactionGet = jest.fn();
const transactionUpdate = jest.fn();
const runTransaction = jest.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
  callback({ get: transactionGet, update: transactionUpdate })
);
const technologyRef = { path: 'technologies/tech-1' };

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => DELETE_SENTINEL },
}));

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: () => ({ doc: () => technologyRef }),
    runTransaction: (callback: (transaction: unknown) => Promise<unknown>) => runTransaction(callback),
  },
}));

import {
  claimResearchDispatch,
  clearPendingSnapshotRefresh,
  completeDeepResearchAttempt,
  completeResearchAttempt,
  inspectResearchAttempt,
  PendingSnapshotRefreshPersistenceError,
  recordPendingSnapshotRefresh,
  releaseResearchPending,
} from '../technology-research-admin';

const NOW = 1_800_000_000_000;

function snapshot(data?: Partial<Technology>) {
  return {
    exists: data !== undefined,
    data: () => data,
  };
}

describe('technology research transactional dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('claims an idle technology inside one read-before-write transaction', async () => {
    transactionGet.mockResolvedValue(snapshot({ id: 'tech-1', name: 'Quantum' }));

    await expect(claimResearchDispatch('tech-1', NOW)).resolves.toEqual({
      claimed: true,
      reason: 'idle',
      startedAt: NOW,
    });
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(transactionUpdate).toHaveBeenCalledWith(technologyRef, {
      researchStatus: 'pending',
      researchStartedAt: NOW,
      updatedAt: NOW,
    });
  });

  it('allows only the first of two competing claims to write', async () => {
    let state: Partial<Technology> = { id: 'tech-1', name: 'Quantum' };
    transactionGet.mockImplementation(async () => snapshot(state));
    transactionUpdate.mockImplementation((_ref, updates: Partial<Technology>) => {
      state = { ...state, ...updates };
    });

    const first = await claimResearchDispatch('tech-1', NOW);
    const second = await claimResearchDispatch('tech-1', NOW + 1);

    expect(first).toMatchObject({ claimed: true, startedAt: NOW });
    expect(second).toEqual({ claimed: false, reason: 'already-running', startedAt: NOW });
    expect(transactionUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not invent a claim after the technology was deleted', async () => {
    transactionGet.mockResolvedValue(snapshot());

    await expect(claimResearchDispatch('tech-1', NOW)).resolves.toEqual({ claimed: false, reason: 'not-found' });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('rolls back only the exact still-pending attempt', async () => {
    transactionGet.mockResolvedValue(
      snapshot({ id: 'tech-1', name: 'Quantum', researchStatus: 'pending', researchStartedAt: NOW })
    );

    await expect(releaseResearchPending('tech-1', 'dispatch-failed', NOW)).resolves.toEqual({ released: true });
    expect(transactionUpdate).toHaveBeenCalledWith(technologyRef, {
      researchStatus: 'failed',
      researchStartedAt: DELETE_SENTINEL,
      updatedAt: expect.any(Number),
    });
  });

  it.each([
    ['a newer attempt', { researchStatus: 'pending', researchStartedAt: NOW + 1 }],
    ['a completed attempt', { researchStatus: 'completed', researchStartedAt: NOW }],
    ['a failed attempt', { researchStatus: 'failed', researchStartedAt: NOW }],
  ])('refuses a stale rollback over %s', async (_label, state) => {
    transactionGet.mockResolvedValue(snapshot({ id: 'tech-1', name: 'Quantum', ...state } as Partial<Technology>));

    await expect(releaseResearchPending('tech-1', 'dispatch-failed', NOW)).resolves.toEqual({ released: false });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('returns the canonical technology only for the exact active attempt', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        description: 'Canonical description',
        researchStatus: 'pending',
        researchStartedAt: NOW,
      })
    );

    await expect(inspectResearchAttempt('tech-1', NOW)).resolves.toMatchObject({
      active: true,
      technology: { id: 'tech-1', name: 'Quantum', description: 'Canonical description' },
    });
  });

  it.each([
    ['a newer attempt', { researchStatus: 'pending', researchStartedAt: NOW + 1 }, 'stale-attempt'],
    ['a completed attempt', { researchStatus: 'completed', researchStartedAt: NOW }, 'already-settled'],
  ])('refuses to inspect %s as active', async (_label, state, reason) => {
    transactionGet.mockResolvedValue(snapshot({ id: 'tech-1', name: 'Quantum', ...state } as Partial<Technology>));

    await expect(inspectResearchAttempt('tech-1', NOW)).resolves.toEqual({ active: false, reason });
  });

  it.each([
    ['comprehensive', { comprehensiveResearch: { lastResearched: NOW, version: 1 } }],
    ['deep', { deepResearch: { summary: 'Persisted result', sources: [] } }],
  ] as const)('resumes only the %s handoff for an exact completed artifact', async (kind, artifact) => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        researchStatus: 'completed',
        researchStartedAt: NOW,
        ...artifact,
      } as Partial<Technology>)
    );

    await expect(inspectResearchAttempt('tech-1', NOW, kind)).resolves.toMatchObject({
      active: false,
      reason: 'handoff-pending',
      technology: { id: 'tech-1', name: 'Quantum' },
    });
  });

  it('completes only the exact attempt and preserves concurrent manual fields', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        description: 'A manual description that must remain unchanged after research completes.',
        category: 'platform',
        tags: ['manual', 'quantum'],
        trl: 8,
        researchStatus: 'pending',
        researchStartedAt: NOW,
      })
    );

    await expect(
      completeResearchAttempt('tech-1', NOW, {
        completedAt: NOW + 100,
        research: { lastResearched: NOW + 100, version: 1 },
        description: 'Generated description',
        category: 'hardware',
        githubUrl: 'https://github.com/example/quantum',
        trl: 4,
        timeToImpact: 'H3',
        tags: ['quantum', 'fast-growing'],
      })
    ).resolves.toEqual({
      completed: true,
      technologyName: 'Quantum',
      updatedFields: ['comprehensiveResearch', 'timeToImpact', 'githubUrl', 'tags'],
    });

    expect(transactionUpdate).toHaveBeenCalledWith(
      technologyRef,
      expect.objectContaining({
        researchStatus: 'completed',
        researchStartedAt: NOW,
        comprehensiveResearch: expect.objectContaining({ version: 1 }),
        timeToImpact: 'H3',
        githubUrl: 'https://github.com/example/quantum',
        tags: ['manual', 'quantum', 'fast-growing'],
      })
    );
    const updates = transactionUpdate.mock.calls[0][1];
    expect(updates.description).toBeUndefined();
    expect(updates.category).toBeUndefined();
    expect(updates.trl).toBeUndefined();
  });

  it('does not let an old completion overwrite a newer attempt', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        researchStatus: 'pending',
        researchStartedAt: NOW + 1,
      })
    );

    await expect(
      completeResearchAttempt('tech-1', NOW, {
        completedAt: NOW + 100,
        research: { lastResearched: NOW + 100, version: 1 },
      })
    ).resolves.toEqual({ completed: false, reason: 'stale-attempt' });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('recognizes an exact already-committed completion as an idempotent replay', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        researchStatus: 'completed',
        researchStartedAt: NOW,
        comprehensiveResearch: { lastResearched: NOW + 100, version: 1 },
      })
    );

    await expect(
      completeResearchAttempt('tech-1', NOW, {
        completedAt: NOW + 200,
        research: { lastResearched: NOW + 100, version: 1 },
        trl: 4,
        timeToImpact: 'H2',
        description: 'A generated description that may have been preserved or replaced.',
        category: 'hardware',
        githubUrl: 'https://github.com/example/quantum',
        tags: ['quantum'],
      })
    ).resolves.toEqual({
      completed: true,
      technologyName: 'Quantum',
      updatedFields: ['comprehensiveResearch'],
    });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('stores basic deep research only for the exact active attempt', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Canonical Quantum',
        researchStatus: 'pending',
        researchStartedAt: NOW,
      })
    );
    const research = {
      summary: 'A sufficiently detailed canonical research summary.',
      keyInsights: ['Insight'],
      lastResearched: NOW + 100,
      sources: ['https://example.com/source'],
    };

    await expect(completeDeepResearchAttempt('tech-1', NOW, { completedAt: NOW + 100, research })).resolves.toEqual({
      completed: true,
      technologyName: 'Canonical Quantum',
      updatedFields: ['deepResearch'],
    });
    expect(transactionUpdate).toHaveBeenCalledWith(technologyRef, {
      deepResearch: research,
      researchStatus: 'completed',
      researchStartedAt: NOW,
      updatedAt: NOW + 100,
    });
  });

  it('does not let a basic completion overwrite a newer attempt', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        researchStatus: 'pending',
        researchStartedAt: NOW + 1,
      })
    );

    await expect(
      completeDeepResearchAttempt('tech-1', NOW, {
        completedAt: NOW + 100,
        research: {
          summary: 'A sufficiently detailed research summary.',
          keyInsights: ['Insight'],
          lastResearched: NOW + 100,
          sources: [],
        },
      })
    ).resolves.toEqual({ completed: false, reason: 'stale-attempt' });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('recognizes an exact committed basic completion as an idempotent replay', async () => {
    const deepResearch = {
      summary: 'A sufficiently detailed research summary.',
      keyInsights: ['Insight'],
      lastResearched: NOW + 100,
      sources: [],
    };
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        name: 'Quantum',
        researchStatus: 'completed',
        researchStartedAt: NOW,
        deepResearch,
      })
    );

    await expect(
      completeDeepResearchAttempt('tech-1', NOW, { completedAt: NOW + 200, research: deepResearch })
    ).resolves.toEqual({
      completed: true,
      technologyName: 'Quantum',
      updatedFields: ['deepResearch'],
    });
    expect(transactionUpdate).not.toHaveBeenCalled();
  });
});

describe('post-research snapshot-refresh debt (ARUN-028)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records the debt without touching researchStatus, starting at attempt count 1', async () => {
    transactionGet.mockResolvedValue(snapshot({ id: 'tech-1', researchStatus: 'completed' }));

    await recordPendingSnapshotRefresh('tech-1', NOW, new Error('dispatch down'));

    expect(transactionUpdate).toHaveBeenCalledWith(technologyRef, {
      pendingSnapshotRefresh: {
        attemptToken: NOW,
        recordedAt: expect.any(Number),
        attempts: 1,
        lastError: 'dispatch down',
      },
      updatedAt: expect.any(Number),
    });
    // researchStatus is never written by the debt recorder.
    const written = transactionUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect('researchStatus' in written).toBe(false);
  });

  it('increments the attempt count when the same attempt fails to dispatch again', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        pendingSnapshotRefresh: { attemptToken: NOW, recordedAt: NOW, attempts: 2 },
      })
    );

    await recordPendingSnapshotRefresh('tech-1', NOW);

    expect(transactionUpdate.mock.calls[0][1]).toMatchObject({
      pendingSnapshotRefresh: expect.objectContaining({ attemptToken: NOW, attempts: 3 }),
    });
  });

  it('resets the attempt count when a newer attempt records debt', async () => {
    transactionGet.mockResolvedValue(
      snapshot({
        id: 'tech-1',
        pendingSnapshotRefresh: { attemptToken: NOW, recordedAt: NOW, attempts: 4 },
      })
    );

    await recordPendingSnapshotRefresh('tech-1', NOW + 1);

    expect(transactionUpdate.mock.calls[0][1]).toMatchObject({
      pendingSnapshotRefresh: expect.objectContaining({ attemptToken: NOW + 1, attempts: 1 }),
    });
  });

  it('surfaces a debt-write failure for bounded handoff-only retry without changing research state', async () => {
    transactionGet.mockRejectedValue(new Error('firestore unavailable'));
    await expect(recordPendingSnapshotRefresh('tech-1', NOW)).rejects.toBeInstanceOf(
      PendingSnapshotRefreshPersistenceError
    );
    expect(transactionUpdate).not.toHaveBeenCalled();
  });

  it('clears the debt only for the matching attempt token', async () => {
    transactionGet.mockResolvedValue(
      snapshot({ id: 'tech-1', pendingSnapshotRefresh: { attemptToken: NOW, recordedAt: NOW, attempts: 1 } })
    );

    await expect(clearPendingSnapshotRefresh('tech-1', NOW)).resolves.toBe(true);
    expect(transactionUpdate).toHaveBeenCalledWith(technologyRef, {
      pendingSnapshotRefresh: DELETE_SENTINEL,
      updatedAt: expect.any(Number),
    });
  });

  it('refuses to clear a newer attempt debt with a stale token', async () => {
    transactionGet.mockResolvedValue(
      snapshot({ id: 'tech-1', pendingSnapshotRefresh: { attemptToken: NOW + 5, recordedAt: NOW, attempts: 1 } })
    );

    await expect(clearPendingSnapshotRefresh('tech-1', NOW)).resolves.toBe(false);
    expect(transactionUpdate).not.toHaveBeenCalled();
  });
});
