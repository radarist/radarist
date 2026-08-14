/**
 * @file lib/pipeline/relation-proposal.ts
 * @description AI-powered relation proposal service
 *
 * Proposes relations between entities based on:
 * - Co-occurrence in signals (entities mentioned together)
 * - AI analysis of signal content
 * - Pattern matching (company-uses-technology, tech-solves-painpoint)
 *
 * **Relation Types:**
 * - VENDOR: Company is vendor of technology
 * - USES: Entity uses technology
 * - DEVELOPS: Company develops technology
 * - SOLVES: Technology/prototype solves pain point
 * - ALIGNS_WITH: Entity aligns with strategy
 * - COMPETES_WITH: Company competes with company
 * - PARTNERS_WITH: Company partners with company
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { createLogger } from '@/lib/logger';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { generateStructuredContent } from '@/lib/ai/client';

const log = createLogger('pipeline/relation-proposal');
import { z } from 'zod';
import type { ExtractedEntity, ExtractionResult } from './entity-extraction';
import type { RelationType } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface ProposedRelation {
  sourceId?: string;
  sourceName: string;
  sourceType: ExtractedEntity['type'];
  targetId?: string;
  targetName: string;
  targetType: ExtractedEntity['type'];
  relationType: RelationType;
  confidence: number;
  reasoning: string;
  signalIds: string[];
  proposedAt: number;
}

export interface RelationProposalResult {
  proposals: ProposedRelation[];
  totalCoOccurrences: number;
  processingTimeMs: number;
  method: 'cooccurrence' | 'ai' | 'combined';
}

export interface CoOccurrence {
  entity1: { name: string; type: ExtractedEntity['type'] };
  entity2: { name: string; type: ExtractedEntity['type'] };
  signalIds: string[];
  count: number;
}

// ============================================================================
// SCHEMAS
// ============================================================================

const RelationProposalSchema = z.object({
  relations: z.array(
    z.object({
      sourceName: z.string(),
      targetName: z.string(),
      relationType: z.enum([
        'vendor',
        'uses',
        'solves',
        'addresses',
        'aligns_with',
        'competes_with',
        'partner',
        'enables',
        'implements',
        'requires',
        'related_to',
        'custom',
      ]),
      confidence: z.number().min(0).max(100),
      reasoning: z.string(),
    })
  ),
});

// ============================================================================
// CO-OCCURRENCE ANALYSIS
// ============================================================================

/**
 * Find entity co-occurrences in extraction results.
 *
 * Two entities "co-occur" when they appear in the same signal.
 */
export function findCoOccurrences(results: ExtractionResult[]): CoOccurrence[] {
  const coOccurrenceMap = new Map<string, CoOccurrence>();

  for (const result of results) {
    const entities = result.entities;

    // Create pairs of all entities in this signal
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const e1 = entities[i];
        const e2 = entities[j];

        // Create consistent key (alphabetical order)
        const key =
          e1.name.localeCompare(e2.name) < 0
            ? `${e1.type}:${e1.name}|${e2.type}:${e2.name}`
            : `${e2.type}:${e2.name}|${e1.type}:${e1.name}`;

        if (coOccurrenceMap.has(key)) {
          const existing = coOccurrenceMap.get(key)!;
          existing.signalIds.push(result.signalId);
          existing.count++;
        } else {
          coOccurrenceMap.set(key, {
            entity1:
              e1.name.localeCompare(e2.name) < 0
                ? { name: e1.name, type: e1.type }
                : { name: e2.name, type: e2.type },
            entity2:
              e1.name.localeCompare(e2.name) < 0
                ? { name: e2.name, type: e2.type }
                : { name: e1.name, type: e1.type },
            signalIds: [result.signalId],
            count: 1,
          });
        }
      }
    }
  }

  // Convert to array and sort by count
  return Array.from(coOccurrenceMap.values()).sort((a, b) => b.count - a.count);
}

/**
 * Infer relation type from entity types.
 */
function inferRelationType(
  sourceType: ExtractedEntity['type'],
  targetType: ExtractedEntity['type']
): RelationType {
  // Company → Technology patterns
  if (sourceType === 'company' && targetType === 'technology') {
    return 'vendor';
  }
  if (sourceType === 'technology' && targetType === 'company') {
    return 'vendor';
  }

  // Company → Company patterns
  if (sourceType === 'company' && targetType === 'company') {
    return 'competitor';
  }

  // Technology → Concept (often pain points)
  if (sourceType === 'technology' && targetType === 'concept') {
    return 'addresses';
  }
  if (sourceType === 'concept' && targetType === 'technology') {
    return 'addresses';
  }

  // Default
  return 'related_to';
}

// ============================================================================
// CO-OCCURRENCE BASED PROPOSALS
// ============================================================================

/**
 * Propose relations based on entity co-occurrence.
 *
 * Simple heuristic: entities that appear together in signals
 * are likely related.
 */
export function proposeRelationsFromCoOccurrence(
  coOccurrences: CoOccurrence[],
  options: {
    minCount?: number;
    minConfidence?: number;
    maxProposals?: number;
  } = {}
): ProposedRelation[] {
  const { minCount = 2, minConfidence = 60, maxProposals = 100 } = options;

  const proposals: ProposedRelation[] = [];

  for (const co of coOccurrences) {
    if (co.count < minCount) continue;

    // Calculate confidence based on count
    // 2 co-occurrences = 60%, each additional adds 10% up to 90%
    const confidence = Math.min(60 + (co.count - 2) * 10, 90);

    if (confidence < minConfidence) continue;

    // Determine which entity should be source vs target
    // Generally: companies → technologies, technologies → concepts
    let source = co.entity1;
    let target = co.entity2;

    // Swap if needed based on type preference
    if (
      (source.type === 'technology' && target.type === 'company') ||
      (source.type === 'concept' && target.type !== 'concept')
    ) {
      [source, target] = [target, source];
    }

    const relationType = inferRelationType(source.type, target.type);

    proposals.push({
      sourceName: source.name,
      sourceType: source.type,
      targetName: target.name,
      targetType: target.type,
      relationType,
      confidence,
      reasoning: `Co-occurred in ${co.count} signal(s)`,
      signalIds: [...new Set(co.signalIds)],
      proposedAt: Date.now(),
    });

    if (proposals.length >= maxProposals) break;
  }

  return proposals;
}

// ============================================================================
// AI-BASED PROPOSALS
// ============================================================================

/**
 * Use AI to analyze signal content and propose relations.
 *
 * More accurate but slower and costs tokens.
 */
export async function proposeRelationsWithAI(
  signalContent: string,
  entities: ExtractedEntity[],
  signalId: string
): Promise<ProposedRelation[]> {
  if (entities.length < 2) return [];

  const entityList = entities
    .map((e) => `- ${e.name} (${e.type}, confidence: ${e.confidence}%)`)
    .join('\n');

  const prompt = `Analyze the following signal content and the entities extracted from it.
Propose relationships between the entities based on the content.

Signal Content:
${signalContent}

Extracted Entities:
${entityList}

For each relationship:
1. Identify source and target entities
2. Choose the most appropriate relation type:
   - vendor: Company sells/provides technology
   - uses: Entity uses technology
   - solves: Technology/solution addresses a problem
   - addresses: Similar to solves
   - aligns_with: Entity aligns with strategy/goal
   - competes_with: Companies compete
   - partner: Companies partner
   - enables: Technology enables capability
   - implements: Technology implements concept/standard
   - requires: Use case or workflow requires a capability
   - related_to: Generic relation when specific type is unclear
3. Assign confidence (0-100) based on how clearly the relationship is stated
4. Provide brief reasoning

Only propose relationships that are clearly supported by the content.`;

  try {
    const response = await generateStructuredContent(prompt, RelationProposalSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.3,
    });

    return response.relations.map((rel) => {
      // Find entity types
      const source = entities.find(
        (e) => e.name.toLowerCase() === rel.sourceName.toLowerCase()
      );
      const target = entities.find(
        (e) => e.name.toLowerCase() === rel.targetName.toLowerCase()
      );

      return {
        sourceName: rel.sourceName,
        sourceType: source?.type || 'concept',
        targetName: rel.targetName,
        targetType: target?.type || 'concept',
        relationType: rel.relationType,
        confidence: rel.confidence,
        reasoning: rel.reasoning,
        signalIds: [signalId],
        proposedAt: Date.now(),
      };
    });
  } catch (error) {
    log.error('AI analysis failed', error instanceof Error ? error : undefined);
    return [];
  }
}

// ============================================================================
// COMBINED PROPOSAL
// ============================================================================

/**
 * Propose relations using both co-occurrence and AI analysis.
 *
 * @example
 * ```typescript
 * const result = await proposeRelations(extractionResults, {
 *   useAI: true,
 *   minConfidence: 70,
 * });
 * console.log(`Proposed ${result.proposals.length} relations`);
 * ```
 */
export async function proposeRelations(
  extractionResults: ExtractionResult[],
  signalContents: Map<string, string>,
  options: {
    useAI?: boolean;
    minConfidence?: number;
    minCoOccurrenceCount?: number;
    maxProposals?: number;
  } = {}
): Promise<RelationProposalResult> {
  const startTime = Date.now();
  const {
    useAI = false,
    minConfidence = 60,
    minCoOccurrenceCount = 2,
    maxProposals = 100,
  } = options;

  // Step 1: Find co-occurrences
  const coOccurrences = findCoOccurrences(extractionResults);

  // Step 2: Generate co-occurrence based proposals
  const coOccurrenceProposals = proposeRelationsFromCoOccurrence(coOccurrences, {
    minCount: minCoOccurrenceCount,
    minConfidence,
    maxProposals,
  });

  if (!useAI) {
    return {
      proposals: coOccurrenceProposals,
      totalCoOccurrences: coOccurrences.length,
      processingTimeMs: Date.now() - startTime,
      method: 'cooccurrence',
    };
  }

  // Step 3: AI-based proposals for high co-occurrence pairs
  const aiProposals: ProposedRelation[] = [];
  const topCoOccurrences = coOccurrences.slice(0, 10); // Only analyze top 10

  for (const co of topCoOccurrences) {
    // Get signal content for first co-occurring signal
    const signalContent = signalContents.get(co.signalIds[0]);
    if (!signalContent) continue;

    // Find the extraction result
    const extractionResult = extractionResults.find((r) => r.signalId === co.signalIds[0]);
    if (!extractionResult) continue;

    const aiResults = await proposeRelationsWithAI(
      signalContent,
      extractionResult.entities,
      co.signalIds[0]
    );

    aiProposals.push(...aiResults);
  }

  // Step 4: Merge proposals, preferring AI over co-occurrence
  const proposalMap = new Map<string, ProposedRelation>();

  // Add co-occurrence proposals
  for (const p of coOccurrenceProposals) {
    const key = `${p.sourceName}|${p.targetName}|${p.relationType}`;
    proposalMap.set(key, p);
  }

  // Override with AI proposals (higher quality)
  for (const p of aiProposals) {
    const key = `${p.sourceName}|${p.targetName}|${p.relationType}`;
    if (!proposalMap.has(key) || proposalMap.get(key)!.confidence < p.confidence) {
      proposalMap.set(key, p);
    }
  }

  // Filter by confidence and limit
  const allProposals = Array.from(proposalMap.values())
    .filter((p) => p.confidence >= minConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxProposals);

  return {
    proposals: allProposals,
    totalCoOccurrences: coOccurrences.length,
    processingTimeMs: Date.now() - startTime,
    method: 'combined',
  };
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Group proposals by relation type.
 */
export function groupProposalsByType(
  proposals: ProposedRelation[]
): Map<RelationType, ProposedRelation[]> {
  const groups = new Map<RelationType, ProposedRelation[]>();

  for (const proposal of proposals) {
    if (!groups.has(proposal.relationType)) {
      groups.set(proposal.relationType, []);
    }
    groups.get(proposal.relationType)!.push(proposal);
  }

  return groups;
}

/**
 * Filter proposals by confidence threshold.
 */
export function filterByConfidence(
  proposals: ProposedRelation[],
  minConfidence: number
): ProposedRelation[] {
  return proposals.filter((p) => p.confidence >= minConfidence);
}

/**
 * Get proposal statistics.
 */
export function getProposalStats(result: RelationProposalResult): {
  totalProposals: number;
  byType: Record<string, number>;
  avgConfidence: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
} {
  const byType: Record<string, number> = {};

  let totalConfidence = 0;
  let highConfidence = 0;
  let mediumConfidence = 0;
  let lowConfidence = 0;

  for (const p of result.proposals) {
    byType[p.relationType] = (byType[p.relationType] || 0) + 1;
    totalConfidence += p.confidence;

    if (p.confidence >= 80) highConfidence++;
    else if (p.confidence >= 60) mediumConfidence++;
    else lowConfidence++;
  }

  return {
    totalProposals: result.proposals.length,
    byType,
    avgConfidence:
      result.proposals.length > 0
        ? Math.round(totalConfidence / result.proposals.length)
        : 0,
    highConfidence,
    mediumConfidence,
    lowConfidence,
  };
}
