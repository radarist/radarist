/**
 * @file lib/schemas/linker-bundle.ts
 * @description Zod schema for the linker agent's structured relation bundle.
 */

import { z } from 'zod';

export const linkerEdgeSchema = z.object({
  sourceEntityName: z.string().min(1),
  targetEntityName: z.string().min(1),
  relationType: z.string().min(1),
  evidence: z.string().min(10),
  confidence: z.number().min(0).max(1),
  sourceUrl: z.string().url().optional(),
});

export type LinkerEdge = z.infer<typeof linkerEdgeSchema>;

/**
 * MISSION-011 — `edges` may be EMPTY.
 *
 * An honest `{"edges": []}` is a legitimate research outcome: the agent looked and
 * found nothing it could defend. Rejecting it as a schema violation made
 * "found nothing" indistinguishable from "ignored the deliverable contract", and
 * a critical failure for the honest answer is a direct incentive to invent an
 * edge. The distinction now lives in two checks instead of one:
 * `linker-bundle-parseable` (CRITICAL — is the bundle well-formed?) and
 * `linker-proposals-present` (soft — did it contain any edge?).
 */
export const linkerBundleSchema = z.object({
  edges: z.array(linkerEdgeSchema),
});

export type LinkerBundle = z.infer<typeof linkerBundleSchema>;
