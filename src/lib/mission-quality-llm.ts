/**
 * @file lib/mission-quality-llm.ts
 * @description Quality Layer 2 — LLM-as-judge.
 *
 * Runs after Layer 1 (rule-based, deterministic). Uses the unified Gemini
 * client to score the mission result against the 10-point critique-report
 * rubric. Structured output via Zod.
 *
 * Layer 2 never replaces Layer 1 — both scores persist side-by-side.
 * Layer 1 catches structural failures; Layer 2 catches semantic ones
 * (interpretation bled into Results, inflated confidence, recommendation
 * doesn't follow from evidence).
 *
 * Cost controls:
 *   - Env var QUALITY_LLM_SAMPLE_RATE (default 1.0 — every mission)
 *   - Skip trivial prompts (same heuristic as Layer 1)
 *   - Skip when effective result is < 500 chars (not enough substance)
 *   - Cap input at 40KB to bound cost on very long reports
 */

import { z } from 'zod';
import { generateStructuredContentWithMetadata, type GeminiModel } from '@/lib/ai/client';
import { createLogger } from '@/lib/logger';
import {
  QUALITY_JUDGEMENT_DIMENSIONS,
  qualityJudgementSchema,
  qualityJudgementDimensionSchema,
} from '@/lib/schemas/mission-quality-llm';
import type { QualityJudgement } from '@/lib/schemas/mission-quality-llm';

const log = createLogger('mission-quality-llm');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESULT_INPUT_CAP_BYTES = 40 * 1024; // 40KB — caps worst-case token cost
const MIN_RESULT_BYTES_FOR_JUDGE = 500; // skip trivial outputs
const DEFAULT_JUDGE_MODEL: GeminiModel = 'gemini-3-flash-preview';

// ---------------------------------------------------------------------------
// Input type — keep decoupled from the full Mission type
// ---------------------------------------------------------------------------

export interface MissionForLlmJudge {
  prompt: string;
  result: string;
  agent?: string;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const JUDGE_PROMPT_TEMPLATE = `You are a strict quality auditor evaluating a mission's final output against a 10-point rubric adapted from the critique-report skill.

---
USER'S ORIGINAL QUESTION:
{{prompt}}

AGENT THAT ANSWERED:
{{agent}}

FULL MISSION OUTPUT (may be truncated):
{{result}}
---

Score each of these 10 dimensions on a 0-1 scale, with a one-sentence rationale per score:

1. **answersQuestion** — does the output directly address the user's question, or drift to an adjacent one?
2. **evidenceSourced** — are factual claims cited (numbered references, DOIs, URLs) rather than asserted?
3. **antiPatternsAvoided** — does the output avoid common failures: interpretation bled into Results section, editorializing in neutral-voice sections, unsourced counterfactuals, mixing methods with findings?
4. **reproducible** — is there enough methodological detail (which sources, which queries, which selection criteria) for another analyst to reproduce the same output?
5. **confidenceHonest** — do the stated confidences match the evidence quality? Inflated confidence on single-source claims is a fail.
6. **limitationsStated** — does the output acknowledge what it does NOT cover, which assumptions are load-bearing, and where follow-up would be valuable?
7. **audienceCalibrated** — is the voice, density, and length appropriate for the requested audience (executive vs analyst vs technical)?
8. **counterEvidenceAddressed** — does the output name evidence that would cut against its conclusion, not just supporting evidence?
9. **numbersDefensible** — every quantitative claim has units, a baseline for any comparison, and a method for computed figures?
10. **nextActionActionable** — if the output recommends action, is it specific (owner, deadline, kill-threshold), not vague ("further research is needed")?

SCORING GUIDANCE:
- 1.0 = dimension is excellent, no meaningful issues
- 0.7-0.9 = minor issues, does not undermine the output
- 0.5-0.7 = real issues worth fixing in a revision
- 0.3-0.5 = significant problem that weakens the output
- 0.0-0.3 = failure mode — this dimension is broken

VERDICT RULES:
- PASS = all dimensions ≥ 0.7
- REVISE = 1–2 dimensions below 0.7, or 1 below 0.5
- FAIL = ≥3 dimensions below 0.7 OR any below 0.3

Respond with JSON matching this schema:
{
  "verdict": "PASS" | "REVISE" | "FAIL",
  "overallScore": number between 0 and 1 (mean of the 10 dimension scores),
  "dimensions": [
    {"name": "answersQuestion", "score": 0-1, "rationale": "one sentence"},
    ... (all 10 dimensions, in the order above)
  ],
  "note": "optional short overall summary"
}`;

function buildPrompt(m: MissionForLlmJudge): string {
  const result =
    m.result.length > RESULT_INPUT_CAP_BYTES
      ? m.result.slice(0, RESULT_INPUT_CAP_BYTES) + '\n...[truncated]'
      : m.result;
  return JUDGE_PROMPT_TEMPLATE.replace('{{prompt}}', m.prompt)
    .replace('{{agent}}', m.agent ?? 'unknown')
    .replace('{{result}}', result);
}

// ---------------------------------------------------------------------------
// Skip heuristics
// ---------------------------------------------------------------------------

function isTrivialPrompt(prompt: string): boolean {
  return (
    prompt.length <= 140 &&
    !/\b(analy[sz]|report|whitepap|brief|strateg|plan(ning)?|assess|evaluat|recommend|audit|review|compar|critique)/i.test(
      prompt
    )
  );
}

/**
 * Returns true if this mission should be skipped — e.g. trivial prompt,
 * tiny result, or sample-rate pruning. Callers can use the returned reason
 * in logs.
 */
export function shouldSkipLlmJudge(
  m: MissionForLlmJudge,
  sampleRate = 1.0
): { skip: true; reason: string } | { skip: false } {
  if (!m.result || m.result.length < MIN_RESULT_BYTES_FOR_JUDGE) {
    return { skip: true, reason: `result under ${MIN_RESULT_BYTES_FOR_JUDGE}B` };
  }
  if (isTrivialPrompt(m.prompt)) {
    return { skip: true, reason: 'trivial prompt' };
  }
  if (sampleRate < 1.0 && Math.random() > sampleRate) {
    return { skip: true, reason: `sampled out (rate=${sampleRate})` };
  }
  return { skip: false };
}

// ---------------------------------------------------------------------------
// Schema the judge model must return (internal — not persisted as-is)
// ---------------------------------------------------------------------------

const judgeResponseSchema = z.object({
  verdict: z.enum(['PASS', 'REVISE', 'FAIL']),
  overallScore: z.number().min(0).max(1),
  dimensions: z
    .array(
      z.object({
        name: qualityJudgementDimensionSchema,
        score: z.number().min(0).max(1),
        rationale: z.string().min(1),
      })
    )
    .length(QUALITY_JUDGEMENT_DIMENSIONS.length),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a mission's quality via an LLM judge. Returns a QualityJudgement
 * on success or null on any failure / skip — callers must not rely on the
 * judge being available (Gemini outages, sample-rate pruning, etc. all
 * produce null).
 */
export async function evaluateMissionQualityLlm(
  mission: MissionForLlmJudge,
  options: {
    sampleRate?: number;
    model?: GeminiModel;
  } = {}
): Promise<{ judgement: QualityJudgement | null; costUsd: number | null }> {
  const sampleRate = options.sampleRate ?? parseFloat(process.env.QUALITY_LLM_SAMPLE_RATE ?? '1.0');
  const skipDecision = shouldSkipLlmJudge(mission, sampleRate);
  if (skipDecision.skip) {
    log.debug('LLM judge skipped', { reason: skipDecision.reason });
    return { judgement: null, costUsd: 0 };
  }

  const model = options.model ?? DEFAULT_JUDGE_MODEL;
  const prompt = buildPrompt(mission);
  // MISSION-005: the judge call's real Gemini spend is returned even when the
  // judgement itself fails validation — the tokens were still billed.
  let costUsd: number | null = 0;

  try {
    const response = await generateStructuredContentWithMetadata(prompt, judgeResponseSchema, {
      model,
      temperature: 0.2, // low for consistency across runs
      maxOutputTokens: 4096,
      skipReliability: true, // judge is best-effort; don't block on circuit-breaker
    });
    costUsd = response.costUsd;

    const judgement: QualityJudgement = {
      evaluatedAt: new Date().toISOString(),
      judgeModel: response.effectiveModel,
      overallScore: response.data.overallScore,
      verdict: response.data.verdict,
      dimensions: response.data.dimensions,
      note: response.data.note,
    };

    return { judgement: qualityJudgementSchema.parse(judgement), costUsd };
  } catch (err) {
    log.warn('LLM judge invocation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { judgement: null, costUsd };
  }
}
