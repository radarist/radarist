/**
 * @file run-evaluation-agent.test.ts
 * @description Unit tests for the Evaluation Agent Inngest handler.
 *
 * Covers the three behaviours that matter at the handler level (the
 * scorer itself is tested in src/lib/signals/__tests__/scorer.test.ts):
 *   1. Happy path — every signalId scored and written
 *   2. Missing signal — skipped without crashing the batch
 *   3. Per-signal failure isolated — one failing updateSignal does not
 *      drop results from sibling signals (Promise.allSettled contract)
 */

jest.mock('@/lib/firebase-admin', () => ({ db: {}, adminAuth: {}, adminApp: {} }));
jest.mock('@/lib/signals-admin', () => ({
  adminGetSignalById: jest.fn(),
  adminUpdateSignal: jest.fn(),
}));
jest.mock('@/lib/signals/scorer', () => ({
  scoreSignal: jest.fn(),
}));
jest.mock('@/lib/logger', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return {
    createLogger: jest.fn(() => logger),
    __mockLogger: logger,
  };
});
jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown) =>
        handler({
          event: { data },
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
}));

import * as signalsAdmin from '@/lib/signals-admin';
import * as scorer from '@/lib/signals/scorer';
import { runEvaluationAgent } from '../run-evaluation-agent';

const mockLogger = (
  require('@/lib/logger') as {
    __mockLogger: { info: jest.Mock };
  }
).__mockLogger;

const mockedGet = signalsAdmin.adminGetSignalById as jest.Mock;
const mockedUpdate = signalsAdmin.adminUpdateSignal as jest.Mock;
const mockedScore = scorer.scoreSignal as jest.Mock;

const baseTrust = {
  overall: 75,
  breakdown: { sourceReliability: 80, dataCompleteness: 70, corroboration: 60, aiConfidence: 70 },
  factors: ['test'],
};

describe('runEvaluationAgent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedScore.mockReturnValue(baseTrust);
    mockedUpdate.mockResolvedValue(undefined);
  });

  it('scores every signal that exists and returns the count', async () => {
    mockedGet.mockResolvedValueOnce({ id: 's1', title: 'A' });
    mockedGet.mockResolvedValueOnce({ id: 's2', title: 'B' });

    const r = await (runEvaluationAgent as any).execute({ signalIds: ['s1', 's2'] });
    expect(r.scored).toBe(2);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
    expect(mockedUpdate).toHaveBeenCalledWith('s1', { trustScore: baseTrust });
    expect(mockedUpdate).toHaveBeenCalledWith('s2', { trustScore: baseTrust });
    expect(mockLogger.info).toHaveBeenCalledWith('Evaluation agent started', { signalCount: 2 });
    expect(mockLogger.info).toHaveBeenCalledWith('Evaluation agent completed', {
      requestedSignalCount: 2,
      scoredSignalCount: 2,
    });
  });

  it('skips missing signals without crashing the batch', async () => {
    mockedGet.mockResolvedValueOnce(null);
    mockedGet.mockResolvedValueOnce({ id: 's2', title: 'B' });

    const r = await (runEvaluationAgent as any).execute({ signalIds: ['missing', 's2'] });
    expect(r.scored).toBe(1);
    expect(mockedUpdate).toHaveBeenCalledTimes(1);
    expect(mockedUpdate).toHaveBeenCalledWith('s2', { trustScore: baseTrust });
  });

  it('isolates per-signal failures via Promise.allSettled', async () => {
    mockedGet.mockResolvedValueOnce({ id: 's1' });
    mockedGet.mockResolvedValueOnce({ id: 's2' });
    mockedUpdate.mockRejectedValueOnce(new Error('firestore timeout'));
    mockedUpdate.mockResolvedValueOnce(undefined);

    const r = await (runEvaluationAgent as any).execute({ signalIds: ['s1', 's2'] });
    expect(r.scored).toBe(1);
    expect(r.results).toHaveLength(1);
  });

  it('handles an empty signalIds array cleanly', async () => {
    const r = await (runEvaluationAgent as any).execute({ signalIds: [] });
    expect(r.scored).toBe(0);
    expect(mockedGet).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });
});
