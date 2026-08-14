/**
 * Safety limits for the interactive graph workbench.
 *
 * Keep this module dependency-free: the API route and client workbench both
 * import it so query responses and incremental node expansion share one cap.
 */
export const GRAPH_QUERY_LIMITS = Object.freeze({
  records: 500,
  nodes: 300,
  relationships: 600,
  traversedValues: 5_000,
  responseBytes: 2 * 1024 * 1024,
});
