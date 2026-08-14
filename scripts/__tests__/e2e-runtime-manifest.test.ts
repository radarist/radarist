import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  PUBLIC_E2E_DISCOVERY_MIN_BY_LANE,
  PUBLIC_E2E_LANE_CONTRACTS,
  analyzeE2ESoftPassSource,
  auditE2ERuntimeManifest,
  exactLaneSpecPattern,
  explicitSpecLaneMap,
  findUnauditedBasePageFixture,
  findUnauditedRawBrowserContexts,
  laneById,
  laneSpecPatterns,
  loadPublicE2ERuntimeManifest,
  nonGenericSpecPatterns,
  parseE2ERuntimeManifest,
  resolveSpecLane,
  specsOutsideLanePatterns,
  unprovisionableRuntimeDependencies,
} from '../lib/e2e-runtime-manifest';

interface MutableLaneFixture {
  id: string;
  status: string;
  command: string;
  config: string;
  contract: Record<string, unknown>;
  specs: unknown[];
  [key: string]: unknown;
}

interface MutableManifestFixture {
  schemaVersion: number;
  ratchets: {
    directCatchFalseMax?: unknown;
    fixedWaitMax?: unknown;
    discoveryMinByLane?: Record<string, unknown>;
    [key: string]: unknown;
  };
  lanes: MutableLaneFixture[];
  retiredSpecs: unknown[];
  assertionReviews: unknown[];
}

function publicManifestFixture(): MutableManifestFixture {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 3,
      ratchets: {
        directCatchFalseMax: 0,
        fixedWaitMax: 0,
        discoveryMinByLane: PUBLIC_E2E_DISCOVERY_MIN_BY_LANE,
      },
      lanes: PUBLIC_E2E_LANE_CONTRACTS,
      retiredSpecs: [],
      assertionReviews: [],
    })
  ) as MutableManifestFixture;
}

function privateV2ManifestFixture(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    ratchets: {
      directCatchFalseMax: 0,
      fixedWaitMax: 0,
      smokeDirectCatchFalseMax: 0,
      smokeFixedWaitMax: 0,
      genericDiscoveryMin: 319,
    },
    lanes: [],
    retiredSpecs: [],
    assertionReviews: [],
  };
}

function write(root: string, path: string, content: string): void {
  const destination = resolve(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function createPublicAuditRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'radarist-public-e2e-contract-'));
  write(root, 'tests/e2e/runtime-manifest.json', `${JSON.stringify(publicManifestFixture(), null, 2)}\n`);
  write(
    root,
    'package.json',
    `${JSON.stringify(
      {
        scripts: {
          e2e: 'E2E_RUNTIME_LANE=generic bash scripts/testing/run-generic-e2e.sh full',
          'e2e:accessibility': 'E2E_RUNTIME_LANE=accessibility playwright test -c playwright.config.ts',
          'e2e:local':
            'E2E_RUNTIME_LANE=local-smoke E2E_REUSE_EXISTING_SERVER=true playwright test -c playwright.config.ts',
          'e2e:report-publication':
            'E2E_RUNTIME_LANE=report-publication REPORT_DESIGN_E2E=1 playwright test -c playwright.config.ts',
        },
      },
      null,
      2
    )}\n`
  );
  write(
    root,
    'playwright.config.ts',
    `
import { loadPublicE2ERuntimeManifest, specsOutsideLanePatterns } from './scripts/lib/e2e-runtime-manifest';
import { scrubProviderCredentialEnv } from './scripts/lib/provider-credential-env';
import dotenv from 'dotenv';
const selectedRuntimeLane = process.env.E2E_RUNTIME_LANE ?? 'generic';
const runtimeManifest = loadPublicE2ERuntimeManifest(__dirname);
Object.assign(process.env, scrubProviderCredentialEnv(process.env), {
  CLAUDE_CHAT_ENABLED: 'false',
  INNGEST_ENABLED: 'false',
  MAINTENANCE_PAUSED: 'true',
  NEXT_PUBLIC_INNGEST_ENABLED: 'false',
});
dotenv.config({ path: '.env.local' });
const ignored = specsOutsideLanePatterns(runtimeManifest, selectedRuntimeLane);
void ignored;
`
  );
  write(
    root,
    'tests/e2e/network-only-fixtures.ts',
    `
export const installMarker = 'installLoopbackNetworkAudit(page, audit)';
export const teardownMarker = "assertNoExternalBrowserRequests(audit, 'Network-only Playwright page')";
`
  );
  for (const lane of PUBLIC_E2E_LANE_CONTRACTS) {
    for (const spec of lane.specs) {
      write(
        root,
        spec,
        `import { test, expect } from './network-only-fixtures';\ntest('${lane.id}', async () => { expect(true).toBe(true); });\n`
      );
    }
  }
  write(
    root,
    'node_modules/@playwright/test/cli.js',
    `
const counts = ${JSON.stringify(PUBLIC_E2E_DISCOVERY_MIN_BY_LANE)};
const count = counts[process.env.E2E_RUNTIME_LANE];
if (!count) process.exit(2);
process.stdout.write('Total: ' + count + ' tests in 1 file\\n');
`
  );
  return root;
}

describe('public E2E runtime manifest v3', () => {
  it('accepts exactly the four retained lanes and lane-keyed discovery floors', () => {
    const manifest = parseE2ERuntimeManifest(publicManifestFixture());

    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.lanes.map((lane) => lane.id)).toEqual([
      'generic',
      'accessibility',
      'local-smoke',
      'report-publication',
    ]);
    expect(manifest.ratchets).toEqual({
      directCatchFalseMax: 0,
      fixedWaitMax: 0,
      discoveryMinByLane: PUBLIC_E2E_DISCOVERY_MIN_BY_LANE,
    });
  });

  it('rejects a v2 source schema instead of silently adapting it', () => {
    const privateManifest = privateV2ManifestFixture();
    const root = mkdtempSync(join(tmpdir(), 'radarist-public-v2-loader-rejection-'));
    write(root, 'tests/e2e/runtime-manifest.json', `${JSON.stringify(privateManifest)}\n`);

    expect(() => parseE2ERuntimeManifest(privateManifest)).toThrow('manifest.schemaVersion must be 3');
    expect(() => loadPublicE2ERuntimeManifest(root)).toThrow('manifest.schemaVersion must be 3');
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects missing and typoed ratchet fields', () => {
    const missing = publicManifestFixture();
    delete missing.ratchets.fixedWaitMax;
    expect(() => parseE2ERuntimeManifest(missing)).toThrow('missing fixedWaitMax');

    const typoed = publicManifestFixture();
    typoed.ratchets.fixedWaitMxa = typoed.ratchets.fixedWaitMax;
    delete typoed.ratchets.fixedWaitMax;
    expect(() => parseE2ERuntimeManifest(typoed)).toThrow('missing fixedWaitMax; unknown fixedWaitMxa');
  });

  it('rejects nonzero soft-pass ceilings', () => {
    const manifest = publicManifestFixture();
    manifest.ratchets.directCatchFalseMax = 1;

    expect(() => parseE2ERuntimeManifest(manifest)).toThrow('public soft-pass ceilings must both be zero');
  });

  it('rejects missing, unknown, and lowered lane discovery floors', () => {
    const missing = publicManifestFixture();
    delete missing.ratchets.discoveryMinByLane?.accessibility;
    expect(() => parseE2ERuntimeManifest(missing)).toThrow('missing accessibility');

    const unknown = publicManifestFixture();
    unknown.ratchets.discoveryMinByLane!.privateLane = 1;
    expect(() => parseE2ERuntimeManifest(unknown)).toThrow('unknown privateLane');

    const lowered = publicManifestFixture();
    lowered.ratchets.discoveryMinByLane!.generic = 45;
    expect(() => parseE2ERuntimeManifest(lowered)).toThrow('discovery floors do not match');
  });

  it('rejects drift in the retained lane set, commands, contracts, and specs', () => {
    for (const mutate of [
      (manifest: MutableManifestFixture) => manifest.lanes.pop(),
      (manifest: MutableManifestFixture) => (manifest.lanes[0].command = 'e2e:private'),
      (manifest: MutableManifestFixture) => (manifest.lanes[1].contract.provider = 'live-explicit'),
      (manifest: MutableManifestFixture) => manifest.lanes[2].specs.push('tests/e2e/private.spec.ts'),
    ]) {
      const manifest = publicManifestFixture();
      mutate(manifest);
      expect(() => parseE2ERuntimeManifest(manifest)).toThrow('public lane contracts must exactly match');
    }
  });

  it('rejects retired private inventory in the public contract', () => {
    const manifest = publicManifestFixture();
    manifest.retiredSpecs.push({
      path: 'tests/e2e/private.spec.ts',
      reason: 'private inventory must not be published',
      resolution: 'invalid-claim',
      replacements: [],
    });

    expect(() => parseE2ERuntimeManifest(manifest)).toThrow('retiredSpecs must be empty');
  });

  it('resolves lane ownership and selectors without a fallback owner', () => {
    const manifest = parseE2ERuntimeManifest(publicManifestFixture());
    const explicit = explicitSpecLaneMap(manifest);

    expect(explicit.size).toBe(8);
    expect(resolveSpecLane(manifest, 'tests/e2e/accessibility-sweep.spec.ts')).toBe('accessibility');
    expect(() => resolveSpecLane(manifest, 'tests/e2e/unowned.spec.ts')).toThrow('has no explicit runtime owner');
    expect(laneSpecPatterns(manifest, 'report-publication')).toEqual([
      '**/report-publication-conformance.spec.ts',
    ]);
    expect(exactLaneSpecPattern(manifest, 'local-smoke', 'tests/e2e/local-smoke.spec.ts')).toBe(
      '**/local-smoke.spec.ts'
    );
    expect(nonGenericSpecPatterns(manifest)).toContain('**/accessibility-sweep.spec.ts');
    expect(specsOutsideLanePatterns(manifest, 'accessibility')).not.toContain('**/accessibility-sweep.spec.ts');
    expect(laneById(manifest, 'local-smoke').status).toBe('manual');
  });
});

describe('public E2E safety analysis', () => {
  it('classifies conditional false-green and timing debt at test granularity', () => {
    const findings = analyzeE2ESoftPassSource(
      `import { test, expect } from '@playwright/test';
       test('conditional', async ({ page }) => {
         if (await page.getByText('maybe').isVisible().catch(() => false)) {
           expect(await page.title()).toBe('shown');
         }
         await page.waitForTimeout(100);
       });
       test.fixme('disabled', async () => { expect(true).toBe(true); });`,
      'tests/e2e/example.spec.ts'
    );

    expect(findings).toEqual([
      expect.objectContaining({
        path: 'tests/e2e/example.spec.ts',
        title: 'conditional',
        directCatchFalseCount: 1,
        fixedWaitCount: 1,
        unconditionalAssertionCount: 0,
        conditionalAssertionCount: 1,
        declaration: 'test',
      }),
      expect.objectContaining({ title: 'disabled', declaration: 'fixme' }),
    ]);
  });

  it('detects unaudited raw contexts and automatic base pages', () => {
    expect(
      findUnauditedRawBrowserContexts(
        'const a = await browser.newContext();\nconst b = await chromium.newPage();',
        'tests/e2e/helpers/unsafe.ts'
      )
    ).toEqual(['tests/e2e/helpers/unsafe.ts:1', 'tests/e2e/helpers/unsafe.ts:2']);
    expect(
      findUnauditedBasePageFixture(
        "import { test } from '@playwright/test';\ntest('unsafe', async ({ page }) => page.goto('/'));",
        'tests/e2e/unsafe.spec.ts'
      )
    ).toEqual(['tests/e2e/unsafe.spec.ts:2']);
    expect(
      findUnauditedBasePageFixture(
        "import { test } from './network-only-fixtures';\ntest('safe', async ({ page }) => page.goto('/'));",
        'tests/e2e/safe.spec.ts'
      )
    ).toEqual([]);
  });

  it('permits manual status only when the lane names caller-owned runtime dependencies', () => {
    expect(unprovisionableRuntimeDependencies(laneById(parseE2ERuntimeManifest(publicManifestFixture()), 'local-smoke').contract)).toEqual([
      'firebase=operator-selected',
      'neo4j=operator-selected',
      'inngest=operator-selected',
    ]);
  });
});

describe('public E2E runtime audit', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('rejects a v2 manifest before considering it a public runtime contract', () => {
    const root = mkdtempSync(join(tmpdir(), 'radarist-public-e2e-v2-rejection-'));
    roots.push(root);
    write(root, 'tests/e2e/runtime-manifest.json', `${JSON.stringify(privateV2ManifestFixture())}\n`);

    expect(() => auditE2ERuntimeManifest(root)).toThrow('manifest.schemaVersion must be 3');
  });

  it('audits every retained lane generically and returns zero-debt evidence', () => {
    const root = createPublicAuditRoot();
    roots.push(root);

    expect(auditE2ERuntimeManifest(root)).toMatchObject({
      specCount: 8,
      laneCounts: { generic: 5, accessibility: 1, 'local-smoke': 1, 'report-publication': 1 },
      discoveryCounts: PUBLIC_E2E_DISCOVERY_MIN_BY_LANE,
      directCatchFalseCount: 0,
      fixedWaitCount: 0,
      unauditedRawContextCount: 0,
      unauditedBasePageFixtureCount: 0,
    });
  });

  it('rejects package routing that does not explicitly select its manifest lane', () => {
    const root = createPublicAuditRoot();
    roots.push(root);
    const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    packageJson.scripts['e2e:accessibility'] = 'playwright test -c playwright.config.ts';
    write(root, 'package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => auditE2ERuntimeManifest(root)).toThrow('must select E2E_RUNTIME_LANE=accessibility');
  });

  it('rejects a projected spec with no explicit public lane owner', () => {
    const root = createPublicAuditRoot();
    roots.push(root);
    write(
      root,
      'tests/e2e/unowned.spec.ts',
      "import { test, expect } from './network-only-fixtures';\ntest('unowned', () => expect(true).toBe(true));\n"
    );

    expect(() => auditE2ERuntimeManifest(root)).toThrow('E2E specs have no explicit runtime owner');
  });

  it('rejects new soft-pass debt anywhere in the projected E2E source tree', () => {
    const root = createPublicAuditRoot();
    roots.push(root);
    const spec = 'tests/e2e/local-smoke.spec.ts';
    write(root, spec, `${readFileSync(resolve(root, spec), 'utf8')}\nvoid Promise.resolve().catch(() => false);\n`);

    expect(() => auditE2ERuntimeManifest(root)).toThrow('E2E direct catch-false debt grew: 1 > 0');
  });

  it('rejects discovery below the retained lane floor', () => {
    const root = createPublicAuditRoot();
    roots.push(root);
    write(
      root,
      'node_modules/@playwright/test/cli.js',
      `
const counts = ${JSON.stringify({ ...PUBLIC_E2E_DISCOVERY_MIN_BY_LANE, generic: 45 })};
process.stdout.write('Total: ' + counts[process.env.E2E_RUNTIME_LANE] + ' tests in 1 file\\n');
`
    );

    expect(() => auditE2ERuntimeManifest(root)).toThrow('generic discovered 45 tests below its floor 46');
  });
});
