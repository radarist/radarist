/**
 * @file app/api/debug/inspect-relations/route.ts
 * @description Debug API to inspect relations data
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';

const log = createLogger('api/debug/inspect-relations');

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
    const relationsSnap = await db.collection('relations').get();

    const relations = relationsSnap.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        relationType: data.relationType,
        sourceSnapshot: data.sourceSnapshot,
        targetSnapshot: data.targetSnapshot,
      };
    });

    // Find problematic relations (with weird IDs)
    const problematic = relations.filter((r) => {
      const sourceId = r.sourceSnapshot?.id || '';
      const targetId = r.targetSnapshot?.id || '';
      // Look for IDs that don't match expected patterns
      return (
        sourceId.includes(':') ||
        targetId.includes(':') ||
        (!sourceId.startsWith('tech-') &&
          !sourceId.startsWith('company-') &&
          !sourceId.startsWith('proto-') &&
          !sourceId.startsWith('signal-') &&
          !sourceId.startsWith('strategy-') &&
          !sourceId.startsWith('usecase-') &&
          !sourceId.startsWith('orgunit-') &&
          !sourceId.startsWith('init-') &&
          !sourceId.startsWith('pain-') &&
          !sourceId.startsWith('rel-') &&
          !targetId.startsWith('tech-') &&
          !targetId.startsWith('company-') &&
          !targetId.startsWith('proto-') &&
          !targetId.startsWith('signal-') &&
          !targetId.startsWith('strategy-') &&
          !targetId.startsWith('usecase-') &&
          !targetId.startsWith('orgunit-') &&
          !targetId.startsWith('init-') &&
          !targetId.startsWith('pain-') &&
          !targetId.startsWith('rel-'))
      );
    });

    return NextResponse.json({
      success: true,
      totalRelations: relations.length,
      problematicCount: problematic.length,
      problematic,
      allRelations: relations,
    });
  } catch (error) {
    log.error('Failed to inspect relations', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to inspect relations',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
