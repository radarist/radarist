import { resolveAnthropicRate } from './provider-rate-card.generated.js';

export const SDK_MODEL_ALIASES: readonly string[] = ['sonnet', 'opus', 'haiku', 'inherit'];
const ALIASES = new Set(SDK_MODEL_ALIASES);

export type ModelRejectionReason = 'empty' | 'unsupported-model';
export type ModelSelection =
  { ok: true; model: string; kind: 'alias' | 'exact' } | { ok: false; reason: ModelRejectionReason };

export function resolveSdkModel(requested: string | undefined, opts?: { asOf?: string }): ModelSelection {
  const model = (requested ?? '').trim();
  if (!model) return { ok: false, reason: 'empty' };
  if (ALIASES.has(model)) return { ok: true, model, kind: 'alias' };
  const asOf = opts?.asOf ?? new Date().toISOString().slice(0, 10);
  return resolveAnthropicRate(model, { asOf })
    ? { ok: true, model, kind: 'exact' }
    : { ok: false, reason: 'unsupported-model' };
}

export interface ModelSelectionViolation {
  scope: string;
  requested: string;
  reason: ModelRejectionReason;
}

export const UNSUPPORTED_MODEL_FAILURE_KIND = 'unsupported-model' as const;

export class UnsupportedModelError extends Error {
  readonly failureKind = UNSUPPORTED_MODEL_FAILURE_KIND;
  constructor(readonly violations: readonly ModelSelectionViolation[]) {
    super(
      `${UNSUPPORTED_MODEL_FAILURE_KIND}: refusing to start; ` +
        violations.map((v) => `${v.scope}="${v.requested}":${v.reason}`).join(', ')
    );
    this.name = 'UnsupportedModelError';
  }
}

export const MODEL_FALLBACK_AUTHORIZATION_ENV = 'IMPULSE_AGENT_ALLOW_MODEL_FALLBACK';
export type ModelSubstitutionAuthority = 'configured-fallback' | 'explicit-pair' | 'explicit-served';

export interface ModelSubstitution {
  requested: string;
  served: string;
  servedModels: readonly string[];
  authorized: boolean;
  authorizedBy?: ModelSubstitutionAuthority;
}

function isSameModelIdentity(a: string, b: string): boolean {
  if (a === b) return true;
  const snapshotOf = (base: string, candidate: string): boolean =>
    candidate.startsWith(`${base}-`) && /^\d{6,}$/.test(candidate.slice(base.length + 1));
  return snapshotOf(a, b) || snapshotOf(b, a);
}

export interface ModelAuthorizationEntry {
  requested?: string;
  served: string;
}

export function parseModelAuthorizationEntries(raw: string): {
  valid: ModelAuthorizationEntry[];
  invalid: Array<{ index: number }>;
} {
  const valid: ModelAuthorizationEntry[] = [];
  const invalid: Array<{ index: number }> = [];
  for (const [index, entry] of raw
    .split(',')
    .map((value) => value.trim())
    .entries()) {
    if (!entry) continue;
    const parts = entry.split('>').map((value) => value.trim());
    if (parts.length > 2 || parts.some((part) => !part)) {
      invalid.push({ index });
    } else if (parts.length === 2) {
      valid.push({ requested: parts[0]!, served: parts[1]! });
    } else {
      valid.push({ served: parts[0]! });
    }
  }
  return { valid, invalid };
}

/**
 * COORD-012 — resolve which fallback model (if any) an orchestrator run may
 * hand the SDK for transparent retry. The persisted mission envelope is the
 * authority when present:
 *
 * - a non-blank `authorizedFallbackModel` string → exactly that model;
 * - an explicit `null` (or blank string) → the mission authorized NO
 *   fallback, so the SDK retry is disabled outright — the worker environment
 *   must not smuggle one back in;
 * - `undefined` (legacy caller with no envelope authority) → the historical
 *   environment-then-default chain.
 */
export function resolveFallbackModelSelection(input: {
  authorizedFallbackModel?: string | null;
  envFallback?: string;
  defaultFallback: string;
}): string | undefined {
  if (input.authorizedFallbackModel !== undefined) {
    const authorized = (input.authorizedFallbackModel ?? '').trim();
    return authorized ? authorized : undefined;
  }
  const fromEnv = (input.envFallback ?? '').trim();
  return fromEnv ? fromEnv : input.defaultFallback;
}

/**
 * COORD-019 — a fallback model that IS the main model is not a fallback.
 *
 * The pinned SDK refuses such a pair outright ("Fallback model cannot be the
 * same as the main model") while building the CLI argv, before it spawns the
 * child — so the run dies with no provider call, no spend, and no output. The
 * revision turn is the exposed case: it carries no envelope authority, so its
 * main model falls through to the role profile while its fallback comes from
 * `IMPULSE_AGENT_FALLBACK_MODEL`. Two unrelated sources, one id, dead run.
 *
 * Resolving the pair DROPS the redundant fallback rather than substituting some
 * other model. That disables transparent retry for the dispatch, which is
 * exactly the state COORD-012 already authorizes for an explicit `null`
 * fallback — so the result is strictly narrower than the colliding pair it
 * replaces and authorizes no new model and no new spend.
 *
 * Deliberately broader than the SDK's exact `===`: a dated snapshot of the same
 * model is the same model, and retrying it buys nothing.
 */
export function resolveTransparentRetryFallback(
  mainModel: string,
  fallbackModel: string | undefined
): string | undefined {
  if (fallbackModel === undefined) return undefined;
  return isSameModelIdentity(mainModel, fallbackModel) ? undefined : fallbackModel;
}

export function resolveModelSubstitutionAuthority(input: {
  requested: string;
  served: string;
  configuredFallback?: string;
  env?: NodeJS.ProcessEnv;
}): ModelSubstitutionAuthority | undefined {
  const configuredFallback = (input.configuredFallback ?? '').trim();
  if (configuredFallback && isSameModelIdentity(input.served, configuredFallback)) return 'configured-fallback';
  const raw = (input.env ?? process.env)[MODEL_FALLBACK_AUTHORIZATION_ENV]?.trim();
  if (!raw) return undefined;
  for (const entry of parseModelAuthorizationEntries(raw).valid) {
    if (!entry.requested && isSameModelIdentity(input.served, entry.served)) return 'explicit-served';
    if (
      entry.requested &&
      isSameModelIdentity(input.requested, entry.requested) &&
      isSameModelIdentity(input.served, entry.served)
    ) {
      return 'explicit-pair';
    }
  }
  return undefined;
}

export function detectModelSubstitution(input: {
  requested: string | undefined;
  primaryServed: string | undefined;
  servedModels?: readonly string[];
  configuredFallback?: string;
  env?: NodeJS.ProcessEnv;
}): ModelSubstitution | undefined {
  const requested = (input.requested ?? '').trim();
  const primaryServed = (input.primaryServed ?? '').trim();
  if (!requested || !primaryServed || ALIASES.has(requested) || isSameModelIdentity(requested, primaryServed)) {
    return undefined;
  }
  const servedModels = [...new Set([primaryServed, ...(input.servedModels ?? []).map((value) => value.trim())])]
    .filter(Boolean)
    .sort();
  const authorizedBy = resolveModelSubstitutionAuthority({
    requested,
    served: primaryServed,
    configuredFallback: input.configuredFallback,
    env: input.env,
  });
  return {
    requested,
    served: primaryServed,
    servedModels,
    authorized: authorizedBy !== undefined,
    ...(authorizedBy ? { authorizedBy } : {}),
  };
}
