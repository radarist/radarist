/**
 * Core contracts for the build-mission sandbox layer.
 *
 * The SandboxDriver interface is the no-rework boundary: the supervisor,
 * provisioner, and session runner only ever talk to this interface, so the
 * backend (docker today, apple-container later, microVM providers after
 * that) is a configuration choice, not an architecture change. Persistence
 * is workspace-volume + git + STATUS.json — never VM-memory snapshots —
 * which every OCI backend can satisfy.
 */
import { z } from 'zod';

/** Result of a command executed on the host or inside the sandbox. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable process executor (argv form, never a shell string on the host). */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; input?: string }
) => Promise<ExecResult>;

/** Explicit in-container identity for commands that cross a privilege boundary. */
export type SandboxExecUser = 'node' | 'preview' | 'root';

export interface SandboxExecOptions {
  timeoutMs?: number;
  input?: string;
  /** Omit to use the image's default unprivileged user. */
  user?: SandboxExecUser;
}

export interface SandboxDetachedExecOptions {
  /** Omit to use the image's default unprivileged user. */
  user?: SandboxExecUser;
}

/** Stable reference to a provisioned sandbox; persisted on the mission doc. */
export interface SandboxRef {
  driver: SandboxDriverName;
  missionId: string;
  containerName: string;
  volumeName: string;
  image: string;
  hostPort: number;
  workspacePath: string;
  /**
   * Named volume holding the mission's declared check dependencies (BUILD-039).
   * Optional so refs persisted before this field existed still parse; a null or
   * absent value means "this mission predates the durable cache" and the
   * dependency preflight reports it honestly instead of assuming a browser.
   */
  browserCacheVolume?: string | null;
}

/**
 * Where a mission's declared check dependencies live (BUILD-039).
 *
 * Playwright resolves browser builds under PLAYWRIGHT_BROWSERS_PATH, which the
 * image points at /opt/ms-playwright — a path in the container's *ephemeral*
 * layer. Recreating the container is the credential boundary between builder
 * and reviewer, so anything the mission installed there was destroyed before
 * the supervisor ran the very checks that needed it. Binding this path to its
 * own named volume makes the dependency outlive the runtime that installed it,
 * without putting it on the workspace volume (which stays 0700/node).
 */
export interface BrowserCacheMount {
  /** Named volume; distinct from the workspace volume so isolation is unchanged. */
  name: string;
  /** Must equal the image's PLAYWRIGHT_BROWSERS_PATH for Playwright to resolve it. */
  mountPath: string;
  /**
   * Verification runtimes bind read-only: the reviewer must be able to execute
   * the browser but must never be able to rewrite the cache while checks run.
   */
  readOnly: boolean;
}

export interface CreateSandboxOptions {
  missionId: string;
  image: string;
  cpus: number;
  memoryGb: number;
  /** Finite cgroup task limit; validated before Docker creates any resource. */
  pidsLimit: number;
  network: string;
  hostPort: number;
  /** Port the mission dev server binds inside the container (ADR mandates 3000). */
  containerPort: number;
  workspacePath: string;
  /** Explicit allowlisted env — never the full host env. */
  env: Record<string, string>;
  /**
   * Durable check-dependency cache (BUILD-039). Omitted only by callers that
   * genuinely want a runtime with no declared dependencies bound.
   */
  browserCacheVolume?: BrowserCacheMount;
}

/**
 * The sandbox backends that actually exist.
 *
 * `'apple-container'` used to be listed here and was accepted by config, but no
 * driver was ever written — every method rejected NOT_IMPLEMENTED. Selecting it
 * let a mission pass validation, get marked `running`, and emit `agent.started`
 * before the provisioner refused (BUILD-010 / AUDIT-011). A backend is added to
 * this union when it is implemented, not before.
 */
export type SandboxDriverName = 'docker';

/** One bounded point-in-time sample of the container process namespace. */
export interface SandboxProcessTelemetry {
  /** Current cgroup task count. */
  current: number;
  /** Highest cgroup task count since container creation, when the kernel exposes it. */
  peak: number | null;
  /** Active cgroup limit; null exposes an old/unbounded runtime honestly. */
  limit: number | null;
  /** Processes whose `ps` state starts with Z at sample time. */
  zombies: number;
}

export interface SandboxDriver {
  readonly name: SandboxDriverName;
  /** Create volume + container (idle entrypoint), ready for exec. */
  create(opts: CreateSandboxOptions): Promise<SandboxRef>;
  /**
   * Run argv inside the sandbox workspace; resolves with the exec result.
   * When `input` is provided it is piped to stdin — files written this way
   * are owned by the container user (host-side `docker cp` preserves host
   * uids, which the unprivileged session user cannot write to).
   */
  exec(ref: SandboxRef, argv: string[], opts?: SandboxExecOptions): Promise<ExecResult>;
  /** Fire-and-forget argv inside the sandbox (agent sessions). */
  execDetached(ref: SandboxRef, argv: string[], opts?: SandboxDetachedExecOptions): Promise<void>;
  /** Copy a host file or directory into the sandbox. */
  copyIn(ref: SandboxRef, hostPath: string, containerPath: string): Promise<void>;
  /** Copy a file or directory OUT of the sandbox to the host (harvest). */
  copyOut(ref: SandboxRef, containerPath: string, hostPath: string): Promise<void>;
  /** Stop the container, KEEP the volume (pause). */
  stop(ref: SandboxRef): Promise<void>;
  /** Restart a stopped container (resume on the same volume). */
  resume(ref: SandboxRef): Promise<void>;
  /** Remove the container; volume removed only when explicitly requested. */
  destroy(ref: SandboxRef, opts?: { removeVolume?: boolean }): Promise<void>;
  isRunning(ref: SandboxRef): Promise<boolean>;
  /** Host ports currently claimed by this driver's sandboxes. */
  usedHostPorts(): Promise<number[]>;
  /** Optional backend capability for process-leak observability. */
  processTelemetry?(ref: SandboxRef): Promise<SandboxProcessTelemetry>;
}

/** One bounded agent session inside the sandbox. */
export interface SessionSpec {
  index: number;
  model: string;
  maxTurns: number;
  /**
   * Hard wall-clock ceiling for the in-container CLI process. The wrapper
   * enforces this independently of supervisor polling so a stalled worker or
   * delayed durable replay cannot leave paid work running past its envelope.
   */
  maxMinutes: number;
  /**
   * The kickoff prompt for this session: the frozen standard-tier
   * `KICKOFF_PROMPT`, the frozen fresh-reviewer prompt, or an explicitly
   * enabled per-artifact `/goal` builder kickoff. Behavioral fixes belong in
   * the skill pack or these frozen role contracts, never ad-hoc call sites.
   */
  prompt: string;
  /**
   * Per-launch CLI spend ceiling in USD (`--max-budget-usd`). The supervisor
   * sets this to the lower of the configured session budget and the mission's
   * REMAINING budget, so a single session can't overrun the mission cap before
   * the post-hoc budget gate catches it.
   *
   * Omit to run the CLI with no per-session cap.
   *
   * AUDIT-016 — a non-positive value is NOT "no cap"; it is an error. It means
   * the mission has no headroom left, and `buildSessionScript` throws rather
   * than dropping the flag and launching an uncapped CLI. Callers must refuse
   * the launch before they get here (see `remainingBudgetUsd`).
   */
  maxBudgetUsd?: number;
  /**
   * `claude -p --effort` level (BUILD-012/013): low|medium|high|xhigh|max.
   * The `limitless` build tier sets a raised base effort and steps it up on
   * escalation. Omit to run at the CLI default effort.
   */
  effort?: string;
}

/**
 * One SERVED model's usage as the headless CLI reports it on the final
 * `result` line (`result.modelUsage[<served model>]`).
 *
 * This is the finest granularity the headless protocol reports
 * AUTHORITATIVELY. The per-response `assistant` lines look finer, but their
 * `output_tokens` is a mid-stream snapshot and auxiliary models never appear
 * there at all — see the boundary contract in `stream-json.ts`. So the served
 * model, not the individual response, is the accounting unit.
 *
 * Every field is validated defensively: the parser must stay tolerant of a CLI
 * version that omits or reshapes a counter, and a malformed counter must be
 * DROPPED rather than coerced into a confident zero.
 */
export const sessionModelUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheCreationInputTokens: z.number().int().nonnegative().optional(),
  /** Per-model provider-authoritative cost. `undefined` = unreported, `0` = a KNOWN zero. */
  costUSD: z.number().nonnegative().optional(),
});
export type SessionModelUsage = z.infer<typeof sessionModelUsageSchema>;

/**
 * The session-wide cache-creation tier split (`result.usage.cache_creation`).
 * The 5-minute and 1-hour cache-write tiers are priced differently (1.6×), so
 * the split is load-bearing for any derived estimate. It is reported for the
 * SESSION, not per model, which is why the receipt bridge may only attribute it
 * per model when the attribution is unambiguous.
 */
export const sessionCacheCreationSchema = z.object({
  ephemeral5mInputTokens: z.number().int().nonnegative().optional(),
  ephemeral1hInputTokens: z.number().int().nonnegative().optional(),
});
export type SessionCacheCreation = z.infer<typeof sessionCacheCreationSchema>;

export const sessionResultSchema = z.object({
  subtype: z.string(),
  numTurns: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  durationMs: z.number().nonnegative().optional(),
  // The CLI sets `is_error: true` on the result line for a failed run even
  // when `subtype === 'success'` (e.g. a 404 model_not_found). Never infer
  // success from subtype alone — read isError. `apiErrorStatus` carries the
  // HTTP status (404 bad model / 401 auth / 403 access — non-retryable) and
  // `resultText` the human-readable error so the supervisor can surface and
  // fast-abort instead of silently burning the session cap.
  isError: z.boolean().optional(),
  apiErrorStatus: z.number().int().optional(),
  resultText: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .partial()
    .optional(),
  /**
   * Per-SERVED-model usage and provider-authoritative cost. Present on every
   * CLI version that reports `result.modelUsage`; absent otherwise, in which
   * case the receipt bridge falls back to the aggregate session facts and
   * records honest `requested-fallback` / `partial` provenance.
   *
   * `.catch(undefined)` is deliberate and load-bearing: `totalCostUsd` on this
   * same line is the supervisor's BUDGET AUTHORITY. A future CLI version that
   * reshapes one `modelUsage` entry must degrade the accounting BREAKDOWN to
   * absent — it must never fail the whole result line, because that would drop
   * the authoritative cost and make the supervisor charge the full reservation
   * for a session the provider actually priced. Dropping the breakdown WHOLE
   * (not per-entry) is the fail-closed choice: a partially-parsed breakdown
   * would silently under-attribute the models it could not read.
   */
  modelUsage: z.record(z.string(), sessionModelUsageSchema).optional().catch(undefined),
  /** Session-wide cache-write tier split, when the CLI reports it. */
  cacheCreation: sessionCacheCreationSchema.optional().catch(undefined),
});
export type SessionResult = z.infer<typeof sessionResultSchema>;

/**
 * Deterministic host-port pick for a mission: hash into the configured
 * range, then linear-probe past ports already taken.
 */
export function pickHostPort(missionId: string, rangeStart: number, rangeEnd: number, taken: number[]): number {
  const size = rangeEnd - rangeStart + 1;
  if (size <= 0) throw new Error(`Invalid port range ${rangeStart}-${rangeEnd}`);
  let hash = 0;
  for (const ch of missionId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const takenSet = new Set(taken);
  for (let probe = 0; probe < size; probe++) {
    const port = rangeStart + ((hash + probe) % size);
    if (!takenSet.has(port)) return port;
  }
  throw new Error(`No free host port in ${rangeStart}-${rangeEnd} (all ${size} taken)`);
}
