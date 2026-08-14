#!/usr/bin/env npx tsx

/**
 * Read-only benchmark for the caller-supplied Cypher guard.
 *
 * Measures the incremental cost of policy + EXPLAIN classification + bounded
 * streaming without mutating the target graph. Correctness limits always gate;
 * the local latency budget is opt-in because hosted runners are noisy.
 */

import './load-env-local';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDriver, runRawReadQuery, runReadTransaction } from '../src/lib/graph/neo4j-client';
import { inspectCypherReadQuery, RAW_CYPHER_LIMITS } from '../src/lib/graph/cypher-read-policy';

const DEFAULT_WARMUPS = 3;
const DEFAULT_SAMPLES = 30;
const PREFLIGHT_OVERHEAD_P95_BUDGET_MS = 10;

// `repeat()` is not available on the Neo4j 5.15 baseline used by CI. REDUCE
// creates a deterministic response large enough to exercise the payload cap.
export const PAYLOAD_CAP_QUERY =
  "UNWIND range(1, 100) AS value RETURN value, reduce(payload = '', _ IN range(1, 4096) | payload + 'x') AS payload";

export interface LatencySummary {
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface CypherLatencyCase {
  direct: LatencySummary;
  guarded: LatencySummary;
  overhead: LatencySummary;
}

export interface CypherBenchmarkReport {
  label: string;
  warmups: number;
  samples: number;
  limits: typeof RAW_CYPHER_LIMITS;
  correctness: {
    simpleReadRows: number;
    hundredReadRows: number;
    recordCapRows: number;
    recordCapTruncated: boolean;
    recordCapReasons: string[];
    payloadCapRows: number;
    payloadCapTruncated: boolean;
    payloadCapReasons: string[];
    mutationRejected: boolean;
    nestedCommentMutationRejected: boolean;
  };
  latency: {
    simpleRead: CypherLatencyCase;
    hundredRows: CypherLatencyCase;
  };
  latencyBudget: {
    preflightOverheadP95Ms: number;
    simpleReadPassed: boolean;
    hundredRowsPassed: boolean;
    enforced: boolean;
  };
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function summarizeLatencies(values: number[]): LatencySummary {
  if (values.length === 0) throw new Error('At least one latency sample is required');
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    minMs: rounded(sorted[0]),
    p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

export function evaluateCypherBenchmark(report: CypherBenchmarkReport): string[] {
  const failures: string[] = [];
  const { correctness } = report;
  if (correctness.simpleReadRows !== 1) failures.push(`simple read returned ${correctness.simpleReadRows}, expected 1`);
  if (correctness.hundredReadRows !== 100) {
    failures.push(`100-row read returned ${correctness.hundredReadRows}, expected 100`);
  }
  if (
    correctness.recordCapRows !== RAW_CYPHER_LIMITS.records ||
    !correctness.recordCapTruncated ||
    !correctness.recordCapReasons.includes('record limit')
  ) {
    failures.push('record cap did not stop at the configured limit with explicit truncation metadata');
  }
  if (!correctness.payloadCapTruncated || !correctness.payloadCapReasons.includes('payload limit')) {
    failures.push('payload cap did not emit explicit truncation metadata');
  }
  if (!correctness.mutationRejected) failures.push('plain mutation was not rejected by policy');
  if (!correctness.nestedCommentMutationRejected) {
    failures.push('nested-comment mutation was not rejected by policy');
  }
  if (report.latencyBudget.enforced) {
    if (!report.latencyBudget.simpleReadPassed) {
      failures.push(
        `simple-read preflight overhead p95 ${report.latency.simpleRead.overhead.p95Ms}ms exceeds ${report.latencyBudget.preflightOverheadP95Ms}ms`
      );
    }
    if (!report.latencyBudget.hundredRowsPassed) {
      failures.push(
        `100-row preflight overhead p95 ${report.latency.hundredRows.overhead.p95Ms}ms exceeds ${report.latencyBudget.preflightOverheadP95Ms}ms`
      );
    }
  }
  return failures;
}

function integerArgument(args: string[], flag: string, fallback: number, min: number, max: number): number {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (!raw || raw.startsWith('--') || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function stringArgument(args: string[], flag: string, fallback?: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function measured<T>(operation: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> {
  const started = performance.now();
  const value = await operation();
  return { value, elapsedMs: performance.now() - started };
}

async function runGuarded(query: string) {
  return runRawReadQuery(query, {}, {
    transactionTimeoutMs: RAW_CYPHER_LIMITS.transactionTimeoutMs,
    wallTimeoutMs: RAW_CYPHER_LIMITS.wallTimeoutMs,
    maxRecords: RAW_CYPHER_LIMITS.records,
    maxPayloadBytes: RAW_CYPHER_LIMITS.responseBytes,
    recordMode: 'native',
    metadata: { application: 'radarist', surface: 'graph-cypher-benchmark' },
  });
}

async function measureCase(query: string, warmups: number, samples: number): Promise<CypherLatencyCase> {
  for (let index = 0; index < warmups; index++) {
    await runReadTransaction(query);
    await runGuarded(query);
  }

  const direct: number[] = [];
  const guarded: number[] = [];
  const overhead: number[] = [];
  for (let index = 0; index < samples; index++) {
    let directSample: number;
    let guardedSample: number;
    if (index % 2 === 0) {
      directSample = (await measured(() => runReadTransaction(query))).elapsedMs;
      guardedSample = (await measured(() => runGuarded(query))).elapsedMs;
    } else {
      guardedSample = (await measured(() => runGuarded(query))).elapsedMs;
      directSample = (await measured(() => runReadTransaction(query))).elapsedMs;
    }
    direct.push(directSample);
    guarded.push(guardedSample);
    overhead.push(guardedSample - directSample);
  }

  return {
    direct: summarizeLatencies(direct),
    guarded: summarizeLatencies(guarded),
    overhead: summarizeLatencies(overhead),
  };
}

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const supported = new Set(['--label', '--json', '--warmups', '--samples', '--enforce-latency']);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!supported.has(arg)) throw new Error(`Unknown graph Cypher benchmark argument: ${arg}`);
    if (arg !== '--enforce-latency') index++;
  }

  const label = stringArgument(args, '--label', 'adhoc')!;
  const jsonPath = stringArgument(args, '--json');
  const warmups = integerArgument(args, '--warmups', DEFAULT_WARMUPS, 0, 100);
  const samples = integerArgument(args, '--samples', DEFAULT_SAMPLES, 1, 1_000);
  const enforceLatency = args.includes('--enforce-latency');
  const simpleQuery = 'RETURN 1 AS value';
  const hundredRowsQuery = 'UNWIND range(1, 100) AS value RETURN value';

  try {
    const simple = await runGuarded(simpleQuery);
    const hundred = await runGuarded(hundredRowsQuery);
    const recordCap = await runGuarded('UNWIND range(1, 101) AS value RETURN value');
    const payloadCap = await runGuarded(PAYLOAD_CAP_QUERY);
    // Keep cases serial so they do not distort each other's latency samples.
    const simpleLatency = await measureCase(simpleQuery, warmups, samples);
    const hundredLatency = await measureCase(hundredRowsQuery, warmups, samples);
    const report: CypherBenchmarkReport = {
      label,
      warmups,
      samples,
      limits: RAW_CYPHER_LIMITS,
      correctness: {
        simpleReadRows: simple.nativeRecords?.length ?? 0,
        hundredReadRows: hundred.nativeRecords?.length ?? 0,
        recordCapRows: recordCap.nativeRecords?.length ?? 0,
        recordCapTruncated: recordCap.truncated,
        recordCapReasons: recordCap.truncationReasons,
        payloadCapRows: payloadCap.nativeRecords?.length ?? 0,
        payloadCapTruncated: payloadCap.truncated,
        payloadCapReasons: payloadCap.truncationReasons,
        mutationRejected: !inspectCypherReadQuery('MATCH (n) DELETE n').allowed,
        nestedCommentMutationRejected: !inspectCypherReadQuery(
          'MATCH (n) /* outer /* inner */ DELETE n // */'
        ).allowed,
      },
      latency: { simpleRead: simpleLatency, hundredRows: hundredLatency },
      latencyBudget: {
        preflightOverheadP95Ms: PREFLIGHT_OVERHEAD_P95_BUDGET_MS,
        simpleReadPassed: simpleLatency.overhead.p95Ms <= PREFLIGHT_OVERHEAD_P95_BUDGET_MS,
        hundredRowsPassed: hundredLatency.overhead.p95Ms <= PREFLIGHT_OVERHEAD_P95_BUDGET_MS,
        enforced: enforceLatency,
      },
    };

    const failures = evaluateCypherBenchmark(report);
    console.log(JSON.stringify(report, null, 2));
    if (jsonPath) {
      mkdirSync(dirname(jsonPath), { recursive: true });
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    }
    if (failures.length > 0) throw new Error(`Cypher benchmark failed:\n- ${failures.join('\n- ')}`);
  } finally {
    await closeDriver();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[graph-cypher-benchmark] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
