#!/usr/bin/env npx tsx

/**
 * @file run-graph-identity-integration.ts
 * @description AI-026 — owner of the disposable graph for the business-entity
 * identity integration proof.
 *
 * The proof seeds `:AgentObservation` and every other internal-memory label as a
 * decoy carrying `entityType:'technology'`, then drives the real reads. It must
 * therefore run against a graph this process created and can discard, not a
 * retained one: the repository-wide disposable integration port 17687 is ALSO the
 * Bolt port of the canonical `selftest` local-runtime profile
 * (`scripts/lib/local-runtime-profile.ts`), which operators keep running for
 * days, and `assertDisposableNeo4jIntegrationTarget` cannot tell the two apart —
 * both are loopback and neither is the protected default 7687.
 *
 * So this lane publishes its own Bolt/HTTP pair that no durable profile uses, and
 * `withDisposableNeo4j` proves before the suite starts that the target is a
 * container it just created, holds zero nodes, has an ephemeral `/data`, and is
 * bound to loopback only. Teardown removes the container and proves its absence.
 *
 * Run:
 *   npm run test:integration:graph-identity
 *
 * No Firestore, no provider credentials, no network: the suite reads and writes
 * Neo4j only, so it costs nothing.
 */

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { withDisposableNeo4j } from '../lib/disposable-neo4j-runtime';
import { scrubProviderCredentialEnv } from '../lib/provider-credential-env';

const ROOT = resolve(__dirname, '../..');

/**
 * Deliberately outside every other graph in the repository — default 7687/7474,
 * `selftest` 17687/17474, the TEST-023 offset stack 30687/30474, the
 * relation-integrity graph 17690/17475, and browser acceptance 17692/17477.
 */
export const GRAPH_IDENTITY_BOLT_PORT = 17694;
export const GRAPH_IDENTITY_HTTP_PORT = 17479;

export const GRAPH_IDENTITY_SUITES = ['src/lib/graph/__tests__/business-entity-identity.integration.test.ts'] as const;

export function buildGraphIdentityJestArgs(): string[] {
  return [...GRAPH_IDENTITY_SUITES, '--runInBand', '--coverage=false'];
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  if (args.length > 0) {
    console.error(`[graph-identity] this lane accepts no Jest overrides: ${args.join(' ')}`);
    return 1;
  }

  try {
    return await withDisposableNeo4j(
      {
        namePrefix: 'radarist-graph-identity',
        labelValue: 'graph-identity-integration',
        boltPort: GRAPH_IDENTITY_BOLT_PORT,
        httpPort: GRAPH_IDENTITY_HTTP_PORT,
      },
      async (handle) => {
        console.log(`[graph-identity] disposable graph ready at ${handle.uri} (container ${handle.containerId})`);
        const jestBin = require.resolve('jest/bin/jest');
        const result = spawnSync(process.execPath, [jestBin, ...buildGraphIdentityJestArgs()], {
          cwd: ROOT,
          env: {
            // Provider keys blanked, but HOME left alone: this lane needs no
            // credential root, and relocating HOME would only hide the toolchain
            // caches that live there.
            ...scrubProviderCredentialEnv(process.env),
            ...handle.env,
            NEO4J_INTEGRATION_TESTS: '1',
          },
          stdio: 'inherit',
        });
        if (result.error) throw result.error;
        return result.status ?? 1;
      }
    );
  } catch (error) {
    console.error(`[graph-identity] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  void main().then((status) => {
    process.exitCode = status;
  });
}
