/**
 * @file lib/mission-usage.ts
 * @description ARUN-020 — the ONE authoritative usage snapshot for a mission
 * document. Build missions persist disjoint actual, estimated, reserved, and
 * unsettled buckets on their own `missions` doc (authority is reserved before
 * launch; tokens and actual cost reconcile at session finalization), and
 * several independent surfaces render or aggregate
 * that spend: the `/agents/runs` list rows, the run detail Details card, and
 * the daily token/cost summaries. Before this module each surface re-derived
 * usage inline (some fabricating 0 for unpersisted values), so a running build
 * could show zero tokens in the list while its detail header showed real spend.
 *
 * Pure module — no Firebase/React imports — safe for client row mappers and
 * the admin-SDK aggregation code alike.
 */

import type { Mission } from '@/lib/schemas/mission';

export interface MissionUsageSnapshot {
  /** Total persisted tokens, or undefined when the doc has no tokenUsage yet
   * (display surfaces render "—"/"Unavailable" — never a fabricated 0). */
  tokens: number | undefined;
  /** Zero-defaulted input tokens for additive aggregation (daily buckets). */
  input: number;
  /** Zero-defaulted output tokens for additive aggregation (daily buckets). */
  output: number;
  /** Observed or explicitly estimated spend, excluding reserved/unsettled authority. */
  costUsd: number | undefined;
  settledCostUsd: number | undefined;
  estimatedCostUsd: number | undefined;
  reservedCostUsd: number | undefined;
  unsettledMaximumUsd: number | undefined;
  maximumExposureUsd: number | undefined;
  /** True when at least one cost component cannot be stated exactly. */
  costUnavailable: boolean;
  /**
   * ARUN-027 — WHY a component cannot be stated, when the doc can prove it.
   *
   * `accounting-incomplete` is set ONLY when accounting exists and is provably
   * partial: a persisted `buildCostAccounting` that fails read-boundary
   * validation, or one that itself reports unavailable/invalid sessions. Both
   * mean real spend occurred that the ledger cannot fully reconstruct.
   *
   * It is deliberately ABSENT when there is simply no accounting basis at all
   * (a legacy doc, or a mission that never recorded a cost). "We have no record"
   * is not the same claim as "our record is provably missing spend", and
   * over-reporting the latter would cry wolf on every legacy row.
   */
  costUnavailableReason?: 'accounting-incomplete';
  /**
   * ARUN-020 — `tokens` is the mission's RUNNING total, not a terminal one: no
   * finalized `tokenUsage` has landed yet, so the figure will still move. The
   * per-direction `input`/`output` buckets stay 0 for it, because the budget
   * accumulator tracks one number and splitting it would be invented.
   */
  tokensProvisional: boolean;
}

type MissionUsageInput = Pick<Mission, 'tokenUsage' | 'costUsd' | 'kind'> & {
  runningTokensUsed?: number;
  buildCostAccounting?: unknown;
};

/**
 * The mission's best token total and whether it is still moving.
 *
 * A finalized `tokenUsage` wins outright. Otherwise the running total the
 * worker persists every five tool calls (ARUN-020) is the honest in-flight
 * answer — durable, so the Runs list and the run detail read the identical
 * number instead of one of them lending an ephemeral heartbeat the other never
 * saw. With neither, the count is genuinely unknown and stays undefined.
 */
function missionTokenTotal(mission: MissionUsageInput): { tokens: number | undefined; provisional: boolean } {
  if (mission.tokenUsage) {
    return { tokens: mission.tokenUsage.input + mission.tokenUsage.output, provisional: false };
  }
  if (nonNegativeFinite(mission.runningTokensUsed)) {
    return { tokens: mission.runningTokensUsed, provisional: true };
  }
  return { tokens: undefined, provisional: false };
}

interface BuildCostAccountingRead {
  settledActualUsd: number;
  estimatedUsd: number;
  activeReservedUsd: number;
  unsettledMaximumUsd: number;
  trackedSpendUsd: number;
  maximumExposureUsd: number;
  unavailableSessionCount: number;
  invalidSessionIndexes: number[];
  observedAt: string;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Read-boundary validation: malformed accounting becomes unavailable, never $0. */
function readBuildCostAccounting(value: unknown): BuildCostAccountingRead | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const numeric = [
    raw.settledActualUsd,
    raw.estimatedUsd,
    raw.activeReservedUsd,
    raw.unsettledMaximumUsd,
    raw.trackedSpendUsd,
    raw.maximumExposureUsd,
  ];
  if (numeric.some((item) => !nonNegativeFinite(item))) return undefined;
  if (!Number.isSafeInteger(raw.unavailableSessionCount) || (raw.unavailableSessionCount as number) < 0) {
    return undefined;
  }
  if (
    !Array.isArray(raw.invalidSessionIndexes) ||
    raw.invalidSessionIndexes.some((index) => !Number.isSafeInteger(index) || (index as number) < 0) ||
    typeof raw.observedAt !== 'string' ||
    Number.isNaN(Date.parse(raw.observedAt))
  ) {
    return undefined;
  }
  const accounting = raw as unknown as BuildCostAccountingRead;
  if (
    accounting.trackedSpendUsd !== accounting.settledActualUsd + accounting.estimatedUsd ||
    accounting.maximumExposureUsd !==
      accounting.trackedSpendUsd + accounting.activeReservedUsd + accounting.unsettledMaximumUsd
  ) {
    return undefined;
  }
  return accounting;
}

/**
 * The single read rule for a mission doc's usage. A persisted `{0,0}` is a
 * real measurement and stays 0; an ABSENT tokenUsage is unknown and surfaces
 * as undefined tokens (aggregation reads the zero-defaulted input/output).
 */
export function missionUsageSnapshot(mission: MissionUsageInput): MissionUsageSnapshot {
  const input = mission.tokenUsage?.input ?? 0;
  const output = mission.tokenUsage?.output ?? 0;
  const total = missionTokenTotal(mission);
  if (mission.kind === 'build') {
    if (mission.buildCostAccounting !== undefined) {
      const accounting = readBuildCostAccounting(mission.buildCostAccounting);
      if (!accounting) {
        return {
          tokens: total.tokens,
          tokensProvisional: total.provisional,
          input,
          output,
          costUsd: undefined,
          settledCostUsd: undefined,
          estimatedCostUsd: undefined,
          reservedCostUsd: undefined,
          unsettledMaximumUsd: undefined,
          maximumExposureUsd: undefined,
          costUnavailable: true,
          // Accounting WAS persisted and failed validation: the ledger exists
          // and is corrupt, which is provable incompleteness, not absence.
          costUnavailableReason: 'accounting-incomplete',
        };
      }
      const sessionsUnaccounted = accounting.unavailableSessionCount > 0 || accounting.invalidSessionIndexes.length > 0;
      return {
        tokens: total.tokens,
        tokensProvisional: total.provisional,
        input,
        output,
        costUsd: accounting.trackedSpendUsd,
        settledCostUsd: accounting.settledActualUsd,
        estimatedCostUsd: accounting.estimatedUsd,
        reservedCostUsd: accounting.activeReservedUsd,
        unsettledMaximumUsd: accounting.unsettledMaximumUsd,
        maximumExposureUsd: accounting.maximumExposureUsd,
        costUnavailable: sessionsUnaccounted,
        // The accounting itself reports sessions whose cost it could not state.
        ...(sessionsUnaccounted ? { costUnavailableReason: 'accounting-incomplete' as const } : {}),
      };
    }

    // A pre-BUILD-035 total is authority consumed, but its accounting basis is
    // unknowable. Preserve it only as maximum unsettled exposure and never use
    // status to relabel it as reserved or settled.
    const legacyExposure = nonNegativeFinite(mission.costUsd) ? mission.costUsd : undefined;
    return {
      tokens: total.tokens,
      tokensProvisional: total.provisional,
      input,
      output,
      costUsd: undefined,
      settledCostUsd: undefined,
      estimatedCostUsd: undefined,
      reservedCostUsd: undefined,
      unsettledMaximumUsd: legacyExposure,
      maximumExposureUsd: legacyExposure,
      costUnavailable: true,
    };
  }

  const measuredCost = nonNegativeFinite(mission.costUsd) ? mission.costUsd : undefined;
  return {
    tokens: total.tokens,
    tokensProvisional: total.provisional,
    input,
    output,
    costUsd: measuredCost,
    settledCostUsd: measuredCost,
    estimatedCostUsd: measuredCost === undefined ? undefined : 0,
    reservedCostUsd: measuredCost === undefined ? undefined : 0,
    unsettledMaximumUsd: measuredCost === undefined ? undefined : 0,
    maximumExposureUsd: measuredCost,
    costUnavailable: measuredCost === undefined,
  };
}

/**
 * The one duration rule for a mission doc, beside the usage snapshot so the
 * derivation can't fork per surface: completed → completedAt − createdAt;
 * in-flight → elapsed age; terminal WITHOUT a completedAt stamp → unknowable
 * (undefined — renderers show "—"/"Unavailable", never a fabricated 0ms).
 */
export function missionDurationMs(mission: Pick<Mission, 'status' | 'createdAt' | 'completedAt'>): number | undefined {
  if (mission.completedAt) {
    return new Date(mission.completedAt).getTime() - new Date(mission.createdAt).getTime();
  }
  const inFlight = mission.status === 'running' || mission.status === 'pending';
  return inFlight ? Date.now() - new Date(mission.createdAt).getTime() : undefined;
}
