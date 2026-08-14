'use server';

import { generateStructuredContent } from '@/lib/ai/client';
import type { GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { createLogger } from '@/lib/logger';
import { z } from 'zod';
import type { EntityType, RelationType } from '@/lib/types';

const log = createLogger('ai-discover-relations');

/**
 * Schema for relation discovery input.
 */
const _DiscoverRelationsInputSchema = z.object({
  entityType: z.string(),
  entityId: z.string(),
  entityName: z.string(),
  entityDescription: z.string().optional(),
  /** Existing entities in the database to match against */
  candidateEntities: z.array(z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    description: z.string().optional(),
  })),
  /** Entity types to focus on for discovery */
  targetTypes: z.array(z.string()).optional(),
  /** Maximum number of suggestions to return */
  maxSuggestions: z.number().optional().default(10),
});

export type DiscoverRelationsInput = z.infer<typeof _DiscoverRelationsInputSchema>;

/**
 * Schema for a single relation suggestion.
 */
const RelationSuggestionSchema = z.object({
  targetEntityId: z.string().describe('ID of the suggested target entity'),
  targetEntityName: z.string().describe('Name of the suggested target entity'),
  targetEntityType: z.string().describe('Type of the suggested target entity'),
  relationType: z.enum([
    'uses', 'enables', 'competes_with', 'vendor', 'user', 'partner',
    'competitor', 'addresses', 'requires', 'aligns_with', 'supports',
    'owned_by', 'sponsors', 'funds', 'solves', 'impacts', 'drives', 'custom'
  ]).describe('Type of relationship'),
  confidence: z.number().min(0).max(100).describe('Confidence score 0-100'),
  reasoning: z.string().describe('Explanation of why this relation is suggested'),
});

/**
 * Schema for the AI response containing multiple suggestions.
 */
const DiscoverRelationsOutputSchema = z.object({
  suggestions: z.array(RelationSuggestionSchema).describe('Array of suggested relations'),
});

export interface RelationSuggestion {
  targetEntityId: string;
  targetEntityName: string;
  targetEntityType: EntityType;
  relationType: RelationType;
  confidence: number;
  reasoning: string;
}

export interface DiscoverRelationsOutput {
  suggestions: RelationSuggestion[];
}

/**
 * Uses AI to discover potential relations between an entity and existing entities.
 *
 * @param input - Entity context and candidate entities to match
 * @returns Array of relation suggestions with confidence and reasoning
 */
export async function discoverRelations(
  input: DiscoverRelationsInput
): Promise<DiscoverRelationsOutput> {
  try {
    // Build the list of candidate entities for the prompt
    const candidatesList = input.candidateEntities
      .slice(0, 50) // Limit to 50 candidates to avoid token limits
      .map(e => `- ID: "${e.id}" | Name: "${e.name}" | Type: ${e.type}${e.description ? ` | Description: ${e.description.substring(0, 100)}` : ''}`)
      .join('\n');

    const targetTypesFilter = input.targetTypes?.length
      ? `Focus on these entity types: ${input.targetTypes.join(', ')}`
      : 'Consider all entity types';

    const prompt = `You are an expert Knowledge Graph Analyst specializing in business and technology relationships.

TASK: Analyze the source entity and identify potential relationships with the candidate entities.

SOURCE ENTITY:
- Type: ${input.entityType}
- Name: "${input.entityName}"
- Description: ${input.entityDescription || 'Not provided'}

CANDIDATE ENTITIES (potential relation targets):
${candidatesList}

RELATION TYPES (choose the most appropriate):
- uses: Source uses/utilizes target (e.g., company uses technology)
- enables: Source enables target functionality
- competes_with: Direct competition
- vendor: Target is a vendor to source
- user: Source is a user of target
- partner: Partnership relationship
- competitor: Competitive relationship
- addresses: Source addresses target (e.g., technology addresses use case)
- requires: Source requires target
- aligns_with: Strategic alignment
- supports: Source supports target
- owned_by: Ownership relationship
- sponsors: Sponsorship relationship
- funds: Funding relationship
- solves: Source solves target problem
- impacts: Source impacts target
- drives: Source drives target
- custom: Other relationship

INSTRUCTIONS:
1. ${targetTypesFilter}
2. Only suggest relations with HIGH confidence (>60%)
3. Provide clear reasoning for each suggestion
4. Consider bidirectional relationships (if A uses B, B might enable A)
5. Maximum ${input.maxSuggestions || 10} suggestions
6. Return ONLY valid JSON

RESPONSE FORMAT:
{
  "suggestions": [
    {
      "targetEntityId": "exact-id-from-candidates",
      "targetEntityName": "Name from candidates",
      "targetEntityType": "type from candidates",
      "relationType": "one of the relation types above",
      "confidence": 75,
      "reasoning": "Clear explanation of why this relation makes sense"
    }
  ]
}

Analyze and return suggestions:`;

    const result = await generateStructuredContent(
      prompt,
      DiscoverRelationsOutputSchema,
      {
        model: geminiTextModel() as GeminiModel,
        temperature: 0.3,
        maxOutputTokens: 4096,
      }
    );

    // Validate that suggested IDs match actual candidate IDs
    const candidateIds = new Set(input.candidateEntities.map(e => e.id));
    const validSuggestions = result.suggestions.filter(s => candidateIds.has(s.targetEntityId));

    return {
      suggestions: validSuggestions as RelationSuggestion[],
    };
  } catch (error) {
    log.error('Error discovering relations', error instanceof Error ? error : new Error(String(error)));
    throw new Error(
      `Failed to discover relations: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

/**
 * Lightweight version that only uses entity names (no database lookup required).
 * Useful for quick suggestions based on text analysis.
 */
export async function discoverRelationsFromText(
  sourceEntity: { type: string; name: string; description?: string },
  targetEntityNames: string[],
  maxSuggestions: number = 5
): Promise<{ name: string; relationType: RelationType; confidence: number; reasoning: string }[]> {
  try {
    const prompt = `You are an expert at identifying business and technology relationships.

SOURCE: ${sourceEntity.type} named "${sourceEntity.name}"
${sourceEntity.description ? `Description: ${sourceEntity.description}` : ''}

POTENTIAL TARGETS: ${targetEntityNames.join(', ')}

For each target that has a likely relationship with the source, provide:
1. The relation type (uses, enables, competes_with, partner, addresses, supports, etc.)
2. Confidence (0-100)
3. Brief reasoning

Return JSON array with max ${maxSuggestions} suggestions:
[{"name": "...", "relationType": "...", "confidence": 80, "reasoning": "..."}]`;

    const schema = z.array(z.object({
      name: z.string(),
      relationType: z.enum([
        'uses', 'enables', 'competes_with', 'vendor', 'user', 'partner',
        'competitor', 'addresses', 'requires', 'aligns_with', 'supports',
        'owned_by', 'sponsors', 'funds', 'solves', 'impacts', 'drives', 'custom'
      ]),
      confidence: z.number(),
      reasoning: z.string(),
    }));

    const result = await generateStructuredContent(prompt, schema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.2,
      maxOutputTokens: 2048,
    });

    return result as { name: string; relationType: RelationType; confidence: number; reasoning: string }[];
  } catch (error) {
    log.error('Error in text-based discovery', error instanceof Error ? error : new Error(String(error)));
    return [];
  }
}
