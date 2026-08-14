/**
 * AI-051 — bounded control for the interactive chat tool loop.
 *
 * A read-only question can spend every tool iteration gathering relevant graph
 * evidence and return `tool_iterations_exhausted` with **no answer**. Two mechanics
 * produced that outcome, and both live in the loop rather than in any tool:
 *
 * 1. **Nothing ever reserved capacity for the answer.** Every provider call in
 *    the loop offers the full tool catalog, so the model may always ask for one
 *    more tool. When the cap is reached the loop simply stops and the last
 *    response — still a `tool_use` — is discarded. The model is never once put
 *    in a position where it has to write the answer down.
 * 2. **Nothing noticed the model re-asking for data it already had.** The
 *    repeated probes after a system-level result cost a full round trip plus a
 *    permanently larger conversation because the whole history is re-sent.
 *
 * This module is the pure decision layer for both. It adds **no** capacity: the
 * iteration cap is unchanged, and the synthesis turn re-uses the provider call
 * the loop was already going to make, with tools withheld instead of offered.
 *
 * Honesty rules encoded here, not left to the prompt:
 * - synthesis is offered ONLY when at least one tool call actually succeeded
 *   ({@link hasCitableToolEvidence}). With nothing citable the loop keeps its
 *   existing explicit `tool_iterations_exhausted` envelope rather than inviting
 *   the model to invent an answer from failures.
 * - a suppressed duplicate returns the EARLIER result, labelled as a repeat. It
 *   never fabricates a fresh one and never hides that the call was not re-run.
 */

import type { ToolResult } from '@/lib/ai/tools/tool-result';

/** The minimum a caller must expose for loop control to reason about a call. */
export interface LoopToolCall {
  name: string;
  args: Record<string, unknown>;
  result: Pick<ToolResult, 'success'>;
}

/**
 * Stable signature for "the same question asked again".
 *
 * Object keys are sorted recursively so `{a,b}` and `{b,a}` collapse to one
 * signature — the model re-emits arguments in whatever order it composed them,
 * and a key-order-sensitive comparison would miss most real repeats.
 */
export function toolCallSignature(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * The earlier identical call in this turn, if there is one.
 *
 * `alreadyExecuted` is the turn's running receipt list, so this is O(n) over a
 * list the loop already keeps — no extra bookkeeping structure.
 */
export function findDuplicateToolCall<T extends LoopToolCall>(
  alreadyExecuted: readonly T[],
  name: string,
  args: Record<string, unknown>
): T | undefined {
  const signature = toolCallSignature(name, args);
  return alreadyExecuted.find((call) => toolCallSignature(call.name, call.args) === signature);
}

/**
 * Note attached to a suppressed repeat so the model reads the reason rather
 * than inferring the tool became flaky.
 */
export const REPEATED_TOOL_CALL_NOTE =
  'This exact call already ran earlier in this turn; the earlier result is repeated here and the tool was NOT re-run. ' +
  'Do not call it again — use this result, and if it does not answer the question, say what is missing instead of re-querying.';

/**
 * Re-serve a prior result, labelled. The payload is byte-identical to what the
 * model already saw; only the repeat marker and note are added.
 */
export function markRepeatedToolResult(previous: ToolResult): ToolResult {
  return { ...previous, repeatedCall: true, _note: REPEATED_TOOL_CALL_NOTE } as ToolResult;
}

/**
 * Whether this turn holds anything the model could honestly cite.
 *
 * A SUCCESSFUL call counts even when its payload is empty: "the graph was
 * searched and holds nothing about X" is a real, citable finding and is the
 * correct answer to a no-evidence question. A FAILED call never counts — that
 * is the case the explicit incomplete envelope exists for.
 */
export function hasCitableToolEvidence(executed: readonly LoopToolCall[]): boolean {
  return executed.some((call) => call.result.success === true);
}

export type SynthesisReservationReason = 'final-iteration-reserved' | 'duplicate-probe-loop';

export interface SynthesisDecisionInput {
  /** Iterations consumed so far, INCLUDING the batch just executed. */
  iterations: number;
  /** The unchanged per-turn tool-iteration cap. */
  maxIterations: number;
  /** Every tool call executed this turn. */
  executed: readonly LoopToolCall[];
  /** True when every call in the batch just executed was a suppressed repeat. */
  batchWasAllRepeats: boolean;
}

/**
 * Decide whether the provider call the loop is about to make should be the
 * synthesis turn (tools withheld) instead of another tool-offering turn.
 *
 * This never adds a call and never removes one. It changes what the NEXT
 * already-scheduled call is allowed to do.
 *
 * - `final-iteration-reserved` — the cap is reached, so the call that was going
 *   to be thrown away as "still asking for tools" becomes the answer instead.
 * - `duplicate-probe-loop` — the model just re-asked for data it already had,
 *   across the whole batch, while holding citable evidence. Continuing would
 *   spend the remaining iterations restating the same question.
 */
export function decideSynthesisReservation(input: SynthesisDecisionInput): SynthesisReservationReason | null {
  if (!hasCitableToolEvidence(input.executed)) return null;
  if (input.iterations >= input.maxIterations) return 'final-iteration-reserved';
  if (input.batchWasAllRepeats) return 'duplicate-probe-loop';
  return null;
}

/**
 * The bounded directive appended to the conversation for the synthesis turn.
 *
 * It is deliberately restrictive: answer from what is already on the transcript,
 * name the tools the facts came from, and state gaps as gaps. The loop only ever
 * reaches this text with at least one successful tool result in hand.
 */
export function buildSynthesisDirective(reason: SynthesisReservationReason): string {
  const why =
    reason === 'final-iteration-reserved'
      ? 'The tool budget for this turn is now spent.'
      : 'The last tool batch only repeated calls that had already run, so no new evidence is available.';
  return [
    `${why} Answer the user now, using ONLY the tool results already in this conversation. No further tools will run.`,
    '',
    'Requirements for this answer:',
    '- Cite the concrete facts you actually retrieved: name the tool and the specific values, ids, counts or names it returned.',
    '- If the evidence supports only part of the question, answer that part and state plainly which part is unsupported and what would be needed to close it.',
    '- If a tool failed or returned nothing, say so explicitly. Never present an unretrieved value as a fact, and never invent an id, number, date or name.',
    '- Be concise. Lead with the answer, then the evidence behind it.',
  ].join('\n');
}

// ============================================================================
// Payload bounding
// ============================================================================

/**
 * Chars of model-facing tool payload a single turn may accumulate before later
 * results are tightened. The retained failure re-sent an ever-growing transcript
 * on every one of its 16 provider calls, so the cost of one broad graph result
 * is paid once per remaining iteration, not once.
 *
 * This is a CUMULATIVE budget, derived from the turn's own history — not a list
 * of "broad" tool names, which would need hand-maintenance and would miss the
 * next wide tool.
 */
export const CHAT_TOOL_RESULT_TURN_BUDGET_DEFAULT = 120_000;

/**
 * Floor for a tightened result. A late call must still return something the
 * model can read; silently emptying it would look like the tool failed.
 */
export const CHAT_TOOL_RESULT_MIN_CAP = 2_000;

/**
 * The cap to apply to the NEXT model-facing tool payload.
 *
 * Below budget the per-result cap is unchanged, so ordinary turns behave exactly
 * as before. Once the turn has spent its budget every further result is clamped
 * to {@link CHAT_TOOL_RESULT_MIN_CAP} rather than dropped.
 */
export function boundedResultCapForTurn(
  spentChars: number,
  perResultCap: number,
  turnBudget: number = CHAT_TOOL_RESULT_TURN_BUDGET_DEFAULT,
  floor: number = CHAT_TOOL_RESULT_MIN_CAP
): number {
  if (!Number.isFinite(turnBudget) || turnBudget <= 0) return perResultCap;
  const remaining = turnBudget - Math.max(0, spentChars);
  if (remaining >= perResultCap) return perResultCap;
  return Math.max(floor, Math.min(perResultCap, remaining));
}
