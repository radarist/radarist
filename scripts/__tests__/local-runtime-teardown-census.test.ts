/**
 * @jest-environment node
 * @file scripts/__tests__/local-runtime-teardown-census.test.ts
 * @description LOCAL-012 — the lifecycle can REPORT what it tore down.
 *
 * `planLocalRuntimeTermination` already computes orphan, descendant, unrecorded
 * and unanchored pids with reasons, and `finalizeStoppedRuntime` already refuses
 * to release the lease unless a fresh snapshot proves everything stopped. None of
 * that was reachable by the launcher, so a `SIGINT` that left four child process
 * groups alive told the operator only that "cleanup failed" — the pids the
 * supervisor had already identified never reached the terminal.
 *
 * These cases pin the reporting surface: an accurate per-role disposition, and
 * residue drawn from the supervisor's own analysis rather than re-derived.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRuntimeLifecycle } from '../lib/local-runtime-lifecycle';
import {
  fingerprintLocalProcessCommand,
  type LocalProcessObservationSnapshot,
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
  command: string
): ObservedLocalProcess {
  return {
    pid,
    processGroupId,
    parentPid,
    birthMarker: `birth-${pid}`,
    commandFingerprint: fingerprintLocalProcessCommand(command),
    startedAtEpochMs: 1_753_000_000_000 + pid,
  };
}

describe('LocalRuntimeLifecycle.describeOwnedProcesses (LOCAL-012)', () => {
  let sandbox: string;
  let paths: LocalRuntimePaths;
  let processes: ObservedLocalProcess[];
  const launcher = observed(4200, 4100, 100, 'demo-full');

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'radarist-teardown-census-'));
    paths = ensurePrivateLocalRuntimeLayout(deriveLocalRuntimePaths(sandbox, 'selftest'));
    processes = [launcher];
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  function snapshot(): LocalProcessObservationSnapshot {
    return { complete: true, processes };
  }

  async function claim(): Promise<LocalRuntimeLifecycle> {
    return LocalRuntimeLifecycle.claim({
      paths,
      runtimeId: 'runtime-0123456789abcdef',
      acquiredAt: '2026-07-19T08:00:00.000Z',
      dependencies: {
        currentPid: launcher.pid,
        observeProcesses: snapshot,
        nowEpochMs: () => 1_753_000_000_000,
      },
    });
  }

  it('reports every registered child as stopped once none survive', async () => {
    const lifecycle = await claim();
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);
    processes = [launcher, observed(4202, 4202, 4200, 'next dev')];
    lifecycle.registerProcess('next', 4202);

    // Both children gone.
    processes = [launcher];
    const report = lifecycle.describeOwnedProcesses();

    expect(report.census).toEqual([
      { role: 'firebase', pid: 4201, processGroupId: 4201, disposition: 'stopped' },
      { role: 'next', pid: 4202, processGroupId: 4202, disposition: 'stopped' },
    ]);
    expect(report.residue.processPids).toEqual([]);
    expect(report.residue.processGroupIds).toEqual([]);
  });

  it('names each surviving child and its process group', async () => {
    const lifecycle = await claim();
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase'), observed(4202, 4202, 4200, 'next dev')];
    lifecycle.registerProcess('next', 4202);

    const report = lifecycle.describeOwnedProcesses();

    expect(report.census).toEqual([
      { role: 'firebase', pid: 4201, processGroupId: 4201, disposition: 'remaining' },
      { role: 'next', pid: 4202, processGroupId: 4202, disposition: 'remaining' },
    ]);
    // The exact detail the operator had to reconstruct by hand.
    expect(report.residue.processPids).toEqual([4201, 4202]);
    expect(report.residue.processGroupIds).toEqual([4201, 4202]);
  });

  it('surfaces a group descendant the manifest never recorded', async () => {
    // A Java child of the Firebase CLI is not in the manifest, but it holds the
    // emulator ports. Leaving it out of the residue is how a "clean" shutdown
    // still blocks the next start.
    const lifecycle = await claim();
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase'), observed(4299, 4201, 4201, 'firebase-java')];

    const report = lifecycle.describeOwnedProcesses();

    expect(report.residue.descendantPids).toContain(4299);
  });

  it('does not report the launcher\'s own transient children as residue', async () => {
    // Found by the live acceptance run, not by inspection. `planLocalRuntimeTermination`
    // treats any live child of an owned process as a descendant, and the LAUNCHER is
    // an owned process — so the `ps` subprocess the supervisor itself spawns to
    // observe the table came back as residue and every shutdown read "NOT clean".
    // A receipt that cries wolf on every exit is worse than no receipt.
    const lifecycle = await claim();
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);

    // Child stopped; a transient helper of the launcher is still alive.
    processes = [launcher, observed(4999, launcher.processGroupId, launcher.pid, 'ps -axo pid')];
    const report = lifecycle.describeOwnedProcesses();

    expect(report.residue.descendantPids).not.toContain(4999);
    expect(report.census).toEqual([
      { role: 'firebase', pid: 4201, processGroupId: 4201, disposition: 'stopped' },
    ]);
  });

  it('still reports a descendant of a child group that outlived its parent', async () => {
    // The case that MUST stay reported: a Java grandchild in the Firebase group
    // holds the emulator port even after the CLI parent is gone.
    const lifecycle = await claim();
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase'), observed(4299, 4201, 4201, 'firebase-java')];

    const report = lifecycle.describeOwnedProcesses();

    expect(report.residue.descendantPids).toContain(4299);
  });

  it('reports a clean census when no child was ever registered', async () => {
    const lifecycle = await claim();

    const report = lifecycle.describeOwnedProcesses();

    expect(report.census).toEqual([]);
    expect(report.residue.processPids).toEqual([]);
    expect(report.residue.reasons).toEqual([]);
  });

  it('never reports the launcher itself as residue', async () => {
    // The launcher is mid-exit; listing its own pid would send the operator to
    // kill the process that is already shutting down.
    const lifecycle = await claim();
    processes = [launcher];

    const report = lifecycle.describeOwnedProcesses();

    expect(report.residue.processPids).not.toContain(launcher.pid);
    expect(report.census.map((entry) => entry.pid)).not.toContain(launcher.pid);
  });

  it('records the refusal reason when the runtime cannot be proven stopped', async () => {
    // An incomplete snapshot means the supervisor cannot prove anything. A census
    // that reported "all stopped" here would be a false clean.
    const lifecycle = await claim();
    processes = [launcher, observed(4201, 4201, 4200, 'npx firebase')];
    lifecycle.registerProcess('firebase', 4201);

    const report = lifecycle.describeOwnedProcesses({ complete: false, processes: [] });

    expect(report.residue.reasons.length).toBeGreaterThan(0);
    expect(report.census.every((entry) => entry.disposition === 'remaining')).toBe(true);
  });
});
