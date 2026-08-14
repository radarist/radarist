import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  assertLocalRuntimePathContained,
  getLocalRuntimeProfile,
  type LocalRuntimePaths,
  type LocalRuntimeProfileName,
} from './local-runtime-profile';

export const LOCAL_RUNTIME_PROCESS_ROLES = [
  'launcher',
  'firebase',
  'next',
  'inngest',
  'assistant',
  'mcp',
  'checkpoint',
  'background',
] as const;

export type LocalRuntimeProcessRole = (typeof LOCAL_RUNTIME_PROCESS_ROLES)[number];
export type LocalRuntimeTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL';

export interface OwnedLocalProcessIdentity {
  readonly role: LocalRuntimeProcessRole;
  readonly pid: number;
  readonly processGroupId: number;
  readonly parentPid: number | null;
  /** OS process birth marker (for example /proc start ticks or a ps start timestamp). */
  readonly birthMarker: string;
  readonly commandFingerprint: string;
  readonly startedAtEpochMs: number;
}

export interface LocalProcessIdentityManifest {
  readonly version: 1;
  readonly runtimeId: string;
  readonly profileName: LocalRuntimeProfileName;
  readonly projectId: string;
  readonly createdAt: string;
  readonly leaderPid: number;
  readonly processes: readonly OwnedLocalProcessIdentity[];
}

export interface ObservedLocalProcess {
  readonly pid: number;
  readonly processGroupId: number;
  readonly parentPid: number | null;
  readonly birthMarker: string;
  readonly commandFingerprint: string;
  readonly startedAtEpochMs: number;
  /**
   * True when `ps` printed the parenthesized "(comm)" fallback instead of the
   * process argv. macOS does this for LIVE processes (states S/R/?E, not only
   * zombies) once exit teardown has freed the argv region, so the command
   * fingerprint of such a row cannot witness an identity change.
   */
  readonly commandUnreadable?: true;
}

export interface LocalProcessObservationSnapshot {
  /** True only when the caller enumerated the complete host process table. */
  readonly complete: boolean;
  readonly processes: readonly ObservedLocalProcess[];
}

export interface LocalRuntimeLeaseRecord {
  readonly version: 1;
  readonly runtimeId: string;
  readonly profileName: LocalRuntimeProfileName;
  readonly projectId: string;
  readonly acquiredAt: string;
  /**
   * New launchers acquire the exclusive file in `claiming` state, persist the
   * process manifest, then atomically promote it to `active`. Older receipts
   * have no phase and are treated as active so they can never use the narrower
   * manifest-less recovery path.
   */
  readonly phase?: 'claiming' | 'active';
  readonly owner: OwnedLocalProcessIdentity;
}

export interface LocalRuntimeLeaseHandle {
  readonly record: LocalRuntimeLeaseRecord;
  readonly device: number;
  readonly inode: number;
  readonly contentFingerprint: string;
}

export interface LocalRuntimeLeaseWitness {
  readonly device: number;
  readonly inode: number;
  readonly contentFingerprint: string;
}

interface PresentLocalRuntimeLeaseInspection {
  readonly lease: LocalRuntimeLeaseRecord;
  readonly witness: LocalRuntimeLeaseWitness;
  readonly reasons: readonly string[];
}

export type LocalRuntimeStaleLeaseInspection = PresentLocalRuntimeLeaseInspection & {
  readonly status: 'stale';
};

export type LocalRuntimeLeaseInspection =
  | { readonly status: 'available'; readonly reasons: readonly string[] }
  | (PresentLocalRuntimeLeaseInspection & { readonly status: 'active' })
  | LocalRuntimeStaleLeaseInspection
  | (PresentLocalRuntimeLeaseInspection & { readonly status: 'unverified' })
  | { readonly status: 'refused'; readonly reasons: readonly string[] };

export class LocalRuntimeLeaseConflictError extends Error {
  readonly inspection: LocalRuntimeLeaseInspection;

  constructor(inspection: LocalRuntimeLeaseInspection) {
    super(
      inspection.status === 'available'
        ? 'Local runtime lease acquisition lost an atomic race.'
        : `Local runtime profile lease is ${inspection.status}: ${inspection.reasons.join('; ')}`
    );
    this.name = 'LocalRuntimeLeaseConflictError';
    this.inspection = inspection;
  }
}

export interface LocalTerminationPolicy {
  readonly sigintGraceMs: number;
  readonly sigtermGraceMs: number;
  readonly sigkillGraceMs: number;
  readonly pollIntervalMs: number;
}

export interface LocalTerminationStage {
  readonly signal: LocalRuntimeTerminationSignal;
  readonly graceMs: number;
  readonly pollIntervalMs: number;
}

export type LocalTerminationTarget =
  | {
      readonly kind: 'owned-process-set';
      /** POSIX groups whose ownership was anchored when the plan was created. */
      readonly processGroupIds: readonly number[];
      /** Exact-identity processes outside the owned POSIX groups (or every process on Windows). */
      readonly pids: readonly number[];
    }
  /** Compatibility shapes for callers while they adopt mixed group/PID targets. */
  | { readonly kind: 'process-groups'; readonly processGroupIds: readonly number[] }
  | { readonly kind: 'process-list'; readonly pids: readonly number[] };

export interface LocalTerminationPlan {
  readonly status: 'ready' | 'already-stopped' | 'refused';
  readonly leaderPid: number;
  readonly target?: LocalTerminationTarget;
  readonly stages: readonly LocalTerminationStage[];
  readonly exactProcessPids: readonly number[];
  readonly ownedProcessPids: readonly number[];
  readonly descendantPids: readonly number[];
  readonly orphanPids: readonly number[];
  readonly unrecordedGroupPids: readonly number[];
  readonly unanchoredGroupPids: readonly number[];
  /** Immutable exact identities used to avoid signalling a reused supplemental PID. */
  readonly ownedProcesses: readonly ObservedLocalProcess[];
  readonly reasons: readonly string[];
}

export interface LocalTerminationProgress {
  readonly status: 'running' | 'stopped' | 'refused';
  readonly target: LocalTerminationTarget;
  readonly remainingPids: readonly number[];
  readonly reasons: readonly string[];
}

export interface EnumeratedOwnedLocalProcesses {
  readonly exactRecordedPids: readonly number[];
  readonly ownedProcessPids: readonly number[];
  readonly descendantPids: readonly number[];
  readonly processGroupIds: readonly number[];
  readonly supplementalPids: readonly number[];
  readonly unrecordedGroupPids: readonly number[];
  readonly unanchoredGroupPids: readonly number[];
  readonly ownedProcesses: readonly ObservedLocalProcess[];
  readonly reasons: readonly string[];
}

export type LocalRuntimePausableProcessRole = Exclude<LocalRuntimeProcessRole, 'launcher'>;

export interface LocalRuntimePauseGroup {
  /** Exact registered child that authenticated this process group. */
  readonly root: OwnedLocalProcessIdentity;
  readonly processGroupId: number;
  /** Complete group membership captured immediately before suspension. */
  readonly members: readonly ObservedLocalProcess[];
}

export interface LocalRuntimePausePlan {
  readonly status: 'ready' | 'nothing-to-pause' | 'refused';
  readonly roles: readonly LocalRuntimePausableProcessRole[];
  readonly groups: readonly LocalRuntimePauseGroup[];
  readonly reasons: readonly string[];
}

export const DEFAULT_LOCAL_TERMINATION_POLICY: LocalTerminationPolicy = {
  sigintGraceMs: 15_000,
  sigtermGraceMs: 5_000,
  sigkillGraceMs: 2_000,
  pollIntervalMs: 100,
};

const SHA256_RE = /^[a-f0-9]{64}$/;
const RUNTIME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;
const BIRTH_MARKER_RE = /^[\x20-\x7e]{1,256}$/;
const MAX_STAGE_GRACE_MS = 60_000;
const MAX_TOTAL_GRACE_MS = 120_000;

function assertPid(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 2) throw new Error(`${label} must be an integer greater than one.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertIdentity(value: unknown): asserts value is OwnedLocalProcessIdentity {
  if (!isRecord(value)) throw new Error('Local process identity has an invalid shape.');
  const identity = value as unknown as OwnedLocalProcessIdentity;
  if (!(LOCAL_RUNTIME_PROCESS_ROLES as readonly string[]).includes(identity.role)) {
    throw new Error(`Unknown local runtime process role: ${String(identity.role)}.`);
  }
  assertPid(identity.pid, 'Process PID');
  assertPid(identity.processGroupId, 'Process group ID');
  if (identity.parentPid !== null && (!Number.isSafeInteger(identity.parentPid) || identity.parentPid < 1)) {
    throw new Error('Parent PID must be a positive integer or null.');
  }
  if (!BIRTH_MARKER_RE.test(identity.birthMarker)) throw new Error('Process birth marker is missing or invalid.');
  if (!SHA256_RE.test(identity.commandFingerprint)) throw new Error('Process command fingerprint is invalid.');
  if (!Number.isSafeInteger(identity.startedAtEpochMs) || identity.startedAtEpochMs <= 0) {
    throw new Error('Process start time is invalid.');
  }
}

export function fingerprintLocalProcessCommand(command: string, args: readonly string[] = []): string {
  if (!command.trim()) throw new Error('Process command must not be empty.');
  if (args.some((argument) => argument.includes('\0')))
    throw new Error('Process arguments must not contain NUL bytes.');
  return createHash('sha256')
    .update(JSON.stringify([command, ...args]))
    .digest('hex');
}

const POSIX_PROCESS_LINE_RE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;
// Same table with a `stat=` column between pgid and lstart (current format).
const POSIX_PROCESS_LINE_WITH_STATE_RE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\S+\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

/** Parse the fixed C-locale `ps` format used by observeLocalProcessTable. */
export function parsePosixProcessTable(output: string): ObservedLocalProcess[] {
  const processes: ObservedLocalProcess[] = [];
  for (const [index, line] of output.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    // Try the stat-bearing format first; a stat token can never look like the
    // weekday-led lstart field, so legacy 5-column rows fall through cleanly.
    const stateMatch = POSIX_PROCESS_LINE_WITH_STATE_RE.exec(line);
    const legacyMatch = stateMatch ? null : POSIX_PROCESS_LINE_RE.exec(line);
    const match = stateMatch ?? legacyMatch;
    if (!match) throw new Error(`Cannot parse process-table row ${index + 1}.`);
    const state = stateMatch ? match[4] : undefined;
    // A zombie has already exited: it holds no ports, files, or writers and
    // only awaits parental reap. Treating its mutated `(command)` placeholder
    // as a live identity change wrongly flips clean shutdowns into refusals.
    if (state?.toUpperCase().startsWith('Z')) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const processGroupId = Number(match[3]);
    const birthMarker = stateMatch ? match[5] : match[4];
    const command = stateMatch ? match[6] : match[5];
    // Live processes mid-exit (states like S/Rs/?E) print the parenthesized
    // "(comm)" fallback once their argv region is freed; flag them so identity
    // comparison never mistakes the fallback for a changed command.
    const commandUnreadable = /^\([^()]+\)$/.test(command.trim());
    const startedAtEpochMs = Date.parse(birthMarker);
    if (
      !Number.isSafeInteger(pid) ||
      pid < 2 ||
      !Number.isSafeInteger(processGroupId) ||
      processGroupId < 2 ||
      !Number.isFinite(startedAtEpochMs)
    ) {
      // PID/group 0 or 1 are host supervisors and cannot be owned targets.
      if (pid < 2 || processGroupId < 2) continue;
      throw new Error(`Process-table row ${index + 1} has invalid identity fields.`);
    }
    processes.push({
      pid,
      processGroupId,
      parentPid: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
      birthMarker,
      commandFingerprint: fingerprintLocalProcessCommand(command),
      startedAtEpochMs,
      ...(commandUnreadable ? { commandUnreadable: true as const } : {}),
    });
  }
  validateObservations(processes);
  return processes;
}

/**
 * Enumerate the complete POSIX process table in one snapshot. Windows lacks a
 * comparable core API with PGID/birth identity and is intentionally refused.
 */
export function observeLocalProcessTable(
  options: {
    platform?: NodeJS.Platform;
    read?: () => string;
  } = {}
): LocalProcessObservationSnapshot {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    throw new Error('Complete local process-group observation is unavailable on Windows.');
  }
  const output = options.read
    ? options.read()
    : execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C' },
        maxBuffer: 16 * 1024 * 1024,
      });
  return { complete: true, processes: parsePosixProcessTable(output) };
}

export function validateLocalProcessIdentityManifest(value: unknown): LocalProcessIdentityManifest {
  if (!isRecord(value)) throw new Error('Local process identity manifest has an invalid shape.');
  const manifest = value as unknown as LocalProcessIdentityManifest;
  if (manifest.version !== 1) throw new Error('Unsupported local process identity manifest version.');
  if (!RUNTIME_ID_RE.test(manifest.runtimeId)) throw new Error('Local runtime ID is invalid.');
  const profile = getLocalRuntimeProfile(manifest.profileName);
  if (manifest.projectId !== profile.projectId) {
    throw new Error('Local process manifest project ID does not match its profile.');
  }
  if (!Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Local process manifest timestamp is invalid.');
  assertPid(manifest.leaderPid, 'Manifest leader PID');
  if (!Array.isArray(manifest.processes) || manifest.processes.length === 0) {
    throw new Error('Local process manifest must contain at least one process.');
  }

  const seen = new Set<number>();
  for (const identity of manifest.processes) {
    assertIdentity(identity);
    if (seen.has(identity.pid)) throw new Error(`Local process manifest repeats PID ${identity.pid}.`);
    seen.add(identity.pid);
  }
  const leader = manifest.processes.find((identity) => identity.pid === manifest.leaderPid);
  if (!leader || leader.role !== 'launcher') throw new Error('Manifest leader must be the recorded launcher process.');
  for (const identity of manifest.processes) {
    if (identity.role !== 'launcher' && identity.processGroupId !== identity.pid) {
      throw new Error('Each managed child must lead its own POSIX process group.');
    }
  }
  return manifest;
}

function parseManifest(raw: string): LocalProcessIdentityManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Local process identity manifest is not valid JSON.');
  }
  return validateLocalProcessIdentityManifest(parsed);
}

export function validateLocalRuntimeLeaseRecord(value: unknown): LocalRuntimeLeaseRecord {
  if (!isRecord(value)) throw new Error('Local runtime lease has an invalid shape.');
  const lease = value as unknown as LocalRuntimeLeaseRecord;
  if (lease.version !== 1) throw new Error('Unsupported local runtime lease version.');
  if (!RUNTIME_ID_RE.test(lease.runtimeId)) throw new Error('Local runtime lease ID is invalid.');
  const profile = getLocalRuntimeProfile(lease.profileName);
  if (lease.projectId !== profile.projectId) {
    throw new Error('Local runtime lease project ID does not match its profile.');
  }
  if (!Number.isFinite(Date.parse(lease.acquiredAt))) throw new Error('Local runtime lease timestamp is invalid.');
  if (lease.phase !== undefined && lease.phase !== 'claiming' && lease.phase !== 'active') {
    throw new Error('Local runtime lease phase is invalid.');
  }
  assertIdentity(lease.owner);
  if (lease.owner.role !== 'launcher') throw new Error('Local runtime lease owner must be the launcher process.');
  return lease;
}

function parseLease(raw: string): LocalRuntimeLeaseRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Local runtime lease is not valid JSON.');
  }
  return validateLocalRuntimeLeaseRecord(parsed);
}

function serializeLease(lease: LocalRuntimeLeaseRecord): string {
  return `${JSON.stringify(validateLocalRuntimeLeaseRecord(lease), null, 2)}\n`;
}

function fingerprintLeaseContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertPrivateRegularFile(path: string, label = 'Process manifest'): void {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file.`);
  if ((entry.mode & 0o077) !== 0) throw new Error(`${label} must not be accessible by group or other users.`);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function writeLocalProcessIdentityManifest(
  paths: LocalRuntimePaths,
  manifest: LocalProcessIdentityManifest,
  dependencies: { readonly syncDirectory?: (path: string) => void } = {}
): void {
  const validated = validateLocalProcessIdentityManifest(manifest);
  if (validated.profileName !== paths.profileName)
    throw new Error('Process manifest does not belong to this profile root.');
  const target = assertLocalRuntimePathContained(paths, paths.processManifest, { allowMissingLeaf: true });
  if (pathEntryExists(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error('Refusing to replace a symbolic-link process manifest.');
  }
  const temporary = `${target}.${validated.runtimeId}.partial`;
  assertLocalRuntimePathContained(paths, temporary, { allowMissingLeaf: true });
  if (pathEntryExists(temporary)) throw new Error('A process manifest staging file already exists.');

  try {
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    chmodSync(target, 0o600);
    (dependencies.syncDirectory ?? syncDirectory)(paths.pids);
  } catch (error) {
    if (pathEntryExists(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function readLocalProcessIdentityManifest(paths: LocalRuntimePaths): LocalProcessIdentityManifest {
  const target = assertLocalRuntimePathContained(paths, paths.processManifest);
  assertPrivateRegularFile(target);
  const manifest = parseManifest(readFileSync(target, 'utf8'));
  if (manifest.profileName !== paths.profileName) throw new Error('Process manifest belongs to another profile.');
  return manifest;
}

function exactOwnedIdentityMatches(left: OwnedLocalProcessIdentity, right: OwnedLocalProcessIdentity): boolean {
  return (
    left.role === right.role &&
    left.pid === right.pid &&
    left.processGroupId === right.processGroupId &&
    left.parentPid === right.parentPid &&
    left.birthMarker === right.birthMarker &&
    left.commandFingerprint === right.commandFingerprint &&
    left.startedAtEpochMs === right.startedAtEpochMs
  );
}

/**
 * Restore only the exact manifest receipt produced by finalization before its
 * active lease was released. Restoring first makes every later crash fall back
 * to the ordinary lease+manifest recovery path.
 */
export function restoreFinalizingLocalProcessManifest(
  paths: LocalRuntimePaths,
  staleInspection: LocalRuntimeStaleLeaseInspection,
  postCrashSnapshot: LocalProcessObservationSnapshot
): LocalProcessIdentityManifest {
  if (!postCrashSnapshot.complete) {
    throw new Error('Finalization receipt recovery requires a complete process snapshot.');
  }
  if (staleInspection.lease.phase !== 'active') {
    throw new Error('Finalization receipt recovery requires an explicit active lease.');
  }
  const target = assertLocalRuntimePathContained(paths, paths.processManifest, {
    allowMissingLeaf: true,
  });
  if (pathEntryExists(target)) {
    throw new Error('Finalization receipt recovery requires the canonical manifest to be absent.');
  }
  const receipt = `${target}.${staleInspection.lease.runtimeId}.finalizing`;
  assertLocalRuntimePathContained(paths, receipt, { allowMissingLeaf: true });
  if (!pathEntryExists(receipt)) {
    throw new Error('The exact finalization receipt is missing.');
  }
  assertPrivateRegularFile(receipt, 'Finalization process manifest receipt');

  const before = lstatSync(receipt);
  const content = readFileSync(receipt, 'utf8');
  const after = lstatSync(receipt);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Finalization process manifest receipt identity changed while it was read.');
  }
  const manifest = parseManifest(content);
  if (
    manifest.runtimeId !== staleInspection.lease.runtimeId ||
    manifest.profileName !== paths.profileName ||
    manifest.projectId !== staleInspection.lease.projectId
  ) {
    throw new Error('Finalization receipt does not match the stale runtime lease.');
  }
  const leader = manifest.processes.find((identity) => identity.pid === manifest.leaderPid);
  if (!leader || !exactOwnedIdentityMatches(leader, staleInspection.lease.owner)) {
    throw new Error('Finalization receipt launcher identity does not match the stale runtime lease.');
  }

  const currentInspection = inspectLocalRuntimeLease(paths, postCrashSnapshot);
  if (currentInspection.status !== 'stale') {
    throw new Error(`Finalization receipt recovery lost lease ownership verification (${currentInspection.status}).`);
  }
  if (
    currentInspection.lease.phase !== 'active' ||
    currentInspection.lease.runtimeId !== staleInspection.lease.runtimeId ||
    !witnessesMatch(currentInspection.witness, staleInspection.witness)
  ) {
    throw new Error('Finalization receipt lease changed after inspection.');
  }
  if (pathEntryExists(target)) {
    throw new Error('Canonical process manifest appeared during finalization receipt recovery.');
  }
  const finalReceipt = lstatSync(receipt);
  if (
    finalReceipt.dev !== after.dev ||
    finalReceipt.ino !== after.ino ||
    fingerprintLeaseContent(readFileSync(receipt, 'utf8')) !== fingerprintLeaseContent(content)
  ) {
    throw new Error('Finalization process manifest receipt changed before restoration.');
  }

  renameSync(receipt, target);
  syncDirectory(paths.pids);
  const restored = lstatSync(target);
  if (
    restored.dev !== after.dev ||
    restored.ino !== after.ino ||
    fingerprintLeaseContent(readFileSync(target, 'utf8')) !== fingerprintLeaseContent(content)
  ) {
    throw new Error('Restored process manifest identity changed during recovery.');
  }
  return manifest;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function readLocalRuntimeLease(paths: LocalRuntimePaths): LocalRuntimeLeaseRecord {
  return readLocalRuntimeLeaseWithWitness(paths).lease;
}

function readLocalRuntimeLeaseWithWitness(paths: LocalRuntimePaths): {
  lease: LocalRuntimeLeaseRecord;
  witness: LocalRuntimeLeaseWitness;
} {
  const target = assertLocalRuntimePathContained(paths, paths.runtimeLease);
  assertPrivateRegularFile(target, 'Local runtime lease');
  const before = lstatSync(target);
  const content = readFileSync(target, 'utf8');
  const after = lstatSync(target);
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Local runtime lease file identity changed while it was being read.');
  }
  const lease = parseLease(content);
  if (lease.profileName !== paths.profileName) throw new Error('Local runtime lease belongs to another profile.');
  return {
    lease,
    witness: {
      device: after.dev,
      inode: after.ino,
      contentFingerprint: fingerprintLeaseContent(content),
    },
  };
}

/**
 * Classify an existing lease without mutating it. A missing owner is called
 * stale only when the caller provides a complete process-table snapshot.
 * Partial observation can never authorize recovery.
 */
export function inspectLocalRuntimeLease(
  paths: LocalRuntimePaths,
  snapshot?: LocalProcessObservationSnapshot
): LocalRuntimeLeaseInspection {
  let target: string;
  try {
    target = assertLocalRuntimePathContained(paths, paths.runtimeLease, { allowMissingLeaf: true });
  } catch (error) {
    return { status: 'refused', reasons: [(error as Error).message] };
  }
  if (!pathEntryExists(target)) return { status: 'available', reasons: [] };

  let lease: LocalRuntimeLeaseRecord;
  let witness: LocalRuntimeLeaseWitness;
  try {
    ({ lease, witness } = readLocalRuntimeLeaseWithWitness(paths));
  } catch (error) {
    return { status: 'refused', reasons: [(error as Error).message] };
  }
  if (!snapshot) {
    return {
      status: 'unverified',
      lease,
      witness,
      reasons: ['No process observation was supplied for the existing lease.'],
    };
  }
  try {
    validateObservations(snapshot.processes);
  } catch (error) {
    return { status: 'refused', reasons: [(error as Error).message] };
  }
  const observedOwner = snapshot.processes.find((process) => process.pid === lease.owner.pid);
  if (observedOwner) {
    const mismatch = identityMismatchReason(lease.owner, observedOwner);
    return mismatch
      ? { status: 'stale', lease, witness, reasons: [mismatch] }
      : { status: 'active', lease, witness, reasons: ['The exact lease owner is still running.'] };
  }
  return snapshot.complete
    ? {
        status: 'stale',
        lease,
        witness,
        reasons: ['The complete process snapshot does not contain the recorded lease owner.'],
      }
    : {
        status: 'unverified',
        lease,
        witness,
        reasons: ['A partial process snapshot cannot prove that the recorded lease owner exited.'],
      };
}

/**
 * Atomically claim a profile for the lifetime of one launcher. Existing files
 * are never removed or replaced, including leases classified as stale.
 */
export function acquireLocalRuntimeLease(
  paths: LocalRuntimePaths,
  record: LocalRuntimeLeaseRecord,
  existingLeaseSnapshot?: LocalProcessObservationSnapshot
): LocalRuntimeLeaseHandle {
  const validated = validateLocalRuntimeLeaseRecord(record);
  if (validated.profileName !== paths.profileName)
    throw new Error('Local runtime lease does not belong to this profile.');
  const target = assertLocalRuntimePathContained(paths, paths.runtimeLease, { allowMissingLeaf: true });
  const content = serializeLease(validated);
  let descriptor: number;
  try {
    descriptor = openSync(target, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new LocalRuntimeLeaseConflictError(inspectLocalRuntimeLease(paths, existingLeaseSnapshot));
    }
    throw error;
  }

  try {
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    const entry = fstatSync(descriptor);
    if (!entry.isFile() || (entry.mode & 0o077) !== 0) {
      throw new Error('New local runtime lease did not retain its private regular-file identity.');
    }
    chmodSync(target, 0o600);
    syncDirectory(paths.pids);
    return {
      record: validated,
      device: entry.dev,
      inode: entry.ino,
      contentFingerprint: fingerprintLeaseContent(content),
    };
  } catch (error) {
    const current = lstatSync(target);
    const created = fstatSync(descriptor);
    if (current.dev === created.dev && current.ino === created.ino) unlinkSync(target);
    throw error;
  } finally {
    closeSync(descriptor);
  }
}

function assertExactLeaseHandle(
  paths: LocalRuntimePaths,
  handle: LocalRuntimeLeaseHandle
): { target: string; entry: ReturnType<typeof lstatSync>; content: string } {
  validateLocalRuntimeLeaseRecord(handle.record);
  if (handle.record.profileName !== paths.profileName) {
    throw new Error('Local runtime lease handle belongs to another profile.');
  }
  const target = assertLocalRuntimePathContained(paths, paths.runtimeLease);
  assertPrivateRegularFile(target, 'Local runtime lease');
  const entry = lstatSync(target);
  if (entry.dev !== handle.device || entry.ino !== handle.inode) {
    throw new Error('Local runtime lease file identity changed.');
  }
  const content = readFileSync(target, 'utf8');
  if (fingerprintLeaseContent(content) !== handle.contentFingerprint) {
    throw new Error('Local runtime lease content changed.');
  }
  const parsed = parseLease(content);
  if (parsed.runtimeId !== handle.record.runtimeId || parsed.owner.pid !== handle.record.owner.pid) {
    throw new Error('Local runtime lease is owned by another runtime.');
  }
  return { target, entry, content };
}

/**
 * Atomically publish that the matching process manifest now exists. The
 * returned handle owns the replacement inode and must be used for release.
 */
export function promoteLocalRuntimeLeaseToActive(
  paths: LocalRuntimePaths,
  handle: LocalRuntimeLeaseHandle
): LocalRuntimeLeaseHandle {
  if (handle.record.phase !== 'claiming') {
    throw new Error('Only a claiming local runtime lease can be promoted.');
  }
  const current = assertExactLeaseHandle(paths, handle);
  const active: LocalRuntimeLeaseRecord = { ...handle.record, phase: 'active' };
  const content = serializeLease(active);
  const temporary = `${current.target}.${active.runtimeId}.promoting`;
  assertLocalRuntimePathContained(paths, temporary, { allowMissingLeaf: true });
  if (pathEntryExists(temporary)) {
    throw new Error('A local runtime lease promotion stage already exists.');
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    const staged = fstatSync(descriptor);
    if (!staged.isFile() || (staged.mode & 0o077) !== 0) {
      throw new Error('Promoted local runtime lease did not retain its private file identity.');
    }
    // Re-read the exact claiming witness immediately before the atomic swap.
    assertExactLeaseHandle(paths, handle);
    renameSync(temporary, current.target);
    chmodSync(current.target, 0o600);
    syncDirectory(paths.pids);
    const promoted = lstatSync(current.target);
    return {
      record: active,
      device: promoted.dev,
      inode: promoted.ino,
      contentFingerprint: fingerprintLeaseContent(content),
    };
  } catch (error) {
    if (pathEntryExists(temporary)) {
      const staged = lstatSync(temporary);
      if (!staged.isSymbolicLink() && staged.isFile()) unlinkSync(temporary);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Release only the exact inode and bytes returned by acquisition. */
export function releaseLocalRuntimeLease(paths: LocalRuntimePaths, handle: LocalRuntimeLeaseHandle): void {
  let exact: ReturnType<typeof assertExactLeaseHandle>;
  try {
    exact = assertExactLeaseHandle(paths, handle);
  } catch (error) {
    throw new Error(`Refusing to release local runtime lease: ${(error as Error).message}`);
  }
  unlinkSync(exact.target);
  syncDirectory(paths.pids);
}

function witnessesMatch(left: LocalRuntimeLeaseWitness, right: LocalRuntimeLeaseWitness): boolean {
  return (
    left.device === right.device && left.inode === right.inode && left.contentFingerprint === right.contentFingerprint
  );
}

/**
 * Recover only the pre-manifest claim window. Missing-phase (legacy) and
 * active leases are deliberately ineligible because their child ownership can
 * only be proven by the matching manifest.
 */
export function retireAbandonedClaimAndAcquireLocalRuntimeLease(
  paths: LocalRuntimePaths,
  staleInspection: LocalRuntimeStaleLeaseInspection,
  postCrashSnapshot: LocalProcessObservationSnapshot,
  replacement: LocalRuntimeLeaseRecord
): LocalRuntimeLeaseHandle {
  if (staleInspection.lease.phase !== 'claiming') {
    throw new Error('Manifest-less lease recovery requires an explicit claiming phase.');
  }
  if (!postCrashSnapshot.complete) {
    throw new Error('Abandoned claim recovery requires a complete process snapshot.');
  }
  if (pathEntryExists(paths.processManifest)) {
    throw new Error('Abandoned claim recovery requires the process manifest to be absent.');
  }
  const current = inspectLocalRuntimeLease(paths, postCrashSnapshot);
  if (current.status !== 'stale') {
    throw new Error(`Abandoned claim recovery lost ownership verification (${current.status}).`);
  }
  if (
    current.lease.runtimeId !== staleInspection.lease.runtimeId ||
    current.lease.phase !== 'claiming' ||
    !witnessesMatch(current.witness, staleInspection.witness)
  ) {
    throw new Error('Abandoned claim lease changed after inspection.');
  }

  const target = assertLocalRuntimePathContained(paths, paths.runtimeLease);
  const retired = `${target}.${staleInspection.lease.runtimeId}.abandoned`;
  assertLocalRuntimePathContained(paths, retired, { allowMissingLeaf: true });
  if (pathEntryExists(retired)) throw new Error('An abandoned claim receipt already exists.');
  const beforeRename = readLocalRuntimeLeaseWithWitness(paths);
  if (!witnessesMatch(beforeRename.witness, staleInspection.witness)) {
    throw new Error('Abandoned claim changed immediately before retirement.');
  }
  renameSync(target, retired);
  syncDirectory(paths.pids);

  let replacementHandle: LocalRuntimeLeaseHandle;
  try {
    replacementHandle = acquireLocalRuntimeLease(paths, replacement);
  } catch (error) {
    if (!pathEntryExists(target)) renameSync(retired, target);
    syncDirectory(paths.pids);
    throw error;
  }
  const retiredEntry = lstatSync(retired);
  if (
    retiredEntry.dev !== staleInspection.witness.device ||
    retiredEntry.ino !== staleInspection.witness.inode ||
    fingerprintLeaseContent(readFileSync(retired, 'utf8')) !== staleInspection.witness.contentFingerprint
  ) {
    throw new Error('Abandoned claim receipt changed before cleanup.');
  }
  unlinkSync(retired);
  syncDirectory(paths.pids);
  return replacementHandle;
}

/**
 * Retire one witnessed stale lease and immediately compete for the now-free
 * profile with O_EXCL. This path requires a complete post-cleanup process
 * snapshot and the matching runtime manifest; it cannot infer cleanup from age.
 */
export function retireStaleAndAcquireLocalRuntimeLease(
  paths: LocalRuntimePaths,
  staleInspection: LocalRuntimeStaleLeaseInspection,
  staleManifest: LocalProcessIdentityManifest,
  postCleanupSnapshot: LocalProcessObservationSnapshot,
  replacement: LocalRuntimeLeaseRecord
): LocalRuntimeLeaseHandle {
  if (!postCleanupSnapshot.complete) {
    throw new Error('Stale lease retirement requires a complete post-cleanup process snapshot.');
  }
  const validatedManifest = validateLocalProcessIdentityManifest(staleManifest);
  if (
    validatedManifest.runtimeId !== staleInspection.lease.runtimeId ||
    validatedManifest.profileName !== paths.profileName
  ) {
    throw new Error('Stale lease retirement requires the exact matching process manifest.');
  }
  const currentInspection = inspectLocalRuntimeLease(paths, postCleanupSnapshot);
  if (currentInspection.status !== 'stale') {
    throw new Error(`Stale lease retirement lost ownership verification (${currentInspection.status}).`);
  }
  if (
    currentInspection.lease.runtimeId !== staleInspection.lease.runtimeId ||
    !witnessesMatch(currentInspection.witness, staleInspection.witness)
  ) {
    throw new Error('Stale lease changed after inspection; refusing compare-and-swap retirement.');
  }

  // A reused launcher PID is already proven not to be the stale owner. Every
  // managed child/group must independently be gone before retirement.
  const withoutStaleLauncherPid = postCleanupSnapshot.processes.filter(
    (process) => process.pid !== validatedManifest.leaderPid
  );
  const cleanupPlan = planLocalRuntimeTermination(validatedManifest, withoutStaleLauncherPid);
  if (cleanupPlan.status !== 'already-stopped') {
    const detail = cleanupPlan.reasons.length > 0 ? `: ${cleanupPlan.reasons.join('; ')}` : '';
    throw new Error(`Stale runtime cleanup is incomplete (${cleanupPlan.status})${detail}.`);
  }

  const target = assertLocalRuntimePathContained(paths, paths.runtimeLease);
  const retired = `${target}.${staleInspection.lease.runtimeId}.retired`;
  assertLocalRuntimePathContained(paths, retired, { allowMissingLeaf: true });
  if (pathEntryExists(retired)) throw new Error('A prior stale lease retirement receipt already exists.');
  const beforeRename = readLocalRuntimeLeaseWithWitness(paths);
  if (!witnessesMatch(beforeRename.witness, staleInspection.witness)) {
    throw new Error('Stale lease changed immediately before retirement.');
  }
  renameSync(target, retired);
  syncDirectory(paths.pids);

  let replacementHandle: LocalRuntimeLeaseHandle;
  try {
    replacementHandle = acquireLocalRuntimeLease(paths, replacement);
  } catch (error) {
    if (!pathEntryExists(target)) renameSync(retired, target);
    syncDirectory(paths.pids);
    throw error;
  }
  const retiredEntry = lstatSync(retired);
  if (
    retiredEntry.dev !== staleInspection.witness.device ||
    retiredEntry.ino !== staleInspection.witness.inode ||
    fingerprintLeaseContent(readFileSync(retired, 'utf8')) !== staleInspection.witness.contentFingerprint
  ) {
    throw new Error('Retired lease receipt changed before cleanup.');
  }
  unlinkSync(retired);
  syncDirectory(paths.pids);
  return replacementHandle;
}

function identityMismatchReason(
  expected: OwnedLocalProcessIdentity,
  observed: ObservedLocalProcess
): string | undefined {
  if (expected.processGroupId !== observed.processGroupId) return `PID ${expected.pid} changed process group`;
  return stableProcessIdentityMismatchReason(expected, observed);
}

/** Fields that witness one stable process identity across snapshots. */
export interface StableProcessIdentityWitness {
  readonly pid: number;
  readonly birthMarker: string;
  readonly commandFingerprint: string;
  readonly startedAtEpochMs: number;
  readonly commandUnreadable?: boolean;
}

export function stableProcessIdentityMismatchReason(
  expected: StableProcessIdentityWitness,
  observed: ObservedLocalProcess
): string | undefined {
  if (expected.birthMarker !== observed.birthMarker) return `PID ${expected.pid} has been reused`;
  if (
    expected.commandFingerprint !== observed.commandFingerprint &&
    expected.commandUnreadable !== true &&
    observed.commandUnreadable !== true
  ) {
    // A differing command fingerprint witnesses a recycled or hijacked PID —
    // unless either snapshot could not read the argv at all ("(comm)"
    // fallback, live mid-exit teardown on macOS). In that window the SAME
    // process still matches on pid + birth marker + start time, so a dying
    // group keeps its identity anchor instead of turning every clean
    // multi-member shutdown into a spurious cleanup refusal.
    return `PID ${expected.pid} changed command identity`;
  }
  if (expected.startedAtEpochMs !== observed.startedAtEpochMs) return `PID ${expected.pid} changed start identity`;
  return undefined;
}

function exactObservedProcesses(
  manifest: LocalProcessIdentityManifest,
  observations: readonly ObservedLocalProcess[]
): Map<number, ObservedLocalProcess> {
  const observedByPid = new Map(observations.map((process) => [process.pid, process]));
  const exact = new Map<number, ObservedLocalProcess>();
  for (const identity of manifest.processes) {
    const observed = observedByPid.get(identity.pid);
    if (observed && !identityMismatchReason(identity, observed)) exact.set(identity.pid, observed);
  }
  return exact;
}

function validateObservations(observations: readonly ObservedLocalProcess[]): void {
  const seen = new Set<number>();
  for (const observation of observations) {
    assertPid(observation.pid, 'Observed PID');
    assertPid(observation.processGroupId, 'Observed process group ID');
    if (observation.parentPid !== null && (!Number.isSafeInteger(observation.parentPid) || observation.parentPid < 1)) {
      throw new Error('Observed parent PID must be a positive integer or null.');
    }
    if (!BIRTH_MARKER_RE.test(observation.birthMarker)) throw new Error('Observed process birth marker is invalid.');
    if (!SHA256_RE.test(observation.commandFingerprint)) {
      throw new Error('Observed process command fingerprint is invalid.');
    }
    if (!Number.isSafeInteger(observation.startedAtEpochMs) || observation.startedAtEpochMs <= 0) {
      throw new Error('Observed process start time is invalid.');
    }
    if (seen.has(observation.pid)) throw new Error(`Process observation repeats PID ${observation.pid}.`);
    seen.add(observation.pid);
  }
}

export function findOwnedLocalOrphans(
  manifest: LocalProcessIdentityManifest,
  observations: readonly ObservedLocalProcess[]
): ObservedLocalProcess[] {
  validateLocalProcessIdentityManifest(manifest);
  validateObservations(observations);
  const exact = exactObservedProcesses(manifest, observations);
  const leaderAlive = exact.has(manifest.leaderPid);
  return manifest.processes
    .filter((identity) => identity.pid !== manifest.leaderPid)
    .flatMap((identity) => {
      const observed = exact.get(identity.pid);
      if (!observed) return [];
      const parentAlive = observed.parentPid !== null && exact.has(observed.parentPid);
      return !leaderAlive || observed.parentPid === 1 || !parentAlive ? [observed] : [];
    });
}

function sortProcesses(processes: Iterable<ObservedLocalProcess>): ObservedLocalProcess[] {
  return [...processes].sort((left, right) => left.pid - right.pid);
}

/**
 * Enumerate one authenticated ownership snapshot. Recorded identities are the
 * roots; exact process-group members and recursive descendants join the set.
 * A recorded group with live members but no exact/ancestry anchor is reported
 * separately and must never be signalled by PGID alone.
 */
export function enumerateOwnedLocalProcesses(
  manifest: LocalProcessIdentityManifest,
  observations: readonly ObservedLocalProcess[],
  options: { platform?: NodeJS.Platform } = {}
): EnumeratedOwnedLocalProcesses {
  validateLocalProcessIdentityManifest(manifest);
  validateObservations(observations);
  const observedByPid = new Map(observations.map((process) => [process.pid, process]));
  const expectedPids = new Set(manifest.processes.map((process) => process.pid));
  const exact = exactObservedProcesses(manifest, observations);
  const reasons: string[] = [];
  for (const identity of manifest.processes) {
    const observed = observedByPid.get(identity.pid);
    const mismatch = observed ? identityMismatchReason(identity, observed) : undefined;
    if (mismatch) reasons.push(mismatch);
  }

  const managedGroups = new Set(
    manifest.processes.filter((identity) => identity.role !== 'launcher').map((identity) => identity.processGroupId)
  );
  const anchoredGroups = new Set(
    manifest.processes
      .filter((identity) => identity.role !== 'launcher' && exact.has(identity.pid))
      .map((identity) => identity.processGroupId)
  );
  const owned = new Map(exact);
  const descendants = new Set<number>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const process of observations) {
      const groupOwned = anchoredGroups.has(process.processGroupId);
      const parentOwned = process.parentPid !== null && owned.has(process.parentPid);
      if (!owned.has(process.pid) && (groupOwned || parentOwned)) {
        owned.set(process.pid, process);
        if (!expectedPids.has(process.pid)) descendants.add(process.pid);
        changed = true;
      }
      if (
        owned.has(process.pid) &&
        process.pid === process.processGroupId &&
        !anchoredGroups.has(process.processGroupId)
      ) {
        anchoredGroups.add(process.processGroupId);
        changed = true;
      }
    }
  }

  const unanchoredGroupPids = observations
    .filter((process) => managedGroups.has(process.processGroupId) && !anchoredGroups.has(process.processGroupId))
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  const unrecordedGroupPids = observations
    .filter((process) => managedGroups.has(process.processGroupId) && !expectedPids.has(process.pid))
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  const platform = options.platform ?? process.platform;
  const processGroupIds =
    platform === 'win32'
      ? []
      : [...anchoredGroups].filter((groupId) => groupId !== manifest.leaderPid).sort((left, right) => left - right);
  const coveredGroups = new Set(processGroupIds);
  const supplementalPids = [...owned.values()]
    .filter(
      (process) =>
        process.pid !== manifest.leaderPid && (platform === 'win32' || !coveredGroups.has(process.processGroupId))
    )
    .map((process) => process.pid)
    .sort((left, right) => left - right);

  return {
    exactRecordedPids: [...exact.keys()].sort((left, right) => left - right),
    ownedProcessPids: [...owned.keys()].sort((left, right) => left - right),
    descendantPids: [...descendants].sort((left, right) => left - right),
    processGroupIds,
    supplementalPids,
    unrecordedGroupPids,
    unanchoredGroupPids,
    ownedProcesses: sortProcesses(owned.values()),
    reasons,
  };
}

/**
 * Authenticate selected registered process-group leaders from one complete
 * host snapshot before a checkpoint suspension. A missing child with no live
 * group is already stopped and is harmless. PID reuse, command drift, or live
 * members in a now-unanchored recorded group refuse the whole plan.
 */
export function planLocalRuntimeProcessGroupPause(
  manifest: LocalProcessIdentityManifest,
  snapshot: LocalProcessObservationSnapshot,
  roles: readonly LocalRuntimePausableProcessRole[]
): LocalRuntimePausePlan {
  validateLocalProcessIdentityManifest(manifest);
  validateObservations(snapshot.processes);
  if (!snapshot.complete) {
    return {
      status: 'refused',
      roles: [],
      groups: [],
      reasons: ['Process-group suspension requires a complete process snapshot.'],
    };
  }

  const selected = [...new Set(roles)].sort();
  if (selected.length === 0) throw new Error('At least one pausable process role is required.');
  for (const role of selected) {
    if (role === ('launcher' as LocalRuntimeProcessRole)) {
      throw new Error('The local runtime launcher cannot be suspended.');
    }
    if (!(LOCAL_RUNTIME_PROCESS_ROLES as readonly string[]).includes(role)) {
      throw new Error(`Unknown local runtime process role: ${String(role)}.`);
    }
  }

  const observedByPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
  const groups: LocalRuntimePauseGroup[] = [];
  const reasons: string[] = [];
  for (const root of manifest.processes
    .filter(
      (identity): identity is OwnedLocalProcessIdentity & { role: LocalRuntimePausableProcessRole } =>
        identity.role !== 'launcher' && selected.includes(identity.role)
    )
    .sort((left, right) => left.processGroupId - right.processGroupId)) {
    const members = snapshot.processes.filter((process) => process.processGroupId === root.processGroupId);
    const observedRoot = observedByPid.get(root.pid);
    if (!observedRoot) {
      if (members.length > 0) {
        reasons.push(
          `Recorded ${root.role} process group ${root.processGroupId} has live members but no exact registered leader: ${members
            .map((process) => process.pid)
            .sort((left, right) => left - right)
            .join(', ')}`
        );
      }
      continue;
    }
    const mismatch = identityMismatchReason(root, observedRoot);
    if (mismatch) {
      reasons.push(`${root.role}: ${mismatch}`);
      continue;
    }
    groups.push({
      root,
      processGroupId: root.processGroupId,
      members: sortProcesses(members),
    });
  }

  if (reasons.length > 0) {
    return { status: 'refused', roles: selected, groups: [], reasons };
  }
  return {
    status: groups.length > 0 ? 'ready' : 'nothing-to-pause',
    roles: selected,
    groups,
    reasons: [],
  };
}

export function buildLocalTerminationStages(
  policy: LocalTerminationPolicy = DEFAULT_LOCAL_TERMINATION_POLICY
): LocalTerminationStage[] {
  const graceValues = [policy.sigintGraceMs, policy.sigtermGraceMs, policy.sigkillGraceMs];
  if (graceValues.some((value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_STAGE_GRACE_MS)) {
    throw new Error(`Each process termination grace period must be between 0 and ${MAX_STAGE_GRACE_MS}ms.`);
  }
  const total = graceValues.reduce((sum, value) => sum + value, 0);
  if (total > MAX_TOTAL_GRACE_MS) throw new Error('Total process termination grace period is unbounded.');
  if (!Number.isSafeInteger(policy.pollIntervalMs) || policy.pollIntervalMs < 10 || policy.pollIntervalMs > 5_000) {
    throw new Error('Process termination polling interval must be between 10ms and 5000ms.');
  }
  return [
    { signal: 'SIGINT', graceMs: policy.sigintGraceMs, pollIntervalMs: policy.pollIntervalMs },
    { signal: 'SIGTERM', graceMs: policy.sigtermGraceMs, pollIntervalMs: policy.pollIntervalMs },
    { signal: 'SIGKILL', graceMs: policy.sigkillGraceMs, pollIntervalMs: policy.pollIntervalMs },
  ];
}

/**
 * Produce a teardown plan without sending signals. A live, exact recorded
 * process anchors group ownership. If all anchors are gone but a PID now
 * belongs to a different process, the plan refuses to act.
 */
export function planLocalRuntimeTermination(
  manifest: LocalProcessIdentityManifest,
  observations: readonly ObservedLocalProcess[],
  options: { policy?: LocalTerminationPolicy; platform?: NodeJS.Platform } = {}
): LocalTerminationPlan {
  const stages = buildLocalTerminationStages(options.policy);
  const enumeration = enumerateOwnedLocalProcesses(manifest, observations, { platform: options.platform });
  const exactPids = enumeration.exactRecordedPids;
  const orphans = findOwnedLocalOrphans(manifest, observations)
    .map((process) => process.pid)
    .sort((a, b) => a - b);

  if (enumeration.reasons.length > 0 || enumeration.unanchoredGroupPids.length > 0) {
    const reasons = [
      ...enumeration.reasons,
      ...(enumeration.unanchoredGroupPids.length > 0
        ? [
            `Recorded process groups contain unauthenticated live members: ${enumeration.unanchoredGroupPids.join(', ')}`,
          ]
        : []),
    ];
    return {
      status: 'refused',
      leaderPid: manifest.leaderPid,
      stages: [],
      exactProcessPids: exactPids,
      ownedProcessPids: enumeration.ownedProcessPids,
      descendantPids: enumeration.descendantPids,
      orphanPids: orphans,
      unrecordedGroupPids: enumeration.unrecordedGroupPids,
      unanchoredGroupPids: enumeration.unanchoredGroupPids,
      ownedProcesses: enumeration.ownedProcesses,
      reasons,
    };
  }
  if (exactPids.length === 0) {
    return {
      status: 'already-stopped',
      leaderPid: manifest.leaderPid,
      stages: [],
      exactProcessPids: [],
      ownedProcessPids: [],
      descendantPids: [],
      orphanPids: [],
      unrecordedGroupPids: enumeration.unrecordedGroupPids,
      unanchoredGroupPids: [],
      ownedProcesses: [],
      reasons: [],
    };
  }

  return {
    status: 'ready',
    leaderPid: manifest.leaderPid,
    target: {
      kind: 'owned-process-set',
      processGroupIds: enumeration.processGroupIds,
      pids: enumeration.supplementalPids,
    },
    stages,
    exactProcessPids: exactPids,
    ownedProcessPids: enumeration.ownedProcessPids,
    descendantPids: enumeration.descendantPids,
    orphanPids: orphans,
    unrecordedGroupPids: enumeration.unrecordedGroupPids,
    unanchoredGroupPids: [],
    ownedProcesses: enumeration.ownedProcesses,
    reasons: [],
  };
}

/**
 * Re-evaluate a ready plan after a signal. Group survival is based on every
 * current PGID member, not the original wrapper PID. Exact supplemental
 * processes are rechecked for PID reuse before they can be signalled again.
 */
export function observeLocalTerminationProgress(
  plan: LocalTerminationPlan,
  observations: readonly ObservedLocalProcess[],
  options: { platform?: NodeJS.Platform } = {}
): LocalTerminationProgress {
  validateObservations(observations);
  if (plan.status !== 'ready' || !plan.target) throw new Error('Termination progress requires a ready plan.');
  const initialGroupIds = plan.target.kind === 'process-list' ? [] : plan.target.processGroupIds;
  const initialPids = plan.target.kind === 'process-groups' ? [] : plan.target.pids;
  const observedByPid = new Map(observations.map((process) => [process.pid, process]));
  const expectedByPid = new Map(plan.ownedProcesses.map((process) => [process.pid, process]));
  const groupIds = new Set<number>();
  const unanchoredGroupIds = new Set<number>();
  const owned = new Map<number, ObservedLocalProcess>();
  const reasons: string[] = [];

  // A PGID is reusable as soon as its prior members exit. Retain an original
  // group only while this snapshot contains an exact stable identity that was
  // already observed in that same group when the immutable plan was created.
  // Ancestry or an unrelated current member cannot authenticate a reused PGID.
  for (const groupId of [...new Set(initialGroupIds)].sort((left, right) => left - right)) {
    const members = observations.filter((process) => process.processGroupId === groupId);
    if (members.length === 0) continue;
    const hasExactStableAnchor = members.some((process) => {
      const expected = expectedByPid.get(process.pid);
      return (
        expected?.processGroupId === groupId && stableProcessIdentityMismatchReason(expected, process) === undefined
      );
    });
    if (hasExactStableAnchor) {
      groupIds.add(groupId);
      for (const process of members) owned.set(process.pid, process);
      continue;
    }
    unanchoredGroupIds.add(groupId);
    reasons.push(
      `Retained process group ${groupId} has live members but no current exact stable identity anchor: ${members
        .map((process) => process.pid)
        .sort((left, right) => left - right)
        .join(', ')}`
    );
  }

  for (const [pid, expected] of expectedByPid) {
    const current = observedByPid.get(pid);
    if (!current) continue;
    const mismatch = stableProcessIdentityMismatchReason(expected, current);
    if (mismatch) {
      if (initialPids.includes(pid) || !groupIds.has(current.processGroupId)) reasons.push(mismatch);
      continue;
    }
    if (unanchoredGroupIds.has(current.processGroupId)) continue;
    if (pid !== plan.leaderPid) owned.set(pid, current);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const process of observations) {
      if (unanchoredGroupIds.has(process.processGroupId)) continue;
      const parentOwned = process.parentPid !== null && owned.has(process.parentPid);
      if (!owned.has(process.pid) && parentOwned) {
        owned.set(process.pid, process);
        changed = true;
      }
      if (owned.has(process.pid) && process.pid === process.processGroupId && !groupIds.has(process.processGroupId)) {
        groupIds.add(process.processGroupId);
        changed = true;
      }
      if (groupIds.has(process.processGroupId) && !owned.has(process.pid)) {
        owned.set(process.pid, process);
        changed = true;
      }
    }
  }

  const platform = options.platform ?? process.platform;
  const refreshedGroupIds = platform === 'win32' ? [] : [...groupIds].sort((left, right) => left - right);
  const refreshedGroups = new Set(refreshedGroupIds);
  const refreshedPids = [...owned.values()]
    .filter((process) => platform === 'win32' || !refreshedGroups.has(process.processGroupId))
    .map((process) => process.pid)
    .sort((left, right) => left - right);
  const target: LocalTerminationTarget = {
    kind: 'owned-process-set',
    processGroupIds: refreshedGroupIds,
    pids: refreshedPids,
  };
  return {
    status: reasons.length > 0 ? 'refused' : owned.size > 0 ? 'running' : 'stopped',
    target,
    remainingPids: [...owned.keys()].sort((left, right) => left - right),
    reasons,
  };
}
