/**
 * Golden tests for the canonical relation-verb registry.
 *
 * These fixtures are frozen from the OLD semantics (three separate copies
 * previously living in `validation.ts`, `traversal.ts`, and
 * `sync-relation-to-neo4j.ts`'s `RELATION_TYPE_TO_NEO4J[t] || 'RELATED_TO'`).
 * The registry centralizes them; this test proves the centralization is
 * behavior-preserving — every relation type must resolve to the exact same
 * Neo4j predicate and verb phrase as before.
 *
 * @jest-environment node
 */

import {
  CLAIM_RELATION_PREDICATES,
  RELATION_TYPES_LOWER,
  RELATION_PREDICATE_MAP,
  resolveNeo4jPredicate,
  relationTypeToVerbPhrase,
} from '../relation-registry';

const GOLDEN: Record<string, string> = {
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
  custom: 'RELATED_TO',
  mentions: 'RELATED_TO',
  documented_in: 'RELATED_TO',
  source: 'RELATED_TO',
  reveals: 'RELATED_TO',
  experiences: 'RELATED_TO',
  invests_in: 'RELATED_TO',
  parent: 'RELATED_TO',
  child: 'RELATED_TO',
  demonstrates: 'RELATED_TO',
  implements: 'RELATED_TO',
  informed_by: 'RELATED_TO',
  about: 'RELATED_TO',
  acquired_by: 'RELATED_TO',
  invested_in: 'RELATED_TO',
  integrates_with: 'RELATED_TO',
  alternative_to: 'RELATED_TO',
  built_on: 'RELATED_TO',
  customer_of: 'RELATED_TO',
  supplier_of: 'RELATED_TO',
  references: 'RELATED_TO',
  supersedes: 'RELATED_TO',
  supplements: 'RELATED_TO',
  cites: 'RELATED_TO',
  related_to: 'RELATED_TO',
  evidences: 'RELATED_TO',
  parallels: 'RELATED_TO',
  narrows_to: 'RELATED_TO',
  complements: 'RELATED_TO',
  compounds: 'RELATED_TO',
  conflicts_with: 'RELATED_TO',
  engages: 'RELATED_TO',
};

it('resolves all 50 relation types to their frozen Neo4j predicates (golden)', () => {
  expect(Object.fromEntries(RELATION_TYPES_LOWER.map((t) => [t, resolveNeo4jPredicate(t)]))).toEqual(GOLDEN);
});
it('collapses exactly 32 values to RELATED_TO (31 legacy + custom)', () => {
  expect(Object.values(RELATION_PREDICATE_MAP).filter((v) => v === 'RELATED_TO')).toHaveLength(32);
});
it('exports the unique canonical claim predicates used by health and benchmark gates', () => {
  expect(CLAIM_RELATION_PREDICATES).toContain('EVALUATES');
  expect(CLAIM_RELATION_PREDICATES.filter((predicate) => predicate === 'RELATED_TO')).toHaveLength(1);
  expect(CLAIM_RELATION_PREDICATES).toHaveLength(new Set(Object.values(RELATION_PREDICATE_MAP)).size);
});
it('falls back to RELATED_TO for undefined and unknown strings (legacy event-data path)', () => {
  expect(resolveNeo4jPredicate(undefined)).toBe('RELATED_TO');
  expect(resolveNeo4jPredicate('nonsense')).toBe('RELATED_TO');
});
it('verb phrases match the legacy traversal map and fall back verbatim', () => {
  expect(relationTypeToVerbPhrase('SOLVES')).toBe('solves');
  expect(relationTypeToVerbPhrase('VENDOR')).toBe('is a vendor of');
  expect(relationTypeToVerbPhrase('WEIRD')).toBe('is connected to (WEIRD)');
});
