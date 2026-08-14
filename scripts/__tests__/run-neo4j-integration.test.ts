import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertDisposableNeo4jIntegrationSuiteTarget,
  assertDisposableNeo4jIntegrationTarget,
  buildNeo4jIntegrationJestArgs,
  isDisposableNeo4jIntegrationSuiteEnabled,
  runNeo4jIntegrationTests,
  validateNeo4jIntegrationRunnerArgs,
} from '../testing/run-neo4j-integration';

const SAFE_ENV = {
  NEO4J_INTEGRATION_DISPOSABLE: 'true',
  NEO4J_URI: 'bolt://127.0.0.1:17687',
};
const ROOT = resolve(__dirname, '../..');

describe('Neo4j integration runner safety', () => {
  it('keeps the package command behind the guarded runner', () => {
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['test:integration:neo4j']).toBe(
      'npx tsx scripts/testing/run-neo4j-integration.ts'
    );
  });

  it('requires the exact disposable confirmation before considering the URI', () => {
    expect(() =>
      assertDisposableNeo4jIntegrationTarget({
        ...SAFE_ENV,
        NEO4J_INTEGRATION_DISPOSABLE: undefined,
      })
    ).toThrow('NEO4J_INTEGRATION_DISPOSABLE=true');
    expect(() =>
      assertDisposableNeo4jIntegrationTarget({
        ...SAFE_ENV,
        NEO4J_INTEGRATION_DISPOSABLE: '1',
      })
    ).toThrow('NEO4J_INTEGRATION_DISPOSABLE=true');
  });

  it('requires an explicit Neo4j URI and published Bolt port', () => {
    expect(() =>
      assertDisposableNeo4jIntegrationTarget({
        ...SAFE_ENV,
        NEO4J_URI: undefined,
      })
    ).toThrow('NEO4J_URI is required');
    expect(() =>
      assertDisposableNeo4jIntegrationTarget({
        ...SAFE_ENV,
        NEO4J_URI: 'bolt://127.0.0.1',
      })
    ).toThrow('must include');
  });

  it.each([
    ['the protected default port', 'bolt://127.0.0.1:7687', 'protected default Bolt port 7687'],
    ['a remote host', 'bolt://graph.example.com:17687', 'localhost or 127.0.0.1'],
    ['a wildcard host', 'bolt://0.0.0.0:17687', 'localhost or 127.0.0.1'],
    ['a non-Neo4j protocol', 'https://127.0.0.1:17687', 'Bolt or Neo4j protocol'],
    ['embedded credentials', 'bolt://neo4j:secret@127.0.0.1:17687', 'must not embed credentials'],
  ])('rejects %s', (_case, uri, message) => {
    expect(() => assertDisposableNeo4jIntegrationTarget({ ...SAFE_ENV, NEO4J_URI: uri })).toThrow(message);
  });

  it.each(['bolt://127.0.0.1:17687', 'neo4j://localhost:17687'])(
    'accepts an explicitly confirmed disposable loopback target: %s',
    (uri) => {
      expect(assertDisposableNeo4jIntegrationTarget({ ...SAFE_ENV, NEO4J_URI: uri })).toMatchObject({
        uri,
        port: 17687,
      });
    }
  );

  it('requires both exact suite flags before a test can reach a disposable target', () => {
    const suiteEnv = { ...SAFE_ENV, NEO4J_INTEGRATION_TESTS: '1' };

    expect(isDisposableNeo4jIntegrationSuiteEnabled(suiteEnv)).toBe(true);
    expect(assertDisposableNeo4jIntegrationSuiteTarget(suiteEnv)).toMatchObject({
      uri: SAFE_ENV.NEO4J_URI,
      port: 17687,
    });

    expect(isDisposableNeo4jIntegrationSuiteEnabled(SAFE_ENV)).toBe(false);
    expect(() => assertDisposableNeo4jIntegrationSuiteTarget(SAFE_ENV)).toThrow(
      'NEO4J_INTEGRATION_TESTS=1'
    );
    expect(
      isDisposableNeo4jIntegrationSuiteEnabled({
        ...suiteEnv,
        NEO4J_INTEGRATION_DISPOSABLE: '1',
      })
    ).toBe(false);
    expect(() =>
      assertDisposableNeo4jIntegrationSuiteTarget({
        ...suiteEnv,
        NEO4J_INTEGRATION_DISPOSABLE: undefined,
      })
    ).toThrow('NEO4J_INTEGRATION_DISPOSABLE=true');
    expect(() =>
      assertDisposableNeo4jIntegrationSuiteTarget({
        ...suiteEnv,
        NEO4J_URI: 'bolt://127.0.0.1:7687',
      })
    ).toThrow('protected default Bolt port 7687');
  });

  it('invokes only the serial integration lane after validation', () => {
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];

    const status = runNeo4jIntegrationTests([], {
      cwd: '/repo',
      env: SAFE_ENV,
      jestBin: '/repo/node_modules/jest/bin/jest.js',
      spawnJest: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: process.execPath,
        args: ['/repo/node_modules/jest/bin/jest.js', ...buildNeo4jIntegrationJestArgs()],
        env: expect.objectContaining({
          NEO4J_INTEGRATION_DISPOSABLE: 'true',
          NEO4J_INTEGRATION_TESTS: '1',
          NEO4J_URI: SAFE_ENV.NEO4J_URI,
        }),
      },
    ]);
  });

  it('fails before spawning Jest for unsafe targets or caller-controlled overrides', () => {
    const spawnJest = jest.fn(() => ({ status: 0 }));

    expect(() =>
      runNeo4jIntegrationTests([], {
        env: { ...SAFE_ENV, NEO4J_URI: 'bolt://127.0.0.1:7687' },
        spawnJest,
      })
    ).toThrow('protected default Bolt port 7687');
    expect(() => validateNeo4jIntegrationRunnerArgs(['--runTestsByPath', 'safe-looking.test.ts'])).toThrow(
      'does not accept Jest overrides'
    );
    expect(spawnJest).not.toHaveBeenCalled();
  });

  it('propagates Jest failures and treats a missing exit status as failure', () => {
    expect(
      runNeo4jIntegrationTests([], {
        env: SAFE_ENV,
        jestBin: '/jest',
        spawnJest: () => ({ status: 7 }),
      })
    ).toBe(7);
    expect(
      runNeo4jIntegrationTests([], {
        env: SAFE_ENV,
        jestBin: '/jest',
        spawnJest: () => ({ status: null }),
      })
    ).toBe(1);
  });
});
