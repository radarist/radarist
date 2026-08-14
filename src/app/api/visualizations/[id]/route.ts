/**
 * @file app/api/visualizations/[id]/route.ts
 * @description API routes for individual visualization CRUD.
 *
 * - GET /api/visualizations/[id] — Get visualization by ID
 * - PUT /api/visualizations/[id] — Update visualization (title, shared)
 * - DELETE /api/visualizations/[id] — Delete visualization
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { readVisualizationById, updateVisualization, deleteVisualization } from '@/lib/visualizations';
import { resolveVisualizationEntityReferences } from '@/lib/visualization-entity-refs';
import {
  MAX_VISUALIZATION_TITLE_LENGTH,
  normalizeVisualizationDataSnapshot,
  type ResolvedVisualizationEntityRef,
} from '@/lib/schemas/visualization';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/visualizations/[id]');
const updateVisualizationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_VISUALIZATION_TITLE_LENGTH).optional(),
    shared: z.boolean().optional(),
    liked: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'At least one update field is required' });

/**
 * Resolve the referenced entities for the detail view. Entity lookups happen
 * only on this authenticated route — the public share page never resolves live
 * entity data. Fail-open: a resolution failure degrades to the stored snapshot
 * names rather than failing the whole GET.
 */
async function resolveReferencedEntities(dataSnapshot: unknown): Promise<ResolvedVisualizationEntityRef[]> {
  try {
    return await resolveVisualizationEntityReferences(dataSnapshot);
  } catch (error) {
    log.warn('referenced-entity resolution failed — serving stored snapshot names', {
      error: error instanceof Error ? error.message : String(error),
    });
    return normalizeVisualizationDataSnapshot(dataSnapshot).entities.map((entity) => ({
      id: entity.id,
      type: entity.type,
      name: entity.name.length > 0 ? entity.name : null,
      resolution: entity.name.length > 0 ? 'snapshot' : 'unresolved',
    }));
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ status: 'unauthorized', error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const result = await readVisualizationById(id);
    if (result.status === 'not-found') {
      return NextResponse.json({ status: 'not-found' }, { status: 404 });
    }

    const viz = result.visualization;
    // Treat a foreign private record exactly like an absent record. This keeps
    // the detail contract owner-only without disclosing whether another user's
    // visualization id exists.
    if (viz.userId !== auth.uid) {
      return NextResponse.json({ status: 'not-found' }, { status: 404 });
    }
    const referencedEntities = await resolveReferencedEntities(viz.dataSnapshot);
    return NextResponse.json({ status: 'found', visualization: { ...viz, referencedEntities } });
  } catch (error) {
    log.error('Failed to get visualization', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json(
      { status: 'unavailable', error: 'Visualization metadata is unavailable' },
      { status: 503 }
    );
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid visualization update' }, { status: 400 });
    }
    const validation = updateVisualizationRequestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid visualization update' }, { status: 400 });
    }

    const result = await updateVisualization(id, auth.uid, validation.data);
    if (result.status === 'not-found') {
      return NextResponse.json({ status: 'not-found' }, { status: 404 });
    }
    log.info('Visualization updated', { vizId: id, uid: auth.uid });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Failed to update visualization', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to update visualization' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;
    const result = await deleteVisualization(id, auth.uid);
    if (result.status === 'not-found') {
      return NextResponse.json({ status: 'not-found' }, { status: 404 });
    }
    log.info('Visualization deleted', { vizId: id, uid: auth.uid });

    return NextResponse.json({ success: true });
  } catch (error) {
    log.error('Failed to delete visualization', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to delete visualization' }, { status: 500 });
  }
}
