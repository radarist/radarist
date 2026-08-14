/**
 * @file schemas/dismiss-reason.ts
 * @description Reviewer dismiss/reject reason codes shared across the discovery
 * triage surfaces. Lands first within P1a so the proposed-entity/update schemas
 * (and the reason-coded feedback recorder) can reference it directly.
 */
import { z } from 'zod';

export const dismissReasonSchema = z.enum(['out-of-scope', 'low-quality', 'already-known', 'duplicate', 'correct']);
export type DismissReason = z.infer<typeof dismissReasonSchema>;
