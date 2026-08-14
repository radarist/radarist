/**
 * @file Process-level contract tests for scripts/setup-neo4j.sh.
 *
 * The real script runs against stubbed executables in a disposable project, so
 * these tests never inspect or mutate an operator's Docker or Neo4j instance.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const SOURCE_SCRIPT = resolve(__dirname, '..', 'setup-neo4j.sh');
const PACKAGE_JSON = JSON.parse(
  readFileSync(resolve(__dirname, '..', '..', 'package.json'), 'utf8')
) as { scripts: Record<string, string> };
const SECRET = 'test-only-password-that-must-not-be-printed';

type ComposeMode = 'plugin' | 'legacy';

interface Fixture {
  root: string;
  script: string;
  bin: string;
  composeLog: string;
  nodeLog: string;
  composeMode: ComposeMode;
}

const fixtures: string[] = [];

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function makeFixture({
  withEnv = true,
  composeMode = 'plugin',
}: { withEnv?: boolean; composeMode?: ComposeMode } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'radarist-neo4j-setup-'));
  fixtures.push(root);

  const script = join(root, 'scripts', 'setup-neo4j.sh');
  const bin = join(root, 'bin');
  const composeLog = join(root, 'compose.log');
  const nodeLog = join(root, 'node.log');

  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(SOURCE_SCRIPT, script);
  chmodSync(script, 0o755);
  writeFileSync(join(root, 'docker-compose.neo4j.yml'), 'services: {}\n');
  writeFileSync(join(root, 'scripts', 'init-neo4j-schema.ts'), '// fixture\n');
  if (withEnv) {
    writeFileSync(join(root, '.env.local'), `NEO4J_PASSWORD=${SECRET}\n`);
  }

  writeExecutable(
    join(bin, 'docker'),
    `#!/bin/bash
if [ "$1" = "info" ]; then
  exit 0
fi
if [ "$1" = "compose" ]; then
  if [ "$2" = "version" ]; then
    exit ${composeMode === 'plugin' ? '0' : '1'}
  fi
  shift
  printf "docker compose|%s\\n" "$*" >> "$COMPOSE_LOG"
  exit ${composeMode === 'plugin' ? '0' : '97'}
fi
exit 96
`
  );
  writeExecutable(
    join(bin, 'docker-compose'),
    `#!/bin/bash
printf "docker-compose|%s\\n" "$*" >> "$COMPOSE_LOG"
exit ${composeMode === 'legacy' ? '0' : '97'}
`
  );
  writeExecutable(join(bin, 'curl'), '#!/bin/bash\nprintf "200"\n');
  writeExecutable(
    join(bin, 'node'),
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$NODE_LOG"\nexit 0\n'
  );

  return { root, script, bin, composeLog, nodeLog, composeMode };
}

function expectedComposeCall(fixture: Fixture, action: string): string {
  const executable = fixture.composeMode === 'plugin' ? 'docker compose' : 'docker-compose';
  return `${executable}|--env-file ${join(fixture.root, '.env.local')} -f ${join(
    fixture.root,
    'docker-compose.neo4j.yml'
  )} ${action}`;
}

function run(
  fixture: Fixture,
  command?: string,
  input?: string
): { status: number | null; output: string } {
  const result = spawnSync('bash', command ? [fixture.script, command] : [fixture.script], {
    cwd: tmpdir(),
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
      COMPOSE_LOG: fixture.composeLog,
      NODE_LOG: fixture.nodeLog,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

afterEach(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
  fixtures.length = 0;
});

describe('setup-neo4j local configuration contract', () => {
  it('uses the project env for Compose and schema initialization without disclosing secrets', () => {
    const fixture = makeFixture();
    const result = run(fixture);

    expect(result.status).toBe(0);
    expect(result.output).toContain('configured in .env.local (not displayed)');
    expect(result.output).not.toContain(SECRET);
    expect(readFileSync(fixture.composeLog, 'utf8').trim()).toBe(
      expectedComposeCall(fixture, 'up -d')
    );
    expect(readFileSync(fixture.nodeLog, 'utf8').trim()).toBe(
      `--env-file=${join(fixture.root, '.env.local')} --import tsx scripts/init-neo4j-schema.ts`
    );
  });

  it('fails before invoking tools when .env.local is absent', () => {
    const fixture = makeFixture({ withEnv: false });
    const result = run(fixture, 'status');

    expect(result.status).not.toBe(0);
    expect(result.output).toContain(".env.local not found. Run 'npm run setup:local'");
    expect(existsSync(fixture.composeLog)).toBe(false);
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it.each([
    { command: 'stop', input: undefined, expected: ['down'] },
    { command: 'status', input: undefined, expected: ['ps'] },
    { command: 'logs', input: undefined, expected: ['logs -f'] },
    { command: 'restart', input: undefined, expected: ['down', 'up -d'] },
    { command: 'reset', input: 'y\n', expected: ['down -v', 'up -d'] },
  ])(
    'passes the explicit env/config prefix for every $command Compose action',
    ({ command, input, expected }) => {
      const fixture = makeFixture();
      const result = run(fixture, command, input);

      expect(result.status).toBe(0);
      const calls = readFileSync(fixture.composeLog, 'utf8').trim().split('\n');
      expect(calls).toEqual(expected.map(action => expectedComposeCall(fixture, action)));
      expect(result.output).not.toContain(SECRET);
    }
  );

  it('prefers the Docker Compose v2 plugin and falls back to docker-compose', () => {
    const pluginFixture = makeFixture({ composeMode: 'plugin' });
    const legacyFixture = makeFixture({ composeMode: 'legacy' });

    expect(run(pluginFixture, 'stop').status).toBe(0);
    expect(run(legacyFixture, 'stop').status).toBe(0);
    expect(readFileSync(pluginFixture.composeLog, 'utf8').trim()).toBe(
      expectedComposeCall(pluginFixture, 'down')
    );
    expect(readFileSync(legacyFixture.composeLog, 'utf8').trim()).toBe(
      expectedComposeCall(legacyFixture, 'down')
    );
  });

  it('cancels reset without invoking Compose or schema initialization', () => {
    const fixture = makeFixture();
    const result = run(fixture, 'reset', 'n\n');

    expect(result.status).toBe(0);
    expect(result.output).toContain('Cancelled.');
    expect(existsSync(fixture.composeLog)).toBe(false);
    expect(existsSync(fixture.nodeLog)).toBe(false);
  });

  it('keeps lifecycle actions behind the env-aware helper and never sources .env.local', () => {
    const source = readFileSync(SOURCE_SCRIPT, 'utf8');

    expect(source).not.toMatch(/^\s*(?:docker-compose|docker compose)\s+--env-file/gm);
    expect(source).not.toMatch(/(?:^|\s)(?:source|\.)\s+[^\n]*\.env\.local/m);
  });

  it('routes every public lifecycle script through the guarded setup boundary', () => {
    expect(PACKAGE_JSON.scripts['neo4j:start']).toBe('bash scripts/setup-neo4j.sh up');
    expect(PACKAGE_JSON.scripts['neo4j:stop']).toBe('bash scripts/setup-neo4j.sh stop');
    expect(PACKAGE_JSON.scripts['neo4j:reset']).toBe('bash scripts/setup-neo4j.sh reset');
    expect(PACKAGE_JSON.scripts['neo4j:logs']).toBe('bash scripts/setup-neo4j.sh logs');
    expect(PACKAGE_JSON.scripts['neo4j:status']).toBe('bash scripts/setup-neo4j.sh status');
  });

  it('routes neo4j:health through the profile-aware health gate', () => {
    expect(PACKAGE_JSON.scripts['neo4j:health']).toBe('npx tsx scripts/neo4j-health.ts');
  });

  it('makes neo4j:health refuse an ambiguous profile selection before any probe', () => {
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/neo4j-health.ts', '--profile', 'default', '--profile', 'selftest'],
      {
        cwd: resolve(__dirname, '..', '..'),
        encoding: 'utf8',
        env: { ...process.env },
      }
    );

    expect(result.status).toBe(2);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('exactly once');
  }, 60_000);

  it('makes neo4j:health a real gate when the selected profile container is missing', () => {
    // Minimal stub directory: only `docker` is shadowed (the shared fixture's
    // `node` stub would swallow the real tsx invocation).
    const bin = mkdtempSync(join(tmpdir(), 'radarist-neo4j-health-bin-'));
    fixtures.push(bin);
    writeExecutable(
      join(bin, 'docker'),
      `#!/bin/bash
if [ "$1" = "inspect" ]; then
  echo "Error response from daemon: No such object: $3" >&2
  exit 1
fi
exit 0
`
    );

    const result = spawnSync('npx', ['tsx', 'scripts/neo4j-health.ts', '--profile', 'selftest'], {
      cwd: resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    });

    expect(result.status).toBe(1);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).toContain('Neo4j is not responding');
    expect(output).toContain('profile selftest');
    expect(output).toContain('radarist-neo4j-selftest');
    // No fallback to the unshifted default instance when selftest was requested.
    expect(output).not.toContain('http://127.0.0.1:7474');
    expect(output).not.toContain('bolt://127.0.0.1:7687');
  }, 60_000);
});
