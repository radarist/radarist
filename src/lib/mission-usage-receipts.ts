/**
 * @file lib/mission-usage-receipts.ts
 * @description ARUN-022 — flush the Anthropic mission runtimes' provider-reported
 * usage as durable operation-usage receipts, and record each runtime's
 * authoritative cost as an append-only settlement.
 *
 * Three envelopes, ONE shared per-served-model path ({@link flushPerModelUsage}):
 *   - {@link flushMissionUsageReceipts} — the mission's main orchestrator turn;
 *   - {@link flushSubSessionUsageReceipts} — the out-of-process helper sessions
 *     the mission dispatches alongside it: the bounded revision turn (Step 2.75)
 *     and each skill-prelude helper turn (Step 1.7);
 *   - {@link flushBuildSessionUsageReceipt} — a build mission's sandboxed
 *     headless CLI session.
 * They differ only in what the provider actually told us, and each records
 * exactly that — see each function's contract.
 *
 * GRANULARITY — the served model, not the individual response. Both Anthropic
 * runtimes stream per-response usage, and both under-report it: the response
 * events carry a MID-STREAM `output_tokens` snapshot that is never finalized,
 * and auxiliary models never appear as response events at all. The measured
 * evidence lives in `agent/src/sandbox/stream-json.ts` and its boundary test.
 * So the per-SERVED-MODEL summary is the finest granularity either runtime
 * reports authoritatively, and it is the accounting unit here.
 *
 * The mission runtime is the Anthropic Claude Agent SDK in the `/agent`
 * sub-package. That package is compiled and loaded separately (via
 * `pathToFileURL` of its dist) and imports NOTHING from `@/lib`, so it cannot
 * call the ambient operation-usage sink from inside the orchestrator. The
 * orchestrator instead exposes its provider-reported per-model summary
 * (`MissionResult.modelUsage`) back to the Inngest handler in `src/lib`, which
 * CAN import the receipt substrate. This module is that boundary seam.
 *
 * Semantics (requirements 2 + 3):
 *   - Each provider-reported model in `modelUsage` produces its OWN receipt
 *     (one per model — the summary granularity the SDK exposes; the per-response
 *     breakdown is not available at this boundary).
 *   - Counters come from the SDK's per-model token summary; the model name is
 *     the provider-reported served model (`provider-reported` provenance). The
 *     immutable ESTIMATE is derived from these facts by the ONE canonical rate
 *     card inside the repository.
 *   - `asOf` is the mission's immutable occurrence timestamp (the memoized
 *     completion time), so a dated introductory rate prices correctly and a
 *     replay prices identically.
 *   - The SDK's per-model `costUSD` is provider ACTUAL/settlement evidence. It
 *     is recorded as an APPEND-ONLY settlement against that model's receipt —
 *     it NEVER overwrites the immutable estimate.
 *   - Scope is `included-in-parent`: the mission headline already counts this
 *     spend, so a later daily aggregator never double-counts it.
 *
 * Everything is best-effort and non-fatal: a receipt/settlement failure is
 * classified and surfaced (and the durable accounting marker inside the flush
 * records a loss when it can) rather than breaking the observed mission.
 *
 * @author Radarist Team
 * @created 2026-07-24
 */

import 'server-only';
import { createLogger } from '@/lib/logger';
import { flushCapturedUsage, type FlushResult } from '@/lib/operation-receipt-instrument';
import { recordOperationSettlement } from '@/lib/operation-settlement-repository';
import type { CapturedProviderUsage } from '@/lib/operation-context';
import type { OperationUsageCompleteness } from '@/lib/schemas/operation-receipt';

const log = createLogger('mission-usage-receipts');

/**
 * The Anthropic SDK's per-model usage summary (structural mirror of the agent
 * package's `ModelUsageSummary`, so this module does not import across the
 * package boundary). `costUSD` is the SDK's authoritative per-model cost.
 */
export interface ProviderModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Per-model cache-read fact. Absent when only aggregate tokenUsage is available. */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** SDK-authoritative per-model cost. `undefined` means unreported; `0` is a KNOWN zero cost. */
  costUSD?: number;
}

export interface MissionUsageReceiptInput {
  missionId: string;
  /** Accounting owner principal, e.g. `user:<uid>`. */
  owner: string;
  /** Immutable provider-occurrence timestamp (ISO-8601) — the receipt `asOf`. */
  asOf: string;
  /** Provider-reported per-model usage summary from the orchestrator result. */
  modelUsage: Record<string, ProviderModelUsage>;
}

export interface MissionUsageReceiptOutcome {
  flush: FlushResult | undefined;
  /** Per-model settlement outcomes. */
  settlements: Record<string, SettlementOutcome>;
}

/**
 * How this model's cache-CREATION tokens map onto the receipt's priced write
 * tiers. The 5-minute and 1-hour tiers differ ~1.6× in price, so an unresolved
 * split must never be guessed:
 *   - `{ tier }` — the tier is PROVEN for this model's writes;
 *   - `'ambiguous'` — writes exist but their tier is not derivable, so no
 *     cache-write counter is recorded and the receipt is `partial`. (The legacy
 *     ambiguous `cacheWriteTokens` counter is forbidden on a v2 write.)
 *   - `undefined` — the caller has no tier fact and accepts the documented
 *     5-minute default (the SDK paths, which never send the 1-hour beta).
 */
type CacheWriteResolution = { cacheWrite5mTokens?: number; cacheWrite1hTokens?: number } | 'ambiguous' | undefined;

/**
 * Build one correlation-free capture per provider-reported model. The model name
 * is the provider-reported served model; counters are the provider's per-model
 * token summary mapped onto the receipt counter set (Anthropic disjoint cache
 * semantics). Completeness is honest: `complete` only when the required
 * input/output counters are present and valid, the cache-read fact is known, and
 * the cache-write tier is not ambiguous.
 */
function modelUsageToCapture(
  model: string,
  usage: ProviderModelUsage,
  asOf: string,
  operation: string,
  cacheWrite?: CacheWriteResolution
): CapturedProviderUsage {
  const counters: CapturedProviderUsage['counters'] = {
    promptTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  // Only report a cache-read counter when the provider supplied a per-model
  // fact. Synthetic fallbacks from aggregate tokenUsage must not manufacture a
  // known-zero cache counter.
  if (typeof usage.cacheReadInputTokens === 'number' && usage.cacheReadInputTokens > 0) {
    counters.cacheReadTokens = usage.cacheReadInputTokens;
  }
  let cacheWriteAmbiguous = false;
  if (usage.cacheCreationInputTokens && usage.cacheCreationInputTokens > 0) {
    if (cacheWrite === 'ambiguous') {
      // Writes happened but we cannot prove which tier billed them. Record no
      // write counter and fail the receipt's completeness closed, rather than
      // price 1-hour writes at the 5-minute rate.
      cacheWriteAmbiguous = true;
    } else if (cacheWrite) {
      // A PROVEN per-model split (the sandbox path, from the provider's own
      // `usage.cache_creation` tier fact).
      if (cacheWrite.cacheWrite5mTokens) counters.cacheWrite5mTokens = cacheWrite.cacheWrite5mTokens;
      if (cacheWrite.cacheWrite1hTokens) counters.cacheWrite1hTokens = cacheWrite.cacheWrite1hTokens;
    } else {
      // Default (SDK paths): the codebase never sends the 1-hour extended-cache
      // TTL beta, so aggregate cache-creation writes are the 5-minute tier.
      counters.cacheWrite5mTokens = usage.cacheCreationInputTokens;
    }
  }
  const cacheFactsKnown = typeof usage.cacheReadInputTokens === 'number';
  const requiredValid =
    Number.isFinite(usage.inputTokens) &&
    Number.isInteger(usage.inputTokens) &&
    usage.inputTokens >= 0 &&
    Number.isFinite(usage.outputTokens) &&
    Number.isInteger(usage.outputTokens) &&
    usage.outputTokens >= 0 &&
    cacheFactsKnown &&
    !cacheWriteAmbiguous;
  const usageCompleteness: OperationUsageCompleteness = requiredValid ? 'complete' : 'partial';
  return {
    provider: 'anthropic',
    operation,
    // The provider reports the served model as the modelUsage key.
    requestedModel: model,
    providerModel: model,
    counters,
    usageCompleteness,
    occurredAt: asOf,
    // Anthropic chat turns are token-billed; no separate provider surcharge.
    feeState: 'none',
  };
}

/**
 * The ONE shared per-served-model flush every Anthropic envelope routes
 * through: mission, revision/prelude sub-session, and build sandbox session. It
 * exists so the estimate-vs-settlement split, the deterministic model ordering,
 * and the best-effort error contract cannot fork into per-envelope copies.
 *
 * Models are sorted so a replay derives the SAME positional `invocationId` for
 * the same model regardless of provider key order.
 */
async function flushPerModelUsage(input: {
  missionId: string;
  owner: string;
  asOf: string;
  modelUsage: Record<string, ProviderModelUsage>;
  operation: string;
  invocationPrefix: string;
  evidenceRef: string;
  cacheWriteFor?: (model: string, usage: ProviderModelUsage) => CacheWriteResolution;
  logContext: Record<string, unknown>;
}): Promise<{ flush: FlushResult | undefined; settlements: Record<string, SettlementOutcome> }> {
  const models = Object.keys(input.modelUsage).sort();
  if (models.length === 0) {
    return { flush: undefined, settlements: {} };
  }

  const captured = models.map((model) =>
    modelUsageToCapture(
      model,
      input.modelUsage[model],
      input.asOf,
      input.operation,
      input.cacheWriteFor?.(model, input.modelUsage[model])
    )
  );

  let flush: FlushResult | undefined;
  try {
    flush = await flushCapturedUsage(
      {
        parentType: 'mission',
        owner: input.owner,
        correlationId: input.missionId,
        missionId: input.missionId,
      },
      captured,
      input.invocationPrefix,
      'included-in-parent'
    );
  } catch (error) {
    log.error(
      'Provider usage receipt flush failed (best-effort, non-fatal)',
      error instanceof Error ? error : new Error(String(error)),
      { ...input.logContext, models: models.length }
    );
    return { flush: undefined, settlements: {} };
  }

  // Record each model's provider-authoritative cost as an append-only ACTUAL
  // settlement against its durable receipt. The estimate (priced from the
  // canonical card) stays immutable; the settlement is the provider's actual.
  const settlements: Record<string, SettlementOutcome> = {};
  for (const receipt of flush.receipts) {
    const model = receipt.model;
    if (!model) continue;
    const usage = input.modelUsage[model];
    settlements[model] = usage
      ? await settleReceiptActual({
          receiptId: receipt.id,
          owner: input.owner,
          costUsd: usage.costUSD,
          occurredAt: input.asOf,
          evidenceRef: input.evidenceRef,
          logContext: { ...input.logContext, model },
        })
      : 'skipped';
  }

  return { flush, settlements };
}

/**
 * Flush the mission's provider-reported per-model usage as receipts and record
 * the SDK's per-model `costUSD` as an append-only settlement against each
 * receipt. Best-effort and non-fatal: receipt/settlement failures are logged
 * and classified, never thrown into the mission path. Returns the structured
 * outcome for telemetry.
 */
export async function flushMissionUsageReceipts(input: MissionUsageReceiptInput): Promise<MissionUsageReceiptOutcome> {
  return flushPerModelUsage({
    missionId: input.missionId,
    owner: input.owner,
    asOf: input.asOf,
    modelUsage: input.modelUsage,
    operation: 'anthropic.mission-turn',
    // Stable prefix derived from the mission id so an exact replay is
    // idempotent, not a duplicate.
    invocationPrefix: `mission-${input.missionId}`,
    evidenceRef: 'anthropic-sdk-modelUsage',
    logContext: { missionId: input.missionId, owner: input.owner },
  });
}

/**
 * The out-of-process Anthropic HELPER sub-sessions a mission dispatches
 * alongside its main orchestrator turn:
 *   - `revision` — the single bounded correction turn (Step 2.75);
 *   - `skill-prelude` — one bounded helper turn per skill/target (Step 1.7).
 *
 * Both are full paid provider sessions whose spend is folded into the mission
 * headline (`totalMissionCost = orchestrator + prelude + revision + aux`), so
 * their receipts are `included-in-parent` — pure attribution that an aggregate
 * adds ZERO for.
 */
export type SubSessionKind = 'revision' | 'skill-prelude';

export interface SubSessionUsageReceiptInput {
  missionId: string;
  /** Accounting owner principal, e.g. `user:<uid>`. */
  owner: string;
  /** Immutable provider-occurrence timestamp (ISO-8601) — the receipt `asOf`. */
  asOf: string;
  kind: SubSessionKind;
  /**
   * Stable identity of this sub-session WITHIN its mission (e.g. `attempt-1`,
   * `task-3`). It must be derived from a memoized fact so a durable replay
   * targets the same receipts instead of minting duplicates. Constrained to the
   * receipt id alphabet: alphanumerics plus `._-`.
   */
  sessionKey: string;
  /** Provider-reported per-model usage summary from the sub-session result. */
  modelUsage: Record<string, ProviderModelUsage>;
}

/** Receipt-id-safe subset of the sub-session key; anything else is replaced. */
function sanitizeSessionKey(sessionKey: string): string {
  const cleaned = sessionKey.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'unkeyed';
}

/**
 * Flush ONE helper/revision sub-session's provider-reported per-model usage as
 * durable receipts, settling each with the sub-session's own per-model cost.
 *
 * These sessions run out-of-process (the Agent SDK drives a `claude` subprocess),
 * and the `/agent` package imports nothing from `@/lib`, so the orchestrator
 * cannot reach the receipt substrate itself. It returns its per-model summary to
 * the Inngest handler instead; this function is that boundary seam — the same
 * one {@link flushMissionUsageReceipts} uses for the main turn.
 *
 * Best-effort and non-fatal: a receipt/settlement failure is classified and
 * logged rather than thrown into the mission path.
 */
export async function flushSubSessionUsageReceipts(
  input: SubSessionUsageReceiptInput
): Promise<MissionUsageReceiptOutcome> {
  const sessionKey = sanitizeSessionKey(input.sessionKey);
  return flushPerModelUsage({
    missionId: input.missionId,
    owner: input.owner,
    asOf: input.asOf,
    modelUsage: input.modelUsage,
    operation: input.kind === 'revision' ? 'anthropic.revision-turn' : 'anthropic.prelude-turn',
    // Distinct from the mission prefix so a helper receipt can never collide
    // with the main turn's, and stable per sub-session so a replay is idempotent.
    invocationPrefix: `${input.kind}-${input.missionId}-${sessionKey}`,
    evidenceRef: 'anthropic-sdk-modelUsage',
    logContext: { missionId: input.missionId, kind: input.kind, sessionKey },
  });
}

export type SettlementOutcome = 'settled' | 'skipped' | 'failed';

/**
 * Record ONE provider-authoritative cost as an append-only settlement against a
 * durable receipt. Best-effort: a settlement failure is classified, never thrown
 * into the observed operation.
 *
 * `costUsd` is deliberately `number | undefined` with three distinct meanings:
 *   - `undefined` — the provider reported no cost, so nothing is settled and the
 *     canonical estimate stands. This is NOT a zero.
 *   - `0` — a provider-reported KNOWN zero. It IS recorded, so a later reader
 *     sees "settled at $0" rather than "unpriced".
 *   - non-finite or negative — an impossible fact; refuse it rather than persist
 *     a corrupt actual.
 */
async function settleReceiptActual(input: {
  receiptId: string;
  owner: string;
  costUsd: number | undefined;
  occurredAt: string;
  evidenceRef: string;
  logContext: Record<string, unknown>;
}): Promise<SettlementOutcome> {
  if (typeof input.costUsd !== 'number') return 'skipped';
  if (!Number.isFinite(input.costUsd) || input.costUsd < 0) return 'failed';
  const actualAmountMicros = Math.round(input.costUsd * 1_000_000);
  if (!Number.isSafeInteger(actualAmountMicros)) return 'failed';
  try {
    await recordOperationSettlement({
      receiptId: input.receiptId,
      owner: input.owner,
      actualAmountMicros,
      currency: 'USD',
      covers: 'tokens',
      evidenceRef: input.evidenceRef,
      occurredAt: input.occurredAt,
      revision: 0,
    });
    return 'settled';
  } catch (error) {
    log.warn('Provider settlement failed (best-effort, non-fatal)', {
      ...input.logContext,
      receiptId: input.receiptId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'failed';
  }
}

export interface BuildSessionUsageReceiptInput {
  missionId: string;
  /** Accounting owner principal, e.g. `user:<uid>`. */
  owner: string;
  /** 0-based session index within the build mission — part of the stable identity. */
  sessionIndex: number;
  /**
   * The model the supervisor ASKED for. Used as the receipt's effective model
   * ONLY on the aggregate fallback path, where the CLI reported no per-model
   * breakdown and nothing confirms what was actually served.
   */
  requestedModel: string;
  /**
   * Immutable session-completion timestamp (ISO-8601), read back from the
   * durable session record so a replay stamps the same `occurredAt`.
   */
  occurredAt: string;
  /** The CLI's final cumulative input token count for the session, when reported. */
  inputTokens?: number;
  /** The CLI's final cumulative output token count for the session, when reported. */
  outputTokens?: number;
  /**
   * The CLI result line's `total_cost_usd` — the provider's AUTHORITATIVE cost
   * for this session. Pass `undefined` when the result was missing or malformed:
   * the supervisor then charges the full budget RESERVATION, which is an exposure
   * ceiling and emphatically NOT a provider actual, so it must never be recorded
   * as a settlement.
   */
  authoritativeCostUsd?: number;
  /**
   * The CLI result line's `modelUsage` — per SERVED model, with that model's own
   * provider-authoritative `costUSD`. This is the FINEST granularity the headless
   * protocol reports authoritatively (see `agent/src/sandbox/stream-json.ts` for
   * why the per-response `assistant` lines are not). When present it drives the
   * per-served-model path; when absent the aggregate fallback runs.
   */
  modelUsage?: Record<string, ProviderModelUsage>;
  /**
   * The session-wide cache-write tier split (`usage.cache_creation`). The 5m and
   * 1h tiers price ~1.6× apart, so it is only attributed per model when the
   * attribution is PROVABLE — see {@link resolveBuildCacheWrite}.
   */
  cacheCreation?: { ephemeral5mInputTokens?: number; ephemeral1hInputTokens?: number };
}

export interface BuildSessionUsageReceiptOutcome {
  flush: FlushResult | undefined;
  /** The aggregate-fallback settlement. `'skipped'` when the per-model path ran. */
  settlement: SettlementOutcome;
  /** Per-served-model settlements. Empty when the aggregate fallback ran. */
  settlements: Record<string, SettlementOutcome>;
  /** Which granularity actually recorded this session — never inferred by callers. */
  granularity: 'per-served-model' | 'session-aggregate';
}

/**
 * Decide, per served model, how that model's cache-CREATION tokens map onto the
 * priced 5m/1h write tiers — using only what the provider PROVED.
 *
 * The CLI reports the tier split for the SESSION (`usage.cache_creation`) but
 * `cacheCreationInputTokens` per MODEL, so the two only compose when the mapping
 * is unambiguous. Exactly three cases resolve:
 *   - the model wrote no cache at all — nothing to attribute;
 *   - one tier of the session split is zero — every write in the session, and so
 *     every write of every model, belongs to the other tier;
 *   - both tiers are nonzero but this model is the session's ONLY writer — the
 *     session split IS this model's split.
 * Anything else (two models writing across two tiers, or no session split fact)
 * is `'ambiguous'`: no write counter is recorded and the receipt stays `partial`,
 * because guessing would price 1-hour writes at the 5-minute rate.
 */
function resolveBuildCacheWrite(
  modelUsage: Record<string, ProviderModelUsage>,
  cacheCreation: BuildSessionUsageReceiptInput['cacheCreation']
): (model: string, usage: ProviderModelUsage) => CacheWriteResolution {
  const writersWithCache = Object.values(modelUsage).filter(
    (usage) => (usage.cacheCreationInputTokens ?? 0) > 0
  ).length;

  return (_model, usage) => {
    const writes = usage.cacheCreationInputTokens ?? 0;
    if (writes === 0) return undefined;
    const fiveMin = cacheCreation?.ephemeral5mInputTokens;
    const oneHour = cacheCreation?.ephemeral1hInputTokens;
    if (typeof fiveMin !== 'number' || typeof oneHour !== 'number') return 'ambiguous';
    if (oneHour === 0) return { cacheWrite5mTokens: writes };
    if (fiveMin === 0) return { cacheWrite1hTokens: writes };
    // Both tiers were used. Only a sole writer can claim the whole split, and
    // only when the split actually accounts for its writes.
    if (writersWithCache === 1 && fiveMin + oneHour === writes) {
      return { cacheWrite5mTokens: fiveMin, cacheWrite1hTokens: oneHour };
    }
    return 'ambiguous';
  };
}

/**
 * Flush ONE build-mission sandbox session as a durable receipt, and settle it
 * with the headless CLI's authoritative `total_cost_usd`.
 *
 * TWO granularities, chosen by what the CLI actually reported — never both, so
 * one session's spend can never be receipted twice:
 *
 * 1. PER SERVED MODEL (`modelUsage` present). The result line reports each
 *    served model with its own token counters and its own authoritative
 *    `costUSD`, and `usage.cache_creation` reports the write-tier split. So each
 *    model gets its own receipt with `provider-reported` provenance, complete
 *    counters where the tier attribution is provable, and its own append-only
 *    settlement. The per-model costs sum to the session `total_cost_usd`, so the
 *    session total is deliberately NOT settled again on top.
 *
 * 2. SESSION AGGREGATE (no `modelUsage` — an older CLI). Only cumulative
 *    input/output tokens and a session total exist, so the receipt records
 *    `requested-fallback` provenance (we asked for `plan.model`; nothing
 *    confirmed it) and `partial` completeness, which fails the canonical
 *    ESTIMATE closed to `unavailable`. That is correct, not a gap: pricing
 *    requested-model tokens with no cache split would invent a figure. The real
 *    money arrives as a SETTLEMENT carrying the provider's own total, so the
 *    session still reconciles as a proven actual.
 *
 * Scope is `included-in-parent` on both paths: `buildCostAccounting` already
 * counts this session in the mission headline, so a cross-parent total must not
 * add it twice.
 */
export async function flushBuildSessionUsageReceipt(
  input: BuildSessionUsageReceiptInput
): Promise<BuildSessionUsageReceiptOutcome> {
  const invocationPrefix = `build-${input.missionId}-session-${input.sessionIndex}`;
  const logContext = { missionId: input.missionId, sessionIndex: input.sessionIndex };

  // ---- Path 1: per SERVED model, the finest authoritative granularity. -----
  if (input.modelUsage && Object.keys(input.modelUsage).length > 0) {
    const { flush, settlements } = await flushPerModelUsage({
      missionId: input.missionId,
      owner: input.owner,
      asOf: input.occurredAt,
      modelUsage: input.modelUsage,
      operation: 'anthropic.build-session',
      invocationPrefix,
      evidenceRef: 'claude-code-cli-modelUsage',
      cacheWriteFor: resolveBuildCacheWrite(input.modelUsage, input.cacheCreation),
      logContext,
    });
    // The session `total_cost_usd` is the SUM of these per-model costs. Settling
    // it again against any receipt would double-count the session's actual.
    return { flush, settlement: 'skipped', settlements, granularity: 'per-served-model' };
  }

  // ---- Path 2: session aggregate (older CLI, no per-model breakdown). ------
  const counters: CapturedProviderUsage['counters'] = {};
  if (isNonNegativeInteger(input.inputTokens)) counters.promptTokens = input.inputTokens;
  if (isNonNegativeInteger(input.outputTokens)) counters.outputTokens = input.outputTokens;

  const captured: CapturedProviderUsage = {
    provider: 'anthropic',
    operation: 'anthropic.build-session',
    requestedModel: input.requestedModel,
    // Deliberately absent: without `modelUsage` nothing confirms what was
    // served, so the receipt records requested-fallback provenance rather than
    // claiming the provider confirmed this model.
    providerModel: undefined,
    counters,
    // Never `complete`: with no per-model breakdown there are no cache tiers, so
    // these counters are a known-partial view of what was actually billed.
    usageCompleteness: 'partial',
    occurredAt: input.occurredAt,
    feeState: 'none',
  };

  let flush: FlushResult | undefined;
  try {
    flush = await flushCapturedUsage(
      {
        parentType: 'mission',
        owner: input.owner,
        correlationId: input.missionId,
        missionId: input.missionId,
      },
      [captured],
      // Stable per-session prefix so a durable replay upserts the same receipt
      // and the same accounting-marker batch instead of duplicating either.
      invocationPrefix,
      'included-in-parent'
    );
  } catch (error) {
    log.error(
      'Build session usage receipt flush failed (best-effort, non-fatal)',
      error instanceof Error ? error : new Error(String(error)),
      logContext
    );
    return { flush: undefined, settlement: 'skipped', settlements: {}, granularity: 'session-aggregate' };
  }

  const receipt = flush.receipts[0];
  if (!receipt) return { flush, settlement: 'skipped', settlements: {}, granularity: 'session-aggregate' };

  const settlement = await settleReceiptActual({
    receiptId: receipt.id,
    owner: input.owner,
    costUsd: input.authoritativeCostUsd,
    occurredAt: input.occurredAt,
    evidenceRef: 'claude-code-cli-total_cost_usd',
    logContext,
  });

  return { flush, settlement, settlements: {}, granularity: 'session-aggregate' };
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
