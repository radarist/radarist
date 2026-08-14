/**
 * @jest-environment node
 */

/**
 * @file Tests for the build-mission branch of POST /api/missions and the
 * gate-resolution route POST /api/missions/[id]/gates.
 */

import { NextRequest } from 'next/server';

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({ authenticated: true, uid: 'user-a' }),
}));

jest.mock('@/lib/mission-research-gate', () => ({
  dispatchMissionWithGate: jest.fn(),
}));

jest.mock('@/lib/ai/mission-intent-classifier', () => ({
  classifyMissionIntent: jest.fn(),
}));

const mockCreateMission = jest.fn();
const mockUpdateMission = jest.fn().mockResolvedValue(undefined);
const mockGetMissionById = jest.fn();
const mockAppendBuildGate = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/missions', () => ({
  listMissions: jest.fn(),
  createMission: (...args: unknown[]) => mockCreateMission(...args),
  updateMission: (...args: unknown[]) => mockUpdateMission(...args),
  getMissionById: (...args: unknown[]) => mockGetMissionById(...args),
  appendBuildGate: (...args: unknown[]) => mockAppendBuildGate(...args),
}));

const mockSend = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockSend(...args) },
}));

const mockComposeEval = jest.fn();
jest.mock('@/lib/build-mission-eval-brief', () => ({
  composeEvaluationBrief: (...args: unknown[]) => mockComposeEval(...args),
}));

const mockResolveBuildContextForUser = jest.fn();
const mockHasUnauthorizedBuildContextRefs = jest.fn((manifest: { omitted?: Array<{ reason?: string }> }) =>
  manifest.omitted?.some((entry) => entry.reason === 'unauthorized')
);
jest.mock('@/lib/build-mission-context', () => ({
  resolveBuildContextForUser: (...args: unknown[]) => mockResolveBuildContextForUser(...args),
  hasUnauthorizedBuildContextRefs: (manifest: { omitted?: Array<{ reason?: string }> }) =>
    mockHasUnauthorizedBuildContextRefs(manifest),
}));

const { POST: missionsPost } = require('../route');
const { POST: gatesPost } = require('../[id]/gates/route');
const { POST: iteratePost } = require('../[id]/iterate/route');
const { POST: startPost } = require('../[id]/start/route');

function postRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const buildMission = {
  id: 'm1',
  userId: 'user-a',
  kind: 'build',
  prompt: '# Mission: X',
  agent: 'builder',
  status: 'running',
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.IMPULSE_BUILD_ENABLED;
  mockCreateMission.mockResolvedValue({ ...buildMission, status: 'pending' });
  mockGetMissionById.mockResolvedValue({ ...buildMission });
  mockResolveBuildContextForUser.mockResolvedValue({
    version: 1,
    items: [],
    omitted: [],
    totalBytes: 181,
    counts: { requested: 0, resolved: 0, omitted: 0 },
    digest: 'a'.repeat(64),
  });
});

describe('POST /api/missions kind=build', () => {
  it('returns 403 when IMPULSE_BUILD_ENABLED is off', async () => {
    const res = await missionsPost(postRequest('http://localhost/api/missions', { prompt: 'p', kind: 'build' }));
    expect(res.status).toBe(403);
    expect(mockCreateMission).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('creates, applies the budget override, and dispatches the build event when enabled', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    const res = await missionsPost(
      postRequest('http://localhost/api/missions', { prompt: '# Mission: X', kind: 'build', budgetUsd: 30 })
    );
    expect(res.status).toBe(201);
    expect(mockCreateMission).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({ kind: 'build', budgetUsd: 30 }),
      { slots: [] }
    );
    expect(mockUpdateMission).toHaveBeenCalledWith('m1', {
      budget: { capUsd: 30, warnThreshold: 0.8, topUps: [] },
    });
    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/build-mission.run.requested',
      data: { missionId: 'm1', userId: 'user-a' },
    });
    // The research classifier/gate must NOT run for build missions.
    const { classifyMissionIntent } = require('@/lib/ai/mission-intent-classifier');
    expect(classifyMissionIntent).not.toHaveBeenCalled();
  });

  it('resolves valid context before creating, persists it, then dispatches', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    const manifest = {
      version: 1,
      items: [],
      omitted: [{ kind: 'report', refId: 'missing', reason: 'not-found' }],
      totalBytes: 250,
      counts: { requested: 1, resolved: 0, omitted: 1 },
      digest: 'b'.repeat(64),
    };
    mockResolveBuildContextForUser.mockResolvedValueOnce(manifest);

    const res = await missionsPost(
      postRequest('http://localhost/api/missions', {
        prompt: '# Mission: X',
        kind: 'build',
        context: [{ kind: 'report', id: 'missing' }],
      })
    );

    expect(res.status).toBe(201);
    expect(mockResolveBuildContextForUser).toHaveBeenCalledWith('user-a', [{ kind: 'report', id: 'missing' }]);
    expect(mockResolveBuildContextForUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateMission.mock.invocationCallOrder[0]
    );
    expect(mockUpdateMission).toHaveBeenCalledWith('m1', { contextManifest: manifest });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed context with zero mutation or dispatch', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    const res = await missionsPost(
      postRequest('http://localhost/api/missions', {
        prompt: '# Mission: X',
        kind: 'build',
        context: [{ kind: 'document', id: '../foreign' }],
      })
    );

    expect(res.status).toBe(400);
    expect(mockResolveBuildContextForUser).not.toHaveBeenCalled();
    expect(mockCreateMission).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('makes foreign context indistinguishable from a miss and leaves zero writes', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    mockResolveBuildContextForUser.mockResolvedValueOnce({
      version: 1,
      items: [],
      omitted: [{ kind: 'report', refId: 'r-foreign', reason: 'unauthorized' }],
      totalBytes: 250,
      counts: { requested: 1, resolved: 0, omitted: 1 },
      digest: 'c'.repeat(64),
    });

    const res = await missionsPost(
      postRequest('http://localhost/api/missions', {
        prompt: '# Mission: X',
        kind: 'build',
        context: [{ kind: 'report', id: 'r-foreign' }],
      })
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Context reference not found' });
    expect(mockCreateMission).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('leaves zero writes when an authoritative context read fails', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    mockResolveBuildContextForUser.mockRejectedValueOnce(new Error('Firestore unavailable'));

    const res = await missionsPost(
      postRequest('http://localhost/api/missions', {
        prompt: '# Mission: X',
        kind: 'build',
        context: [{ kind: 'report', id: 'r1' }],
      })
    );

    expect(res.status).toBe(500);
    expect(mockCreateMission).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('E1: an evaluation composes the brief FROM THE GRAPH and dispatches with motivation', async () => {
    process.env.IMPULSE_BUILD_ENABLED = 'true';
    mockComposeEval.mockResolvedValue({
      brief: '# Mission: Evaluate Neo4j\n... .impulse/verdict.json ...',
      motivation: { sourceTechnologyId: 'tech-neo4j', useCaseIds: ['uc-1'], painPointIds: [], strategyIds: [] },
      title: 'Evaluate Neo4j',
    });
    const res = await missionsPost(
      postRequest('http://localhost/api/missions', {
        prompt: 'evaluate it', // ignored — the graph composes the real brief
        kind: 'build',
        artifactKind: 'evaluation',
        motivation: { sourceTechnologyId: 'tech-neo4j', useCaseIds: ['uc-1'], painPointIds: [], strategyIds: [] },
        budgetUsd: 15,
      })
    );
    expect(res.status).toBe(201);
    expect(mockComposeEval).toHaveBeenCalledWith('tech-neo4j', { useCaseIds: ['uc-1'] });
    // createMission receives the COMPOSED brief + motivation, artifactKind evaluation
    expect(mockCreateMission).toHaveBeenCalledWith(
      'user-a',
      expect.objectContaining({
        prompt: expect.stringContaining('Evaluate Neo4j'),
        artifactKind: 'evaluation',
        motivation: expect.objectContaining({ sourceTechnologyId: 'tech-neo4j' }),
      }),
      { slots: [] }
    );
    expect(mockSend).toHaveBeenCalledWith({
      name: 'app/build-mission.run.requested',
      data: { missionId: 'm1', userId: 'user-a' },
    });
  });
});

describe('POST /api/missions/[id]/gates', () => {
  const params = Promise.resolve({ id: 'm1' });

  it('records the decision and emits gate.resolved', async () => {
    const res = await gatesPost(
      postRequest('http://localhost/api/missions/m1/gates', { gate: 'final', decision: 'approve' }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(mockAppendBuildGate).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ gate: 'final', decision: 'approve' })
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/build-mission.gate.resolved',
        data: expect.objectContaining({ missionId: 'm1', gate: 'final', decision: 'approve', resolvedBy: 'user-a' }),
      })
    );
  });

  it('requires topUpUsd when approving a budget gate', async () => {
    const res = await gatesPost(
      postRequest('http://localhost/api/missions/m1/gates', { gate: 'budget', decision: 'approve' }),
      { params }
    );
    expect(res.status).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('rejects foreign missions and non-build missions', async () => {
    mockGetMissionById.mockResolvedValueOnce({ ...buildMission, userId: 'someone-else' });
    const forbidden = await gatesPost(
      postRequest('http://localhost/api/missions/m1/gates', { gate: 'final', decision: 'deny' }),
      { params }
    );
    expect(forbidden.status).toBe(403);

    mockGetMissionById.mockResolvedValueOnce({ ...buildMission, kind: 'research' });
    const wrongKind = await gatesPost(
      postRequest('http://localhost/api/missions/m1/gates', { gate: 'final', decision: 'deny' }),
      { params }
    );
    expect(wrongKind.status).toBe(400);
  });

  it('rejects invalid gate payloads', async () => {
    const res = await gatesPost(
      postRequest('http://localhost/api/missions/m1/gates', { gate: 'vibes', decision: 'approve' }),
      { params }
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/missions/[id]/iterate', () => {
  const params = Promise.resolve({ id: 'm1' });
  const completedMission = {
    ...buildMission,
    status: 'completed',
    prompt: '# Mission: X\n\nbody',
    sandbox: {
      driver: 'docker',
      containerName: 'c',
      volumeName: 'v',
      image: 'i',
      workspacePath: '/workspace',
      state: 'stopped',
      createdAt: 'x',
    },
    budget: { capUsd: 13, warnThreshold: 0.8, topUps: [] },
  };

  it('appends an Iteration section, resets QA, raises the cap, dispatches with instructions', async () => {
    mockGetMissionById.mockResolvedValueOnce(completedMission);
    const res = await iteratePost(
      postRequest('http://localhost/api/missions/m1/iterate', { instructions: 'add CSV export' }),
      { params }
    );
    expect(res.status).toBe(200);
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        status: 'pending',
        prompt: expect.stringContaining('## Iteration 1'),
        qaGate: { attempts: 0, findings: [] },
        budget: expect.objectContaining({ capUsd: 23 }), // 13 + default 10
      })
    );
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'app/build-mission.run.requested',
        data: expect.objectContaining({ missionId: 'm1', instructions: 'add CSV export' }),
      })
    );
  });

  it('refuses while the mission is still running and without a sandbox', async () => {
    mockGetMissionById.mockResolvedValueOnce({ ...completedMission, status: 'running' });
    const running = await iteratePost(
      postRequest('http://localhost/api/missions/m1/iterate', { instructions: 'x'.repeat(10) }),
      { params }
    );
    expect(running.status).toBe(409);

    mockGetMissionById.mockResolvedValueOnce({ ...completedMission, sandbox: undefined });
    const noSandbox = await iteratePost(
      postRequest('http://localhost/api/missions/m1/iterate', { instructions: 'x'.repeat(10) }),
      { params }
    );
    expect(noSandbox.status).toBe(409);
  });
});

describe('POST /api/missions/[id]/start (BUILD-007)', () => {
  const params = Promise.resolve({ id: 'm1' });
  const sandbox = {
    driver: 'docker',
    containerName: 'c',
    volumeName: 'v',
    image: 'i',
    hostPort: 4100,
    workspacePath: '/workspace',
    state: 'stopped',
    createdAt: 'x',
  };

  it('returns 410 sandbox-reclaimed for a destroyed (reclaimed) sandbox — never an opaque 500', async () => {
    mockGetMissionById.mockResolvedValueOnce({
      ...buildMission,
      status: 'completed',
      sandbox: { ...sandbox, state: 'destroyed' },
    });
    const res = await startPost(postRequest('http://localhost/api/missions/m1/start', {}), { params });
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'sandbox-reclaimed' });
  });

  it('returns 400 when the mission has no sandbox at all', async () => {
    mockGetMissionById.mockResolvedValueOnce({ ...buildMission, status: 'completed', sandbox: undefined });
    const res = await startPost(postRequest('http://localhost/api/missions/m1/start', {}), { params });
    expect(res.status).toBe(400);
  });
});
