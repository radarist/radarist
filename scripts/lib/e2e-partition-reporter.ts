import { join } from 'node:path';

import type { ReporterDescription } from '@playwright/test';

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'run';
}

/**
 * Add a JSON reporter only when the exact-partition orchestrator owns an output
 * directory. Ordinary lane commands retain their current reporter behavior.
 */
export function partitionAwareReporters(
  lane: string,
  fallback: readonly ReporterDescription[]
): ReporterDescription[] {
  const rawDirectory = process.env.E2E_PARTITION_RAW_DIR;
  if (!rawDirectory) return [...fallback];
  const phase =
    process.env.E2E_PARTITION_PHASE ?? process.env.RCA_PHASE ?? process.env.GENERIC_E2E_MODE ?? 'full';
  const outputFile = join(
    rawDirectory,
    `${safeSegment(lane)}-${safeSegment(phase)}-${process.pid}.json`
  );
  return [...fallback, ['json', { outputFile }]];
}
