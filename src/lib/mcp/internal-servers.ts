/**
 * @file lib/mcp/internal-servers.ts
 * @description The one canonical catalog of in-tree (platform-served) MCP
 * server route names.
 *
 * These are the servers `/api/mcp/[server]` actually mounts. Everything else an
 * agent may request (exa, arxiv, firecrawl, playwright, github, antv-chart,
 * filesystem, neo4j-memory, …) is a THIRD-PARTY server spawned over stdio by the
 * SDK — never served by this app, so `/api/mcp/<name>` for those is a 404.
 *
 * This distinction is load-bearing for the OPS-004 MCP preflight: it must probe
 * exactly the platform-served endpoints and never a third-party name, or a
 * fresh no-YAML install (where every un-declared external falls through to the
 * in-process HTTP fallback) would fail on `/api/mcp/exa` and break every
 * mission.
 *
 * The route (`src/app/api/mcp/[server]/route.ts`) imports this as its
 * `VALID_SERVERS` source; the mission preflight (`mission-mcp-preflight.ts`)
 * imports it as the set it probes. The agent runtime is a separate package and
 * cannot import from `src/lib`, so it mirrors this list explicitly in
 * `agent/src/orchestrator.ts` (`INTERNAL_PLATFORM_MCP_ROUTES`) — keep the two in
 * sync.
 */

/** The six domain MCP servers. */
export const DOMAIN_MCP_SERVERS = ['entities', 'graph', 'signals', 'research', 'radar', 'reports'] as const;

/** In-process Gemini + Super-Graph MCP servers, also served by this app. */
export const AUXILIARY_INTERNAL_MCP_SERVERS = [
  'gemini-image',
  'gemini-embeddings',
  'gemini-research',
  'gemini-grounding',
  'super-graph',
] as const;

/**
 * Every in-tree platform-served MCP server (11). This is the single source of
 * truth for "is this name served by /api/mcp/[server]".
 */
export const INTERNAL_MCP_SERVERS = [...DOMAIN_MCP_SERVERS, ...AUXILIARY_INTERNAL_MCP_SERVERS] as const;

export type InternalMcpServer = (typeof INTERNAL_MCP_SERVERS)[number];

const INTERNAL_MCP_SERVER_SET: ReadonlySet<string> = new Set(INTERNAL_MCP_SERVERS);

/** The agent runtime prefixes its internal server names with `impulse-`. */
export function stripImpulsePrefix(name: string): string {
  return name.replace(/^impulse-/, '');
}

/** True when `name` (bare or `impulse-`-prefixed) is an in-tree platform server. */
export function isInternalMcpServer(name: string): boolean {
  return INTERNAL_MCP_SERVER_SET.has(stripImpulsePrefix(name));
}
