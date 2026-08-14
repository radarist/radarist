/**
 * @file route.ts (API > technologies > bulk-delete)
 * @description API endpoint for bulk deleting technologies with cascade relation cleanup
 *
 * POST /api/technologies/bulk-delete - Delete multiple technologies at once
 *
 * Accepts decoupled-format IDs (e.g., "tech-1736123456789-abc1234"). The legacy
 * "radarId:techId" composite format was removed in D4.2.
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminDeleteTechnologiesCompletely } from '@/lib/technology-admin';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/technologies/bulk-delete');

const BulkDeleteRequestSchema = z.object({
  ids: z
    .array(z.string().min(1).startsWith('tech-', 'Technology IDs must use decoupled format (tech-xxx)'))
    .min(1, 'At least one technology ID is required'),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();

    const validationResult = BulkDeleteRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: 'Invalid request',
          details: validationResult.error.errors,
        },
        { status: 400 }
      );
    }

    const { ids } = validationResult.data;

    log.info('Deleting technologies', { count: ids.length });
    const result = await adminDeleteTechnologiesCompletely(ids);

    return NextResponse.json({
      success: result.failed.length === 0,
      deleted: result.succeeded,
      failed: result.failed,
      ...(result.failed.length > 0 ? { error: 'Some technologies could not be deleted' } : {}),
      relationsDeleted: result.totalRelationsDeleted,
      placementsDeleted: result.totalPlacementsDeleted,
    });
  } catch (error) {
    log.error('Bulk technology delete failed', error instanceof Error ? error : undefined);

    return NextResponse.json({ error: 'Failed to delete technologies' }, { status: 500 });
  }
}
