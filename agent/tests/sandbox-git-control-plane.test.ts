import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadBuildConfig } from '../src/sandbox/config.js';
import { refreshWorkspaceControlPlane } from '../src/sandbox/provisioner.js';
import { listWorkspaceChangesSince, readWorkspaceGitHead } from '../src/sandbox/status.js';
import type { ExecResult, SandboxDriver, SandboxRef } from '../src/sandbox/types.js';

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string, mode?: number): string {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  if (mode !== undefined) fs.chmodSync(target, mode);
  return target;
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

describe('trusted workspace Git control plane', () => {
  it('neutralizes hostile config/helpers and exposes index-hidden worktree mutations', async () => {
    const attackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-hostile-git-'));
    temporaryDirectories.push(attackRoot);
    const workspace = path.join(attackRoot, 'workspace');
    fs.mkdirSync(workspace);
    write(workspace, 'MISSION.md', '# Mission\n');
    write(workspace, '.impulse/STATUS.json', '{"phase":"07-self-test"}\n');
    write(workspace, '.claude/settings.json', '{}\n');
    write(workspace, '.mcp.json', '{"mcpServers":{}}\n');
    write(workspace, 'src/assumed.ts', 'export const assumed = 1;\n');
    write(workspace, 'src/skipped.ts', 'export const skipped = 1;\n');
    git(workspace, 'init', '-q');
    git(workspace, 'config', 'user.email', 'builder@example.test');
    git(workspace, 'config', 'user.name', 'Builder');
    git(workspace, 'add', '--all');
    git(workspace, 'commit', '-qm', 'seed');
    git(workspace, 'update-index', '--assume-unchanged', 'src/assumed.ts');
    git(workspace, 'update-index', '--skip-worktree', 'src/skipped.ts');
    write(workspace, 'src/assumed.ts', 'export const assumed = 2;\n');
    write(workspace, 'src/skipped.ts', 'export const skipped = 2;\n');
    expect(git(workspace, 'status', '--short', '--', 'src/assumed.ts', 'src/skipped.ts')).toBe('');

    const marker = path.join(attackRoot, 'HOSTILE_HELPER_RAN');
    const helper = write(workspace, '.git/poison-helper.sh', `#!/bin/sh\nprintf ran >> "${marker}"\nexit 97\n`, 0o755);
    write(workspace, '.git/config', `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\thooksPath = .git/hooks\n\tfsmonitor = ${helper}\n\tattributesFile = .git/info/attributes\n[extensions]\n\tworktreeConfig = true\n[filter "poison"]\n\tclean = ${helper}\n\tsmudge = ${helper}\n\trequired = true\n`);
    write(workspace, '.git/config.worktree', `[core]\n\tfsmonitor = ${helper}\n\thooksPath = ${path.join(workspace, '.git/hooks')}\n`);
    write(workspace, '.git/info/attributes', 'src/*.ts filter=poison\n');
    write(workspace, '.git/hooks/pre-commit', `#!/bin/sh\nprintf hook >> "${marker}"\nexit 98\n`, 0o755);
    write(workspace, '.git/commondir', '.\n');
    write(workspace, '.git/objects/info/alternates', '/nonexistent/hostile-objects\n');
    write(workspace, '.git/refs/replace/0000000000000000000000000000000000000000', 'bad\n');

    const hostileHome = path.join(attackRoot, 'home');
    write(hostileHome, '.gitconfig', `[core]\n\tfsmonitor = ${helper}\n\thooksPath = ${path.join(workspace, '.git/hooks')}\n`);
    const hostileBin = path.join(attackRoot, 'bin');
    write(hostileBin, 'git', `#!/bin/sh\nprintf fake-git >> "${marker}"\nexit 96\n`, 0o755);
    const calls: string[][] = [];
    const driver = {
      exec: async (_ref: SandboxRef, argv: string[], opts?: { timeoutMs?: number; input?: string }): Promise<ExecResult> => {
        calls.push(argv);
        const result = spawnSync(argv[0], argv.slice(1), {
          cwd: workspace,
          input: opts?.input,
          encoding: 'utf8',
          timeout: opts?.timeoutMs,
          env: {
            ...process.env,
            HOME: hostileHome,
            PATH: `${hostileBin}:${process.env.PATH ?? ''}`,
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'core.fsmonitor',
            GIT_CONFIG_VALUE_0: helper,
          },
        });
        return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr || result.error?.message || '' };
      },
    } as unknown as SandboxDriver;
    const ref = { driver: 'docker', missionId: 'hostile-git', workspacePath: workspace } as SandboxRef;

    const refresh = await refreshWorkspaceControlPlane({
      cfg: loadBuildConfig({ env: {} }), missionId: 'hostile-git', driver, ref,
    });
    expect(refresh.changed).toBe(true);
    const head = await readWorkspaceGitHead(driver, ref);
    expect(head).toBe(refresh.commit);
    await expect(listWorkspaceChangesSince(driver, ref, head!)).resolves.toEqual([
      'src/assumed.ts', 'src/skipped.ts',
    ]);

    expect(fs.existsSync(marker)).toBe(false);
    const localConfig = fs.readFileSync(path.join(workspace, '.git/config'), 'utf8');
    expect(localConfig).toContain('hooksPath = /dev/null');
    expect(localConfig).toContain('fsmonitor = false');
    expect(localConfig).not.toContain('poison');
    for (const removed of ['config.worktree', 'commondir', 'info/attributes', 'objects/info/alternates', 'refs/replace']) {
      expect(fs.existsSync(path.join(workspace, '.git', removed))).toBe(false);
    }
    expect(fs.readdirSync(path.join(workspace, '.git/hooks'))).toEqual([]);
    expect(git(workspace, 'ls-files', '-v', '--', 'src/assumed.ts', 'src/skipped.ts').split('\n'))
      .toEqual(['H src/assumed.ts', 'H src/skipped.ts']);
    const trustedGitCalls = calls.filter((argv) => argv.includes('/usr/bin/git'));
    expect(trustedGitCalls.length).toBeGreaterThan(5);
    for (const argv of trustedGitCalls) {
      expect(argv.slice(0, 2)).toEqual(['/usr/bin/env', '-i']);
      expect(argv).toContain('GIT_CONFIG_NOSYSTEM=1');
      expect(argv).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    }
    const resetShellCall = calls.find(
      (argv) => argv.includes('/bin/sh') && argv.some((part) => part.includes('config.supervisor'))
    );
    expect(resetShellCall?.join(' ')).toContain('/usr/bin/mktemp .git/config.supervisor.XXXXXX');
    expect(resetShellCall?.join(' ')).not.toContain('config.supervisor.$$');
    expect(calls.some((argv) => argv[0] === 'git' || argv[0] === path.join(hostileBin, 'git'))).toBe(false);
  });
});
