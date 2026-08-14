/**
 * @file schemas/visualization.ts
 * @description Zod validation schema for user-generated visualizations.
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import { z } from 'zod';

// ============================================================================
// Bounded entity-snapshot contract (AI-025)
//
// A visualization stores WHICH entities its data came from as a small, stable
// reference list — only id/name/type, never entity payloads. The bounds below
// are the single source of truth for every writer (AI tool, POST API,
// diagram save) and every reader (detail API, infographic page).
// ============================================================================

/** Canonical entity types a visualization reference may carry. */
export const VISUALIZATION_ENTITY_TYPES = [
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'document',
  'orgUnit',
  'initiative',
  'painPoint',
] as const;
export type VisualizationEntityType = (typeof VISUALIZATION_ENTITY_TYPES)[number];

/** Persisted references additionally allow 'unknown' — the exact-ID fallback. */
export const VISUALIZATION_SNAPSHOT_ENTITY_TYPES = [...VISUALIZATION_ENTITY_TYPES, 'unknown'] as const;
export type VisualizationSnapshotEntityType = (typeof VISUALIZATION_SNAPSHOT_ENTITY_TYPES)[number];

export const MAX_VISUALIZATION_ENTITY_REFS = 50;
export const MAX_VISUALIZATION_ENTITY_ID_LENGTH = 256;
export const MAX_VISUALIZATION_ENTITY_NAME_LENGTH = 200;
export const MAX_VISUALIZATION_TITLE_LENGTH = 200;
export const MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH = 1000;

/** One persisted reference: id + display-name snapshot + canonical type. */
export const visualizationEntitySnapshotSchema = z.object({
  id: z.string().min(1).max(MAX_VISUALIZATION_ENTITY_ID_LENGTH),
  // '' means "never resolved" — readers render a neutral unresolved label.
  name: z.string().max(MAX_VISUALIZATION_ENTITY_NAME_LENGTH),
  type: z.enum(VISUALIZATION_SNAPSHOT_ENTITY_TYPES),
});
export type VisualizationEntitySnapshot = z.infer<typeof visualizationEntitySnapshotSchema>;

export const visualizationDataSnapshotSchema = z.object({
  entities: z
    .array(visualizationEntitySnapshotSchema)
    .max(MAX_VISUALIZATION_ENTITY_REFS)
    .superRefine((entities, ctx) => {
      const seen = new Set<string>();
      for (const { id } of entities) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate entity reference: ${id}. References must be unique by id.`,
          });
          return;
        }
        seen.add(id);
      }
    }),
  description: z.string().max(MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH),
});
export type VisualizationDataSnapshot = z.infer<typeof visualizationDataSnapshotSchema>;

/**
 * Typed input reference accepted at capture time (tool/API callers). The type
 * is optional — untyped ids fall back to a graph lookup, then to the exact-ID
 * 'unknown' snapshot. Firestore doc ids cannot contain '/', so such input is
 * malformed and rejected before any paid generation.
 */
export const visualizationEntityRefInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(MAX_VISUALIZATION_ENTITY_ID_LENGTH)
    .refine((id) => !id.includes('/'), { message: 'Entity ids cannot contain "/"' }),
  type: z.enum(VISUALIZATION_ENTITY_TYPES).optional(),
});
export type VisualizationEntityRefInput = z.infer<typeof visualizationEntityRefInputSchema>;

/**
 * Read-time display shape for one reference. `resolution` records where the
 * name came from: the live typed Firestore doc, the stored snapshot, or
 * nowhere ('unresolved' — render a neutral label, never invent a name).
 */
export interface ResolvedVisualizationEntityRef {
  id: string;
  type: VisualizationSnapshotEntityType;
  name: string | null;
  resolution: 'live' | 'snapshot' | 'unresolved';
}

/**
 * Repair a legacy/malformed stored snapshot in memory — no migration, the
 * stored doc is never rewritten. Guarantees the bounded contract: drops
 * entries without a usable id, coerces names/types, strips extra fields,
 * deduplicates by id, and clips every string to its documented bound.
 */
export function normalizeVisualizationDataSnapshot(raw: unknown): VisualizationDataSnapshot {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const description =
    typeof source.description === 'string'
      ? source.description.slice(0, MAX_VISUALIZATION_DATA_DESCRIPTION_LENGTH)
      : '';

  const entities: VisualizationEntitySnapshot[] = [];
  const seen = new Set<string>();
  const rawEntities = Array.isArray(source.entities) ? source.entities : [];
  for (const entry of rawEntities) {
    if (entities.length >= MAX_VISUALIZATION_ENTITY_REFS) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { id: rawId, name: rawName, type: rawType } = entry as Record<string, unknown>;
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (id.length === 0 || id.length > MAX_VISUALIZATION_ENTITY_ID_LENGTH || seen.has(id)) continue;
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, MAX_VISUALIZATION_ENTITY_NAME_LENGTH) : '';
    const type = (VISUALIZATION_SNAPSHOT_ENTITY_TYPES as readonly string[]).includes(rawType as string)
      ? (rawType as VisualizationSnapshotEntityType)
      : 'unknown';
    seen.add(id);
    entities.push({ id, name, type });
  }

  return { entities, description };
}

export const visualizationSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(MAX_VISUALIZATION_TITLE_LENGTH),
  prompt: z.string().min(1),
  refinedPrompt: z.string(),
  imageUrl: z.string().url(),
  thumbnailUrl: z.string().optional(),
  // Internal Firebase Storage identity. This intentionally differs from the
  // Firestore document ID: callers navigate, read, and delete by `id`, while
  // storage cleanup targets this exact server-authored object path.
  storageObjectPath: z.string().optional(),
  // 'image/svg+xml' lets a rendered super-graph diagram (vector SVG) be saved
  // into the visualizations gallery alongside raster infographics.
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']),
  style: z.enum(['professional', 'minimal', 'colorful', 'dark']),
  dataSnapshot: visualizationDataSnapshotSchema,
  createdAt: z.string(),
  createdBy: z.string().min(1),
  shared: z.boolean(),
  // User rating: `true` = thumbs-up, `false` = thumbs-down, `undefined`
  // = no rating yet. Stored optional so existing docs without the field
  // continue to validate without a Firestore migration.
  liked: z.boolean().optional(),
  // The learned-style fragment (from `buildLearnedStyleFragment`) actually
  // composed into the generation prompt for this doc, when one was applied —
  // makes the like/dislike loop's effect queryable on the stored doc (US-1).
  appliedStyleFragment: z.string().optional(),
  userId: z.string(),
  metadata: z.object({
    model: z.string(),
    width: z.number(),
    height: z.number(),
    sizeBytes: z.number(),
  }),
});

export type Visualization = z.infer<typeof visualizationSchema>;

/**
 * Detail-API payload shape: the stored visualization plus server-resolved
 * display references. Only GET /api/visualizations/[id] attaches these —
 * list rows and the public share page stay resolution-free.
 */
export type VisualizationWithReferences = Visualization & {
  referencedEntities?: ResolvedVisualizationEntityRef[];
};

export const createVisualizationSchema = visualizationSchema.omit({
  id: true,
  createdAt: true,
  shared: true,
  // Public API callers cannot choose a server cleanup target. Trusted internal
  // generation paths add it through CreateVisualizationInput below.
  storageObjectPath: true,
});

export type CreateVisualizationInput = z.infer<typeof createVisualizationSchema> &
  Pick<Visualization, 'storageObjectPath'>;
