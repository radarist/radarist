/**
 * @file app/api/debug/enrich-signal/route.ts
 * @description Admin route that runs Gemini-grounded enrichment on a signal
 * to resolve its canonical publisher URL, real title, and summary. Fixes the
 * "source vs stored data not aligned" issue where the aggregator RSS gave us
 * a redirect URL and a normalised title.
 *
 * POST /api/debug/enrich-signal
 *   body: { signalId: string, dryRun?: boolean }
 *
 * Auth: admin required.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { db } from '@/lib/firebase-admin';
import { enrichSignal } from '@/lib/signals/enrichment';
import type { Signal } from '@/lib/types';

const log = createLogger('api/debug/enrich-signal');

export async function POST(request: NextRequest) {
  const adm = await requireAdmin(request);
  if (!adm.authenticated) {
    return NextResponse.json({ error: adm.error }, { status: 401 });
  }
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Debug endpoints are only available in development mode' }, { status: 403 });
  }

  let body: { signalId?: string; dryRun?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }
  const { signalId, dryRun = false } = body;
  if (!signalId) return NextResponse.json({ error: 'signalId required' }, { status: 400 });

  try {
    const signalRef = db.collection('signals').doc(signalId);
    const snap = await signalRef.get();
    // Admin SDK exposes `exists` as a property, not a method.
    if (!snap.exists) {
      return NextResponse.json({ error: `Signal ${signalId} not found` }, { status: 404 });
    }
    const signal = snap.data() as Signal;

    const enrichment = await enrichSignal({
      title: signal.title,
      description: signal.description,
      url: signal.url ?? '',
      metadata: signal.metadata,
    });

    const update: Record<string, unknown> = {};
    if (enrichment.canonicalUrl) update.url = enrichment.canonicalUrl;
    if (enrichment.canonicalTitle) update.title = enrichment.canonicalTitle;
    if (enrichment.summary) update.aiSummary = enrichment.summary;
    if (enrichment.relevanceScore !== undefined) update.relevanceScore = enrichment.relevanceScore;
    update.metadata = {
      ...(signal.metadata ?? {}),
      ...(enrichment.publisher ? { publisher: enrichment.publisher } : {}),
      enrichedAt: Date.now(),
      enrichedFrom: signal.url ?? null,
    };

    if (!dryRun && enrichment.hasData) {
      await signalRef.update(update);
      log.info('Signal enriched', { signalId, before: signal.url, after: update.url });
    }

    return NextResponse.json({
      signalId,
      dryRun,
      before: {
        title: signal.title,
        url: signal.url,
        publisher: signal.metadata?.publisher,
        relevanceScore: signal.relevanceScore,
      },
      enrichment,
      applied: !dryRun && enrichment.hasData ? update : null,
    });
  } catch (e) {
    log.error('enrich-signal failed', e instanceof Error ? e : new Error(String(e)));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
