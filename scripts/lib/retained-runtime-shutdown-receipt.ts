/**
 * @file scripts/lib/retained-runtime-shutdown-receipt.ts
 * @description LOCAL-012 — the acknowledgement a normal interrupt owes the operator.
 *
 * The retained finding this closes: a normal `SIGINT` printed
 * `Creating a final verified checkpoint...` and then exited. Nothing confirmed
 * the checkpoint finished, nothing named the children that were torn down, and
 * when four child process groups survived, nothing named THEM either — so the
 * operator had to find and kill them by hand.
 *
 * Almost all of the truth needed already existed on the base tree:
 * `planLocalRuntimeTermination` computes orphan, descendant, unrecorded and
 * unanchored pids with reasons, and `finalizeStoppedRuntime` refuses to release
 * the lease unless a fresh snapshot proves everything stopped. What was missing
 * was reporting it. This module is deliberately pure — it assembles and formats,
 * it never signals, kills, or touches the filesystem — so the acknowledgement can
 * be asserted directly instead of scraped from a live teardown.
 *
 * The one judgement it encodes: `clean` is a CONJUNCTION. A shutdown is clean
 * only when the final checkpoint did not fail, every owned process is accounted
 * for as stopped, and nothing at all is left behind — including a bare refusal
 * reason, because a refusal means the supervisor could not PROVE the runtime
 * stopped, which is not the same as proving it did.
 */

/** Outcome of one shutdown step. `skipped` is a designed path, not a failure. */
export type ShutdownStepStatus = 'ok' | 'skipped' | 'failed';

export interface FinalCheckpointAcknowledgement {
  readonly status: ShutdownStepStatus;
  /** Verified generation this shutdown created, when it created one. */
  readonly generationId?: string;
  readonly manifestSha256?: string;
  /** Why it was skipped or failed — operator-facing, bounded. */
  readonly detail?: string;
  /**
   * Newest generation that remains recoverable. Named ON FAILURE above all: a
   * lost final checkpoint is survivable only if the operator is told which
   * generation a restart will actually load.
   */
  readonly retainedGenerationId?: string;
}

export type OwnedProcessDisposition = 'stopped' | 'remaining';

export interface OwnedProcessCensusEntry {
  readonly role: string;
  readonly pid: number;
  readonly processGroupId: number;
  readonly disposition: OwnedProcessDisposition;
}

/**
 * Everything the runtime may have left behind.
 *
 * Each field answers a question the operator would otherwise have to answer with
 * `ps`, `lsof`, or `docker ps`. `reasons` carries supervisor refusals verbatim
 * (they are generated text, not caller text).
 */
export interface RuntimeResidue {
  readonly processPids: readonly number[];
  readonly processGroupIds: readonly number[];
  readonly orphanPids: readonly number[];
  readonly descendantPids: readonly number[];
  readonly unrecordedGroupPids: readonly number[];
  readonly unanchoredGroupPids: readonly number[];
  readonly containers: readonly string[];
  readonly volumes: readonly string[];
  readonly listenerPorts: readonly number[];
  readonly partialCheckpointPaths: readonly string[];
  readonly reasons: readonly string[];
}

export const EMPTY_RUNTIME_RESIDUE: RuntimeResidue = Object.freeze({
  processPids: Object.freeze([]) as readonly number[],
  processGroupIds: Object.freeze([]) as readonly number[],
  orphanPids: Object.freeze([]) as readonly number[],
  descendantPids: Object.freeze([]) as readonly number[],
  unrecordedGroupPids: Object.freeze([]) as readonly number[],
  unanchoredGroupPids: Object.freeze([]) as readonly number[],
  containers: Object.freeze([]) as readonly string[],
  volumes: Object.freeze([]) as readonly string[],
  listenerPorts: Object.freeze([]) as readonly number[],
  partialCheckpointPaths: Object.freeze([]) as readonly string[],
  reasons: Object.freeze([]) as readonly string[],
});

export interface ShutdownAcknowledgementInput {
  readonly signal: string;
  readonly exitCode: number;
  readonly checkpoint: FinalCheckpointAcknowledgement;
  readonly processes: {
    readonly status: ShutdownStepStatus;
    readonly census: readonly OwnedProcessCensusEntry[];
  };
  readonly containers: {
    readonly status: ShutdownStepStatus;
    readonly stoppedContainers: readonly string[];
    readonly stoppedVolumes: readonly string[];
  };
  readonly residue: RuntimeResidue;
}

export interface ShutdownAcknowledgement extends ShutdownAcknowledgementInput {
  readonly processes: ShutdownAcknowledgementInput['processes'] & {
    readonly stoppedCount: number;
    readonly remainingCount: number;
  };
  /** True only when every step is accounted for AND nothing was left behind. */
  readonly clean: boolean;
}

/** Nothing left behind, and no unproven claim standing in for proof. */
export function isResidueEmpty(residue: RuntimeResidue): boolean {
  return (
    residue.processPids.length === 0 &&
    residue.processGroupIds.length === 0 &&
    residue.orphanPids.length === 0 &&
    residue.descendantPids.length === 0 &&
    residue.unrecordedGroupPids.length === 0 &&
    residue.unanchoredGroupPids.length === 0 &&
    residue.containers.length === 0 &&
    residue.volumes.length === 0 &&
    residue.listenerPorts.length === 0 &&
    residue.partialCheckpointPaths.length === 0 &&
    residue.reasons.length === 0
  );
}

export function buildShutdownAcknowledgement(input: ShutdownAcknowledgementInput): ShutdownAcknowledgement {
  const remainingCount = input.processes.census.filter((entry) => entry.disposition === 'remaining').length;
  const stoppedCount = input.processes.census.length - remainingCount;

  const clean =
    input.checkpoint.status !== 'failed' &&
    input.processes.status !== 'failed' &&
    input.containers.status !== 'failed' &&
    remainingCount === 0 &&
    isResidueEmpty(input.residue);

  return {
    ...input,
    processes: { ...input.processes, stoppedCount, remainingCount },
    clean,
  };
}

/** Render a residue field as `label: a, b, c`, or nothing when empty. */
function residueLine(label: string, values: readonly (number | string)[]): string | null {
  return values.length === 0 ? null : `    ${label}: ${values.join(', ')}`;
}

/**
 * The operator-visible acknowledgement, one line per fact.
 *
 * Written for the moment AFTER Ctrl+C, when the operator needs to know three
 * things without reading scrollback: did the final checkpoint land, did the
 * children stop, and is there anything they still have to clean up.
 */
export function formatShutdownAcknowledgement(ack: ShutdownAcknowledgement): string[] {
  const lines: string[] = [];

  lines.push(`Shutdown acknowledgement (${ack.signal}, exit ${ack.exitCode})`);

  switch (ack.checkpoint.status) {
    case 'ok':
      lines.push(
        `  Final checkpoint verified: ${ack.checkpoint.generationId ?? 'unknown generation'}` +
          (ack.checkpoint.manifestSha256 ? ` (manifest ${ack.checkpoint.manifestSha256.slice(0, 12)})` : '')
      );
      break;
    case 'skipped':
      lines.push(`  Final checkpoint skipped: ${ack.checkpoint.detail ?? 'not enabled for this run'}`);
      break;
    case 'failed':
      lines.push(`  Final checkpoint FAILED: ${ack.checkpoint.detail ?? 'unknown error'}`);
      lines.push(
        `    A restart will load the newest verified generation: ${
          ack.checkpoint.retainedGenerationId ?? 'none — this profile has no verified generation'
        }`
      );
      break;
  }

  const total = ack.processes.census.length;
  lines.push(`  Owned processes stopped: ${ack.processes.stoppedCount}/${total}`);
  for (const entry of ack.processes.census) {
    lines.push(
      `    ${entry.disposition === 'stopped' ? 'stopped' : 'REMAINING'} ${entry.role} pid ${entry.pid} (group ${entry.processGroupId})`
    );
  }

  if (ack.containers.stoppedContainers.length > 0) {
    lines.push(`  Containers stopped: ${ack.containers.stoppedContainers.join(', ')}`);
  }
  if (ack.containers.stoppedVolumes.length > 0) {
    lines.push(`  Volumes removed: ${ack.containers.stoppedVolumes.join(', ')}`);
  }

  if (ack.clean) {
    lines.push('  Residue: none — shutdown clean.');
    return lines;
  }

  // Name everything. The reported failure mode was an operator hunting four
  // orphaned process groups the supervisor had already identified.
  lines.push('  Residue: shutdown is NOT clean — the following were left behind:');
  const residueLines = [
    residueLine('process pids', ack.residue.processPids),
    residueLine('process groups', ack.residue.processGroupIds),
    residueLine('orphan pids', ack.residue.orphanPids),
    residueLine('descendant pids', ack.residue.descendantPids),
    residueLine('unrecorded group pids', ack.residue.unrecordedGroupPids),
    residueLine('unanchored group pids', ack.residue.unanchoredGroupPids),
    residueLine('containers', ack.residue.containers),
    residueLine('volumes', ack.residue.volumes),
    residueLine('listener ports', ack.residue.listenerPorts),
    residueLine('partial checkpoints', ack.residue.partialCheckpointPaths),
    residueLine('reasons', ack.residue.reasons),
  ].filter((line): line is string => line !== null);

  if (residueLines.length === 0) {
    // `clean` is false but no residue was itemised — say so rather than printing
    // an empty list that reads like nothing is wrong.
    lines.push('    a shutdown step failed without itemised residue; see the errors above');
  }
  lines.push(...residueLines);

  return lines;
}
