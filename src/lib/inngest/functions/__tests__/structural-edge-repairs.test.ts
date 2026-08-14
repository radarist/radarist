import { STRUCTURAL_EDGE_REPAIRS } from '../structural-edge-repairs';

const EXPECTED_RELATIONSHIPS = ['ABOUT', 'BELONGS_TO', 'CONTAINS', 'EXECUTED', 'ON_RADAR', 'PLACES'];
const ON_CREATE_PROPERTIES = [
  'assertedConfidence',
  'confidence',
  'createdAt',
  'effectiveConfidence',
  't_observed',
  't_valid',
];

describe('structural reconciliation edge repairs', () => {
  it('owns exactly the six structural edge classes repaired by both reconciliation paths', () => {
    expect(STRUCTURAL_EDGE_REPAIRS.map(({ relationship }) => relationship).sort()).toEqual(EXPECTED_RELATIONSHIPS);
  });

  it.each(STRUCTURAL_EDGE_REPAIRS)('$relationship mints metadata only on creation', ({ cypher }) => {
    const onCreateStart = cypher.indexOf('ON CREATE SET');
    const returnStart = cypher.indexOf('RETURN count(*) AS fixed');
    expect(onCreateStart).toBeGreaterThan(cypher.indexOf('MERGE'));
    expect(returnStart).toBeGreaterThan(onCreateStart);

    const onCreateClause = cypher.slice(onCreateStart, returnStart);
    const properties = [...onCreateClause.matchAll(/edge\.([A-Za-z_]+)\s*=/g)].map((match) => match[1]).sort();
    expect(properties).toEqual(ON_CREATE_PROPERTIES);

    const outsideOnCreate = `${cypher.slice(0, onCreateStart)}${cypher.slice(returnStart)}`;
    expect(outsideOnCreate).not.toMatch(/\bSET\s+edge\./);
    expect(cypher).not.toContain('ON MATCH SET');
    expect(cypher).not.toMatch(
      /edge\.(?:assertedBy|claimStatus|aiSuggested|relationId|claimId|feedbackDelta|corroborationNudge)\s*=/
    );
  });

  it.each(STRUCTURAL_EDGE_REPAIRS)('$relationship is a bounded idempotent MERGE', ({ relationship, cypher }) => {
    expect(cypher).toContain('WHERE');
    expect(cypher).toMatch(/\bNOT\s*\(/);
    expect(cypher).toContain(`MERGE`);
    expect(cypher).toContain(`[edge:${relationship}]`);
    expect(cypher).not.toMatch(/\bCREATE\s*\([^)]*\)-\[edge:/);
    expect(cypher.match(new RegExp(`:${relationship}\\b`, 'g'))).toHaveLength(2);
  });
});
