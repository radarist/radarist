/**
 * @file lib/schemas/entity-document-link.ts
 * @description Zod validation schemas for EntityDocumentLink
 *
 * Provides runtime validation for entity-document relationships
 * used in the Knowledge Tab.
 *
 * @phase Knowledge Tab Sprint - Phase 2
 * @author Radarist Team
 * @created 2026-01-14
 */

import { z } from 'zod';

// ============================================================================
// ENUM SCHEMAS
// ============================================================================

/**
 * Valid entity types that can be linked to documents.
 */
export const entityTypeSchema = z.enum([
  'technology',
  'company',
  'useCase',
  'strategy',
  'prototype',
  'signal',
  'org_unit',
  'initiative',
  'pain_point',
  'document',
]);

/**
 * Document relationship types.
 */
export const documentRelationshipTypeSchema = z.enum([
  'documentation',
  'pitch_deck',
  'technical_spec',
  'case_study',
  'research_paper',
  'competitive_intel',
  'contract',
  'evidence',
  'other',
]);

/**
 * Relevance levels for document links.
 */
export const documentRelevanceSchema = z.enum(['high', 'medium', 'low']);

/**
 * Graph sync status values.
 */
export const graphSyncStatusSchema = z.enum(['pending', 'synced', 'failed']);

// ============================================================================
// MAIN SCHEMAS
// ============================================================================

/**
 * Full EntityDocumentLink schema.
 */
export const entityDocumentLinkSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1).default('default'),

  // Link endpoints
  entityType: entityTypeSchema,
  entityId: z.string().min(1),
  documentId: z.string().min(1),

  // Relationship metadata
  relationshipType: documentRelationshipTypeSchema,
  tags: z.array(z.string()).default([]),
  relevance: documentRelevanceSchema,
  note: z.string().optional(),

  // AI metadata
  aiSuggested: z.boolean().optional(),
  aiConfidence: z.number().min(0).max(100).optional(),

  // Audit fields
  createdAt: z.number().positive(),
  createdBy: z.string().min(1),
  updatedAt: z.number().positive(),

  // Graph sync
  graphSyncStatus: graphSyncStatusSchema.optional(),
  lastSyncedAt: z.number().positive().optional(),
});

/**
 * Schema for creating a new EntityDocumentLink.
 * Excludes auto-generated fields (id, timestamps, sync status).
 */
export const createEntityDocumentLinkSchema = z.object({
  workspaceId: z.string().min(1).default('default'),
  entityType: entityTypeSchema,
  entityId: z.string().min(1),
  documentId: z.string().min(1),
  relationshipType: documentRelationshipTypeSchema,
  tags: z.array(z.string()).default([]),
  relevance: documentRelevanceSchema,
  note: z.string().optional(),
  aiSuggested: z.boolean().optional(),
  aiConfidence: z.number().min(0).max(100).optional(),
  createdBy: z.string().min(1),
});

export type CreateEntityDocumentLinkSchema = z.infer<typeof createEntityDocumentLinkSchema>;

/**
 * Schema for updating an EntityDocumentLink.
 * Only allows updating relationship metadata, not endpoints.
 */
export const updateEntityDocumentLinkSchema = z.object({
  relationshipType: documentRelationshipTypeSchema.optional(),
  tags: z.array(z.string()).optional(),
  relevance: documentRelevanceSchema.optional(),
  note: z.string().nullable().optional(),
  aiSuggested: z.boolean().optional(),
  aiConfidence: z.number().min(0).max(100).nullable().optional(),
});

export type UpdateEntityDocumentLinkSchema = z.infer<typeof updateEntityDocumentLinkSchema>;

/**
 * Schema for querying EntityDocumentLinks.
 */
export const queryEntityDocumentLinksSchema = z.object({
  entityType: entityTypeSchema.optional(),
  entityId: z.string().optional(),
  documentId: z.string().optional(),
  relationshipType: documentRelationshipTypeSchema.optional(),
  relevance: documentRelevanceSchema.optional(),
  workspaceId: z.string().optional(),
  limit: z.number().int().positive().max(100).default(50),
  offset: z.number().int().nonnegative().default(0),
});

export type QueryEntityDocumentLinksSchema = z.infer<typeof queryEntityDocumentLinksSchema>;

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate data for creating an EntityDocumentLink.
 * @throws ZodError if validation fails
 */
export function validateCreateEntityDocumentLink(data: unknown): CreateEntityDocumentLinkSchema {
  return createEntityDocumentLinkSchema.parse(data);
}

/**
 * Validate data for updating an EntityDocumentLink.
 * @throws ZodError if validation fails
 */
export function validateUpdateEntityDocumentLink(data: unknown): UpdateEntityDocumentLinkSchema {
  return updateEntityDocumentLinkSchema.parse(data);
}

/**
 * Safe validation for creating an EntityDocumentLink.
 * Returns success/error instead of throwing.
 */
export function safeValidateCreateEntityDocumentLink(data: unknown): {
  success: boolean;
  data?: CreateEntityDocumentLinkSchema;
  error?: z.ZodError;
} {
  const result = createEntityDocumentLinkSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Safe validation for updating an EntityDocumentLink.
 * Returns success/error instead of throwing.
 */
export function safeValidateUpdateEntityDocumentLink(data: unknown): {
  success: boolean;
  data?: UpdateEntityDocumentLinkSchema;
  error?: z.ZodError;
} {
  const result = updateEntityDocumentLinkSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Validate query parameters for EntityDocumentLinks.
 */
export function validateQueryEntityDocumentLinks(data: unknown): QueryEntityDocumentLinksSchema {
  return queryEntityDocumentLinksSchema.parse(data);
}

// ============================================================================
// CONSTANTS
// ============================================================================

/**
 * Labels for document relationship types (for UI display).
 */
export const DOCUMENT_RELATIONSHIP_TYPE_LABELS: Record<z.infer<typeof documentRelationshipTypeSchema>, string> = {
  documentation: 'Documentation',
  pitch_deck: 'Pitch Deck',
  technical_spec: 'Technical Spec',
  case_study: 'Case Study',
  research_paper: 'Research Paper',
  competitive_intel: 'Competitive Intel',
  contract: 'Contract',
  evidence: 'Evidence',
  other: 'Other',
};

/**
 * Labels for relevance levels (for UI display).
 */
export const DOCUMENT_RELEVANCE_LABELS: Record<z.infer<typeof documentRelevanceSchema>, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Colors for relevance levels (for UI styling).
 */
export const DOCUMENT_RELEVANCE_COLORS: Record<z.infer<typeof documentRelevanceSchema>, string> = {
  high: 'text-green-600',
  medium: 'text-yellow-600',
  low: 'text-gray-500',
};
