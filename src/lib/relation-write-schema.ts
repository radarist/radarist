import { z } from 'zod';

import { ENTITY_COLLECTIONS } from '@/lib/entity-collections';
import { isCanonicalRelationType } from '@/lib/relation-type-contract';
import { canonicalHttpUrl, isUnresolvedGroundingRedirectUrl } from '@/lib/signals/source-identity';
import type { EntityType, RelationType } from '@/lib/types';

/**
 * GRAPH-070 — an evidence URL must be a citable publisher identity.
 *
 * A Google grounding redirect proves a page was consulted, not which publisher
 * supported the claim; two such URLs may alias one article, so accepting one as
 * an evidence identity lets a single source masquerade as corroboration and
 * inflates the derived `effectiveConfidence`. Enforced on the shared schema so
 * every durable relation-write route inherits it.
 */
const evidenceUrlSchema = z
  .string()
  .refine((value) => canonicalHttpUrl(value) !== null, 'Evidence url must be an absolute http(s) publisher URL')
  .refine(
    (value) => !isUnresolvedGroundingRedirectUrl(value),
    'Evidence url is an unresolved Google grounding redirect. Cite the publisher URL the search result points to, not the redirect.'
  );

export const entityTypeSchema = z.custom<EntityType>(
  (value) => typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENTITY_COLLECTIONS, value),
  'Invalid entity type'
);

export const relationTypeSchema = z.custom<RelationType>(isCanonicalRelationType, 'Invalid relation type');

export const evidenceRefSchema = z
  .object({
    id: z.string().min(1),
    sourceKey: z.string().optional(),
    type: z.enum(['document_chunk', 'signal', 'entity_field', 'web_ref', 'user_assertion']),
    snippet: z.string().optional(),
    url: evidenceUrlSchema.optional(),
    documentId: z.string().optional(),
    chunkIndex: z.number().int().nonnegative().optional(),
    chunkId: z.string().optional(),
    pageNumber: z.number().int().nonnegative().optional(),
    signalId: z.string().optional(),
    entityId: z.string().optional(),
    entityType: entityTypeSchema.optional(),
    entityField: z.string().optional(),
    confidence: z.number().finite().min(0).max(100).optional(),
    capturedAt: z.number().finite().nonnegative(),
  })
  .strict();

export const claimStatusSchema = z.enum(['proposed', 'curated', 'rejected', 'derived']);

const entitySnapshotSchema = z
  .object({
    type: entityTypeSchema,
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    status: z.string().optional(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.unknown()).optional(),
    snapshotAt: z.number().finite().nonnegative(),
  })
  .strict();

const mutableRelationFields = {
  relationType: relationTypeSchema,
  sourceSnapshot: entitySnapshotSchema,
  targetSnapshot: entitySnapshotSchema,
  notes: z.string().optional(),
  confidence: z.number().finite().min(0).max(100).optional(),
  aiSuggested: z.boolean().optional(),
  agentName: z.string().min(1).optional(),
  evidenceRefs: z.array(evidenceRefSchema).optional(),
  claimStatus: claimStatusSchema.optional(),
  reasoningSummary: z.string().optional(),
};

export const relationCreatePayloadSchema = z.object(mutableRelationFields).strict();

export const relationUpdatePayloadSchema = z.object(mutableRelationFields).partial().strict();
