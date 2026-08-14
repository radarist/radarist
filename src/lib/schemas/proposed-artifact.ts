/**
 * @file schemas/proposed-artifact.ts
 * @description A recommendation to PRODUCE an artifact (an HTML report, a research
 * document, or an infographic), staged for human triage in the Assessments inbox.
 * The fourth proposal kind alongside proposed-entity / proposed-assessment /
 * proposed-update. The defining difference: approval EXECUTES a generation job
 * (it does not mint an entity). NEVER auto-executed — always written `pending`,
 * and generation only runs inside the approve path.
 *
 * Two lifecycles are tracked independently:
 *   - `status`           — the human decision (pending → approved/rejected/dismissed)
 *   - `generationStatus` — the execution (idle → generating → ready/failed)
 * so a row can be `approved · generating…` then `approved · ready`.
 */
import { z } from 'zod';
import { createHash } from 'crypto';
import { dismissReasonSchema } from './dismiss-reason';

/** The artifact kinds a recommendation can produce. */
export const artifactKindSchema = z.enum(['report', 'research', 'infographic']);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Execution lifecycle, independent of the human decision. */
export const artifactGenerationStatusSchema = z.enum(['idle', 'generating', 'ready', 'failed']);
export type ArtifactGenerationStatus = z.infer<typeof artifactGenerationStatusSchema>;

export const proposedArtifactStatusSchema = z.enum(['pending', 'approved', 'rejected', 'dismissed']);
export type ProposedArtifactStatus = z.infer<typeof proposedArtifactStatusSchema>;

/** Where the generated output landed (set when generationStatus becomes 'ready'). */
export const artifactOutputRefSchema = z.object({
  type: z.enum(['report', 'document', 'visualization']),
  id: z.string(),
  url: z.string().optional(),
});
export type ArtifactOutputRef = z.infer<typeof artifactOutputRefSchema>;

export const proposedArtifactSchema = z.object({
  id: z.string(), // generateProposedArtifactKey(artifactKind, title, scopeKey?)
  artifactKind: artifactKindSchema,
  title: z.string(),
  /** Why the scout recommends producing this (the proactive "why"). */
  rationale: z.string().optional(),
  /** Which of the user's interests this serves. */
  matchedTopics: z.array(z.string()).default([]),
  /** What the artifact is ABOUT — drives the generation prompt. */
  scope: z
    .object({
      entityType: z.string().optional(),
      entityIds: z.array(z.string()).default([]),
      query: z.string().optional(),
    })
    .default({ entityIds: [] }),
  /** Kind-specific generation params. */
  params: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(100).default(70),
  status: proposedArtifactStatusSchema.default('pending'),
  generationStatus: artifactGenerationStatusSchema.default('idle'),
  outputRef: artifactOutputRefSchema.optional(),
  /** When set, approving UPDATES this existing output (regenerates it) instead of creating a new one. */
  updateOf: artifactOutputRefSchema.optional(),
  generationError: z.string().optional(),
  sourceRunId: z.string().optional(),
  /**
   * Owning user. SEC-011: required at creation (`createProposedArtifactIfNotExists`
   * throws without it) and part of the deterministic id; optional here only so
   * pre-ownership legacy docs still parse — those are denied on every
   * authenticated surface (list/mutations treat them as absent).
   */
  sourceUserId: z.string().optional(),
  /**
   * REPORT-005: the durable execution mission minted when an approved CREATE
   * recommendation generates. Stamped transactionally with the mission doc so
   * event replay converges on one mission (and one report via upsert-by-slot).
   */
  executionMissionId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.number().optional(),
  appliedAt: z.number().optional(),
  feedbackReason: dismissReasonSchema.optional(),
});
export type ProposedArtifact = z.infer<typeof proposedArtifactSchema>;

/**
 * Deterministic id: one recommendation per (owner, artifactKind, normalized title, scope).
 * A re-recommendation of the same artifact by the same user upserts instead of
 * duplicating. SEC-011: the owner is part of the hash — without it, two users
 * recommending the same artifact collided on one shared doc and the first
 * writer's `sourceUserId` silently owned the second user's recommendation.
 */
export function generateProposedArtifactKey(
  artifactKind: string,
  title: string,
  scopeKey: string,
  sourceUserId: string
): string {
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256')
    .update(`${sourceUserId}:${artifactKind}:${normalizedTitle}:${scopeKey}`)
    .digest('hex')
    .slice(0, 32);
}
