import type { EntityType, Relation, RelationType } from '@/lib/types';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { CORRELATION_ID_HEADER, createCorrelationId } from '@/lib/observability/correlation';

type RelationCreateInput = Omit<
  Relation,
  'id' | 'createdAt' | 'updatedAt' | 'sourceCorrelationId' | 'sourceFingerprint'
>;
type RelationUpdateInput = Partial<
  Omit<
    Relation,
    'id' | 'createdAt' | 'updatedAt' | 'claimId' | 'createdBy' | 'sourceCorrelationId' | 'sourceFingerprint'
  >
>;

interface ApiEnvelope<T> {
  success?: boolean;
  data?: T;
  error?: string;
  message?: string;
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  headers.set(CORRELATION_ID_HEADER, createCorrelationId());
  const response = await fetchWithAuth(url, {
    ...init,
    headers,
  });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Relation request failed (${response.status})`);
  }
  if (payload.data === undefined) throw new Error('Relation API returned no data');
  return payload.data;
}

export function isBrowserRelationClient(): boolean {
  return typeof window !== 'undefined';
}

export function createRelationViaApi(input: RelationCreateInput): Promise<Relation> {
  return requestJson<Relation>('/api/relations', { method: 'POST', body: JSON.stringify(input) });
}

export function updateRelationViaApi(id: string, updates: RelationUpdateInput): Promise<Relation> {
  return requestJson<Relation>(`/api/relations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteRelationViaApi(id: string): Promise<void> {
  await requestJson<{ deleted: true }>(`/api/relations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ============================================================================
// UX-054 — ID-based creation through the server snapshot boundary
// ============================================================================

/** The pair already exists. Distinct from a failure: the link the user wanted is there. */
export class DuplicateRelationApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateRelationApiError';
  }
}

export interface CreateRelationFromIdsInput {
  sourceId: string;
  sourceType: EntityType;
  targetId: string;
  targetType: EntityType;
  relationType: RelationType;
}

/**
 * Create a relation from entity IDs, letting the SERVER resolve both snapshots.
 *
 * `POST /api/relations` (what `createRelation` uses in the browser) accepts a
 * client-built snapshot verbatim — it validates the shape but never checks that
 * the entity exists. Callers therefore had to resolve the target themselves, and
 * a page whose inline resolver did not cover an entity type it offered in the
 * picker silently created nothing (UX-054).
 *
 * `/api/relations/from-ids` is the authorization boundary: it authenticates,
 * resolves BOTH endpoints through the admin `buildEntitySnapshot`, rejects
 * unknown ids and self-references, and dispatches the Neo4j sync. A foreign or
 * invalid target cannot produce a write here — it produces an error the UI must
 * show.
 *
 * @throws DuplicateRelationApiError when the pair already exists (HTTP 409)
 * @throws Error with the server's message for any other failure
 */
export async function createRelationFromIds(input: CreateRelationFromIdsInput): Promise<Relation> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    [CORRELATION_ID_HEADER]: createCorrelationId(),
  });
  const response = await fetchWithAuth('/api/relations/from-ids', {
    method: 'POST',
    headers,
    body: JSON.stringify(input),
  });

  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<Relation> & { code?: string };

  if (response.status === 409 || payload.code === 'DUPLICATE_RELATION') {
    throw new DuplicateRelationApiError(payload.message || payload.error || 'Relation already exists');
  }
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || payload.error || `Relation request failed (${response.status})`);
  }
  if (payload.data === undefined) throw new Error('Relation API returned no data');
  return payload.data;
}

export async function deleteRelationsForEntityViaApi(entityId: string): Promise<number> {
  const result = await requestJson<{ deleted: number }>(`/api/relations?entityId=${encodeURIComponent(entityId)}`, {
    method: 'DELETE',
  });
  return result.deleted;
}
