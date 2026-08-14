/**
 * @file relations-triple-key.ts
 * @description Pure, side-effect-free key builder for the relation-triple lock
 * doc used by the transactional duplicate-create guard (LIVE-2 fix).
 *
 * WHY A SEPARATE MODULE: both the client (`relations-core.ts`) and admin
 * (`relations-admin.ts`) twins need the IDENTICAL lock key for the same
 * triple, or the lock can't serialize creates that race across the two SDKs
 * (e.g. a client-side create racing an admin-side AI-tool create for the same
 * pair). A pure module with no Firestore import lets both twins — and a
 * standalone unit suite — share one definition instead of two hand-rolled
 * copies that could silently drift.
 *
 * THE EQUIVALENCE CLASS THIS KEY MUST MIRROR: `checkDuplicateRelation`
 * (relations-core.ts) / `adminCheckDuplicateRelation` (relations-admin.ts).
 * That check is:
 *  - direction-SENSITIVE for most relation types: sourceId->targetId with a
 *    given relationType only collides with the same direction. A->B stays
 *    distinct from B->A (e.g. the live bug's Anthropic --vendor--> Claude vs.
 *    the reverse pair are NOT the same claim).
 *  - direction-INSENSITIVE for the symmetric vocabulary exported by
 *    `relation-type-contract.ts` — those checks also probe the reverse
 *    direction, so A->B and B->A must collapse onto the SAME lock document.
 *  - relationType-SCOPED: the same (source, target) pair under a different
 *    relationType is a different edge entirely (not a duplicate), so it must
 *    get a different lock key.
 *
 * The dependency-free `relation-symmetry-contract.ts` is the single source of
 * truth. This module re-exports its vocabulary for compatibility while the
 * client and admin service twins consume the same predicate.
 */

import { isSymmetricRelationType } from '@/lib/relation-symmetry-contract';
import type { RelationType } from '@/lib/types';

export { SYMMETRIC_RELATION_TYPES } from '@/lib/relation-symmetry-contract';

/**
 * Firestore collection that stores one lock doc per (sourceId, targetId,
 * relationType) triple (collapsed per the symmetric-type rule above). Doc
 * body: `{ relationId, sourceId, targetId, relationType, createdAt }`.
 */
export const RELATION_TRIPLE_LOCK_COLLECTION = 'relationTriples';

/** Version of the reversible relation-triple document-ID encoding. */
export const RELATION_TRIPLE_KEY_VERSION = 2 as const;
export const RELATION_TRIPLE_KEY_PREFIX = `rtk${RELATION_TRIPLE_KEY_VERSION}_`;

/** Firestore document IDs are limited to 1,500 UTF-8 bytes. */
export const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1500;

/**
 * During the v1-to-v2 transition a durable delete can issue five writes per
 * relation: relation, up to three owned lock orientations, and graph-delete
 * outbox marker. Keeping chunks at 90 leaves headroom below Firestore's
 * 500-write transaction limit.
 */
export const RELATION_LOCK_AWARE_DELETE_BATCH_SIZE = 90;

export interface RelationTripleLockDocument {
  relationId: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  createdAt: number;
  /** Missing on legacy locks created with the v1 slash-replacement key. */
  keyVersion?: typeof RELATION_TRIPLE_KEY_VERSION;
}

export interface RelationTripleLockEntry {
  id: string;
  data: RelationTripleLockDocument;
}

const BASE64_URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Historical v1 semantics are frozen solely for guarded migration lookup. */
const LEGACY_SYMMETRIC_RELATION_TYPES: ReadonlySet<RelationType> = new Set([
  'competes_with',
  'partner',
  'competitor',
]);

export class RelationTripleKeyTooLongError extends Error {
  readonly encodedBytes: number;

  constructor(encodedBytes: number) {
    super(
      `Relation triple key encodes to ${encodedBytes} bytes; Firestore document IDs allow at most ${FIRESTORE_DOCUMENT_ID_MAX_BYTES}`
    );
    this.name = 'RelationTripleKeyTooLongError';
    this.encodedBytes = encodedBytes;
  }
}

function encodeBase64Url(value: string): string {
  // JSON.stringify escapes lone UTF-16 surrogates, so TextEncoder cannot
  // collapse distinct JavaScript strings onto the replacement character.
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

function orderedTriple(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): readonly [RelationType, string, string] {
  if (isSymmetricRelationType(relationType) && sourceId > targetId) {
    return [relationType, targetId, sourceId];
  }
  return [relationType, sourceId, targetId];
}

/** Reproduces the non-injective v1 key exactly for migration and cleanup. */
export function buildLegacyRelationTripleKey(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): string {
  const a = sourceId.replace(/\//g, '_');
  const b = targetId.replace(/\//g, '_');
  if (LEGACY_SYMMETRIC_RELATION_TYPES.has(relationType)) {
    const [first, second] = a <= b ? [a, b] : [b, a];
    return `${first}__${relationType}__${second}`;
  }
  return `${a}__${relationType}__${b}`;
}

/**
 * Builds the deterministic Firestore document ID for the triple lock that
 * guards `createRelationWithTripleLock`/`adminCreateRelationWithTripleLock`.
 *
 * @param sourceId - The source entity ID
 * @param targetId - The target entity ID
 * @param relationType - The relation type
 * @returns A deterministic, sanitized key encoding the same equivalence class
 *   as the existing duplicate check
 */
export function buildRelationTripleKey(sourceId: string, targetId: string, relationType: RelationType): string {
  const tuple = orderedTriple(sourceId, targetId, relationType);
  const key = `${RELATION_TRIPLE_KEY_PREFIX}${encodeBase64Url(JSON.stringify(tuple))}`;
  // The generated key is ASCII, so code-unit length equals its UTF-8 byte
  // length. Fail closed rather than truncating or hashing into a collision.
  if (key.length > FIRESTORE_DOCUMENT_ID_MAX_BYTES) {
    throw new RelationTripleKeyTooLongError(key.length);
  }
  return key;
}

/**
 * Returns the current lock key followed by every historical v1 orientation
 * that can own the same semantic relation. The reverse v1 key matters for
 * verbs that became symmetric after v1 shipped.
 */
export function buildRelationTripleLockKeyCandidates(
  sourceId: string,
  targetId: string,
  relationType: RelationType
): string[] {
  const candidates = [
    buildRelationTripleKey(sourceId, targetId, relationType),
    buildLegacyRelationTripleKey(sourceId, targetId, relationType),
  ];
  if (isSymmetricRelationType(relationType)) {
    candidates.push(buildLegacyRelationTripleKey(targetId, sourceId, relationType));
  }
  return [...new Set(candidates)];
}

/**
 * Builds the complete deterministic lock entry used by raw seed/import paths.
 * Runtime relation creation uses the same key builder, so seeded relations
 * participate in the duplicate-create guard exactly like app-created rows.
 *
 * `relationType` accepts a string because the curated demo contains registered
 * graph verbs that predate the narrower client `RelationType` union. The key
 * algorithm only gives special treatment to the canonical symmetric subset;
 * every other verb remains direction-sensitive.
 */
export function buildRelationTripleLockEntry(
  relationId: string,
  sourceId: string,
  targetId: string,
  relationType: string,
  createdAt: number
): RelationTripleLockEntry {
  return {
    id: buildRelationTripleKey(sourceId, targetId, relationType as RelationType),
    data: {
      relationId,
      sourceId,
      targetId,
      relationType,
      createdAt,
      keyVersion: RELATION_TRIPLE_KEY_VERSION,
    },
  };
}

export interface RelationTripleLockAuditRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: RelationType;
}

export interface RelationTripleLockAuditLock {
  id: string;
  relationId?: string;
}

export interface RelationTripleLockAuditResult {
  missingLockKeys: string[];
  duplicateRelationKeys: Array<{ key: string; relationIds: string[] }>;
  mismatchedLocks: Array<{ key: string; expectedRelationIds: string[]; actualRelationId: string | null }>;
  orphanLockKeys: string[];
  healthy: boolean;
}

/**
 * Pure invariant detector for legacy relation rows written before triple locks
 * existed. It reports drift without mutating or backfilling data; callers can
 * run it over a bounded Firestore snapshot in a doctor or health lane.
 */
export function auditRelationTripleLocks(
  relations: RelationTripleLockAuditRelation[],
  locks: RelationTripleLockAuditLock[]
): RelationTripleLockAuditResult {
  const expectedByKey = new Map<string, string[]>();
  for (const relation of relations) {
    const key = buildRelationTripleKey(relation.sourceId, relation.targetId, relation.relationType);
    const ids = expectedByKey.get(key) ?? [];
    ids.push(relation.id);
    expectedByKey.set(key, ids);
  }
  for (const ids of expectedByKey.values()) ids.sort();

  const lockByKey = new Map(locks.map((lock) => [lock.id, lock]));
  const missingLockKeys: string[] = [];
  const duplicateRelationKeys: Array<{ key: string; relationIds: string[] }> = [];
  const mismatchedLocks: Array<{ key: string; expectedRelationIds: string[]; actualRelationId: string | null }> = [];

  for (const [key, relationIds] of [...expectedByKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const lock = lockByKey.get(key);
    if (!lock) missingLockKeys.push(key);
    if (relationIds.length > 1) duplicateRelationKeys.push({ key, relationIds });
    if (lock && (!lock.relationId || !relationIds.includes(lock.relationId))) {
      mismatchedLocks.push({ key, expectedRelationIds: relationIds, actualRelationId: lock.relationId ?? null });
    }
  }

  const orphanLockKeys = locks
    .map((lock) => lock.id)
    .filter((key) => !expectedByKey.has(key))
    .sort();

  return {
    missingLockKeys,
    duplicateRelationKeys,
    mismatchedLocks,
    orphanLockKeys,
    healthy:
      missingLockKeys.length === 0 &&
      duplicateRelationKeys.length === 0 &&
      mismatchedLocks.length === 0 &&
      orphanLockKeys.length === 0,
  };
}
