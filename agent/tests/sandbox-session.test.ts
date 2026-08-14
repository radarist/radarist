/** Session wrapper script + path contracts. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { jest } from '@jest/globals';
import {
  KICKOFF_PROMPT,
  QA_REVIEW_PROMPT,
  SESSION_CONTROL_ROOT,
  SESSION_HOME_ROOT,
  buildGoalKickoff,
  buildKillSessionScript,
  buildSessionScript,
  isSessionDone,
  killSession,
  launchSession,
  quiesceSession,
  readFullTranscript,
  readSessionExitCode,
  readTranscriptFrom,
  sessionPaths,
} from '../src/sandbox/session.js';

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

function hostRunnableSessionScript(
  value: string,
  roots: { control: string; homes: string },
  fakeClaude: string
): string {
  let runnable = value
    .replace(/\/usr\/bin\/timeout --foreground --signal=TERM --kill-after=30s [^ ]+ /, '')
    .replace(
      '/usr/bin/setpriv --reuid=node --regid=node --init-groups --no-new-privs --inh-caps=-all --ambient-caps=-all --bounding-set=-all ',
      ''
    )
    .replace('/usr/bin/install -d -o node -g node -m 0700 --', '/usr/bin/install -d -m 0700 --')
    .replaceAll(SESSION_CONTROL_ROOT, roots.control)
    .replaceAll(SESSION_HOME_ROOT, roots.homes)
    .replace('/usr/local/bin/claude', shellQuote(fakeClaude));
  // macOS has no Linux /proc. Keep the functional wrapper tests focused on
  // env isolation/replay while production-shape tests assert the real kernel
  // identity transaction separately.
  const identityStart = runnable.indexOf('wrapper_pgid=');
  const identityEnd = runnable.indexOf('identity_tmp=', identityStart);
  if (identityStart === -1 || identityEnd === -1) throw new Error('session identity block not found');
  runnable = `${runnable.slice(0, identityStart)}wrapper_pgid=$wrapper_pid; wrapper_start=1; session_token=abc; ${runnable.slice(identityEnd)}`;
  return runnable;
}

describe('sessionPaths', () => {
  it('derives the per-session contract files', () => {
    expect(sessionPaths(3)).toEqual({
      wrapper: '/run/impulse-supervisor/session-3.wrapper.sh',
      identity: '/run/impulse-supervisor/session-3.identity',
      transcript: '/run/impulse-supervisor/session-3.jsonl',
      stderr: '/run/impulse-supervisor/session-3.stderr.log',
      exitcode: '/run/impulse-supervisor/session-3.exitcode',
      launchLock: '/run/impulse-supervisor/session-3.launch',
    });
    expect(() => sessionPaths(-1)).toThrow(/invalid session index/);
  });
});

describe('buildSessionScript', () => {
  const spec = {
    index: 2,
    model: 'claude-sonnet-4-6',
    maxTurns: 80,
    maxMinutes: 30,
    prompt: KICKOFF_PROMPT,
  };
  const script = buildSessionScript(spec);
  it('runs the frozen kickoff headless with stream-json and the permission bypass', () => {
    expect(script).toContain(`claude -p '${KICKOFF_PROMPT}'`);
    expect(script).toContain('--output-format stream-json');
    expect(script).toContain('--verbose');
    expect(script).toContain('--max-turns 80');
    expect(script).toContain("--model 'claude-sonnet-4-6'");
    expect(script).toContain('--dangerously-skip-permissions');
  });

  it('writes fresh logs and atomically records the exit code', () => {
    expect(script).toContain("/bin/rm -f -- '/run/impulse-supervisor/session-2.exitcode'");
    expect(script).toContain(": > '/run/impulse-supervisor/session-2.jsonl'");
    expect(script).toContain(": > '/run/impulse-supervisor/session-2.stderr.log'");
    expect(script).toContain(">> '/run/impulse-supervisor/session-2.jsonl'");
    expect(script).toContain("2>> '/run/impulse-supervisor/session-2.stderr.log'");
    expect(script).toContain("exit_tmp='/run/impulse-supervisor/session-2.exitcode.tmp'.$$");
    expect(script).toContain('/bin/mv -f -- "$exit_tmp"');
  });

  it('keeps session authority root-only and drops only the Claude child to node', () => {
    expect(script).toContain("if ! /bin/mkdir -- '/run/impulse-supervisor/session-2.launch'");
    expect(script).toContain('/usr/bin/setpriv --reuid=node --regid=node --init-groups --no-new-privs');
    expect(script).toContain('--inh-caps=-all --ambient-caps=-all --bounding-set=-all');
    expect(script).toContain('/usr/local/bin/claude');
    expect(script).toContain('/usr/bin/env -u IMPULSE_SESSION_TOKEN');
    expect(script).toContain('session_token=${IMPULSE_SESSION_TOKEN:-}; unset IMPULSE_SESSION_TOKEN');
    expect(script).toContain('USER=node LOGNAME=node');
    expect(script).not.toContain('.impulse/session-2');
  });

  it('publishes an exact root-owned process identity before starting paid work', () => {
    expect(script).toContain('wrapper_pid=$$');
    expect(script).toContain("wrapper_pgid=$(/bin/ps -o pgid= -p \"$wrapper_pid\"");
    expect(script).toContain("wrapper_start=$(/usr/bin/awk '{print $22}' \"/proc/$wrapper_pid/stat\"");
    expect(script).toContain('session_token=${IMPULSE_SESSION_TOKEN:-}');
    expect(script).toContain("identity_tmp='/run/impulse-supervisor/session-2.identity.tmp'.$$");
    expect(script).toContain("/bin/mv -f -- \"$identity_tmp\" '/run/impulse-supervisor/session-2.identity'");
    expect(script).toContain('record_exit 125; exit 125');
  });

  it('is valid POSIX shell syntax', () => {
    const parsed = spawnSync('sh', ['-n'], { input: script, encoding: 'utf8' });
    expect(parsed.status).toBe(0);
    expect(parsed.stderr).toBe('');
  });

  it('enforces maxMinutes inside the container independently of supervisor polling', () => {
    expect(script).toContain('/usr/bin/timeout --foreground --signal=TERM --kill-after=30s 1800s');
    const dockerfile = fs.readFileSync(path.resolve('src/sandbox/template/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/apt-get install[^\n]*coreutils/);
    expect(() => buildSessionScript({ ...spec, maxMinutes: 0 })).toThrow(/maxMinutes/);
    expect(() => buildSessionScript({ ...spec, maxMinutes: Number.POSITIVE_INFINITY })).toThrow(/maxMinutes/);
  });

  it('shell-quotes prompts safely', () => {
    const hostile = buildSessionScript({ ...spec, prompt: "it's; rm -rf /" });
    expect(hostile).toContain(`'it'\\''s; rm -rf /'`);
  });

  // BUILD-014 — the CLI must be capped per launch so one session cannot
  // overrun the remaining mission budget before the post-hoc gate catches it.
  it('caps the CLI spend with --max-budget-usd when a per-session budget is set', () => {
    const capped = buildSessionScript({ ...spec, maxBudgetUsd: 6 });
    expect(capped).toContain('--max-budget-usd 6');
  });

  it('passes fractional budgets verbatim (e.g. a nearly-exhausted mission budget)', () => {
    const capped = buildSessionScript({ ...spec, maxBudgetUsd: 0.75 });
    expect(capped).toContain('--max-budget-usd 0.75');
  });

  it('omits the flag entirely when no per-session budget is configured', () => {
    expect(script).not.toContain('--max-budget-usd');
  });

  // AUDIT-016 — THIS CONTRACT IS DELIBERATELY INVERTED.
  //
  // These two cases previously asserted that a 0/negative budget OMITS the flag.
  // That is a fail-OPEN: omitting `--max-budget-usd` runs the CLI with no cap at
  // all, so "the mission has no money left" silently became "spend without
  // limit". It was unreachable until AUDIT-016 seeded the supervisor's spend
  // counter from cumulative mission cost — at which point an exhausted mission
  // computes `remaining === 0` and would have taken exactly this path.
  //
  // A present-but-non-positive budget is now an error, not a licence.
  it.each([0, -1, NaN, Infinity])('throws rather than launching uncapped when the budget is %p', (bad) => {
    expect(() => buildSessionScript({ ...spec, maxBudgetUsd: bad })).toThrow(/no spend headroom/);
  });

  it('still treats an ABSENT budget as an explicit opt-out of the per-session cap', () => {
    expect(() => buildSessionScript(spec)).not.toThrow();
    expect(buildSessionScript(spec)).not.toContain('--max-budget-usd');
  });

  // BUILD-012/013 — the limitless tier raises the CLI effort level.
  it('raises the effort tier with --effort when set', () => {
    expect(buildSessionScript({ ...spec, effort: 'high' })).toContain("--effort 'high'");
    expect(buildSessionScript({ ...spec, effort: 'max' })).toContain("--effort 'max'");
  });

  it('omits --effort at the default (standard tier is byte-identical to before)', () => {
    expect(script).not.toContain('--effort');
  });

  it('strips stale secret env from a reused container while preserving current explicit opt-ins', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-session-env-'));
    const roots = {
      control: path.join(workspace, 'root-control'),
      homes: path.join(workspace, 'session-homes'),
    };
    try {
      fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.impulse'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'bin'), { recursive: true });
      fs.mkdirSync(roots.control, { recursive: true });
      fs.mkdirSync(roots.homes, { recursive: true });
      fs.mkdirSync(path.join(workspace, 'builder-home/.claude'), { recursive: true });
      fs.writeFileSync(path.join(workspace, 'builder-home/.claude/poison'), 'builder state\n');
      fs.writeFileSync(
        path.join(workspace, '.claude/.supervisor-env-allowlist'),
        'ANTHROPIC_API_KEY\nDATABASE_URL\nEXA_API_KEY\n'
      );
      const fakeClaude = path.join(workspace, 'bin/claude');
      fs.writeFileSync(
        fakeClaude,
        [
          '#!/bin/sh',
          'printf "anthropic=%s\\n" "$ANTHROPIC_API_KEY"',
          'printf "exa=%s\\n" "$EXA_API_KEY"',
          'printf "firecrawl=%s\\n" "$FIRECRAWL_API_KEY"',
          'printf "github=%s\\n" "$GITHUB_TOKEN"',
          'printf "internal=%s\\n" "$IMPULSE_INTERNAL_KEY"',
          'printf "aws=%s\\n" "$AWS_SECRET_ACCESS_KEY"',
          'printf "database=%s\\n" "$DATABASE_URL"',
          'printf "lowercase=%s\\n" "$secret_key"',
          'printf "home=%s\\n" "$HOME"',
          'printf "xdg=%s\\n" "$XDG_CONFIG_HOME"',
          'printf "claude_config=%s\\n" "$CLAUDE_CONFIG_DIR"',
          'test ! -e "$HOME/.claude/poison" && printf "home_clean=yes\\n"',
        ].join('\n')
      );
      fs.chmodSync(fakeClaude, 0o755);

      const result = spawnSync('sh', ['-c', hostRunnableSessionScript(script, roots, fakeClaude)], {
        cwd: workspace,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${path.join(workspace, 'bin')}:${process.env.PATH ?? ''}`,
          HOME: path.join(workspace, 'builder-home'),
          ANTHROPIC_API_KEY: 'current-anthropic',
          EXA_API_KEY: 'current-exa',
          FIRECRAWL_API_KEY: 'stale-firecrawl',
          GITHUB_TOKEN: 'stale-github',
          IMPULSE_INTERNAL_KEY: 'stale-internal',
          AWS_SECRET_ACCESS_KEY: 'stale-aws',
          DATABASE_URL: 'current-explicit-database',
          secret_key: 'stale-lowercase',
        },
      });
      expect(result.status).toBe(0);
      expect(fs.readFileSync(path.join(roots.control, 'session-2.jsonl'), 'utf8')).toBe(
        [
          'anthropic=current-anthropic',
          'exa=current-exa',
          'firecrawl=',
          'github=',
          'internal=',
          'aws=',
          'database=current-explicit-database',
          'lowercase=',
          `home=${roots.homes}/2`,
          `xdg=${roots.homes}/2/.config`,
          `claude_config=${roots.homes}/2/.claude`,
          'home_clean=yes',
          '',
        ].join('\n')
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('fails closed when the supervisor env allowlist is missing', () => {
    expect(script).toContain('.claude/.supervisor-env-allowlist');
    expect(script).toContain('|| unset "$key"');
  });

  it('starts the paid CLI at most once when a detached launch is replayed', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-session-replay-'));
    const replaySpec = { ...spec, index: 91 };
    const roots = {
      control: path.join(workspace, 'root-control'),
      homes: path.join(workspace, 'session-homes'),
    };
    try {
      fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(workspace, '.impulse'), { recursive: true });
      fs.mkdirSync(path.join(workspace, 'bin'), { recursive: true });
      fs.mkdirSync(roots.control, { recursive: true });
      fs.mkdirSync(roots.homes, { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude/.supervisor-env-allowlist'), '');
      // These are the exact old workspace authority names. A mission may forge
      // them, but the supervisor no longer reads or locks on this volume.
      fs.mkdirSync(path.join(workspace, '.impulse/session-91.launch'));
      fs.writeFileSync(path.join(workspace, '.impulse/session-91.exitcode'), '0\n');
      fs.writeFileSync(path.join(workspace, '.impulse/session-91.jsonl'), 'forged workspace result\n');
      const fakeClaude = path.join(workspace, 'bin/claude');
      fs.writeFileSync(
        fakeClaude,
        '#!/bin/sh\nprintf "invoked\\n" >> invocation-count\nprintf "authoritative transcript\\n"\n'
      );
      fs.chmodSync(fakeClaude, 0o755);
      const replayScript = hostRunnableSessionScript(buildSessionScript(replaySpec), roots, fakeClaude);
      const options = {
        cwd: workspace,
        encoding: 'utf8' as const,
        env: { ...process.env, PATH: `${path.join(workspace, 'bin')}:${process.env.PATH ?? ''}` },
      };

      expect(spawnSync('sh', ['-c', replayScript], options).status).toBe(0);
      expect(spawnSync('sh', ['-c', replayScript], options).status).toBe(0);

      expect(fs.readFileSync(path.join(workspace, 'invocation-count'), 'utf8')).toBe('invoked\n');
      expect(fs.readFileSync(path.join(roots.control, 'session-91.jsonl'), 'utf8')).toBe(
        'authoritative transcript\n'
      );
      expect(fs.readFileSync(path.join(roots.control, 'session-91.exitcode'), 'utf8')).toBe('0\n');
      expect(fs.statSync(path.join(roots.control, 'session-91.launch')).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(workspace, '.impulse/session-91.jsonl'), 'utf8')).toBe(
        'forged workspace result\n'
      );
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('installs and launches the wrapper as root without exposing authority files to mission code', async () => {
    const driver = {
      exec: jest.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      execDetached: jest.fn(async () => undefined),
    };
    await launchSession(driver as never, {} as never, spec);
    expect(driver.exec).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      ['/bin/sh', '-c', expect.stringContaining("install -d -o root -g root -m 0700 -- '/run/impulse-supervisor'")],
      {
        input: expect.stringContaining('/usr/bin/setpriv --reuid=node --regid=node'),
        user: 'root',
      }
    );
    expect(driver.execDetached).toHaveBeenCalledWith(
      expect.anything(),
      [
        '/bin/sh',
        '-c',
        expect.stringContaining(
          'exec /usr/bin/env IMPULSE_SESSION_TOKEN="$session_token" /usr/bin/setsid /bin/sh'
        ),
      ],
      { user: 'root' }
    );
    expect(driver.exec.mock.invocationCallOrder[2]).toBeLessThan(driver.execDetached.mock.invocationCallOrder[0]);
  });

  it('fails closed before installing a wrapper when force-stop cannot be cleared', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'remove failed' })
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' }),
      execDetached: jest.fn(async () => undefined),
    };

    await expect(launchSession(driver as never, {} as never, spec)).rejects.toThrow(/failed to clear force-stop/);
    expect(driver.exec).toHaveBeenCalledTimes(2);
    expect(driver.execDetached).not.toHaveBeenCalled();
  });

  it('fails closed before detached launch when the root wrapper cannot be installed', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'read-only runtime layer' }),
      execDetached: jest.fn(async () => undefined),
    };

    await expect(launchSession(driver as never, {} as never, spec)).rejects.toThrow(/read-only runtime layer/);
    expect(driver.execDetached).not.toHaveBeenCalled();
  });

  it('reads every trusted marker and transcript through an explicit root exec', async () => {
    const driver = {
      exec: jest.fn(async (_ref: unknown, argv: string[], _opts?: unknown) => ({
        code: 0,
        stdout: argv.includes('/bin/cat') ? '0\n' : 'chunk',
        stderr: '',
      })),
    };
    const ref = {} as never;

    await expect(isSessionDone(driver as never, ref, 2)).resolves.toBe(true);
    await expect(readSessionExitCode(driver as never, ref, 2)).resolves.toBe(0);
    await expect(readTranscriptFrom(driver as never, ref, 2, 0)).resolves.toMatchObject({ chunk: 'chunk' });
    await expect(readFullTranscript(driver as never, ref, 2)).resolves.toBe('0\n');

    for (const call of driver.exec.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ user: 'root' }));
      expect((call[1] as string[]).join(' ')).toContain('/run/impulse-supervisor/session-2');
    }
    await expect(readTranscriptFrom(driver as never, ref, 2, -1)).rejects.toThrow(/invalid session transcript offset/);
  });
});

describe('killSession', () => {
  const ref = {} as never;

  it('targets only the trusted session process group and proves its exit marker', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '143\n', stderr: '' }),
    };

    await expect(killSession(driver as never, ref, 7)).resolves.toBeUndefined();

    const killCall = driver.exec.mock.calls[2] as unknown as [unknown, string[], unknown];
    expect(killCall[1]).toEqual(['/bin/sh', '-c', expect.any(String)]);
    expect(killCall[2]).toEqual({ timeoutMs: 25_000, user: 'root' });
    const transaction = killCall[1][2];
    expect(transaction).toContain("identity='/run/impulse-supervisor/session-7.identity'");
    expect(transaction).toContain("exitcode='/run/impulse-supervisor/session-7.exitcode'");
    expect(transaction).toContain('/bin/kill -TERM -- "-$session_pgid"');
    expect(transaction).toContain('/bin/kill -KILL -- "-$session_pgid"');
    expect(transaction).toContain('IMPULSE_SESSION_TOKEN=$session_token');
    expect(transaction).toContain('marker_seen=1');
    expect(transaction).not.toMatch(/marker_seen=1;?\s*exit 0/);
    expect(transaction).not.toContain('pkill');
    expect(driver.exec).toHaveBeenNthCalledWith(
      4,
      ref,
      ['/bin/cat', '/run/impulse-supervisor/session-7.exitcode'],
      { user: 'root' }
    );
  });

  it('fails before signaling when the force-stop gate cannot be verified', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'write failed' })
        .mockResolvedValueOnce({ code: 1, stdout: '', stderr: '' }),
    };
    await expect(killSession(driver as never, ref, 7)).rejects.toThrow(/failed to arm force-stop/);
    expect(driver.exec).toHaveBeenCalledTimes(2);
  });

  it('propagates trusted cancellation diagnostics and never claims success', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 72, stdout: '', stderr: 'identity mismatch\n' }),
    };
    await expect(killSession(driver as never, ref, 7)).rejects.toThrow(/identity mismatch/);
    expect(driver.exec).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the post-kill exit marker is missing or malformed', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: 'forged\n', stderr: '' }),
    };
    await expect(killSession(driver as never, ref, 7)).rejects.toThrow(/exit marker was not verifiable/);
  });

  it('exposes the same verified transaction for natural-completion quiescence without arming force-stop', async () => {
    const driver = {
      exec: jest
        .fn<() => Promise<{ code: number; stdout: string; stderr: string }>>()
        .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
        .mockResolvedValueOnce({ code: 0, stdout: '0\n', stderr: '' }),
    };
    await expect(quiesceSession(driver as never, ref, 8)).resolves.toBeUndefined();
    expect(driver.exec).toHaveBeenCalledTimes(2);
    expect(driver.exec).toHaveBeenNthCalledWith(
      1,
      ref,
      ['/bin/sh', '-c', expect.stringContaining("identity='/run/impulse-supervisor/session-8.identity'")],
      { timeoutMs: 25_000, user: 'root' }
    );
  });

  it('accepts a valid completion marker when the wrapper PID has been recycled', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'impulse-session-recycled-pid-'));
    const controlRoot = path.join(workspace, 'control');
    const recycledStat = path.join(workspace, 'recycled.stat');
    const fakeKill = path.join(workspace, 'kill');
    const killLog = path.join(workspace, 'kill.log');
    const paths = sessionPaths(92);

    try {
      fs.mkdirSync(controlRoot, { recursive: true });
      fs.writeFileSync(path.join(controlRoot, path.basename(paths.identity)), '4242 4242 1 abc\n');
      fs.writeFileSync(path.join(controlRoot, path.basename(paths.exitcode)), '0\n');
      fs.writeFileSync(recycledStat, `${Array.from({ length: 22 }, (_, index) => index + 1).join(' ')}\n`);
      fs.writeFileSync(
        fakeKill,
        ['#!/bin/sh', `printf '%s\\n' "$*" >> ${shellQuote(killLog)}`, 'test "$1" = "-0"'].join('\n')
      );
      fs.chmodSync(fakeKill, 0o755);

      const transaction = buildKillSessionScript(92)
        .replaceAll(SESSION_CONTROL_ROOT, controlRoot)
        .replaceAll('"/proc/$session_pid/stat"', shellQuote(recycledStat))
        .replaceAll('/bin/kill', shellQuote(fakeKill));
      const result = spawnSync('sh', ['-c', transaction], { encoding: 'utf8' });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(fs.readFileSync(killLog, 'utf8')).toBe('-0 -- -4242\n');
      expect(fs.readFileSync(path.join(controlRoot, path.basename(paths.exitcode)), 'utf8')).toBe('0\n');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('emits a syntactically valid bounded root cancellation transaction', () => {
    const transaction = buildKillSessionScript(5);
    const parsed = spawnSync('sh', ['-n'], { input: transaction, encoding: 'utf8' });
    expect(parsed.stderr).toBe('');
    expect(parsed.status).toBe(0);
    expect(() => buildKillSessionScript(-1)).toThrow(/invalid session index/);
  });
});

describe('buildGoalKickoff', () => {
  it('ends the solution builder at a clean phase-08 handoff without self-QA', () => {
    const k = buildGoalKickoff('solution');
    expect(k.startsWith('/goal ')).toBe(true);
    expect(k).toContain('phase 08-qa');
    expect(k).toContain('readyForQa true');
    expect(k).toContain('.impulse/qa-report.json does not exist');
    expect(k).toMatch(/design brief/i);
    expect(k).toContain('mission-methodology'); // still runs the methodology
  });

  it('evaluation goal keys on the verdict file, not design', () => {
    const k = buildGoalKickoff('evaluation');
    expect(k).toContain('.impulse/verdict.json');
    expect(k).not.toMatch(/design brief/i);
  });

  it('is distinct from the frozen standard kickoff', () => {
    expect(buildGoalKickoff('solution')).not.toBe(KICKOFF_PROMPT);
  });
});

describe('QA_REVIEW_PROMPT', () => {
  it('freezes an independent read-only reviewer role with an explicit verdict contract', () => {
    expect(QA_REVIEW_PROMPT).toContain('fresh-context Phase 08 reviewer');
    expect(QA_REVIEW_PROMPT).toContain('Do not edit product code');
    expect(QA_REVIEW_PROMPT).toContain('.impulse/qa-report.json');
    expect(QA_REVIEW_PROMPT).toContain('On PASS set STATUS.phase to done');
    expect(QA_REVIEW_PROMPT).toContain('On FAIL keep STATUS.phase at 08-qa');
  });
});
