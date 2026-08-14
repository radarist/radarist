/**
 * Canonical relation-verb registry.
 *
 * Single source of truth for the relation-type vocabulary and its two
 * derived projections:
 *   1. The Neo4j predicate a relation type maps to (`RELATION_PREDICATE_MAP`
 *      / `resolveNeo4jPredicate`) — previously duplicated as
 *      `RELATION_TYPE_TO_NEO4J` in `sync-relation-to-neo4j.ts` and as the
 *      array in `validation.ts`.
 *   2. The human-readable verb phrase a Neo4j edge type reads as
 *      (`RELATION_VERB_PHRASES` / `relationTypeToVerbPhrase`) — previously
 *      duplicated as `relationToVerb`'s local `verbMap` in `traversal.ts`.
 *
 * The single source of truth for the relation-type union itself is
 * `RelationType` in `src/lib/types/relations.ts`. The `_Exhaustive`
 * compile-time check below fails `npm run typecheck` if a type is added to
 * the union without being mirrored in `RELATION_TYPES_LOWER` here.
 *
 * Design lock: this module imports ONLY `type RelationType` — no cycles,
 * and it must never import `./validation` (validation imports FROM here).
 */

import type { RelationType } from '@/lib/types/relations';

/** The 50 relation types, verbatim from `validation.ts`. */
export const RELATION_TYPES_LOWER = [
  'uses',
  'enables',
  'competes_with',
  'vendor',
  'user',
  'partner',
  'competitor',
  'addresses',
  'requires',
  'aligns_with',
  'supports',
  'owned_by',
  'sponsors',
  'funds',
  'solves',
  'impacts',
  'drives',
  'mentions',
  'documented_in',
  'source',
  'reveals',
  'experiences',
  'invests_in',
  'parent',
  'child',
  'demonstrates',
  'implements',
  'informed_by',
  'about',
  'acquired_by',
  'invested_in',
  'integrates_with',
  'alternative_to',
  'built_on',
  'customer_of',
  'supplier_of',
  'references',
  'supersedes',
  'supplements',
  'cites',
  'related_to',
  // 2026-05-13 — verbs added in the custom-bucket audit.
  'evidences',
  'parallels',
  'narrows_to',
  'complements',
  'compounds',
  'conflicts_with',
  'engages',
  'evaluates',
  'custom',
] as const satisfies readonly RelationType[];

// Compile-time exhaustiveness check — adding to RelationType without updating
// the array becomes a TypeScript error here.
type _Exhaustive = Exclude<RelationType, (typeof RELATION_TYPES_LOWER)[number]>;

const _check: _Exhaustive extends never ? true : never = true;

export const RELATION_TYPES_UPPER: readonly string[] = RELATION_TYPES_LOWER.map((t) => t.toUpperCase());

/** Generic fallback predicate for any relation type without an explicit Neo4j mapping. */
export const GENERIC_PREDICATE = 'RELATED_TO';

/**
 * TOTAL map from every `RelationType` to its Neo4j relationship-type
 * predicate. 19 relation types have a dedicated predicate; the remaining 31
 * (+ `custom`) explicitly resolve to `GENERIC_PREDICATE`.
 */
export const RELATION_PREDICATE_MAP: Record<RelationType, string> = {
  uses: 'USES',
  enables: 'ENABLES',
  competes_with: 'COMPETES_WITH',
  vendor: 'VENDOR',
  user: 'USER',
  partner: 'PARTNER',
  competitor: 'COMPETITOR',
  addresses: 'ADDRESSES',
  requires: 'REQUIRES',
  aligns_with: 'ALIGNS_WITH',
  supports: 'SUPPORTS',
  owned_by: 'OWNED_BY',
  sponsors: 'SPONSORS',
  funds: 'FUNDS',
  solves: 'SOLVES',
  impacts: 'IMPACTS',
  drives: 'DRIVES',
  evaluates: 'EVALUATES',
  custom: GENERIC_PREDICATE,
  mentions: GENERIC_PREDICATE,
  documented_in: GENERIC_PREDICATE,
  source: GENERIC_PREDICATE,
  reveals: GENERIC_PREDICATE,
  experiences: GENERIC_PREDICATE,
  invests_in: GENERIC_PREDICATE,
  parent: GENERIC_PREDICATE,
  child: GENERIC_PREDICATE,
  demonstrates: GENERIC_PREDICATE,
  implements: GENERIC_PREDICATE,
  informed_by: GENERIC_PREDICATE,
  about: GENERIC_PREDICATE,
  acquired_by: GENERIC_PREDICATE,
  invested_in: GENERIC_PREDICATE,
  integrates_with: GENERIC_PREDICATE,
  alternative_to: GENERIC_PREDICATE,
  built_on: GENERIC_PREDICATE,
  customer_of: GENERIC_PREDICATE,
  supplier_of: GENERIC_PREDICATE,
  references: GENERIC_PREDICATE,
  supersedes: GENERIC_PREDICATE,
  supplements: GENERIC_PREDICATE,
  cites: GENERIC_PREDICATE,
  related_to: GENERIC_PREDICATE,
  evidences: GENERIC_PREDICATE,
  parallels: GENERIC_PREDICATE,
  narrows_to: GENERIC_PREDICATE,
  complements: GENERIC_PREDICATE,
  compounds: GENERIC_PREDICATE,
  conflicts_with: GENERIC_PREDICATE,
  engages: GENERIC_PREDICATE,
};

/**
 * Unique Neo4j predicates produced by the canonical Relation write contract.
 *
 * Health checks, fixtures, and benchmarks must derive their claim-bearing
 * edge vocabulary from this projection. Keeping handwritten predicate lists
 * caused `EVALUATES` edges to fall out of operational coverage.
 */
export const CLAIM_RELATION_PREDICATES: readonly string[] = Object.freeze(
  Array.from(new Set(Object.values(RELATION_PREDICATE_MAP)))
);

/**
 * Resolve a (possibly undefined/unknown) relation type to its Neo4j
 * predicate. Falls back to `GENERIC_PREDICATE` for `undefined` and for
 * strings that aren't in the `RelationType` union (legacy event-data path —
 * Inngest event payloads are untyped JSON at the boundary).
 */
export function resolveNeo4jPredicate(relationType: RelationType | string | undefined): string {
  return RELATION_PREDICATE_MAP[relationType as RelationType] ?? GENERIC_PREDICATE;
}

/**
 * Map from a Neo4j relationship-type string to its human-readable verb
 * phrase, verbatim from `traversal.ts`'s `relationToVerb`. String-keyed
 * (not `Record<RelationType, string>`) because 7 keys — `PROVIDES`,
 * `DEVELOPS`, `BENEFITS`, `TARGETS`, `OWNS`, `HAS`, `SIMILAR_TO` — don't
 * correspond to any current `RelationType` member (legacy/display-only
 * verbs kept for backward compatibility).
 */
export const RELATION_VERB_PHRASES: Record<string, string> = {
  SOLVES: 'solves',
  ADDRESSES: 'addresses',
  ENABLES: 'enables',
  IMPLEMENTS: 'implements',
  USES: 'uses',
  PROVIDES: 'provides',
  DEVELOPS: 'develops',
  IMPACTS: 'impacts',
  BENEFITS: 'benefits',
  ALIGNS_WITH: 'aligns with',
  SUPPORTS: 'supports',
  TARGETS: 'targets',
  EXPERIENCES: 'experiences',
  OWNS: 'owns',
  HAS: 'has',
  RELATED_TO: 'is related to',
  SIMILAR_TO: 'is similar to',
  VENDOR: 'is a vendor of',
  PARTNER: 'partners with',
  COMPETES_WITH: 'competes with',
};

/**
 * Convert a Neo4j relation type (edge type, e.g. `"SOLVES"`) to its natural
 * language verb phrase. Falls back to `` `is connected to (${edgeType})` ``
 * for unmapped types, verbatim from `traversal.ts`.
 */
export function relationTypeToVerbPhrase(edgeType: string): string {
  return RELATION_VERB_PHRASES[edgeType] || `is connected to (${edgeType})`;
}
