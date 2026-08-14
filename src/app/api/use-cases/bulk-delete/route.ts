/**
 * @file route.ts (API > use-cases > bulk-delete)
 * @description API endpoint for bulk deleting use cases with cascade relation cleanup
 *
 * POST /api/use-cases/bulk-delete - Delete multiple use cases at once
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminDeleteUseCases } from '@/lib/use-cases-admin';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/use-cases/bulk-delete');

// Request body schema
const BulkDeleteRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, 'At least one use case ID is required')
    .refine((ids) => new Set(ids).size === ids.length, 'Use case IDs must be unique'),
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

    // Delete use cases with cascade cleanup
    const result = await adminDeleteUseCases(ids);

    return NextResponse.json({
      success: result.failed.length === 0,
      deleted: result.deleted,
      failed: result.failed,
      relationsDeleted: result.relationsDeleted,
    });
  } catch (error) {
    log.error('Bulk use case delete failed', error instanceof Error ? error : undefined);

    return NextResponse.json({ error: 'Failed to delete use cases' }, { status: 500 });
  }
}
