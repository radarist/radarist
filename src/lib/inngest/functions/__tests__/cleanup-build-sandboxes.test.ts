/**
 * @jest-environment node
 */

/**
 * Lifecycle GC safety tests. Reclaim is destructive, so these tests exercise
 * the required ordering: serialize the runtime, stop/verify stuck work,
 * recreate a secretless harvester, persist a verified bundle, then remove the
 * volume. Any unavailable or unverified step must leave the volume retryable.
 */
import * as path from 'node:path';

const mockUpdateMission = jest.fn().mockResolvedValue(undefined);
const mockGetMissionById = jest.fn();
jest.mock('@/lib/missions', () => ({
  __esModule: true,
  getMissionById: (...args: unknown[]) => mockGetMissionById(...args),
  updateMission: (...args: unknown[]) => mockUpdateMission(...args),
}));

const mockReleaseRuntime = jest.fn();
const mockAcquireBuildRuntimeOperation: jest.Mock<(() => void) | null, [string]> = jest.fn(
  (_missionId: string) => mockReleaseRuntime
);
jest.mock('@/lib/build-runtime-operation-lock', () => ({
  __esModule: true,
  acquireBuildRuntimeOperation: (missionId: string) => mockAcquireBuildRuntimeOperation(missionId),
}));

let byStatus: Record<string, Array<Record<string, unknown>>> = {};
const mockDocUpdate = jest.fn().mockResolvedValue(undefined);
const mockDb = {
  collection: jest.fn((_collection: string) => {
    const wheres: Array<{ field: string; val: unknown }> = [];
    const chain: Record<string, unknown> = {
      where: (field: string, _op: string, val: unknown) => {
        wheres.push({ field, val });
        return chain;
      },
      limit: () => chain,
      get: async () => {
        const status = wheres.find((where) => where.field === 'status')?.val as string;
        return { docs: (byStatus[status] ?? []).map((mission) => ({ data: () => mission })) };
      },
      doc: (id: string) => ({ update: (patch: unknown) => mockDocUpdate(_collection, id, patch) }),
    };
    return chain;
  }),
};
jest.mock('@/lib/firebase-admin', () => ({ __esModule: true, db: mockDb }));

const driverIsRunning = jest.fn();
const driverStop = jest.fn();
const driverDestroy = jest.fn();
const recreateSandboxRuntime = jest.fn();
const harvestArtifact = jest.fn();
const readHarvestBundleIntegrity = jest.fn();
const HARVEST_SHA256 = 'a'.repeat(64);
const HARVEST_BYTES = 4096;

const fakeCfg = {
  driver: 'docker',
  workspacePath: '/workspace',
  keepAliveMinutes: 240,
  gcThresholdHours: 96,
  lifecycle: { volumeRetentionDays: 7, evalVolumeRetentionDays: 1, failedVolumeRetentionDays: 2 },
};
const fakeSandbox = {
  loadBuildConfig: jest.fn(() => fakeCfg),
  getDriver: jest.fn(() => ({
    stop: driverStop,
    destroy: driverDestroy,
    isRunning: driverIsRunning,
  })),
  recreateSandboxRuntime,
  harvestArtifact,
  readHarvestBundleIntegrity,
  containerNameFor: (id: string) => `radarist-build-${id}`,
  volumeNameFor: (id: string) => `radarist_build_${id}`,
  fullImageName: () => 'img:v1',
};
jest.mock('@/lib/agent-import', () => ({
  __esModule: true,
  importSandbox: jest.fn(async () => fakeSandbox),
}));

jest.mock('../../client', () => ({
  __esModule: true,
  inngest: {
    createFunction: jest.fn((config, trigger, handler) => ({
      config,
      trigger,
      handler,
      execute: () =>
        handler({
          step: { run: async (_name: string, fn: () => unknown) => fn() },
        }),
    })),
    send: jest.fn(),
  },
}));

import { cleanupBuildSandboxes } from '../cleanup-build-sandboxes';

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const sandboxOf = (id: string) => ({
  driver: 'docker',
  image: 'img:v1',
  containerName: `radarist-build-${id}`,
  volumeName: `radarist_build_${id}`,
  hostPort: 4100,
  workspacePath: '/workspace',
  state: 'stopped',
  createdAt: daysAgo(10),
});
const oldMission = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: 'build',
  status: 'completed',
  artifactKind: 'solution',
  createdAt: daysAgo(10),
  completedAt: daysAgo(10),
  sandbox: sandboxOf(id),
  ...overrides,
});

describe('cleanupBuildSandboxes lifecycle safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    byStatus = {};
    fakeCfg.keepAliveMinutes = 240;
    mockUpdateMission.mockResolvedValue(undefined);
    mockGetMissionById.mockImplementation(async (id: string) =>
      Object.values(byStatus)
        .flat()
        .find((mission) => mission.id === id) ?? null
    );
    mockDocUpdate.mockResolvedValue(undefined);
    mockAcquireBuildRuntimeOperation.mockImplementation(() => mockReleaseRuntime);
    driverIsRunning.mockResolvedValue(false);
    driverStop.mockResolvedValue(undefined);
    driverDestroy.mockResolvedValue(undefined);
    recreateSandboxRuntime.mockImplementation(async (options: { ref: Record<string, unknown> }) => ({
      ref: { ...options.ref, image: 'img:secretless' },
      warnings: [],
    }));
    harvestArtifact.mockImplementation(async (_driver, _ref, dir: string, id: string) => ({
      bundlePath: path.resolve(dir, `${id}.tgz`),
      sha256: HARVEST_SHA256,
      bytes: HARVEST_BYTES,
    }));
    readHarvestBundleIntegrity.mockResolvedValue({ sha256: HARVEST_SHA256, bytes: HARVEST_BYTES });
  });

  it('reclaims only missions past their per-kind retention window', async () => {
    byStatus = {
      running: [],
      pending: [],
      completed: [
        oldMission('sol-old'),
        oldMission('sol-young', { completedAt: daysAgo(2) }),
        oldMission('eval-old', { artifactKind: 'evaluation', completedAt: daysAgo(2) }),
        oldMission('done', {
          completedAt: daysAgo(30),
          sandbox: { ...sandboxOf('done'), state: 'destroyed' },
          harvest: { bundlePath: 'x', harvestedAt: daysAgo(20), reclaimedAt: daysAgo(20) },
        }),
      ],
      failed: [
        oldMission('fail-old', { status: 'failed', completedAt: daysAgo(3) }),
        oldMission('fail-young', { status: 'failed', completedAt: daysAgo(1) }),
      ],
    };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(harvestArtifact.mock.calls.map((call) => call[3]).sort()).toEqual([
      'eval-old',
      'fail-old',
      'sol-old',
    ]);
    expect(recreateSandboxRuntime).toHaveBeenCalledTimes(3);
    for (const [options] of recreateSandboxRuntime.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ purpose: 'preview' }));
    }
    expect(driverDestroy).toHaveBeenCalledTimes(3);
    for (const call of driverDestroy.mock.calls) expect(call[1]).toEqual({ removeVolume: true });

    const reclaimUpdates = mockUpdateMission.mock.calls.filter(
      (call) => (call[1] as any).harvest?.reclaimedAt
    );
    expect(reclaimUpdates).toHaveLength(3);
    const solutionUpdate = reclaimUpdates.find((call) => call[0] === 'sol-old')![1] as any;
    expect(solutionUpdate.harvest.bundlePath).toBe(path.resolve('tmp/build-harvests/sol-old.tgz'));
    expect(solutionUpdate.sandbox.state).toBe('destroyed');
    expect(mockUpdateMission.mock.calls.some((call) => call[0] === 'done')).toBe(false);
    expect(result).toEqual(expect.objectContaining({ reclaimCandidates: 3, harvested: 3, reclaimed: 3 }));
  });

  it('retains the volume and retry authority when harvest is unavailable', async () => {
    harvestArtifact.mockResolvedValueOnce(null);
    byStatus = { running: [], pending: [], completed: [oldMission('sol-old')], failed: [] };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(recreateSandboxRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: 'sol-old', purpose: 'preview' })
    );
    expect(harvestArtifact.mock.calls[0][1]).toEqual(expect.objectContaining({ image: 'img:secretless' }));
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).harvest)).toBe(false);
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).sandbox?.state === 'destroyed')).toBe(
      false
    );
    expect(result).toEqual(expect.objectContaining({ harvested: 0, reclaimed: 0 }));
  });

  it('rejects an unverified harvest path and retains the volume', async () => {
    harvestArtifact.mockResolvedValueOnce({ bundlePath: path.resolve('tmp/build-harvests/not-this-mission.tgz') });
    byStatus = { running: [], pending: [], completed: [oldMission('sol-old')], failed: [] };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).harvest)).toBe(false);
    expect(result.reclaimed).toBe(0);
  });

  it('persists the verified bundle before destroy and retries after destroy failure', async () => {
    driverDestroy.mockRejectedValueOnce(new Error('docker volume removal failed'));
    byStatus = { running: [], pending: [], completed: [oldMission('sol-old')], failed: [] };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(driverDestroy).toHaveBeenCalledWith(expect.any(Object), { removeVolume: true });
    const harvestUpdates = mockUpdateMission.mock.calls.filter((call) => (call[1] as any).harvest);
    expect(harvestUpdates).toHaveLength(1);
    expect((harvestUpdates[0][1] as any).harvest).toEqual({
      bundlePath: path.resolve('tmp/build-harvests/sol-old.tgz'),
      harvestedAt: expect.any(String),
      sha256: HARVEST_SHA256,
      bytes: HARVEST_BYTES,
    });
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).sandbox?.state === 'destroyed')).toBe(
      false
    );
    expect(result).toEqual(expect.objectContaining({ harvested: 1, reclaimed: 0 }));
  });

  it('vetoes volume removal when the host bundle changes immediately before destroy', async () => {
    fakeCfg.keepAliveMinutes = 60 * 24 * 365;
    const harvest = {
      bundlePath: path.resolve('tmp/build-harvests/sol-old.tgz'),
      harvestedAt: daysAgo(1),
      sha256: HARVEST_SHA256,
      bytes: HARVEST_BYTES,
    };
    byStatus = {
      running: [],
      pending: [],
      completed: [oldMission('sol-old', { harvest })],
      failed: [],
    };
    readHarvestBundleIntegrity
      .mockResolvedValueOnce({ sha256: HARVEST_SHA256, bytes: HARVEST_BYTES })
      .mockResolvedValueOnce({ sha256: 'b'.repeat(64), bytes: HARVEST_BYTES });

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(recreateSandboxRuntime).not.toHaveBeenCalled();
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).harvest?.reclaimedAt)).toBe(false);
    expect(result).toEqual(expect.objectContaining({ reclaimed: 0 }));
  });

  it('persists replacement integrity before destroy when a prior harvest is corrupt', async () => {
    fakeCfg.keepAliveMinutes = 60 * 24 * 365;
    const priorHarvest = {
      bundlePath: path.resolve('tmp/build-harvests/sol-old.tgz'),
      harvestedAt: daysAgo(1),
      sha256: 'b'.repeat(64),
      bytes: 12,
    };
    byStatus = {
      running: [],
      pending: [],
      completed: [oldMission('sol-old', { harvest: priorHarvest })],
      failed: [],
    };
    readHarvestBundleIntegrity
      .mockResolvedValueOnce({ sha256: 'c'.repeat(64), bytes: 12 })
      .mockResolvedValueOnce({ sha256: HARVEST_SHA256, bytes: HARVEST_BYTES });
    driverDestroy.mockRejectedValueOnce(new Error('volume busy'));

    await (cleanupBuildSandboxes as any).execute();

    expect(recreateSandboxRuntime).toHaveBeenCalledTimes(1);
    const replacementIndex = mockUpdateMission.mock.calls.findIndex(
      (call) => (call[1] as any).harvest && !(call[1] as any).harvest.reclaimedAt
    );
    const replacementUpdate = mockUpdateMission.mock.calls[replacementIndex];
    expect((replacementUpdate?.[1] as any).harvest).toEqual({
      bundlePath: path.resolve('tmp/build-harvests/sol-old.tgz'),
      harvestedAt: expect.any(String),
      sha256: HARVEST_SHA256,
      bytes: HARVEST_BYTES,
    });
    expect(driverDestroy.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockUpdateMission.mock.invocationCallOrder[replacementIndex]
    );
  });

  it('retries prototype demoUrl cleanup before recording reclaimedAt', async () => {
    fakeCfg.keepAliveMinutes = 60 * 24 * 365;
    const mission = oldMission('sol-old', {
      artifact: { prototypeId: 'proto-9', previewUrl: 'http://localhost:4100', publishedAt: daysAgo(10) },
    });
    byStatus = { running: [], pending: [], completed: [mission], failed: [] };
    mockDocUpdate.mockRejectedValueOnce(new Error('firestore unavailable'));

    const first = await (cleanupBuildSandboxes as any).execute();

    // Firestore cleanup is retry-critical and happens before the destructive
    // Docker call. A transient failure must leave the original volume intact.
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).harvest?.reclaimedAt)).toBe(false);
    expect(first).toEqual(expect.objectContaining({ reclaimed: 0 }));

    const persisted = mockUpdateMission.mock.calls.find(
      (call) => (call[1] as any).harvest && !(call[1] as any).harvest.reclaimedAt
    )?.[1] as any;
    byStatus.completed = [oldMission('sol-old', { ...mission, harvest: persisted.harvest })];
    mockDocUpdate.mockResolvedValue(undefined);
    const second = await (cleanupBuildSandboxes as any).execute();

    expect(mockDocUpdate).toHaveBeenCalledTimes(2);
    expect(recreateSandboxRuntime).toHaveBeenCalledTimes(1);
    expect(driverDestroy).toHaveBeenCalledTimes(1);
    expect(driverDestroy.mock.invocationCallOrder[0]).toBeGreaterThan(mockDocUpdate.mock.invocationCallOrder[1]);
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).harvest?.reclaimedAt)).toBe(true);
    expect(second).toEqual(expect.objectContaining({ reclaimed: 1 }));
  });

  it('stops and verifies a stuck runtime before marking the mission terminal', async () => {
    driverIsRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    byStatus = {
      running: [oldMission('stuck', { status: 'running', completedAt: undefined })],
      pending: [],
      completed: [],
      failed: [],
    };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(driverStop).toHaveBeenCalledTimes(1);
    expect(driverIsRunning).toHaveBeenCalledTimes(2);
    const terminal = mockUpdateMission.mock.calls.find((call) => (call[1] as any).status === 'failed');
    expect(terminal).toBeDefined();
    expect((terminal![1] as any).sandbox.state).toBe('stopped');
    expect(result).toEqual(expect.objectContaining({ failed: 1, cleanupPending: 0 }));
  });

  it('does not mark a stuck mission terminal when stop fails', async () => {
    driverIsRunning.mockResolvedValueOnce(true);
    driverStop.mockRejectedValueOnce(new Error('docker stop failed'));
    byStatus = {
      running: [oldMission('stuck', { status: 'running', completedAt: undefined, errors: ['prior'] })],
      pending: [],
      completed: [],
      failed: [],
    };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).status === 'failed')).toBe(false);
    const evidence = mockUpdateMission.mock.calls.find((call) => (call[1] as any).errors)?.[1] as any;
    expect(evidence.errors).toEqual(['prior', expect.stringContaining('docker stop failed')]);
    expect(result).toEqual(expect.objectContaining({ failed: 0, cleanupPending: 1 }));
  });

  it('does not mark a stuck mission terminal when it is still running after stop', async () => {
    driverIsRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    byStatus = {
      running: [oldMission('stuck', { status: 'running', completedAt: undefined })],
      pending: [],
      completed: [],
      failed: [],
    };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(driverStop).toHaveBeenCalledTimes(1);
    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).status === 'failed')).toBe(false);
    expect(result).toEqual(expect.objectContaining({ failed: 0, cleanupPending: 1 }));
  });

  it('derives and stops the canonical runtime before failing a stuck mission with no sandbox record', async () => {
    driverIsRunning.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    byStatus = {
      running: [oldMission('orphan', { status: 'running', completedAt: undefined, sandbox: undefined })],
      pending: [],
      completed: [],
      failed: [],
    };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(driverStop).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'orphan',
        containerName: 'radarist-build-orphan',
        volumeName: 'radarist_build_orphan',
      })
    );
    const terminal = mockUpdateMission.mock.calls.find((call) => (call[1] as any).status === 'failed');
    expect(terminal).toBeDefined();
    expect((terminal![1] as any).sandbox).toBeUndefined();
    expect(result).toEqual(expect.objectContaining({ failed: 1, cleanupPending: 0 }));
  });

  it('keeps an orphan-runtime mission nonterminal when canonical cleanup fails', async () => {
    driverIsRunning.mockResolvedValueOnce(true);
    driverStop.mockRejectedValueOnce(new Error('canonical stop failed'));
    byStatus = {
      running: [oldMission('orphan', { status: 'running', completedAt: undefined, sandbox: undefined })],
      pending: [],
      completed: [],
      failed: [],
    };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(mockUpdateMission.mock.calls.some((call) => (call[1] as any).status === 'failed')).toBe(false);
    expect(result).toEqual(expect.objectContaining({ failed: 0, cleanupPending: 1 }));
  });

  it('does not act on a reclaim candidate whose lifecycle changed before lock ownership', async () => {
    fakeCfg.keepAliveMinutes = 60 * 24 * 365;
    const candidate = oldMission('changed');
    byStatus = { running: [], pending: [], completed: [candidate], failed: [] };
    mockGetMissionById.mockResolvedValueOnce({ ...candidate, status: 'pending' });

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(recreateSandboxRuntime).not.toHaveBeenCalled();
    expect(harvestArtifact).not.toHaveBeenCalled();
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ reclaimCandidates: 1, reclaimed: 0 }));
  });

  it('does not act on a reclaim candidate whose sandbox identity drifted before lock ownership', async () => {
    fakeCfg.keepAliveMinutes = 60 * 24 * 365;
    const candidate = oldMission('changed');
    byStatus = { running: [], pending: [], completed: [candidate], failed: [] };
    mockGetMissionById.mockResolvedValueOnce({
      ...candidate,
      sandbox: { ...sandboxOf('changed'), volumeName: 'radarist_build_replaced' },
    });

    await (cleanupBuildSandboxes as any).execute();

    expect(driverStop).not.toHaveBeenCalled();
    expect(recreateSandboxRuntime).not.toHaveBeenCalled();
    expect(driverDestroy).not.toHaveBeenCalled();
  });

  it('does not persist stale cleanup state when lifecycle changes during harvest', async () => {
    fakeCfg.keepAliveMinutes = 60 * 24 * 365;
    const candidate = oldMission('changed-during-harvest');
    const changed = { ...candidate, status: 'pending' };
    byStatus = { running: [], pending: [], completed: [candidate], failed: [] };
    mockGetMissionById
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce(changed)
      .mockResolvedValueOnce(changed);

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(recreateSandboxRuntime).toHaveBeenCalledTimes(1);
    expect(harvestArtifact).toHaveBeenCalledTimes(1);
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ reclaimed: 0 }));
  });

  it('does not fail a stale stuck candidate that completed before lock ownership', async () => {
    const candidate = oldMission('stale-stuck', { status: 'running', completedAt: undefined });
    byStatus = { running: [candidate], pending: [], completed: [], failed: [] };
    mockGetMissionById.mockResolvedValueOnce({ ...candidate, status: 'completed', completedAt: daysAgo(1) });

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(driverStop).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ failed: 0 }));
  });

  it('skips a mission while another runtime operation owns its lock', async () => {
    mockAcquireBuildRuntimeOperation.mockReturnValue(null);
    byStatus = { running: [], pending: [], completed: [oldMission('locked')], failed: [] };

    const result = await (cleanupBuildSandboxes as any).execute();

    expect(mockAcquireBuildRuntimeOperation).toHaveBeenCalledWith('locked');
    expect(driverStop).not.toHaveBeenCalled();
    expect(recreateSandboxRuntime).not.toHaveBeenCalled();
    expect(harvestArtifact).not.toHaveBeenCalled();
    expect(driverDestroy).not.toHaveBeenCalled();
    expect(mockUpdateMission).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ stopped: 0, reclaimed: 0 }));
  });

  it('releases the operation lock after a failed harvest', async () => {
    harvestArtifact.mockResolvedValueOnce(null);
    byStatus = { running: [], pending: [], completed: [oldMission('sol-old')], failed: [] };

    await (cleanupBuildSandboxes as any).execute();

    // The completed mission is visited by preview expiry and by reclaim.
    expect(mockAcquireBuildRuntimeOperation).toHaveBeenCalledTimes(2);
    expect(mockReleaseRuntime).toHaveBeenCalledTimes(2);
  });

  it('persists preview stop state and clears a reclaimed prototype demo URL', async () => {
    byStatus = {
      running: [],
      pending: [],
      completed: [
        oldMission('sol-old', {
          artifact: { prototypeId: 'proto-9', previewUrl: 'http://localhost:4100', publishedAt: daysAgo(10) },
          sandbox: { ...sandboxOf('sol-old'), state: 'running' },
        }),
      ],
      failed: [],
    };

    await (cleanupBuildSandboxes as any).execute();

    const stopped = mockUpdateMission.mock.calls.find(
      (call) => (call[1] as any).sandbox?.state === 'stopped' && !(call[1] as any).harvest
    );
    expect(stopped?.[0]).toBe('sol-old');
    expect((stopped?.[1] as any).sandbox.hostPort).toBe(4100);
    expect(mockDocUpdate).toHaveBeenCalledWith(
      'prototypes',
      'proto-9',
      expect.objectContaining({ 'artifacts.demoUrl': '' })
    );
  });
});
