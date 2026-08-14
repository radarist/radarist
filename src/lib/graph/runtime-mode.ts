/**
 * Server-side connection policy for the Neo4j runtime.
 *
 * `disabled` is an isolation boundary, not a health hint: it always wins over
 * NEO4J_URI so a child process cannot reconnect through `.env.local` or an
 * inherited default-port URI. With no explicit mode, a non-empty URI enables
 * Neo4j and a missing URI remains unconfigured. We never synthesize a target.
 *
 * This leaf intentionally has no `server-only` marker: Neo4j maintenance and
 * seed scripts import the client through plain `tsx`, where that Next.js marker
 * throws. The only importer is already server-side graph infrastructure.
 */
export const GRAPH_RUNTIME_MODE_ENV = 'RADARIST_GRAPH_RUNTIME_MODE' as const;

export type GraphRuntime =
  | { mode: 'neo4j'; uri: string }
  | { mode: 'disabled' }
  | { mode: 'unconfigured' };

export class GraphRuntimeConfigurationError extends Error {
  override readonly name: string = 'GraphRuntimeConfigurationError';
}

export class GraphRuntimeDisabledError extends GraphRuntimeConfigurationError {
  override readonly name: string = 'GraphRuntimeDisabledError';
}

export class GraphRuntimeUnconfiguredError extends GraphRuntimeConfigurationError {
  override readonly name: string = 'GraphRuntimeUnconfiguredError';
}

export function resolveGraphRuntime(env: NodeJS.ProcessEnv = process.env): GraphRuntime {
  const explicitMode = env[GRAPH_RUNTIME_MODE_ENV]?.trim().toLowerCase();
  const uri = env.NEO4J_URI?.trim();

  if (explicitMode === 'disabled') return { mode: 'disabled' };

  if (explicitMode && explicitMode !== 'neo4j') {
    throw new GraphRuntimeConfigurationError(
      `${GRAPH_RUNTIME_MODE_ENV} must be either "neo4j" or "disabled" (received ${JSON.stringify(explicitMode)}).`
    );
  }

  if (explicitMode === 'neo4j' && !uri) {
    throw new GraphRuntimeConfigurationError(
      `${GRAPH_RUNTIME_MODE_ENV}=neo4j requires a non-empty NEO4J_URI.`
    );
  }

  return uri ? { mode: 'neo4j', uri } : { mode: 'unconfigured' };
}

export function requireNeo4jRuntime(env: NodeJS.ProcessEnv = process.env): Extract<GraphRuntime, { mode: 'neo4j' }> {
  const runtime = resolveGraphRuntime(env);

  if (runtime.mode === 'disabled') {
    throw new GraphRuntimeDisabledError(
      `Neo4j graph runtime is disabled by ${GRAPH_RUNTIME_MODE_ENV}=disabled.`
    );
  }
  if (runtime.mode === 'unconfigured') {
    throw new GraphRuntimeUnconfiguredError(
      `NEO4J_URI is not configured. Set an explicit URI for Neo4j or use ${GRAPH_RUNTIME_MODE_ENV}=disabled for Firestore-only operation.`
    );
  }

  return runtime;
}
