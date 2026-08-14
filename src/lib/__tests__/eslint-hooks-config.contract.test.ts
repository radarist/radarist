/**
 * @jest-environment node
 *
 * LINT-001 config contract — loads the REAL eslint.config.mjs and proves the
 * react-hooks severity split: `rules-of-hooks` is an ERROR (severity 2) and
 * `exhaustive-deps` stays a visible WARNING (severity 1, never 2). Fails if
 * anyone later downgrades the error or hides/escalates the dependency debt.
 *
 * Virtual file paths MUST live under src/ — `tests/**` and `scripts/**` are
 * config-ignored, so a path there would lint to zero messages (a false pass).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

interface LintMessage {
  ruleId: string | null;
  severity: number;
}

/**
 * Lint a code string through the real CLI + the real flat config. The ESLint
 * class cannot load the ESM eslint.config.mjs inside Jest's VM (dynamic
 * import needs --experimental-vm-modules), so the contract spawns the CLI.
 */
function lintText(code: string, virtualPath: string): LintMessage[] {
  const bin = path.join(repoRoot, 'node_modules', '.bin', 'eslint');
  const res = spawnSync(bin, ['--stdin', '--stdin-filename', virtualPath, '--format', 'json', '--no-fix'], {
    cwd: repoRoot,
    input: code,
    encoding: 'utf8',
  });
  if (!res.stdout) {
    throw new Error(`eslint produced no JSON output (status ${res.status}): ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout) as Array<{ messages: LintMessage[] }>;
  return parsed[0]?.messages ?? [];
}

jest.setTimeout(60_000);

describe('react-hooks lint contract (LINT-001)', () => {
  it('a conditionally-called hook fails as an ERROR', async () => {
    const code = [
      "import { useState } from 'react';",
      'export function Bad({ cond }: { cond: boolean }) {',
      '  if (cond) {',
      '    const [x] = useState(0);',
      '    return x;',
      '  }',
      '  return null;',
      '}',
      '',
    ].join('\n');
    const messages = lintText(code, path.join(repoRoot, 'src/__contract__/bad-hook.tsx'));
    const hits = messages.filter((m) => m.ruleId === 'react-hooks/rules-of-hooks');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) => m.severity === 2)).toBe(true);
  });

  it('a missing effect dependency reports as a WARNING, never an error', async () => {
    const code = [
      "import { useEffect } from 'react';",
      'export function C({ id }: { id: string }) {',
      '  useEffect(() => {',
      '    void id;',
      '  }, []);',
      '  return null;',
      '}',
      '',
    ].join('\n');
    const messages = lintText(code, path.join(repoRoot, 'src/__contract__/missing-dep.tsx'));
    const hits = messages.filter((m) => m.ruleId === 'react-hooks/exhaustive-deps');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((m) => m.severity === 1)).toBe(true);
  });
});
