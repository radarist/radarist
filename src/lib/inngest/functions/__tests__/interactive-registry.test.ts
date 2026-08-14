/** @jest-environment node */

/**
 * LOCAL-015 — the interactive registry must be provably cron-free.
 *
 * These checks are static on purpose. Importing the registries would load the
 * full Inngest/Firebase/Neo4j module graph, and discovery must never load the
 * full registry just to subtract schedules from it. Static analysis keeps the
 * guarantee cheap and keeps `interactive.ts` a deliberate hand-maintained list.
 *
 * The cron scan is deliberately CONSERVATIVE: it flags a module if the file
 * declares a cron trigger anywhere, even when the specific export registered
 * here is that file's non-cron sibling. Over-reporting fails the build and gets
 * looked at; under-reporting would silently schedule ambient work against
 * retained data, which is the exact failure this row exists to prevent.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FUNCTIONS_ROOT = join(process.cwd(), 'src/lib/inngest/functions');
const interactiveSource = readFileSync(join(FUNCTIONS_ROOT, 'interactive.ts'), 'utf8');
const fullRegistrySource = readFileSync(join(FUNCTIONS_ROOT, 'index.ts'), 'utf8');

const expectedRegisteredNames = [
  'syncRadarToNeo4jJob',
  'deleteRadarFromNeo4jJob',
  'syncPlacementToNeo4jJob',
  'syncTechnologyToNeo4jJob',
  'syncUnifiedEntityToNeo4jJob',
  'syncRelationToNeo4jJob',
  'syncDocumentToNeo4jJob',
  'syncEntityDocumentLinkToNeo4jJob',
  'runAgentMission',
  'recordObservationJob',
  'runBuildMission',
  'finalizeCancelledJobRun',
  'verifyEntityJob',
  'verifyEdgeJob',
] as const;

interface ImportedBinding {
  exportName: string;
  modulePath: string;
}

/** Parse `import { a, b } from './x';`, including multi-line brace lists. */
function parseLocalImports(source: string): ImportedBinding[] {
  const bindings: ImportedBinding[] = [];
  const importPattern = /import\s*\{([\s\S]*?)\}\s*from\s*'(\.\/[^']+)';/g;
  for (const [, names, modulePath] of source.matchAll(importPattern)) {
    for (const raw of names.split(',')) {
      const exportName = raw.trim();
      if (exportName) bindings.push({ exportName, modulePath });
    }
  }
  return bindings;
}

/** Parse the entries of an `export const <name> = [ ... ];` array literal. */
function parseRegistryArray(source: string, constName: string): string[] {
  const body = source.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\];`))?.[1];
  if (body === undefined) throw new Error(`Could not locate registry array "${constName}"`);
  return body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .flatMap((line) => line.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && /^[A-Za-z][A-Za-z0-9]*$/.test(entry));
}

function moduleSourceFor(modulePath: string): string {
  return readFileSync(join(FUNCTIONS_ROOT, `${modulePath.slice(2)}.ts`), 'utf8');
}

/** True when a module declares any cron trigger, including a dual-trigger array. */
function declaresCronTrigger(modulePath: string): boolean {
  return /\bcron\s*:/.test(moduleSourceFor(modulePath));
}

const interactiveImports = parseLocalImports(interactiveSource);
const interactiveRegistered = parseRegistryArray(interactiveSource, 'interactiveFunctions');
const fullImports = parseLocalImports(fullRegistrySource);
const fullRegistered = new Set(parseRegistryArray(fullRegistrySource, 'functions'));
const fullModuleByExport = new Map(fullImports.map(({ exportName, modulePath }) => [exportName, modulePath]));
const fullCronModules = new Set(
  fullImports.map(({ modulePath }) => modulePath).filter((modulePath) => declaresCronTrigger(modulePath))
);

describe('interactive Inngest registry', () => {
  it('contains the exact operator-driven functions and causal follow-ons', () => {
    expect(interactiveRegistered).toEqual([...expectedRegisteredNames]);
    expect(interactiveImports.map(({ exportName }) => exportName).sort()).toEqual([...interactiveRegistered].sort());
  });

  it('registers each function exactly once', () => {
    expect(new Set(interactiveRegistered).size).toBe(interactiveRegistered.length);
  });

  it('imports no module that declares a cron or dual trigger', () => {
    expect(interactiveImports).toHaveLength(expectedRegisteredNames.length);

    const offenders = interactiveImports
      .filter(({ modulePath }) => declaresCronTrigger(modulePath))
      .map(({ exportName, modulePath }) => `${exportName} (${modulePath})`);

    expect(offenders).toEqual([]);
  });

  it('detects cron triggers where they really exist, so the scan cannot pass vacuously', () => {
    // If the detector silently matched nothing, every assertion above would pass
    // no matter what the registry contained. The full registry is known to carry
    // scheduled maintenance, so the same scan must flag some of it — including
    // the dual event+cron trigger in discovery-sweep-cycle.
    expect(fullCronModules.size).toBeGreaterThan(0);
    expect(fullCronModules.has('./discovery-sweep-cycle')).toBe(true);
    expect(declaresCronTrigger('./daily-pipeline')).toBe(true);
  });

  it('parses the full registry into a sane inventory, so the subset check has something to check against', () => {
    // A parser that quietly returned [] would make the disjointness and subset
    // assertions meaningless. Pin the shape of what it actually read.
    expect(fullRegistered.size).toBeGreaterThan(interactiveRegistered.length);
    expect(fullRegistered.has('dailyPipeline')).toBe(true);
    expect(fullRegistered.has('syncRadarToNeo4jJob')).toBe(true);
    expect(fullModuleByExport.get('syncRadarToNeo4jJob')).toBe('./sync-radar-to-neo4j');
  });

  it('flags a drifted or cron-bearing entry when one is present', () => {
    // Exercise the same predicates against synthetic inventories rather than
    // mutating the tracked registry files, so the guards are shown to bite.
    const driftedNames = [...interactiveRegistered, 'someFunctionOnlyHere'];
    expect(driftedNames.filter((name) => !fullRegistered.has(name))).toEqual(['someFunctionOnlyHere']);

    const driftedImports = [...interactiveImports, { exportName: 'dailyPipeline', modulePath: './daily-pipeline' }];
    expect(driftedImports.filter(({ modulePath }) => fullCronModules.has(modulePath))).toEqual([
      { exportName: 'dailyPipeline', modulePath: './daily-pipeline' },
    ]);
  });

  it('stays a strict subset of the full registry so the two cannot drift', () => {
    // A name that exists only here would be served when INNGEST_FUNCTION_PROFILE
    // is interactive and be silently missing from production's full registry.
    const missingFromFull = interactiveRegistered.filter((name) => !fullRegistered.has(name));
    expect(missingFromFull).toEqual([]);

    // The same export must resolve to the same module in both registries.
    for (const { exportName, modulePath } of interactiveImports) {
      expect(fullModuleByExport.get(exportName)).toBe(modulePath);
    }
  });

  it('shares no module with the full registry’s scheduled work', () => {
    const overlap = interactiveImports
      .map(({ modulePath }) => modulePath)
      .filter((modulePath) => fullCronModules.has(modulePath));

    expect(overlap).toEqual([]);
  });
});
