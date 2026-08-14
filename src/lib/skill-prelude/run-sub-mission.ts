/**
 * @file lib/skill-prelude/run-sub-mission.ts
 * @description Runs a single skill against a single target via a stripped-down
 * orchestrator call. Bounded by cost cap + timeout. Returns a structured
 * result the prelude stitcher consumes.
 */

import { isPerEntitySkill } from './registry';

import type { RevisionModelUsage } from './run-revision-orchestrator';
import type { Mission } from '@/lib/schemas/mission';

type CostUnavailableReason = NonNullable<Mission['costUnavailableReason']>;

export interface SubMissionInput {
  skill: string;
  target?: string; // entity name for per-entity skills
  briefContext?: string; // brief-level context for non-per-entity skills
  maxCostUsd?: number; // default $0.30
  timeoutMs?: number; // default 60_000
  /**
   * Factory for the orchestrator-like object. Production wiring passes a real
   * `Orchestrator` instance; tests pass a mock. The minimal contract is a
   * `runMission(prompt: string)` method returning `{ success, result, costUsd, ... }`.
   */
  createOrchestrator: () => {
    runMission: (prompt: string) => Promise<{
      success: boolean;
      result?: string;
      costUsd?: number | null;
      costUnavailableReason?: string;
      modelUsage?: Record<string, RevisionModelUsage>;
      errors?: string[];
    }>;
  };
}

export interface SubMissionResult {
  skill: string;
  target?: string;
  block: string;
  costUsd: number | null;
  costUnavailableReason?: CostUnavailableReason;
  durationMs: number;
  firedAt: string;
  success: boolean;
  error?: string;
  /**
   * ARUN-022/AI-029 — the helper session's provider-reported per-SERVED-MODEL
   * usage summary, surfaced so the Inngest handler can flush durable usage
   * receipts for this paid out-of-process turn. It is IN-MEMORY ONLY and is
   * deliberately NOT part of the persisted `mission.skillPrelude` shape (the
   * handler strips it before writing) — the durable record of this spend is the
   * receipt ledger, not a second copy on the mission document.
   */
  modelUsage?: Record<string, RevisionModelUsage>;
}

const BLOCK_MAX_CHARS = 4000;
const DEFAULT_MAX_COST_USD = 0.3;
const DEFAULT_TIMEOUT_MS = 60_000;

function buildPrompt(skill: string, target?: string, briefContext?: string): string {
  const subject = isPerEntitySkill(skill)
    ? `the technology "${target ?? 'unknown'}"`
    : `this brief: ${briefContext ?? 'unspecified context'}`;

  return [
    `Apply the ${skill} skill to ${subject}.`,
    `Output exactly one fenced block in the skill's standard format.`,
    `Do not add prose. Do not output anything other than the fenced block.`,
  ].join('\n');
}

export async function runSkillSubMission(input: SubMissionInput): Promise<SubMissionResult> {
  const firedAt = new Date().toISOString();
  const start = Date.now();
  const prompt = buildPrompt(input.skill, input.target, input.briefContext);

  try {
    const orchestrator = input.createOrchestrator();
    const result = await orchestrator.runMission(prompt);
    const durationMs = Date.now() - start;
    const costUsd = result.costUsd === undefined ? null : result.costUsd;
    const costUnavailableReason: CostUnavailableReason | undefined =
      costUsd === null
        ? result.costUnavailableReason === 'accounting-incomplete'
          ? 'accounting-incomplete'
          : result.costUnavailableReason
            ? 'unknown-pricing'
            : 'accounting-incomplete'
        : undefined;

    // A FAILED helper session still burns provider tokens, so its per-model
    // usage is surfaced on both branches — receipting only successes would
    // under-report real spend.
    const modelUsage =
      result.modelUsage && Object.keys(result.modelUsage).length > 0 ? { modelUsage: result.modelUsage } : {};

    if (!result.success) {
      return {
        skill: input.skill,
        target: input.target,
        block: '',
        costUsd,
        ...(costUnavailableReason ? { costUnavailableReason } : {}),
        durationMs,
        firedAt,
        success: false,
        error: result.errors?.join('; ') ?? 'sub-mission returned success=false',
        ...modelUsage,
      };
    }

    const block = (result.result ?? '').slice(0, BLOCK_MAX_CHARS);
    return {
      skill: input.skill,
      target: input.target,
      block,
      costUsd,
      ...(costUnavailableReason ? { costUnavailableReason } : {}),
      durationMs,
      firedAt,
      success: true,
      ...modelUsage,
    };
  } catch (err) {
    return {
      skill: input.skill,
      target: input.target,
      block: '',
      // The wrapper cannot prove that the provider spent nothing before the
      // throw. Preserve that uncertainty instead of fabricating an exact $0.
      costUsd: null,
      costUnavailableReason: 'accounting-incomplete',
      durationMs: Date.now() - start,
      firedAt,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const SUB_MISSION_DEFAULTS = {
  maxCostUsd: DEFAULT_MAX_COST_USD,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};
