/**
 * @file lib/schemas/agent-run.ts
 * @description Zod validation schemas for AgentRun entities
 *
 * AgentRuns record individual agent execution results for the Activity page.
 * Each run captures the agent name, action taken, status, token usage, cost,
 * and duration. These records power the activity log and token usage charts.
 *
 * The schema matches the existing AgentLogEntry interface from
 * src/hooks/useAgentActivity.ts, with additional server-side fields
 * (userId, missionId, costUsd) not exposed in the hook type.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { z } from 'zod';
import { qualityJudgementSchema } from './mission-quality-llm';
import {
  CHAT_TOOL_NAME_PATTERN,
  MAX_CHAT_TOOL_DURATION_MS,
  MAX_CHAT_TOOL_NAME_LENGTH,
  MAX_CHAT_TOOL_SUMMARY_ENTRIES,
} from '@/lib/chat-tool-summary';

// ============================================================================
// STATUS ENUM
// ============================================================================

/**
 * Execution outcome of an agent run.
 * - success: agent completed its task
 * - failure: agent encountered an error
 * - skipped: agent had nothing to do (e.g. no pending signals)
 */
export const agentRunStatusSchema = z.enum(['success', 'failure', 'skipped']);

export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

/** Durable execution category. Optional on input for legacy writer compatibility. */
export const agentRunKindSchema = z.enum(['chat', 'mission', 'sweep']);
export type AgentRunKind = z.infer<typeof agentRunKindSchema>;

/** Provider vocabulary used by the interactive Assistant. */
export const agentRunProviderSchema = z.enum(['claude', 'gemini']);
export type AgentRunProvider = z.infer<typeof agentRunProviderSchema>;

/**
 * Privacy-safe chat tool history. Strict objects prevent arguments, results,
 * prompts, document content, and confirmation phrases from being persisted.
 */
export const agentRunToolSummaryEntrySchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CHAT_TOOL_NAME_LENGTH).regex(CHAT_TOOL_NAME_PATTERN),
    status: z.enum(['success', 'failure']),
    durationMs: z.number().int().min(0).max(MAX_CHAT_TOOL_DURATION_MS).optional(),
  })
  .strict();

export type AgentRunToolSummaryEntry = z.infer<typeof agentRunToolSummaryEntrySchema>;

type AgentRunClassificationInput = {
  kind?: unknown;
  provider?: unknown;
  agentName?: unknown;
  missionId?: unknown;
  sweepId?: unknown;
  model?: unknown;
};

/**
 * Infer legacy rows without rewriting them. Only an exact chat agent with no
 * mission/sweep owner becomes chat; all other old non-sweep rows stay mission.
 */
export function inferAgentRunKind(run: AgentRunClassificationInput): AgentRunKind {
  const explicit = agentRunKindSchema.safeParse(run.kind);
  if (explicit.success) return explicit.data;
  if (typeof run.sweepId === 'string' && run.sweepId.length > 0) return 'sweep';
  if (
    typeof run.agentName === 'string' &&
    run.agentName.trim().toLowerCase() === 'chat' &&
    !(typeof run.missionId === 'string' && run.missionId.length > 0)
  ) {
    return 'chat';
  }
  return 'mission';
}

/** Infer provider only for chat rows; mission models must never be relabelled. */
export function inferAgentRunProvider(run: AgentRunClassificationInput): AgentRunProvider | undefined {
  const explicit = agentRunProviderSchema.safeParse(run.provider);
  if (explicit.success) return explicit.data;
  if (inferAgentRunKind(run) !== 'chat' || typeof run.model !== 'string') return undefined;

  const model = run.model.trim().toLowerCase();
  if (/(^|[/:_-])claude([/:_.-]|$)/.test(model)) return 'claude';
  if (/(^|[/:_-])gemini([/:_.-]|$)/.test(model)) return 'gemini';
  return undefined;
}

// ============================================================================
// SWEEP STATS (OBS-004)
// ============================================================================

/**
 * OBS-004 — durable per-cycle sweep counters. Persisted on the sweep's
 * summary AgentRun so the insight-production volume survives beyond the
 * Inngest step return (which is only visible in the dev dashboard).
 *
 * `insightsStatus` is the honesty discriminator:
 *   - 'failed' — the insight pipeline errored; its zeros are NOT trustworthy.
 *   - 'quiet'  — the pipeline ran healthily and genuinely produced nothing.
 *   - 'ok'     — at least one insight (watched or narrative) was produced.
 *   - 'not-run' — the sweep completed before REFLECT because SENSE found no
 *                 gaps or DECIDE found no actionable work. Its zero counters
 *                 are real, but are not evidence that insight generation ran.
 * Narrative-only production must never read as zero: `insightsTotal` is
 * watched + narrative, and both addends are persisted individually.
 */
/**
 * OBS-004 — the sweep's CHILD accounting, accrued as dispatched missions
 * terminalise.
 *
 * `missionsSpawned` above counts what the sweep FIRED. This block is what those
 * children actually DID: the exact terminal partition, their cost, their
 * durable outputs and their elapsed time. A dispatch can succeed while every
 * paid child fails, so each of those facts is an explicit field here.
 *
 * `childrenStatus` is the completeness discriminator, and it matters because
 * children outlive the sweep that dispatched them:
 *   - 'none'    — nothing was dispatched.
 *   - 'pending' — dispatched, none has reported yet. Counters are not yet meaningful.
 *   - 'partial' — some reported, some outstanding. Counters are a lower bound.
 *   - 'settled' — every dispatched child reported. Counters are final.
 *
 * `costUsd` sums only children whose cost is KNOWN; `costUnavailableChildren`
 * counts the rest rather than letting an unpriced child contribute 0 (AI-029).
 */
export const agentRunSweepChildrenSchema = z.object({
  dispatched: z.number().int().min(0),
  settled: z.number().int().min(0),
  /** Count per canonical DomainOutcome — the exact terminal partition. */
  byOutcome: z.record(z.string(), z.number().int().min(0)),
  /** Rolled-up child outcome. Absent while nothing has settled. */
  outcome: z.string().optional(),
  childrenStatus: z.enum(['none', 'pending', 'partial', 'settled']),
  costUsd: z.number().min(0),
  costUnavailableChildren: z.number().int().min(0),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  /** Summed durable elapsed time across settled children, in milliseconds. */
  childDurationMs: z.number().int().min(0),
  outputs: z.object({
    proposals: z.number().int().min(0),
    reports: z.number().int().min(0),
    entities: z.number().int().min(0),
  }),
  failedChildren: z.number().int().min(0),
});

export type AgentRunSweepChildren = z.infer<typeof agentRunSweepChildrenSchema>;

export const agentRunSweepStatsSchema = z.object({
  gapsFound: z.number().int().min(0),
  missionsSpawned: z.number().int().min(0),
  usersProcessed: z.number().int().min(0),
  observationsWritten: z.number().int().min(0),
  watchedInsights: z.number().int().min(0),
  narrativeInsights: z.number().int().min(0),
  insightsTotal: z.number().int().min(0),
  insightsStatus: z.enum(['ok', 'quiet', 'failed', 'not-run']),
  /** OBS-004 child accounting. Absent on rows written before this field existed. */
  children: agentRunSweepChildrenSchema.optional(),
});

export type AgentRunSweepStats = z.infer<typeof agentRunSweepStatsSchema>;

// ============================================================================
// CREATE AGENT RUN SCHEMA
// ============================================================================

/**
 * Schema for creating a new AgentRun.
 * Used for validating input at the API/service boundary.
 */
const createAgentRunBaseSchema = z.object({
  /** ID of the user who owns this agent run */
  userId: z.string().min(1),
  /** Optional mission ID that triggered this run */
  missionId: z.string().optional(),
  /** Explicit execution category. Inferred server-side when older writers omit it. */
  kind: agentRunKindSchema.optional(),
  /** Interactive chat provider. Inferred from a legacy chat model when absent. */
  provider: agentRunProviderSchema.optional(),
  /** Name of the agent (e.g. 'Scout', 'Evaluator', 'Linker', 'Monitor') */
  agentName: z.string().min(1),
  /** Human-readable description of what the agent did */
  action: z.string().min(1),
  /** Execution outcome */
  status: agentRunStatusSchema,
  /** Model used for this run (e.g. 'claude-sonnet-4-6', 'gemini-2.5-flash').
   * ARUN-003: derived from the SDK result (or its modelUsage breakdown) —
   * never a hardcoded fallback. Absent when the run reported neither. */
  model: z.string().trim().min(1).max(200).optional(),
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
  /**
   * ARUN-003: authoritative per-model usage breakdown from the SDK result
   * (`modelUsage` on the final result message). Keys are model names; token
   * fields mirror the orchestrator's ModelUsageSummary. Cache/cost fields are
   * optional for forward compatibility.
   */
  modelUsage: z
    .record(
      z.string(),
      z.object({
        inputTokens: z.number().min(0),
        outputTokens: z.number().min(0),
        cacheReadInputTokens: z.number().min(0).optional(),
        cacheCreationInputTokens: z.number().min(0).optional(),
        costUSD: z.number().min(0).optional(),
      })
    )
    .optional(),
  /** Optional sweep ID grouping related runs */
  sweepId: z.string().optional(),
  /** OBS-004: durable honest counters for sweep summary runs. */
  sweepStats: agentRunSweepStatsSchema.optional(),
  /** Token consumption for this run */
  tokenUsage: z.object({
    input: z.number().min(0),
    output: z.number().min(0),
  }),
  /**
   * ARUN-020 — how much of `tokenUsage` the PROVIDER actually reported.
   *
   * `tokenUsage` is required, so a turn whose provider responses all omitted
   * usage still has to store `{0,0}`. Without this discriminator that
   * placeholder is indistinguishable from a measured zero and every surface
   * renders a confident "0 tokens" for a run whose real usage is unknown.
   * Absent on rows written before the field; readers treat absence as legacy
   * and fall back to the stored counters (see `agentRunUsageSnapshot`).
   */
  tokenUsageProvenance: z.enum(['provider-reported', 'partially-reported', 'unreported']).optional(),
  /**
   * Estimated cost in USD. AI-029: OPTIONAL because a model with no
   * rate-card entry has an UNKNOWN cost — persisting 0 would understate
   * spend while looking exact. Absent + `costUnavailableReason` set is the
   * honest encoding; ARUN-027's aggregation counts such rows as
   * "unavailable" instead of summing them.
   */
  costUsd: z.number().min(0).optional(),
  providerReportedCostUsd: z.number().min(0).nullable().optional(),
  exposureUsd: z.number().min(0).optional(),
  duplicateUsageEvents: z.number().int().min(0).optional(),
  restatedUsageEvents: z.number().int().min(0).optional(),
  /**
   * Authority of `costUsd`. Receipt-derived chat prices are estimates from the
   * versioned card, not provider invoice settlements. Historical rows without
   * this discriminator retain their legacy settled interpretation.
   */
  costState: z.enum(['estimated', 'settled']).optional(),
  /** Why no cost was recorded. Only meaningful when `costUsd` is absent. */
  costUnavailableReason: z.enum(['unknown-pricing', 'accounting-incomplete']).optional(),
  /**
   * ARUN-029 — the run's stable, machine-readable terminal failure code,
   * mirroring `Mission.failureCode`. Infrastructure aborts (an internal-MCP
   * preflight failure and friends) previously recorded the code on the Mission
   * only, so the run surfaces had to parse `errors[0]` prose or say nothing at
   * all. Absent on rows that failed for any other reason, and on every
   * successful run.
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
  /** Execution duration in milliseconds */
  duration: z.number().min(0),
  /**
   * ARUN-008: true when the real duration is unknowable — e.g. the
   * infrastructure-failure fallback row written by onFailure, which never saw
   * the orchestrator run. UI renders the duration as "—" instead of a
   * fabricated 0ms. Absent on normal runs.
   */
  durationUnknown: z.boolean().optional(),
  /** Error messages collected during execution */
  errors: z.array(z.string()).optional(),
  /** Bounded, redacted chat tool history; never contains arguments or results. */
  toolSummary: z.array(agentRunToolSummaryEntrySchema).max(MAX_CHAT_TOOL_SUMMARY_ENTRIES).optional(),
  /** True when additional tool calls were omitted by the persistence boundary. */
  toolSummaryTruncated: z.boolean().optional(),
  /**
   * True when the run's output was recovered from a mid-run checkpoint after
   * a timeout (Tier 1). UI renders a yellow "Partial" badge instead of
   * the red "Failed" for these.
   */
  partial: z.boolean().optional(),
  /**
   * AI-042: why the run is partial, so a renderer never states the wrong cause.
   * Absent on rows written before this field existed, which were all mission
   * checkpoint recoveries.
   * - `checkpoint-recovery` — mid-run checkpoint rescued a timed-out mission.
   * - `tool-failures` — the turn delivered value, but one or more of its
   *   operations failed or partially wrote.
   */
  partialReason: z.enum(['checkpoint-recovery', 'tool-failures']).optional(),
  /** Turn number of the last checkpoint captured before partial recovery. */
  partialCheckpointTurn: z.number().int().nonnegative().optional(),
  /**
   * Real-time trail of Skill(...) invocations captured during the mission
   * (Tier 2). UI renders these as an expandable timeline.
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
  /** Deterministic quality verdict from Layer 1 evaluator (copied from mission doc). */
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
  /** Layer 2 LLM-as-judge verdict (copied from mission doc). */
  qualityJudgement: qualityJudgementSchema.optional(),
  /** Workspace files salvaged on timeout (Tier 3 Task 6; copied from mission doc). */
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
  /** Mirrored from mission.skillPrelude for Activity-page rendering. */
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
  /** Mirrored from mission.revisionAttempts. */
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
  /** Mission-chain membership — enables chain-grouping on the activity view. */
  chainId: z.string().optional(),
  chainStep: z.number().int().positive().optional(),
  chainTotalSteps: z.number().int().positive().optional(),
});

function refineAgentRunCostState(
  value: { costUsd?: number; costState?: 'estimated' | 'settled'; costUnavailableReason?: string },
  ctx: z.RefinementCtx
): void {
  if (value.costState !== undefined && value.costUsd === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['costState'],
      message: 'costState requires costUsd',
    });
  }
  if (value.costUsd !== undefined && value.costUnavailableReason !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['costUnavailableReason'],
      message: 'costUnavailableReason must be absent when costUsd is present',
    });
  }
}

export const createAgentRunSchema = createAgentRunBaseSchema.superRefine(refineAgentRunCostState);

export type CreateAgentRunInput = z.infer<typeof createAgentRunSchema>;

// ============================================================================
// FULL AGENT RUN SCHEMA
// ============================================================================

/**
 * Full AgentRun schema as stored in Firestore.
 * Includes auto-generated fields (id, createdAt).
 */
export const agentRunSchema = createAgentRunBaseSchema
  .extend({
    /** Unique agent run identifier */
    id: z.string().min(1),
    /** ISO timestamp of creation */
    createdAt: z.string(),
  })
  .superRefine(refineAgentRunCostState);

export type AgentRun = z.infer<typeof agentRunSchema>;

// ============================================================================
// AGGREGATE TYPES
// ============================================================================

/** Per-agent token usage breakdown returned by the tokens-by-agent API */
export interface AgentTokenBreakdown {
  agentName: string;
  model: string;
  totalInput: number;
  totalOutput: number;
  totalTokens: number;
  /** Legacy combined observed/estimated total. Never includes unavailable rows. */
  totalCost: number;
  /** Provider-settled/legacy numeric cost. */
  settledCost: number;
  /** Versioned rate-card estimates, kept visibly distinct from settlements. */
  estimatedCost: number;
  /** Runs whose cost authority or amount could not be proven. */
  unavailableCostRuns: number;
  /** ARUN-020: runs whose TOKEN count could not be proven; counted, never summed. */
  unavailableTokenRuns: number;
  runCount: number;
}
