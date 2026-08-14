/**
 * @jest-environment node
 * @file __tests__/apply-relation-feedback.test.ts
 * @description LIVE-1 fix — B3 feedback race. Verified live on real Neo4j
 * (2026-07-06): the Neo4j edge + `:Assertion` for a freshly-approved relation
 * are created ASYNCHRONOUSLY by the sync Inngest job. Calling
 * `applyConfidenceFeedback` inline in the triage route raced that sync — on
 * a first approval neither the edge nor the Assertion existed yet, so the
 * calibration Cypher matched 0 rows and the +5 `feedbackDelta` was silently
 * lost. This durable Inngest function moves the delta application off the
 * request path with retry semantics (`retries: 4`) that outlive the sync
 * latency.
 *
 * LIVE-1 FOLLOW-UP (critical fix): the original version wrapped the whole
 * `applyConfidenceFeedback` call — two sequential, non-idempotent
 * accumulator writes — in a SINGLE `step.run`. Inngest only memoizes a step
 * that returns successfully, so a step that throws partway re-executes its
 * ENTIRE callback on retry: edge write succeeds (+5), assertion write throws
 * -> retry re-runs BOTH writes -> the edge is double-counted while the
 * assertion isn't. Fixed by splitting into three independently-memoized
 * steps (`await-materialization` read probe, `apply-edge-feedback`,
 * `apply-assertion-feedback`) so a retry after a partial failure replays the
 * step that already succeeded from Inngest's memo and re-executes only the
 * one that failed. The `step.run` mock below models exactly that memoization
 * behavior so the double-apply regression is provable in a unit test.
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('@/lib/graph/confidence-calibration', () => ({
  relationFeedbackTargetsExist: jest.fn(),
  applyConfidenceFeedbackToEdge: jest.fn(),
  applyConfidenceFeedbackToAssertion: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

// `step.run` mock models Inngest's real memoization contract: a step that
// resolves is cached by name and never re-invoked on a later `execute` call
// sharing the same `memo` Map; a step that throws is NOT cached, so the next
// `execute` call re-invokes it. Tests that want to observe cross-retry
// behavior pass their own `memo` Map into `execute(data, memo)`; tests that
// don't care get a fresh Map per call (matching the previous run-once mock).
jest.mock('../../client', () => ({
  inngest: {
    createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => ({
      config,
      trigger,
      handler,
      execute: (data: unknown, memo: Map<string, unknown> = new Map()) =>
        handler({
          event: { data },
          step: {
            run: async (name: string, fn: () => unknown) => {
              if (memo.has(name)) {
                return memo.get(name);
              }
              const result = await fn();
              memo.set(name, result);
              return result;
            },
          },
        }),
    })),
    send: jest.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import * as confidenceCalibrationModule from '@/lib/graph/confidence-calibration';
import { applyRelationFeedbackJob } from '../apply-relation-feedback';

const mockProbe = confidenceCalibrationModule.relationFeedbackTargetsExist as jest.MockedFunction<
  typeof confidenceCalibrationModule.relationFeedbackTargetsExist
>;
const mockApplyToEdge = confidenceCalibrationModule.applyConfidenceFeedbackToEdge as jest.MockedFunction<
  typeof confidenceCalibrationModule.applyConfidenceFeedbackToEdge
>;
const mockApplyToAssertion = confidenceCalibrationModule.applyConfidenceFeedbackToAssertion as jest.MockedFunction<
  typeof confidenceCalibrationModule.applyConfidenceFeedbackToAssertion
>;

type Job = { execute: (data: unknown, memo?: Map<string, unknown>) => Promise<unknown> };
const TEST_CORRELATION_ID = 'corr_123e4567-e89b-42d3-a456-426614174000';

describe('apply-relation-feedback registration', () => {
  it('registers with id apply-relation-feedback and retries: 4', () => {
    const job = applyRelationFeedbackJob as unknown as { config: Record<string, unknown> };
    expect(job.config.id).toBe('apply-relation-feedback');
    expect(job.config.retries).toBe(4);
  });

  it('triggers on app/relation.feedback.requested', () => {
    const job = applyRelationFeedbackJob as unknown as { trigger: unknown };
    expect(job.trigger).toEqual({ event: 'app/relation.feedback.requested' });
  });
});

describe('apply-relation-feedback handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['empty relation id', { relationId: '', direction: 'up', expectMaterialized: true }],
    ['oversized relation id', { relationId: 'r'.repeat(257), direction: 'up', expectMaterialized: true }],
    ['invalid direction', { relationId: 'rel-1', direction: 'sideways', expectMaterialized: true }],
    ['invalid materialization flag', { relationId: 'rel-1', direction: 'up', expectMaterialized: 'yes' }],
  ])('rejects %s before any graph access', async (_case, data) => {
    const job = applyRelationFeedbackJob as unknown as Job;

    await expect(job.execute(data)).rejects.toThrow('Invalid relation feedback event data');

    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockApplyToEdge).not.toHaveBeenCalled();
    expect(mockApplyToAssertion).not.toHaveBeenCalled();
  });

  it('applies an approve delta with the validated correlation and returns counts', async () => {
    mockProbe.mockResolvedValue({ edge: true, assertion: true });
    mockApplyToEdge.mockResolvedValue({ edgesUpdated: 1 });
    mockApplyToAssertion.mockResolvedValue({ assertionsUpdated: 1 });

    const job = applyRelationFeedbackJob as unknown as Job;
    const result = await job.execute({
      correlationId: TEST_CORRELATION_ID,
      relationId: 'rel-1',
      direction: 'up',
      expectMaterialized: true,
    });

    expect(mockProbe).toHaveBeenCalledWith('rel-1');
    expect(mockApplyToEdge).toHaveBeenCalledWith('rel-1', 'up', TEST_CORRELATION_ID);
    expect(mockApplyToAssertion).toHaveBeenCalledWith('rel-1', 'up', TEST_CORRELATION_ID);
    expect(result).toMatchObject({
      applied: true,
      edgesUpdated: 1,
      assertionsUpdated: 1,
      correlationId: TEST_CORRELATION_ID,
    });
  });

  it('passes the same validated correlation through both reject writes', async () => {
    mockProbe.mockResolvedValue({ edge: true, assertion: true });
    mockApplyToEdge.mockResolvedValue({ edgesUpdated: 1 });
    mockApplyToAssertion.mockResolvedValue({ assertionsUpdated: 1 });

    const job = applyRelationFeedbackJob as unknown as Job;
    await job.execute({
      correlationId: TEST_CORRELATION_ID,
      relationId: 'rel-1',
      direction: 'down',
      expectMaterialized: true,
    });

    expect(mockApplyToEdge).toHaveBeenCalledWith('rel-1', 'down', TEST_CORRELATION_ID);
    expect(mockApplyToAssertion).toHaveBeenCalledWith('rel-1', 'down', TEST_CORRELATION_ID);
  });

  it('keeps legacy events compatible without inventing graph provenance', async () => {
    mockProbe.mockResolvedValue({ edge: true, assertion: true });
    mockApplyToEdge.mockResolvedValue({ edgesUpdated: 1 });
    mockApplyToAssertion.mockResolvedValue({ assertionsUpdated: 1 });

    const job = applyRelationFeedbackJob as unknown as Job;
    const result = await job.execute({
      relationId: 'rel-legacy',
      direction: 'up',
      expectMaterialized: true,
    });

    expect(mockApplyToEdge).toHaveBeenCalledWith('rel-legacy', 'up', undefined);
    expect(mockApplyToAssertion).toHaveBeenCalledWith('rel-legacy', 'up', undefined);
    expect(result).toEqual({ applied: true, edgesUpdated: 1, assertionsUpdated: 1 });
  });

  it('throws to trigger a retry when nothing matched and materialization was expected (throw comes from the probe step only)', async () => {
    mockProbe.mockResolvedValue({ edge: false, assertion: false });

    const job = applyRelationFeedbackJob as unknown as Job;

    await expect(job.execute({ relationId: 'rel-1', direction: 'up', expectMaterialized: true })).rejects.toThrow(
      /not yet materialized/
    );

    expect(mockProbe).toHaveBeenCalledTimes(1);
    expect(mockApplyToEdge).not.toHaveBeenCalled();
    expect(mockApplyToAssertion).not.toHaveBeenCalled();
  });

  it('no-ops gracefully when nothing matched and materialization was not expected', async () => {
    mockProbe.mockResolvedValue({ edge: false, assertion: false });

    const job = applyRelationFeedbackJob as unknown as Job;

    const result = await job.execute({
      correlationId: TEST_CORRELATION_ID,
      relationId: 'rel-1',
      direction: 'down',
      expectMaterialized: false,
    });

    expect(result).toEqual({
      applied: false,
      reason: 'not-materialized',
      correlationId: TEST_CORRELATION_ID,
    });
    expect(mockApplyToEdge).not.toHaveBeenCalled();
    expect(mockApplyToAssertion).not.toHaveBeenCalled();
  });

  it('rejects malformed correlation before any graph probe or write', async () => {
    const job = applyRelationFeedbackJob as unknown as Job;

    await expect(
      job.execute({
        correlationId: 'caller-controlled-text',
        relationId: 'rel-1',
        direction: 'up',
        expectMaterialized: true,
      })
    ).rejects.toThrow('Invalid relation feedback correlation ID');

    expect(mockProbe).not.toHaveBeenCalled();
    expect(mockApplyToEdge).not.toHaveBeenCalled();
    expect(mockApplyToAssertion).not.toHaveBeenCalled();
  });

  it('LIVE-1 critical fix: a partial retry cannot double-apply the delta or change its mutation correlation', async () => {
    const memo = new Map<string, unknown>();

    mockProbe.mockResolvedValue({ edge: true, assertion: true });
    // Attempt 1: edge write succeeds; assertion write throws (simulated
    // transient Neo4j error) — the whole handler invocation rejects.
    mockApplyToEdge.mockResolvedValueOnce({ edgesUpdated: 1 });
    mockApplyToAssertion.mockRejectedValueOnce(new Error('transient neo4j error'));
    // Attempt 2 (same memo): the edge step is already memoized from attempt
    // 1's success, so `mockApplyToEdge` must NOT be called again. Only the
    // assertion step re-runs, and this time it succeeds.
    mockApplyToAssertion.mockResolvedValueOnce({ assertionsUpdated: 1 });

    const job = applyRelationFeedbackJob as unknown as Job;
    const data = {
      correlationId: TEST_CORRELATION_ID,
      relationId: 'rel-1',
      direction: 'up',
      expectMaterialized: true,
    };

    await expect(job.execute(data, memo)).rejects.toThrow('transient neo4j error');
    const result = await job.execute(data, memo);

    expect(mockApplyToEdge).toHaveBeenCalledTimes(1);
    expect(mockApplyToAssertion).toHaveBeenCalledTimes(2);
    expect(mockApplyToEdge).toHaveBeenCalledWith('rel-1', 'up', TEST_CORRELATION_ID);
    expect(mockApplyToAssertion).toHaveBeenNthCalledWith(1, 'rel-1', 'up', TEST_CORRELATION_ID);
    expect(mockApplyToAssertion).toHaveBeenNthCalledWith(2, 'rel-1', 'up', TEST_CORRELATION_ID);
    expect(result).toMatchObject({ applied: true, edgesUpdated: 1, assertionsUpdated: 1 });
  });
});
