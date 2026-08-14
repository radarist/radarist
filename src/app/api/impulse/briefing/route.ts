/**
 * @file /api/impulse/briefing
 * @description API route for the Briefing page — returns proactive insights.
 *
 * Queries ProactiveInsight nodes from Neo4j for the authenticated user
 * and returns them formatted for the BriefingFeed component.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getInsightsForUser, getInsightStats } from '@/lib/graph/proactive-insights';
import { GraphUnavailableError, graphDegradedBody, type GraphDegradedBody } from '@/lib/graph/errors';
import { withGraphReadDeadline } from '@/lib/graph/interactive-read';
import { createLogger } from '@/lib/logger';
import type { BriefingData, BriefingInsight } from '@/hooks/useBriefing';

const log = createLogger('api/impulse/briefing');

/** Default limit for insight retrieval */
const DEFAULT_LIMIT = 20;

/** Estimated tokens per insight (placeholder until real token tracking) */
const TOKENS_PER_INSIGHT = 500;

/** Default token budget (placeholder — will come from config/env) */
const DEFAULT_TOKEN_BUDGET = 100_000;

/**
 * GET /api/impulse/briefing
 *
 * Returns proactive insights for the authenticated user.
 *
 * Query params:
 * - limit (optional, default 20): Maximum number of insights to return
 *
 * Response:
 * ```json
 * {
 *   "insights": BriefingInsight[],
 *   "tokenUsage": { "used": number, "budget": number }
 * }
 * ```
 *
 * Degradation (UX-018): when the graph backend is unavailable the route
 * returns 503 with `{ degraded: true }` so the client can tell an outage apart
 * from a genuinely empty inbox — it no longer masks an outage as 200-empty.
 * PERF-008: the read is bounded so that 503 arrives within a measured budget.
 */
export async function GET(
  request: NextRequest
): Promise<NextResponse<BriefingData | { error: string } | GraphDegradedBody>> {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    // Parse limit from query params
    const url = new URL(request.url);
    const limitParam = url.searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.min(100, parseInt(limitParam, 10) || DEFAULT_LIMIT)) : DEFAULT_LIMIT;

    try {
      // Fetch insights and stats from Neo4j in parallel, bounded so a Neo4j
      // outage surfaces the 503 below within a measured budget (PERF-008)
      // instead of the driver's stacked ~33–60s.
      const [insightNodes, stats] = await withGraphReadDeadline('briefing', () =>
        Promise.all([getInsightsForUser(auth.uid, limit), getInsightStats(auth.uid)])
      );

      // Map ProactiveInsightNode[] → BriefingInsight[]
      const insights: BriefingInsight[] = insightNodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        summary: node.summary,
        agentName: node.agentName,
        confidenceScore: node.confidenceScore,
        relatedEntities: node.relatedEntities,
        observedEntityId: node.observedEntityId,
        exploredEntityId: node.exploredEntityId,
        actionable: node.actionable,
        actionUrl: node.actionUrl,
        actionLabel: node.actionLabel,
        createdAt: node.createdAt,
        liked: node.liked,
        relationshipTypes: node.relationshipTypes,
        sourceRelationTypes: node.sourceRelationTypes,
        relationshipDirections: node.relationshipDirections,
        evidenceSummary: node.evidenceSummary,
        groundingVersion: node.groundingVersion,
        epistemicKind: node.epistemicKind,
        pathLength: node.pathLength,
        exploredAt: node.exploredAt,
      }));

      // Token usage approximation: estimated tokens per insight * total insights
      const tokenUsage = {
        used: stats.total * TOKENS_PER_INSIGHT,
        budget: DEFAULT_TOKEN_BUDGET,
      };

      log.info('Briefing data returned', {
        userId: auth.uid,
        insightCount: insights.length,
        totalInsights: stats.total,
      });

      return NextResponse.json({ insights, tokenUsage });
    } catch (neo4jError) {
      // Honest degradation (UX-018): a graph outage is NOT an empty inbox.
      // Return a sanitized 503 `degraded` response so the client can render a
      // distinct "unavailable / retry" state instead of "no insights". Any
      // other error is a real bug — rethrow to the 500 handler below.
      if (neo4jError instanceof GraphUnavailableError) {
        log.warn('Neo4j unavailable, returning degraded briefing', {
          error: neo4jError.message,
          backend: neo4jError.backend,
          userId: auth.uid,
        });

        return NextResponse.json(graphDegradedBody(neo4jError), {
          status: 503,
          headers: { 'X-Impulse-Fallback': 'true' },
        });
      }

      throw neo4jError;
    }
  } catch (error) {
    log.error('Unexpected error in briefing API', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
