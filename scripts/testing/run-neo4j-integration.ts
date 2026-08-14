#!/usr/bin/env npx tsx

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface Neo4jIntegrationTarget {
  uri: string;
  hostname: string;
  port: number;
}

interface Neo4jIntegrationGuard {
  assertDisposableNeo4jIntegrationTarget(env?: NodeJS.ProcessEnv): Neo4jIntegrationTarget;
  assertDisposableNeo4jIntegrationSuiteTarget(env?: NodeJS.ProcessEnv): Neo4jIntegrationTarget;
  isDisposableNeo4jIntegrationSuiteEnabled(env?: NodeJS.ProcessEnv): boolean;
}

interface SpawnResult {
  error?: Error;
  status: number | null;
}

interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: 'inherit';
}

type SpawnJest = (command: string, args: string[], options: SpawnOptions) => SpawnResult;

export interface Neo4jIntegrationRunnerDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  jestBin?: string;
  spawnJest?: SpawnJest;
}

// CommonJS keeps this same guard usable from jest.pre-setup.js before tests load.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('./neo4j-integration-target.cjs') as Neo4jIntegrationGuard;

const ROOT = resolve(__dirname, '../..');

export const assertDisposableNeo4jIntegrationTarget = guard.assertDisposableNeo4jIntegrationTarget;
export const assertDisposableNeo4jIntegrationSuiteTarget =
  guard.assertDisposableNeo4jIntegrationSuiteTarget;
export const isDisposableNeo4jIntegrationSuiteEnabled =
  guard.isDisposableNeo4jIntegrationSuiteEnabled;

export function buildNeo4jIntegrationJestArgs(): string[] {
  return ['--runInBand', '--testPathPatterns=\\.integration\\.test\\.ts$'];
}

export function validateNeo4jIntegrationRunnerArgs(args: string[]): void {
  if (args.length > 0) {
    throw new Error(`Neo4j integration runner does not accept Jest overrides: ${args.join(' ')}`);
  }
}

export function runNeo4jIntegrationTests(
  args: string[],
  dependencies: Neo4jIntegrationRunnerDependencies = {}
): number {
  validateNeo4jIntegrationRunnerArgs(args);

  const env = dependencies.env ?? process.env;
  const target = assertDisposableNeo4jIntegrationTarget(env);
  const jestBin = dependencies.jestBin ?? require.resolve('jest/bin/jest');
  const spawnJest: SpawnJest =
    dependencies.spawnJest ??
    ((command, jestArgs, options) => spawnSync(command, jestArgs, options));

  console.log(
    `[neo4j-integration] Confirmed disposable target ${target.hostname}:${target.port}; running serial integration suites`
  );
  const result = spawnJest(process.execPath, [jestBin, ...buildNeo4jIntegrationJestArgs()], {
    cwd: dependencies.cwd ?? ROOT,
    env: {
      ...env,
      NEO4J_URI: target.uri,
      NEO4J_INTEGRATION_TESTS: '1',
    },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function main(args: string[] = process.argv.slice(2)): number {
  try {
    return runNeo4jIntegrationTests(args);
  } catch (error) {
    console.error(`[neo4j-integration] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}
