import type { SignalStatus } from '@/lib/types';

/**
 * Signal projection is deliberately narrower than the Firestore inbox.
 * Detected/Validated/Rejected/Archived rows remain searchable in Firestore but
 * do not add graph noise unless another retained graph record references them.
 */
export const DIRECT_SIGNAL_GRAPH_STATUSES = ['Approved', 'Imported'] as const satisfies readonly SignalStatus[];

export type SignalProjectionReferenceKind = 'relation-endpoint' | 'document-link';

export interface SignalProjectionReference {
  id: string;
  kind: SignalProjectionReferenceKind;
}

export interface SignalProjectionRelationSource {
  id: string;
  sourceSnapshot?: unknown;
  targetSnapshot?: unknown;
}

export interface SignalProjectionDocumentLinkSource {
  id: string;
  entityType?: unknown;
  entityId?: unknown;
}

export interface SignalProjectionReferenceSources {
  relations?: readonly SignalProjectionRelationSource[];
  documentLinks?: readonly SignalProjectionDocumentLinkSource[];
}

export interface SignalProjectionDecision {
  eligible: boolean;
  reason: 'approved-or-imported' | 'reference-required' | 'inbox-only';
  references: SignalProjectionReference[];
}

const DIRECT_STATUS_SET = new Set<string>(DIRECT_SIGNAL_GRAPH_STATUSES);

function compareStableStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function signalEndpointId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const endpoint = value as { id?: unknown; type?: unknown };
  return endpoint.type === 'signal' && typeof endpoint.id === 'string' && endpoint.id.trim().length > 0
    ? endpoint.id
    : null;
}

/**
 * Convert authoritative relation/link rows into the exact reference map used
 * by workers, reconciliation, seeding, and health checks.
 */
export function collectSignalProjectionReferences(
  sources: SignalProjectionReferenceSources
): Map<string, SignalProjectionReference[]> {
  const references = new Map<string, SignalProjectionReference[]>();
  const add = (signalId: string, reference: SignalProjectionReference) => {
    if (reference.id.trim().length === 0) return;
    const current = references.get(signalId) ?? [];
    current.push(reference);
    references.set(signalId, current);
  };

  for (const relation of sources.relations ?? []) {
    for (const endpoint of [relation.sourceSnapshot, relation.targetSnapshot]) {
      const signalId = signalEndpointId(endpoint);
      if (signalId) add(signalId, { id: relation.id, kind: 'relation-endpoint' });
    }
  }
  for (const link of sources.documentLinks ?? []) {
    if (link.entityType === 'signal' && typeof link.entityId === 'string' && link.entityId.trim().length > 0) {
      add(link.entityId, { id: link.id, kind: 'document-link' });
    }
  }
  return references;
}

export function decideSignalProjection(
  status: unknown,
  references: readonly SignalProjectionReference[] = []
): SignalProjectionDecision {
  const uniqueReferences = Array.from(
    new Map(
      references
        .filter((reference) => reference.id.trim().length > 0)
        .map((reference) => [`${reference.kind}:${reference.id}`, reference] as const)
    ).values()
  ).sort((left, right) =>
    left.kind === right.kind ? compareStableStrings(left.id, right.id) : compareStableStrings(left.kind, right.kind)
  );

  if (DIRECT_STATUS_SET.has(String(status))) {
    return { eligible: true, reason: 'approved-or-imported', references: uniqueReferences };
  }
  if (uniqueReferences.length > 0) {
    return { eligible: true, reason: 'reference-required', references: uniqueReferences };
  }
  return { eligible: false, reason: 'inbox-only', references: [] };
}
