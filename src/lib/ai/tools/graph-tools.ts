/**
 * @file ai/tools/graph-tools.ts
 * @description AI tools for GraphRAG operations (Phase 5)
 *
 * Provides capabilities for:
 * - Multi-hop graph traversal and queries
 * - Path finding and connection explanation
 * - Business impact analysis
 * - Gap analysis and recommendations
 * - Executive Q&A support
 *
 * @phase Phase 5: GraphRAG Reasoning Engine
 * @author Radarist Team
 * @created 2026-01-09
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  // Traversal functions
  findPath,
  findAllPaths,
  findConnected,
  getNeighbors,
  checkConnection,
  explainGraphConnection,
  getGraphStatus,
  formatPath,
  // Business queries
  findSolutionsForPainPoint,
  findTechnologiesForStrategy,
  analyzeTechnologyImpact,
  findVendorsForStrategy,
  analyzeGaps,
  compareTechnologyPortfolio,
  recommendTechnologyInvestments,
  generateTechnologySummary,
  // NL-to-Cypher
  executeNaturalLanguageQuery,
  getExampleQueries,
  // Business-entity identity (AI-026)
  businessEntityGraphType,
  // Service access
  getGraphService,
  // Types
  type GraphNode,
  type GraphPath,
  type NLQueryResult,
} from '@/lib/graph';
import type { TransformationEntityType } from '@/lib/types';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/graph-tools');

// ============================================================================
// Tool Definitions for Graph Operations
// ============================================================================

export const GRAPH_TOOLS: FunctionDeclaration[] = [
  // ---------------------------------------------------------------------------
  // Core Graph Traversal Tools
  // ---------------------------------------------------------------------------
  {
    name: 'queryGraph',
    description:
      "Query the knowledge graph to find entities connected to a source entity. Supports multi-hop traversal with filtering by entity type and relation type. Great for exploring connections like 'What technologies are connected to this strategy?' or 'What org units use this technology?'",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the source entity to start traversal from',
        },
        targetType: {
          type: SchemaType.STRING,
          description:
            'Type of entities to find: technology, company, useCase, prototype, strategy, signal, org_unit, initiative, pain_point',
        },
        maxDepth: {
          type: SchemaType.NUMBER,
          description: 'Maximum hops to traverse (default: 3, max: 5)',
        },
        relationTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Optional: Filter by relation types (e.g., USES, ENABLES, SOLVES, ALIGNS_WITH)',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of results (default: 20)',
        },
      },
      required: ['entityId', 'targetType'],
    },
  },
  {
    name: 'findGraphPath',
    description:
      "Find the connection path between two entities in the knowledge graph. Returns a detailed explanation of how they are connected, including intermediate entities and relationships. Great for answering 'How is X connected to Y?' questions. Accepts either entity IDs or entity names — names are resolved via fuzzy match. If no path is found, the response distinguishes between 'entity_not_found' (names didn't resolve) and 'no_path' (entities exist but aren't connected within maxDepth) so you know whether to search first or relax the depth.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fromId: {
          type: SchemaType.STRING,
          description:
            "ID or name of the starting entity. If a name is provided (e.g., 'Nvidia' or 'LLM hallucinations'), it will be resolved to the best matching entity. Prefer IDs when known.",
        },
        toId: {
          type: SchemaType.STRING,
          description:
            'ID or name of the destination entity. Names are resolved via case-insensitive CONTAINS on name/title. Prefer IDs when known.',
        },
        maxDepth: {
          type: SchemaType.NUMBER,
          description: 'Maximum path length to search (default: 6)',
        },
        findAll: {
          type: SchemaType.BOOLEAN,
          description: 'If true, find all paths (not just shortest). Default: false',
        },
        pathLimit: {
          type: SchemaType.NUMBER,
          description: 'If findAll is true, maximum paths to return (default: 5)',
        },
      },
      required: ['fromId', 'toId'],
    },
  },
  {
    name: 'getGraphNeighbors',
    description:
      'Get immediate neighbors of an entity in the knowledge graph. Returns directly connected entities with their relationship types. Use for exploring direct connections.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the entity',
        },
        entityTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Filter by entity types (optional)',
        },
        relationTypes: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Filter by relation types (optional)',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum neighbors to return (default: 50)',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'checkGraphConnection',
    description:
      'Check if two entities are connected in the knowledge graph. Returns whether they are connected and the distance in hops.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fromId: {
          type: SchemaType.STRING,
          description: 'ID of the first entity',
        },
        toId: {
          type: SchemaType.STRING,
          description: 'ID of the second entity',
        },
        maxDepth: {
          type: SchemaType.NUMBER,
          description: 'Maximum hops to check (default: 6)',
        },
      },
      required: ['fromId', 'toId'],
    },
  },

  // ---------------------------------------------------------------------------
  // Business Intelligence Tools
  // ---------------------------------------------------------------------------
  {
    name: 'analyzeImpact',
    description:
      'Analyze the business impact of a technology. Shows which use cases it enables, which org units it affects, and its overall reach. Great for understanding the value of a technology investment.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'ID of the technology to analyze',
        },
      },
      required: ['technologyId'],
    },
  },
  {
    name: 'findSolutions',
    description:
      'Find technologies that can solve a specific pain point. Returns solutions ranked by effectiveness score based on path confidence and distance.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        painPointId: {
          type: SchemaType.STRING,
          description: 'ID of the pain point',
        },
        maxDepth: {
          type: SchemaType.NUMBER,
          description: 'Max traversal depth (default: 3)',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max solutions to return (default: 10)',
        },
      },
      required: ['painPointId'],
    },
  },
  {
    name: 'findAlignedTechnologies',
    description:
      'Find technologies that align with a specific STRATEGY, ranked by alignment score with reasoning. Use when the user asks which technologies fit or support a given strategy. Requires a strategyId — if the user names a strategy, resolve it to an ID first (listStrategies / searchEntities). For the broader "what should we invest in?" question, use recommendTechInvestments instead.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        strategyId: {
          type: SchemaType.STRING,
          description: 'ID of the strategy',
        },
        maxDepth: {
          type: SchemaType.NUMBER,
          description: 'Max traversal depth (default: 3)',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max technologies to return (default: 15)',
        },
      },
      required: ['strategyId'],
    },
  },
  {
    name: 'getGapAnalysis',
    description:
      'Analyze capability gaps — pain points that lack initiatives or technology solutions — and recommend where to act. Use when the user asks "where are our gaps / what is unaddressed / what needs attention". Optional orgUnitId scopes the analysis to one org unit (resolve the name to an ID first if the user names one).',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        orgUnitId: {
          type: SchemaType.STRING,
          description: 'Optional: Limit analysis to a specific org unit',
        },
      },
      required: [],
    },
  },
  {
    name: 'findVendors',
    description:
      'Find vendors (companies) that provide technologies aligned with a strategy. Useful for vendor selection and partnership decisions.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        strategyId: {
          type: SchemaType.STRING,
          description: 'ID of the strategy',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max vendors to return (default: 10)',
        },
      },
      required: ['strategyId'],
    },
  },
  {
    name: 'compareCompetitors',
    description:
      "Compare technology portfolios between our company and one or more named competitors — returns each side's unique technologies, shared technologies, and our gaps. Use for 'how do we compare to X / competitive positioning' questions. Requires ourCompanyId + competitorIds — resolve company names to IDs first (searchEntities / listCompanies).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ourCompanyId: {
          type: SchemaType.STRING,
          description: 'ID of our company',
        },
        competitorIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'IDs of competitor companies',
        },
      },
      required: ['ourCompanyId', 'competitorIds'],
    },
  },

  // ---------------------------------------------------------------------------
  // Executive Q&A Tools
  // ---------------------------------------------------------------------------
  {
    name: 'recommendTechInvestments',
    description:
      "Executive Q&A: recommend which technologies to INVEST in, scored from strategy alignment + pain-point solutions + competitive gaps. Use for 'what should we invest in / where should we bet / how to prioritize'. All params optional (strategyId, orgUnitId, competitorIds) — pass whichever the user names (resolve names to IDs first); more context yields better recommendations. Broader than findAlignedTechnologies, which only ranks technologies for a single strategy.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        strategyId: {
          type: SchemaType.STRING,
          description: 'Optional: Strategy to align with',
        },
        orgUnitId: {
          type: SchemaType.STRING,
          description: 'Optional: Org unit to solve pain points for',
        },
        competitorIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description: 'Optional: Competitor IDs to analyze gaps',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Max recommendations (default: 10)',
        },
      },
      required: [],
    },
  },
  {
    name: 'getTechSummary',
    description:
      'Get an executive summary for a technology. Includes impact analysis, strategy alignment, pain points solved, and vendors/providers.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        technologyId: {
          type: SchemaType.STRING,
          description: 'ID of the technology',
        },
      },
      required: ['technologyId'],
    },
  },
  {
    name: 'getGraphHealth',
    description:
      'Check the health and status of the graph database. Returns whether the graph is available, which backend is in use, and latency metrics.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // Natural Language Query Tool (Phase 5.13)
  // ---------------------------------------------------------------------------
  {
    name: 'askGraphQuestion',
    description:
      "Ask a natural language question about the knowledge graph. This tool understands questions like 'How is X connected to Y?', 'What technologies are related to Z?', 'Who provides this technology?', 'What solves this pain point?', etc. Use this for flexible, conversational queries about the innovation data.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        question: {
          type: SchemaType.STRING,
          description:
            "Natural language question about the knowledge graph, e.g., 'How is React connected to Google?' or 'What technologies align with our digital strategy?'",
        },
      },
      required: ['question'],
    },
  },

  // ---------------------------------------------------------------------------
  // Knowledge Gap Tools
  // ---------------------------------------------------------------------------
  {
    name: 'recordKnowledgeGap',
    description:
      'Record a knowledge gap in the graph when the AI encounters a question it cannot answer due to missing, stale, or conflicting data. Use this to flag areas where the knowledge graph needs improvement so they can be prioritised for research.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        question: {
          type: SchemaType.STRING,
          description: 'The question or information that could not be answered from the knowledge graph',
        },
        entityIds: {
          type: SchemaType.ARRAY,
          description: 'IDs of entities related to this knowledge gap',
          items: { type: SchemaType.STRING },
        },
        priority: {
          type: SchemaType.STRING,
          description: 'Priority of the gap: high, medium, or low',
        },
        gapType: {
          type: SchemaType.STRING,
          description:
            'Type of gap: missing_data (no data exists), missing_relation (entities not linked), stale_data (data is outdated), conflicting_data (contradictory information)',
        },
      },
      required: ['question', 'gapType'],
    },
  },

  // ---------------------------------------------------------------------------
  // Data Quality Tools
  // ---------------------------------------------------------------------------
  {
    name: 'findOrphanedEntities',
    description:
      'Find entities that have no relationships to other entities in the knowledge graph. Use this when the user asks about orphaned, unconnected, or isolated entities. Runs a single efficient graph query — much faster than listing entities and checking each one individually. Returns entities grouped by type with counts.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityType: {
          type: SchemaType.STRING,
          description:
            'Optional: Filter by entity type (technology, company, useCase, prototype, strategy, signal, org_unit, initiative, pain_point). If omitted, checks all types.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum orphaned entities to return per type (default: 25)',
        },
      },
      required: [],
    },
  },

  // ---------------------------------------------------------------------------
  // Concept Graph Tools
  // ---------------------------------------------------------------------------
  {
    name: 'findByConcept',
    description:
      "Find all entities linked to a concept tag in the knowledge graph. Use this when the user asks about a theme, topic, or technology concept — for example 'What entities are tagged with Artificial Intelligence?' or 'Show me everything related to the concept cloud computing'. Matches by canonical name (case-insensitive) or slug.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        concept: {
          type: SchemaType.STRING,
          description:
            "The concept name to search for, e.g. 'Artificial Intelligence', 'Machine Learning', 'cloud computing'. Matched case-insensitively against canonical name and slug.",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of entities to return (default: 20)',
        },
      },
      required: ['concept'],
    },
  },
  {
    name: 'findConceptGaps',
    description:
      "Find innovation gaps by identifying concepts that have entities of some types but are missing entities of another type. For example, find concepts that have signals and technologies but no prototypes ('no_prototypes' gap). Use this to surface areas where innovation work is lacking.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        gapType: {
          type: SchemaType.STRING,
          description:
            "The type of entity that is missing. Options: 'no_prototypes' (concepts with no Prototype entities), 'no_use_cases' (concepts with no UseCase entities), 'no_companies' (concepts with no Company entities), 'no_signals' (concepts with no Signal entities).",
        },
        minEntities: {
          type: SchemaType.NUMBER,
          description:
            'Minimum number of existing entities a concept must have before it is considered a gap (default: 3)',
        },
      },
      required: ['gapType'],
    },
  },
  {
    name: 'findSimilarEntities',
    description:
      "Find entities that share the most concept tags with a target entity. Use this when the user asks 'What is similar to X?' or 'Find technologies like this one'. Returns entities ranked by the number of shared concepts.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        entityId: {
          type: SchemaType.STRING,
          description: 'ID of the target entity to find similar entities for',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of similar entities to return (default: 10)',
        },
      },
      required: ['entityId'],
    },
  },
  {
    name: 'getConceptMap',
    description:
      "Get the top concepts in the knowledge graph ranked by how many entities are tagged with them. Use this to understand the dominant themes in the knowledge base, or when the user asks 'What are the main topics?' or 'Show me a concept overview'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of concepts to return (default: 30)',
        },
      },
      required: [],
    },
  },
];

// ============================================================================
// Result Types
// ============================================================================

export interface QueryGraphResult {
  success: boolean;
  entities?: Array<{
    id: string;
    name: string;
    type: string;
    properties: Record<string, unknown>;
  }>;
  count?: number;
  error?: string;
}

export interface FindGraphPathResult {
  success: boolean;
  /**
   * Outcome the caller LLM must branch on:
   *   path_found        — one or more paths returned in `paths`
   *   no_path           — both entities resolved but no path within maxDepth
   *   entity_not_found  — one or both inputs couldn't be resolved; see `missing`
   *   error             — execution error, see `error`
   * Legacy `connected` boolean is preserved so existing callers still compile.
   */
  status?: 'path_found' | 'no_path' | 'entity_not_found' | 'error';
  connected?: boolean;
  explanation?: string;
  paths?: Array<{
    nodes: Array<{ id: string; name: string; type: string }>;
    relations: Array<{ type: string; from: string; to: string }>;
    length: number;
    formatted: string;
  }>;
  /** Resolved entity info when status is path_found / no_path. */
  resolved?: {
    from: { input: string; id: string; name: string };
    to: { input: string; id: string; name: string };
  };
  /** Populated when status is 'entity_not_found' — tells the LLM what to search for. */
  missing?: Array<{
    slot: 'from' | 'to';
    input: string;
    suggestions: Array<{ id: string; name: string; type: string }>;
  }>;
  error?: string;
}

export interface GetNeighborsResult {
  success: boolean;
  neighbors?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  count?: number;
  error?: string;
}

export interface CheckConnectionResult {
  success: boolean;
  connected?: boolean;
  distance?: number;
  error?: string;
}

export interface AnalyzeImpactResult {
  success: boolean;
  impact?: {
    technologyName: string;
    useCases: Array<{ name: string; distance: number }>;
    orgUnits: Array<{ name: string; viaUseCase: string; distance: number }>;
    totalReach: number;
  };
  error?: string;
}

export interface FindSolutionsResult {
  success: boolean;
  solutions?: Array<{
    technologyId: string;
    technologyName: string;
    effectivenessScore: number;
    distance: number;
    pathDescription?: string;
  }>;
  error?: string;
}

export interface FindAlignedTechnologiesResult {
  success: boolean;
  technologies?: Array<{
    technologyId: string;
    technologyName: string;
    alignmentScore: number;
    distance: number;
    reason: string;
  }>;
  error?: string;
}

export interface GapAnalysisResult {
  success: boolean;
  gaps?: Array<{
    painPointId: string;
    painPointName: string;
    severity: string;
    hasInitiative: boolean;
    hasTechnology: boolean;
    affectedOrgUnits: string[];
    recommendation: string;
  }>;
  error?: string;
}

export interface FindVendorsResult {
  success: boolean;
  vendors?: Array<{
    companyId: string;
    companyName: string;
    alignmentScore: number;
    technologies: string[];
    explanation: string;
  }>;
  error?: string;
}

export interface CompareCompetitorsResult {
  success: boolean;
  comparison?: {
    unique: Array<{ id: string; name: string }>;
    shared: Array<{ id: string; name: string }>;
    gaps: Array<{ id: string; name: string }>;
  };
  error?: string;
}

export interface RecommendInvestmentsResult {
  success: boolean;
  recommendations?: Array<{
    technologyId: string;
    technologyName: string;
    score: number;
    reasons: string[];
  }>;
  error?: string;
}

export interface TechSummaryResult {
  success: boolean;
  summary?: {
    technologyId: string;
    technologyName: string;
    impactReach: number;
    useCasesEnabled: number;
    orgUnitsAffected: number;
    alignedStrategies: Array<{ name: string; score: number }>;
    solvesPainPoints: Array<{ name: string; effectiveness: number }>;
    providers: Array<{ id: string; name: string }>;
  };
  error?: string;
}

export interface GraphHealthResult {
  success: boolean;
  health?: {
    healthy: boolean;
    backend: string;
    latencyMs: number;
    error?: string;
  };
  error?: string;
}

export interface AskGraphQuestionResult {
  success: boolean;
  answer?: string;
  results?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  queryExplanation?: string;
  executionTimeMs?: number;
  error?: string;
}

export interface FindOrphanedEntitiesResult {
  success: boolean;
  orphans?: Array<{
    id: string;
    name: string;
    type: string;
  }>;
  totalOrphans?: number;
  totalEntities?: number;
  byType?: Record<string, number>;
  executionTimeMs?: number;
  error?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

function nodeToSimple(node: GraphNode | null | undefined): { id: string; name: string; type: string } {
  if (!node) {
    return { id: 'unknown', name: 'unknown', type: 'unknown' };
  }
  return {
    id: node.id || 'unknown',
    name: String(node.properties?.name || node.id || 'unknown'),
    // AI-026: canonical label first, `entityType` property only as a fallback.
    // The old order (`properties.entityType || labels[0]`) is what turned an
    // `:AgentObservation`'s copied `entityType:'technology'` into a Technology in
    // the model's context; the reads below now refuse such a node, and this keeps
    // the render boundary from re-introducing the claim if one ever reaches it.
    type: businessEntityGraphType(node) ?? 'unknown',
  };
}

function pathToResult(path: GraphPath): {
  nodes: Array<{ id: string; name: string; type: string }>;
  relations: Array<{ type: string; from: string; to: string }>;
  length: number;
  formatted: string;
} {
  if (!path || !path.nodes) {
    return { nodes: [], relations: [], length: 0, formatted: '(empty path)' };
  }
  const nodes = path.nodes.map(nodeToSimple);
  const relations = (path.relations || []).map((rel, i) => ({
    type: rel?.type || 'RELATED_TO',
    from: nodes[i]?.name || 'unknown',
    to: nodes[i + 1]?.name || 'unknown',
  }));
  return {
    nodes,
    relations,
    length: path.length || 0,
    formatted: formatPath(path),
  };
}

// ============================================================================
// Execution Functions
// ============================================================================

/**
 * Query graph with multi-hop traversal
 */
export async function executeQueryGraph(args: Record<string, unknown>): Promise<QueryGraphResult> {
  try {
    const entityId = args.entityId as string;
    const targetType = args.targetType as TransformationEntityType;
    const maxDepth = Math.min((args.maxDepth as number) || 3, 5);
    const relationTypes = args.relationTypes as string[] | undefined;
    const limit = Math.min((args.limit as number) || 20, 50);

    if (!entityId || !targetType) {
      return { success: false, error: 'entityId and targetType are required' };
    }

    // Use multi-hop traversal
    const connected = await findConnected(entityId, targetType, {
      maxDepth,
      relationTypes,
    });

    // Apply limit after traversal
    const entities = connected.slice(0, limit).map((node) => ({
      id: node?.id || 'unknown',
      name: String(node?.properties?.name || node?.id || 'unknown'),
      // AI-026: canonical label first (see nodeToSimple).
      type: (node && businessEntityGraphType(node)) || 'unknown',
      properties: node?.properties || {},
    }));

    return {
      success: true,
      entities,
      count: entities.length,
    };
  } catch (error) {
    log.error('queryGraph error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to query graph',
    };
  }
}

/**
 * Find path between two entities. Accepts either IDs or names — names are
 * resolved via {@link resolveEntityByIdOrName} so chat callers don't have
 * to pre-search. Returns a structured `status` so the LLM can branch on
 * "entity_not_found" vs "no_path" vs "path_found" instead of conflating
 * both misses into an unhelpful "connected: false".
 */
export async function executeFindGraphPath(args: Record<string, unknown>): Promise<FindGraphPathResult> {
  try {
    const fromInput = (args.fromId as string) ?? '';
    const toInput = (args.toId as string) ?? '';
    const maxDepth = (args.maxDepth as number) || 6;
    const findAll = (args.findAll as boolean) || false;
    const pathLimit = (args.pathLimit as number) || 5;

    if (!fromInput || !toInput) {
      return { success: false, status: 'error', error: 'fromId and toId are required' };
    }

    const { resolveEntityByIdOrName } = await import('@/lib/graph/resolve-entity');
    const [fromResolved, toResolved] = await Promise.all([
      resolveEntityByIdOrName(fromInput),
      resolveEntityByIdOrName(toInput),
    ]);

    // If either side didn't resolve, tell the LLM exactly which one and
    // hand it up to 5 close candidates for each miss so it can retry.
    if (!fromResolved.match || !toResolved.match) {
      const missing: FindGraphPathResult['missing'] = [];
      if (!fromResolved.match) missing.push({ slot: 'from', input: fromInput, suggestions: fromResolved.suggestions });
      if (!toResolved.match) missing.push({ slot: 'to', input: toInput, suggestions: toResolved.suggestions });
      const missLabels = missing.map((m) => `"${m.input}"`).join(' and ');
      return {
        success: true,
        status: 'entity_not_found',
        connected: false,
        explanation: `Could not resolve ${missLabels} to an entity. ${missing
          .map((m) =>
            m.suggestions.length > 0
              ? `Closest matches for "${m.input}": ${m.suggestions.map((s) => `${s.name} (${s.type}, id=${s.id})`).join('; ')}.`
              : `No close matches for "${m.input}".`
          )
          .join(' ')}`,
        missing,
      };
    }

    const fromId = fromResolved.match.id;
    const toId = toResolved.match.id;

    // Real connectivity check with resolved IDs.
    const explanation = await explainGraphConnection(fromId, toId, { maxDepth });

    if (!explanation.connected) {
      return {
        success: true,
        status: 'no_path',
        connected: false,
        explanation: `No path between "${fromResolved.match.name}" and "${toResolved.match.name}" within ${maxDepth} hops.`,
        paths: [],
        resolved: {
          from: { input: fromInput, id: fromId, name: fromResolved.match.name },
          to: { input: toInput, id: toId, name: toResolved.match.name },
        },
      };
    }

    // Path(s) found.
    let paths: GraphPath[] = [];
    if (findAll) {
      paths = await findAllPaths(fromId, toId, { maxDepth, pathLimit });
    } else {
      const path = await findPath(fromId, toId, { maxDepth });
      if (path) paths = [path];
    }

    return {
      success: true,
      status: 'path_found',
      connected: true,
      explanation: explanation.explanation,
      paths: paths.map(pathToResult),
      resolved: {
        from: { input: fromInput, id: fromId, name: fromResolved.match.name },
        to: { input: toInput, id: toId, name: toResolved.match.name },
      },
    };
  } catch (error) {
    log.error('findGraphPath error', error instanceof Error ? error : undefined);
    return {
      success: false,
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to find path',
    };
  }
}

/**
 * Get immediate neighbors
 */
export async function executeGetGraphNeighbors(args: Record<string, unknown>): Promise<GetNeighborsResult> {
  try {
    const entityId = args.entityId as string;
    const entityTypes = args.entityTypes as TransformationEntityType[] | undefined;
    const relationTypes = args.relationTypes as string[] | undefined;
    const limit = Math.min((args.limit as number) || 50, 100);

    if (!entityId) {
      return { success: false, error: 'entityId is required' };
    }

    const neighbors = await getNeighbors(entityId, {
      entityTypes,
      relationTypes,
      limit,
    });

    return {
      success: true,
      neighbors: neighbors.map(nodeToSimple),
      count: neighbors.length,
    };
  } catch (error) {
    log.error('getGraphNeighbors error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get neighbors',
    };
  }
}

/**
 * Check connection between entities
 */
export async function executeCheckGraphConnection(args: Record<string, unknown>): Promise<CheckConnectionResult> {
  try {
    const fromId = args.fromId as string;
    const toId = args.toId as string;
    const maxDepth = (args.maxDepth as number) || 6;

    if (!fromId || !toId) {
      return { success: false, error: 'fromId and toId are required' };
    }

    const result = await checkConnection(fromId, toId, maxDepth);

    return {
      success: true,
      connected: result.connected,
      distance: result.distance,
    };
  } catch (error) {
    log.error('checkGraphConnection error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check connection',
    };
  }
}

/**
 * Analyze technology impact
 */
export async function executeAnalyzeImpact(args: Record<string, unknown>): Promise<AnalyzeImpactResult> {
  try {
    const technologyId = args.technologyId as string;

    if (!technologyId) {
      return { success: false, error: 'technologyId is required' };
    }

    const impact = await analyzeTechnologyImpact(technologyId);

    return {
      success: true,
      impact: {
        technologyName: String(impact.technology.properties.name || technologyId),
        useCases: impact.useCases.map((uc) => ({
          name: String(uc.useCase.properties.name),
          distance: uc.distance,
        })),
        orgUnits: impact.orgUnits.map((ou) => ({
          name: String(ou.orgUnit.properties.name),
          viaUseCase: ou.viaUseCase,
          distance: ou.totalDistance,
        })),
        totalReach: impact.totalReach,
      },
    };
  } catch (error) {
    log.error('analyzeImpact error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze impact',
    };
  }
}

/**
 * Find solutions for pain point
 */
export async function executeFindSolutions(args: Record<string, unknown>): Promise<FindSolutionsResult> {
  try {
    const painPointId = args.painPointId as string;
    const maxDepth = (args.maxDepth as number) || 3;
    const limit = (args.limit as number) || 10;

    if (!painPointId) {
      return { success: false, error: 'painPointId is required' };
    }

    const solutions = await findSolutionsForPainPoint(painPointId, { maxDepth });

    return {
      success: true,
      solutions: solutions.slice(0, limit).map((s) => ({
        technologyId: s.technology.id,
        technologyName: String(s.technology.properties.name),
        effectivenessScore: s.effectivenessScore,
        distance: s.distance,
        pathDescription: s.path ? formatPath(s.path) : undefined,
      })),
    };
  } catch (error) {
    log.error('findSolutions error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find solutions',
    };
  }
}

/**
 * Find technologies aligned with strategy
 */
export async function executeFindAlignedTechnologies(
  args: Record<string, unknown>
): Promise<FindAlignedTechnologiesResult> {
  try {
    const strategyId = args.strategyId as string;
    const maxDepth = (args.maxDepth as number) || 3;
    const limit = (args.limit as number) || 15;

    if (!strategyId) {
      return { success: false, error: 'strategyId is required' };
    }

    const aligned = await findTechnologiesForStrategy(strategyId, { maxDepth });

    return {
      success: true,
      technologies: aligned.slice(0, limit).map((t) => ({
        technologyId: t.technology.id,
        technologyName: String(t.technology.properties.name),
        alignmentScore: t.alignmentScore,
        distance: t.distance,
        reason: t.reason,
      })),
    };
  } catch (error) {
    log.error('findAlignedTechnologies error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find aligned technologies',
    };
  }
}

/**
 * Get gap analysis
 */
export async function executeGetGapAnalysis(args: Record<string, unknown>): Promise<GapAnalysisResult> {
  try {
    const orgUnitId = args.orgUnitId as string | undefined;

    const gaps = await analyzeGaps({ orgUnitId });

    return {
      success: true,
      gaps: gaps.map((g) => ({
        painPointId: g.painPoint.id,
        painPointName: String(g.painPoint.properties.name),
        severity: g.severity,
        hasInitiative: g.hasInitiative,
        hasTechnology: g.hasTechnology,
        affectedOrgUnits: g.affectedOrgUnits.map((ou) => String(ou.properties.name)),
        recommendation: g.recommendation,
      })),
    };
  } catch (error) {
    log.error('getGapAnalysis error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze gaps',
    };
  }
}

/**
 * Find vendors for strategy
 */
export async function executeFindVendors(args: Record<string, unknown>): Promise<FindVendorsResult> {
  try {
    const strategyId = args.strategyId as string;
    const limit = (args.limit as number) || 10;

    if (!strategyId) {
      return { success: false, error: 'strategyId is required' };
    }

    const vendors = await findVendorsForStrategy(strategyId);

    return {
      success: true,
      vendors: vendors.slice(0, limit).map((v) => ({
        companyId: v.company.id,
        companyName: String(v.company.properties.name),
        alignmentScore: v.alignmentScore,
        technologies: v.technologies.map((t) => String(t.properties.name)),
        explanation: v.explanation,
      })),
    };
  } catch (error) {
    log.error('findVendors error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find vendors',
    };
  }
}

/**
 * Compare competitor technology portfolios
 */
export async function executeCompareCompetitors(args: Record<string, unknown>): Promise<CompareCompetitorsResult> {
  try {
    const ourCompanyId = args.ourCompanyId as string;
    const competitorIds = args.competitorIds as string[];

    if (!ourCompanyId || !competitorIds?.length) {
      return { success: false, error: 'ourCompanyId and competitorIds are required' };
    }

    const comparison = await compareTechnologyPortfolio(ourCompanyId, competitorIds);

    return {
      success: true,
      comparison: {
        unique: comparison.unique.map(nodeToSimple),
        shared: comparison.shared.map(nodeToSimple),
        gaps: comparison.gaps.map(nodeToSimple),
      },
    };
  } catch (error) {
    log.error('compareCompetitors error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to compare competitors',
    };
  }
}

/**
 * Recommend technology investments
 */
export async function executeRecommendTechInvestments(
  args: Record<string, unknown>
): Promise<RecommendInvestmentsResult> {
  try {
    const strategyId = args.strategyId as string | undefined;
    const orgUnitId = args.orgUnitId as string | undefined;
    const competitorIds = args.competitorIds as string[] | undefined;
    const limit = (args.limit as number) || 10;

    const recommendations = await recommendTechnologyInvestments({
      strategyId,
      orgUnitId,
      competitorIds,
      limit,
    });

    return {
      success: true,
      recommendations: recommendations.map((r) => ({
        technologyId: r.technology.id,
        technologyName: String(r.technology.properties.name),
        score: Math.round(r.score),
        reasons: r.reasons,
      })),
    };
  } catch (error) {
    log.error('recommendTechInvestments error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to recommend investments',
    };
  }
}

/**
 * Get technology executive summary
 */
export async function executeGetTechSummary(args: Record<string, unknown>): Promise<TechSummaryResult> {
  try {
    const technologyId = args.technologyId as string;

    if (!technologyId) {
      return { success: false, error: 'technologyId is required' };
    }

    const summary = await generateTechnologySummary(technologyId);

    return {
      success: true,
      summary: {
        technologyId,
        technologyName: summary.technology ? String(summary.technology.properties.name) : technologyId,
        impactReach: summary.impact.totalReach,
        useCasesEnabled: summary.impact.useCases.length,
        orgUnitsAffected: summary.impact.orgUnits.length,
        alignedStrategies: summary.alignedStrategies.map((s) => ({
          name: String(s.strategy.properties.name),
          score: s.score,
        })),
        solvesPainPoints: summary.solvesPainPoints.map((p) => ({
          name: String(p.painPoint.properties.name),
          effectiveness: p.effectiveness,
        })),
        providers: summary.providers.map(nodeToSimple),
      },
    };
  } catch (error) {
    log.error('getTechSummary error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get summary',
    };
  }
}

/**
 * Get graph health status
 */
export async function executeGetGraphHealth(_args: Record<string, unknown>): Promise<GraphHealthResult> {
  try {
    const status = await getGraphStatus();

    return {
      success: true,
      health: status,
    };
  } catch (error) {
    log.error('getGraphHealth error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get graph health',
    };
  }
}

/**
 * Ask a natural language question about the knowledge graph
 */
export async function executeAskGraphQuestion(args: Record<string, unknown>): Promise<AskGraphQuestionResult> {
  try {
    const question = args.question as string;

    if (!question) {
      return { success: false, error: 'question is required' };
    }

    // Execute the natural language query
    const result: NLQueryResult = await executeNaturalLanguageQuery(question);

    if (!result.success) {
      return {
        success: false,
        answer: result.answer,
        error: result.error,
      };
    }

    return {
      success: true,
      answer: result.answer,
      results: result.results?.map((node) => ({
        id: node.id,
        name: String(node.properties.name || node.id),
        // AI-026: canonical label first (see nodeToSimple).
        type: businessEntityGraphType(node) ?? 'unknown',
      })),
      queryExplanation: result.query?.explanation,
      executionTimeMs: result.executionTimeMs,
    };
  } catch (error) {
    log.error('askGraphQuestion error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to process question',
    };
  }
}

/**
 * Find entities with no relationships in the knowledge graph.
 *
 * Uses a single Cypher query instead of O(N) tool calls — completes in
 * milliseconds even with hundreds of entities.
 */
export async function executeFindOrphanedEntities(args: Record<string, unknown>): Promise<FindOrphanedEntitiesResult> {
  try {
    const entityType = args.entityType as string | undefined;
    const limit = Math.min((args.limit as number) || 25, 100);
    const startTime = Date.now();

    const graphService = await getGraphService();

    // Build Cypher query — find nodes with degree 0 (no relationships)
    const typeFilter = entityType ? `WHERE n.entityType = $entityType` : '';

    // Query 1: Get orphaned entities (no relationships)
    const orphanCypher = `
      MATCH (n:Entity)
      ${typeFilter}
      WHERE NOT (n)--()
      RETURN n.id AS id, n.name AS name, n.entityType AS type
      ORDER BY n.entityType, n.name
      LIMIT toInteger($limit)
    `;

    // Query 2: Get total entity count for context
    const countCypher = `
      MATCH (n:Entity)
      ${typeFilter}
      WITH count(n) AS total,
           size([n2 IN collect(n) WHERE NOT (n2)--()]) AS orphanCount
      RETURN total, orphanCount
    `;

    // Run both queries in parallel
    const [orphanResult, countResult] = await Promise.all([
      graphService.query(orphanCypher, { entityType, limit }),
      graphService.query(countCypher, { entityType }).catch(() => ({
        records: [],
        summary: {},
        executionTimeMs: 0,
      })),
    ]);

    const orphans = orphanResult.records.map((r: Record<string, unknown>) => ({
      id: String(r.id || 'unknown'),
      name: String(r.name || r.id || 'unknown'),
      type: String(r.type || 'unknown'),
    }));

    // Group by type for summary
    const byType: Record<string, number> = {};
    for (const o of orphans) {
      byType[o.type] = (byType[o.type] || 0) + 1;
    }

    const totalEntities = countResult.records[0]?.total as number | undefined;
    const totalOrphans = countResult.records[0]?.orphanCount as number | undefined;

    return {
      success: true,
      orphans,
      totalOrphans: totalOrphans ?? orphans.length,
      totalEntities: totalEntities ?? undefined,
      byType,
      executionTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    log.error('findOrphanedEntities error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find orphaned entities',
    };
  }
}

/**
 * Get example queries for the natural language interface
 */
export function getGraphQueryExamples(): ReturnType<typeof getExampleQueries> {
  return getExampleQueries();
}

export interface RecordKnowledgeGapResult {
  success: boolean;
  gapId?: string;
  message?: string;
  error?: string;
}

/**
 * Record a knowledge gap encountered during AI assistant interactions
 */
export async function executeRecordKnowledgeGap(args: Record<string, unknown>): Promise<RecordKnowledgeGapResult> {
  try {
    const { recordCuriosityGap } = await import('@/lib/graph/curiosity-gaps');
    const gapId = await recordCuriosityGap({
      question: args.question as string,
      entityIds: (args.entityIds ?? []) as string[],
      agentName: 'ai-assistant',
      priority: (args.priority ?? 'medium') as 'high' | 'medium' | 'low',
      gapType: (args.gapType ?? 'missing_data') as
        'missing_data' | 'missing_relation' | 'stale_data' | 'conflicting_data',
    });
    return { success: true, gapId, message: `Knowledge gap recorded: ${args.question}` };
  } catch (error) {
    log.error('recordKnowledgeGap error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to record knowledge gap',
    };
  }
}

// ============================================================================
// Concept Graph Execution Functions
// ============================================================================

/**
 * Find all entities linked to a concept tag
 */
export async function executeFindByConcept(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const { runReadTransaction } = await import('@/lib/graph/neo4j-client');
    const conceptName = String(args.concept);
    const limit = Number(args.limit ?? 20);

    const result = await runReadTransaction(
      `MATCH (c:Concept)<-[:HAS_CONCEPT]-(e:Entity)
       WHERE c.canonicalName =~ $pattern OR c.slug = $slug
       RETURN e.id AS id, e.name AS name, e.entityType AS entityType,
              substring(e.description, 0, 200) AS description
       LIMIT toInteger($limit)`,
      {
        pattern: '(?i)' + conceptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        slug: conceptName.toLowerCase().replace(/\s+/g, '-'),
        limit: limit,
      }
    );
    return { entities: result.records, concept: conceptName, count: result.records.length };
  } catch (error) {
    log.error('findByConcept error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find entities by concept',
    };
  }
}

/**
 * Find concepts missing specific entity types (innovation gaps)
 */
export async function executeFindConceptGaps(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const { runReadTransaction } = await import('@/lib/graph/neo4j-client');
    const gapType = String(args.gapType);
    const minEntities = Number(args.minEntities ?? 3);

    const missingLabel: Record<string, string> = {
      no_prototypes: 'Prototype',
      no_use_cases: 'UseCase',
      no_companies: 'Company',
      no_signals: 'Signal',
    };
    const missing = missingLabel[gapType] ?? 'Prototype';

    const result = await runReadTransaction(
      `MATCH (c:Concept)<-[:HAS_CONCEPT]-(e:Entity)
       WHERE c.entityCount >= toInteger($minEntities)
       WITH c, collect(DISTINCT e.entityType) AS types, count(e) AS cnt
       WHERE NOT '${missing.toLowerCase()}' IN [t IN types | toLower(t)]
       RETURN c.canonicalName AS concept, cnt AS entityCount, types AS hasTypes
       ORDER BY cnt DESC LIMIT 20`,
      { minEntities }
    );
    return { gaps: result.records, gapType, missingType: missing };
  } catch (error) {
    log.error('findConceptGaps error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find concept gaps',
    };
  }
}

/**
 * Find entities sharing the most concepts with a target entity
 */
export async function executeFindSimilarEntities(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const { runReadTransaction } = await import('@/lib/graph/neo4j-client');
    const entityId = String(args.entityId);
    const limit = Number(args.limit ?? 10);

    const result = await runReadTransaction(
      `MATCH (target:Entity {id: $entityId})-[:HAS_CONCEPT]->(c)<-[:HAS_CONCEPT]-(other:Entity)
       WHERE other <> target
       WITH other, collect(c.canonicalName) AS sharedConcepts, count(c) AS overlap
       RETURN other.id AS id, other.name AS name, other.entityType AS entityType,
              sharedConcepts, overlap
       ORDER BY overlap DESC LIMIT toInteger($limit)`,
      { entityId, limit }
    );
    return { similar: result.records, targetId: entityId };
  } catch (error) {
    log.error('findSimilarEntities error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to find similar entities',
    };
  }
}

/**
 * Get top concepts with entity counts
 */
export async function executeGetConceptMap(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const { runReadTransaction } = await import('@/lib/graph/neo4j-client');
    const limit = Number(args.limit ?? 30);

    const result = await runReadTransaction(
      `MATCH (c:Concept)<-[:HAS_CONCEPT]-(e:Entity)
       WITH c, count(e) AS cnt, collect(DISTINCT e.entityType) AS types
       RETURN c.canonicalName AS name, cnt AS entityCount, types
       ORDER BY cnt DESC LIMIT toInteger($limit)`,
      { limit }
    );
    return { concepts: result.records, total: result.records.length };
  } catch (error) {
    log.error('getConceptMap error', error instanceof Error ? error : undefined);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get concept map',
    };
  }
}
