/**
 * @file ai/tools/pipeline-tools.ts
 * @description AI tools for pipeline control and monitoring
 *
 * Provides tools for the AI assistant to:
 * - Check pipeline status
 * - Trigger pipeline runs
 * - Get trend data
 * - Monitor pipeline health
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { SchemaType, type FunctionDeclaration } from '@google/generative-ai';
import { inngest } from '@/lib/inngest/client';
import { adminGetTrends, adminGetTrendStats, adminGetTrendById } from '@/lib/trends-admin';
import type { ComputedTrend } from '@/lib/trends-core';
import { getGraphServiceHealth } from '@/lib/graph';
import { getGraphRefreshStats, verifyGraphIntegrity } from '@/lib/pipeline';

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

export const PIPELINE_TOOLS: FunctionDeclaration[] = [
  {
    name: 'getPipelineStatus',
    description: 'Get the current status of the daily pipeline including health, last run info, and statistics',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        includeGraphStats: {
          type: SchemaType.BOOLEAN,
          description: 'Include detailed graph statistics',
        },
        includeIntegrityCheck: {
          type: SchemaType.BOOLEAN,
          description: 'Run and include graph integrity check',
        },
      },
    },
  },
  {
    name: 'triggerPipeline',
    description: 'Manually trigger the daily pipeline to run immediately',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        reason: {
          type: SchemaType.STRING,
          description: 'Optional reason for triggering the pipeline',
        },
      },
    },
  },
  {
    name: 'getTrends',
    description: 'Get computed trends with optional filtering by trajectory or keyword',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        trajectory: {
          type: SchemaType.STRING,
          format: 'enum',
          description: 'Filter by trajectory: emerging, growing, stable, or declining',
          enum: ['emerging', 'growing', 'stable', 'declining'],
        },
        keyword: {
          type: SchemaType.STRING,
          description: 'Filter trends by keyword',
        },
        limit: {
          type: SchemaType.NUMBER,
          description: 'Maximum number of trends to return (default: 10)',
        },
      },
    },
  },
  {
    name: 'getTrendDetails',
    description: 'Get detailed information about a specific trend',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        trendId: {
          type: SchemaType.STRING,
          description: 'The ID of the trend to get details for',
        },
      },
      required: ['trendId'],
    },
  },
  {
    name: 'getTrendSummary',
    description: 'Get a summary of all computed trends including counts by trajectory',
    parameters: {
      type: SchemaType.OBJECT,
      properties: {},
    },
  },
];

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface PipelineStatusResult {
  success: boolean;
  status: {
    healthy: boolean;
    lastRunAt: number | null;
    nextRunAt: number;
    graphHealth: { healthy: boolean; backend: string; latencyMs: number };
    graphStats?: { nodes: number; claims: number; relations: number };
    integrityCheck?: { healthy: boolean; issues: number };
  };
  error?: string;
}

export interface TriggerPipelineResult {
  success: boolean;
  triggeredAt: number;
  message: string;
  error?: string;
}

export interface GetTrendsResult {
  success: boolean;
  trends: Array<{
    id: string;
    name: string;
    trajectory: string;
    signalCount: number;
    confidence: number;
    keywords: string[];
    summary?: string;
  }>;
  total: number;
  error?: string;
}

export interface GetTrendDetailsResult {
  success: boolean;
  trend?: ComputedTrend;
  error?: string;
}

export interface TrendSummaryResult {
  success: boolean;
  summary: {
    total: number;
    emerging: number;
    growing: number;
    stable: number;
    declining: number;
    lastComputedAt?: number;
    topKeywords: string[];
  };
  error?: string;
}

// ============================================================================
// EXECUTION FUNCTIONS
// ============================================================================

/**
 * Get pipeline status
 */
export async function executeGetPipelineStatus(args: Record<string, unknown>): Promise<PipelineStatusResult> {
  const includeGraphStats = args.includeGraphStats as boolean | undefined;
  const includeIntegrityCheck = args.includeIntegrityCheck as boolean | undefined;

  try {
    // Get graph health
    const graphHealth = await getGraphServiceHealth();

    // Calculate next cron run (8 AM UTC)
    const now = Date.now();
    const nextRun = new Date(now);
    nextRun.setUTCHours(8, 0, 0, 0);
    if (nextRun.getTime() <= now) {
      nextRun.setUTCDate(nextRun.getUTCDate() + 1);
    }

    const status: PipelineStatusResult['status'] = {
      healthy: graphHealth.healthy,
      lastRunAt: null, // Would come from persistent storage
      nextRunAt: nextRun.getTime(),
      graphHealth: {
        healthy: graphHealth.healthy,
        backend: graphHealth.backend,
        latencyMs: graphHealth.latencyMs,
      },
    };

    // Include graph stats if requested
    if (includeGraphStats) {
      const stats = await getGraphRefreshStats();
      status.graphStats = {
        nodes: stats.nodeCount,
        claims: stats.claimCount,
        relations: stats.relationCount,
      };
    }

    // Include integrity check if requested
    if (includeIntegrityCheck) {
      const integrity = await verifyGraphIntegrity();
      status.integrityCheck = {
        healthy: integrity.healthy,
        issues: integrity.issues.length,
      };
    }

    return { success: true, status };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      status: {
        healthy: false,
        lastRunAt: null,
        nextRunAt: 0,
        graphHealth: { healthy: false, backend: 'unknown', latencyMs: 0 },
      },
      error: err,
    };
  }
}

/**
 * Trigger pipeline manually
 */
export async function executeTriggerPipeline(args: Record<string, unknown>): Promise<TriggerPipelineResult> {
  const reason = args.reason as string | undefined;

  try {
    await inngest.send({
      name: 'app/pipeline.trigger',
      data: {
        source: 'ai-assistant',
        triggeredAt: Date.now(),
        reason: reason || 'Triggered via AI assistant',
      },
    });

    return {
      success: true,
      triggeredAt: Date.now(),
      message: 'Pipeline triggered successfully. It will run shortly.',
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      triggeredAt: 0,
      message: 'Failed to trigger pipeline',
      error: err,
    };
  }
}

/**
 * Get trends with optional filtering
 */
export async function executeGetTrends(args: Record<string, unknown>): Promise<GetTrendsResult> {
  const trajectory = args.trajectory as string | undefined;
  const keyword = args.keyword as string | undefined;
  const limit = (args.limit as number) || 10;

  try {
    let trends = await adminGetTrends();

    // Filter by trajectory
    if (trajectory) {
      trends = trends.filter((t) => t.trajectory === trajectory);
    }

    // Filter by keyword
    if (keyword) {
      const kw = keyword.toLowerCase();
      trends = trends.filter(
        (t) =>
          t.name.toLowerCase().includes(kw) ||
          t.keywords.some((k) => k.toLowerCase().includes(kw)) ||
          t.summary?.toLowerCase().includes(kw)
      );
    }

    // Sort by confidence and limit
    trends = trends.sort((a, b) => b.confidence - a.confidence).slice(0, limit);

    return {
      success: true,
      trends: trends.map((t) => ({
        id: t.id,
        name: t.name,
        trajectory: t.trajectory,
        signalCount: t.signalCount,
        confidence: t.confidence,
        keywords: t.keywords,
        summary: t.summary,
      })),
      total: trends.length,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { success: false, trends: [], total: 0, error: err };
  }
}

/**
 * Get trend details by ID
 */
export async function executeGetTrendDetails(args: Record<string, unknown>): Promise<GetTrendDetailsResult> {
  const trendId = args.trendId as string;

  if (!trendId) {
    return { success: false, error: 'Trend ID is required' };
  }

  try {
    const trend = await adminGetTrendById(trendId);

    if (!trend) {
      return { success: false, error: `Trend not found: ${trendId}` };
    }

    return { success: true, trend };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return { success: false, error: err };
  }
}

/**
 * Get trend summary
 */
export async function executeGetTrendSummary(): Promise<TrendSummaryResult> {
  try {
    const stats = await adminGetTrendStats();
    const trends = await adminGetTrends();

    // Get top keywords across all trends
    const keywordCounts = new Map<string, number>();
    for (const trend of trends) {
      for (const keyword of trend.keywords) {
        keywordCounts.set(keyword, (keywordCounts.get(keyword) || 0) + 1);
      }
    }

    const topKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([kw]) => kw);

    // Find most recent computation time
    const lastComputedAt = trends.length > 0 ? Math.max(...trends.map((t) => t.lastComputedAt)) : undefined;

    return {
      success: true,
      summary: {
        total: stats.total,
        emerging: stats.emerging,
        growing: stats.growing,
        stable: stats.stable,
        declining: stats.declining,
        lastComputedAt,
        topKeywords,
      },
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      summary: {
        total: 0,
        emerging: 0,
        growing: 0,
        stable: 0,
        declining: 0,
        topKeywords: [],
      },
      error: err,
    };
  }
}
