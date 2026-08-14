/** @jest-environment node */

import {
  PAYLOAD_CAP_QUERY,
  evaluateCypherBenchmark,
  summarizeLatencies,
  type CypherBenchmarkReport,
} from '../graph-cypher-benchmark';
import { RAW_CYPHER_LIMITS } from '../../src/lib/graph/cypher-read-policy';

function validReport(): CypherBenchmarkReport {
  const latency = { minMs: 1, p50Ms: 2, p95Ms: 3, maxMs: 4 };
  return {
    label: 'test',
    warmups: 3,
    samples: 30,
    limits: RAW_CYPHER_LIMITS,
    correctness: {
      simpleReadRows: 1,
      hundredReadRows: 100,
      recordCapRows: RAW_CYPHER_LIMITS.records,
      recordCapTruncated: true,
      recordCapReasons: ['record limit'],
      payloadCapRows: 20,
      payloadCapTruncated: true,
      payloadCapReasons: ['payload limit'],
      mutationRejected: true,
      nestedCommentMutationRejected: true,
    },
    latency: {
      simpleRead: { direct: latency, guarded: latency, overhead: latency },
      hundredRows: { direct: latency, guarded: latency, overhead: latency },
    },
    latencyBudget: {
      preflightOverheadP95Ms: 10,
      simpleReadPassed: true,
      hundredRowsPassed: true,
      enforced: false,
    },
  };
}

describe('graph Cypher benchmark contracts', () => {
  it('uses a payload probe supported by the Neo4j 5.15 CI baseline', () => {
    expect(PAYLOAD_CAP_QUERY).toContain('reduce(');
    expect(PAYLOAD_CAP_QUERY).not.toContain('repeat(');
  });

  it('reports nearest-rank p50/p95 latency summaries', () => {
    expect(summarizeLatencies([4, 1, 3, 2])).toEqual({
      minMs: 1,
      p50Ms: 2,
      p95Ms: 4,
      maxMs: 4,
    });
  });

  it('passes deterministic correctness limits without enforcing noisy latency', () => {
    const report = validReport();
    report.latencyBudget.simpleReadPassed = false;

    expect(evaluateCypherBenchmark(report)).toEqual([]);
  });

  it('fails missing truncation metadata and enforced latency regressions', () => {
    const report = validReport();
    report.correctness.recordCapTruncated = false;
    report.correctness.nestedCommentMutationRejected = false;
    report.latencyBudget.enforced = true;
    report.latencyBudget.hundredRowsPassed = false;

    expect(evaluateCypherBenchmark(report)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('record cap'),
        expect.stringContaining('nested-comment'),
        expect.stringContaining('preflight overhead'),
      ])
    );
  });
});
