/**
 * @file lib/mission-stage-usage.ts
 * @description ARUN-022 — durable receipts for a mission's AUXILIARY provider stages.
 *
 * `@/lib/mission-usage-receipts` covers the two Anthropic envelopes: the research
 * orchestrator's per-model summary and a build mission's sandbox session. Neither
 * is the whole bill. A research mission ALSO pays Gemini for the dispatch intent
 * classifier, the skill-activation prelude, each revision turn, the LLM quality
 * judge, the report fact-check, and the reflection — every one of them already
 * folded into the mission's headline `costUsd` (see `MissionCostComponent`), and
 * none of them producing a receipt. The ledger could therefore state a mission's
 * total but never reconstruct which stage spent what, and a stage that billed and
 * then failed left no trace at all.
 *
 * This module is the seam that closes that, reusing the existing substrate rather
 * than adding a parallel ledger:
 *   - {@link withMissionStageReceipts} wraps ONE stage, opening the ambient sink so
 *     the Gemini chokepoints capture, and flushing whatever they captured — even
 *     when the stage throws, because spend that happened before a failure is still
 *     real money;
 *   - {@link flushMissionStageUsage} is the capture-now / correlate-later half, for
 *     the dispatch classifier, which bills BEFORE the mission id it belongs to
 *     exists.
 *
 * Scope is always `included-in-parent`: the mission headline already counts these
 * components, so a cross-parent total must add zero for them. The batch prefix is
 * derived from `(missionId, stage, sequence)`, so a stage that legitimately runs
 * twice (a second revision turn) records NEW spend under a distinct batch instead
 * of colliding with the first as a conflict, while an exact replay of one stage is
 * idempotent.
 *
 * Everything here is best-effort and non-fatal: a ledger failure is logged and
 * reported through the returned flush, never thrown into the mission.
 *
 * @author Radarist Team
 * @created 2026-07-29
 */

import 'server-only';
import { createLogger } from '@/lib/logger';
import { BufferingUsageSink, flushCapturedUsage, type FlushResult } from '@/lib/operation-receipt-instrument';
import { runWithOperationUsageSink, type CapturedProviderUsage } from '@/lib/operation-context';

const log = createLogger('mission-stage-usage');

/**
 * The auxiliary provider stages a mission bills for outside the Anthropic SDK run.
 * These mirror `MissionCostComponent` in the mission worker — each one is a real
 * line in the mission's headline cost, so each one earns its own receipt batch.
 */
export type MissionProviderStage = 'classifier' | 'prelude' | 'revision' | 'judge' | 'fact-check' | 'reflection';

export interface MissionStageUsageInput {
  missionId: string;
  /** Accounting owner principal, e.g. `user:<uid>`. */
  owner: string;
  stage: MissionProviderStage;
  /**
   * 0-based ordinal for a stage that can legitimately run more than once in one
   * mission (revision turns). Omitted for once-per-mission stages. Two runs of the
   * same stage are DIFFERENT spend, so they must not share a batch — sharing one
   * would make the second run a conflicting replay of the first and lose it.
   */
  sequence?: number;
}

/**
 * The stable per-stage batch id. Derived only from durable, memoized facts
 * (mission id, stage name, sequence) so an Inngest replay of the same stage targets
 * the same receipts and the same marker slot rather than duplicating either.
 */
export function missionStageInvocationPrefix(
  missionId: string,
  stage: MissionProviderStage,
  sequence?: number
): string {
  return sequence === undefined ? `mission-${missionId}-${stage}` : `mission-${missionId}-${stage}-${sequence}`;
}

/**
 * Flush a set of already-captured stage responses under the mission correlation.
 * Returns `undefined` when there was nothing to record (no provider call happened —
 * a real nothing, so no marker is written) or when the flush itself failed.
 */
export async function flushMissionStageUsage(
  input: MissionStageUsageInput,
  captured: readonly CapturedProviderUsage[]
): Promise<FlushResult | undefined> {
  if (captured.length === 0) return undefined;
  try {
    return await flushCapturedUsage(
      {
        parentType: 'mission',
        owner: input.owner,
        correlationId: input.missionId,
        missionId: input.missionId,
      },
      captured,
      missionStageInvocationPrefix(input.missionId, input.stage, input.sequence),
      // The mission headline already rolls this stage into `costUsd`, so a
      // cross-parent aggregate must add ZERO for it.
      'included-in-parent'
    );
  } catch (error) {
    log.error(
      'Mission stage receipt flush failed (best-effort, non-fatal)',
      error instanceof Error ? error : new Error(String(error)),
      { missionId: input.missionId, stage: input.stage, captured: captured.length }
    );
    return undefined;
  }
}

/**
 * Run ONE mission stage with the ambient usage sink open and flush everything its
 * provider chokepoints captured.
 *
 * `run`'s errors propagate UNCHANGED — a stage failure must stay a stage failure —
 * but the captures taken before the throw are flushed FIRST, so a judge call that
 * billed and then failed to parse still leaves a receipt. The ledger never breaks
 * the stage: a flush failure yields `flush: undefined` and is logged.
 */
export async function withMissionStageReceipts<T>(
  input: MissionStageUsageInput,
  run: () => Promise<T>
): Promise<{ result: T; flush: FlushResult | undefined }> {
  const sink = new BufferingUsageSink();
  let result: T;
  try {
    result = await runWithOperationUsageSink(sink, run);
  } catch (error) {
    await flushMissionStageUsage(input, [...sink.captured]);
    throw error;
  }
  const flush = await flushMissionStageUsage(input, [...sink.captured]);
  return { result, flush };
}
