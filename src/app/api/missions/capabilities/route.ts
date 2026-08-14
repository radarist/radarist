/**
 * @file app/api/missions/capabilities/route.ts
 * @description Read-only capability probe for the missions surface — lets the
 * UI show the truth BEFORE dispatch (BUILD-027) instead of letting the user
 * fill in a brief and only discover on submit that builds are off.
 *
 * GET /api/missions/capabilities → { buildEnabled: boolean }
 *
 * `buildEnabled` mirrors exactly what `POST /api/missions` enforces for
 * `kind: 'build'` — both resolve `IMPULSE_BUILD_ENABLED` through
 * `isBuildEnabled()`, so the button state and the server gate never drift.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { isBuildEnabled } from '@/lib/build-capability';

export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }
  return NextResponse.json({ buildEnabled: isBuildEnabled() });
}
