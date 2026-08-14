/**
 * @file app/api/reports/bulk-delete/route.ts
 * @description API route for bulk deleting reports
 *
 * Endpoint:
 * - POST /api/reports/bulk-delete - Delete multiple reports at once (authenticated)
 *
 * @author Radarist Team
 * @created 2026-02-26
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { deleteReports, reportsBelongToOwner } from '@/lib/reports';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/reports/bulk-delete');

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one ID is required').max(100),
});

/**
 * POST /api/reports/bulk-delete
 *
 * Delete multiple reports by their IDs.
 *
 * Request body:
 * - ids: string[] - Array of report IDs to delete (1-100 items)
 *
 * Returns:
 * - 200 with { success: true, deleted: number }
 * - 400 if input validation fails
 * - 401 if not authenticated
 * - 500 on server error
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();

    const validation = bulkDeleteSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json({ error: 'Invalid request', details: validation.error.errors }, { status: 400 });
    }

    const ids = Array.from(new Set(validation.data.ids));
    // Authorize the complete set before starting any recursive delete. Missing
    // and non-owned IDs intentionally share one response so callers cannot use
    // bulk deletion as an existence oracle.
    const allOwned = await reportsBelongToOwner(ids, auth.uid);
    if (!allOwned) {
      return NextResponse.json({ error: 'One or more reports not found' }, { status: 404 });
    }
    await deleteReports(ids);

    log.info('Reports bulk deleted via API', { count: ids.length });

    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (error) {
    log.error('Bulk report delete failed', error instanceof Error ? error : new Error(String(error)));

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: `Failed to delete reports: ${errorMessage}` }, { status: 500 });
  }
}
