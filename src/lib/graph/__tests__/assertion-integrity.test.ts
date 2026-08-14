/** @jest-environment node */

import { ASSERTION_STRUCTURAL_DRIFT_CYPHER, countAssertionStructuralDrift } from '../assertion-integrity';
import { runReadTransaction } from '../neo4j-client';

jest.mock('../neo4j-client', () => ({
  runReadTransaction: jest.fn(),
}));

const mockRunReadTransaction = runReadTransaction as jest.MockedFunction<typeof runReadTransaction>;
const READ_SUMMARY = {
  counters: {
    nodesCreated: 0,
    nodesDeleted: 0,
    relationshipsCreated: 0,
    relationshipsDeleted: 0,
    propertiesSet: 0,
  },
  queryType: 'r',
  resultAvailableAfter: 0,
  resultConsumedAfter: 0,
};

describe('Assertion structural integrity diagnostic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is read-only and checks exact role cardinality against scalar topology', () => {
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).not.toMatch(/\b(?:CREATE|DELETE|DETACH|MERGE|REMOVE|SET)\b/i);
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(subjects) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(objects) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(predicates) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('size(actors) <> 1');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain('(p:RelationType) | p.name');
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain("coalesce(a.subjectId, '') = ''");
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain("coalesce(head(subjects), '') = ''");
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain("coalesce(a.predicate, '') = ''");
    expect(ASSERTION_STRUCTURAL_DRIFT_CYPHER).toContain("coalesce(head(predicates), '') = ''");
  });

  it('uses the read transaction boundary and returns the measured count', async () => {
    mockRunReadTransaction.mockResolvedValue({ records: [{ c: 73 }], summary: READ_SUMMARY });

    await expect(countAssertionStructuralDrift()).resolves.toBe(73);
    expect(mockRunReadTransaction).toHaveBeenCalledWith(ASSERTION_STRUCTURAL_DRIFT_CYPHER);
  });

  it('returns zero for an empty diagnostic result', async () => {
    mockRunReadTransaction.mockResolvedValue({ records: [], summary: READ_SUMMARY });

    await expect(countAssertionStructuralDrift()).resolves.toBe(0);
  });
});
