import 'server-only';
import { createLogger } from '@/lib/logger';
import {
  AMBIGUOUS_GRAPH_COLLECTION,
  type CitationResolution,
  type GraphCitationRef,
  type OwnerScopedCitationReader,
} from './citation-provenance';

const log = createLogger('citation-provenance-admin');
const OWNER_FIELDS = ['userId', 'ownerId', 'createdBy'] as const;
const CITABLE_COLLECTIONS: ReadonlySet<string> = new Set([
  'documents',
  'signals',
  'technologies',
  'companies',
  'use-cases',
  'prototypes',
]);

export function createOwnerScopedCitationReader(ownerId: string): OwnerScopedCitationReader {
  return async (ref: GraphCitationRef): Promise<CitationResolution> => {
    if (!ownerId.trim()) return { state: 'unavailable', reason: 'mission owner is unavailable' };
    if (ref.collection !== AMBIGUOUS_GRAPH_COLLECTION && !CITABLE_COLLECTIONS.has(ref.collection)) {
      return { state: 'unavailable', reason: `citations may not name the "${ref.collection}" collection` };
    }
    const { db } = await import('@/lib/firebase-admin');
    if (ref.collection === AMBIGUOUS_GRAPH_COLLECTION) {
      const matches = (
        await Promise.all(
          [...CITABLE_COLLECTIONS].map(async (collection) => ({
            collection,
            snapshot: await db.collection(collection).doc(ref.id).get(),
          }))
        )
      ).filter(({ snapshot }) => snapshot.exists);
      if (matches.length === 0) return { state: 'absent' };
      if (matches.length !== 1) return { state: 'unavailable', reason: 'legacy graph citation is ambiguous' };
      return authorizeSnapshot(matches[0]!.snapshot.data() ?? {}, ownerId, matches[0]!.collection);
    }
    const snapshot = await db.collection(ref.collection).doc(ref.id).get();
    if (!snapshot.exists) return { state: 'absent' };
    return authorizeSnapshot(snapshot.data() ?? {}, ownerId, ref.collection);
  };
}

function authorizeSnapshot(input: unknown, ownerId: string, collection: string): CitationResolution {
  const data = (input ?? {}) as Record<string, unknown>;
  const present = OWNER_FIELDS.filter((field) => typeof data[field] === 'string' && data[field] !== '');
  if (present.some((field) => data[field] !== ownerId)) {
    log.warn('Citation names a record owned by another principal', { collection });
    return { state: 'unavailable', reason: 'record belongs to another owner' };
  }
  return { state: 'eligible' };
}
