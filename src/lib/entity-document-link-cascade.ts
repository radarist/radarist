import type { EntityDocumentLink, TransformationEntityType } from '@/lib/types';

/**
 * Library deletion services use camel-case graph vocabulary for these two
 * entities, while EntityDocumentLink persists the transformation vocabulary.
 * Keep that conversion at the cascade boundary so callers cannot drift.
 */
export type EntityDocumentLinkCascadeEntityType = TransformationEntityType | 'orgUnit' | 'painPoint';

export const ENTITY_DOCUMENT_LINK_DELETE_CHUNK_SIZE = 200;

export interface EntityDocumentLinkDeleteEvent {
  name: 'app/entity-document-link.sync.requested';
  data: {
    operation: 'delete';
    linkId: string;
    entityId: string;
    documentId: string;
  };
}

export function toEntityDocumentLinkType(entityType: EntityDocumentLinkCascadeEntityType): TransformationEntityType {
  if (entityType === 'orgUnit') return 'org_unit';
  if (entityType === 'painPoint') return 'pain_point';
  return entityType;
}

export interface EntityDocumentLinkDeleteTarget {
  linkId: string;
  entityId: string;
  documentId: string;
}

export function toEntityDocumentLinkDeleteTarget(
  link: Pick<EntityDocumentLink, 'id' | 'entityId' | 'documentId'>
): EntityDocumentLinkDeleteTarget {
  return { linkId: link.id, entityId: link.entityId, documentId: link.documentId };
}

export function buildEntityDocumentLinkDeleteEvent(
  target: EntityDocumentLinkDeleteTarget
): EntityDocumentLinkDeleteEvent {
  return {
    name: 'app/entity-document-link.sync.requested',
    data: {
      operation: 'delete',
      linkId: target.linkId,
      entityId: target.entityId,
      documentId: target.documentId,
    },
  };
}

export function chunkEntityDocumentLinks(
  links: readonly EntityDocumentLink[],
  chunkSize = ENTITY_DOCUMENT_LINK_DELETE_CHUNK_SIZE
): EntityDocumentLink[][] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error('Entity-document link cascade chunk size must be a positive integer');
  }

  const chunks: EntityDocumentLink[][] = [];
  for (let offset = 0; offset < links.length; offset += chunkSize) {
    chunks.push(links.slice(offset, offset + chunkSize));
  }
  return chunks;
}
