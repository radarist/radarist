/**
 * Bounded agent sessions inside the sandbox.
 *
 * A session is `claude -p` headless launched detached inside the container;
 * a root-owned wrapper appends stream-json under /run/impulse-supervisor and
 * writes the exit code there on completion. Only the Claude child drops to the
 * unprivileged node user. Mission code cannot write the transcript, completion
 * marker, or once-only launch lock that the supervisor trusts.
 *
 * `--dangerously-skip-permissions` is intentional: the container IS the
 * permission boundary (documented in docs/LIMITATIONS.md).
 */
import { clearForceStop, writeForceStop } from './status.js';
import type { SandboxDriver, SandboxRef, SessionSpec } from './types.js';

/** Frozen kickoff — behavioral fixes go into the skill pack, never here. */
export const KICKOFF_PROMPT = 'Read MISSION.md and execute it following the mission-methodology skill.';

/** Frozen fresh-context Phase 08 reviewer contract. */
export const QA_REVIEW_PROMPT = [
  'Act only as the fresh-context Phase 08 reviewer.',
  'Read MISSION.md, .impulse/STATUS.json, the phase artifacts, the qa-gate skill, and git history.',
  'Independently rerun every acceptance check and user flow; create your own evidence under .impulse/qa-screenshots/.',
  'Do not edit product code, dependencies, checks, phase 00-07 documents, or the builder evidence.',
  'Write a fresh .impulse/qa-report.json with an ISO checkedAt and commit only QA evidence plus .impulse/STATUS.json.',
  'On PASS set STATUS.phase to done. On FAIL keep STATUS.phase at 08-qa, record the findings, and stop without fixing anything.',
].join(' ');

/** The task handed to the Limitless `/goal` session once its condition is met. */
const GOAL_TASK = 'Read MISSION.md and execute it following the mission-methodology skill.';

/**
 * Optional Limitless builder kickoff. Its condition ends at the phase-08
 * handoff and explicitly forbids a QA verdict; the supervisor launches the
 * independent reviewer in a separate CLI context.
 *
 * `evaluation` omits the Design Brief clause (evaluation artifacts have no
 * UI to conform); `solution` adds it as part of the acceptance bar.
 *
 * The exact `/goal <condition>. <task>` invocation shape is the documented
 * form; live-CLI verification against the real `claude -p '/goal …'`
 * behavior is Task 0 and has not landed as of this writing — treat the
 * returned string's shape as provisional until Task 0 confirms it.
 */
export function buildGoalKickoff(artifactKind: 'solution' | 'evaluation'): string {
  const condition =
    artifactKind === 'evaluation'
      ? '.impulse/STATUS.json is at phase 08-qa with readyForQa true, every check passes, docs/07-test-report.md and phase-07 screenshots exist, .impulse/verdict.json has a valid verdict, and .impulse/qa-report.json does not exist'
      : '.impulse/STATUS.json is at phase 08-qa with readyForQa true, every check passes, docs/07-test-report.md and phase-07 screenshots exist, .impulse/qa-report.json does not exist, and the UI conforms to the Design Brief in MISSION.md';
  return `/goal ${condition}. ${GOAL_TASK}`;
}

/** Ephemeral, root-only authority state. Never place these files on the mission volume. */
export const SESSION_CONTROL_ROOT = '/run/impulse-supervisor';
export const SESSION_HOME_ROOT = '/run/impulse-session-homes';

export function sessionPaths(index: number) {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`invalid session index ${index}`);
  }
  return {
    wrapper: `${SESSION_CONTROL_ROOT}/session-${index}.wrapper.sh`,
    identity: `${SESSION_CONTROL_ROOT}/session-${index}.identity`,
    transcript: `${SESSION_CONTROL_ROOT}/session-${index}.jsonl`,
    stderr: `${SESSION_CONTROL_ROOT}/session-${index}.stderr.log`,
    exitcode: `${SESSION_CONTROL_ROOT}/session-${index}.exitcode`,
    launchLock: `${SESSION_CONTROL_ROOT}/session-${index}.launch`,
  };
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Fail-closed scrub for secrets inherited from a reused container.
 *
 * Docker cannot change a container's configured environment on resume. The
 * current supervisor allowlist is therefore persisted under the freshly
 * restored `.claude` control plane, and every shell that can execute mission
 * code removes every non-runtime variable absent from that allowlist. This
 * covers arbitrary historical `envAllowlist` names (not just *_KEY patterns)
 * while preserving explicit current opt-ins. A missing marker authorizes no
 * caller-provided environment.
 */
const SESSION_ENV_SCRUB = String.raw`for key in $(env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'); do case "$key" in PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|_|HOSTNAME|TERM|LANG|LC_*|TZ|NODE_VERSION|YARN_VERSION|PLAYWRIGHT_BROWSERS_PATH|CLAUDE_CODE_MAX_OUTPUT_TOKENS) ;; *) grep -Fxq "$key" .claude/.supervisor-env-allowlist 2>/dev/null || unset "$key" ;; esac; done`;

/** Prefix a mission-controlled shell command with the resumed-env scrub. */
export function buildSanitizedShellCommand(command: string): string {
  return `${SESSION_ENV_SCRUB}; ${command}`;
}

/** The in-container wrapper script for one session (exported for tests). */
export function buildSessionScript(spec: SessionSpec): string {
  if (!Number.isSafeInteger(spec.index) || spec.index < 0) {
    throw new Error(`refusing to launch session with invalid index ${spec.index}`);
  }
  const paths = sessionPaths(spec.index);
  if (!Number.isFinite(spec.maxMinutes) || spec.maxMinutes <= 0) {
    throw new Error(`refusing to launch session ${spec.index}: maxMinutes must be positive and finite`);
  }
  // BUILD-014 / AUDIT-016: cap the CLI's API spend per launch, and FAIL CLOSED.
  //
  // `undefined` still means "no per-session cap" — that is the caller explicitly
  // opting out, and it is the pre-BUILD-014 behaviour.
  //
  // A budget that is PRESENT but non-positive is a different thing entirely: it
  // means the mission has no spend headroom left. The original code dropped the
  // flag in that case, which launched the CLI *uncapped* — the exact runaway the
  // flag exists to prevent. That was unreachable until AUDIT-016 seeded the
  // supervisor's spend counter, at which point an exhausted mission computes
  // `remaining === 0` and would have hit it on the very first over-budget
  // iterate. Refuse to build the script instead.
  if (spec.maxBudgetUsd !== undefined && !(Number.isFinite(spec.maxBudgetUsd) && spec.maxBudgetUsd > 0)) {
    throw new Error(
      `refusing to launch session ${spec.index}: maxBudgetUsd=${spec.maxBudgetUsd} leaves no spend headroom ` +
        `(dropping --max-budget-usd here would run the CLI with no cap)`
    );
  }
  const budgetArgs = spec.maxBudgetUsd !== undefined ? ['--max-budget-usd', String(spec.maxBudgetUsd)] : [];
  // BUILD-012/013: raise the effort tier under `limitless`. Omit for the CLI
  // default so standard builds are byte-identical to before.
  const effortArgs = spec.effort ? ['--effort', shellQuote(spec.effort)] : [];
  const sessionHome = `${SESSION_HOME_ROOT}/${spec.index}`;
  const maxSeconds = spec.maxMinutes * 60;
  const claude = [
    '/usr/bin/timeout',
    '--foreground',
    '--signal=TERM',
    '--kill-after=30s',
    `${maxSeconds}s`,
    '/usr/bin/setpriv',
    '--reuid=node',
    '--regid=node',
    '--init-groups',
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--bounding-set=-all',
    '/usr/bin/env',
    '-u',
    'IMPULSE_SESSION_TOKEN',
    `HOME=${shellQuote(sessionHome)}`,
    'USER=node',
    'LOGNAME=node',
    `XDG_CONFIG_HOME=${shellQuote(`${sessionHome}/.config`)}`,
    `CLAUDE_CONFIG_DIR=${shellQuote(`${sessionHome}/.claude`)}`,
    '/usr/local/bin/claude',
    '-p',
    shellQuote(spec.prompt),
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(spec.maxTurns),
    '--model',
    shellQuote(spec.model),
    ...budgetArgs,
    ...effortArgs,
    '--dangerously-skip-permissions',
  ].join(' ');
  const recordExit = [
    'record_exit() { exit_value="$1"',
    `exit_tmp=${shellQuote(`${paths.exitcode}.tmp`)}.$$`,
    `/usr/bin/printf '%s\\n' "$exit_value" > "$exit_tmp"`,
    `/bin/mv -f -- "$exit_tmp" ${shellQuote(paths.exitcode)}`,
    '}',
  ].join('; ');
  const body = [
    'umask 077',
    // The empty directory is an atomic, persistent once-only guard. If an
    // Inngest launch step is replayed after docker exec --detach succeeded,
    // the duplicate wrapper exits without starting another paid CLI process.
    `if ! /bin/mkdir -- ${shellQuote(paths.launchLock)} 2>/dev/null; then exit 0; fi`,
    `/bin/rm -rf -- ${shellQuote(sessionHome)}`,
    `/usr/bin/install -d -o node -g node -m 0700 -- ${shellQuote(sessionHome)} ${shellQuote(`${sessionHome}/.config`)} ${shellQuote(`${sessionHome}/.claude`)}`,
    `/bin/rm -f -- ${shellQuote(paths.exitcode)}`,
    `: > ${shellQuote(paths.transcript)}`,
    `: > ${shellQuote(paths.stderr)}`,
    recordExit,
    'wrapper_pid=$$',
    `wrapper_pgid=$(/bin/ps -o pgid= -p "$wrapper_pid" | /usr/bin/tr -d '[:space:]')`,
    `wrapper_start=$(/usr/bin/awk '{print $22}' "/proc/$wrapper_pid/stat" 2>/dev/null || true)`,
    'case "$wrapper_pid:$wrapper_pgid:$wrapper_start:$session_token" in *[!0-9a-fA-F:-]*|*::*|:*|*:) record_exit 125; exit 125 ;; esac',
    '[ "$wrapper_pid" -gt 1 ] && [ "$wrapper_pid" -eq "$wrapper_pgid" ] || { record_exit 125; exit 125; }',
    `identity_tmp=${shellQuote(`${paths.identity}.tmp`)}.$$`,
    `/usr/bin/printf '%s %s %s %s\\n' "$wrapper_pid" "$wrapper_pgid" "$wrapper_start" "$session_token" > "$identity_tmp"`,
    `/bin/mv -f -- "$identity_tmp" ${shellQuote(paths.identity)}`,
    'terminated=0',
    "trap 'terminated=1' TERM HUP INT",
    `${claude} >> ${shellQuote(paths.transcript)} 2>> ${shellQuote(paths.stderr)}`,
    'code=$?',
    "trap - TERM HUP INT",
    '[ "$terminated" -eq 0 ] || code=143',
    'record_exit "$code"',
    'exit "$code"',
  ].join('; ');
  // Save the root-only launch token as a non-exported shell variable before
  // the generic environment scrub removes it. Linux `/proc/<pid>/environ`
  // retains the initial value for identity verification, while neither the
  // Claude child nor unrelated sanitized commands inherit it.
  return `session_token=\${IMPULSE_SESSION_TOKEN:-}; unset IMPULSE_SESSION_TOKEN; ${buildSanitizedShellCommand(body)}`;
}

export async function launchSession(driver: SandboxDriver, ref: SandboxRef, spec: SessionSpec): Promise<void> {
  await clearForceStop(driver, ref);
  const forceStopCleared = await driver.exec(ref, ['/usr/bin/test', '!', '-e', '.impulse/force-stop'], {
    user: 'root',
  });
  if (forceStopCleared.code !== 0) {
    throw new Error(`failed to clear force-stop before launching session ${spec.index}`);
  }
  const paths = sessionPaths(spec.index);
  const wrapper = buildSessionScript(spec);
  const wrapperTmp = `${paths.wrapper}.tmp`;
  const installScript = [
    'set -eu',
    'umask 077',
    `/usr/bin/install -d -o root -g root -m 0700 -- ${shellQuote(SESSION_CONTROL_ROOT)}`,
    `/usr/bin/install -d -o root -g root -m 0711 -- ${shellQuote(SESSION_HOME_ROOT)}`,
    `wrapper_tmp=${shellQuote(wrapperTmp)}.$$`,
    `trap '/bin/rm -f -- "$wrapper_tmp"' EXIT`,
    '/bin/cat > "$wrapper_tmp"',
    '/bin/chown root:root "$wrapper_tmp"',
    '/bin/chmod 0700 "$wrapper_tmp"',
    `/bin/mv -f -- "$wrapper_tmp" ${shellQuote(paths.wrapper)}`,
    'trap - EXIT',
  ].join('; ');
  const installed = await driver.exec(ref, ['/bin/sh', '-c', installScript], {
    input: wrapper,
    user: 'root',
  });
  if (installed.code !== 0) {
    throw new Error(
      `failed to install root-owned session ${spec.index} wrapper: ${installed.stderr || installed.stdout}`.trim()
    );
  }
  // `setsid` makes the trusted wrapper the leader of a unique process group.
  // A root-only random launch token binds its PID to this exact invocation;
  // the token is removed from the unprivileged Claude child's environment.
  const launch = [
    'set -eu',
    'session_token=$(/bin/cat /proc/sys/kernel/random/uuid)',
    "case \"$session_token\" in ''|*[!0-9a-fA-F-]*) exit 125 ;; esac",
    `exec /usr/bin/env IMPULSE_SESSION_TOKEN="$session_token" /usr/bin/setsid /bin/sh ${shellQuote(paths.wrapper)}`,
  ].join('; ');
  await driver.execDetached(ref, ['/bin/sh', '-c', launch], { user: 'root' });
}

export async function isSessionDone(driver: SandboxDriver, ref: SandboxRef, index: number): Promise<boolean> {
  const result = await driver.exec(ref, ['/usr/bin/test', '-f', sessionPaths(index).exitcode], { user: 'root' });
  return result.code === 0;
}

export async function readSessionExitCode(
  driver: SandboxDriver,
  ref: SandboxRef,
  index: number
): Promise<number | null> {
  const result = await driver.exec(ref, ['/bin/cat', sessionPaths(index).exitcode], { user: 'root' });
  if (result.code !== 0) return null;
  const code = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(code) ? code : null;
}

/**
 * Read transcript bytes from `offset` (0-based). Returns the chunk and the
 * next offset; offsets are byte-accurate so multibyte output never drifts.
 */
export async function readTranscriptFrom(
  driver: SandboxDriver,
  ref: SandboxRef,
  index: number,
  offset: number
): Promise<{ chunk: string; nextOffset: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`invalid session transcript offset ${offset}`);
  }
  const transcript = shellQuote(sessionPaths(index).transcript);
  const result = await driver.exec(ref, [
    '/bin/sh',
    '-c',
    `/usr/bin/tail -c +${offset + 1} ${transcript} 2>/dev/null || true`,
  ], { user: 'root' });
  const chunk = result.stdout;
  return { chunk, nextOffset: offset + Buffer.byteLength(chunk, 'utf8') };
}

/** Read the full transcript (finalize step — authoritative result line). */
export async function readFullTranscript(driver: SandboxDriver, ref: SandboxRef, index: number): Promise<string> {
  const result = await driver.exec(ref, ['/bin/cat', sessionPaths(index).transcript], {
    timeoutMs: 60_000,
    user: 'root',
  });
  return result.code === 0 ? result.stdout : '';
}

/**
 * Build the trusted in-container cancellation transaction for one exact
 * session. The identity file is root-owned and binds the wrapper PID/process
 * group to its kernel start time and a per-launch token. TERM gets ten seconds
 * for the wrapper trap to persist the exit marker; KILL is bounded to five.
 */
export function buildKillSessionScript(index: number): string {
  const paths = sessionPaths(index);
  const identity = shellQuote(paths.identity);
  const exitcode = shellQuote(paths.exitcode);
  const wrapper = shellQuote(paths.wrapper);
  const identityMatches = [
    'identity_matches() { [ -r "/proc/$session_pid/stat" ] || return 1',
    'current_pgid=$(/bin/ps -o pgid= -p "$session_pid" 2>/dev/null | /usr/bin/tr -d \'[:space:]\')',
    'current_start=$(/usr/bin/awk \'{print $22}\' "/proc/$session_pid/stat" 2>/dev/null) || return 1',
    '[ "$current_pgid" = "$session_pgid" ] && [ "$current_start" = "$session_start" ] || return 1',
    'current_cmd=$(/usr/bin/tr \'\\000\' \' \' < "/proc/$session_pid/cmdline" 2>/dev/null) || return 1',
    '[ "$current_cmd" = "/bin/sh $wrapper " ] || return 1',
    '/usr/bin/tr \'\\000\' \'\\n\' < "/proc/$session_pid/environ" 2>/dev/null | /bin/grep -Fqx -- "IMPULSE_SESSION_TOKEN=$session_token"',
    '}',
  ].join('; ');
  return [
    'set -u',
    `identity=${identity}`,
    `exitcode=${exitcode}`,
    `wrapper=${wrapper}`,
    'fail() { /usr/bin/printf \'%s\\n\' "$1" >&2; exit "$2"; }',
    'valid_exit() { value=$(/bin/cat "$exitcode" 2>/dev/null) || return 1; case "$value" in \'\'|*[!0-9]*) return 1 ;; esac; return 0; }',
    identityMatches,
    'marker_seen=0',
    'if [ -f "$exitcode" ]; then valid_exit || fail "invalid trusted session exit marker" 70; marker_seen=1; fi',
    'attempt=0',
    'while [ ! -f "$identity" ] && [ ! -f "$exitcode" ] && [ "$attempt" -lt 20 ]; do /bin/sleep 0.1; attempt=$((attempt + 1)); done',
    'if [ -f "$exitcode" ]; then valid_exit || fail "invalid trusted session exit marker" 70; marker_seen=1; fi',
    'if [ ! -r "$identity" ] && [ "$marker_seen" -eq 1 ]; then exit 0; fi',
    '[ -r "$identity" ] || fail "trusted session identity is unavailable" 71',
    "IFS=' ' read -r session_pid session_pgid session_start session_token extra < \"$identity\" || fail \"cannot read trusted session identity\" 71",
    "[ -z \"${extra:-}\" ] || fail \"malformed trusted session identity\" 71",
    'case "$session_pid:$session_pgid:$session_start:$session_token" in *[!0-9a-fA-F:-]*|*::*|:*|*:) fail "malformed trusted session identity" 71 ;; esac',
    '[ "$session_pid" -gt 1 ] && [ "$session_pid" -eq "$session_pgid" ] || fail "unsafe trusted session process group" 71',
    'escalated=0',
    'if /bin/kill -0 -- "-$session_pgid" 2>/dev/null; then',
    // PID wraparound: a long session can complete (valid root-owned exit marker)
    // while an unrelated process has recycled the wrapper PID. The marker is the
    // authoritative completion proof — honor it and leave the stranger process
    // group untouched instead of failing the whole mission. Identity is still
    // strictly required whenever no marker exists.
    'if [ -r "/proc/$session_pid/stat" ]; then identity_matches || { [ "$marker_seen" -eq 1 ] && exit 0; fail "trusted session identity no longer matches its process" 72; }; else [ "$marker_seen" -eq 1 ] || fail "trusted session leader vanished without an exit marker" 72; fi',
    '/bin/kill -TERM -- "-$session_pgid" 2>/dev/null || true',
    'attempt=0',
    'while /bin/kill -0 -- "-$session_pgid" 2>/dev/null && [ "$attempt" -lt 100 ]; do /bin/sleep 0.1; attempt=$((attempt + 1)); done',
    'if [ -f "$exitcode" ]; then valid_exit || fail "invalid trusted session exit marker after TERM" 70; marker_seen=1; fi',
    'if /bin/kill -0 -- "-$session_pgid" 2>/dev/null; then',
    // Re-read the marker before escalation: the TERM window may have let the
    // wrapper publish its exit. Same marker-wins rule as the TERM gate above.
    'if [ -f "$exitcode" ]; then valid_exit && marker_seen=1; fi',
    'if [ -r "/proc/$session_pid/stat" ]; then identity_matches || { [ "$marker_seen" -eq 1 ] && exit 0; fail "refusing KILL after trusted session identity changed" 73; }; else [ "$marker_seen" -eq 1 ] || fail "refusing KILL without a trusted completed session" 73; fi',
    '/bin/kill -KILL -- "-$session_pgid" 2>/dev/null || fail "failed to KILL trusted session process group" 74',
    'escalated=1',
    'attempt=0',
    'while /bin/kill -0 -- "-$session_pgid" 2>/dev/null && [ "$attempt" -lt 50 ]; do /bin/sleep 0.1; attempt=$((attempt + 1)); done',
    '/bin/kill -0 -- "-$session_pgid" 2>/dev/null && fail "trusted session process group survived KILL" 75',
    'fi',
    'fi',
    'if [ ! -f "$exitcode" ]; then',
    'synthetic=143; [ "$escalated" -eq 0 ] || synthetic=137',
    'exit_tmp="$exitcode.kill.$$"',
    '/usr/bin/printf \'%s\\n\' "$synthetic" > "$exit_tmp" || fail "cannot write trusted session exit marker" 76',
    '/bin/mv -f -- "$exit_tmp" "$exitcode" || fail "cannot publish trusted session exit marker" 76',
    'fi',
    'valid_exit || fail "invalid trusted session exit marker after cancellation" 77',
  ].join('\n');
}

/**
 * Kill a running session at a cap. Success means both that the exact trusted
 * process group is gone and that its root-owned completion marker is readable.
 */
export async function quiesceSession(driver: SandboxDriver, ref: SandboxRef, index: number): Promise<void> {
  const killed = await driver.exec(ref, ['/bin/sh', '-c', buildKillSessionScript(index)], {
    timeoutMs: 25_000,
    user: 'root',
  });
  if (killed.code !== 0) {
    throw new Error(
      `failed to quiesce trusted session ${index} (exit ${killed.code}): ${killed.stderr || killed.stdout}`.trim()
    );
  }
  const marker = await driver.exec(ref, ['/bin/cat', sessionPaths(index).exitcode], { user: 'root' });
  if (marker.code !== 0 || !/^\d+\s*$/.test(marker.stdout)) {
    throw new Error(`trusted session ${index} exit marker was not verifiable after quiescence`);
  }
}

/** Arm the in-workspace stop gate, then quiesce the exact trusted session. */
export async function killSession(driver: SandboxDriver, ref: SandboxRef, index: number): Promise<void> {
  await writeForceStop(driver, ref);
  const forceStop = await driver.exec(ref, ['/usr/bin/test', '-f', '.impulse/force-stop'], { user: 'root' });
  if (forceStop.code !== 0) {
    throw new Error(`failed to arm force-stop before killing session ${index}`);
  }
  await quiesceSession(driver, ref, index);
}
