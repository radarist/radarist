/**
 * @file lib/skill-prelude/run-revision-orchestrator.ts
 * @description Wraps the agent-SDK orchestrator dispatch for the revision
 * turn (Step 2.75). Extracted so tests can mock at the module boundary
 * without triggering the dynamic ESM agent-SDK import that Jest cannot
 * resolve. Returns a structured result; callers handle persistence.
 */

import type { Mission } from '@/lib/schemas/mission';

type CostUnavailableReason = NonNullable<Mission['costUnavailableReason']>;

export interface RevisionOrchestratorInput {
  prompt: string;
  agentsDir: string;
  configPath: string;
  apiKey?: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  logFilePath?: string;
  /**
   * Mission ID — passed through to the orchestrator so the MCP layer can
   * bind x-mission-id on every internal HTTP call. Without this the revise
   * turn's publishReport calls are rejected by the platform with
   * "missionId not bound" (Bug C2 territory) and the polish never ships.
   */
  missionId?: string;
  /**
   * Frozen slot manifest — surfaced to the revise agent in the orchestrator
   * preamble so it knows which slotName values publishReport will accept.
   * Without this the agent invents descriptive names ("ai-ml-2026-foresight")
   * that publishReport rejects, and revise draft cycles never escape FS.
   */
  slots?: Array<{ name: string; intent?: string }>;
  roleAgent?: string;
}

/**
 * One SERVED model's usage from the sub-session's provider-reported summary.
 * Structural mirror of the agent package's `ModelUsageSummary` so this module
 * does not import across the package boundary.
 */
export interface RevisionModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Provider-authoritative per-model cost. `undefined` = unreported, `0` = KNOWN zero. */
  costUSD?: number;
}

export interface RevisionOrchestratorResult {
  success: boolean;
  result?: string;
  costUsd: number | null;
  costUnavailableReason?: CostUnavailableReason;
  tokenUsage?: { input: number; output: number };
  /**
   * ARUN-022/AI-029 — the sub-session's provider-reported per-SERVED-MODEL usage
   * summary. Declared here so the Inngest handler can flush durable usage
   * receipts for this paid out-of-process turn: the orchestrator returns it, but
   * before this field existed the wrapper's type dropped it at the boundary and
   * the revision turn's spend reached the ledger as a session-level cost only,
   * with no served model and no token/cache counters.
   */
  modelUsage?: Record<string, RevisionModelUsage>;
  providerReportedCostUsd?: number | null;
  exposureUsd?: number;
  duplicateUsageEvents?: number;
  restatedUsageEvents?: number;
  requestedModel?: string;
  modelSubstitution?: {
    requested: string;
    served: string;
    servedModels: readonly string[];
    authorized: boolean;
    authorizedBy?: 'configured-fallback' | 'explicit-pair' | 'explicit-served';
  };
  /** Formal Skill() calls observed in this revision session. */
  skillInvocations?: Array<{ skill: string; args?: string; firedAt: string; turn: number }>;
  errors?: string[];
}

export async function runRevisionOrchestrator(input: RevisionOrchestratorInput): Promise<RevisionOrchestratorResult> {
  const skillInvocations: NonNullable<RevisionOrchestratorResult['skillInvocations']> = [];
  try {
    const { importOrchestrator } = await import('@/lib/agent-import');
    const mod = await importOrchestrator();
    const logger = mod.createLogger(input.logFilePath);
    const orchestrator = new mod.Orchestrator({
      apiKey: input.apiKey,
      agentsDir: input.agentsDir,
      configPath: input.configPath,
      logger,
      permissionMode: 'bypassPermissions' as const,
      maxBudgetUsd: input.maxBudgetUsd,
      timeoutMs: input.timeoutMs,
      missionId: input.missionId,
      slots: input.slots,
      roleAgent: input.roleAgent,
      onSkillInvocation: async (invocation: {
        skill: string;
        args?: string;
        firedAt: string;
        turn: number;
      }) => {
        skillInvocations.push(invocation);
        if (!input.missionId) return;
        const { appendSkillInvocation } = await import('@/lib/missions');
        await appendSkillInvocation(input.missionId, invocation);
      },
    });
    const result = await orchestrator.runMission(input.prompt);
    const receipt = skillInvocations.length > 0 ? { skillInvocations } : {};
    if (result.costUsd === null) {
      return {
        ...result,
        ...receipt,
        costUsd: null,
        costUnavailableReason:
          result.costUnavailableReason === 'accounting-incomplete'
            ? 'accounting-incomplete'
            : result.costUnavailableReason
              ? 'unknown-pricing'
              : 'accounting-incomplete',
      };
    }
    if (result.costUsd === undefined) {
      return {
        ...result,
        ...receipt,
        costUsd: null,
        costUnavailableReason: 'accounting-incomplete',
      };
    }
    return { ...result, ...receipt };
  } catch (err) {
    return {
      success: false,
      costUsd: null,
      costUnavailableReason: 'accounting-incomplete',
      ...(skillInvocations.length > 0 ? { skillInvocations } : {}),
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
