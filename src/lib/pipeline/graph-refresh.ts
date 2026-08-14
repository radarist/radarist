/**
 * @file lib/pipeline/graph-refresh.ts
 * @description Graph projection refresh service
 *
 * Ensures the Neo4j graph stays synchronized with Firestore data.
 * Runs as part of the daily pipeline to:
 * 1. Sync any pending entity changes
 * 2. Update claim statuses
 * 3. Rebuild graph indexes if needed
 * 4. Verify graph integrity
 *
 * @phase Phase 6: Daily Pipeline
 * @author Radarist Team
 * @created 2026-01-09
 */

import { createLogger } from '@/lib/logger';

import { getGraphService, getGraphServiceHealth, syncEntity, invalidateAllGraphCaches } from '@/lib/graph';

const log = createLogger('pipeline/graph-refresh');
import { adminGetCompanies } from '@/lib/companies-admin';
import { adminGetTechnologiesWithRadar, type TechnologyWithRadar } from '@/lib/technologies-admin';
import { adminGetStrategies } from '@/lib/strategies-admin';
import { initializeSchema } from '@/lib/graph/neo4j-client';
import type { Company, Technology, Strategy } from '@/lib/types';

// ============================================================================
// TYPES
// ============================================================================

export interface GraphRefreshResult {
  success: boolean;
  nodesRefreshed: number;
  nodesSynced: number;
  nodesSkipped: number;
  relationsRefreshed: number;
  cacheCleared: boolean;
  schemaUpdated: boolean;
  errors: Array<{ entityId: string; entityType: string; error: string }>;
  processingTimeMs: number;
  healthStatus: {
    healthy: boolean;
    backend: string;
    latencyMs: number;
  };
}

export interface GraphRefreshOptions {
  fullSync?: boolean;
  entityTypes?: Array<'company' | 'technology' | 'strategy'>;
  clearCache?: boolean;
  updateSchema?: boolean;
  maxEntities?: number;
  dryRun?: boolean;
  /**
   * OBS-003 — the accepted request identity that drove this refresh, threaded
   * onto every `:Entity` projection it writes. Absent for a scheduled refresh,
   * which has no accepted request; `syncEntity` coalesces rather than
   * overwriting, so an unattributed refresh cannot erase earlier evidence.
   */
  correlationId?: string;
}

// ============================================================================
// GRAPH REFRESH
// ============================================================================

/**
 * Refresh the graph projection with current Firestore data.
 *
 * @example
 * ```typescript
 * const result = await refreshGraphProjection({
 *   fullSync: false,
 *   entityTypes: ['company', 'technology'],
 *   clearCache: true,
 * });
 * console.log(`Synced ${result.nodesSynced} nodes`);
 * ```
 */
export async function refreshGraphProjection(options: GraphRefreshOptions = {}): Promise<GraphRefreshResult> {
  const startTime = Date.now();
  const {
    fullSync = false,
    entityTypes = ['company', 'technology', 'strategy'],
    clearCache = true,
    updateSchema = false,
    maxEntities = 500,
    dryRun = false,
    correlationId,
  } = options;

  const result: GraphRefreshResult = {
    success: false,
    nodesRefreshed: 0,
    nodesSynced: 0,
    nodesSkipped: 0,
    relationsRefreshed: 0,
    cacheCleared: false,
    schemaUpdated: false,
    errors: [],
    processingTimeMs: 0,
    healthStatus: {
      healthy: false,
      backend: 'unknown',
      latencyMs: 0,
    },
  };

  try {
    // Step 1: Check graph health
    const health = await getGraphServiceHealth();
    result.healthStatus = {
      healthy: health.healthy,
      backend: health.backend,
      latencyMs: health.latencyMs,
    };

    if (!health.healthy) {
      log.warn('Graph service unhealthy, skipping refresh');
      result.processingTimeMs = Date.now() - startTime;
      return result;
    }

    log.info('Starting refresh', { fullSync, correlationId });

    // Step 2: Update schema if requested
    if (updateSchema && !dryRun) {
      try {
        await initializeSchema();
        result.schemaUpdated = true;
        log.info('Schema updated');
      } catch (error) {
        log.error('Schema update failed', error instanceof Error ? error : undefined);
      }
    }

    // Step 3: Clear cache if requested
    if (clearCache && !dryRun) {
      invalidateAllGraphCaches();
      result.cacheCleared = true;
      log.info('Cache cleared');
    }

    // Step 4: Sync entities by type
    const entitiesToSync: Array<{
      id: string;
      type: 'company' | 'technology' | 'strategy';
      data: Company | Technology | TechnologyWithRadar | Strategy;
    }> = [];

    if (entityTypes.includes('company')) {
      const companies = await adminGetCompanies();
      for (const company of companies.slice(0, maxEntities)) {
        entitiesToSync.push({ id: company.id, type: 'company', data: company });
      }
    }

    if (entityTypes.includes('technology')) {
      const techResult = await adminGetTechnologiesWithRadar();
      for (const tech of techResult.technologies.slice(0, maxEntities)) {
        entitiesToSync.push({ id: String(tech.id), type: 'technology', data: tech });
      }
    }

    if (entityTypes.includes('strategy')) {
      const strategies = await adminGetStrategies();
      for (const strategy of strategies.slice(0, maxEntities)) {
        entitiesToSync.push({ id: strategy.id, type: 'strategy', data: strategy });
      }
    }

    log.info('Found entities to sync', { count: entitiesToSync.length });

    // Step 5: Sync entities with rate limiting
    const batchSize = 10;
    for (let i = 0; i < entitiesToSync.length; i += batchSize) {
      const batch = entitiesToSync.slice(i, i + batchSize);

      await Promise.all(
        batch.map(async ({ id, type, data }) => {
          try {
            if (!dryRun) {
              await syncEntity({
                id: String(data.id),
                entityType: type as 'company' | 'technology' | 'strategy',
                name: data.name,
                description: data.description || '',
                status: 'status' in data ? String(data.status) : 'active',
                tags: 'tags' in data ? data.tags || [] : [],
                ...(correlationId ? { correlationId } : {}),
              });
              result.nodesSynced++;
            } else {
              result.nodesSkipped++;
            }
            result.nodesRefreshed++;
          } catch (error) {
            const err = error instanceof Error ? error.message : String(error);
            result.errors.push({ entityId: id, entityType: type, error: err });
            log.error('Failed to sync entity to graph', error, { entityType: type, entityId: id });
          }
        })
      );

      // Small delay between batches
      if (i + batchSize < entitiesToSync.length) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    result.success = result.errors.length === 0;
    result.processingTimeMs = Date.now() - startTime;

    log.info('Complete', {
      nodesSynced: result.nodesSynced,
      errors: result.errors.length,
      processingTimeMs: result.processingTimeMs,
    });

    return result;
  } catch (error) {
    log.error('Fatal error during graph refresh', error);
    result.processingTimeMs = Date.now() - startTime;
    return result;
  }
}

/**
 * Verify graph integrity.
 * Checks for orphaned nodes, missing relationships, etc.
 */
export async function verifyGraphIntegrity(): Promise<{
  healthy: boolean;
  issues: string[];
  stats: {
    totalNodes: number;
    totalRelations: number;
    orphanedNodes: number;
    missingSubjects: number;
    missingObjects: number;
  };
}> {
  const issues: string[] = [];
  const stats = {
    totalNodes: 0,
    totalRelations: 0,
    orphanedNodes: 0,
    missingSubjects: 0,
    missingObjects: 0,
  };

  try {
    const service = await getGraphService();

    // Check for orphaned assertions (assertions without subjects/objects)
    const orphanCheck = await service.query(
      `MATCH (claim:Assertion)
       WHERE NOT EXISTS {
         MATCH (e:Entity {id: claim.subjectId})
       } OR NOT EXISTS {
         MATCH (e:Entity {id: claim.objectId})
       }
       RETURN count(claim) as orphaned`,
      {}
    );

    if (orphanCheck?.records && orphanCheck.records.length > 0) {
      const record = orphanCheck.records[0] as { orphaned: number };
      stats.orphanedNodes = record.orphaned;
      if (record.orphaned > 0) {
        issues.push(`Found ${record.orphaned} orphaned assertions`);
      }
    }

    // Get total counts
    const countResult = await service.query(
      `MATCH (e:Entity) RETURN count(e) as nodes
       UNION ALL
       MATCH (c:Assertion) RETURN count(c) as nodes`,
      {}
    );

    if (countResult?.records) {
      stats.totalNodes = (countResult.records as Array<{ nodes: number }>).reduce((sum, r) => sum + r.nodes, 0);
    }

    // Get relation count
    const relResult = await service.query(`MATCH ()-[r]->() RETURN count(r) as relations`, {});

    if (relResult?.records && relResult.records.length > 0) {
      stats.totalRelations = (relResult.records[0] as { relations: number }).relations;
    }

    return {
      healthy: issues.length === 0,
      issues,
      stats,
    };
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    issues.push(`Integrity check failed: ${err}`);
    return {
      healthy: false,
      issues,
      stats,
    };
  }
}

/**
 * Get graph statistics for monitoring.
 */
export async function getGraphRefreshStats(): Promise<{
  nodeCount: number;
  claimCount: number;
  relationCount: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}> {
  try {
    const service = await getGraphService();

    // Get node counts by type
    const typeResult = await service.query(
      `MATCH (e:Entity)
       RETURN e.entityType as type, count(e) as count`,
      {}
    );

    const byType: Record<string, number> = {};
    if (typeResult?.records) {
      for (const record of typeResult.records as Array<{ type: string; count: number }>) {
        byType[record.type] = record.count;
      }
    }

    // Get assertion counts by status
    const statusResult = await service.query(
      `MATCH (c:Assertion)
       RETURN c.status as status, count(c) as count`,
      {}
    );

    const byStatus: Record<string, number> = {};
    if (statusResult?.records) {
      for (const record of statusResult.records as Array<{ status: string; count: number }>) {
        byStatus[record.status] = record.count;
      }
    }

    const totalNodes = Object.values(byType).reduce((sum, n) => sum + n, 0);
    const totalClaims = Object.values(byStatus).reduce((sum, n) => sum + n, 0);

    // Get total relations
    const relResult = await service.query(`MATCH ()-[r]->() RETURN count(r) as count`, {});
    const relationCount =
      relResult?.records && relResult.records.length > 0 ? (relResult.records[0] as { count: number }).count : 0;

    return {
      nodeCount: totalNodes,
      claimCount: totalClaims,
      relationCount,
      byType,
      byStatus,
    };
  } catch (error) {
    log.error('Failed to get stats', error instanceof Error ? error : undefined);
    return {
      nodeCount: 0,
      claimCount: 0,
      relationCount: 0,
      byType: {},
      byStatus: {},
    };
  }
}
