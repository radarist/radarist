/**
 * @file app/api/admin/backfill-concepts/route.ts
 * @description Admin API endpoint for triggering concept backfill operations
 *
 * This endpoint allows admins to:
 * - Backfill concepts from entity tags
 * - Trigger Neo4j sync for concepts
 * - Get status of existing concepts
 *
 * **Security:** Requires admin authentication
 *
 * @phase Knowledge Graph Intelligence Sprint - Phase 6
 * @author Radarist Team
 * @created 2026-01-14
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@/lib/logger';
import { requireAdmin } from '@/lib/auth-utils';
import { Timestamp, FieldValue } from 'firebase-admin/firestore';
import { db } from '@/lib/firebase-admin';
import { adminBulkGetOrCreateConcepts, adminGetConcepts, adminIncrementEntityCount } from '@/lib/concept-admin';
import { triggerBatchConceptSync } from '@/lib/inngest/functions/sync-concept-to-neo4j';

const log = createLogger('api/admin/backfill-concepts');

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface BackfillRequest {
  action: 'preview' | 'backfill' | 'sync' | 'status';
  collections?: string[];
  limit?: number;
  dryRun?: boolean;
}

interface BackfillResult {
  success: boolean;
  action: string;
  stats: {
    collectionsProcessed: number;
    entitiesScanned: number;
    entitiesUpdated: number;
    conceptsCreated: number;
    tagsProcessed: number;
    errors: string[];
  };
}

interface StatusResult {
  success: boolean;
  totalConcepts: number;
  byType: Record<string, number>;
  bySyncStatus: Record<string, number>;
  topConcepts: Array<{
    id: string;
    canonicalName: string;
    entityCount: number;
  }>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Canonical collection names (see src/lib/entity-collections.ts). `useCases`/
// `orgUnits` here made the concept backfill skip every real use-case/org-unit doc.
const ENTITY_COLLECTIONS = [
  'technologies',
  'companies',
  'use-cases',
  'strategies',
  'prototypes',
  'signals',
  'org-units',
  'initiatives',
  'painPoints',
  'documents',
];

const DEFAULT_BATCH_LIMIT = 100;

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * GET /api/admin/backfill-concepts
 * Returns status of existing concepts
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Require admin authentication
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const concepts = await adminGetConcepts();

    // Calculate stats
    const byType: Record<string, number> = {};
    const bySyncStatus: Record<string, number> = {};

    for (const concept of concepts) {
      const conceptType = concept.type || 'unknown';
      byType[conceptType] = (byType[conceptType] || 0) + 1;
      const syncStatus = concept.graphSyncStatus || 'unknown';
      bySyncStatus[syncStatus] = (bySyncStatus[syncStatus] || 0) + 1;
    }

    // Get top concepts by entity count
    const topConcepts = [...concepts]
      .sort((a, b) => (b.entityCount || 0) - (a.entityCount || 0))
      .slice(0, 20)
      .map((c) => ({
        id: c.id,
        canonicalName: c.canonicalName,
        entityCount: c.entityCount || 0,
      }));

    const result: StatusResult = {
      success: true,
      totalConcepts: concepts.length,
      byType,
      bySyncStatus,
      topConcepts,
    };

    return NextResponse.json(result);
  } catch (error) {
    log.error('GET error', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/backfill-concepts
 * Triggers backfill operations
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Require admin authentication
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = (await request.json()) as BackfillRequest;
    const { action, collections, limit, dryRun = false } = body;

    switch (action) {
      case 'preview':
        return await handlePreview(collections, limit);

      case 'backfill':
        return await handleBackfill(collections, limit, dryRun);

      case 'sync':
        return await handleSync();

      case 'status':
        return GET(request);

      default:
        return NextResponse.json({ success: false, error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (error) {
    log.error('POST error', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// ACTION HANDLERS
// ============================================================================

/**
 * Preview what would be backfilled without making changes
 */
async function handlePreview(collections?: string[], limit?: number): Promise<NextResponse> {
  const targetCollections = collections || ENTITY_COLLECTIONS;
  const batchLimit = limit || DEFAULT_BATCH_LIMIT;

  const tagCounts: Record<string, number> = {};
  let entitiesScanned = 0;
  let entitiesWithTags = 0;

  for (const collectionName of targetCollections) {
    try {
      const snapshot = await db.collection(collectionName).limit(batchLimit).get();

      for (const docSnap of snapshot.docs) {
        entitiesScanned++;
        const data = docSnap.data();
        const tags = data.tags as string[] | undefined;

        if (tags && tags.length > 0) {
          entitiesWithTags++;
          for (const tag of tags) {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
        }
      }
    } catch (_error) {
      log.warn('Error reading collection during preview', { collectionName });
    }
  }

  // Sort tags by frequency
  const sortedTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([tag, count]) => ({ tag, count }));

  return NextResponse.json({
    success: true,
    action: 'preview',
    collectionsScanned: targetCollections,
    entitiesScanned,
    entitiesWithTags,
    uniqueTags: Object.keys(tagCounts).length,
    topTags: sortedTags,
  });
}

/**
 * Perform the actual backfill operation
 */
async function handleBackfill(collections?: string[], limit?: number, dryRun?: boolean): Promise<NextResponse> {
  const targetCollections = collections || ENTITY_COLLECTIONS;
  const batchLimit = limit || DEFAULT_BATCH_LIMIT;

  const stats: BackfillResult['stats'] = {
    collectionsProcessed: 0,
    entitiesScanned: 0,
    entitiesUpdated: 0,
    conceptsCreated: 0,
    tagsProcessed: 0,
    errors: [],
  };

  for (const collectionName of targetCollections) {
    try {
      const snapshot = await db.collection(collectionName).limit(batchLimit).get();
      stats.collectionsProcessed++;

      for (const docSnap of snapshot.docs) {
        stats.entitiesScanned++;
        const data = docSnap.data();
        const tags = data.tags as string[] | undefined;
        const existingConceptIds = (data.conceptIds as string[]) || [];

        if (!tags || tags.length === 0) continue;

        try {
          // Get or create concepts for all tags
          const concepts = await adminBulkGetOrCreateConcepts(tags, 'tag');
          stats.tagsProcessed += tags.length;

          // Count new concepts (rough estimate)
          const newConceptIds = concepts.filter((c) => !existingConceptIds.includes(c.id)).map((c) => c.id);

          if (newConceptIds.length > 0 && !dryRun) {
            // Update entity with concept IDs (admin SDK)
            const entityRef = db.collection(collectionName).doc(docSnap.id);
            await entityRef.update({
              conceptIds: FieldValue.arrayUnion(...newConceptIds),
              updatedAt: Timestamp.now(),
            });

            // Increment entity count for each concept
            for (const conceptId of newConceptIds) {
              await adminIncrementEntityCount(conceptId, 1);
            }

            stats.entitiesUpdated++;
          } else if (newConceptIds.length > 0) {
            stats.entitiesUpdated++;
          }
        } catch (error) {
          const message = `Error processing ${collectionName}/${docSnap.id}: ${error instanceof Error ? error.message : 'Unknown'}`;
          stats.errors.push(message);
          log.warn('Error processing entity during backfill', { detail: message });
        }
      }
    } catch (error) {
      const message = `Error reading ${collectionName}: ${error instanceof Error ? error.message : 'Unknown'}`;
      stats.errors.push(message);
      log.warn('Error reading collection during backfill', { detail: message });
    }
  }

  const result: BackfillResult = {
    success: stats.errors.length === 0,
    action: dryRun ? 'backfill (dry run)' : 'backfill',
    stats,
  };

  return NextResponse.json(result);
}

/**
 * Trigger Neo4j sync for all concepts
 */
async function handleSync(): Promise<NextResponse> {
  try {
    // Get all concepts with pending sync status
    const concepts = await adminGetConcepts();
    const conceptIds = concepts.map((c) => c.id);

    if (conceptIds.length === 0) {
      return NextResponse.json({
        success: true,
        action: 'sync',
        message: 'No concepts to sync',
        conceptsQueued: 0,
      });
    }

    // Trigger batch sync
    await triggerBatchConceptSync(conceptIds, { batchSize: 20 });

    return NextResponse.json({
      success: true,
      action: 'sync',
      message: `Queued ${conceptIds.length} concepts for Neo4j sync`,
      conceptsQueued: conceptIds.length,
    });
  } catch (error) {
    log.error('Sync error', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
