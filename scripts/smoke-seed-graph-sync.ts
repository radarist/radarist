/**
 * @file scripts/smoke-seed-graph-sync.ts
 * @description Guarded smoke/CI fixture for `scripts/lib/seed-graph-sync.ts`.
 * The default `roundtrip` mode seeds, verifies, and deletes deterministic
 * namespaced data. CI uses separate `seed`, `verify`, and `cleanup` modes so
 * graph:health and the strict benchmark run while the fixture is present.
 *
 * Run:
 *   NEO4J_URI=bolt://127.0.0.1:17687 \
 *   NEO4J_INTEGRATION_DISPOSABLE=true \
 *   npx tsx scripts/smoke-seed-graph-sync.ts [roundtrip|seed|verify|cleanup]
 */

import './load-env-local';
import { closeDriver } from '@/lib/graph/neo4j-client';
import {
  assertGraphCiFixtureAbsent,
  assertGraphCiFixturePresent,
  cleanupGraphCiFixture,
  seedGraphCiFixture,
} from './lib/graph-ci-fixture';

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const mode = args[0] ?? 'roundtrip';
  if (!['roundtrip', 'seed', 'verify', 'cleanup'].includes(mode) || args.length > 1) {
    throw new Error('Usage: smoke-seed-graph-sync.ts [roundtrip|seed|verify|cleanup]');
  }

  try {
    if (mode === 'seed' || mode === 'roundtrip') {
      const verification = await seedGraphCiFixture();
      console.log('[graph-fixture] seeded:', JSON.stringify(verification));
    }
    if (mode === 'verify') {
      const verification = await assertGraphCiFixturePresent();
      console.log('[graph-fixture] verified:', JSON.stringify(verification));
    }
    if (mode === 'cleanup' || mode === 'roundtrip') {
      await cleanupGraphCiFixture();
      await assertGraphCiFixtureAbsent();
      console.log('[graph-fixture] cleanup verified: zero residue');
    }
  } finally {
    await closeDriver();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[graph-fixture] failed:', err);
    process.exitCode = 1;
  });
}
