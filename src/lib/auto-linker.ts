/**
 * @file auto-linker.ts
 * @description AI-powered entity extraction and matching for auto-linking suggestions
 *
 * This service analyzes text content to identify mentions of:
 * - Technologies (from Radar entries)
 * - Companies (from Companies collection)
 * - Use Cases (from Use Cases collection)
 * - Prototypes (from Prototypes collection)
 * - Strategies (from Strategies collection)
 * - Signals (from Signals collection)
 * - Initiatives (from Initiatives collection)
 * - Org Units (from Org Units collection)
 * - Pain Points (from Pain Points collection)
 *
 * It uses Gemini AI to extract entity names, then matches them against
 * existing database entries to suggest relations.
 *
 * @author Radarist Team
 * @created 2025-11-28
 * @updated 2026-01-20 - Phase 3: Extended to support ALL entity types
 */

'use server';

import { z } from 'zod';
import { generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { getTechnologies, type TechnologyWithRadar } from '@/lib/technologies';
import { getCompanies } from '@/lib/companies';
import { getUseCases } from '@/lib/use-cases';
import { getPrototypes } from '@/lib/prototypes';
import { getStrategies } from '@/lib/strategies';
import { getSignals } from '@/lib/signals';
import { getInitiatives } from '@/lib/initiatives';
import { getOrgUnits } from '@/lib/org-units';
import { getPainPoints } from '@/lib/pain-points';
import { getDocuments, getDocumentById } from '@/lib/document-service';
import { getChunksForDocument } from '@/lib/document-chunk-service';
import { getSignalById } from '@/lib/signals';
import { getValidRelationTypes } from '@/lib/linker/relation-ontology';
import { idResolver } from '@/lib/migration';
import type {
  EntityType,
  RelationType,
  Company,
  UseCase,
  Prototype,
  Strategy,
  Signal,
  Initiative,
  OrgUnit,
  PainPoint,
  Document,
} from '@/lib/types';
import { createLogger } from '@/lib/logger';
const log = createLogger('auto-linker');

/**
 * Schema for extracted entity mention
 * Each entity type uses the same structure for consistency
 */
const ExtractedMentionSchema = z.object({
  name: z.string().describe('The entity name mentioned'),
  context: z.string().optional().describe("How it's used/mentioned in context"),
  confidence: z.number().min(0).max(100).optional().describe('Extraction confidence 0-100'),
});

/**
 * Schema for AI-extracted entities
 * Phase 3: Extended to support ALL 10 entity types
 */
const ExtractedEntitiesSchema = z.object({
  technologies: z
    .array(ExtractedMentionSchema)
    .describe('Software tools, frameworks, platforms, programming languages, AI/ML tools, cloud services'),
  companies: z.array(ExtractedMentionSchema).describe('Business names, vendors, partners, startups, organizations'),
  useCases: z
    .array(ExtractedMentionSchema)
    .describe('Business applications, product ideas, scenarios, problems being solved'),
  prototypes: z.array(ExtractedMentionSchema).describe('Proof of concepts, demos, experiments, MVPs, pilots'),
  strategies: z.array(ExtractedMentionSchema).describe('Business strategies, strategic initiatives, roadmaps, plans'),
  signals: z.array(ExtractedMentionSchema).describe('News events, announcements, market signals, industry trends'),
  initiatives: z.array(ExtractedMentionSchema).describe('Projects, programs, initiatives, transformation efforts'),
  orgUnits: z.array(ExtractedMentionSchema).describe('Departments, teams, business units, divisions, regions'),
  painPoints: z.array(ExtractedMentionSchema).describe('Problems, challenges, issues, bottlenecks, friction points'),
  documents: z
    .array(ExtractedMentionSchema)
    .describe('Referenced documents, reports, whitepapers, articles, research papers'),
});

type ExtractedEntities = z.infer<typeof ExtractedEntitiesSchema>;
type _ExtractedMention = z.infer<typeof ExtractedMentionSchema>;

/**
 * Represents a suggested relation with a matched entity
 */
export interface SuggestedRelation {
  /** The type of entity being linked to */
  entityType: EntityType;
  /** The entity ID */
  entityId: string;
  /** The entity name */
  entityName: string;
  /** Optional entity description */
  entityDescription?: string;
  /** Suggested relation type */
  relationType: RelationType;
  /** Confidence score 0-100 */
  confidence: number;
  /** Context from the source text */
  context?: string;
}

/**
 * Empty result for entity extraction fallback
 */
const EMPTY_EXTRACTION: ExtractedEntities = {
  technologies: [],
  companies: [],
  useCases: [],
  prototypes: [],
  strategies: [],
  signals: [],
  initiatives: [],
  orgUnits: [],
  painPoints: [],
  documents: [],
};

/**
 * Extracts entities from text using Gemini AI
 *
 * Phase 3: Extended to extract ALL 10 entity types with improved prompting
 *
 * @param text - The text content to analyze
 * @returns Extracted entity mentions by type
 */
async function extractEntitiesFromText(text: string): Promise<ExtractedEntities> {
  if (!text || text.trim().length < 10) {
    return EMPTY_EXTRACTION;
  }

  const prompt = `
You are an expert at identifying business and technology entity mentions in text.

Analyze this text and extract any mentions of these entity types:

1. **Technologies** - Software tools, frameworks, platforms, programming languages, AI/ML tools, cloud services
2. **Companies** - Business names, vendors, partners, startups, organizations
3. **Use Cases** - Business applications, product ideas, scenarios, problems being solved
4. **Prototypes** - Proof of concepts, demos, experiments, MVPs, pilots mentioned
5. **Strategies** - Business strategies, strategic initiatives, roadmaps, plans
6. **Signals** - News events, announcements, market signals, industry trends
7. **Initiatives** - Projects, programs, organizational initiatives, transformation efforts
8. **Org Units** - Departments, teams, business units, divisions, regions mentioned
9. **Pain Points** - Problems, challenges, issues, bottlenecks, friction points
10. **Documents** - Referenced documents, reports, whitepapers, articles, research papers

Text to analyze:
"""
${text}
"""

Rules:
- Extract ONLY entities that are explicitly mentioned or strongly implied
- Do NOT invent or hallucinate entities
- For each entity, capture the context of how it's mentioned
- Include a confidence score (0-100) for how certain you are about the extraction
- Return empty arrays for entity types with no mentions

Return JSON with this structure:
{
  "technologies": [{"name": "TensorFlow", "context": "using for ML models", "confidence": 90}],
  "companies": [{"name": "Google", "context": "partnering with", "confidence": 95}],
  "useCases": [{"name": "predictive maintenance", "context": "applying ML for", "confidence": 85}],
  "prototypes": [],
  "strategies": [],
  "signals": [],
  "initiatives": [],
  "orgUnits": [],
  "painPoints": [],
  "documents": []
}
`;

  try {
    const result = await generateStructuredContent(prompt, ExtractedEntitiesSchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.1, // Low temperature for more precise extraction
    });
    return result;
  } catch (error) {
    log.error('Failed to extract entities', error instanceof Error ? error : new Error(String(error)));
    // Fallback: return empty results
    return EMPTY_EXTRACTION;
  }
}

/**
 * Calculates similarity between two strings (case-insensitive)
 * Uses Levenshtein-like approach but simplified for performance
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  // Exact match
  if (s1 === s2) return 100;

  // One contains the other
  if (s1.includes(s2) || s2.includes(s1)) {
    const longer = Math.max(s1.length, s2.length);
    const shorter = Math.min(s1.length, s2.length);
    return Math.round((shorter / longer) * 90);
  }

  // Word-based matching
  const words1 = s1.split(/\s+/);
  const words2 = s2.split(/\s+/);
  const matchingWords = words1.filter((w) => words2.some((w2) => w === w2 || w.includes(w2) || w2.includes(w)));

  if (matchingWords.length > 0) {
    return Math.round((matchingWords.length / Math.max(words1.length, words2.length)) * 70);
  }

  return 0;
}

/**
 * Context-based relation type hints
 * Maps context keywords to relation types
 */
const CONTEXT_RELATION_HINTS: Record<string, RelationType[]> = {
  // Usage patterns
  uses: ['uses'],
  using: ['uses'],
  'built on': ['uses'],
  'runs on': ['uses'],
  leverages: ['uses'],

  // Enablement patterns
  enables: ['enables'],
  powers: ['enables'],
  supports: ['enables'],
  facilitates: ['enables'],

  // Competition patterns
  competes: ['competes_with'],
  competitor: ['competes_with'],
  alternative: ['competes_with'],
  rival: ['competes_with'],

  // Vendor/supplier patterns
  vendor: ['vendor'],
  provides: ['vendor'],
  sells: ['vendor'],
  supplier: ['vendor'],

  // Partnership patterns
  partner: ['partner'],
  collaboration: ['partner'],
  'works with': ['partner'],
  alliance: ['partner'],

  // Customer patterns
  customer: ['user'],
  client: ['user'],

  // Requirement patterns
  requires: ['requires'],
  needs: ['requires'],
  depends: ['requires'],

  // Solution patterns
  addresses: ['addresses'],
  solves: ['addresses'],
  resolves: ['addresses'],
  fixes: ['addresses'],

  // Ownership patterns
  owns: ['owned_by'],
  manages: ['owned_by'],
  responsible: ['owned_by'],

  // Funding patterns
  funds: ['funds'],
  finances: ['funds'],
  invests: ['invests_in'],
  sponsors: ['sponsors'],

  // Alignment/priority patterns
  prioritizes: ['aligns_with'],
  focuses: ['aligns_with'],
  emphasizes: ['aligns_with'],

  // Assessment patterns
  evaluates: ['addresses'],
  assesses: ['addresses'],
  reviews: ['addresses'],

  // Demonstration patterns
  validates: ['demonstrates'],
  proves: ['demonstrates'],
  demonstrates: ['demonstrates'],
};

/**
 * Suggests a relation type based on context and the relation ontology
 *
 * Phase 3: Uses getValidRelationTypes from ontology + context-based hints
 *
 * @param sourceType - Source entity type
 * @param targetType - Target entity type
 * @param context - Optional context text from extraction
 * @returns Best matching relation type
 */
function suggestRelationType(sourceType: EntityType, targetType: EntityType, context?: string): RelationType {
  // Get valid relation types from ontology
  const validTypes = getValidRelationTypes(sourceType, targetType);

  // If no valid types from ontology, fall back to generic
  if (validTypes.length === 0) {
    return 'custom';
  }

  // If only one valid type, use it
  if (validTypes.length === 1) {
    return validTypes[0];
  }

  // Try to match context keywords to suggest best relation type
  if (context) {
    const contextLower = context.toLowerCase();

    for (const [keyword, hintedTypes] of Object.entries(CONTEXT_RELATION_HINTS)) {
      if (contextLower.includes(keyword)) {
        // Find the first hinted type that's valid for this entity pair
        for (const hintedType of hintedTypes) {
          if (validTypes.includes(hintedType)) {
            return hintedType;
          }
        }
      }
    }
  }

  // Return the first valid type as default
  return validTypes[0];
}

/**
 * Entity lookup data structure for O(1) matching
 * Maps normalized name -> entity data
 */
interface EntityLookupEntry<T> {
  entity: T;
  normalizedName: string;
  words: string[];
}

/**
 * Builds a Map-based lookup structure for fast entity matching
 * Keys are normalized (lowercase, trimmed) names for exact match
 * Also stores word tokens for partial matching
 *
 * @param entities - Array of entities to index
 * @param getName - Function to extract name from entity
 * @returns Map of normalized name to lookup entry
 */
function buildEntityLookup<T>(entities: T[], getName: (entity: T) => string): Map<string, EntityLookupEntry<T>[]> {
  const lookup = new Map<string, EntityLookupEntry<T>[]>();

  for (const entity of entities) {
    const name = getName(entity);
    const normalizedName = name.toLowerCase().trim();
    const words = normalizedName.split(/\s+/);

    const entry: EntityLookupEntry<T> = { entity, normalizedName, words };

    // Index by full normalized name
    if (!lookup.has(normalizedName)) {
      lookup.set(normalizedName, []);
    }
    lookup.get(normalizedName)!.push(entry);

    // Index by each word (for partial matching)
    for (const word of words) {
      if (word.length >= 3) {
        // Only index words 3+ chars
        if (!lookup.has(word)) {
          lookup.set(word, []);
        }
        lookup.get(word)!.push(entry);
      }
    }
  }

  return lookup;
}

/**
 * Finds matching entities using Map lookup (O(1) average case)
 * Falls back to substring check for partial matches
 *
 * @param extractedName - Name to search for
 * @param lookup - Pre-built lookup map
 * @param threshold - Minimum similarity threshold
 * @returns Matching entities with similarity scores
 */
function findMatchesFromLookup<T>(
  extractedName: string,
  lookup: Map<string, EntityLookupEntry<T>[]>,
  threshold: number
): Array<{ entity: T; similarity: number }> {
  const normalizedSearch = extractedName.toLowerCase().trim();
  const searchWords = normalizedSearch.split(/\s+/);
  const matches: Array<{ entity: T; similarity: number }> = [];
  const seen = new Set<T>();

  // 1. Try exact match first (O(1))
  const exactMatches = lookup.get(normalizedSearch);
  if (exactMatches) {
    for (const entry of exactMatches) {
      if (!seen.has(entry.entity)) {
        seen.add(entry.entity);
        matches.push({ entity: entry.entity, similarity: 100 });
      }
    }
  }

  // 2. Try word-based matching (O(W) where W is number of words in search)
  for (const word of searchWords) {
    if (word.length >= 3) {
      const wordMatches = lookup.get(word);
      if (wordMatches) {
        for (const entry of wordMatches) {
          if (!seen.has(entry.entity)) {
            // Calculate similarity for partial match
            const similarity = calculateSimilarity(extractedName, entry.normalizedName);
            if (similarity >= threshold) {
              seen.add(entry.entity);
              matches.push({ entity: entry.entity, similarity });
            }
          }
        }
      }
    }
  }

  // 3. For very short or unusual names, check for substring containment
  // Only scan if we haven't found enough matches yet
  if (matches.length < 3 && normalizedSearch.length >= 3) {
    // Get unique entries from the lookup (avoiding duplicates from word indexing)
    const uniqueEntries = new Map<T, EntityLookupEntry<T>>();
    const lookupValues = Array.from(lookup.values());
    for (const entries of lookupValues) {
      for (const entry of entries) {
        if (!uniqueEntries.has(entry.entity) && !seen.has(entry.entity)) {
          uniqueEntries.set(entry.entity, entry);
        }
      }
    }

    // Only check containment for entries we haven't matched yet
    const uniqueEntriesArray = Array.from(uniqueEntries.entries());
    for (const [entity, entry] of uniqueEntriesArray) {
      if (entry.normalizedName.includes(normalizedSearch) || normalizedSearch.includes(entry.normalizedName)) {
        const similarity = calculateSimilarity(extractedName, entry.normalizedName);
        if (similarity >= threshold) {
          seen.add(entity);
          matches.push({ entity, similarity });
        }
      }
    }
  }

  return matches;
}

/**
 * Calculates combined confidence score
 *
 * @param similarity - Name similarity score (0-100)
 * @param extractionConfidence - AI extraction confidence (0-100)
 * @returns Combined confidence score (0-100)
 */
function calculateCombinedConfidence(similarity: number, extractionConfidence?: number): number {
  // If we have extraction confidence, weight it 30% and similarity 70%
  if (extractionConfidence !== undefined) {
    return Math.round(similarity * 0.7 + extractionConfidence * 0.3);
  }
  return similarity;
}

/**
 * Checks if an entity matches the source entity (to avoid self-references)
 */
function isSelfReference(
  sourceEntityType: EntityType,
  sourceEntityId: string,
  targetEntityType: EntityType,
  targetEntityId: string,
  targetEntityName: string,
  extractedName: string
): boolean {
  // Different entity types can't be self-references
  if (sourceEntityType !== targetEntityType) {
    return false;
  }

  // Check ID match
  if (targetEntityId === sourceEntityId) {
    return true;
  }

  // For technologies, check composite ID patterns
  if (targetEntityType === 'technology') {
    const rawId = targetEntityId;
    if (sourceEntityId.includes(rawId) || rawId.includes(sourceEntityId.split(':').pop() || '')) {
      return true;
    }
  }

  // Name-based check for same-type entities
  if (targetEntityName.toLowerCase().trim() === extractedName.toLowerCase().trim()) {
    return true;
  }

  return false;
}

/**
 * Main function to analyze text and suggest entity relations
 *
 * Phase 3: Extended to support ALL 10 entity types
 *
 * PERFORMANCE OPTIMIZATION (v2):
 * - Uses Map-based lookup instead of O(N×M) nested loops
 * - Exact name matches: O(1)
 * - Word-based matches: O(W) where W is words in search term
 * - Overall complexity: O(N+M) instead of O(N×M)
 *
 * @param text - The text content to analyze
 * @param sourceEntityType - The type of entity this text belongs to
 * @param sourceEntityId - The ID of the source entity
 * @returns Array of suggested relations with confidence scores
 */
/**
 * Options for suggestRelations function
 */
interface SuggestRelationsOptions {
  /** Phase 3: When true and sourceType is 'document', also analyze document chunks */
  includeDocumentContent?: boolean;
  /** Phase 3: When true and sourceType is 'signal', also analyze signal content */
  includeSignalContent?: boolean;
}

export async function suggestRelations(
  text: string,
  sourceEntityType: EntityType,
  sourceEntityId: string,
  options?: SuggestRelationsOptions
): Promise<SuggestedRelation[]> {
  const suggestions: SuggestedRelation[] = [];

  // Build enhanced text with optional document/signal content
  let enhancedText = text;

  // Phase 3: Document content analysis
  if (options?.includeDocumentContent && sourceEntityType === 'document' && sourceEntityId) {
    try {
      const [doc, chunks] = await Promise.all([getDocumentById(sourceEntityId), getChunksForDocument(sourceEntityId)]);

      if (doc) {
        // Add document metadata
        const docMeta = [`Document Title: ${doc.title}`];
        if (doc.description) docMeta.push(`Description: ${doc.description}`);
        if (doc.aiSummary) docMeta.push(`Summary: ${doc.aiSummary}`);
        if (doc.tags?.length) docMeta.push(`Tags: ${doc.tags.join(', ')}`);

        // Add first 5 chunks (limit to avoid token overflow)
        const chunkContent = chunks
          .slice(0, 5)
          .map((c) => c.content)
          .join('\n\n');

        enhancedText = `${docMeta.join('\n')}\n\nDocument Content:\n${chunkContent}\n\nAdditional Context:\n${text}`;
      }
    } catch (error) {
      log.warn('Failed to fetch document content', { error: String(error) });
      // Continue with original text
    }
  }

  // Phase 3: Signal content analysis
  if (options?.includeSignalContent && sourceEntityType === 'signal' && sourceEntityId) {
    try {
      const signal = await getSignalById(sourceEntityId);

      if (signal) {
        // Add signal metadata and content
        const signalMeta = [`Signal Title: ${signal.title}`];
        if (signal.description) signalMeta.push(`Description: ${signal.description}`);
        if (signal.aiSummary) signalMeta.push(`AI Summary: ${signal.aiSummary}`);
        if (signal.source) signalMeta.push(`Source: ${signal.source}`);
        if (signal.url) signalMeta.push(`URL: ${signal.url}`);

        enhancedText = `${signalMeta.join('\n')}\n\nAdditional Context:\n${text}`;
      }
    } catch (error) {
      log.warn('Failed to fetch signal content', { error: String(error) });
      // Continue with original text
    }
  }

  // Extract entities from enhanced text
  const extracted = await extractEntitiesFromText(enhancedText);

  // Early exit if nothing extracted
  const hasExtractions =
    extracted.technologies.length > 0 ||
    extracted.companies.length > 0 ||
    extracted.useCases.length > 0 ||
    extracted.prototypes.length > 0 ||
    extracted.strategies.length > 0 ||
    extracted.signals.length > 0 ||
    extracted.initiatives.length > 0 ||
    extracted.orgUnits.length > 0 ||
    extracted.painPoints.length > 0 ||
    extracted.documents.length > 0;

  if (!hasExtractions) {
    return [];
  }

  // Fetch ALL entity types from database (parallel)
  const [
    technologiesResult,
    companies,
    useCases,
    prototypes,
    strategies,
    signals,
    initiatives,
    orgUnits,
    painPoints,
    documents,
  ] = await Promise.all([
    getTechnologies().catch((): { technologies: TechnologyWithRadar[] } => ({ technologies: [] })),
    getCompanies().catch((): Company[] => []),
    getUseCases().catch((): UseCase[] => []),
    getPrototypes().catch((): Prototype[] => []),
    getStrategies().catch((): Strategy[] => []),
    getSignals().catch((): Signal[] => []),
    getInitiatives().catch((): Initiative[] => []),
    getOrgUnits().catch((): OrgUnit[] => []),
    getPainPoints().catch((): PainPoint[] => []),
    getDocuments({ status: 'processed' }).catch((): Document[] => []),
  ]);
  const technologies = technologiesResult.technologies;

  // Build lookup maps ONCE (O(N) where N is total DB entities)
  const techLookup = buildEntityLookup(technologies, (t) => t.name);
  const companyLookup = buildEntityLookup(companies, (c) => c.name);
  const useCaseLookup = buildEntityLookup(useCases, (u) => u.title);
  const prototypeLookup = buildEntityLookup(prototypes, (p) => p.name);
  const strategyLookup = buildEntityLookup(strategies, (s) => s.name);
  const signalLookup = buildEntityLookup(signals, (s) => s.title);
  const initiativeLookup = buildEntityLookup(initiatives, (i) => i.name);
  const orgUnitLookup = buildEntityLookup(orgUnits, (o) => o.name);
  const painPointLookup = buildEntityLookup(painPoints, (p) => p.title);
  const documentLookup = buildEntityLookup(documents, (d) => d.title);

  // Match extracted technologies
  for (const tech of extracted.technologies) {
    const matches = findMatchesFromLookup(tech.name, techLookup, 50);

    for (const { entity: dbTech, similarity } of matches) {
      // Handle technology ID format (new-format IDs are pass-through; legacy
      // composite IDs synthesize from radarId:id).
      let entityId: string;
      const techId = String(dbTech.id);
      if (idResolver.isNewFormat(techId)) {
        entityId = techId;
      } else {
        entityId = `${dbTech.radarId}:${dbTech.id}`;
      }

      if (isSelfReference(sourceEntityType, sourceEntityId, 'technology', entityId, dbTech.name, tech.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'technology',
        entityId,
        entityName: dbTech.name,
        entityDescription: dbTech.description,
        relationType: suggestRelationType(sourceEntityType, 'technology', tech.context),
        confidence: calculateCombinedConfidence(similarity, tech.confidence),
        context: tech.context,
      });
    }
  }

  // Match extracted companies
  for (const company of extracted.companies) {
    const matches = findMatchesFromLookup(company.name, companyLookup, 50);

    for (const { entity: dbCompany, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'company', dbCompany.id, dbCompany.name, company.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'company',
        entityId: dbCompany.id,
        entityName: dbCompany.name,
        entityDescription: dbCompany.description,
        relationType: suggestRelationType(sourceEntityType, 'company', company.context),
        confidence: calculateCombinedConfidence(similarity, company.confidence),
        context: company.context,
      });
    }
  }

  // Match extracted use cases (lower threshold for varied naming)
  for (const useCase of extracted.useCases) {
    const matches = findMatchesFromLookup(useCase.name, useCaseLookup, 40);

    for (const { entity: dbUseCase, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'useCase', dbUseCase.id, dbUseCase.title, useCase.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'useCase',
        entityId: dbUseCase.id,
        entityName: dbUseCase.title,
        entityDescription: dbUseCase.description,
        relationType: suggestRelationType(sourceEntityType, 'useCase', useCase.context),
        confidence: calculateCombinedConfidence(similarity, useCase.confidence),
        context: useCase.context,
      });
    }
  }

  // Match extracted prototypes
  for (const proto of extracted.prototypes) {
    const matches = findMatchesFromLookup(proto.name, prototypeLookup, 50);

    for (const { entity: dbProto, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'prototype', dbProto.id, dbProto.name, proto.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'prototype',
        entityId: dbProto.id,
        entityName: dbProto.name,
        entityDescription: dbProto.description,
        relationType: suggestRelationType(sourceEntityType, 'prototype', proto.context),
        confidence: calculateCombinedConfidence(similarity, proto.confidence),
        context: proto.context,
      });
    }
  }

  // Match extracted strategies
  for (const strat of extracted.strategies) {
    const matches = findMatchesFromLookup(strat.name, strategyLookup, 50);

    for (const { entity: dbStrat, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'strategy', dbStrat.id, dbStrat.name, strat.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'strategy',
        entityId: dbStrat.id,
        entityName: dbStrat.name,
        entityDescription: dbStrat.description,
        relationType: suggestRelationType(sourceEntityType, 'strategy', strat.context),
        confidence: calculateCombinedConfidence(similarity, strat.confidence),
        context: strat.context,
      });
    }
  }

  // Match extracted signals
  for (const signal of extracted.signals) {
    const matches = findMatchesFromLookup(signal.name, signalLookup, 45);

    for (const { entity: dbSignal, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'signal', dbSignal.id, dbSignal.title, signal.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'signal',
        entityId: dbSignal.id,
        entityName: dbSignal.title,
        entityDescription: dbSignal.description,
        relationType: suggestRelationType(sourceEntityType, 'signal', signal.context),
        confidence: calculateCombinedConfidence(similarity, signal.confidence),
        context: signal.context,
      });
    }
  }

  // Match extracted initiatives
  for (const init of extracted.initiatives) {
    const matches = findMatchesFromLookup(init.name, initiativeLookup, 50);

    for (const { entity: dbInit, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'initiative', dbInit.id, dbInit.name, init.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'initiative',
        entityId: dbInit.id,
        entityName: dbInit.name,
        entityDescription: dbInit.description,
        relationType: suggestRelationType(sourceEntityType, 'initiative', init.context),
        confidence: calculateCombinedConfidence(similarity, init.confidence),
        context: init.context,
      });
    }
  }

  // Match extracted org units
  for (const org of extracted.orgUnits) {
    const matches = findMatchesFromLookup(org.name, orgUnitLookup, 50);

    for (const { entity: dbOrg, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'orgUnit', dbOrg.id, dbOrg.name, org.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'orgUnit',
        entityId: dbOrg.id,
        entityName: dbOrg.name,
        entityDescription: dbOrg.description,
        relationType: suggestRelationType(sourceEntityType, 'orgUnit', org.context),
        confidence: calculateCombinedConfidence(similarity, org.confidence),
        context: org.context,
      });
    }
  }

  // Match extracted pain points
  for (const pain of extracted.painPoints) {
    const matches = findMatchesFromLookup(pain.name, painPointLookup, 45);

    for (const { entity: dbPain, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'painPoint', dbPain.id, dbPain.title, pain.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'painPoint',
        entityId: dbPain.id,
        entityName: dbPain.title,
        entityDescription: dbPain.description,
        relationType: suggestRelationType(sourceEntityType, 'painPoint', pain.context),
        confidence: calculateCombinedConfidence(similarity, pain.confidence),
        context: pain.context,
      });
    }
  }

  // Match extracted documents
  for (const doc of extracted.documents) {
    const matches = findMatchesFromLookup(doc.name, documentLookup, 50);

    for (const { entity: dbDoc, similarity } of matches) {
      if (isSelfReference(sourceEntityType, sourceEntityId, 'document', dbDoc.id, dbDoc.title, doc.name)) {
        continue;
      }

      suggestions.push({
        entityType: 'document',
        entityId: dbDoc.id,
        entityName: dbDoc.title,
        entityDescription: dbDoc.description || dbDoc.aiSummary,
        relationType: suggestRelationType(sourceEntityType, 'document', doc.context),
        confidence: calculateCombinedConfidence(similarity, doc.confidence),
        context: doc.context,
      });
    }
  }

  // Sort by confidence and deduplicate
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      const key = `${s.entityType}:${s.entityId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15); // Limit to top 15 suggestions (increased from 10)
}
