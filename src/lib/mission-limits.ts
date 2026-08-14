/**
 * Mission-wide runtime limits shared by execution and settings readouts.
 *
 * Legacy MISSION_* names remain primary. The IMPULSE_* aliases are consulted
 * only when the corresponding primary variable is absent, matching the rest of
 * the configuration module.
 */

export const DEFAULT_MISSION_LIMITS = Object.freeze({
  maxCostUsd: 15,
  tokenBudget: 50_000,
  maxToolCalls: 100,
  warnThreshold: 0.8,
});

export const DEFAULT_AGENT_MISSION_COST_COMPONENTS = Object.freeze({
  preludeMaxCostUsd: 2,
  auxiliaryMaxCostUsd: 2,
});

export const DEFAULT_MISSION_TIMEOUT_MINUTES = 45;
export const MAX_MISSION_TIMEOUT_MINUTES = 120;

export type MissionLimitEnvironmentVariable =
  | 'MISSION_MAX_COST_USD'
  | 'IMPULSE_MISSION_MAX_COST_USD'
  | 'MISSION_TOKEN_BUDGET'
  | 'IMPULSE_MISSION_TOKEN_BUDGET'
  | 'MISSION_MAX_TOOL_CALLS'
  | 'IMPULSE_MISSION_MAX_TOOL_CALLS'
  | 'MISSION_WARN_THRESHOLD'
  | 'IMPULSE_MISSION_WARN_THRESHOLD';

export interface ResolvedMissionLimits {
  maxCostUsd: number;
  maxCostSource: 'env' | 'default';
  tokenBudget: number;
  maxToolCalls: number;
  warnThreshold: number;
  invalidEnvironmentVariables: MissionLimitEnvironmentVariable[];
}

export interface AgentProfileMissionBudget {
  max_tokens?: unknown;
  max_tool_calls?: unknown;
}

type MissionLimitEnvironment = Readonly<Record<string, string | undefined>>;

export interface AgentMissionCostEnvelope {
  orchestratorMaxCostUsd: number;
  revisionMaxCostUsd: number;
  preludeMaxCostUsd: number;
  auxiliaryMaxCostUsd: number;
  totalMaxCostUsd: number;
}

interface SelectedEnvironmentValue {
  key?: MissionLimitEnvironmentVariable;
  raw?: string;
}

function selectEnvironmentValue(
  env: MissionLimitEnvironment,
  primary: MissionLimitEnvironmentVariable,
  alias: MissionLimitEnvironmentVariable
): SelectedEnvironmentValue {
  if (env[primary] !== undefined) return { key: primary, raw: env[primary] };
  if (env[alias] !== undefined) return { key: alias, raw: env[alias] };
  return {};
}

function resolvePositiveNumber(
  selected: SelectedEnvironmentValue,
  fallback: number,
  invalidEnvironmentVariables: MissionLimitEnvironmentVariable[]
): { value: number; source: 'env' | 'default' } {
  if (selected.key === undefined || selected.raw === undefined) {
    return { value: fallback, source: 'default' };
  }

  const value = Number(selected.raw);
  if (!Number.isFinite(value) || value <= 0) {
    invalidEnvironmentVariables.push(selected.key);
    return { value: fallback, source: 'default' };
  }

  return { value, source: 'env' };
}

function resolvePositiveInteger(
  selected: SelectedEnvironmentValue,
  fallback: number,
  invalidEnvironmentVariables: MissionLimitEnvironmentVariable[]
): number {
  const resolved = resolvePositiveNumber(selected, fallback, invalidEnvironmentVariables);
  if (resolved.source === 'default') return resolved.value;
  if (Number.isSafeInteger(resolved.value)) return resolved.value;

  invalidEnvironmentVariables.push(selected.key!);
  return fallback;
}

function resolveWarnThreshold(
  selected: SelectedEnvironmentValue,
  invalidEnvironmentVariables: MissionLimitEnvironmentVariable[]
): number {
  const resolved = resolvePositiveNumber(selected, DEFAULT_MISSION_LIMITS.warnThreshold, invalidEnvironmentVariables);
  if (resolved.source === 'default') return resolved.value;
  if (resolved.value <= 1) return resolved.value;

  invalidEnvironmentVariables.push(selected.key!);
  return DEFAULT_MISSION_LIMITS.warnThreshold;
}

/** Resolve mission limits without reading global process state. */
export function resolveMissionLimits(env: MissionLimitEnvironment): ResolvedMissionLimits {
  const invalidEnvironmentVariables: MissionLimitEnvironmentVariable[] = [];
  const maxCost = resolvePositiveNumber(
    selectEnvironmentValue(env, 'MISSION_MAX_COST_USD', 'IMPULSE_MISSION_MAX_COST_USD'),
    DEFAULT_MISSION_LIMITS.maxCostUsd,
    invalidEnvironmentVariables
  );
  const tokenBudget = resolvePositiveInteger(
    selectEnvironmentValue(env, 'MISSION_TOKEN_BUDGET', 'IMPULSE_MISSION_TOKEN_BUDGET'),
    DEFAULT_MISSION_LIMITS.tokenBudget,
    invalidEnvironmentVariables
  );
  const maxToolCalls = resolvePositiveInteger(
    selectEnvironmentValue(env, 'MISSION_MAX_TOOL_CALLS', 'IMPULSE_MISSION_MAX_TOOL_CALLS'),
    DEFAULT_MISSION_LIMITS.maxToolCalls,
    invalidEnvironmentVariables
  );
  const warnThreshold = resolveWarnThreshold(
    selectEnvironmentValue(env, 'MISSION_WARN_THRESHOLD', 'IMPULSE_MISSION_WARN_THRESHOLD'),
    invalidEnvironmentVariables
  );

  return {
    maxCostUsd: maxCost.value,
    maxCostSource: maxCost.source,
    tokenBudget,
    maxToolCalls,
    warnThreshold,
    invalidEnvironmentVariables,
  };
}

/**
 * Resolve an optional money allocation where an EXPLICIT zero is valid: the
 * revision and prelude phases may be deliberately de-funded by the dispatcher
 * (COORD-012). Only absent or genuinely invalid values fall back.
 */
function nonNegativeFiniteOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function ceilingCents(value: number): number {
  const scaled = value * 100;
  const nearestInteger = Math.round(scaled);
  const floatingPointTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  return Math.abs(scaled - nearestInteger) <= floatingPointTolerance ? nearestInteger : Math.ceil(scaled);
}

/**
 * Resolve the complete paid envelope used by a research mission. The main
 * orchestrator cap is not the whole workflow: one revision, the skill prelude,
 * and bounded Gemini quality/reflection calls can also incur spend.
 */
export function resolveAgentMissionCostEnvelope(env: MissionLimitEnvironment): AgentMissionCostEnvelope {
  const orchestratorMaxCostUsd = resolveMissionLimits(env).maxCostUsd;
  const requestedRevision = nonNegativeFiniteOr(env.REVISION_MAX_COST_USD, orchestratorMaxCostUsd * 0.8);
  const revisionMaxCostUsd = Math.min(requestedRevision, orchestratorMaxCostUsd);
  const preludeMaxCostUsd = nonNegativeFiniteOr(
    env.PRELUDE_MAX_TOTAL_COST_USD,
    DEFAULT_AGENT_MISSION_COST_COMPONENTS.preludeMaxCostUsd
  );
  // The auxiliary calls have bounded inputs/outputs and a fixed call count.
  // Keep this reserve static so a configuration change cannot silently widen
  // the user-authorized envelope.
  const auxiliaryMaxCostUsd = DEFAULT_AGENT_MISSION_COST_COMPONENTS.auxiliaryMaxCostUsd;
  // Convert each independent cap to cents before summing. This stays
  // conservative for genuine sub-cent values while avoiding a phantom extra
  // cent from binary noise (for example, 23 + 18.4 previously became 45.41).
  const totalMaxCostUsd =
    [orchestratorMaxCostUsd, revisionMaxCostUsd, preludeMaxCostUsd, auxiliaryMaxCostUsd].reduce(
      (totalCents, component) => totalCents + ceilingCents(component),
      0
    ) / 100;

  return {
    orchestratorMaxCostUsd,
    revisionMaxCostUsd,
    preludeMaxCostUsd,
    auxiliaryMaxCostUsd,
    totalMaxCostUsd,
  };
}

/**
 * The complete per-mission execution envelope a dispatch surface freezes at
 * user confirmation (COORD-012). Extends the paid cost components with the
 * tool-call cap, wall-clock timeout, and the model identity the user
 * authorized. Persisted on the mission document and consumed verbatim by the
 * worker for every paid phase — worker-startup environment can never replace
 * it.
 */
export interface AgentMissionExecutionEnvelope extends AgentMissionCostEnvelope {
  maxToolCalls: number;
  timeoutMinutes: number;
  requestedModel?: string;
  authorizedFallbackModel?: string;
}

function normalizeModelId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function resolveTimeoutMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MISSION_TIMEOUT_MINUTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_MISSION_TIMEOUT_MINUTES;
  return Math.min(value, MAX_MISSION_TIMEOUT_MINUTES);
}

/**
 * Resolve the complete execution envelope a dispatch surface authorizes: the
 * paid cost components plus the tool-call cap, the wall-clock timeout
 * (clamped to the 120-minute platform ceiling), and the optional model
 * identity/fallback the dispatcher explicitly authorized.
 *
 * The dispatcher MUST supply the target agent's profile budget/timeout when
 * it has them: the persisted envelope outranks the worker's profile
 * narrowing, so an envelope minted from bare environment defaults would
 * silently widen a profile's tool-call runaway guard (strategist caps at 20)
 * and shrink a profile's long wall clock (creator/strategist run 90 minutes)
 * to values the user never chose. Tool calls take the STRICTER of the
 * environment and the profile (matching
 * {@link resolveEffectiveAgentMissionLimits}); the timeout prefers the
 * profile's declared window over the environment default (matching the
 * worker's own pre-envelope behavior), capped at the platform ceiling.
 */
export function resolveAgentMissionExecutionEnvelope(
  env: MissionLimitEnvironment,
  opts?: {
    requestedModel?: string;
    authorizedFallbackModel?: string;
    profileMaxToolCalls?: unknown;
    profileTimeoutMinutes?: unknown;
  }
): AgentMissionExecutionEnvelope {
  const costEnvelope = resolveAgentMissionCostEnvelope(env);
  const requestedModel = normalizeModelId(opts?.requestedModel);
  const authorizedFallbackModel = normalizeModelId(opts?.authorizedFallbackModel);
  const environmentMaxToolCalls = resolveMissionLimits(env).maxToolCalls;
  const maxToolCalls = isPositiveSafeInteger(opts?.profileMaxToolCalls)
    ? Math.min(environmentMaxToolCalls, opts.profileMaxToolCalls)
    : environmentMaxToolCalls;
  const timeoutMinutes = isPositiveSafeInteger(opts?.profileTimeoutMinutes)
    ? Math.min(opts.profileTimeoutMinutes, MAX_MISSION_TIMEOUT_MINUTES)
    : resolveTimeoutMinutes(env.MISSION_TIMEOUT_MINUTES);
  return {
    ...costEnvelope,
    maxToolCalls,
    timeoutMinutes,
    ...(requestedModel ? { requestedModel } : {}),
    ...(authorizedFallbackModel ? { authorizedFallbackModel } : {}),
  };
}

type EnvelopeComparableField = keyof AgentMissionExecutionEnvelope;

const ENVELOPE_CENT_FIELDS: readonly EnvelopeComparableField[] = [
  'orchestratorMaxCostUsd',
  'revisionMaxCostUsd',
  'preludeMaxCostUsd',
  'auxiliaryMaxCostUsd',
  'totalMaxCostUsd',
];

const ENVELOPE_EXACT_FIELDS: readonly EnvelopeComparableField[] = ['maxToolCalls', 'timeoutMinutes'];

const ENVELOPE_MODEL_FIELDS: readonly EnvelopeComparableField[] = ['requestedModel', 'authorizedFallbackModel'];

/**
 * Compare a confirmed (user-authorized) execution envelope against the values
 * a worker is about to run with. Money is compared in ceilinged cents so IEEE
 * noise cannot fabricate a refusal; every genuinely differing field is named
 * so the refusal message identifies the exact divergence (COORD-012
 * requirement: refuse execution when effective values differ from the
 * confirmed envelope).
 */
export function describeMissionEnvelopeMismatch(
  confirmed: AgentMissionExecutionEnvelope,
  effective: AgentMissionExecutionEnvelope
): string[] {
  const mismatches: string[] = [];
  for (const field of ENVELOPE_CENT_FIELDS) {
    const confirmedValue = confirmed[field] as number;
    const effectiveValue = effective[field] as number;
    if (ceilingCents(confirmedValue) !== ceilingCents(effectiveValue)) {
      mismatches.push(`${field}: confirmed $${confirmedValue.toFixed(2)}, effective $${effectiveValue.toFixed(2)}`);
    }
  }
  for (const field of ENVELOPE_EXACT_FIELDS) {
    if (confirmed[field] !== effective[field]) {
      mismatches.push(`${field}: confirmed ${String(confirmed[field])}, effective ${String(effective[field])}`);
    }
  }
  for (const field of ENVELOPE_MODEL_FIELDS) {
    const confirmedValue = normalizeModelId(confirmed[field] as string | undefined);
    const effectiveValue = normalizeModelId(effective[field] as string | undefined);
    if (confirmedValue !== effectiveValue) {
      mismatches.push(`${field}: confirmed ${confirmedValue ?? 'none'}, effective ${effectiveValue ?? 'none'}`);
    }
  }
  return mismatches;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * Apply a validated active profile as a stricter per-agent ceiling. Invalid or
 * missing profile fields cannot weaken the already-secure global limits.
 */
export function resolveEffectiveAgentMissionLimits(
  globalLimits: Pick<ResolvedMissionLimits, 'tokenBudget' | 'maxToolCalls'>,
  profileBudget?: AgentProfileMissionBudget
): Pick<ResolvedMissionLimits, 'tokenBudget' | 'maxToolCalls'> {
  return {
    tokenBudget: isPositiveSafeInteger(profileBudget?.max_tokens)
      ? Math.min(globalLimits.tokenBudget, profileBudget.max_tokens)
      : globalLimits.tokenBudget,
    maxToolCalls: isPositiveSafeInteger(profileBudget?.max_tool_calls)
      ? Math.min(globalLimits.maxToolCalls, profileBudget.max_tool_calls)
      : globalLimits.maxToolCalls,
  };
}
