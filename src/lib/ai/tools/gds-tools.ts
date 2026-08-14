/**
 * @file ai/tools/gds-tools.ts
 * @description AI tools for Phase 5 Neo4j GDS algorithms.
 *
 * Exposes to the AI:
 *   - getPersonalizedRecommendations: PageRank-ranked technologies, seeded
 *     by entities the user currently interacts with (radar placements).
 *   - findDuplicateEntities: Jaccard node similarity to surface potential
 *     duplicate Technology / Company entries for review.
 *   - listCommunityClusters: summary of Louvain communities in the graph,
 *     with top-N representatives per community.
 *
 * @phase Phase 5: GDS algorithms (UI integration)
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import {
  runPersonalizedPageRankForUser,
  detectDuplicateCandidates,
  type PageRankHit,
  type DupeCandidate,
} from '@/lib/graph';
import { runReadTransaction } from '@/lib/graph/neo4j-client';
import { createLogger } from '@/lib/logger';

const log = createLogger('ai/gds-tools');

// ============================================================================
// TOOL DECLARATIONS
// ============================================================================

export const GDS_TOOLS: FunctionDeclaration[] = [
  {
    name: 'getPersonalizedRecommendations',
    description:
      'Rank technologies by personalized PageRank seeded from a set of entities the user cares about (typically their current radar placements or recently-viewed techs). Returns the top-N technologies most structurally connected to the seed set. Use this when the user asks "what should I look at next?", "what technologies are most relevant to my radar?", or similar recommendation questions.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        seedEntityIds: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            'Entity IDs to seed the personalized PageRank from (e.g. technologies already on the user radar). Pass an empty array to get global PageRank instead.',
        },
        topN: {
          type: SchemaType.NUMBER,
          description: 'Number of top results to return (default: 10)',
        },
      },
      required: ['seedEntityIds'],
    },
  },
  {
    name: 'findDuplicateEntities',
    description:
      'Find potential duplicate entities (same label, high neighborhood-Jaccard similarity). Returns pairs with similarity >= threshold. Use this when the user asks "find duplicates", "are any technologies similar?", or as part of a data-quality review.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        threshold: {
          type: SchemaType.NUMBER,
          description: 'Minimum Jaccard similarity (0.0 to 1.0). Default 0.85.',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum pairs to return. Default 20.',
        },
      },
      required: [],
    },
  },
  {
    name: 'listCommunityClusters',
    description:
      'List the largest Louvain communities in the knowledge graph with their top representative entities. Use this when the user asks "what clusters exist?", "show me the technology communities", or wants a high-level structural overview of the graph.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        topCommunities: {
          type: SchemaType.NUMBER,
          description: 'How many top communities to return (default 5)',
        },
        membersPerCommunity: {
          type: SchemaType.NUMBER,
          description: 'How many sample members per community (default 5)',
        },
      },
      required: [],
    },
  },
  {
    name: 'getCommunityReports',
    description:
      'Retrieve LLM-generated summaries of the top graph communities, scored by substring match against a free-text query. Each report contains title, summary, themes, and memberIds — use this for "whole landscape" questions like "what\'s happening across AI hardware?" or "summarize the flavor-AI space". Reports are refreshed nightly (F2 community-report overlay). Returns an empty list when no reports have been generated yet.',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: 'Free-text query describing the landscape question the user is asking.',
        },
        k: {
          type: SchemaType.NUMBER,
          description: 'Number of reports to return (default 3, max 10).',
        },
      },
      required: ['query'],
    },
  },
];

// ============================================================================
// EXECUTORS
// ============================================================================

export async function executeGetPersonalizedRecommendations(args: Record<string, unknown>): Promise<{
  success: boolean;
  recommendations: PageRankHit[];
  seedCount: number;
  message: string;
}> {
  const seedEntityIds = Array.isArray(args.seedEntityIds)
    ? (args.seedEntityIds as string[]).filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  const topN = typeof args.topN === 'number' ? Math.min(Math.max(1, args.topN), 50) : 10;

  try {
    const recommendations = await runPersonalizedPageRankForUser(seedEntityIds, { topN });
    log.info('getPersonalizedRecommendations complete', {
      seedCount: seedEntityIds.length,
      returned: recommendations.length,
    });
    return {
      success: true,
      recommendations,
      seedCount: seedEntityIds.length,
      message:
        seedEntityIds.length === 0
          ? `Global PageRank top-${recommendations.length} (no seed entities).`
          : `Personalized PageRank top-${recommendations.length} from ${seedEntityIds.length} seed entities.`,
    };
  } catch (error) {
    log.error('getPersonalizedRecommendations failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      recommendations: [],
      seedCount: seedEntityIds.length,
      message: `PageRank failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export async function executeFindDuplicateEntities(args: Record<string, unknown>): Promise<{
  success: boolean;
  duplicates: DupeCandidate[];
  threshold: number;
  message: string;
}> {
  const threshold = typeof args.threshold === 'number' ? Math.min(Math.max(0, args.threshold), 1) : 0.85;
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 100) : 20;

  try {
    const duplicates = await detectDuplicateCandidates({ threshold, limit });
    return {
      success: true,
      duplicates,
      threshold,
      message:
        duplicates.length === 0
          ? `No duplicate candidates found at Jaccard >= ${threshold}.`
          : `Found ${duplicates.length} potential duplicate pairs at Jaccard >= ${threshold}.`,
    };
  } catch (error) {
    log.error('findDuplicateEntities failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      duplicates: [],
      threshold,
      message: `Duplicate detection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

export interface CommunitySummary {
  communityId: number;
  size: number;
  topMembers: Array<{ id: string; name: string; label: string }>;
}

export async function executeListCommunityClusters(args: Record<string, unknown>): Promise<{
  success: boolean;
  communities: CommunitySummary[];
  message: string;
}> {
  const topCommunities = typeof args.topCommunities === 'number' ? Math.min(Math.max(1, args.topCommunities), 20) : 5;
  const membersPerCommunity =
    typeof args.membersPerCommunity === 'number' ? Math.min(Math.max(1, args.membersPerCommunity), 20) : 5;

  try {
    const topResult = await runReadTransaction<{ communityId: number; size: number }>(
      `
      MATCH (n) WHERE n.gdsCommunity IS NOT NULL
      RETURN n.gdsCommunity AS communityId, count(*) AS size
      ORDER BY size DESC
      LIMIT toInteger($top)
      `,
      { top: topCommunities }
    );

    if (topResult.records.length === 0) {
      return {
        success: true,
        communities: [],
        message:
          'No community assignments found. Run Louvain community detection first (gds.louvain.write with writeProperty "gdsCommunity").',
      };
    }

    const communities: CommunitySummary[] = [];
    for (const row of topResult.records) {
      const members = await runReadTransaction<{ id: string; name: string; label: string }>(
        `
        MATCH (n) WHERE n.gdsCommunity = $cid
        RETURN n.id AS id, n.name AS name,
               [l IN labels(n) WHERE l IN ['Technology','Company','UseCase','PainPoint','Strategy','Signal','Prototype','Initiative','OrgUnit','Document']][0] AS label
        LIMIT toInteger($members)
        `,
        { cid: row.communityId, members: membersPerCommunity }
      );
      communities.push({
        communityId: row.communityId,
        size: row.size,
        topMembers: members.records,
      });
    }

    return {
      success: true,
      communities,
      message: `Top ${communities.length} Louvain communities in the knowledge graph.`,
    };
  } catch (error) {
    log.error('listCommunityClusters failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      communities: [],
      message: `Community listing failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// ---------------------------------------------------------------------------
// getCommunityReports — F2 overlay retrieval
// ---------------------------------------------------------------------------

export interface CommunityReportHit {
  id: string;
  communityId: number;
  title: string;
  summary: string;
  themes: string[];
  memberCount: number;
  memberIds: string[];
  score: number;
  generatedAt: number;
}

export async function executeGetCommunityReports(args: Record<string, unknown>): Promise<{
  success: boolean;
  reports: CommunityReportHit[];
  message: string;
}> {
  const query = (args.query as string) ?? '';
  const k = Math.min(Math.max((args.k as number) ?? 3, 1), 10);

  if (!query.trim()) {
    return { success: false, reports: [], message: 'query is required' };
  }

  try {
    const { queryCommunityReports } = await import('@/lib/graph/community-reports');
    const hits = await queryCommunityReports(query, k);
    return {
      success: true,
      reports: hits.map((h) => ({
        id: h.id,
        communityId: h.communityId,
        title: h.title,
        summary: h.summary,
        themes: h.themes,
        memberCount: h.memberCount,
        memberIds: h.memberIds,
        score: h.score,
        generatedAt: h.generatedAt,
      })),
      message:
        hits.length === 0
          ? 'No community reports match this query. Run refresh-community-reports first to generate them.'
          : `Top ${hits.length} community reports matching "${query.slice(0, 60)}".`,
    };
  } catch (error) {
    log.error('getCommunityReports failed', error instanceof Error ? error : undefined);
    return {
      success: false,
      reports: [],
      message: `Community-report retrieval failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
