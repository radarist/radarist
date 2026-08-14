import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import {
  acquireLocalRuntimeLease,
  enumerateOwnedLocalProcesses,
  findOwnedLocalOrphans,
  inspectLocalRuntimeLease,
  observeLocalProcessTable,
  observeLocalTerminationProgress,
  planLocalRuntimeProcessGroupPause,
  planLocalRuntimeTermination,
  promoteLocalRuntimeLeaseToActive,
  readLocalProcessIdentityManifest,
  releaseLocalRuntimeLease,
  restoreFinalizingLocalProcessManifest,
  retireAbandonedClaimAndAcquireLocalRuntimeLease,
  retireStaleAndAcquireLocalRuntimeLease,
  stableProcessIdentityMismatchReason,
  writeLocalProcessIdentityManifest,
  type LocalProcessIdentityManifest,
  type LocalProcessObservationSnapshot,
  type LocalRuntimeLeaseHandle,
  type LocalRuntimeLeaseRecord,
  type LocalRuntimePausableProcessRole,
  type LocalRuntimePauseGroup,
  type LocalRuntimeProcessRole,
  type LocalRuntimeTerminationSignal,
  type LocalTerminationPolicy,
  type LocalTerminationTarget,
  type ObservedLocalProcess,
  type OwnedLocalProcessIdentity,
} from './local-process-supervisor';
import {
  assertLocalRuntimePathContained,
  getLocalRuntimeProfile,
  type LocalRuntimePaths,
} from './local-runtime-profile';
import {
  EMPTY_RUNTIME_RESIDUE,
  type OwnedProcessCensusEntry,
  type RuntimeResidue,
} from './retained-runtime-shutdown-receipt';

export interface LocalRuntimeLifecycleDependencies {
  readonly currentPid: number;
  readonly observeProcesses: () => LocalProcessObservationSnapshot;
  readonly signal: (target: LocalTerminationTarget, signal: LocalRuntimeTerminationSignal) => void;
  readonly controlSignal: (target: LocalTerminationTarget, signal: LocalRuntimeProcessControlSignal) => void;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly nowEpochMs: () => number;
  readonly terminationPolicy?: LocalTerminationPolicy;
  readonly log?: (message: string) => void;
}

export interface ClaimLocalRuntimeLifecycleInput {
  readonly paths: LocalRuntimePaths;
  readonly runtimeId: string;
  readonly acquiredAt: string;
  readonly dependencies?: Partial<LocalRuntimeLifecycleDependencies>;
}

export interface LocalRuntimeOwnershipHealth {
  readonly orphanPids: readonly number[];
  readonly orphanCount: number;
  readonly ambiguous: boolean;
  readonly reasons: readonly string[];
}

export type LocalRuntimeProcessControlSignal = 'SIGSTOP' | 'SIGCONT';

/** Opaque, one-shot proof that this lifecycle established the suspension. */
export interface LocalRuntimeProcessPauseToken {
  readonly runtimeId: string;
  readonly sequence: number;
}

interface ActiveLocalRuntimePause {
  readonly token: LocalRuntimeProcessPauseToken;
  groups: LocalRuntimePauseGroup[];
}

export function shouldRemoveRetiredEphemeralNeo4j(input: {
  readonly profileName: string;
  readonly retiredRuntimeId?: string;
  readonly runtimeLabel?: string;
  readonly ownerLabel?: string;
}): boolean {
  if (!input.retiredRuntimeId) {
    throw new Error('An existing ephemeral Neo4j container has no verified retired runtime owner.');
  }
  if (input.runtimeLabel !== `ephemeral:${input.profileName}`) {
    throw new Error('Existing ephemeral Neo4j container belongs to another runtime mode or profile.');
  }
  if (input.ownerLabel !== input.retiredRuntimeId) {
    throw new Error('Existing ephemeral Neo4j container owner does not match the retired runtime.');
  }
  return true;
}

function defaultSignal(target: LocalTerminationTarget, signal: LocalRuntimeTerminationSignal): void {
  const groups = target.kind === 'process-list' ? [] : target.processGroupIds;
  const pids = target.kind === 'process-groups' ? [] : target.pids;
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

function defaultControlSignal(target: LocalTerminationTarget, signal: LocalRuntimeProcessControlSignal): void {
  const groups = target.kind === 'process-list' ? [] : target.processGroupIds;
  const pids = target.kind === 'process-groups' ? [] : target.pids;
  for (const group of groups) {
    try {
      process.kill(-group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
}

function dependenciesWithDefaults(
  overrides: Partial<LocalRuntimeLifecycleDependencies> = {}
): LocalRuntimeLifecycleDependencies {
  return {
    currentPid: overrides.currentPid ?? process.pid,
    observeProcesses: overrides.observeProcesses ?? observeLocalProcessTable,
    signal: overrides.signal ?? defaultSignal,
    controlSignal: overrides.controlSignal ?? defaultControlSignal,
    sleep:
      overrides.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
    nowEpochMs: overrides.nowEpochMs ?? Date.now,
    terminationPolicy: overrides.terminationPolicy,
    log: overrides.log,
  };
}

function requireCompleteSnapshot(dependencies: LocalRuntimeLifecycleDependencies): LocalProcessObservationSnapshot {
  const snapshot = dependencies.observeProcesses();
  if (!snapshot.complete) throw new Error('Local runtime lifecycle requires a complete process snapshot.');
  return snapshot;
}

function ownedIdentity(role: LocalRuntimeProcessRole, observed: ObservedLocalProcess): OwnedLocalProcessIdentity {
  if (role !== 'launcher' && observed.processGroupId !== observed.pid) {
    throw new Error(`Managed ${role} PID ${observed.pid} must lead its own process group.`);
  }
  // An unreadable "(comm)" fallback cannot become an identity anchor: its
  // fingerprint would be meaningless and would poison every later comparison.
  if (observed.commandUnreadable) {
    throw new Error(`Cannot anchor ${role} PID ${observed.pid}: its command line is unreadable (mid-exit).`);
  }
  return {
    role,
    pid: observed.pid,
    processGroupId: observed.processGroupId,
    parentPid: observed.parentPid,
    birthMarker: observed.birthMarker,
    commandFingerprint: observed.commandFingerprint,
    startedAtEpochMs: observed.startedAtEpochMs,
  };
}

function exactIdentityMatches(
  expected: OwnedLocalProcessIdentity,
  observed: ObservedLocalProcess | undefined
): boolean {
  return (
    Boolean(observed && expected.processGroupId === observed.processGroupId) &&
    stableIdentityMatches(expected, observed)
  );
}

// One shared identity comparator (local-process-supervisor) so the mid-exit
// "(comm)" tolerance can never fork between planning and lifecycle checks.
function stableIdentityMatches(
  expected: Pick<ObservedLocalProcess, 'pid' | 'birthMarker' | 'commandFingerprint' | 'startedAtEpochMs'> & {
    readonly commandUnreadable?: boolean;
  },
  observed: ObservedLocalProcess | undefined
): boolean {
  return Boolean(
    observed && expected.pid === observed.pid && stableProcessIdentityMismatchReason(expected, observed) === undefined
  );
}

function readExactManifest(paths: LocalRuntimePaths, runtimeId: string): LocalProcessIdentityManifest {
  const manifest = readLocalProcessIdentityManifest(paths);
  if (manifest.runtimeId !== runtimeId) throw new Error('Process manifest changed runtime identity.');
  return manifest;
}

function unlinkExactManifest(paths: LocalRuntimePaths, runtimeId: string): void {
  readExactManifest(paths, runtimeId);
  unlinkSync(assertLocalRuntimePathContained(paths, paths.processManifest));
}

async function terminateManifest(
  manifest: LocalProcessIdentityManifest,
  dependencies: LocalRuntimeLifecycleDependencies,
  options: { staleLeader?: boolean } = {}
): Promise<void> {
  let snapshot = requireCompleteSnapshot(dependencies);
  const observations = options.staleLeader
    ? snapshot.processes.filter((process) => process.pid !== manifest.leaderPid)
    : snapshot.processes;
  const plan = planLocalRuntimeTermination(manifest, observations, {
    policy: dependencies.terminationPolicy,
  });
  if (plan.status === 'refused') {
    throw new Error(`Refusing local runtime cleanup: ${plan.reasons.join('; ')}`);
  }
  if (plan.status === 'already-stopped' || !plan.target) return;

  let target = plan.target;
  for (const stage of plan.stages) {
    dependencies.signal(target, stage.signal);
    const deadline = dependencies.nowEpochMs() + stage.graceMs;
    while (true) {
      snapshot = requireCompleteSnapshot(dependencies);
      const progress = observeLocalTerminationProgress(plan, snapshot.processes);
      if (progress.status === 'stopped') return;
      if (progress.status === 'refused') {
        throw new Error(`Refusing local runtime cleanup: ${progress.reasons.join('; ')}`);
      }
      target = progress.target;
      if (dependencies.nowEpochMs() >= deadline) break;
      await dependencies.sleep(stage.pollIntervalMs);
    }
  }

  const final = observeLocalTerminationProgress(plan, requireCompleteSnapshot(dependencies).processes);
  if (final.status !== 'stopped') {
    throw new Error(`Owned processes survived bounded cleanup: ${final.remainingPids.join(', ')}.`);
  }
}

export class LocalRuntimeLifecycle {
  private manifest: LocalProcessIdentityManifest;
  private lease: LocalRuntimeLeaseHandle;
  private processesStopped = false;
  private finalized = false;
  private pauseSequence = 0;
  private activePause: ActiveLocalRuntimePause | null = null;

  private constructor(
    readonly paths: LocalRuntimePaths,
    lease: LocalRuntimeLeaseHandle,
    manifest: LocalProcessIdentityManifest,
    private readonly dependencies: LocalRuntimeLifecycleDependencies,
    readonly retiredRuntimeId?: string
  ) {
    this.lease = lease;
    this.manifest = manifest;
  }

  static async claim(input: ClaimLocalRuntimeLifecycleInput): Promise<LocalRuntimeLifecycle> {
    const dependencies = dependenciesWithDefaults(input.dependencies);
    const profile = getLocalRuntimeProfile(input.paths.profileName);
    const initial = requireCompleteSnapshot(dependencies);
    const launcher = initial.processes.find((process) => process.pid === dependencies.currentPid);
    if (!launcher) throw new Error('Cannot observe the local runtime launcher identity.');
    const launcherIdentity = ownedIdentity('launcher', launcher);
    const replacement: LocalRuntimeLeaseRecord = {
      version: 1,
      runtimeId: input.runtimeId,
      profileName: profile.name,
      projectId: profile.projectId,
      acquiredAt: input.acquiredAt,
      phase: 'claiming',
      owner: launcherIdentity,
    };
    const inspection = inspectLocalRuntimeLease(input.paths, initial);
    if (inspection.status === 'active' || inspection.status === 'unverified' || inspection.status === 'refused') {
      throw new Error(
        `Local runtime profile ${profile.name} is ${inspection.status}: ${inspection.reasons.join('; ')}.`
      );
    }

    let lease: LocalRuntimeLeaseHandle | undefined;
    let retiredRuntimeId: string | undefined;
    if (inspection.status === 'available') {
      lease = acquireLocalRuntimeLease(input.paths, replacement, initial);
      if (existsSync(input.paths.processManifest)) {
        try {
          const staleManifest = readLocalProcessIdentityManifest(input.paths);
          const observedLeader = initial.processes.find((process) => process.pid === staleManifest.leaderPid);
          const staleLeader = staleManifest.processes.find((identity) => identity.pid === staleManifest.leaderPid);
          if (!staleLeader) {
            throw new Error('Process manifest has no launcher identity for its leader PID.');
          }
          if (exactIdentityMatches(staleLeader, observedLeader)) {
            throw new Error('An active runtime has a process manifest but no lease; refusing takeover.');
          }
          await terminateManifest(staleManifest, dependencies, { staleLeader: true });
          unlinkExactManifest(input.paths, staleManifest.runtimeId);
          retiredRuntimeId = staleManifest.runtimeId;
        } catch (error) {
          releaseLocalRuntimeLease(input.paths, lease);
          throw error;
        }
      }
    } else {
      let staleManifest: LocalProcessIdentityManifest | undefined;
      if (!existsSync(input.paths.processManifest)) {
        if (inspection.lease.phase === 'claiming') {
          lease = retireAbandonedClaimAndAcquireLocalRuntimeLease(input.paths, inspection, initial, replacement);
          retiredRuntimeId = inspection.lease.runtimeId;
        } else if (inspection.lease.phase === 'active') {
          staleManifest = restoreFinalizingLocalProcessManifest(input.paths, inspection, initial);
        } else {
          // Missing-phase legacy leases are deliberately ineligible for both
          // crash windows and retain the abandoned-claim refusal contract.
          throw new Error('Manifest-less lease recovery requires an explicit claiming phase.');
        }
      } else {
        staleManifest = readLocalProcessIdentityManifest(input.paths);
      }
      if (staleManifest) {
        if (staleManifest.runtimeId !== inspection.lease.runtimeId) {
          throw new Error('Stale local runtime lease and process manifest identities differ.');
        }
        await terminateManifest(staleManifest, dependencies, { staleLeader: true });
        lease = retireStaleAndAcquireLocalRuntimeLease(
          input.paths,
          inspection,
          staleManifest,
          requireCompleteSnapshot(dependencies),
          replacement
        );
        unlinkExactManifest(input.paths, staleManifest.runtimeId);
        retiredRuntimeId = staleManifest.runtimeId;
      }
    }
    if (!lease) {
      throw new Error('Local runtime recovery completed without acquiring the replacement lease.');
    }

    const manifest: LocalProcessIdentityManifest = {
      version: 1,
      runtimeId: input.runtimeId,
      profileName: profile.name,
      projectId: profile.projectId,
      createdAt: input.acquiredAt,
      leaderPid: dependencies.currentPid,
      processes: [launcherIdentity],
    };
    try {
      writeLocalProcessIdentityManifest(input.paths, manifest);
      lease = promoteLocalRuntimeLeaseToActive(input.paths, lease);
    } catch (error) {
      try {
        releaseLocalRuntimeLease(input.paths, lease);
      } catch {
        // Promotion may already have atomically replaced the lease before a
        // later fsync error. Leave the witnessed state for stale recovery.
      }
      throw error;
    }
    return new LocalRuntimeLifecycle(input.paths, lease, manifest, dependencies, retiredRuntimeId);
  }

  get runtimeId(): string {
    return this.manifest.runtimeId;
  }

  get processManifest(): LocalProcessIdentityManifest {
    return this.manifest;
  }

  /**
   * Recompute process ownership from one complete operating-system snapshot.
   * The public health file must never report a hard-coded orphan count: exact
   * recorded identities and unauthenticated members of a recorded group are
   * evaluated on every heartbeat.
   */
  inspectOwnership(): LocalRuntimeOwnershipHealth {
    const snapshot = requireCompleteSnapshot(this.dependencies);
    const enumeration = enumerateOwnedLocalProcesses(this.manifest, snapshot.processes);
    const orphanPids = new Set(findOwnedLocalOrphans(this.manifest, snapshot.processes).map((process) => process.pid));
    for (const pid of enumeration.unanchoredGroupPids) orphanPids.add(pid);
    const sortedOrphanPids = [...orphanPids].sort((left, right) => left - right);
    const reasons = [
      ...enumeration.reasons,
      ...(enumeration.unanchoredGroupPids.length > 0
        ? [
            `Recorded process groups contain unauthenticated live members: ${enumeration.unanchoredGroupPids.join(', ')}`,
          ]
        : []),
    ];
    return {
      orphanPids: sortedOrphanPids,
      orphanCount: sortedOrphanPids.length,
      ambiguous: reasons.length > 0,
      reasons,
    };
  }

  registerProcess(role: Exclude<LocalRuntimeProcessRole, 'launcher'>, pid: number): void {
    if (this.finalized) throw new Error('Cannot register a process after runtime finalization.');
    if (this.activePause) throw new Error('Cannot register a process while owned writers are suspended.');
    const snapshot = requireCompleteSnapshot(this.dependencies);
    const observed = snapshot.processes.find((process) => process.pid === pid);
    if (!observed) throw new Error(`Cannot observe newly spawned ${role} PID ${pid}.`);
    const identity = ownedIdentity(role, observed);
    this.manifest = {
      ...this.manifest,
      processes: [...this.manifest.processes.filter((process) => process.pid !== pid), identity],
    };
    writeLocalProcessIdentityManifest(this.paths, this.manifest);
    this.processesStopped = false;
  }

  /** Refresh command/parent identity after an npx wrapper has stabilized. */
  refreshProcess(pid: number): void {
    if (this.activePause) throw new Error('Cannot refresh a process while owned writers are suspended.');
    const previous = this.manifest.processes.find((process) => process.pid === pid);
    if (!previous || previous.role === 'launcher') throw new Error(`PID ${pid} is not a registered child.`);
    const snapshot = requireCompleteSnapshot(this.dependencies);
    const observed = snapshot.processes.find((process) => process.pid === pid);
    if (!observed) throw new Error(`Registered ${previous.role} PID ${pid} exited before stabilization.`);
    if (previous.birthMarker !== observed.birthMarker || previous.startedAtEpochMs !== observed.startedAtEpochMs) {
      throw new Error(`Registered ${previous.role} PID ${pid} was reused before stabilization.`);
    }
    const refreshed = ownedIdentity(previous.role, observed);
    this.manifest = {
      ...this.manifest,
      processes: this.manifest.processes.map((process) => (process.pid === pid ? refreshed : process)),
    };
    writeLocalProcessIdentityManifest(this.paths, this.manifest);
  }

  private assertPersistedManifestUnchanged(): void {
    const persisted = readExactManifest(this.paths, this.manifest.runtimeId);
    if (JSON.stringify(persisted) !== JSON.stringify(this.manifest)) {
      throw new Error('Process manifest changed outside the owning lifecycle.');
    }
  }

  /**
   * Suspend only selected, exactly registered POSIX groups. Each group is
   * re-authenticated from a fresh complete process snapshot immediately before
   * SIGSTOP. The returned object is a one-shot identity token, not a caller-
   * supplied list of PIDs.
   */
  pauseProcessGroups(roles: readonly LocalRuntimePausableProcessRole[]): LocalRuntimeProcessPauseToken {
    if (this.finalized) throw new Error('Cannot suspend processes after runtime finalization.');
    if (this.processesStopped) throw new Error('Cannot suspend processes after runtime shutdown.');
    if (this.activePause) throw new Error('Owned process groups are already suspended.');
    this.assertPersistedManifestUnchanged();

    const initial = planLocalRuntimeProcessGroupPause(this.manifest, requireCompleteSnapshot(this.dependencies), roles);
    if (initial.status === 'refused') {
      throw new Error(`Refusing local runtime suspension: ${initial.reasons.join('; ')}`);
    }

    const token = Object.freeze({
      runtimeId: this.manifest.runtimeId,
      sequence: ++this.pauseSequence,
    });
    const active: ActiveLocalRuntimePause = { token, groups: [] };
    this.activePause = active;
    try {
      for (const expected of initial.groups) {
        this.assertPersistedManifestUnchanged();
        const fresh = planLocalRuntimeProcessGroupPause(
          this.manifest,
          requireCompleteSnapshot(this.dependencies),
          roles
        );
        if (fresh.status === 'refused') {
          throw new Error(`Refusing local runtime suspension: ${fresh.reasons.join('; ')}`);
        }
        // A writer may exit between the initial plan and its turn. Missing
        // groups need no signal; a reused/live unanchored group was refused.
        const group = fresh.groups.find(
          (candidate) =>
            candidate.processGroupId === expected.processGroupId && candidate.root.pid === expected.root.pid
        );
        if (!group) continue;
        this.dependencies.controlSignal(
          {
            kind: 'owned-process-set',
            processGroupIds: [group.processGroupId],
            pids: [],
          },
          'SIGSTOP'
        );
        active.groups.push(group);
      }
      return token;
    } catch (pauseError) {
      try {
        this.resumeProcessGroups(token);
      } catch (resumeError) {
        throw new AggregateError(
          [
            pauseError instanceof Error ? pauseError : new Error(String(pauseError)),
            resumeError instanceof Error ? resumeError : new Error(String(resumeError)),
          ],
          'Process-group suspension failed and verified cleanup is incomplete.'
        );
      }
      throw pauseError;
    }
  }

  private resumeActivePause(active: ActiveLocalRuntimePause): void {
    const snapshot = requireCompleteSnapshot(this.dependencies);
    const observedByPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
    const remaining: LocalRuntimePauseGroup[] = [];
    const errors: Error[] = [];

    for (const group of [...active.groups].reverse()) {
      try {
        const currentGroupMembers = snapshot.processes.filter(
          (process) => process.processGroupId === group.processGroupId
        );
        const exactSameGroup = group.members.filter((expected) => {
          const current = observedByPid.get(expected.pid);
          return stableIdentityMatches(expected, current) && current?.processGroupId === group.processGroupId;
        });
        if (exactSameGroup.length > 0) {
          const exactPids = new Set(exactSameGroup.map((process) => process.pid));
          const target: LocalTerminationTarget = currentGroupMembers.every((process) => exactPids.has(process.pid))
            ? {
                kind: 'owned-process-set',
                processGroupIds: [group.processGroupId],
                pids: [],
              }
            : {
                kind: 'owned-process-set',
                processGroupIds: [],
                pids: [...exactPids].sort((left, right) => left - right),
              };
          this.dependencies.controlSignal(target, 'SIGCONT');
          if (target.processGroupIds.length === 0) {
            this.dependencies.log?.(
              `Resumed only exact captured PIDs in process group ${group.processGroupId}; reused or unverified members were not signalled.`
            );
          }
          continue;
        }

        // If an exact captured member was externally moved to another group,
        // resume only that stable PID. Never signal a now-unanchored/reused
        // original PGID merely because it still has live members.
        const exactMovedPids = group.members
          .filter((expected) => {
            const current = observedByPid.get(expected.pid);
            return stableIdentityMatches(expected, current) && current?.processGroupId !== group.processGroupId;
          })
          .map((process) => process.pid)
          .sort((left, right) => left - right);
        if (exactMovedPids.length > 0) {
          this.dependencies.controlSignal(
            { kind: 'owned-process-set', processGroupIds: [], pids: exactMovedPids },
            'SIGCONT'
          );
        } else if (currentGroupMembers.length > 0) {
          this.dependencies.log?.(
            `Skipped SIGCONT for unanchored or reused process group ${group.processGroupId}; no exact suspended identity survives.`
          );
        }
      } catch (error) {
        remaining.push(group);
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    active.groups = remaining.reverse();
    if (active.groups.length === 0) this.activePause = null;
    if (errors.length > 0) {
      throw new AggregateError(errors, 'One or more verified writer groups could not resume.');
    }
  }

  /** Resume only the groups captured by the exact token returned above. */
  resumeProcessGroups(token: LocalRuntimeProcessPauseToken): void {
    const active = this.activePause;
    if (!active || active.token !== token || token.runtimeId !== this.manifest.runtimeId) {
      throw new Error('Process pause token is stale, foreign, or already consumed.');
    }
    this.resumeActivePause(active);
  }

  /** Retry verified cleanup after pauseProcessGroups itself reported a partial failure. */
  recoverPausedProcessGroups(): void {
    if (this.activePause) this.resumeActivePause(this.activePause);
  }

  /**
   * LOCAL-012 — report what this runtime still owns, without signalling anything.
   *
   * The supervisor already knows all of this: `planLocalRuntimeTermination`
   * derives exact, descendant, orphan, unrecorded and unanchored pids plus its own
   * refusal reasons. It was simply unreachable from the launcher, so a `SIGINT`
   * that left four child process groups alive could only report "cleanup failed"
   * while the pids it had already identified stayed in the plan.
   *
   * Read-only and side-effect-free so it is safe to call from a failing teardown
   * path, where signalling again would be exactly the wrong move.
   *
   * An INCOMPLETE snapshot yields every child as `remaining` with the reason
   * recorded. That is the honest answer: an unobservable process table proves
   * nothing stopped, and reporting "all stopped" would be a false clean.
   */
  describeOwnedProcesses(snapshot?: LocalProcessObservationSnapshot): {
    census: OwnedProcessCensusEntry[];
    residue: RuntimeResidue;
  } {
    const observation = snapshot ?? this.dependencies.observeProcesses();
    // The launcher is mid-exit and must never appear in its own residue — naming
    // it would send the operator to kill the process that is already stopping.
    const owned = this.manifest.processes.filter((process) => process.pid !== this.manifest.leaderPid);

    if (!observation.complete) {
      return {
        census: owned.map((process) => ({
          role: process.role,
          pid: process.pid,
          processGroupId: process.processGroupId,
          disposition: 'remaining' as const,
        })),
        residue: {
          ...EMPTY_RUNTIME_RESIDUE,
          processPids: owned.map((process) => process.pid),
          processGroupIds: [...new Set(owned.map((process) => process.processGroupId))],
          reasons: ['the process table could not be observed completely, so no process can be proven stopped'],
        },
      };
    }

    const livePids = new Set(observation.processes.map((process) => process.pid));
    const census: OwnedProcessCensusEntry[] = owned.map((process) => ({
      role: process.role,
      pid: process.pid,
      processGroupId: process.processGroupId,
      disposition: livePids.has(process.pid) ? 'remaining' : 'stopped',
    }));

    const plan = planLocalRuntimeTermination(this.manifest, observation.processes, {
      policy: this.dependencies.terminationPolicy,
    });
    const remaining = census.filter((entry) => entry.disposition === 'remaining');

    // Scope descendants to the CHILD groups.
    //
    // `planLocalRuntimeTermination` counts any live child of an owned process as a
    // descendant, and the launcher is itself an owned process — so the `ps`
    // subprocess the supervisor spawns to observe the table shows up there. That
    // is correct for termination targeting, but it is not shutdown residue: the
    // launcher is exiting and its transient helpers exit with it. Reporting them
    // made every clean shutdown read "NOT clean", which is how a receipt becomes
    // something operators learn to ignore. A grandchild in a CHILD group (the Java
    // process holding an emulator port) still reports, because that one genuinely
    // outlives the teardown.
    const childGroups = new Set(
      this.manifest.processes
        .filter((process) => process.role !== 'launcher')
        .map((process) => process.processGroupId)
    );
    const observedByPid = new Map(observation.processes.map((process) => [process.pid, process] as const));
    const childDescendantPids = plan.descendantPids.filter((pid) => {
      const observed = observedByPid.get(pid);
      return observed !== undefined && childGroups.has(observed.processGroupId);
    });

    return {
      census,
      residue: {
        ...EMPTY_RUNTIME_RESIDUE,
        processPids: remaining.map((entry) => entry.pid),
        processGroupIds: [...new Set(remaining.map((entry) => entry.processGroupId))],
        // Taken from the supervisor's own analysis rather than re-derived, so the
        // receipt and the teardown decision can never disagree.
        orphanPids: [...plan.orphanPids],
        descendantPids: childDescendantPids,
        unrecordedGroupPids: [...plan.unrecordedGroupPids],
        unanchoredGroupPids: [...plan.unanchoredGroupPids],
        reasons: [...plan.reasons],
      },
    };
  }

  async stopOwnedProcesses(): Promise<void> {
    this.recoverPausedProcessGroups();
    await terminateManifest(this.manifest, this.dependencies);
    this.processesStopped = true;
  }

  /**
   * Remove lifecycle state only after a fresh full snapshot still proves every
   * managed child/group stopped. The manifest is renamed as a rollback receipt
   * before releasing the lease, avoiding a lease-without-manifest failure.
   */
  finalizeStoppedRuntime(): void {
    if (this.finalized) return;
    if (this.activePause) throw new Error('Suspended process groups must resume before finalization.');
    if (!this.processesStopped) throw new Error('Owned processes must be stopped before finalization.');
    const verification = planLocalRuntimeTermination(
      this.manifest,
      requireCompleteSnapshot(this.dependencies).processes
    );
    if (verification.status === 'refused') {
      throw new Error(`Final process verification is ambiguous: ${verification.reasons.join('; ')}`);
    }
    if (verification.status === 'ready' && verification.target) {
      const progress = observeLocalTerminationProgress(
        verification,
        requireCompleteSnapshot(this.dependencies).processes
      );
      if (progress.status !== 'stopped') {
        throw new Error(`Owned processes remain before finalization: ${progress.remainingPids.join(', ')}.`);
      }
    }

    const manifest = readExactManifest(this.paths, this.manifest.runtimeId);
    const target = assertLocalRuntimePathContained(this.paths, this.paths.processManifest);
    const receipt = `${target}.${manifest.runtimeId}.finalizing`;
    assertLocalRuntimePathContained(this.paths, receipt, { allowMissingLeaf: true });
    if (existsSync(receipt)) throw new Error('A prior runtime finalization receipt already exists.');
    const before = lstatSync(target);
    renameSync(target, receipt);
    try {
      releaseLocalRuntimeLease(this.paths, this.lease);
    } catch (error) {
      if (!existsSync(target)) renameSync(receipt, target);
      throw error;
    }
    const retired = lstatSync(receipt);
    if (before.dev !== retired.dev || before.ino !== retired.ino) {
      throw new Error('Process manifest receipt identity changed during finalization.');
    }
    const parsed = JSON.parse(readFileSync(receipt, 'utf8')) as { runtimeId?: unknown };
    if (parsed.runtimeId !== this.manifest.runtimeId) {
      throw new Error('Process manifest receipt content changed during finalization.');
    }
    unlinkSync(receipt);
    this.finalized = true;
  }
}
