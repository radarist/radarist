import type { Firestore } from 'firebase-admin/firestore';
import { PLACEMENT_PARENT_DELETION_LEASE_COLLECTION } from '@/lib/radar-placement-deletion-lease';
import { RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION } from '@/lib/radar-placement-delete-outbox';
import {
  buildRadarPlacementPairLockEntry,
  RADAR_PLACEMENT_PAIR_LOCK_COLLECTION,
} from '@/lib/radar-placement-pair-key';

export const RADAR_PLACEMENT_COLLECTION = 'radarPlacements';
const FIRESTORE_BATCH_WRITE_LIMIT = 500;

/**
 * All server-owned RadarPlacement state that a disposable demo reset must clear.
 * Browser writes are denied by firestore.rules, and the supporting collections
 * are not client-readable; this module intentionally accepts only Admin Firestore.
 */
export const SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS = [
  RADAR_PLACEMENT_COLLECTION,
  RADAR_PLACEMENT_PAIR_LOCK_COLLECTION,
  RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION,
  PLACEMENT_PARENT_DELETION_LEASE_COLLECTION,
] as const;

export interface SeedRadarPlacement {
  id: string;
  radarId: string;
  technologyId: string;
}

/** Clears one server-owned collection through the Admin SDK. */
export async function clearServerOwnedRadarPlacementCollection(
  db: Firestore,
  collectionName: (typeof SERVER_OWNED_RADAR_PLACEMENT_COLLECTIONS)[number]
): Promise<number> {
  const snapshot = await db.collection(collectionName).get();
  if (snapshot.empty) return 0;

  for (let offset = 0; offset < snapshot.docs.length; offset += FIRESTORE_BATCH_WRITE_LIMIT) {
    const batch = db.batch();
    for (const document of snapshot.docs.slice(offset, offset + FIRESTORE_BATCH_WRITE_LIMIT)) {
      batch.delete(document.ref);
    }
    await batch.commit();
  }
  return snapshot.size;
}

/**
 * Writes deterministic placement fixtures and their pair locks atomically
 * through the Admin SDK. The caller validates the complete placement payload.
 */
export async function seedRadarPlacementsWithAdmin<T extends SeedRadarPlacement>(
  db: Firestore,
  placements: readonly T[],
  recordedAt = Date.now()
): Promise<void> {
  const batch = db.batch();
  for (const placement of placements) {
    batch.set(db.collection(RADAR_PLACEMENT_COLLECTION).doc(placement.id), { ...placement });
    const lock = buildRadarPlacementPairLockEntry(
      placement.id,
      placement.radarId,
      placement.technologyId,
      recordedAt
    );
    batch.set(db.collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).doc(lock.id), lock.data);
  }
  await batch.commit();
}
