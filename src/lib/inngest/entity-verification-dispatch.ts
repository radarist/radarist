/**
 * @file lib/inngest/entity-verification-dispatch.ts
 * @description GRAPH-048 — single decision point for entity-created Defense
 * Minister dispatch.
 *
 * The client entity factory could never fire `app/entity.verification.requested`
 * (the non-NEXT_PUBLIC `DEFENSE_MINISTER_ENABLED` flag is invisible in the
 * browser), so the trigger lives server-side: the entity sync workers call this
 * helper after a successful Neo4j create, mirroring how edge verification fires
 * from sync-relation-to-neo4j.
 *
 * Contract (prove-able): default-off; create operations only (stale re-checks
 * belong to the impulse sweep); externally verifiable entity types only;
 * deterministic event id so a retried or upsert-replayed create converges to
 * one event at Inngest ingestion.
 */

import { createHash } from 'node:crypto';

export const ENTITY_VERIFICATION_TYPES = ['company', 'technology'] as const;
export type EntityVerificationType = (typeof ENTITY_VERIFICATION_TYPES)[number];

export function isEntityVerificationType(value: unknown): value is EntityVerificationType {
  return typeof value === 'string' && ENTITY_VERIFICATION_TYPES.some((entityType) => entityType === value);
}

export interface EntityCreateVerificationEvent {
  /** Deterministic ingestion-dedup id — stable per (entityType, entityId). */
  id: string;
  name: 'app/entity.verification.requested';
  data: { entityId: string; entityType: EntityVerificationType };
}

/**
 * Build the verification event for an entity create, or null when dispatch
 * must not happen (flag off, non-create operation, unverifiable type).
 *
 * Accepts both the ingress tense ('create') and the workers' result tense
 * ('created') so call sites can pass whichever operation value they hold.
 */
export function maybeBuildEntityCreateVerificationEvent(input: {
  entityType: string;
  entityId: string;
  operation: string;
}): EntityCreateVerificationEvent | null {
  if (process.env.DEFENSE_MINISTER_ENABLED !== 'true') return null;
  if (input.operation !== 'create' && input.operation !== 'created') return null;
  if (!isEntityVerificationType(input.entityType)) return null;

  // Keep the separator escaped in source text; it becomes one NUL byte only
  // in the hash preimage and cannot make this TypeScript file binary.
  const digest = createHash('sha256').update(`${input.entityType}\u0000${input.entityId}`).digest('hex');
  return {
    id: `entity-create-verification:${digest}`,
    name: 'app/entity.verification.requested',
    data: { entityId: input.entityId, entityType: input.entityType },
  };
}
