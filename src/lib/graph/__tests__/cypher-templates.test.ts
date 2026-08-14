/**
 * @file cypher-templates.test.ts
 * @description Pins the B0 two-field confidence authority read rule
 * (COALESCE(effectiveConfidence, confidence, <site default>)) across the
 * cypher-templates constants + buildQuery helper.
 */

import {
  DISCOVER_USE_CASES,
  FIND_INITIATIVES_FOR_PAIN_POINT,
  FIND_PAIN_POINTS_FOR_ORG_UNIT,
  GET_NEIGHBORS,
  FIND_PATH_DETAILED,
  FIND_SOLUTIONS_FOR_PAIN_POINT,
  FIND_TECHNOLOGIES_WITHOUT_PROTOTYPES,
  FIND_TECHNOLOGIES_FOR_STRATEGY,
  FIND_TECHNOLOGY_IMPACT,
  FIND_UNADDRESSED_PAIN_POINTS,
  FIND_VENDORS_FOR_STRATEGY,
  GET_RELATIONSHIP_STATS,
  buildQuery,
} from '../cypher-templates';
import * as cypherTemplates from '../cypher-templates';
import { CLAIM_RELATION_PREDICATES } from '../relation-registry';

function staticRelationshipTypes(cypher: string): string[] {
  return Array.from(cypher.matchAll(/\[(?:[A-Za-z_][A-Za-z0-9_]*)?:([A-Z_]+(?:\|[A-Z_]+)*)/g)).flatMap(
    (match) => match[1].split('|')
  );
}

describe('GET_NEIGHBORS — confidence projection + ordering honour effectiveConfidence', () => {
  it('projects confidence via a 2-arg COALESCE (no third default)', () => {
    expect(GET_NEIGHBORS).toContain('COALESCE(r.effectiveConfidence, r.confidence) AS confidence');
  });

  it('orders by the same COALESCE expression', () => {
    expect(GET_NEIGHBORS).toContain('ORDER BY COALESCE(r.effectiveConfidence, r.confidence) DESC');
  });

  it('excludes invalidated and rejected current facts', () => {
    expect(GET_NEIGHBORS).toContain('r.t_invalidated IS NULL');
    expect(GET_NEIGHBORS).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
  });
});

describe('FIND_PATH_DETAILED — per-relationship confidence honours effectiveConfidence', () => {
  it('projects confidence via a 2-arg COALESCE', () => {
    expect(FIND_PATH_DETAILED).toContain('confidence: coalesce(r.effectiveConfidence, r.confidence),');
  });
});

describe('FIND_SOLUTIONS_FOR_PAIN_POINT — reduce() input list is coalesced, formula unchanged', () => {
  it('coalesces each relationship confidence in the input list', () => {
    expect(FIND_SOLUTIONS_FOR_PAIN_POINT).toContain(
      '[r IN relationships(path) | coalesce(r.effectiveConfidence, r.confidence)] AS confidences'
    );
  });

  it('keeps the reduce() formula unchanged', () => {
    expect(FIND_SOLUTIONS_FOR_PAIN_POINT).toContain('reduce(c = 100, conf IN confidences | c * conf / 100)');
  });
});

describe('FIND_TECHNOLOGIES_FOR_STRATEGY — reduce() input list is coalesced, formula unchanged', () => {
  it('coalesces each relationship confidence in the input list', () => {
    expect(FIND_TECHNOLOGIES_FOR_STRATEGY).toContain(
      '[r IN relationships(path) | coalesce(r.effectiveConfidence, r.confidence)] AS confidences'
    );
  });

  it('keeps the reduce() formula unchanged', () => {
    expect(FIND_TECHNOLOGIES_FOR_STRATEGY).toContain('reduce(c = 100, conf IN confidences | c * conf / 100)');
  });
});

describe('buildQuery — minConfidence filter + orderBy enum mapping', () => {
  it('filters minConfidence via a 2-arg COALESCE (no third default)', () => {
    const { query, params } = buildQuery('MATCH (source)-[r]->(target)\nRETURN target', { minConfidence: 60 });
    expect(query).toContain('coalesce(r.effectiveConfidence, r.confidence) >= $minConfidence');
    expect(params.minConfidence).toBe(60);
  });

  it('filters curated relations on the property writers actually set', () => {
    const { query } = buildQuery('MATCH (source)-[r]->(target)\nRETURN target', { curatedOnly: true });
    expect(query).toContain("r.claimStatus = 'curated'");
  });

  it("maps the 'r.confidence' orderBy enum token to the COALESCE expression", () => {
    const { query } = buildQuery('MATCH (source)-[r]->(target)\nRETURN target', { orderBy: 'r.confidence' });
    expect(query).toContain('ORDER BY coalesce(r.effectiveConfidence, r.confidence)');
  });

  it('leaves non-confidence orderBy tokens unchanged', () => {
    const { query } = buildQuery('MATCH (n)\nRETURN n', { orderBy: 'n.name' });
    expect(query).toContain('ORDER BY n.name');
  });
});

describe('current graph statistics', () => {
  it('does not count invalidated or rejected relationships', () => {
    expect(GET_RELATIONSHIP_STATS).toContain('r.t_invalidated IS NULL');
    expect(GET_RELATIONSHIP_STATS).toContain("coalesce(r.claimStatus, 'curated') <> 'rejected'");
  });
});

describe('canonical Relation-writer query contract', () => {
  const staticTemplates = Object.values(cypherTemplates).filter(
    (value): value is string => typeof value === 'string'
  );

  it('contains no unsupported static relationship type', () => {
    // These templates query only projected Relation edges, so there is no
    // graph-native relationship allowlist here by design.
    const used = staticTemplates.flatMap(staticRelationshipTypes);

    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((type) => !CLAIM_RELATION_PREDICATES.includes(type))).toEqual([]);
  });

  it('uses the camelCase entity discriminators emitted by entity writers', () => {
    const allTemplates = staticTemplates.join('\n');

    expect(allTemplates).not.toMatch(/'org_unit'|'pain_point'/);
    expect(allTemplates).toContain("entityType: 'orgUnit'");
    expect(allTemplates).toContain("entityType: 'painPoint'");
  });

  it('uses semantic guards for RelationTypes projected as RELATED_TO', () => {
    expect(FIND_PAIN_POINTS_FOR_ORG_UNIT).toContain("rel.sourceRelationType = 'experiences'");
    expect(FIND_UNADDRESSED_PAIN_POINTS).toContain("painRel.sourceRelationType = 'experiences'");
    expect(DISCOVER_USE_CASES).toContain("similarRel.sourceRelationType = 'alternative_to'");
  });

  it('matches semantic relations by typed endpoints regardless of stored direction', () => {
    expect(FIND_VENDORS_FOR_STRATEGY).toContain(
      "(strategy)-[:ALIGNS_WITH]-(tech:Entity {entityType: 'technology'})-[vendorRel:VENDOR]-(company"
    );
    expect(FIND_SOLUTIONS_FOR_PAIN_POINT).toContain('(pain)-[:SOLVES*1..$maxDepth]-(tech');
    expect(FIND_TECHNOLOGIES_FOR_STRATEGY).toContain('(strategy)-[:ALIGNS_WITH*1..$maxDepth]-(tech');
    expect(FIND_INITIATIVES_FOR_PAIN_POINT).toContain('(pain)-[initiativeRel:DRIVES]-(initiative');
    expect(FIND_TECHNOLOGIES_WITHOUT_PROTOTYPES).toContain('(tech)-[prototypeRel:SUPPORTS]-(proto');
    expect(FIND_TECHNOLOGY_IMPACT).toContain('(tech)-[:REQUIRES]-(useCase');
    expect(FIND_TECHNOLOGY_IMPACT).toContain('(useCase)-[:ADDRESSES]-(:Entity');
    expect(FIND_PAIN_POINTS_FOR_ORG_UNIT).toContain('(org)-[:RELATED_TO*1..$maxDepth]-(pain');
    expect(FIND_UNADDRESSED_PAIN_POINTS).toContain('(pain)-[addressRel:ADDRESSES]-(initiative');
  });
});
