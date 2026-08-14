/**
 * @file app/api/user/preferences/route.ts
 * @description AI-005 — expose the stored mission/report preferences.
 *
 * Endpoints (all operate on the AUTHENTICATED user only — a client-supplied
 * uid is never accepted):
 * - GET    /api/user/preferences — the harvested `userPreferences/{uid}` doc
 *   (mission/report-shaped, written nightly by the preference harvester) plus,
 *   best-effort, the Neo4j :UserPreference topic weights the discovery
 *   cold-start reads. Graph unavailability degrades gracefully to null.
 * - PATCH  /api/user/preferences — set/clear explicit pins on the three
 *   pinnable fields (preferredStructure, preferredCitationStyle,
 *   requestsConfidenceScores). Value sets, null clears, absent leaves as-is.
 * - DELETE /api/user/preferences — reset: delete the Firestore doc (the
 *   nightly harvest recreates it from mission history).
 *
 * These preferences are consumed by MISSION dispatch only
 * (run-agent-mission.ts → buildUserPreferencesPreamble). The chat assistant
 * deliberately does not read them because mission preferences do not belong
 * in conversational turns.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { preferredCitationStyleSchema, preferredStructureSchema } from '@/lib/schemas/user-preferences';

const log = createLogger('api/user/preferences');

/**
 * PATCH body — pin updates only. `.strict()` everywhere so a client-supplied
 * `userId` (or any other field) is rejected instead of silently ignored at the
 * top level; the uid always comes from the verified token.
 */
const patchBodySchema = z
  .object({
    pinned: z
      .object({
        preferredStructure: preferredStructureSchema.nullable().optional(),
        preferredCitationStyle: preferredCitationStyleSchema.nullable().optional(),
        requestsConfidenceScores: z.boolean().nullable().optional(),
      })
      .strict(),
  })
  .strict();

/** Best-effort Neo4j topic weights — null when the graph is unavailable. */
async function getTopicWeightsBestEffort(
  userId: string
): Promise<Array<{ topic: string; actedCount: number; dismissedCount: number }> | null> {
  try {
    const { getUserPreferences } = await import('@/lib/graph/preferences');
    const rows = await getUserPreferences(userId);
    return rows.map((r) => ({ topic: r.topic, actedCount: r.actedCount, dismissedCount: r.dismissedCount }));
  } catch (error) {
    log.warn('Topic weights unavailable (degrading gracefully)', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * GET /api/user/preferences — the authenticated user's stored preferences.
 * `preferences` is null when no harvest has run yet; `topicWeights` is null
 * when Neo4j is unavailable (best-effort).
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { getMissionUserPreferences } = await import('@/lib/user-preferences');
    // Adversarial #1: a schema-invalid stored doc must DEGRADE, not 500 —
    // a 500 hid the Reset affordance, leaving the user unable to self-heal.
    const [preferencesResult, topicWeights] = await Promise.all([
      getMissionUserPreferences(auth.uid).then(
        (preferences) => ({ preferences, invalid: false }),
        (err) => {
          // Only SCHEMA corruption degrades to the invalid/Reset state —
          // a transport failure must stay a 500, not masquerade as a
          // corrupted profile.
          if (err instanceof Error && err.name === 'ZodError') {
            log.warn('Stored preferences failed validation — degrading to invalid state', {
              userId: auth.uid,
              error: err.message,
            });
            return { preferences: null, invalid: true };
          }
          throw err;
        }
      ),
      getTopicWeightsBestEffort(auth.uid),
    ]);
    return NextResponse.json({ ...preferencesResult, topicWeights });
  } catch (error) {
    log.error('Failed to read user preferences', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
    });
    return NextResponse.json({ error: 'Failed to read preferences' }, { status: 500 });
  }
}

/**
 * PATCH /api/user/preferences — set/clear pins on the pinnable fields.
 * Returns the updated preferences document.
 */
export async function PATCH(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = patchBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request format', details: parsed.error.issues }, { status: 400 });
  }

  try {
    const { setPinnedPreferences } = await import('@/lib/user-preferences');
    const preferences = await setPinnedPreferences(auth.uid, parsed.data.pinned);
    return NextResponse.json({ preferences });
  } catch (error) {
    log.error('Failed to update pinned preferences', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
    });
    return NextResponse.json({ error: 'Failed to update preferences' }, { status: 500 });
  }
}

/**
 * DELETE /api/user/preferences — reset the stored preferences (doc delete;
 * the nightly harvest recreates the learned fields from mission history).
 */
export async function DELETE(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { resetUserPreferences } = await import('@/lib/user-preferences');
    await resetUserPreferences(auth.uid);
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error('Failed to reset user preferences', error instanceof Error ? error : new Error(String(error)), {
      userId: auth.uid,
    });
    return NextResponse.json({ error: 'Failed to reset preferences' }, { status: 500 });
  }
}
