/**
 * @file lib/schemas/technology-schema.ts
 * @description Zod validation schemas for Technology and RadarPlacement entities (Phase 1)
 *
 * These schemas provide runtime validation for:
 * - Technology entity (facts about technologies)
 * - RadarPlacement entity (opinions about placement)
 * - Create and update input types
 *
 * @author Radarist Team
 * @created 2025-01-10
 */

import { z } from 'zod';
import { createLogger } from '@/lib/logger';

const log = createLogger('schemas/technology');

// ============================================================================
// ENUMS & CONSTANTS
// ============================================================================

/**
 * Technology categories - aligned with types.ts TechnologyCategory
 * Added 'other' for extensibility (maps unknown categories)
 */
export const technologyCategorySchema = z.enum([
  'framework', // Web/app frameworks (React, Django, etc.)
  'language', // Programming languages (TypeScript, Python, etc.)
  'platform', // Platforms (AWS, Kubernetes, etc.)
  'tool', // Development tools (VS Code, Git, etc.)
  'library', // Code libraries (lodash, moment, etc.)
  'service', // Services/APIs (Stripe, Twilio, etc.)
  'methodology', // Development methodologies (Agile, TDD, etc.)
  'infrastructure', // Infrastructure (Docker, Terraform, etc.)
  'other', // Other/unknown categories
]);

export type TechnologyCategory = z.infer<typeof technologyCategorySchema>;

/**
 * Maps legacy/unknown categories to canonical values.
 * Used for normalization at write boundaries.
 */
const TECHNOLOGY_CATEGORY_NORMALIZE: Record<string, TechnologyCategory> = {
  // Legacy categories -> closest match
  database: 'platform',
  'ai-ml': 'library',
  cloud: 'platform',
  security: 'tool',
  devops: 'tool',
  data: 'library',
  mobile: 'framework',
  web: 'framework',
  iot: 'platform',
  blockchain: 'platform',
  // Passthrough
  framework: 'framework',
  language: 'language',
  platform: 'platform',
  tool: 'tool',
  library: 'library',
  service: 'service',
  methodology: 'methodology',
  infrastructure: 'infrastructure',
  other: 'other',
};

/**
 * Normalizes a technology category value.
 */
export function normalizeTechnologyCategory(val: unknown): TechnologyCategory | undefined {
  if (typeof val !== 'string') return undefined;
  const normalized = TECHNOLOGY_CATEGORY_NORMALIZE[val];
  if (!normalized && val) {
    log.warn('Unknown technology category, mapping to other', { value: val });
    return 'other';
  }
  return normalized;
}

/**
 * Time-to-Impact values for radar placement
 */
export const timeToImpactSchema = z.enum(['H1', 'H2', 'H3', 'unknown']);

export type TimeToImpact = z.infer<typeof timeToImpactSchema>;

/**
 * Approval status for technologies
 */
export const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected']);

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/**
 * Ring values for radar placement
 */
export const ringSchema = z.enum(['Hold', 'Assess', 'Trial', 'Adopt']);

export type Ring = z.infer<typeof ringSchema>;

// ============================================================================
// SUPPORTING SCHEMAS
// ============================================================================

/**
 * Market interest metrics schema
 */
export const marketInterestSchema = z.object({
  score: z.number().min(0).max(100),
  trend: z.enum(['rising', 'stable', 'declining']),
  lastUpdated: z.number().positive(),
  sources: z.array(z.string()).optional(),
  details: z.string().optional(),
});

export type MarketInterest = z.infer<typeof marketInterestSchema>;

/**
 * Deep research data schema - aligned with types.ts DeepResearchData
 * Field names match types.ts for consistency.
 */
export const deepResearchDataSchema = z.object({
  /** AI-generated executive summary of the technology (2-4 sentences). */
  summary: z.string().min(10),
  /** Key insights discovered during research (3-7 bullet points). */
  keyInsights: z.array(z.string()).min(1),
  /** Analysis of competitive technologies and market positioning. */
  competitiveLandscape: z.string().optional(),
  /** Market trends, adoption rates, and business implications. */
  marketAnalysis: z.string().optional(), // RENAMED from marketSize
  /** Technical architecture, implementation details, and specifications. */
  technicalDetails: z.string().optional(), // ADDED to match types.ts
  /** Timestamp when research was last performed (milliseconds since epoch). */
  lastResearched: z.number().positive(), // RENAMED from researchedAt
  /** Source URLs used in the research. */
  sources: z.array(z.string()).default([]), // CHANGED to string[] to match types.ts
});

export type DeepResearchData = z.infer<typeof deepResearchDataSchema>;

/**
 * Extended deep research schema that accepts legacy field names.
 * Normalizes marketSize -> marketAnalysis, researchedAt -> lastResearched.
 */
export const deepResearchDataSchemaWithNormalize = z.preprocess((val) => {
  if (typeof val !== 'object' || val === null) return val;
  const obj = val as Record<string, unknown>;
  return {
    ...obj,
    // Normalize field names
    marketAnalysis: obj.marketAnalysis ?? obj.marketSize,
    lastResearched: obj.lastResearched ?? obj.researchedAt,
    // Normalize sources from object array to string array
    sources: Array.isArray(obj.sources)
      ? obj.sources
          .map((s: unknown) =>
            typeof s === 'string'
              ? s
              : typeof s === 'object' && s !== null && 'url' in s
                ? (s as { url: string }).url
                : ''
          )
          .filter(Boolean)
      : [],
  };
}, deepResearchDataSchema);

// ============================================================================
// TECHNOLOGY SCHEMA
// ============================================================================

/**
 * Full Technology entity schema
 */
export const technologySchema = z.object({
  // Identity
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(250)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens'),

  // Core fields
  description: z.string().max(5000),
  category: technologyCategorySchema.optional(),
  tags: z.array(z.string().max(50)).max(20).default([]),

  // URLs
  websiteUrl: z.string().url().optional().or(z.literal('')),
  githubUrl: z.string().url().optional().or(z.literal('')),
  documentationUrl: z.string().url().optional().or(z.literal('')),

  // Relations
  linkedCompanies: z.array(z.string()).optional(),
  linkedUseCases: z.array(z.string()).optional(),

  // Timestamps
  createdAt: z.number().positive(),
  updatedAt: z.number().positive(),
  createdBy: z.string().min(1),

  // Approval workflow
  approvalStatus: approvalStatusSchema.optional(),
  approvedBy: z.string().optional(),
  approvedAt: z.number().positive().optional(),
  approvalNotes: z.string().max(1000).optional(),

  // Market data
  marketInterest: marketInterestSchema.optional(),

  // Research data
  deepResearch: deepResearchDataSchema.optional(),
});

export type Technology = z.infer<typeof technologySchema>;

/**
 * Schema for creating a new technology
 */
export const createTechnologyInputSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Name must be 200 characters or less'),
  description: z.string().max(5000, 'Description must be 5000 characters or less').optional().default(''),
  category: technologyCategorySchema.optional(),
  tags: z.array(z.string().max(50)).max(20).optional().default([]),
  websiteUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  githubUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  documentationUrl: z.string().url('Invalid URL').optional().or(z.literal('')),
  linkedCompanies: z.array(z.string()).optional(),
  linkedUseCases: z.array(z.string()).optional(),
  createdBy: z.string().min(1, 'Creator ID is required'),
});

export type CreateTechnologyInput = z.infer<typeof createTechnologyInputSchema>;

/**
 * Schema for updating a technology
 */
export const updateTechnologyInputSchema = createTechnologyInputSchema.omit({ createdBy: true }).partial();

export type UpdateTechnologyInput = z.infer<typeof updateTechnologyInputSchema>;

// ============================================================================
// RADAR PLACEMENT SCHEMA
// ============================================================================

/**
 * TRL Score schema (1-9)
 * @phase Phase 2 Task 2.1.4
 */
export const trlScoreSchema = z.number().int().min(1).max(9);

/**
 * Technology Snapshot schema for denormalized data
 * @phase Phase 2 Task 2.1.4
 */
export const technologySnapshotSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  category: z.string().optional(),
  snapshotUpdatedAt: z.number().positive().optional(),
});

export type TechnologySnapshotInput = z.infer<typeof technologySnapshotSchema>;

/**
 * Full RadarPlacement entity schema
 */
export const radarPlacementSchema = z.object({
  // Identity
  id: z.string().min(1),
  technologyId: z.string().min(1),
  radarId: z.string().min(1),

  // Position — stable quadrant id that references RadarData.quadrants[].id on the parent radar.
  quadrantId: z.string().min(1),
  ring: ringSchema,

  // Time-to-Impact (Phase 0 Task 0.2.2)
  timeToImpact: timeToImpactSchema.optional(),

  // TRL Score (Phase 2 Task 2.1.1)
  trlScore: trlScoreSchema.optional(),

  // Technology Snapshot (Phase 2 Task 2.1.1)
  technologySnapshot: technologySnapshotSchema.optional(),

  // Rationale
  rationale: z.string().max(2000).optional(),

  // Movement tracking
  movedFrom: z
    .object({
      ring: ringSchema,
      at: z.number().positive(),
      by: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
  movedAt: z.number().positive().optional(),

  // Visualization coordinates
  x: z.number().optional(),
  y: z.number().optional(),

  // Audit
  createdAt: z.number().positive(),
  updatedAt: z.number().positive(),
  placedBy: z.string().optional(),
});

export type RadarPlacement = z.infer<typeof radarPlacementSchema>;

/**
 * Schema for creating a new radar placement
 */
export const createRadarPlacementInputSchema = z.object({
  technologyId: z.string().min(1, 'Technology ID is required'),
  radarId: z.string().min(1, 'Radar ID is required'),
  // Stable quadrant id from the target radar's quadrant config. Callers that
  // know only the display name must resolve it via `resolveQuadrantId` first.
  quadrantId: z.string().min(1, 'Quadrant ID is required'),
  ring: ringSchema,
  timeToImpact: timeToImpactSchema.optional(),
  trlScore: trlScoreSchema.optional(),
  technologySnapshot: technologySnapshotSchema.optional(),
  rationale: z.string().max(2000).optional(),
  placedBy: z.string().optional(),
});

export type CreateRadarPlacementInput = z.infer<typeof createRadarPlacementInputSchema>;

/**
 * Schema for updating a radar placement
 */
export const updateRadarPlacementInputSchema = createRadarPlacementInputSchema
  .omit({ technologyId: true, radarId: true })
  .partial();

export type UpdateRadarPlacementInput = z.infer<typeof updateRadarPlacementInputSchema>;

/**
 * Schema for moving a technology between rings
 */
export const moveRingInputSchema = z.object({
  newRing: ringSchema,
  reason: z.string().max(500).optional(),
  movedBy: z.string().optional(),
});

export type MoveRingInput = z.infer<typeof moveRingInputSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate technology data
 */
export function validateTechnology(data: unknown): Technology {
  return technologySchema.parse(data);
}

/**
 * Validate create technology input
 */
export function validateCreateTechnologyInput(data: unknown): CreateTechnologyInput {
  return createTechnologyInputSchema.parse(data);
}

/**
 * Validate update technology input
 */
export function validateUpdateTechnologyInput(data: unknown): UpdateTechnologyInput {
  return updateTechnologyInputSchema.parse(data);
}

/**
 * Validate radar placement data
 */
export function validateRadarPlacement(data: unknown): RadarPlacement {
  return radarPlacementSchema.parse(data);
}

/**
 * Validate create radar placement input
 */
export function validateCreateRadarPlacementInput(data: unknown): CreateRadarPlacementInput {
  return createRadarPlacementInputSchema.parse(data);
}

/**
 * Safe validation for technology that returns success/error
 */
export function safeValidateTechnology(data: unknown): {
  success: boolean;
  data?: Technology;
  error?: z.ZodError;
} {
  const result = technologySchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for create technology input
 */
export function safeValidateCreateTechnologyInput(data: unknown): {
  success: boolean;
  data?: CreateTechnologyInput;
  error?: z.ZodError;
} {
  const result = createTechnologyInputSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for radar placement
 */
export function safeValidateRadarPlacement(data: unknown): {
  success: boolean;
  data?: RadarPlacement;
  error?: z.ZodError;
} {
  const result = radarPlacementSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for create radar placement input
 */
export function safeValidateCreateRadarPlacementInput(data: unknown): {
  success: boolean;
  data?: CreateRadarPlacementInput;
  error?: z.ZodError;
} {
  const result = createRadarPlacementInputSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
