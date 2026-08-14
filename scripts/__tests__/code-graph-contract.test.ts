import { execFileSync } from 'node:child_process';
import path from 'node:path';

interface CodeGraphReport {
  orphans: string[];
}

describe('code graph entrypoints', () => {
  it('does not classify the Next.js proxy as an orphan module', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const output = execFileSync(process.execPath, ['scripts/code-graph.mjs', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const report = JSON.parse(output) as CodeGraphReport;

    expect(report.orphans).not.toContain('src/proxy.ts');
  });

  it('counts modules imported by retained public CLI entrypoints as live', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const output = execFileSync(process.execPath, ['scripts/code-graph.mjs', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const report = JSON.parse(output) as CodeGraphReport;

    expect(report.orphans).not.toContain('src/lib/ai/tool-surface-policy.ts');
    expect(report.orphans).not.toContain('src/lib/inngest/interrupted-run-recovery.ts');
  });

  it('still reports an unreferenced module instead of crediting arbitrary scripts', () => {
    const repoRoot = path.resolve(__dirname, '../..');
    const program = `
      import { buildGraphFromView } from './scripts/code-graph.mjs';
      const view = new Map([
        ['src/live.ts', { bytes: "export const live = true;" }],
        ['src/orphan.ts', { bytes: "export const orphan = true;" }],
        ['scripts/public-entry.ts', { bytes: "import '@/live';" }],
        ['scripts/abandoned.ts', { bytes: "import '@/orphan';" }],
      ]);
      process.stdout.write(JSON.stringify(buildGraphFromView(view, ['scripts/public-entry.ts'])));
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const report = JSON.parse(output) as CodeGraphReport;

    expect(report.orphans).toEqual(['src/orphan.ts']);
  });

});
