/**
 * @file lib/activity/defense-verification-types.ts
 * @description Bounded read-model types and schemas for the Background
 * Verifications activity facet.
 *
 * These types describe what a read-model consumer can see about Defense
 * Minister verification JobRuns without exposing raw input/output, prompts,
 * provider payloads, or unbounded error text.
 */

import { z } from 'zod';
import type { JobStatus } from '@/lib/inngest/observability';
import type { VerificationOutputFieldName } from '@/lib/verification-output-contract';
import {
  OPERATION_ACCOUNTING_STATES,
  type OperationAccountingReason,
  type OperationAccountingState,
} from '@/lib/operation-accounting-summary';

export const DEFENSE_VERIFICATION_KINDS = ['entity', 'edge'] as const;
export type DefenseVerificationKind = (typeof DEFENSE_VERIFICATION_KINDS)[number];

export type DefenseVerificationStatus = JobStatus;

export const defenseVerificationPartialReasons = [
  'no-receipts',
  'no-graph-result',
  'ambiguous-graph-result',
  'mismatched-graph-result',
  'incomplete-accounting',
  'mixed-currency',
  'conflicted-settlement',
  'fee-unaccounted',
  'dependency-outage',
  'malformed-output',
  'hostile-output',
  'orphan-target',
] as const;

export type DefenseVerificationPartialReason = (typeof defenseVerificationPartialReasons)[number];

/**
 * The facet does NOT own a cost vocabulary. Cost states come from the ONE
 * canonical ledger roll-up (`@/lib/operation-accounting-summary`) so Defense,
 * Agent Runs, and Builds cannot drift into three different meanings of
 * "settled" or "incomplete". Re-exported (not redeclared), so adding a state
 * there surfaces here rather than silently diverging.
 */
export const defenseVerificationCostStates = OPERATION_ACCOUNTING_STATES;

export type DefenseVerificationCostState = OperationAccountingState;

/**
 * Every canonical accounting reason must be representable as a facet partial
 * reason, so a money defect can never be silently dropped on the way to the UI.
 * A new canonical reason fails this assignment until it is added above.
 */
type AccountingReasonsAreRepresentable = OperationAccountingReason extends DefenseVerificationPartialReason
  ? true
  : never;
const _accountingReasonsAreRepresentable: AccountingReasonsAreRepresentable = true;
void _accountingReasonsAreRepresentable;

export interface DefenseVerificationCost {
  state: DefenseVerificationCostState;
  /** ISO-4217 currency code, only present when the state can name one. */
  currency?: string;
  /** Integer micro-units (1 USD = 1_000_000), only when an amount is provable. */
  amountMicros?: number;
  /** Human-readable, already-localized display string. Never returns raw `$0`. */
  display: string;
}

export interface DefenseVerificationTargetSubIds {
  sourceEntityId?: string;
  targetEntityId?: string;
}

export interface DefenseVerificationRow {
  /** Durable JobRun id: `inngest-${runId}` */
  id: string;
  kind: DefenseVerificationKind;
  status: DefenseVerificationStatus;
  /** 1-based attempt count (`retryCount + 1`). */
  attempts: number;
  /** Epoch millis when the run started, or null if the doc is malformed. */
  startedAt: number | null;
  /** Epoch millis when the run completed, undefined if still running. */
  completedAt?: number;
  /** Wall-clock duration in millis, undefined when not computable. */
  durationMs?: number;
  /** Target kind only when the JobRun output proves it. */
  targetKind?: DefenseVerificationKind;
  /** Target id only when proven (entityId or relationId). */
  targetId?: string;
  /** For edge verifications, the endpoint entity ids when proven. */
  targetSubIds?: DefenseVerificationTargetSubIds;
  /** VerificationResult id only when exact correlation + target validation succeeds. */
  resultId?: string;
  /** Graph result status only when resultId is proven. */
  resultStatus?: 'verified' | 'unverified' | 'disputed';
  /** Graph result score only when resultId is proven. */
  resultScore?: number;
  /** Distinct providers actually billed, from receipts. */
  providers: string[];
  /** Distinct served models, from receipts (excludes unreported). */
  models: string[];
  /** Verifier pipeline version from JobRun output; never a provider model. */
  verifierModel?: string;
  /** Cost/scope summary for this verification run. */
  cost: DefenseVerificationCost;
  /** One primary degradation reason, or undefined when the row is fully proven. */
  partialReason?: DefenseVerificationPartialReason;
  /**
   * OBS-007 — the output fields that were present but unreadable, named from the
   * shared contract's closed field list (never echoed from the payload).
   *
   * Separate from `partialReason` on purpose: a row can have an unreadable score
   * AND a missing graph result, and an operator needs to see both rather than
   * whichever one wins the single primary-reason slot.
   */
  degradedFields?: VerificationOutputFieldName[];
  /** Sanitized, bounded terminal error message; never a stack trace. */
  errorMessage?: string;
}

export interface DefenseVerificationListPage {
  verifications: DefenseVerificationRow[];
  nextCursor: string | null;
}

export interface ListDefenseVerificationsInput {
  /**
   * Owner principal to use for accounting joins. Defense verification runs
   * are system-principal (`user:system`) because `verify-entity`/`verify-edge`
   * record receipts/markers under that principal. The caller's uid is for
   * authentication only; it is never inserted into an accounting predicate.
   */
  accountingOwner: string;
  kind?: DefenseVerificationKind;
  status?: DefenseVerificationStatus;
  cursor?: string;
  limit?: number;
}

export const listDefenseVerificationsQuerySchema = z.object({
  kind: z.enum(DEFENSE_VERIFICATION_KINDS).optional(),
  status: z.enum(['running', 'completed', 'failed', 'retrying', 'cancelled'] as const).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export type ListDefenseVerificationsQuery = z.infer<typeof listDefenseVerificationsQuerySchema>;
