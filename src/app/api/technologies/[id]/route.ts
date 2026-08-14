/**
 * @file api/technologies/[id]/route.ts
 * @description API endpoint to fetch a single technology by ID
 *
 * Used by the ResearchTab to poll for research status updates.
 *
 * @author Radarist Team
 * @created 2026-01-12
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/technologies/[id]');
import { adminGetTechnologyById } from '@/lib/technology-admin';

// ============================================================================
// HANDLER
// ============================================================================

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Authenticate user
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: 'Technology ID is required' }, { status: 400 });
    }

    const technology = await adminGetTechnologyById(id);

    if (!technology) {
      return NextResponse.json({ error: `Technology ${id} not found` }, { status: 404 });
    }

    return NextResponse.json(technology);
  } catch (error) {
    log.error('Failed to fetch technology', error instanceof Error ? error : undefined);
    return NextResponse.json({ error: 'Failed to fetch technology' }, { status: 500 });
  }
}
