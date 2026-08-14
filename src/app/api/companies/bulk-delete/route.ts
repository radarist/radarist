/**
 * @file route.ts (API > companies > bulk-delete)
 * @description API endpoint for bulk deleting companies with cascade relation cleanup
 *
 * POST /api/companies/bulk-delete - Delete multiple companies at once
 *
 * @author Radarist Team
 * @created 2025-12-09
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminDeleteCompaniesBulk } from '@/lib/companies-admin';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/companies/bulk-delete');

// Request body schema
const BulkDeleteRequestSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, 'At least one company ID is required')
    .refine((ids) => new Set(ids).size === ids.length, 'Company IDs must be unique'),
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

    // Delete companies with cascade cleanup
    const result = await adminDeleteCompaniesBulk(ids);

    return NextResponse.json({
      success: result.failed.length === 0,
      deleted: result.deleted,
      failed: result.failed,
      relationsDeleted: result.relationsDeleted,
    });
  } catch (error) {
    log.error('Bulk company delete failed', error instanceof Error ? error : undefined);

    return NextResponse.json({ error: 'Failed to delete companies' }, { status: 500 });
  }
}
