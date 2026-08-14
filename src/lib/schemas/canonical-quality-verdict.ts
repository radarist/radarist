/**
 * @file lib/schemas/canonical-quality-verdict.ts
 * @description REPORT-018 — persistence shape for the composed quality verdict.
 *
 * Kept beside the two evaluator schemas it reconciles (`mission-quality-llm.ts`
 * for Layer 2, the inline `qualityReport` block in `mission.ts` for Layer 1) and
 * separate from the composer itself, so the schema stays importable from client
 * code without pulling the evaluator modules in.
 */
import { z } from 'zod';

export const qualityVerdictValueSchema = z.enum(['PASS', 'REVISE', 'FAIL']);

export const canonicalQualityVerdictSchema = z.object({
  /** The one verdict every consumer should read. */
  verdict: qualityVerdictValueSchema,
  /** Best verdict the deterministic evidence permits; the canonical value never exceeds it. */
  ceiling: qualityVerdictValueSchema,
  /** Which authority produced the canonical value. */
  decidedBy: z.enum(['deterministic', 'judge', 'ceiling']),
  /** Failing critical check names that set a `FAIL` ceiling. */
  criticalFailures: z.array(z.string()),
  deterministic: z
    .object({
      verdict: qualityVerdictValueSchema,
      overallScore: z.number().min(0).max(1),
      evaluatedAt: z.string(),
    })
    .optional(),
  judge: z
    .object({
      verdict: qualityVerdictValueSchema,
      overallScore: z.number().min(0).max(1),
      judgeModel: z.string().min(1),
      evaluatedAt: z.string(),
    })
    .optional(),
  /** Preserved evaluator conflict — evidence, not something to resolve away. */
  disagreement: z
    .object({
      kind: z.enum(['judge-more-favourable', 'judge-more-critical']),
      detail: z.string().min(1),
    })
    .optional(),
  composedAt: z.string(),
});

export type CanonicalQualityVerdictDoc = z.infer<typeof canonicalQualityVerdictSchema>;
