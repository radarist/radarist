/**
 * @jest-environment node
 */

/**
 * @file lifecycle.test.ts
 * @description BUILD-026 — Start / Stop / Cancel must never report success on a
 * driver self-report. These tests pin the verify-after contract: Start confirms
 * the container is running AND the preview is reachable; Stop confirms the
 * container is actually down; Cancel confirms the container stopped before it
 * fires the run-abort and flips the mission to failed — and every failure path
 * leaves the operation retryable (no torn state, no false success).
 */

import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Auth — authenticated by default.
// ---------------------------------------------------------------------------
const mockGetAuthenticatedUser = jest
  .fn()
  .mockResolvedValue({ authenticated: true, uid: 'test-user-123' });
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockGetAuthenticatedUser(...a),
}));
jest.mock('@/lib/system-principals', () => ({ isSystemPrincipal: jest.fn().mockReturnValue(false) }));

// ---------------------------------------------------------------------------
// Missions service.
// ---------------------------------------------------------------------------
const mockGetMissionById = jest.fn();
const mockUpdateMission = jest.fn().mockResolvedValue(undefined);
const mockReconcileBuildMissionCostAccounting = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/missions', () => ({
  getMissionById: (...a: unknown[]) => mockGetMissionById(...a),
  updateMission: (...a: unknown[]) => mockUpdateMission(...a),
  reconcileBuildMissionCostAccounting: (...a: unknown[]) =>
    mockReconcileBuildMissionCostAccounting(...a),
}));

// ---------------------------------------------------------------------------
// Sandbox driver — the object every verify-after call goes through.
// ---------------------------------------------------------------------------
const mockDriver = {
  resume: jest.fn().mockResolvedValue(undefined),
  exec: jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
  execDetached: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  isRunning: jest.fn().mockResolvedValue(true),
};
const mockBuildConfig = { driver: 'docker', containerPort: 3000 };
const mockRecreateSandboxRuntime = jest.fn();
const mockBuildSanitizedShellCommand = jest.fn();
const mockDefaultExec = jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
const mockResetWorkspaceGitControlPlane = jest.fn().mockResolvedValue(undefined);
const mockReadWorkspaceGitHead = jest.fn().mockResolvedValue('a'.repeat(40));
const mockListWorkspaceChangesSince = jest.fn().mockResolvedValue(['src/app.ts']);
const mockCaptureReviewerWorkspaceSnapshot = jest.fn().mockResolvedValue({
  version: 1,
  algorithm: 'sha256',
  digest: 'b'.repeat(64),
  entries: 10,
  bytes: 1000,
});
jest.mock('@/lib/agent-import', () => ({
  importSandbox: jest.fn().mockResolvedValue({
    loadBuildConfig: () => mockBuildConfig,
    getDriver: () => mockDriver,
    recreateSandboxRuntime: (...a: unknown[]) => mockRecreateSandboxRuntime(...a),
    buildSanitizedShellCommand: (...a: unknown[]) => mockBuildSanitizedShellCommand(...a),
    platformServersFor: () => [],
    resolveContainerSecretValues: () => ['authorized-secret'],
    defaultExec: (...a: unknown[]) => mockDefaultExec(...a),
    resetWorkspaceGitControlPlane: (...a: unknown[]) => mockResetWorkspaceGitControlPlane(...a),
    readWorkspaceGitHead: (...a: unknown[]) => mockReadWorkspaceGitHead(...a),
    listWorkspaceChangesSince: (...a: unknown[]) => mockListWorkspaceChangesSince(...a),
    captureReviewerWorkspaceSnapshot: (...a: unknown[]) => mockCaptureReviewerWorkspaceSnapshot(...a),
  }),
}));

// ---------------------------------------------------------------------------
// Preview-readiness probe (Start) + Inngest (Cancel).
// ---------------------------------------------------------------------------
const mockWaitForPreviewReady = jest.fn().mockResolvedValue(true);
jest.mock('@/lib/build-preview-readiness', () => ({
  waitForPreviewReady: (...a: unknown[]) => mockWaitForPreviewReady(...a),
}));
const mockInngestSend = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => mockInngestSend(...a) } }));

const mockLogDebug = jest.fn();
const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: (...a: unknown[]) => mockLogDebug(...a),
    info: (...a: unknown[]) => mockLogInfo(...a),
    warn: (...a: unknown[]) => mockLogWarn(...a),
    error: (...a: unknown[]) => mockLogError(...a),
  }),
}));

import { POST as START } from '../start/route';
import { POST as STOP } from '../stop/route';
import { POST as CANCEL } from '../cancel/route';

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------
function req(): NextRequest {
  return new NextRequest(new URL('http://localhost:3000/api/missions/m1/x'), {
    method: 'POST',
    headers: { Authorization: 'Bearer t' },
  });
}
const params = { params: Promise.resolve({ id: 'm1' }) };

function buildMission(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    userId: 'test-user-123',
    kind: 'build',
    status: 'completed',
    artifactKind: 'solution',
    sandbox: {
      driver: 'docker',
      containerName: 'radarist-build-m1',
      volumeName: 'radarist_build_m1',
      image: 'node:20',
      hostPort: 5199,
      workspacePath: '/workspace',
      state: 'stopped',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

const acceptedReview = {
  gitHead: 'a'.repeat(40),
  residualChanges: ['src/app.ts'],
  workspaceSnapshot: {
    version: 1 as const,
    algorithm: 'sha256' as const,
    digest: 'b'.repeat(64),
    entries: 10,
    bytes: 1000,
  },
  sessionIndex: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAuthenticatedUser.mockResolvedValue({ authenticated: true, uid: 'test-user-123' });
  mockUpdateMission.mockResolvedValue(undefined);
  mockReconcileBuildMissionCostAccounting.mockResolvedValue(undefined);
  mockInngestSend.mockResolvedValue(undefined);
  mockWaitForPreviewReady.mockResolvedValue(true);
  mockDriver.resume.mockResolvedValue(undefined);
  mockDriver.exec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  mockDriver.execDetached.mockResolvedValue(undefined);
  mockDriver.stop.mockResolvedValue(undefined);
  mockDriver.destroy.mockResolvedValue(undefined);
  mockDriver.isRunning.mockResolvedValue(true);
  mockRecreateSandboxRuntime.mockImplementation(async ({ ref }: { ref: Record<string, unknown> }) => ({
    ref: { ...ref, image: 'impulse-sandbox:current' },
    warnings: [],
  }));
  mockBuildSanitizedShellCommand.mockImplementation((command: string) => `SANITIZED:${command}`);
  mockDefaultExec.mockResolvedValue({ code: 0, stdout: '', stderr: '' });
  mockResetWorkspaceGitControlPlane.mockResolvedValue(undefined);
  mockReadWorkspaceGitHead.mockResolvedValue('a'.repeat(40));
  mockListWorkspaceChangesSince.mockResolvedValue(['src/app.ts']);
  mockCaptureReviewerWorkspaceSnapshot.mockResolvedValue(acceptedReview.workspaceSnapshot);
});

// ===========================================================================
// START
// ===========================================================================
describe('POST /api/missions/[id]/start (BUILD-026 verify-after)', () => {
  it('reports success only after the container is running AND the preview is reachable', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValue(true);
    mockWaitForPreviewReady.mockResolvedValue(true);

    const res = await START(req(), params);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, previewUrl: 'http://localhost:5199' });
    expect(mockDriver.resume).not.toHaveBeenCalled();
    expect(mockRecreateSandboxRuntime).toHaveBeenCalledWith({
      cfg: mockBuildConfig,
      missionId: 'm1',
      driver: mockDriver,
      ref: {
        driver: 'docker',
        missionId: 'm1',
        containerName: 'radarist-build-m1',
        volumeName: 'radarist_build_m1',
        image: 'node:20',
        hostPort: 5199,
        workspacePath: '/workspace',
      },
      hostPort: 5199,
      artifactKind: 'solution',
      purpose: 'preview',
    });
    const recreatedRef = expect.objectContaining({ image: 'impulse-sandbox:current', hostPort: 5199 });
    expect(mockDriver.isRunning).toHaveBeenCalledWith(recreatedRef);
    expect(mockBuildSanitizedShellCommand).toHaveBeenCalledWith(
      'cd /tmp/radarist-reviewed-preview && exec /usr/local/bin/npm --ignore-scripts run dev >/tmp/preview.log 2>&1'
    );
    expect(mockDriver.execDetached).toHaveBeenCalledWith(
      recreatedRef,
      [
        '/bin/sh',
        '-c',
        'SANITIZED:cd /tmp/radarist-reviewed-preview && exec /usr/local/bin/npm --ignore-scripts run dev >/tmp/preview.log 2>&1',
      ],
      { user: 'preview' }
    );
    expect(mockWaitForPreviewReady).toHaveBeenCalledWith('http://localhost:5199');
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({
        sandbox: expect.objectContaining({
          state: 'running',
          image: 'impulse-sandbox:current',
          hostPort: 5199,
        }),
      })
    );
    expect(mockDriver.destroy).not.toHaveBeenCalled();
  });

  it('restarts a Limitless solution only when the retained workspace matches its accepted review', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ buildMode: 'limitless', artifact: { acceptedReview, publishedAt: '2026-01-01T00:00:00Z' } })
    );

    const res = await START(req(), params);

    expect(res.status).toBe(200);
    expect(mockResetWorkspaceGitControlPlane).toHaveBeenCalledTimes(2);
    expect(mockReadWorkspaceGitHead).toHaveBeenCalledTimes(2);
    expect(mockListWorkspaceChangesSince).toHaveBeenCalledTimes(2);
    expect(mockCaptureReviewerWorkspaceSnapshot).toHaveBeenCalledTimes(2);
    expect(mockDriver.destroy).not.toHaveBeenCalled();
  });

  it('accepts semantically identical review evidence regardless of object key order', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ buildMode: 'limitless', artifact: { acceptedReview, publishedAt: '2026-01-01T00:00:00Z' } })
    );
    mockCaptureReviewerWorkspaceSnapshot.mockResolvedValue({
      bytes: 1000,
      entries: 10,
      digest: 'b'.repeat(64),
      algorithm: 'sha256',
      version: 1,
    });

    const res = await START(req(), params);

    expect(res.status).toBe(200);
    expect(mockDriver.destroy).not.toHaveBeenCalled();
  });

  it('rejects a Limitless solution with no durable accepted-review evidence before recreation', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ buildMode: 'limitless' }));

    const res = await START(req(), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'artifact-integrity-evidence-missing' });
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
  });

  it('cleans up when the retained Limitless workspace differs from the accepted generation', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ buildMode: 'limitless', artifact: { acceptedReview, publishedAt: '2026-01-01T00:00:00Z' } })
    );
    mockCaptureReviewerWorkspaceSnapshot.mockResolvedValue({
      ...acceptedReview.workspaceSnapshot,
      digest: 'c'.repeat(64),
    });
    mockDriver.isRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await START(req(), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'artifact-integrity-mismatch' });
    expect(mockDriver.execDetached).not.toHaveBeenCalled();
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
  });

  it('fails closed if a Limitless startup hook changes the accepted workspace after readiness', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ buildMode: 'limitless', artifact: { acceptedReview, publishedAt: '2026-01-01T00:00:00Z' } })
    );
    mockCaptureReviewerWorkspaceSnapshot
      .mockResolvedValueOnce(acceptedReview.workspaceSnapshot)
      .mockResolvedValueOnce({ ...acceptedReview.workspaceSnapshot, digest: 'd'.repeat(64) });
    mockDriver.isRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const res = await START(req(), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'artifact-integrity-mismatch' });
    expect(mockWaitForPreviewReady).toHaveBeenCalled();
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
  });

  it('cleans up a failed dev-server relaunch and persists the replacement runtime as stopped', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockDriver.execDetached.mockRejectedValue(new Error('exec --detach failed'));

    const res = await START(req(), params);

    expect(res.status).toBe(500);
    expect(mockDriver.destroy).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'impulse-sandbox:current', volumeName: 'radarist_build_m1' }),
      { removeVolume: false }
    );
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
    expect(mockWaitForPreviewReady).not.toHaveBeenCalled();
  });

  it('leaves the stopped mission retryable when runtime recreation fails', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockRecreateSandboxRuntime.mockRejectedValue(new Error('runtime create failed'));

    const res = await START(req(), params);

    expect(res.status).toBe(500);
    expect(mockDriver.isRunning).not.toHaveBeenCalled();
    expect(mockDriver.execDetached).not.toHaveBeenCalled();
    expect(mockDriver.destroy).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it('returns 502 (not success) when the container cannot be verified running', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValue(false);

    const res = await START(req(), params);
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.code).toBe('start-unverified');
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
    expect(mockDriver.execDetached).not.toHaveBeenCalled();
    expect(mockWaitForPreviewReady).not.toHaveBeenCalled();
  });

  it('returns 503 (not success) when the preview never becomes reachable', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockWaitForPreviewReady.mockResolvedValue(false);

    const res = await START(req(), params);
    const json = await res.json();

    expect(res.status).toBe(503);
    expect(json.code).toBe('preview-unreachable');
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
  });

  it('cleans up when runtime verification throws after recreation', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockRejectedValueOnce(new Error('docker inspect failed')).mockResolvedValueOnce(false);

    const res = await START(req(), params);

    expect(res.status).toBe(500);
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
  });

  it('cleans up when the readiness probe throws after launch', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockWaitForPreviewReady.mockRejectedValue(new Error('probe failed'));

    const res = await START(req(), params);

    expect(res.status).toBe(500);
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
  });

  it('cleans up when persisting the running state fails', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mockUpdateMission.mockRejectedValueOnce(new Error('firestore down')).mockResolvedValueOnce(undefined);

    const res = await START(req(), params);

    expect(res.status).toBe(500);
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).toHaveBeenNthCalledWith(
      2,
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
  });

  it('fails closed and logs when cleanup cannot verify the replacement runtime is down', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDriver.isRunning.mockResolvedValue(true);
    mockDriver.execDetached.mockRejectedValue(new Error('exec --detach failed'));

    const res = await START(req(), params);
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.code).toBe('start-cleanup-failed');
    expect(mockDriver.destroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: false });
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalledWith(
      'Failed to clean up replacement runtime after unsuccessful artifact start',
      expect.objectContaining({ message: expect.stringContaining('still running after cleanup') }),
      expect.objectContaining({ missionId: 'm1', startError: 'exec --detach failed' })
    );
  });

  it('refuses to recreate a legacy sandbox without a persisted host port', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ sandbox: { ...buildMission().sandbox, hostPort: undefined } })
    );

    const res = await START(req(), params);
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('sandbox-runtime-incomplete');
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it.each([
    ['active mission', { status: 'running' }],
    ['non-solution artifact', { artifactKind: 'report' }],
    ['already-running sandbox', { sandbox: { ...buildMission().sandbox, state: 'running' } }],
  ])('rejects an %s before destructive recreation', async (_label, overrides) => {
    mockGetMissionById.mockResolvedValue(buildMission(overrides));
    const res = await START(req(), params);
    expect(res.status).toBe(409);
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
  });

  it('marks a sandbox destroyed only when Docker explicitly proves its persisted volume is missing', async () => {
    const retainedMission = buildMission({
      artifact: {
        prototypeId: 'prototype-1',
        previewUrl: 'http://localhost:5199',
        publishedAt: '2026-01-01T01:00:00.000Z',
      },
    });
    mockGetMissionById.mockResolvedValue(retainedMission);
    mockDefaultExec.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'Error response from daemon: get radarist_build_m1: no such volume',
    });

    const res = await START(req(), params);

    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'sandbox-volume-missing' });
    expect(mockUpdateMission).toHaveBeenCalledWith('m1', {
      sandbox: { ...retainedMission.sandbox, state: 'destroyed' },
    });
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
  });

  it('leaves a stopped sandbox retryable when Docker cannot conclusively inspect its volume', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDefaultExec.mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    });

    const res = await START(req(), params);

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'sandbox-volume-probe-failed' });
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
  });

  it('does not report a terminal 410 when persisting the proven missing-volume state fails', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    mockDefaultExec.mockResolvedValue({ code: 1, stdout: '', stderr: 'Error: No such volume: radarist_build_m1' });
    mockUpdateMission.mockRejectedValue(new Error('firestore unavailable'));

    const res = await START(req(), params);

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: 'Failed to start the artifact sandbox' });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'destroyed' }) })
    );
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
  });

  it('does not probe or change another human user\'s sandbox', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ userId: 'another-human-user' }));

    const res = await START(req(), params);

    expect(res.status).toBe(403);
    expect(mockDefaultExec).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockRecreateSandboxRuntime).not.toHaveBeenCalled();
  });

  it('does not read, probe, or change a sandbox for an unauthenticated request', async () => {
    mockGetAuthenticatedUser.mockResolvedValue({ authenticated: false, error: 'Unauthorized' });

    const res = await START(req(), params);

    expect(res.status).toBe(401);
    expect(mockGetMissionById).not.toHaveBeenCalled();
    expect(mockDefaultExec).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it('serializes concurrent starts for the same mission', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    let release!: (value: unknown) => void;
    mockRecreateSandboxRuntime.mockImplementation(
      ({ ref }: { ref: Record<string, unknown> }) =>
        new Promise((resolve) => {
          release = resolve;
        }).then(() => ({ ref, warnings: [] }))
    );

    const first = START(req(), params);
    while (!release) await Promise.resolve();
    const second = await START(req(), params);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'start-in-progress' });
    release(undefined);
    await expect(first).resolves.toMatchObject({ status: 200 });
    expect(mockRecreateSandboxRuntime).toHaveBeenCalledTimes(1);
  });

  it('serializes start against a concurrent stop for the same runtime', async () => {
    mockGetMissionById.mockResolvedValue(buildMission());
    let release!: (value: unknown) => void;
    mockRecreateSandboxRuntime.mockImplementation(
      ({ ref }: { ref: Record<string, unknown> }) =>
        new Promise((resolve) => {
          release = resolve;
        }).then(() => ({ ref, warnings: [] }))
    );

    const starting = START(req(), params);
    while (!release) await Promise.resolve();
    const stopping = await STOP(req(), params);

    expect(stopping.status).toBe(409);
    expect(await stopping.json()).toMatchObject({ code: 'sandbox-operation-in-progress' });
    expect(mockDriver.stop).not.toHaveBeenCalled();
    release(undefined);
    await expect(starting).resolves.toMatchObject({ status: 200 });
  });
});

// ===========================================================================
// STOP
// ===========================================================================
describe('POST /api/missions/[id]/stop (BUILD-026 verify-after)', () => {
  it('reports success only after the container is confirmed down', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ sandbox: { ...buildMission().sandbox, state: 'running' } })
    );
    mockDriver.isRunning.mockResolvedValue(false);

    const res = await STOP(req(), params);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(mockUpdateMission).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ sandbox: expect.objectContaining({ state: 'stopped' }) })
    );
  });

  it('returns 502 (not success) when the container is still running after stop', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ sandbox: { ...buildMission().sandbox, state: 'running' } })
    );
    mockDriver.isRunning.mockResolvedValue(true);

    const res = await STOP(req(), params);
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.code).toBe('stop-unverified');
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it('returns 500 (not success) when the state write fails', async () => {
    mockGetMissionById.mockResolvedValue(
      buildMission({ sandbox: { ...buildMission().sandbox, state: 'running' } })
    );
    mockDriver.isRunning.mockResolvedValue(false);
    mockUpdateMission.mockRejectedValue(new Error('firestore down'));

    const res = await STOP(req(), params);
    expect(res.status).toBe(500);
  });

  it.each([
    ['active mission', { status: 'running' }, 'artifact-not-stoppable'],
    ['non-solution artifact', { artifactKind: 'report' }, 'artifact-not-stoppable'],
    ['already-stopped sandbox', {}, 'sandbox-not-running'],
  ])('rejects an %s without stopping its runtime', async (_label, overrides, code) => {
    mockGetMissionById.mockResolvedValue(buildMission(overrides));

    const res = await STOP(req(), params);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code });
    expect(mockDriver.stop).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// CANCEL
// ===========================================================================
describe('POST /api/missions/[id]/cancel (BUILD-026 verify-after)', () => {
  it('fires the run-abort and marks failed only after the container is confirmed down — in that order', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ status: 'running' }));
    mockDriver.isRunning.mockResolvedValue(false);

    const res = await CANCEL(req(), params);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'app/build-mission.cancel.requested' })
    );
    expect(mockUpdateMission).toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'failed' }));
    expect(mockReconcileBuildMissionCostAccounting).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ state: 'terminal' })
    );
    // The abort event must precede the terminal-status write (retryability).
    expect(mockInngestSend.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateMission.mock.invocationCallOrder[0]);
    expect(mockUpdateMission.mock.invocationCallOrder[0]).toBeLessThan(
      mockReconcileBuildMissionCostAccounting.mock.invocationCallOrder[0]
    );
  });

  it('returns 502 and leaves the mission untouched when the container will not stop', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ status: 'running' }));
    mockDriver.isRunning.mockResolvedValue(true);

    const res = await CANCEL(req(), params);
    const json = await res.json();

    expect(res.status).toBe(502);
    expect(json.code).toBe('cancel-stop-failed');
    // No abort fired, no status flip → the operation is fully retryable.
    expect(mockInngestSend).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(mockReconcileBuildMissionCostAccounting).not.toHaveBeenCalled();
  });

  it('does NOT mark the mission failed when the abort event fails to send (stays retryable)', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ status: 'running' }));
    mockDriver.isRunning.mockResolvedValue(false);
    mockInngestSend.mockRejectedValue(new Error('inngest unavailable'));

    const res = await CANCEL(req(), params);

    expect(res.status).toBe(500);
    // The mission must still be 'running' so the terminal-status guard lets a retry through.
    expect(mockUpdateMission).not.toHaveBeenCalled();
  });

  it('cancels a mission that never provisioned a sandbox (skips the stop, still aborts + fails)', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ status: 'running', sandbox: undefined }));

    const res = await CANCEL(req(), params);

    expect(res.status).toBe(200);
    expect(mockDriver.stop).not.toHaveBeenCalled();
    expect(mockInngestSend).toHaveBeenCalled();
    expect(mockUpdateMission).toHaveBeenCalledWith('m1', expect.objectContaining({ status: 'failed' }));
  });

  it('rejects cancelling an already-terminal mission (409, retry guard)', async () => {
    mockGetMissionById.mockResolvedValue(buildMission({ status: 'completed' }));

    const res = await CANCEL(req(), params);
    expect(res.status).toBe(409);
    expect(mockDriver.stop).not.toHaveBeenCalled();
  });
});
