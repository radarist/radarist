/**
 * @file neo4j-client.ts
 * @description Neo4j driver configuration and query runner for the Innovation Brain.
 *
 * This module provides:
 * - Connection management with retry logic
 * - Query execution with error handling
 * - Health check endpoint
 * - Graceful shutdown
 *
 * @phase Phase 4: Relations-as-Claims
 * @author Radarist Team
 * @created 2026-01-09
 */

import neo4j, { Driver, Integer, Session, QueryResult, Record as Neo4jRecord } from 'neo4j-driver';
import { createLogger } from '@/lib/logger';
import { GraphUnavailableError, isDriverUnavailableError, toGraphUnavailableError } from './errors';
import { sanitizeNeo4jErrorMessage } from './neo4j-sanitize';
import { GraphRuntimeDisabledError, GraphRuntimeUnconfiguredError, requireNeo4jRuntime } from './runtime-mode';
import { assertCypherReadQuery, hasExplainRoot, RAW_CYPHER_LIMITS } from './cypher-read-policy';
import {
  CONSTRAINTS as SCHEMA_CONSTRAINTS,
  INDEXES as SCHEMA_INDEXES,
  CONTEXT_SCHEMA as SCHEMA_CONTEXT,
  VECTOR_INDEXES as SCHEMA_VECTORS,
  FULLTEXT_INDEXES as SCHEMA_FULLTEXT,
  RELATION_TYPES as SCHEMA_RELATION_TYPES,
} from './schema-manifest';

const log = createLogger('graph/neo4j-client');

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Neo4j connection configuration.
 * Uses environment variables for sensitive data.
 */
export interface Neo4jConfig {
  uri: string;
  username: string;
  password: string;
  database?: string;
  maxConnectionPoolSize?: number;
  connectionAcquisitionTimeout?: number;
}

/**
 * Get Neo4j configuration from environment variables.
 */
export function getNeo4jConfig(): Neo4jConfig {
  const { uri } = requireNeo4jRuntime();
  const username = process.env.NEO4J_USER || process.env.NEO4J_USERNAME || 'neo4j';
  const password = process.env.NEO4J_PASSWORD || 'change-me-required';
  const database = process.env.NEO4J_DATABASE || 'neo4j';

  if (password === 'change-me-required' && process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEO4J_PASSWORD must be set to a real value when NODE_ENV=production (current placeholder is "change-me-required").'
    );
  }

  return {
    uri,
    username,
    password,
    database,
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 30000, // 30 seconds
  };
}

// ============================================================================
// DRIVER MANAGEMENT
// ============================================================================

let driver: Driver | null = null;

/**
 * Get or create Neo4j driver instance.
 * Uses singleton pattern for connection pooling.
 */
export function getDriver(): Driver {
  // Re-evaluate the runtime boundary even when a singleton exists. This makes
  // an explicit disabled mode authoritative before any driver/session use.
  const config = getNeo4jConfig();

  if (!driver) {
    driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password), {
      maxConnectionPoolSize: config.maxConnectionPoolSize,
      connectionAcquisitionTimeout: config.connectionAcquisitionTimeout,
      logging: {
        level: 'warn',
        logger: (level, message) => {
          log.debug('Neo4j driver log', { level, message });
        },
      },
    });

    log.info('Driver initialized');
  }

  return driver;
}

/**
 * Close the Neo4j driver connection.
 * Should be called during application shutdown.
 */
export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
    log.info('Driver closed');
  }
}

/**
 * Get a new session for executing queries.
 */
export function getSession(mode: 'READ' | 'WRITE' = 'WRITE'): Session {
  const config = getNeo4jConfig();
  const d = getDriver();

  return d.session({
    database: config.database,
    defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
  });
}

// ============================================================================
// QUERY EXECUTION
// ============================================================================

/**
 * Result of a query execution.
 */
export interface QueryExecutionResult<T = Record<string, unknown>> {
  records: T[];
  summary: {
    counters: {
      nodesCreated: number;
      nodesDeleted: number;
      relationshipsCreated: number;
      relationshipsDeleted: number;
      propertiesSet: number;
    };
    queryType: string;
    resultAvailableAfter: number;
    resultConsumedAfter: number;
  };
}

export type RawReadTruncationReason = 'record limit' | 'payload limit';

export interface RawReadQueryOptions {
  transactionTimeoutMs?: number;
  wallTimeoutMs?: number;
  maxRecords?: number;
  maxPayloadBytes?: number;
  recordMode?: 'raw' | 'native';
  metadata?: Record<string, string | number | boolean>;
}

export interface RawReadQueryResult {
  records: Neo4jRecord[];
  nativeRecords?: Record<string, unknown>[];
  summary: QueryExecutionResult['summary'];
  truncated: boolean;
  truncationReasons: RawReadTruncationReason[];
  payloadBytes?: number;
}

export class CypherQueryClassificationError extends Error {
  readonly name = 'CypherQueryClassificationError';
  readonly code = 'CYPHER_QUERY_NOT_READ_ONLY';
}

export class CypherQueryWallTimeoutError extends Error {
  readonly name = 'CypherQueryWallTimeoutError';
  readonly code = 'CYPHER_QUERY_TIMEOUT';

  constructor(readonly timeoutMs: number) {
    super(`Cypher query exceeded the ${timeoutMs}ms wall-time limit.`);
  }
}

// Lives in the dependency-free leaf `neo4j-sanitize.ts` so `errors.ts` can use
// it without an import cycle. Re-exported here for the existing import sites.
export { sanitizeNeo4jErrorMessage };

/**
 * Run a read against the driver, translating "the database is unreachable"
 * into the typed {@link GraphUnavailableError} the app's honest-degradation
 * gates gate on (AUDIT-020).
 *
 * Scoped to READS on purpose:
 * - `runQuery` stays raw — `checkHealth` is built on it and the service factory's
 *   sticky-fallback recovery depends on its catch-all.
 * - `runWriteTransaction` stays raw — its callers are Inngest sync functions,
 *   which retry on any error class; re-typing would change nothing but the text.
 *
 * Query-level failures (syntax, constraint, classification) pass through
 * untouched. Dressing those up as 503s would hide real bugs.
 */
async function withUnavailableTranslation<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GraphRuntimeDisabledError || error instanceof GraphRuntimeUnconfiguredError) {
      const backend = error instanceof GraphRuntimeDisabledError ? 'disabled' : 'unconfigured';
      throw new GraphUnavailableError(operation, backend, error.message);
    }
    if (isDriverUnavailableError(error)) {
      log.warn('Neo4j unavailable', {
        operation,
        error: sanitizeNeo4jErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      throw toGraphUnavailableError(error, operation);
    }
    throw error;
  }
}

function neo4jRecordToObject(record: Neo4jRecord): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  record.keys.forEach((key) => {
    const keyString = String(key);
    obj[keyString] = toNativeValue(record.get(keyString));
  });
  return obj;
}

/**
 * Execute a Cypher query and return results.
 *
 * @param cypher - The Cypher query string
 * @param params - Query parameters
 * @param mode - Session mode (READ or WRITE)
 * @returns Query results with summary
 */
export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  mode: 'READ' | 'WRITE' = 'WRITE'
): Promise<QueryExecutionResult<T>> {
  const session = getSession(mode);

  try {
    const result: QueryResult = await session.run(cypher, params);

    const records = result.records.map((record: Neo4jRecord) => {
      return neo4jRecordToObject(record) as T;
    });

    const counters = result.summary.counters.updates();

    return {
      records,
      summary: {
        counters: {
          nodesCreated: counters.nodesCreated,
          nodesDeleted: counters.nodesDeleted,
          relationshipsCreated: counters.relationshipsCreated,
          relationshipsDeleted: counters.relationshipsDeleted,
          propertiesSet: counters.propertiesSet,
        },
        queryType: result.summary.queryType,
        resultAvailableAfter: result.summary.resultAvailableAfter.toNumber(),
        resultConsumedAfter: result.summary.resultConsumedAfter.toNumber(),
      },
    };
  } finally {
    await session.close();
  }
}

/**
 * Execute a write query in a transaction.
 * Provides automatic retry on transient errors.
 */
export async function runWriteTransaction<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryExecutionResult<T>> {
  const session = getSession('WRITE');

  try {
    let records: T[] = [];
    let summaryData: QueryExecutionResult<T>['summary'] | null = null;

    await session.executeWrite(async (tx) => {
      const result = await tx.run(cypher, params);

      records = result.records.map((record: Neo4jRecord) => {
        return neo4jRecordToObject(record) as T;
      });

      const counters = result.summary.counters.updates();
      summaryData = {
        counters: {
          nodesCreated: counters.nodesCreated,
          nodesDeleted: counters.nodesDeleted,
          relationshipsCreated: counters.relationshipsCreated,
          relationshipsDeleted: counters.relationshipsDeleted,
          propertiesSet: counters.propertiesSet,
        },
        queryType: result.summary.queryType,
        resultAvailableAfter: result.summary.resultAvailableAfter.toNumber(),
        resultConsumedAfter: result.summary.resultConsumedAfter.toNumber(),
      };
    });

    return {
      records,
      summary: summaryData!,
    };
  } finally {
    await session.close();
  }
}

/**
 * Execute a read query in a transaction.
 * Provides automatic retry on transient errors.
 *
 * An unreachable database surfaces as {@link GraphUnavailableError}, not as a
 * raw `Neo4jError` — see {@link withUnavailableTranslation}.
 */
export async function runReadTransaction<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<QueryExecutionResult<T>> {
  return withUnavailableTranslation('read', () => runReadTransactionRaw<T>(cypher, params));
}

async function runReadTransactionRaw<T>(
  cypher: string,
  params: Record<string, unknown>
): Promise<QueryExecutionResult<T>> {
  const session = getSession('READ');

  try {
    let records: T[] = [];
    let summaryData: QueryExecutionResult<T>['summary'] | null = null;

    await session.executeRead(async (tx) => {
      const result = await tx.run(cypher, params);

      records = result.records.map((record: Neo4jRecord) => {
        return neo4jRecordToObject(record) as T;
      });

      const counters = result.summary.counters.updates();
      summaryData = {
        counters: {
          nodesCreated: counters.nodesCreated,
          nodesDeleted: counters.nodesDeleted,
          relationshipsCreated: counters.relationshipsCreated,
          relationshipsDeleted: counters.relationshipsDeleted,
          propertiesSet: counters.propertiesSet,
        },
        queryType: result.summary.queryType,
        resultAvailableAfter: result.summary.resultAvailableAfter.toNumber(),
        resultConsumedAfter: result.summary.resultConsumedAfter.toNumber(),
      };
    });

    return {
      records,
      summary: summaryData!,
    };
  } finally {
    await session.close();
  }
}

/**
 * Execute a read query preserving raw Neo4j types.
 * Unlike runReadTransaction, this preserves Node/Relationship objects with their identities.
 * Useful for graph visualization where you need node/relationship IDs.
 * transactionTimeoutMs, when provided, is enforced by Neo4j so timed-out
 * requests do not keep consuming database resources after the caller returns.
 */
export async function runRawReadQuery(
  cypher: string,
  params: Record<string, unknown> = {},
  transactionTimeoutOrOptions?: number | RawReadQueryOptions,
  legacyMaxRecords?: number
): Promise<RawReadQueryResult> {
  return withUnavailableTranslation('query', () =>
    runRawReadQueryUntranslated(cypher, params, transactionTimeoutOrOptions, legacyMaxRecords)
  );
}

async function runRawReadQueryUntranslated(
  cypher: string,
  params: Record<string, unknown> = {},
  transactionTimeoutOrOptions?: number | RawReadQueryOptions,
  legacyMaxRecords?: number
): Promise<RawReadQueryResult> {
  assertCypherReadQuery(cypher, params);

  const options: RawReadQueryOptions =
    typeof transactionTimeoutOrOptions === 'number'
      ? { transactionTimeoutMs: transactionTimeoutOrOptions, maxRecords: legacyMaxRecords }
      : {
          ...(transactionTimeoutOrOptions ?? {}),
          ...(legacyMaxRecords === undefined ? {} : { maxRecords: legacyMaxRecords }),
        };
  const {
    transactionTimeoutMs = RAW_CYPHER_LIMITS.transactionTimeoutMs,
    wallTimeoutMs = RAW_CYPHER_LIMITS.wallTimeoutMs,
    maxRecords = RAW_CYPHER_LIMITS.records,
    maxPayloadBytes,
    recordMode = 'raw',
    metadata,
  } = options;

  for (const [name, value] of [
    ['transactionTimeoutMs', transactionTimeoutMs],
    ['wallTimeoutMs', wallTimeoutMs],
    ['maxRecords', maxRecords],
    ['maxPayloadBytes', maxPayloadBytes],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  if (maxPayloadBytes !== undefined && recordMode !== 'native') {
    throw new Error('maxPayloadBytes requires recordMode "native"');
  }

  const session = getSession('READ');
  let wallTimeoutHandle: NodeJS.Timeout | undefined;
  let wallTimedOut = false;

  try {
    const execute = async (): Promise<RawReadQueryResult> => {
      const queryConfig =
        transactionTimeoutMs === undefined && metadata === undefined
          ? undefined
          : {
              ...(transactionTimeoutMs === undefined ? {} : { timeout: transactionTimeoutMs }),
              ...(metadata === undefined ? {} : { metadata }),
            };

      // EXPLAIN is the database parser/classifier, not the only security gate:
      // Neo4j labels operational commands and dynamic function calls as reads.
      // The lexical policy above blocks those before this classification step.
      const explainQuery = hasExplainRoot(cypher) ? cypher : `EXPLAIN ${cypher}`;
      const explainResult = await session.run(explainQuery, params, queryConfig);
      assertReadOnlySummary(explainResult.summary, 'EXPLAIN preflight');

      const result = session.run(cypher, params, queryConfig);
      const records: Neo4jRecord[] = [];
      const nativeRecords: Record<string, unknown>[] = [];
      const truncationReasons: RawReadTruncationReason[] = [];
      let payloadBytes = 2; // []
      let resultSummary: QueryResult['summary'];

      const mustStream = maxRecords !== undefined || maxPayloadBytes !== undefined || recordMode === 'native';
      if (!mustStream) {
        const eagerResult = await result;
        records.push(...eagerResult.records);
        resultSummary = eagerResult.summary;
      } else {
        // Result's public async iterator streams with backpressure. Breaking the
        // loop calls iterator.return(), which tells Neo4j to discard the rest.
        for await (const record of result) {
          const returnedCount = recordMode === 'native' ? nativeRecords.length : records.length;
          if (maxRecords !== undefined && returnedCount === maxRecords) {
            truncationReasons.push('record limit');
            break;
          }

          if (recordMode === 'native') {
            const nativeRecord = neo4jRecordToObject(record);
            const serializedRecord = JSON.stringify(nativeRecord);
            const recordBytes = new TextEncoder().encode(serializedRecord).byteLength;
            const candidateBytes = payloadBytes + recordBytes + (nativeRecords.length === 0 ? 0 : 1);
            if (maxPayloadBytes !== undefined && candidateBytes > maxPayloadBytes) {
              truncationReasons.push('payload limit');
              break;
            }
            nativeRecords.push(nativeRecord);
            payloadBytes = candidateBytes;
          } else {
            records.push(record);
          }
        }
        resultSummary = await result.summary();
      }

      assertReadOnlySummary(resultSummary, 'query execution');
      const summary = toExecutionSummary(resultSummary);

      return {
        records,
        ...(recordMode === 'native' ? { nativeRecords, payloadBytes } : {}),
        summary,
        truncated: truncationReasons.length > 0,
        truncationReasons,
      };
    };

    if (wallTimeoutMs === undefined) return await execute();

    return await Promise.race([
      execute(),
      new Promise<never>((_, reject) => {
        wallTimeoutHandle = setTimeout(() => {
          wallTimedOut = true;
          // Closing a session discards the active result/transaction. Do not
          // await here: the caller receives the wall-time error immediately.
          void session.close().catch(() => undefined);
          reject(new CypherQueryWallTimeoutError(wallTimeoutMs));
        }, wallTimeoutMs);
      }),
    ]);
  } finally {
    if (wallTimeoutHandle) clearTimeout(wallTimeoutHandle);
    if (!wallTimedOut) await session.close();
  }
}

function assertReadOnlySummary(summary: QueryResult['summary'], phase: string): void {
  const counters = summary.counters;
  const containsUpdates =
    typeof counters.containsUpdates === 'function'
      ? counters.containsUpdates()
      : Object.values(counters.updates()).some((value) => typeof value === 'number' && value > 0);
  const containsSystemUpdates =
    typeof counters.containsSystemUpdates === 'function' ? counters.containsSystemUpdates() : false;

  if (summary.queryType !== 'r' || containsUpdates || containsSystemUpdates) {
    throw new CypherQueryClassificationError(`${phase} was not classified as a read-only query.`);
  }
}

function toExecutionSummary(resultSummary: QueryResult['summary']): QueryExecutionResult['summary'] {
  const counters = resultSummary.counters.updates();
  return {
    counters: {
      nodesCreated: counters.nodesCreated,
      nodesDeleted: counters.nodesDeleted,
      relationshipsCreated: counters.relationshipsCreated,
      relationshipsDeleted: counters.relationshipsDeleted,
      propertiesSet: counters.propertiesSet,
    },
    queryType: resultSummary.queryType,
    resultAvailableAfter: resultSummary.resultAvailableAfter.toNumber(),
    resultConsumedAfter: resultSummary.resultConsumedAfter.toNumber(),
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert Neo4j values to native JavaScript values.
 * Handles Integer, Date, and other Neo4j-specific types.
 */
function toNativeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  // Handle Neo4j Integer
  if (neo4j.isInt(value)) {
    const integer = value as Integer;
    return integer.inSafeRange() ? integer.toNumber() : integer.toString();
  }

  // Handle Neo4j Date/DateTime
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value)) {
    return (value as { toStandardDate(): Date }).toStandardDate();
  }

  // Handle Neo4j Node / Relationship — flattened to their property bag, which
  // is the shape every existing caller reads.
  //
  // GRAPH-062: this used to be duck-typed as `'properties' in value`, so a plain
  // Cypher MAP that merely CONTAINED a key named `properties` was mistaken for a
  // graph entity and collapsed into that key's contents. Every sibling key was
  // silently discarded. The victim was `findPath`/`findAllPaths`, whose
  // projections are exactly `{id, type, sourceId, targetId, properties}` and
  // `{id, labels, properties}`: paths came back with `type`, `sourceId`,
  // `targetId`, `labels`, and the nested `properties` all `undefined`. So
  // `explainConnection` narrated every hop as the RELATED_TO fallback, and
  // `resolveBusinessRelationConfidence(rel.properties)` read `undefined` and
  // scored every edge at its hardcoded default instead of its real confidence.
  // The driver's own type guards are exact, so a map is now just a map.
  if (neo4j.isNode(value) || neo4j.isRelationship(value)) {
    const entity = value as unknown as { properties: Record<string, unknown>; labels?: string[] };
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entity.properties)) {
      properties[k] = toNativeValue(v);
    }
    return {
      ...properties,
      _labels: entity.labels,
    };
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value.map(toNativeValue);
  }

  // Handle objects
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = toNativeValue(v);
    }
    return obj;
  }

  return value;
}

// ============================================================================
// HEALTH CHECK
// ============================================================================

/**
 * Check Neo4j connection health.
 */
export async function checkHealth(): Promise<{
  healthy: boolean;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();

  try {
    await runQuery('RETURN 1 AS health', {}, 'READ');
    return {
      healthy: true,
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// SCHEMA SETUP
// ============================================================================

/**
 * Initialize Neo4j schema with constraints and indexes.
 * Should be run once during application startup or migration.
 */
export async function initializeSchema(): Promise<void> {
  log.info('Initializing schema');

  // Schema lives in the single-source-of-truth manifest (shared with the
  // init-neo4j-schema.ts script and graph-health assertSchema). Runtime
  // initialization is BEST-EFFORT (never hard-fails the server); the
  // fail-loud gate is the init script. The manifest uses `assertion_*` names,
  // fixing the prior drop/create collision with the init script's claim_* drops.
  const ddl = [...SCHEMA_CONSTRAINTS, ...SCHEMA_INDEXES, ...SCHEMA_CONTEXT, ...SCHEMA_VECTORS, ...SCHEMA_FULLTEXT];
  for (const stmt of ddl) {
    try {
      await runQuery(stmt);
    } catch (error) {
      // Constraint/index may already exist, or a uniqueness constraint may be
      // blocked by duplicate-id data. Non-fatal at runtime — surfaced by the
      // fail-loud init script and graph:health assertSchema instead.
      log.debug('Schema statement skipped', { stmt: stmt.substring(0, 60), error: (error as Error).message });
    }
  }

  for (const rt of SCHEMA_RELATION_TYPES) {
    await runQuery(
      `MERGE (r:RelationType {name: $name})
       ON CREATE SET r.description = $description, r.category = $category, r.createdAt = timestamp()
       ON MATCH SET r.description = coalesce(r.description, $description), r.category = coalesce(r.category, $category)`,
      { name: rt.name, description: rt.description, category: rt.category }
    );
  }

  log.info('Schema initialization complete');
}

// ============================================================================
// SHUTDOWN HOOK
// ============================================================================

// Register shutdown handler for graceful cleanup.
// Skipped in test to avoid Jest open-handle warning, and guarded by a
// module-scoped flag so Next.js dev hot-reload doesn't stack duplicate
// listeners (which previously surfaced as MaxListenersExceededWarning).
let shutdownHandlersRegistered = false;
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test' && !shutdownHandlersRegistered) {
  shutdownHandlersRegistered = true;

  process.on('SIGTERM', async () => {
    log.debug('Received SIGTERM, closing driver');
    await closeDriver();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    log.debug('Received SIGINT, closing driver');
    await closeDriver();
    process.exit(0);
  });
}
// 1776590983 touch
