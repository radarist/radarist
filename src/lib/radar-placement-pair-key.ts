/**
 * @file radar-placement-pair-key.ts
 * @description Pure, side-effect-free key builder + drift auditor for the
 * RadarPlacement pair-identity lock (GRAPH-066).
 *
 * ONE radar's opinion about ONE technology is the exact ordered tuple
 * `[radarId, technologyId]`. Unlike a relation triple this is NOT a symmetric
 * equivalence class — the radar and technology roles are not interchangeable, so
 * the tuple order is preserved verbatim. The deterministic key below is the
 * Firestore document id of the server-owned lock (`radarPlacementPairs/{pairKey}`)
 * that the create transaction reads/writes so concurrent UI + Assistant creates
 * for the same pair converge on one placement, one lock, one Neo4j node, one
 * PLACES and one ON_RADAR — instead of the previous raceable check-then-write.
 *
 * Modelled on `relations-triple-key.ts`: a dependency-free module so the admin
 * primitive, imports/seed, replay, and a standalone health lane all share ONE
 * key definition that cannot drift into hand-rolled copies.
 */

/** Firestore collection storing one lock doc per (radarId, technologyId) pair. */
export const RADAR_PLACEMENT_PAIR_LOCK_COLLECTION = 'radarPlacementPairs';

/** Version of the reversible pair-key encoding. Bump only on an encoding change. */
export const RADAR_PLACEMENT_PAIR_KEY_VERSION = 1 as const;
export const RADAR_PLACEMENT_PAIR_KEY_PREFIX = `rpk${RADAR_PLACEMENT_PAIR_KEY_VERSION}_`;

/** Firestore document IDs are limited to 1,500 UTF-8 bytes. */
export const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1500;

/** The stored lock document body. */
export interface RadarPlacementPairLockDocument {
  placementId: string;
  radarId: string;
  technologyId: string;
  createdAt: number;
  keyVersion: typeof RADAR_PLACEMENT_PAIR_KEY_VERSION;
}

const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export class RadarPlacementPairKeyTooLongError extends Error {
  readonly encodedBytes: number;
  constructor(encodedBytes: number) {
    super(
      `RadarPlacement pair key encodes to ${encodedBytes} bytes; Firestore document IDs allow at most ${FIRESTORE_DOCUMENT_ID_MAX_BYTES}`
    );
    this.name = 'RadarPlacementPairKeyTooLongError';
    this.encodedBytes = encodedBytes;
  }
}

function encodeBase64Url(value: string): string {
  // JSON.stringify escapes lone UTF-16 surrogates, so TextEncoder cannot collapse
  // distinct JavaScript strings onto the replacement character.
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_URL_ALPHABET[(combined >>> 18) & 63];
    encoded += BASE64_URL_ALPHABET[(combined >>> 12) & 63];
    if (second !== undefined) encoded += BASE64_URL_ALPHABET[(combined >>> 6) & 63];
    if (third !== undefined) encoded += BASE64_URL_ALPHABET[combined & 63];
  }
  return encoded;
}

/**
 * Deterministic Firestore document id for a `(radarId, technologyId)` pair lock.
 * The JSON-encoded ordered tuple is injective (distinct pairs never collide, even
 * across ids that embed slashes or underscores), then base64url-encoded so the id
 * is Firestore-safe. Fails closed rather than truncating into a collision.
 */
export function buildRadarPlacementPairKey(radarId: string, technologyId: string): string {
  const tuple: readonly [string, string] = [radarId, technologyId];
  const key = `${RADAR_PLACEMENT_PAIR_KEY_PREFIX}${encodeBase64Url(JSON.stringify(tuple))}`;
  if (key.length > FIRESTORE_DOCUMENT_ID_MAX_BYTES) {
    throw new RadarPlacementPairKeyTooLongError(key.length);
  }
  return key;
}

/**
 * GRAPH-066 #3 — the ONE complete pair-lock parser. Validates that a lock
 * document's deterministic key, placementId, radarId, technologyId, keyVersion,
 * and bounded createdAt all agree with the EXPECTED pair. Returns null (fail
 * closed) on any mismatch/malformation so every writer refuses a drifted lock
 * through a single definition instead of hand-rolled inline checks.
 */
export function parseRadarPlacementPairLock(
  documentId: string,
  data: unknown,
  expected: { radarId: string; technologyId: string }
): RadarPlacementPairLockDocument | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const expectedKey = buildRadarPlacementPairKey(expected.radarId, expected.technologyId);
  if (
    documentId !== expectedKey ||
    typeof record.placementId !== 'string' ||
    record.placementId.length === 0 ||
    record.radarId !== expected.radarId ||
    record.technologyId !== expected.technologyId ||
    record.keyVersion !== RADAR_PLACEMENT_PAIR_KEY_VERSION ||
    typeof record.createdAt !== 'number' ||
    !Number.isFinite(record.createdAt) ||
    record.createdAt < 0
  ) {
    return null;
  }
  return record as unknown as RadarPlacementPairLockDocument;
}

/** Build the complete deterministic lock entry for seed/import paths. */
export function buildRadarPlacementPairLockEntry(
  placementId: string,
  radarId: string,
  technologyId: string,
  createdAt: number
): { id: string; data: RadarPlacementPairLockDocument } {
  return {
    id: buildRadarPlacementPairKey(radarId, technologyId),
    data: { placementId, radarId, technologyId, createdAt, keyVersion: RADAR_PLACEMENT_PAIR_KEY_VERSION },
  };
}

export interface RadarPlacementPairAuditPlacement {
  id: string;
  radarId: string;
  technologyId: string;
}

export interface RadarPlacementPairAuditLock {
  id: string;
  placementId?: string;
}

export interface RadarPlacementPairAuditResult {
  /** Placements whose pair has no lock doc. */
  missingLockKeys: string[];
  /** Pairs with more than one placement (the drift a single lock prevents). */
  duplicatePairKeys: Array<{ key: string; placementIds: string[] }>;
  /** Locks pointing at a placement that isn't the pair's current placement. */
  mismatchedLocks: Array<{ key: string; expectedPlacementIds: string[]; actualPlacementId: string | null }>;
  /** Locks whose pair has no placement at all. */
  orphanLockKeys: string[];
  healthy: boolean;
}

/**
 * Pure invariant detector for legacy placement rows written before pair locks
 * existed. Reports drift (missing/duplicate/mismatched/orphan) without mutating,
 * so a doctor/health lane can run it over a bounded Firestore snapshot.
 */
export function auditRadarPlacementPairLocks(
  placements: RadarPlacementPairAuditPlacement[],
  locks: RadarPlacementPairAuditLock[]
): RadarPlacementPairAuditResult {
  const expectedByKey = new Map<string, string[]>();
  for (const placement of placements) {
    const key = buildRadarPlacementPairKey(placement.radarId, placement.technologyId);
    const ids = expectedByKey.get(key) ?? [];
    ids.push(placement.id);
    expectedByKey.set(key, ids);
  }
  for (const ids of expectedByKey.values()) ids.sort();

  const lockByKey = new Map(locks.map((lock) => [lock.id, lock]));
  const missingLockKeys: string[] = [];
  const duplicatePairKeys: Array<{ key: string; placementIds: string[] }> = [];
  const mismatchedLocks: Array<{ key: string; expectedPlacementIds: string[]; actualPlacementId: string | null }> = [];

  for (const [key, placementIds] of [...expectedByKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const lock = lockByKey.get(key);
    if (!lock) missingLockKeys.push(key);
    if (placementIds.length > 1) duplicatePairKeys.push({ key, placementIds });
    if (lock && (!lock.placementId || !placementIds.includes(lock.placementId))) {
      mismatchedLocks.push({ key, expectedPlacementIds: placementIds, actualPlacementId: lock.placementId ?? null });
    }
  }

  const orphanLockKeys = locks
    .map((lock) => lock.id)
    .filter((key) => !expectedByKey.has(key))
    .sort();

  return {
    missingLockKeys,
    duplicatePairKeys,
    mismatchedLocks,
    orphanLockKeys,
    healthy:
      missingLockKeys.length === 0 &&
      duplicatePairKeys.length === 0 &&
      mismatchedLocks.length === 0 &&
      orphanLockKeys.length === 0,
  };
}

// ============================================================================
// GRAPH-066 #10 — pure migration planner
// ============================================================================

export interface RadarPlacementPairMigrationPlacement {
  id: string;
  radarId: string | null;
  technologyId: string | null;
  /** Present when a node already carries a pairKey (won't be re-backfilled). */
  pairKey?: string | null;
}

export interface RadarPlacementPairMigrationPlan {
  /** Placements whose pairKey must be written, computed once up front. */
  backfill: Array<{ id: string; pairKey: string }>;
  /** Fatal drift that must halt the migration BEFORE any write (fail closed). */
  violations: string[];
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) dup.add(value);
    else seen.add(value);
  }
  return [...dup].sort();
}

/**
 * Compute the ENTIRE migration plan (all prospective pair keys) and preflight it
 * with ZERO mutation. The migration must call this first and refuse to write when
 * `violations` is non-empty — so a duplicate/malformed input produces no change
 * at all, instead of a partial backfill that then hits a duplicate. Pure and
 * fully unit-testable.
 */
export function planRadarPlacementPairMigration(
  placements: RadarPlacementPairMigrationPlacement[],
  radarIds: string[]
): RadarPlacementPairMigrationPlan {
  const violations: string[] = [];

  const malformed = placements.filter((p) => !p.radarId || !p.technologyId);
  if (malformed.length > 0) {
    violations.push(
      `${malformed.length} placement(s) with malformed endpoints: ${malformed
        .slice(0, 5)
        .map((p) => p.id)
        .join(', ')}`
    );
  }

  const dupRadars = findDuplicates(radarIds);
  if (dupRadars.length > 0) violations.push(`duplicate Radar.id: ${dupRadars.slice(0, 5).join(', ')}`);

  const dupPlacementIds = findDuplicates(placements.map((p) => p.id));
  if (dupPlacementIds.length > 0)
    violations.push(`duplicate RadarPlacement.id: ${dupPlacementIds.slice(0, 5).join(', ')}`);

  // Prospective pair keys for every well-formed placement.
  const prospective = placements
    .filter((p): p is RadarPlacementPairMigrationPlacement & { radarId: string; technologyId: string } =>
      Boolean(p.radarId && p.technologyId)
    )
    .map((p) => ({ id: p.id, pairKey: buildRadarPlacementPairKey(p.radarId, p.technologyId), existing: p.pairKey }));

  const dupPairKeys = findDuplicates(prospective.map((x) => x.pairKey));
  if (dupPairKeys.length > 0) {
    violations.push(`${dupPairKeys.length} duplicate prospective pair key(s) — two placements map to one pair`);
  }

  // A stored pairKey that does NOT equal the recomputed [radarId, technologyId]
  // key is drift that must abort the migration BEFORE any write — never silently
  // skipped (the wrong-key-blind bug). Zero mutation until an operator resolves it.
  const wrongKeys = prospective.filter(
    (x) => typeof x.existing === 'string' && x.existing.length > 0 && x.existing !== x.pairKey
  );
  if (wrongKeys.length > 0) {
    violations.push(
      `${wrongKeys.length} placement(s) with a stored pairKey that does not match [radarId, technologyId]: ${wrongKeys
        .slice(0, 5)
        .map((x) => x.id)
        .join(', ')}`
    );
  }

  // Only placements MISSING a pairKey need a backfill write (a correct existing
  // key is left alone; a wrong one already aborted above).
  const backfill = prospective
    .filter((x) => !(typeof x.existing === 'string' && x.existing.length > 0))
    .map((x) => ({ id: x.id, pairKey: x.pairKey }));

  return { backfill, violations };
}
