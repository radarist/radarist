/**
 * @file app/api/debug/firestore/route.ts
 * @description Debug API for querying Firestore directly
 *
 * This endpoint helps diagnose sync issues by querying Firestore
 * to see what data exists in the primary database.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';

const log = createLogger('api/debug/firestore');

/**
 * GET /api/debug/firestore
 *
 * Query parameters:
 * - collection: The Firestore collection to query
 * - limit: Max results (default 100)
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
    const { searchParams } = new URL(request.url);
    const collectionName = searchParams.get('collection');
    const limitValue = parseInt(searchParams.get('limit') || '100', 10);

    if (!collectionName) {
      return NextResponse.json(
        {
          error: 'collection parameter required',
          availableCollections: ['relations', 'entityDocumentLinks', 'documents', 'technologies', 'companies'],
        },
        { status: 400 }
      );
    }

    const collectionRef = db.collection(collectionName);
    let snapshot;

    // Try to order by createdAt if available; admin SDK throws lazily on
    // unindexed fields when `.get()` runs, so we catch + retry without order.
    try {
      snapshot = await collectionRef.orderBy('createdAt', 'desc').limit(limitValue).get();
    } catch {
      snapshot = await collectionRef.limit(limitValue).get();
    }
    const docs = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return NextResponse.json({
      success: true,
      collection: collectionName,
      count: docs.length,
      data: docs,
    });
  } catch (error) {
    log.error('Failed to query Firestore', error instanceof Error ? error : undefined);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to query Firestore',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
