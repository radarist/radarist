/**
 * @file lib/ai/chat-turn-outcome.ts
 * @description AI-042 — the chat turn's DURABLE terminal status, derived from
 * exact tool outcomes instead of optimistic loop state.
 *
 * The chat loop used to terminalize every normally-completed turn as
 * `status: 'success'`, whatever its tools actually did. Retained AgentRuns were
 * therefore stamped `success` while their own durable tool summaries listed
 * failed graph searches and failed relation writes: the row that proves what
 * happened contradicted the headline on the same row.
 *
 * This module is the one place that decision is made. It is pure, so it can be
 * exercised directly, and it reads only facts the route already has:
 *
 *   - the per-tool terminal result (success, refusal proof, batch counters),
 *   - the loop's terminal error code, if the turn stopped on one, and
 *   - whether a usable prose answer actually reached the operator.
 *
 * Three outcomes, all encoded on the existing AgentRun contract:
 *
 *   - SUCCESS  — `status: 'success'`. Every operation the turn ran completed,
 *                or declined by design (a spend confirmation, an unauthorized
 *                write, a machine principal). Nothing failed.
 *   - PARTIAL  — `status: 'failure'` + `partial: true`. Something failed, but
 *                the turn still delivered value. Rendered as an amber
 *                "Partial", never as an unqualified success.
 *   - FAILURE  — `status: 'failure'`. The turn stopped on a terminal error, or
 *                everything it attempted failed and no answer was produced.
 *
 * `errors` stays CONTENT-FREE. Tool arguments, results, prompts, document text,
 * and confirmation phrases must never enter AgentRun history (see
 * `chat-tool-summary.ts`), so each entry is a tool name plus its outcome class.
 * The real, actionable error text belongs to the operator's live turn, not to
 * durable history.
 *
 * @author Radarist Team
 * @created 2026-07-27
 */

import type { ToolResult } from '@/lib/ai/tools/tool-result';
import { isPolicyRefusalStage, readNoMutationProof } from '@/lib/ai/tool-side-effects';

/**
 * Exact outcome of one tool call.
 *
 * - `ok` — completed.
 * - `refused` — declined by design; nothing was attempted and nothing broke.
 * - `failed` — the operation did not happen, or its outcome is unknown.
 * - `partial-write` — reported success while its own counters record failures
 *   inside the batch (`{ approved: 3, failed: 2 }`).
 */
export type ChatToolOutcomeClass = 'ok' | 'refused' | 'failed' | 'partial-write';

export interface ChatTurnToolCall {
  name: string;
  result: ToolResult;
}

export interface ChatTurnOutcome {
  status: 'success' | 'failure';
  /** Something failed, but the turn still delivered value. */
  partial: boolean;
  /** Set only alongside `partial`, so the UI never claims a timeout it didn't have. */
  partialReason?: 'tool-failures';
  /** Bounded, content-free reasons. Absent when there is nothing to report. */
  errors?: string[];
}

export interface ChatTurnOutcomeInput {
  toolCalls: readonly ChatTurnToolCall[];
  /** The loop's own terminal error, when it stopped on one. */
  terminalError?: string;
  /**
   * True when the operator received substantive prose for this turn — not the
   * no-synthesis fallback, and not an empty body.
   */
  answerDelivered: boolean;
}

/** Keeps the durable `errors` array bounded regardless of tool-call volume. */
export const MAX_CHAT_TURN_OUTCOME_ERRORS = 12;

/**
 * A batch tool can report `success: true` while part of its batch failed. Those
 * counters are the exact mutation receipt for a multi-write, so they decide the
 * turn's status the same way an outright failure does.
 */
export function batchFailureCount(result: ToolResult): number {
  if (typeof result.data !== 'object' || result.data === null) return 0;
  const failed = (result.data as { failed?: unknown }).failed;
  if (typeof failed === 'number' && Number.isFinite(failed) && failed > 0) return Math.floor(failed);
  if (Array.isArray(failed)) return failed.length;
  return 0;
}

/**
 * A confirmation gate that stopped before dispatching. Recognized for tools
 * that predate the explicit no-mutation proof; `requiresConfirmation` is
 * required, so a bare `dispatched: false` is never read as a policy refusal.
 */
function isConfirmationRefusal(result: ToolResult): boolean {
  if (typeof result.data !== 'object' || result.data === null) return false;
  return (result.data as { requiresConfirmation?: unknown }).requiresConfirmation === true;
}

export function classifyChatToolCall(call: ChatTurnToolCall): ChatToolOutcomeClass {
  const { result } = call;
  if (!result.success) {
    // The tool's own proof wins over any shape heuristic: a validation or
    // lookup refusal proves no write happened, but it is still an operation
    // that did not happen, which a policy refusal is not.
    const proof = readNoMutationProof(result);
    if (proof) return isPolicyRefusalStage(proof.stage) ? 'refused' : 'failed';
    return isConfirmationRefusal(result) ? 'refused' : 'failed';
  }
  return batchFailureCount(result) > 0 ? 'partial-write' : 'ok';
}

function outcomeLabel(call: ChatTurnToolCall, outcome: ChatToolOutcomeClass): string {
  if (outcome === 'partial-write') {
    return `${call.name}: partial-write (${batchFailureCount(call.result)} failed)`;
  }
  return `${call.name}: ${outcome}`;
}

/**
 * Derive the turn's durable terminal status.
 *
 * A terminal loop error is always a failure — including the conservative
 * outcome-uncertain stop, whose whole point is that the state is unknown.
 * Otherwise the tools decide: no failures is a success, and a failure alongside
 * either a completed operation or a delivered answer is partial rather than a
 * flat failure.
 */
export function deriveChatTurnOutcome(input: ChatTurnOutcomeInput): ChatTurnOutcome {
  const classified = input.toolCalls.map((call) => ({ call, outcome: classifyChatToolCall(call) }));
  const failures = classified.filter(({ outcome }) => outcome === 'failed' || outcome === 'partial-write');
  const completed = classified.filter(({ outcome }) => outcome === 'ok');
  const failureLabels = failures.map(({ call, outcome }) => outcomeLabel(call, outcome));

  if (input.terminalError) {
    const errors = [input.terminalError, ...failureLabels].slice(0, MAX_CHAT_TURN_OUTCOME_ERRORS);
    return { status: 'failure', partial: false, errors };
  }

  if (failures.length === 0) {
    return { status: 'success', partial: false };
  }

  const errors = failureLabels.slice(0, MAX_CHAT_TURN_OUTCOME_ERRORS);
  if (completed.length > 0 || input.answerDelivered) {
    return { status: 'failure', partial: true, partialReason: 'tool-failures', errors };
  }
  return { status: 'failure', partial: false, errors };
}
