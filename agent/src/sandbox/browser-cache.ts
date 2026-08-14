/**
 * Durable check-dependency cache and its fail-closed preflight (BUILD-039).
 *
 * ## The defect this closes
 *
 * The sandbox image points PLAYWRIGHT_BROWSERS_PATH at /opt/ms-playwright and
 * pre-warms one chromium there. A mission that installs its own
 * @playwright/test version fetches a *different* browser build into that same
 * path — which lives in the container's ephemeral writable layer, not on the
 * workspace volume.
 *
 * `recreateSandboxRuntime` destroys the container (keeping only the workspace
 * volume) because that is the credential boundary between the builder and the
 * reviewer. Without a durable browser cache, later checks lose a dependency
 * that earlier phases installed and can reject an otherwise valid handoff.
 *
 * ## The fix
 *
 * Bind the browser path to its own named volume so the dependency outlives the
 * runtime that installed it, and verify it by *executing* the browser as the
 * user that will run the checks before trusting any check result. Two distinct
 * failure vectors are covered, because fixing only the first still fails:
 *
 *  1. **Ephemeral-layer loss** — the cache volume persists across recreation.
 *  2. **UID mismatch** — acceptance checks run as `preview` (uid 1001) while
 *     the image chowns /opt/ms-playwright to `node` (uid 1000). A cache that
 *     survives but is unreadable by the check user is still a broken runtime,
 *     so the probe runs as the real check user rather than testing a mode bit.
 *
 * When a declared check needs a browser and the runtime cannot execute one,
 * this module fails *before* the supervisor runs checks — turning a fleet of
 * phantom check failures and a stall loop into one honest, cheap error.
 */
import { buildSanitizedShellCommand } from './session.js';
import { browserCacheVolumeNameFor } from './drivers/docker.js';
import type { Check } from './checks.js';
import type { BrowserCacheMount, SandboxDriver, SandboxExecUser, SandboxRef } from './types.js';

/**
 * Must equal the sandbox image's `ENV PLAYWRIGHT_BROWSERS_PATH`. Playwright
 * resolves browser builds relative to that variable, so a mount anywhere else
 * would persist bytes nothing ever reads. A wiring test pins this constant to
 * the Dockerfile so the two cannot drift.
 */
export const BROWSER_CACHE_MOUNT_PATH = '/opt/ms-playwright';

/** Bounded probe: locating and version-executing a browser is fast or broken. */
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Describe the cache mount for one mission.
 *
 * Agent runtimes bind read-write (the mission legitimately installs its own
 * browser build). Verification runtimes bind read-only: the reviewer must be
 * able to *execute* the browser but must never be able to rewrite the cache
 * while its own acceptance checks are running.
 */
export function browserCacheMountFor(missionId: string, opts: { readOnly: boolean }): BrowserCacheMount {
  return {
    name: browserCacheVolumeNameFor(missionId),
    mountPath: BROWSER_CACHE_MOUNT_PATH,
    readOnly: opts.readOnly,
  };
}

/**
 * Does any declared acceptance check drive a browser?
 *
 * Conservative on purpose: a false positive costs one cheap probe, while a
 * false negative reinstates the original defect (running browser checks
 * against a runtime with no browser and believing the failures).
 */
export function checksRequireBrowser(checks: readonly Check[]): boolean {
  return checks.some((check) => /(^|[^\w-])(playwright|puppeteer)([^\w-]|$)/i.test(check.command));
}

export interface CheckDependencyVerdict {
  /** Whether any declared check actually needs a browser. */
  required: boolean;
  /** True when a browser was located AND executed successfully as `user`. */
  satisfied: boolean;
  /** Resolved executable path when satisfied; null otherwise. */
  executable: string | null;
  /** Version banner when satisfied, else the reason it is unsatisfied. */
  detail: string;
}

/**
 * Shell probe run as the prospective check user.
 *
 * `[ -x ]` and the trailing `--version` are evaluated by that user's own
 * credentials, so this answers "can the reviewer run a browser?" rather than
 * the weaker "does a file exist?". Both questions have different answers under
 * the preview-UID split that made this bug survivable.
 *
 * Exported (with an overridable mount path) so every branch is provable
 * against a real shell without Docker: exit 3 no directory, 4 no executable,
 * 5 present but not executable by this user, 6 present but fails to run.
 */
export function buildBrowserProbeCommand(mountPath: string): string {
  return [
    `p=${mountPath}`,
    `[ -d "$p" ] || { echo "no browser cache directory at $p" >&2; exit 3; }`,
    `b=$(find "$p" -maxdepth 4 -type f \\( -name chrome -o -name headless_shell \\) 2>/dev/null | head -1)`,
    `[ -n "$b" ] || { echo "no chromium executable under $p" >&2; exit 4; }`,
    `[ -x "$b" ] || { echo "$b is not executable by $(id -un)" >&2; exit 5; }`,
    `v=$("$b" --version 2>&1) || { echo "$b failed to execute: $v" >&2; exit 6; }`,
    `echo "$b|$v"`,
  ].join('; ');
}

/**
 * Prove the runtime can execute a browser as the user that will run checks.
 *
 * Never throws on a missing browser — the caller decides whether absence is
 * fatal, because a mission with no browser-driven checks is legitimately fine.
 */
export async function probeBrowserExecutable(
  driver: SandboxDriver,
  ref: SandboxRef,
  opts?: { user?: SandboxExecUser; mountPath?: string }
): Promise<{ ok: boolean; executable: string | null; detail: string }> {
  const mountPath = opts?.mountPath ?? BROWSER_CACHE_MOUNT_PATH;
  const result = await driver.exec(ref, ['sh', '-c', buildSanitizedShellCommand(buildBrowserProbeCommand(mountPath))], {
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(opts?.user ? { user: opts.user } : {}),
  });
  if (result.code !== 0) {
    return { ok: false, executable: null, detail: (result.stderr || result.stdout).trim().slice(-500) };
  }
  const [executable, version] = result.stdout.trim().split('|');
  if (!executable) {
    return { ok: false, executable: null, detail: 'browser probe returned no executable path' };
  }
  return { ok: true, executable, detail: (version ?? '').trim() };
}

/**
 * Decide whether declared check dependencies are satisfied in this runtime.
 *
 * Returns a verdict rather than throwing so callers can log it on the happy
 * path; `assertCheckDependenciesSatisfied` is the fail-closed wrapper used at
 * the point where the next step would otherwise cost money.
 */
export async function verifyCheckDependencies(
  driver: SandboxDriver,
  ref: SandboxRef,
  checks: readonly Check[],
  opts?: { user?: SandboxExecUser; mountPath?: string }
): Promise<CheckDependencyVerdict> {
  if (!checksRequireBrowser(checks)) {
    return { required: false, satisfied: true, executable: null, detail: 'no browser-driven checks declared' };
  }
  const probe = await probeBrowserExecutable(driver, ref, opts);
  return { required: true, satisfied: probe.ok, executable: probe.executable, detail: probe.detail };
}

/** Raised when a runtime cannot satisfy a declared check dependency. */
export class MissingCheckDependencyError extends Error {
  readonly verdict: CheckDependencyVerdict;
  constructor(verdict: CheckDependencyVerdict) {
    super(
      'Declared acceptance checks require a browser, but this runtime cannot execute one ' +
        `(${verdict.detail || 'no detail'}). Refusing to run checks or dispatch another session: ` +
        'their failures would be runtime defects, not mission defects.'
    );
    this.name = 'MissingCheckDependencyError';
    this.verdict = verdict;
  }
}

/**
 * Fail closed before spending.
 *
 * Called after recreation and *before* acceptance checks run. Without this the
 * supervisor reports every browser check as a mission failure, rejects a
 * genuine `STATUS=done` + `qa=PASS`, and opens a stall that buys another paid
 * session to "fix" a defect that lives in the runtime.
 */
export async function assertCheckDependenciesSatisfied(
  driver: SandboxDriver,
  ref: SandboxRef,
  checks: readonly Check[],
  opts?: { user?: SandboxExecUser; mountPath?: string }
): Promise<CheckDependencyVerdict> {
  const verdict = await verifyCheckDependencies(driver, ref, checks, opts);
  if (verdict.required && !verdict.satisfied) throw new MissingCheckDependencyError(verdict);
  return verdict;
}
