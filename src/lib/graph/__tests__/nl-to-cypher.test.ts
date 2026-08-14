/**
 * @file nl-to-cypher.test.ts
 * @description Tests for the NL→Cypher template generator.
 *
 * Pins the NL templates to the entity and relationship vocabulary emitted by
 * the canonical Relation writer.
 */

jest.mock('@/lib/ai/client', () => ({
  generateStructuredContent: jest.fn(),
}));
jest.mock('../service-factory', () => ({
  getGraphService: jest.fn(),
}));

import { generateCypherQuery, isSafeQuery, type ParsedQuery } from '../nl-to-cypher';
import { CLAIM_RELATION_PREDICATES } from '../relation-registry';

function parsed(intent: ParsedQuery['intent']): ParsedQuery {
  return {
    intent,
    entities: [],
    normalizedQuery: 'q',
    confidence: 90,
  };
}

const ALL_INTENTS: ParsedQuery['intent'][] = [
  'find_path',
  'find_neighbors',
  'find_by_type',
  'impact_analysis',
  'solution_discovery',
  'alignment_check',
  'vendor_search',
  'gap_analysis',
  'statistics',
  'custom_query',
];

function staticRelationshipTypes(cypher: string): string[] {
  return Array.from(cypher.matchAll(/\[(?:[A-Za-z_][A-Za-z0-9_]*)?:([A-Z_]+(?:\|[A-Z_]+)*)/g)).flatMap(
    (match) => match[1].split('|')
  );
}

describe('generateCypherQuery — canonical graph vocabulary', () => {
  it('uses the camelCase entity types stored by entity writers', () => {
    const { cypher } = generateCypherQuery(parsed('gap_analysis'));

    expect(cypher).toContain("'orgUnit'");
    expect(cypher).toContain("'painPoint'");
    expect(cypher).not.toMatch(/'org_unit'|'pain_point'/);
  });

  it('uses the canonical painPoint discriminator for solution discovery', () => {
    const { cypher } = generateCypherQuery({
      ...parsed('solution_discovery'),
      entities: [{ name: 'slow deploys', role: 'subject' }],
    });
    expect(cypher).toContain("'painPoint'");
    expect(cypher).not.toContain("'pain_point'");
  });

  it('contains no static relationship type outside the Relation writer predicates', () => {
    const used = ALL_INTENTS.flatMap((intent) => staticRelationshipTypes(generateCypherQuery(parsed(intent)).cypher));

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((type) => !CLAIM_RELATION_PREDICATES.includes(type))).toEqual([]);
  });

  it('matches vendor relations by typed endpoints regardless of stored direction', () => {
    const { cypher } = generateCypherQuery(parsed('vendor_search'));

    expect(cypher).toContain(
      "MATCH (vendor:Entity {entityType: 'company'})-[vendorRel:VENDOR]-(tech)"
    );
    expect(cypher).not.toContain('[vendorRel:VENDOR]->');
    expect(cypher).not.toContain('<-[vendorRel:VENDOR]');
    expect(cypher).not.toMatch(/PROVIDES|DEVELOPS|OFFERS/);
  });

  it('queries experiences through its generic predicate and semantic discriminator', () => {
    const { cypher } = generateCypherQuery(parsed('gap_analysis'));

    expect(cypher).toContain('(org:Entity)-[painRel:RELATED_TO]-(pain:Entity)');
    expect(cypher).toContain("painRel.sourceRelationType = 'experiences'");
    expect(cypher).not.toMatch(/\bEXPERIENCES\b|\bHAS\b/);
  });
});

describe('generateCypherQuery — current-fact contract', () => {
  it.each([
    'find_path',
    'find_neighbors',
    'impact_analysis',
    'solution_discovery',
    'alignment_check',
    'vendor_search',
    'gap_analysis',
  ] as const)('excludes invalidated and rejected edges for %s', (intent) => {
    const { cypher } = generateCypherQuery(parsed(intent));
    expect(cypher).toContain('t_invalidated IS NULL');
    expect(cypher).toContain("claimStatus, 'curated'");
    expect(cypher).toContain("<> 'rejected'");
  });
});

describe('isSafeQuery', () => {
  it('rejects destructive queries', () => {
    expect(isSafeQuery('MATCH (n) DETACH DELETE n')).toBe(false);
  });

  it('accepts read-only queries', () => {
    expect(isSafeQuery('MATCH (n) RETURN n LIMIT 5')).toBe(true);
  });
});
