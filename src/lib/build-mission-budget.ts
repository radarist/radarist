/**
 * @file build-mission-budget.ts
 * @description The single cumulative-spend authority for build missions (AUDIT-016).
 *
 * A build mission is the only thing in Radarist that spends real money against a
 * raw Anthropic key, and its spend accrues along THREE axes that used to be
 * bounded independently:
 *
 *   1. sessions within one supervisor run  → bounded by `cfg.sessions.maxCostUsd`
 *   2. top-ups granted at the human budget gate → each raises `budget.capUsd`
 *   3. Iterate turns that re-dispatch the supervisor → each ALSO raises `capUsd`
 *
 * Nothing bounded their SUM. The supervisor re-initialised its `spentUsd`
 * counter to 0 on every invocation, so iteration N began with a zeroed counter
 * against a cap that iteration N-1 had just raised: the mission-level gate could
 * never fire, and cumulative spend was unbounded in the number of iterations.
 *
 * This module owns the one ceiling nothing may cross. It is deliberately pure
 * and dependency-free so the supervisor (an Inngest worker) and the iterate core
 * can share it without either pulling the other's imports in.
 *
 * NOTE ON WHAT THE CEILING ACTUALLY BOUNDS: before detached work launches, the
 * supervisor transactionally charges the session's full authorized envelope.
 * Finalization reconciles that reserve to provider-reported spend; a missing or
 * invalid result retains the full reserve. Provider last-call overshoot can still
 * exceed the envelope, but it is recorded and blocks publication above the cap.
 */

/** Cumulative USD a single build mission may spend across ALL sessions, top-ups and iterations. */
export const DEFAULT_BUILD_MISSION_HARD_CAP_USD = 150;

/**
 * The cumulative ceiling, overridable per-deployment.
 *
 * Read from the environment on every call rather than captured at module load:
 * the Inngest worker and the Next server initialise this module at different
 * times, and a value frozen at import would silently ignore a `.env` change in
 * one of them.
 */
export function getBuildMissionHardCapUsd(): number {
  const raw = process.env.IMPULSE_BUILD_MISSION_HARD_CAP_USD;
  if (!raw) return DEFAULT_BUILD_MISSION_HARD_CAP_USD;
  const parsed = Number(raw);
  // Fail SAFE, not open: an unparseable or non-positive override must not become
  // "no ceiling". Fall back to the default rather than trusting the operator.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BUILD_MISSION_HARD_CAP_USD;
  return parsed;
}

/** Clamp any proposed cap to the cumulative ceiling. */
export function clampCapUsd(capUsd: number, hardCapUsd = getBuildMissionHardCapUsd()): number {
  if (!Number.isFinite(capUsd) || capUsd <= 0) return 0;
  return Math.min(capUsd, hardCapUsd);
}

/**
 * Budget still available to spend. Never negative, never NaN.
 *
 * A `NaN`/absent input yields 0 (refuse to launch) rather than `NaN` — a NaN
 * remaining would flow into `Math.min` at the launch site, produce a NaN
 * `maxBudgetUsd`, and make the sandbox drop the `--max-budget-usd` flag
 * entirely. That is precisely the fail-open this module exists to prevent.
 */
export function remainingBudgetUsd(capUsd: number, spentUsd: number): number {
  if (!Number.isFinite(capUsd) || !Number.isFinite(spentUsd)) return 0;
  return Math.max(0, capUsd - spentUsd);
}

export interface IterateBudget {
  /** The mission's new cap — always ≤ the hard ceiling. */
  capUsd: number;
  /** Spend the iteration may actually make. `0` ⇒ the iteration must be refused. */
  headroomUsd: number;
  /** True when the mission has no room left to iterate under the ceiling. */
  exhausted: boolean;
}

/**
 * Grant an Iterate turn NEW headroom, bounded by the cumulative ceiling.
 *
 * The old behaviour was `capUsd = priorCap + additional`, monotonic and
 * unbounded. Two changes:
 *
 *   - the new cap is based on `max(priorCap, priorSpent)`, so when a run
 *     overshot its cap the top-up buys genuinely new room instead of first
 *     back-filling spend that already happened;
 *   - the result is clamped to the ceiling, and an iteration with no room left
 *     is reported `exhausted` so the caller can REFUSE it rather than dispatch a
 *     mission that would immediately hit the gate.
 */
export function resolveIterateBudget(input: {
  priorCapUsd: number;
  priorSpentUsd: number;
  additionalUsd: number;
  hardCapUsd?: number;
}): IterateBudget {
  const hardCapUsd = input.hardCapUsd ?? getBuildMissionHardCapUsd();
  const priorCap = Number.isFinite(input.priorCapUsd) ? Math.max(0, input.priorCapUsd) : 0;
  const priorSpent = Number.isFinite(input.priorSpentUsd) ? Math.max(0, input.priorSpentUsd) : 0;
  const additional = Number.isFinite(input.additionalUsd) ? Math.max(0, input.additionalUsd) : 0;

  const capUsd = Math.min(hardCapUsd, Math.max(priorCap, priorSpent) + additional);
  const headroomUsd = remainingBudgetUsd(capUsd, priorSpent);
  return { capUsd, headroomUsd, exhausted: headroomUsd <= 0 };
}

/**
 * The accounting-relevant projection of a persisted build session record.
 *
 * The runtime deliberately persists a reservation record before launch and a
 * second completion record after the provider returns. Keeping this structural
 * interface here lets the accounting derivation remain dependency-free while
 * accepting the canonical mission session records without a conversion layer.
 */
export interface BuildCostSessionRecord {
  index: number;
  reservedCostUsd?: number;
  endedAt?: string;
  costUsd?: number;
  costEstimated?: boolean;
}

/**
 * A truth-preserving build-cost snapshot.
 *
 * `trackedSpendUsd` is observed or explicitly estimated spend. It never
 * includes a reservation merely because the process was authorized to spend
 * it. `maximumExposureUsd` is the fail-safe budget number and includes every
 * still-active or terminal-but-unsettled envelope.
 */
export interface BuildCostAccountingSnapshot {
  /** Provider-reported terminal cost. */
  settledActualUsd: number;
  /** Terminal cost explicitly marked as an estimate. */
  estimatedUsd: number;
  /** Envelopes held by sessions that may still be running. */
  activeReservedUsd: number;
  /** Maximum exposure of terminal sessions whose actual cost is unavailable. */
  unsettledMaximumUsd: number;
  /** Actual plus estimated cost; reservations are intentionally excluded. */
  trackedSpendUsd: number;
  /** Fail-safe authority consumption used to calculate remaining headroom. */
  maximumExposureUsd: number;
  /** Session indexes for which no reliable terminal cost is available. */
  unavailableSessionCount: number;
  /** Malformed or contradictory session indexes that were failed closed. */
  invalidSessionIndexes: number[];
}

interface NormalizedCompletion {
  kind: 'actual' | 'estimated' | 'unavailable';
  costUsd?: number;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function completionKey(completion: NormalizedCompletion): string {
  return completion.kind === 'unavailable' ? completion.kind : `${completion.kind}:${completion.costUsd}`;
}

/**
 * Derive accounting buckets from the append-only session ledger.
 *
 * The derivation is idempotent by session index: identical Inngest/provider
 * replays collapse to one reservation and one completion. Contradictory
 * replays never choose a convenient number; the session is moved to the
 * unavailable/unsettled bucket and its largest known envelope is retained for
 * budget safety. A reservation-only session is active while the mission is in
 * flight and becomes unsettled (not settled spend) after stop/cancel/crash.
 */
export function deriveBuildCostAccounting(
  sessions: ReadonlyArray<BuildCostSessionRecord>,
  options: { terminal: boolean }
): BuildCostAccountingSnapshot {
  const byIndex = new Map<number, BuildCostSessionRecord[]>();
  for (const session of sessions) {
    if (!Number.isSafeInteger(session.index) || session.index < 0) {
      throw new Error('Build cost ledger contains an invalid session index');
    }
    const records = byIndex.get(session.index) ?? [];
    records.push(session);
    byIndex.set(session.index, records);
  }

  let settledActualUsd = 0;
  let estimatedUsd = 0;
  let activeReservedUsd = 0;
  let unsettledMaximumUsd = 0;
  let unavailableSessionCount = 0;
  const invalidSessionIndexes: number[] = [];

  for (const [index, records] of [...byIndex.entries()].sort(([left], [right]) => left - right)) {
    const reservationRecords = records.filter((record) => record.endedAt === undefined);
    const completionRecords = records.filter((record) => record.endedAt !== undefined);

    const validReservationAmounts = reservationRecords
      .map((record) => record.reservedCostUsd)
      .filter(isNonNegativeFinite)
      .filter((amount) => amount > 0);
    const distinctReservationAmounts = new Set(validReservationAmounts);
    const reservationUsd = validReservationAmounts.length > 0 ? Math.max(...validReservationAmounts) : 0;

    let invalid =
      reservationRecords.some(
        (record) => !isNonNegativeFinite(record.reservedCostUsd) || record.reservedCostUsd <= 0
      ) || distinctReservationAmounts.size > 1;

    const completions: NormalizedCompletion[] = completionRecords.map((record) => {
      if (!isNonNegativeFinite(record.costUsd)) {
        if (record.costUsd !== undefined) invalid = true;
        return { kind: 'unavailable' };
      }
      return record.costEstimated
        ? { kind: 'estimated', costUsd: record.costUsd }
        : { kind: 'actual', costUsd: record.costUsd };
    });
    const distinctCompletions = new Map(completions.map((completion) => [completionKey(completion), completion]));
    if (distinctCompletions.size > 1) invalid = true;

    const completion = distinctCompletions.values().next().value as NormalizedCompletion | undefined;
    if (completion?.kind === 'estimated' && reservationUsd > 0 && completion.costUsd !== reservationUsd) {
      invalid = true;
    }

    // A record that is neither a valid reservation nor a completion cannot be
    // interpreted safely, including historical partial writes.
    if (reservationRecords.length === 0 && completionRecords.length === 0) invalid = true;

    if (invalid) {
      const largestClaimedCost = Math.max(
        reservationUsd,
        ...completions.map((item) => item.costUsd ?? 0)
      );
      unsettledMaximumUsd += largestClaimedCost;
      unavailableSessionCount += 1;
      invalidSessionIndexes.push(index);
      continue;
    }

    if (completion?.kind === 'actual') {
      settledActualUsd += completion.costUsd!;
      continue;
    }
    if (completion?.kind === 'estimated') {
      estimatedUsd += completion.costUsd!;
      continue;
    }
    if (completion?.kind === 'unavailable') {
      unsettledMaximumUsd += reservationUsd;
      unavailableSessionCount += 1;
      continue;
    }
    if (reservationUsd > 0) {
      if (options.terminal) {
        unsettledMaximumUsd += reservationUsd;
        unavailableSessionCount += 1;
      } else {
        activeReservedUsd += reservationUsd;
      }
      continue;
    }

    // Legacy/malformed session with no usable reservation or completion.
    unavailableSessionCount += 1;
    invalidSessionIndexes.push(index);
  }

  const trackedSpendUsd = settledActualUsd + estimatedUsd;
  const maximumExposureUsd = trackedSpendUsd + activeReservedUsd + unsettledMaximumUsd;
  return {
    settledActualUsd,
    estimatedUsd,
    activeReservedUsd,
    unsettledMaximumUsd,
    trackedSpendUsd,
    maximumExposureUsd,
    unavailableSessionCount,
    invalidSessionIndexes,
  };
}
