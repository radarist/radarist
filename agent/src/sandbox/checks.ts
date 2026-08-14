/**
 * Acceptance checks (.impulse/checks.json) — the machine-checkable contract
 * written in mission phase 04. The supervisor runs these via driver exec
 * and NEVER trusts the agent's self-report.
 */
import { z } from 'zod';
import { buildSanitizedShellCommand } from './session.js';
import type { SandboxDriver, SandboxExecUser, SandboxRef } from './types.js';

export const checksFileSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string(),
        story: z.string(),
        files: z.array(z.string()).default([]),
        command: z.string(),
        description: z.string().optional(),
      })
    )
    .min(1),
});
export type ChecksFile = z.infer<typeof checksFileSchema>;
export type Check = ChecksFile['checks'][number];

export interface CheckResult {
  id: string;
  story: string;
  ok: boolean;
  output: string;
}

const CHECK_TIMEOUT_MS = 180_000;
const OUTPUT_TAIL_CHARS = 1_500;

export async function loadChecks(
  driver: SandboxDriver,
  ref: SandboxRef,
  opts?: { user?: SandboxExecUser }
): Promise<Check[] | null> {
  const result = await driver.exec(ref, ['cat', '.impulse/checks.json'], opts);
  if (result.code !== 0) return null;
  try {
    return checksFileSchema.parse(JSON.parse(result.stdout)).checks;
  } catch {
    return null;
  }
}

export async function runChecks(
  driver: SandboxDriver,
  ref: SandboxRef,
  checks: Check[],
  opts?: { user?: SandboxExecUser }
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await driver.exec(ref, ['sh', '-c', buildSanitizedShellCommand(check.command)], {
      timeoutMs: CHECK_TIMEOUT_MS,
      ...opts,
    });
    const combined = `${result.stdout}\n${result.stderr}`.trim();
    results.push({
      id: check.id,
      story: check.story,
      ok: result.code === 0,
      output: combined.length > OUTPUT_TAIL_CHARS ? `…${combined.slice(-OUTPUT_TAIL_CHARS)}` : combined,
    });
  }
  return results;
}

/** Canonical failure text used for stall hashing — stable across runs. */
export function failureFingerprintInput(results: CheckResult[]): string {
  return results
    .filter((r) => !r.ok)
    .map((r) => `${r.id}\n${normalizeOutput(r.output)}`)
    .join('\n---\n');
}

/** Strip volatile tokens (durations, timestamps, ports, hashes) before hashing. */
function normalizeOutput(output: string): string {
  return output
    .replace(/\d+(\.\d+)?(ms|s)\b/g, 'T')
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?/g, 'DATE')
    .replace(/localhost:\d+/g, 'localhost:PORT')
    .replace(/\b[0-9a-f]{7,40}\b/g, 'HASH')
    .replace(/\s+/g, ' ')
    .trim();
}
