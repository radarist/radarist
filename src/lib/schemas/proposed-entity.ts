/**
 * @file schemas/proposed-entity.ts
 * @description A net-new entity staged for human triage — the dimension-agnostic
 * mirror of proposed-assessment. NEVER auto-applied: a net-new entity is always
 * written `pending` and a reviewer approves it (there is no autopilot path in
 * this plan). Approval applies via `adminCreateEntity`.
 */
import { z } from 'zod';
import { createHash } from 'crypto';
import { assessmentEvidenceSchema } from './proposed-assessment';
import { dismissReasonSchema } from './dismiss-reason';

/** Growth dimensions a discovery generator may propose. Excludes strategy/initiative/orgUnit/document/report/concept. */
export const supportedEntityTypeSchema = z.enum(['technology', 'company', 'useCase', 'painPoint', 'prototype']);
export type SupportedEntityType = z.infer<typeof supportedEntityTypeSchema>;

export const proposedEntityStatusSchema = z.enum(['pending', 'approved', 'rejected', 'dismissed']);
export type ProposedEntityStatus = z.infer<typeof proposedEntityStatusSchema>;

export const proposedEntitySchema = z.object({
  id: z.string(), // generateProposedEntityKey(entityType, normalizedName, primaryDomain?)
  entityType: supportedEntityTypeSchema,
  name: z.string(),
  /** Optional disambiguator (e.g. primary domain) folded into the dedup key. */
  primaryDomain: z.string().optional(),
  description: z.string().optional(),
  /** Field payload written on approve (passed to adminCreateEntity). */
  data: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(100),
  evidence: assessmentEvidenceSchema.default({ metrics: [], findings: [] }),
  sourceRunId: z.string().optional(),
  sourceDocumentId: z.string().optional(),
  status: proposedEntityStatusSchema.default('pending'),
  createdAt: z.number(),
  updatedAt: z.number(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.number().optional(),
  // Apply provenance (set on approve only — never autopilot).
  appliedBy: z.string().optional(),
  appliedAt: z.number().optional(),
  appliedEntityId: z.string().optional(),
  feedbackReason: dismissReasonSchema.optional(),
});
export type ProposedEntity = z.infer<typeof proposedEntitySchema>;

/**
 * Deterministic id: one proposal per (entityType, normalizedName, primaryDomain).
 * A re-discovery of the same entity upserts the same proposal instead of duplicating.
 */
export function generateProposedEntityKey(entityType: string, normalizedName: string, primaryDomain?: string): string {
  return createHash('sha256')
    .update(`${entityType}:${normalizedName}:${primaryDomain ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}
