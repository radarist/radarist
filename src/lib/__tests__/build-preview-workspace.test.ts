/** @jest-environment node */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import {
  REVIEWED_PREVIEW_MANIFEST_BASENAME,
  REVIEWED_PREVIEW_WORKSPACE,
  buildPreviewSecretScanArgv,
  buildStaticPreviewServerArgv,
  launchReviewedPreview,
  parseReviewedPreviewManifest,
} from '../build-preview-workspace';

const WS = REVIEWED_PREVIEW_WORKSPACE;
const MANIFEST_PATH = `${WS}/${REVIEWED_PREVIEW_MANIFEST_BASENAME}`;

const MANIFEST_PROBE_ARGV = [
  '/usr/bin/find',
  WS,
  '-maxdepth',
  '1',
  '-name',
  REVIEWED_PREVIEW_MANIFEST_BASENAME,
  '-printf',
  '%y %s\n',
];

type ExecResult = { code: number; stdout: string; stderr: string };
type ExecOpts = { timeoutMs?: number; input?: string; user?: 'node' | 'preview' | 'root' };

function harness(results: ExecResult[] = []) {
  const exec = jest.fn(async () => results.shift() ?? { code: 0, stdout: '', stderr: '' });
  const execDetached = jest.fn(async () => undefined);
  const sanitize = jest.fn((command: string) => `SANITIZED:${command}`);
  return { driver: { exec, execDetached }, ref: { id: 'r' }, exec, execDetached, sanitize };
}

/** Argv-keyed fake driver: routes each exec to the first matching responder. */
function contractHarness(respond: (argv: string[], opts?: ExecOpts) => Partial<ExecResult> | undefined) {
  const exec = jest.fn(async (_ref: unknown, argv: string[], opts?: ExecOpts) => ({
    code: 0,
    stdout: '',
    stderr: '',
    ...(respond(argv, opts) ?? {}),
  }));
  const execDetached = jest.fn(async () => undefined);
  const sanitize = jest.fn((command: string) => `SANITIZED:${command}`);
  return { driver: { exec, execDetached }, ref: { id: 'r' }, exec, execDetached, sanitize };
}

function launchArgs(
  h: ReturnType<typeof harness> | ReturnType<typeof contractHarness>,
  extra?: Record<string, unknown>
) {
  return {
    driver: h.driver,
    ref: h.ref,
    buildSanitizedShellCommand: h.sanitize,
    retainedWorkspacePath: '/workspace',
    containerPort: 3000,
    ...extra,
  } as Parameters<typeof launchReviewedPreview>[0];
}

/** Responder for a workspace whose manifest declares a static preview. */
function staticWorkspace(manifest: string, overrides?: (argv: string[]) => Partial<ExecResult> | undefined) {
  return (argv: string[]): Partial<ExecResult> | undefined => {
    const fromOverride = overrides?.(argv);
    if (fromOverride) return fromOverride;
    if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) {
      return { stdout: `f ${Buffer.byteLength(manifest)}\n` };
    }
    if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: manifest };
    if (argv[0] === '/usr/bin/find' && argv.includes('-type') && argv.includes('d') && argv.includes('-maxdepth')) {
      return { stdout: 'd' };
    }
    if (argv[0] === '/usr/bin/find' && argv.includes('-type') && argv.includes('f') && argv.includes('-maxdepth')) {
      return { stdout: 'f' };
    }
    if (argv[0] === '/usr/bin/realpath') return { stdout: `${argv[3]}\n` };
    if (argv[0] === '/usr/bin/find' && argv.includes('l')) return { stdout: '' };
    return undefined;
  };
}

describe('BUILD-034 reproduction — static HTML output and the hardcoded npm dev launch', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'radarist-static-output-'));
    writeFileSync(join(fixtureRoot, 'index.html'), '<!doctype html><h1>Static demo</h1>\n');
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('`npm --ignore-scripts run dev` cannot serve a static-only workspace (the failure the contract fixes)', () => {
    // This is the exact application command the launcher hardcoded before the
    // reviewed-preview contract: for a mission whose reviewed output is plain
    // static HTML there is no package.json, npm exits non-zero, nothing ever
    // listens, and readiness fails the publish.
    const result = spawnSync('npm', ['--ignore-scripts', 'run', 'dev'], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false' },
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/package\.json/i);
  });

  it('a manifest-less workspace still takes the legacy framework-dev launch path (compatibility pin)', async () => {
    const h = harness();
    await launchReviewedPreview(launchArgs(h));
    expect(h.execDetached).toHaveBeenCalledWith(
      h.ref,
      ['/bin/sh', '-c', expect.stringContaining('/usr/local/bin/npm --ignore-scripts run dev')],
      { user: 'preview' }
    );
  });

  it('the same static-only output with a static manifest launches the fixed trusted server instead of npm', async () => {
    const h = contractHarness(staticWorkspace(JSON.stringify({ mode: 'static' })));
    await launchReviewedPreview(launchArgs(h));
    const detached = h.execDetached.mock.calls[0] as unknown as [unknown, string[], { user?: string }];
    expect(detached[1][0]).toBe('/bin/sh');
    expect(detached[1][2]).toContain('/usr/local/bin/node -e');
    expect(detached[1][2]).not.toContain('npm');
    expect(detached[2]).toEqual({ user: 'preview' });
  });
});

describe('parseReviewedPreviewManifest', () => {
  it('accepts an explicit framework-dev manifest', () => {
    expect(parseReviewedPreviewManifest('{"mode":"framework-dev"}')).toEqual({ mode: 'framework-dev' });
  });

  it('accepts a static manifest and applies root/entry defaults', () => {
    expect(parseReviewedPreviewManifest('{"mode":"static"}')).toEqual({
      mode: 'static',
      root: '.',
      entry: 'index.html',
    });
  });

  it('normalizes an explicit static root and entry', () => {
    expect(parseReviewedPreviewManifest('{"mode":"static","root":"site/","entry":"demo/start.html"}')).toEqual({
      mode: 'static',
      root: 'site',
      entry: 'demo/start.html',
    });
  });

  it.each([
    ['not JSON', 'nope{', /not valid JSON/],
    ['a JSON array', '[]', /JSON object/],
    ['a JSON scalar', '"static"', /JSON object/],
    ['null', 'null', /JSON object/],
    ['an unknown key', '{"mode":"static","command":"rm -rf /"}', /unsupported key "command"/],
    ['a missing mode', '{}', /"mode" must be "framework-dev" or "static"/],
    ['an unsupported mode', '{"mode":"ssr"}', /"mode" must be "framework-dev" or "static"/],
    ['a non-string mode', '{"mode":42}', /"mode" must be "framework-dev" or "static"/],
    ['root on framework-dev', '{"mode":"framework-dev","root":"site"}', /only applies to static previews/],
    ['entry on framework-dev', '{"mode":"framework-dev","entry":"x.html"}', /only applies to static previews/],
    ['an empty root', '{"mode":"static","root":""}', /non-empty string/],
    ['a non-string root', '{"mode":"static","root":7}', /non-empty string/],
    ['an absolute root', '{"mode":"static","root":"/etc"}', /relative path/],
    ['a traversal root', '{"mode":"static","root":"../secrets"}', /unsupported path segment/],
    ['an interior traversal root', '{"mode":"static","root":"site/../../x"}', /unsupported path segment/],
    ['a dotfile root', '{"mode":"static","root":".well-known"}', /unsupported path segment/],
    ['a root with spaces', '{"mode":"static","root":"my site"}', /unsupported path segment/],
    ['a root with a backslash', '{"mode":"static","root":"site\\\\x"}', /unsupported path segment/],
    ['an empty segment root', '{"mode":"static","root":"site//x"}', /unsupported path segment/],
    ['a node_modules root', '{"mode":"static","root":"node_modules/pkg"}', /dependency or control tree/],
    ['a nested node_modules root', '{"mode":"static","root":"app/node_modules"}', /dependency or control tree/],
    ['a derived-output root', '{"mode":"static","root":"dist"}', /unreviewed derived output/],
    ['a nested derived-output root', '{"mode":"static","root":"dist/site"}', /unreviewed derived output/],
    ['a traversal entry', '{"mode":"static","entry":"../index.html"}', /unsupported path segment/],
    ['an absolute entry', '{"mode":"static","entry":"/index.html"}', /relative path/],
    ['a dot entry', '{"mode":"static","entry":"."}', /unsupported path segment/],
    ['a dotfile entry', '{"mode":"static","entry":".hidden.html"}', /unsupported path segment/],
  ])('rejects %s', (_label, raw, message) => {
    expect(() => parseReviewedPreviewManifest(raw)).toThrow(message);
  });

  it('rejects an oversized manifest before parsing it', () => {
    const raw = `{"mode":"static","root":"${'a'.repeat(70_000)}"}`;
    expect(() => parseReviewedPreviewManifest(raw)).toThrow(/too large/);
  });
});

describe('launchReviewedPreview', () => {
  it('copies into the container layer, strips sensitive surfaces, and disables lifecycle hooks', async () => {
    const h = harness();
    await launchReviewedPreview(launchArgs(h));

    const calls = h.exec.mock.calls as unknown as Array<
      [unknown, string[], { timeoutMs?: number; user?: string } | undefined]
    >;
    expect(calls[0]).toEqual([h.ref, ['/bin/chown', 'node:node', '--', '/workspace'], { user: 'root' }]);
    expect(calls[1]).toEqual([h.ref, ['/bin/chmod', '0700', '--', '/workspace'], { user: 'root' }]);
    expect(calls[2]).toEqual([h.ref, ['/bin/rm', '-rf', '--', REVIEWED_PREVIEW_WORKSPACE], { user: 'root' }]);
    expect(calls[3]).toEqual([
      h.ref,
      ['/bin/cp', '-a', '--', '/workspace/.', REVIEWED_PREVIEW_WORKSPACE],
      { timeoutMs: 120_000, user: 'root' },
    ]);
    expect(calls[4][1]).toEqual([
      '/usr/bin/find',
      REVIEWED_PREVIEW_WORKSPACE,
      '(',
      '-type',
      'd',
      '-name',
      'node_modules',
      '-prune',
      ')',
      '-o',
      '(',
      '-name',
      '.impulse',
      '-o',
      '-name',
      '.claude',
      '-o',
      '-name',
      '.mcp.json',
      '-o',
      '-name',
      '.memory',
      '-o',
      '-name',
      '.npmrc',
      '-o',
      '-name',
      '.netrc',
      '-o',
      '-name',
      '.env*',
      ')',
      '-exec',
      '/bin/rm',
      '-rf',
      '--',
      '{}',
      '+',
    ]);
    expect(calls[4][2]).toEqual({ user: 'root' });
    expect(calls[5][1]).toEqual([
      '/bin/rm',
      '-rf',
      '--',
      `${REVIEWED_PREVIEW_WORKSPACE}/.next`,
      `${REVIEWED_PREVIEW_WORKSPACE}/.nuxt`,
      `${REVIEWED_PREVIEW_WORKSPACE}/.svelte-kit`,
      `${REVIEWED_PREVIEW_WORKSPACE}/.turbo`,
      `${REVIEWED_PREVIEW_WORKSPACE}/coverage`,
      `${REVIEWED_PREVIEW_WORKSPACE}/dist`,
      `${REVIEWED_PREVIEW_WORKSPACE}/playwright-report`,
      `${REVIEWED_PREVIEW_WORKSPACE}/test-results`,
      `${REVIEWED_PREVIEW_WORKSPACE}/node_modules/.cache`,
    ]);
    // The reviewed-preview contract probe sits between derived-output cleanup
    // and the ownership handoff; an all-defaults (missing manifest) workspace
    // keeps the legacy framework-dev launch byte-identical.
    expect(calls[6][1]).toEqual(MANIFEST_PROBE_ARGV);
    expect(calls[6][2]).toEqual({ user: 'root' });
    expect(calls[7]).toEqual([
      h.ref,
      ['/bin/chown', '-R', 'preview:preview', '--', REVIEWED_PREVIEW_WORKSPACE],
      { timeoutMs: 120_000, user: 'root' },
    ]);
    expect(h.execDetached).toHaveBeenCalledWith(
      h.ref,
      ['/bin/sh', '-c', expect.stringContaining('/usr/local/bin/npm --ignore-scripts run dev')],
      { user: 'preview' }
    );
    expect(h.sanitize).toHaveBeenCalledTimes(1);
  });

  it('uses structured argv so wildcard and nested-path cleanup cannot be shell-expanded', async () => {
    const h = harness();
    await launchReviewedPreview(launchArgs(h));

    const calls = h.exec.mock.calls as unknown as Array<[unknown, string[]]>;
    const scrubArgv = calls[4][1];
    expect(scrubArgv[0]).toBe('/usr/bin/find');
    expect(scrubArgv).toContain('.env*');
    expect(scrubArgv).toContain('-prune');
    expect(scrubArgv).not.toContain('/bin/sh');
    expect(scrubArgv).not.toContain('-c');
    expect(scrubArgv).not.toContain('-delete');
    expect(scrubArgv.filter((part) => part === REVIEWED_PREVIEW_WORKSPACE)).toHaveLength(1);
  });

  it('passes forbidden values over stdin and never exposes them in command arguments', async () => {
    const h = harness();
    await launchReviewedPreview(launchArgs(h, { forbiddenValues: ['sk-live-secret', 'internal-secret'] }));

    const scan = h.exec.mock.calls[7] as unknown as [
      unknown,
      string[],
      { timeoutMs: number; input: string; user: string },
    ];
    expect(scan[1]).toEqual(buildPreviewSecretScanArgv());
    expect(scan[1].join(' ')).not.toContain('sk-live-secret');
    expect(scan[1].join(' ')).not.toContain('internal-secret');
    expect(JSON.parse(scan[2].input)).toEqual(['sk-live-secret', 'internal-secret']);
    expect(scan[2].user).toBe('root');
  });

  it('fails closed before launch when the exact-value scan reports a path', async () => {
    const h = harness([
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 0, stdout: '', stderr: '' },
      { code: 3, stdout: '', stderr: 'src/leak.ts\n' },
    ]);

    await expect(launchReviewedPreview(launchArgs(h, { forbiddenValues: ['sk-live-secret'] }))).rejects.toThrow(
      /src\/leak\.ts/
    );
    expect(h.execDetached).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])('fails closed when trusted preparation command %i fails', async (failureIndex) => {
    const results = Array.from({ length: failureIndex + 1 }, (_, index) => ({
      code: index === failureIndex ? 1 : 0,
      stdout: '',
      stderr: index === failureIndex ? 'failure' : '',
    }));
    const h = harness(results);
    await expect(launchReviewedPreview(launchArgs(h))).rejects.toThrow(/Failed to/);
    expect(h.execDetached).not.toHaveBeenCalled();
  });

  it('rejects a non-absolute retained workspace before executing anything', async () => {
    const h = harness();
    await expect(launchReviewedPreview(launchArgs(h, { retainedWorkspacePath: 'workspace' }))).rejects.toThrow(
      /non-absolute/
    );
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.execDetached).not.toHaveBeenCalled();
  });

  it.each([
    ['filesystem root', '/'],
    ['normalized traversal', '/workspace/../tmp'],
    ['preview workspace itself', REVIEWED_PREVIEW_WORKSPACE],
    ['preview workspace ancestor', '/tmp'],
    ['preview workspace descendant', `${REVIEWED_PREVIEW_WORKSPACE}/source`],
  ])('rejects an unsafe %s retained workspace before executing anything', async (_label, workspacePath) => {
    const h = harness();
    await expect(launchReviewedPreview(launchArgs(h, { retainedWorkspacePath: workspacePath }))).rejects.toThrow(
      /unsafe|overlapping/
    );
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.execDetached).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 65_536, Number.NaN])(
    'rejects invalid container port %p before executing anything',
    async (containerPort) => {
      const h = harness();
      await expect(launchReviewedPreview(launchArgs(h, { containerPort }))).rejects.toThrow(/container port/);
      expect(h.exec).not.toHaveBeenCalled();
      expect(h.execDetached).not.toHaveBeenCalled();
    }
  );
});

describe('launchReviewedPreview — reviewed-preview contract routing', () => {
  it('launches the trusted static server with root-owned, read-only reviewed bytes', async () => {
    const h = contractHarness(staticWorkspace(JSON.stringify({ mode: 'static', root: 'site', entry: 'index.html' })));
    await launchReviewedPreview(launchArgs(h, { containerPort: 4321 }));

    const argvs = (h.exec.mock.calls as unknown as Array<[unknown, string[], ExecOpts?]>).map((call) => call[1]);
    expect(argvs).toContainEqual(['/bin/cat', '--', MANIFEST_PATH]);
    expect(argvs).toContainEqual(['/usr/bin/find', `${WS}/site`, '-maxdepth', '0', '-type', 'd', '-printf', 'd']);
    expect(argvs).toContainEqual([
      '/usr/bin/find',
      `${WS}/site/index.html`,
      '-maxdepth',
      '0',
      '-type',
      'f',
      '-printf',
      'f',
    ]);
    expect(argvs).toContainEqual(['/usr/bin/realpath', '-e', '--', `${WS}/site`]);
    expect(argvs).toContainEqual(['/usr/bin/realpath', '-e', '--', `${WS}/site/index.html`]);
    expect(argvs).toContainEqual([
      '/usr/bin/find',
      `${WS}/site`,
      '(',
      '-type',
      'd',
      '(',
      '-name',
      'node_modules',
      '-o',
      '-name',
      '.*',
      ')',
      '-prune',
      ')',
      '-o',
      '(',
      '-type',
      'l',
      '!',
      '-name',
      '.*',
      '-print',
      ')',
    ]);
    // Static previews never hand the reviewed bytes to the preview identity:
    // the tree stays root-owned and world-readable, so not even the serving
    // process can mutate what was reviewed.
    expect(argvs).toContainEqual(['/bin/chown', '-R', 'root:root', '--', WS]);
    expect(argvs).toContainEqual(['/bin/chmod', '-R', 'u=rwX,go=rX', '--', WS]);
    expect(argvs.some((argv) => argv.join(' ').includes('preview:preview'))).toBe(false);

    const detached = h.execDetached.mock.calls[0] as unknown as [unknown, string[], { user?: string }];
    expect(detached[1][0]).toBe('/bin/sh');
    expect(detached[1][1]).toBe('-c');
    expect(detached[1][2]).toContain('SANITIZED:');
    expect(detached[1][2]).toContain(`cd ${WS} && exec /usr/local/bin/node -e `);
    expect(detached[1][2]).toContain(`'${WS}/site'`);
    expect(detached[1][2]).toContain("'4321'");
    expect(detached[1][2]).toContain("'index.html'");
    expect(detached[1][2]).toContain('>/tmp/preview.log 2>&1');
    expect(detached[1][2]).not.toContain('npm');
    expect(detached[2]).toEqual({ user: 'preview' });
    expect(h.sanitize).toHaveBeenCalledTimes(1);
  });

  it('validates an explicit framework-dev manifest against the npm manifest before launching', async () => {
    const manifest = JSON.stringify({ mode: 'framework-dev' });
    const h = contractHarness((argv) => {
      if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: `f ${manifest.length}\n` };
      if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: manifest };
      if (argv[0] === '/usr/bin/find' && argv[1] === `${WS}/package.json`) return { stdout: 'f' };
      if (argv[0] === '/bin/cat' && argv[2] === `${WS}/package.json`) {
        return { stdout: JSON.stringify({ scripts: { dev: 'next dev --port 3000' } }) };
      }
      return undefined;
    });
    await launchReviewedPreview(launchArgs(h));

    const argvs = (h.exec.mock.calls as unknown as Array<[unknown, string[]]>).map((call) => call[1]);
    expect(argvs).toContainEqual([
      '/usr/bin/find',
      `${WS}/package.json`,
      '-maxdepth',
      '0',
      '-type',
      'f',
      '-printf',
      'f',
    ]);
    expect(argvs).toContainEqual(['/bin/cat', '--', `${WS}/package.json`]);
    expect(h.execDetached).toHaveBeenCalledWith(
      h.ref,
      ['/bin/sh', '-c', expect.stringContaining('/usr/local/bin/npm --ignore-scripts run dev')],
      { user: 'preview' }
    );
  });

  it.each([
    [
      'the manifest is not a regular file',
      (argv: string[]) => (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ') ? { stdout: 'l 20\n' } : undefined),
      /must be a regular file/,
    ],
    [
      'the manifest is too large to review',
      (argv: string[]) =>
        argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ') ? { stdout: `f ${1024 * 1024}\n` } : undefined,
      /too large/,
    ],
    [
      'the manifest probe fails',
      (argv: string[]) =>
        argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ') ? { code: 1, stderr: 'docker exploded' } : undefined,
      /Failed to inspect the reviewed-preview manifest/,
    ],
    [
      'the manifest cannot be read',
      (argv: string[]) => {
        if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: 'f 20\n' };
        if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { code: 1, stderr: 'cat: I/O error' };
        return undefined;
      },
      /Failed to read the reviewed-preview manifest/,
    ],
    [
      'the manifest is invalid JSON',
      (argv: string[]) => {
        if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: 'f 8\n' };
        if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: 'nope{' };
        return undefined;
      },
      /not valid JSON/,
    ],
    [
      'the manifest declares an unsupported mode',
      (argv: string[]) => {
        if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: 'f 16\n' };
        if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: '{"mode":"ssr"}' };
        return undefined;
      },
      /"mode" must be "framework-dev" or "static"/,
    ],
  ])('fails closed when %s', async (_label, respond, message) => {
    const h = contractHarness(respond as (argv: string[]) => Partial<ExecResult> | undefined);
    await expect(launchReviewedPreview(launchArgs(h))).rejects.toThrow(message);
    expect(h.execDetached).not.toHaveBeenCalled();
  });

  it.each([
    [
      'the static root is missing',
      staticWorkspace(JSON.stringify({ mode: 'static', root: 'site' }), (argv) =>
        argv[0] === '/usr/bin/find' && argv[1] === `${WS}/site` && argv.includes('d')
          ? { code: 1, stdout: '', stderr: 'No such file or directory' }
          : undefined
      ),
      /static preview root "site" was not found/,
    ],
    [
      'the static entry is missing (mission produced no reviewable static output)',
      staticWorkspace(JSON.stringify({ mode: 'static', root: 'site' }), (argv) =>
        argv[0] === '/usr/bin/find' && argv[1] === `${WS}/site/index.html` ? { code: 0, stdout: '' } : undefined
      ),
      /static preview entry "site\/index\.html" was not found/,
    ],
    [
      'the static root escapes containment through a symlink',
      staticWorkspace(JSON.stringify({ mode: 'static', root: 'site' }), (argv) =>
        argv[0] === '/usr/bin/realpath' && argv[3] === `${WS}/site` ? { stdout: '/workspace/real-site\n' } : undefined
      ),
      /escapes the reviewed workspace/,
    ],
    [
      'the static entry escapes containment through a symlink',
      staticWorkspace(JSON.stringify({ mode: 'static', root: 'site' }), (argv) =>
        argv[0] === '/usr/bin/realpath' && argv[3] === `${WS}/site/index.html` ? { stdout: '/etc/passwd\n' } : undefined
      ),
      /escapes the reviewed workspace/,
    ],
    [
      'the static root contains symlinks',
      staticWorkspace(JSON.stringify({ mode: 'static', root: 'site' }), (argv) =>
        argv[0] === '/usr/bin/find' && argv.includes('l') && argv[1] === `${WS}/site`
          ? { stdout: `${WS}/site/link-out\n` }
          : undefined
      ),
      /contains symlinks[\s\S]*link-out/,
    ],
    [
      'the framework-dev package.json is missing',
      (argv: string[]) => {
        const manifest = JSON.stringify({ mode: 'framework-dev' });
        if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: `f ${manifest.length}\n` };
        if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: manifest };
        if (argv[0] === '/usr/bin/find' && argv[1] === `${WS}/package.json`) return { code: 1, stdout: '' };
        return undefined;
      },
      /requires a regular package\.json/,
    ],
    [
      'the framework-dev package.json is invalid JSON',
      (argv: string[]) => {
        const manifest = JSON.stringify({ mode: 'framework-dev' });
        if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: `f ${manifest.length}\n` };
        if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: manifest };
        if (argv[0] === '/usr/bin/find' && argv[1] === `${WS}/package.json`) return { stdout: 'f' };
        if (argv[0] === '/bin/cat' && argv[2] === `${WS}/package.json`) return { stdout: '{oops' };
        return undefined;
      },
      /package\.json is not valid JSON/,
    ],
    [
      'the framework-dev package.json has no dev script',
      (argv: string[]) => {
        const manifest = JSON.stringify({ mode: 'framework-dev' });
        if (argv.join(' ') === MANIFEST_PROBE_ARGV.join(' ')) return { stdout: `f ${manifest.length}\n` };
        if (argv[0] === '/bin/cat' && argv[2] === MANIFEST_PATH) return { stdout: manifest };
        if (argv[0] === '/usr/bin/find' && argv[1] === `${WS}/package.json`) return { stdout: 'f' };
        if (argv[0] === '/bin/cat' && argv[2] === `${WS}/package.json`) {
          return { stdout: JSON.stringify({ scripts: { build: 'tsc' } }) };
        }
        return undefined;
      },
      /"scripts\.dev"/,
    ],
  ])('fails closed when %s', async (_label, respond, message) => {
    const h = contractHarness(respond as (argv: string[]) => Partial<ExecResult> | undefined);
    await expect(launchReviewedPreview(launchArgs(h))).rejects.toThrow(message);
    expect(h.execDetached).not.toHaveBeenCalled();
  });

  it('still runs the exact-value secret scan for static previews', async () => {
    const h = contractHarness(staticWorkspace(JSON.stringify({ mode: 'static' })));
    await launchReviewedPreview(launchArgs(h, { forbiddenValues: ['sk-live-secret'] }));
    const scanCall = (h.exec.mock.calls as unknown as Array<[unknown, string[], ExecOpts?]>).find(
      (call) => call[1][1] === '-e' && call[1][0] === '/usr/local/bin/node' && call[2]?.input !== undefined
    );
    expect(scanCall).toBeDefined();
    expect(scanCall![1]).toEqual(buildPreviewSecretScanArgv());
    expect(JSON.parse(scanCall![2]!.input!)).toEqual(['sk-live-secret']);
  });
});

describe('static preview server (real process)', () => {
  jest.setTimeout(30_000);

  let root: string;
  let outside: string;
  const children: ChildProcess[] = [];

  beforeEach(() => {
    outside = mkdtempSync(join(tmpdir(), 'radarist-static-outside-'));
    writeFileSync(join(outside, 'leak.txt'), 'outside-secret\n');
    root = mkdtempSync(join(tmpdir(), 'radarist-static-serve-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><h1>hello static</h1>\n');
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'app.js'), 'console.log("ok");\n');
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'index.html'), '<p>docs</p>\n');
    mkdirSync(join(root, 'empty-dir'));
    writeFileSync(join(root, '.hidden.html'), 'dotfile\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'inside.txt'), 'dependency bytes\n');
    symlinkSync(join(outside, 'leak.txt'), join(root, 'escape.txt'));
    mkdirSync(join(root, 'linkdir-target'));
    symlinkSync(outside, join(root, 'linkdir'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  async function startServer(entry = 'index.html'): Promise<number> {
    const argv = buildStaticPreviewServerArgv(root, 0, entry);
    expect(argv[0]).toBe('/usr/local/bin/node');
    const child = spawn(process.execPath, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('static preview server did not report readiness')), 10_000);
      let buffered = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        buffered += chunk.toString('utf8');
        const match = buffered.match(/preview-static: listening (\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        clearTimeout(timer);
        reject(new Error(`static preview server failed: ${chunk.toString('utf8')}`));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`static preview server exited early with code ${code}`));
      });
    });
  }

  /**
   * Raw HTTP client: unlike fetch/undici it performs NO client-side path
   * normalization, so `/../` and `/./` reach the server verbatim exactly as a
   * hostile client (e.g. `curl --path-as-is`) would send them.
   */
  function request(
    port: number,
    path: string,
    init?: { method?: string; body?: string }
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: () => string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: init?.method ?? 'GET' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: () => Buffer.concat(chunks).toString('utf8'),
          })
        );
      });
      req.on('error', reject);
      if (init?.body) req.write(init.body);
      req.end();
    });
  }

  it('serves the entry at / with safe headers (readiness probes get their 2xx)', async () => {
    const port = await startServer();
    const response = await request(port, '/');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text()).toContain('hello static');
  });

  it('serves nested assets with mapped content types', async () => {
    const port = await startServer();
    const response = await request(port, '/assets/app.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.text()).toContain('console.log');
  });

  it('serves a custom entry for /', async () => {
    writeFileSync(join(root, 'demo.html'), '<p>demo entry</p>\n');
    const port = await startServer('demo.html');
    const response = await request(port, '/');
    expect(response.status).toBe(200);
    expect(response.text()).toContain('demo entry');
  });

  it('resolves directory requests to their index.html without listings', async () => {
    const port = await startServer();
    expect((await request(port, '/docs/')).status).toBe(200);
    expect((await request(port, '/docs')).text()).toContain('docs');
    expect((await request(port, '/empty-dir/')).status).toBe(404);
  });

  it('answers HEAD without a body and rejects other methods', async () => {
    const port = await startServer();
    const head = await request(port, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.text()).toBe('');
    const post = await request(port, '/', { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
    expect((await request(port, '/', { method: 'DELETE' })).status).toBe(405);
  });

  it('returns 404 for missing files', async () => {
    const port = await startServer();
    expect((await request(port, '/nope.html')).status).toBe(404);
  });

  it.each([
    ['plain traversal', '/../leak.txt', 400],
    ['encoded traversal', '/%2e%2e/leak.txt', 400],
    ['nested traversal', '/assets/../../leak.txt', 400],
    ['backslash path', '/assets%5C..%5Cleak.txt', 400],
    ['null byte', '/index.html%00.png', 400],
    ['malformed escape', '/%zz', 400],
    ['current-dir segment', '/./index.html', 400],
  ])('rejects %s with a 4xx refusal', async (_label, path, status) => {
    const port = await startServer();
    expect((await request(port, path)).status).toBe(status);
  });

  it('never serves dotfiles, node_modules, or symlinked escapes', async () => {
    const port = await startServer();
    expect((await request(port, '/.hidden.html')).status).toBe(404);
    expect((await request(port, '/node_modules/inside.txt')).status).toBe(404);
    // The file symlink itself is refused …
    expect((await request(port, '/escape.txt')).status).toBe(404);
    // … and a directory symlink cannot smuggle contained-looking paths outside.
    const viaDir = await request(port, '/linkdir/leak.txt');
    expect(viaDir.status).toBe(404);
  });

  it('keeps double-slash and query-string requests inside the root', async () => {
    const port = await startServer();
    expect((await request(port, '//etc/passwd')).status).toBe(404);
    expect((await request(port, '/index.html?x=1')).status).toBe(200);
  });
});

describe('preview exact-value scanner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'radarist-preview-secret-scan-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function scan(values: string[]) {
    const argv = buildPreviewSecretScanArgv(root);
    return spawnSync(process.execPath, argv.slice(1), {
      input: JSON.stringify(values),
      encoding: 'utf8',
    });
  }

  it('accepts ordinary source when no authorized value is present', () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'app.ts'), 'export const ready = true;\n');
    expect(scan(['sk-secret-value']).status).toBe(0);
  });

  it('reports only the path when a forbidden value spans scanner chunks', () => {
    mkdirSync(join(root, 'src'));
    const secret = 'sk-secret-across-the-chunk-boundary';
    writeFileSync(
      join(root, 'src', 'leak.bin'),
      Buffer.concat([Buffer.alloc(1024 * 1024 - 5, 0x61), Buffer.from(secret)])
    );

    const result = scan([secret]);

    expect(result.status).toBe(3);
    expect(result.stderr.trim()).toBe('src/leak.bin');
    expect(result.stderr).not.toContain(secret);
  });
});
