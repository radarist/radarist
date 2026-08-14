/**
 * @file agent-runs-failure-fallback.test.ts
 * @description ARUN-008 — the idempotent infrastructure-failure AgentRun
 * fallback. Covers the four required scenarios:
 *   1. early-step failure (no AgentRun yet) → fallback row written honestly
 *   2. post-AgentRun failure (real row exists) → reconciled, never duplicated
 *   3. retry / concurrent onFailure (create race) → idempotent skip
 *   4. Firestore read-back → the fallback row is what listAgentRuns surfaces
 *
 * @jest-environment node
 */

export {}; // module-scope the mock consts

import { createFirebaseAdminMock, fakeQuerySnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();

// The shared mock's docRef has no `create` — add one (admin SDK create()
// fails when the doc exists; tests drive it per-scenario).
const docCreate = jest.fn().mockResolvedValue(undefined);
(adminMock.doc('x') as unknown as { create: jest.Mock }).create = docCreate;

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));
jest.mock('@/lib/graph/agent-run-sync', () => ({
  syncAgentRunToNeo4j: jest.fn().mockResolvedValue(undefined),
}));

const { recordMissionFailureFallback, listAgentRuns } = require('../agent-runs');

const INPUT = {
  missionId: 'm-1',
  userId: 'u-1',
  agentName: 'scout',
  errorMessage: 'function timed out after retries',
};

describe('recordMissionFailureFallback (ARUN-008)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    docCreate.mockResolvedValue(undefined);
  });

  it('1. early-step failure: writes an honest fallback row when no AgentRun exists', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([])); // missionId query → empty

    const result = await recordMissionFailureFallback({
      ...INPUT,
      costUsd: 1.23,
      tokenUsage: { input: 500, output: 200 },
    });

    expect(result).toEqual({ written: true, reason: 'created' });
    expect(adminMock.where).toHaveBeenCalledWith('missionId', '==', 'm-1');
    // Deterministic id keyed by mission.
    expect(adminMock.doc).toHaveBeenCalledWith('run-fallback-m-1');
    const [payload] = docCreate.mock.calls[0];
    expect(payload).toMatchObject({
      id: 'run-fallback-m-1',
      missionId: 'm-1',
      userId: 'u-1',
      agentName: 'scout',
      status: 'failure',
      // Honest about the unknown: no fabricated duration…
      duration: 0,
      durationUnknown: true,
      // …but the pre-failure spend the mission doc persisted IS carried.
      costUsd: 1.23,
      tokenUsage: { input: 500, output: 200 },
      errors: ['function timed out after retries'],
    });
  });

  it('marks cost unavailable when the mission doc persisted nothing', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await recordMissionFailureFallback(INPUT);
    const [payload] = docCreate.mock.calls[0];
    expect(payload.costUsd).toBeUndefined();
    expect(payload.costUnavailableReason).toBe('accounting-incomplete');
    expect(payload.tokenUsage).toEqual({ input: 0, output: 0 });
  });

  it('does not settle a numeric snapshot when the mission already marked it unpriced', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await recordMissionFailureFallback({
      ...INPUT,
      costUsd: 1.23,
      costUnavailableReason: 'unknown-pricing',
    });
    const [payload] = docCreate.mock.calls[0];
    expect(payload.costUsd).toBeUndefined();
    expect(payload.costUnavailableReason).toBe('unknown-pricing');
  });

  it('2. post-AgentRun failure: reconciles an existing success row instead of leaving split terminal truth', async () => {
    const existing = fakeQuerySnapshot([
      {
        id: 'run-real',
        missionId: 'm-1',
        userId: 'u-1',
        status: 'success',
        errors: ['earlier warning'],
      },
    ]);
    adminMock.get.mockResolvedValueOnce(existing);

    const result = await recordMissionFailureFallback(INPUT);

    expect(result).toEqual({ written: true, reason: 'reconciled-existing' });
    expect(existing.docs[0].ref.update).toHaveBeenCalledWith({
      status: 'failure',
      errors: ['earlier warning', 'function timed out after retries'],
    });
    expect(docCreate).not.toHaveBeenCalled();
  });

  it('refuses to reconcile an existing AgentRun owned by another user', async () => {
    const existing = fakeQuerySnapshot([
      { id: 'run-foreign', missionId: 'm-1', userId: 'u-foreign', status: 'success' },
    ]);
    adminMock.get.mockResolvedValueOnce(existing);

    await expect(recordMissionFailureFallback(INPUT)).rejects.toThrow('mission owner mismatch');
    expect(existing.docs[0].ref.update).not.toHaveBeenCalled();
    expect(docCreate).not.toHaveBeenCalled();
  });

  it('3. retry / concurrent onFailure: losing the create race is a clean idempotent skip', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([])); // query raced past the other writer
    docCreate.mockRejectedValueOnce(Object.assign(new Error('ALREADY_EXISTS: document already exists'), { code: 6 }));

    const result = await recordMissionFailureFallback(INPUT);

    expect(result).toEqual({ written: false, reason: 'lost-create-race' });
  });

  it('rethrows non-ALREADY_EXISTS create errors (a real write failure must not be silent)', async () => {
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    docCreate.mockRejectedValueOnce(Object.assign(new Error('UNAVAILABLE'), { code: 14 }));

    await expect(recordMissionFailureFallback(INPUT)).rejects.toThrow('UNAVAILABLE');
  });

  it('4. read-back: the fallback row is returned by listAgentRuns (visible after reload)', async () => {
    // Write path
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([]));
    await recordMissionFailureFallback(INPUT);
    const [written] = docCreate.mock.calls[0];

    // Read path — the Activity page's listAgentRuns query returns the same row.
    adminMock.get.mockResolvedValueOnce(fakeQuerySnapshot([written]));
    const runs = await listAgentRuns('u-1');

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 'run-fallback-m-1',
      status: 'failure',
      durationUnknown: true,
    });
  });
});
