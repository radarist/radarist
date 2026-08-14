/**
 * @file scripts/lib/seed-graph-sync.ts
 * @description Helper module for the seed scripts to bootstrap Neo4j with the
 * same data they write to Firestore. The default `npm run firebase:seed` writes
 * relations via raw `setDoc`, which bypasses `createRelation` →
 * `entity-factory` → Inngest, so Neo4j stays empty on a fresh OSS clone. This
 * helper closes that gap: after the Firestore seed completes, call
 * `syncSeedToNeo4j({ entities, relations })` to upsert `:Entity` nodes and
 * typed edges using the SAME production code paths the Inngest sync uses
 * (`syncRelationAsAssertion` / `syncRelationAsEdge`).
 *
 * Why production code paths and not bespoke Cypher:
 *   - Schema invariants (temporal fields, asserter, evidence) stay in one
 *     place. If the contract changes, the seed automatically follows.
 *   - The same dispatch rules apply (curated → direct edge; AI-suggested or
 *     non-curated → :Assertion-first), so the seeded graph matches what the
 *     app would produce at runtime.
 *
 * Connection details:
 *   - Reads `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` from env.
 *   - Caller is responsible for env loading (dotenv) before invoking; the
 *     seed scripts already do this.
 *   - Caller should `await closeDriver()` from `@/lib/graph/neo4j-client` after the
 *     sync to let the process exit cleanly.
 */

import { deleteEntityFromGraph } from '@/lib/graph/assertions';
import { runWriteTransaction } from '@/lib/graph/neo4j-client';
import {
  syncRelationAsAssertion,
  syncRelationAsEdge,
  type SyncRelationAsAssertionInput,
} from '@/lib/graph/relation-assertion-sync';
import type { EvidenceInput } from '@/lib/graph/types';
import { resolveNeo4jPredicate } from '@/lib/graph/relation-registry';
import {
  collectSignalProjectionReferences,
  decideSignalProjection,
  type SignalProjectionDocumentLinkSource,
} from '@/lib/graph/signal-projection-policy';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SeedEntityType =
  | 'company'
  | 'technology'
  | 'useCase'
  | 'strategy'
  | 'prototype'
  | 'signal'
  | 'document'
  | 'orgUnit'
  | 'initiative'
  | 'painPoint'
  | 'radarPlacement';

export interface SeedEntity {
  id: string;
  type: SeedEntityType;
  name: string;
  /** Optional extra properties to attach to the Neo4j node. */
  properties?: Record<string, unknown>;
}

export interface SeedRelation {
  id: string;
  relationType: string;
  sourceSnapshot: { id: string; type: string; name: string };
  targetSnapshot: { id: string; type: string; name: string };
  confidence?: number;
  aiSuggested?: boolean;
  claimStatus?: string;
  /** Override the deterministic seed asserter when a fixture owns its actor. */
  assertedBy?: string;
  notes?: string | null;
  /**
   * Structured evidence — e.g. two distinct-source news snippets — so the
   * seeded graph shows real corroboration (chat's ✓✓ claim chip) instead of
   * only single-source or curated-with-no-evidence relations. Presence of
   * evidence forces the :Assertion write path (see `syncOneRelation`) so the
   * pieces attach as `:Evidence` nodes via `syncRelationAsAssertion`.
   */
  evidence?: Array<{ sourceType: EvidenceInput['sourceType']; snippet: string; sourceUrl?: string }>;
}

export interface SeedGraphSyncInput {
  entities: SeedEntity[];
  relations: SeedRelation[];
  documentLinks?: SignalProjectionDocumentLinkSource[];
}

export interface SeedProjectionSelection {
  entities: SeedEntity[];
  excludedSignalIds: string[];
}

export function selectSeedProjectionEntities(input: SeedGraphSyncInput): SeedProjectionSelection {
  const references = collectSignalProjectionReferences({
    relations: input.relations,
    documentLinks: input.documentLinks,
  });
  const excludedSignalIds: string[] = [];
  const entities = input.entities.filter((entity) => {
    if (entity.type !== 'signal') return true;
    const decision = decideSignalProjection(entity.properties?.status, references.get(entity.id));
    if (decision.eligible) return true;
    excludedSignalIds.push(entity.id);
    return false;
  });
  return { entities, excludedSignalIds };
}

// ---------------------------------------------------------------------------
// Type mappings
// ---------------------------------------------------------------------------

const ENTITY_TYPE_TO_LABEL: Record<SeedEntityType, string> = {
  technology: 'Technology',
  company: 'Company',
  useCase: 'UseCase',
  strategy: 'Strategy',
  prototype: 'Prototype',
  signal: 'Signal',
  document: 'Document',
  orgUnit: 'OrgUnit',
  initiative: 'Initiative',
  painPoint: 'PainPoint',
  radarPlacement: 'RadarPlacement',
};

// ---------------------------------------------------------------------------
// Entity sync
// ---------------------------------------------------------------------------

/**
 * Upsert one entity as `:Entity` + label-specific node. Idempotent.
 */
async function upsertEntityNode(entity: SeedEntity): Promise<void> {
  const label = ENTITY_TYPE_TO_LABEL[entity.type] ?? 'Entity';
  const properties = {
    ...(entity.properties ?? {}),
    id: entity.id,
    name: entity.name,
    entityType: entity.type,
    syncedAt: Date.now(),
  };
  // Label is hard-coded from the map (not user input) so string interpolation
  // is safe.
  const cypher = `
    MERGE (n:Entity {id: $id})
    ON CREATE SET n = $properties, n:${label}, n.createdAt = timestamp()
    ON MATCH SET n += $properties, n:${label}, n.updatedAt = timestamp()
    RETURN n.id AS id
  `;
  await runWriteTransaction(cypher, { id: entity.id, properties });
}

export async function syncSeedEntitiesToNeo4j(
  entities: SeedEntity[]
): Promise<{ synced: number; failed: number; failures: Array<{ id: string; error: string }> }> {
  let synced = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const entity of entities) {
    try {
      await upsertEntityNode(entity);
      synced++;
    } catch (err) {
      failures.push({ id: `${entity.type}:${entity.id}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { synced, failed: failures.length, failures };
}

async function removeExcludedSeedSignalsFromNeo4j(
  signalIds: readonly string[]
): Promise<{ failed: number; failures: Array<{ id: string; error: string }> }> {
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of signalIds) {
    try {
      // IDs come only from the caller-owned seed inventory after the shared
      // policy proved they have no retained relation/link reference.
      await deleteEntityFromGraph(id, 'signal');
    } catch (error) {
      failures.push({ id: `signal:${id}`, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { failed: failures.length, failures };
}

// ---------------------------------------------------------------------------
// Relation sync
// ---------------------------------------------------------------------------

/**
 * Dispatch a seeded relation through the same Class A/B/C decision the
 * Inngest sync function uses (curated + no AI → direct edge; otherwise
 * Assertion-first).
 */
async function syncOneRelation(rel: SeedRelation): Promise<'edged' | 'asserted'> {
  const predicate = resolveNeo4jPredicate(rel.relationType);
  const aiSuggested = rel.aiSuggested === true;
  const hasEvidence = (rel.evidence?.length ?? 0) > 0;
  // Evidence forces the :Assertion path — a bare typed edge (syncRelationAsEdge)
  // has nowhere to attach :Evidence nodes (property graphs can't put edges on
  // edges), so any relation carrying structured evidence needs the Assertion
  // bridge regardless of its claimStatus/aiSuggested combination.
  const needsAssertion = aiSuggested || (rel.claimStatus !== undefined && rel.claimStatus !== 'curated') || hasEvidence;

  const input: SyncRelationAsAssertionInput = {
    relationId: rel.id,
    subject: {
      id: rel.sourceSnapshot.id,
      type: rel.sourceSnapshot.type,
      name: rel.sourceSnapshot.name,
    },
    object: {
      id: rel.targetSnapshot.id,
      type: rel.targetSnapshot.type,
      name: rel.targetSnapshot.name,
    },
    predicate,
    confidence: rel.confidence ?? (aiSuggested ? 50 : 100),
    assertedBy: rel.assertedBy ?? (aiSuggested ? 'agent:linker' : 'user:system'),
    notes: rel.notes ?? null,
    evidence: rel.evidence?.map((e): EvidenceInput => ({
      sourceType: e.sourceType,
      snippet: e.snippet,
      sourceUrl: e.sourceUrl,
    })),
  };

  if (needsAssertion) {
    await syncRelationAsAssertion(input);
    return 'asserted';
  }
  await syncRelationAsEdge(input);
  return 'edged';
}

export async function syncSeedRelationsToNeo4j(relations: SeedRelation[]): Promise<{
  asserted: number;
  edged: number;
  failed: number;
  failures: Array<{ id: string; error: string }>;
}> {
  let asserted = 0;
  let edged = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const rel of relations) {
    try {
      const result = await syncOneRelation(rel);
      if (result === 'asserted') asserted++;
      else edged++;
    } catch (err) {
      failures.push({ id: rel.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { asserted, edged, failed: failures.length, failures };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export interface SeedGraphSyncResult {
  entities: {
    selected: number;
    excludedSignals: number;
    synced: number;
    failed: number;
    failures: Array<{ id: string; error: string }>;
  };
  relations: {
    asserted: number;
    edged: number;
    failed: number;
    failures: Array<{ id: string; error: string }>;
  };
}

export async function syncSeedToNeo4j(input: SeedGraphSyncInput): Promise<SeedGraphSyncResult> {
  // Entities first — relation sync MERGEs by subject/object id, so the
  // typed-entity labels need to land before any edge connects them, otherwise
  // the bare `:Entity {id}` from the relation MERGE would lack its specific
  // label (Technology, Company, …).
  const selection = selectSeedProjectionEntities(input);
  const cleanup = await removeExcludedSeedSignalsFromNeo4j(selection.excludedSignalIds);
  const entitySync = await syncSeedEntitiesToNeo4j(selection.entities);
  const entities = {
    ...entitySync,
    selected: selection.entities.length,
    excludedSignals: selection.excludedSignalIds.length,
    failed: entitySync.failed + cleanup.failed,
    failures: [...cleanup.failures, ...entitySync.failures],
  };
  const relations = await syncSeedRelationsToNeo4j(input.relations);
  return { entities, relations };
}
