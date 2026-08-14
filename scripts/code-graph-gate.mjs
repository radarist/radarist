#!/usr/bin/env node
/**
 * code-graph-gate.mjs — structural-regression ratchet for CI.
 *
 * Builds the current `src/` import graph (via code-graph.mjs) and diffs it
 * against a committed baseline. Fails (exit 1) ONLY on NEW structural debt, so
 * existing debt (the documented service cycle, the known orphans) is
 * grandfathered and never blocks — only regressions do:
 *
 *   - a file entering an import cycle that wasn't in one before
 *   - a new orphan module (unreferenced by production code)
 *   - a new client→server-only boundary violation
 *   - any new unresolved/broken internal import
 *
 * Accepting debt is an explicit, reviewable act: re-bless the baseline with
 *   npm run graph:structure:gate -- --update-baseline
 * and commit scripts/code-graph-baseline.json (the change shows up in PR review).
 *
 * Usage:
 *   node scripts/code-graph-gate.mjs                  # check (exit 1 on regression)
 *   node scripts/code-graph-gate.mjs --update-baseline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, ROOT } from './code-graph.mjs';

const BASELINE = path.join(ROOT, 'scripts/code-graph-baseline.json');
const args = process.argv.slice(2);

const g = buildGraph();
const snapshot = {
  externalEntrypoints: g.meta.externalEntrypoints,
  cycleMembers: g.cycleMembers,
  orphans: g.orphans,
  boundary: g.boundary,
  unresolved: g.unresolved,
};

if (args.includes('--update-baseline')) {
  fs.writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`Baseline written: ${path.relative(ROOT, BASELINE)}`);
  console.log(
    `  cycleMembers=${snapshot.cycleMembers.length}  orphans=${snapshot.orphans.length}  boundary=${snapshot.boundary.length}  unresolved=${snapshot.unresolved.length}`
  );
  process.exit(0);
}

if (!fs.existsSync(BASELINE)) {
  console.error(`No baseline found at ${path.relative(ROOT, BASELINE)}.`);
  console.error('Create it with: npm run graph:structure:gate -- --update-baseline');
  process.exit(2);
}

const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const added = (cur, old) => cur.filter((x) => !(old || []).includes(x));

const checks = [
  [
    'import-cycle member(s)',
    added(snapshot.cycleMembers, base.cycleMembers),
    'A file entered an import cycle. Break it or move the shared symbol out.',
  ],
  [
    'orphan module(s)',
    added(snapshot.orphans, base.orphans),
    'Unreferenced by production code. Wire it up or delete it.',
  ],
  [
    'client→server boundary violation(s)',
    added(snapshot.boundary, base.boundary),
    'A "use client" file imports a server-only module at runtime. Use a *-client variant or an API route.',
  ],
  [
    'unresolved/broken import(s)',
    added(snapshot.unresolved, base.unresolved),
    'An internal import resolves to no file (likely a renamed/deleted module).',
  ],
];

let failed = false;
for (const [label, items, hint] of checks) {
  if (items.length) {
    failed = true;
    console.error(`\n✗ ${items.length} NEW ${label}:`);
    for (const i of items) console.error(`    ${i}`);
    console.error(`  ${hint}`);
  }
}

if (failed) {
  console.error('\nStructural-regression gate FAILED.');
  console.error(
    'If this is intentional debt, run `npm run graph:structure:gate -- --update-baseline` and commit the baseline diff.'
  );
  process.exit(1);
}
console.log('✓ code-graph gate passed — no new cycles / orphans / boundary violations / broken imports.');
