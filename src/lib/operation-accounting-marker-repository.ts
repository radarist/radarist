/**
 * @file lib/operation-accounting-marker-repository.ts
 * @description ARUN-022 — server-only writer/reader for the durable parent
 * accounting marker (see `@/lib/schemas/operation-accounting-marker`).
 *
 * A marker is a CURRENT-STATE snapshot of one parent operation's capture-and-flush
 * outcome, keyed by `(owner, parentType, correlationId)`. A re-flush of the same
 * parent UPSERTS the same slot with the latest counts (Inngest replays produce the
 * same deterministic counts → idempotent). `accountingState` is DERIVED here from
 * the counts, never trusted from a caller — the same fail-closed discipline as
 * receipt cost. Reads are owner-scoped.
 *
 * @author Radarist Team
 * @created 2026-07-23
 */

import 'server-only';
import { db } from '@/lib/firebase-admin';
import { sanitizeForFirestore } from '@/lib/firestore-sanitize';
import { createLogger } from '@/lib/logger';
import {
  createParentAccountingMarkerSchema,
  deriveAccountingState,
  deriveParentAccountingMarkerId,
  parseParentAccountingMarkerDoc,
  resolveParentAccountingState,
  type CreateParentAccountingMarkerInput,
  type ParentAccountingMarker,
  type ParentAccountingState,
} from '@/lib/schemas/operation-accounting-marker';
import type { OperationParentType } from '@/lib/schemas/operation-receipt';

const log = createLogger('operation-accounting-marker-repository');

const COLLECTION = 'operationAccountingMarkers';

/**
 * Upsert the durable accounting marker for one parent correlation. `accountingState`
 * is DERIVED from the counts here (never a trusted input). The marker is a
 * current-state snapshot, so this overwrites the deterministic slot.
 *
 * @throws {z.ZodError} on invalid input (incl. the count-partition invariant).
 * @returns the stored marker.
 */
export async function upsertParentAccountingMarker(
  input: CreateParentAccountingMarkerInput
): Promise<ParentAccountingMarker> {
  const validated = createParentAccountingMarkerSchema.parse(input);
  const accountingState = deriveAccountingState(validated);
  const id = deriveParentAccountingMarkerId(validated);
  const marker: ParentAccountingMarker = {
    ...validated,
    accountingState,
    id,
    recordedAt: new Date().toISOString(),
  };
  try {
    await db.collection(COLLECTION).doc(id).set(sanitizeForFirestore(marker));
    return marker;
  } catch (error) {
    log.error('Failed to upsert parent accounting marker', error, { markerId: id, parentType: validated.parentType });
    throw error;
  }
}

/**
 * Read one BATCH marker for a parent correlation, scoped to `owner`. Returns null
 * when absent or owned by someone else (fail closed).
 */
export async function getParentAccountingMarker(
  owner: string,
  parentType: OperationParentType,
  correlationId: string,
  batchId: string
): Promise<ParentAccountingMarker | null> {
  const id = deriveParentAccountingMarkerId({ owner, parentType, correlationId, batchId });
  try {
    const snap = await db.collection(COLLECTION).doc(id).get();
    if (!snap.exists) return null;
    const marker = parseParentAccountingMarkerDoc(id, snap.data());
    if (marker.owner !== owner) return null;
    return marker;
  } catch (error) {
    log.error('Failed to read parent accounting marker', error, { markerId: id });
    throw error;
  }
}

/**
 * Roll up EVERY batch marker for one parent correlation into its whole-of-parent
 * accounting state, scoped to `owner`. Terminal truth: `complete` only when every
 * batch is complete — an earlier unresolved loss is never masked by a later
 * successful batch. Returns null when the parent has no markers. Every returned
 * document is verified; a verification failure fails closed (throws) rather than
 * silently under-counting a loss.
 */
export async function getParentAccountingState(
  owner: string,
  parentType: OperationParentType,
  correlationId: string
): Promise<ParentAccountingState | null> {
  try {
    const snap = await db
      .collection(COLLECTION)
      .where('owner', '==', owner)
      .where('parentType', '==', parentType)
      .where('correlationId', '==', correlationId)
      .get();
    const markers: ParentAccountingMarker[] = [];
    for (const doc of snap.docs) {
      const marker = parseParentAccountingMarkerDoc(doc.id, doc.data());
      // Defense in depth: the query already scopes to this owner + parentType.
      if (marker.owner === owner && marker.parentType === parentType) markers.push(marker);
    }
    return resolveParentAccountingState(markers);
  } catch (error) {
    log.error('Failed to roll up parent accounting state', error, { owner, parentType, correlationId });
    throw error;
  }
}
