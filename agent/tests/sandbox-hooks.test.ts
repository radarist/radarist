/**
 * Enforcement-hook tests: spawn the REAL gate-lib.mjs (the file baked into
 * the sandbox image) against fixture workspaces — exit codes are the
 * contract (0 allow, 2 block).
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const GATE = path.resolve('src/sandbox/template/hooks/gate-lib.mjs');

function runGate(mode: 'post-tool' | 'stop', cwd: string, input: object = {}) {
  const result = spawnSync('node', [GATE, mode], {
    cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: result.status, stderr: result.stderr };
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-ws-'));
  fs.mkdirSync(path.join(dir, '.impulse'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  return dir;
}

function writeStatus(dir: string, status: object) {
  fs.writeFileSync(path.join(dir, '.impulse', 'STATUS.json'), JSON.stringify(status));
}

const midMissionStatus = {
  phase: '02-user-flows',
  readyForQa: false,
  stories: [],
  blocked: null,
  handoff: { reason: 'cap', nextObjective: 'write flows' },
  notes: [],
};

describe('stop gate', () => {
  it('blocks when STATUS.json is missing', () => {
    const dir = makeWorkspace();
    const { code, stderr } = runGate('stop', dir);
    expect(code).toBe(2);
    expect(stderr).toContain('STATUS.json');
  });

  it('allows a mid-mission stop with completed artifacts + fresh handoff', () => {
    const dir = makeWorkspace();
    writeStatus(dir, midMissionStatus);
    fs.writeFileSync(path.join(dir, 'docs', '00-inception.md'), 'x');
    fs.writeFileSync(path.join(dir, 'docs', '01-brainstorm.md'), 'x');
    expect(runGate('stop', dir).code).toBe(0);
  });

  it('blocks when a completed-phase artifact is missing', () => {
    const dir = makeWorkspace();
    writeStatus(dir, midMissionStatus);
    fs.writeFileSync(path.join(dir, 'docs', '00-inception.md'), 'x');
    const { code, stderr } = runGate('stop', dir);
    expect(code).toBe(2);
    expect(stderr).toContain('01-brainstorm');
  });

  it('re-blocks under stop_hook_active, then gives up on the third attempt', () => {
    const dir = makeWorkspace();
    // No handoff → violation that persists across attempts.
    writeStatus(dir, { ...midMissionStatus, handoff: null, phase: '00-inception' });
    expect(runGate('stop', dir).code).toBe(2);
    expect(runGate('stop', dir, { stop_hook_active: true }).code).toBe(2);
    expect(runGate('stop', dir, { stop_hook_active: true }).code).toBe(0); // bounded give-up
    expect(runGate('stop', dir).code).toBe(2); // counter cleared → fresh loop blocks again
  });

  it('honors the supervisor force-stop escape hatch', () => {
    const dir = makeWorkspace();
    fs.writeFileSync(path.join(dir, '.impulse', 'force-stop'), '');
    expect(runGate('stop', dir).code).toBe(0);
  });

  it('requires a PASS qa-report when phase is done', () => {
    const dir = makeWorkspace();
    const doneStatus = { ...midMissionStatus, phase: 'done', handoff: null };
    // All phase artifacts present:
    for (const artifact of [
      'docs/00-inception.md',
      'docs/01-brainstorm.md',
      'docs/02-user-flows.md',
      'docs/03-design-system.md',
      'docs/04-stories.md',
      'docs/05-adr.md',
      'docs/07-test-report.md',
    ]) {
      fs.writeFileSync(path.join(dir, artifact), 'x');
    }
    fs.writeFileSync(path.join(dir, '.impulse', 'checks.json'), JSON.stringify({ checks: [] }));
    writeStatus(dir, doneStatus);
    fs.writeFileSync(
      path.join(dir, '.impulse', 'qa-report.json'),
      JSON.stringify({ verdict: 'FAIL', checkedAt: 'x', findings: [] })
    );
    expect(runGate('stop', dir).code).toBe(2);
    fs.writeFileSync(
      path.join(dir, '.impulse', 'qa-report.json'),
      JSON.stringify({ verdict: 'PASS', checkedAt: 'x', findings: [] })
    );
    expect(runGate('stop', dir).code).toBe(0);
  });
});

describe('post-tool gate', () => {
  it('blocks an edit whose matching check fails, with output on stderr', () => {
    const dir = makeWorkspace();
    fs.writeFileSync(
      path.join(dir, '.impulse', 'checks.json'),
      JSON.stringify({
        checks: [
          { id: 'S1-AC1', story: 'S1', files: ['src/**'], command: 'echo broken assertion >&2; exit 1' },
          { id: 'S2-AC1', story: 'S2', files: ['lib/**'], command: 'exit 0' },
        ],
      })
    );
    const blocked = runGate('post-tool', dir, { tool_name: 'Edit', tool_input: { file_path: `${dir}/src/app.ts` } });
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('S1-AC1');
    expect(blocked.stderr).toContain('broken assertion');
  });

  it('allows edits that match only passing checks, doc edits, and pre-phase-04 edits', () => {
    const dir = makeWorkspace();
    expect(runGate('post-tool', dir, { tool_name: 'Edit', tool_input: { file_path: `${dir}/src/a.ts` } }).code).toBe(0); // no checks.json yet
    fs.writeFileSync(
      path.join(dir, '.impulse', 'checks.json'),
      JSON.stringify({ checks: [{ id: 'S2-AC1', story: 'S2', files: ['lib/**'], command: 'exit 0' }] })
    );
    expect(runGate('post-tool', dir, { tool_name: 'Edit', tool_input: { file_path: `${dir}/lib/u.ts` } }).code).toBe(0);
    expect(runGate('post-tool', dir, { tool_name: 'Write', tool_input: { file_path: `${dir}/docs/x.md` } }).code).toBe(
      0
    );
    expect(runGate('post-tool', dir, {}).code).toBe(0); // no file_path → no-op
  });
});
