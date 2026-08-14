/**
 * @file app/api/debug/backfill-neo4j/route.ts
 * @description Debug API for triggering Neo4j backfill operations
 *
 * This endpoint helps fix sync gaps by triggering batch syncs for:
 * - Documents
 * - Entity-Document Links
 * - Relations
 * - All entity types (company, strategy, prototype, signal, etc.)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { inngest, type InngestEvents } from '@/lib/inngest/client';
import type { EntityType } from '@/lib/types';

/** Element type of the technology batch-sync event payload — the handler contract. */
type BatchSyncTechnology = InngestEvents['app/technology.batch-sync.requested']['data']['technologies'][number];

/** Firestore admin Timestamps carry toMillis(); the event contract wants epoch millis. */
function toEpochMillis(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof (value as { toMillis?: () => number }).toMillis === 'function') {
    return (value as { toMillis: () => number }).toMillis();
  }
  return undefined;
}

const log = createLogger('api/debug/backfill-neo4j');

// Entity types that use the unified sync (excluding those with dedicated sync functions)
const UNIFIED_ENTITY_TYPES: EntityType[] = [
  'company',
  'strategy',
  'prototype',
  'signal',
  'orgUnit',
  'initiative',
  'painPoint',
  'useCase',
];

// Collection name mapping
const ENTITY_TYPE_TO_COLLECTION: Record<string, string> = {
  company: 'companies',
  strategy: 'strategies',
  prototype: 'prototypes',
  signal: 'signals',
  orgUnit: 'org-units',
  initiative: 'initiatives',
  painPoint: 'painPoints',
  useCase: 'use-cases',
};

type BackfillAction =
  'documents' | 'entity-doc-links' | 'relations' | 'technologies' | 'entities' | 'all' | 'full-sync';

/**
 * POST /api/debug/backfill-neo4j
 *
 * Body:
 * - action: 'documents' | 'entity-doc-links' | 'relations' | 'technologies' | 'entities' | 'all'
 *   | 'full-sync' (DISC-006: fires `app/full-sync.requested` — the one-shot full
 *   Firestore→Neo4j rebuild `fullSyncJob` runs after a graph wipe; previously
 *   nothing in the app could send that event)
 * - entityType?: EntityType (optional, filter for 'entities' action)
 */
export async function POST(request: NextRequest) {
  // Require admin authentication + development mode only
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const action: BackfillAction = body.action || 'all';
    const filterEntityType: EntityType | undefined = body.entityType;
    const results: Record<string, string[] | number | string> = {};

    // Step 0 (DISC-006): explicit full rebuild — hand the whole job to
    // fullSyncJob (reconcile-firestore-neo4j.ts) and return. Deliberately NOT
    // part of 'all' (which batch-syncs collections itself); this is the
    // disaster-recovery path after a graph wipe.
    if (action === 'full-sync') {
      await inngest.send({ name: 'app/full-sync.requested', data: {} });
      log.info('Full Firestore→Neo4j sync requested (fullSyncJob)');
      return NextResponse.json({
        success: true,
        results: { fullSync: 'requested — fullSyncJob is rebuilding the graph; watch Inngest for progress' },
      });
    }

    // Step 1: Sync technologies (dedicated sync)
    if (action === 'technologies' || action === 'all') {
      const techsSnap = await db.collection('technologies').get();

      // Get full technology data for the batch sync job. Map explicitly onto
      // the event contract (the handler upserts these fields verbatim) and
      // normalize Firestore Timestamps to the epoch millis the contract wants.
      const technologies: BatchSyncTechnology[] = techsSnap.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          name: data.name,
          slug: data.slug,
          description: data.description,
          category: data.category,
          tags: data.tags,
          websiteUrl: data.websiteUrl,
          githubUrl: data.githubUrl,
          documentationUrl: data.documentationUrl,
          linkedCompanies: data.linkedCompanies,
          linkedUseCases: data.linkedUseCases,
          conceptIds: data.conceptIds,
          approvalStatus: data.approvalStatus,
          createdBy: data.createdBy,
          createdAt: toEpochMillis(data.createdAt),
          updatedAt: toEpochMillis(data.updatedAt),
        };
      });
      const techIds = technologies.map((t) => t.id);
      results.technologies = techIds;
      results.technologiesCount = techIds.length;

      // Trigger batch sync for technologies with full data
      if (technologies.length > 0) {
        await inngest.send({
          name: 'app/technology.batch-sync.requested',
          data: {
            technologies,
          },
        });
        log.info('Triggered technology batch sync', { count: technologies.length });
      }
    }

    // Step 2: Sync documents (dedicated sync)
    if (action === 'documents' || action === 'all') {
      const docsSnap = await db.collection('documents').where('status', '==', 'processed').get();

      const documentIds = docsSnap.docs.map((doc) => doc.id);
      results.documents = documentIds;
      results.documentsCount = documentIds.length;

      // Trigger sync for each document
      for (const documentId of documentIds) {
        await inngest.send({
          name: 'app/document.sync.requested',
          data: {
            operation: 'update',
            documentId,
          },
        });
        log.info('Triggered document sync', { documentId });
      }
    }

    // Step 3: Sync entity-document links (dedicated sync)
    if (action === 'entity-doc-links' || action === 'all') {
      const linksSnap = await db.collection('entityDocumentLinks').get();

      const linkIds = linksSnap.docs.map((doc) => doc.id);
      results.links = linkIds;
      results.linksCount = linkIds.length;

      // Trigger sync for each link
      for (const linkId of linkIds) {
        await inngest.send({
          name: 'app/entity-document-link.sync.requested',
          data: {
            operation: 'update',
            linkId,
          },
        });
        log.info('Triggered entity-doc-link sync', { linkId });
      }
    }

    // Step 4: Sync relations (dedicated sync)
    if (action === 'relations' || action === 'all') {
      const relationsSnap = await db.collection('relations').get();

      const relationIds = relationsSnap.docs.map((doc) => doc.id);
      results.relations = relationIds;
      results.relationsCount = relationIds.length;

      // Trigger sync for each relation
      for (const relationId of relationIds) {
        await inngest.send({
          name: 'app/relation.sync.requested',
          data: {
            operation: 'update',
            relationId,
          },
        });
        log.info('Triggered relation sync', { relationId });
      }
    }

    // Step 5: Sync all other entities (unified sync)
    if (action === 'entities' || action === 'all') {
      const entityTypesToSync = filterEntityType ? [filterEntityType] : UNIFIED_ENTITY_TYPES;

      for (const entityType of entityTypesToSync) {
        const collectionName = ENTITY_TYPE_TO_COLLECTION[entityType];
        if (!collectionName) {
          log.warn('Unknown collection for entity type', { entityType });
          continue;
        }

        try {
          const entitiesSnap = await db.collection(collectionName).get();

          const entityIds = entitiesSnap.docs.map((doc) => doc.id);
          results[entityType] = entityIds;
          results[`${entityType}Count`] = entityIds.length;

          if (entityIds.length > 0) {
            // Use batch sync for efficiency
            await inngest.send({
              name: 'app/unified-entities.batch-sync.requested',
              data: {
                entityType,
                entityIds,
              },
            });
            log.info('Triggered unified batch sync', { entityType, count: entityIds.length });
          }
        } catch (error) {
          log.error('Error syncing entity type', error instanceof Error ? error : undefined, { entityType });
          results[`${entityType}Error`] = error instanceof Error ? error.message : 'Unknown error';
        }
      }
    }

    // Build summary
    const summary: Record<string, number> = {};
    for (const key of Object.keys(results)) {
      if (key.endsWith('Count')) {
        summary[key.replace('Count', '')] = results[key] as number;
      }
    }

    return NextResponse.json({
      success: true,
      message: `Backfill triggered successfully`,
      action,
      summary,
      details: results,
    });
  } catch (error) {
    log.error('Failed to trigger backfill', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to trigger backfill',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/debug/backfill-neo4j
 * Returns backfill status and available actions
 */
export async function GET(request: NextRequest) {
  // Require admin authentication + development mode only
  const auth = await requireAdmin(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  return NextResponse.json({
    success: true,
    availableActions: ['documents', 'entity-doc-links', 'relations', 'technologies', 'entities', 'all'],
    entityTypes: UNIFIED_ENTITY_TYPES,
    usage: {
      fullBackfill: 'POST with { "action": "all" }',
      specificAction: 'POST with { "action": "entities", "entityType": "company" }',
      onlyRelations: 'POST with { "action": "relations" }',
    },
  });
}
