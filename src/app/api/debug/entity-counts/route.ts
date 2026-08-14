/**
 * @file app/api/debug/entity-counts/route.ts
 * @description Debug API to count entities in Firestore vs Neo4j
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { runReadTransaction, checkHealth } from '@/lib/graph';

const log = createLogger('api/debug/entity-counts');

function parseGraphCount(value: unknown): number {
  if (typeof value === 'number') return value;
  if (
    value &&
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof (value as { toNumber: () => number }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return 0;
}

/**
 * GET /api/debug/entity-counts
 * Returns counts of all entities in Firestore and Neo4j
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

  try {
    // Firestore collections to count
    const firestoreCollections = [
      { name: 'technologies', entityType: 'technology' },
      { name: 'companies', entityType: 'company' },
      { name: 'use-cases', entityType: 'useCase' },
      { name: 'strategies', entityType: 'strategy' },
      { name: 'prototypes', entityType: 'prototype' },
      { name: 'signals', entityType: 'signal' },
      { name: 'documents', entityType: 'document' },
      { name: 'org-units', entityType: 'orgUnit' },
      { name: 'initiatives', entityType: 'initiative' },
      { name: 'painPoints', entityType: 'painPoint' },
      { name: 'relations', entityType: 'relation' },
      { name: 'entityDocumentLinks', entityType: 'entityDocumentLink' },
      { name: 'radarPlacements', entityType: 'radarPlacement' },
    ];

    // Count Firestore entities
    const firestoreCounts: Record<string, number> = {};
    for (const col of firestoreCollections) {
      try {
        const snap = await db.collection(col.name).get();
        firestoreCounts[col.entityType] = snap.docs.length;
      } catch {
        firestoreCounts[col.entityType] = -1; // Error
      }
    }

    // Count Neo4j entities
    const neo4jCounts: Record<string, number> = {};
    const health = await checkHealth();

    if (health.healthy) {
      const entityLabels = [
        'Technology',
        'Company',
        'UseCase',
        'Strategy',
        'Prototype',
        'Signal',
        'Document',
        'OrgUnit',
        'Initiative',
        'PainPoint',
      ];

      for (const label of entityLabels) {
        try {
          const result = await runReadTransaction(`MATCH (n:${label}) RETURN count(n) as count`, {});
          const count = result.records[0]?.count;
          neo4jCounts[label.toLowerCase()] = parseGraphCount(count);
        } catch {
          neo4jCounts[label.toLowerCase()] = -1;
        }
      }

      // Count relationships
      try {
        const relResult = await runReadTransaction(
          `MATCH ()-[r]->() WHERE r.relationId IS NOT NULL RETURN count(r) as count`,
          {}
        );
        const relCount = relResult.records[0]?.count;
        neo4jCounts['relations'] = parseGraphCount(relCount);
      } catch {
        neo4jCounts['relations'] = -1;
      }

      // Count document links
      try {
        const linkResult = await runReadTransaction(`MATCH ()-[r:DOCUMENTED_BY]->() RETURN count(r) as count`, {});
        const linkCount = linkResult.records[0]?.count;
        neo4jCounts['documentLinks'] = parseGraphCount(linkCount);
      } catch {
        neo4jCounts['documentLinks'] = -1;
      }
    }

    // Calculate gaps
    const gaps: Array<{ entity: string; firestore: number; neo4j: number; gap: number; synced: boolean }> = [];

    const entityMapping: Array<{ firestore: string; neo4j: string; label: string }> = [
      { firestore: 'technology', neo4j: 'technology', label: 'Technology' },
      { firestore: 'company', neo4j: 'company', label: 'Company' },
      { firestore: 'useCase', neo4j: 'usecase', label: 'Use Case' },
      { firestore: 'strategy', neo4j: 'strategy', label: 'Strategy' },
      { firestore: 'prototype', neo4j: 'prototype', label: 'Prototype' },
      { firestore: 'signal', neo4j: 'signal', label: 'Signal' },
      { firestore: 'document', neo4j: 'document', label: 'Document' },
      { firestore: 'orgUnit', neo4j: 'orgunit', label: 'Org Unit' },
      { firestore: 'initiative', neo4j: 'initiative', label: 'Initiative' },
      { firestore: 'painPoint', neo4j: 'painpoint', label: 'Pain Point' },
      { firestore: 'relation', neo4j: 'relations', label: 'Relations' },
      { firestore: 'entityDocumentLink', neo4j: 'documentLinks', label: 'Doc Links' },
    ];

    for (const mapping of entityMapping) {
      const fsCount = firestoreCounts[mapping.firestore] || 0;
      const neo4jCount = neo4jCounts[mapping.neo4j] || 0;
      gaps.push({
        entity: mapping.label,
        firestore: fsCount,
        neo4j: neo4jCount,
        gap: fsCount - neo4jCount,
        synced: fsCount === neo4jCount && fsCount >= 0,
      });
    }

    return NextResponse.json({
      success: true,
      neo4jHealthy: health.healthy,
      firestore: firestoreCounts,
      neo4j: neo4jCounts,
      gaps,
      summary: {
        totalFirestoreEntities: Object.values(firestoreCounts)
          .filter((v) => v >= 0)
          .reduce((a, b) => a + b, 0),
        totalNeo4jEntities: Object.values(neo4jCounts)
          .filter((v) => v >= 0)
          .reduce((a, b) => a + b, 0),
        entitiesFullySynced: gaps.filter((g) => g.synced).length,
        entitiesWithGaps: gaps.filter((g) => !g.synced && g.gap > 0).length,
      },
    });
  } catch (error) {
    log.error('Failed to count entities', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to count entities',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
