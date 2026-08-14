/**
 * @file app/api/visualizations/route.ts
 * @description API routes for listing and creating visualizations.
 *
 * - GET /api/visualizations — List the authenticated owner's visualizations
 * - POST /api/visualizations — Create a new visualization (authenticated)
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createVisualization, listVisualizations } from '@/lib/visualizations';
import { createVisualizationSchema } from '@/lib/schemas/visualization';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/visualizations');
const createVisualizationRequestSchema = createVisualizationSchema.omit({ userId: true });

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const visualizations = await listVisualizations(auth.uid);
    return NextResponse.json({ visualizations });
  } catch (error) {
    log.error('Failed to list visualizations', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list visualizations' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const validation = createVisualizationRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }

    const viz = await createVisualization({ ...validation.data, userId: auth.uid });
    log.info('Visualization created via API', { vizId: viz.id, uid: auth.uid });

    return NextResponse.json(viz, { status: 201 });
  } catch (error) {
    log.error('Failed to create visualization', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to create visualization' }, { status: 500 });
  }
}
