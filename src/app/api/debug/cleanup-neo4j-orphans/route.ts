/**
 * @file app/api/debug/cleanup-neo4j-orphans/route.ts
 * @description Read-only diagnostic API for Neo4j nodes that don't exist in Firestore
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { checkHealth, runReadTransaction } from '@/lib/graph';

const log = createLogger('api/debug/cleanup-neo4j-orphans');

// Entity types to check for orphans
const ENTITY_CONFIGS = [
  { label: 'Technology', collection: 'technologies' },
  { label: 'Company', collection: 'companies' },
  { label: 'PainPoint', collection: 'painPoints' },
  { label: 'Strategy', collection: 'strategies' },
  { label: 'Prototype', collection: 'prototypes' },
  { label: 'Signal', collection: 'signals' },
  { label: 'Document', collection: 'documents' },
  { label: 'OrgUnit', collection: 'org-units' },
  { label: 'Initiative', collection: 'initiatives' },
];

/**
 * GET /api/debug/cleanup-neo4j-orphans
 * Returns a list of orphan nodes (in Neo4j but not in Firestore)
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
    const health = await checkHealth();
    if (!health.healthy) {
      return NextResponse.json({ error: 'Neo4j not healthy', details: health.error }, { status: 503 });
    }

    const orphans: Record<string, string[]> = {};
    let totalOrphans = 0;

    for (const config of ENTITY_CONFIGS) {
      // Get Firestore IDs
      const snap = await db.collection(config.collection).get();
      const firestoreIds = new Set(snap.docs.map((d) => d.id));

      // Get Neo4j IDs
      const neo4jResult = await runReadTransaction<{ id: string }>(`MATCH (n:${config.label}) RETURN n.id as id`, {});
      const neo4jIds = neo4jResult.records.map((r) => r.id);

      // Find orphans (in Neo4j but not in Firestore)
      const orphanIds = neo4jIds.filter((id) => !firestoreIds.has(id));

      if (orphanIds.length > 0) {
        orphans[config.label] = orphanIds;
        totalOrphans += orphanIds.length;
      }
    }

    return NextResponse.json({
      success: true,
      totalOrphans,
      orphans,
      usage: 'Read-only diagnostic; automatic deletion is disabled',
    });
  } catch (error) {
    log.error('Failed to inspect Neo4j orphans', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to find orphans',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/debug/cleanup-neo4j-orphans
 * Orphan cleanup is intentionally unavailable through HTTP.
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

  return NextResponse.json(
    {
      error: 'Orphan cleanup is read-only; use GET for diagnostics',
    },
    {
      status: 405,
      headers: { Allow: 'GET' },
    }
  );
}
