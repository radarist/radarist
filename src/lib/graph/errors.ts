/**
 * @file errors.ts
 * @description Domain errors for the graph layer.
 *
 * These errors let degraded backends (e.g. the Firestore fallback) fail
 * honestly instead of fabricating empty results, so callers can surface
 * the degradation to users and agents.
 *
 * Dependency-free on purpose: this module is imported by API routes and by
 * `neo4j-client.ts`, so it must not pull in the `neo4j-driver` package. The
 * driver is duck-typed here (status codes are plain strings on the error).
 */

import { sanitizeNeo4jErrorMessage } from './neo4j-sanitize';

/**
 * Thrown when a graph operation cannot be served by the active backend.
 *
 * Two producers:
 *
 * 1. The Firestore fallback service, for raw Cypher queries and all write
 *    operations — it only supports basic reads (getNode, getNeighbors,
 *    findPath).
 * 2. `neo4j-client.ts`, when the Neo4j driver reports the database itself is
 *    unreachable (AUDIT-020) — before this, a real outage surfaced as a raw
 *    `Neo4jError`, so every `instanceof GraphUnavailableError` gate in the app
 *    was unreachable and the honest-degradation 503s were dead branches.
 *
 * Callers should catch this and report degraded mode rather than treating
 * fabricated empty results as real data.
 */
export class GraphUnavailableError extends Error {
  /** The graph operation that could not be served (e.g. 'query', 'createNode'). */
  readonly operation: string;

  /** The backend that was active when the operation failed. */
  readonly backend: string;

  constructor(operation: string, backend = 'firestore-fallback', message?: string) {
    super(
      message ?? `Graph backend unavailable: '${operation}' requires Neo4j but the active backend is '${backend}'.`
    );
    this.name = 'GraphUnavailableError';
    this.operation = operation;
    this.backend = backend;
  }
}

/**
 * Neo4j status / driver codes that mean "the backend could not serve this",
 * as opposed to "your query was wrong".
 *
 * The distinction is the whole point: a Cypher syntax error
 * (`Neo.ClientError.Statement.SyntaxError`) is the caller's fault and must keep
 * surfacing as a 4xx/500. Only genuine unavailability earns a 503.
 *
 * `ServiceUnavailable` is what the driver actually reports for a refused socket
 * — verified against neo4j-driver 6.0.1 by pointing a driver at a dead port.
 * Bad credentials and a missing database are grouped in deliberately: no change
 * the caller can make will fix them, and from the client's side the graph is
 * exactly as unavailable as a dead socket.
 */
const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'ServiceUnavailable',
  'SessionExpired',
  'Neo.TransientError.General.DatabaseUnavailable',
  'Neo.ClientError.Database.DatabaseUnavailable',
  'Neo.ClientError.Database.DatabaseNotFound',
  'Neo.ClientError.Security.Unauthorized',
  'Neo.ClientError.Security.AuthenticationRateLimit',
]);

/**
 * Connectivity failures the driver raises without a Neo4j status code —
 * a closed pool, a socket error surfaced as a plain `Error`.
 */
const UNAVAILABLE_MESSAGE =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET\b.*\bconnect|Failed to connect|Pool is closed|Connection acquisition timed out/i;

/**
 * True when `error` means the Neo4j backend could not serve the request at all.
 *
 * Deliberately conservative — an over-broad match would dress a Cypher bug up
 * as a 503 and hide it.
 */
export function isDriverUnavailableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return true;

  // Only fall back to message-matching when the driver gave us no status code.
  // A coded error has already told us what it is; second-guessing it by string
  // is how a syntax error becomes a fake 503.
  if (typeof code === 'string' && code.length > 0) return false;

  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && UNAVAILABLE_MESSAGE.test(message);
}

/**
 * Translate a raw driver error into the typed, sanitized domain error.
 *
 * The message is scrubbed on the way through: driver errors quote the bolt URI
 * (which can carry credentials), and the three honest-degradation routes echo
 * `error.message` straight into their 503 response bodies.
 */
export function toGraphUnavailableError(error: unknown, operation: string): GraphUnavailableError {
  const raw = error instanceof Error ? error.message : String(error);
  return new GraphUnavailableError(operation, 'neo4j', sanitizeNeo4jErrorMessage(raw));
}

/**
 * Canonical 503 body for an unavailable graph backend. Shared by the
 * interactive read routes (claims, briefing list, briefing detail) so the
 * client can gate on one shape. `message` is already sanitized — it comes from
 * a {@link GraphUnavailableError}, whose message is scrubbed at construction.
 */
export interface GraphDegradedBody {
  degraded: true;
  error: string;
  message: string;
  backend: string;
}

/** Build the canonical {@link GraphDegradedBody} from a typed unavailability error. */
export function graphDegradedBody(error: GraphUnavailableError): GraphDegradedBody {
  return {
    degraded: true,
    error: 'Graph backend unavailable',
    message: error.message,
    backend: error.backend,
  };
}
