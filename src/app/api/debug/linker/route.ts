/**
 * @file api/debug/linker/route.ts
 * @description Debug endpoint for Linker Agent diagnostics
 *
 * GET /api/debug/linker - Returns diagnostic info about linker status
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';

const log = createLogger('api/debug/linker');

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
    const diagnostics: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
    };

    // 1. Recent linker runs (admin SDK)
    const runsSnapshot = await db.collection('linkerRuns').orderBy('createdAt', 'desc').limit(5).get();
    diagnostics.recentRuns = runsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
      // Convert Firestore timestamp
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
    }));

    // 2. Entity counts
    const entityCounts: Record<string, number> = {};
    const collections = ['companies', 'technologies', 'use-cases', 'signals', 'painPoints', 'documents', 'prototypes'];

    await Promise.all(
      collections.map(async (colName) => {
        try {
          const countSnapshot = await db.collection(colName).count().get();
          entityCounts[colName] = countSnapshot.data().count;
        } catch {
          entityCounts[colName] = -1; // Error
        }
      })
    );
    diagnostics.entityCounts = entityCounts;

    // 3. Approved signals count (linker only processes approved)
    try {
      const approvedCount = await db.collection('signals').where('status', '==', 'Approved').count().get();
      diagnostics.approvedSignals = approvedCount.data().count;
    } catch {
      diagnostics.approvedSignals = -1;
    }

    // 4. Proposed relations counts
    try {
      const pendingCount = await db.collection('proposedRelations').where('status', '==', 'pending').count().get();
      const approvedCount = await db.collection('proposedRelations').where('status', '==', 'approved').count().get();
      const rejectedCount = await db.collection('proposedRelations').where('status', '==', 'rejected').count().get();

      diagnostics.proposedRelations = {
        pending: pendingCount.data().count,
        approved: approvedCount.data().count,
        rejected: rejectedCount.data().count,
      };
    } catch (error) {
      diagnostics.proposedRelations = { error: String(error) };
    }

    // 5. Entity tracking count
    try {
      const trackingCount = await db.collection('linkerEntityTracking').count().get();
      diagnostics.trackedEntities = trackingCount.data().count;
    } catch {
      diagnostics.trackedEntities = -1;
    }

    // 6. Sample entities (check if they have required fields)
    const sampleEntities: Record<string, unknown[]> = {};
    for (const colName of ['technologies', 'companies']) {
      try {
        const sampleSnapshot = await db.collection(colName).limit(3).get();
        sampleEntities[colName] = sampleSnapshot.docs.map((doc) => {
          const data = doc.data();
          return {
            id: doc.id,
            name: data.name || data.title || doc.id,
            hasTags: Boolean(data.tags?.length),
            tagCount: data.tags?.length || 0,
            hasDescription: Boolean(data.description?.length),
            descriptionLength: data.description?.length || 0,
            hasCategory: Boolean(data.category || data.quadrant),
            category: data.category || data.quadrant || null,
          };
        });
      } catch {
        sampleEntities[colName] = [];
      }
    }
    diagnostics.sampleEntities = sampleEntities;

    // 7. Generate diagnosis
    const diagnosis: string[] = [];

    if (runsSnapshot.empty) {
      diagnosis.push('NO_RUNS: No linker runs recorded. The linker may not have executed.');
    } else {
      const lastRun = runsSnapshot.docs[0].data();
      if (lastRun.candidatesGenerated === 0) {
        diagnosis.push('NO_CANDIDATES: Last run generated 0 candidates. Check if entities have tags/descriptions.');
      }
      if (lastRun.candidatesVerified === 0 && lastRun.candidatesGenerated > 0) {
        diagnosis.push(
          'ALL_FILTERED: Candidates were generated but all filtered by AI verification. Try lowering minConfidence.'
        );
      }
      if (lastRun.errors?.length > 0) {
        diagnosis.push(
          `ERRORS: Last run had ${lastRun.errors.length} errors: ${lastRun.errors.slice(0, 2).join(', ')}`
        );
      }
    }

    if (entityCounts.technologies < 2 && entityCounts.companies < 2) {
      diagnosis.push('LOW_ENTITIES: Need at least 2 entities of a type to find relations between them.');
    }

    // Check if sample entities have matching criteria
    const techSamples = sampleEntities.technologies || [];
    const entitiesWithTags = techSamples.filter((e: unknown) => (e as Record<string, unknown>).hasTags).length;
    if (techSamples.length > 0 && entitiesWithTags === 0) {
      diagnosis.push('NO_TAGS: Sample entities have no tags. Add tags to enable heuristic matching.');
    }

    diagnostics.diagnosis = diagnosis.length > 0 ? diagnosis : ['OK: No obvious issues detected.'];

    // 8. Recommendations
    diagnostics.recommendations = [
      'Check browser console for [LinkerAgent] and [CandidateGenerator] logs',
      'Ensure entities have tags, descriptions, or categories for matching',
      'Try running with dryRun=false and minConfidence=40 to test',
      'Verify there are no existing relations between entity pairs',
    ];

    return NextResponse.json(diagnostics);
  } catch (error) {
    log.error('Linker debug error', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to fetch diagnostics', details: String(error) }, { status: 500 });
  }
}
