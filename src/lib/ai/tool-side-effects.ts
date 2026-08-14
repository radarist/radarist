/**
 * @file lib/ai/tool-side-effects.ts
 * @description AI-047 — the one contract for proving a write-classified tool
 * mutated nothing.
 *
 * The chat loop classifies every tool by its permission scope, so a failing
 * `write`/`delete`/`signals`/`admin` tool is treated as a POSSIBLE uncontrolled
 * mutation: the turn stops, the tool is never retried, and the operator sees a
 * generic "something may have changed" warning. That conservative default is
 * correct for genuine mid-write ambiguity and must stay.
 *
 * It was wrong for the far more common case: a tool that refused or failed
 * BEFORE its first mutating call. Nothing had changed, the real cause (a bad
 * id, an unauthorized turn, a machine principal) was discarded, and the rest of
 * the turn was thrown away.
 *
 * A caller cannot tell those apart by inspecting a result — only the tool knows
 * where it stopped. So the tool emits the proof, on the shared
 * {@link ToolResult.noMutation} field, and the route reads it. No proof means
 * "unknown", which keeps the conservative path. Proof is never inferred from an
 * error string, an error class, or the absence of a mutation mapping.
 *
 * @author Radarist Team
 * @created 2026-07-27
 */

import type { PreWriteRefusalStage, ToolNoMutationProof, ToolResult } from '@/lib/ai/tools/tool-result';

export type { PreWriteRefusalStage, ToolNoMutationProof };

/**
 * Stages where the platform DECLINED by policy rather than failed to act.
 *
 * The distinction matters downstream (AI-042): an authorization or principal
 * refusal is a correct, designed outcome of the turn, while a validation,
 * lookup, or unexpected pre-write stop is an operation that did not happen.
 */
const POLICY_REFUSAL_STAGES: ReadonlySet<PreWriteRefusalStage> = new Set<PreWriteRefusalStage>([
  'authorization',
  'principal',
]);

export function isPolicyRefusalStage(stage: PreWriteRefusalStage): boolean {
  return POLICY_REFUSAL_STAGES.has(stage);
}

/** The proof value itself, for tools that build their result literal inline. */
export function noMutationProof(stage: PreWriteRefusalStage): ToolNoMutationProof {
  return { mutationAttempted: false, stage };
}

/**
 * Build a failed tool result that PROVES no mutation was attempted.
 *
 * `error` is the actionable operator-facing cause and is preserved verbatim —
 * replacing it with a generic message is exactly the defect this closes.
 */
export function preWriteRefusal(
  stage: PreWriteRefusalStage,
  init: { error: string; message?: string; data?: unknown }
): ToolResult {
  return {
    success: false,
    error: init.error,
    ...(init.message === undefined ? {} : { message: init.message }),
    ...(init.data === undefined ? {} : { data: init.data }),
    noMutation: noMutationProof(stage),
  };
}

export interface MutationLatch {
  /** Wraps a mutating call; opening the latch is what marks the tool as having written. */
  mutating: <T>(run: () => Promise<T>) => Promise<T>;
  attempted: () => boolean;
}

/**
 * AI-047 — a latch a write executor opens immediately before its first mutating
 * call, and only then.
 *
 * Its value inside the executor's outer catch is the ONLY evidence that a thrown
 * failure happened before any durable state changed. Wrapping the call (rather
 * than setting a bare boolean near it) means a future edit cannot add a mutation
 * that silently inherits a stale "nothing was written" claim.
 */
export function createMutationLatch(): MutationLatch {
  let attempted = false;
  return {
    mutating: (run) => {
      attempted = true;
      return run();
    },
    attempted: () => attempted,
  };
}

/**
 * The proof to attach to a thrown pre-write failure, or `undefined` once a
 * mutation was attempted (state is genuinely unknown — stay conservative).
 */
export function thrownFailureProof(latch: Pick<MutationLatch, 'attempted'>): { noMutation?: ToolNoMutationProof } {
  return latch.attempted() ? {} : { noMutation: noMutationProof('unexpected') };
}

/**
 * Read a tool's own no-mutation proof. Accepts only the exact literal shape —
 * a truthy `mutationAttempted` or an unknown stage is NOT proof of anything.
 */
export function readNoMutationProof(result: unknown): ToolNoMutationProof | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const proof = (result as { noMutation?: unknown }).noMutation;
  if (typeof proof !== 'object' || proof === null) return undefined;
  const { mutationAttempted, stage } = proof as { mutationAttempted?: unknown; stage?: unknown };
  if (mutationAttempted !== false) return undefined;
  if (
    stage !== 'validation' &&
    stage !== 'lookup' &&
    stage !== 'authorization' &&
    stage !== 'principal' &&
    stage !== 'unexpected'
  ) {
    return undefined;
  }
  return { mutationAttempted: false, stage };
}

/** True when the tool proved it wrote nothing, whatever the reason. */
export function provesNoMutation(result: unknown): boolean {
  return readNoMutationProof(result) !== undefined;
}
