/**
 * @file neo4j-gds-readiness.ts
 * @description Bounded, authenticated readiness probe for the live Neo4j GDS
 * runtime used by local launchers.
 *
 * The driver boundary is injectable so unit tests never need Docker or a live
 * database. The default adapter executes the load-bearing query through an
 * authenticated read session and closes every session plus the owning driver.
 */

import neo4j from 'neo4j-driver';
import { sanitizeNeo4jErrorMessage } from '../../src/lib/graph/neo4j-sanitize';

export const NEO4J_GDS_VERSION_QUERY = 'RETURN gds.version() AS version';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const MAX_TIMEOUT_MS = 5 * 60_000;
const MAX_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const MAX_VERSION_LENGTH = 128;
const MAX_ERROR_LENGTH = 512;

export type Neo4jGdsReadinessEnv = Readonly<Partial<Record<string, string>>>;

export interface Neo4jGdsReadinessOptions {
  /** Total wall-clock budget across all attempts, sleeps, and query timeouts. */
  timeoutMs?: number;
  /** Transaction and client-side budget for one gds.version() query. */
  attemptTimeoutMs?: number;
  /** Delay between failed attempts. */
  pollIntervalMs?: number;
}

export interface Neo4jGdsDriverFactoryInput {
  uri: string;
  username: string;
  password: string;
  database: string;
  connectionAcquisitionTimeoutMs: number;
  connectionTimeoutMs: number;
}

export interface Neo4jGdsProbeSession {
  probeVersion(query: string, timeoutMs: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface Neo4jGdsProbeDriver {
  openReadSession(database: string): Neo4jGdsProbeSession;
  close(): Promise<void>;
}

export interface Neo4jGdsReadinessDependencies {
  createDriver?: (input: Neo4jGdsDriverFactoryInput) => Neo4jGdsProbeDriver;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class Neo4jGdsReadinessError extends Error {
  readonly attempts: number;
  readonly lastProbeError: string;

  constructor(message: string, attempts: number, lastProbeError: string) {
    super(message);
    this.name = 'Neo4jGdsReadinessError';
    this.attempts = attempts;
    this.lastProbeError = lastProbeError;
  }
}

interface ResolvedOptions {
  timeoutMs: number;
  attemptTimeoutMs: number;
  pollIntervalMs: number;
}

interface ResolvedConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
}

function requireBoundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return resolved;
}

function resolveOptions(options: Neo4jGdsReadinessOptions): ResolvedOptions {
  const timeoutMs = requireBoundedInteger(
    'Neo4j GDS readiness timeoutMs',
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS
  );
  const attemptTimeoutMs = requireBoundedInteger(
    'Neo4j GDS readiness attemptTimeoutMs',
    options.attemptTimeoutMs,
    DEFAULT_ATTEMPT_TIMEOUT_MS,
    MAX_ATTEMPT_TIMEOUT_MS
  );
  const pollIntervalMs = requireBoundedInteger(
    'Neo4j GDS readiness pollIntervalMs',
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS
  );
  return {
    timeoutMs,
    attemptTimeoutMs: Math.min(attemptTimeoutMs, timeoutMs),
    pollIntervalMs,
  };
}

function requireNonempty(name: string, value: string | undefined): string {
  const resolved = value?.trim();
  if (!resolved) throw new Error(`${name} is required for the authenticated Neo4j GDS probe`);
  return resolved;
}

function requireNonemptySecret(name: string, value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required for the authenticated Neo4j GDS probe`);
  }
  return value;
}

function resolveConfig(env: Neo4jGdsReadinessEnv): ResolvedConfig {
  return {
    uri: requireNonempty('NEO4J_URI', env.NEO4J_URI),
    username: requireNonempty(
      'NEO4J_USER',
      env.NEO4J_USER || env.NEO4J_USERNAME || 'neo4j'
    ),
    // Credentials are opaque. Validate that the password is not whitespace-only
    // without normalizing a value that Neo4j itself accepts verbatim.
    password: requireNonemptySecret('NEO4J_PASSWORD', env.NEO4J_PASSWORD),
    database: requireNonempty('NEO4J_DATABASE', env.NEO4J_DATABASE || 'neo4j'),
  };
}

function sanitizeProbeError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown Neo4j GDS readiness failure';
  const sanitized = sanitizeNeo4jErrorMessage(raw).replace(/\s+/g, ' ').trim();
  return (sanitized || 'Unknown Neo4j GDS readiness failure').slice(0, MAX_ERROR_LENGTH);
}

function validateVersion(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('gds.version() did not return a string');
  }
  const version = value.trim();
  if (
    version.length === 0 ||
    version.length > MAX_VERSION_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(version)
  ) {
    throw new Error('gds.version() returned an invalid version');
  }
  return version;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${operation} exceeded its ${timeoutMs}ms budget`)),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createDefaultDriver(input: Neo4jGdsDriverFactoryInput): Neo4jGdsProbeDriver {
  const driver = neo4j.driver(
    input.uri,
    neo4j.auth.basic(input.username, input.password),
    {
      connectionAcquisitionTimeout: input.connectionAcquisitionTimeoutMs,
      connectionTimeout: input.connectionTimeoutMs,
      maxConnectionPoolSize: 1,
    }
  );

  return {
    openReadSession(database) {
      const session = driver.session({
        database,
        defaultAccessMode: neo4j.session.READ,
      });
      return {
        async probeVersion(query, timeoutMs) {
          const result = await session.run(query, {}, { timeout: timeoutMs });
          return result.records[0]?.get('version');
        },
        async close() {
          await session.close();
        },
      };
    },
    async close() {
      await driver.close();
    },
  };
}

async function probeOnce(
  driver: Neo4jGdsProbeDriver,
  database: string,
  attemptTimeoutMs: number,
  totalDeadline: number,
  now: () => number
): Promise<string> {
  let session: Neo4jGdsProbeSession | undefined;
  let version: string | undefined;
  let failure: unknown;
  const attemptDeadline = Math.min(totalDeadline, now() + attemptTimeoutMs);
  const remainingAttemptBudget = () =>
    Math.max(1, Math.floor(attemptDeadline - now()));

  try {
    session = driver.openReadSession(database);
    const queryTimeoutMs = remainingAttemptBudget();
    const rawVersion = await withTimeout(
      session.probeVersion(NEO4J_GDS_VERSION_QUERY, queryTimeoutMs),
      queryTimeoutMs,
      'gds.version() probe'
    );
    version = validateVersion(rawVersion);
  } catch (error) {
    failure = error;
  }

  if (session) {
    try {
      await withTimeout(
        session.close(),
        remainingAttemptBudget(),
        'Neo4j GDS readiness session close'
      );
    } catch (error) {
      // A query/authentication/plugin error is more useful than a secondary
      // close error. Use the close error only when the probe itself succeeded.
      if (failure === undefined) failure = error;
    }
  }

  if (failure !== undefined) throw failure;
  return version!;
}

/**
 * Poll an authenticated live Neo4j instance until `gds.version()` returns a
 * validated nonempty version, or reject after the bounded total budget.
 *
 * Failure messages retain the final diagnostic after removing credentials,
 * endpoints, line breaks, and unbounded driver prose.
 */
export async function waitForNeo4jGdsReadiness(
  env: Neo4jGdsReadinessEnv,
  options: Neo4jGdsReadinessOptions = {},
  dependencies: Neo4jGdsReadinessDependencies = {}
): Promise<string> {
  const config = resolveConfig(env);
  const resolved = resolveOptions(options);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? defaultSleep;
  const createDriver = dependencies.createDriver ?? createDefaultDriver;
  const startedAt = now();
  const deadline = startedAt + resolved.timeoutMs;
  let attempts = 0;
  let lastProbeError = 'Neo4j GDS readiness was not probed';
  let driver: Neo4jGdsProbeDriver;

  try {
    driver = createDriver({
      ...config,
      connectionAcquisitionTimeoutMs: resolved.attemptTimeoutMs,
      connectionTimeoutMs: resolved.attemptTimeoutMs,
    });
  } catch (error) {
    lastProbeError = sanitizeProbeError(error);
    throw new Neo4jGdsReadinessError(
      `Could not initialize the Neo4j GDS readiness driver: ${lastProbeError}`,
      attempts,
      lastProbeError
    );
  }

  let version: string | undefined;
  let failure: unknown;
  try {
    while (now() < deadline) {
      attempts += 1;
      const remainingMs = Math.max(1, deadline - now());
      const attemptTimeoutMs = Math.min(resolved.attemptTimeoutMs, remainingMs);
      try {
        version = await probeOnce(driver, config.database, attemptTimeoutMs, deadline, now);
        break;
      } catch (error) {
        lastProbeError = sanitizeProbeError(error);
      }

      const sleepMs = Math.min(resolved.pollIntervalMs, Math.max(0, deadline - now()));
      if (sleepMs > 0) await sleep(sleepMs);
    }

    if (version === undefined) {
      throw new Neo4jGdsReadinessError(
        `Neo4j GDS did not become ready within ${resolved.timeoutMs}ms after ${attempts} attempt(s): ${lastProbeError}`,
        attempts,
        lastProbeError
      );
    }
  } catch (error) {
    failure = error;
  }

  try {
    const closeTimeoutMs = Math.max(
      1,
      Math.min(resolved.attemptTimeoutMs, Math.floor(deadline - now()))
    );
    await withTimeout(
      driver.close(),
      closeTimeoutMs,
      'Neo4j GDS readiness driver close'
    );
  } catch (error) {
    // Preserve the load-bearing query failure when both the probe and cleanup
    // fail. A close failure after success must still fail the readiness check.
    if (failure === undefined) {
      const closeError = sanitizeProbeError(error);
      failure = new Neo4jGdsReadinessError(
        `Neo4j GDS became ready but its probe driver did not close cleanly: ${closeError}`,
        attempts,
        closeError
      );
    }
  }

  if (failure !== undefined) throw failure;
  return version!;
}
