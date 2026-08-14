/**
 * @jest-environment node
 * @file status/__tests__/correlation.test.ts
 * @description OBS-003 — the accepted request identity is QUERYABLE.
 *
 * This is the hop the retained `TEST-027` acceptance could not complete. The
 * trigger accepted a request, the pipeline ran, the job-run middleware recorded
 * it — and then the status surface reported `lastRun: { …all nulls }` with the
 * comment "would be populated from a persistent store in production", so there
 * was no way to ask "what happened to MY request?".
 *
 * The honesty rules the shape has to keep (OBS-001): transport `status` and
 * declared `domainOutcome` stay separate, and an undeclared outcome renders as
 * absent rather than as a success.
 */
import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/trends-admin', () => ({ adminGetTrendStats: jest.fn() }));
jest.mock('@/lib/graph', () => ({ getGraphServiceHealth: jest.fn() }));
jest.mock('@/lib/pipeline', () => ({
  getGraphRefreshStats: jest.fn(),
  verifyGraphIntegrity: jest.fn(),
}));
jest.mock('@/lib/inngest/observability', () => ({
  getRecentJobRuns: jest.fn(),
  findJobRunsByCorrelationId: jest.fn(),
}));

const { adminGetTrendStats } = jest.requireMock('@/lib/trends-admin');
const { getGraphServiceHealth } = jest.requireMock('@/lib/graph');
const { getGraphRefreshStats, verifyGraphIntegrity } = jest.requireMock('@/lib/pipeline');
const { getRecentJobRuns, findJobRunsByCorrelationId } = jest.requireMock('@/lib/inngest/observability');

import { CORRELATION_ID_HEADER } from '@/lib/observability/correlation';
import { GET } from '../route';

const ACCEPTED = 'corr_3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/pipeline/status${query}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-token' },
  });
}

/** A job-run row as the middleware writes it for a completed pipeline. */
function pipelineRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inngest-01JRUN',
    functionId: 'daily-pipeline',
    functionName: 'Daily Pipeline',
    status: 'completed',
    correlationId: ACCEPTED,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_060_000,
    duration: 60_000,
    input: { event: 'app/pipeline.trigger', correlationId: ACCEPTED },
    output: {
      success: true,
      stepsReplayed: 0,
      summary: {
        signalsProcessed: 4,
        entitiesExtracted: 9,
        relationsProposed: 3,
        trendsComputed: 2,
      },
    },
    ...overrides,
  };
}

describe('GET /api/pipeline/status correlation (OBS-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    adminGetTrendStats.mockResolvedValue({ total: 0, emerging: 0, growing: 0, stable: 0, declining: 0 });
    getGraphServiceHealth.mockResolvedValue({ healthy: true, backend: 'neo4j', latencyMs: 3 });
    getGraphRefreshStats.mockResolvedValue({ nodeCount: 1, claimCount: 2, relationCount: 3 });
    verifyGraphIntegrity.mockResolvedValue({ healthy: true, issues: [] });
    getRecentJobRuns.mockResolvedValue([]);
    findJobRunsByCorrelationId.mockResolvedValue([]);
  });

  it('answers "what happened to my request?" for an accepted identity', async () => {
    findJobRunsByCorrelationId.mockResolvedValue([pipelineRun()]);

    const res = await GET(request(`?correlationId=${ACCEPTED}`));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(findJobRunsByCorrelationId).toHaveBeenCalledWith(ACCEPTED);
    expect(json.requestedRun).toMatchObject({
      correlationId: ACCEPTED,
      jobRunId: 'inngest-01JRUN',
      status: 'completed',
      success: true,
      signalsProcessed: 4,
      trendsComputed: 2,
      entitiesExtracted: 9,
      relationsProposed: 3,
    });
    // The identity being ASKED ABOUT is not this read's own trace — an operator
    // routinely looks up someone else's request — so the echoed header is this
    // request's own minted token, not the queried one.
    expect(res.headers.get(CORRELATION_ID_HEADER)).not.toBe(ACCEPTED);
    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^corr_[0-9a-f-]{36}$/);
  });

  it('reports a known-absent request rather than an empty-looking success', async () => {
    const res = await GET(request(`?correlationId=${ACCEPTED}`));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.requestedRun).toBeNull();
  });

  it('rejects a malformed identity instead of scanning for caller text', async () => {
    const res = await GET(request('?correlationId=not-a-token'));

    expect(res.status).toBe(400);
    expect(findJobRunsByCorrelationId).not.toHaveBeenCalled();
  });

  it('ignores runs of other functions that share the identity', async () => {
    // One request can fan out to several functions. Only the pipeline run
    // answers a question asked of the pipeline status surface.
    findJobRunsByCorrelationId.mockResolvedValue([
      { ...pipelineRun(), functionId: 'sync-relation-to-neo4j', id: 'inngest-OTHER' },
    ]);

    const json = await (await GET(request(`?correlationId=${ACCEPTED}`))).json();

    expect(json.requestedRun).toBeNull();
  });

  it('returns the newest run when an identity was replayed', async () => {
    findJobRunsByCorrelationId.mockResolvedValue([
      pipelineRun({ id: 'inngest-OLD', startedAt: 1_600_000_000_000 }),
      pipelineRun({ id: 'inngest-NEW', startedAt: 1_700_000_000_000 }),
    ]);

    const json = await (await GET(request(`?correlationId=${ACCEPTED}`))).json();

    expect(json.requestedRun.jobRunId).toBe('inngest-NEW');
  });

  it('populates lastRun from the real job-run record instead of nulls', async () => {
    getRecentJobRuns.mockResolvedValue([pipelineRun()]);

    const json = await (await GET(request())).json();

    expect(getRecentJobRuns).toHaveBeenCalledWith('daily-pipeline', 1);
    expect(json.lastRun).toMatchObject({
      correlationId: ACCEPTED,
      startedAt: 1_700_000_000_000,
      completedAt: 1_700_000_060_000,
      duration: 60_000,
      success: true,
      signalsProcessed: 4,
    });
  });

  it('keeps lastRun explicitly unknown when no run exists', async () => {
    const json = await (await GET(request())).json();

    expect(json.lastRun).toMatchObject({ startedAt: null, completedAt: null, success: null });
  });

  it('never reads a success from a run that declared no outcome', async () => {
    // OBS-001: transport completion is not a business result. A run whose output
    // carries no domain flag must render as "not declared", never as success.
    getRecentJobRuns.mockResolvedValue([pipelineRun({ output: { summary: {} } })]);

    const json = await (await GET(request())).json();

    expect(json.lastRun.success).toBeNull();
    expect(json.lastRun.status).toBe('completed');
  });

  it('keeps transport status and declared domain outcome separate', async () => {
    getRecentJobRuns.mockResolvedValue([
      pipelineRun({ status: 'completed', domainOutcome: 'failed', output: { success: false, summary: {} } }),
    ]);

    const json = await (await GET(request())).json();

    expect(json.lastRun.status).toBe('completed');
    expect(json.lastRun.domainOutcome).toBe('failed');
    expect(json.lastRun.success).toBe(false);
  });

  it('mints and echoes an identity for a plain status read', async () => {
    const res = await GET(request());

    expect(res.headers.get(CORRELATION_ID_HEADER)).toMatch(/^corr_[0-9a-f-]{36}$/);
  });
});
