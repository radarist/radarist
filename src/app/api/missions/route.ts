/**
 * @file app/api/missions/route.ts
 * @description API routes for managing missions
 *
 * Endpoints:
 * - POST /api/missions - Create a new mission (authenticated)
 * - GET /api/missions - List missions for the authenticated user
 *
 * Both endpoints require Firebase Auth token in the Authorization header.
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { BUILD_DISABLED_MESSAGE, isBuildEnabled } from '@/lib/build-capability';
import { createMission, listMissions, updateMission } from '@/lib/missions';
import { dispatchMissionWithGate } from '@/lib/mission-research-gate';
import { createMissionSchema } from '@/lib/schemas/mission';
import { buildContextRefsSchema } from '@/lib/schemas/mission-build';
import type { BuildContextManifest, BuildContextRefInput } from '@/lib/build-mission-context';
import { inngest } from '@/lib/inngest/client';
import { createLogger } from '@/lib/logger';
import { classifyMissionIntent } from '@/lib/ai/mission-intent-classifier';
import { preflightMissionMcp, mcpPreflightRemediation } from '@/lib/mission-mcp-preflight';

const log = createLogger('api/missions');

/**
 * POST /api/missions
 *
 * Create a new mission and fire an Inngest event to start execution.
 *
 * Request body:
 * ```json
 * {
 *   "prompt": "Find emerging AI startups in healthcare",
 *   "agent": "scout"
 * }
 * ```
 *
 * Returns: 201 with the created Mission object
 */
export async function POST(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const body = await request.json();
    const validation = createMissionSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json({ error: validation.error.flatten() }, { status: 400 });
    }

    // Build missions bypass the research classifier/gate entirely — the
    // methodology pack inside the sandbox does its own planning. Gated by
    // IMPULSE_BUILD_ENABLED through the shared build-capability contract.
    if (validation.data.kind === 'build') {
      // Same source of truth the UI reads via GET /api/missions/capabilities,
      // so the disabled button and this enforced gate can never disagree.
      if (!isBuildEnabled()) {
        return NextResponse.json({ error: BUILD_DISABLED_MESSAGE }, { status: 403 });
      }
      // Resolve every caller-controlled reference before creating a mission.
      // A malformed input, foreign private object, or failed authoritative
      // read must leave zero pending missions and zero dispatches.
      let contextManifest: BuildContextManifest | undefined;
      if (body.context !== undefined && (validation.data.artifactKind ?? 'solution') === 'solution') {
        const parsedContext = buildContextRefsSchema.safeParse(body.context);
        if (!parsedContext.success) {
          return NextResponse.json({ error: parsedContext.error.flatten() }, { status: 400 });
        }
        if (parsedContext.data.length > 0) {
          const { hasUnauthorizedBuildContextRefs, resolveBuildContextForUser } =
            await import('@/lib/build-mission-context');
          contextManifest = await resolveBuildContextForUser(auth.uid, parsedContext.data as BuildContextRefInput[]);
          if (hasUnauthorizedBuildContextRefs(contextManifest)) {
            // Keep absent and foreign ids indistinguishable at this boundary.
            return NextResponse.json({ error: 'Context reference not found' }, { status: 404 });
          }
        }
      }
      // E1 — Technology Evaluation: the brief is composed FROM THE GRAPH
      // (the technology's real repo + linked use cases), not free text.
      let input = validation.data;
      if (validation.data.artifactKind === 'evaluation' && validation.data.motivation?.sourceTechnologyId) {
        const { composeEvaluationBrief } = await import('@/lib/build-mission-eval-brief');
        const composed = await composeEvaluationBrief(validation.data.motivation.sourceTechnologyId, {
          useCaseIds: validation.data.motivation.useCaseIds,
        });
        input = { ...validation.data, prompt: composed.brief, motivation: composed.motivation };
      }

      const mission = await createMission(auth.uid, input, { slots: [] });

      // Post-create mission updates: displayed budget + the already-validated
      // BUILD-036 context. No untrusted reads occur after this write.
      const missionUpdates: Parameters<typeof updateMission>[1] = {};
      if (validation.data.budgetUsd) {
        missionUpdates.budget = { capUsd: validation.data.budgetUsd, warnThreshold: 0.8, topUps: [] };
      }
      if (contextManifest) missionUpdates.contextManifest = contextManifest;
      if (Object.keys(missionUpdates).length > 0) {
        await updateMission(mission.id, missionUpdates);
      }

      await inngest.send({
        name: 'app/build-mission.run.requested',
        data: { missionId: mission.id, userId: auth.uid },
      });
      log.info('Build mission created and dispatched', {
        missionId: mission.id,
        userId: auth.uid,
        artifactKind: validation.data.artifactKind ?? 'solution',
      });
      return NextResponse.json({ ...mission, missions: [mission] }, { status: 201 });
    }

    // OPS-004: refuse before the paid intent classifier (a Gemini call) when
    // the internal platform MCP surface is unreachable at the active base URL.
    // A dispatched mission would otherwise burn its whole budget searching for
    // Report/entity/graph tools that never answer. Bounded, provider-free.
    const preflight = await preflightMissionMcp();
    if (!preflight.ok) {
      // The base URL + unreachable server list are logged server-side only —
      // never returned to the client (they leak deployment topology). The
      // response carries a stable code + URL-free remediation.
      log.error('Mission dispatch refused — MCP preflight failed', undefined, {
        userId: auth.uid,
        reason: preflight.reason,
        baseUrl: preflight.baseUrl,
        unreachable: preflight.unreachable,
      });
      return NextResponse.json(
        {
          error: preflight.reason,
          reason: preflight.reason,
          remediation: mcpPreflightRemediation(preflight.reason),
        },
        { status: 503 }
      );
    }

    // ARUN-022 — the intent classifier is a PAID Gemini call that bills before the
    // mission it belongs to exists, so its usage is captured here and correlated to
    // the mission id once dispatch returns one. Its cost is already folded into the
    // mission headline via `classifierMetadata.costUsd`, so the receipt batch is
    // `included-in-parent`. Capture-then-correlate; a classifier that throws never
    // creates a mission, so there is no correlation to record it under.
    const { withCapturedUsage } = await import('@/lib/operation-receipt-instrument');
    const { result: intent, captured: classifierUsage } = await withCapturedUsage(() =>
      classifyMissionIntent({
        prompt: validation.data.prompt,
        agent: validation.data.agent,
      })
    );
    log.info('classifier result', {
      userId: auth.uid,
      slotCount: intent.slots.length,
      fallback: intent.metadata.fallback,
    });

    const result = await dispatchMissionWithGate(
      auth.uid,
      validation.data,
      { slots: intent.slots, classifierMetadata: intent.metadata },
      // OPS-004: the route already ran the preflight above (before the paid
      // classifier), so the gate must NOT re-probe — a second failure here would
      // become an unreceipted generic 500 after classifier spend.
      { preflightVerified: true }
    );
    const firstMission = result.dispatched[0];

    // The classifier ran ONCE for the whole dispatch, so its spend is correlated to
    // the first (head) mission of the chain — never duplicated across the chain.
    const { flushMissionStageUsage } = await import('@/lib/mission-stage-usage');
    await flushMissionStageUsage(
      { missionId: firstMission.id, owner: `user:${auth.uid}`, stage: 'classifier' },
      classifierUsage
    );

    await inngest.send({
      name: 'app/mission.run.requested',
      data: {
        missionId: firstMission.id,
        userId: auth.uid,
        prompt: firstMission.prompt,
        agent: firstMission.agent,
      },
    });

    log.info('Mission(s) created and dispatched', {
      missionId: firstMission.id,
      userId: auth.uid,
      agent: firstMission.agent,
      gated: result.gated,
      chainId: result.chainId,
      chainLength: result.dispatched.length,
    });

    // Backwards-compat: clients that expect a single mission object see the
    // first mission. New clients can read `missions[]` for the full chain.
    return NextResponse.json(
      { ...firstMission, missions: result.dispatched, chainId: result.chainId, gated: result.gated },
      { status: 201 }
    );
  } catch (error) {
    log.error('Failed to create mission', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to create mission' }, { status: 500 });
  }
}

/**
 * GET /api/missions
 *
 * List missions for the authenticated user, ordered by creation date (newest first).
 *
 * Returns: 200 with `{ missions: [...] }`
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const missions = await listMissions(auth.uid);
    return NextResponse.json({ missions });
  } catch (error) {
    log.error('Failed to list missions', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to list missions' }, { status: 500 });
  }
}
