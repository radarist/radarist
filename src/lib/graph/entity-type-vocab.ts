/**
 * @file entity-type-vocab.ts
 * @description entityType vocabulary normalization for graph READS.
 *
 * The domain type union (`TransformationEntityType`) uses snake_case for
 * `org_unit` / `pain_point`, but every graph WRITER (sync-entity-to-neo4j,
 * entity factory sync) stores the camelCase forms `orgUnit` / `painPoint` on
 * the node's `entityType` property. Readers that filtered on the snake_case
 * vocabulary matched 0 of the 91 live nodes (H2).
 *
 * Fix lives at the read boundary: expand any requested entityType to the full
 * alias set (canonical camelCase first, legacy snake_case kept for any
 * historical nodes) before it reaches Cypher / the Firestore fallback filter.
 *
 * Dependency-free (pure data + functions) so it is safe to import anywhere.
 */

import type { EntityType } from '@/lib/types';

/**
 * The specific Neo4j label every entity projection carries alongside the
 * generic `:Entity` (`MERGE (e:Entity:${label} {id: …})` in
 * `sync-entity-to-neo4j.ts`).
 *
 * Lives here rather than next to a single consumer because two very different
 * readers need the same vocabulary: the entity deleter isolates a colliding ID
 * by label, and business queries admit a traversal only when every node on the
 * path is a canonical business entity (GRAPH-062).
 */
export const ENTITY_TYPE_GRAPH_LABEL: Record<EntityType, string> = {
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

/**
 * Labels that identify a node as a first-class domain entity.
 *
 * Deliberately the SPECIFIC labels and not the generic `:Entity`: bookkeeping
 * nodes (`:Session`, `:Assertion`, `:ProactiveInsight`, `:Episode`, `:Chunk`,
 * `:Concept`, `:CommunityReport`, …) are exactly what a business traversal must
 * refuse to walk through, and a projection that has lost its specific label is
 * a repairable defect rather than something to silently admit into a
 * recommendation.
 */
export const BUSINESS_ENTITY_GRAPH_LABELS: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(ENTITY_TYPE_GRAPH_LABEL)))
);

/** camelCase-canonical alias sets, keyed by every accepted spelling. */
const ENTITY_TYPE_ALIASES: Record<string, readonly string[]> = {
  org_unit: ['orgUnit', 'org_unit'],
  orgUnit: ['orgUnit', 'org_unit'],
  pain_point: ['painPoint', 'pain_point'],
  painPoint: ['painPoint', 'pain_point'],
};

/**
 * Expand entityType filter values to accept both the camelCase writer
 * vocabulary (canonical) and the legacy snake_case domain vocabulary.
 * Types without aliases pass through unchanged. Order-preserving, deduped.
 */
export function expandEntityTypes(types: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const type of types) {
    for (const alias of ENTITY_TYPE_ALIASES[type] ?? [type]) {
      if (!expanded.includes(alias)) {
        expanded.push(alias);
      }
    }
  }
  return expanded;
}
