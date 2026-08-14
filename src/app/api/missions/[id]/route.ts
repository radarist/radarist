/**
 * @file app/api/missions/[id]/route.ts
 * @description API route for retrieving a single mission by ID
 *
 * Endpoints:
 * - GET /api/missions/[id] - Get a mission by ID (authenticated, owner-only)
 *
 * Requires Firebase Auth token in the Authorization header.
 * The authenticated user must be the mission owner (userId match).
 *
 * @author Radarist Team
 * @created 2026-02-23
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { getMissionById, deleteMission } from '@/lib/missions';
import { importSandbox } from '@/lib/agent-import';
import { isSystemPrincipal } from '@/lib/system-principals';
import { deleteBuildArtifactCascade } from '@/lib/build-artifact-deletion';
import { createLogger } from '@/lib/logger';
import { acquireBuildRuntimeOperation } from '@/lib/build-runtime-operation-lock';

const log = createLogger('api/missions/[id]');

/**
 * GET /api/missions/[id]
 *
 * Retrieve a single mission by its ID. The authenticated user must be the
 * mission owner (userId field must match auth.uid) — except system-principal
 * missions (sweep/discovery), which the signed-in user may read AND operate
 * on in local single-user mode (ARUN-005; visible rows must never carry
 * dead 403 actions). Missions of another human user stay forbidden
 * everywhere.
 *
 * Returns:
 * - 200 with the Mission object
 * - 401 if not authenticated
 * - 403 if the mission belongs to a different (human) user
 * - 404 if the mission does not exist
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const { id } = await params;

    const mission = await getMissionById(id);

    if (!mission) {
      return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    }

    if (mission.userId !== auth.uid && !isSystemPrincipal(mission.userId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json(mission);
  } catch (error) {
    log.error('Failed to get mission', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to get mission' }, { status: 500 });
  }
}

/**
 * DELETE /api/missions/[id]
 *
 * Delete a build-mission artifact and cascade: destroy the sandbox (container +
 * volume), delete the produced output entity (Prototype or verdict Document +
 * its proposed Assessment), then the mission record. Owner-only, build-kind only.
 * Prototype deletion is fail-loud because the mission is its retry anchor.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const { id } = await params;
  const releaseOperation = acquireBuildRuntimeOperation(id);
  if (!releaseOperation) {
    return NextResponse.json(
      {
        error: 'A runtime operation is already in progress for this artifact.',
        code: 'sandbox-operation-in-progress',
      },
      { status: 409 }
    );
  }
  try {
    const mission = await getMissionById(id);
    if (!mission) return NextResponse.json({ error: 'Mission not found' }, { status: 404 });
    // ARUN-005: system-owned artifacts are deletable by the local user —
    // otherwise bulk delete on /artifacts silently leaves them behind.
    if (mission.userId !== auth.uid && !isSystemPrincipal(mission.userId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (mission.kind !== 'build') {
      return NextResponse.json({ error: 'Delete only applies to build artifacts' }, { status: 400 });
    }

    // BUILD-025: fail-closed cascade. Every prerequisite (sandbox, Document,
    // Prototype cascade, Assessment) is attempted with a per-resource outcome;
    // the mission (retry anchor) is deleted ONLY if all succeed. Primitives are
    // idempotent so a retry after a partial failure converges.
    const result = await deleteBuildArtifactCascade(mission, {
      destroySandbox: async (m) => {
        const s = m.sandbox as {
          driver: string;
          containerName?: string;
          volumeName?: string;
          image?: string;
          hostPort?: number;
          workspacePath?: string;
        };
        const sandbox = await importSandbox();
        const cfg = sandbox.loadBuildConfig({ yamlPath: 'impulse.config.yaml' });
        await sandbox.getDriver(cfg.driver).destroy(
          {
            driver: s.driver,
            missionId: id,
            containerName: s.containerName,
            volumeName: s.volumeName,
            image: s.image,
            hostPort: s.hostPort ?? 0,
            workspacePath: s.workspacePath,
          },
          { removeVolume: true }
        );
      },
      deleteDocument: async (documentId) => {
        const { adminDeleteDocument } = await import('@/lib/document-admin');
        await adminDeleteDocument(documentId, { kind: 'system', expectedOwnerUid: mission.userId });
      },
      // adminDeletePrototype IS the complete cascade (graph handoff + document
      // links + relations + notes + doc), not a raw doc delete.
      deletePrototype: async (prototypeId) => {
        const { adminDeletePrototype } = await import('@/lib/prototypes-admin');
        await adminDeletePrototype(prototypeId);
      },
      deleteAssessment: async (assessmentId) => {
        const { db } = await import('@/lib/firebase-admin');
        await db.collection('proposedAssessments').doc(assessmentId).delete();
      },
      deleteMission: (missionId) => deleteMission(missionId),
    });

    if (!result.deleted) {
      // Honest partial-cleanup report; the mission is retained for retry. 409 so
      // the client treats the row as still-present and keeps it selected.
      log.warn('Build artifact deletion incomplete', { missionId: id, failedResources: result.failedResources });
      return NextResponse.json(
        {
          ok: false,
          error: `Partial cleanup: ${result.failedResources.join(', ')} could not be deleted; the artifact was retained so you can retry.`,
          outcomes: result.outcomes,
          failedResources: result.failedResources,
          retryable: true,
        },
        { status: 409 }
      );
    }

    log.info('Build artifact deleted', { missionId: id, userId: auth.uid });
    return NextResponse.json({ ok: true, outcomes: result.outcomes });
  } catch (error) {
    log.error('Failed to delete artifact', error instanceof Error ? error : new Error(String(error)), {
      missionId: id,
    });
    return NextResponse.json({ error: 'Failed to delete the artifact' }, { status: 500 });
  } finally {
    releaseOperation();
  }
}
