/**
 * @file lib/schemas/mission-quality-llm.ts
 * @description Schema for Quality Layer 2 — LLM-as-judge verdicts.
 *
 * Layer 1 (rule-based, fast, free) lives in mission-quality.ts. Layer 2
 * runs an LLM judge (Haiku by default) against the 10-point rubric from
 * the critique-report skill so structural PASS doesn't automatically mean
 * semantic PASS. Output is stored as `mission.qualityJudgement` — side-
 * by-side with Layer 1's `qualityReport`, never replacing it.
 */

import { z } from 'zod';

/**
 * The 10 canonical dimensions from the critique-report skill. Each has a
 * 0-1 score from the judge + a one-sentence rationale. Dimension names
 * stay stable so UIs can render them deterministically.
 */
export const QUALITY_JUDGEMENT_DIMENSIONS = [
  'answersQuestion',
  'evidenceSourced',
  'antiPatternsAvoided',
  'reproducible',
  'confidenceHonest',
  'limitationsStated',
  'audienceCalibrated',
  'counterEvidenceAddressed',
  'numbersDefensible',
  'nextActionActionable',
] as const;

export type QualityJudgementDimension = (typeof QUALITY_JUDGEMENT_DIMENSIONS)[number];

export const qualityJudgementDimensionSchema = z.enum(QUALITY_JUDGEMENT_DIMENSIONS);

export const qualityJudgementScoreSchema = z.object({
  name: qualityJudgementDimensionSchema,
  score: z.number().min(0).max(1),
  rationale: z.string().min(1),
});

export type QualityJudgementScore = z.infer<typeof qualityJudgementScoreSchema>;

export const qualityJudgementVerdictSchema = z.enum(['PASS', 'REVISE', 'FAIL']);

export const qualityJudgementSchema = z.object({
  evaluatedAt: z.string(),
  judgeModel: z.string().min(1),
  overallScore: z.number().min(0).max(1),
  verdict: qualityJudgementVerdictSchema,
  dimensions: z.array(qualityJudgementScoreSchema),
  costUsd: z.number().nonnegative().optional(),
  note: z.string().optional(),
});

export type QualityJudgement = z.infer<typeof qualityJudgementSchema>;
