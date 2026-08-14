import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  PUBLIC_E2E_DISCOVERY_MIN_BY_LANE,
  PUBLIC_E2E_LANE_CONTRACTS,
  playwrightLaneDiscoveryArguments,
} from '../lib/e2e-runtime-manifest';

const REPOSITORY_ROOT = resolve(__dirname, '..', '..');
const PLAYWRIGHT_CLI = require.resolve('@playwright/test/cli');

interface DiscoveryAttempt {
  readonly status: number | null;
  readonly output: string;
}

function listLane(lane: (typeof PUBLIC_E2E_LANE_CONTRACTS)[number], temporaryRoot: string): DiscoveryAttempt {
  const needsAuthSetup = lane.contract.firebase.startsWith('owned-');
  const config = join(temporaryRoot, `${lane.id}.config.cjs`);
  const projects = needsAuthSetup
    ? `[
        { name: 'setup', testMatch: /auth\\.setup\\.ts/ },
        { name: 'chromium', testIgnore: /auth\\.setup\\.ts/, dependencies: ['setup'] },
      ]`
    : `[{ name: 'chromium', testIgnore: /auth\\.setup\\.ts/ }]`;
  writeFileSync(
    config,
    `module.exports = {
      testDir: ${JSON.stringify(resolve(REPOSITORY_ROOT, 'tests/e2e'))},
      fullyParallel: false,
      projects: ${projects},
    };\n`
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: 'true',
    E2E_RUNTIME_LANE: lane.id,
    REPORT_DESIGN_E2E: '1',
    PW_TEST_HTML_REPORT_OPEN: 'never',
  };
  for (const key of [
    'JEST_WORKER_ID',
    'NODE_OPTIONS',
    'PW_TEST_SOURCE_TRANSFORM',
    'PW_TEST_SOURCE_TRANSFORM_SCOPE',
    'PW_TEST_SOURCE_TRANSFORM_TS_CONFIG',
  ]) {
    delete env[key];
  }

  const laneWithTemporaryConfig = { ...lane, config };
  const result = spawnSync(
    process.execPath,
    [PLAYWRIGHT_CLI, ...playwrightLaneDiscoveryArguments(laneWithTemporaryConfig)],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    }
  );
  return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
}

describe('public E2E lane config discovery', () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('pins one shared config and one exact spec partition per retained lane', () => {
    const allSpecs = PUBLIC_E2E_LANE_CONTRACTS.flatMap((lane) => lane.specs);
    const allSpecSet = new Set<string>(allSpecs);

    expect(PUBLIC_E2E_LANE_CONTRACTS.map((lane) => lane.id)).toEqual([
      'generic',
      'accessibility',
      'local-smoke',
      'report-publication',
    ]);
    expect(new Set(PUBLIC_E2E_LANE_CONTRACTS.map((lane) => lane.config))).toEqual(
      new Set(['playwright.config.ts'])
    );
    expect(new Set(allSpecs).size).toBe(allSpecs.length);

    for (const lane of PUBLIC_E2E_LANE_CONTRACTS) {
      const argumentsForLane = playwrightLaneDiscoveryArguments(lane);
      expect(argumentsForLane.slice(0, 5)).toEqual([
        'test',
        '--config',
        'playwright.config.ts',
        '--list',
        '--reporter=line',
      ]);
      expect(argumentsForLane.slice(5)).toEqual(lane.specs);
      expect(argumentsForLane.filter((argument) => allSpecSet.has(argument))).toEqual(lane.specs);
    }
  });

  it.each(PUBLIC_E2E_LANE_CONTRACTS.map((lane) => [lane.id, lane] as const))(
    'discovers the retained %s test floor without starting a runtime',
    (laneId, lane) => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), `public-e2e-discovery-${laneId}-`));
      temporaryRoots.push(temporaryRoot);
      const attempt = listLane(lane, temporaryRoot);

      expect({ lane: laneId, status: attempt.status, output: attempt.output }).toMatchObject({ status: 0 });
      const count = Number(attempt.output.match(/Total:\s+(\d+)\s+tests?\s+in\s+\d+\s+files?/)?.[1]);
      expect(count).toBe(PUBLIC_E2E_DISCOVERY_MIN_BY_LANE[laneId]);
    },
    90_000
  );
});
