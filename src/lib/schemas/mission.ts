/**
 * @file lib/schemas/mission.ts
 * @description Zod validation schemas for Mission entities
 *
 * Missions represent agent tasks dispatched from the UI. A mission tracks
 * the prompt, executing agent, progress, discovered entities/sources,
 * and eventual result. This schema is the single source of truth for
 * the mission data shape used across the API, service, and UI layers.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { z } from 'zod';
import {
  artifactKindSchema,
  artifactMotivationSchema,
  buildMissionFields,
  buildModelOverridesSchema,
  buildModeSchema,
  missionKindSchema,
} from './mission-build';
import { qualityJudgementSchema } from './mission-quality-llm';
import { canonicalQualityVerdictSchema } from './canonical-quality-verdict';
import { designBriefSchema, designBriefInputSchema } from './design-brief';
import { evidenceProvenanceReceiptSchema, scoutBundleSchema } from './scout-bundle';
import { defaultMissionAgentForKind } from '@/lib/build-runtime-identity';
import { ceilingCents, MAX_MISSION_TIMEOUT_MINUTES } from '@/lib/mission-limits';

// ============================================================================
// LIMITS
// ============================================================================

/**
 * Max mission prompt length in characters. Default 50,000 — the AI assistant
 * composes full structured briefs (audience, decision context, conversation
 * data, CRITICAL DIMENSIONS), so the cap must comfortably exceed chat-message
 * scale while still preventing a direct Firestore write or migration from
 * landing a multi-hundred-KB prompt. Override with `MISSION_PROMPT_MAX_CHARS`
 * (server-side; client bundles use the default). Falls back to the default
 * when the env value is missing or not a positive integer.
 */
const promptMaxCharsRaw = Number.parseInt(process.env.MISSION_PROMPT_MAX_CHARS ?? '', 10);
export const MISSION_PROMPT_MAX_CHARS =
  Number.isInteger(promptMaxCharsRaw) && promptMaxCharsRaw > 0 ? promptMaxCharsRaw : 50000;

// ============================================================================
// SUB-SCHEMAS
// ============================================================================

/**
 * An entity discovered or created during a mission run.
 */
export const missionEntitySchema = z.object({
  /** Entity ID (may be a Firestore doc ID or a temporary placeholder) */
  id: z.string().min(1),
  /** Display name of the entity */
  name: z.string().min(1),
  /** Entity type (e.g. 'company', 'technology', 'signal') */
  type: z.string().min(1),
  /** Agent confidence in the entity relevance (0-1) */
  confidence: z.number().min(0).max(1),
  /** Source URL where the entity was discovered */
  sourceUrl: z.string().url().optional(),
  /** Name of the agent that discovered this entity */
  agentName: z.string().min(1),
});

export type MissionEntity = z.infer<typeof missionEntitySchema>;

/**
 * A source (web page, document) referenced during a mission run.
 */
export const missionSourceSchema = z.object({
  /** URL of the source */
  url: z.string().url(),
  /** Human-readable title */
  title: z.string().min(1),
  /** Optional text snippet from the source */
  snippet: z.string().optional(),
});

export type MissionSource = z.infer<typeof missionSourceSchema>;

// === SLOT SUB-SCHEMA ===
export const slotSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'slot names must be kebab-case (lowercase a-z, 0-9, hyphens)')
    .min(1)
    .max(40),
  intent: z.string().min(1).max(200),
});
export type Slot = z.infer<typeof slotSchema>;

export const classifierMetadataSchema = z.object({
  latencyMs: z.number().int().nonnegative(),
  /** Absent when the provider-reported model has no rate-card entry. */
  costUsd: z.number().nonnegative().optional(),
  costUnavailableReason: z.enum(['unknown-pricing']).optional(),
  fallback: z.boolean(),
  model: z.string().min(1),
});
export type ClassifierMetadata = z.infer<typeof classifierMetadataSchema>;

/**
 * COORD-012 — the exact per-mission execution envelope the user authorized at
 * dispatch confirmation. Every paid phase's component budget, the tool-call
 * cap, the wall-clock timeout, and (when pinned) the model identity are
 * frozen here so a worker whose startup environment has drifted can never
 * substitute its own allocation. The components must sum (in ceilinged cents)
 * to `totalMaxCostUsd` — an envelope whose declared total disagrees with its
 * own allocation is refused at the schema boundary, before any paid phase.
 */
export const missionExecutionEnvelopeSchema = z
  .object({
    /** Main orchestrator SDK budget (maxBudgetUsd) in USD. */
    orchestratorMaxCostUsd: z.number().finite().positive(),
    /** Bounded revision-turn budget in USD. Zero de-funds the revision phase. */
    revisionMaxCostUsd: z.number().finite().nonnegative(),
    /** Skill-activation prelude total budget in USD. Zero de-funds the prelude. */
    preludeMaxCostUsd: z.number().finite().nonnegative(),
    /** Static reserve for bounded auxiliary quality/reflection calls in USD. */
    auxiliaryMaxCostUsd: z.number().finite().nonnegative(),
    /** The user-confirmed workflow total; must equal the component sum. */
    totalMaxCostUsd: z.number().finite().positive(),
    /** Orchestrator tool-call cap the user authorized. */
    maxToolCalls: z.number().int().positive(),
    /** Wall-clock mission timeout in minutes, bounded by the platform ceiling. */
    timeoutMinutes: z.number().int().positive().max(MAX_MISSION_TIMEOUT_MINUTES),
    /** Exact model the user authorized the orchestrator to request. */
    requestedModel: z.string().trim().min(1).max(200).optional(),
    /** Fallback model explicitly authorized at dispatch, when any. */
    authorizedFallbackModel: z.string().trim().min(1).max(200).optional(),
  })
  .superRefine((envelope, ctx) => {
    const componentCents = [
      envelope.orchestratorMaxCostUsd,
      envelope.revisionMaxCostUsd,
      envelope.preludeMaxCostUsd,
      envelope.auxiliaryMaxCostUsd,
    ].reduce((cents, component) => cents + ceilingCents(component), 0);
    if (componentCents !== ceilingCents(envelope.totalMaxCostUsd)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `execution envelope components sum to $${(componentCents / 100).toFixed(2)} ` +
          `but declare totalMaxCostUsd $${envelope.totalMaxCostUsd.toFixed(2)}`,
        path: ['totalMaxCostUsd'],
      });
    }
  });

export type MissionExecutionEnvelope = z.infer<typeof missionExecutionEnvelopeSchema>;

/**
 * Lifecycle status of a mission.
 */
export const missionStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);

export type MissionStatus = z.infer<typeof missionStatusSchema>;

/**
 * ARUN-014: the post-orchestration processing phase a `running` mission is in.
 * `quality-review` covers the L1 rule-based + L1.5 grounded fact-check window;
 * `revising` covers the single bounded correction turn. Cleared (null) at
 * terminal persistence. Distinct from `status` (the coarse lifecycle) so the UI
 * can show what the mission is doing during the otherwise-opaque inline quality
 * window.
 */
export const missionPhaseSchema = z.enum(['quality-review', 'revising']);

export type MissionPhase = z.infer<typeof missionPhaseSchema>;

// ============================================================================
// CREATE MISSION SCHEMA
// ============================================================================

/**
 * Schema for creating a new Mission.
 * Used for validating input at the API boundary.
 */
export const createMissionSchema = z
  .object({
    /** The user's natural-language prompt describing the mission. The default
     *  50000-char cap leaves room for a full structured brief (audience,
     *  decision context, scope, conversation data, CRITICAL DIMENSIONS)
     *  composed by the AI assistant — a one-line cap here would force lossy
     *  compression of the brainstorm the user just had. */
    prompt: z.string().min(1, 'Mission prompt is required').max(MISSION_PROMPT_MAX_CHARS),
    /**
     * Agent to execute the mission.
     *
     * ARUN-030: deliberately NOT `.default('scout')`. A flat literal default
     * stamped every build mission — which supervises sandboxed sessions and loads
     * no `/agent` profile — as `scout`, fabricating a lineage claim. The default is derived from `kind` in the
     * transform below, through the one shared `defaultMissionAgentForKind`.
     */
    agent: z.string().min(1).optional(),
    /** Optional partial design directives (design-pass conception). Resolved to a
     *  full DesignBrief on mission creation. */
    designBrief: designBriefInputSchema.optional(),
    /** Mission kind — 'build' dispatches the sandboxed prototyping pipeline. */
    kind: missionKindSchema.default('research'),
    /** Per-mission budget cap override (build missions; defaults to IMPULSE_BUILD_MISSION_MAX_COST_USD). */
    budgetUsd: z.number().positive().max(500).optional(),
    /** Per-stage model overrides (build missions; defaults to IMPULSE_BUILD_MODEL_*). */
    modelOverrides: buildModelOverridesSchema.optional(),
    /** Output shape of the artifact (solution app, evaluation, …). Defaults to 'solution'. */
    artifactKind: artifactKindSchema.optional(),
    /** Build effort tier (BUILD-012). Absent → 'standard' (default-off premium). */
    buildMode: buildModeSchema.optional(),
    /** Graph entities that motivated this artifact — connected back on publish as proposed relations. */
    motivation: artifactMotivationSchema.optional(),
    /**
     * OBS-004 — the sweep cycle that dispatched this mission, when one did.
     *
     * Without this link a sweep can report only how many children it FIRED; it
     * can never learn how they ENDED, what they cost, or what they produced.
     */
    sweepId: z.string().min(1).max(200).optional(),
  })
  .transform((input) => ({
    ...input,
    agent: input.agent ?? defaultMissionAgentForKind(input.kind),
  }));

/**
 * Caller-facing input type: z.input keeps defaulted fields (agent, kind)
 * optional at call sites — createMission parses and applies defaults.
 */
export type CreateMissionInput = z.input<typeof createMissionSchema>;

// ============================================================================
// FULL MISSION SCHEMA
// ============================================================================

/**
 * Full Mission schema as stored in Firestore.
 * Includes auto-generated fields (id, userId, createdAt, etc.).
 */
export const missionSchema = z.object({
  /** Unique mission identifier */
  id: z.string().min(1),
  /** ID of the user who created the mission */
  userId: z.string().min(1),
  /**
   * The user's natural-language prompt. Bounded at MISSION_PROMPT_MAX_CHARS
   * to mirror createMissionSchema — without the cap, a direct Firestore
   * write or migration could land a multi-hundred-KB prompt that breaks
   * downstream UI rendering and inflates index size.
   */
  prompt: z.string().min(1).max(MISSION_PROMPT_MAX_CHARS),
  /** Agent that executes the mission */
  agent: z.string().min(1),
  /** Current lifecycle status */
  status: missionStatusSchema,
  /** Progress percentage (0-100, integer). */
  progress: z.number().int().min(0).max(100),
  /** Human-readable progress message */
  progressMessage: z.string().optional(),
  /**
   * ARUN-014: the current post-orchestration processing phase (quality-review /
   * revising). null/absent when not in an inline processing window. Written at
   * the head of the corresponding step and cleared at terminal persistence.
   */
  phase: missionPhaseSchema.nullable().optional(),
  /** ARUN-014: wall-clock start of the current phase (ISO), for elapsed display. */
  phaseStartedAt: z.string().nullable().optional(),
  /** ARUN-014: the current phase's wall-clock bound in ms (e.g. the revision timeout), for observability. */
  phaseLimitMs: z.number().nullable().optional(),
  /** ARUN-014: the current phase's cost bound in USD (e.g. the revision cap), for observability. */
  phaseLimitCostUsd: z.number().nullable().optional(),
  /** ARUN-014: the preliminary published report under review during the quality phase. */
  preliminaryReportId: z.string().nullable().optional(),
  /**
   * REPORT-002: the canonical primary report of this mission (newest publish),
   * persisted BEFORE quality work begins and NEVER cleared at terminal
   * persistence — the durable run→report pointer the transient
   * `preliminaryReportId` phase field is not.
   */
  reportId: z.string().nullable().optional(),
  /** REPORT-002: every published report id for this mission (newest first). */
  reportIds: z.array(z.string()).optional(),
  /**
   * REPORT-002: honest terminal outcome of an SDK-successful run — `delivered`
   * (clean artifact linked), `needs-review` (artifact retained as an
   * owner-visible draft with its failed checks), or `no-deliverable` (a
   * slotted mission published nothing and was terminated as failed).
   */
  outcome: z.enum(['delivered', 'needs-review', 'no-deliverable']).optional(),
  /** Entities discovered during the mission */
  entities: z.array(missionEntitySchema),
  /** Sources referenced during the mission */
  sources: z.array(missionSourceSchema),
  /** Final result summary (markdown) */
  result: z.string().optional(),
  /**
   * Partial result captured mid-run. The orchestrator writes this every
   * checkpoint (default every 5 turns). Becomes the final `result` on timeout
   * so work produced before the ceiling is not lost. Explicitly set to null
   * on successful completion so the doc doesn't carry leftover scratch.
   */
  partialResult: z.string().nullable().optional(),
  /** Turn number of the last checkpoint. Null after successful completion. */
  partialCheckpointTurn: z.number().int().nonnegative().nullable().optional(),
  /** True if the final `result` came from a timed-out run (promoted from partialResult). Null on clean completion. */
  partial: z.boolean().nullable().optional(),
  /**
   * Real-time trail of Skill(...) invocations during the mission. Populated
   * by the orchestrator via its onSkillInvocation callback. Used by the UI
   * to render which skills fired, in what order, and with what args.
   */
  skillInvocations: z
    .array(
      z.object({
        skill: z.string(),
        args: z.string().optional(),
        firedAt: z.string(),
        turn: z.number().int().nonnegative().optional(),
      })
    )
    .optional(),
  /**
   * Per-mission opt-out for Step 1.7. When false, the prelude is skipped at
   * dispatch even if the prompt contains a CRITICAL DIMENSIONS block. Used
   * for controlled A/B benchmarks. Undefined = enabled.
   */
  enablePrelude: z.boolean().optional(),
  /**
   * Visual design brief (design-pass conception). The single source of truth
   * for the report's theme/palette/typography — read by the chart renderer,
   * the infographic prompt, and the brand analyzer. MUST stay `.optional()`:
   * every pre-existing Firestore mission doc lacks this field.
   */
  designBrief: designBriefSchema.optional(),
  /** Exact filtered Scout bundle accepted for this downstream mission. */
  evidenceBundle: scoutBundleSchema.optional(),
  /** Firestore-resolution and hash receipt for `evidenceBundle`. */
  evidenceProvenance: evidenceProvenanceReceiptSchema.optional(),
  /**
   * Precomputed innovation-discipline content from Step 1.7 (skill-activation
   * prelude). Each entry corresponds to one sub-mission run against a single
   * skill+target. Populated only for P3-style structured prompts containing a
   * CRITICAL DIMENSIONS block. Optional so non-creator missions stay backward
   * compatible.
   */
  skillPrelude: z
    .array(
      z.object({
        skill: z.string().min(1),
        target: z.string().optional(),
        block: z.string().max(4000),
        costUsd: z.number().min(0).nullable(),
        costUnavailableReason: z.enum(['unknown-pricing', 'accounting-incomplete']).optional(),
        durationMs: z.number().int().nonnegative(),
        firedAt: z.string(),
        success: z.boolean(),
        error: z.string().optional(),
      })
    )
    .optional(),
  /**
   * Prelude planning ledger (ARUN-025). Records every SCOPE fragment's fate —
   * accepted / rejected (with reason) / duplicate / dropped-for-count-cap — plus
   * planned vs executed vs skipped helper sessions and the exact prelude cost
   * state. Distinct from `skillPrelude` (which holds only launched-session
   * results): this discloses what did NOT launch and why. Optional so missions
   * without a prelude stay backward compatible.
   */
  preludeAccounting: z
    .object({
      targets: z.object({
        accepted: z.array(z.string()),
        rejected: z.array(z.object({ value: z.string(), reason: z.string() })),
        duplicates: z.array(z.object({ value: z.string(), canonicalKey: z.string() })),
        droppedForCountCap: z.array(z.string()),
        countCap: z.number().int().nonnegative(),
      }),
      tasks: z.object({
        planned: z.number().int().nonnegative(),
        executed: z.number().int().nonnegative(),
        skipped: z.array(
          z.object({
            skill: z.string(),
            target: z.string().optional(),
            reason: z.string(),
          })
        ),
      }),
      cost: z.object({
        totalUsd: z.number().min(0).nullable(),
        costUnavailableReason: z.enum(['unknown-pricing', 'accounting-incomplete']).optional(),
        capUsd: z.number().min(0),
        aborted: z.boolean(),
      }),
    })
    .optional(),
  /**
   * Bounded revision turns dispatched by Step 2.75 when L1 verdict is REVISE.
   * Capped at attempt=1 by schema; orchestrator enforces the same cap.
   */
  revisionAttempts: z
    .array(
      z.object({
        attempt: z.number().int().min(1).max(1),
        triggeredByVerdict: z.enum(['REVISE', 'FAIL']),
        failingChecks: z.array(z.string()),
        feedback: z.string().max(8000),
        costUsd: z.number().min(0).nullable(),
        costUnavailableReason: z.enum(['unknown-pricing', 'accounting-incomplete']).optional(),
        providerReportedCostUsd: z.number().min(0).nullable().optional(),
        exposureUsd: z.number().min(0).optional(),
        duplicateUsageEvents: z.number().int().min(0).optional(),
        restatedUsageEvents: z.number().int().min(0).optional(),
        requestedModel: z.string().trim().min(1).max(200).optional(),
        modelSubstitution: z
          .object({
            requested: z.string().trim().min(1).max(200),
            served: z.string().trim().min(1).max(200),
            servedModels: z.array(z.string().trim().min(1).max(200)).max(20),
            authorized: z.boolean(),
            authorizedBy: z.enum(['configured-fallback', 'explicit-pair', 'explicit-served']).optional(),
          })
          .optional(),
        /** Formal Skill() receipts emitted by this attempt, retained even when rejected. */
        skillInvocations: z
          .array(
            z.object({
              skill: z.string(),
              args: z.string().optional(),
              firedAt: z.string(),
              turn: z.number().int().nonnegative().optional(),
            })
          )
          .optional(),
        durationMs: z.number().int().nonnegative(),
        revisedAt: z.string(),
        newVerdict: z.enum(['PASS', 'REVISE', 'FAIL']).optional(),
        /**
         * True when the revision was computed but REJECTED as a regression
         * (it scored worse than the original, or dropped the verdict to FAIL),
         * so the original result + report HTML were retained (MISSION-002).
         * Absent/false means the revision was promoted as the canonical result.
         */
        rejected: z.boolean().optional(),
        /**
         * REPORT-003: the concrete non-regression reasons behind a rejected
         * promotion (verdict drop, previously-passing load-bearing check
         * flips, per-report design-gate regressions). Absent on promotions.
         */
        promotionReasons: z.array(z.string()).optional(),
        coverageShift: z
          .object({
            dimensionsFixed: z.array(z.string()),
            dimensionsStillFailing: z.array(z.string()),
            dimensionsNewlyFailing: z.array(z.string()),
          })
          .optional(),
      })
    )
    .optional(),
  /**
   * Slot manifest set by the intent classifier at dispatch. Frozen for
   * the lifetime of the mission. Empty array = exploratory (publishReport
   * is gated out of the agent's tool list).
   */
  slots: z.array(slotSchema).default([]),
  /** Classifier audit data captured at dispatch. Optional for legacy missions. */
  classifierMetadata: classifierMetadataSchema.optional(),
  /**
   * Maximum end-to-end research workflow spend explicitly authorized at
   * dispatch. Workers fail before any paid phase if their current resolved
   * envelope exceeds this value. Optional only for legacy/non-chat missions.
   */
  authorizedMaxCostUsd: z.number().finite().positive().optional(),
  /**
   * COORD-012: the complete execution envelope the user confirmed at dispatch.
   * When present, the worker consumes it verbatim for every paid phase and the
   * startup environment supplies nothing but legacy defaults. Optional so
   * every pre-existing mission document keeps parsing.
   */
  executionEnvelope: missionExecutionEnvelopeSchema.optional(),
  /**
   * COORD-012: the envelope the worker actually resolved and enforced,
   * persisted before the first provider call so receipts can prove the
   * confirmed and effective values agree.
   */
  effectiveExecutionEnvelope: missionExecutionEnvelopeSchema.optional(),
  /** Set when the L1 quality gate is skipped (e.g. exploratory missions with empty slots). */
  qualityGateSkipped: z.enum(['exploratory']).optional(),
  /**
   * Files written by the agent to its workspace directory during the mission,
   * preserved on timeout (Tier 3 Task 6). Small text-like files (≤ 50KB) have
   * their content inlined; larger or binary files carry metadata only.
   */
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        relativePath: z.string(),
        mimeType: z.string(),
        sizeBytes: z.number().int().nonnegative(),
        content: z.string().optional(),
        savedAt: z.string(),
        salvaged: z.boolean().optional(),
      })
    )
    .optional(),
  /**
   * Deterministic post-mission quality report. Populated by the Layer 1
   * rule-based evaluator in `lib/mission-quality.ts`. Layer 2's semantic
   * judgement lives alongside in `qualityJudgement` below.
   */
  qualityReport: z
    .object({
      evaluatedAt: z.string(),
      overallScore: z.number().min(0).max(1),
      verdict: z.enum(['PASS', 'REVISE', 'FAIL']),
      checks: z.array(
        z.object({
          name: z.string(),
          pass: z.boolean(),
          critical: z.boolean(),
          detail: z.string(),
        })
      ),
      revisedFromVerdict: z.enum(['REVISE', 'FAIL']).optional(),
    })
    .optional(),
  /**
   * Layer 2 LLM-as-judge verdict from `lib/mission-quality-llm.ts`. Runs
   * after Layer 1 and sits alongside — a structural PASS from Layer 1
   * does not imply a semantic PASS here. Optional because the judge is
   * best-effort (Gemini outage, sample-rate pruning, etc. → absent).
   */
  qualityJudgement: qualityJudgementSchema.optional(),
  /**
   * REPORT-018 — the ONE quality verdict every consumer should read.
   *
   * Composed from the two evaluators above, never replacing either receipt.
   * A deterministic critical failure can coexist with an advisory PASS, so the
   * canonical verdict is
   * the lower of the two, so deterministic critical failures are a hard upper
   * bound that an advisory model score can never lift, while a judge can still
   * lower a structurally clean result. The conflict is preserved in
   * `disagreement` rather than resolved away.
   */
  qualityVerdict: canonicalQualityVerdictSchema.optional(),
  /**
   * Mission chaining (Superpower #2). When present, identifies this mission
   * as part of a multi-step pipeline where each step's output feeds into
   * the next. Step N+1 is dispatched automatically when step N completes.
   */
  chainId: z.string().optional(),
  /** 1-indexed position within the chain. */
  chainStep: z.number().int().positive().optional(),
  /** Total steps in the chain — used to detect the final step. */
  chainTotalSteps: z.number().int().positive().optional(),
  /** Pointer to the immediate parent mission in the chain (step N-1). */
  parentMissionId: z.string().optional(),
  /**
   * OBS-004 — the sweep cycle that dispatched this mission.
   *
   * This is the durable link that makes a sweep's child accounting possible at
   * all: the mission runner reads it at terminal time and reports the child's
   * outcome, cost, tokens, elapsed time and output counts back to the sweep. It
   * is set only by a sweep dispatch; a user-dispatched mission carries none.
   */
  sweepId: z.string().min(1).max(200).optional(),
  /** ISO 8601 datetime of creation. Used as the sort key for the mission GC. */
  createdAt: z.string().datetime(),
  /** ISO 8601 datetime of completion (set when status becomes completed/failed). */
  completedAt: z.string().datetime().optional(),
  /**
   * ARUN-009: ISO 8601 datetime stamped when the handler dequeues the mission
   * and flips it to `running`. Lets live UI rows show EXECUTION-only age
   * (matching the terminal AgentRun duration contract) instead of
   * queue-inclusive request age that visibly shrank at completion. Absent on
   * missions that never started (still pending) and on legacy docs.
   */
  executionStartedAt: z.string().datetime().optional(),
  /**
   * MISSION-005: auxiliary Gemini spend, persisted per phase by the handler
   * (durable across Inngest replays) and folded into the mission/AgentRun
   * total at Step 3. Flat fields — a single writer each — so the breakdown
   * can never double count.
   */
  judgeCostUsd: z.number().min(0).optional(),
  factCheckCostUsd: z.number().min(0).optional(),
  reflectionCostUsd: z.number().min(0).optional(),
  /** Components whose paid usage could not be priced exactly. */
  costUnavailableComponents: z
    .array(
      z.enum(['orchestrator', 'classifier', 'prelude', 'revisions', 'judge', 'factCheck', 'reflection', 'mission-read'])
    )
    .optional(),
  costUnavailableReason: z.enum(['unknown-pricing', 'accounting-incomplete']).optional(),
  /** MISSION-005: the single-writer cost breakdown persisted at finalization. */
  costBreakdownUsd: z
    .object({
      orchestrator: z.number().min(0),
      classifier: z.number().min(0).default(0),
      prelude: z.number().min(0),
      revisions: z.number().min(0),
      judge: z.number().min(0),
      factCheck: z.number().min(0),
      reflection: z.number().min(0),
    })
    .optional(),
  /** Token usage for cost tracking. Both fields are non-negative integers. */
  /**
   * ARUN-020 — the RUNNING token total of an in-flight mission.
   *
   * The mission worker already persists its running COST every five tool calls
   * (see the H1 comment at that write) precisely so a mid-run reader is not
   * shown $0 for a run that is burning money. The equivalent token count was
   * emitted only on the ephemeral `agent.thinking` heartbeat, so the Runs list —
   * which subscribes to that stream — could lend it into a row while the run
   * detail, reading only the durable doc, showed nothing. Persisting it here
   * makes the in-flight count survive a reload and a navigation, so both
   * surfaces read the same number from the same record.
   *
   * A TOTAL, deliberately not split into input/output: the budget accumulator
   * tracks one figure and inventing a `{ input: total, output: 0 }` split would
   * be a fabricated measurement. Superseded by `tokenUsage` at terminalization.
   */
  runningTokensUsed: z.number().int().nonnegative().optional(),
  tokenUsage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    })
    .optional(),
  /** Estimated cost in USD. Non-negative — negatives would corrupt aggregation. */
  costUsd: z.number().nonnegative().optional(),
  providerReportedCostUsd: z.number().nonnegative().nullable().optional(),
  exposureUsd: z.number().nonnegative().optional(),
  duplicateUsageEvents: z.number().int().nonnegative().optional(),
  restatedUsageEvents: z.number().int().nonnegative().optional(),
  requestedModel: z.string().trim().min(1).max(200).optional(),
  modelSubstitution: z
    .object({
      requested: z.string().trim().min(1).max(200),
      served: z.string().trim().min(1).max(200),
      servedModels: z.array(z.string().trim().min(1).max(200)).max(20),
      authorized: z.boolean(),
      authorizedBy: z.enum(['configured-fallback', 'explicit-pair', 'explicit-served']).optional(),
    })
    .optional(),
  /** Error messages collected during execution */
  errors: z.array(z.string()).optional(),
  /**
   * OPS-004: stable, machine-readable terminal failure code. Set for
   * infrastructure aborts (e.g. an internal-MCP preflight failure) so the UI and
   * downstream consumers can branch on a code rather than parse `errors[0]`.
   */
  failureCode: z
    .enum([
      'mcp-preflight-failed',
      'mcp-base-url-missing',
      'mcp-internal-key-missing',
      'unsupported-model',
      'mcp-credential-containment-failed',
    ])
    .optional(),
  /**
   * Build-mission fields (kind 'build'): buildState/buildPhase, budget
   * envelope, sandbox ref, bounded session summaries, human gates, QA
   * verdict, published artifact. All optional/defaulted — legacy docs parse
   * as research missions. See lib/schemas/mission-build.ts.
   */
  ...buildMissionFields,
});

export type Mission = z.infer<typeof missionSchema>;
