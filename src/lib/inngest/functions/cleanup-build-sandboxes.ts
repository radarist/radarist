/**
 * @file lib/inngest/functions/cleanup-build-sandboxes.ts
 * @description Lifecycle GC for build-mission sandboxes (runs every 6h).
 *
 * 1. Stops preview containers of published artifacts once they outlive
 *    IMPULSE_BUILD_KEEP_ALIVE_MINUTES (volumes are ALWAYS kept — Iterate
 *    restarts the container on demand).
 * 2. Force-fails build missions stuck in 'running'/'pending' beyond
 *    IMPULSE_BUILD_GC_THRESHOLD_HOURS. Build missions are excluded from
 *    the general mission GC because they legitimately park at human gates
 *    for days; this build-specific threshold sits beyond every gate
 *    timeout (24h/72h), so anything older is genuinely dead.
 * 3. Harvest-then-reclaim (L): once a finished mission outlives its per-kind
 *    retention window, harvest its durable bundle (git history + logs) to the
 *    host, persist that evidence, then REMOVE the container AND volume. A
 *    failed or unverifiable harvest keeps the volume for the next GC pass.
 */
import * as path from 'node:path';
import { inngest } from '../client';
import { importSandbox } from '@/lib/agent-import';
import { acquireBuildRuntimeOperation } from '@/lib/build-runtime-operation-lock';
import { createLogger } from '@/lib/logger';
import type { Mission } from '@/lib/schemas/mission';

const log = createLogger('cleanup-build-sandboxes');

interface SandboxRef {
  driver: 'docker';
  missionId: string;
  containerName: string;
  volumeName: string;
  image: string;
  hostPort: number;
  workspacePath: string;
}

interface SandboxDriver {
  stop(ref: SandboxRef): Promise<void>;
  destroy(ref: SandboxRef, opts?: { removeVolume?: boolean }): Promise<void>;
  isRunning(ref: SandboxRef): Promise<boolean>;
}

type HarvestRecord = NonNullable<Mission['harvest']>;

interface HarvestIntegrityReader {
  readHarvestBundleIntegrity(
    bundlePath: string
  ): Promise<{ sha256: string; bytes: number } | null>;
}

function refForMission(mission: Mission): SandboxRef {
  const sandbox = mission.sandbox!;
  if (sandbox.driver !== 'docker') {
    throw new Error(`Cannot clean up unsupported persisted sandbox driver ${sandbox.driver}`);
  }
  return {
    driver: sandbox.driver,
    missionId: mission.id,
    containerName: sandbox.containerName,
    volumeName: sandbox.volumeName,
    image: sandbox.image,
    hostPort: sandbox.hostPort ?? 0,
    workspacePath: sandbox.workspacePath,
  };
}

async function stopAndVerifyRuntime(
  driver: SandboxDriver,
  ref: SandboxRef,
  context: string
): Promise<void> {
  if (await driver.isRunning(ref)) await driver.stop(ref);
  if (await driver.isRunning(ref)) {
    throw new Error(`${context}: runtime ${ref.containerName} is still running after stop`);
  }
}

function expectedHarvestPath(harvestDir: string, missionId: string): string | null {
  if (!/^[a-zA-Z0-9._-]+$/.test(missionId) || missionId === '.' || missionId === '..') return null;
  return path.join(path.resolve(harvestDir), `${missionId}.tgz`);
}

function persistedHarvestMetadata(mission: Mission, harvestDir: string): HarvestRecord | null {
  const expected = expectedHarvestPath(harvestDir, mission.id);
  const harvest = mission.harvest;
  if (
    !expected ||
    !harvest ||
    harvest.bundlePath !== expected ||
    harvest.reclaimedAt ||
    typeof harvest.harvestedAt !== 'string' ||
    harvest.harvestedAt.length === 0 ||
    typeof harvest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(harvest.sha256) ||
    typeof harvest.bytes !== 'number' ||
    !Number.isSafeInteger(harvest.bytes) ||
    harvest.bytes <= 0
  ) {
    return null;
  }
  return harvest;
}

async function verifyPersistedHarvest(
  sandbox: HarvestIntegrityReader,
  missionId: string,
  harvestDir: string,
  harvest: HarvestRecord
): Promise<boolean> {
  const expected = expectedHarvestPath(harvestDir, missionId);
  if (!expected || harvest.bundlePath !== expected || !harvest.sha256 || !harvest.bytes) return false;
  const integrity = await sandbox.readHarvestBundleIntegrity(expected);
  return integrity?.sha256 === harvest.sha256 && integrity.bytes === harvest.bytes;
}

function sandboxLifecycleIdentity(mission: Mission): string {
  const sandbox = mission.sandbox;
  if (!sandbox) return 'none';
  return JSON.stringify([
    sandbox.driver,
    sandbox.containerName,
    sandbox.volumeName,
    sandbox.image,
    sandbox.hostPort ?? null,
    sandbox.workspacePath,
    sandbox.state,
    sandbox.createdAt ?? null,
  ]);
}

function harvestLifecycleIdentity(mission: Mission): string {
  const harvest = mission.harvest;
  if (!harvest) return 'none';
  return JSON.stringify([
    harvest.bundlePath,
    harvest.harvestedAt,
    harvest.sha256 ?? null,
    harvest.bytes ?? null,
    harvest.reclaimedAt ?? null,
  ]);
}

function sameLifecycleCandidate(expected: Mission, current: Mission): boolean {
  return (
    expected.id === current.id &&
    expected.kind === current.kind &&
    expected.status === current.status &&
    expected.createdAt === current.createdAt &&
    expected.completedAt === current.completedAt &&
    expected.artifactKind === current.artifactKind &&
    sandboxLifecycleIdentity(expected) === sandboxLifecycleIdentity(current) &&
    harvestLifecycleIdentity(expected) === harvestLifecycleIdentity(current)
  );
}

function stoppedSandbox(mission: Mission, ref: SandboxRef): NonNullable<Mission['sandbox']> {
  return {
    ...mission.sandbox!,
    driver: ref.driver,
    image: ref.image,
    containerName: ref.containerName,
    volumeName: ref.volumeName,
    hostPort: ref.hostPort,
    workspacePath: ref.workspacePath,
    state: 'stopped',
  };
}

function canonicalRefForMissionWithoutSandbox(
  sandbox: {
    containerNameFor(missionId: string): string;
    volumeNameFor(missionId: string): string;
    fullImageName(config: unknown): string;
  },
  cfg: { driver: string; workspacePath: string },
  mission: Pick<Mission, 'id'>
): SandboxRef {
  if (cfg.driver !== 'docker') {
    throw new Error(`Cannot clean up unsupported configured sandbox driver ${cfg.driver}`);
  }
  return {
    driver: 'docker',
    missionId: mission.id,
    containerName: sandbox.containerNameFor(mission.id),
    volumeName: sandbox.volumeNameFor(mission.id),
    image: sandbox.fullImageName(cfg),
    hostPort: 0,
    workspacePath: cfg.workspacePath,
  };
}

function previewIsExpired(mission: Mission, cutoff: string): boolean {
  return Boolean(
    mission.kind === 'build' &&
      mission.status === 'completed' &&
      mission.sandbox &&
      mission.sandbox.state !== 'destroyed' &&
      !mission.harvest?.reclaimedAt &&
      mission.completedAt &&
      mission.completedAt < cutoff
  );
}

function stuckBuildIsEligible(mission: Mission, cutoff: string): boolean {
  return (
    mission.kind === 'build' &&
    (mission.status === 'running' || mission.status === 'pending') &&
    mission.createdAt < cutoff
  );
}

function isFirestoreNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 5 || code === '5' || code === 'not-found';
}

export const cleanupBuildSandboxes = inngest.createFunction(
  { id: 'cleanup-build-sandboxes', retries: 1 },
  { cron: '0 */6 * * *' },
  async ({ step }) => {
    const stoppedPreviews = await step.run('stop-expired-previews', async () => {
      const sandbox = await importSandbox();
      const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
      const { db } = await import('@/lib/firebase-admin');
      const cutoff = new Date(Date.now() - cfg.keepAliveMinutes * 60 * 1000).toISOString();

      const snap = await db
        .collection('missions')
        .where('kind', '==', 'build')
        .where('status', '==', 'completed')
        .limit(100)
        .get();
      const expired = snap.docs
        .map((d) => d.data() as Mission)
        .filter((mission) => previewIsExpired(mission, cutoff));

      const driver = sandbox.getDriver(cfg.driver) as SandboxDriver;
      const { getMissionById, updateMission } = await import('@/lib/missions');
      let stopped = 0;
      for (const candidate of expired) {
        const releaseRuntime = acquireBuildRuntimeOperation(candidate.id);
        if (!releaseRuntime) {
          log.info('preview expiry skipped because another runtime operation is active', {
            missionId: candidate.id,
          });
          continue;
        }
        try {
          const mission = await getMissionById(candidate.id);
          if (!mission || !sameLifecycleCandidate(candidate, mission) || !previewIsExpired(mission, cutoff)) {
            log.info('preview expiry skipped because candidate state changed after query', {
              missionId: candidate.id,
            });
            continue;
          }
          const ref = refForMission(mission);
          await stopAndVerifyRuntime(driver, ref, `Build preview ${mission.id} expiry cleanup`);
          const beforeUpdate = await getMissionById(mission.id);
          if (
            !beforeUpdate ||
            !sameLifecycleCandidate(mission, beforeUpdate) ||
            !previewIsExpired(beforeUpdate, cutoff)
          ) {
            log.warn('preview stopped but state write skipped because mission changed during cleanup', {
              missionId: mission.id,
            });
            continue;
          }
          // Record that the preview is no longer live so the UI stops rendering a
          // link/iframe to a stopped port. hostPort/previewUrl are KEPT — Iterate
          // restarts the same container — but `state: 'stopped'` drives
          // previewState() → 'stopped' (offer Restart, not a dead link).
          await updateMission(mission.id, { sandbox: stoppedSandbox(mission, ref) });
          stopped++;
        } catch (error) {
          log.warn('preview stop failed', {
            missionId: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          releaseRuntime();
        }
      }
      return { candidates: expired.length, stopped };
    });

    const gcStuck = await step.run('gc-stuck-builds', async () => {
      const sandbox = await importSandbox();
      const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
      const { db } = await import('@/lib/firebase-admin');
      const cutoff = new Date(Date.now() - cfg.gcThresholdHours * 60 * 60 * 1000).toISOString();

      const [running, pending] = await Promise.all([
        db.collection('missions').where('kind', '==', 'build').where('status', '==', 'running').get(),
        db.collection('missions').where('kind', '==', 'build').where('status', '==', 'pending').get(),
      ]);
      const stuck = [...running.docs, ...pending.docs]
        .map((d) => d.data() as Mission)
        .filter((mission) => stuckBuildIsEligible(mission, cutoff));

      const driver = sandbox.getDriver(cfg.driver) as SandboxDriver;
      const { getMissionById, updateMission } = await import('@/lib/missions');
      let failed = 0;
      let cleanupPending = 0;
      for (const candidate of stuck) {
        const releaseRuntime = acquireBuildRuntimeOperation(candidate.id);
        if (!releaseRuntime) {
          log.info('stuck build cleanup skipped because another runtime operation is active', {
            missionId: candidate.id,
          });
          continue;
        }
        try {
          const mission = await getMissionById(candidate.id);
          if (!mission || !sameLifecycleCandidate(candidate, mission) || !stuckBuildIsEligible(mission, cutoff)) {
            log.info('stuck build cleanup skipped because candidate state changed after query', {
              missionId: candidate.id,
            });
            continue;
          }
          log.warn('force-failing stuck build mission', { missionId: mission.id, createdAt: mission.createdAt });
          const ref = mission.sandbox
            ? refForMission(mission)
            : canonicalRefForMissionWithoutSandbox(sandbox, cfg, mission);
          try {
            await stopAndVerifyRuntime(driver, ref, `Build mission ${mission.id} GC cleanup`);
          } catch (error) {
            cleanupPending++;
            const detail = error instanceof Error ? error.message : String(error);
            log.warn('stuck build runtime cleanup could not be verified; mission remains non-terminal', {
              missionId: mission.id,
              error: detail,
            });
            const beforeEvidence = await getMissionById(mission.id).catch(() => null);
            if (
              beforeEvidence &&
              sameLifecycleCandidate(mission, beforeEvidence) &&
              stuckBuildIsEligible(beforeEvidence, cutoff)
            ) {
              try {
                await updateMission(mission.id, {
                  errors: [
                    ...(beforeEvidence.errors ?? []).slice(-9),
                    `build GC cleanup required: ${detail}`.slice(0, 2000),
                  ],
                });
              } catch (stateError) {
                log.warn('could not persist stuck build cleanup-required evidence', {
                  missionId: mission.id,
                  error: stateError instanceof Error ? stateError.message : String(stateError),
                });
              }
            }
            continue;
          }
          const beforeTerminal = await getMissionById(mission.id);
          if (
            !beforeTerminal ||
            !sameLifecycleCandidate(mission, beforeTerminal) ||
            !stuckBuildIsEligible(beforeTerminal, cutoff)
          ) {
            log.warn('stuck runtime stopped but terminal write skipped because mission changed during cleanup', {
              missionId: mission.id,
            });
            continue;
          }
          await updateMission(mission.id, {
            status: 'failed',
            buildState: 'paused',
            completedAt: new Date().toISOString(),
            errors: [`build GC: stuck beyond ${cfg.gcThresholdHours}h (volume kept)`],
            ...(mission.sandbox ? { sandbox: stoppedSandbox(mission, ref) } : {}),
          });
          failed++;
        } finally {
          releaseRuntime();
        }
      }
      return { failed, cleanupPending };
    });

    const reclaimed = await step.run('harvest-and-reclaim', async () => {
      const sandbox = await importSandbox();
      const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
      const { db } = await import('@/lib/firebase-admin');
      const { getMissionById, updateMission } = await import('@/lib/missions');
      const driver = sandbox.getDriver(cfg.driver) as SandboxDriver;
      const harvestDir = 'tmp/build-harvests';
      const now = Date.now();

      // Per-kind retention → the age past which we harvest + reclaim.
      const retentionDays = (m: Mission): number => {
        if (m.status === 'failed') return cfg.lifecycle.failedVolumeRetentionDays;
        return (m.artifactKind ?? 'solution') === 'evaluation'
          ? cfg.lifecycle.evalVolumeRetentionDays
          : cfg.lifecycle.volumeRetentionDays;
      };
      const reclaimIsEligible = (mission: Mission): boolean =>
        Boolean(
          mission.kind === 'build' &&
            (mission.status === 'completed' || mission.status === 'failed') &&
            mission.sandbox &&
            mission.sandbox.state !== 'destroyed' &&
            !mission.harvest?.reclaimedAt &&
            mission.completedAt &&
            new Date(mission.completedAt).getTime() <
              now - retentionDays(mission) * 24 * 60 * 60 * 1000
        );

      const [completed, failed] = await Promise.all([
        db.collection('missions').where('kind', '==', 'build').where('status', '==', 'completed').limit(200).get(),
        db.collection('missions').where('kind', '==', 'build').where('status', '==', 'failed').limit(200).get(),
      ]);
      const candidates = [...completed.docs, ...failed.docs]
        .map((d) => d.data() as Mission)
        .filter((mission) => reclaimIsEligible(mission));

      let harvested = 0;
      let reclaimedCount = 0;
      for (const candidate of candidates) {
        const releaseRuntime = acquireBuildRuntimeOperation(candidate.id);
        if (!releaseRuntime) {
          log.info('harvest/reclaim skipped because another runtime operation is active', {
            missionId: candidate.id,
          });
          continue;
        }
        let mission: Mission | null = null;
        let expectedCleanupState: Mission | null = null;
        let activeRef: SandboxRef | null = null;
        let volumeRemoved = false;
        try {
          mission = await getMissionById(candidate.id);
          if (!mission || !sameLifecycleCandidate(candidate, mission) || !reclaimIsEligible(mission)) {
            log.info('harvest/reclaim skipped because candidate state changed after query', {
              missionId: candidate.id,
            });
            continue;
          }
          expectedCleanupState = mission;
          const ref = refForMission(mission);
          activeRef = ref;
          try {
            let harvest = persistedHarvestMetadata(mission, harvestDir);
            let persistHarvestBeforeReclaim = false;
            if (harvest && !(await verifyPersistedHarvest(sandbox, mission.id, harvestDir, harvest))) {
              log.warn('persisted harvest integrity changed; rebuilding before reclaim', {
                missionId: mission.id,
              });
              harvest = null;
            }

            if (harvest) {
              // Recovery after a prior pass persisted the bundle but failed while
              // removing the runtime or recording reclaimedAt.
            } else {
              // Never resume the old writable layer: it carries the agent's
              // provider/internal environment and may contain a poisoned HOME.
              const recreated = await sandbox.recreateSandboxRuntime({
                cfg,
                missionId: mission.id,
                driver,
                ref,
                hostPort: ref.hostPort,
                artifactKind: mission.artifactKind ?? 'solution',
                purpose: 'preview',
              });
              activeRef = recreated.ref as SandboxRef;
              for (const warning of recreated.warnings) {
                log.warn('secretless harvest runtime recreation warning', { missionId: mission.id, warning });
              }

              const result = await sandbox.harvestArtifact(driver, activeRef, harvestDir, mission.id);
              const expectedPath = expectedHarvestPath(harvestDir, mission.id);
              if (
                !result ||
                !expectedPath ||
                result.bundlePath !== expectedPath ||
                typeof result.sha256 !== 'string' ||
                !/^[a-f0-9]{64}$/.test(result.sha256) ||
                !Number.isSafeInteger(result.bytes) ||
                result.bytes <= 0
              ) {
                throw new Error('durable harvest bundle was unavailable or failed verification');
              }
              harvest = {
                bundlePath: result.bundlePath,
                harvestedAt: new Date().toISOString(),
                sha256: result.sha256,
                bytes: result.bytes,
              };
              persistHarvestBeforeReclaim = true;
              harvested++;
            }

            // Harvesting can take minutes. Re-read after that work, while still
            // holding the runtime lock, and refuse to act on a stale query result.
            const beforeReclaim = await getMissionById(mission.id);
            if (
              !beforeReclaim ||
              !sameLifecycleCandidate(mission, beforeReclaim) ||
              !reclaimIsEligible(beforeReclaim)
            ) {
              throw new Error('mission lifecycle changed while harvest was in progress');
            }

            if (persistHarvestBeforeReclaim) {
              await updateMission(mission.id, { harvest });
              expectedCleanupState = { ...mission, harvest };
            }

            // The Prototype owns a separate preview URL. Clearing it is part of
            // the retryable reclaim transaction and MUST precede volume removal.
            // If this write fails the retained volume is still available, so the
            // next GC pass can retry without recreating an empty named volume.
            if (mission.artifact?.prototypeId) {
              try {
                await db
                  .collection('prototypes')
                  .doc(mission.artifact.prototypeId)
                  .update({ 'artifacts.demoUrl': '', updatedAt: Date.now() });
              } catch (error) {
                if (!isFirestoreNotFound(error)) throw error;
                log.info('reclaimed prototype was already absent while clearing demoUrl', {
                  missionId: mission.id,
                  prototypeId: mission.artifact.prototypeId,
                });
              }
            }

            // Re-hash immediately before the only destructive operation. This is
            // required even on retry: a non-empty but replaced/truncated host file
            // must never authorize removal of the retained volume.
            if (!(await verifyPersistedHarvest(sandbox, mission.id, harvestDir, harvest))) {
              throw new Error('durable harvest bundle changed before reclaim');
            }
            await driver.destroy(activeRef, { removeVolume: true });
            volumeRemoved = true;

            const reclaimedAt = new Date().toISOString();
            await updateMission(mission.id, {
              harvest: {
                ...harvest,
                reclaimedAt,
              },
              // state 'destroyed' → previewState() 'expired' → the /artifacts
              // surfaces stop offering the (now-dead) preview link automatically.
              sandbox: { ...mission.sandbox!, state: 'destroyed' },
            });
            reclaimedCount++;
          } catch (error) {
            log.warn('harvest/reclaim failed (will retry next cycle)', {
              missionId: mission.id,
              error: error instanceof Error ? error.message : String(error),
            });
            // A failed harvest must not leave even a secretless idle runtime
            // consuming resources. Failure here is logged, but the volume and
            // non-reclaimed mission record remain the retry authority.
            if (!volumeRemoved && activeRef) {
              try {
                await stopAndVerifyRuntime(driver, activeRef, `Build mission ${mission.id} harvest cleanup`);
                const beforeCleanupWrite = await getMissionById(mission.id);
                if (
                  beforeCleanupWrite &&
                  expectedCleanupState &&
                  sameLifecycleCandidate(expectedCleanupState, beforeCleanupWrite)
                ) {
                  await updateMission(mission.id, {
                    sandbox: stoppedSandbox(beforeCleanupWrite, activeRef),
                  });
                } else {
                  log.warn('harvest runtime stopped but stale sandbox state was not persisted', {
                    missionId: mission.id,
                  });
                }
              } catch (cleanupError) {
                log.warn('could not verify harvest runtime cleanup; volume retained', {
                  missionId: mission.id,
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                });
              }
            }
          }
        } finally {
          releaseRuntime();
        }
      }
      return { reclaimCandidates: candidates.length, harvested, reclaimed: reclaimedCount };
    });

    return { ...stoppedPreviews, ...gcStuck, ...reclaimed };
  }
);
