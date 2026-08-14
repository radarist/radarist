/**
 * @file ai/tools/enrichment.ts
 * @description Entity enrichment and bulk operation tools for AI Assistant
 *
 * Provides capabilities for:
 * - Enriching entities with research data
 * - Bulk operations on entities
 * - Creating multiple relations at once
 *
 * @author Radarist Team
 * @created 2025-12-02
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { adminGetCompanies } from '@/lib/companies-admin';
import { adminCreateRelationFromIds } from '@/lib/relations-admin';
import { cleanMarkdownFromText } from '@/lib/ai/signal-evaluation';
import { needsResolution, safeResolve } from '@/lib/migration';
import { fuzzySearch } from '@/lib/fuzzy-search';
import type { EntityType, RelationType, Company, UseCase, Prototype, Strategy, Document } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/enrichment');

// ============================================================================
// Tool Definitions for Enrichment and Bulk Operations
// ============================================================================

// AI-043 — `enrichCompanyFromResearch` was REMOVED. It wrote arbitrary research
// fields straight onto the canonical Company with no source review. It is gone
// from every callable/advertised surface (tool declarations, dispatch, CORE,
// entities MCP, permissions, mutation tracking, generated capability artifacts).
// Canonical fields are promoted only through the human source-review workflow and
// its separate, explicit promotion action.
export const ENRICHMENT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'enrichTechnologyFromResearch',
    description:
      'Enrich a technology record with research data. Use this to update technology information with latest findings.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: "Technology ID (supports both new 'tech-xxx' format and legacy 'radarId:techId' format)",
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {
            description: { type: SchemaType.STRING },
            ring: { type: SchemaType.STRING },
            status: { type: SchemaType.STRING },
            maturity: { type: SchemaType.NUMBER },
            tags: {
              type: SchemaType.ARRAY,
              items: { type: SchemaType.STRING },
            },
            notes: { type: SchemaType.STRING },
          },
          description: 'Fields to update with research data',
        },
      },
      required: ['technologyId', 'updates'],
    },
  },
  {
    name: 'bulkCreateRelations',
    description: 'Create multiple relations at once. Use this to efficiently link multiple entities.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        relations: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              sourceType: { type: SchemaType.STRING },
              sourceId: { type: SchemaType.STRING },
              targetType: { type: SchemaType.STRING },
              targetId: { type: SchemaType.STRING },
              relationType: { type: SchemaType.STRING },
              notes: { type: SchemaType.STRING },
            },
          },
          description: 'Array of relations to create',
        },
      },
      required: ['relations'],
    },
  },
  {
    name: 'bulkUpdateEntities',
    description: 'Update multiple entities of the same type with the same changes. Use for batch updates.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          description: "Type of entities to update: 'company', 'technology', 'useCase', 'prototype'",
        },
        ids: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Array of entity IDs to update',
        },
        updates: {
          type: SchemaType.OBJECT,
          properties: {},
          description: 'Fields to update on all entities',
        },
        confirmed: {
          type: SchemaType.BOOLEAN,
          description: 'Must be true to execute bulk update',
        },
      },
      required: ['entityType', 'ids', 'updates'],
    },
  },
  {
    name: 'findAndLinkRelatedEntities',
    description: 'Automatically find and create relations based on entity content. Uses AI to suggest links.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          description: 'Type of the source entity',
        },
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the source entity',
        },
        targetTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: "Types of entities to search for relations (e.g., ['technology', 'company'])",
        },
        autoLink: {
          type: SchemaType.BOOLEAN,
          description: 'If true, automatically create suggested relations. If false, just return suggestions.',
        },
      },
      required: ['entityType', 'entityId'],
    },
  },
  {
    name: 'createRelationsByName',
    description:
      'Create relations between entities using their NAMES instead of IDs. This is the PREFERRED tool for creating relations because it handles name-to-ID resolution automatically. Searches for entities by name and creates relations only if both entities exist. IMPORTANT: Use this tool instead of bulkCreateRelations when you have entity names.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        relations: {
          type: SchemaType.ARRAY,
          items: {
            type: SchemaType.OBJECT,
            properties: {
              sourceType: {
                type: SchemaType.STRING,
                description:
                  "Type of source entity: 'technology', 'company', 'useCase', 'prototype', 'strategy', 'document'",
              },
              sourceName: {
                type: SchemaType.STRING,
                description: 'Name of the source entity (will be searched)',
              },
              sourceId: {
                type: SchemaType.STRING,
                description: 'Optional: If you have the ID, provide it to skip name search',
              },
              targetType: {
                type: SchemaType.STRING,
                description:
                  "Type of target entity: 'technology', 'company', 'useCase', 'prototype', 'strategy', 'document'",
              },
              targetName: {
                type: SchemaType.STRING,
                description: 'Name of the target entity (will be searched)',
              },
              targetId: {
                type: SchemaType.STRING,
                description: 'Optional: If you have the ID, provide it to skip name search',
              },
              relationType: {
                type: SchemaType.STRING,
                description:
                  "Type of relationship: 'uses', 'enables', 'competes_with', 'vendor', 'user', 'partner', 'competitor', 'addresses', 'requires', 'aligns_with', 'supports'",
              },
              notes: {
                type: SchemaType.STRING,
                description: 'Optional notes about this relationship',
              },
            },
            required: ['sourceType', 'targetType', 'relationType'],
          },
          description:
            'Array of relations to create. Each relation must have either sourceName or sourceId, and either targetName or targetId.',
        },
      },
      required: ['relations'],
    },
  },
];

// ============================================================================
// Tool Execution Functions
// ============================================================================

// `executeEnrichCompany` was REMOVED with `enrichCompanyFromResearch` (AI-043).
// There is no callable company-enrich-from-research path; company research is
// reviewed and promoted through the source-review workflow only.

/**
 * Enrich a technology with research data
 */
export async function executeEnrichTechnology(
  args: Record<string, unknown>
): Promise<{ success: boolean; data?: { technologyId: string; fieldsUpdated: string[] }; error?: string }> {
  try {
    const technologyId = args.technologyId as string;
    const updates = args.updates as Record<string, unknown>;

    log.info('Enriching technology', { technologyId });

    // Clean markdown from text fields
    const cleanedUpdates: Record<string, unknown> = {};
    const fieldsUpdated: string[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && value !== null) {
        if (typeof value === 'string') {
          cleanedUpdates[key] = cleanMarkdownFromText(value);
        } else {
          cleanedUpdates[key] = value;
        }
        fieldsUpdated.push(key);
      }
    }

    // Resolve any legacy composite IDs to the canonical tech-xxx form.
    const resolvedId = needsResolution(technologyId) ? safeResolve(technologyId) : technologyId;
    if (!resolvedId.startsWith('tech-')) {
      return {
        success: false,
        error: 'Technology ID must be in format "tech-xxx"',
      };
    }

    const { adminUpdateTechnology } = await import('@/lib/technology-admin');
    await adminUpdateTechnology(resolvedId, cleanedUpdates);
    log.info('Updated decoupled technology', { technologyId: resolvedId, fieldsUpdated });

    return {
      success: true,
      data: { technologyId: resolvedId, fieldsUpdated },
    };
  } catch (error) {
    log.error('Failed to enrich technology', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to enrich technology',
    };
  }
}

/**
 * Create multiple relations at once
 */
export async function executeBulkCreateRelations(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    created: number;
    failed: number;
    results: Array<{ sourceId: string; targetId: string; success: boolean; error?: string }>;
  };
  error?: string;
}> {
  try {
    const relations = args.relations as Array<{
      sourceType: EntityType;
      sourceId: string;
      targetType: EntityType;
      targetId: string;
      relationType: RelationType;
      notes?: string;
    }>;

    log.info('Creating relations', { count: relations.length });

    const results: Array<{ sourceId: string; targetId: string; success: boolean; error?: string }> = [];
    let created = 0;
    let failed = 0;

    for (const relation of relations) {
      try {
        await adminCreateRelationFromIds({
          sourceType: relation.sourceType,
          sourceId: relation.sourceId,
          targetType: relation.targetType,
          targetId: relation.targetId,
          relationType: relation.relationType,
          notes: relation.notes,
          // F102: machine writer — route through the :Assertion layer and the
          // <75 materialization gate instead of falling back to the Class A
          // curated defaults (aiSuggested:false, confidence 100).
          aiSuggested: true,
          agentName: 'assistant',
          claimStatus: 'proposed',
          confidence: 70,
        });
        results.push({
          sourceId: relation.sourceId,
          targetId: relation.targetId,
          success: true,
        });
        created++;
      } catch (error) {
        results.push({
          sourceId: relation.sourceId,
          targetId: relation.targetId,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    return {
      success: true,
      data: { created, failed, results },
    };
  } catch (error) {
    log.error('Bulk create relations failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bulk create relations failed',
    };
  }
}

/**
 * Bulk update entities
 */
export async function executeBulkUpdateEntities(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    updated: number;
    failed: number;
    results: Array<{ id: string; success: boolean; error?: string }>;
  };
  error?: string;
}> {
  const entityType = args.entityType as string;
  const ids = args.ids as string[];
  const updates = args.updates as Record<string, unknown>;
  const confirmed = args.confirmed as boolean;

  if (!confirmed) {
    return {
      success: false,
      error: `Bulk update requires confirmation. Will update ${ids.length} ${entityType} entities with: ${JSON.stringify(updates)}`,
    };
  }

  try {
    log.info('Bulk updating entities', { count: ids.length, entityType });

    // Clean markdown from text fields
    const cleanedUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && value !== null) {
        if (typeof value === 'string') {
          cleanedUpdates[key] = cleanMarkdownFromText(value);
        } else {
          cleanedUpdates[key] = value;
        }
      }
    }

    const results: Array<{ id: string; success: boolean; error?: string }> = [];
    let updated = 0;
    let failed = 0;

    for (const id of ids) {
      try {
        switch (entityType) {
          case 'company': {
            const { adminUpdateCompany } = await import('@/lib/companies-admin');
            await adminUpdateCompany(id, cleanedUpdates);
            break;
          }
          case 'technology': {
            const resolvedId = needsResolution(id) ? safeResolve(id) : id;
            if (!resolvedId.startsWith('tech-')) {
              throw new Error('Invalid technology ID format. Expected "tech-xxx"');
            }
            const { adminUpdateTechnology } = await import('@/lib/technology-admin');
            await adminUpdateTechnology(resolvedId, cleanedUpdates);
            break;
          }
          case 'useCase': {
            const { adminUpdateUseCase } = await import('@/lib/use-cases-admin');
            await adminUpdateUseCase(id, cleanedUpdates);
            break;
          }
          case 'prototype': {
            const { adminUpdatePrototype } = await import('@/lib/prototypes-admin');
            await adminUpdatePrototype(id, cleanedUpdates);
            break;
          }
          default:
            throw new Error(`Unknown entity type: ${entityType}`);
        }
        results.push({ id, success: true });
        updated++;
      } catch (error) {
        results.push({
          id,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    return {
      success: true,
      data: { updated, failed, results },
    };
  } catch (error) {
    log.error('Bulk update failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Bulk update failed',
    };
  }
}

/**
 * Find and suggest related entities
 * This is a placeholder - in production would use AI to analyze content
 */
export async function executeFindAndLinkRelatedEntities(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    suggestions: Array<{
      targetType: string;
      targetId: string;
      targetName: string;
      relationType: string;
      confidence: number;
    }>;
    autoLinked: number;
  };
  error?: string;
}> {
  try {
    const entityType = args.entityType as string;
    const entityId = args.entityId as string;
    const _targetTypes = args.targetTypes as string[] | undefined;
    const _autoLink = args.autoLink as boolean;

    log.info('Finding related entities', { entityType, entityId });

    // In production, this would:
    // 1. Load the source entity
    // 2. Use AI to analyze its content
    // 3. Search for matching entities in the specified types
    // 4. Return or create suggested relations

    // Placeholder response
    return {
      success: true,
      data: {
        suggestions: [],
        autoLinked: 0,
      },
    };
  } catch (error) {
    log.error('Find related entities failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Find related entities failed',
    };
  }
}

// ============================================================================
// Entity Name Resolution Helpers
// ============================================================================

interface EntityMatch {
  id: string;
  name: string;
  score: number;
}

/**
 * Resolve an entity name to its ID by searching the database
 */
async function resolveEntityByName(entityType: EntityType, entityName: string): Promise<EntityMatch | null> {
  log.debug('Resolving entity by name', { entityType, entityName });

  switch (entityType) {
    case 'company': {
      const companies = await adminGetCompanies();
      // First try exact match (case-insensitive)
      const normalizedName = entityName.toLowerCase().trim();
      const exactMatch = companies.find((c) => c.name.toLowerCase().trim() === normalizedName);
      if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.name, score: 1.0 };
      }

      // Fuzzy search
      const matches = fuzzySearch(companies as unknown as Record<string, unknown>[], entityName, {
        keys: ['name'],
        threshold: 0.3,
        limit: 3,
      }) as unknown as Company[];

      if (matches.length > 0) {
        return { id: matches[0].id, name: matches[0].name, score: 0.8 };
      }
      return null;
    }

    case 'technology': {
      const { adminGetTechnologies } = await import('@/lib/technology-admin');
      const technologies = await adminGetTechnologies({ search: entityName, limit: 5 });

      if (technologies.length === 0) return null;

      // First try exact match
      const normalizedName = entityName.toLowerCase().trim();
      const exactMatch = technologies.find((t) => t.name.toLowerCase().trim() === normalizedName);
      if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.name, score: 1.0 };
      }

      // Return best fuzzy match
      return { id: technologies[0].id, name: technologies[0].name, score: 0.8 };
    }

    case 'useCase': {
      const { adminGetUseCases } = await import('@/lib/use-cases-admin');
      const useCases = await adminGetUseCases();

      const normalizedName = entityName.toLowerCase().trim();
      const exactMatch = useCases.find((u) => u.title.toLowerCase().trim() === normalizedName);
      if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.title, score: 1.0 };
      }

      const matches = fuzzySearch(useCases as unknown as Record<string, unknown>[], entityName, {
        keys: ['title'],
        threshold: 0.3,
        limit: 3,
      }) as unknown as UseCase[];

      if (matches.length > 0) {
        return { id: matches[0].id, name: matches[0].title, score: 0.8 };
      }
      return null;
    }

    case 'prototype': {
      const { adminGetPrototypes } = await import('@/lib/prototypes-admin');
      const prototypes = await adminGetPrototypes();

      const normalizedName = entityName.toLowerCase().trim();
      const exactMatch = prototypes.find((p) => p.name.toLowerCase().trim() === normalizedName);
      if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.name, score: 1.0 };
      }

      const matches = fuzzySearch(prototypes as unknown as Record<string, unknown>[], entityName, {
        keys: ['name'],
        threshold: 0.3,
        limit: 3,
      }) as unknown as Prototype[];

      if (matches.length > 0) {
        return { id: matches[0].id, name: matches[0].name, score: 0.8 };
      }
      return null;
    }

    case 'strategy': {
      const { adminGetStrategies } = await import('@/lib/strategies-admin');
      const strategies = await adminGetStrategies();

      const normalizedName = entityName.toLowerCase().trim();
      const exactMatch = strategies.find((s) => s.name.toLowerCase().trim() === normalizedName);
      if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.name, score: 1.0 };
      }

      const matches = fuzzySearch(strategies as unknown as Record<string, unknown>[], entityName, {
        keys: ['name'],
        threshold: 0.3,
        limit: 3,
      }) as unknown as Strategy[];

      if (matches.length > 0) {
        return { id: matches[0].id, name: matches[0].name, score: 0.8 };
      }
      return null;
    }

    case 'document': {
      const { adminGetDocuments } = await import('@/lib/document-admin');
      const documents = await adminGetDocuments();

      const normalizedName = entityName.toLowerCase().trim();
      const exactMatch = documents.find((d: Document) => d.title.toLowerCase().trim() === normalizedName);
      if (exactMatch) {
        return { id: exactMatch.id, name: exactMatch.title, score: 1.0 };
      }

      const matches = fuzzySearch(documents as unknown as Record<string, unknown>[], entityName, {
        keys: ['title'],
        threshold: 0.3,
        limit: 3,
      }) as unknown as Document[];

      if (matches.length > 0) {
        return { id: matches[0].id, name: matches[0].title, score: 0.8 };
      }
      return null;
    }

    default:
      log.warn('Unsupported entity type for name resolution', { entityType });
      return null;
  }
}

/**
 * Create relations by resolving entity names to IDs first.
 * This is the PREFERRED method for the AI to create relations.
 */
export async function executeCreateRelationsByName(args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: {
    message: string;
    created: number;
    failed: number;
    notFound: number;
    results: Array<{
      sourceName: string;
      targetName: string;
      success: boolean;
      error?: string;
      resolvedSourceId?: string;
      resolvedTargetId?: string;
    }>;
    notFoundEntities: Array<{
      type: string;
      name: string;
      searchedFor: string;
    }>;
  };
  error?: string;
}> {
  try {
    const relations = args.relations as Array<{
      sourceType: EntityType;
      sourceName?: string;
      sourceId?: string;
      targetType: EntityType;
      targetName?: string;
      targetId?: string;
      relationType: RelationType;
      notes?: string;
    }>;

    log.info('Creating relations', { count: relations.length });

    const results: Array<{
      sourceName: string;
      targetName: string;
      success: boolean;
      error?: string;
      resolvedSourceId?: string;
      resolvedTargetId?: string;
    }> = [];
    const notFoundEntities: Array<{
      type: string;
      name: string;
      searchedFor: string;
    }> = [];

    let created = 0;
    let failed = 0;
    let notFound = 0;

    for (const relation of relations) {
      const sourceName = relation.sourceName || relation.sourceId || 'unknown';
      const targetName = relation.targetName || relation.targetId || 'unknown';

      try {
        // Resolve source entity
        let sourceId = relation.sourceId;
        if (!sourceId && relation.sourceName) {
          const sourceMatch = await resolveEntityByName(relation.sourceType, relation.sourceName);
          if (sourceMatch) {
            sourceId = sourceMatch.id;
            log.debug('Resolved source', { sourceName: relation.sourceName, sourceId });
          } else {
            notFound++;
            notFoundEntities.push({
              type: relation.sourceType,
              name: relation.sourceName,
              searchedFor: 'source',
            });
            results.push({
              sourceName,
              targetName,
              success: false,
              error: `Source ${relation.sourceType} not found: "${relation.sourceName}"`,
            });
            continue;
          }
        }

        if (!sourceId) {
          results.push({
            sourceName,
            targetName,
            success: false,
            error: 'No source ID or name provided',
          });
          failed++;
          continue;
        }

        // Resolve target entity
        let targetId = relation.targetId;
        if (!targetId && relation.targetName) {
          const targetMatch = await resolveEntityByName(relation.targetType, relation.targetName);
          if (targetMatch) {
            targetId = targetMatch.id;
            log.debug('Resolved target', { targetName: relation.targetName, targetId });
          } else {
            notFound++;
            notFoundEntities.push({
              type: relation.targetType,
              name: relation.targetName,
              searchedFor: 'target',
            });
            results.push({
              sourceName,
              targetName,
              success: false,
              error: `Target ${relation.targetType} not found: "${relation.targetName}"`,
            });
            continue;
          }
        }

        if (!targetId) {
          results.push({
            sourceName,
            targetName,
            success: false,
            error: 'No target ID or name provided',
          });
          failed++;
          continue;
        }

        // Create the relation. F102: machine writer — stamp agent provenance
        // so the write routes through the :Assertion layer and the <75
        // materialization gate instead of the Class A curated defaults.
        await adminCreateRelationFromIds({
          sourceType: relation.sourceType,
          sourceId,
          targetType: relation.targetType,
          targetId,
          relationType: relation.relationType,
          notes: relation.notes,
          aiSuggested: true,
          agentName: 'assistant',
          claimStatus: 'proposed',
          confidence: 70,
        });

        results.push({
          sourceName,
          targetName,
          success: true,
          resolvedSourceId: sourceId,
          resolvedTargetId: targetId,
        });
        created++;
        log.info('Created relation', { sourceName, relationType: relation.relationType, targetName });
      } catch (error) {
        results.push({
          sourceName,
          targetName,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    // Build helpful summary message
    let message = `Created ${created} relation(s).`;
    if (notFound > 0) {
      message += ` ${notFound} entities not found in database.`;
      if (notFoundEntities.length > 0) {
        const uniqueNotFound = notFoundEntities.filter(
          (e, i, arr) => arr.findIndex((x) => x.type === e.type && x.name === e.name) === i
        );
        message += ` Missing: ${uniqueNotFound.map((e) => `${e.type} "${e.name}"`).join(', ')}.`;
        message += ` To fix: Create these entities first, then re-run the relation creation.`;
      }
    }
    if (failed > 0 && failed !== notFound) {
      message += ` ${failed - notFound} failed due to other errors.`;
    }

    log.info('Relations by name complete', { message, created, failed, notFound });

    return {
      success: true,
      data: {
        message,
        created,
        failed,
        notFound,
        results,
        notFoundEntities,
      },
    };
  } catch (error) {
    log.error('Bulk create relations failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Create relations by name failed',
    };
  }
}
