/**
 * @file lib/schemas/company-review.ts
 * @description AI-043 — the bounded input contract for recording a human
 * source-review decision. This is what a CLIENT (UI or Assistant) may submit.
 *
 * Deliberately omits `ownerId`, `reviewerId`, `createdAt` and the event id: those
 * are trust-sensitive and are resolved SERVER-side from the authenticated session,
 * never chosen by the caller.
 */

import { z } from 'zod';
import { COMPANY_REVIEW_DECISIONS, MAX_REVIEW_SOURCES } from '@/lib/company-review';

export const companyReviewDecisionInputSchema = z.object({
  /** The company whose draft is being reviewed. */
  companyId: z.string().min(1).max(200),
  /** Which research artifact the decision targets (never mixed). */
  artifactKind: z.enum(['structured', 'narrative']),
  /** The exact artifact version the reviewer saw. */
  artifactVersion: z.string().min(1).max(80),
  /** The reviewable area key (e.g. `size` for structured, `narrative` for a narrative draft). */
  area: z.string().min(1).max(160),
  /** The exact content digest of the area the reviewer saw (optimistic concurrency). */
  areaDigest: z.string().min(1).max(80),
  /** The exact draft version digest the reviewer saw. */
  draftDigest: z.string().min(1).max(80),
  /**
   * The exact source identities backing the area at review time. Bounded by the
   * SAME limit the projection enforces (`MAX_REVIEW_SOURCES`) so every reviewable
   * server projection is accepted here and an over-bound area is never submittable.
   */
  sourceIds: z.array(z.string().min(1).max(400)).max(MAX_REVIEW_SOURCES).default([]),
  /** The verdict. */
  decision: z.enum(COMPANY_REVIEW_DECISIONS),
  /** Optional bounded reviewer note. */
  note: z.string().max(2000).optional(),
  /** Client-chosen replay/idempotency identity (bounded, id-safe charset). */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, 'idempotencyKey must be 8-128 url-safe characters'),
});

export type CompanyReviewDecisionInput = z.infer<typeof companyReviewDecisionInputSchema>;
