/**
 * @jest-environment node
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { AgentRuntimeUnavailableError, assertAgentRuntimeAvailable } from '../agent-import';

describe('optional agent runtime availability guard', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'radarist-agent-runtime-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('explains how to enable missions when setup has not run', () => {
    expect(() => assertAgentRuntimeAvailable('orchestrator-lite.js', root)).toThrow(
      AgentRuntimeUnavailableError
    );
    expect(() => assertAgentRuntimeAvailable('orchestrator-lite.js', root)).toThrow(
      /Run `npm run setup:agents` from the repository root/
    );
  });

  it('reports missing dependencies even when a stale compiled artifact exists', () => {
    const distPath = join(root, 'agent', 'dist', 'orchestrator-lite.js');
    mkdirSync(dirname(distPath), { recursive: true });
    writeFileSync(distPath, 'export {};');

    expect(() => assertAgentRuntimeAvailable('orchestrator-lite.js', root)).toThrow(
      /dependencies are not installed/
    );
  });

  it('returns the compiled artifact only after dependencies and build output exist', () => {
    const distPath = join(root, 'agent', 'dist', 'sandbox', 'index.js');
    mkdirSync(join(root, 'agent', 'node_modules'), { recursive: true });
    mkdirSync(dirname(distPath), { recursive: true });
    writeFileSync(distPath, 'export {};');

    expect(assertAgentRuntimeAvailable(join('sandbox', 'index.js'), root)).toBe(distPath);
  });
});
