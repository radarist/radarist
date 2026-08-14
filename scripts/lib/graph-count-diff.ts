/**
 * P3-B graph:health v2 — Firestore↔Neo4j count-diff gate (pure logic).
 *
 * Firestore is the source of truth; Neo4j is the sync target. A per-type
 * divergence above the threshold means the sync pipeline is dropping writes
 * (Neo4j low) or retaining ghosts (Neo4j high) — both are drift and both
 * fail the gate. Live count collection lives in scripts/graph-health.ts
 * behind GRAPH_HEALTH_COUNT_DIFF=1 (needs both stores up).
 */

export interface CountDiffEntry {
  /** Entity type / Neo4j label (e.g. 'Company'). */
  type: string;
  /** Document count in the Firestore collection. */
  firestore: number;
  /** Node count for the Neo4j label. */
  neo4j: number;
}

/** Maximum tolerated relative divergence (5%). */
export const COUNT_DIFF_THRESHOLD = 0.05;

/**
 * Returns one human-readable violation string per entry whose relative
 * divergence exceeds the threshold. Divergence is |firestore − neo4j|
 * relative to the larger of the two counts (so ghost-heavy AND drop-heavy
 * drift are measured symmetrically); both-zero is in sync.
 */
export function evaluateCountDiff(entries: CountDiffEntry[], threshold: number = COUNT_DIFF_THRESHOLD): string[] {
  const violations: string[] = [];
  for (const { type, firestore, neo4j } of entries) {
    const denominator = Math.max(firestore, neo4j);
    if (denominator === 0) continue; // both empty — in sync
    const divergence = Math.abs(firestore - neo4j) / denominator;
    if (divergence > threshold) {
      violations.push(
        `Count diff ${type}: Firestore=${firestore} vs Neo4j=${neo4j} ` +
          `(${(divergence * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}%)`
      );
    }
  }
  return violations;
}
