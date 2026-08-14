/**
 * @file lib/ai/chat-accounting.ts
 * @description AI-029 — canonical per-response accounting for the AI chat sink.
 *
 * The chat route (`src/app/api/ai/chat/route.ts`) previously aggregated every
 * provider response in a turn and priced the AGGREGATE once against a single
 * flat rate (with `CHAT_CACHED_INPUT_PRICE_FACTOR=0.25`). That destroyed
 * per-response model, context-tier, cache, and `occurredAt` truth and produced
 * no durable receipts at all. This module is the chat sink's terminalization
 * seam: it reuses the landed receipt/pricing/marker foundation so every
 * completed provider response is persisted as its OWN receipt and priced
 * independently by the ONE canonical rate-card kernel.
 *
 * Flow (the OUTER boundary owns the captured[]; provider chokepoints in the
 * route push one {@link CapturedProviderUsage} per response):
 *   1. reserve an AgentRun id, then create the row with
 *      `costUnavailableReason: 'accounting-incomplete'`
 *      (the receipts that justify any headline are flushed next);
 *   2. flush each capture as a separate receipt under a `chat-turn` correlation
 *      — an exact re-flush with the same correlation + captures is idempotent;
 *   3. derive the AgentRun headline cost from the DURABLE receipts (sum when
 *      every component prices in one supported currency, else explicitly
 *      unavailable — never a fabricated $0 or a precise partial total);
 *   4. patch the AgentRun with the settled headline (best-effort).
 *
 * Cost is NEVER supplied by this seam or the route. The immutable per-response
 * cost is DERIVED inside the repository by the canonical pricing kernel
 * (`@/lib/operation-receipt-pricing`) from the raw provider facts; the headline
 * is the sum of those derived facts. No prompt, response, tool argument/result,
 * header, or credential may enter a receipt — capture is content-free.
 *
 * @author Radarist Team
 * @created 2026-07-23
 */

import 'server-only';
import { createLogger } from '@/lib/logger';
import {
  createAgentRun,
  generateAgentRunId,
  patchAgentRunAccounting,
  type AgentRunAccountingUsage,
} from '@/lib/agent-runs';
import { providerCacheSemantics } from '@/lib/ai/rate-card';
import { readProviderModel } from '@/lib/ai/effective-model';
import { flushCapturedUsage, type FlushResult } from '@/lib/operation-receipt-instrument';
import { summarizeChatToolCalls } from '@/lib/chat-tool-summary';
import type { CapturedProviderUsage } from '@/lib/operation-context';
import type { AgentRunUsageProvenance } from '@/lib/agent-run-usage';
import type {
  OperationReceipt,
  OperationReceiptCounters,
  OperationUsageCompleteness,
} from '@/lib/schemas/operation-receipt';

const log = createLogger('chat-accounting');

export type ChatAccountingProvider = 'gemini' | 'claude';
export type ChatAccountingErrorCode =
  | 'provider_error'
  | 'client_aborted'
  | 'budget_exhausted'
  | 'tool_iterations_exhausted'
  | 'time_budget_exhausted'
  | 'outcome_uncertain_side_effect'
  | 'paid_action_staging_failed';

export interface ChatAccountingPersistInput {
  userId: string;
  provider: ChatAccountingProvider;
  model: string;
  /**
   * AI-042: derived by {@link deriveChatTurnOutcome} from the turn's exact tool
   * outcomes — never the loop's optimistic "we got here, so it worked".
   */
  status: 'success' | 'failure';
  /** True when the turn delivered value despite one or more failed operations. */
  partial?: boolean;
  partialReason?: 'tool-failures';
  /** Content-free failure reasons that accompany a partial/failed status. */
  toolErrors?: string[];
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    totalInputTokens: number;
  };
  toolCalls: unknown;
  error?: ChatAccountingErrorCode;
  requestId: string;
}

export interface ChatAccountingOutcome extends ChatAccountingHeadline {
  /** Reserved before persistence so receipt correlation survives a row-write failure. */
  agentRunId: string;
  /** The receipt flush outcome (`undefined` only when the flush itself threw). */
  flush: FlushResult | undefined;
}

export interface ChatAccountingHeadline {
  /** `null` when the durable accounting could not produce a complete price. */
  costUsd: number | null;
  costUnavailableReason?: 'unknown-pricing' | 'accounting-incomplete';
  /**
   * What to charge the in-memory daily spend guard, which is a DIFFERENT question
   * from what to display.
   *
   * The guard is an accumulator: its job is to stop paid work once the day's
   * spend is accounted for, and a single unpriceable request fails it closed for
   * the rest of the day. That is right when the spend is genuinely unknowable —
   * an off-card model — but wrong for a receipt priced token-only because a
   * grounded search fee is free-tier-windowed. There the token cost is exact and
   * only a cents-scale surcharge is missing, so blocking every later paid turn
   * would take the Assistant offline over a rounding-scale gap.
   *
   * So a fee-unaccounted turn feeds the guard its exact TOKEN sum — a real lower
   * bound, and strictly more than the nothing it contributed before nested tool
   * spend was captured at all — while `costUsd` stays `null`, because a single
   * displayed figure has no way to say "at least". Anything genuinely unpriceable
   * still yields `null` here and still fails the guard closed.
   */
  budgetUsd: number | null;
}

export interface ChatProviderAttemptDescriptor {
  provider: string;
  operation: string;
  requestedModel?: string;
}

function appendUnreportedChatUsage(captured: CapturedProviderUsage[], attempt: ChatProviderAttemptDescriptor): void {
  captured.push({
    provider: attempt.provider,
    operation: attempt.operation,
    requestedModel: attempt.requestedModel,
    counters: {},
    usageCompleteness: 'unreported',
    occurredAt: new Date().toISOString(),
    feeState: 'none',
  });
}

/**
 * A completed SDK response must never disappear if its usage adapter encounters
 * an unexpected provider shape. Preserve an unreported fact instead.
 */
export function captureChatProviderResponse(
  captured: CapturedProviderUsage[],
  attempt: ChatProviderAttemptDescriptor,
  mapResponse: () => CapturedProviderUsage
): void {
  try {
    captured.push(mapResponse());
  } catch {
    appendUnreportedChatUsage(captured, attempt);
  }
}

/**
 * Wrap one SDK dispatch. A rejected/aborted/deadline attempt may still have
 * reached the provider, so record an unreported, unpriceable capture before
 * rethrowing. Successful calls are captured from their real response at the
 * existing response chokepoint.
 */
export async function trackChatProviderAttempt<T>(
  captured: CapturedProviderUsage[],
  attempt: ChatProviderAttemptDescriptor,
  dispatch: () => Promise<T>
): Promise<T> {
  try {
    return await dispatch();
  } catch (error) {
    appendUnreportedChatUsage(captured, attempt);
    throw error;
  }
}

/**
 * Derive the AgentRun headline cost from the DURABLE flushed receipts (single
 * source of truth):
 *   - an INCOMPLETE flush (a conflict or write failure) makes a complete total
 *     unprovable → `accounting-incomplete`;
 *   - ZERO receipts (no provider response occurred) is a REAL zero, never a
 *     fabricated estimate — nothing was spent;
 *   - every durable receipt must be priceable in ONE supported currency (USD);
 *     any `unavailable` receipt makes a complete total unprovable →
 *     `unknown-pricing`;
 *   - otherwise the headline is the exact sum of the receipts' micro-unit
 *     amounts, so it is recomputable from the ledger.
 *
 * This never returns a fabricated $0 for a partial total and never mixes
 * currencies — a fee/price in another currency fails the whole cost closed.
 *
 * `budgetUsd` answers the separate question of what to charge the daily spend
 * guard; see {@link ChatAccountingHeadline.budgetUsd}.
 */
export function deriveHeadlineCost(flush: FlushResult): ChatAccountingHeadline {
  if (!flush.complete || !flush.markerPersisted) {
    return { costUsd: null, costUnavailableReason: 'accounting-incomplete', budgetUsd: null };
  }
  if (flush.receipts.length === 0) {
    return { costUsd: 0, budgetUsd: 0 };
  }
  let feeUnaccounted = false;
  let usageUnreported = false;
  for (const receipt of flush.receipts) {
    if (!isReceiptPricedUsd(receipt)) {
      // Missing provider counters are bounded differently from an unknown
      // model/rate. Keep the displayed total unavailable, but preserve other
      // priced receipts as a real lower bound for the daily spend guard.
      if (!isUsageOnlyUnavailable(receipt)) {
        return { costUsd: null, costUnavailableReason: 'unknown-pricing', budgetUsd: null };
      }
      usageUnreported = true;
      continue;
    }
    // A receipt priced TOKEN-ONLY because its provider fee is applicable-but-
    // unknown (a grounded search inside its free-tier window) is a lower bound, not
    // the turn's cost. A legacy receipt states no fee at all, which is equally not
    // provably fee-free.
    if ((receipt.feeState ?? 'applicable-but-unknown') === 'applicable-but-unknown') feeUnaccounted = true;
  }
  const micros = flush.receipts.reduce<number>((sum, receipt) => sum + receiptPricedMicros(receipt), 0);
  if (!Number.isSafeInteger(micros)) {
    return { costUsd: null, costUnavailableReason: 'accounting-incomplete', budgetUsd: null };
  }
  const usd = micros / 1_000_000;
  if (usageUnreported) {
    return { costUsd: null, costUnavailableReason: 'unknown-pricing', budgetUsd: usd > 0 ? usd : null };
  }
  // The displayed headline is a single figure with no room to say "at least", so
  // an unaccounted fee — or an unreported nested call — keeps it unavailable,
  // while the guard still receives the exact priced sum so one grounded or
  // graph-semantic turn cannot take the Assistant offline.
  //
  // A ZERO sum is not a bound. With nothing priced there is no evidence of spend
  // to accumulate, so the guard falls back to failing closed rather than
  // recording a fabricated $0 — which is precisely what this contract forbids.
  if (usageUnreported) {
    return { costUsd: null, costUnavailableReason: 'unknown-pricing', budgetUsd: usd > 0 ? usd : null };
  }
  return feeUnaccounted
    ? { costUsd: null, costUnavailableReason: 'unknown-pricing', budgetUsd: usd }
    : { costUsd: usd, budgetUsd: usd };
}

const USAGE_ONLY_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(['missing-usage', 'provider-unreported']);

function isUsageOnlyUnavailable(receipt: OperationReceipt): boolean {
  return receipt.cost.state === 'unavailable' && USAGE_ONLY_UNAVAILABLE_REASONS.has(receipt.cost.reason);
}

/** A durable receipt carries a complete, single-currency (USD) priced amount. */
function isReceiptPricedUsd(receipt: OperationReceipt): boolean {
  return (
    receipt.cost.state === 'estimated' && receipt.cost.amountMicros !== undefined && receipt.cost.currency === 'USD'
  );
}

/** The priced micro-unit amount of a receipt already verified priced-USD. */
function receiptPricedMicros(receipt: OperationReceipt): number {
  return receipt.cost.state === 'estimated' ? (receipt.cost.amountMicros ?? 0) : 0;
}

interface MutableModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costMicros: number;
  costComplete: boolean;
}

function addSafe(left: number, right: number, label: string): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum) || sum < 0) {
    throw new Error(`AgentRun receipt projection overflowed ${label}`);
  }
  return sum;
}

/**
 * ARUN-020 — the ONE provider fact an AgentRun's usage is folded from.
 *
 * A chat turn publishes its usage TWICE: once when the AgentRun row is created
 * (before any receipt exists) and again when the durable receipts are known.
 * Before this type the two writes used two DIFFERENT bases — the route's
 * mutable aggregate (which substitutes a `characters / 4` estimate whenever a
 * provider response omits `usageMetadata`) and the receipt fold — so the same
 * run could publish 115 tokens and then silently republish 109. Both writes now
 * fold the SAME facts, so they agree by construction whenever the captures
 * survive into receipts.
 */
interface ProviderUsageFact {
  provider: string;
  /** The provider-REPORTED served model, or undefined when it was not proven. */
  model: string | undefined;
  counters: OperationReceiptCounters;
  usageCompleteness: OperationUsageCompleteness;
  /** Complete USD micro-amount for this response; undefined when unpriceable. */
  pricedMicros: number | undefined;
}

/**
 * A receipt's fact. `modelProvenance` gates the per-model breakdown: a
 * requested-fallback model is useful for pricing provenance but is not proof of
 * what was served.
 */
function receiptFact(receipt: OperationReceipt): ProviderUsageFact {
  return {
    provider: receipt.provider,
    model: receipt.modelProvenance === 'provider-reported' ? receipt.model : undefined,
    counters: receipt.counters,
    usageCompleteness: receipt.usageCompleteness,
    pricedMicros: isReceiptPricedUsd(receipt) ? receiptPricedMicros(receipt) : undefined,
  };
}

/**
 * A capture's fact — the SAME provider truth a receipt is built from, minus the
 * derived price (pricing happens inside the repository). `providerModel` goes
 * through the same {@link readProviderModel} normalization the receipt builder
 * applies, so a `models/`-prefixed id folds to the identical model key.
 */
function captureFact(capture: CapturedProviderUsage): ProviderUsageFact {
  return {
    provider: capture.provider,
    model: readProviderModel(capture.providerModel),
    counters: capture.counters,
    usageCompleteness: capture.usageCompleteness,
    pricedMicros: undefined,
  };
}

/**
 * How much of an AgentRun's token usage the PROVIDER actually reported.
 *
 * `unreported` is the honest answer when every provider response in the turn
 * omitted usage: the token count is unknown, and a persisted `{0,0}` would read
 * as a measured zero on every surface. A turn with NO provider response at all
 * is a real zero (nothing was sent), matching the headline-cost rule.
 */
function deriveUsageProvenance(facts: readonly ProviderUsageFact[]): AgentRunUsageProvenance {
  if (facts.length === 0) return 'provider-reported';
  const complete = facts.filter((fact) => factContribution(fact) === 'complete').length;
  if (complete === facts.length) return 'provider-reported';
  const contributing = facts.filter((fact) => factContribution(fact) !== 'none').length;
  return contributing === 0 ? 'unreported' : 'partially-reported';
}

/**
 * How much a single provider response contributes to the run's token total.
 *
 * `none` covers BOTH a provider that reported nothing and counters that cannot
 * be believed. Receipt counters are schema-validated at the repository
 * boundary, but a CAPTURE is a raw provider fact: a fractional, negative, NaN
 * or infinite counter reaches this fold verbatim. Such a value is not a
 * measurement, so it contributes nothing and never becomes a per-model key —
 * the same fail-closed rule the pricing kernel applies. Folding it in would
 * either throw out of terminalization or poison the total with NaN.
 */
function factContribution(fact: ProviderUsageFact): 'complete' | 'partial' | 'none' {
  if (fact.usageCompleteness === 'unreported') return 'none';
  const usable = Object.values(fact.counters).every(
    (value) => value === undefined || (Number.isSafeInteger(value) && value >= 0)
  );
  if (!usable) return 'none';
  return fact.usageCompleteness === 'complete' ? 'complete' : 'partial';
}

/**
 * Project the AgentRun usage from provider facts, never from the route's
 * requested model or mutable aggregate. Only a provider-reported model may
 * become a modelUsage key: requested fallback is useful for pricing provenance
 * but is not proof of what was served.
 *
 * Gemini's prompt counter includes its cached subset, so the ordinary-input
 * bucket subtracts cache-read once. Anthropic-style chat counters (including
 * OpenRouter's Anthropic SDK transport) are disjoint and remain additive.
 * Thinking is added to output because AgentRun's historical tokenUsage contract
 * treats generated reasoning as output while receipts retain it separately.
 */
function foldAgentRunUsage(facts: readonly ProviderUsageFact[]): AgentRunAccountingUsage {
  const byModel = new Map<string, MutableModelUsage>();
  let totalInput = 0;
  let totalOutput = 0;

  for (const fact of facts) {
    // Fail closed: an unreported or unbelievable response contributes nothing.
    // `deriveUsageProvenance` above records that the total is therefore not the
    // whole turn, so no surface can read the remainder as exact.
    if (factContribution(fact) === 'none') continue;
    const counters = fact.counters;
    const prompt = counters.promptTokens ?? 0;
    const cacheRead = counters.cacheReadTokens ?? 0;
    const cacheCreation = addSafe(counters.cacheWrite5mTokens ?? 0, counters.cacheWrite1hTokens ?? 0, 'cache creation');
    const cacheSemantics = providerCacheSemantics(fact.provider);
    const subsetCacheValid = cacheSemantics !== 'subset' || cacheRead <= prompt;
    const ordinaryInput = cacheSemantics === 'subset' && subsetCacheValid ? prompt - cacheRead : prompt;
    const responseOutput = addSafe(counters.outputTokens ?? 0, counters.thinkingTokens ?? 0, 'output');
    // For subset providers, prompt already includes cache-read tokens. Use the
    // provider total directly so an impossible cached>prompt fact cannot be
    // Math.max-clamped into an inflated "700 known tokens from 500 total"
    // projection. Its cost is already unavailable; the per-model breakdown is
    // omitted below because ordinary-vs-cache allocation is unprovable.
    const responseInput =
      cacheSemantics === 'subset'
        ? addSafe(prompt, cacheCreation, 'input')
        : addSafe(addSafe(ordinaryInput, cacheRead, 'input'), cacheCreation, 'input');
    totalInput = addSafe(totalInput, responseInput, 'total input');
    totalOutput = addSafe(totalOutput, responseOutput, 'total output');

    if (!fact.model || !subsetCacheValid) {
      continue;
    }
    const current = byModel.get(fact.model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costMicros: 0,
      costComplete: true,
    };
    current.inputTokens = addSafe(current.inputTokens, ordinaryInput, 'model input');
    current.outputTokens = addSafe(current.outputTokens, responseOutput, 'model output');
    current.cacheReadInputTokens = addSafe(current.cacheReadInputTokens, cacheRead, 'model cache read');
    current.cacheCreationInputTokens = addSafe(current.cacheCreationInputTokens, cacheCreation, 'model cache creation');
    if (fact.pricedMicros !== undefined) {
      current.costMicros = addSafe(current.costMicros, fact.pricedMicros, 'model cost');
    } else {
      current.costComplete = false;
    }
    byModel.set(fact.model, current);
  }

  const modelUsage: AgentRunAccountingUsage['modelUsage'] = {};
  for (const [model, usage] of byModel) {
    modelUsage[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      ...(usage.costComplete ? { costUSD: usage.costMicros / 1_000_000 } : {}),
    };
  }
  const models = Object.keys(modelUsage);
  return {
    ...(models.length === 1 ? { model: models[0] } : {}),
    modelUsage,
    tokenUsage: { input: totalInput, output: totalOutput },
    tokenUsageProvenance: deriveUsageProvenance(facts),
  };
}

/** The AgentRun usage projected from the DURABLE receipts (terminal authority). */
export function deriveAgentRunUsage(receipts: readonly OperationReceipt[]): AgentRunAccountingUsage {
  return foldAgentRunUsage(receipts.map(receiptFact));
}

/**
 * The AgentRun usage projected from the turn's CAPTURES — the same provider
 * facts the receipts are built from, available before the flush.
 *
 * Used for the create-time write and as the fallback when the flush could not
 * complete. A conflicted/failed receipt batch cannot prove a served-model
 * breakdown, so callers drop `modelUsage`; the token counters stay, because
 * replacing known provider usage with an empty set would turn a receipt-storage
 * failure into a false exact zero.
 */
export function deriveAgentRunUsageFromCaptures(captured: readonly CapturedProviderUsage[]): AgentRunAccountingUsage {
  return foldAgentRunUsage(captured.map(captureFact));
}

function unprovenAgentRunUsage(captured: readonly CapturedProviderUsage[]): AgentRunAccountingUsage {
  const { modelUsage: _unprovable, model: _unprovableModel, ...usage } = deriveAgentRunUsageFromCaptures(captured);
  return { ...usage, modelUsage: {} };
}

/**
 * Terminalize one chat provider attempt: persist the AgentRun (accounting marked
 * incomplete), flush each captured provider response as its OWN receipt, derive
 * the headline from the durable receipts, and patch the AgentRun with it.
 *
 * `requestId` is the correlation for this HTTP attempt. An exact re-flush with
 * the same reserved AgentRun id and immutable captures targets the same receipt
 * identities; a new HTTP request is a new attempt and is not claimed as a
 * replay. `accountingScope: 'included-in-parent'`
 * classifies the chat main-model responses as already counted by the AgentRun
 * headline, so a later daily aggregator never double-counts them.
 *
 * Best-effort and non-fatal: a receipt/AgentRun failure is logged and surfaced
 * via the returned outcome (and durably via the accounting marker) rather than
 * breaking the observed chat turn. `fn`'s own errors are NOT caught here — this
 * is called only from terminalization, after the provider work has settled.
 */
export async function terminalizeChatAccounting(
  input: ChatAccountingPersistInput,
  captured: readonly CapturedProviderUsage[]
): Promise<ChatAccountingOutcome> {
  const toolSummary = summarizeChatToolCalls(input.toolCalls);
  const action = toolSummary.toolSummary.length
    ? `Assistant chat tools: ${toolSummary.toolSummary.map((tool) => tool.name).join(', ')}`.slice(0, 200)
    : 'Assistant chat turn';

  // 1. Reserve the id BEFORE persistence. Even when the AgentRun write fails,
  //    captured provider spend can still be durably correlated and marked.
  const agentRunId = generateAgentRunId();
  let agentRunPersisted = false;

  // ARUN-020 — the create-time usage is folded from the CAPTURES, i.e. the same
  // provider facts the receipts are built from, so the terminal patch below
  // republishes an identical token total instead of silently contradicting it.
  // The route's own aggregate is NOT used: it substitutes a `characters / 4`
  // estimate whenever a provider response omits usage metadata, which the
  // receipt fold correctly refuses to invent — that mismatch is exactly how one
  // visible chat run showed 115 tokens in the Runs list and 109 in its detail.
  const capturedUsage = deriveAgentRunUsageFromCaptures(captured);

  // Create the AgentRun with accounting INCOMPLETE — receipts are flushed
  //    next and the row is patched once their outcome is known. A crash between
  //    the two leaves an honest "accounting-incomplete" row, never a fake number.
  try {
    await createAgentRun(
      {
        userId: input.userId,
        kind: 'chat',
        provider: input.provider,
        agentName: 'chat',
        action,
        status: input.status,
        // No requested/last-model attribution here. The authoritative served
        // model breakdown is derived from durable receipts and replaces usage
        // in the terminal patch below.
        tokenUsage: capturedUsage.tokenUsage,
        tokenUsageProvenance: capturedUsage.tokenUsageProvenance,
        costUnavailableReason: 'accounting-incomplete',
        duration: input.durationMs,
        ...toolSummary,
        // AI-042 — the durable reasons. The route's terminal error code (when
        // there is one) is already the first entry of `toolErrors`; the legacy
        // single-code form is kept for callers that pass only `error`.
        ...(input.toolErrors && input.toolErrors.length > 0
          ? { errors: input.toolErrors }
          : input.error
            ? { errors: [input.error] }
            : {}),
        ...(input.partial ? { partial: true } : {}),
        ...(input.partial && input.partialReason ? { partialReason: input.partialReason } : {}),
      },
      {
        id: agentRunId,
        // Project only after the receipt-derived headline has been patched.
        // Otherwise Neo4j freezes the initial incomplete/null cost.
        deferGraphSync: true,
      }
    );
    agentRunPersisted = true;
  } catch (error) {
    log.error('Failed to persist chat AgentRun', error instanceof Error ? error : new Error(String(error)), {
      requestId: input.requestId,
      provider: input.provider,
      status: input.status,
    });
  }

  // 2. Flush each capture as its OWN receipt under the chat-turn correlation.
  //    The reserved id keeps this durable even when the AgentRun create failed.
  const correlation = {
    parentType: 'chat-turn' as const,
    owner: `user:${input.userId}`,
    correlationId: input.requestId,
    agentRunId,
  };
  let flush: FlushResult | undefined;
  try {
    // One HTTP request may terminalize multiple provider attempts (e.g. paid
    // Claude failure then Gemini fallback). The request id is their shared
    // parent correlation; the reserved AgentRun id is the stable, DISTINCT
    // batch/receipt prefix, so a later successful attempt cannot overwrite an
    // earlier loss marker.
    flush = await flushCapturedUsage(correlation, captured, agentRunId, 'included-in-parent');
  } catch (error) {
    log.error(
      'Chat receipt flush threw (best-effort, non-fatal)',
      error instanceof Error ? error : new Error(String(error)),
      {
        requestId: input.requestId,
        provider: input.provider,
        captured: captured.length,
      }
    );
  }

  // 3. Derive the headline from the durable receipts.
  const headline: ChatAccountingHeadline =
    flush && agentRunPersisted
      ? deriveHeadlineCost(flush)
      : { costUsd: null, costUnavailableReason: 'accounting-incomplete' as const, budgetUsd: null };

  // 4. Patch the AgentRun with the receipt-derived estimate. Best-effort: a failure
  //    here leaves the row at accounting-incomplete (honest), never a fake number.
  //    `budgetUsd` is a guard input, not an accounting fact, so it is not persisted.
  if (agentRunPersisted) {
    try {
      const durableUsage =
        flush?.complete === true ? deriveAgentRunUsage(flush.receipts) : unprovenAgentRunUsage(captured);
      const { budgetUsd: _budgetUsd, ...persistedHeadline } = headline;
      await patchAgentRunAccounting(agentRunId, persistedHeadline, durableUsage);
    } catch (error) {
      log.error(
        'Failed to patch chat AgentRun headline (best-effort)',
        error instanceof Error ? error : new Error(String(error)),
        {
          requestId: input.requestId,
          agentRunId,
        }
      );
    }
  }

  return { agentRunId, ...headline, flush };
}
