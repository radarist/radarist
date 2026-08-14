/**
 * @file rate-card.ts
 * @description TEST-021 — the canonical, versioned provider rate-card kernel.
 *
 * This is the ONE pure root pricing kernel. It reads the single authored source
 * of truth (`config/provider-rate-card.json`) and is consumed by:
 *   - the root runtime / chat accounting, via compatibility re-exports in
 *     `src/lib/ai/reliability.ts` (`MODEL_PRICING`, `GEMINI_RATE_CARD`,
 *     `ANTHROPIC_PRICING`, `rateCardPriceUsd`, `resolveGeminiPricing`);
 *   - model benchmark consumers;
 *   - the isolated agent package, through the deterministic generated adapter
 *     `agent/src/provider-rate-card.generated.ts` (built by
 *     `scripts/generate-provider-rate-card.ts`, drift-checked in tests).
 *
 * SAFE FOUNDATION: `priceUsage` is not yet wired into production receipts
 * (ARUN-022 owns settled provider spend). Every figure it returns is an
 * ESTIMATE, never an `actual` invoice.
 *
 * Contract highlights:
 *   - Rich per-tier representation: input, cache-read, Anthropic 5-minute and
 *     1-hour cache-write, Google cache storage (per token-hour), output, plus a
 *     per-operation query/grounding fee kept separate from token counters.
 *   - Context tiering: tiers ordered ascending by `maxContextTokens` (null last).
 *   - Provider-specific normalization: Gemini `candidates` EXCLUDE thoughts and
 *     the kernel adds them; Anthropic `output_tokens` already includes thinking
 *     and the kernel never adds it again.
 *   - Cache arithmetic: cached input is a SUBSET of input for Gemini (never
 *     double-counted) and a DISJOINT counter for Anthropic; cache-creation
 *     tokens count toward the derived context size.
 *   - Fail closed: an unknown provider/model/tier, an invalid counter/context/
 *     fee, an explicit context below the provider-derived prompt size, an
 *     applicable-but-unknown fee, or a rate absent for a non-zero counter yields
 *     an `unavailable` settlement with `costUsd: null` — never a guessed number.
 *   - Runtime validation (`assertValidRateCard`) enforces version/source
 *     validity, non-negative finite rates, sorted non-overlapping tiers with a
 *     single final unbounded tier, and supported currency/unit at module load.
 */

import rawCard from '../../../config/provider-rate-card.json';

export type ProviderId = 'google' | 'anthropic';
type GeminiRateCardModel = keyof (typeof rawCard)['providers']['google']['models'];

/**
 * Settlement authority for a cost figure:
 *   - `actual`      — a provider-BILLED amount backed by receipt evidence. This
 *                     kernel never emits it: a rate-card computation is derived
 *                     token math, not a settled invoice. `actual` is reserved
 *                     for the provider-operation receipt work in ARUN-022.
 *   - `estimated`   — derived from token counters against the card. Every
 *                     successful `priceUsage` result is `estimated`.
 *   - `unavailable` — cannot be priced from the card; fail closed (`costUsd`
 *                     is null).
 */
export type Settlement = 'actual' | 'estimated' | 'unavailable';

/**
 * Explicit fee state for a provider query / grounding / tool fee, kept separate
 * from token pricing. Modeling this as a discriminated union (rather than an
 * optional number) forces a caller to distinguish "no fee applies" from "a fee
 * applies but its amount is unknown" — the latter fails closed, per the
 * TEST-021 requirement that an unknown provider/tool fee is unavailable.
 */
export type FeeSpec = { kind: 'none' } | { kind: 'known'; amountUsd: number } | { kind: 'unknown' };

export interface RateTier {
  /** Inclusive upper bound of effective prompt tokens for this tier; null = unbounded. */
  maxContextTokens: number | null;
  /** Per-1M standard (non-cached) input tokens. Absent = unknown. */
  input?: number;
  /** Per-1M generated output tokens. Absent = unknown. */
  output?: number;
  /** Per-1M prompt-cache reads. Absent = unknown. */
  cacheRead?: number;
  /** Anthropic per-1M five-minute cache creation. Absent = unknown/NA. */
  cacheWrite5m?: number;
  /** Anthropic per-1M one-hour cache creation. Absent = unknown/NA. */
  cacheWrite1h?: number;
  /** Google context-cache storage, USD per 1M token-HOURS. Absent = unknown/NA. */
  cacheStoragePerHour?: number;
  /** ISO date these rates are valid through (e.g. an introductory-price window). */
  validUntil?: string;
}

export interface ModelCard {
  tiers: RateTier[];
}

export interface ProviderCard {
  displayName: string;
  source: string;
  sourceDate: string;
  /** True when the provider's input counter already includes cache-read tokens
   * (a subset), so cache-read must not be added a second time. */
  cachedInputIsSubsetOfInput: boolean;
  /** True when the provider's output counter already includes thinking tokens,
   * so thoughts must NOT be added to output again (Anthropic). */
  outputIncludesThinking: boolean;
  /** Server-tool / grounding fee schedule shapes (informational; the kernel
   * receives an explicit per-operation fee, keeping raw counters separate). */
  fees?: Record<string, unknown>;
  models: Record<string, ModelCard>;
}

export interface ProviderRateCard {
  version: string;
  effectiveDate: string;
  currency: string;
  unit: string;
  providers: Record<ProviderId, ProviderCard>;
}

/**
 * Raw provider usage counters. `inputTokens` and `outputTokens` are REQUIRED
 * and must be present, non-negative safe integers — a missing required counter
 * fails closed (never a confident zero). Optional counters may be omitted (→ 0).
 * `cacheStorageTokenHours` is a non-negative finite number (token-hours may be
 * fractional). Any invalid value fails closed rather than being coerced. `fee`
 * is REQUIRED: a fee-bearing operation cannot be priced without stating its fee.
 */
export interface UsageCounters {
  inputTokens: number;
  /**
   * Provider-native generated output tokens. For Anthropic this ALREADY
   * includes thinking (thoughts must be omitted/0). For Gemini this EXCLUDES
   * thoughts, which the kernel adds from `thoughtsTokens`.
   */
  outputTokens: number;
  /** Gemini thinking tokens (added to output). Must be 0/absent for Anthropic. */
  thoughtsTokens?: number;
  cacheReadTokens?: number;
  /** Anthropic five-minute cache-creation tokens. */
  cacheWrite5mTokens?: number;
  /** Anthropic one-hour cache-creation tokens. */
  cacheWrite1hTokens?: number;
  /** Google cache storage in token-hours (tokens × hours resident). */
  cacheStorageTokenHours?: number;
  /** Effective prompt size for tier selection. Must be >= the provider-derived
   * prompt size; defaults to it when omitted. */
  contextTokens?: number;
  /** Provider query/grounding/tool fee state. `{ kind: 'unknown' }` fails closed. */
  fee: FeeSpec;
  /** ISO date the usage occurred (operation/receipt timestamp), for rate
   * freshness. REQUIRED when the selected tier carries a `validUntil` (an
   * introductory/time-bounded price) — omitting it there fails closed rather
   * than pinning to the card date; a tier past its `validUntil` also fails
   * closed. Timeless tiers (no `validUntil`) ignore it. */
  asOf?: string;
}

export interface NormalizedCounters {
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheStorageTokenHours: number;
}

export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
  cacheStorageUsd: number;
  feeUsd: number;
}

export interface PriceResult {
  settlement: Settlement;
  /** null whenever settlement is 'unavailable'. */
  costUsd: number | null;
  provider: ProviderId | string;
  requestedModel: string;
  /** The card model id that priced the request (after alias/prefix resolution). */
  resolvedModel: string | null;
  rateCardVersion: string;
  effectiveDate: string;
  /** The tier selected for the effective context size, when one applied. */
  tier: RateTier | null;
  /** Raw counters as supplied — preserved so downstream receipts keep provider truth. */
  counters: NormalizedCounters;
  breakdown: CostBreakdown | null;
  unavailableReason?: string;
}

export class RateCardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateCardValidationError';
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

const OPTIONAL_RATE_FIELDS: Array<keyof RateTier> = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite5m',
  'cacheWrite1h',
  'cacheStoragePerHour',
];

/**
 * Enforce the structural invariants the card must satisfy: valid version/source
 * dates, supported currency/unit, non-negative finite rates, and per-model
 * tiers that are strictly ascending, non-overlapping, and end in exactly one
 * unbounded tier. Throws `RateCardValidationError` on the first violation.
 */
export function assertValidRateCard(candidate: ProviderRateCard): void {
  if (!isValidIsoDate(candidate.version)) {
    throw new RateCardValidationError(`card version must be an ISO date, got "${candidate.version}"`);
  }
  if (!isValidIsoDate(candidate.effectiveDate)) {
    throw new RateCardValidationError(`card effectiveDate must be an ISO date, got "${candidate.effectiveDate}"`);
  }
  if (candidate.currency !== 'USD') {
    throw new RateCardValidationError(`unsupported currency "${candidate.currency}" (only USD)`);
  }
  if (candidate.unit !== 'per 1M tokens') {
    throw new RateCardValidationError(`unsupported unit "${candidate.unit}" (only "per 1M tokens")`);
  }

  for (const [providerId, provider] of Object.entries(candidate.providers)) {
    if (typeof provider.source !== 'string' || !provider.source.startsWith('https://')) {
      throw new RateCardValidationError(`${providerId}: source must be an https URL`);
    }
    if (!isValidIsoDate(provider.sourceDate)) {
      throw new RateCardValidationError(`${providerId}: sourceDate must be an ISO date`);
    }
    if (
      typeof provider.cachedInputIsSubsetOfInput !== 'boolean' ||
      typeof provider.outputIncludesThinking !== 'boolean'
    ) {
      throw new RateCardValidationError(`${providerId}: cache/thinking semantics flags must be booleans`);
    }
    const models = Object.entries(provider.models);
    if (models.length === 0) {
      throw new RateCardValidationError(`${providerId}: at least one model is required`);
    }
    for (const [modelId, model] of models) {
      assertValidTiers(providerId, modelId, model.tiers);
    }
  }
}

function assertValidTiers(providerId: string, modelId: string, tiers: RateTier[]): void {
  const where = `${providerId}/${modelId}`;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new RateCardValidationError(`${where}: at least one tier is required`);
  }
  let previousBound = 0;
  tiers.forEach((tier, index) => {
    const isLast = index === tiers.length - 1;
    for (const field of OPTIONAL_RATE_FIELDS) {
      if (tier[field] !== undefined && !isNonNegativeFinite(tier[field])) {
        throw new RateCardValidationError(
          `${where} tier[${index}]: ${String(field)} must be a non-negative finite number`
        );
      }
    }
    if (tier.validUntil !== undefined && !isValidIsoDate(tier.validUntil)) {
      throw new RateCardValidationError(`${where} tier[${index}]: validUntil must be an ISO date`);
    }
    if (isLast) {
      if (tier.maxContextTokens !== null) {
        throw new RateCardValidationError(`${where}: the final tier must be unbounded (maxContextTokens: null)`);
      }
    } else {
      if (!Number.isSafeInteger(tier.maxContextTokens) || (tier.maxContextTokens as number) <= previousBound) {
        throw new RateCardValidationError(
          `${where} tier[${index}]: maxContextTokens must be a positive integer strictly greater than the previous tier`
        );
      }
      previousBound = tier.maxContextTokens as number;
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const card: ProviderRateCard = deepFreeze(rawCard as unknown as ProviderRateCard);
assertValidRateCard(card);

export const RATE_CARD_VERSION: string = card.version;

/** The frozen canonical rate card. */
export function getProviderRateCard(): ProviderRateCard {
  return card;
}

/**
 * Canonical provider-slug → rate-card `ProviderId` aliases. A receipt's
 * `provider` is a free-form slug (e.g. `gemini`); the card is keyed by canonical
 * id (`google` / `anthropic`). This is the ONE place a slug is aliased, so the
 * pricing bridge and the receipt replay-normalizer agree on which provider a slug
 * denotes and can never drift into two mappings.
 */
const PROVIDER_SLUG_ALIASES: Readonly<Record<string, ProviderId>> = Object.freeze({
  gemini: 'google',
  google: 'google',
  anthropic: 'anthropic',
  // AI-029 — the chat path records first-party Anthropic responses under the
  // `claude` provider slug (the AgentRun `provider` label). Alias it to the
  // canonical card id so those receipts price against the Anthropic card.
  claude: 'anthropic',
});

/** Resolve a provider slug to a canonical rate-card provider id, or undefined. */
export function providerIdForSlug(slug: string): ProviderId | undefined {
  return PROVIDER_SLUG_ALIASES[slug];
}

/**
 * The provider's cache-input semantics — the canonical contract a caller MUST use
 * instead of assuming one shape for all providers:
 *   - `subset`   — the raw prompt counter INCLUDES the cached-read subset
 *     (Google/Gemini: `promptTokenCount` counts cached tokens);
 *   - `disjoint` — the prompt counter EXCLUDES cache; cache-read is a separate,
 *     additive count (Anthropic: `input_tokens` excludes cache);
 *   - `unknown`  — the slug is not on the card, so the semantics are unknowable.
 * Derived from the card's `cachedInputIsSubsetOfInput` flag — never hardcoded, so
 * it stays true to the one provider contract the kernel prices against.
 */
export type ProviderCacheSemantics = 'subset' | 'disjoint' | 'unknown';
export function providerCacheSemantics(slug: string): ProviderCacheSemantics {
  const id = providerIdForSlug(slug);
  if (!id) return 'unknown';
  return card.providers[id].cachedInputIsSubsetOfInput ? 'subset' : 'disjoint';
}

/** Required counters must be PRESENT; a missing one is a data gap, not a zero. */
const REQUIRED_TOKEN_FIELDS: Array<keyof NormalizedCounters> = ['inputTokens', 'outputTokens'];
/** Optional counters may be omitted (→ 0). */
const OPTIONAL_TOKEN_FIELDS: Array<keyof NormalizedCounters> = [
  'thoughtsTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
];

function isValidTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A required counter must be a present, non-negative safe integer. */
function readRequiredCounter(value: number | undefined): number | 'invalid' {
  if (value === undefined || typeof value !== 'number' || !isValidTokenCount(value)) return 'invalid';
  return value;
}

/** An optional counter is valid iff omitted (→0) or a non-negative safe integer. */
function readOptionalCounter(value: number | undefined): number | 'invalid' {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !isValidTokenCount(value)) return 'invalid';
  return value;
}

/** Token-hours may be fractional, so validate as a non-negative finite number. */
function readTokenHours(value: number | undefined): number | 'invalid' {
  if (value === undefined) return 0;
  return isNonNegativeFinite(value) ? value : 'invalid';
}

interface CounterValidation {
  counters: NormalizedCounters;
  invalidFields: string[];
}

function validateCounters(usage: UsageCounters): CounterValidation {
  const counters: NormalizedCounters = {
    inputTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheStorageTokenHours: 0,
  };
  const invalidFields: string[] = [];
  for (const field of REQUIRED_TOKEN_FIELDS) {
    const value = readRequiredCounter(usage[field]);
    if (value === 'invalid') invalidFields.push(field);
    else counters[field] = value;
  }
  for (const field of OPTIONAL_TOKEN_FIELDS) {
    const value = readOptionalCounter(usage[field]);
    if (value === 'invalid') invalidFields.push(field);
    else counters[field] = value;
  }
  const hours = readTokenHours(usage.cacheStorageTokenHours);
  if (hours === 'invalid') invalidFields.push('cacheStorageTokenHours');
  else counters.cacheStorageTokenHours = hours;
  return { counters, invalidFields };
}

function getProviderCard(provider: string): ProviderCard | undefined {
  return (card.providers as Record<string, ProviderCard>)[provider];
}

/**
 * Resolve a card model id for a provider. Exact match wins; otherwise the
 * longest card id that the requested model starts with (e.g. a dated alias
 * `claude-haiku-4-5-20251001` resolves to `claude-haiku-4-5`). Returns null
 * when nothing matches — the caller fails closed.
 */
export function resolveModelId(provider: string, model: string): string | null {
  const providerCard = getProviderCard(provider);
  if (!providerCard) return null;
  const requested = model.trim();
  if (providerCard.models[requested]) return requested;
  const prefixMatch = Object.keys(providerCard.models)
    .filter((id) => requested === id || requested.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];
  return prefixMatch ?? null;
}

/**
 * Select the tier whose `maxContextTokens` bound covers the effective context
 * size. Tiers are scanned in ascending order; null is treated as unbounded.
 */
export function resolveModelTier(provider: string, model: string, contextTokens: number): RateTier | null {
  const providerCard = getProviderCard(provider);
  if (!providerCard) return null;
  const modelId = resolveModelId(provider, model);
  if (!modelId) return null;
  for (const tier of providerCard.models[modelId].tiers) {
    if (tier.maxContextTokens === null || contextTokens <= tier.maxContextTokens) {
      return tier;
    }
  }
  return null;
}

function unavailable(
  provider: string,
  requestedModel: string,
  resolvedModel: string | null,
  tier: RateTier | null,
  counters: NormalizedCounters,
  reason: string
): PriceResult {
  return {
    settlement: 'unavailable',
    costUsd: null,
    provider,
    requestedModel,
    resolvedModel,
    rateCardVersion: card.version,
    effectiveDate: card.effectiveDate,
    tier,
    counters,
    breakdown: null,
    unavailableReason: reason,
  };
}

/**
 * Price a set of raw usage counters against the canonical card. The result is
 * always an ESTIMATE (never `actual`). See the module header and the
 * `unavailable` conditions for the fail-closed contract.
 */
export function priceUsage(provider: ProviderId, model: string, usage: UsageCounters): PriceResult {
  const { counters, invalidFields } = validateCounters(usage);

  const providerCard = getProviderCard(provider);
  if (!providerCard) {
    return unavailable(provider, model, null, null, counters, `unknown-provider:${provider}`);
  }
  if (invalidFields.length > 0) {
    return unavailable(provider, model, null, null, counters, `invalid-counter:${invalidFields.join(',')}`);
  }
  const modelId = resolveModelId(provider, model);
  if (!modelId) {
    return unavailable(provider, model, null, null, counters, `unknown-model:${model}`);
  }

  // Fee state is explicit and EXHAUSTIVE: unknown-but-applicable, invalid
  // amounts, and unrecognized kinds all fail closed (no fall-through to zero).
  const fee: FeeSpec | undefined = usage.fee;
  let feeUsd = 0;
  if (!fee || typeof fee.kind !== 'string') {
    return unavailable(provider, model, modelId, null, counters, 'fee-required');
  }
  if (fee.kind === 'none') {
    feeUsd = 0;
  } else if (fee.kind === 'unknown') {
    return unavailable(provider, model, modelId, null, counters, 'fee-unknown-required');
  } else if (fee.kind === 'known') {
    if (!isNonNegativeFinite(fee.amountUsd)) {
      return unavailable(provider, model, modelId, null, counters, 'invalid-fee');
    }
    feeUsd = fee.amountUsd;
  } else {
    return unavailable(provider, model, modelId, null, counters, `invalid-fee-kind:${String((fee as FeeSpec).kind)}`);
  }

  // Rate-freshness: validate an explicit as-of date up front (format only here;
  // whether it is REQUIRED depends on the selected tier, checked below).
  let providedAsOf: string | undefined;
  if (usage.asOf !== undefined) {
    if (!isValidIsoDate(usage.asOf)) {
      return unavailable(provider, model, modelId, null, counters, 'invalid-asof');
    }
    providedAsOf = usage.asOf;
  }

  const subset = providerCard.cachedInputIsSubsetOfInput;

  // Provider-specific thinking semantics: Anthropic output already includes
  // thinking, so a separate thoughts counter is ambiguous and fails closed.
  if (providerCard.outputIncludesThinking && counters.thoughtsTokens > 0) {
    return unavailable(provider, model, modelId, null, counters, 'thoughts-not-separable-for-provider');
  }

  // For subset providers cache-read is part of input; an inconsistent count
  // (cache-read > input) is a real data error, not something to Math.min-hide.
  if (subset && counters.cacheReadTokens > counters.inputTokens) {
    return unavailable(provider, model, modelId, null, counters, 'cache-read-exceeds-input');
  }

  // Provider-derived prompt size: input, plus disjoint cache-read, plus
  // cache-creation tokens (which are written from — and part of — the prompt).
  const derivedPromptTokens =
    counters.inputTokens +
    (subset ? 0 : counters.cacheReadTokens) +
    counters.cacheWrite5mTokens +
    counters.cacheWrite1hTokens;

  let contextTokens: number;
  if (usage.contextTokens !== undefined) {
    const validated = readOptionalCounter(usage.contextTokens);
    if (validated === 'invalid') {
      return unavailable(provider, model, modelId, null, counters, 'invalid-context');
    }
    if (validated < derivedPromptTokens) {
      return unavailable(provider, model, modelId, null, counters, 'context-below-prompt');
    }
    contextTokens = validated;
  } else {
    contextTokens = derivedPromptTokens;
  }

  const tier = resolveModelTier(provider, model, contextTokens);
  if (!tier) {
    return unavailable(provider, model, modelId, null, counters, `no-tier-for-context:${contextTokens}`);
  }

  // A tier with a validUntil is a time-bounded price (e.g. an introductory
  // rate). It must NOT default to the card date — after the window that would
  // silently keep the promo. Require an explicit as-of (the operation/receipt
  // timestamp) and fail closed if it is absent or past the window. A tier with
  // no validUntil is timeless and needs no as-of. (ISO dates compare lexically.)
  if (tier.validUntil !== undefined) {
    if (providedAsOf === undefined) {
      return unavailable(provider, model, modelId, tier, counters, `asof-required-for-dated-tier:${tier.validUntil}`);
    }
    if (providedAsOf > tier.validUntil) {
      return unavailable(provider, model, modelId, tier, counters, `tier-rate-expired:${tier.validUntil}`);
    }
  }

  // Cache arithmetic: subset providers carve the cached portion out of input so
  // it is never billed twice; disjoint providers bill input and cache-read
  // independently. Output includes thinking exactly once, per provider.
  const billableInputTokens = subset ? counters.inputTokens - counters.cacheReadTokens : counters.inputTokens;
  const billableOutputTokens = providerCard.outputIncludesThinking
    ? counters.outputTokens
    : counters.outputTokens + counters.thoughtsTokens;

  // Fail closed: any non-zero counter that needs an absent rate is unpriceable.
  const needs: Array<[number, keyof RateTier, string]> = [
    [billableInputTokens, 'input', 'input-rate-unknown'],
    [billableOutputTokens, 'output', 'output-rate-unknown'],
    [counters.cacheReadTokens, 'cacheRead', 'cache-read-rate-unknown'],
    [counters.cacheWrite5mTokens, 'cacheWrite5m', 'cache-write-5m-rate-unknown'],
    [counters.cacheWrite1hTokens, 'cacheWrite1h', 'cache-write-1h-rate-unknown'],
    [counters.cacheStorageTokenHours, 'cacheStoragePerHour', 'cache-storage-rate-unknown'],
  ];
  for (const [quantity, field, reason] of needs) {
    if (quantity > 0 && tier[field] === undefined) {
      return unavailable(provider, model, modelId, tier, counters, reason);
    }
  }

  const breakdown: CostBreakdown = {
    inputUsd: (billableInputTokens * (tier.input ?? 0)) / 1_000_000,
    outputUsd: (billableOutputTokens * (tier.output ?? 0)) / 1_000_000,
    cacheReadUsd: (counters.cacheReadTokens * (tier.cacheRead ?? 0)) / 1_000_000,
    cacheWrite5mUsd: (counters.cacheWrite5mTokens * (tier.cacheWrite5m ?? 0)) / 1_000_000,
    cacheWrite1hUsd: (counters.cacheWrite1hTokens * (tier.cacheWrite1h ?? 0)) / 1_000_000,
    cacheStorageUsd: (counters.cacheStorageTokenHours * (tier.cacheStoragePerHour ?? 0)) / 1_000_000,
    feeUsd,
  };

  const costUsd =
    breakdown.inputUsd +
    breakdown.outputUsd +
    breakdown.cacheReadUsd +
    breakdown.cacheWrite5mUsd +
    breakdown.cacheWrite1hUsd +
    breakdown.cacheStorageUsd +
    breakdown.feeUsd;

  return {
    settlement: 'estimated',
    costUsd,
    provider,
    requestedModel: model,
    resolvedModel: modelId,
    rateCardVersion: card.version,
    effectiveDate: card.effectiveDate,
    tier,
    counters,
    breakdown,
  };
}

// ============================================================================
// Compatibility derivations (TEST-021)
//
// The following exports preserve the historical public surface that predates
// this kernel. They are DERIVED from the one canonical card so the legacy
// tables can no longer drift from it. `src/lib/ai/reliability.ts` re-exports
// these unchanged, and every prior consumer keeps byte-identical behavior.
// ============================================================================

function firstPricedTier(provider: ProviderId, modelId: string): RateTier {
  const tiers = card.providers[provider].models[modelId].tiers;
  return tiers.find((t) => t.input !== undefined && t.output !== undefined) ?? tiers[0];
}

/** Gemini list pricing (input/output only), the shape the runtime has always
 * exported. Derived from the base (<=200k, or single) tier of each Google model. */
export const MODEL_PRICING = Object.freeze(
  Object.fromEntries(
    Object.keys(card.providers.google.models).map((modelId) => {
      const tier = firstPricedTier('google', modelId);
      return [modelId, { input: tier.input as number, output: tier.output as number }];
    })
  )
) as Readonly<Record<GeminiRateCardModel, { input: number; output: number }>>;

/**
 * AI-029 — the ONE Gemini pricing lookup. Returns `undefined` for a model the
 * card doesn't list. There is deliberately no fallback rate: an unlisted model
 * is "cost unavailable", not silently priced at some other model's rate.
 */
export function resolveGeminiPricing(model: string): { input: number; output: number } | undefined {
  return MODEL_PRICING[model as GeminiRateCardModel];
}

/**
 * The canonical, timestamped Gemini rate card. `rates` is the live
 * `MODEL_PRICING` object (same reference), so offline consumers that import it
 * cannot diverge from what the runtime bills.
 */
export const GEMINI_RATE_CARD = {
  asOf: card.providers.google.sourceDate,
  source: card.providers.google.source,
  currency: card.currency,
  unit: card.unit,
  rates: MODEL_PRICING,
} as const;

/**
 * Price a Gemini usage triple from the canonical card, HONORING context tiers:
 * the prompt size (`inputTokens`) selects the tier, so a >200k prompt on a
 * tiered model (2.5 Pro, 3.1 Pro) bills at the higher tier. Thinking tokens
 * bill as output (Gemini candidates exclude thoughts). Throws on a model the
 * card doesn't list, or a prompt size no tier covers — a benchmark that guesses
 * a rate publishes a number nobody can reconcile, so failing loudly is the point.
 */
export function rateCardPriceUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; thoughtsTokens?: number }
): number {
  if (!MODEL_PRICING[model as GeminiRateCardModel]) {
    throw new Error(
      `No rate-card entry for model "${model}" (card as of ${GEMINI_RATE_CARD.asOf}). ` +
        `Add it to config/provider-rate-card.json before pricing this model.`
    );
  }
  const tier = resolveModelTier('google', model, usage.inputTokens);
  if (!tier || tier.input === undefined || tier.output === undefined) {
    throw new Error(
      `No priced tier for model "${model}" at ${usage.inputTokens} prompt tokens ` +
        `(card as of ${GEMINI_RATE_CARD.asOf}).`
    );
  }
  const billedOutput = usage.outputTokens + (usage.thoughtsTokens ?? 0);
  return (usage.inputTokens * tier.input + billedOutput * tier.output) / 1_000_000;
}

export interface AnthropicPricing {
  /** Standard, non-cached input tokens per 1M tokens. */
  input: number;
  /** Generated output tokens per 1M tokens. */
  output: number;
  /** Prompt-cache hits and refreshes per 1M tokens. */
  cacheRead: number;
  /** Default five-minute prompt-cache writes per 1M tokens. */
  cacheCreation: number;
}

/**
 * Anthropic list pricing, the shape the runtime accounting has always used
 * (`cacheCreation` is the config's five-minute `cacheWrite5m`). Derived from the
 * base tier of each Anthropic model. Cache reads cost 0.1x input; five-minute
 * cache writes cost 1.25x input; current models serve full context at standard
 * pricing. Sonnet 5 reflects the introductory price in effect on the card date.
 */
export const ANTHROPIC_PRICING: Readonly<Record<string, Readonly<AnthropicPricing>>> = Object.freeze(
  Object.fromEntries(
    Object.keys(card.providers.anthropic.models).map((modelId) => {
      const tier = firstPricedTier('anthropic', modelId);
      return [
        modelId,
        Object.freeze({
          input: tier.input as number,
          output: tier.output as number,
          cacheRead: tier.cacheRead as number,
          cacheCreation: tier.cacheWrite5m as number,
        }),
      ];
    })
  )
);
