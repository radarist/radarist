/**
 * AuditRecorder — fail-safe evidence recorder for the live-audit harness (TEST-011).
 *
 * The pre-release entity-journey audit ran an operator-local harness whose
 * structured step evidence was lost when the run was interrupted before its
 * recorder's `.stop()`. This module is the committed,
 * unit-tested spine that makes that class of loss impossible:
 *
 *  - Every step transition is **atomically checkpointed** to `audit.json`
 *    (write-temp + rename), so an interrupt at any point — including before
 *    `stop()` — leaves a durable record of every completed step plus the
 *    in-flight active step.
 *  - Failure screenshots are **bounded** (count + per-file bytes) so a looping
 *    failure can't fill local disk.
 *  - `cleanup()` is **exact-owned**: it removes only this run's own directory
 *    under the audit root, and the run id is validated to a single safe path
 *    segment so cleanup can never escape that directory (it can never touch
 *    primary data or a sibling run).
 *
 * It writes only under the gitignored `reports/live-audit/<runId>/` prefix
 * by default.
 */
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

export type AuditStepStatus = 'active' | 'passed' | 'failed';

export interface AuditStep {
  index: number;
  name: string;
  status: AuditStepStatus;
  startedAt: number;
  endedAt?: number;
  error?: string;
  screenshots: string[];
}

export interface AuditCheckpoint {
  runId: string;
  dir: string;
  startedAt: number;
  updatedAt: number;
  finished: boolean;
  finishedAt?: number;
  steps: AuditStep[];
  screenshotsRetained: number;
  screenshotsDropped: number;
}

export interface AuditRecorderOptions {
  /** Run identifier — becomes the exact-owned directory segment. */
  runId: string;
  /**
   * Root the run directory lives under. Defaults to `reports/live-audit`
   * (gitignored). Tests inject a temp dir; the safety invariant (cleanup can
   * only touch `<outputRoot>/<runId>`) holds for any root.
   */
  outputRoot?: string;
  /** Max failure screenshots retained across the run. Default 12. */
  maxScreenshots?: number;
  /** Screenshots larger than this many bytes are dropped, not written. Default 5 MiB. */
  maxScreenshotBytes?: number;
  /** Injectable monotonic clock (ms) for deterministic tests. */
  now?: () => number;
}

export const DEFAULT_AUDIT_ROOT = 'reports/live-audit';
export const DEFAULT_MAX_SCREENSHOTS = 12;
export const DEFAULT_MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const CHECKPOINT_FILE = 'audit.json';
const SCREENSHOT_DIR = 'screenshots';
/** A run id must be a single, safe path segment — no traversal, no separators. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate a run id to a single safe path segment. Rejecting `.`/`..`,
 * separators, absolute markers and control characters is what guarantees
 * `cleanup()` can never escape `<outputRoot>/<runId>`.
 */
export function assertSafeRunId(runId: unknown): asserts runId is string {
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128) {
    throw new Error(`AuditRecorder: runId must be a non-empty string ≤128 chars, got ${String(runId)}`);
  }
  if (runId === '.' || runId === '..' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`AuditRecorder: unsafe runId ${JSON.stringify(runId)} — must match ${SAFE_RUN_ID}`);
  }
}

export class AuditRecorder {
  readonly runId: string;
  readonly dir: string;
  private readonly outputRoot: string;
  private readonly maxScreenshots: number;
  private readonly maxScreenshotBytes: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private steps: AuditStep[] = [];
  private finished = false;
  private finishedAt?: number;
  private screenshotsRetained = 0;
  private screenshotsDropped = 0;

  constructor(options: AuditRecorderOptions) {
    assertSafeRunId(options.runId);
    this.runId = options.runId;
    this.outputRoot = options.outputRoot ?? DEFAULT_AUDIT_ROOT;
    this.maxScreenshots = options.maxScreenshots ?? DEFAULT_MAX_SCREENSHOTS;
    this.maxScreenshotBytes = options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;
    this.now = options.now ?? Date.now;

    // Resolve the owned directory and assert it stays directly under the root.
    const root = resolve(this.outputRoot);
    this.dir = join(root, this.runId);
    if (dirname(this.dir) !== root) {
      throw new Error(`AuditRecorder: run directory ${this.dir} escapes root ${root}`);
    }
    this.startedAt = this.now();
    mkdirSync(this.dir, { recursive: true });
    this.checkpoint();
  }

  /** Begin a step. Any previously active step is auto-failed as abandoned. */
  startStep(name: string): void {
    if (this.finished) throw new Error('AuditRecorder: cannot start a step after stop()');
    const active = this.activeStep();
    if (active) {
      active.status = 'failed';
      active.endedAt = this.now();
      active.error = active.error ?? 'abandoned: superseded by a new step';
    }
    this.steps.push({
      index: this.steps.length,
      name,
      status: 'active',
      startedAt: this.now(),
      screenshots: [],
    });
    this.checkpoint();
  }

  /** Mark the current active step passed. */
  passStep(): void {
    this.endActive('passed');
  }

  /** Mark the current active step failed, recording the error. */
  failStep(error: unknown): void {
    this.endActive('failed', error);
  }

  private endActive(status: Exclude<AuditStepStatus, 'active'>, error?: unknown): void {
    const active = this.activeStep();
    if (!active) throw new Error('AuditRecorder: no active step to end');
    active.status = status;
    active.endedAt = this.now();
    if (error !== undefined) active.error = error instanceof Error ? error.message : String(error);
    this.checkpoint();
  }

  /**
   * Persist a failure screenshot, bounded by count and per-file size. Returns
   * the written path, or null when the screenshot was dropped by a bound (the
   * drop is still counted in the checkpoint so evidence loss is visible, not silent).
   */
  attachScreenshot(data: Buffer, label = 'shot'): string | null {
    if (this.screenshotsRetained >= this.maxScreenshots || data.length > this.maxScreenshotBytes) {
      this.screenshotsDropped += 1;
      this.checkpoint();
      return null;
    }
    const shotDir = join(this.dir, SCREENSHOT_DIR);
    mkdirSync(shotDir, { recursive: true });
    const safeLabel = label.replace(/[^A-Za-z0-9._-]/g, '_');
    const rel = join(SCREENSHOT_DIR, `${String(this.screenshotsRetained).padStart(3, '0')}-${safeLabel}.png`);
    writeFileSync(join(this.dir, rel), data);
    this.screenshotsRetained += 1;
    const active = this.activeStep();
    if (active) active.screenshots.push(rel);
    this.checkpoint();
    return rel;
  }

  /** Finalize the run. Any still-active step is failed as interrupted. */
  stop(): AuditCheckpoint {
    const active = this.activeStep();
    if (active) {
      active.status = 'failed';
      active.endedAt = this.now();
      active.error = active.error ?? 'interrupted: run stopped with step active';
    }
    this.finished = true;
    this.finishedAt = this.now();
    return this.checkpoint();
  }

  /** Remove ONLY this run's owned directory. Never escapes `<outputRoot>/<runId>`. */
  cleanup(): void {
    const root = resolve(this.outputRoot);
    // Re-assert containment at delete time (defense in depth against a mutated field).
    if (dirname(this.dir) !== root || this.dir === root) {
      throw new Error(`AuditRecorder.cleanup: refusing to remove ${this.dir} — not an owned run dir under ${root}`);
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** The current in-flight step, if any. */
  private activeStep(): AuditStep | undefined {
    const last = this.steps[this.steps.length - 1];
    return last && last.status === 'active' ? last : undefined;
  }

  /** Atomically write the checkpoint (temp file + rename). */
  private checkpoint(): AuditCheckpoint {
    const snapshot: AuditCheckpoint = {
      runId: this.runId,
      dir: this.dir,
      startedAt: this.startedAt,
      updatedAt: this.now(),
      finished: this.finished,
      finishedAt: this.finishedAt,
      steps: this.steps.map((s) => ({ ...s, screenshots: [...s.screenshots] })),
      screenshotsRetained: this.screenshotsRetained,
      screenshotsDropped: this.screenshotsDropped,
    };
    const target = join(this.dir, CHECKPOINT_FILE);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    renameSync(tmp, target); // atomic on POSIX — audit.json is never half-written
    return snapshot;
  }
}

/** Read a run's persisted checkpoint (used by callers and tests to verify retained evidence). */
export function readAuditCheckpoint(dir: string): AuditCheckpoint {
  const file = join(dir, CHECKPOINT_FILE);
  if (!existsSync(file)) throw new Error(`AuditRecorder: no checkpoint at ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as AuditCheckpoint;
}
