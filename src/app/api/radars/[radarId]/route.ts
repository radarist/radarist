/**
 * @file route.ts (API > radars > [radarId])
 * @description Server-owned, authenticated radar deletion boundary (LOCAL-010).
 *
 * DELETE /api/radars/:radarId
 *
 * Why a route instead of the browser client SDK: the required graph-cleanup
 * handoff (`app/radar.graph-delete.requested`) must be dispatched from the
 * server process of the profile that owns this workspace. A browser bundle
 * cannot see the server-side Inngest routing env (`INNGEST_DEV` /
 * `INNGEST_BASE_URL`), so a browser-side send silently falls back to the SDK
 * default dev server (port 8288) — the DEFAULT profile's runtime — even when
 * the page was served by the selftest profile. Executing here binds the
 * handoff to the launching profile's environment.
 *
 * Failure contract (honest, retryable):
 *   - `adminDeleteRadar` orders relations → placements → graph handoff →
 *     radar doc, and throws before deleting the radar doc if the handoff was
 *     not accepted. The surviving doc is the retry anchor.
 *   - 502 + `retryable: true` reports that pre-commit truth; a retry of the
 *     idempotent cascade converges Firestore and Neo4j.
 *   - 404 means the radar doc is already gone (deletion converged earlier or
 *     the id never existed) — callers treat it as already-deleted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';

const log = createLogger('api/radars/delete');

const RadarIdSchema = z.string().trim().min(1, 'Radar id is required').max(200, 'Radar id is too long');

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ radarId: string }> }) {
  try {
    const auth = await getAuthenticatedUser(request);
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error }, { status: 401 });
    }

    const { radarId: rawRadarId } = await params;
    let decodedRadarId: string;
    try {
      decodedRadarId = decodeURIComponent(rawRadarId ?? '');
    } catch {
      // Malformed percent-encoding is a caller error, not a retryable server
      // failure — it would fail identically on every retry.
      return NextResponse.json({ error: 'Malformed radar id encoding' }, { status: 400 });
    }
    const parsed = RadarIdSchema.safeParse(decodedRadarId);
    if (!parsed.success) {
      return NextResponse.json({ error: 'A non-empty radar id is required' }, { status: 400 });
    }
    const radarId = parsed.data;

    const { adminDeleteRadar, RadarAuthorizationError } = await import('@/lib/radars-admin');

    log.info('Deleting radar', { radarId, uid: auth.uid });
    try {
      // GRAPH-060 #2 — owner-only: only the radar's creator may delete it. The
      // primitive enforces ownership before any delete. We deliberately do NOT
      // pre-read the radar to 404 on absence: a foreign, ownerless, missing, or
      // merely-shared radar must all return the SAME 403 denial so a non-owner
      // cannot use the status code as an existence oracle. An owner deleting an
      // already-converged radar likewise cannot prove ownership of a doc that no
      // longer carries their `createdBy`, so it too denies — honestly.
      const { placementsDeleted } = await adminDeleteRadar(radarId, auth.uid, { cascade: true });
      return NextResponse.json({ ok: true, radarId, placementsDeleted });
    } catch (authzError) {
      if (authzError instanceof RadarAuthorizationError) {
        return NextResponse.json(
          { error: 'You do not have permission to delete this radar', code: 'forbidden' },
          { status: 403 }
        );
      }
      throw authzError;
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('Radar deletion failed', err);

    // The radar doc survives a pre-handoff failure (retry anchor); a retry of
    // the idempotent cascade converges both stores. Report that truthfully —
    // never a fabricated success.
    return NextResponse.json({ error: err.message.slice(0, 500), retryable: true }, { status: 502 });
  }
}
