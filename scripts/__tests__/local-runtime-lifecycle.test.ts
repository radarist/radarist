/** @jest-environment node */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalRuntimeLifecycle,
  shouldRemoveRetiredEphemeralNeo4j,
  type LocalRuntimeProcessControlSignal,
} from '../lib/local-runtime-lifecycle';
import {
  acquireLocalRuntimeLease,
  fingerprintLocalProcessCommand,
  readLocalProcessIdentityManifest,
  readLocalRuntimeLease,
  type LocalProcessObservationSnapshot,
  type LocalTerminationTarget,
  type ObservedLocalProcess,
} from '../lib/local-process-supervisor';
import {
  deriveLocalRuntimePaths,
  ensurePrivateLocalRuntimeLayout,
  type LocalRuntimePaths,
} from '../lib/local-runtime-profile';

function observed(
  pid: number,
  processGroupId: number,
  parentPid: number | null,
  command: string,
  birthMarker = `birth-${pid}`
): ObservedLocalProcess {
  return {
    pid,
    processGroupId,
    parentPid,
    birthMarker,
    commandFingerprint: fingerprintLocalProcessCommand(command),
    startedAtEpochMs: 1_753_000_000_000 + pid,
  };
}

describe('local runtime lifecycle adapter', () => {
  let sandbox: string;
  let paths: LocalRuntimePaths;
  let processes: ObservedLocalProcess[];
  const launcher = observed(4200, 4100, 100, 'demo-full');

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'radarist-runtime-lifecycle-'));
    paths = ensurePrivateLocalRuntimeLayout(deriveLocalRuntimePaths(sandbox, 'selftest'));
    processes = [launcher];
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function snapshot(): LocalProcessObservationSnapshot {
    return { complete: true, processes };
  }

  it('claims before spawn, registers and stabilizes identities, then waits for every group descendant', async () => {
    const signals: Array<{ target: LocalTerminationTarget; signal: string }> = [];
    let clock = 1_753_000_000_000;
    const lifecycle = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
        nowEpochMs: () => clock,
        terminationPolicy: {
          sigintGraceMs: 20,
          sigtermGraceMs: 20,
          sigkillGraceMs: 20,
          pollIntervalMs: 10,
        },
        signal: (target, signal) => {
          signals.push({ target, signal });
          if (signal === 'SIGINT') {
            processes = [launcher, observed(4299, 4201, 1, 'firebase-java')];
          }
        },
        sleep: async (milliseconds) => {
          clock += milliseconds;
          processes = [launcher];
        },
      },
    });
    expect(existsSync(paths.runtimeLease)).toBe(true);
    expect(readLocalRuntimeLease(paths).phase).toBe('active');
    expect(readLocalProcessIdentityManifest(paths).processes).toHaveLength(1);

    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);
    processes = [launcher, observed(4201, 4201, 4200, 'node firebase-tools')];
    lifecycle.refreshProcess(4201);
    expect(readLocalProcessIdentityManifest(paths).processes[1].commandFingerprint).toBe(
      fingerprintLocalProcessCommand('node firebase-tools')
    );

    processes = [
      launcher,
      observed(4201, 4201, 4200, 'node firebase-tools'),
      observed(4299, 4201, 4201, 'firebase-java'),
    ];
    await lifecycle.stopOwnedProcesses();
    expect(signals[0]).toEqual({
      target: { kind: 'owned-process-set', processGroupIds: [4201], pids: [] },
      signal: 'SIGINT',
    });
    lifecycle.finalizeStoppedRuntime();
    expect(existsSync(paths.processManifest)).toBe(false);
    expect(existsSync(paths.runtimeLease)).toBe(false);
  });

  it('suspends and resumes only freshly authenticated registered writer groups', async () => {
    const controlSignals: Array<{
      target: LocalTerminationTarget;
      signal: LocalRuntimeProcessControlSignal;
    }> = [];
    const lifecycle = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
        controlSignal: (target, signal) => controlSignals.push({ target, signal }),
      },
    });
    const next = observed(4201, 4201, launcher.pid, 'next start');
    const inngest = observed(4202, 4202, launcher.pid, 'inngest dev');
    processes = [launcher, next];
    lifecycle.registerProcess('next', next.pid);
    processes = [launcher, next, inngest];
    lifecycle.registerProcess('inngest', inngest.pid);
    processes.push(observed(4299, next.processGroupId, next.pid, 'next worker'));

    const token = lifecycle.pauseProcessGroups(['next', 'inngest']);
    expect(controlSignals).toEqual([
      {
        target: { kind: 'owned-process-set', processGroupIds: [next.processGroupId], pids: [] },
        signal: 'SIGSTOP',
      },
      {
        target: { kind: 'owned-process-set', processGroupIds: [inngest.processGroupId], pids: [] },
        signal: 'SIGSTOP',
      },
    ]);

    lifecycle.resumeProcessGroups(token);
    expect(controlSignals.slice(2)).toEqual([
      {
        target: { kind: 'owned-process-set', processGroupIds: [inngest.processGroupId], pids: [] },
        signal: 'SIGCONT',
      },
      {
        target: { kind: 'owned-process-set', processGroupIds: [next.processGroupId], pids: [] },
        signal: 'SIGCONT',
      },
    ]);
    expect(() => lifecycle.resumeProcessGroups(token)).toThrow('stale, foreign, or already consumed');
  });

  it('rolls back an established partial pause and never hides the original signal failure', async () => {
    const controlSignals: Array<{ group: number; signal: LocalRuntimeProcessControlSignal }> = [];
    const lifecycle = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
        controlSignal: (target, signal) => {
          const group = target.kind === 'process-list' ? -1 : target.processGroupIds[0];
          controlSignals.push({ group, signal });
          if (signal === 'SIGSTOP' && group === 4202) throw new Error('synthetic stop failure');
        },
      },
    });
    const next = observed(4201, 4201, launcher.pid, 'next start');
    const inngest = observed(4202, 4202, launcher.pid, 'inngest dev');
    processes = [launcher, next];
    lifecycle.registerProcess('next', next.pid);
    processes = [launcher, next, inngest];
    lifecycle.registerProcess('inngest', inngest.pid);

    expect(() => lifecycle.pauseProcessGroups(['next', 'inngest'])).toThrow(
      'synthetic stop failure'
    );
    expect(controlSignals).toEqual([
      { group: next.processGroupId, signal: 'SIGSTOP' },
      { group: inngest.processGroupId, signal: 'SIGSTOP' },
      { group: next.processGroupId, signal: 'SIGCONT' },
    ]);
    expect(() => lifecycle.recoverPausedProcessGroups()).not.toThrow();
  });

  it('retains failed cleanup for retry and refuses to resume a reused group identity', async () => {
    let failResume = true;
    const controlSignals: LocalRuntimeProcessControlSignal[] = [];
    const logs: string[] = [];
    const lifecycle = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
        log: (message) => logs.push(message),
        controlSignal: (_target, signal) => {
          controlSignals.push(signal);
          if (signal === 'SIGCONT' && failResume) throw new Error('synthetic resume failure');
        },
      },
    });
    const next = observed(4201, 4201, launcher.pid, 'next start');
    processes = [launcher, next];
    lifecycle.registerProcess('next', next.pid);
    const token = lifecycle.pauseProcessGroups(['next']);

    expect(() => lifecycle.resumeProcessGroups(token)).toThrow('verified writer groups could not resume');
    failResume = false;
    lifecycle.recoverPausedProcessGroups();
    expect(controlSignals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGCONT']);

    const secondToken = lifecycle.pauseProcessGroups(['next']);
    processes = [launcher, { ...next, birthMarker: 'reused-next' }];
    lifecycle.resumeProcessGroups(secondToken);
    expect(controlSignals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGCONT', 'SIGSTOP']);
    expect(logs).toEqual([expect.stringMatching(/Skipped SIGCONT.*unanchored or reused/)]);
  });

  it('reclaims only a fully verified stale runtime and exposes its owner for external cleanup', async () => {
    await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-aaaaaaaaaaaaaaaa',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
      },
    });

    const replacement = observed(5200, 5100, 100, 'demo-full-restart');
    processes = [replacement];
    const recovered = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
      acquiredAt: '2026-07-19T09:00:00.000Z',
      dependencies: {
        currentPid: replacement.pid,
        observeProcesses: snapshot,
      },
    });
    expect(recovered.retiredRuntimeId).toBe('runtime-aaaaaaaaaaaaaaaa');
    expect(recovered.runtimeId).toBe('runtime-bbbbbbbbbbbbbbbb');
    await recovered.stopOwnedProcesses();
    recovered.finalizeStoppedRuntime();
  });

  it('recovers the witnessed pre-manifest claim window but keeps the replacement active', async () => {
    acquireLocalRuntimeLease(paths, {
      version: 1,
      runtimeId: 'runtime-aaaaaaaaaaaaaaaa',
      profileName: 'selftest',
      projectId: 'demo-radarist-selftest',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      phase: 'claiming',
      owner: { role: 'launcher', ...launcher },
    });

    const replacement = observed(5200, 5100, 100, 'demo-full-restart');
    processes = [replacement];
    const recovered = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
      acquiredAt: '2026-07-19T09:00:00.000Z',
      dependencies: {
        currentPid: replacement.pid,
        observeProcesses: snapshot,
      },
    });

    expect(recovered.retiredRuntimeId).toBe('runtime-aaaaaaaaaaaaaaaa');
    expect(readLocalRuntimeLease(paths)).toMatchObject({
      runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
      phase: 'active',
    });
    await recovered.stopOwnedProcesses();
    recovered.finalizeStoppedRuntime();
  });

  it('recovers an exact active-lease finalization receipt after a launcher crash', async () => {
    await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-aaaaaaaaaaaaaaaa',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
      },
    });
    const receipt = `${paths.processManifest}.runtime-aaaaaaaaaaaaaaaa.finalizing`;
    renameSync(paths.processManifest, receipt);

    const replacement = observed(5200, 5100, 100, 'demo-full-restart');
    processes = [replacement];
    const recovered = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
      acquiredAt: '2026-07-19T09:00:00.000Z',
      dependencies: {
        currentPid: replacement.pid,
        observeProcesses: snapshot,
      },
    });

    expect(recovered.retiredRuntimeId).toBe('runtime-aaaaaaaaaaaaaaaa');
    expect(existsSync(receipt)).toBe(false);
    expect(readLocalRuntimeLease(paths)).toMatchObject({
      runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
      phase: 'active',
    });
    await recovered.stopOwnedProcesses();
    recovered.finalizeStoppedRuntime();
  });

  it('fails closed when a finalization receipt does not match its active lease owner', async () => {
    await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-aaaaaaaaaaaaaaaa',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
      },
    });
    const receipt = `${paths.processManifest}.runtime-aaaaaaaaaaaaaaaa.finalizing`;
    renameSync(paths.processManifest, receipt);
    const parsed = JSON.parse(readFileSync(receipt, 'utf8')) as {
      processes: Array<{ birthMarker: string }>;
    };
    parsed.processes[0].birthMarker = 'tampered-launcher-birth';
    writeFileSync(receipt, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    const replacement = observed(5200, 5100, 100, 'demo-full-restart');
    processes = [replacement];
    await expect(
      LocalRuntimeLifecycle.claim({
        paths,
        runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
        acquiredAt: '2026-07-19T09:00:00.000Z',
        dependencies: {
          currentPid: replacement.pid,
          observeProcesses: snapshot,
        },
      })
    ).rejects.toThrow('launcher identity does not match');
    expect(existsSync(paths.runtimeLease)).toBe(true);
    expect(existsSync(receipt)).toBe(true);
    expect(existsSync(paths.processManifest)).toBe(false);
  });

  it('selects the manifest launcher by leaderPid when no lease exists', async () => {
    const child = observed(4201, 4201, launcher.pid, 'firebase');
    const old = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-aaaaaaaaaaaaaaaa',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
      },
    });
    processes = [launcher, child];
    old.registerProcess('firebase', child.pid);
    const reordered = readLocalProcessIdentityManifest(paths);
    writeFileSync(
      paths.processManifest,
      `${JSON.stringify({ ...reordered, processes: [...reordered.processes].reverse() }, null, 2)}\n`,
      { mode: 0o600 }
    );
    rmSync(paths.runtimeLease);

    const replacement = observed(5200, 5100, 100, 'demo-full-restart');
    processes = [launcher, replacement];
    await expect(
      LocalRuntimeLifecycle.claim({
        paths,
        runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
        acquiredAt: '2026-07-19T09:00:00.000Z',
        dependencies: {
          currentPid: replacement.pid,
          observeProcesses: snapshot,
        },
      })
    ).rejects.toThrow('active runtime has a process manifest but no lease');
    expect(existsSync(paths.processManifest)).toBe(true);
  });

  it.each([undefined, 'active'] as const)(
    'refuses manifest-less recovery for a legacy or %s lease',
    async (phase) => {
      acquireLocalRuntimeLease(paths, {
        version: 1,
        runtimeId: 'runtime-aaaaaaaaaaaaaaaa',
        profileName: 'selftest',
        projectId: 'demo-radarist-selftest',
        acquiredAt: '2026-07-19T08:00:00.000Z',
        ...(phase ? { phase } : {}),
        owner: { role: 'launcher', ...launcher },
      });
      const replacement = observed(5200, 5100, 100, 'demo-full-restart');
      processes = [replacement];

      await expect(
        LocalRuntimeLifecycle.claim({
          paths,
          runtimeId: 'runtime-bbbbbbbbbbbbbbbb',
          acquiredAt: '2026-07-19T09:00:00.000Z',
          dependencies: {
            currentPid: replacement.pid,
            observeProcesses: snapshot,
          },
        })
      ).rejects.toThrow(
        phase === 'active'
          ? 'exact finalization receipt is missing'
          : 'requires an explicit claiming phase'
      );
    }
  );

  it('fails closed when the process observation is partial', async () => {
    await expect(
      LocalRuntimeLifecycle.claim({
        paths,
        runtimeId: 'runtime-0123456789abcdef',
        acquiredAt: '2026-07-19T08:00:00.000Z',
        dependencies: {
          currentPid: launcher.pid,
          observeProcesses: () => ({ complete: false, processes: [launcher] }),
        },
      })
    ).rejects.toThrow('requires a complete process snapshot');
    expect(existsSync(paths.runtimeLease)).toBe(false);
  });

  it('derives live orphan telemetry from the current process snapshot', async () => {
    const lifecycle = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
      },
    });
    const firebase = observed(4201, 4201, launcher.pid, 'node firebase-tools');
    processes = [launcher, firebase];
    lifecycle.registerProcess('firebase', firebase.pid);

    expect(lifecycle.inspectOwnership()).toEqual({
      orphanPids: [],
      orphanCount: 0,
      ambiguous: false,
      reasons: [],
    });

    processes = [{ ...launcher, parentPid: null }, { ...firebase, parentPid: 1 }];
    expect(lifecycle.inspectOwnership()).toEqual({
      orphanPids: [firebase.pid],
      orphanCount: 1,
      ambiguous: false,
      reasons: [],
    });
  });

  it('marks reused recorded identities as ambiguous without counting them as owned', async () => {
    const lifecycle = await LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
      },
    });
    const firebase = observed(4201, 4201, launcher.pid, 'node firebase-tools');
    processes = [launcher, firebase];
    lifecycle.registerProcess('firebase', firebase.pid);
    processes = [launcher, { ...firebase, birthMarker: 'reused-process' }];

    expect(lifecycle.inspectOwnership()).toMatchObject({
      orphanCount: 0,
      ambiguous: true,
      reasons: [expect.stringMatching(/reused/)],
    });
  });

  it('authorizes stale ephemeral Neo4j removal only for both exact ownership labels', () => {
    expect(
      shouldRemoveRetiredEphemeralNeo4j({
        profileName: 'selftest',
        retiredRuntimeId: 'runtime-aaaaaaaaaaaaaaaa',
        runtimeLabel: 'ephemeral:selftest',
        ownerLabel: 'runtime-aaaaaaaaaaaaaaaa',
      })
    ).toBe(true);
    expect(() =>
      shouldRemoveRetiredEphemeralNeo4j({
        profileName: 'selftest',
        runtimeLabel: 'ephemeral:selftest',
        ownerLabel: 'runtime-aaaaaaaaaaaaaaaa',
      })
    ).toThrow('no verified retired runtime owner');
    expect(() =>
      shouldRemoveRetiredEphemeralNeo4j({
        profileName: 'selftest',
        retiredRuntimeId: 'runtime-aaaaaaaaaaaaaaaa',
        runtimeLabel: 'durable:selftest',
        ownerLabel: 'runtime-aaaaaaaaaaaaaaaa',
      })
    ).toThrow('another runtime mode or profile');
    expect(() =>
      shouldRemoveRetiredEphemeralNeo4j({
        profileName: 'selftest',
        retiredRuntimeId: 'runtime-aaaaaaaaaaaaaaaa',
        runtimeLabel: 'ephemeral:selftest',
        ownerLabel: 'runtime-other-owner',
      })
    ).toThrow('does not match');
  });
});
