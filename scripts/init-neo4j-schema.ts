#!/usr/bin/env npx tsx
/**
 * @file init-neo4j-schema.ts
 * @description Initialize Neo4j schema (constraints, indexes, vector indexes,
 * relation types) from the single-source-of-truth manifest.
 *
 * FAIL-LOUD (CRIT-2 fix, 2026-07-03): previously this script ignored the
 * per-statement success booleans and always printed "complete!" + exited 0,
 * even when every constraint/index failed — so a zero-schema DB looked healthy.
 * It now aggregates every result and exits NON-ZERO if any CREATE failed.
 *
 * Note: uniqueness CONSTRAINTS legitimately fail against a graph that still has
 * duplicate-id nodes. That is the correct fail-loud signal — dedupe first
 * (see the foundation-elevation plan, P2), then re-run.
 *
 * Usage:  npx tsx scripts/init-neo4j-schema.ts
 */
import './load-env-local';

import neo4j, { Driver, Session } from 'neo4j-driver';
import {
  CONSTRAINTS,
  INDEXES,
  CONTEXT_SCHEMA,
  VECTOR_INDEXES,
  FULLTEXT_INDEXES,
  DEPRECATED_DROPS,
  RELATION_TYPES,
  parseSchemaObjectName,
  summarizeSchemaResults,
  type SchemaResult,
} from '../src/lib/graph/schema-manifest';

const config = {
  uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
  user: process.env.NEO4J_USER || 'neo4j',
  password: process.env.NEO4J_PASSWORD || 'change-me-required',
};

/** Run one DDL statement. Returns ok=true on success or already-exists. */
async function runOne(session: Session, query: string, label: string): Promise<SchemaResult> {
  try {
    await session.run(query);
    console.log(`  ✓ ${label}`);
    return { label, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('already exists') || message.includes('equivalent')) {
      console.log(`  ○ ${label} (already exists)`);
      return { label, ok: true };
    }
    console.log(`  ✗ ${label}: ${message}`);
    return { label: `${label} — ${message}`, ok: false };
  }
}

function labelFor(stmt: string): string {
  return parseSchemaObjectName(stmt) || stmt.substring(0, 50);
}

async function initializeSchema(): Promise<void> {
  console.log('\n━━━ Neo4j Schema Initialization ━━━');
  console.log(`  URI: ${config.uri}  User: ${config.user}\n`);

  const driver: Driver = neo4j.driver(config.uri, neo4j.auth.basic(config.user, config.password));
  const session = driver.session();
  const results: SchemaResult[] = [];

  try {
    await session.run('RETURN 1');
    console.log('  ✓ Connection successful\n');

    // Deprecated drops run first; failures here are non-gating (IF EXISTS).
    console.log('Dropping deprecated schema (:Claim, :Decision)...');
    for (const drop of DEPRECATED_DROPS) {
      const m = drop.match(/(?:CONSTRAINT|INDEX)\s+(\w+)/);
      await runOne(session, drop, `drop ${m?.[1] ?? drop.substring(0, 40)}`);
    }
    console.log('');

    // The gated CREATE pass — every result is collected.
    const passes: Array<[string, string[]]> = [
      ['Creating constraints', CONSTRAINTS],
      ['Creating indexes', INDEXES],
      ['Creating context schema', CONTEXT_SCHEMA],
      ['Creating vector indexes', VECTOR_INDEXES],
      ['Creating fulltext indexes', FULLTEXT_INDEXES],
    ];
    for (const [title, statements] of passes) {
      console.log(`${title}...`);
      for (const stmt of statements) {
        results.push(await runOne(session, stmt, labelFor(stmt)));
      }
      console.log('');
    }

    // Relation-type metadata nodes (MERGE — carries description for the
    // reconcile prune's IS NULL guard; see schema-migrations Pass-4).
    console.log('Seeding relation types...');
    for (const rt of RELATION_TYPES) {
      try {
        await session.run(
          `MERGE (r:RelationType {name: $name})
           ON CREATE SET r.description = $description, r.category = $category, r.createdAt = timestamp()
           ON MATCH SET r.description = coalesce(r.description, $description), r.category = coalesce(r.category, $category)`,
          rt
        );
      } catch (e) {
        results.push({ label: `reltype ${rt.name} — ${(e as Error).message}`, ok: false });
      }
    }
    console.log(`  ✓ Seeded ${RELATION_TYPES.length} relation types\n`);

    const summary = summarizeSchemaResults(results);
    console.log('━━━ Schema Summary ━━━');
    console.log(`  Statements: ${summary.total}   ok: ${summary.ok}   failed: ${summary.failed}`);
    if (summary.failed > 0) {
      console.log('\n  FAILURES:');
      summary.failures.forEach((f) => console.log(`    ✗ ${f}`));
      console.log(
        '\n✗ Schema initialization INCOMPLETE — see failures above.' +
          '\n  (Uniqueness constraints fail while duplicate-id nodes exist; dedupe first.)\n'
      );
      process.exitCode = 1;
      return;
    }
    console.log('\n✓ Schema initialization complete.\n');
  } catch (error) {
    console.error('\n✗ Fatal error initializing schema:', error);
    process.exitCode = 1;
  } finally {
    await session.close();
    await driver.close();
  }
}

initializeSchema();
