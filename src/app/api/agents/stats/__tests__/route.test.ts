/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// Mock auth - default to authenticated
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

// Admin-SDK fake. The route builds a fluent query:
// db.collection('job-runs').where(...).limit(...).get(). The shared
// mockGet captures the final .get() call; the intermediate chain
// methods all return `this`.
const mockGet = jest.fn();
const adminCollection = {
  where: function () {
    return this;
  },
  limit: function () {
    return this;
  },
  get: (...args: unknown[]) => mockGet(...args),
};

jest.mock('@/lib/firebase-admin', () => ({
  db: {
    collection: () => adminCollection,
  },
}));

import { GET } from '../route';

function createMockRequest(): NextRequest {
  return new NextRequest('http://localhost:3000/api/agents/stats', {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

function createMockSnapshot(
  docs: Array<{ status: string; startedAt: number; completedAt?: number; domainOutcome?: string }>
) {
  return {
    docs: docs.map((d, i) => ({
      id: `run-${i}`,
      data: () => d,
    })),
  };
}

describe('GET /api/agents/stats', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'Not authenticated',
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('Not authenticated');
  });

  it('returns stats for all default agents', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000000000 },
        { status: 'completed', startedAt: 1699999000000 },
        { status: 'failed', startedAt: 1699998000000 },
      ])
    );

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats).toBeDefined();
    // Should have stats for scout and evaluation (linker/monitor removed)
    expect(json.stats.scout).toBeDefined();
    expect(json.stats.evaluation).toBeDefined();
    expect(json.stats.linker).toBeUndefined();
    expect(json.stats.monitor).toBeUndefined();
  });

  // ARUN-023: a user cancelling their own build must not read as agent failure.
  // OBS-001 keeps that rule but applies it on the DOMAIN axis, where it belongs.
  it('excludes cancelled runs from the success-rate denominator', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000003000, domainOutcome: 'success' },
        { status: 'completed', startedAt: 1700000002000, domainOutcome: 'success' },
        { status: 'cancelled', startedAt: 1700000001000, domainOutcome: 'cancelled' },
        { status: 'cancelled', startedAt: 1700000000000, domainOutcome: 'cancelled' },
      ])
    );

    const json = await (await GET(createMockRequest())).json();

    // 2 delivered / 2 decided = 100%, not 2/4 = 50%.
    expect(json.stats.scout.successRate).toBe(100);
    // Nothing is hidden: every row is still reported in totalRuns.
    expect(json.stats.scout.totalRuns).toBe(4);
    expect(json.stats.scout.successCount).toBe(2);
    expect(json.stats.scout.failureCount).toBe(0);
    expect(json.stats.scout.undeclaredOutcomeCount).toBe(0);
  });

  it('reports cancelled as the latest run status without casting outside the API contract', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000000000, domainOutcome: 'success' },
        { status: 'cancelled', startedAt: 1700000001000, domainOutcome: 'cancelled' },
      ])
    );

    const json = await (await GET(createMockRequest())).json();

    expect(json.stats.scout.lastRunStatus).toBe('cancelled');
    expect(json.stats.scout.lastDomainOutcome).toBe('cancelled');
    expect(json.stats.scout.successRate).toBe(100);
  });

  it('reports 0% rather than a fake rate when no run has an outcome yet', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'running', startedAt: 1700000001000 },
        { status: 'cancelled', startedAt: 1700000000000, domainOutcome: 'cancelled' },
      ])
    );

    const json = await (await GET(createMockRequest())).json();

    expect(json.stats.scout.successRate).toBe(0);
    expect(json.stats.scout.totalRuns).toBe(2);
    // A still-running row is not terminal, so it is not "undeclared" either.
    expect(json.stats.scout.undeclaredOutcomeCount).toBe(0);
  });

  it('calculates success rate correctly', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000003000, domainOutcome: 'success' },
        { status: 'completed', startedAt: 1700000002000, domainOutcome: 'success' },
        { status: 'failed', startedAt: 1700000001000, domainOutcome: 'failed' },
        { status: 'completed', startedAt: 1700000000000, domainOutcome: 'success' },
      ])
    );

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Scout has 1 function ID -> 4 runs (3 delivered, 1 failed) = 75%
    expect(json.stats.scout.successRate).toBe(75);
    expect(json.stats.scout.totalRuns).toBe(4);
    expect(json.stats.scout.successCount).toBe(3);
    expect(json.stats.scout.failureCount).toBe(1);
  });

  // ==========================================================================
  // OBS-001 — the reproduced mismatch
  // ==========================================================================

  it('counts a transport-completed run whose declared business outcome failed as a FAILURE', async () => {
    // The exact TEST-027 Creator evidence. Pre-fix this row was in the success
    // numerator purely because the Inngest run returned without throwing.
    mockGet.mockResolvedValue(
      createMockSnapshot([{ status: 'completed', startedAt: 1700000000000, domainOutcome: 'failed' }])
    );

    const json = await (await GET(createMockRequest())).json();

    expect(json.stats.scout.successRate).toBe(0);
    expect(json.stats.scout.successCount).toBe(0);
    expect(json.stats.scout.failureCount).toBe(1);
    // The transport fact is still reported — under its own name.
    expect(json.stats.scout.transportCompletedCount).toBe(1);
    expect(json.stats.scout.lastDomainOutcome).toBe('failed');
  });

  it('excludes an undeclared terminal run from both sides and reports it explicitly', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000002000, domainOutcome: 'success' },
        { status: 'completed', startedAt: 1700000001000 },
        { status: 'failed', startedAt: 1700000000000 },
      ])
    );

    const json = await (await GET(createMockRequest())).json();

    // Only the one declared row decides the rate; the other two are visible as
    // undeclared instead of being silently counted or silently dropped.
    expect(json.stats.scout.successRate).toBe(100);
    expect(json.stats.scout.successCount).toBe(1);
    expect(json.stats.scout.failureCount).toBe(0);
    expect(json.stats.scout.undeclaredOutcomeCount).toBe(2);
    expect(json.stats.scout.totalRuns).toBe(3);
    expect(json.stats.scout.transportCompletedCount).toBe(2);
    expect(json.stats.scout.transportFailedCount).toBe(1);
  });

  it('counts a partial delivery as delivered, not failed', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000001000, domainOutcome: 'partial' },
        { status: 'completed', startedAt: 1700000000000, domainOutcome: 'failed' },
      ])
    );

    const json = await (await GET(createMockRequest())).json();

    expect(json.stats.scout.successCount).toBe(1);
    expect(json.stats.scout.failureCount).toBe(1);
    expect(json.stats.scout.successRate).toBe(50);
  });

  it('keeps an honest no-op out of the rate entirely', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: 1700000001000, domainOutcome: 'skipped' },
        { status: 'completed', startedAt: 1700000000000, domainOutcome: 'skipped' },
      ])
    );

    const json = await (await GET(createMockRequest())).json();

    expect(json.stats.scout.successRate).toBe(0);
    expect(json.stats.scout.successCount).toBe(0);
    expect(json.stats.scout.failureCount).toBe(0);
    expect(json.stats.scout.totalRuns).toBe(2);
  });

  it('never back-infers an outcome from a garbage domainOutcome value', async () => {
    mockGet.mockResolvedValue(
      createMockSnapshot([{ status: 'completed', startedAt: 1700000000000, domainOutcome: 'completed' }])
    );

    const json = await (await GET(createMockRequest())).json();

    expect(json.stats.scout.lastDomainOutcome).toBeNull();
    expect(json.stats.scout.successCount).toBe(0);
    expect(json.stats.scout.undeclaredOutcomeCount).toBe(1);
  });

  it('returns most recent run as lastRunAt', async () => {
    const mostRecentTime = 1700000003000;
    mockGet.mockResolvedValue(
      createMockSnapshot([
        { status: 'completed', startedAt: mostRecentTime },
        { status: 'failed', startedAt: 1700000001000 },
      ])
    );

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.scout.lastRunAt).toBe(mostRecentTime);
    expect(json.stats.scout.lastRunStatus).toBe('completed');
  });

  it('returns 0% success rate when no runs exist, not a fake 95%', async () => {
    mockGet.mockResolvedValue(createMockSnapshot([]));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.scout.totalRuns).toBe(0);
    expect(json.stats.scout.lastRunAt).toBeNull();
    expect(json.stats.scout.lastRunStatus).toBeNull();
    // Must be 0 when no runs exist, never a fake hardcoded value
    expect(json.stats.scout.successRate).toBe(0);
  });

  it('returns 0% success rate on Firestore error, not a fake 95%', async () => {
    mockGet.mockRejectedValue(new Error('Firestore unavailable'));

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Should fall back to default stats for each agent
    expect(json.stats.scout).toBeDefined();
    expect(json.stats.scout.lastRunAt).toBeNull();
    // Must be 0 on error, never a fake hardcoded value
    expect(json.stats.scout.successRate).toBe(0);
    expect(json.stats.scout.totalRuns).toBe(0);
  });

  it('handles Firestore Timestamp objects with toMillis()', async () => {
    const mockTimestamp = {
      toMillis: () => 1700000005000,
    };
    mockGet.mockResolvedValue({
      docs: [
        {
          id: 'run-ts',
          data: () => ({
            status: 'completed',
            startedAt: mockTimestamp,
            completedAt: mockTimestamp,
          }),
        },
      ],
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stats.scout.lastRunAt).toBe(1700000005000);
  });
});
