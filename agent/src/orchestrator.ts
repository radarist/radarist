import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentDefinition,
  McpHttpServerConfig,
  McpStdioServerConfig,
  PermissionMode,
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
} from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { AccountingUnavailableError } from './accounting-errors.js';
import { validateRuntimeSkillPlugin } from './runtime-skill-contract.js';
import type { CapabilityPolicy } from './capability-policy.js';
import { MISSION_DENIED_BUILTIN_TOOLS, buildMissionCapabilityPolicy } from './capability-policy.js';
import { createPermissionsHooks } from './hooks/permissions.js';
import { collectLiveSecrets, isSecretEnvName, isSecretKeyName, redactText } from './redaction.js';
import { estimateTurnCostUsd } from './cost-estimation.js';
import {
  NO_ARTIFACT_DELIVERABLE_RULES,
  PUBLISH_COMPLETION_SIGNAL_RULE,
  PUBLISH_PRIVACY_RULE,
} from './publish-contract.js';
import {
  collectMcpEnvReferencedVars,
  INTERNAL_PLATFORM_MCP_ROUTES,
  loadAgentConfig,
  getMcpServerUrl,
  mcpEnvReferencedVars,
  resolveAgentMcpServers,
} from './config.js';
import type { AgentConfig } from './config.js';
export { INTERNAL_PLATFORM_MCP_ROUTES } from './config.js';
import {
  detectModelSubstitution,
  MODEL_FALLBACK_AUTHORIZATION_ENV,
  parseModelAuthorizationEntries,
  resolveFallbackModelSelection,
  resolveSdkModel,
  resolveTransparentRetryFallback,
  UnsupportedModelError,
  UNSUPPORTED_MODEL_FAILURE_KIND,
} from './model-selection.js';
import type { ModelSelectionViolation, ModelSubstitution } from './model-selection.js';
import { loadAllProfiles } from './profiles.js';
import type { AgentProfile } from './profiles.js';
import type { Logger } from './logger.js';

/** Filesystem setting sources are disabled for mission and chat sessions. */

export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_FALLBACK_MODEL = 'claude-haiku-4-5';

function providerSettlementUsd(
  message: SDKResultSuccess | SDKResultError,
  modelUsage: Record<string, ModelUsageSummary> | undefined
): number | null {
  if (Number.isFinite(message.total_cost_usd) && message.total_cost_usd > 0) return message.total_cost_usd;
  const perModel = modelUsage ? Object.values(modelUsage).reduce((sum, usage) => sum + (usage.costUSD ?? 0), 0) : 0;
  return perModel > 0 ? perModel : null;
}

/** Machine-readable {@link MissionResult.failureKind} for an MCP-preflight abort. */
export const MCP_PREFLIGHT_FAILURE_KIND = 'mcp-preflight-failed' as const;

/**
 * Thrown by the pre-spend MCP preflight so `runMission`'s catch can tag the
 * returned {@link MissionResult} with a typed `failureKind` — the worker keys
 * off that to short-circuit every later paid stage instead of treating it as an
 * ordinary orchestrator failure and continuing into recovery/L1/judge/revision.
 */
export class McpPreflightError extends Error {
  readonly failureKind = MCP_PREFLIGHT_FAILURE_KIND;
  constructor(message: string) {
    super(message);
    this.name = 'McpPreflightError';
  }
}

/**
 * Env allowlist for the Claude Agent SDK subprocess (#31 hardening).
 *
 * The SDK spawns the mission/chat subprocess AND its stdio MCP children
 * (`uvx mcp-neo4j-*`, `npx exa-mcp-server`, `npx firecrawl-mcp`, …) as OS
 * processes that inherit whatever `env` we hand the SDK. Spreading the full
 * `process.env` would expose unrelated host credentials to third-party
 * npm/uvx MCP packages we do not control.
 *
 * We instead pass an explicit allowlist — mirroring the sandbox provisioner's
 * `resolveContainerEnv` (see agent/src/sandbox/provisioner.ts). Prefix-allowed
 * families are the SDK's own knobs (`ANTHROPIC_*` / `CLAUDE_*`); the exact-key
 * set covers OS spawn essentials, proxy/TLS trust, internal-MCP auth, and the
 * external stdio-MCP credentials the configured servers declare. Anything else
 * (`GOOGLE_APPLICATION_CREDENTIALS`, `AWS_*`, `GEMINI_*`, `FIREBASE_*`, …)
 * stays on the host and never reaches an MCP child.
 */
const ORCHESTRATOR_ENV_PREFIX_ALLOW: readonly string[] = ['ANTHROPIC_', 'CLAUDE_'];
const ORCHESTRATOR_ENV_KEY_ALLOW: ReadonlySet<string> = new Set([
  // OS spawn essentials — npx/uvx/node child processes need these to resolve
  // binaries, HOME-relative caches, and locale.
  'PATH',
  'HOME',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'NODE_ENV',
  // Proxy + TLS trust (corporate proxies / custom CA bundles).
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // Internal MCP auth + base URL (HTTP servers served by the Next.js app).
  'IMPULSE_API_KEY',
  'IMPULSE_INTERNAL_KEY',
  'IMPULSE_MCP_BASE_URL',
  // External stdio-MCP credentials: neo4j-memory, exa, firecrawl,
  // google research, github. These are declared in impulse.config.yaml's
  // per-server `env:` blocks and resolved from process.env at config load.
  'NEO4J_URI',
  'NEO4J_USERNAME',
  'NEO4J_PASSWORD',
  'NEO4J_DATABASE',
  'EXA_API_KEY',
  'FIRECRAWL_API_KEY',
  'GOOGLE_API_KEY',
  'GITHUB_TOKEN',
]);

/**
 * Build the explicit env for the SDK subprocess. Only allowlisted host vars
 * cross into the subprocess (and thence its inherited stdio-MCP children).
 * `CLAUDE_CODE_MAX_OUTPUT_TOKENS` is always set (default `128000`) so large
 * HTML reports don't hit the SDK's 32K default. Missing keys are simply
 * omitted — auth failures surface from the SDK itself, exactly as before.
 *
 * `referencedMcpEnvVars` (SEC-016) adds exactly the host variables the configured
 * stdio MCP `env:` blocks refer to by `${VAR}`. Those values previously crossed
 * into the same children through the `--mcp-config` argv, so forwarding them here
 * is a narrower channel for the same data — not a new exposure — and it is what
 * makes a preserved reference resolvable on the far side.
 *
 * Exported for unit testing.
 */
export function resolveOrchestratorEnv(
  hostEnv: NodeJS.ProcessEnv = process.env,
  referencedMcpEnvVars: readonly string[] = []
): Record<string, string> {
  const referenced = new Set(referencedMcpEnvVars);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined) continue;
    if (
      ORCHESTRATOR_ENV_PREFIX_ALLOW.some((prefix) => key.startsWith(prefix)) ||
      ORCHESTRATOR_ENV_KEY_ALLOW.has(key) ||
      referenced.has(key)
    ) {
      env[key] = value;
    }
  }
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = hostEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '128000';
  return env;
}

/**
 * SEC-013 — env vars whose value may back the internal MCP `x-api-key` header.
 *
 * The worker hands the Orchestrator `IMPULSE_INTERNAL_KEY`; the standalone CLI
 * hands it `IMPULSE_API_KEY`. Both are forwarded to the SDK subprocess by
 * {@link resolveOrchestratorEnv}, which is what makes a `${VAR}` reference
 * resolvable on the far side.
 */
const MCP_AUTH_ENV_CANDIDATES: readonly string[] = ['IMPULSE_INTERNAL_KEY', 'IMPULSE_API_KEY'];
const MCP_CHILD_AUTH_ENV = 'RADARIST_MCP_AUTH_KEY';

/** `${VAR}` reference, the only shape the CLI's MCP config loader expands. */
const MCP_ENV_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * The curated MCP surface for the interactive Assistant (`streamChat`).
 *
 * Hoisted to a module constant so the capability policy and the transport are
 * built from ONE list. When these diverged, the policy would have denied a
 * server the transport had just configured.
 */
const CHAT_MCP_SERVERS: readonly string[] = [
  // Internal HTTP servers (curated business tools)
  'impulse-entities',
  'impulse-graph',
  'impulse-signals',
  'impulse-research',
  'impulse-radar',
  'impulse-reports',
  // Gemini HTTP MCP servers
  'gemini-grounding',
  'gemini-image',
  'gemini-research',
  'gemini-embeddings',
];

/**
 * SEC-013 — resolve the value written into the SDK-facing MCP `x-api-key`
 * header.
 *
 * The Agent SDK serialises `options.mcpServers` into `--mcp-config <json>` on
 * the CLI child's command line, and the CLI may persist transport options in
 * session/debug JSONL. A plaintext internal key would therefore cross two
 * observable boundaries.
 *
 * Claude Code expands `${VAR}` inside MCP HTTP `headers` from the child's own
 * environment (verified against the pinned CLI through the `--mcp-config`
 * channel, not just `.mcp.json`), so emitting a reference instead of the value
 * keeps the secret out of argv and out of every trace the CLI writes, while the
 * transport still authenticates.
 *
 * When no host variable already holds the key, a child-only environment slot is
 * injected. The transport config therefore never receives the literal key.
 *
 * Exported for unit testing.
 */
export function resolveMcpAuthHeaderValue(
  apiKey: string,
  hostEnv: NodeJS.ProcessEnv = process.env
): { headerValue: string; envVar: string; injectIntoChild?: boolean } {
  for (const name of MCP_AUTH_ENV_CANDIDATES) {
    const value = hostEnv[name];
    if (typeof value === 'string' && value.length > 0 && value === apiKey) {
      return { headerValue: `\${${name}}`, envVar: name };
    }
  }
  return { headerValue: `\${${MCP_CHILD_AUTH_ENV}}`, envVar: MCP_CHILD_AUTH_ENV, injectIntoChild: true };
}

export const MCP_CREDENTIAL_CONTAINMENT_FAILURE_KIND = 'mcp-credential-containment-failed' as const;

export interface McpCredentialContainmentViolation {
  location: string;
  reason: 'literal-credential' | 'unresolvable-reference';
}

export class McpCredentialContainmentError extends Error {
  readonly failureKind = MCP_CREDENTIAL_CONTAINMENT_FAILURE_KIND;
  constructor(readonly violations: readonly McpCredentialContainmentViolation[]) {
    super(
      `${MCP_CREDENTIAL_CONTAINMENT_FAILURE_KIND}: refusing to start; ` +
        violations.map((violation) => `${violation.location}:${violation.reason}`).join(', ')
    );
    this.name = 'McpCredentialContainmentError';
  }
}

export function auditMcpCredentialContainment(
  configs: Record<string, McpHttpServerConfig | McpStdioServerConfig>,
  childEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env
): McpCredentialContainmentViolation[] {
  const violations: McpCredentialContainmentViolation[] = [];
  const liveSecrets = collectLiveSecrets(hostEnv);
  const holdsLiveSecret = (value: string): boolean => liveSecrets.some((secret) => value.includes(secret));
  for (const [serverName, config] of Object.entries(configs)) {
    if ('url' in config && holdsLiveSecret(config.url)) {
      violations.push({ location: `${serverName}.url`, reason: 'literal-credential' });
    }
    if ('headers' in config && config.headers) {
      for (const [key, rawValue] of Object.entries(config.headers)) {
        const value = String(rawValue ?? '');
        const location = `${serverName}.headers.${key}`;
        const references = mcpEnvReferencedVars(value);
        if (value && references.length === 0 && (isSecretKeyName(key) || holdsLiveSecret(value))) {
          violations.push({ location, reason: 'literal-credential' });
        } else if (references.some((name) => !childEnv[name])) {
          violations.push({ location, reason: 'unresolvable-reference' });
        }
      }
    }
    if (!('env' in config) || !config.env) continue;
    for (const [key, rawValue] of Object.entries(config.env)) {
      const value = String(rawValue ?? '');
      const location = `${serverName}.${key}`;
      const references = mcpEnvReferencedVars(value);
      if (references.length === 0) {
        if (value && (isSecretEnvName(key) || isSecretKeyName(key) || holdsLiveSecret(value))) {
          violations.push({ location, reason: 'literal-credential' });
        }
      } else if (holdsLiveSecret(value)) {
        violations.push({ location, reason: 'literal-credential' });
      } else if (references.some((name) => !childEnv[name])) {
        violations.push({ location, reason: 'unresolvable-reference' });
      }
    }
  }
  return violations;
}

/**
 * SEC-013 — expand `${VAR}` references in a header map for a fetch this process
 * makes itself.
 *
 * The placeholder is only meaningful to the CLI child. The orchestrator's own
 * pre-spend MCP health probe runs in-process, so it must send the resolved
 * value; leaving the placeholder in place would make every probe 401 and abort
 * every mission at the preflight gate.
 *
 * Exported for unit testing.
 */
export function expandMcpHeaderPlaceholders(
  headers: Record<string, string> | undefined,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const match = MCP_ENV_PLACEHOLDER_RE.exec(value);
    out[name] = match ? (hostEnv[match[1]!] ?? value) : value;
  }
  return out;
}

/**
 * One explicit report-authoring instruction for both the parent orchestrator
 * and every mission subagent. The tool boundary independently enforces the
 * same exact opt-in value; this prompt contract prevents a costly rejected
 * first draft instead of relying on tool feedback to recover.
 */
export function reportAuthoringModeInstruction(hostEnv: NodeJS.ProcessEnv = process.env): string {
  if (hostEnv.REPORT_COMPOSER_MODE === 'template') {
    return '- REPORT AUTHORING MODE: template. On the first attempt call draftReport({ slotName, blocks }) with a valid ReportBlocksDoc JSON string; the server composes the HTML. Use html only for an explicit legacy/revision fallback.';
  }
  return '- REPORT AUTHORING MODE: legacy (default). On the first attempt call draftReport({ slotName, html }) with one self-contained HTML document; blocks are rejected and must not be tried as a probe or fallback.';
}

function resolveDefaultRuntimeSkillPluginRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(moduleDir, 'runtime-plugin'), resolve(moduleDir, '..', 'runtime-plugin')];
  return candidates.find((candidate) => existsSync(join(candidate, '.claude-plugin', 'plugin.json'))) ?? candidates[0];
}

const DEFAULT_RUNTIME_SKILL_PLUGIN_ROOT = resolveDefaultRuntimeSkillPluginRoot();

/**
 * Enumerate the product-owned analytical skill plugin and validate its frozen
 * v0.1 surface. This function is intentionally strict: a missing plugin,
 * malformed manifest, developer skill, mismatched frontmatter name, or count
 * drift stops mission construction instead of silently reducing or widening
 * the runtime prompt surface.
 *
 * Exported for unit and publication-contract tests.
 */
export function discoverRuntimeSkills(pluginRoot: string = DEFAULT_RUNTIME_SKILL_PLUGIN_ROOT): string[] {
  return validateRuntimeSkillPlugin(pluginRoot).map((skill) => skill.name);
}
// taskBudget handling was removed 2026-04-17. The Claude Agent SDK's current
// model family (claude-sonnet-4-6, claude-opus-4-7, etc.) rejects the
// options.taskBudget field outright with:
//   "This model does not support user-configurable task budgets."
// Prior behaviour passed raw USD (which failed the >=1024 token floor check)
// and after the conversion fix it still failed against every live model.
//
// maxBudgetUsd + the hooks/budget.ts per-tool-call throttle remain the
// authoritative spend cap. If a future SDK release re-enables taskBudget
// for a concrete model set, re-introduce computeTaskBudgetTokens() here and
// gate it behind an explicit model allowlist.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  configPath?: string;
  agentsDir?: string;
  apiKey?: string;
  /** Max budget in USD per mission. Passed to SDK query(). */
  maxBudgetUsd?: number;
  /** Exact parent-turn model override. */
  model?: string;
  /**
   * COORD-012 — envelope authority over the SDK's transparent-retry fallback.
   * A string pins EXACTLY that model; an explicit `null` means the mission
   * authorized NO fallback (SDK retry disabled — the worker environment must
   * not smuggle one back in); `undefined` keeps the legacy
   * `IMPULSE_AGENT_FALLBACK_MODEL` → default chain for non-envelope callers.
   */
  authorizedFallbackModel?: string | null;
  /** Specialist role whose resolved profile model should own the parent turn. */
  roleAgent?: string;
  /** Permission mode for SDK sessions. Defaults to 'bypassPermissions'. */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
  /** Audit, budget, and permission hooks. */
  hooks?: Record<string, unknown>;
  /**
   * Optional checkpoint callback invoked every `checkpointEveryNTurns` assistant turns
   * (default 5) with the accumulated text content so far. The Inngest handler
   * uses this to persist `mission.partialResult` to Firestore so work is
   * recoverable on timeout.
   */
  onCheckpoint?: (data: { turn: number; partialResult: string }) => Promise<void> | void;
  /** How often the checkpoint callback fires. Default 5 turns. */
  checkpointEveryNTurns?: number;
  /**
   * Called after each assistant turn with the mission's running spend derived
   * from the authoritative SDK usage stream. The Inngest handler wires this to
   * `budgetState.updateCost(...)` so live events, the in-agent budget warning,
   * and the wall-clock-timeout path all report real cost/tokens instead of $0
   * (MISSION-001). Must never throw — the caller wraps it defensively.
   */
  onUsage?: (snapshot: MissionUsageSnapshot) => void;
  /**
   * Wall-clock mission budget in milliseconds, surfaced to the agent in the
   * preamble so it can self-pace. Used alongside the Inngest-side
   * Promise.race timeout. Does NOT enforce the cap (that's the handler's job);
   * it only informs the agent so it can wrap up before the ceiling hits.
   */
  timeoutMs?: number;
  /**
   * Optional preamble block capturing the user's preferences learned
   * passively from their past mission history. Injected between the
   * TIME BUDGET preamble and the permission map so the agent sees the
   * user's profile without the prompt restating it.
   */
  userPreferencesPreamble?: string;
  /**
   * The Firestore mission document ID this orchestrator is running for.
   * Surfaced to the agent in the preamble so the draftReport / publishReport
   * tools (impulse-reports MCP) bind their resulting Firestore documents
   * back to the mission. As of the intent-aware report intake migration
   * (2026-05-01), missionId is bound server-side — the agent does NOT need
   * to pass it explicitly. Without this option set, agent-generated reports
   * persist with missionId: undefined, breaking audit / replay /
   * per-mission dashboards.
   */
  missionId?: string;
  /**
   * Frozen slot manifest for the mission. Each entry is one report deliverable
   * the agent is allowed to publish under. The names listed here are the ONLY
   * accepted slotName values for publishReport — server-side enforcement
   * (mission-research-gate.ts) rejects off-manifest writes. Surfacing the
   * manifest to the agent in the preamble (Bug B) prevents the agent from
   * inventing slot names like "agentic-frameworks-2026" that publishReport
   * then rejects, leaving the FS draft orphaned.
   */
  slots?: Array<{ name: string; intent?: string }>;
  /**
   * Optional callback invoked each time the agent invokes a Skill(...) tool.
   * The Inngest handler wires this to append to mission.skillInvocations[]
   * so the UI can show a real-time trail of which skills fired per mission.
   */
  onSkillInvocation?: (inv: { skill: string; args?: string; firedAt: string; turn: number }) => Promise<void> | void;
  /**
   * Optional watchdog configuration. When enabled, the orchestrator monitors
   * for runaway loops, stream idle, and empty-turn spinning; any heuristic
   * trip aborts the mission so partial output is preserved via checkpointing.
   */
  watchdog?: {
    enabled: boolean;
    config?: Partial<import('./hooks/watchdog').WatchdogConfig>;
  };
  /**
   * Optional cancel-check callback. Polled on the watchdog interval (every
   * 30s); when it returns true, the orchestrator aborts via the watchdog
   * channel so the catch block runs cost-capture and partial-output recovery.
   * The Inngest handler wires this to fetch mission.status from Firestore so
   * external "kill switch" updates (UI cancel button, manual `kill-mission`
   * scripts) actually stop the in-flight SDK loop instead of letting it run
   * to the budget cap. Without this, marking mission.status='failed'
   * elsewhere is purely cosmetic — the Anthropic-side spend continues.
   */
  cancelCheck?: () => Promise<boolean>;
  /** Logger instance. Falls back to console.log if not provided. */
  logger?: Logger;
}

/** Parameters for the streamChat() method (Task 2.1). */
export interface ChatParams {
  /** The user's message (with optional conversation history prepended). */
  prompt: string;
  /** System prompt for guiding Claude's behavior. */
  systemPrompt?: string;
  /** Per-chat-turn cost cap in USD. */
  maxBudgetUsd?: number;
  /** Authenticated user ID (from chat route auth). */
  userId?: string;
  /** Optional session ID for tracking. */
  sessionId?: string;
}

export interface ModelUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  /** Cache-creation (write) tokens — billed at the family write rate; kept in
   * the persisted breakdown so later recomputations don't under-derive. */
  cacheCreationInputTokens?: number;
  costUSD: number;
}

/**
 * A point-in-time view of the in-flight mission's real spend, derived from the
 * SDK usage stream's cumulative token counters. Emitted per turn via
 * `onUsage` and readable at any moment via {@link Orchestrator.getUsageSnapshot}
 * — the Inngest handler reads it in its wall-clock-timeout catch so an aborted
 * run records its true cost/tokens instead of $0 (MISSION-001).
 */
export interface MissionUsageSnapshot {
  /** null when any turn/model component could not be priced (accounting
   * unavailable) — a truthful total is impossible, so we do NOT emit a partial
   * number. See `costUnavailableReason`. */
  costUsd: number | null;
  tokenUsage: { input: number; output: number };
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Set when `costUsd` is null: why the total could not be priced. */
  costUnavailableReason?: string;
}

export interface MissionResult {
  success: boolean;
  result?: string;
  /** null when any component was unpriceable (unknown model / expired-undated
   * introductory rate). A truthful total that OMITS a component is never
   * emitted — the handler records `costUnavailableReason` instead of a number. */
  costUsd: number | null;
  tokenUsage: { input: number; output: number };
  errors?: string[];
  numTurns?: number;
  durationApiMs?: number;
  modelUsage?: Record<string, ModelUsageSummary>;
  /** Set when `costUsd` is null: why the total could not be priced. */
  costUnavailableReason?: string;
  providerReportedCostUsd?: number | null;
  exposureUsd?: number;
  duplicateUsageEvents?: number;
  restatedUsageEvents?: number;
  modelSubstitution?: ModelSubstitution;
  /**
   * True when `result` was recovered from a mid-run checkpoint after a timeout
   * rather than produced by the agent's own completion path. The Inngest
   * handler sets this in its timeout catch; the orchestrator itself never
   * sets it on happy-path completions.
   */
  partial?: boolean;
  /**
   * OPS-004: set to {@link MCP_PREFLIGHT_FAILURE_KIND} when the mission aborted
   * at the pre-spend MCP preflight (the platform MCP surface was unreachable),
   * or SEC-016's {@link MCP_CREDENTIAL_CONTAINMENT_FAILURE_KIND} when the
   * transport config would have put a credential on the CLI command line.
   * The worker keys off this typed kind to short-circuit every later paid stage
   * (recovery/L1/fact-check/judge/revision/reflection) and persist the same
   * reason, instead of treating it as an ordinary orchestrator failure.
   */
  failureKind?:
    | typeof MCP_PREFLIGHT_FAILURE_KIND
    | typeof UNSUPPORTED_MODEL_FAILURE_KIND
    | typeof MCP_CREDENTIAL_CONTAINMENT_FAILURE_KIND;
  requestedModel?: string;
}

// ---------------------------------------------------------------------------
// Assistant message content block types (from Anthropic BetaMessage)
// ---------------------------------------------------------------------------

interface ContentBlockText {
  type: 'text';
  text: string;
}

interface ContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type ContentBlock = ContentBlockText | ContentBlockToolUse | { type: string };

interface BetaMessageLike {
  id?: string;
  content?: ContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model?: string;
}

/**
 * Injectable dependencies for testing.
 * When not provided, the real implementations are used.
 */
export interface OrchestratorDeps {
  loadConfig: (configPath?: string) => AgentConfig;
  loadProfiles: (agentsDir: string) => Map<string, AgentProfile>;
  getServerUrl: (config: AgentConfig, serverName: string) => string;
  queryFn: (params: { prompt: string; options?: Record<string, unknown> }) => AsyncGenerator<SDKMessage, void>;
}

// ---------------------------------------------------------------------------
// Default dependencies (production)
// ---------------------------------------------------------------------------

const defaultDeps: OrchestratorDeps = {
  loadConfig: loadAgentConfig,
  loadProfiles: loadAllProfiles,
  getServerUrl: getMcpServerUrl,
  queryFn: sdkQuery as unknown as OrchestratorDeps['queryFn'],
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  private readonly config: AgentConfig;
  private readonly profiles: Map<string, AgentProfile>;
  private readonly apiKey: string | undefined;
  private readonly maxBudgetUsd: number | undefined;
  private readonly permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk';
  private readonly agentDefinitions: Record<string, AgentDefinition>;
  private readonly mcpServerConfigs: Record<string, McpHttpServerConfig | McpStdioServerConfig>;
  private readonly hooks: Record<string, unknown> | undefined;
  private readonly onCheckpoint?: (data: { turn: number; partialResult: string }) => Promise<void> | void;
  private readonly checkpointEveryNTurns: number;
  private readonly timeoutMs?: number;
  private readonly userPreferencesPreamble?: string;
  private readonly missionId?: string;
  private readonly slots?: Array<{ name: string; intent?: string }>;
  private readonly onSkillInvocation?: (inv: {
    skill: string;
    args?: string;
    firedAt: string;
    turn: number;
  }) => Promise<void> | void;
  private readonly watchdogOpts?: { enabled: boolean; config?: Partial<import('./hooks/watchdog').WatchdogConfig> };
  private readonly cancelCheck?: () => Promise<boolean>;
  /**
   * Running snapshot of the accumulated text + tool-call/result markers for the
   * currently-executing mission. Exposed via {@link getAccumulatedPartial}
   * so the Inngest handler can force a final flush to Firestore on timeout,
   * capturing the up-to-4 turns of work between the last 5-turn checkpoint
   * and the wall-clock abort.
   */
  private currentAccumulatedText: string[] = [];
  private currentTurn = 0;
  /**
   * Running cumulative usage for the in-flight mission (parent + subagent turns
   * from the SDK usage stream). Reset at the start of each run's loop and read
   * by {@link getUsageSnapshot} — the honest-telemetry counterpart to
   * {@link getAccumulatedPartial} (MISSION-001).
   */
  private currentUsage: MissionUsageSnapshot = {
    costUsd: 0,
    tokenUsage: { input: 0, output: 0 },
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  /**
   * The in-flight run's SDK AbortController, hoisted to an instance field so
   * {@link abort} can cancel the loop from outside (the Inngest wall-clock
   * timeout) instead of leaving it spending until the 30s `cancelCheck` poll
   * catches up (MISSION-001). Null while no mission is running.
   */
  private currentAbortController: AbortController | null = null;
  private readonly onUsage?: (snapshot: MissionUsageSnapshot) => void;
  private readonly deps: OrchestratorDeps;
  private readonly log: (message: string) => void;
  /** Product-owned SDK plugin root; contains no project coding configuration. */
  private readonly runtimeSkillPluginRoot: string;
  /** Frozen analytical skill names loaded from the product-owned plugin. */
  private readonly runtimeSkills: string[];
  /**
   * SEC-013 — the value written into the SDK-facing `x-api-key` header: a
   * `${VAR}` reference when a forwarded env var holds the key, else the literal.
   */
  private readonly mcpAuthHeaderValue: string;
  /** Child-only auth value used when the caller supplied a key outside process.env. */
  private readonly mcpAuthEnvOverride?: { name: string; value: string };
  /**
   * SEC-016 — host variable names the configured stdio MCP `env:` blocks refer to.
   * Forwarded into the SDK subprocess so the preserved `${VAR}` references expand
   * there instead of being expanded into argv here.
   */
  private readonly mcpEnvReferencedVars: string[];
  /**
   * OPS-005 — every configured model this runtime cannot serve, collected while
   * the definitions are built and reported before any provider work.
   */
  private readonly modelViolations: ModelSelectionViolation[] = [];
  /** OPS-005 — the exact model the parent mission turn asks the SDK for. */
  private readonly orchestratorModel: string;
  /** OPS-005 — the SDK's transparent retry model, resolved through the same gate. */
  /** undefined = SDK transparent-retry fallback disabled for this run (COORD-012). */
  private readonly fallbackModel: string | undefined;
  /** SEC-014 — the executable capability allowlist for this run. */
  private readonly capabilityPolicy: CapabilityPolicy;

  constructor(options?: OrchestratorOptions, deps?: Partial<OrchestratorDeps>) {
    this.deps = { ...defaultDeps, ...deps };
    // SEC-013: every orchestrator log line — MCP transport summaries, tool-call
    // argument previews, tool-result previews, SDK error messages — passes
    // through redaction before it reaches the console or logs/agent.log. Doing
    // it here rather than at each call site means a new log line cannot
    // reintroduce the leak by forgetting to redact.
    const emit = options?.logger ? (msg: string) => options.logger!.info(msg) : (msg: string) => console.log(msg);
    this.log = (message: string) => emit(redactText(message));

    this.config = this.deps.loadConfig(options?.configPath);
    this.profiles = this.deps.loadProfiles(options?.agentsDir ?? '');
    this.apiKey = options?.apiKey;
    this.maxBudgetUsd = options?.maxBudgetUsd;
    this.permissionMode = options?.permissionMode ?? 'bypassPermissions';
    this.hooks = options?.hooks;
    this.onCheckpoint = options?.onCheckpoint;
    this.checkpointEveryNTurns = options?.checkpointEveryNTurns ?? 5;
    this.onUsage = options?.onUsage;
    this.timeoutMs = options?.timeoutMs;
    this.userPreferencesPreamble = options?.userPreferencesPreamble;
    this.missionId = options?.missionId;
    this.slots = options?.slots;
    this.onSkillInvocation = options?.onSkillInvocation;
    this.watchdogOpts = options?.watchdog;
    this.cancelCheck = options?.cancelCheck;
    this.runtimeSkillPluginRoot = DEFAULT_RUNTIME_SKILL_PLUGIN_ROOT;
    this.runtimeSkills = discoverRuntimeSkills(this.runtimeSkillPluginRoot);
    this.mcpEnvReferencedVars = collectMcpEnvReferencedVars(this.config.externalMcpServers);

    // SEC-013: decide the auth-header representation BEFORE the configs that
    // embed it are built.
    const authHeader = this.apiKey ? resolveMcpAuthHeaderValue(this.apiKey) : undefined;
    this.mcpAuthHeaderValue = authHeader?.headerValue ?? '';
    if (this.apiKey && authHeader?.injectIntoChild) {
      this.mcpAuthEnvOverride = { name: authHeader.envVar, value: this.apiKey };
    }

    const roleModel = options?.roleAgent ? this.profiles.get(options.roleAgent)?.model : undefined;
    this.orchestratorModel = this.resolveConfiguredModel(
      options?.model ??
        roleModel ??
        process.env.IMPULSE_AGENT_ORCHESTRATOR_MODEL?.trim() ??
        this.config.models['orchestrator'],
      roleModel && !options?.model ? `orchestrator(role:${options?.roleAgent ?? ''})` : 'orchestrator',
      DEFAULT_ORCHESTRATOR_MODEL
    );
    const authorization = process.env[MODEL_FALLBACK_AUTHORIZATION_ENV]?.trim();
    if (authorization) {
      const { invalid } = parseModelAuthorizationEntries(authorization);
      if (invalid.length > 0) {
        this.modelViolations.push({
          scope: MODEL_FALLBACK_AUTHORIZATION_ENV,
          requested: `${invalid.length} malformed authorization entries`,
          reason: 'unsupported-model',
        });
      }
    }
    // COORD-012: the persisted mission envelope outranks the worker
    // environment for the transparent-retry fallback. When the selection
    // resolves to undefined (mission authorized no fallback) the SDK retry is
    // disabled for this run; when it names a model, that exact model is
    // validated through the same unsupported-model gate as every other
    // configured model, so an unserveable authorization refuses the run
    // before any provider request.
    const fallbackSelection = resolveFallbackModelSelection({
      authorizedFallbackModel: options?.authorizedFallbackModel,
      envFallback: process.env.IMPULSE_AGENT_FALLBACK_MODEL,
      defaultFallback: DEFAULT_FALLBACK_MODEL,
    });
    this.fallbackModel =
      fallbackSelection === undefined
        ? undefined
        : this.resolveConfiguredModel(fallbackSelection, 'fallback', DEFAULT_FALLBACK_MODEL);

    this.agentDefinitions = this.buildAgentDefinitions();
    this.mcpServerConfigs = this.buildMcpServerConfigs();
    this.capabilityPolicy = this.buildCapabilityPolicy();
  }

  private resolveConfiguredModel(requested: string | undefined, scope: string, fallback: string): string {
    const value = (requested ?? '').trim() || fallback;
    const selection = resolveSdkModel(value);
    if (selection.ok) return selection.model;
    this.modelViolations.push({ scope, requested: value, reason: selection.reason });
    return value;
  }

  private assertConfiguredModelsSupported(): void {
    if (this.modelViolations.length > 0) throw new UnsupportedModelError([...this.modelViolations]);
  }

  /**
   * COORD-019 — the transparent-retry fallback for ONE dispatch.
   *
   * `this.fallbackModel` is a single run-wide field, but the main model differs
   * per dispatch (mission/revision use `orchestratorModel`, chat reads
   * `CLAUDE_CHAT_MODEL`), so the pair can only be resolved here rather than in
   * the constructor. Returns undefined when the configured fallback names the
   * model it would be retrying, which disables SDK transparent retry for this
   * dispatch instead of letting the SDK refuse the run outright.
   */
  private resolveRetryFallbackFor(mainModel: string): string | undefined {
    const resolved = resolveTransparentRetryFallback(mainModel, this.fallbackModel);
    if (resolved === undefined && this.fallbackModel !== undefined) {
      this.log(
        `[model] COORD-019: transparent-retry fallback disabled — configured fallback "${this.fallbackModel}" is the same model as "${mainModel}"`
      );
    }
    return resolved;
  }

  private childEnv(): Record<string, string> {
    const env = resolveOrchestratorEnv(process.env, this.mcpEnvReferencedVars);
    if (this.mcpAuthEnvOverride) env[this.mcpAuthEnvOverride.name] = this.mcpAuthEnvOverride.value;
    return env;
  }

  private assertMcpCredentialContainment(configs: Record<string, McpHttpServerConfig | McpStdioServerConfig>): void {
    const violations = auditMcpCredentialContainment(configs, this.childEnv());
    if (violations.length > 0) throw new McpCredentialContainmentError(violations);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get SDK-ready agent definitions built from loaded profiles.
   */
  getAgentDefinitions(): Record<string, AgentDefinition> {
    return this.agentDefinitions;
  }

  /**
   * Get SDK-ready MCP server configs built from config + all profile mcp_servers.
   */
  getMcpServerConfigs(): Record<string, McpHttpServerConfig | McpStdioServerConfig> {
    return this.mcpServerConfigs;
  }

  /**
   * SEC-014 — the executable capability allowlist this run enforces. Exposed so
   * the worker can log the effective matrix and tests can assert it directly
   * rather than inferring it from denial messages.
   */
  getCapabilityPolicy(): CapabilityPolicy {
    return this.capabilityPolicy;
  }

  /**
   * SEC-014 — build the run's capability policy from the already-resolved agent
   * definitions and MCP configs, so the policy and the transport can never
   * disagree about which servers exist.
   *
   * MCP breadth is deliberately unchanged: the parent keeps the union of every
   * configured server (it must publish, read entities, and query the graph), and
   * each subagent keeps exactly the servers its profile resolved to. What
   * changes is that BOTH are now enforced, and that the non-MCP built-ins are
   * default-deny rather than unconditionally allowed.
   *
   * The workspace root is the mission's own scratch directory
   * (`<os.tmpdir()>/impulse-missions/<missionId>`) — where `draftReport` writes
   * draft HTML and `renderDiagram` persists SVGs. Scoping reads there is what
   * lets an agent re-read its own `savedAt` SVG while making a write to the
   * repository root — the escape this row was filed for — impossible. Outside a
   * mission there is no scratch directory, so no path-bearing capability is
   * permitted at all.
   */
  private buildCapabilityPolicy(): CapabilityPolicy {
    const subagentMcpServers: Record<string, readonly string[]> = {};
    for (const [name, definition] of Object.entries(this.agentDefinitions)) {
      subagentMcpServers[name] = Array.isArray(definition.mcpServers)
        ? definition.mcpServers.filter((spec): spec is string => typeof spec === 'string')
        : [];
    }
    return buildMissionCapabilityPolicy({
      // The parent turn drives both surfaces this class exposes: `runMission`
      // (mission MCP configs) and `streamChat` (the curated chat set). Both are
      // included so one policy covers whichever entry point runs.
      parentMcpServers: [...Object.keys(this.mcpServerConfigs), ...CHAT_MCP_SERVERS],
      subagentMcpServers,
      workspaceRoots: this.missionId ? [join(tmpdir(), 'impulse-missions', this.missionId)] : [],
    });
  }

  /**
   * SEC-014 — merge the orchestrator's own capability hook with any hooks the
   * caller supplied.
   *
   * The capability hook is installed by the orchestrator itself, not by the
   * caller, so a worker that forgets to pass one (or whose profile load failed)
   * still runs behind the boundary. Caller hooks are additive: the SDK evaluates
   * every registered `PreToolUse` hook, and a `deny` from any of them wins.
   */
  private buildHooks(): Record<string, unknown> {
    const { hooks: capabilityHooks } = createPermissionsHooks({
      policy: this.capabilityPolicy,
      onDeny: (event) =>
        this.log(`[capability-deny] principal=${event.principal} tool=${event.toolName} code=${event.code}`),
    });
    const merged: Record<string, unknown> = { ...(this.hooks ?? {}) };
    for (const [event, matchers] of Object.entries(capabilityHooks)) {
      const existing = merged[event];
      merged[event] = Array.isArray(existing) ? [...matchers, ...existing] : matchers;
    }
    return merged;
  }

  /**
   * Get sorted list of available agent names.
   */
  getAgentNames(): string[] {
    return Array.from(this.profiles.keys()).sort();
  }

  /**
   * Task 2.1: Stream a chat interaction via the Claude Agent SDK.
   * Unlike runMission(), this does NOT call checkMcpHealth() (too slow for chat).
   * MCP failures surface as tool errors at invocation time.
   */
  async *streamChat(params: ChatParams): AsyncGenerator<SDKMessage> {
    this.assertConfiguredModelsSupported();
    const chatModel = process.env.CLAUDE_CHAT_MODEL ?? 'claude-sonnet-4-6';
    const maxBudget = params.maxBudgetUsd ?? 0.5;

    const chatMcpServers = this.buildMcpServerConfigsForNames([...CHAT_MCP_SERVERS]);
    this.assertMcpCredentialContainment(chatMcpServers);

    const chatAgents = this.getChatAgentDefinitions();
    const chatFallbackModel = this.resolveRetryFallbackFor(chatModel);

    this.log(`[chat] Starting with model=${chatModel}, budget=$${maxBudget.toFixed(2)}`);

    const conversation = this.deps.queryFn({
      prompt: params.prompt,
      options: {
        model: chatModel,
        // P3: same resilience fallback as runMission — transparently retry on
        // a cheaper/broadly-available model if the chat model fails.
        // COORD-019: omitted when it names the very model it would retry.
        ...(chatFallbackModel !== undefined ? { fallbackModel: chatFallbackModel } : {}),
        systemPrompt: params.systemPrompt,
        mcpServers: chatMcpServers,
        agents: chatAgents,
        persistSession: false,
        maxBudgetUsd: maxBudget,
        // taskBudget omitted — current Claude SDK models reject it. See top
        // of file for the full reasoning.
        permissionMode: 'acceptEdits',
        // OSS-014: disable every filesystem setting tier. The only
        // customization source is the product-owned local plugin below.
        settingSources: [],
        plugins: [{ type: 'local', path: this.runtimeSkillPluginRoot }],
        skills: this.runtimeSkills,
        // Expose the Claude Code preset including the Skill tool. The explicit
        // plugin + skill allowlist above owns discovery and visibility.
        tools: { type: 'preset', preset: 'claude_code' },
        // Auto-approve Skill invocations so acceptEdits doesn't prompt.
        allowedTools: ['Skill'],
        // SEC-014: the interactive assistant is a HUMAN principal, but the
        // process it runs in is still the operator's server — a chat turn has no
        // more business running Bash or writing host files than a mission does,
        // so it carries the same deny list and the same default-deny hook.
        disallowedTools: [...MISSION_DENIED_BUILTIN_TOOLS],
        agentProgressSummaries: true,
        includeHookEvents: true,
        // Explicit env allowlist (#31) — see resolveOrchestratorEnv. Only
        // ANTHROPIC_*/CLAUDE_* + OS/MCP essentials cross the boundary; the
        // full host env (Firebase/Gemini/cloud secrets) never reaches an MCP
        // child. Also sets CLAUDE_CODE_MAX_OUTPUT_TOKENS (default 128000).
        env: this.childEnv(),
        hooks: this.buildHooks(),
      },
    });

    for await (const message of conversation) {
      yield message;
    }
  }

  /**
   * Return the current accumulated checkpoint snapshot (text blocks +
   * tool-call/result markers) for the in-flight mission. The Inngest handler
   * calls this from its timeout catch block to capture the up-to-4 turns of
   * work that happen between the last 5-turn checkpoint and the abort.
   *
   * @returns accumulator string (capped at 200KB) and current turn number
   */
  getAccumulatedPartial(): { partialResult: string; turn: number } {
    return {
      partialResult: this.currentAccumulatedText.join('\n\n').slice(-200_000),
      turn: this.currentTurn,
    };
  }

  /**
   * Return the in-flight mission's real cumulative spend (MISSION-001). The
   * Inngest handler calls this in its wall-clock-timeout catch — alongside
   * {@link getAccumulatedPartial} — so an aborted-but-billed run records its
   * true cost + input/output token split instead of the $0 / 0-tokens the
   * stale `budgetState` reported. Returns a copy so callers can't mutate the
   * live counters.
   */
  getUsageSnapshot(): MissionUsageSnapshot {
    return {
      costUsd: this.currentUsage.costUsd,
      tokenUsage: { ...this.currentUsage.tokenUsage },
      cacheReadTokens: this.currentUsage.cacheReadTokens,
      cacheWriteTokens: this.currentUsage.cacheWriteTokens,
      ...(this.currentUsage.costUnavailableReason
        ? { costUnavailableReason: this.currentUsage.costUnavailableReason }
        : {}),
    };
  }

  /**
   * Cancel the in-flight mission's SDK loop from outside (MISSION-001). The
   * Inngest wall-clock timeout calls this so the orchestrator stops spending
   * immediately, rather than continuing in the background until the 30s
   * `cancelCheck` poll trips. No-op when no mission is running.
   */
  abort(reason?: string): void {
    if (this.currentAbortController && !this.currentAbortController.signal.aborted) {
      this.log(`[abort] external abort requested${reason ? `: ${reason}` : ''}`);
      this.currentAbortController.abort();
    }
  }

  /**
   * Run a single mission via the Claude Agent SDK.
   */
  async runMission(prompt: string): Promise<MissionResult> {
    // Declared outside the try so both happy-path and catch can clear it.
    let idleCheckHandle: ReturnType<typeof setInterval> | null = null;
    let dispatchAttempted = false;
    let parentSessionModel: string | undefined;
    const seenAssistantUsage = new Map<
      string,
      { input: number; output: number; cacheRead: number; cacheWrite: number }
    >();
    let duplicateUsageEvents = 0;
    let restatedUsageEvents = 0;
    // Bug D: hoist cumulative token counters so the catch block can compute
    // partial cost when the loop throws (watchdog abort, SDK stream error).
    // Pre-fix, all four were declared inside the try and the catch returned
    // hardcoded zeros, so an aborted mission could report $0 / 0+0 tokens
    // despite real spend.
    let cumulativeInputTokens = 0;
    // MISSION-004: model/tier/cache-aware running estimate, accumulated per
    // turn from the model each assistant message reports — the abort/fallback
    // figure no longer prices Opus turns at Sonnet rates or ignores cache
    // writes.
    let cumulativeEstimatedCostUsd = 0;
    // TEST-021: once ANY turn is unpriceable the running estimate can no longer
    // be a truthful total, so we record the reason and report the cumulative as
    // unavailable (null) rather than a lower bound that silently omits a turn.
    let estimateUnavailableReason: string | undefined;
    let cumulativeOutputTokens = 0;
    let cumulativeCacheReadTokens = 0;
    let cumulativeCacheWriteTokens = 0;
    // Bug R: AbortController plumbed into the SDK's query() so watchdog trips
    // and external cancel signals actually interrupt the for-await iterator.
    // Without this the iterator can sit silently forever (HMR-orphaned dist,
    // hung upstream API, dropped MCP socket) — watchdog.aborted only flips
    // when a NEW message arrives, but no new message ever arrives, so the
    // mission stalls until the Inngest wall-clock timeout.
    // Hoisted to an instance field (MISSION-001) so an external caller — the
    // Inngest wall-clock timeout — can abort() this run's SDK loop directly.
    const sdkAbortController = new AbortController();
    this.currentAbortController = sdkAbortController;
    try {
      this.assertConfiguredModelsSupported();
      this.assertMcpCredentialContainment(this.mcpServerConfigs);
      // MCP health check — ping internal HTTP servers before building the prompt
      const mcpHealth = await this.checkMcpHealth();

      // OPS-004: strict preflight BEFORE any provider spend. If a required
      // platform MCP is unreachable, the mission runtime is pointed at the wrong
      // app (e.g. a stale IMPULSE_MCP_BASE_URL / ignored YAML port) — every
      // platform tool call would fail and the agent could burn its budget
      // searching for tools that never answer. Fail fast here; the SDK query loop below is where spend
      // begins, so throwing now guarantees zero provider cost.
      this.assertRequiredInternalMcpReachable(mcpHealth);

      const mcpStatusLines = Object.entries(mcpHealth).map(([name, status]) => {
        if (status === 'online') return `  ✓ ${name} — online`;
        if (status === 'unreachable') return `  ✗ ${name} — unreachable (skip this server)`;
        return `  ~ ${name} — external (errors detected at runtime)`;
      });
      const mcpStatusBlock =
        mcpStatusLines.length > 0
          ? `\nMCP SERVER STATUS:\n${mcpStatusLines.join('\n')}\nIf a tool fails repeatedly, stop using it and try alternatives.\n\n`
          : '';

      // Build budget preamble
      const budgetPreamble = this.maxBudgetUsd
        ? `BUDGET: You have $${this.maxBudgetUsd.toFixed(2)} for this mission. Current spend: $0.00.
You will receive budget updates after each tool call.
Plan your work to complete within budget. If you're at 80%, wrap up.
Do NOT retry failing tools — try a different approach or return partial results.
Do NOT rewrite/renumber content you already wrote — get it right the first time.

`
        : '';

      // Time budget preamble — lets the agent self-pace against the wall-clock
      // ceiling enforced by the Inngest handler. The orchestrator only
      // informs; it does not enforce.
      const timePreamble = this.timeoutMs
        ? `TIME BUDGET: You have ${Math.round(this.timeoutMs / 60_000)} minutes of wall-clock for this mission.
The runtime will HARD-ABORT when this elapses and return whatever partial output is checkpointed.

CHECKPOINT PROTOCOL:
- Your emitted text AND tool-call summaries are saved every ${this.checkpointEveryNTurns} turns.
- Checkpoints are your timeout insurance — they only help if you emit text regularly.
- After each major research round or analytical step, write a SHORT summary paragraph (100-300 words) describing what you found BEFORE moving to the next tool.
- Do NOT save all your writing for the end — if the timeout hits, that final draft never reaches Firestore.

PACING:
- 0-50% elapsed: research and tool calls
- 50-70% elapsed: start writing the draft incrementally (summary paragraphs, section outlines)
- 70-85% elapsed: finalize the output — at this point, STOP exploring
- 85-100% elapsed: polish only — no new research

`
        : '';

      // Build permission map from loaded profiles
      const permissionLines: string[] = ['YOUR AVAILABLE MCP SERVERS:'];
      for (const [name, profile] of this.profiles) {
        const internal = profile.mcp_servers?.internal ?? [];
        const external = profile.mcp_servers?.external ?? [];
        const servers = [...internal, ...external];
        if (servers.length > 0) {
          permissionLines.push(`  ${name}: ${servers.join(', ')}`);
        }
      }
      permissionLines.push('Do NOT attempt tools from servers not listed for the active agent.');
      permissionLines.push('');
      permissionLines.push('ORCHESTRATOR RULES:');
      permissionLines.push('- Only ONE agent writes at a time. Never have two agents writing to the same file.');
      permissionLines.push(
        '- NEVER fetch entity details one-by-one in a loop. Use batch/list tools (getRadarDetails, listEntities) to get all data in ONE call.'
      );
      if (this.hasArtifactSlot()) {
        permissionLines.push(
          '- Preserve the mission request and its CRITICAL DIMENSIONS verbatim when delegating to Creator. If it requires a report, evidence, scenario, source-quality, readiness, red-team, citation, or design procedure, tell Creator to invoke the matching built-in Skill tool and apply its output to the artifact; marker-shaped prose without a formal Skill call is not completion.'
        );
        permissionLines.push(
          '- For report tasks, delegate to the creator agent IMMEDIATELY after fetching data. Do NOT spend time reformatting or analyzing the data yourself — pass the raw tool output directly to the creator and let it handle formatting.'
        );
        permissionLines.push(
          '- For report UPDATES, delegate to the creator agent with just the report ID and update instructions. Let the creator fetch and modify the report — do NOT load the full HTML into your context.'
        );
        permissionLines.push(reportAuthoringModeInstruction());
        permissionLines.push(
          '- Reports use the draft-then-publish pattern selected above, then publishReport({ slotName, title, description }) promotes the active draft to Firestore. publishReport reads from FS — do NOT pass html or blocks to it.'
        );
        // Bug C + L: explicit completion rules. Without these the orchestrator
        // routinely dispatches ANOTHER subagent to "verify the URL" or "check
        // the report" after publishReport already succeeded, triggering H7
        // ToolSearch loops. The publishReport response IS the source of truth,
        // and any quality polish the system needs is handled by a separate
        // out-of-band revise turn — not by the agent re-drafting in this turn.
        // REPORT-006: both rules come from publish-contract.ts — the single
        // source derived from the REAL publish result ({reportId, reportUrl,
        // isUpsert}); the old hand-written line promised a shareUrl the runtime
        // never returns.
        permissionLines.push(PUBLISH_COMPLETION_SIGNAL_RULE);
        permissionLines.push(PUBLISH_PRIVACY_RULE);
        permissionLines.push(
          '- Do NOT call draftReport, publishReport, generateInfographic, generateVisualization, generate_image, renderDiagram, listReports, getReportById, or filesystem.* AFTER publishReport returns success. The current turn is over.'
        );
        permissionLines.push(
          '- Do NOT dispatch any agent (Agent({...})) to "verify", "polish", "retrieve the URL", or "improve" the report after a successful publishReport. The platform automatically runs an L1 quality gate and dispatches a separate REVISE turn if needed — that revise turn is a NEW orchestrator instance with its own prompt; you do not initiate it from this turn.'
        );
        permissionLines.push(
          '- Do NOT embed remote image URLs (firebasestorage or any http(s) src) in report HTML — the publication policy rejects off-origin resources and the report viewer strips them. To include a generated image, reference the `imageId` that generate_image returned: write `<img data-image-id="THE_ID" alt="what the visual shows">` and publication embeds it as bounded image data. Max 2 per report, and only when the visual carries evidence the prose cannot. Without an imageId, mention the image by title in prose instead. Then draftReport, then publishReport, then STOP. Do NOT chain more image generations between the result and the draft.'
        );
      } else {
        permissionLines.push(...NO_ARTIFACT_DELIVERABLE_RULES);
      }
      const permissionMap = permissionLines.join('\n') + '\n';

      // Bug B: surface the frozen slot manifest to the agent so it doesn't
      // invent slot names that publishReport then rejects. mission-research-
      // gate.ts enforces the manifest server-side; without seeing the allowed
      // names, the agent can pick a descriptive but off-manifest name and burn
      // turns on rejected publishes. Listing the names makes the constraint
      // visible at decision time.
      // MISSION-011: an EMPTY manifest used to render as an empty allow-list —
      // "the only accepted slotName values are []" — which reads as "publishing
      // is possible, you just have the wrong name" and invited the retry loop the
      // line was meant to prevent. State the absence instead.
      const slotManifestLine = this.hasArtifactSlot()
        ? `MISSION SLOT MANIFEST (these are the ONLY accepted slotName values for publishReport): ${JSON.stringify(
            (this.slots ?? []).map((s) => s.name)
          )}. Calling publishReport with a slotName not in this list will be rejected; if rejected, retry with one of the listed names.\n`
        : 'MISSION SLOT MANIFEST: EMPTY — this mission requested no published artifact. publishReport cannot succeed for any slotName; do not call it and do not retry it.\n';

      const missionIdPreamble = this.missionId
        ? `MISSION CONTEXT: missionId="${this.missionId}". This mission's slot manifest is enforced server-side when you call publishReport. The missionId is bound automatically; you do not need to pass it explicitly.\n${slotManifestLine}\n`
        : '';

      // Precedence footer: the learned USER PROFILE block sits above the `---` and is a set of
      // DEFAULTS from past missions. The user's current request (below the `---`) must win on any
      // conflict — otherwise a 30-day-learned structure can override what the user asked for now.
      const precedenceFooter = this.userPreferencesPreamble
        ? '\n\n---\nPRECEDENCE: the text between the two `---` markers is the user’s CURRENT request and is ' +
          'authoritative. The "USER PROFILE" block above the first `---` is LEARNED DEFAULTS from past missions — ' +
          'apply those defaults ONLY where the current request is silent. On ANY conflict (format, structure, ' +
          'layout, sections, theme, background, color, styling), the current request OVERRIDES the learned defaults.'
        : '';

      const fullPrompt =
        budgetPreamble +
        timePreamble +
        missionIdPreamble +
        (this.userPreferencesPreamble ?? '') +
        permissionMap +
        mcpStatusBlock +
        '---\n' +
        prompt +
        precedenceFooter;

      const model = this.orchestratorModel;
      const mcpInfo = Object.entries(this.mcpServerConfigs).map(([k, v]) => {
        if ('url' in v) return `${k}=${v.url}`;
        if ('command' in v) return `${k}=stdio:${v.command}`;
        return k;
      });
      this.log(`[orchestrator] Starting mission with model=${model}`);
      this.log(`[orchestrator] MCP servers: ${mcpInfo.join(', ') || '(none)'}`);
      this.log(`[orchestrator] Agents: ${Object.keys(this.agentDefinitions).join(', ')}`);
      this.log(`[orchestrator] Prompt: ${prompt.slice(0, 200)}`);
      this.log('---');

      dispatchAttempted = true;
      const missionFallbackModel = this.resolveRetryFallbackFor(this.orchestratorModel);
      const conversation = this.deps.queryFn({
        prompt: fullPrompt,
        options: {
          // Bug R: pass the AbortController into the SDK so abort() actually
          // interrupts query()'s internal iterator. Paired with the watchdog
          // onAbort handler below, this turns every heuristic trip and every
          // external cancel signal into a clean iterator throw.
          abortController: sdkAbortController,
          model: this.orchestratorModel,
          // P3: resilience — if the primary orchestrator model is unavailable
          // or fails, the SDK transparently retries against this fallback.
          // Defaults to Haiku (cheap, broadly available) and is overridable
          // via IMPULSE_AGENT_FALLBACK_MODEL. It's a top-level Option (a model
          // ID/alias string), not per-agent.
          // COORD-019: omitted when it names the very model it would retry.
          ...(missionFallbackModel !== undefined ? { fallbackModel: missionFallbackModel } : {}),
          agents: this.agentDefinitions,
          mcpServers: this.mcpServerConfigs,
          maxBudgetUsd: this.maxBudgetUsd,
          // taskBudget omitted — current Claude SDK models reject it. See top
          // of file for the full reasoning.
          permissionMode: this.permissionMode,
          allowDangerouslySkipPermissions: this.permissionMode === 'bypassPermissions',
          persistSession: false,
          // Emit SDKPartialAssistantMessage (type:'stream_event') token deltas
          // during generation. The idle watchdog needs them to tell an
          // actively-streaming long turn (e.g. the creator assembling a large
          // visual-report HTML with inline SVGs — easily >10 min of output)
          // from a genuinely hung stream. Without partial messages the SDK
          // emits nothing until the turn completes, so the idle watchdog
          // false-aborts the mission mid-compose, right before publishReport.
          // Paired with the 'stream_event' branch in the message loop below.
          includePartialMessages: true,
          // OSS-014: missions load no user/project/local filesystem settings.
          // This prevents private coding instructions, hooks, settings, and
          // coding agents from entering the product prompt/tool surface.
          settingSources: [],
          plugins: [{ type: 'local', path: this.runtimeSkillPluginRoot }],
          skills: this.runtimeSkills,
          // The preset exposes the Skill tool; plugin discovery is explicitly
          // bounded by the product-owned plugin and skill allowlist above.
          tools: { type: 'preset', preset: 'claude_code' },
          // Auto-approve Skill invocations across all permission modes.
          allowedTools: ['Skill'],
          // SEC-014: strip host-mutation and outward-facing built-ins from the
          // model's context entirely. This is a context-hygiene net, not the
          // boundary — the PreToolUse capability hook below is default-deny, so
          // a built-in that appears in a future CLI without being listed here is
          // still refused at execution.
          disallowedTools: [...MISSION_DENIED_BUILTIN_TOOLS],
          // Explicit env allowlist (#31): only ANTHROPIC_*/CLAUDE_* + OS/MCP
          // essentials cross into the SDK subprocess and its stdio-MCP
          // children — never the full host env. CLAUDE_CODE_MAX_OUTPUT_TOKENS
          // is set inside so large HTML reports skip the 32K default limit.
          env: this.childEnv(),
          // SEC-014: the orchestrator installs its own capability hook and
          // merges the caller's on top, so the boundary holds even when the
          // caller supplies no hooks.
          hooks: this.buildHooks(),
        },
      });

      let resultMessage: SDKResultSuccess | SDKResultError | undefined;
      let turnCount = 0;
      // Note: cumulativeInputTokens / cumulativeOutputTokens /
      // cumulativeCacheReadTokens / cumulativeCacheWriteTokens are hoisted to
      // the outer scope (above the try) so the catch block can compute partial
      // cost on abort (Bug D).
      // Rolling accumulator of assistant text blocks + tool-use markers +
      // tool-result summaries. Flushed to the onCheckpoint callback every N
      // turns so the Inngest handler can persist mission.partialResult to
      // Firestore. Includes tool-use/result content so "silent" agents
      // (ones that batch output at the end, M4 evaluator pattern) still
      // have something recoverable on timeout. Exposed on the instance via
      // getAccumulatedPartial() for final-flush-on-timeout.
      this.currentAccumulatedText = [];
      this.currentTurn = 0;
      // MISSION-001: reset the running spend so getUsageSnapshot() can't leak a
      // previous mission's totals into this one before the first turn lands.
      this.currentUsage = {
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const accumulatedText = this.currentAccumulatedText;
      let lastCheckpointBytes = 0;
      const CHECKPOINT_MIN_DELTA_BYTES = 200; // Skip Firestore write if delta below this — saves ~60% of writes at no behavioral cost

      // Watchdog setup — tracks fingerprint repetition, idle gaps, and empty
      // turns. When any heuristic trips, the loop breaks after the next
      // message and runMission throws so the Inngest handler can promote
      // the last checkpoint to partial output.
      const { Watchdog, DEFAULT_WATCHDOG_CONFIG } = await import('./hooks/watchdog.js');
      const watchdog = this.watchdogOpts?.enabled
        ? new Watchdog(
            { ...DEFAULT_WATCHDOG_CONFIG, ...this.watchdogOpts.config },
            {
              onAbort: (reason) => {
                this.log(`[watchdog-abort] ${reason}`);
                // Bug R: every abort() path (heuristic trip OR forceAbort from
                // the cancel-check handler) routes through this callback, so
                // a single SDK abort here covers both. Without this, the
                // iterator may never yield a new message — watchdog.aborted
                // is only checked on the next message, and no message arrives
                // when the SDK subprocess is hung/orphaned.
                if (!sdkAbortController.signal.aborted) sdkAbortController.abort();
              },
              onWarn: (reason) => this.log(`[watchdog-warn] ${reason}`),
            }
          )
        : null;
      idleCheckHandle = watchdog
        ? setInterval(() => {
            watchdog.checkIdle();
            // Bug H: external cancel signal. Run alongside the idle check so
            // we don't add another timer. If cancelCheck resolves true (e.g.
            // mission.status was flipped to 'failed' from outside), abort the
            // watchdog — the next message handler in the for-await throws on
            // watchdog.aborted, the catch block runs cost-capture, and the
            // mission terminates cleanly instead of running until the $5 cap.
            if (this.cancelCheck) {
              this.cancelCheck()
                .then((shouldCancel) => {
                  if (shouldCancel && watchdog && !watchdog.aborted) {
                    this.log('[cancel-check] external signal received — aborting');
                    // forceAbort uses the watchdog's own abort path so the
                    // existing throw + catch + cost-capture flow runs.
                    watchdog.forceAbort('external cancel signal (mission.status no longer running)');
                  }
                })
                .catch(() => {
                  /* cancelCheck failures are non-blocking; mission continues */
                });
            }
          }, 30_000)
        : null;

      // Bug P: track which session the assistant message belongs to so the
      // log makes the parent vs. subagent split visible. SDK 0.2.x emits
      // both via the same iterator — parent has parent_tool_use_id=null,
      // subagent has it set. cumulativeXxxTokens aggregate all of them, so the
      // catch-block cost calculation includes subagent spend. The new
      // session-tag suffix on each [turn N] line is the audit signal — if
      // a future mission shows cumulative-too-low, we can compare turn
      // counts per session and pinpoint where the gap is.
      for await (const message of conversation) {
        if (message.type === 'assistant') {
          turnCount++;
          this.currentTurn = turnCount;
          const betaMsg = (message as Record<string, unknown>).message as BetaMessageLike | undefined;
          const contentBlocks = betaMsg?.content ?? [];
          const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id;
          const sessionTag = parentToolUseId ? `subagent(parent=${parentToolUseId.slice(0, 8)})` : 'parent';
          if (!parentToolUseId && betaMsg?.model) parentSessionModel = betaMsg.model;

          // Count a stable assistant message once. Larger re-emissions are
          // cumulative restatements, so only their delta contributes.
          const usage = betaMsg?.usage;
          let contribution: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;
          if (usage) {
            const observed = {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheRead: usage.cache_read_input_tokens ?? 0,
              cacheWrite: usage.cache_creation_input_tokens ?? 0,
            };
            const usageId = betaMsg?.id;
            const prior = usageId ? seenAssistantUsage.get(usageId) : undefined;
            if (!prior) {
              contribution = observed;
              if (usageId) seenAssistantUsage.set(usageId, observed);
            } else if (
              observed.input === prior.input &&
              observed.output === prior.output &&
              observed.cacheRead === prior.cacheRead &&
              observed.cacheWrite === prior.cacheWrite
            ) {
              duplicateUsageEvents += 1;
            } else if (
              observed.input >= prior.input &&
              observed.output >= prior.output &&
              observed.cacheRead >= prior.cacheRead &&
              observed.cacheWrite >= prior.cacheWrite
            ) {
              contribution = {
                input: observed.input - prior.input,
                output: observed.output - prior.output,
                cacheRead: observed.cacheRead - prior.cacheRead,
                cacheWrite: observed.cacheWrite - prior.cacheWrite,
              };
              seenAssistantUsage.set(usageId!, observed);
              restatedUsageEvents += 1;
            } else {
              contribution = observed;
              seenAssistantUsage.set(usageId!, observed);
              estimateUnavailableReason ??= `assistant message ${usageId} re-emitted with decreased usage counters`;
            }
          }
          if (contribution) {
            const { input, output, cacheRead, cacheWrite } = contribution;
            cumulativeInputTokens += input;
            cumulativeOutputTokens += output;
            cumulativeCacheReadTokens += cacheRead;
            cumulativeCacheWriteTokens += cacheWrite;
            // Fail closed on an unpriceable turn (unknown model / expired-undated
            // introductory rate): never add a wrong-model price or a silent zero.
            // Once any turn is unpriceable the whole running total is unavailable
            // — we record the reason and stop reporting a numeric total that
            // would omit this turn.
            try {
              cumulativeEstimatedCostUsd += estimateTurnCostUsd(betaMsg?.model, {
                input,
                output,
                cacheRead,
                cacheWrite,
              });
            } catch (err) {
              if (err instanceof AccountingUnavailableError) {
                estimateUnavailableReason ??= `turn ${turnCount} model=${betaMsg?.model ?? '(unknown)'}: ${err.reason}`;
                this.log(
                  `[accounting-unavailable] ${estimateUnavailableReason} — running cost total marked unavailable`
                );
              } else {
                throw err;
              }
            }
            this.log(
              `[turn ${turnCount} ${sessionTag}] tokens: input=${input} output=${output} cache_read=${cacheRead} cache_write=${cacheWrite} | cumulative: in=${cumulativeInputTokens} out=${cumulativeOutputTokens} cache=${cumulativeCacheReadTokens}`
            );
            // MISSION-001: publish the real running spend after every turn so
            // the handler can keep budgetState (hence live events + the 80%
            // budget warning + the timeout path) truthful, and getUsageSnapshot
            // can report the true cost/tokens on abort. TEST-021: an unpriceable
            // turn publishes costUsd null (accounting unavailable), never a
            // partial number. onUsage must not throw.
            this.currentUsage = {
              costUsd: estimateUnavailableReason ? null : cumulativeEstimatedCostUsd,
              tokenUsage: { input: cumulativeInputTokens, output: cumulativeOutputTokens },
              cacheReadTokens: cumulativeCacheReadTokens,
              cacheWriteTokens: cumulativeCacheWriteTokens,
              ...(estimateUnavailableReason ? { costUnavailableReason: estimateUnavailableReason } : {}),
            };
            if (this.onUsage) {
              try {
                this.onUsage(this.currentUsage);
              } catch (err) {
                this.log(`[usage-callback-error] ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          } else {
            this.log(`[turn ${turnCount} ${sessionTag}]`);
          }

          // Log each content block: text reasoning and tool_use calls
          for (const block of contentBlocks) {
            if (block.type === 'text') {
              const text = (block as ContentBlockText).text;
              accumulatedText.push(text);
              // Log full reasoning (up to 500 chars) for audit visibility
              const preview = text.length > 500 ? text.slice(0, 500) + `... (${text.length} chars)` : text;
              this.log(`[think] ${preview}`);
            } else if (block.type === 'tool_use') {
              const toolBlock = block as ContentBlockToolUse;
              const inputStr = JSON.stringify(toolBlock.input);
              const inputPreview = inputStr.length > 300 ? inputStr.slice(0, 300) + '...' : inputStr;
              this.log(`[call] ${toolBlock.name}(${inputPreview})`);
              // Add a compact tool-use marker to the checkpoint accumulator
              // so "silent" agents (all tool calls, no text until the end)
              // still have recoverable context if they time out mid-run.
              accumulatedText.push(`[tool-call] ${toolBlock.name}(${inputPreview})`);
              // Feed the watchdog with this tool call for loop detection.
              watchdog?.recordToolCall(toolBlock.name, toolBlock.input);
              // Capture Skill(...) invocations for the per-mission trail.
              if (toolBlock.name === 'Skill' && this.onSkillInvocation) {
                const skillArgs = toolBlock.input as { skill?: string; args?: string };
                try {
                  await this.onSkillInvocation({
                    skill: skillArgs?.skill ?? 'unknown',
                    ...(typeof skillArgs?.args === 'string' ? { args: redactText(skillArgs.args).slice(0, 500) } : {}),
                    firedAt: new Date().toISOString(),
                    turn: turnCount,
                  });
                } catch (err) {
                  this.log(`[skill-invocation-error] ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
          // Record this turn with the watchdog. `hadToolCall` drives the
          // empty-turn streak counter.
          const hadToolCall = contentBlocks.some((b) => b.type === 'tool_use');
          watchdog?.recordTurn(hadToolCall);
          // If any watchdog heuristic tripped on this turn, break the loop
          // cleanly so the finally block clears the idle interval and the
          // outer try/catch promotes partial output.
          if (watchdog?.aborted) {
            throw new Error(`Watchdog abort: ${watchdog.abortReason}`);
          }

          // Fire the checkpoint callback every N turns, but skip the Firestore
          // write when the accumulator hasn't grown meaningfully since the
          // last checkpoint. Prevents no-op writes on turns that produce no
          // new observable state.
          //
          // Progress is tracked against the FULL accumulator length, not the
          // 200KB-sliced payload. The slice was previously used for both the
          // payload AND the delta, which pinned partial.length at 200000 once
          // total length crossed that mark — making delta = 0 forever and
          // skipping every subsequent checkpoint on the longest, most
          // expensive missions (C3 regression).
          if (this.onCheckpoint && turnCount > 0 && turnCount % this.checkpointEveryNTurns === 0) {
            const fullText = accumulatedText.join('\n\n');
            const partial = fullText.slice(-200_000); // payload capped at 200KB
            const delta = fullText.length - lastCheckpointBytes;
            if (delta >= CHECKPOINT_MIN_DELTA_BYTES) {
              try {
                await this.onCheckpoint({ turn: turnCount, partialResult: partial });
                lastCheckpointBytes = fullText.length;
              } catch (err) {
                this.log(`[checkpoint-error] ${err instanceof Error ? err.message : String(err)}`);
              }
            } else {
              this.log(
                `[checkpoint-skip] turn=${turnCount} delta=${delta}B below threshold (${CHECKPOINT_MIN_DELTA_BYTES}B)`
              );
            }
          }
        } else if (message.type === 'tool_progress') {
          const msg = message as Record<string, unknown>;
          const elapsed = (msg.elapsed_time_seconds as number)?.toFixed(1) ?? '?';
          this.log(`[tool] ${msg.tool_name ?? 'unknown'} (${elapsed}s)`);
        } else if (message.type === 'tool_use_summary') {
          const summary = ((message as Record<string, unknown>).summary as string) ?? '';
          const preview = summary.length > 300 ? summary.slice(0, 300) + '...' : summary;
          this.log(`[result] ${preview}`);
          // Include tool-result summaries in the checkpoint accumulator —
          // this is what actually rescues silent-agent patterns. The 2KB
          // cap per summary prevents a single huge scrape result from
          // dominating the checkpoint.
          accumulatedText.push(`[tool-result] ${summary.slice(0, 2000)}`);
          // Reset the watchdog idle clock — a tool result is activity.
          // Without this, a legitimately slow MCP call (e.g. a multi-minute
          // firecrawl_crawl or a bounded impulse-graph aggregate over a large graph)
          // looks like "stream idle" from the assistant's POV and false-aborts
          // the mission. publishReport itself is fast (HTML stays on FS) but
          // the watchdog primitive must tolerate any slow round-trip.
          watchdog?.recordToolResult();
        } else if (message.type === 'stream_event') {
          // Partial generation delta — proof the SDK is actively producing
          // output, not hung. Reset the idle clock so a long-but-active turn
          // (a big report HTML with embedded SVGs can stream for many minutes)
          // isn't false-aborted. A genuinely hung stream emits no deltas, so
          // the idle watchdog still fires correctly. Intentionally not logged
          // (deltas are high-frequency); recordToolResult only bumps the clock.
          watchdog?.recordToolResult();
        } else if (message.type === 'result') {
          resultMessage = message as SDKResultSuccess | SDKResultError;
        } else {
          this.log(`[${message.type}]`);
        }
      }

      if (!resultMessage) {
        const exposure =
          !estimateUnavailableReason && cumulativeEstimatedCostUsd > 0 ? cumulativeEstimatedCostUsd : undefined;
        return {
          success: false,
          costUsd: null,
          costUnavailableReason:
            estimateUnavailableReason ?? 'settlement unavailable: provider returned no final result',
          providerReportedCostUsd: null,
          ...(exposure !== undefined ? { exposureUsd: exposure } : {}),
          ...(duplicateUsageEvents > 0 ? { duplicateUsageEvents } : {}),
          ...(restatedUsageEvents > 0 ? { restatedUsageEvents } : {}),
          tokenUsage: { input: cumulativeInputTokens, output: cumulativeOutputTokens },
          errors: ['No result message received from SDK'],
          requestedModel: this.orchestratorModel,
        };
      }

      // Log detailed cost breakdown from modelUsage
      if (resultMessage.modelUsage) {
        this.log('--- MODEL USAGE BREAKDOWN ---');
        for (const [modelName, usage] of Object.entries(resultMessage.modelUsage)) {
          this.log(
            `[cost] model=${modelName} input=${usage.inputTokens} output=${usage.outputTokens} cache_read=${usage.cacheReadInputTokens} cost=$${usage.costUSD.toFixed(4)}`
          );
        }
        this.log(
          `[cost] TOTAL turns=${resultMessage.num_turns} cost=$${resultMessage.total_cost_usd.toFixed(4)} duration=${((resultMessage.duration_api_ms ?? 0) / 1000).toFixed(1)}s`
        );
        this.log('---');
      }

      if (idleCheckHandle) clearInterval(idleCheckHandle);
      const mr = this.toMissionResult(resultMessage);
      const substitution = detectModelSubstitution({
        requested: this.orchestratorModel,
        primaryServed: parentSessionModel,
        servedModels: Object.keys(mr.modelUsage ?? {}),
        configuredFallback: this.fallbackModel,
      });
      if (substitution) mr.modelSubstitution = substitution;
      // Cost/usage on an ERROR result (notably a budget abort) can undercount:
      // the SDK totals may reflect only the final turn or omit subagent spend.
      // The cumulative token counters aggregate parent + subagent turns, so for
      // a failure prefer the cumulative estimate and floor a budget abort at
      // the configured cap. This keeps the recorded bill conservative.
      if (!mr.success) {
        const hitBudget = !!this.maxBudgetUsd && (mr.errors ?? []).some((e) => /maximum budget/i.test(e));
        const providerReported = providerSettlementUsd(resultMessage, mr.modelUsage);
        const estimate = estimateUnavailableReason ? undefined : cumulativeEstimatedCostUsd;
        const exposureComponents = [
          providerReported ?? undefined,
          estimate,
          hitBudget ? this.maxBudgetUsd : undefined,
        ].filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
        if (exposureComponents.length > 0) mr.exposureUsd = Math.max(...exposureComponents);
        mr.providerReportedCostUsd = providerReported;
        if (duplicateUsageEvents > 0) mr.duplicateUsageEvents = duplicateUsageEvents;
        if (restatedUsageEvents > 0) mr.restatedUsageEvents = restatedUsageEvents;
        if (providerReported !== null) {
          mr.costUsd = providerReported;
          delete mr.costUnavailableReason;
        } else {
          mr.costUsd = null;
          mr.costUnavailableReason =
            mr.costUnavailableReason ??
            estimateUnavailableReason ??
            'provider reported no settled cost for failed session';
        }
        if (cumulativeInputTokens > mr.tokenUsage.input) {
          mr.tokenUsage = { input: cumulativeInputTokens, output: cumulativeOutputTokens };
        }
      }
      if (mr.success) {
        if (duplicateUsageEvents > 0) mr.duplicateUsageEvents = duplicateUsageEvents;
        if (restatedUsageEvents > 0) mr.restatedUsageEvents = restatedUsageEvents;
      }
      return mr;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (idleCheckHandle) clearInterval(idleCheckHandle);
      const provenNoDispatch = !dispatchAttempted;
      const observedUsage = cumulativeInputTokens > 0 || cumulativeOutputTokens > 0;
      const estimate = !estimateUnavailableReason && observedUsage ? cumulativeEstimatedCostUsd : undefined;
      const hitBudget = !!this.maxBudgetUsd && /maximum budget/i.test(errorMessage);
      const exposureComponents = [estimate, hitBudget ? this.maxBudgetUsd : undefined].filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value)
      );
      return {
        success: false,
        costUsd: provenNoDispatch ? 0 : null,
        ...(provenNoDispatch
          ? {}
          : {
              costUnavailableReason:
                estimateUnavailableReason ?? 'settlement unavailable: provider returned no final result',
            }),
        providerReportedCostUsd: provenNoDispatch ? 0 : null,
        ...(exposureComponents.length > 0 ? { exposureUsd: Math.max(...exposureComponents) } : {}),
        ...(duplicateUsageEvents > 0 ? { duplicateUsageEvents } : {}),
        ...(restatedUsageEvents > 0 ? { restatedUsageEvents } : {}),
        tokenUsage: { input: cumulativeInputTokens, output: cumulativeOutputTokens },
        errors: [errorMessage],
        // OPS-004: preserve the typed pre-spend preflight failure so the worker
        // can short-circuit every later paid stage rather than continuing into
        // recovery/L1/judge/revision on an ordinary-looking failed result.
        ...(error instanceof McpPreflightError ||
        error instanceof UnsupportedModelError ||
        error instanceof McpCredentialContainmentError
          ? { failureKind: error.failureKind }
          : {}),
        requestedModel: this.orchestratorModel,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * OPS-005 — the value handed to the SDK for one agent definition.
   *
   * An exact profile pin passes through UNCHANGED; the explicit aliases still
   * mean "let the SDK choose". A model this runtime cannot serve is recorded as
   * a violation and reported by {@link assertConfiguredModelsSupported} before
   * any provider work — the placeholder returned here is never reached, because
   * the run is refused first.
   */
  private mapModelToSdk(model: string, scope: string): string {
    const selection = resolveSdkModel(model);
    if (selection.ok) return selection.model;
    this.modelViolations.push({ scope, requested: model.trim(), reason: selection.reason });
    return 'inherit';
  }

  /**
   * Resolve the permissionMode that should land on a sub-agent's
   * AgentDefinition. Honors the per-profile `permission_mode` from the
   * agent's config.yaml when set; otherwise inherits the parent
   * orchestrator's mode so sub-agents share the same gate behavior the
   * parent already proved out.
   *
   * Why this matters: without an explicit `permissionMode`, the SDK
   * falls back to interactive prompting on the first sub-agent tool
   * call and waits forever for a `canUseTool` callback that the
   * orchestrator never registers. We saw this as a 17-min "stream idle"
   * hang when report tool calls reached the permission gate without an
   * interactive callback.
   */
  private resolveSubAgentPermissionMode(profile: AgentProfile): PermissionMode {
    const fromProfile = profile.permission_mode as PermissionMode | undefined;
    return fromProfile ?? this.permissionMode;
  }

  /**
   * Build SDK agent definitions from all loaded profiles.
   *
   * Merges universal tier servers (graph + filesystem) into each agent's
   * MCP server list via {@link resolveAgentMcpServers}.
   *
   * Bug N: each subagent's `prompt` field is prefixed with the mission
   * context block (slot manifest + completion rules). Without this prefix,
   * dispatched subagents only see their profile and the parent's dispatch
   * message—not the orchestrator's permission map or slot manifest—so they can
   * choose an off-manifest slot.
   */
  private buildAgentDefinitions(): Record<string, AgentDefinition> {
    const definitions: Record<string, AgentDefinition> = {};
    const subagentMissionContext = this.buildSubagentMissionContext();

    for (const [name, profile] of this.profiles) {
      const resolved = resolveAgentMcpServers(this.config.externalMcpServers, profile.mcp_servers);

      definitions[name] = {
        description: profile.description,
        prompt: subagentMissionContext + profile.prompt,
        model: this.mapModelToSdk(profile.model, `agent:${name}`),
        mcpServers: [...resolved.internal, ...Object.keys(resolved.external), ...resolved.httpFallback],
        permissionMode: this.resolveSubAgentPermissionMode(profile),
        // SEC-014: the same host-mutation deny list the parent carries, applied
        // per subagent so the SDK strips these from each specialist's context
        // too. The PreToolUse capability hook remains the authoritative gate.
        disallowedTools: [...MISSION_DENIED_BUILTIN_TOOLS],
        // P3: surface the per-agent reasoning effort from config.yaml to the
        // SDK. profiles.ts already parses `effort` but the orchestrator never
        // forwarded it, so the config was dead. Only set the key when the
        // profile actually declares an effort — omitting it lets the SDK apply
        // its model default rather than pinning to a value. The profile's
        // effort union ('low'|'medium'|'high'|'max') is a subset of the SDK's
        // AgentDefinition.effort, so the assignment is type-safe.
        ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
        // Sub-agents need the same explicit product-owned allowlist as the
        // parent session; they inherit neither filesystem settings nor a
        // broader user/project skill surface.
        skills: this.runtimeSkills,
      };
    }

    return definitions;
  }

  /**
   * Build the mission-context block that gets prepended to every subagent's
   * profile prompt. Includes the slot manifest, missionId, and the
   * completion rules. Empty string when running outside a mission (e.g.,
   * chat mode or sweep cycle) so chat subagents are unchanged.
   */
  private buildSubagentMissionContext(): string {
    if (!this.missionId) return '';

    // MISSION-011: a subagent inherits the SAME artifact truth as its parent.
    // Without this branch a Creator dispatched by a zero-slot mission received
    // the full publish contract and went looking for report tools that could
    // never accept its slotName.
    if (!this.hasArtifactSlot()) {
      return [
        '## MISSION CONTEXT (auto-injected — read this before any tool call)',
        '',
        `MISSION ID: ${this.missionId}. Bound automatically.`,
        '',
        'DELIVERABLE RULES (non-negotiable):',
        ...NO_ARTIFACT_DELIVERABLE_RULES,
        '',
        '---',
        '',
      ].join('\n');
    }

    const slotNames = JSON.stringify((this.slots ?? []).map((s) => s.name));
    return [
      '## MISSION CONTEXT (auto-injected — read this before any tool call)',
      '',
      `MISSION ID: ${this.missionId}. Bound automatically; do not pass missionId to publishReport.`,
      `ALLOWED slotName values for publishReport: ${slotNames}. Any other name will be REJECTED server-side.`,
      reportAuthoringModeInstruction(),
      '',
      'COMPLETION RULES (non-negotiable):',
      // REPORT-006: same single-source publish contract as the orchestrator
      // preamble — the revision turn re-composes through this builder too.
      PUBLISH_COMPLETION_SIGNAL_RULE,
      PUBLISH_PRIVACY_RULE,
      '- Do NOT call draftReport, publishReport, generateInfographic, generateVisualization, generate_image, renderDiagram, listReports, getReportById, or filesystem.* AFTER a successful publishReport in this turn.',
      '- Do NOT dispatch any agent (Agent({...})) to "verify", "polish", or "improve" after a successful publish. The platform automatically runs an L1 quality gate and a separate REVISE turn if needed — that revise turn is a NEW orchestrator instance with its own prompt; you do not initiate it from this turn.',
      '- Do NOT embed remote image URLs in report HTML (publication policy rejects off-origin resources). After any image generation: draftReport (no remote <img>) → publishReport → STOP.',
      '',
      '---',
      '',
    ].join('\n');
  }

  /**
   * MISSION-011 — may this run publish an artifact at all?
   *
   * TRUE outside a mission (chat mode, sweep, CLI): those runs have no manifest
   * to enforce and their report behavior is unchanged. Inside a mission it is the
   * frozen manifest that decides, exactly as `executePublishReport` does
   * server-side — an empty manifest rejects every `slotName`, so telling the
   * agent it may publish would be a promise the runtime cannot keep.
   */
  private hasArtifactSlot(): boolean {
    if (!this.missionId) return true;
    return (this.slots?.length ?? 0) > 0;
  }

  /**
   * Build deduplicated MCP server configs from all agent definitions.
   *
   * Internal servers → HTTP (served by the platform API).
   * External servers → native transport from config (stdio or http).
   */
  private buildMcpServerConfigs(): Record<string, McpHttpServerConfig | McpStdioServerConfig> {
    const serverNames = new Set<string>();

    for (const def of Object.values(this.agentDefinitions)) {
      if (Array.isArray(def.mcpServers)) {
        for (const spec of def.mcpServers) {
          if (typeof spec === 'string') serverNames.add(spec);
        }
      }
    }

    const configs: Record<string, McpHttpServerConfig | McpStdioServerConfig> = {};

    for (const serverName of serverNames) {
      const externalDef = this.config.externalMcpServers[serverName];

      if (externalDef) {
        // External server — use its native transport
        if (externalDef.transport === 'http') {
          configs[serverName] = {
            type: 'http',
            url: externalDef.url,
          };
        } else {
          configs[serverName] = {
            type: 'stdio',
            command: externalDef.command,
            args: externalDef.args,
            ...(externalDef.env ? { env: externalDef.env } : {}),
          };
        }
      } else {
        // Internal server — HTTP via platform API
        const config: McpHttpServerConfig = {
          type: 'http',
          url: this.deps.getServerUrl(this.config, serverName),
        };

        // Bind apiKey + missionId on every internal HTTP call so the platform
        // MCP route can authorize the caller AND scope tool calls to this
        // mission server-side. Without x-mission-id, draftReport /
        // publishReport reject with "missionId not bound" — every mission
        // costs $$$ and produces 0 reports (C2).
        //
        // SEC-013: the key is emitted as a `${VAR}` reference whenever a
        // forwarded env var holds it, so the plaintext never reaches the CLI's
        // argv or its on-disk transport traces.
        if (this.apiKey || this.missionId) {
          config.headers = {
            ...(this.apiKey ? { 'x-api-key': this.mcpAuthHeaderValue } : {}),
            ...(this.missionId ? { 'x-mission-id': this.missionId } : {}),
          };
        }

        configs[serverName] = config;
      }
    }

    return configs;
  }

  /**
   * Task 2.2: Build MCP server configs from an explicit server name list.
   * Used by streamChat() which needs a curated set (not derived from agents).
   */
  private buildMcpServerConfigsForNames(
    serverNames: string[]
  ): Record<string, McpHttpServerConfig | McpStdioServerConfig> {
    const configs: Record<string, McpHttpServerConfig | McpStdioServerConfig> = {};

    for (const serverName of serverNames) {
      const externalDef = this.config.externalMcpServers[serverName];

      if (externalDef) {
        if (externalDef.transport === 'http') {
          configs[serverName] = { type: 'http', url: externalDef.url };
        } else {
          configs[serverName] = {
            type: 'stdio',
            command: externalDef.command,
            args: externalDef.args,
            ...(externalDef.env ? { env: externalDef.env } : {}),
          };
        }
      } else {
        const config: McpHttpServerConfig = {
          type: 'http',
          url: this.deps.getServerUrl(this.config, serverName),
        };
        // Same header binding as buildMcpServerConfigs — keep parity (C2),
        // including the SEC-013 `${VAR}` reference for the auth header.
        if (this.apiKey || this.missionId) {
          config.headers = {
            ...(this.apiKey ? { 'x-api-key': this.mcpAuthHeaderValue } : {}),
            ...(this.missionId ? { 'x-mission-id': this.missionId } : {}),
          };
        }
        configs[serverName] = config;
      }
    }

    return configs;
  }

  /**
   * Task 2.1b: Build agent definitions for chat mode (natural delegation).
   * All agents run inline — the SDK `AgentDefinition` shape carries no
   * background flag and none is set here (the earlier scout/creator
   * background-execution design was reverted with the chaining approach).
   */
  private getChatAgentDefinitions(): Record<string, AgentDefinition> {
    const definitions: Record<string, AgentDefinition> = {};
    // Bug N: same prefix as buildAgentDefinitions. In chat mode this is
    // typically a no-op (no missionId) but if the chat is mid-mission the
    // dispatched subagent gets the same slot manifest + completion rules.
    const subagentMissionContext = this.buildSubagentMissionContext();

    for (const [name, profile] of this.profiles) {
      const resolved = resolveAgentMcpServers(this.config.externalMcpServers, profile.mcp_servers);

      definitions[name] = {
        description: profile.description,
        prompt: subagentMissionContext + profile.prompt,
        model: this.mapModelToSdk(profile.model, `chat-agent:${name}`),
        mcpServers: [...resolved.internal, ...Object.keys(resolved.external), ...resolved.httpFallback],
        permissionMode: this.resolveSubAgentPermissionMode(profile),
        // SEC-014: the same host-mutation deny list the parent carries, applied
        // per subagent so the SDK strips these from each specialist's context
        // too. The PreToolUse capability hook remains the authoritative gate.
        disallowedTools: [...MISSION_DENIED_BUILTIN_TOOLS],
        // P3: same effort wiring as buildAgentDefinitions — surface the
        // per-agent reasoning effort from config.yaml in chat mode too. Only
        // set the key when the profile declares one so the SDK default applies
        // otherwise.
        ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
        skills: this.runtimeSkills,
      };
    }

    return definitions;
  }

  /**
   * OPS-004: EVERY in-tree platform MCP server this mission is configured with
   * MUST be reachable before it spends any provider budget — not just the
   * universal-tier pair.
   *
   * "Internal" is decided by the canonical route catalog
   * ({@link INTERNAL_PLATFORM_MCP_ROUTES}), NOT by "HTTP and not declared
   * external". On a fresh no-YAML install `resolveAgentMcpServers` omits every
   * unconfigured third-party name and keeps only real in-process HTTP fallback
   * routes. We therefore require exactly the platform-served endpoints
   * (the impulse-entities/graph/signals/research/radar/reports domain servers
   * plus the in-tree gemini and super-graph servers) that this mission actually
   * declares, and never a third-party name.
   *
   * Requiring the full platform set (rather than a two-server witness) means a
   * mission that can research but whose Report/entity tools are down fails fast
   * instead of looking healthy.
   */
  private requiredInternalMcpServers(): string[] {
    return Object.entries(this.mcpServerConfigs)
      .filter(([name, config]) => {
        if (!('url' in config) || config.type !== 'http') return false;
        return INTERNAL_PLATFORM_MCP_ROUTES.has(name.replace(/^impulse-/, ''));
      })
      .map(([name]) => name);
  }

  /**
   * OPS-004: throw before provider spend when a required internal MCP is
   * unreachable. The caller (runMission) invokes this immediately after
   * {@link checkMcpHealth} and before the SDK query loop, so a misrouted base
   * URL fails fast at $0 instead of driving an expensive tool-search loop to
   * the watchdog abort.
   */
  private assertRequiredInternalMcpReachable(mcpHealth: Record<string, 'online' | 'unreachable' | 'external'>): void {
    const required = this.requiredInternalMcpServers();
    const unreachable = required.filter((name) => mcpHealth[name] === 'unreachable');
    if (unreachable.length === 0) return;
    // The precise base URL is logged elsewhere (server-side); the error message
    // becomes mission.errors (user-visible), so it must NOT leak the internal
    // base URL — only a stable reason code + URL-free remediation.
    this.log(
      `[mcp-preflight] required internal MCP unreachable at ${this.config.mcpBaseUrl}: ${unreachable.join(', ')}`
    );
    throw new McpPreflightError(
      `${MCP_PREFLIGHT_FAILURE_KIND}: internal platform tools are temporarily unavailable ` +
        `(${unreachable.join(', ')}). Confirm the app and its internal MCP service are running, then retry.`
    );
  }

  /**
   * Health-check the CANONICAL platform MCP routes only.
   *
   * OPS-004: probe exactly the in-tree platform servers
   * ({@link INTERNAL_PLATFORM_MCP_ROUTES}) and NEVER a third-party fallback URL.
   * On a fresh no-YAML install unconfigured third-party names are omitted. Any
   * configured non-canonical entries (stdio or explicit HTTP transports) are
   * reported `external` without a platform health probe.
   *
   * Probes run in PARALLEL under ONE shared ~10s deadline (not a per-server
   * timeout summed sequentially, which could stall a mission for minutes before
   * the fail-fast gate ever runs). Each probe uses an auth-required `tools/list`
   * and parses the JSON-RPC body — a rejected key returns an error at HTTP 200,
   * so `resp.ok` alone would call a broken key healthy.
   */
  private async checkMcpHealth(): Promise<Record<string, 'online' | 'unreachable' | 'external'>> {
    const results: Record<string, 'online' | 'unreachable' | 'external'> = {};
    // One global bound for the whole parallel batch.
    const signal = AbortSignal.timeout(10_000);
    const probes: Array<Promise<void>> = [];

    for (const [name, config] of Object.entries(this.mcpServerConfigs)) {
      const isPlatformRoute =
        'url' in config && config.type === 'http' && INTERNAL_PLATFORM_MCP_ROUTES.has(name.replace(/^impulse-/, ''));
      if (!isPlatformRoute) {
        results[name] = 'external';
        continue;
      }
      const httpConfig = config as McpHttpServerConfig;
      probes.push(
        (async () => {
          try {
            const resp = await fetch(httpConfig.url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // SEC-013: the transport config now carries a `${VAR}` reference
                // rather than the key; this probe runs in-process, so it must
                // send the resolved value or every probe would 401.
                ...(expandMcpHeaderPlaceholders(httpConfig.headers, this.childEnv()) ?? {}),
              },
              body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
              // SEC-013: never follow a redirect while carrying the internal
              // service key. A redirected internal MCP route would replay the
              // credential against whatever origin the redirect names; treating
              // it as unreachable fails the preflight closed instead.
              redirect: 'error',
              signal,
            });
            if (!resp.ok) {
              results[name] = 'unreachable';
              return;
            }
            const body: unknown = await resp.json().catch(() => null);
            const record = body && typeof body === 'object' ? (body as { result?: unknown; error?: unknown }) : null;
            results[name] =
              record && record.error === undefined && record.result !== undefined ? 'online' : 'unreachable';
          } catch {
            results[name] = 'unreachable';
          }
        })()
      );
    }

    await Promise.all(probes);
    return results;
  }

  /**
   * Convert an SDK result message to a MissionResult.
   */
  /**
   * TEST-021 — price an SDK result message, failing CLOSED. The SDK's own
   * `total_cost_usd` (or the sum of per-model `costUSD`) is an AUTHORITATIVE
   * billed figure and is used when present. Otherwise we ESTIMATE from token
   * counters on each model's own card rate; if ANY component is unpriceable
   * (unknown model / expired-undated introductory rate, or no per-model
   * breakdown at all), the whole total is unavailable (`costUsd: null` + reason)
   * — never a partial sum and never a fabricated wrong-model figure.
   */
  private priceResultMessage(
    message: SDKResultSuccess | SDKResultError,
    modelUsage: Record<string, ModelUsageSummary> | undefined
  ): { costUsd: number | null; costUnavailableReason?: string } {
    // Authoritative provider figures first.
    const sdkTotal = message.total_cost_usd ?? 0;
    if (sdkTotal > 0) return { costUsd: sdkTotal };
    const sumFromModelUsage = modelUsage ? Object.values(modelUsage).reduce((sum, u) => sum + (u.costUSD ?? 0), 0) : 0;
    if (sumFromModelUsage > 0) return { costUsd: sumFromModelUsage };

    // No authoritative figure — estimate from token counters, fail closed.
    if (modelUsage && Object.keys(modelUsage).length > 0) {
      let sum = 0;
      for (const [modelName, u] of Object.entries(modelUsage)) {
        try {
          sum += estimateTurnCostUsd(modelName, {
            input: u.inputTokens,
            output: u.outputTokens,
            cacheRead: u.cacheReadInputTokens ?? 0,
            cacheWrite: u.cacheCreationInputTokens ?? 0,
          });
        } catch (err) {
          if (err instanceof AccountingUnavailableError) {
            const reason = `model=${modelName}: ${err.reason}`;
            this.log(`[accounting-unavailable] ${reason} — mission cost total unavailable`);
            return { costUsd: null, costUnavailableReason: reason };
          }
          throw err;
        }
      }
      return { costUsd: sum };
    }

    // No per-model breakdown at all — the effective model is unknown, so the
    // aggregate cannot be priced. Fail closed (never fabricate a wrong-model
    // estimate, never a silent zero).
    try {
      return {
        costUsd: estimateTurnCostUsd(undefined, {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens ?? 0,
          cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
        }),
      };
    } catch (err) {
      if (err instanceof AccountingUnavailableError) {
        const reason = `no per-model usage breakdown: ${err.reason}`;
        this.log(`[accounting-unavailable] ${reason} — mission cost total unavailable`);
        return { costUsd: null, costUnavailableReason: reason };
      }
      throw err;
    }
  }

  private toMissionResult(message: SDKResultSuccess | SDKResultError): MissionResult {
    // Extract per-model usage, keeping only the fields we care about
    const modelUsage: Record<string, ModelUsageSummary> | undefined = message.modelUsage
      ? Object.fromEntries(
          Object.entries(message.modelUsage).map(([model, usage]) => [
            model,
            {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadInputTokens: usage.cacheReadInputTokens,
              ...(usage.cacheCreationInputTokens !== undefined
                ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
                : {}),
              costUSD: usage.costUSD,
            },
          ])
        )
      : undefined;

    const { costUsd, costUnavailableReason } = this.priceResultMessage(message, modelUsage);
    const providerReportedCostUsd = providerSettlementUsd(message, modelUsage);

    const base = {
      costUsd,
      ...(costUnavailableReason ? { costUnavailableReason } : {}),
      tokenUsage: {
        input: message.usage.input_tokens,
        output: message.usage.output_tokens,
      },
      numTurns: message.num_turns,
      durationApiMs: message.duration_api_ms,
      modelUsage,
      providerReportedCostUsd,
      requestedModel: this.orchestratorModel,
    };

    if (message.subtype === 'success') {
      return {
        ...base,
        success: true,
        result: message.result,
      };
    }

    return {
      ...base,
      success: false,
      errors: message.errors,
    };
  }
}
