/**
 * @jest-environment node
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';

const scriptPath = resolve(process.cwd(), 'scripts/ensure-subpackages.mjs');

function runEnsure(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: 'utf8' });
}

describe('ensure-subpackages package selection', () => {
  it('selects only the requested optional package without installing in dry-run mode', () => {
    const result = runEnsure('--package=agent', '--force', '--dry-run');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[ensure-subpackages] selected: agent');
    expect(result.stdout).toContain('agent: would run `npm ci`');
    expect(result.stdout).not.toContain('defense-minister');
    expect(result.stdout).not.toContain('gemini-mcp');
  });

  it('selects the repository-defined package set when no filter is supplied', () => {
    const result = runEnsure('--dry-run');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[ensure-subpackages] selected:');
    expect(result.stdout).toContain('agent');
  });

  it('rejects unknown package names with the supported choices', () => {
    const result = runEnsure('--package=unknown-runtime', '--dry-run');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown sub-package: unknown-runtime');
    expect(result.stderr).toContain('Choose from:');
    expect(result.stderr).toContain('agent');
  });
});

describe('core package scripts', () => {
  const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string | undefined>;
  };

  it('keeps core dev, build, and demo lifecycle hooks independent from the agent runtime', () => {
    expect(packageJson.scripts.predev).not.toMatch(/ensure-subpackages|agent/);
    expect(packageJson.scripts.prebuild).not.toMatch(/ensure-subpackages|agent/);
    expect(packageJson.scripts['predev:emulator']).toBeUndefined();
    expect(packageJson.scripts['predemo:full']).toBeUndefined();

    const demoFull = readFileSync(resolve(process.cwd(), 'scripts/demo-full.ts'), 'utf8');
    expect(demoFull).not.toContain("['--prefix', 'agent', 'run', 'build']");
  });

  it('provides one explicit deterministic setup command for the agent runtime', () => {
    expect(packageJson.scripts['setup:agents']).toBe(
      'node scripts/ensure-subpackages.mjs --package=agent --force && npm --prefix agent run build'
    );
  });
});
