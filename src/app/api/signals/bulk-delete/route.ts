/**
 * @file route.ts (API > signals > bulk-delete)
 * @description API endpoint for bulk deleting signals
 *
 * POST /api/signals/bulk-delete - Delete multiple signals at once
 *
 * @author Radarist Team
 * @created 2025-12-03
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminDeleteSignals } from '@/lib/signals-admin';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/signals/bulk-delete');

// Request body schema
const BulkDeleteRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, 'At least one signal ID is required')
    .refine((ids) => new Set(ids).size === ids.length, 'Signal IDs must be unique'),
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

    // Delete signals
    const result = await adminDeleteSignals(ids);

    return NextResponse.json({
      success: result.failed.length === 0,
      deleted: result.deleted,
      failed: result.failed,
    });
  } catch (error) {
    log.error('Bulk signal delete failed', error instanceof Error ? error : undefined);

    return NextResponse.json({ error: 'Failed to delete signals' }, { status: 500 });
  }
}
