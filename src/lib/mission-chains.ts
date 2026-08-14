/**
 * @file lib/mission-chains.ts
 * @description Mission chaining (Superpower #2) — multi-step pipelines.
 *
 * Creates a group of related missions that execute in sequence. Step N+1
 * is dispatched automatically when step N completes, with the parent's
 * result substituted into the child's prompt via `{{parent.result}}`.
 *
 * Use cases:
 *   - Scout finds funding rounds → Evaluator scores companies → Creator writes brief
 *   - Ad-hoc "decompose + research + synthesize" pipelines
 *   - Scheduled monitoring chains (later)
 *
 * MVP scope:
 *   - Explicit chains only (user specifies the step list upfront)
 *   - Sequential execution only (no parallel fan-out)
 *   - Hard cap of 5 steps per chain
 *   - If any step fails/times out, downstream steps are NOT auto-dispatched
 */

import { randomUUID } from 'crypto';
import { createMission, type CreateMissionExtras } from './missions';
import { db } from './firebase-admin';
import type { Mission } from './schemas/mission';

const COLLECTION = 'missions';
const MAX_CHAIN_STEPS = 5;

/** Placeholder token substituted with the previous step's result. */
const PARENT_RESULT_TOKEN = /\{\{\s*parent\.result\s*\}\}/g;

export interface ChainStepInput {
  agent: string;
  prompt: string;
  /** Optional design directives carried to the step mission (design-pass). */
  designBrief?: import('@/lib/schemas/design-brief').DesignBriefInput;
  /**
   * OBS-004 — the dispatching sweep cycle, when the chain was sweep-initiated.
   *
   * Unlike `deliverableExtras` (deliberately attached to ONE step so the one-time
   * classifier cost is not double-counted), this link belongs on EVERY step: each
   * step is a separately-billed mission, and a step without the link would spend
   * real money outside its sweep's accounting.
   */
  sweepId?: string;
}

export interface ChainCreationResult {
  chainId: string;
  missions: Mission[];
}

/**
 * Generate a unique chain ID. Keeps the same slug-style shape as mission IDs
 * so they sort well in Firestore index views.
 */
function generateChainId(): string {
  return `chain-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a chain of missions. All mission docs are created in `pending`
 * state. Only step 1's Inngest event is fired immediately — subsequent
 * steps are dispatched by the Inngest handler after their predecessor
 * completes.
 *
 * The caller is responsible for firing step 1's Inngest event via
 * {@link dispatchChainStep} — this function only writes the Firestore
 * docs and returns them so the caller can kick off step 1.
 *
 * OPS-004: `deliverableExtras` (slots + classifierMetadata + authorized cost) is
 * applied to the LAST step — the report-producing mission (e.g. the creator in a
 * scout→creator research chain). Without this, a research-gated dispatch computed
 * the paid classifier metadata but dropped it, so the primary report mission
 * carried no classifierMetadata and onFailure could not fold the classifier spend
 * for that path. Attaching to a single step (never every step) avoids
 * double-counting the one-time classifier cost.
 *
 * AI-053: `perStepExtras` carries what `deliverableExtras` deliberately cannot —
 * the user-authorized execution envelope for EVERY step. An envelope is
 * per-mission: a step created without one falls back to
 * `envelopeSource: 'environment'` in the worker, i.e. it runs on environment
 * defaults, OUTSIDE the amount the user confirmed. Omitting the argument (the
 * sweep and the HTTP route) is byte-identical to the pre-AI-053 3-arg form.
 *
 * @throws Error if steps array is empty, exceeds MAX_CHAIN_STEPS, or if
 *   `perStepExtras` is supplied with a length that does not match `steps`
 */
export async function createChain(
  userId: string,
  steps: ChainStepInput[],
  deliverableExtras: CreateMissionExtras = {},
  perStepExtras?: readonly CreateMissionExtras[]
): Promise<ChainCreationResult> {
  if (steps.length === 0) throw new Error('chain must have at least 1 step');
  if (steps.length > MAX_CHAIN_STEPS) {
    throw new Error(`chain exceeds max of ${MAX_CHAIN_STEPS} steps (got ${steps.length})`);
  }
  // Fail closed on a length mismatch rather than letting `?? {}` below silently
  // de-authorize a step — a step running unauthorized IS the defect AI-053 exists
  // to remove, and it is invisible at runtime once created.
  if (perStepExtras !== undefined && perStepExtras.length !== steps.length) {
    throw new Error(
      `perStepExtras length ${perStepExtras.length} does not match the ${steps.length}-step chain; ` +
        'a step without its authorized execution envelope would run on environment defaults'
    );
  }

  const chainId = generateChainId();
  const missions: Mission[] = [];
  const deliverableStepIndex = steps.length - 1;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const mission = await createMission(
      userId,
      {
        agent: step.agent,
        prompt: step.prompt,
        ...(step.designBrief ? { designBrief: step.designBrief } : {}),
        ...(step.sweepId ? { sweepId: step.sweepId } : {}),
      },
      // Key spaces are disjoint by contract: cost fields per step,
      // slots/classifierMetadata on the deliverable. On any future collision the
      // deliverable wins, because it is spread last.
      {
        ...(perStepExtras?.[i] ?? {}),
        ...(i === deliverableStepIndex ? deliverableExtras : {}),
      }
    );

    // Attach chain metadata to the freshly created mission doc.
    const chainUpdate: Partial<Mission> = {
      chainId,
      chainStep: i + 1,
      chainTotalSteps: steps.length,
    };
    if (i > 0) {
      // parentMissionId points to the immediately preceding mission; filled in
      // once that mission's ID is known (which it is — we created it just above).
      chainUpdate.parentMissionId = missions[i - 1].id;
    }

    await db.collection(COLLECTION).doc(mission.id).update(chainUpdate);
    missions.push({ ...mission, ...chainUpdate });
  }

  return { chainId, missions };
}

/**
 * Find the next pending mission in the same chain (step N+1) and return its
 * Firestore document. Returns null if the current mission is the last step
 * or if no successor exists.
 */
export async function findNextChainStep(currentMission: Mission): Promise<Mission | null> {
  if (!currentMission.chainId || !currentMission.chainStep) return null;
  if (currentMission.chainTotalSteps !== undefined && currentMission.chainStep >= currentMission.chainTotalSteps) {
    return null; // already at the last step
  }

  const snapshot = await db
    .collection(COLLECTION)
    .where('chainId', '==', currentMission.chainId)
    .where('chainStep', '==', currentMission.chainStep + 1)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return snapshot.docs[0].data() as Mission;
}

/**
 * Substitute `{{parent.result}}` placeholder in a step's prompt with the
 * parent mission's result. No-op if the prompt doesn't contain the token.
 *
 * The substitution is literal-text — no recursive templating or shell
 * escaping. Parent result is capped at 32KB to avoid ballooning the
 * child's context.
 */
export function renderPromptWithParent(prompt: string, parentResult?: string): string {
  if (!PARENT_RESULT_TOKEN.test(prompt)) return prompt;
  const cappedResult = (parentResult ?? '').slice(0, 32 * 1024);
  // reset the regex's lastIndex before replace() to avoid state issues with /g
  PARENT_RESULT_TOKEN.lastIndex = 0;
  return prompt.replace(PARENT_RESULT_TOKEN, cappedResult);
}

/**
 * Minimum L2 quality score required to advance a chain. Scout research bundles
 * below this threshold are caught by the L2 judge as fabricated/unreliable;
 * advancing to the creator step in that case produces a confident report built
 * on fiction. When the L2 judgement is absent (sample-rate pruning, API outage,
 * trivial prompts) we fall back to L1's verdict — L1 FAIL halts, L1 REVISE
 * advances.
 */
export const QUALITY_HALT_THRESHOLD = 0.6;

/**
 * Whether a mission's outcome allows the chain to continue. Halts on any of:
 *   - status !== 'completed' (failed or still running)
 *   - partial === true (timed out, partial recovery promoted)
 *   - L2 quality judge present and overallScore < QUALITY_HALT_THRESHOLD
 *   - L1 qualityReport.verdict === 'FAIL' (always, regardless of L2 presence)
 *
 * L1 and L2 serve different purposes: L2 is a broad semantic score, L1 critical
 * checks are narrow deterministic gates on specific violations (malformed
 * bundle, padded citations). A high L2 score does not excuse an L1 critical
 * failure — the structural check caught a concrete problem that should halt
 * the chain even if the semantic score came out passable.
 *
 * L1 REVISE still advances — REVISE means "polish this", not "broken".
 * Missions with neither L1 nor L2 present (trivial prompts that skipped both)
 * also advance, so chains aren't blocked by the rubric's own sample-rate pruning.
 */
export function shouldAdvanceChain(currentMission: Mission): boolean {
  if (currentMission.status !== 'completed') return false;
  if ((currentMission as unknown as { partial?: boolean }).partial === true) return false;

  const judgement = currentMission.qualityJudgement;
  if (judgement && judgement.overallScore < QUALITY_HALT_THRESHOLD) return false;

  // L1 FAIL always halts, regardless of whether L2 is present. Critical L1
  // checks (scout-bundle-parseable, scout-no-citation-padding) encode narrow
  // structural violations that a high L2 overall score can mask.
  const report = currentMission.qualityReport;
  if (report && report.verdict === 'FAIL') return false;

  return true;
}
