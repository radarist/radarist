/**
 * @jest-environment node
 *
 * P3-B graph:health v2 count-diff gate: Firestore (source of truth) vs Neo4j
 * per-type entity counts must not diverge by more than 5%. Pure-logic tests —
 * the live collection happens in scripts/graph-health.ts behind
 * GRAPH_HEALTH_COUNT_DIFF=1.
 */

import { COUNT_DIFF_THRESHOLD, evaluateCountDiff } from '../lib/graph-count-diff';

describe('evaluateCountDiff (P3-B count-diff gate)', () => {
  it('exports a 5% default threshold', () => {
    expect(COUNT_DIFF_THRESHOLD).toBe(0.05);
  });

  it('passes when counts match exactly', () => {
    expect(
      evaluateCountDiff([
        { type: 'Company', firestore: 100, neo4j: 100 },
        { type: 'Technology', firestore: 771, neo4j: 771 },
      ])
    ).toEqual([]);
  });

  it('passes divergence at or below the threshold', () => {
    expect(evaluateCountDiff([{ type: 'Company', firestore: 100, neo4j: 95 }])).toEqual([]);
    expect(evaluateCountDiff([{ type: 'Company', firestore: 100, neo4j: 105 }])).toEqual([]);
  });

  it('fails divergence above the threshold, naming the type and both counts', () => {
    const violations = evaluateCountDiff([{ type: 'Signal', firestore: 200, neo4j: 180 }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('Signal');
    expect(violations[0]).toContain('200');
    expect(violations[0]).toContain('180');
  });

  it('fails when Neo4j has MORE than Firestore (ghost nodes are drift too)', () => {
    expect(evaluateCountDiff([{ type: 'Company', firestore: 100, neo4j: 120 }])).toHaveLength(1);
  });

  it('treats both-empty as in sync, but flags nodes with no Firestore source', () => {
    expect(evaluateCountDiff([{ type: 'Prototype', firestore: 0, neo4j: 0 }])).toEqual([]);
    expect(evaluateCountDiff([{ type: 'Prototype', firestore: 0, neo4j: 3 }])).toHaveLength(1);
  });

  it('honors a custom threshold', () => {
    const entries = [{ type: 'Company', firestore: 100, neo4j: 85 }];
    expect(evaluateCountDiff(entries, 0.2)).toEqual([]);
    expect(evaluateCountDiff(entries, 0.1)).toHaveLength(1);
  });
});
