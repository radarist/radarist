/**
 * @file lib/__tests__/mission-stage-usage.test.ts
 * @description ARUN-022 — the mission auxiliary-stage receipt envelope.
 *
 * The orchestrator envelope only ever covered the Anthropic SDK run. Every
 * auxiliary Gemini stage the mission ALSO bills for — the dispatch classifier, the
 * skill prelude, revision turns, the LLM judge, the report fact-check, and the
 * reflection — rolls into the mission headline but produced no durable receipt, so
 * the ledger could not reconstruct where that money went. These cover the seam that
 * closes it: stable identity, honest scope, loss visibility, and — the case a naive
 * wrapper gets wrong — spend that happened before a stage threw.
 */

jest.mock('@/lib/firebase-admin', () => ({ db: {} }));

const flushCapturedUsage = jest.fn();
jest.mock('@/lib/operation-receipt-instrument', () => {
  const actual = jest.requireActual('@/lib/operation-receipt-instrument');
  return { ...actual, flushCapturedUsage: (...args: unknown[]) => flushCapturedUsage(...args) };
});

import {
  missionStageInvocationPrefix,
  withMissionStageReceipts,
  flushMissionStageUsage,
} from '@/lib/mission-stage-usage';
import { captureProviderUsage, type CapturedProviderUsage } from '@/lib/operation-context';

function usage(operation: string): CapturedProviderUsage {
  return {
    provider: 'gemini',
    operation,
    occurredAt: '2026-07-29T10:00:00.000Z',
    counters: { promptTokens: 100, outputTokens: 20 },
    usageCompleteness: 'complete',
    feeState: 'none',
  };
}

const OK_FLUSH = {
  expected: 1,
  written: 1,
  replayed: 0,
  conflicted: 0,
  failed: 0,
  receipts: [],
  complete: true,
  markerPersisted: true,
};

beforeEach(() => {
  flushCapturedUsage.mockReset();
  flushCapturedUsage.mockResolvedValue(OK_FLUSH);
});

describe('missionStageInvocationPrefix', () => {
  it('is stable for the same mission + stage, so a replay is idempotent', () => {
    expect(missionStageInvocationPrefix('m1', 'judge')).toBe(missionStageInvocationPrefix('m1', 'judge'));
  });

  it('separates stages, so one stage cannot overwrite another stage batch marker', () => {
    expect(missionStageInvocationPrefix('m1', 'judge')).not.toBe(missionStageInvocationPrefix('m1', 'reflection'));
  });

  it('separates repeated runs of the SAME stage by sequence, so a second revision is new spend', () => {
    expect(missionStageInvocationPrefix('m1', 'revision', 0)).not.toBe(
      missionStageInvocationPrefix('m1', 'revision', 1)
    );
  });
});

describe('withMissionStageReceipts', () => {
  it('flushes each captured stage response under the mission correlation as included-in-parent', async () => {
    const result = await withMissionStageReceipts({ missionId: 'm1', owner: 'user:u1', stage: 'judge' }, async () => {
      captureProviderUsage(usage('gemini.generate-structured'));
      return 'verdict';
    });

    expect(result.result).toBe('verdict');
    expect(flushCapturedUsage).toHaveBeenCalledTimes(1);
    const [correlation, captured, prefix, scope] = flushCapturedUsage.mock.calls[0];
    expect(correlation).toEqual({
      parentType: 'mission',
      owner: 'user:u1',
      correlationId: 'm1',
      missionId: 'm1',
    });
    expect((captured as CapturedProviderUsage[]).map((c) => c.operation)).toEqual(['gemini.generate-structured']);
    expect(prefix).toBe(missionStageInvocationPrefix('m1', 'judge'));
    // The mission headline already rolls this component in; a cross-parent total
    // must not add it a second time.
    expect(scope).toBe('included-in-parent');
  });

  it('does not flush (or write a marker) when the stage made no provider call', async () => {
    const result = await withMissionStageReceipts(
      { missionId: 'm1', owner: 'user:u1', stage: 'prelude' },
      async () => 'skipped'
    );
    expect(result.result).toBe('skipped');
    expect(result.flush).toBeUndefined();
    expect(flushCapturedUsage).not.toHaveBeenCalled();
  });

  it('records spend that happened BEFORE the stage threw, and rethrows the original error', async () => {
    const boom = new Error('judge failed');
    await expect(
      withMissionStageReceipts({ missionId: 'm1', owner: 'user:u1', stage: 'judge' }, async () => {
        captureProviderUsage(usage('gemini.generate-structured'));
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(flushCapturedUsage).toHaveBeenCalledTimes(1);
    const captured = flushCapturedUsage.mock.calls[0][1] as CapturedProviderUsage[];
    expect(captured).toHaveLength(1);
  });

  it('never lets a ledger failure break the observed mission stage', async () => {
    flushCapturedUsage.mockRejectedValue(new Error('firestore down'));
    const result = await withMissionStageReceipts({ missionId: 'm1', owner: 'user:u1', stage: 'judge' }, async () => {
      captureProviderUsage(usage('gemini.generate-structured'));
      return 'verdict';
    });
    expect(result.result).toBe('verdict');
    expect(result.flush).toBeUndefined();
  });

  it('surfaces an incomplete flush instead of reporting a clean stage', async () => {
    flushCapturedUsage.mockResolvedValue({ ...OK_FLUSH, written: 0, failed: 1, complete: false });
    const result = await withMissionStageReceipts({ missionId: 'm1', owner: 'user:u1', stage: 'judge' }, async () => {
      captureProviderUsage(usage('gemini.generate-structured'));
      return 'verdict';
    });
    expect(result.flush?.complete).toBe(false);
  });
});

describe('flushMissionStageUsage', () => {
  it('correlates captures the stage could only correlate AFTER the fact', async () => {
    // The dispatch classifier bills BEFORE the mission id exists, so its captures
    // are correlated once creation returns one.
    await flushMissionStageUsage({ missionId: 'm-late', owner: 'user:u1', stage: 'classifier' }, [
      usage('gemini.generate-structured'),
    ]);
    const [correlation, , prefix] = flushCapturedUsage.mock.calls[0];
    expect(correlation).toMatchObject({ parentType: 'mission', correlationId: 'm-late' });
    expect(prefix).toBe(missionStageInvocationPrefix('m-late', 'classifier'));
  });

  it('is a no-op for an empty capture set', async () => {
    const flush = await flushMissionStageUsage({ missionId: 'm1', owner: 'user:u1', stage: 'classifier' }, []);
    expect(flush).toBeUndefined();
    expect(flushCapturedUsage).not.toHaveBeenCalled();
  });
});
