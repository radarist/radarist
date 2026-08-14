/**
 * @file app/api/visualizations/bulk-delete/route.ts
 * @description Bulk delete visualizations.
 *
 * - POST /api/visualizations/bulk-delete — Delete multiple visualizations
 *
 * @phase Impulse v1.0 — Phase 1: Nano Banana Integration
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { deleteVisualizations } from '@/lib/visualizations';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/visualizations/bulk-delete');
const MAX_BULK_DELETE_IDS = 100;
const bulkDeleteSchema = z.object({
  ids: z
    .array(z.string().trim().min(1).max(256).refine((id) => !id.includes('/')))
    .min(1)
    .max(MAX_BULK_DELETE_IDS),
});

export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const validation = bulkDeleteSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid visualization ids' }, { status: 400 });
    }

    const ids = Array.from(new Set(validation.data.ids));
    const deleted = await deleteVisualizations(ids, auth.uid);
    log.info('Visualizations bulk deleted', { count: deleted, uid: auth.uid });

    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    log.error('Failed to bulk delete visualizations', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to bulk delete' }, { status: 500 });
  }
}
