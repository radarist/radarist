/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('demo:full checkpoint suspension integration', () => {
  it('delegates stop/continue authority to the verified runtime lifecycle', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/demo-full.ts'), 'utf8');

    expect(source).toContain('lifecycle.pauseProcessGroups(CHECKPOINT_WRITER_ROLES)');
    expect(source).toContain('lifecycle.resumeProcessGroups(pauseToken)');
    expect(source).toContain('lifecycle.recoverPausedProcessGroups()');
    expect(source).not.toContain('function pauseWriterProcessGroups');
    expect(source).not.toMatch(/process\.kill\([^\n]+SIGSTOP/);
    expect(source).not.toMatch(/process\.kill\([^\n]+SIGCONT/);
  });
});
