/**
 * @file radar-placement-schema.ts
 * @description The single, bounded Zod contract for RadarPlacement write payloads
 * crossing the authenticated same-origin handoff (GRAPH-060 #4).
 *
 * ONE schema — no drifting API/domain copies. The create/update bodies are
 * validated here before the Admin-SDK primitive commits them; the route then
 * composes the server-owned fields (`placedBy = auth.uid`) so attribution can't
 * be spoofed (#3). `quadrantName` (read-only denormalized display name) and any
 * server-owned field (`placedBy`) are absent from these input schemas, so a plain
 * `z.object` strips them — a client can never persist a stale name or a forged
 * attribution. All identifiers and free text are length-bounded.
 */

import { z } from 'zod';
import type { CreateRadarPlacementInput, UpdateRadarPlacementInput } from '@/lib/types';

/** Bounds — generous enough for real ids/text, tight enough to reject abuse. */
const MAX_ID = 256;
const MAX_RING = 120;
const MAX_RATIONALE = 4000;
const MAX_NAME = 256;

const boundedId = z.string().min(1).max(MAX_ID);

const timeToImpactSchema = z.enum(['H1', 'H2', 'H3', 'unknown']);
const statusSchema = z.enum(['Trending', 'Stable', 'Fading', 'New', 'Warning']);

const technologySnapshotSchema = z.object({
  name: z.string().max(MAX_NAME),
  slug: z.string().max(MAX_NAME),
  category: z.string().max(MAX_NAME).optional(),
  snapshotUpdatedAt: z.number().optional(),
});

/** Position/assessment fields shared by create + update. */
// GRAPH-060 #6 — a finite visualization coordinate, bounded to reject ±1e300 / NaN / ∞.
const coordinate = z.number().finite().min(-1e6).max(1e6);

const placementMutableFields = {
  quadrantId: boundedId,
  ring: z.string().min(1).max(MAX_RING),
  rationale: z.string().max(MAX_RATIONALE).optional(),
  x: coordinate.optional(),
  y: coordinate.optional(),
  status: statusSchema.optional(),
  timeToImpact: timeToImpactSchema.optional(),
  trlScore: z.number().finite().min(1).max(9).optional(),
  technologySnapshot: technologySnapshotSchema.optional(),
} as const;

/**
 * Create body — the pair identity (`technologyId`, `radarId`) + position. NOTE:
 * `placedBy` is intentionally ABSENT — the route derives it from `auth.uid`, so a
 * client-supplied value is stripped, never persisted.
 */
export const createRadarPlacementInputSchema = z.object({
  technologyId: boundedId,
  radarId: boundedId,
  ...placementMutableFields,
});

/**
 * Update body — a partial edit or ring move. Identity + server-owned fields
 * (`technologyId`, `radarId`, `placedBy`) are absent so they are stripped, not
 * mutated. At least one field must be present.
 */
export const updateRadarPlacementInputSchema = z
  .object({
    quadrantId: placementMutableFields.quadrantId.optional(),
    ring: placementMutableFields.ring.optional(),
    rationale: placementMutableFields.rationale,
    x: placementMutableFields.x,
    y: placementMutableFields.y,
    status: placementMutableFields.status,
    timeToImpact: placementMutableFields.timeToImpact,
    trlScore: placementMutableFields.trlScore,
    technologySnapshot: placementMutableFields.technologySnapshot,
  })
  // GRAPH-060 #1 (round 3) — `.strict()` PROHIBITS the immutable identity fields
  // (`technologyId`, `radarId`) and any server-owned field (`placedBy`, `movedFrom`,
  // `movedAt`, `quadrantName`, `updatedAt`) at the runtime boundary: an attempt to
  // change them is a hard 400, never a silent strip. The TypeScript boundary is
  // closed independently by `UpdateRadarPlacementInput` (omits the same identity keys).
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided to update a placement',
  });

export type CreateRadarPlacementPayload = z.infer<typeof createRadarPlacementInputSchema>;
export type UpdateRadarPlacementPayload = z.infer<typeof updateRadarPlacementInputSchema>;

// Compile-time guards: the create body plus a server-stamped `placedBy` must form
// a valid domain input; the update body must be a valid domain update.
const _createAssignable: Omit<CreateRadarPlacementInput, 'placedBy'> = {} as CreateRadarPlacementPayload;
const _updateAssignable: UpdateRadarPlacementInput = {} as UpdateRadarPlacementPayload;
void _createAssignable;
void _updateAssignable;
