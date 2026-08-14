/**
 * @file lib/ai/mutation-tracking.ts
 * @description Centralized mapping for AI tool mutations and cache invalidation.
 *
 * This module provides a single source of truth for:
 * 1. Which AI tools mutate which entity types
 * 2. How to invalidate caches for each entity type
 * 3. Event types for data refresh
 *
 * When adding a new entity type:
 * 1. Add to EntityType union
 * 2. Add to ENTITY_QUERY_KEYS
 * 3. Add to ENTITY_REFRESH_TYPES
 * 4. Add tool mappings to TOOL_ENTITY_MAP
 */

import type { QueryClient } from '@tanstack/react-query';
import {
  companyKeys,
  technologyKeys,
  useCaseKeys,
  prototypeKeys,
  strategyKeys,
  signalKeys,
  relationKeys,
  orgUnitKeys,
  initiativeKeys,
  painPointKeys,
  documentKeys,
  entityDocumentLinkKeys,
  radarKeys,
  radarPlacementKeys,
  visualizationKeys,
} from '@/lib/query-keys';
import type { EntityTypeForRefresh } from '@/lib/events/data-refresh';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/mutation-tracking');

// ============================================================================
// Entity Types (Single Source of Truth)
// ============================================================================

/**
 * All entity types that can be mutated by AI tools.
 * Add new entity types here first.
 */
export type EntityType =
  | 'company'
  | 'technology'
  | 'useCase'
  | 'prototype'
  | 'strategy'
  | 'signal'
  | 'relation'
  | 'orgUnit'
  | 'initiative'
  | 'painPoint'
  | 'document'
  | 'entityDocumentLink'
  | 'report'
  | 'radar'
  | 'radarPlacement';

// ============================================================================
// Query Key Mapping
// ============================================================================

/**
 * Maps entity types to their TanStack Query keys.
 * Used for cache invalidation after mutations.
 */
export const ENTITY_QUERY_KEYS: Record<EntityType, readonly unknown[]> = {
  company: companyKeys.all,
  technology: technologyKeys.all,
  useCase: useCaseKeys.all,
  prototype: prototypeKeys.all,
  strategy: strategyKeys.all,
  signal: signalKeys.all,
  relation: relationKeys.all,
  orgUnit: orgUnitKeys.all,
  initiative: initiativeKeys.all,
  painPoint: painPointKeys.all,
  document: documentKeys.all,
  entityDocumentLink: entityDocumentLinkKeys.all,
  report: ['reports'],
  radar: radarKeys.all,
  radarPlacement: radarPlacementKeys.all,
};

// ============================================================================
// Refresh Type Mapping
// ============================================================================

/**
 * Maps entity types to their refresh event types (plural form).
 * Used for emitting data refresh events.
 */
export const ENTITY_REFRESH_TYPES: Record<EntityType, EntityTypeForRefresh> = {
  company: 'companies',
  technology: 'technologies',
  useCase: 'useCases',
  prototype: 'prototypes',
  strategy: 'strategies',
  signal: 'signals',
  relation: 'relations',
  orgUnit: 'orgUnits',
  initiative: 'initiatives',
  painPoint: 'painPoints',
  document: 'documents',
  entityDocumentLink: 'documents',
  report: 'reports',
  radar: 'radars',
  radarPlacement: 'radarPlacements',
};

export type DeletionMutationSource =
  | 'company'
  | 'technology'
  | 'useCase'
  | 'prototype'
  | 'strategy'
  | 'signal'
  | 'orgUnit'
  | 'initiative'
  | 'painPoint'
  | 'radar'
  | 'radarPlacement';

/**
 * Conservative cache invalidations for server-side deletion cascades.
 * Besides the source document, cascades remove relations/document links and
 * may rewrite live reverse-reference arrays in the listed entity collections.
 */
export const DELETION_MUTATED_ENTITY_TYPES = {
  company: ['company', 'relation', 'document', 'entityDocumentLink', 'technology', 'prototype', 'useCase', 'signal'],
  technology: [
    'technology',
    'radarPlacement',
    'relation',
    'document',
    'entityDocumentLink',
    'prototype',
    'useCase',
    'painPoint',
  ],
  useCase: ['useCase', 'relation', 'document', 'entityDocumentLink', 'technology', 'prototype', 'signal'],
  prototype: ['prototype', 'relation', 'document', 'entityDocumentLink', 'initiative', 'painPoint'],
  strategy: ['strategy', 'relation', 'document', 'entityDocumentLink', 'prototype', 'initiative', 'signal'],
  signal: ['signal', 'relation', 'document', 'entityDocumentLink'],
  orgUnit: ['orgUnit', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
  initiative: ['initiative', 'relation', 'document', 'entityDocumentLink', 'painPoint'],
  painPoint: ['painPoint', 'relation', 'document', 'entityDocumentLink', 'initiative'],
  radar: ['radar', 'radarPlacement', 'technology', 'relation'],
  radarPlacement: ['radarPlacement', 'technology', 'relation'],
} as const satisfies Record<DeletionMutationSource, readonly EntityType[]>;

// ============================================================================
// Tool → Entity Mapping
// ============================================================================

/**
 * Maps AI tool names to the entity types they mutate.
 * Supports exact matches and prefix patterns.
 */
export const TOOL_ENTITY_MAP: Record<string, EntityType[]> = {
  // Company tools
  createCompany: ['company'],
  createCompanyWithResearch: ['company'],
  updateCompany: ['company'],
  deleteCompany: [...DELETION_MUTATED_ENTITY_TYPES.company],
  bulkResearchCompanies: ['company'],
  // AI-043 — a successful source-review decision changes the company's review
  // state; map it so the chat route refreshes the affected Company review UI.
  recordCompanyReviewDecision: ['company'],

  // Technology tools
  createTechnology: ['technology'],
  createDecoupledTechnology: ['technology'],
  updateTechnology: ['technology'],
  deleteTechnology: [...DELETION_MUTATED_ENTITY_TYPES.technology],
  deleteDecoupledTechnology: [...DELETION_MUTATED_ENTITY_TYPES.technology],
  enrichTechnologyFromResearch: ['technology'],

  // Radar placement tools
  placeTechnologyOnRadar: ['radarPlacement', 'technology'],
  confirmPlacement: ['radarPlacement'],
  updateRadarPlacement: ['radarPlacement'],
  deleteRadarPlacement: [...DELETION_MUTATED_ENTITY_TYPES.radarPlacement],
  removeTechnologyFromRadar: [...DELETION_MUTATED_ENTITY_TYPES.radarPlacement],

  // Radar tools
  createRadar: ['radar'],
  updateRadarSettings: ['radar', 'radarPlacement', 'technology'],
  deleteRadar: [...DELETION_MUTATED_ENTITY_TYPES.radar],
  addTechnologiesToRadar: ['radarPlacement', 'technology'],
  updateTechnologyOnRadar: ['radarPlacement', 'technology'],
  populateRadarFromContext: ['radarPlacement', 'technology'],

  // Use Case tools
  createUseCase: ['useCase'],
  updateUseCase: ['useCase'],
  deleteUseCase: [...DELETION_MUTATED_ENTITY_TYPES.useCase],

  // Prototype tools
  createPrototype: ['prototype'],
  updatePrototype: ['prototype'],
  deletePrototype: [...DELETION_MUTATED_ENTITY_TYPES.prototype],

  // Strategy tools
  createStrategy: ['strategy'],
  updateStrategy: ['strategy'],
  deleteStrategy: [...DELETION_MUTATED_ENTITY_TYPES.strategy],

  // Signal tools
  createSignal: ['signal'],
  createSignalManual: ['signal'],
  updateSignal: ['signal'],
  deleteSignal: [...DELETION_MUTATED_ENTITY_TYPES.signal],
  approveSignalForImport: ['signal'],
  rejectSignalWithReason: ['signal'],
  bulkApproveSignals: ['signal'],
  bulkRejectSignals: ['signal'],

  // Relation tools
  createRelation: ['relation'],
  createRelations: ['relation'],
  proposeVerifiedRelation: ['relation'],
  approveProposedRelation: ['relation'],
  deleteRelation: ['relation'],
  bulkCreateRelations: ['relation'],

  // OrgUnit tools
  createOrgUnit: ['orgUnit'],
  updateOrgUnit: ['orgUnit'],
  deleteOrgUnit: [...DELETION_MUTATED_ENTITY_TYPES.orgUnit],

  // Initiative tools
  createInitiative: ['initiative'],
  updateInitiative: ['initiative'],
  deleteInitiative: [...DELETION_MUTATED_ENTITY_TYPES.initiative],

  // PainPoint tools
  createPainPoint: ['painPoint'],
  updatePainPoint: ['painPoint'],
  deletePainPoint: [...DELETION_MUTATED_ENTITY_TYPES.painPoint],

  // Document tools
  createDocument: ['document'],
  updateDocument: ['document'],
  deleteDocument: ['document'],
  captureEvidence: ['document', 'relation'],
  linkDocumentToEntity: ['entityDocumentLink', 'document'],

  // Report tools
  publishReport: ['report'],
  updateReport: ['report'],
  restoreReport: ['report'],
  deleteReport: ['report'],

  // Generic tools (entity type from args)
  updateEntity: [], // Will be determined from args
  deleteEntity: [], // Will be determined from args
  bulkUpdateEntities: [], // Will be determined from args
  bulkDeleteEntities: [], // Will be determined from args
};

/**
 * Prefixes that indicate a tool is a mutation.
 */
export const MUTATION_PREFIXES = ['create', 'update', 'delete', 'enrich', 'bulk', 'approve', 'reject'];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalize MCP-prefixed tool names to their base name.
 * e.g., "mcp__impulse-entities__createCompany" → "createCompany"
 *
 * Task 2.3: Claude Agent SDK prefixes MCP tools with `mcp__<server>__`.
 */
export function normalizeToolName(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    return parts[parts.length - 1];
  }
  return toolName;
}

/**
 * Get entity types mutated by a tool.
 *
 * @param toolName - Name of the AI tool (supports MCP-prefixed names)
 * @param args - Tool arguments (for generic tools like updateEntity)
 * @returns Array of entity types mutated
 */
export function getToolMutatedTypes(toolName: string, args?: Record<string, unknown>): EntityType[] {
  const normalized = normalizeToolName(toolName);
  // Check exact match first
  const exactMatch = Object.hasOwn(TOOL_ENTITY_MAP, normalized) ? TOOL_ENTITY_MAP[normalized] : undefined;
  if (exactMatch && exactMatch.length > 0) {
    return exactMatch;
  }

  // For generic tools, get entity type from args
  if (['updateEntity', 'deleteEntity', 'bulkUpdateEntities', 'bulkDeleteEntities'].includes(normalized)) {
    const entityType = args?.entityType as EntityType | undefined;
    if (entityType && isValidEntityType(entityType)) {
      if (normalized === 'deleteEntity' || normalized === 'bulkDeleteEntities') {
        const deletionTypes = DELETION_MUTATED_ENTITY_TYPES[entityType as DeletionMutationSource];
        if (deletionTypes) return [...deletionTypes];
      }
      return [entityType];
    }
  }

  // Fallback: try to infer from tool name
  const toolNameLower = toolName.toLowerCase();
  // Prefer the most specific match (`radarPlacement` before `radar`).
  const entityTypesBySpecificity = (Object.keys(ENTITY_QUERY_KEYS) as EntityType[]).sort(
    (left, right) => right.length - left.length
  );
  for (const entityType of entityTypesBySpecificity) {
    if (toolNameLower.includes(entityType.toLowerCase())) {
      // Only if it's a mutation tool
      if (MUTATION_PREFIXES.some((prefix) => toolNameLower.startsWith(prefix))) {
        return [entityType];
      }
    }
  }

  return [];
}

/**
 * Check if a tool is a mutation tool.
 */
export function isMutationTool(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  // Check if in the map
  if (Object.hasOwn(TOOL_ENTITY_MAP, normalized)) {
    return true;
  }
  // Check prefixes
  const normalizedLower = normalized.toLowerCase();
  return MUTATION_PREFIXES.some((prefix) => normalizedLower.startsWith(prefix));
}

/**
 * Type guard for EntityType.
 */
export function isValidEntityType(type: string): type is EntityType {
  return Object.prototype.hasOwnProperty.call(ENTITY_QUERY_KEYS, type);
}

/**
 * Invalidate TanStack Query caches for given entity types.
 *
 * @param queryClient - TanStack Query client
 * @param entityTypes - Entity types to invalidate
 */
export function invalidateCaches(queryClient: QueryClient, entityTypes: EntityType[]): void {
  for (const entityType of entityTypes) {
    const queryKey = ENTITY_QUERY_KEYS[entityType];
    if (queryKey) {
      queryClient.invalidateQueries({ queryKey });
      log.debug('Invalidated cache', { entityType });
    }
  }
}

/**
 * Get refresh event types for given entity types.
 *
 * @param entityTypes - Entity types
 * @returns Array of refresh event types
 */
export function getRefreshTypes(entityTypes: EntityType[]): EntityTypeForRefresh[] {
  return Array.from(
    new Set(
      entityTypes.map((type) => ENTITY_REFRESH_TYPES[type]).filter((type): type is EntityTypeForRefresh => !!type)
    )
  );
}

/**
 * Extract all mutated entity types from a list of tool calls.
 *
 * A tool may report concrete mutations in `result.data.mutatedEntityTypes`.
 * This is intentionally independent of `success`: a fail-closed cascade can
 * still have removed dependent records before retaining its source entity.
 * Reported values are treated as untrusted tool output and filtered through
 * the canonical EntityType registry before they can drive invalidation.
 *
 * @param toolCalls - Array of tool calls with arguments, status, and result
 * @returns Set of mutated entity types
 */
export function extractMutatedTypes(
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    success: boolean;
    result?: unknown;
  }>
): Set<EntityType> {
  const mutatedTypes = new Set<EntityType>();

  for (const toolCall of toolCalls) {
    const resultData =
      toolCall.result && typeof toolCall.result === 'object' ? (toolCall.result as { data?: unknown }).data : undefined;
    const reportedTypes =
      resultData && typeof resultData === 'object'
        ? (resultData as { mutatedEntityTypes?: unknown }).mutatedEntityTypes
        : undefined;

    if (Array.isArray(reportedTypes)) {
      for (const reportedType of reportedTypes) {
        if (typeof reportedType === 'string' && isValidEntityType(reportedType)) {
          mutatedTypes.add(reportedType);
        }
      }
    }

    if (!toolCall.success) continue;

    const types = getToolMutatedTypes(toolCall.name, toolCall.args);
    for (const type of types) {
      mutatedTypes.add(type);
    }
  }

  return mutatedTypes;
}

/**
 * Tools whose output is an ARTIFACT that lands in the Visualizations / Infographics
 * gallery. Artifacts are NOT graph EntityTypes (they're absent from TOOL_ENTITY_MAP),
 * so their views refresh via this separate seam — without it, a saved diagram or a
 * generated visualization wouldn't appear until a manual page reload.
 */
const VISUALIZATION_TOOLS = new Set(['saveDiagram', 'generateVisualization']);

/**
 * Query keys to invalidate for ARTIFACTS produced by a turn's tool calls. Only
 * successful calls count. Returns [] when no artifact-producing tool ran.
 *
 * AI-011 — when a visualization tool reports its persisted Firestore identity
 * (`result.data.visualizationId`), the detail key for that exact record is
 * invalidated alongside the gallery list, so a freshly generated visualization
 * refreshes its own view without waiting for the list to reload.
 */
export function extractMutatedArtifactKeys(
  toolCalls: Array<{ name: string; success: boolean; result?: unknown }>
): readonly (readonly unknown[])[] {
  const keys: (readonly unknown[])[] = [];
  let invalidatedAll = false;
  for (const toolCall of toolCalls) {
    if (!toolCall.success || !VISUALIZATION_TOOLS.has(toolCall.name)) continue;
    if (!invalidatedAll) {
      keys.push(visualizationKeys.all);
      invalidatedAll = true;
    }
    const resultData =
      toolCall.result && typeof toolCall.result === 'object'
        ? (toolCall.result as { data?: unknown }).data
        : undefined;
    const visualizationId =
      resultData && typeof resultData === 'object'
        ? (resultData as { visualizationId?: unknown }).visualizationId
        : undefined;
    if (typeof visualizationId === 'string' && visualizationId.length > 0) {
      keys.push(visualizationKeys.detail(visualizationId));
    }
  }
  return keys;
}
