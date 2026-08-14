/**
 * @jest-environment node
 */

import { lstatSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LOCAL_TERMINATION_POLICY,
  LocalRuntimeLeaseConflictError,
  acquireLocalRuntimeLease,
  buildLocalTerminationStages,
  enumerateOwnedLocalProcesses,
  findOwnedLocalOrphans,
  fingerprintLocalProcessCommand,
  inspectLocalRuntimeLease,
  observeLocalProcessTable,
  observeLocalTerminationProgress,
  parsePosixProcessTable,
  planLocalRuntimeProcessGroupPause,
  planLocalRuntimeTermination,
  promoteLocalRuntimeLeaseToActive,
  readLocalProcessIdentityManifest,
  readLocalRuntimeLease,
  releaseLocalRuntimeLease,
  restoreFinalizingLocalProcessManifest,
  retireStaleAndAcquireLocalRuntimeLease,
  validateLocalProcessIdentityManifest,
  writeLocalProcessIdentityManifest,
  type LocalProcessIdentityManifest,
  type LocalRuntimeLeaseRecord,
  type ObservedLocalProcess,
  type OwnedLocalProcessIdentity,
} from '../lib/local-process-supervisor';
import {
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
  type LocalRuntimePaths,
} from '../lib/local-runtime-profile';

const RUNTIME_ID = 'runtime-0123456789abcdef';
const CREATED_AT = '2026-07-18T09:00:00.000Z';

function identity(
  role: OwnedLocalProcessIdentity['role'],
  pid: number,
  parentPid: number | null,
  command: string
): OwnedLocalProcessIdentity {
  return {
    role,
    pid,
    processGroupId: role === 'launcher' ? 4100 : pid,
    parentPid,
    birthMarker: `birth-${pid}`,
    commandFingerprint: fingerprintLocalProcessCommand(command),
    startedAtEpochMs: 1_752_828_400_000 + pid,
  };
}

function manifest(): LocalProcessIdentityManifest {
  return {
    version: 1,
    runtimeId: RUNTIME_ID,
    profileName: 'selftest',
    projectId: 'demo-radarist-selftest',
    createdAt: CREATED_AT,
    leaderPid: 4200,
    processes: [identity('launcher', 4200, 100, 'demo-full'), identity('firebase', 4201, 4200, 'firebase')],
  };
}

function lease(): LocalRuntimeLeaseRecord {
  return {
    version: 1,
    runtimeId: RUNTIME_ID,
    profileName: 'selftest',
    projectId: 'demo-radarist-selftest',
    acquiredAt: CREATED_AT,
    owner: manifest().processes[0],
  };
}

function observed(
  expected: OwnedLocalProcessIdentity,
  overrides: Partial<ObservedLocalProcess> = {}
): ObservedLocalProcess {
  return {
    pid: expected.pid,
    processGroupId: expected.processGroupId,
    parentPid: expected.parentPid,
    birthMarker: expected.birthMarker,
    commandFingerprint: expected.commandFingerprint,
    startedAtEpochMs: expected.startedAtEpochMs,
    ...overrides,
  };
}

describe('LOCAL-007 local process supervisor contract', () => {
  let sandbox: string;
  let paths: LocalRuntimePaths;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'radarist-process-supervisor-'));
    paths = deriveLocalRuntimePaths(sandbox, 'selftest');
    ensurePrivateLocalRuntimeLayout(paths);
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('fingerprints the executable and ordered arguments without retaining command text', () => {
    const first = fingerprintLocalProcessCommand('node', ['firebase.js', 'emulators:start']);
    const second = fingerprintLocalProcessCommand('node', ['firebase.js', 'emulators:start']);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(second);
    expect(first).not.toBe(fingerprintLocalProcessCommand('node', ['firebase.js', 'emulators:exec']));
    expect(() => fingerprintLocalProcessCommand('  ')).toThrow('must not be empty');
  });

  it('enumerates one complete POSIX process table with stable birth and command identities', () => {
    const fixture = [
      '  4200   100  4100 Sat Jul 18 09:00:00 2026 node demo-full.js --blank',
      '  4201  4200  4201 Sat Jul 18 09:00:01 2026 java -jar firebase.jar',
      '',
    ].join('\n');
    const snapshot = observeLocalProcessTable({ platform: 'darwin', read: () => fixture });
    expect(snapshot).toEqual({
      complete: true,
      processes: [
        {
          pid: 4200,
          parentPid: 100,
          processGroupId: 4100,
          birthMarker: 'Sat Jul 18 09:00:00 2026',
          commandFingerprint: fingerprintLocalProcessCommand('node demo-full.js --blank'),
          startedAtEpochMs: Date.parse('Sat Jul 18 09:00:00 2026'),
        },
        {
          pid: 4201,
          parentPid: 4200,
          processGroupId: 4201,
          birthMarker: 'Sat Jul 18 09:00:01 2026',
          commandFingerprint: fingerprintLocalProcessCommand('java -jar firebase.jar'),
          startedAtEpochMs: Date.parse('Sat Jul 18 09:00:01 2026'),
        },
      ],
    });
    expect(() => parsePosixProcessTable('not a process table')).toThrow('row 1');
    expect(() => observeLocalProcessTable({ platform: 'win32', read: () => fixture })).toThrow(
      'unavailable on Windows'
    );
  });

  it('parses the stat-bearing table format and excludes already-dead zombies', () => {
    const fixture = [
      '  4200   100  4100 Ss   Sat Jul 18 09:00:00 2026 node demo-full.js --blank',
      '  4201  4200  4201 Z+   Sat Jul 18 09:00:01 2026 (java)',
      '  4202  4200  4202 R+   Sat Jul 18 09:00:02 2026 java -jar firebase.jar',
      '',
    ].join('\n');
    const processes = parsePosixProcessTable(fixture);
    expect(processes.map((process) => process.pid)).toEqual([4200, 4202]);
    expect(processes[0]).toMatchObject({
      pid: 4200,
      parentPid: 100,
      processGroupId: 4100,
      birthMarker: 'Sat Jul 18 09:00:00 2026',
      commandFingerprint: fingerprintLocalProcessCommand('node demo-full.js --blank'),
    });
    expect(processes[0]!.commandUnreadable).toBeUndefined();
  });

  it('flags live rows whose command collapsed to the "(comm)" fallback as unreadable', () => {
    // Observed on macOS during SIGINT teardown: states S / Rs / ?E (NOT
    // zombies) with the argv already freed, so ps prints "(node)"/"(java)".
    const fixture = [
      '  4200   100  4100 Ss   Sat Jul 18 09:00:00 2026 node demo-full.js --blank',
      '  4201  4200  4201 Rs   Sat Jul 18 09:00:01 2026 (node)',
      '  4202  4201  4201 ?E   Sat Jul 18 09:00:02 2026 (java)',
      '',
    ].join('\n');
    const processes = parsePosixProcessTable(fixture);
    expect(processes.map((process) => [process.pid, process.commandUnreadable ?? false])).toEqual([
      [4200, false],
      [4201, true],
      [4202, true],
    ]);
  });

  it('validates a profile-bound process-group identity and rejects ambiguous manifests', () => {
    expect(validateLocalProcessIdentityManifest(manifest())).toEqual(manifest());
    expect(() => validateLocalProcessIdentityManifest({ ...manifest(), projectId: 'demo-radarist' })).toThrow(
      'project ID does not match'
    );
    expect(() =>
      validateLocalProcessIdentityManifest({
        ...manifest(),
        processes: [manifest().processes[0], manifest().processes[0]],
      })
    ).toThrow('repeats PID 4200');
    expect(() =>
      validateLocalProcessIdentityManifest({
        ...manifest(),
        processes: [manifest().processes[0], { ...manifest().processes[1], processGroupId: 9999 }],
      })
    ).toThrow('must lead its own');
    expect(() => validateLocalProcessIdentityManifest({ version: 1, processes: [null] })).toThrow(
      'runtime ID is invalid'
    );
    expect(() =>
      validateLocalProcessIdentityManifest({
        ...manifest(),
        processes: [null],
      })
    ).toThrow('identity has an invalid shape');
  });

  it('writes and reads an atomic 0600 manifest inside the owning profile', () => {
    const syncedDirectories: string[] = [];
    writeLocalProcessIdentityManifest(paths, manifest(), {
      syncDirectory: (path) => syncedDirectories.push(path),
    });

    expect(lstatSync(paths.processManifest).isFile()).toBe(true);
    expect(lstatSync(paths.processManifest).isSymbolicLink()).toBe(false);
    expect(lstatSync(paths.processManifest).mode & 0o777).toBe(0o600);
    expect(readLocalProcessIdentityManifest(paths)).toEqual(manifest());
    expect(syncedDirectories).toEqual([paths.pids]);
  });

  it('keeps the renamed manifest recoverable when directory fsync reports a failure', () => {
    expect(() =>
      writeLocalProcessIdentityManifest(paths, manifest(), {
        syncDirectory: () => {
          throw new Error('synthetic directory fsync failure');
        },
      })
    ).toThrow('synthetic directory fsync failure');
    expect(readLocalProcessIdentityManifest(paths)).toEqual(manifest());
  });

  it('refuses finalization receipt restoration from a partial process snapshot', () => {
    const activeLease = { ...lease(), phase: 'active' as const };
    acquireLocalRuntimeLease(paths, activeLease);
    writeLocalProcessIdentityManifest(paths, manifest());
    const receipt = `${paths.processManifest}.${RUNTIME_ID}.finalizing`;
    renameSync(paths.processManifest, receipt);
    const stale = inspectLocalRuntimeLease(paths, { complete: true, processes: [] });
    expect(stale.status).toBe('stale');
    if (stale.status !== 'stale') throw new Error('Expected a stale active lease fixture.');

    expect(() => restoreFinalizingLocalProcessManifest(paths, stale, { complete: false, processes: [] })).toThrow(
      'requires a complete process snapshot'
    );
    expect(lstatSync(receipt).isFile()).toBe(true);
    expect(() => lstatSync(paths.processManifest)).toThrow();
  });

  it('refuses to follow a symlink at the manifest boundary', () => {
    const outside = join(sandbox, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, paths.processManifest);

    expect(() => writeLocalProcessIdentityManifest(paths, manifest())).toThrow('must not be a symbolic link');
    expect(() => readLocalProcessIdentityManifest(paths)).toThrow('must not be a symbolic link');
  });

  it('atomically leases one profile and releases only the acquired inode and content', () => {
    const handle = acquireLocalRuntimeLease(paths, lease());
    expect(lstatSync(paths.runtimeLease).mode & 0o777).toBe(0o600);
    expect(inspectLocalRuntimeLease(paths)).toMatchObject({ status: 'unverified' });

    const active = { complete: true, processes: [observed(lease().owner)] } as const;
    expect(inspectLocalRuntimeLease(paths, active)).toMatchObject({ status: 'active' });
    expect(() => acquireLocalRuntimeLease(paths, lease(), active)).toThrow(LocalRuntimeLeaseConflictError);
    expect(lstatSync(paths.runtimeLease).isFile()).toBe(true);

    releaseLocalRuntimeLease(paths, handle);
    expect(inspectLocalRuntimeLease(paths)).toEqual({ status: 'available', reasons: [] });
  });

  it('atomically promotes a claiming lease and invalidates the old inode witness', () => {
    const claiming = { ...lease(), phase: 'claiming' as const };
    const claimingHandle = acquireLocalRuntimeLease(paths, claiming);
    const activeHandle = promoteLocalRuntimeLeaseToActive(paths, claimingHandle);

    expect(readLocalRuntimeLease(paths)).toMatchObject({
      runtimeId: claiming.runtimeId,
      phase: 'active',
    });
    expect(() => releaseLocalRuntimeLease(paths, claimingHandle)).toThrow('file identity changed');
    releaseLocalRuntimeLease(paths, activeHandle);
  });

  it('classifies stale leases without deleting or reclaiming them from incomplete evidence', () => {
    acquireLocalRuntimeLease(paths, lease());

    expect(inspectLocalRuntimeLease(paths, { complete: false, processes: [] })).toMatchObject({
      status: 'unverified',
    });
    expect(inspectLocalRuntimeLease(paths, { complete: true, processes: [] })).toMatchObject({
      status: 'stale',
    });
    expect(() => acquireLocalRuntimeLease(paths, lease(), { complete: true, processes: [] })).toThrow('lease is stale');
    expect(lstatSync(paths.runtimeLease).isFile()).toBe(true);
  });

  it('retires a witnessed stale lease only after complete orphan cleanup, then reacquires exclusively', () => {
    acquireLocalRuntimeLease(paths, lease());
    const completeEmpty = { complete: true, processes: [] } as const;
    const stale = inspectLocalRuntimeLease(paths, completeEmpty);
    expect(stale.status).toBe('stale');
    if (stale.status !== 'stale') throw new Error('Expected a stale lease fixture.');
    const replacement: LocalRuntimeLeaseRecord = {
      ...lease(),
      runtimeId: 'runtime-fedcba9876543210',
      acquiredAt: '2026-07-18T10:00:00.000Z',
      owner: identity('launcher', 5200, 100, 'demo-full-restart'),
    };

    const handle = retireStaleAndAcquireLocalRuntimeLease(paths, stale, manifest(), completeEmpty, replacement);
    expect(inspectLocalRuntimeLease(paths, { complete: true, processes: [observed(replacement.owner)] })).toMatchObject(
      {
        status: 'active',
        lease: { runtimeId: replacement.runtimeId },
      }
    );
    releaseLocalRuntimeLease(paths, handle);
  });

  it('does not retire a stale launcher lease while a verified managed child survives', () => {
    acquireLocalRuntimeLease(paths, lease());
    const childSurvives = { complete: true, processes: [observed(manifest().processes[1], { parentPid: 1 })] } as const;
    const stale = inspectLocalRuntimeLease(paths, childSurvives);
    expect(stale.status).toBe('stale');
    if (stale.status !== 'stale') throw new Error('Expected a stale lease fixture.');

    expect(() =>
      retireStaleAndAcquireLocalRuntimeLease(paths, stale, manifest(), childSurvives, {
        ...lease(),
        runtimeId: 'runtime-fedcba9876543210',
        owner: identity('launcher', 5200, 100, 'demo-full-restart'),
      })
    ).toThrow('cleanup is incomplete');
    expect(inspectLocalRuntimeLease(paths, childSurvives)).toMatchObject({ status: 'stale' });
  });

  it('refuses symlinked, replaced, or content-mutated lifetime leases', () => {
    const outside = join(sandbox, 'outside-lease');
    writeFileSync(outside, '{}');
    symlinkSync(outside, paths.runtimeLease);
    expect(inspectLocalRuntimeLease(paths)).toMatchObject({ status: 'refused' });
    expect(() => acquireLocalRuntimeLease(paths, lease())).toThrow('must not be a symbolic link');

    rmSync(paths.runtimeLease);
    const handle = acquireLocalRuntimeLease(paths, lease());
    writeFileSync(paths.runtimeLease, '{}', { mode: 0o600 });
    expect(() => releaseLocalRuntimeLease(paths, handle)).toThrow('content changed');
  });

  it('builds a bounded INT to TERM to KILL plan for an exactly anchored process group', () => {
    const current = manifest();
    const observations = current.processes.map((process) => observed(process));
    observations.push({
      ...observed(current.processes[1]),
      pid: 4299,
      parentPid: 4201,
      birthMarker: 'birth-4299',
      commandFingerprint: fingerprintLocalProcessCommand('java'),
      startedAtEpochMs: 1_752_828_404_299,
    });

    expect(planLocalRuntimeTermination(current, observations, { platform: 'darwin' })).toMatchObject({
      status: 'ready',
      leaderPid: 4200,
      target: { kind: 'owned-process-set', processGroupIds: [4201], pids: [] },
      stages: [
        { signal: 'SIGINT', graceMs: 15_000, pollIntervalMs: 100 },
        { signal: 'SIGTERM', graceMs: 5_000, pollIntervalMs: 100 },
        { signal: 'SIGKILL', graceMs: 2_000, pollIntervalMs: 100 },
      ],
      exactProcessPids: [4200, 4201],
      ownedProcessPids: [4200, 4201, 4299],
      descendantPids: [4299],
      orphanPids: [],
      unrecordedGroupPids: [4299],
      unanchoredGroupPids: [],
      reasons: [],
    });
  });

  it('plans checkpoint suspension only from exact selected leaders in one complete snapshot', () => {
    const current = manifest();
    const next = identity('next', 4202, 4200, 'next start');
    const inngest = identity('inngest', 4203, 4200, 'inngest dev');
    const withWriters: LocalProcessIdentityManifest = {
      ...current,
      processes: [...current.processes, next, inngest],
    };
    const nextWorker: ObservedLocalProcess = {
      ...observed(next),
      pid: 4299,
      parentPid: next.pid,
      birthMarker: 'birth-4299',
      commandFingerprint: fingerprintLocalProcessCommand('next worker'),
      startedAtEpochMs: 1_752_828_404_299,
    };

    expect(
      planLocalRuntimeProcessGroupPause(
        withWriters,
        {
          complete: true,
          processes: [...withWriters.processes.map((process) => observed(process)), nextWorker],
        },
        ['next', 'inngest']
      )
    ).toMatchObject({
      status: 'ready',
      roles: ['inngest', 'next'],
      groups: [
        { processGroupId: next.processGroupId, members: [{ pid: next.pid }, { pid: nextWorker.pid }] },
        { processGroupId: inngest.processGroupId, members: [{ pid: inngest.pid }] },
      ],
      reasons: [],
    });
  });

  it('refuses partial, reused, and unanchored writer snapshots without producing targets', () => {
    const next = identity('next', 4202, 4200, 'next start');
    const withWriter: LocalProcessIdentityManifest = {
      ...manifest(),
      processes: [...manifest().processes, next],
    };
    expect(
      planLocalRuntimeProcessGroupPause(withWriter, { complete: false, processes: [observed(next)] }, ['next'])
    ).toMatchObject({ status: 'refused', groups: [] });
    expect(
      planLocalRuntimeProcessGroupPause(
        withWriter,
        {
          complete: true,
          processes: [observed(next, { birthMarker: 'reused-next' })],
        },
        ['next']
      )
    ).toMatchObject({
      status: 'refused',
      groups: [],
      reasons: [expect.stringMatching(/reused/)],
    });
    expect(
      planLocalRuntimeProcessGroupPause(
        withWriter,
        {
          complete: true,
          processes: [
            {
              ...observed(next),
              pid: 4299,
              parentPid: 1,
              birthMarker: 'birth-4299',
              commandFingerprint: fingerprintLocalProcessCommand('unanchored writer'),
              startedAtEpochMs: 1_752_828_404_299,
            },
          ],
        },
        ['next']
      )
    ).toMatchObject({
      status: 'refused',
      groups: [],
      reasons: [expect.stringMatching(/no exact registered leader/)],
    });
  });

  it('keeps an owned group live after its wrapper exits and discovers nested descendant groups', () => {
    const current = manifest();
    const initial = current.processes.map((process) => observed(process));
    initial.push({
      ...observed(current.processes[1]),
      pid: 4299,
      parentPid: 4201,
      birthMarker: 'birth-4299',
      commandFingerprint: fingerprintLocalProcessCommand('java-worker'),
      startedAtEpochMs: 1_752_828_404_299,
    });
    const plan = planLocalRuntimeTermination(current, initial, { platform: 'darwin' });

    const afterWrapperExit: ObservedLocalProcess[] = [
      { ...initial[2], parentPid: 1 },
      {
        ...initial[2],
        pid: 4300,
        processGroupId: 4300,
        parentPid: 4299,
        birthMarker: 'birth-4300',
        commandFingerprint: fingerprintLocalProcessCommand('nested-worker'),
        startedAtEpochMs: 1_752_828_404_300,
      },
    ];
    const progress = observeLocalTerminationProgress(plan, afterWrapperExit, { platform: 'darwin' });
    expect(progress).toEqual({
      status: 'running',
      target: { kind: 'owned-process-set', processGroupIds: [4201, 4300], pids: [] },
      remainingPids: [4299, 4300],
      reasons: [],
    });
    expect(observeLocalTerminationProgress(plan, [], { platform: 'darwin' })).toMatchObject({
      status: 'stopped',
      remainingPids: [],
    });
  });

  it('keeps a dying group anchored when live members collapse to the "(comm)" fallback mid-shutdown', () => {
    // Regression for the LOCAL-009 retained-restart refusal: on macOS SIGINT
    // teardown, ps reports LIVE group members (states S/Rs/?E) with their
    // command collapsed to "(node)". Both members then read as "changed
    // command identity", the group lost its anchor, and a clean shutdown was
    // refused even though every process exited moments later.
    const current = manifest();
    const wrapper = observed(current.processes[1]);
    const member: ObservedLocalProcess = {
      ...wrapper,
      pid: 4250,
      parentPid: 4201,
      birthMarker: 'birth-4250',
      commandFingerprint: fingerprintLocalProcessCommand('node node_modules/.bin/firebase emulators:start'),
      startedAtEpochMs: 1_752_828_404_250,
    };
    const initial = [observed(current.processes[0]), wrapper, member];
    const plan = planLocalRuntimeTermination(current, initial, { platform: 'darwin' });
    expect(plan.status).toBe('ready');

    const fallbackFingerprint = fingerprintLocalProcessCommand('(node)');
    const dying: ObservedLocalProcess[] = [
      { ...wrapper, commandFingerprint: fallbackFingerprint, commandUnreadable: true },
      { ...member, commandFingerprint: fallbackFingerprint, commandUnreadable: true },
    ];
    const progress = observeLocalTerminationProgress(plan, dying, { platform: 'darwin' });
    expect(progress).toMatchObject({
      status: 'running',
      remainingPids: [4201, 4250],
      reasons: [],
    });
    expect(observeLocalTerminationProgress(plan, [], { platform: 'darwin' })).toMatchObject({
      status: 'stopped',
      remainingPids: [],
    });

    // The tolerance never weakens PID-reuse detection: an unreadable command
    // with a different birth identity is still a recycled PID and refuses.
    const recycled: ObservedLocalProcess[] = [
      {
        ...wrapper,
        birthMarker: 'birth-recycled',
        commandFingerprint: fallbackFingerprint,
        commandUnreadable: true,
      },
    ];
    const refused = observeLocalTerminationProgress(plan, recycled, { platform: 'darwin' });
    expect(refused.status).toBe('refused');
    expect(refused.reasons.join('; ')).toContain('has been reused');
  });

  it('refuses to adopt an original process group after its authenticated identities exit', () => {
    const current = manifest();
    const initial = current.processes.map((process) => observed(process));
    const plan = planLocalRuntimeTermination(current, initial, { platform: 'darwin' });
    const unrelated: ObservedLocalProcess = {
      pid: 4299,
      processGroupId: 4201,
      parentPid: 1,
      birthMarker: 'unrelated-birth-4299',
      commandFingerprint: fingerprintLocalProcessCommand('unrelated-worker'),
      startedAtEpochMs: 1_752_828_404_299,
    };

    expect(observeLocalTerminationProgress(plan, [unrelated], { platform: 'darwin' })).toEqual({
      status: 'refused',
      target: { kind: 'owned-process-set', processGroupIds: [], pids: [] },
      remainingPids: [],
      reasons: ['Retained process group 4201 has live members but no current exact stable identity anchor: 4299'],
    });
  });

  it('refuses a retained group when its recorded anchor PID was reused', () => {
    const current = manifest();
    const initial = current.processes.map((process) => observed(process));
    const plan = planLocalRuntimeTermination(current, initial, { platform: 'darwin' });
    const reusedAnchor = observed(current.processes[1], {
      birthMarker: 'reused-birth-4201',
      commandFingerprint: fingerprintLocalProcessCommand('unrelated-wrapper'),
    });
    const unrelatedMember: ObservedLocalProcess = {
      pid: 4299,
      processGroupId: 4201,
      parentPid: 4201,
      birthMarker: 'unrelated-birth-4299',
      commandFingerprint: fingerprintLocalProcessCommand('unrelated-worker'),
      startedAtEpochMs: 1_752_828_404_299,
    };

    const progress = observeLocalTerminationProgress(plan, [reusedAnchor, unrelatedMember], { platform: 'darwin' });
    expect(progress).toMatchObject({
      status: 'refused',
      target: { kind: 'owned-process-set', processGroupIds: [], pids: [] },
      remainingPids: [],
    });
    expect(progress.reasons).toContain(
      'Retained process group 4201 has live members but no current exact stable identity anchor: 4201, 4299'
    );
    expect(progress.reasons).toContain('PID 4201 has been reused');
  });

  it('refuses a live recorded group that no exact identity or ancestry can authenticate', () => {
    const current = manifest();
    const stranded: ObservedLocalProcess = {
      pid: 4299,
      processGroupId: 4201,
      parentPid: 1,
      birthMarker: 'birth-4299',
      commandFingerprint: fingerprintLocalProcessCommand('stranded-worker'),
      startedAtEpochMs: 1_752_828_404_299,
    };
    expect(planLocalRuntimeTermination(current, [stranded], { platform: 'darwin' })).toMatchObject({
      status: 'refused',
      unanchoredGroupPids: [4299],
    });
  });

  it('enumerates recursive descendants outside the initially recorded group', () => {
    const current = manifest();
    const observations = current.processes.map((process) => observed(process));
    observations.push({
      ...observed(current.processes[1]),
      pid: 4300,
      processGroupId: 4300,
      parentPid: 4201,
      birthMarker: 'birth-4300',
      commandFingerprint: fingerprintLocalProcessCommand('nested-group'),
      startedAtEpochMs: 1_752_828_404_300,
    });
    expect(enumerateOwnedLocalProcesses(current, observations, { platform: 'darwin' })).toMatchObject({
      ownedProcessPids: [4200, 4201, 4300],
      descendantPids: [4300],
      processGroupIds: [4201, 4300],
      supplementalPids: [],
    });
  });

  it('recognizes exact recorded children as orphans after their launcher exits', () => {
    const current = manifest();
    const firebase = observed(current.processes[1], { parentPid: 1 });

    expect(findOwnedLocalOrphans(current, [firebase])).toEqual([firebase]);
    expect(planLocalRuntimeTermination(current, [firebase], { platform: 'darwin' })).toMatchObject({
      status: 'ready',
      target: { kind: 'owned-process-set', processGroupIds: [4201], pids: [] },
      exactProcessPids: [4201],
      orphanPids: [4201],
    });
  });

  it('refuses reused or command-mismatched PIDs instead of signaling by number alone', () => {
    const current = manifest();
    const reusedLeader = observed(current.processes[0], {
      birthMarker: 'different-process-birth',
      commandFingerprint: fingerprintLocalProcessCommand('unrelated'),
    });

    expect(planLocalRuntimeTermination(current, [reusedLeader], { platform: 'darwin' })).toMatchObject({
      status: 'refused',
      stages: [],
      exactProcessPids: [],
    });
    const result = planLocalRuntimeTermination(current, [reusedLeader], { platform: 'darwin' });
    expect(result.reasons).toContain('PID 4200 has been reused');
  });

  it('rejects duplicate process observations as ambiguous input', () => {
    const current = manifest();
    const leader = observed(current.processes[0]);
    expect(() => planLocalRuntimeTermination(current, [leader, leader], { platform: 'darwin' })).toThrow(
      'repeats PID 4200'
    );
  });

  it('does nothing when no exact identity remains, even if a process reuses the old group number', () => {
    const unrelated: ObservedLocalProcess = {
      pid: 9999,
      processGroupId: 4201,
      parentPid: 1,
      birthMarker: 'unrelated-birth',
      commandFingerprint: fingerprintLocalProcessCommand('unrelated'),
      startedAtEpochMs: 1_752_828_499_999,
    };
    expect(planLocalRuntimeTermination(manifest(), [unrelated], { platform: 'darwin' })).toEqual({
      status: 'refused',
      leaderPid: 4200,
      stages: [],
      exactProcessPids: [],
      ownedProcessPids: [],
      descendantPids: [],
      orphanPids: [],
      unrecordedGroupPids: [9999],
      unanchoredGroupPids: [9999],
      ownedProcesses: [],
      reasons: ['Recorded process groups contain unauthenticated live members: 9999'],
    });
  });

  it('uses exact individual PIDs on Windows and rejects unbounded policies', () => {
    const current = manifest();
    const observations = current.processes.map((process) => observed(process));
    expect(planLocalRuntimeTermination(current, observations, { platform: 'win32' }).target).toEqual({
      kind: 'owned-process-set',
      processGroupIds: [],
      pids: [4201],
    });
    expect(buildLocalTerminationStages(DEFAULT_LOCAL_TERMINATION_POLICY)).toHaveLength(3);
    expect(() =>
      buildLocalTerminationStages({
        sigintGraceMs: 60_000,
        sigtermGraceMs: 60_000,
        sigkillGraceMs: 60_000,
        pollIntervalMs: 100,
      })
    ).toThrow('unbounded');
    expect(() =>
      buildLocalTerminationStages({
        ...DEFAULT_LOCAL_TERMINATION_POLICY,
        pollIntervalMs: 1,
      })
    ).toThrow('between 10ms and 5000ms');
  });
});
