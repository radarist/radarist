import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePlaywrightJsonLaneArgs, runPlaywrightJsonLane } from '../testing/run-playwright-json-lane';
import {
  genericModeContract,
  loadGenericRuntimeManifestSchemaVersion,
} from '../testing/run-generic-e2e-inner';

describe('runPlaywrightJsonLane', () => {
  it('passes an owned receipt through env/argv without shell interpolation and removes it', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'radarist-playwright-json-lane-unit-'));
    let observedReceipt = '';
    let observedArgs: readonly string[] = [];
    const receipt = runPlaywrightJsonLane(
      {
        lane: 'unit lane; $(touch /tmp/not-run)',
        config: 'playwright.unit.config.ts',
        minExpected: 2,
        maxSkipped: 0,
        maxFlaky: 0,
        playwrightArgs: ['smoke', '--project=chromium'],
      },
      {
        createTempRoot: () => tempRoot,
        runCommand: (_command, args, options) => {
          observedArgs = args;
          observedReceipt = options.env.PLAYWRIGHT_JSON_OUTPUT_NAME ?? '';
          writeFileSync(
            observedReceipt,
            JSON.stringify({ stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 } })
          );
          return { status: 0 };
        },
      }
    );

    expect(receipt.expected).toBe(2);
    expect(observedArgs).toContain('smoke');
    expect(observedArgs).toContain('--project=chromium');
    expect(observedArgs).toContain('--reporter=line,json,html');
    expect(observedArgs.join(' ')).not.toContain(observedReceipt);
    expect(existsSync(tempRoot)).toBe(false);
  });

  it('removes the owned receipt root when Playwright fails', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'radarist-playwright-json-lane-failure-'));
    expect(() =>
      runPlaywrightJsonLane(
        {
          lane: 'failure',
          config: 'playwright.unit.config.ts',
          minExpected: 1,
          maxSkipped: 0,
          maxFlaky: 0,
        },
        {
          createTempRoot: () => tempRoot,
          runCommand: (_command, _args, options) => {
            writeFileSync(
              join(tempRoot, 'playwright.json'),
              JSON.stringify({ stats: { expected: 0, skipped: 0, unexpected: 1, flaky: 0 } })
            );
            expect(options.env.PLAYWRIGHT_JSON_OUTPUT_NAME).toBe(join(tempRoot, 'playwright.json'));
            return { status: 1 };
          },
        }
      )
    ).toThrow(/execution contract/);
    expect(existsSync(tempRoot)).toBe(false);
  });
});

describe('runner CLI contracts', () => {
  it('parses contract arguments separately from literal Playwright argv', () => {
    expect(
      parsePlaywrightJsonLaneArgs([
        'generic-smoke',
        'playwright.config.ts',
        '31',
        '0',
        '0',
        '--',
        'smoke',
        '--project=chromium',
      ])
    ).toEqual({
      lane: 'generic-smoke',
      config: 'playwright.config.ts',
      minExpected: 31,
      maxSkipped: 0,
      maxFlaky: 0,
      playwrightArgs: ['smoke', '--project=chromium'],
    });
  });

  it('pins the full and smoke non-vacuity contracts', () => {
    const previousRuntimeLane = process.env.E2E_RUNTIME_LANE;
    process.env.E2E_RUNTIME_LANE = 'generic';
    try {
      const schemaVersion = loadGenericRuntimeManifestSchemaVersion();
      expect([2, 3]).toContain(schemaVersion);
      expect(genericModeContract('full')).toMatchObject({
        minExpected: schemaVersion === 2 ? 319 : 46,
        maxSkipped: 0,
      });
    } finally {
      if (previousRuntimeLane === undefined) delete process.env.E2E_RUNTIME_LANE;
      else process.env.E2E_RUNTIME_LANE = previousRuntimeLane;
    }

    expect(genericModeContract('full', 3)).toMatchObject({ minExpected: 46, maxSkipped: 0 });
    expect(genericModeContract('smoke', 2)).toMatchObject({ minExpected: 31, maxSkipped: 0 });
    expect(() => genericModeContract('full', 4)).toThrow(/unsupported schemaVersion 4/);
    expect(() => genericModeContract('anything-else')).toThrow(/full or smoke/);
  });
});
