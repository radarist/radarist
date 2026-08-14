/**
 * @file config.ts
 * @description Unified configuration module — single source of truth.
 *
 * Task 0.9b: Replaces scattered process.env reads with typed accessors.
 * - Reads env vars with sensible defaults
 * - Supports both legacy (MISSION_*) and prefixed (IMPULSE_*) names
 * - New env vars should use IMPULSE_ prefix
 * - Existing unprefixed vars keep working (no breaking change)
 */

import { resolveMissionLimits } from './mission-limits';

function readEnv(primary: string, alias?: string, fallback?: string): string | undefined {
  return process.env[primary] ?? (alias ? process.env[alias] : undefined) ?? fallback;
}

function parseNumber(primary: string, alias: string | undefined, defaultValue: number): number {
  const value = readEnv(primary, alias);
  const parsed = value ? parseFloat(value) : NaN;
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseInt10(primary: string, alias: string | undefined, defaultValue: number): number {
  const value = readEnv(primary, alias);
  const parsed = value ? parseInt(value, 10) : NaN;
  return isNaN(parsed) ? defaultValue : parsed;
}

/** Parse an exact base-10 integer within inclusive bounds; invalid input fails closed. */
export function parseBoundedInteger(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number
): number | null {
  if (value === undefined) return defaultValue;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function parseBool(primary: string, alias: string | undefined, defaultValue: boolean): boolean {
  const value = readEnv(primary, alias);
  if (value === undefined) return defaultValue;
  return value === 'true';
}

const missionLimits = resolveMissionLimits(process.env);

export const config = {
  /** Mission limits (legacy unprefixed primary, IMPULSE_ alias) */
  mission: {
    timeoutMinutes: parseInt10('MISSION_TIMEOUT_MINUTES', 'IMPULSE_MISSION_TIMEOUT_MINUTES', 30),
    tokenBudget: missionLimits.tokenBudget,
    maxToolCalls: missionLimits.maxToolCalls,
    maxCostUsd: missionLimits.maxCostUsd,
    warnThreshold: missionLimits.warnThreshold,
  },

  /** Chat limits */
  chat: {
    maxBudgetUsd: parseNumber('IMPULSE_CLAUDE_CHAT_MAX_BUDGET_USD', 'CLAUDE_CHAT_MAX_BUDGET_USD', 0.5),
    // DISC-003: the ONE tool-loop cap the chat route enforces (both Gemini and
    // Claude paths). Default 15 preserves the previously-hardcoded behavior;
    // CHAT_MAX_TOOL_ITERATIONS is the legacy alias the route used to read.
    maxToolCalls: parseInt10('IMPULSE_CHAT_MAX_TOOL_CALLS', 'CHAT_MAX_TOOL_ITERATIONS', 15),
    parallelToolCalls: parseInt10('AI_PARALLEL_TOOL_CALLS', 'IMPULSE_AI_PARALLEL_TOOL_CALLS', 3),
    // routeTimeoutSeconds removed (DISC-003): the real bound is the route's
    // static `export const maxDuration = 300` + CHAT_LOOP_BUDGET_MS — a runtime
    // env var can never change a Next.js static route segment config.
  },

  // config.models removed (DISC-003): CLAUDE_MISSION_MODEL / CLAUDE_REPORT_MODEL /
  // IMPULSE_CLAUDE_SWEEP_MODEL were minted here but consumed by nothing — mission
  // models actually come from the agent profile YAML, CLAUDE_CHAT_MODEL (read
  // directly by the orchestrator/chat route), and IMPULSE_AGENT_FALLBACK_MODEL.

  /** Feature flags (runtime kill switches) */
  flags: {
    claudeChatEnabled: parseBool('CLAUDE_CHAT_ENABLED', 'IMPULSE_CLAUDE_CHAT_ENABLED', false),
    graphSyncEnabled: parseBool('GRAPH_SYNC_ENABLED', 'IMPULSE_GRAPH_SYNC_ENABLED', true),
    signalAutopilotEnabled: parseBool('SIGNAL_AUTOPILOT_ENABLED', 'IMPULSE_SIGNAL_AUTOPILOT_ENABLED', false),
    linkerAutopilotEnabled: parseBool('LINKER_AUTOPILOT_ENABLED', 'IMPULSE_LINKER_AUTOPILOT_ENABLED', false),
    // When on, a build-mission evaluation's Assessment auto-applies at
    // buildAssessmentAutoApprove. Relations also have to clear the graph's
    // reliability-aware machine materialization floor or remain in triage.
    buildAutopilotEnabled: parseBool('BUILD_AUTOPILOT_ENABLED', 'IMPULSE_BUILD_AUTOPILOT_ENABLED', false),
    // Task 16 (A1): gates the confidence-scale-0-100 minters (relation-defaults,
    // chunk-mentions, the two Inngest sync ingress points). Default true — the
    // 0-100 scale is the contract everywhere else; flip to false only to
    // temporarily restore the legacy 0-1 minting behavior being retired.
    confidenceScale100Enabled: parseBool('CONFIDENCE_SCALE_100_ENABLED', 'IMPULSE_CONFIDENCE_SCALE_100_ENABLED', true),
  },

  /** Auto-apply thresholds */
  thresholds: {
    signalAutoApprove: parseBoundedInteger(
      readEnv('SIGNAL_AUTO_APPROVE_THRESHOLD', 'IMPULSE_SIGNAL_AUTO_APPROVE_THRESHOLD'),
      85,
      0,
      100
    ),
    linkerAutoApprove: parseInt10('LINKER_AUTO_APPROVE_THRESHOLD', 'IMPULSE_LINKER_AUTO_APPROVE_THRESHOLD', 75),
    buildAssessmentAutoApprove: parseInt10(
      'BUILD_ASSESSMENT_AUTO_APPROVE_THRESHOLD',
      'IMPULSE_BUILD_ASSESSMENT_AUTO_APPROVE_THRESHOLD',
      75
    ),
  },

  /** Build-mission artifact publishing */
  build: {
    /** Radar an evaluation places onto under autopilot (else reviewer picks at approval). */
    defaultRadarId: readEnv('BUILD_DEFAULT_RADAR_ID', 'IMPULSE_BUILD_DEFAULT_RADAR_ID', undefined),
  },

  // config.delegation removed (DISC-003): IMPULSE_DELEGATION_MAX_DEPTH /
  // _MAX_CONCURRENT were minted here but no enforcement point ever read them —
  // the agent orchestrator's sub-agent fan-out has its own internal limits.

  /** Internal auth */
  auth: {
    internalKey: process.env.IMPULSE_INTERNAL_KEY,
    logFile: process.env.IMPULSE_LOG_FILE,
  },

  /** AI rate limiting — consumed by the reliability layer (DISC-001). Defaults
   *  match the previously-hardcoded enforcement (30 RPM / $10 per day) so
   *  wiring these through changes nothing until an operator sets them. */
  ai: {
    rateLimitRpm: parseInt10('AI_RATE_LIMIT_RPM', undefined, 30),
    dailyBudgetUsd: parseNumber('AI_DAILY_BUDGET_USD', undefined, 10),
  },

  /** MCP error thresholds */
  mcp: {
    errorWarnThreshold: parseInt10('MCP_ERROR_WARN_THRESHOLD', undefined, 3),
  },
};

/**
 * Validate required env vars at startup (fail fast).
 * Call from server entry points, not from client code.
 */
export function validateConfigOrThrow(): void {
  const required: Array<[string, unknown]> = [
    ['GOOGLE_API_KEY or GEMINI_API_KEY', process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY],
  ];

  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
