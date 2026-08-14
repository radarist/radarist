/**
 * @file radar-placement-admin.ts
 * @description Admin-SDK twin of `radar-placement-service.ts` for SERVER-side
 * callers (the `/api/ai/chat` tool executors in `radar-management`,
 * `technology-decoupled`, and `entity-creation`, plus `/api/radar*` routes).
 *
 * WHY: `radar-placement-service.ts` is a CLIENT-SDK module (it uses
 * `firebase/firestore` + `@/lib/firebase`). When its writes/reads run server-side
 * inside a stateless serverless function they can hit `code: 'unavailable'`
 * (no persistent connection) or the `a540` in-process client assertion.
 * This file reproduces the exact create/read/update behavior via the
 * Admin SDK so those server callers are drop-in.
 *
 * SEMANTICS PRESERVED (must match `radar-placement-service.ts` exactly):
 *   - `adminCreateRadarPlacement` does NOT delegate to `adminCreateEntity`.
 *     The client `createRadarPlacement` uses its OWN id (`placement-<ts>-<rand>`)
 *     + `setDoc`, a technology-existence guard, and a duplicate-placement check
 *     that throws a PLAIN `Error` (not `DuplicateEntityError`). Routing through
 *     `adminCreateEntity` would generate a slug and throw `DuplicateEntityError`
 *     — a different id shape and error type than every caller expects. So the
 *     create logic is replicated here, wrapped in a reads-before-writes admin
 *     transaction (existence + duplicate reads, then the set).
 *   - `timeToImpact` defaults to `'unknown'`, undefined fields are stripped
 *     (Firestore rejects them), and the SAME `app/radar-placement.sync.requested`
 *     Inngest events fire post-write (best-effort).
 *   - `adminUpdateRadarPlacement` tracks ring movement (`movedFrom`/`movedAt`),
 *     strips undefined, re-reads the full doc, and fires the update sync event.
 *
 * NOTE: `triggerEntitySync('radarPlacement', …)` is intentionally NOT called
 * here. `entity-sync.ts` lists `radarPlacement` in `DEDICATED_SYNC_TYPES`, so
 * that call is a no-op for placements — the dedicated
 * `app/radar-placement.sync.requested` event below is the real graph-sync path.
 */

import 'server-only';

import { db } from '@/lib/firebase-admin';
import { createLogger } from '@/lib/logger';
import type { RadarPlacement, CreateRadarPlacementInput, RadarData, Ring } from '@/lib/types';
import type { RadarPlacementFilters } from '@/lib/radar-placement-service';
import { adminDeleteRelationsForEntity } from '@/lib/relations-cascade-admin';
import {
  RADAR_PLACEMENT_PAIR_LOCK_COLLECTION,
  buildRadarPlacementPairKey,
  buildRadarPlacementPairLockEntry,
  parseRadarPlacementPairLock,
} from '@/lib/radar-placement-pair-key';
import { resolveQuadrantConfigs } from '@/lib/radar-quadrants';
import { RING_SYSTEMS } from '@/lib/constants';
import { isRadarMutableBy } from '@/lib/radar-authorization';
import {
  PLACEMENT_PARENT_DELETION_LEASE_COLLECTION,
  buildPlacementParentDeletionLease,
  isPlacementParentDeletionLeaseActive,
  placementParentDeletionLeaseId,
  type PlacementParentKind,
} from '@/lib/radar-placement-deletion-lease';
import {
  RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION,
  buildRadarPlacementDeleteOutboxRecord,
  createRadarPlacementDeleteToken,
  radarPlacementDeleteSyncEventId,
} from '@/lib/radar-placement-delete-outbox';

/** Options threaded through the mutation primitives (GRAPH-060 #3 authorization). */
export interface PlacementMutationAuthzOptions {
  /** When set, the target radar must be mutable by this uid (ownership/legacy policy). */
  requireOwnerId?: string;
}

/**
 * Load + authorize the target radar inside a transaction. Returns the radar for
 * quadrant/ring validation. Throws PlacementValidationError when the radar is
 * missing and PlacementAuthorizationError when the caller may not mutate it.
 */
async function loadAuthorizedRadar(
  transaction: FirebaseFirestore.Transaction,
  radarId: string,
  requireOwnerId: string | undefined
): Promise<RadarData> {
  const radarSnap = await transaction.get(db.collection('radars').doc(radarId));
  if (!radarSnap.exists) {
    throw new PlacementValidationError(`Cannot modify placement: radar ${radarId} does not exist`);
  }
  const radar = { ...(radarSnap.data() as Omit<RadarData, 'id'>), id: radarSnap.id } as RadarData;
  if (requireOwnerId !== undefined && !isRadarMutableBy(radar, requireOwnerId)) {
    throw new PlacementAuthorizationError(radarId);
  }
  return radar;
}

const log = createLogger('radar-placement-admin');

// ============================================================================
// GRAPH-066 — pair-identity errors + validation
// ============================================================================

/** Thrown when a create payload's quadrant/ring is not valid on the target radar. */
export class PlacementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlacementValidationError';
  }
}

/** Thrown when a differing create payload lands on an already-occupied pair. */
export class PlacementPairConflictError extends Error {
  readonly existingPlacement: RadarPlacement;
  constructor(existingPlacement: RadarPlacement) {
    super(
      `Radar ${existingPlacement.radarId} already holds a different placement for technology ${existingPlacement.technologyId} (pair conflict)`
    );
    this.name = 'PlacementPairConflictError';
    this.existingPlacement = existingPlacement;
  }
}

/** Thrown when the caller is not authorized to mutate placements on the target radar. */
export class PlacementAuthorizationError extends Error {
  constructor(radarId: string) {
    super(`Not authorized to modify placements on radar ${radarId}`);
    this.name = 'PlacementAuthorizationError';
  }
}

/** Thrown when a create races a parent (radar/technology) that is being cascade-deleted. */
export class PlacementParentDeletingError extends Error {
  constructor(parentKind: string, parentId: string) {
    super(`Cannot create placement: its ${parentKind} ${parentId} is being deleted`);
    this.name = 'PlacementParentDeletingError';
  }
}

/** Thrown when a pair lock is malformed, mismatched, or points at a foreign placement — fail closed. */
export class MalformedPlacementLockError extends Error {
  constructor(pairKey: string) {
    super(`Pair lock ${pairKey} is malformed or mismatched; refusing to mutate (resolve the drift first)`);
    this.name = 'MalformedPlacementLockError';
  }
}

/** Thrown when >1 legacy placement exists for one pair — migration halts, never chooses silently. */
export class AmbiguousLegacyPlacementError extends Error {
  readonly placementIds: string[];
  constructor(radarId: string, technologyId: string, placementIds: string[]) {
    super(
      `Radar ${radarId} has multiple legacy placements for technology ${technologyId} (${placementIds.join(', ')}); migration halted`
    );
    this.name = 'AmbiguousLegacyPlacementError';
    this.placementIds = placementIds;
  }
}

/**
 * GRAPH-066 #3 — the ONLY caller-assignable fields on a placement update. Every
 * identity field (`id`, `technologyId`, `radarId`, `placedBy`), audit field
 * (`createdAt`, `updatedAt`), server-owned move telemetry (`movedFrom`,
 * `movedAt`), and the denormalized read-only `quadrantName` are excluded: they
 * are never caller-supplied. Moving a placement between radars/technologies is a
 * change of IDENTITY, not an ordinary update — it must go through a dedicated
 * transactional pair-lock migration, never this path (which would rewrite the
 * doc while its pair lock, keyed on the original identity, stays put → drift).
 */
export type AdminUpdateRadarPlacementInput = Partial<
  Omit<
    RadarPlacement,
    | 'id'
    | 'technologyId'
    | 'radarId'
    | 'placedBy'
    | 'createdAt'
    | 'updatedAt'
    | 'movedFrom'
    | 'movedAt'
    | 'quadrantName'
  >
>;

// Runtime backstop for the type above: TypeScript is erased, and internal callers
// (or a payload deserialized from JSON) can smuggle a forbidden key past the
// compiler. Enumerated explicitly so a new forbidden field is a deliberate edit.
const FORBIDDEN_PLACEMENT_UPDATE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'technologyId',
  'radarId',
  'placedBy',
  'createdAt',
  'updatedAt',
  'movedFrom',
  'movedAt',
  'quadrantName',
]);

/**
 * Fail closed BEFORE any read/transaction if an update carries a non-assignable
 * (identity/audit/server-owned) field. The server computes `movedFrom`/`movedAt`/
 * `updatedAt` itself; identity changes require the dedicated migration path.
 */
function assertMutablePlacementUpdate(updates: Record<string, unknown>): void {
  for (const key of Object.keys(updates)) {
    if (FORBIDDEN_PLACEMENT_UPDATE_KEYS.has(key)) {
      throw new PlacementValidationError(
        `Field "${key}" is not caller-assignable on a placement update (identity/audit fields are server-owned; ` +
          `moving a placement between radars/technologies requires a pair-lock migration, not an update)`
      );
    }
  }
}

/**
 * Validate a create payload's quadrant + ring against the EXACT target radar's
 * configuration. Quadrant is matched by stable id against the radar's
 * `QuadrantConfig[]`; ring is matched by name against the radar's `ringConfigs`
 * (or the standard/typed ring system it declares). Different radars keep their
 * own ring vocabularies — this never collapses them.
 */
export function assertPlacementQuadrantAndRing(radar: RadarData, quadrantId: string, ring: string): void {
  const quadrants = resolveQuadrantConfigs(radar);
  if (!quadrants.some((quadrant) => quadrant.id === quadrantId)) {
    throw new PlacementValidationError(`Quadrant ${quadrantId} is not configured on radar ${radar.id}`);
  }

  const validRings = radar.ringConfigs?.length
    ? radar.ringConfigs.map((config) => config.name)
    : [...(RING_SYSTEMS[radar.ringSystem ?? 'Standard'] ?? RING_SYSTEMS.Standard)];
  if (!validRings.includes(ring)) {
    throw new PlacementValidationError(`Ring ${ring} is not valid on radar ${radar.id}`);
  }
}

/** Two placements occupy the same position when their quadrant and ring match. */
/**
 * GRAPH-066 #5 — an exact retry must match the COMPLETE canonical create payload,
 * not just the quadrant + ring. The same pair with any changed field — quadrant,
 * ring, rationale, status, time-to-impact, TRL, technology snapshot, or x/y
 * position — is a CONFLICT that must go through update, not an idempotent retry.
 * `technologyId`/`radarId` are the pair identity (equal by definition here) and
 * `placedBy` is creator attribution, so neither participates in the equality.
 */
function isSameCanonicalPlacement(existing: RadarPlacement, incoming: CreateRadarPlacementInput): boolean {
  const scalarEqual =
    existing.quadrantId === incoming.quadrantId &&
    existing.ring === incoming.ring &&
    (existing.rationale ?? null) === (incoming.rationale ?? null) &&
    (existing.status ?? null) === (incoming.status ?? null) &&
    (existing.timeToImpact ?? 'unknown') === (incoming.timeToImpact ?? 'unknown') &&
    (existing.trlScore ?? null) === (incoming.trlScore ?? null) &&
    (existing.x ?? null) === (incoming.x ?? null) &&
    (existing.y ?? null) === (incoming.y ?? null);
  if (!scalarEqual) return false;
  // Technology snapshot compared structurally (a stringify is stable enough for
  // this flat, key-ordered object minted by the same writer).
  return JSON.stringify(existing.technologySnapshot ?? null) === JSON.stringify(incoming.technologySnapshot ?? null);
}

// ============================================================================
// CONSTANTS (mirror radar-placement-service.ts)
// ============================================================================

/** Firestore collection name for radar placements. */
const COLLECTION_NAME = 'radarPlacements';

// ============================================================================
// UTILITY (mirror radar-placement-service.ts)
// ============================================================================

/** Generates a unique placement id — same format as the client service. */
function generateId(): string {
  return `placement-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * GRAPH-060 — the acknowledged graph-handoff status returned by the `*WithHandoff`
 * mutation primitives. `committed` is always `true` (the caller only reaches this
 * after the Firestore write landed). `acknowledged` reflects whether Inngest
 * accepted the graph-sync event; when it did not — either an empty ack or a
 * thrown dispatch — `reconciliationRequired` is set so the caller can surface an
 * explicit "committed, graph handoff pending recovery" truth instead of claiming
 * either full success or a rollback that never happened.
 */
export interface PlacementGraphHandoff {
  committed: true;
  acknowledged: boolean;
  reconciliationRequired: boolean;
}

/** Result of a placement create/update through the acknowledged handoff. */
export interface PlacementMutationHandoffResult {
  placement: RadarPlacement;
  graphHandoff: PlacementGraphHandoff;
}

/** Result of a placement delete through the acknowledged handoff. */
export interface PlacementDeleteHandoffResult {
  graphHandoff: PlacementGraphHandoff;
}

/** Pure derivation of the handoff status from whether the dispatch was acknowledged. */
export function buildPlacementGraphHandoff(acknowledged: boolean): PlacementGraphHandoff {
  return { committed: true, acknowledged, reconciliationRequired: !acknowledged };
}

/**
 * Dispatch the dedicated placement graph-sync event and REPORT whether Inngest
 * acknowledged it. Unlike the historical best-effort `fireSyncEvent`, this awaits
 * the send and inspects the accepted event ids. A rejected/empty dispatch is
 * reported as `acknowledged: false` (never thrown) — the Firestore write has
 * already committed, so a dispatch failure is a recovery signal, not a mutation
 * failure. Scheduled reconciliation (`reconcile-firestore-neo4j`) re-drives any
 * unacknowledged placement.
 */
async function dispatchPlacementSync(
  placementId: string,
  operation: 'create' | 'update' | 'delete',
  deleteToken?: string
): Promise<{ acknowledged: boolean }> {
  try {
    const { inngest } = await import('@/lib/inngest/client');
    const accepted = await inngest.send({
      name: 'app/radar-placement.sync.requested',
      data: { placementId, operation, ...(deleteToken ? { deleteToken } : {}) },
    });
    const ids = (accepted as { ids?: unknown } | undefined)?.ids;
    return { acknowledged: Array.isArray(ids) && ids.length > 0 };
  } catch (error) {
    log.warn('Placement graph-sync dispatch failed after commit; reconciliation required', {
      placementId,
      operation,
      error: String(error),
    });
    return { acknowledged: false };
  }
}

/**
 * Best-effort dispatch used by the drop-in `admin*RadarPlacement` twins that
 * preserve the original client-service signatures. It shares the awaited
 * dispatch above but discards the acknowledgement — callers that need the
 * committed-vs-acknowledged truth use the `*WithHandoff` variants.
 */
async function fireSyncEvent(placementId: string, operation: 'create' | 'update' | 'delete'): Promise<void> {
  await dispatchPlacementSync(placementId, operation);
}

// ============================================================================
// READS
// ============================================================================

/**
 * Admin-SDK twin of `getRadarPlacements`. Mirrors the client service: a single
 * collection fetch (optionally narrowed by `radarId` server-side to keep the
 * payload small), then in-memory filters for the remaining predicates so we
 * never require a composite index.
 */
export async function adminGetRadarPlacements(filters: RadarPlacementFilters = {}): Promise<RadarPlacement[]> {
  try {
    // Narrow on `radarId` at the query level when present (cheap, indexed on a
    // single field); apply every other predicate in-memory to match the client
    // service's index-free behavior.
    const baseRef = db.collection(COLLECTION_NAME);
    const queryRef = filters.radarId ? baseRef.where('radarId', '==', filters.radarId) : baseRef;
    const snapshot = await queryRef.get();

    let placements = snapshot.docs.map((doc) => ({
      ...(doc.data() as Omit<RadarPlacement, 'id'>),
      id: doc.id,
    })) as RadarPlacement[];

    if (filters.technologyId) {
      placements = placements.filter((p) => p.technologyId === filters.technologyId);
    }
    if (filters.quadrantId) {
      placements = placements.filter((p) => p.quadrantId === filters.quadrantId);
    }
    if (filters.ring) {
      placements = placements.filter((p) => p.ring === filters.ring);
    }
    if (filters.status) {
      placements = placements.filter((p) => p.status === filters.status);
    }
    if (filters.timeToImpact) {
      placements = placements.filter((p) => p.timeToImpact === filters.timeToImpact);
    }
    if (filters.limit) {
      placements = placements.slice(0, filters.limit);
    }

    return placements;
  } catch (error) {
    log.error('Error fetching placements (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch placements: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK twin of `getPlacementsByRadar`. Same name the spec asks for
 * (`adminGetPlacementsForRadar`); delegates to {@link adminGetRadarPlacements}.
 */
export async function adminGetPlacementsForRadar(radarId: string): Promise<RadarPlacement[]> {
  return adminGetRadarPlacements({ radarId });
}

/**
 * Admin-SDK twin of `getPlacementsForTechnology`. Returns every placement of a
 * technology across all radars. Used by refresh-placement-snapshots.
 */
export async function adminGetPlacementsForTechnology(technologyId: string): Promise<RadarPlacement[]> {
  return adminGetRadarPlacements({ technologyId });
}

/**
 * Admin-SDK twin of `getPlacementForTechnologyOnRadar`. Returns the single
 * placement for a technology on a radar, or null. Used internally by
 * {@link adminCreateRadarPlacement}'s duplicate guard, and exported for callers
 * that need the lookup directly.
 */
export async function adminGetPlacementForTechnologyOnRadar(
  technologyId: string,
  radarId: string
): Promise<RadarPlacement | null> {
  try {
    const snapshot = await db
      .collection(COLLECTION_NAME)
      .where('technologyId', '==', technologyId)
      .where('radarId', '==', radarId)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return { ...(doc.data() as Omit<RadarPlacement, 'id'>), id: doc.id } as RadarPlacement;
  } catch (error) {
    log.error('Error fetching placement (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK twin of `getRadarPlacementById`. Returns the placement or null.
 */
export async function adminGetRadarPlacementById(id: string): Promise<RadarPlacement | null> {
  try {
    const snap = await db.collection(COLLECTION_NAME).doc(id).get();
    if (!snap.exists) {
      return null;
    }
    return { ...(snap.data() as Omit<RadarPlacement, 'id'>), id: snap.id } as RadarPlacement;
  } catch (error) {
    log.error('Error fetching placement by ID (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to fetch placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ============================================================================
// CREATE
// ============================================================================

/**
 * Admin-SDK twin of `createRadarPlacement`, reworked onto the GRAPH-066
 * deterministic pair identity `[radarId, technologyId]`. One transaction reads
 * the technology, the target radar (for quadrant/ring validation), the
 * server-owned pair lock (`radarPlacementPairs/{pairKey}`), and — only when no
 * lock exists — the legacy placements for the pair, then:
 *
 *   - Fresh pair → mint the placement + write the pair lock.
 *   - Exact retry (lock present, same position) → resync/return the existing
 *     placement idempotently (no second write).
 *   - Conflicting payload on an occupied pair → `PlacementPairConflictError`.
 *   - Exactly one unadopted legacy placement → adopt it (backfill the lock,
 *     preserve the legacy doc id), write no new placement.
 *   - Multiple legacy placements for one pair → `AmbiguousLegacyPlacementError`
 *     (migration halts, never chooses silently).
 *   - Invalid quadrant/ring for the exact radar → `PlacementValidationError`.
 *
 * All reads precede all writes, and the lock is a single deterministic
 * contention point, so concurrent UI + Assistant creates converge on one
 * placement + one lock. Typed errors propagate unwrapped so callers/routes can
 * classify them; only unexpected failures are wrapped.
 */
async function commitCreatePlacement(
  data: CreateRadarPlacementInput,
  opts: PlacementMutationAuthzOptions = {}
): Promise<RadarPlacement> {
  const pairKey = buildRadarPlacementPairKey(data.radarId, data.technologyId);
  const lockRef = db.collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).doc(pairKey);

  try {
    return await db.runTransaction(async (transaction) => {
      const now = Date.now();

      // (1) Technology must exist — orphan prevention at the service boundary.
      const techSnap = await transaction.get(db.collection('technologies').doc(data.technologyId));
      if (!techSnap.exists) {
        throw new PlacementValidationError(`Cannot create placement: technology ${data.technologyId} does not exist`);
      }

      // (2) Authorize + validate quadrant/ring against the EXACT radar's config.
      const radar = await loadAuthorizedRadar(transaction, data.radarId, opts.requireOwnerId);
      assertPlacementQuadrantAndRing(radar, data.quadrantId, data.ring);

      // (2b) GRAPH-066 #3 — refuse if the parent radar OR technology is mid-cascade
      //      (a transactionally-enforced barrier so a create can't strand an orphan
      //      after the cascade snapshot but before the parent is deleted).
      const radarLeaseSnap = await transaction.get(
        db
          .collection(PLACEMENT_PARENT_DELETION_LEASE_COLLECTION)
          .doc(placementParentDeletionLeaseId('radar', data.radarId))
      );
      if (isPlacementParentDeletionLeaseActive(radarLeaseSnap.data(), now)) {
        throw new PlacementParentDeletingError('radar', data.radarId);
      }
      const techLeaseSnap = await transaction.get(
        db
          .collection(PLACEMENT_PARENT_DELETION_LEASE_COLLECTION)
          .doc(placementParentDeletionLeaseId('technology', data.technologyId))
      );
      if (isPlacementParentDeletionLeaseActive(techLeaseSnap.data(), now)) {
        throw new PlacementParentDeletingError('technology', data.technologyId);
      }

      // (3) Read + fully validate the deterministic pair lock (#6). A lock whose
      //     body or referenced placement does not match this exact pair is
      //     malformed/mismatched and fails CLOSED — we never create beside it.
      const lockSnap = await transaction.get(lockRef);
      let staleLock = false;
      if (lockSnap.exists) {
        // #3 — one complete parser validates the key, endpoints, keyVersion, and
        // bounded body; a drifted/malformed lock fails CLOSED.
        const lock = parseRadarPlacementPairLock(pairKey, lockSnap.data(), {
          radarId: data.radarId,
          technologyId: data.technologyId,
        });
        if (!lock) {
          throw new MalformedPlacementLockError(pairKey);
        }
        const existingSnap = await transaction.get(db.collection(COLLECTION_NAME).doc(lock.placementId));
        if (existingSnap.exists) {
          const existing = {
            ...(existingSnap.data() as Omit<RadarPlacement, 'id'>),
            id: existingSnap.id,
          } as RadarPlacement;
          // The referenced placement must itself be this exact pair — else the
          // lock points at a foreign placement (mismatched) → fail closed.
          if (existing.radarId !== data.radarId || existing.technologyId !== data.technologyId) {
            throw new MalformedPlacementLockError(pairKey);
          }
          // Exact retry (full canonical payload) → idempotent resync.
          if (isSameCanonicalPlacement(existing, data)) {
            log.info('Placement create is an exact retry; resyncing existing', { pairKey, id: existing.id });
            return existing;
          }
          // Occupied pair, differing payload → conflict (use update/move instead).
          throw new PlacementPairConflictError(existing);
        }
        // Lock present but its placement is gone — a stale lock. Do NOT blindly
        // create; fall through to the legacy-adopt-or-create decision, which
        // overwrites the stale lock with a real placement id.
        staleLock = true;
      }

      // (4) No valid current placement — adopt exactly one matching legacy
      //     placement if present, halt on multiple, else create. This holds for
      //     both the no-lock and stale-lock paths (#6: never create beside a legacy).
      const legacySnap = await transaction.get(
        db
          .collection(COLLECTION_NAME)
          .where('technologyId', '==', data.technologyId)
          .where('radarId', '==', data.radarId)
      );
      if (legacySnap.size > 1) {
        throw new AmbiguousLegacyPlacementError(
          data.radarId,
          data.technologyId,
          legacySnap.docs.map((doc: { id: string }) => doc.id)
        );
      }
      if (legacySnap.size === 1) {
        const legacyDoc = legacySnap.docs[0];
        const adopted = {
          ...(legacyDoc.data() as Omit<RadarPlacement, 'id'>),
          id: legacyDoc.id,
        } as RadarPlacement;
        // GRAPH-066 #3 — adopt the legacy placement ONLY when the incoming create
        // is an exact retry of it (complete canonical payload). A create with a
        // DIFFERENT payload for an existing pair is a conflict — the caller must
        // update/move, not silently overwrite the legacy opinion.
        if (!isSameCanonicalPlacement(adopted, data)) {
          throw new PlacementPairConflictError(adopted);
        }
        transaction.set(
          lockRef,
          buildRadarPlacementPairLockEntry(legacyDoc.id, data.radarId, data.technologyId, now).data
        );
        log.info('Adopted legacy placement under pair lock', { pairKey, id: legacyDoc.id, staleLock });
        return adopted;
      }

      // (5) Fresh create — mint the placement and (over)write the pair lock together.
      const id = generateId();
      const placement: RadarPlacement = {
        id,
        technologyId: data.technologyId,
        radarId: data.radarId,
        quadrantId: data.quadrantId,
        ring: data.ring,
        rationale: data.rationale,
        x: data.x,
        y: data.y,
        status: data.status,
        timeToImpact: data.timeToImpact ?? 'unknown',
        trlScore: data.trlScore,
        technologySnapshot: data.technologySnapshot,
        createdAt: now,
        updatedAt: now,
        placedBy: data.placedBy,
      };
      const cleaned = Object.fromEntries(
        Object.entries(placement).filter(([, v]) => v !== undefined)
      ) as RadarPlacement;

      transaction.set(db.collection(COLLECTION_NAME).doc(id), cleaned);
      transaction.set(lockRef, buildRadarPlacementPairLockEntry(id, data.radarId, data.technologyId, now).data);
      log.info('Created placement (admin)', { id, technologyId: data.technologyId, radarId: data.radarId, pairKey });
      return cleaned;
    });
  } catch (error) {
    // Typed pair-identity errors carry their own classification — propagate them.
    if (
      error instanceof PlacementValidationError ||
      error instanceof PlacementAuthorizationError ||
      error instanceof PlacementParentDeletingError ||
      error instanceof MalformedPlacementLockError ||
      error instanceof PlacementPairConflictError ||
      error instanceof AmbiguousLegacyPlacementError
    ) {
      throw error;
    }
    log.error('Error creating placement (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to create placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK twin of `createRadarPlacement`. Commits the placement, then fires
 * the dedicated graph-sync event (best-effort — the acknowledgement is
 * discarded). Preserves the original signature for internal callers (AI-tool
 * executors, workers). Callers that need the committed-vs-acknowledged truth of
 * GRAPH-060 use {@link adminCreateRadarPlacementWithHandoff}.
 */
export async function adminCreateRadarPlacement(
  data: CreateRadarPlacementInput,
  opts: PlacementMutationAuthzOptions = {}
): Promise<RadarPlacement> {
  const placement = await commitCreatePlacement(data, opts);
  // Fire dedicated graph-sync event (best-effort). `triggerEntitySync` is a
  // no-op for radarPlacement (DEDICATED_SYNC_TYPES), so this is the real path.
  await fireSyncEvent(placement.id, 'create');
  return placement;
}

/**
 * GRAPH-060 create through the acknowledged graph handoff. Commits the placement
 * (throwing the same duplicate/orphan errors on a failed commit), then AWAITS
 * the graph-sync dispatch and returns both the committed placement and an
 * explicit {@link PlacementGraphHandoff}. A dispatch that is unacknowledged or
 * throws yields `reconciliationRequired: true` — the placement is still
 * committed and returned.
 */
export async function adminCreateRadarPlacementWithHandoff(
  data: CreateRadarPlacementInput,
  opts: PlacementMutationAuthzOptions = {}
): Promise<PlacementMutationHandoffResult> {
  const placement = await commitCreatePlacement(data, opts);
  const { acknowledged } = await dispatchPlacementSync(placement.id, 'create');
  return { placement, graphHandoff: buildPlacementGraphHandoff(acknowledged) };
}

// ============================================================================
// UPDATE
// ============================================================================

/**
 * Admin-SDK twin of `updateRadarPlacement`. Tracks ring movement
 * (`movedFrom`/`movedAt`) when `ring` changes, strips undefined values, fires
 * the `app/radar-placement.sync.requested` update event, and returns the full
 * re-read document — identical to the client service.
 */
async function commitUpdatePlacement(
  id: string,
  updates: AdminUpdateRadarPlacementInput,
  opts: PlacementMutationAuthzOptions = {}
): Promise<RadarPlacement> {
  // GRAPH-066 #3 — reject any caller-supplied identity/audit field BEFORE opening
  // the transaction, so a smuggled `radarId`/`placedBy`/… mutates nothing.
  assertMutablePlacementUpdate(updates as Record<string, unknown>);

  const docRef = db.collection(COLLECTION_NAME).doc(id);

  try {
    // GRAPH-066 #7 — update/move is TRANSACTIONAL: read the placement, its exact
    // radar config, and its pair lock; authorize; validate the RESULTING quadrant
    // + ring against that radar (preserving per-radar ring vocabularies); verify
    // the lock still owns this placement (fail closed on missing/mismatch); then
    // write. All reads precede the write.
    return await db.runTransaction(async (transaction) => {
      const docSnap = await transaction.get(docRef);
      if (!docSnap.exists) {
        throw new PlacementValidationError(`Placement ${id} not found`);
      }
      const currentData = { ...(docSnap.data() as Omit<RadarPlacement, 'id'>), id: docSnap.id } as RadarPlacement;

      const radar = await loadAuthorizedRadar(transaction, currentData.radarId, opts.requireOwnerId);

      // Validate the resulting position (post-update quadrant + ring) against the radar.
      const resultingQuadrantId = updates.quadrantId ?? currentData.quadrantId;
      const resultingRing = updates.ring ?? currentData.ring;
      assertPlacementQuadrantAndRing(radar, resultingQuadrantId, resultingRing);

      // Verify the pair lock still owns THIS placement — fail closed otherwise.
      const pairKey = buildRadarPlacementPairKey(currentData.radarId, currentData.technologyId);
      const lockRef = db.collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).doc(pairKey);
      const lockSnap = await transaction.get(lockRef);
      const now = Date.now();
      if (!lockSnap.exists) {
        // Missing lock on an existing placement is drift — heal it in-band by
        // (re)writing the lock for this exact pair rather than failing the user's
        // edit. A lock that exists but points elsewhere is a genuine conflict.
        transaction.set(
          lockRef,
          buildRadarPlacementPairLockEntry(id, currentData.radarId, currentData.technologyId, now).data
        );
      } else if ((lockSnap.data() as { placementId?: string } | undefined)?.placementId !== id) {
        throw new MalformedPlacementLockError(pairKey);
      }

      const updatedData: Partial<RadarPlacement> = { ...updates, updatedAt: now };
      if (updates.ring && updates.ring !== currentData.ring) {
        updatedData.movedFrom = currentData.ring as Ring;
        updatedData.movedAt = now;
      }
      const cleanUpdates = Object.fromEntries(Object.entries(updatedData).filter(([, v]) => v !== undefined));
      transaction.update(docRef, cleanUpdates);

      log.info('Updated placement (admin)', { id, pairKey });
      // Compose the resulting document from current + applied updates (a re-read
      // inside the same transaction would not see the pending write).
      return { ...currentData, ...cleanUpdates } as RadarPlacement;
    });
  } catch (error) {
    if (
      error instanceof PlacementValidationError ||
      error instanceof PlacementAuthorizationError ||
      error instanceof MalformedPlacementLockError
    ) {
      throw error;
    }
    log.error('Error updating placement (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to update placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Admin-SDK twin of `updateRadarPlacement`. Commits the edit, then fires the
 * graph-sync event best-effort. Preserves the original signature.
 */
export async function adminUpdateRadarPlacement(
  id: string,
  updates: AdminUpdateRadarPlacementInput,
  opts: PlacementMutationAuthzOptions = {}
): Promise<RadarPlacement> {
  const placement = await commitUpdatePlacement(id, updates, opts);
  await fireSyncEvent(id, 'update');
  return placement;
}

/**
 * GRAPH-060 update (including ring moves) through the acknowledged graph handoff.
 */
export async function adminUpdateRadarPlacementWithHandoff(
  id: string,
  updates: AdminUpdateRadarPlacementInput,
  opts: PlacementMutationAuthzOptions = {}
): Promise<PlacementMutationHandoffResult> {
  const placement = await commitUpdatePlacement(id, updates, opts);
  const { acknowledged } = await dispatchPlacementSync(id, 'update');
  return { placement, graphHandoff: buildPlacementGraphHandoff(acknowledged) };
}

// ============================================================================
// DELETE
// ============================================================================

/**
 * Admin-SDK twin of `deleteRadarPlacement`. Same contract, same errors, same
 * fire-and-forget graph-sync, safe to call from server routes / AI-tool
 * executors / workers.
 *
 * Replicates the client service exactly:
 *   1. Existence guard — throws `Error('Placement … not found')` when missing
 *      (same message the client throws).
 *   2. Relation cascade cleanup through the shared admin helper. It removes
 *      relation docs plus their owned triple locks in bounded batches and fires
 *      the per-relation Neo4j delete sync.
 *   3. Delete the placement doc.
 *   4. Fire the dedicated `app/radar-placement.sync.requested` delete event
 *      (best-effort). `triggerEntitySync('radarPlacement', …)` is a no-op for
 *      placements (DEDICATED_SYNC_TYPES), so this is the real graph-sync path —
 *      same rationale as create/update above.
 */
/**
 * GRAPH-060 #1 — delete the placement doc + pair lock AND write a durable delete
 * outbox tombstone in ONE transaction. The tombstone (placement id + pair key +
 * endpoints) is the recovery identity: even after Firestore is deleted,
 * reconciliation can redrive the graph removal from it. Returns the delete token
 * so the caller dispatches a delete event that clears the tombstone only after
 * Neo4j confirms.
 */
async function commitDeletePlacement(
  id: string,
  opts: PlacementMutationAuthzOptions = {}
): Promise<{ deleteToken: string; pairKey: string }> {
  const docRef = db.collection(COLLECTION_NAME).doc(id);

  try {
    // Read + authorize BEFORE any mutation (including the relation cascade). This
    // read is outside the delete transaction; the transaction below only reads
    // the lock and writes, keeping reads-before-writes intact.
    const preSnap = await docRef.get();
    if (!preSnap.exists) {
      throw new PlacementValidationError(`Placement ${id} not found`);
    }
    const placement = { ...(preSnap.data() as Omit<RadarPlacement, 'id'>), id: preSnap.id } as RadarPlacement;
    if (opts.requireOwnerId !== undefined) {
      const radarSnap = await db.collection('radars').doc(placement.radarId).get();
      const radar = radarSnap.exists
        ? ({ ...(radarSnap.data() as Omit<RadarData, 'id'>), id: radarSnap.id } as RadarData)
        : null;
      // GRAPH-060 #2 — fail closed: a missing parent radar (null) is NOT mutable,
      // so an orphan placement can't be deleted by any authenticated user merely
      // by knowing its id. Radar/technology CASCADE deletes are system-authorized
      // (they omit requireOwnerId) and don't reach this branch.
      if (!isRadarMutableBy(radar, opts.requireOwnerId)) {
        throw new PlacementAuthorizationError(placement.radarId);
      }
    }

    // Clean up relations first (cascade delete).
    const relationsDeleted = await adminDeleteRelationsForEntity(id);
    if (relationsDeleted > 0) {
      log.info('Cleaned up relations for placement (admin)', { relationsDeleted, id });
    }

    const pairKey = buildRadarPlacementPairKey(placement.radarId, placement.technologyId);
    const lockRef = db.collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).doc(pairKey);
    const outboxRef = db.collection(RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION).doc(id);
    const deleteToken = createRadarPlacementDeleteToken(id);

    await db.runTransaction(async (transaction) => {
      const lockSnap = await transaction.get(lockRef);
      const now = Date.now();
      transaction.delete(docRef);
      // Only drop the lock if it still points at THIS placement — never strip a
      // lock a concurrent write already re-owned.
      if (lockSnap.exists && (lockSnap.data() as { placementId?: string } | undefined)?.placementId === id) {
        transaction.delete(lockRef);
      }
      // Durable tombstone committed atomically with the delete.
      transaction.set(
        outboxRef,
        buildRadarPlacementDeleteOutboxRecord(
          { id, pairKey, radarId: placement.radarId, technologyId: placement.technologyId },
          deleteToken,
          now
        )
      );
    });
    log.info('Deleted placement + wrote delete tombstone (admin)', { id, pairKey });
    return { deleteToken, pairKey };
  } catch (error) {
    if (error instanceof PlacementValidationError || error instanceof PlacementAuthorizationError) {
      throw error;
    }
    log.error('Error deleting placement (admin)', error instanceof Error ? error : new Error(String(error)));
    throw new Error(`Failed to delete placement: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * GRAPH-066 — the ONE primitive for the quadrant-reassignment path that runs
 * while a radar's quadrant set is being rewritten.
 *
 * `commitUpdatePlacement` validates the resulting quadrant against the radar's
 * CURRENT config, but an orphan reassignment happens BEFORE the new quadrant set
 * is written — so the target id does not exist on the radar yet and the ordinary
 * update would (correctly) refuse it. That is why this path used to write the
 * document raw, which also skipped the pair-lock ownership check every other
 * writer performs.
 *
 * This primitive keeps the ordering intact while restoring the invariant: the
 * target quadrant must belong to the caller's PROSPECTIVE quadrant set, and the
 * pair lock must still own this exact placement (missing locks heal in-band,
 * mismatched locks fail closed).
 */
export async function adminReassignPlacementQuadrant(
  placementId: string,
  newQuadrantId: string,
  prospectiveQuadrantIds: readonly string[]
): Promise<RadarPlacement> {
  if (!prospectiveQuadrantIds.includes(newQuadrantId)) {
    throw new PlacementValidationError(
      `Quadrant ${newQuadrantId} is not in the prospective quadrant set for placement ${placementId}`
    );
  }

  const docRef = db.collection(COLLECTION_NAME).doc(placementId);
  const placement = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(docRef);
    if (!snap.exists) throw new PlacementValidationError(`Placement ${placementId} not found`);
    const current = { ...(snap.data() as Omit<RadarPlacement, 'id'>), id: snap.id } as RadarPlacement;

    const pairKey = buildRadarPlacementPairKey(current.radarId, current.technologyId);
    const lockRef = db.collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION).doc(pairKey);
    const lockSnap = await transaction.get(lockRef);
    const now = Date.now();
    if (!lockSnap.exists) {
      transaction.set(
        lockRef,
        buildRadarPlacementPairLockEntry(placementId, current.radarId, current.technologyId, now).data
      );
    } else if ((lockSnap.data() as { placementId?: string } | undefined)?.placementId !== placementId) {
      throw new MalformedPlacementLockError(pairKey);
    }

    const updates = { quadrantId: newQuadrantId, updatedAt: now };
    transaction.update(docRef, updates);
    return { ...current, ...updates } as RadarPlacement;
  });

  await fireSyncEvent(placementId, 'update');
  return placement;
}

/**
 * GRAPH-066 #3 — hold the parent-deletion barrier across a cascade's
 * snapshot→delete window, then always release it.
 *
 * The lease is what makes `commitCreatePlacement` refuse a create for a parent
 * that is mid-cascade. Every cascade that reads placements and then deletes them
 * MUST run inside it: without the lease a create landing between the snapshot
 * and the parent's removal is not in the deleted set, so it survives as an
 * orphan placement plus an orphan pair lock pointing at a parent that no longer
 * exists. The lease carries a bounded TTL, so an interrupted cascade self-heals
 * rather than blocking creates forever.
 */
export async function withPlacementParentDeletionLease<T>(
  parentKind: PlacementParentKind,
  parentId: string,
  run: () => Promise<T>
): Promise<T> {
  const leaseRef = db
    .collection(PLACEMENT_PARENT_DELETION_LEASE_COLLECTION)
    .doc(placementParentDeletionLeaseId(parentKind, parentId));
  await leaseRef.set(buildPlacementParentDeletionLease(parentKind, parentId));
  try {
    return await run();
  } finally {
    await leaseRef.delete().catch(() => undefined);
  }
}

/** A placement row a cascade path already holds (from a bulk query). */
export interface CascadePlacementRow {
  id: string;
  radarId: string;
  technologyId: string;
}

/**
 * GRAPH-066 #8 — the ONE lock-aware bulk-delete primitive every cascade path
 * (technology deletion, radar deletion, quadrant-orphan deletion) routes through.
 * For each placement it removes the doc AND its pair lock AND writes a durable
 * delete tombstone in a single chunked batch (3 writes/placement, ≤450/batch),
 * then dispatches per-placement delete events. So a cascade can never leave an
 * orphan `radarPlacementPairs` lock or a graph node with no recovery evidence.
 *
 * The lock is deleted unconditionally by pair key (the pair is being vacated) —
 * safe for a cascade where the whole radar/technology is going away.
 */
export async function adminCascadeDeletePlacements(
  placements: CascadePlacementRow[],
  opts: { skipRelationCascade?: boolean } = {}
): Promise<number> {
  if (placements.length === 0) return 0;

  // Relation cascade first (idempotent), matching the single-delete path. A
  // caller that already ran relation cleanup (e.g. radar deletion via
  // prepareEntityDeletions) passes skipRelationCascade to avoid a redundant pass.
  if (!opts.skipRelationCascade) {
    await Promise.all(placements.map((placement) => adminDeleteRelationsForEntity(placement.id)));
  }

  const CHUNK = 150;
  const dispatch: Array<{ id: string; token: string }> = [];
  for (let i = 0; i < placements.length; i += CHUNK) {
    const slice = placements.slice(i, i + CHUNK);
    // GRAPH-066 #3 — pre-read the pair locks so we delete each ONLY when it still
    // points at the placement we're removing (placement-id CAS). A lock a
    // concurrent create already re-owned to a different placement is left intact.
    const lockRefs = slice.map((placement) =>
      db
        .collection(RADAR_PLACEMENT_PAIR_LOCK_COLLECTION)
        .doc(buildRadarPlacementPairKey(placement.radarId, placement.technologyId))
    );
    const lockSnaps = await db.getAll(...lockRefs);
    const lockOwnsPlacement = new Map<string, boolean>();
    slice.forEach((placement, index) => {
      const snap = lockSnaps[index];
      lockOwnsPlacement.set(
        placement.id,
        Boolean(snap.exists && (snap.data() as { placementId?: string } | undefined)?.placementId === placement.id)
      );
    });

    const batch = db.batch();
    const now = Date.now();
    slice.forEach((placement, index) => {
      const token = createRadarPlacementDeleteToken(placement.id);
      const pairKey = buildRadarPlacementPairKey(placement.radarId, placement.technologyId);
      batch.delete(db.collection(COLLECTION_NAME).doc(placement.id));
      if (lockOwnsPlacement.get(placement.id)) {
        batch.delete(lockRefs[index]);
      }
      batch.set(
        db.collection(RADAR_PLACEMENT_DELETE_OUTBOX_COLLECTION).doc(placement.id),
        buildRadarPlacementDeleteOutboxRecord(
          { id: placement.id, pairKey, radarId: placement.radarId, technologyId: placement.technologyId },
          token,
          now
        )
      );
      dispatch.push({ id: placement.id, token });
    });
    await batch.commit();
  }

  try {
    const { inngest } = await import('@/lib/inngest/client');
    await Promise.allSettled(
      dispatch.map(({ id, token }) =>
        inngest.send({
          id: radarPlacementDeleteSyncEventId(token, 0),
          name: 'app/radar-placement.sync.requested',
          data: { operation: 'delete', placementId: id, deleteToken: token },
        })
      )
    );
  } catch (error) {
    log.warn('Cascade placement delete dispatch failed; tombstones will be redriven', { error: String(error) });
  }

  log.info('Cascade-deleted placements with lock + tombstone', { count: placements.length });
  return placements.length;
}

/**
 * GRAPH-060 #1 — server-side bulk cascade for "delete every placement on a
 * radar", used by the browser radar-deletion path. Authorizes the radar, then
 * routes through the lock-aware primitive.
 */
export async function adminCascadeDeletePlacementsByRadar(
  radarId: string,
  opts: PlacementMutationAuthzOptions = {}
): Promise<number> {
  if (opts.requireOwnerId !== undefined) {
    const radarSnap = await db.collection('radars').doc(radarId).get();
    const radar = radarSnap.exists
      ? ({ ...(radarSnap.data() as Omit<RadarData, 'id'>), id: radarSnap.id } as RadarData)
      : null;
    if (!isRadarMutableBy(radar, opts.requireOwnerId)) throw new PlacementAuthorizationError(radarId);
  }
  // #3 — hold the parent-deletion lease across the snapshot→delete window so a
  // concurrent create for this radar is refused, then release it.
  return withPlacementParentDeletionLease('radar', radarId, async () => {
    const snap = await db.collection(COLLECTION_NAME).where('radarId', '==', radarId).get();
    const rows = snap.docs.map((doc) => {
      const data = doc.data() as { radarId: string; technologyId: string };
      return { id: doc.id, radarId: data.radarId, technologyId: data.technologyId };
    });
    return adminCascadeDeletePlacements(rows);
  });
}

/**
 * GRAPH-060 #1 — server-side bulk cascade for "delete every placement of a
 * technology" (across radars), used by the browser technology-deletion path.
 * Authorizes each distinct affected radar before deleting anything.
 */
export async function adminCascadeDeletePlacementsByTechnology(
  technologyId: string,
  opts: PlacementMutationAuthzOptions = {}
): Promise<number> {
  // #3 — hold the technology parent-deletion lease across the snapshot→delete
  // window so a concurrent create for this technology is refused.
  return withPlacementParentDeletionLease('technology', technologyId, async () => {
    const snap = await db.collection(COLLECTION_NAME).where('technologyId', '==', technologyId).get();
    const rows = snap.docs.map((doc) => {
      const data = doc.data() as { radarId: string; technologyId: string };
      return { id: doc.id, radarId: data.radarId, technologyId: data.technologyId };
    });
    if (opts.requireOwnerId !== undefined && rows.length > 0) {
      const radarIds = [...new Set(rows.map((row) => row.radarId))];
      const radarSnaps = await db.getAll(...radarIds.map((id) => db.collection('radars').doc(id)));
      for (const radarSnap of radarSnaps) {
        const radar = radarSnap.exists
          ? ({ ...(radarSnap.data() as Omit<RadarData, 'id'>), id: radarSnap.id } as RadarData)
          : null;
        if (!isRadarMutableBy(radar, opts.requireOwnerId)) {
          throw new PlacementAuthorizationError(radar?.id ?? 'unknown');
        }
      }
    }
    return adminCascadeDeletePlacements(rows);
  });
}

/**
 * Admin-SDK twin of `deleteRadarPlacement`. Commits the delete + tombstone, then
 * dispatches the delete event best-effort. Preserves the original signature.
 */
export async function adminDeleteRadarPlacement(id: string, opts: PlacementMutationAuthzOptions = {}): Promise<void> {
  const { deleteToken } = await commitDeletePlacement(id, opts);
  await dispatchPlacementSync(id, 'delete', deleteToken);
}

/**
 * GRAPH-060 delete through the acknowledged graph handoff. The Firestore doc, its
 * pair lock, and a durable delete tombstone are committed atomically; the graph
 * removal rides the dispatched delete event (carrying the token that clears the
 * tombstone once Neo4j confirms). An unacknowledged dispatch reports
 * `reconciliationRequired: true` — the tombstone lets reconciliation redrive it.
 */
export async function adminDeleteRadarPlacementWithHandoff(
  id: string,
  opts: PlacementMutationAuthzOptions = {}
): Promise<PlacementDeleteHandoffResult> {
  const { deleteToken } = await commitDeletePlacement(id, opts);
  const { acknowledged } = await dispatchPlacementSync(id, 'delete', deleteToken);
  return { graphHandoff: buildPlacementGraphHandoff(acknowledged) };
}
