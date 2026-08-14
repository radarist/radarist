/**
 * Executable mission capability policy (SEC-014).
 *
 * Before this module the mission capability boundary was **prompt text**: the
 * worker's comment said "filesystem intentionally excluded — agents must publish
 * through Radarist", the PROFILE.md files said "NEVER use Bash for file writes",
 * and `createPermissionsHooks` checked only that a *subagent* used an allowed MCP
 * *server*. Three holes made that boundary decorative:
 *
 *  - the parent orchestrator was exempt from the hook entirely;
 *  - every non-MCP built-in (`Bash`, `Write`, `Edit`, `NotebookEdit`, and — as of
 *    the current CLI — `CronCreate`, `EnterWorktree`, `RemoteTrigger`,
 *    `PushNotification`, …) was allowed unconditionally for everyone;
 *  - a profile-load failure fell **open** ("subagents will have unrestricted
 *    access").
 *
 * If the Report MCP fails, uncontrolled host-write tools must not become an
 * implicit fallback around the canonical publication path.
 *
 * This module replaces that with a **default-deny** decision function. Nothing is
 * permitted unless the policy names it, so a capability that did not exist when
 * the policy was written — a new CLI built-in, an unknown MCP server, a tool name
 * the model invented — is denied rather than silently granted.
 *
 * It is deliberately pure and dependency-free (aside from Node's `fs`/`path` for
 * symlink resolution) so the full allow/deny matrix is unit-testable without an
 * SDK, a network, or a container.
 */
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Principals
// ---------------------------------------------------------------------------

/**
 * Who is asking. `parent` is the orchestrator's own turn; `subagent` is a
 * profile-backed specialist dispatched via the `Task` tool.
 *
 * Both are **machine** principals: a mission runs autonomously and no human
 * approves individual tool calls. `human` covers the interactive Assistant
 * surface (`Orchestrator.streamChat`), where a signed-in user drives the turn.
 * The distinction changes which policy is selected, never whether the policy is
 * enforced — see `MISSION_CAPABILITY_POLICY` vs `CHAT_CAPABILITY_POLICY`.
 */
export type CapabilityPrincipal = { kind: 'parent' } | { kind: 'subagent'; agentType: string } | { kind: 'human' };

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

export interface CapabilityPolicy {
  /** Built-in (non-MCP) tools this policy permits. Everything else is denied. */
  readonly builtinTools: readonly string[];
  /** MCP servers the parent orchestrator turn may reach. */
  readonly parentMcpServers: readonly string[];
  /** MCP servers each named subagent may reach. A subagent absent here is denied. */
  readonly subagentMcpServers: Readonly<Record<string, readonly string[]>>;
  /**
   * Absolute, already-resolved directories that path-bearing capabilities may
   * touch. Empty means "no path-bearing capability is permitted at all".
   */
  readonly workspaceRoots: readonly string[];
}

/** A stable machine-readable denial reason. */
export type CapabilityDenyCode =
  | 'tool-name-malformed'
  | 'tool-name-dynamic'
  | 'mcp-name-malformed'
  | 'mcp-server-not-allowed'
  | 'mcp-server-alias'
  | 'subagent-unknown'
  | 'builtin-not-allowed'
  | 'path-argument-missing-root'
  | 'path-outside-workspace'
  | 'path-traversal'
  | 'path-symlink-escape'
  | 'policy-missing';

export type CapabilityDecision = { allow: true } | { allow: false; code: CapabilityDenyCode; reason: string };

const allow = (): CapabilityDecision => ({ allow: true });
const deny = (code: CapabilityDenyCode, reason: string): CapabilityDecision => ({ allow: false, code, reason });

// ---------------------------------------------------------------------------
// Built-in tool sets
// ---------------------------------------------------------------------------

/**
 * The built-ins a research mission legitimately needs.
 *
 * Derived from the live tool list the pinned CLI advertises under
 * `tools: { preset: 'claude_code' }` (captured from a `system:init` stream-json
 * line): Task, AskUserQuestion, Bash, CronCreate, CronDelete, CronList, Edit,
 * EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, Glob, Grep, LSP,
 * Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger, ScheduleWakeup,
 * Skill, TaskOutput, TaskStop, TodoWrite, ToolSearch, WebFetch, WebSearch, Write.
 *
 * Everything omitted below is denied, and the omissions are the point:
 *
 *  - `Bash`, `Write`, `Edit`, `NotebookEdit` — host mutation. Reports are
 *    persisted by the `impulse-reports` MCP tools server-side; an agent has no
 *    legitimate reason to write host files, and doing so is the exact escape
 *    SEC-014 exists to close.
 *  - `CronCreate` / `CronDelete` / `CronList`, `RemoteTrigger`, `ScheduleWakeup`,
 *    `PushNotification` — persistent scheduling and outward-facing actions that
 *    outlive the mission and its budget.
 *  - `EnterWorktree` / `ExitWorktree` — mutate the host git checkout.
 *  - `LSP`, `Monitor` — host process/tooling attachment.
 *  - `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` — there is no human in a
 *    headless mission turn; asking would stall until the wall-clock abort.
 *
 * `Read` / `Glob` / `Grep` are permitted but **path-scoped** (see
 * `decideToolCall`) — the mission needs them to re-read a `renderDiagram` SVG
 * from `tmp/missions/<missionId>/svg/` after it rolls out of context.
 */
export const MISSION_BUILTIN_TOOLS: readonly string[] = [
  'Glob',
  'Grep',
  'Read',
  'Skill',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
];

/**
 * Built-ins denied for missions, named explicitly so they can also be handed to
 * the SDK's `disallowedTools` (which removes them from the model's context).
 *
 * This list is a *second* net for context hygiene and cheaper turns. It is NOT
 * the boundary: `decideToolCall` is default-deny, so a built-in that appears in
 * a future CLI without being added here is still denied at execution.
 */
export const MISSION_DENIED_BUILTIN_TOOLS: readonly string[] = [
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'KillShell',
  'LSP',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'PushNotification',
  'RemoteTrigger',
  'ScheduleWakeup',
  'Write',
];

/** Built-ins whose arguments name host paths, and the argument keys to check. */
const PATH_ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path', 'path', 'notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

/**
 * MCP tools that take a host path. The `filesystem` MCP server is the documented
 * publish escape hatch in the PROFILE.md files, so when a deployment does grant
 * it, every path it receives is scoped to the workspace roots exactly like the
 * built-in readers.
 */
const MCP_PATH_ARGUMENT_KEYS: readonly string[] = ['path', 'paths', 'file_path', 'source', 'destination'];

// ---------------------------------------------------------------------------
// Name validation
// ---------------------------------------------------------------------------

/** Conservative shape for any tool name we are willing to reason about. */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/** One `mcp__…` segment: non-empty, alphanumeric-led, no separators of its own. */
const MCP_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Parse an MCP tool name **strictly**: exactly `mcp`, server, tool.
 *
 * `String.split('__')[1]` — the previous implementation — accepted
 * `mcp____evil` (empty server), `mcp__a__b__c` (ambiguous), and any control
 * character or whitespace a prompt-injected name might carry. A name that does
 * not match the exact grammar is not "an MCP call for an unknown server", it is
 * an unparseable name, and the caller denies it.
 *
 * Splitting on `__` and requiring exactly three parts is deliberate. A regex
 * with two greedy segments does NOT solve this: on `mcp__my-server__tool__extra`
 * the server group happily swallows `my-server__tool`, leaving `extra` as the
 * tool — so a compound name still resolves to an allowed server, which is the
 * hole being closed. The split has no such ambiguity.
 *
 * The cost is that a third-party tool whose own name contains `__` is refused
 * rather than guessed at. That is the intended trade: the refusal is loud (a
 * `mcp-name-malformed` denial in the audit trail) and fixable, whereas guessing
 * the split silently grants the wrong server's permissions.
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__');
  if (parts.length !== 3) return null;
  const [prefix, server, tool] = parts as [string, string, string];
  if (prefix !== 'mcp') return null;
  if (!MCP_SEGMENT_RE.test(server) || !MCP_SEGMENT_RE.test(tool)) return null;
  return { server, tool };
}

/**
 * Back-compat shim for the previous export. Returns the server segment only for
 * names that pass the strict grammar; everything else is `undefined`, which the
 * hook treats as a denial rather than as "not an MCP tool".
 */
export function extractMcpServerName(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return parseMcpToolName(toolName)?.server;
}

// ---------------------------------------------------------------------------
// Path scoping
// ---------------------------------------------------------------------------

/**
 * Resolve the longest existing ancestor of `target` through symlinks, then
 * re-append the not-yet-existing tail. `fs.realpathSync` on a path that does not
 * exist throws, and a check that skips missing paths is exactly how a symlinked
 * parent directory smuggles a write outside the workspace.
 */
function resolveThroughSymlinks(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  // Bounded: every iteration removes one segment, and `path.dirname` is a fixed
  // point at the filesystem root.
  for (let i = 0; i < 4096; i += 1) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(target);
}

/** True when `candidate` is `root` itself or lives beneath it. */
function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Decide whether one path argument is inside the policy's workspace roots.
 *
 * Order matters: the raw string is checked for traversal segments BEFORE
 * resolution, so a denial reason distinguishes "the model asked for `../..`"
 * from "a symlink pointed out of the workspace" — two different failures that
 * need two different follow-ups.
 */
export function decidePathArgument(policy: CapabilityPolicy, rawPath: string): CapabilityDecision {
  if (policy.workspaceRoots.length === 0) {
    return deny(
      'path-argument-missing-root',
      'no workspace root is configured, so no path-bearing capability is permitted'
    );
  }
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return deny('path-outside-workspace', 'empty path argument');
  }
  // NUL and other control characters truncate paths in some syscalls.
  if (/[\u0000-\u001f\u007f]/.test(rawPath)) {
    return deny('path-traversal', 'path argument contains control characters');
  }
  if (rawPath.split(/[\\/]/).includes('..')) {
    return deny('path-traversal', `path argument escapes via "..": ${rawPath}`);
  }

  // Two comparisons against two root forms, and they must not be crossed.
  //
  // The LEXICAL check compares the resolved-but-not-followed path against the
  // configured roots as written. The REAL check compares the symlink-resolved
  // path against the symlink-resolved roots. Comparing a lexical candidate to a
  // realpath'd root is a false denial on any platform where the workspace root
  // is itself reached through a link — on macOS `os.tmpdir()` is `/var/…`, a
  // symlink to `/private/var/…`, so crossing the two forms rejects every
  // legitimate mission path.
  const lexicalRoots = policy.workspaceRoots;
  const realRoots = policy.workspaceRoots.map((root) => resolveThroughSymlinks(root));

  const lexical = path.resolve(lexicalRoots[0]!, rawPath);
  const real = resolveThroughSymlinks(lexical);

  const lexicallyInside = lexicalRoots.some((root) => isWithinRoot(lexical, root));
  const reallyInside = realRoots.some((root) => isWithinRoot(real, root));

  if (!lexicallyInside && !reallyInside) {
    return deny('path-outside-workspace', `path argument resolves outside the mission workspace: ${rawPath}`);
  }
  if (!reallyInside) {
    return deny('path-symlink-escape', `path argument leaves the mission workspace through a symlink: ${rawPath}`);
  }

  return allow();
}

/** Every string that looks like a path argument for this tool. */
function collectPathArguments(toolName: string, toolInput: unknown, isMcp: boolean): string[] {
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const record = toolInput as Record<string, unknown>;
  const keys = isMcp ? MCP_PATH_ARGUMENT_KEYS : (PATH_ARGUMENT_KEYS[toolName] ?? []);
  const out: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decide a single tool call. Default-deny: a call is permitted only when the
 * policy names the capability AND every path argument stays inside the
 * workspace.
 */
export function decideToolCall(
  policy: CapabilityPolicy | undefined,
  principal: CapabilityPrincipal,
  toolName: unknown,
  toolInput?: unknown
): CapabilityDecision {
  if (!policy) {
    return deny('policy-missing', 'no capability policy is configured for this run');
  }
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return deny('tool-name-malformed', 'tool name is missing or not a string');
  }
  // A name assembled at runtime from model output can contain whitespace,
  // control characters, or shell metacharacters. Reject the shape outright
  // rather than trying to interpret it.
  if (!TOOL_NAME_RE.test(toolName)) {
    return deny('tool-name-dynamic', `tool name is not a static identifier: ${JSON.stringify(toolName.slice(0, 64))}`);
  }

  if (toolName.startsWith('mcp__')) {
    const parsed = parseMcpToolName(toolName);
    if (!parsed) {
      return deny('mcp-name-malformed', `MCP tool name does not match mcp__<server>__<tool>: ${toolName}`);
    }
    const allowedServers = mcpServersFor(policy, principal);
    if (allowedServers === null) {
      return deny(
        'subagent-unknown',
        `subagent "${(principal as { agentType: string }).agentType}" has no configured capability policy`
      );
    }
    if (!allowedServers.includes(parsed.server)) {
      // An exact-case miss that matches case-insensitively is an alias attempt,
      // not a typo — report it distinctly so it is visible in the audit trail.
      const aliased = allowedServers.some((name) => name.toLowerCase() === parsed.server.toLowerCase());
      return aliased
        ? deny(
            'mcp-server-alias',
            `MCP server "${parsed.server}" is a case alias of an allowed server; exact names only`
          )
        : deny(
            'mcp-server-not-allowed',
            `MCP server "${parsed.server}" is not permitted for ${describePrincipal(principal)} (allowed: ${allowedServers.join(', ') || 'none'})`
          );
    }
    for (const rawPath of collectPathArguments(parsed.tool, toolInput, true)) {
      const decision = decidePathArgument(policy, rawPath);
      if (!decision.allow) return decision;
    }
    return allow();
  }

  if (!policy.builtinTools.includes(toolName)) {
    return deny(
      'builtin-not-allowed',
      `built-in tool "${toolName}" is not permitted for ${describePrincipal(principal)}; ` +
        `persist through the platform MCP tools instead of writing to the host`
    );
  }

  for (const rawPath of collectPathArguments(toolName, toolInput, false)) {
    const decision = decidePathArgument(policy, rawPath);
    if (!decision.allow) return decision;
  }

  return allow();
}

function describePrincipal(principal: CapabilityPrincipal): string {
  if (principal.kind === 'subagent') return `subagent "${principal.agentType}"`;
  if (principal.kind === 'human') return 'the interactive assistant';
  return 'the orchestrator';
}

/** Allowed servers for a principal, or `null` when the subagent is unknown. */
function mcpServersFor(policy: CapabilityPolicy, principal: CapabilityPrincipal): readonly string[] | null {
  if (principal.kind === 'subagent') {
    return policy.subagentMcpServers[principal.agentType] ?? null;
  }
  return policy.parentMcpServers;
}

// ---------------------------------------------------------------------------
// Policy construction
// ---------------------------------------------------------------------------

export interface BuildMissionPolicyInput {
  /** Servers the parent orchestrator turn is configured with. */
  parentMcpServers: readonly string[];
  /** Per-subagent server lists, keyed by agent name. */
  subagentMcpServers: Readonly<Record<string, readonly string[]>>;
  /** Mission workspace roots (absolute). Usually `tmp/missions/<missionId>`. */
  workspaceRoots?: readonly string[];
  /** Override the built-in allowlist. Defaults to {@link MISSION_BUILTIN_TOOLS}. */
  builtinTools?: readonly string[];
}

/**
 * Build the mission policy. Roots are resolved to absolute paths up front so a
 * relative `workspaceRoots` entry cannot be reinterpreted against a different
 * `process.cwd()` later in the run.
 */
export function buildMissionCapabilityPolicy(input: BuildMissionPolicyInput): CapabilityPolicy {
  return {
    builtinTools: [...(input.builtinTools ?? MISSION_BUILTIN_TOOLS)],
    parentMcpServers: [...new Set(input.parentMcpServers)],
    subagentMcpServers: Object.fromEntries(
      Object.entries(input.subagentMcpServers).map(([agent, servers]) => [agent, [...new Set(servers)]])
    ),
    workspaceRoots: (input.workspaceRoots ?? []).map((root) => path.resolve(root)),
  };
}

/**
 * The interactive-assistant (human principal) policy. The signed-in user drives
 * the turn, but the process is still the operator's server: a chat turn has no
 * more business running `Bash` on the host than a mission does, so it inherits
 * the same built-in allowlist. It carries no workspace root because the chat
 * surface has no per-mission directory.
 */
export function buildChatCapabilityPolicy(mcpServers: readonly string[]): CapabilityPolicy {
  return {
    builtinTools: [...MISSION_BUILTIN_TOOLS],
    parentMcpServers: [...new Set(mcpServers)],
    subagentMcpServers: {},
    workspaceRoots: [],
  };
}
