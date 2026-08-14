/**
 * @file lib/schemas/operation-receipt.ts
 * @description ARUN-022 — durable nested-provider operation-usage receipt.
 *
 * A receipt is one IMMUTABLE record of one provider response performed on
 * behalf of a parent operation (a chat turn, a mission phase, an Inngest
 * verification run, an embedding call, an external research query, …). It
 * exists so nested provider spend the outer AgentRun / Mission counters omit
 * can be reconstructed later — without re-running the provider and without
 * double counting. This module is FOUNDATION ONLY: it never instruments a
 * provider and never prices. Pricing/reconciliation is a separate layer.
 *
 * This file is the schema plus the PURE contracts on top of it:
 *   - `deriveOperationReceiptId` — a deterministic, injective, Firestore-safe,
 *     OWNER-SCOPED identity. It uses a bounded ASCII length-framed scheme (not
 *     unbounded URI-encoding), so max-length inputs stay under the 1500-byte
 *     document-id limit and malformed Unicode / reserved separators are
 *     rejected outright.
 *   - `parseOperationReceiptDoc` — verifies a stored document (schema + ISO
 *     timestamp + doc-id == embedded id == derived identity) before trusting it.
 *   - `aggregateOperationReceipts` — deterministic aggregate INPUTS over
 *     canonical, validated receipts: it dedupes exact duplicates, FAILS CLOSED
 *     on a conflicting duplicate, and never multiplies a counter by a rate.
 *
 * Privacy is enforced at BOTH the shape and the value level. Strict objects give
 * no field for prompts, tool arguments/results, or retrieved content to land in;
 * and the free-text-capable fields are format-constrained — lineage fields to
 * opaque-id formats, and operation/provider/model/version to bounded safe slugs
 * — so no human-readable prose, document text, header, or whitespace-bearing
 * secret can be stored. This is a strong reduction, not a cryptographic
 * guarantee: identifier fields are OPAQUE PRINCIPAL/REFERENCE ids supplied by
 * callers (they intentionally may carry an internal id such as a user or
 * workspace principal), so callers must still pass references, never content.
 * Fees and costs are exact integer micro-units — never floats — so summation is
 * order-independent.
 *
 * The server-only Firestore writer/reader lives in
 * `@/lib/operation-receipt-repository`. Nothing here touches Firestore.
 *
 * @author Radarist Team
 * @created 2026-07-22
 */

import { z } from 'zod';
import { providerCacheSemantics } from '@/lib/ai/rate-card';

// ==========================================================================
// BOUNDS
// ==========================================================================

export const MAX_OWNER_LENGTH = 128;
export const MAX_CORRELATION_ID_LENGTH = 200;
export const MAX_OPERATION_LENGTH = 120;
const MAX_PROVIDER_LENGTH = 48;
const MAX_MODEL_LENGTH = 200;
const MAX_RATECARD_VERSION_LENGTH = 60;
const MAX_ENTITY_TYPE_LENGTH = 60;
const MAX_ID_REF_LENGTH = 200;
/**
 * Retry attempt / response ordinal are small nonnegative indices. Exported so
 * the id helper and the schema enforce the SAME ceiling — an index the schema
 * rejects must never derive an id.
 */
export const MAX_INDEX = 1_000_000;
/** Token/query/image counters — a hard ceiling well under Number.MAX_SAFE_INTEGER. */
const MAX_COUNTER = 1_000_000_000_000; // 1e12
/** Fee / cost micro-units (1e-6 currency unit) — hard ceiling under MAX_SAFE_INTEGER. */
const MAX_MICROS = 1_000_000_000_000_000; // 1e15
/**
 * Cache-storage micro-token-hours ceiling. Cache storage is a RATE OVER TIME
 * (tokens resident × hours) and is inherently fractional, so it is stored in
 * integer MICRO-token-hours (1e-6 token-hour) — never a float — so the receipt
 * keeps the module's exact-integer, safe-summable invariant. The pricing bridge
 * divides by 1e6 to feed the rate-card kernel's fractional `cacheStorageTokenHours`.
 */
const MAX_MICRO_TOKEN_HOURS = 1_000_000_000_000_000; // 1e15 (== 1e9 token-hours)

// ==========================================================================
// VALUE FORMATS (value-level privacy boundary)
// ==========================================================================

/** Opaque id: alnum plus `:._-`. No spaces, quotes, slashes, `~`, or control chars. */
const OPAQUE_ID_RE = /^[A-Za-z0-9:_.-]+$/;
/** Registry-style lowercase slug for operations/providers. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Effective-model id (mixed case, colon-tolerant for namespaced ids). */
// Provider namespaces such as OpenRouter's `anthropic/claude-*` are literal
// provenance, not paths. Keep the alphabet content-safe while preserving `/`.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
/** Rate-card version tag (e.g. `2026-07-22`). */
const RATECARD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Entity-type slug (e.g. `companies`). */
const ENTITY_TYPE_RE = /^[a-z][a-z0-9_-]*$/;
/** ISO-4217 currency code. */
const CURRENCY_RE = /^[A-Z]{3}$/;

const opaqueId = (max: number) => z.string().min(1).max(max).regex(OPAQUE_ID_RE);
const currencyCode = z.string().regex(CURRENCY_RE);

/** A nonnegative safe integer with an explicit maximum (rejects NaN/Infinity/floats/unsafe). */
const boundedInt = (max: number) => z.number().int().nonnegative().max(max);
const counter = boundedInt(MAX_COUNTER);
const microUnits = boundedInt(MAX_MICROS);
const boundedIndex = boundedInt(MAX_INDEX);
/** Cache-storage in integer micro-token-hours (1e-6 token-hour); safe-summable. */
const microTokenHours = boundedInt(MAX_MICRO_TOKEN_HOURS);

// ==========================================================================
// CORRELATION — parentType discriminated union with per-type lineage
// ==========================================================================

export const operationParentTypeSchema = z.enum([
  'agent-run',
  'mission',
  'job-run',
  'sweep',
  'chat-turn',
  'verification',
  'mcp',
]);
export type OperationParentType = z.infer<typeof operationParentTypeSchema>;

/**
 * OWNER PRINCIPAL — the opaque accounting owner this receipt's spend belongs to
 * and is scoped by. It is a principal reference (e.g. `user:<uid>`,
 * `workspace:<id>`, or a system principal such as `user:system`), matching the
 * observability-principal model used elsewhere. It is the read/write scope for
 * every reader; it is NOT a display name and carries no free text or PII beyond
 * an opaque principal identifier.
 */
const owner = opaqueId(MAX_OWNER_LENGTH);
const correlationId = opaqueId(MAX_CORRELATION_ID_LENGTH);
const idRef = opaqueId(MAX_ID_REF_LENGTH);

const verificationCorrelation = z
  .object({
    parentType: z.literal('verification'),
    owner,
    correlationId,
    inngestRunId: idRef,
    verificationResultId: idRef,
    entityId: idRef.optional(),
    entityType: z.string().min(1).max(MAX_ENTITY_TYPE_LENGTH).regex(ENTITY_TYPE_RE).optional(),
    relationId: idRef.optional(),
  })
  .strict();

const missionCorrelation = z
  .object({
    parentType: z.literal('mission'),
    owner,
    correlationId,
    missionId: idRef,
    agentRunId: idRef.optional(),
  })
  .strict();

const agentRunCorrelation = z
  .object({
    parentType: z.literal('agent-run'),
    owner,
    correlationId,
    agentRunId: idRef,
    missionId: idRef.optional(),
  })
  .strict();

const chatTurnCorrelation = z
  .object({
    parentType: z.literal('chat-turn'),
    owner,
    correlationId,
    agentRunId: idRef,
  })
  .strict();

const sweepCorrelation = z
  .object({
    parentType: z.literal('sweep'),
    owner,
    correlationId,
    sweepId: idRef,
  })
  .strict();

const jobRunCorrelation = z
  .object({
    parentType: z.literal('job-run'),
    owner,
    correlationId,
    inngestRunId: idRef,
  })
  .strict();

/**
 * A STANDALONE external MCP tool call (an external assistant invoking a tool via
 * `/api/mcp/[server]` with no bound mission). Its nested provider spend has no
 * parent mission headline to fold into, so it is its own `standalone` scope. The
 * owner is resolved server-side from the authenticated API key — never from the
 * caller's body. `apiKeyId` optionally records which key drove the call.
 */
const mcpCorrelation = z
  .object({
    parentType: z.literal('mcp'),
    owner,
    correlationId,
    apiKeyId: idRef.optional(),
  })
  .strict();

/**
 * Correlation is discriminated on `parentType`; each member requires the
 * appropriate parent reference. A verification receipt additionally must carry
 * Inngest-run + VerificationResult lineage and reference EXACTLY ONE entity
 * (id + type together) or relation target.
 */
export const operationReceiptCorrelationSchema = z
  .discriminatedUnion('parentType', [
    verificationCorrelation,
    missionCorrelation,
    agentRunCorrelation,
    chatTurnCorrelation,
    sweepCorrelation,
    jobRunCorrelation,
    mcpCorrelation,
  ])
  .superRefine((value, ctx) => {
    if (value.parentType !== 'verification') return;
    const hasEntityId = value.entityId != null;
    const hasEntityType = value.entityType != null;
    if (hasEntityId !== hasEntityType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'entityId and entityType must be provided together' });
    }
    const entityTarget = hasEntityId && hasEntityType;
    const targetCount = (entityTarget ? 1 : 0) + (value.relationId != null ? 1 : 0);
    if (targetCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a verification receipt must reference exactly one entity or relation target',
      });
    }
  });
export type OperationReceiptCorrelation = z.infer<typeof operationReceiptCorrelationSchema>;

// ==========================================================================
// RAW COUNTERS
// ==========================================================================

/**
 * Raw provider-reported usage counters, stored verbatim. Every field is
 * optional (a keyless search reports only `queryCount`); an absent counter
 * aggregates as zero. SDK mapping:
 *   promptTokens ← non-cached input · outputTokens ← output/completion
 *   thinkingTokens ← reasoning/thoughts · cacheReadTokens ← cache-read input
 *   queryCount ← grounding/search calls · imageCount ← generated images.
 *
 * Cache WRITES are provider-honest and DISTINCT (an earlier single
 * `cacheWriteTokens` collapsed prices that differ 1.6× between windows):
 *   - `cacheWrite5mTokens` ← 5-minute (default) cache-creation input;
 *   - `cacheWrite1hTokens` ← 1-hour cache-creation input;
 *   - `cacheStorageMicroTokenHours` ← Google context-cache STORAGE (tokens
 *     resident × hours), a rate over time — stored in integer MICRO-token-hours
 *     so the receipt keeps its exact-integer, safe-summable invariant; the
 *     pricing bridge divides by 1e6 to feed the rate-card kernel's fractional
 *     `cacheStorageTokenHours`. (`promptTokens`/`thinkingTokens` are the
 *     provider-raw names; the bridge maps them onto the kernel's
 *     `inputTokens`/`thoughtsTokens`.)
 */
export const operationReceiptCountersSchema = z
  .object({
    promptTokens: counter.optional(),
    outputTokens: counter.optional(),
    thinkingTokens: counter.optional(),
    cacheReadTokens: counter.optional(),
    cacheWrite5mTokens: counter.optional(),
    cacheWrite1hTokens: counter.optional(),
    cacheStorageMicroTokenHours: microTokenHours.optional(),
    queryCount: counter.optional(),
    imageCount: counter.optional(),
    /**
     * LEGACY (schema v1) ONLY. The pre-split ambiguous cache-creation counter.
     * A current (v2) write MUST NOT use it — the version refinement forbids it —
     * but a stored v1 document is read verbatim so it stays parseable. It is
     * treated as AMBIGUOUS on read (never silently attributed to the 5m or 1h
     * tier) and its presence forces pricing unavailable.
     */
    cacheWriteTokens: counter.optional(),
  })
  .strict();
export type OperationReceiptCounters = z.infer<typeof operationReceiptCountersSchema>;

/** Every counter — all integers, summed with checked safe-integer addition. */
const COUNTER_FIELDS = [
  'promptTokens',
  'outputTokens',
  'thinkingTokens',
  'cacheReadTokens',
  'cacheWrite5mTokens',
  'cacheWrite1hTokens',
  'cacheStorageMicroTokenHours',
  'queryCount',
  'imageCount',
] as const;

// ==========================================================================
// ACCOUNTING SCOPE — the anti-double-count classification
// ==========================================================================

/**
 * How this receipt's spend relates to its parent's headline total, so an
 * aggregator never counts the same money/tokens twice. DISTINCT from
 * `cost.covers` (which is token-only vs tokens-and-fees COVERAGE of one amount):
 *   - `included-in-parent`  — the parent's own headline already counts this
 *     spend (e.g. a chat main-model response inside the AgentRun total, a build
 *     Claude-Code turn inside the session `total_cost_usd`). Pure ATTRIBUTION:
 *     an aggregate must add ZERO for it.
 *   - `additional-to-parent` — spend the parent headline does NOT already count
 *     (a nested image/research/embedding/grounding call). An aggregate adds it
 *     exactly ONCE on top of the parent headline.
 *   - `standalone` — its own headline; there is no parent total to fold into
 *     (a background Defense verification, a system-principal operation). Counts
 *     once, in the standalone/system scope.
 *   - `unknown-incomplete` — the relationship could not be determined, so a
 *     complete total is NOT provable. Never silently summed as additional.
 */
export const operationAccountingScopeSchema = z.enum([
  'included-in-parent',
  'additional-to-parent',
  'standalone',
  'unknown-incomplete',
]);
export type OperationAccountingScope = z.infer<typeof operationAccountingScopeSchema>;

/**
 * Provider fee (grounding/search/query/image surcharge) state for this
 * operation, kept as an explicit TRI-STATE so a reader can never read a missing
 * fee as $0:
 *   - `none` — no provider fee applies. `externalFees` must be ABSENT.
 *   - `known` — a fee applies and its amount is recorded. `externalFees` must be
 *     PRESENT (an explicit currency + amount(s)).
 *   - `applicable-but-unknown` — a fee applies but the provider did not report a
 *     usable amount (e.g. a grounded search inside a free-tier window whose
 *     per-request charge is indeterminate). `externalFees` must be ABSENT — the
 *     amount is genuinely unknown and must NEVER be fabricated as 0. A receipt
 *     in this state cannot be priced `tokens-and-fees`; its cost fails closed.
 */
export const operationFeeStateSchema = z.enum(['none', 'known', 'applicable-but-unknown']);
export type OperationFeeState = z.infer<typeof operationFeeStateSchema>;

// ==========================================================================
// EXTERNAL FEES (raw provider surcharges, kept separate from cost)
// ==========================================================================

/**
 * Provider-reported external fees for this operation (grounding/search/query
 * surcharges, per-image charges) that are NOT derivable from token counters.
 * Raw observed amounts the provider stated — not a price we computed — in exact
 * integer micro-units so summation never drifts. `currency` is REQUIRED and
 * explicit: a missing provider currency must never be fabricated as a default,
 * so unlike currencies can never silently combine. Kept separate from the
 * derived `cost` fact.
 */
export const operationReceiptExternalFeesSchema = z
  .object({
    currency: currencyCode,
    groundingFeeMicros: microUnits.optional(),
    queryFeeMicros: microUnits.optional(),
    imageFeeMicros: microUnits.optional(),
  })
  .strict();
export type OperationReceiptExternalFees = z.infer<typeof operationReceiptExternalFeesSchema>;

const FEE_FIELDS = ['groundingFeeMicros', 'queryFeeMicros', 'imageFeeMicros'] as const;

// ==========================================================================
// COST — discriminated immutable cost fact
// ==========================================================================

export const operationCostUnavailableReasonSchema = z.enum([
  'unknown-pricing',
  'missing-usage',
  'provider-unreported',
  'accounting-incomplete',
]);
export type OperationCostUnavailableReason = z.infer<typeof operationCostUnavailableReasonSchema>;

/**
 * EXPLICIT COST SCOPE — what a priced `amountMicros` already includes, so a
 * reader never double-counts the derived cost against the raw `externalFees`:
 *   - `tokens` — covers model token usage ONLY; any `externalFees` are additive.
 *   - `tokens-and-fees` — already includes this receipt's external provider fees;
 *     they must NOT be added again.
 * Required on any priced cost; absent when there is no amount (deferred/unavailable).
 */
export const operationCostCoverageSchema = z.enum(['tokens', 'tokens-and-fees']);
export type OperationCostCoverage = z.infer<typeof operationCostCoverageSchema>;

/**
 * The priced per-component breakdown, in exact integer micro-units, that a
 * canonical estimate carries so a reader can see WHERE the amount came from
 * (and recompute it). Every field optional — a component absent from the tier
 * or with zero quantity simply omits its line. Kept in micro-units so the sum
 * is order-independent and never a lossy float.
 */
const priceBreakdownSchema = z
  .object({
    inputMicros: microUnits.optional(),
    outputMicros: microUnits.optional(),
    cacheReadMicros: microUnits.optional(),
    cacheWrite5mMicros: microUnits.optional(),
    cacheWrite1hMicros: microUnits.optional(),
    cacheStorageMicros: microUnits.optional(),
    feeMicros: microUnits.optional(),
  })
  .strict();
export type OperationPriceBreakdown = z.infer<typeof priceBreakdownSchema>;

/** A per-1M applied rate — provenance metadata (fractional, never summed). */
const perMillionRate = z.number().finite().nonnegative();

/**
 * The per-1M rates actually applied from the selected tier, recorded as pricing
 * PROVENANCE so a reader can reconstruct the amount. These are fractional
 * dollars-per-1M metadata (not summed integer money), so they are plain finite
 * numbers rather than micro-units.
 */
const appliedRatesSchema = z
  .object({
    inputPerMillion: perMillionRate.optional(),
    outputPerMillion: perMillionRate.optional(),
    cacheReadPerMillion: perMillionRate.optional(),
    cacheWrite5mPerMillion: perMillionRate.optional(),
    cacheWrite1hPerMillion: perMillionRate.optional(),
    cacheStoragePerMillionTokenHours: perMillionRate.optional(),
  })
  .strict();
export type OperationAppliedRates = z.infer<typeof appliedRatesSchema>;

const actualCost = z
  .object({
    state: z.literal('actual'),
    amountMicros: microUnits,
    currency: currencyCode,
    covers: operationCostCoverageSchema,
    evidenceRef: idRef,
  })
  .strict();

const estimatedCost = z
  .object({
    state: z.literal('estimated'),
    rateCardVersion: z.string().min(1).max(MAX_RATECARD_VERSION_LENGTH).regex(RATECARD_RE),
    amountMicros: microUnits.optional(),
    currency: currencyCode.optional(),
    covers: operationCostCoverageSchema.optional(),
    /** The card model id that actually priced this (after alias resolution). */
    resolvedModel: z.string().min(1).max(MAX_MODEL_LENGTH).regex(MODEL_RE).optional(),
    /** The selected tier's upper context bound; `null` = the unbounded tier. */
    tierMaxContextTokens: z.union([boundedInt(MAX_COUNTER), z.null()]).optional(),
    /** The per-1M rates applied from that tier (provenance). */
    appliedRates: appliedRatesSchema.optional(),
    /** Per-component priced breakdown (micro-units). */
    breakdown: priceBreakdownSchema.optional(),
    deferred: z.literal(true).optional(),
  })
  .strict();

const unavailableCost = z
  .object({
    state: z.literal('unavailable'),
    reason: operationCostUnavailableReasonSchema,
  })
  .strict();

/**
 * The immutable cost fact:
 *   - `actual` — reconciled: amount + currency + explicit `covers` scope + an
 *     evidence reference.
 *   - `estimated` — a required rate-card version PLUS either a priced
 *     (amountMicros + currency + `covers`) value or an explicit `deferred: true`.
 *   - `unavailable` — a bounded reason enum.
 * Never a single dollar figure summed across states.
 */
export const operationCostSchema = z
  .discriminatedUnion('state', [actualCost, estimatedCost, unavailableCost])
  .superRefine((value, ctx) => {
    if (value.state !== 'estimated') return;
    const hasAmount = value.amountMicros != null;
    const hasCurrency = value.currency != null;
    const hasCovers = value.covers != null;
    const hasPricingProvenance =
      value.resolvedModel != null ||
      value.tierMaxContextTokens !== undefined ||
      value.appliedRates != null ||
      value.breakdown != null;
    if (value.deferred === true) {
      if (hasAmount || hasCurrency || hasCovers || hasPricingProvenance) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'a deferred estimate cannot also carry an amount, coverage, or pricing provenance',
        });
      }
      return;
    }
    if (!hasAmount || !hasCurrency || !hasCovers) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an estimate must be deferred or carry amountMicros, currency, and covers',
      });
    }
    // NOTE: the COMPLETE-provenance requirement (resolvedModel/tier/appliedRates/
    // breakdown) is a v2-ONLY rule enforced at the receipt level
    // (refineV2EstimateProvenance) — NOT here — because the actual v1 schema
    // accepted a priced estimate WITHOUT that provenance, and a legacy v1 document
    // carrying such a cost must remain READABLE (as a legacy/incomplete fact), not
    // be reinterpreted or rejected.
    // Headline/breakdown consistency: when a per-component breakdown is present,
    // the headline `amountMicros` MUST equal the exact sum of its rounded
    // components, so a reader recomputing the total can never disagree with it.
    if (value.breakdown && hasAmount) {
      const b = value.breakdown;
      const componentSum =
        (b.inputMicros ?? 0) +
        (b.outputMicros ?? 0) +
        (b.cacheReadMicros ?? 0) +
        (b.cacheWrite5mMicros ?? 0) +
        (b.cacheWrite1hMicros ?? 0) +
        (b.cacheStorageMicros ?? 0) +
        (b.feeMicros ?? 0);
      if (componentSum !== value.amountMicros) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `amountMicros (${value.amountMicros}) must equal the sum of its breakdown components (${componentSum})`,
          path: ['amountMicros'],
        });
      }
    }
  });
export type OperationCost = z.infer<typeof operationCostSchema>;

// ==========================================================================
// CREATE / FULL RECEIPT
// ==========================================================================

/**
 * PROVENANCE of the recorded effective `model` — was the served model the one
 * the provider actually reported, a fallback to the requested id because the
 * provider reported none, or unreported (no model at all, e.g. a keyless API)?
 * A requested id recorded as if the provider confirmed it is a silent lie about
 * which model was billed (see `@/lib/ai/effective-model`).
 */
export const operationModelProvenanceSchema = z.enum(['provider-reported', 'requested-fallback', 'unreported']);
export type OperationModelProvenance = z.infer<typeof operationModelProvenanceSchema>;

/**
 * USAGE COMPLETENESS — is the recorded counter set the provider's complete
 * accounting for this response, a known-partial subset, or entirely unreported?
 * Many providers omit per-response cache/thinking tiers, so a total built from
 * these receipts must be able to say honestly whether it is complete.
 */
export const operationUsageCompletenessSchema = z.enum(['complete', 'partial', 'unreported']);
export type OperationUsageCompleteness = z.infer<typeof operationUsageCompletenessSchema>;

/**
 * Base receipt facts. The identity is
 * `(correlation.owner, correlation.parentType, correlation.correlationId,
 *   operation, invocationId, attempt, responseOrdinal)`:
 *   - `operation` — the logical operation/tool that made the call.
 *   - `invocationId` — a STABLE per-invocation discriminator supplied by the
 *     caller (e.g. a call/span id). It distinguishes two separate calls of the
 *     SAME tool under one parent that would otherwise both be attempt 0 /
 *     ordinal 0. Without it, two distinct same-tool calls would derive one id
 *     and either conflict or silently dedupe — losing spend. `attempt` and
 *     `responseOrdinal` are scoped WITHIN a single invocation, not across calls.
 *   - `attempt` — 0-based retry attempt of THIS invocation.
 *   - `responseOrdinal` — 0-based provider response within the attempt.
 *   - `provider` — the effective provider that served the call.
 *   - `model` — the effective model served; `requestedModel` is what was asked
 *     for; `modelProvenance` records how `model` was obtained.
 *   - `usageCompleteness` — honest completeness of `counters`.
 *   - `occurredAt` — the IMMUTABLE provider-occurrence timestamp (when the
 *     response happened), captured at the chokepoint and distinct from the
 *     server-managed `recordedAt` (when it was persisted). It is an immutable
 *     FACT (part of the fingerprint), so it must survive capture, Inngest step
 *     memoization, flush, and replay UNCHANGED — a divergent occurredAt on the
 *     same identity is a conflict, not a silent overwrite. It is also the `asOf`
 *     a time-bounded (introductory) rate is priced against.
 *   - `accountingScope` — the anti-double-count classification (included /
 *     additional / standalone / unknown-incomplete); see the enum.
 */
const rawReceiptFactsShape = {
  correlation: operationReceiptCorrelationSchema,
  operation: z.string().min(1).max(MAX_OPERATION_LENGTH).regex(SLUG_RE),
  invocationId: opaqueId(MAX_ID_REF_LENGTH),
  attempt: boundedIndex,
  responseOrdinal: boundedIndex,
  provider: z.string().min(1).max(MAX_PROVIDER_LENGTH).regex(SLUG_RE),
  model: z.string().min(1).max(MAX_MODEL_LENGTH).regex(MODEL_RE).optional(),
  requestedModel: z.string().min(1).max(MAX_MODEL_LENGTH).regex(MODEL_RE).optional(),
  // REQUIRED so provenance is always explicit — never silently omitted.
  modelProvenance: operationModelProvenanceSchema,
  counters: operationReceiptCountersSchema,
  usageCompleteness: operationUsageCompletenessSchema,
  // REQUIRED immutable provider-occurrence time (≠ persistence `recordedAt`).
  occurredAt: z.string().datetime(),
  // REQUIRED anti-double-count classification.
  accountingScope: operationAccountingScopeSchema,
  // REQUIRED tri-state fee fact (none / known / applicable-but-unknown).
  feeState: operationFeeStateSchema,
  externalFees: operationReceiptExternalFeesSchema.optional(),
  // NOTE: `cost` is DELIBERATELY NOT a create-input field. The immutable cost is
  // DERIVED inside the persistence boundary from these raw provider facts by the
  // ONE canonical pricing kernel (`@/lib/operation-receipt-pricing`), so a caller
  // can never supply, forge, or override an amount / model / tier / rate /
  // breakdown / currency, and a provider ACTUAL never enters here (it is a
  // separate append-only settlement). It lives only on the STORED receipt below.
};

/**
 * Cross-field provenance rule shared by the create and stored schemas.
 * `modelProvenance` is always required; this constrains it against the model
 * fields so every combination is explicit and honest:
 *   - `provider-reported` — the provider reported the served model; `model`
 *     REQUIRED.
 *   - `requested-fallback` — the provider reported no model, so the effective
 *     `model` fell back to what was requested; `model` and `requestedModel`
 *     REQUIRED and must be equal.
 *   - `unreported` — no served model at all (e.g. a keyless API); `model` must
 *     be ABSENT. A `requestedModel` may still be recorded (what we asked for).
 * There is no combination where a `requestedModel` or a `model` is present with
 * provenance omitted — provenance is a required field.
 */
function refineModelProvenance(
  value: { model?: string; requestedModel?: string; modelProvenance: OperationModelProvenance },
  ctx: z.RefinementCtx
): void {
  const hasModel = value.model != null;
  const hasRequested = value.requestedModel != null;
  switch (value.modelProvenance) {
    case 'provider-reported':
      if (!hasModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'provider-reported provenance requires a model',
          path: ['model'],
        });
      }
      break;
    case 'requested-fallback':
      if (!hasModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'requested-fallback provenance requires a model',
          path: ['model'],
        });
      }
      if (!hasRequested) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'requested-fallback provenance requires requestedModel',
          path: ['requestedModel'],
        });
      }
      if (hasModel && hasRequested && value.model !== value.requestedModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'requested-fallback provenance requires model to equal requestedModel',
          path: ['model'],
        });
      }
      break;
    case 'unreported':
      if (hasModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'unreported provenance cannot carry a model',
          path: ['model'],
        });
      }
      break;
  }
}

/**
 * All cross-field receipt rules, shared by the create and stored schemas:
 * model provenance (above) PLUS — `usageCompleteness: 'unreported'` asserts the
 * provider reported no usage, so it may not carry nonzero counters; recording
 * real counts under `unreported` would understate a total that trusts the flag.
 */
function refineReceiptFacts(
  value: {
    model?: string;
    requestedModel?: string;
    modelProvenance: OperationModelProvenance;
    counters: OperationReceiptCounters;
    usageCompleteness: OperationUsageCompleteness;
    feeState?: OperationFeeState;
    externalFees?: OperationReceiptExternalFees;
  },
  ctx: z.RefinementCtx
): void {
  refineModelProvenance(value, ctx);
  if (value.usageCompleteness === 'unreported') {
    // Include the LEGACY ambiguous cacheWriteTokens: an unreported receipt cannot
    // carry ANY nonzero counter, current or legacy.
    const total =
      COUNTER_FIELDS.reduce((sum, field) => sum + (value.counters[field] ?? 0), 0) +
      (value.counters.cacheWriteTokens ?? 0);
    if (total > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "usageCompleteness 'unreported' cannot carry nonzero counters",
        path: ['counters'],
      });
    }
  }
  // Fee-state ↔ externalFees consistency (only when a fee state is present — a
  // legacy v1 receipt carries no `feeState` and its fees are read as-is): only
  // `known` carries an amount, so an `applicable-but-unknown` (or `none`) fee can
  // never be silently read as $0.
  if (value.feeState !== undefined) {
    const fees = value.externalFees;
    if (value.feeState === 'known') {
      // A `known` fee must carry at least one EXPLICIT amount field. An empty
      // object (currency only) is NOT "known zero" — the amount is unknown. An
      // explicit `0` in any field IS a valid known-zero.
      const hasExplicitAmount =
        fees != null &&
        (fees.groundingFeeMicros !== undefined ||
          fees.queryFeeMicros !== undefined ||
          fees.imageFeeMicros !== undefined);
      if (!hasExplicitAmount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "feeState 'known' requires externalFees with at least one explicit amount (an empty object is not known-zero)",
          path: ['externalFees'],
        });
      }
    } else if (fees != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `feeState '${value.feeState}' cannot carry an externalFees amount`,
        path: ['externalFees'],
      });
    }
  }
}

/** The current receipt schema version. Stored on every new write; absent on legacy v1 docs. */
export const OPERATION_RECEIPT_SCHEMA_VERSION = 2 as const;

/**
 * A v2 (current) estimated cost that is PRICED must carry COMPLETE canonical
 * provenance — resolved model, selected tier, applied rates, and a component
 * breakdown — so the amount is auditable and recomputable. This is enforced at
 * the receipt level (not on the shared cost schema) precisely so a LEGACY v1
 * priced estimate, which never had that provenance, stays readable.
 */
function refineV2EstimateProvenance(cost: OperationCost, ctx: z.RefinementCtx): void {
  if (cost.state !== 'estimated' || cost.deferred === true) return;
  if (cost.resolvedModel == null)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a v2 priced estimate requires resolvedModel',
      path: ['cost', 'resolvedModel'],
    });
  if (cost.tierMaxContextTokens === undefined)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a v2 priced estimate requires the selected tier',
      path: ['cost', 'tierMaxContextTokens'],
    });
  if (cost.appliedRates == null)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a v2 priced estimate requires appliedRates',
      path: ['cost', 'appliedRates'],
    });
  if (cost.breakdown == null)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a v2 priced estimate requires a component breakdown',
      path: ['cost', 'breakdown'],
    });
}

/**
 * A create input is ALWAYS the current (v2) shape: the legacy ambiguous
 * `cacheWriteTokens` counter must never be minted anew. A create input carries NO
 * cost at all — the canonical estimate is derived inside the persistence boundary
 * — so there is no caller cost to validate here.
 */
function refineCreateReceiptFacts(value: { counters: OperationReceiptCounters }, ctx: z.RefinementCtx): void {
  if (value.counters.cacheWriteTokens !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cacheWriteTokens is a legacy-only counter; a new write must use cacheWrite5mTokens/cacheWrite1hTokens',
      path: ['counters', 'cacheWriteTokens'],
    });
  }
}

/**
 * Version-appropriateness of a STORED document. Current (v2) documents carry
 * `schemaVersion: 2` and the required occurrence/scope/fee facts; a legacy (v1)
 * document has no `schemaVersion` and none of those facts. Enforcing the split
 * keeps a v2 doc from silently omitting a required fact and a v1 doc from
 * masquerading as v2.
 */
function refineStoredReceiptVersion(
  value: {
    schemaVersion?: number;
    occurredAt?: string;
    accountingScope?: OperationAccountingScope;
    feeState?: OperationFeeState;
    counters: OperationReceiptCounters;
    correlation: OperationReceiptCorrelation;
    cost: OperationCost;
  },
  ctx: z.RefinementCtx
): void {
  const c = value.counters;
  const hasNewCacheWrite =
    c.cacheWrite5mTokens !== undefined ||
    c.cacheWrite1hTokens !== undefined ||
    c.cacheStorageMicroTokenHours !== undefined;
  if (value.schemaVersion === OPERATION_RECEIPT_SCHEMA_VERSION) {
    if (value.occurredAt === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a v2 receipt requires occurredAt', path: ['occurredAt'] });
    if (value.accountingScope === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a v2 receipt requires accountingScope',
        path: ['accountingScope'],
      });
    if (value.feeState === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a v2 receipt requires feeState', path: ['feeState'] });
    if (c.cacheWriteTokens !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a v2 receipt must not carry the legacy cacheWriteTokens counter',
        path: ['counters', 'cacheWriteTokens'],
      });
    // A current (v2) receipt's cost is the DERIVED canonical estimate (or an
    // honest unavailable) — never a provider ACTUAL. Provider actuals are a
    // separate, append-only settlement (`@/lib/schemas/operation-settlement`), so
    // an `actual` cost on a v2 receipt is a category error and fails closed. A
    // legacy v1 doc may still carry an actual (read as an incomplete legacy fact).
    if (value.cost.state === 'actual')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a v2 receipt cannot carry an actual cost — provider actuals are recorded as settlements',
        path: ['cost', 'state'],
      });
    // A v2 priced estimate must carry complete canonical provenance.
    refineV2EstimateProvenance(value.cost, ctx);
  } else {
    // Legacy v1 (no schemaVersion) — it must not carry any fact v1 never had.
    if (value.occurredAt !== undefined || value.accountingScope !== undefined || value.feeState !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a legacy receipt (no schemaVersion) cannot carry occurredAt/accountingScope/feeState',
      });
    if (hasNewCacheWrite)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a legacy receipt cannot carry the split cache-write counters',
        path: ['counters'],
      });
    // The `mcp` correlation type was introduced with v2 — a v1 doc claiming it is
    // a version forgery.
    if (value.correlation.parentType === 'mcp')
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a legacy receipt cannot use the 'mcp' correlation (introduced in v2)",
        path: ['correlation', 'parentType'],
      });
    // v1 accepted a PRICED estimate (amountMicros + currency + covers) WITHOUT the
    // v2-only pricing PROVENANCE — such a legacy cost stays readable (as a
    // legacy/incomplete fact). Only the v2-only provenance FIELDS themselves
    // (resolvedModel/tier/appliedRates/breakdown) are a version forgery on a v1 doc.
    if (
      value.cost.state === 'estimated' &&
      (value.cost.resolvedModel != null ||
        value.cost.tierMaxContextTokens !== undefined ||
        value.cost.appliedRates != null ||
        value.cost.breakdown != null)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a legacy receipt cannot carry v2-only pricing provenance (resolvedModel/tier/appliedRates/breakdown)',
        path: ['cost'],
      });
  }
}

/**
 * Input to record one receipt: the RAW provider facts ONLY. It carries no `cost`
 * — the immutable cost is derived from these facts inside the persistence
 * boundary by the canonical pricing kernel, so a forged/actual/mismatched cost is
 * unrepresentable at the create boundary (a stray `cost` key is rejected by
 * `.strict()`).
 */
export const createOperationReceiptSchema = z
  .object(rawReceiptFactsShape)
  .strict()
  .superRefine(refineReceiptFacts)
  .superRefine(refineCreateReceiptFacts);
export type CreateOperationReceiptInput = z.infer<typeof createOperationReceiptSchema>;

/**
 * The receipt as STORED. It is version-tolerant so a legacy v1 document (written
 * before the occurrence/scope/fee facts existed) stays READABLE and aggregatable:
 *   - a current (v2) document carries `schemaVersion: 2` and the required
 *     `occurredAt`/`accountingScope`/`feeState`;
 *   - a legacy (v1) document has no `schemaVersion` and none of those facts, and
 *     may carry the pre-split ambiguous `cacheWriteTokens` counter.
 * `refineStoredReceiptVersion` enforces that split, so a v2 doc can't omit a
 * required fact and a v1 doc can't masquerade as v2. Consumers treat an absent
 * `occurredAt` as unknown (pricing fails closed), an absent `accountingScope` as
 * `unknown-incomplete`, and an absent `feeState` as `applicable-but-unknown`.
 */
export const operationReceiptSchema = z
  .object({
    ...rawReceiptFactsShape,
    // The immutable cost fact lives on the STORED receipt only (derived at write
    // time for a v2 receipt; read verbatim on a legacy v1 doc). It is version-
    // tolerant so a legacy priced/actual cost stays READABLE (as a legacy fact),
    // while a v2 priced estimate is held to complete provenance by
    // refineStoredReceiptVersion → refineV2EstimateProvenance.
    cost: operationCostSchema,
    // Version-tolerant overrides — required for v2, absent for legacy v1 (enforced
    // by refineStoredReceiptVersion below).
    occurredAt: z.string().datetime().optional(),
    accountingScope: operationAccountingScopeSchema.optional(),
    feeState: operationFeeStateSchema.optional(),
    id: z.string().min(1).max(1500),
    /** ISO-8601 timestamp the receipt was first recorded (immutable after create). */
    recordedAt: z.string().datetime(),
    /** Present (== 2) on every current write; ABSENT on a legacy v1 document. */
    schemaVersion: z.literal(OPERATION_RECEIPT_SCHEMA_VERSION).optional(),
  })
  .strict()
  .superRefine(refineReceiptFacts)
  .superRefine(refineStoredReceiptVersion);
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;

/**
 * Server-managed metadata that is NOT part of a receipt's immutable accounting
 * facts. `schemaVersion` is a storage-format marker, not an accounting fact, so
 * it is excluded from the fingerprint — a v2 re-record of a v1 identity still
 * conflicts on its genuinely different facts (occurredAt etc.), not on the marker.
 */
const METADATA_FIELDS = new Set(['id', 'recordedAt', 'schemaVersion']);

// ==========================================================================
// ERRORS
// ==========================================================================

/** A stored document failed schema/identity verification, or aggregation saw a conflict. */
export class OperationReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationReceiptError';
  }
}

/** A receipt set contained a non-canonical receipt or a conflicting duplicate. */
export class OperationReceiptAggregationError extends OperationReceiptError {
  constructor(message: string) {
    super(message);
    this.name = 'OperationReceiptAggregationError';
  }
}

/**
 * A legacy-vs-current (v1→v2) replay could not be normalized into a comparable
 * form because the provider's cache semantics are unknown AND the record carries
 * cached tokens — so it is impossible to tell whether the legacy prompt counter
 * was stored subset (Gemini) or disjoint (Anthropic). Rather than GUESS a
 * normalization (which could make two genuinely different responses fingerprint
 * equal and silently dedupe real spend), the comparison fails closed: the caller
 * (the repository's v1-over-v2 branch) maps this to a conflict, so the legacy
 * record is preserved and the ambiguous new observation is never silently merged.
 */
export class LegacyReplayAmbiguityError extends OperationReceiptError {
  public readonly provider: string;
  constructor(provider: string) {
    super(
      `legacy replay for provider '${provider}' cannot be normalized: unknown cache semantics with cached tokens present`
    );
    this.name = 'LegacyReplayAmbiguityError';
    this.provider = provider;
  }
}

// ==========================================================================
// DETERMINISTIC, OWNER-SCOPED IDENTITY
// ==========================================================================

export interface OperationReceiptIdentity {
  owner: string;
  parentType: OperationParentType;
  correlationId: string;
  operation: string;
  invocationId: string;
  attempt: number;
  responseOrdinal: number;
}

/** Extract the identity from a create input or a stored receipt. */
export function receiptIdentity(
  receipt: Pick<
    CreateOperationReceiptInput,
    'correlation' | 'operation' | 'invocationId' | 'attempt' | 'responseOrdinal'
  >
): OperationReceiptIdentity {
  return {
    owner: receipt.correlation.owner,
    parentType: receipt.correlation.parentType,
    correlationId: receipt.correlation.correlationId,
    operation: receipt.operation,
    invocationId: receipt.invocationId,
    attempt: receipt.attempt,
    responseOrdinal: receipt.responseOrdinal,
  };
}

/**
 * Guard an id component: printable ASCII only (rejects lone surrogates and
 * control chars), no `/` (Firestore-reserved), no `~` (our field separator),
 * and bounded length. Validated fields already satisfy this; the guard makes
 * the derivation robust when called on unvalidated input.
 */
function assertIdComponent(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new RangeError('operation-receipt identity component is empty or too long');
  }
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code > 0x7e || code === 0x2f /* / */ || code === 0x7e /* ~ */) {
      throw new RangeError('operation-receipt identity component is not id-safe');
    }
  }
}

/**
 * Guard a numeric index component: a nonnegative safe integer no greater than
 * `MAX_INDEX`. The ceiling is IDENTICAL to the schema's `boundedIndex`, so an
 * index the schema would reject can never be stringified into an id.
 */
function assertIdIndex(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_INDEX) {
    throw new RangeError(`operation-receipt identity index must be an integer in [0, ${MAX_INDEX}]`);
  }
}

/**
 * Deterministic, injective, owner-scoped, Firestore-safe document id.
 *
 * Length-framed (`<len>~<value>` per component, in fixed order) so that
 * component boundaries can never shift — `(cid='ab', op='c')` and
 * `(cid='a', op='bc')` yield different ids, and a different owner, parentType,
 * or invocation always yields a different id. Two distinct same-tool calls under
 * one parent differ by `invocationId`, so they can never collapse to one id.
 * Components are bounded ASCII, so `.length` equals byte length and the id stays
 * well under Firestore's 1500-byte limit. Numeric indices are validated so a
 * NaN/Infinity/negative/fractional value can never be stringified into an id.
 */
export function deriveOperationReceiptId(identity: OperationReceiptIdentity): string {
  assertIdIndex(identity.attempt);
  assertIdIndex(identity.responseOrdinal);
  const parts = [
    identity.owner,
    identity.parentType,
    identity.correlationId,
    identity.operation,
    identity.invocationId,
    String(identity.attempt),
    String(identity.responseOrdinal),
  ];
  for (const part of parts) assertIdComponent(part);
  return `oprcpt~v1~${parts.map((part) => `${part.length}~${part}`).join('~')}`;
}

// ==========================================================================
// STORED-DOCUMENT VERIFICATION
// ==========================================================================

/**
 * Validate and verify a stored document before trusting it: it must pass the
 * schema (including an ISO `recordedAt`), and its Firestore document id must
 * equal both the embedded `id` and the id DERIVED from its own identity. This
 * fails closed on a tampered, mislocated, or legacy-shaped document.
 */
export function parseOperationReceiptDoc(docId: string, data: unknown): OperationReceipt {
  const receipt = operationReceiptSchema.parse(data);
  if (receipt.id !== docId) {
    throw new OperationReceiptError(`operation receipt doc id ${docId} does not match embedded id ${receipt.id}`);
  }
  const derived = deriveOperationReceiptId(receiptIdentity(receipt));
  if (derived !== receipt.id) {
    throw new OperationReceiptError(`operation receipt ${receipt.id} does not match its derived identity ${derived}`);
  }
  return receipt;
}

// ==========================================================================
// CANONICAL FACT FINGERPRINT (shared by repository conflict check + aggregation)
// ==========================================================================

/** Stable, key-sorted, undefined-filtered serialization for equality of immutable facts. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Fingerprint of a receipt's immutable facts (everything except server metadata). */
export function receiptFactsFingerprint(receipt: Record<string, unknown>): string {
  const facts: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(receipt)) {
    if (!METADATA_FIELDS.has(key)) facts[key] = val;
  }
  return stableStringify(facts);
}

/**
 * Fields excluded from the v1-COMPARABLE fingerprint:
 *   - server metadata (`id`/`recordedAt`/`schemaVersion`);
 *   - the genuinely v2-only facts (`occurredAt`/`accountingScope`/`feeState`),
 *     whose mere absence in a legacy doc must never read as a conflict;
 *   - `cost` — the DERIVED interpretation. A v2 estimate is a deterministic
 *     function of the raw provider facts (counters/model/provider/fee), so it is
 *     redundant with them for the same response; a legacy doc's cost is a legacy
 *     interpretation of that same response, and upgrading it to the canonical
 *     estimate is an explicit append-only SETTLEMENT, not a replay conflict. A
 *     genuinely different response still conflicts on its raw facts below.
 */
const V1_INCOMPARABLE_FIELDS = new Set([...METADATA_FIELDS, 'occurredAt', 'accountingScope', 'feeState', 'cost']);

/**
 * Normalize counters to a version-neutral comparable shape, honoring the
 * PROVIDER's cache semantics (the canonical `providerCacheSemantics` contract —
 * never an assumption that every provider is subset):
 *   - `subset` (Gemini/Google): the raw v2 prompt counter INCLUDES the cached
 *     subset, but v1 stored `promptTokenCount − cachedContentTokenCount`
 *     (non-cached). Collapse both to `totalPromptTokens = non-cached + cached`, so
 *     a v1 and a v2 record of ONE response agree while a genuinely different
 *     prompt/cache split still differs.
 *   - `disjoint` (Anthropic): the prompt counter EXCLUDES cache in BOTH versions,
 *     so cache is NEVER added during normalization — `totalPromptTokens = prompt`
 *     for v1 and v2 alike. (Adding cache here was the defect: it made an Anthropic
 *     v1 700/300 and v2 700/300 falsely conflict.)
 *   - `unknown` provider: with NO cached tokens the prompt is unambiguous
 *     (`totalPromptTokens = prompt`); with cached tokens present we cannot know
 *     which shape v1 used, so we FAIL CLOSED via {@link LegacyReplayAmbiguityError}
 *     rather than guess — an ambiguous legacy record must never silently replay.
 *   - CACHE-WRITE SPELLING: the split 5m/1h tiers and the legacy ambiguous
 *     `cacheWriteTokens` collapse to one `cacheWriteTotal` (spelling only).
 */
function normalizeCountersForV1Comparison(
  counters: OperationReceiptCounters,
  schemaVersion: number | undefined,
  provider: string
): Record<string, number> {
  const promptStored = counters.promptTokens ?? 0;
  const cacheRead = counters.cacheReadTokens ?? 0;
  const semantics = providerCacheSemantics(provider);
  let totalPromptTokens: number;
  if (semantics === 'subset') {
    // v2 prompt already includes cached; v1 stored non-cached, so add cached back.
    totalPromptTokens = schemaVersion === OPERATION_RECEIPT_SCHEMA_VERSION ? promptStored : promptStored + cacheRead;
  } else if (semantics === 'disjoint') {
    // Prompt excludes cache in both versions — never fold cache into the prompt.
    totalPromptTokens = promptStored;
  } else if (cacheRead > 0) {
    // Unknown provider WITH cached tokens: normalization is undecidable — fail closed.
    throw new LegacyReplayAmbiguityError(provider);
  } else {
    // Unknown provider with no cache: the prompt is the same in either version.
    totalPromptTokens = promptStored;
  }
  return {
    totalPromptTokens,
    outputTokens: counters.outputTokens ?? 0,
    thinkingTokens: counters.thinkingTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTotal:
      (counters.cacheWriteTokens ?? 0) + (counters.cacheWrite5mTokens ?? 0) + (counters.cacheWrite1hTokens ?? 0),
    cacheStorageMicroTokenHours: counters.cacheStorageMicroTokenHours ?? 0,
    queryCount: counters.queryCount ?? 0,
    imageCount: counters.imageCount ?? 0,
  };
}

/**
 * Fingerprint of the version-neutral RAW provider facts (provider, model, usage,
 * counters normalized per the provider's cache semantics, fees, correlation,
 * operation identity), EXCLUDING the v2-only occurrence/scope/fee facts and the
 * derived cost. Used to decide whether a current (v2) re-record over a stored
 * legacy document is a genuine idempotent replay (the same provider response — all
 * raw facts match) or a real conflict (a different provider / model / prompt-cache
 * / usage / fees).
 *
 * @throws {LegacyReplayAmbiguityError} when the provider's cache semantics are
 *   unknown and cached tokens are present, so a comparable form cannot be derived.
 */
export function legacyComparableFingerprint(receipt: Record<string, unknown>): string {
  const schemaVersion = receipt.schemaVersion as number | undefined;
  const provider = typeof receipt.provider === 'string' ? receipt.provider : '';
  const facts: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(receipt)) {
    if (V1_INCOMPARABLE_FIELDS.has(key)) continue;
    facts[key] =
      key === 'counters'
        ? normalizeCountersForV1Comparison(val as OperationReceiptCounters, schemaVersion, provider)
        : val;
  }
  return stableStringify(facts);
}

/**
 * Checked nonnegative addition. Individual receipts are bounded, but a large
 * set of valid receipts could still sum past `Number.MAX_SAFE_INTEGER`, where
 * `+` silently loses precision. An accounting total must refuse that rather
 * than report a lossy figure.
 */
function addSafe(a: number, b: number): number {
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) {
    throw new OperationReceiptAggregationError('operation-receipt total exceeds the safe-integer range');
  }
  return sum;
}

// ==========================================================================
// DETERMINISTIC AGGREGATION (validated, deduped, fail-closed, no pricing)
// ==========================================================================

export interface OperationReceiptCounterTotals {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheStorageMicroTokenHours: number;
  queryCount: number;
  imageCount: number;
  /**
   * LEGACY (v1) ambiguous cache-creation tokens, kept in a SEPARATE bucket — a
   * legacy `cacheWriteTokens` is never silently folded into the 5m or 1h tier
   * (their prices differ 1.6×), so a consumer sees it is unattributed.
   */
  legacyCacheWriteTokens: number;
}

function emptyCounterTotals(): OperationReceiptCounterTotals {
  return {
    promptTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheStorageMicroTokenHours: 0,
    queryCount: 0,
    imageCount: 0,
    legacyCacheWriteTokens: 0,
  };
}

/** Add one receipt's counters into a running total with checked safe-integer addition. */
function addCountersInto(total: OperationReceiptCounterTotals, counters: OperationReceiptCounters): void {
  for (const field of COUNTER_FIELDS) total[field] = addSafe(total[field], counters[field] ?? 0);
  total.legacyCacheWriteTokens = addSafe(total.legacyCacheWriteTokens, counters.cacheWriteTokens ?? 0);
}

export interface OperationReceiptFeeTotals {
  groundingFeeMicros: number;
  queryFeeMicros: number;
  imageFeeMicros: number;
}

export interface OperationReceiptAggregate {
  receiptCount: number;
  operations: string[];
  providers: string[];
  models: string[];
  rateCardVersions: string[];
  counters: OperationReceiptCounterTotals;
  costStateCounts: Record<OperationCost['state'], number>;
  /**
   * Receipt counts per usage-completeness state. `usageComplete` is true ONLY
   * when every counted receipt is `complete`, so a consumer can never present a
   * partial/unreported total as if it were the whole spend.
   */
  usageCompletenessCounts: Record<OperationUsageCompleteness, number>;
  usageComplete: boolean;
  externalFeesMicros: Record<string, OperationReceiptFeeTotals>;
  /** Receipt counts per accounting-scope classification. */
  scopeCounts: Record<OperationAccountingScope, number>;
  /** Receipt counts per fee-state (none / known / applicable-but-unknown). */
  feeStateCounts: Record<OperationFeeState, number>;
  /**
   * Counter total across ONLY `additional-to-parent` receipts — the spend to add
   * ON TOP of a parent's own headline (which already counts `included-in-parent`).
   * `included-in-parent` receipts are pure attribution and contribute ZERO here.
   */
  additionalCounters: OperationReceiptCounterTotals;
  /**
   * Counter total across ONLY `standalone` receipts — operations that have no
   * parent headline to fold into (background verification, system-principal work).
   */
  standaloneCounters: OperationReceiptCounterTotals;
  /**
   * True only when no receipt is `unknown-incomplete`. When false, a
   * not-double-counted total built from `additional`/`standalone` is NOT provably
   * complete and a consumer must surface the unknown component rather than imply
   * a whole figure.
   */
  scopeComplete: boolean;
  /**
   * Count of LEGACY (schema v1) receipts in the set — documents recorded before
   * the occurrence/scope/fee facts existed. A non-zero count means the aggregate
   * folds in receipts whose scope/fee were unknown (counted as
   * `unknown-incomplete` / `applicable-but-unknown`), so `scopeComplete` is false
   * and a consumer must surface that the total is not provably complete.
   */
  legacyReceiptCount: number;
}

/**
 * Deterministic aggregate INPUTS for a set of receipts.
 *
 * Every receipt is re-verified as a stored document (schema + ISO timestamp +
 * embedded id == derived identity) before it is trusted — typing alone is not
 * enough, since inputs may be raw Firestore data cast to the type. Duplicates
 * are keyed by identity: an exact duplicate (idempotent replay) is counted
 * once; a CONFLICTING duplicate (same identity, different immutable facts)
 * throws — it never silently wins. Output is a pure function of the input set
 * (order-independent). Raw counters and integer micro-unit fees are summed with
 * checked safe-integer addition; no counter is ever multiplied by a rate, so
 * there is no priced total here.
 */
export function aggregateOperationReceipts(receipts: readonly OperationReceipt[]): OperationReceiptAggregate {
  const seen = new Map<string, string>();
  const unique: OperationReceipt[] = [];
  for (const candidate of receipts) {
    let receipt: OperationReceipt;
    try {
      receipt = parseOperationReceiptDoc(candidate.id, candidate);
    } catch (error) {
      throw new OperationReceiptAggregationError(
        `operation receipt failed stored-document verification: ${error instanceof Error ? error.message : 'invalid document'}`
      );
    }
    const fingerprint = receiptFactsFingerprint(receipt as unknown as Record<string, unknown>);
    const priorFingerprint = seen.get(receipt.id);
    if (priorFingerprint !== undefined) {
      if (priorFingerprint !== fingerprint) {
        throw new OperationReceiptAggregationError(`conflicting duplicate operation receipt for ${receipt.id}`);
      }
      continue;
    }
    seen.set(receipt.id, fingerprint);
    unique.push(receipt);
  }

  const counters = emptyCounterTotals();
  const additionalCounters = emptyCounterTotals();
  const standaloneCounters = emptyCounterTotals();
  const costStateCounts: Record<OperationCost['state'], number> = { actual: 0, estimated: 0, unavailable: 0 };
  const usageCompletenessCounts: Record<OperationUsageCompleteness, number> = {
    complete: 0,
    partial: 0,
    unreported: 0,
  };
  const scopeCounts: Record<OperationAccountingScope, number> = {
    'included-in-parent': 0,
    'additional-to-parent': 0,
    standalone: 0,
    'unknown-incomplete': 0,
  };
  const feeStateCounts: Record<OperationFeeState, number> = {
    none: 0,
    known: 0,
    'applicable-but-unknown': 0,
  };
  // Accumulate fees in a Map keyed by currency; the output object is rebuilt in
  // sorted-currency order below so the key order is input-order-independent.
  const feesByCurrency = new Map<string, OperationReceiptFeeTotals>();
  const operations = new Set<string>();
  const providers = new Set<string>();
  const models = new Set<string>();
  const rateCardVersions = new Set<string>();
  let legacyReceiptCount = 0;

  for (const receipt of unique) {
    if (receipt.schemaVersion === undefined) legacyReceiptCount += 1;
    addCountersInto(counters, receipt.counters);
    // A legacy (v1) receipt carries no scope/fee facts: fold it in as the most
    // conservative classification — `unknown-incomplete` scope (so the total is
    // NOT provably complete) and `applicable-but-unknown` fee (never $0).
    const scope = receipt.accountingScope ?? 'unknown-incomplete';
    const feeState = receipt.feeState ?? 'applicable-but-unknown';
    scopeCounts[scope] += 1;
    feeStateCounts[feeState] += 1;
    if (scope === 'additional-to-parent') addCountersInto(additionalCounters, receipt.counters);
    else if (scope === 'standalone') addCountersInto(standaloneCounters, receipt.counters);
    costStateCounts[receipt.cost.state] += 1;
    usageCompletenessCounts[receipt.usageCompleteness] += 1;
    operations.add(receipt.operation);
    providers.add(receipt.provider);
    if (receipt.model) models.add(receipt.model);
    if (receipt.cost.state === 'estimated') rateCardVersions.add(receipt.cost.rateCardVersion);

    if (receipt.externalFees) {
      let bucket = feesByCurrency.get(receipt.externalFees.currency);
      if (!bucket) {
        bucket = { groundingFeeMicros: 0, queryFeeMicros: 0, imageFeeMicros: 0 };
        feesByCurrency.set(receipt.externalFees.currency, bucket);
      }
      for (const field of FEE_FIELDS) bucket[field] = addSafe(bucket[field], receipt.externalFees[field] ?? 0);
    }
  }

  // Deterministic key order regardless of input order.
  const externalFeesMicros: Record<string, OperationReceiptFeeTotals> = {};
  for (const currency of [...feesByCurrency.keys()].sort()) {
    externalFeesMicros[currency] = feesByCurrency.get(currency)!;
  }

  return {
    receiptCount: unique.length,
    operations: [...operations].sort(),
    providers: [...providers].sort(),
    models: [...models].sort(),
    rateCardVersions: [...rateCardVersions].sort(),
    counters,
    costStateCounts,
    usageCompletenessCounts,
    usageComplete:
      unique.length > 0 && usageCompletenessCounts.partial === 0 && usageCompletenessCounts.unreported === 0,
    externalFeesMicros,
    scopeCounts,
    feeStateCounts,
    additionalCounters,
    standaloneCounters,
    scopeComplete: scopeCounts['unknown-incomplete'] === 0,
    legacyReceiptCount,
  };
}
