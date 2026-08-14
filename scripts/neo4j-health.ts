#!/usr/bin/env npx tsx
/**
 * LOCAL-011 — profile-aware Neo4j health gate.
 *
 *   npm run neo4j:health                          # default runtime profile
 *   npm run neo4j:health -- --profile selftest    # selftest runtime profile
 *   RADARIST_LOCAL_RUNTIME_PORT_OFFSET=20 \
 *   RADARIST_LOCAL_RUNTIME_NAME_SUFFIX=rc2 \
 *     npm run neo4j:health                        # shifted retained profile
 *
 * The command resolves exactly one runtime profile through the canonical
 * local-runtime authority, displays the selected loopback target and Docker
 * identity (never credentials), verifies the container belongs to that
 * profile, and only then probes the profile's own HTTP and Bolt ports. A
 * missing, ambiguous, mismatched, foreign-bound, or unavailable selection
 * fails closed and never falls back to another Neo4j instance.
 *
 * Exit codes: 0 healthy, 1 selection valid but target unhealthy/unavailable,
 * 2 invalid selection or usage.
 */
import { spawnSync } from 'node:child_process';
import type { CommandRunner } from './benchmark/snapshot';
import {
  checkNeo4jHealth,
  resolveNeo4jHealthSelection,
  type Neo4jHealthReport,
} from './lib/neo4j-health-target';

const systemRunner: CommandRunner = {
  run(command, args) {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split('\n')[0];
      throw new Error(`${command} exited with code ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout ?? '';
  },
};

function usage(): never {
  console.error(`Usage: npm run neo4j:health -- [--profile <default|selftest>]

Resolves the selected local-runtime profile (including sanctioned
RADARIST_LOCAL_RUNTIME_PORT_OFFSET / RADARIST_LOCAL_RUNTIME_NAME_SUFFIX
overrides), verifies the profile-owned Neo4j container identity, and probes
only that profile's loopback HTTP/Bolt ports. No credentials are read.`);
  process.exit(2);
}

function printReport(report: Neo4jHealthReport): void {
  const { target, identity } = report;
  console.log(`[neo4j:health] profile=${target.profile} project=${target.projectId}`);
  console.log(`[neo4j:health] target http=${target.httpUrl} bolt=${target.boltUri}`);
  if (identity.state === 'matched') {
    const volumes = identity.volumes.length > 0 ? identity.volumes.join(',') : '<ephemeral>';
    console.log(
      `[neo4j:health] container=${identity.container} image=${identity.image} label=${identity.runtimeLabel} ` +
        `running=${identity.running} volumes=${volumes}`
    );
  } else {
    console.log(`[neo4j:health] container=${target.container} state=${identity.state}`);
  }
  if (report.http) console.log(`[neo4j:health] http=${report.http.ok ? 'ok' : 'fail'} (${report.http.detail})`);
  if (report.bolt) console.log(`[neo4j:health] bolt=${report.bolt.ok ? 'ok' : 'fail'} (${report.bolt.detail})`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument === '--help' || argument === '-h')) usage();
  // Refuse anything that is not a well-formed --profile selection: a silently
  // ignored positional or unknown flag could mask an operator's typo.
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--profile') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) usage();
      index += 1;
    } else if (!argument.startsWith('--profile=')) {
      usage();
    }
  }

  let selection;
  try {
    selection = resolveNeo4jHealthSelection(args, process.env);
  } catch (error) {
    console.error(`Neo4j health target selection failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const report = await checkNeo4jHealth(selection.target, { runner: systemRunner });
  printReport(report);
  if (report.healthy) {
    console.log(`Neo4j is healthy (profile ${selection.target.profile})`);
    return;
  }
  const reasons = report.problems.slice(0, 6).join('; ');
  console.error(`Neo4j is not responding (profile ${selection.target.profile}): ${reasons}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`Neo4j health check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
