/**
 * @file route.ts (API > signals > archive)
 * @description API endpoint for archiving / restoring signals.
 *
 * POST /api/signals/archive — move one or more signals to (or out of) the
 * `Archived` status. A single body handles both directions via `action`:
 *   - `archive`  → adminArchiveSignals (stamps archivedAt/previousStatus)
 *   - `restore`  → adminRestoreSignals (returns to previousStatus)
 *
 * Mirrors the auth + admin-SDK shape of the sibling bulk-delete route so the
 * triage page reaches the archival lifecycle through the same server path as
 * delete/approve/reject instead of the deprecated client-SDK signals-approval.
 *
 * @author Radarist Team
 * @created 2026-07-12
 */

import { NextRequest, NextResponse } from 'next/server';
import { adminArchiveSignals, adminRestoreSignals } from '@/lib/signals-admin';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/signals/archive');

const ArchiveRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one signal ID is required'),
  action: z.enum(['archive', 'restore']),
  reason: z.string().max(500).optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const body = await request.json();

    const validationResult = ArchiveRequestSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json({ error: 'Invalid request', details: validationResult.error.errors }, { status: 400 });
    }

    const { ids, action, reason } = validationResult.data;

    if (action === 'archive') {
      const result = await adminArchiveSignals(ids, reason);
      return NextResponse.json({ success: true, changed: result.archived, failed: result.failed });
    }

    const result = await adminRestoreSignals(ids);
    return NextResponse.json({ success: true, changed: result.restored, failed: result.failed });
  } catch (error) {
    log.error('Signal archive/restore failed', error instanceof Error ? error : undefined);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
