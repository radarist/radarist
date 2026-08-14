/** @jest-environment node */

import {
  COUNT_DIFF_PAIRS,
  LIVE_CLAIM_COVERAGE_CYPHER,
  classifyMissingClaimEdges,
  countExpectedSignalProjections,
  evaluateClaimCoverageRow,
  evaluateRelationTripleLockAudit,
  evaluateRadarPlacementPairLockAudit,
  evaluateRadarPlacementGraphIntegrity,
} from '../graph-health';

describe('blank-workspace vacuous coverage (LOCAL-009)', () => {
  it('treats a fully empty graph as a warning, not a violation', () => {
    // A genuinely blank workspace has zero relationships of any kind; the
    // launcher must be able to reach healthy without seeded data.
    expect(
      classifyMissingClaimEdges({
        claimBearingEdgeCount: 0,
        claimCount: 0,
        assertionCount: 0,
      })
    ).toBe('vacuous');
  });

  it('stays vacuous with structural edges only (radars/placements, zero relations)', () => {
    expect(classifyMissingClaimEdges({ claimBearingEdgeCount: 0, claimCount: 0, assertionCount: 0 })).toBe('vacuous');
  });

  it.each([
    ['claims exist without materialized edges', { claimCount: 2, assertionCount: 0 }],
    ['assertions exist without materialized edges', { claimCount: 0, assertionCount: 3 }],
  ])('still fails closed when %s', (_label, partial) => {
    expect(classifyMissingClaimEdges({ claimBearingEdgeCount: 0, ...partial })).toBe('violation');
  });

  it('does not classify at all when claim-bearing edges exist', () => {
    expect(
      classifyMissingClaimEdges({
        claimBearingEdgeCount: 4,
        claimCount: 4,
        assertionCount: 1,
      })
    ).toBe('measurable');
  });
});

describe('graph health live claim coverage contract', () => {
  it('filters invalidated edges before every aggregate is calculated', () => {
    expect(LIVE_CLAIM_COVERAGE_CYPHER).toMatch(/WHERE type\(r\) IN \$claimTypes AND r\.t_invalidated IS NULL\s+RETURN/);
    expect(LIVE_CLAIM_COVERAGE_CYPHER.match(/t_invalidated/g)).toHaveLength(1);
  });

  it('keeps all-time and recent coverage independently measurable', () => {
    expect(
      evaluateClaimCoverageRow({
        total: 4,
        withTemporal: 3,
        withConfidence: 4,
        recentTotal: 0,
        recentWithTemporal: 0,
        recentWithConfidence: 0,
      })
    ).toEqual({
      temporalAll: 0.75,
      confidenceAll: 1,
      temporalRecent: null,
      confidenceRecent: null,
      total: 4,
      recentTotal: 0,
    });
  });
});

describe('Signal count-diff projection policy', () => {
  it('keeps the Signal health pair locked to the projection-aware counter', () => {
    expect(COUNT_DIFF_PAIRS.filter((pair) => pair.collection === 'signals')).toEqual([
      { collection: 'signals', label: 'Signal' },
    ]);
    expect(
      countExpectedSignalProjections({
        signals: [
          { id: 'approved', status: 'Approved' },
          { id: 'imported', status: 'Imported' },
          { id: 'detected', status: 'Detected' },
          { id: 'relation-retained', status: 'Validated' },
          { id: 'link-retained', status: 'Rejected' },
        ],
        relations: [
          {
            id: 'relation-1',
            sourceSnapshot: { id: 'relation-retained', type: 'signal' },
            targetSnapshot: { id: 'company-1', type: 'company' },
          },
        ],
        documentLinks: [{ id: 'link-1', entityType: 'signal', entityId: 'link-retained' }],
      })
    ).toBe(4);
  });
});

describe('relation triple-lock health gate', () => {
  it('passes a healthy audit and reports every drift category concisely', () => {
    expect(
      evaluateRelationTripleLockAudit({
        missingLockKeys: [],
        duplicateRelationKeys: [],
        mismatchedLocks: [],
        orphanLockKeys: [],
        healthy: true,
      })
    ).toEqual([]);

    expect(
      evaluateRelationTripleLockAudit({
        missingLockKeys: ['missing'],
        duplicateRelationKeys: [{ key: 'duplicate', relationIds: ['r1', 'r2'] }],
        mismatchedLocks: [{ key: 'mismatch', expectedRelationIds: ['r3'], actualRelationId: 'r4' }],
        orphanLockKeys: ['orphan'],
        healthy: false,
      })
    ).toEqual(['Relation triple-lock drift: 1 missing, 1 duplicate triples, 1 mismatched, 1 orphan locks']);
  });
});

describe('GRAPH-066 pair-lock health (graph:health)', () => {
  it('a healthy pair-lock audit produces no violations', () => {
    expect(
      evaluateRadarPlacementPairLockAudit({
        missingLockKeys: [],
        duplicatePairKeys: [],
        mismatchedLocks: [],
        orphanLockKeys: [],
        healthy: true,
      })
    ).toEqual([]);
  });

  it('drift produces one bounded, actionable violation line', () => {
    expect(
      evaluateRadarPlacementPairLockAudit({
        missingLockKeys: ['k1'],
        duplicatePairKeys: [{ key: 'k2', placementIds: ['p1', 'p2'] }],
        mismatchedLocks: [{ key: 'k3', expectedPlacementIds: ['p3'], actualPlacementId: 'p4' }],
        orphanLockKeys: ['k4'],
        healthy: false,
      })
    ).toEqual(['RadarPlacement pair-lock drift: 1 missing, 1 duplicate pairs, 1 mismatched, 1 orphan locks']);
  });

  it('Neo4j pair integrity flags every cardinality/uniqueness class', () => {
    expect(
      evaluateRadarPlacementGraphIntegrity({
        duplicatePairKeys: 0,
        missingPairKeys: 0,
        duplicatePlacementIds: 0,
        badPlacesCardinality: 0,
        badOnRadarCardinality: 0,
      })
    ).toEqual([]);
    const violations = evaluateRadarPlacementGraphIntegrity({
      duplicatePairKeys: 1,
      missingPairKeys: 2,
      duplicatePlacementIds: 3,
      badPlacesCardinality: 4,
      badOnRadarCardinality: 5,
    });
    expect(violations).toHaveLength(5);
    expect(violations.join(' ')).toContain('duplicate RadarPlacement.pairKey');
    expect(violations.join(' ')).toContain('without exactly one PLACES edge');
    expect(violations.join(' ')).toContain('without exactly one ON_RADAR edge');
  });
});
