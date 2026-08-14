/**
 * @file status/__tests__/route.test.ts
 * @description UX-051 — the briefing status endpoint behind the truthful
 * first-insight empty states.
 *
 * Contract:
 *   1. `hasExploration` is uid-scoped (the caller's own EXPLORED memory).
 *   2. `sweepEnabled` reflects the resolved background-automation policy.
 *   3. `lastSweep` is the most recent sweep-cycle summary run with its
 *      OBS-004 counters; legacy rows without sweepStats report 'unknown'
 *      with null counts rather than fabricated zeros.
 *   4. A failing source degrades honestly: the field goes null and
 *      `degraded: true` — never a fabricated healthy/empty answer.
 *
 * @jest-environment node
 */

const mockGetAuthenticatedUser = jest.fn();
const mockGetExploredEntities = jest.fn();
const mockConfigGet = jest.fn();
const mockRunsGet = jest.fn();
const mockIsMaintenancePaused = jest.fn();

jest.mock('@/lib/auth-utils', () => ({
  __esModule: true,
  getAuthenticatedUser: (...args: unknown[]) => mockGetAuthenticatedUser(...args),
}));

jest.mock('@/lib/graph/session-memory', () => ({
  __esModule: true,
  getExploredEntities: (...args: unknown[]) => mockGetExploredEntities(...args),
}));

jest.mock('@/lib/firebase-admin', () => ({
  __esModule: true,
  db: {
    collection: jest.fn((name: string) => {
      if (name === 'system-config') {
        return { doc: jest.fn(() => ({ get: (...args: unknown[]) => mockConfigGet(...args) })) };
      }
      const query: Record<string, unknown> = {};
      query.where = jest.fn(() => query);
      query.orderBy = jest.fn(() => query);
      query.limit = jest.fn(() => query);
      query.get = (...args: unknown[]) => mockRunsGet(...args);
      return query;
    }),
  },
}));

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('@/lib/maintenance-policy', () => ({
  __esModule: true,
  isMaintenancePaused: () => mockIsMaintenancePaused(),
}));

import { NextRequest } from 'next/server';
const { GET } = require('../route');

const UID = 'user-owner-a';

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/impulse/briefing/status', { method: 'GET' });
}

function runsSnapshot(docs: Array<Record<string, unknown>>): { docs: Array<{ data: () => Record<string, unknown> }> } {
  return { docs: docs.map((doc) => ({ data: () => doc })) };
}

const SWEEP_STATS = {
  gapsFound: 1,
  missionsSpawned: 1,
  usersProcessed: 1,
  observationsWritten: 0,
  watchedInsights: 0,
  narrativeInsights: 2,
  insightsTotal: 2,
  insightsStatus: 'ok' as const,
};

describe('GET /api/impulse/briefing/status (UX-051)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: UID });
    mockIsMaintenancePaused.mockReturnValue(false);
    mockGetExploredEntities.mockResolvedValue([{ entityId: 'tech-1' }]);
    mockConfigGet.mockResolvedValue({
      exists: true,
      data: () => ({ sweep: { enabled: true, maxActionsPerSweep: 10 } }),
    });
    mockRunsGet.mockResolvedValue(
      runsSnapshot([{ agentName: 'sweep-cycle', createdAt: '2026-07-18T06:00:00.000Z', sweepStats: SWEEP_STATS }])
    );
  });

  it('returns 401 when not authenticated', async () => {
    mockGetAuthenticatedUser.mockResolvedValueOnce({ authenticated: false, error: 'no token' });
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockGetExploredEntities).not.toHaveBeenCalled();
  });

  it('reports the healthy pipeline with uid-scoped exploration and the last sweep counters', async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(mockGetExploredEntities).toHaveBeenCalledWith(UID);
    expect(body).toEqual({
      hasExploration: true,
      sweepEnabled: true,
      pauseReason: null,
      degraded: false,
      lastSweep: {
        at: '2026-07-18T06:00:00.000Z',
        status: 'ok',
        insightsTotal: 2,
        watchedInsights: 0,
        narrativeInsights: 2,
        // OBS-004: this fixture predates child accounting, so the block is null —
        // absent, not zero. A zero would assert "no children failed" about a cycle
        // whose children were never tracked.
        children: null,
      },
    });
  });

  it('reports sweepEnabled false when the policy resolves to paused', async () => {
    mockConfigGet.mockResolvedValue({ exists: true, data: () => ({ sweep: { enabled: false } }) });
    const body = await (await GET(makeRequest())).json();
    expect(body.sweepEnabled).toBe(false);
    expect(body.pauseReason).toBe('settings');
  });

  it('reports the process-wide maintenance guard as paused without pretending Settings can enable it', async () => {
    mockIsMaintenancePaused.mockReturnValue(true);

    const body = await (await GET(makeRequest())).json();

    expect(body.sweepEnabled).toBe(false);
    expect(body.pauseReason).toBe('maintenance');
  });

  it('returns lastSweep null when no sweep summary run exists', async () => {
    mockRunsGet.mockResolvedValue(runsSnapshot([]));
    const body = await (await GET(makeRequest())).json();
    expect(body.lastSweep).toBeNull();
    expect(body.degraded).toBe(false);
  });

  it('skips non-sweep rows and picks the first sweep-cycle summary', async () => {
    mockRunsGet.mockResolvedValue(
      runsSnapshot([
        { agentName: 'linker-cycle', createdAt: '2026-07-18T07:00:00.000Z' },
        { agentName: 'sweep-cycle', createdAt: '2026-07-18T06:00:00.000Z', sweepStats: SWEEP_STATS },
      ])
    );
    const body = await (await GET(makeRequest())).json();
    expect(body.lastSweep?.at).toBe('2026-07-18T06:00:00.000Z');
  });

  it('reports a legacy sweep row without counters as status unknown with null counts — never fabricated zeros', async () => {
    mockRunsGet.mockResolvedValue(runsSnapshot([{ agentName: 'sweep-cycle', createdAt: '2026-07-01T00:00:00.000Z' }]));
    const body = await (await GET(makeRequest())).json();
    expect(body.lastSweep).toEqual({
      at: '2026-07-01T00:00:00.000Z',
      status: 'unknown',
      insightsTotal: null,
      watchedInsights: null,
      narrativeInsights: null,
      children: null,
    });
  });

  // Synthetic sweep: success on the insight lane, two failed paid children,
  // nonzero cost, and zero proposals.
  it('surfaces failed child missions and their spend alongside a healthy insight lane', async () => {
    mockRunsGet.mockResolvedValue(
      runsSnapshot([
        {
          agentName: 'sweep-cycle',
          createdAt: '2026-07-22T06:00:00.000Z',
          sweepStats: {
            gapsFound: 2,
            missionsSpawned: 2,
            usersProcessed: 1,
            observationsWritten: 2,
            watchedInsights: 1,
            narrativeInsights: 0,
            insightsTotal: 1,
            insightsStatus: 'ok',
            children: {
              dispatched: 2,
              settled: 2,
              byOutcome: { failed: 2 },
              outcome: 'failed',
              childrenStatus: 'settled',
              costUsd: 11.25,
              costUnavailableChildren: 0,
              tokensIn: 120_000,
              tokensOut: 8_000,
              childDurationMs: 31_100,
              outputs: { proposals: 0, reports: 0, entities: 0 },
              failedChildren: 2,
            },
          },
        },
      ])
    );

    const body = await (await GET(makeRequest())).json();

    // The insight lane is still reported as healthy — it genuinely was.
    expect(body.lastSweep.status).toBe('ok');
    // And the children's failure is now visible next to it, instead of being
    // hidden behind that healthy lane.
    expect(body.lastSweep.children).toEqual({
      dispatched: 2,
      settled: 2,
      failed: 2,
      childrenStatus: 'settled',
      outcome: 'failed',
      costUsd: 11.25,
      costUnavailableChildren: 0,
      proposals: 0,
      reports: 0,
    });
  });

  it('marks an unsettled child batch as pending so a lower bound is not read as final', async () => {
    mockRunsGet.mockResolvedValue(
      runsSnapshot([
        {
          agentName: 'sweep-cycle',
          createdAt: '2026-07-22T06:00:00.000Z',
          sweepStats: {
            ...SWEEP_STATS,
            children: {
              dispatched: 2,
              settled: 0,
              byOutcome: {},
              childrenStatus: 'pending',
              costUsd: 0,
              costUnavailableChildren: 0,
              tokensIn: 0,
              tokensOut: 0,
              childDurationMs: 0,
              outputs: { proposals: 0, reports: 0, entities: 0 },
              failedChildren: 0,
            },
          },
        },
      ])
    );

    const body = await (await GET(makeRequest())).json();

    expect(body.lastSweep.children.childrenStatus).toBe('pending');
    // No rolled-up outcome while nothing has settled: an aggregate over nothing
    // has no outcome, and defaulting to one is the original defect.
    expect(body.lastSweep.children.outcome).toBeNull();
  });

  it('preserves an early sweep as not-run rather than claiming insight reflection was quiet', async () => {
    mockRunsGet.mockResolvedValue(
      runsSnapshot([
        {
          agentName: 'sweep-cycle',
          createdAt: '2026-07-18T06:00:00.000Z',
          sweepStats: {
            ...SWEEP_STATS,
            gapsFound: 0,
            watchedInsights: 0,
            narrativeInsights: 0,
            insightsTotal: 0,
            insightsStatus: 'not-run',
          },
        },
      ])
    );

    const body = await (await GET(makeRequest())).json();
    expect(body.lastSweep).toMatchObject({ status: 'not-run', insightsTotal: 0 });
  });

  it('degrades honestly when the graph read fails: hasExploration null + degraded true, still 200', async () => {
    mockGetExploredEntities.mockRejectedValue(new Error('neo4j down'));
    const res = await GET(makeRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasExploration).toBeNull();
    expect(body.degraded).toBe(true);
  });

  it('degrades honestly when the config read fails: sweepEnabled null + degraded true', async () => {
    mockConfigGet.mockRejectedValue(new Error('firestore down'));
    const body = await (await GET(makeRequest())).json();
    expect(body.sweepEnabled).toBeNull();
    expect(body.degraded).toBe(true);
  });

  it('degrades honestly when the runs read fails: lastSweep null + degraded true', async () => {
    mockRunsGet.mockRejectedValue(new Error('firestore down'));
    const body = await (await GET(makeRequest())).json();
    expect(body.lastSweep).toBeNull();
    expect(body.degraded).toBe(true);
  });
});
