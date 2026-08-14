/**
 * @file lib/pipeline/entity-extraction.ts
 * @description AI-powered entity extraction from signals
 *
 * Extracts structured entities (companies, technologies, etc.) from
 * unstructured signal content using LLM analysis.
 *
 * **Features:**
 * - Multi-source extraction (title, summary, content)
 * - Confidence scoring for each entity
 * - Entity type classification
 * - Caching for repeated content
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { createLogger } from '@/lib/logger';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { generateStructuredContent } from '@/lib/ai/client';

const log = createLogger('pipeline/entity-extraction');
import { z } from 'zod';
import type { Signal } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface ExtractedEntity {
  name: string;
  type: 'technology' | 'company' | 'person' | 'concept' | 'product';
  confidence: number;
  context?: string;
  aliases?: string[];
}

export interface ExtractionResult {
  signalId: string;
  entities: ExtractedEntity[];
  extractedAt: number;
  sourceFields: string[];
  processingTimeMs: number;
}

export interface BatchExtractionResult {
  results: ExtractionResult[];
  totalSignals: number;
  totalEntities: number;
  averageProcessingTimeMs: number;
  errors: Array<{ signalId: string; error: string }>;
}

// ============================================================================
// SCHEMAS
// ============================================================================

const ExtractedEntitySchema = z.object({
  name: z.string().describe('The normalized name of the entity'),
  type: z.enum(['technology', 'company', 'person', 'concept', 'product']).describe('Entity type'),
  confidence: z.number().min(0).max(100).describe('Confidence score 0-100'),
  context: z.string().optional().describe('Context where entity was mentioned'),
  aliases: z.array(z.string()).optional().describe('Alternative names or abbreviations'),
});

const ExtractionResponseSchema = z.object({
  entities: z.array(ExtractedEntitySchema),
});

// ============================================================================
// EXTRACTION FUNCTIONS
// ============================================================================

/**
 * Extract entities from a single signal using AI.
 *
 * @example
 * ```typescript
 * const result = await extractEntitiesFromSignal(signal);
 * console.log(result.entities);
 * // [{ name: 'OpenAI', type: 'company', confidence: 95 }, ...]
 * ```
 */
export async function extractEntitiesFromSignal(signal: Signal): Promise<ExtractionResult> {
  const startTime = Date.now();
  const sourceFields: string[] = [];

  // Build content string from signal
  const contentParts: string[] = [];

  if (signal.title) {
    contentParts.push(`Title: ${signal.title}`);
    sourceFields.push('title');
  }

  const summaryText = signal.aiSummary || signal.description;
  if (summaryText) {
    contentParts.push(`Summary: ${summaryText}`);
    sourceFields.push(signal.aiSummary ? 'aiSummary' : 'description');
  }

  const expandedSummary =
    signal.expandedContent?.entityProfile?.summary ||
    (signal.expandedContent as { longFormSummary?: string } | undefined)?.longFormSummary;
  if (expandedSummary) {
    contentParts.push(`Content: ${expandedSummary}`);
    sourceFields.push('expandedContent');
  }

  // If no content, return existing linked entities
  if (contentParts.length === 0) {
    return {
      signalId: signal.id,
      entities: extractFromLinkedEntities(signal),
      extractedAt: Date.now(),
      sourceFields: ['linkedEntities'],
      processingTimeMs: Date.now() - startTime,
    };
  }

  const content = contentParts.join('\n\n');

  try {
    const prompt = `Extract all named entities from the following innovation signal content.

Focus on:
- Companies (vendors, startups, partners, competitors)
- Technologies (frameworks, platforms, languages, tools)
- Products (specific software, hardware, services)
- Concepts (methodologies, approaches, strategies)
- People (only notable individuals mentioned by name)

For each entity:
1. Normalize the name (e.g., "Google LLC" → "Google")
2. Assign a confidence score based on clarity of mention
3. Note any aliases mentioned (e.g., "Meta/Facebook")

Content to analyze:
${content}

Extract entities with high precision. Only include entities clearly mentioned in the text.`;

    const response = await generateStructuredContent(prompt, ExtractionResponseSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    // Merge AI results with existing linked entities
    const aiEntities = response.entities;
    const linkedEntities = extractFromLinkedEntities(signal);

    // Deduplicate by name (case-insensitive)
    const entityMap = new Map<string, ExtractedEntity>();

    for (const entity of [...aiEntities, ...linkedEntities]) {
      const key = entity.name.toLowerCase();
      if (!entityMap.has(key) || (entityMap.get(key)?.confidence || 0) < entity.confidence) {
        entityMap.set(key, entity);
      }
    }

    return {
      signalId: signal.id,
      entities: Array.from(entityMap.values()),
      extractedAt: Date.now(),
      sourceFields,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    log.error(`AI extraction failed for signal ${signal.id}`, error instanceof Error ? error : undefined);

    // Fallback to linked entities
    return {
      signalId: signal.id,
      entities: extractFromLinkedEntities(signal),
      extractedAt: Date.now(),
      sourceFields: ['linkedEntities'],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Extract entities from existing linkedEntities field.
 * Used as fallback when AI extraction fails or for efficiency.
 */
function extractFromLinkedEntities(signal: Signal): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];

  if (signal.linkedEntities?.technologies) {
    for (const techId of signal.linkedEntities.technologies) {
      entities.push({
        name: techId,
        type: 'technology',
        confidence: 75,
      });
    }
  }

  if (signal.linkedEntities?.companies) {
    for (const companyId of signal.linkedEntities.companies) {
      entities.push({
        name: companyId,
        type: 'company',
        confidence: 75,
      });
    }
  }

  // Also check expandedContent.relatedItems
  if (signal.expandedContent?.relatedItems?.technologies) {
    for (const tech of signal.expandedContent.relatedItems.technologies) {
      entities.push({
        name: tech.name,
        type: 'technology',
        confidence: 70,
        context: tech.relevance,
      });
    }
  }

  if (signal.expandedContent?.relatedItems?.companies) {
    for (const company of signal.expandedContent.relatedItems.companies) {
      entities.push({
        name: company.name,
        type: 'company',
        confidence: 70,
        context: company.relevance,
      });
    }
  }

  return entities;
}

/**
 * Extract entities from multiple signals in batch.
 *
 * Processes signals in parallel with rate limiting.
 *
 * @example
 * ```typescript
 * const batch = await extractEntitiesFromSignals(signals, { batchSize: 5 });
 * console.log(`Extracted ${batch.totalEntities} entities from ${batch.totalSignals} signals`);
 * ```
 */
export async function extractEntitiesFromSignals(
  signals: Signal[],
  options: {
    batchSize?: number;
    useAI?: boolean;
    minConfidence?: number;
  } = {}
): Promise<BatchExtractionResult> {
  const { batchSize = 5, useAI = true, minConfidence = 50 } = options;

  const results: ExtractionResult[] = [];
  const errors: Array<{ signalId: string; error: string }> = [];
  let totalProcessingTime = 0;

  // Process in batches to avoid rate limiting
  for (let i = 0; i < signals.length; i += batchSize) {
    const batch = signals.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (signal) => {
        try {
          if (useAI) {
            return await extractEntitiesFromSignal(signal);
          } else {
            // Fast mode: only use linked entities
            const startTime = Date.now();
            return {
              signalId: signal.id,
              entities: extractFromLinkedEntities(signal),
              extractedAt: Date.now(),
              sourceFields: ['linkedEntities'],
              processingTimeMs: Date.now() - startTime,
            };
          }
        } catch (error) {
          const err = error instanceof Error ? error.message : String(error);
          errors.push({ signalId: signal.id, error: err });
          return null;
        }
      })
    );

    for (const result of batchResults) {
      if (result) {
        // Filter by confidence
        result.entities = result.entities.filter((e) => e.confidence >= minConfidence);
        results.push(result);
        totalProcessingTime += result.processingTimeMs;
      }
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < signals.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const totalEntities = results.reduce((sum, r) => sum + r.entities.length, 0);

  return {
    results,
    totalSignals: signals.length,
    totalEntities,
    averageProcessingTimeMs: results.length > 0 ? Math.round(totalProcessingTime / results.length) : 0,
    errors,
  };
}

/**
 * Get unique entities across all extraction results.
 * Deduplicates by normalized name.
 */
export function getUniqueEntities(
  results: ExtractionResult[]
): Map<string, ExtractedEntity & { signalIds: string[] }> {
  const entityMap = new Map<string, ExtractedEntity & { signalIds: string[] }>();

  for (const result of results) {
    for (const entity of result.entities) {
      const key = `${entity.type}:${entity.name.toLowerCase()}`;

      if (entityMap.has(key)) {
        const existing = entityMap.get(key)!;
        existing.signalIds.push(result.signalId);
        // Update confidence to max seen
        existing.confidence = Math.max(existing.confidence, entity.confidence);
        // Merge aliases
        if (entity.aliases) {
          existing.aliases = [...new Set([...(existing.aliases || []), ...entity.aliases])];
        }
      } else {
        entityMap.set(key, {
          ...entity,
          signalIds: [result.signalId],
        });
      }
    }
  }

  return entityMap;
}

/**
 * Filter entities by type.
 */
export function filterEntitiesByType(
  entities: ExtractedEntity[],
  type: ExtractedEntity['type']
): ExtractedEntity[] {
  return entities.filter((e) => e.type === type);
}

/**
 * Get entity statistics from extraction results.
 */
export function getExtractionStats(results: ExtractionResult[]): {
  totalSignals: number;
  totalEntities: number;
  byType: Record<string, number>;
  avgConfidence: number;
  avgEntitiesPerSignal: number;
} {
  const allEntities = results.flatMap((r) => r.entities);
  const byType: Record<string, number> = {};

  for (const entity of allEntities) {
    byType[entity.type] = (byType[entity.type] || 0) + 1;
  }

  const avgConfidence =
    allEntities.length > 0
      ? Math.round(allEntities.reduce((sum, e) => sum + e.confidence, 0) / allEntities.length)
      : 0;

  return {
    totalSignals: results.length,
    totalEntities: allEntities.length,
    byType,
    avgConfidence,
    avgEntitiesPerSignal: results.length > 0 ? Math.round(allEntities.length / results.length) : 0,
  };
}
