/**
 * @file nl-to-cypher.ts
 * @description Natural Language to Cypher query translation.
 *
 * This module enables users to query the knowledge graph using
 * natural language questions. It uses AI to:
 * 1. Understand the user's intent
 * 2. Extract relevant entities and relationships
 * 3. Generate appropriate Cypher queries
 * 4. Execute and format results
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import { generateStructuredContent, type GeminiModel } from '@/lib/ai/client';
import { geminiTextModel } from '@/lib/ai/model-config';
import { z } from 'zod';
import { currentEdgePredicate, currentPathPredicate } from './current-edge-filter';
import neo4j from 'neo4j-driver';
import { getGraphService } from './service-factory';
import type { GraphNode, GraphQueryResult } from './interface';
import { createLogger } from '@/lib/logger';
import { inspectCypherReadQuery } from './cypher-read-policy';

const log = createLogger('graph/nl-to-cypher');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Query intent categories recognized by the NL parser.
 */
export type QueryIntent =
  | 'find_path' // How is X connected to Y?
  | 'find_neighbors' // What is related to X?
  | 'find_by_type' // List all technologies/companies/etc.
  | 'impact_analysis' // What is impacted by X?
  | 'solution_discovery' // What solves pain point X?
  | 'alignment_check' // What aligns with strategy X?
  | 'vendor_search' // Who provides technology X?
  | 'gap_analysis' // Where are the gaps?
  | 'statistics' // How many X are there?
  | 'custom_query'; // Freeform query

/**
 * Parsed natural language query structure.
 */
export interface ParsedQuery {
  /** Detected intent */
  intent: QueryIntent;
  /** Entities mentioned in the query */
  entities: Array<{
    name: string;
    type?: string;
    role: 'source' | 'target' | 'filter' | 'subject';
  }>;
  /** Relationships mentioned */
  relationships?: string[];
  /** Filters/constraints */
  filters?: {
    entityTypes?: string[];
    limit?: number;
    minConfidence?: number;
  };
  /** The rewritten query in normalized form */
  normalizedQuery: string;
  /** Confidence in the parsing (0-100) */
  confidence: number;
}

/**
 * Generated Cypher query with parameters.
 */
export interface GeneratedQuery {
  /** The Cypher query string */
  cypher: string;
  /** Query parameters */
  params: Record<string, unknown>;
  /** Human-readable explanation of what the query does */
  explanation: string;
  /** The parsed query structure */
  parsed: ParsedQuery;
}

/**
 * Natural language query result.
 */
export interface NLQueryResult {
  /** Whether the query succeeded */
  success: boolean;
  /** Natural language answer */
  answer: string;
  /** Raw results from the graph */
  results?: GraphNode[];
  /** The generated query (for debugging/transparency) */
  query?: GeneratedQuery;
  /** Error message if failed */
  error?: string;
  /** Execution time in ms */
  executionTimeMs?: number;
}

// ============================================================================
// QUERY INTENT DETECTION SCHEMA
// ============================================================================

const ParsedQuerySchema = z.object({
  intent: z.enum([
    'find_path',
    'find_neighbors',
    'find_by_type',
    'impact_analysis',
    'solution_discovery',
    'alignment_check',
    'vendor_search',
    'gap_analysis',
    'statistics',
    'custom_query',
  ]),
  entities: z.array(
    z.object({
      name: z.string(),
      type: z.string().optional(),
      role: z.enum(['source', 'target', 'filter', 'subject']),
    })
  ),
  relationships: z.array(z.string()).optional(),
  filters: z
    .object({
      entityTypes: z.array(z.string()).optional(),
      limit: z.number().optional(),
      minConfidence: z.number().optional(),
    })
    .optional(),
  normalizedQuery: z.string(),
  confidence: z.number(),
});

// ============================================================================
// CYPHER GENERATION TEMPLATES
// ============================================================================

/**
 * Cypher templates for each intent type.
 */
const CYPHER_TEMPLATES: Record<QueryIntent, string> = {
  find_path: `
    MATCH (source:Entity), (target:Entity)
    WHERE toLower(source.name) CONTAINS toLower($sourceName)
    AND toLower(target.name) CONTAINS toLower($targetName)
    WITH source, target
    LIMIT 1
    MATCH path = shortestPath((source)-[*1..4]-(target))
    WHERE ${currentPathPredicate('path')}
    RETURN
      [n IN nodes(path) | {id: n.id, name: n.name, type: n.entityType}] AS pathNodes,
      [r IN relationships(path) | {type: type(r), from: startNode(r).id, to: endNode(r).id}] AS pathRelations,
      length(path) AS hops
  `,

  find_neighbors: `
    MATCH (source:Entity)-[r]-(neighbor:Entity)
    WHERE toLower(source.name) CONTAINS toLower($entityName)
    AND ${currentEdgePredicate('r')}
    RETURN DISTINCT neighbor {.id, .name, .entityType, relationType: type(r)}
    ORDER BY neighbor.name
    LIMIT $limit
  `,

  find_by_type: `
    MATCH (n:Entity {entityType: $entityType})
    RETURN n {.id, .name, .entityType, .description}
    ORDER BY n.name
    LIMIT $limit
  `,

  impact_analysis: `
    MATCH (source:Entity)
    WHERE toLower(source.name) CONTAINS toLower($entityName)
    WITH source
    LIMIT 1
    MATCH path = (source)-[:IMPACTS|ENABLES|DRIVES*1..3]-(impacted:Entity)
    WHERE ${currentPathPredicate('path')}
    WITH impacted, min(length(path)) AS distance
    RETURN impacted {.id, .name, .entityType}, distance
    ORDER BY distance, impacted.name
    LIMIT $limit
  `,

  solution_discovery: `
    MATCH (pain:Entity)
    WHERE toLower(pain.name) CONTAINS toLower($painPointName)
    AND pain.entityType = 'painPoint'
    WITH pain
    LIMIT 1
    MATCH path = (pain)-[:SOLVES|ADDRESSES*1..2]-(solution:Entity)
    WHERE solution.entityType IN ['technology', 'initiative', 'prototype']
    AND ${currentPathPredicate('path')}
    RETURN solution {.id, .name, .entityType, .description}
    ORDER BY solution.name
    LIMIT $limit
  `,

  alignment_check: `
    MATCH (strategy:Entity)
    WHERE toLower(strategy.name) CONTAINS toLower($strategyName)
    AND strategy.entityType = 'strategy'
    WITH strategy
    LIMIT 1
    MATCH path = (strategy)-[:ALIGNS_WITH*1..2]-(aligned:Entity)
    WHERE ${currentPathPredicate('path')}
    RETURN aligned {.id, .name, .entityType}
    ORDER BY aligned.entityType, aligned.name
    LIMIT $limit
  `,

  vendor_search: `
    MATCH (tech:Entity {entityType: 'technology'})
    WHERE toLower(tech.name) CONTAINS toLower($technologyName)
    WITH tech
    LIMIT 1
    MATCH (vendor:Entity {entityType: 'company'})-[vendorRel:VENDOR]-(tech)
    WHERE ${currentEdgePredicate('vendorRel')}
    RETURN vendor {.id, .name, .entityType, technology: tech.name}
    ORDER BY vendor.name
    LIMIT $limit
  `,

  gap_analysis: `
    MATCH (org:Entity)-[painRel:RELATED_TO]-(pain:Entity)
    WHERE org.entityType = 'orgUnit'
    AND pain.entityType = 'painPoint'
    AND painRel.sourceRelationType = 'experiences'
    AND ${currentEdgePredicate('painRel')}
    AND NOT EXISTS {
      MATCH (pain)-[solutionRel:ADDRESSES|SOLVES]-(initiative:Entity)
      WHERE ${currentEdgePredicate('solutionRel')}
    }
    RETURN org {.id, .name}, COLLECT(pain {.id, .name}) AS unaddressedPainPoints
    LIMIT $limit
  `,

  statistics: `
    MATCH (n:Entity)
    WHERE $entityType IS NULL OR n.entityType = $entityType
    RETURN n.entityType AS type, COUNT(n) AS count
    ORDER BY count DESC
  `,

  custom_query: `
    MATCH (n:Entity)
    WHERE toLower(n.name) CONTAINS toLower($searchTerm)
    RETURN n {.id, .name, .entityType, .description}
    ORDER BY n.name
    LIMIT $limit
  `,
};

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Parse a natural language query to understand intent and extract entities.
 *
 * @example
 * ```typescript
 * const parsed = await parseNaturalLanguageQuery(
 *   "How is React connected to Google?"
 * );
 * // Returns: { intent: 'find_path', entities: [...], ... }
 * ```
 */
export async function parseNaturalLanguageQuery(query: string): Promise<ParsedQuery> {
  const systemPrompt = `You are a query parser for a knowledge graph about innovation, technology, and business.

Your task is to analyze natural language questions and extract:
1. The intent (what type of query is this?)
2. Entities mentioned (companies, technologies, strategies, etc.)
3. Any filters or constraints

Entity types in the system:
- company: Business organizations
- technology: Technologies, frameworks, platforms
- useCase: Business use cases
- prototype: Proof of concept implementations
- strategy: Business strategies and initiatives
- signal: Market signals and trends
- orgUnit: Organizational units/departments
- initiative: Business initiatives
- painPoint: Business pain points/challenges

Intent types:
- find_path: Questions about connections between two entities ("How is X connected to Y?")
- find_neighbors: Questions about what's related to an entity ("What is related to X?", "What uses X?")
- find_by_type: Listing entities of a type ("List all technologies", "Show me companies")
- impact_analysis: Questions about what is impacted ("What does X affect?")
- solution_discovery: Finding solutions for pain points ("What solves X?")
- alignment_check: Checking strategic alignment ("What aligns with strategy X?")
- vendor_search: Finding vendors/providers ("Who provides X?")
- gap_analysis: Finding gaps or missing links ("Where are the gaps?")
- statistics: Counting or metrics questions ("How many X?")
- custom_query: When intent is unclear, use this for general search

Respond with a JSON object matching the required schema.`;

  try {
    const parsed = await generateStructuredContent(`${systemPrompt}\n\nUser query: "${query}"`, ParsedQuerySchema, {
      model: geminiTextModel() as GeminiModel,
      temperature: 0.2,
    });
    return parsed;
  } catch (error) {
    // Fallback to custom_query if parsing fails
    log.warn('Failed to parse query, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      intent: 'custom_query',
      entities: [{ name: query, role: 'subject' }],
      normalizedQuery: query,
      confidence: 30,
    };
  }
}

/**
 * Generate a Cypher query from a parsed natural language query.
 */
export function generateCypherQuery(parsed: ParsedQuery): GeneratedQuery {
  const template = CYPHER_TEMPLATES[parsed.intent];
  // Ensure limit is a Neo4j Integer - LIMIT requires integers.
  // JavaScript numbers are IEEE 754 doubles, so even Math.floor(20) sends 20.0
  // to the driver. neo4j.int() wraps the value as a proper Neo4j Integer.
  const params: Record<string, unknown> = {
    limit: neo4j.int(Math.floor(parsed.filters?.limit || 20)),
  };

  // Extract entity names based on roles
  const sourceEntity = parsed.entities.find((e) => e.role === 'source');
  const targetEntity = parsed.entities.find((e) => e.role === 'target');
  const subjectEntity = parsed.entities.find((e) => e.role === 'subject') || parsed.entities[0];

  // Set parameters based on intent
  switch (parsed.intent) {
    case 'find_path':
      params.sourceName = sourceEntity?.name || subjectEntity?.name || '';
      params.targetName = targetEntity?.name || '';
      break;

    case 'find_neighbors':
    case 'impact_analysis':
      params.entityName = subjectEntity?.name || '';
      break;

    case 'find_by_type':
      params.entityType = subjectEntity?.type || parsed.filters?.entityTypes?.[0] || 'technology';
      break;

    case 'solution_discovery':
      params.painPointName = subjectEntity?.name || '';
      break;

    case 'alignment_check':
      params.strategyName = subjectEntity?.name || '';
      break;

    case 'vendor_search':
      params.technologyName = subjectEntity?.name || '';
      break;

    case 'statistics':
      params.entityType = parsed.filters?.entityTypes?.[0] || null;
      break;

    case 'custom_query':
    default:
      params.searchTerm = subjectEntity?.name || parsed.normalizedQuery || '';
      break;
  }

  // Build explanation
  const explanations: Record<QueryIntent, string> = {
    find_path: `Finding the connection path between ${params.sourceName} and ${params.targetName}`,
    find_neighbors: `Finding entities related to ${params.entityName}`,
    find_by_type: `Listing all ${params.entityType} entities`,
    impact_analysis: `Analyzing what is impacted by ${params.entityName}`,
    solution_discovery: `Finding solutions for pain point: ${params.painPointName}`,
    alignment_check: `Finding entities aligned with strategy: ${params.strategyName}`,
    vendor_search: `Finding vendors that provide ${params.technologyName}`,
    gap_analysis: 'Identifying organizational gaps and unaddressed pain points',
    statistics: params.entityType ? `Counting ${params.entityType} entities` : 'Getting entity statistics',
    custom_query: `Searching for: ${params.searchTerm}`,
  };

  return {
    cypher: template,
    params,
    explanation: explanations[parsed.intent],
    parsed,
  };
}

/**
 * Execute a natural language query against the knowledge graph.
 *
 * @example
 * ```typescript
 * const result = await executeNaturalLanguageQuery(
 *   "What technologies are related to machine learning?"
 * );
 * console.log(result.answer); // "Found 15 technologies related to machine learning..."
 * ```
 */
export async function executeNaturalLanguageQuery(query: string): Promise<NLQueryResult> {
  const startTime = Date.now();

  try {
    // Step 0: Initialize graph service if needed
    const graphService = await getGraphService();

    // Step 1: Parse the natural language query
    const parsed = await parseNaturalLanguageQuery(query);

    // Step 2: Generate Cypher query
    const generatedQuery = generateCypherQuery(parsed);

    // Step 3: Execute the query
    const queryResult: GraphQueryResult = await graphService.query(generatedQuery.cypher, generatedQuery.params);

    // Step 4: Format results
    const results = formatQueryResults(queryResult, parsed.intent);

    // Step 5: Generate natural language answer
    const answer = await generateNaturalLanguageAnswer(query, parsed, results, generatedQuery.explanation);

    return {
      success: true,
      answer,
      results,
      query: generatedQuery,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    log.error('Query execution failed', error instanceof Error ? error : undefined);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const isConnectionError =
      errorMessage.includes('ECONNREFUSED') ||
      errorMessage.includes('Neo4j') ||
      errorMessage.includes('connect') ||
      errorMessage.includes('graph service') ||
      errorMessage.includes('ServiceUnavailable');
    const answer = isConnectionError
      ? 'The knowledge graph is currently unavailable. Natural language queries require a running Neo4j instance. You can still browse entities using the sidebar navigation.'
      : `I couldn't process that query. ${errorMessage}`;
    return {
      success: false,
      answer,
      error: errorMessage,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Format raw query results into GraphNode array.
 */
function formatQueryResults(queryResult: GraphQueryResult, intent: QueryIntent): GraphNode[] {
  const results: GraphNode[] = [];

  for (const record of queryResult.records) {
    // Handle different result shapes based on intent
    if (intent === 'find_path') {
      // Path results have pathNodes array
      const pathNodes = record.pathNodes as Array<{
        id: string;
        name: string;
        type: string;
      }>;
      if (pathNodes) {
        for (const node of pathNodes) {
          results.push({
            id: node.id,
            labels: [node.type],
            properties: { name: node.name, entityType: node.type },
          });
        }
      }
    } else if (record.n) {
      // Standard node result
      const node = record.n as Record<string, unknown>;
      results.push({
        id: node.id as string,
        labels: [node.entityType as string],
        properties: node,
      });
    } else if (record.neighbor) {
      // Neighbor result
      const neighbor = record.neighbor as Record<string, unknown>;
      results.push({
        id: neighbor.id as string,
        labels: [neighbor.entityType as string],
        properties: neighbor,
      });
    } else if (record.solution || record.impacted || record.aligned || record.vendor) {
      // Business query results
      const entity = (record.solution || record.impacted || record.aligned || record.vendor) as Record<string, unknown>;
      results.push({
        id: entity.id as string,
        labels: [entity.entityType as string],
        properties: entity,
      });
    } else if (record.type && record.count !== undefined) {
      // Statistics result
      results.push({
        id: `stat-${record.type}`,
        labels: ['Statistic'],
        properties: { type: record.type, count: record.count },
      });
    }
  }

  return results;
}

/**
 * Generate a natural language answer from query results.
 */
async function generateNaturalLanguageAnswer(
  originalQuery: string,
  parsed: ParsedQuery,
  results: GraphNode[],
  _queryExplanation: string
): Promise<string> {
  if (results.length === 0) {
    return `I couldn't find any results for "${originalQuery}". The knowledge graph may not have relevant data, or you might want to try rephrasing your question.`;
  }

  // For simple queries, generate answer without AI
  if (parsed.intent === 'statistics') {
    const stats = results.map((r) => `${r.properties.type}: ${r.properties.count}`).join(', ');
    return `Here are the statistics: ${stats}`;
  }

  if (parsed.intent === 'find_by_type') {
    const entityType = parsed.filters?.entityTypes?.[0] || 'entities';
    const names = results
      .slice(0, 10)
      .map((r) => r.properties.name)
      .join(', ');
    const more = results.length > 10 ? ` and ${results.length - 10} more` : '';
    return `Found ${results.length} ${entityType}: ${names}${more}.`;
  }

  if (parsed.intent === 'find_path') {
    if (results.length > 0) {
      const pathNames = results.map((r) => r.properties.name).join(' → ');
      return `Connection found: ${pathNames}`;
    }
    return 'No connection path found between the specified entities.';
  }

  // For other queries, provide a summary
  const entityNames = results
    .slice(0, 5)
    .map((r) => r.properties.name)
    .join(', ');
  const more = results.length > 5 ? ` and ${results.length - 5} more` : '';

  const intentDescriptions: Record<QueryIntent, string> = {
    find_path: 'connection',
    find_neighbors: 'related entities',
    find_by_type: 'entities',
    impact_analysis: 'impacted entities',
    solution_discovery: 'potential solutions',
    alignment_check: 'aligned entities',
    vendor_search: 'vendors',
    gap_analysis: 'gaps identified',
    statistics: 'statistics',
    custom_query: 'results',
  };

  return `Found ${results.length} ${intentDescriptions[parsed.intent]}: ${entityNames}${more}.`;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get example queries for each intent type.
 */
export function getExampleQueries(): Array<{
  intent: QueryIntent;
  examples: string[];
}> {
  return [
    {
      intent: 'find_path',
      examples: [
        'How is React connected to Google?',
        "What's the path between Machine Learning and our Digital Strategy?",
        'Show the connection between TensorFlow and Healthcare department',
      ],
    },
    {
      intent: 'find_neighbors',
      examples: [
        'What is related to Kubernetes?',
        'Show me what uses AWS',
        'What technologies are connected to our AI initiative?',
      ],
    },
    {
      intent: 'find_by_type',
      examples: ['List all technologies', 'Show me all companies', 'What strategies do we have?'],
    },
    {
      intent: 'impact_analysis',
      examples: [
        'What is impacted by cloud migration?',
        'What does moving to microservices affect?',
        'Show the impact of adopting GraphQL',
      ],
    },
    {
      intent: 'solution_discovery',
      examples: [
        'What solves our data quality issues?',
        'How can we address slow deployment times?',
        'What technologies help with customer churn?',
      ],
    },
    {
      intent: 'alignment_check',
      examples: [
        'What technologies align with our digital transformation strategy?',
        'Which initiatives support our cost reduction goals?',
        'Show technologies that enable our innovation strategy',
      ],
    },
    {
      intent: 'vendor_search',
      examples: [
        'Who provides Kubernetes solutions?',
        'Which companies offer machine learning platforms?',
        'Find vendors for data analytics',
      ],
    },
    {
      intent: 'gap_analysis',
      examples: [
        'Where are the gaps in our technology coverage?',
        'Which pain points have no solutions?',
        'Show unaddressed business challenges',
      ],
    },
    {
      intent: 'statistics',
      examples: ['How many technologies do we track?', 'Count all companies', 'Show me entity statistics'],
    },
  ];
}

/**
 * Validate if a Cypher query is safe to execute.
 * Prevents destructive operations.
 */
export function isSafeQuery(cypher: string): boolean {
  return inspectCypherReadQuery(cypher).allowed;
}
