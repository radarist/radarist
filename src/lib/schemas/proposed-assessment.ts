/**
 * Proposed Assessment schema — a build-mission **evaluation** verdict staged
 * for human triage (the "Assessment" lane), mirroring proposed relations.
 *
 * An assessment proposes a system-of-record change about a Technology: a
 * maturity read (TRL + recommendation) and a radar placement (ring). A reviewer
 * approves it in /triage/assessment. Optional autopilot can apply a
 * newly created proposal when confidence meets the configured threshold and a
 * required RadarPlacement succeeds. Approval creates/updates the placement and,
 * only if unset, the Technology's canonical TRL.
 *
 * Mirrors the in-sandbox `Verdict` contract (agent/src/sandbox/status.ts):
 * recommendation/trl/confidence/metrics/findings come straight from it.
 */
import { z } from 'zod';
import { createHash } from 'crypto';

export const assessmentRecommendationSchema = z.enum(['adopt', 'trial', 'assess', 'hold']);
export type AssessmentRecommendation = z.infer<typeof assessmentRecommendationSchema>;

export const proposedAssessmentStatusSchema = z.enum(['pending', 'approved', 'rejected', 'dismissed']);
export type ProposedAssessmentStatus = z.infer<typeof proposedAssessmentStatusSchema>;

/** Evidence carried for the reviewer — the verdict's measured metrics + findings. */
export const assessmentEvidenceSchema = z.object({
  metrics: z
    .array(
      z.object({
        name: z.string().max(200),
        value: z.string().max(200),
        command: z.string().max(500).optional(),
      })
    )
    .default([]),
  findings: z
    .array(
      z.object({
        title: z.string().max(200),
        detail: z.string().max(2000).default(''),
        kind: z.enum(['verdict', 'benchmark', 'risk', 'observation']).default('observation'),
        confidence: z.number().min(0).max(100).optional(),
      })
    )
    .default([]),
});
export type AssessmentEvidence = z.infer<typeof assessmentEvidenceSchema>;

export const proposedAssessmentSchema = z.object({
  id: z.string(), // generateAssessmentKey(technologyId, sourceRunId)
  technologyId: z.string(),
  /** Denormalized for the triage card (avoids a lookup). */
  technologyName: z.string().optional(),
  recommendation: assessmentRecommendationSchema,
  trl: z.number().int().min(1).max(9).optional(),
  /** 0–100 headline confidence (gates autopilot at ≥ threshold). */
  confidence: z.number().min(0).max(100),
  evidence: assessmentEvidenceSchema.default({ metrics: [], findings: [] }),
  /** Radar ring matching the recommendation (Adopt/Trial/Assess/Hold). */
  proposedRing: z.string(),
  /** Target radar — absent means the reviewer picks at approval (null-and-defer). */
  radarId: z.string().optional(),
  quadrantId: z.string().optional(),
  /** Provenance back to the run + the verdict Document. */
  sourceRunId: z.string(),
  sourceDocumentId: z.string().optional(),
  status: proposedAssessmentStatusSchema.default('pending'),
  createdAt: z.number(),
  updatedAt: z.number(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.number().optional(),
  // Apply provenance (set on approve / autopilot).
  appliedBy: z.string().optional(), // 'assessment-autopilot' | userId
  appliedAt: z.number().optional(),
  appliedPlacementId: z.string().optional(),
  feedbackReason: z.string().max(2000).optional(),
});
export type ProposedAssessment = z.infer<typeof proposedAssessmentSchema>;

/**
 * Deterministic id: one assessment per (technology, run). A re-publish / Iterate
 * of the same mission upserts the same proposal instead of duplicating it.
 */
export function generateAssessmentKey(technologyId: string, sourceRunId: string): string {
  return createHash('sha256').update(`${technologyId}:${sourceRunId}`).digest('hex').slice(0, 32);
}

/** Verdict recommendation → canonical radar ring label (HATA capitalization). */
export const RING_BY_RECOMMENDATION: Record<AssessmentRecommendation, string> = {
  adopt: 'Adopt',
  trial: 'Trial',
  assess: 'Assess',
  hold: 'Hold',
};
