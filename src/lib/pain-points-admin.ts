/**
 * @file pain-points-admin.ts
 * @description Admin-SDK twin of the pain-points service for SERVER-side callers.
 *
 * Why this exists: `src/lib/pain-points.ts` is a client-SDK service module
 * (it uses `firebase/firestore` + `@/lib/firebase`). Components and client-side
 * hooks call into it from the browser, where a persistent connection is fine.
 * The `/api/ai/chat` route and the AI-tool executors (`new-entities-tools.ts`,
 * `entity-creation.ts`), however, execute
 * on the server inside stateless serverless functions — the client SDK can't
 * hold a connection there and reads return `code: 'unavailable'` or
 * `FIRESTORE INTERNAL ASSERTION FAILED a540`.
 *
 * This file exposes the operations the AI assistant + auto-linker actually need
 * from the server, mirroring the client functions EXACTLY:
 *
 *   - adminCreatePainPoint  — for the `createPainPoint` tool
 *   - adminGetPainPoints    — for `searchPainPoints`, `listPainPointsByOrgUnit`,
 *                             `entity-creation` name-search, and the auto-linker
 *   - adminGetPainPointById — for the `getPainPointDetails` tool
 *   - adminUpdatePainPoint  — for the `updatePainPoint` tool
 *   - adminDeletePainPoint  — for the `deletePainPoint` tool
 *
 * Creates delegate to adminCreateEntity('painPoint', …) so the slug / id /
 * audit fields / uniqueness / DuplicateEntityError contract can NEVER drift
 * from the client path. DuplicateEntityError is re-thrown unchanged for callers
 * that branch on `instanceof`. Required deletes use the server-only,
 * acknowledged graph handoff before source deletion.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { adminDeleteLinksForEntity } from '@/lib/entity-document-link-admin';
import { adminDeleteAllEntityNotes } from '@/lib/entity-notes-cleanup-admin';
import { adminCreateEntity } from '@/lib/entity-factory-admin';
import { DuplicateEntityError } from '@/lib/entity-factory-shared';
import {
  requestEntityGraphDeletionServer as requestEntityGraphDeletion,
  triggerEntityGraphSyncBestEffortServer,
} from '@/lib/entity-sync-server';
import { createLogger } from '@/lib/logger';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import {
  adminApplyEntityReferenceCleanup,
  adminPlanEntityReferenceCleanup,
} from '@/lib/entity-reference-cleanup-admin';
import type { PainPoint, CreatePainPointInput } from '@/lib/types';
import { normalizePainPointForRead } from '@/lib/pain-points-shared';

const log = createLogger('pain-points-admin');

/**
 * Admin-SDK equivalent of `pain-points.getPainPoints`. Fetches all pain points
 * from the `painPoints` collection. Same return shape (`PainPoint[]`).
 */
export async function adminGetPainPoints(): Promise<PainPoint[]> {
  const snap = await db.collection('painPoints').get();
  return snap.docs.map((doc) => normalizePainPointForRead(doc.data()));
}

/**
 * Admin-SDK equivalent of `pain-points.getPainPointById`. Returns the
 * `PainPoint` or `null` if not found.
 */
export async function adminGetPainPointById(id: string): Promise<PainPoint | null> {
  const snap = await db.collection('painPoints').doc(id).get();
  if (snap.exists) {
    return normalizePainPointForRead(snap.data());
  }
  return null;
}

/**
 * Admin-SDK equivalent of `pain-points.createPainPoint`. Mirrors the client
 * function's field assembly (undefined-stripping for optional fields),
 * delegates to adminCreateEntity('painPoint', …) for slug/id/audit/uniqueness,
 * fires the same graph-sync event through `adminCreateEntity`, and
 * re-throws DuplicateEntityError unchanged. Other failures are wrapped in the
 * same `Failed to create pain point: …` Error the client throws.
 */
export async function adminCreatePainPoint(painPoint: CreatePainPointInput): Promise<PainPoint> {
  try {
    const now = Date.now();

    // Build data to create, filtering out undefined values (mirrors client).
    const dataToCreate: Record<string, unknown> = {
      title: painPoint.title,
      description: painPoint.description || '',
      severity: painPoint.severity,
      category: painPoint.category,
      affectedOrgUnitIds: painPoint.affectedOrgUnitIds || [],
      status: painPoint.status,
      linkedPrototypeIds: painPoint.linkedPrototypeIds || [],
      linkedTechnologyIds: painPoint.linkedTechnologyIds || [],
      linkedInitiativeIds: painPoint.linkedInitiativeIds || [],
      tags: painPoint.tags || [],
      identifiedAt: painPoint.identifiedAt || now,
    };

    // Only add optional fields if they have values.
    if (painPoint.estimatedImpact !== undefined) {
      dataToCreate.estimatedImpact = painPoint.estimatedImpact;
    }
    if (painPoint.actualImpact !== undefined) {
      dataToCreate.actualImpact = painPoint.actualImpact;
    }
    if (painPoint.impactDescription) {
      dataToCreate.impactDescription = painPoint.impactDescription;
    }
    if (painPoint.rootCauses && painPoint.rootCauses.length > 0) {
      dataToCreate.rootCauses = painPoint.rootCauses;
    }
    if (painPoint.source) {
      dataToCreate.source = painPoint.source;
    }

    // Use entity-factory-admin for uniqueness-enforced creation.
    const result = await adminCreateEntity<typeof dataToCreate>(
      'painPoint',
      dataToCreate as typeof dataToCreate & { title: string }
    );

    const newPainPoint = result.entity as unknown as PainPoint;

    return newPainPoint;
  } catch (error) {
    // Re-throw DuplicateEntityError for proper handling by callers.
    if (error instanceof DuplicateEntityError) {
      log.warn('Duplicate pain point', { message: error.message });
      throw error;
    }
    log.error('Error creating pain point', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create pain point: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK equivalent of `pain-points.updatePainPoint`. Strips undefined
 * values (Firestore rejects them), stamps `updatedAt`, and fires the same
 * durable best-effort graph-sync event.
 */
export async function adminUpdatePainPoint(
  id: string,
  updates: Partial<Omit<PainPoint, 'id' | 'createdAt'>>
): Promise<void> {
  // Filter out undefined values (Firebase doesn't accept undefined).
  const filteredUpdates: Record<string, unknown> = {
    updatedAt: Date.now(),
  };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      filteredUpdates[key] = value;
    }
  }

  await db.collection('painPoints').doc(id).update(filteredUpdates);

  await triggerEntityGraphSyncBestEffortServer('painPoint', id, 'update');
}

/**
 * Admin-SDK equivalent of `pain-points.deletePainPoint`. An acknowledged
 * graph-delete handoff precedes cascade relation cleanup and removal of the
 * pain-point document.
 */
export async function adminDeletePainPoint(id: string): Promise<void> {
  const referencePlan = await adminPlanEntityReferenceCleanup('painPoint', id);

  await requestEntityGraphDeletion('painPoint', id);
  await adminDeleteLinksForEntity('painPoint', id);
  await adminDeleteRelationsForEntity(id);
  await adminDeleteAllEntityNotes('painPoints', id);
  await adminApplyEntityReferenceCleanup(referencePlan);
  await db.collection('painPoints').doc(id).delete();
}
