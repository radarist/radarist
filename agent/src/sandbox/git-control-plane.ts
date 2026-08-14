/** Trusted Git boundary for supervisor-owned workspace inspection. */
import type { ExecResult, SandboxDriver, SandboxRef } from './types.js';

const CLEAN_ENV_ARGV = [
  '/usr/bin/env',
  '-i',
  'HOME=/nonexistent',
  'XDG_CONFIG_HOME=/nonexistent',
  'PATH=/usr/bin:/bin',
  'LANG=C',
  'LC_ALL=C',
  'GIT_CONFIG_NOSYSTEM=1',
  'GIT_CONFIG_GLOBAL=/dev/null',
  'GIT_ATTR_NOSYSTEM=1',
  'GIT_NO_REPLACE_OBJECTS=1',
  'GIT_TERMINAL_PROMPT=0',
] as const;

const SUPERVISOR_GIT_CONFIG = `[core]
	repositoryformatversion = 0
	filemode = true
	bare = false
	logallrefupdates = true
	hooksPath = /dev/null
	attributesFile = /dev/null
	excludesFile = /dev/null
	fsmonitor = false
	untrackedCache = false
	splitIndex = false
[user]
	name = Mission Supervisor
	email = supervisor@radarist.local
[commit]
	gpgSign = false
[tag]
	gpgSign = false
`;

const detail = (result: ExecResult) => (result.stderr || result.stdout).trim();

export async function runTrustedWorkspaceGit(
  driver: SandboxDriver,
  ref: SandboxRef,
  args: string[]
): Promise<ExecResult> {
  return driver.exec(ref, [...CLEAN_ENV_ARGV, '/usr/bin/git', ...args]);
}

/**
 * Replace builder-controlled Git execution settings and rebuild the index from
 * the verified HEAD tree. The worktree itself is not changed.
 */
export async function resetWorkspaceGitControlPlane(driver: SandboxDriver, ref: SandboxRef): Promise<void> {
  const config = await driver.exec(
    ref,
    [
      ...CLEAN_ENV_ARGV,
      '/bin/sh',
      '-c',
      [
        'set -eu',
        'test -d .git && test ! -L .git',
        'test -f .git/HEAD && test ! -L .git/HEAD',
        'test -f .git/config && test ! -L .git/config',
        'test -d .git/objects && test ! -L .git/objects',
        'if [ -e .git/objects/info ] || [ -L .git/objects/info ]; then test -d .git/objects/info && test ! -L .git/objects/info; fi',
        'test -d .git/refs && test ! -L .git/refs',
        'umask 077',
        'tmp=$(/usr/bin/mktemp .git/config.supervisor.XXXXXX)',
        "trap '/bin/rm -f -- \"$tmp\"' 0 1 2 15",
        '/bin/cat > "$tmp"',
        '/bin/chmod 0600 "$tmp"',
        '/bin/mv -f -- "$tmp" .git/config',
        'trap - 0 1 2 15',
        '/bin/rm -rf -- .git/commondir .git/config.worktree .git/hooks .git/info .git/objects/info/alternates .git/refs/replace',
        '/bin/mkdir -p -- .git/hooks .git/info',
        '/bin/chmod 0700 .git/hooks .git/info',
      ].join('; '),
    ],
    { input: SUPERVISOR_GIT_CONFIG }
  );
  if (config.code !== 0) {
    throw new Error(`Failed to reset workspace Git config: ${detail(config)}`.trim());
  }

  const verified = await runTrustedWorkspaceGit(driver, ref, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const head = verified.stdout.trim();
  if (verified.code !== 0 || !/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error(`Failed to verify workspace Git HEAD: ${detail(verified)}`.trim());
  }

  const removed = await driver.exec(ref, [
    ...CLEAN_ENV_ARGV,
    '/bin/sh',
    '-c',
    '/bin/rm -rf -- .git/index .git/index.lock .git/sharedindex.*',
  ]);
  if (removed.code !== 0) {
    throw new Error(`Failed to remove untrusted workspace Git index: ${detail(removed)}`.trim());
  }

  const readTree = await runTrustedWorkspaceGit(driver, ref, ['read-tree', '--reset', head]);
  if (readTree.code !== 0) {
    throw new Error(`Failed to rebuild workspace Git index: ${detail(readTree)}`.trim());
  }

  const [expected, actual] = await Promise.all([
    runTrustedWorkspaceGit(driver, ref, ['rev-parse', '--verify', `${head}^{tree}`]),
    runTrustedWorkspaceGit(driver, ref, ['write-tree']),
  ]);
  const expectedTree = expected.stdout.trim();
  if (
    expected.code !== 0 ||
    actual.code !== 0 ||
    !/^[0-9a-f]{40}$/i.test(expectedTree) ||
    actual.stdout.trim() !== expectedTree
  ) {
    throw new Error(`Workspace Git index verification failed: ${detail(expected) || detail(actual)}`.trim());
  }
}
