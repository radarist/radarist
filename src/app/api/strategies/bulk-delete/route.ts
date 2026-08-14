/**
 * @file route.ts (API > strategies > bulk-delete)
 * @description API endpoint for bulk deleting strategies with cascade relation cleanup
 *
 * POST /api/strategies/bulk-delete - Delete multiple strategies at once
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminDeleteStrategies } from '@/lib/strategies-admin';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/strategies/bulk-delete');

// Request body schema
const BulkDeleteRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, 'At least one strategy ID is required')
    .refine((ids) => new Set(ids).size === ids.length, 'Strategy IDs must be unique'),
});

export async function POST(request: NextRequest) {
  try {
    // Authenticate user
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();

    // Validate request body
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

    // Delete strategies with cascade cleanup
    const result = await adminDeleteStrategies(ids);

    return NextResponse.json({
      success: result.failed.length === 0,
      deleted: result.deleted,
      failed: result.failed,
      relationsDeleted: result.relationsDeleted,
    });
  } catch (error) {
    log.error('Bulk strategy delete failed', error instanceof Error ? error : undefined);

    return NextResponse.json({ error: 'Failed to delete strategies' }, { status: 500 });
  }
}
