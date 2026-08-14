/**
 * @file neo4j-sanitize.ts
 * @description Leaf module for scrubbing Neo4j driver error text before it
 * leaves the server.
 *
 * This lives apart from `neo4j-client.ts` on purpose. `errors.ts` needs the
 * sanitizer (a `GraphUnavailableError` minted from a driver error carries the
 * driver's message), and `neo4j-client.ts` needs `errors.ts` — importing the
 * sanitizer from the client would close that cycle. Keeping it a dependency-free
 * leaf breaks the cycle without duplicating the regexes.
 *
 * `neo4j-client.ts` re-exports `sanitizeNeo4jErrorMessage`, so the existing
 * import sites keep working.
 */

/**
 * Strip credentials and connection endpoints out of a Neo4j error message.
 *
 * Any message that reaches an API response or an LLM tool result has to go
 * through here first. Two distinct leaks, both observed from the real driver:
 *
 * 1. The bolt URI, which can carry credentials —
 *    "Failed to connect to server at bolt://neo4j:hunter2@10.0.0.4:7687".
 * 2. A BARE address. This is what neo4j-driver 6 actually emits for a refused
 *    connection, and it is easy to miss because it has no `bolt://` prefix:
 *    "... Caused by: connect ECONNREFUSED 10.0.0.4:7687". Stripping only the
 *    URI form leaves the internal host and port in the response body.
 *
 * Diagnostic substrings survive deliberately — `ECONNREFUSED`, `Failed to
 * connect`, and the Neo4j status code are what make a sanitized message useful
 * to an operator, and `nl-to-cypher.ts` matches on them.
 */
export function sanitizeNeo4jErrorMessage(message: string): string {
  return (
    message
      .replace(/\b(?:bolt|neo4j)(?:\+s|\+ssc)?:\/\/[^\s'"`]+/gi, '[neo4j]')
      .replace(
        /(?:["'`])?[A-Za-z0-9_.-]*(?:password|token|secret)[A-Za-z0-9_.-]*(?:["'`])?(?:\s*(?:=>|:|=)\s*|\s+is\s+|\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;&)]+)/gi,
        '[redacted]'
      )
      .replace(/\b[A-Za-z0-9_.-]*(?:password|token|secret)[A-Za-z0-9_.-]*\b/gi, '[redacted]')
      // Bare IPv4, with or without a port. Four octets are required, so version
      // strings ("Neo4j 4.0") are not touched.
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[host]')
      // Bare host:port — `localhost:7687`, `neo4j.internal:7687`. The port is
      // mandatory in this pattern and must follow the colon immediately, so
      // prose like "Neo.ClientError.Statement.SyntaxError: 42" is not matched.
      .replace(/\b(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{1,5}\b/gi, '[host]')
  );
}
