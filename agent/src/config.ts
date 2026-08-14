import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ExternalMcpServerYamlSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().min(1),
  }),
]);

const McpServersYamlSchema = z
  .object({
    internal: z
      .object({
        base_url: z.string().optional(),
        servers: z.array(z.string()).default([]),
      })
      .optional(),
    external: z.record(z.string(), ExternalMcpServerYamlSchema).default({}),
    workspace: z
      .object({
        path: z.string().default('/workspace'),
        cleanup_after_days: z.number().int().positive().default(7),
      })
      .optional(),
  })
  .optional();

const AgentConfigSchema = z.object({
  instance: z.object({
    name: z.string().min(1, 'Instance name is required'),
    domain: z.string().min(1, 'Domain is required'),
    description: z.string().min(1, 'Description is required'),
  }),
  budget: z.object({
    daily_limit: z.number().int().positive('daily_limit must be a positive integer'),
    weekly_limit: z.number().int().positive('weekly_limit must be a positive integer'),
    alert_threshold: z.number().positive('alert_threshold must be positive'),
    overflow_policy: z.enum(['queue', 'drop', 'alert_only']),
    // Task 3.3: Cost controls — USD budget caps per operation type
    daily_cost_usd: z.number().positive().optional(),
    per_chat_usd: z.number().positive().optional(),
    per_mission_usd: z.number().positive().optional(),
    per_sweep_usd: z.number().positive().optional(),
  }),
  models: z.record(z.string(), z.string()),
  sweep: z.object({
    enabled: z.boolean(),
    interval_minutes: z.number().int().positive('interval_minutes must be a positive integer'),
    max_actions_per_sweep: z.number().int().positive('max_actions_per_sweep must be a positive integer'),
    autonomy_level: z.enum(['observer', 'advisor', 'autonomous']).default('advisor'),
    priorities: z.array(z.string()),
  }),
  mcpBaseUrl: z.string().url('mcpBaseUrl must be a valid URL').optional(),
  mcp_servers: McpServersYamlSchema,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentConfig {
  instance: {
    name: string;
    domain: string;
    description: string;
  };
  budget: {
    daily_limit: number;
    weekly_limit: number;
    alert_threshold: number;
    overflow_policy: 'queue' | 'drop' | 'alert_only';
  };
  models: Record<string, string>;
  sweep: {
    enabled: boolean;
    interval_minutes: number;
    max_actions_per_sweep: number;
    autonomy_level: 'observer' | 'advisor' | 'autonomous';
    priorities: string[];
  };
  mcpBaseUrl: string;
  externalMcpServers: Record<string, ExternalMcpServerConfig>;
}

// ---------------------------------------------------------------------------
// External MCP Server Types
// ---------------------------------------------------------------------------

export type ExternalMcpServerConfig =
  | { transport: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { transport: 'http'; url: string };

/**
 * Universal requests shared by all agents. Internal graph tools are always
 * available; third-party requests are included only when operator config gives
 * them an explicit transport.
 */
export const UNIVERSAL_MCP_SERVERS = {
  internal: ['impulse-entities', 'impulse-graph'],
  external: ['neo4j-memory', 'filesystem'],
} as const;

/**
 * Exact in-tree HTTP MCP routes. Missing third-party transports must never be
 * invented as `/api/mcp/<name>` endpoints; only names in this set may use the
 * HTTP fallback when no explicit external transport is configured.
 */
export const INTERNAL_PLATFORM_MCP_ROUTES: ReadonlySet<string> = new Set([
  'entities',
  'graph',
  'signals',
  'research',
  'radar',
  'reports',
  'gemini-image',
  'gemini-embeddings',
  'gemini-research',
  'gemini-grounding',
  'super-graph',
]);

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Hard-coded fallback internal MCP base URL, used only when neither the
 * launcher-selected environment nor the YAML supplies one. The local demo
 * launcher normally derives `IMPULSE_MCP_BASE_URL` from the active runtime
 * profile's app port (see scripts/lib/local-demo.ts), so this default is a
 * last resort rather than the usual value.
 */
export const DEFAULT_MCP_BASE_URL = 'http://localhost:9002/api/mcp';

/**
 * OPS-005 — the top-level `models:` keys this runtime actually reads.
 *
 * `orchestrator` pins the PARENT mission turn. Everything else that used to live
 * in that block (`analysis`, `creative`, and the eight task-named keys in the
 * tracked example) was never read by any call site, so a deploy that "upgraded"
 * one of them changed nothing. Per-agent models are declared in
 * `agent/agents/<name>/config.yaml`; the Gemini-side models are
 * environment-configured. A contract test pins the tracked example to this set.
 */
export const LIVE_MODEL_CONFIG_KEYS: readonly string[] = ['orchestrator'];

/** Default for the one live key; mirrored by `Orchestrator.DEFAULT_ORCHESTRATOR_MODEL`. */
const DEFAULT_ORCHESTRATOR_MODEL_KEY_VALUE = 'claude-sonnet-4-6';

/**
 * Resolve the internal MCP base URL under one authoritative precedence rule.
 *
 * The launcher-selected environment (`IMPULSE_MCP_BASE_URL`) is the single
 * active-runtime authority: the local demo launcher derives it from the port
 * the app was actually started on, so the mission runtime always routes to the
 * live app — even when a developer's *ignored* `impulse.config.yaml` still pins
 * a different port (OPS-004). An explicit environment value therefore OUTRANKS
 * stale YAML. YAML is honored only when the environment is silent, and the
 * hard-coded default only when both are absent.
 *
 * Precedence: explicit `IMPULSE_MCP_BASE_URL` env → YAML `mcpBaseUrl` → YAML
 * `mcp_servers.internal.base_url` → {@link DEFAULT_MCP_BASE_URL}.
 *
 * An empty or whitespace-only environment value is treated as "not set" so an
 * exported-but-blank variable can never blank out a real YAML value.
 *
 * Exported for unit testing.
 */
export function resolveMcpBaseUrl(
  yamlTopLevel: string | undefined,
  yamlInternalBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const explicitEnv = env['IMPULSE_MCP_BASE_URL']?.trim();
  if (explicitEnv) return explicitEnv;
  return yamlTopLevel ?? yamlInternalBaseUrl ?? DEFAULT_MCP_BASE_URL;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  instance: {
    name: 'Impulse',
    domain: 'technology-innovation',
    description: 'Technology radar and innovation management platform',
  },
  budget: {
    daily_limit: 100000,
    weekly_limit: 500000,
    alert_threshold: 0.8,
    overflow_policy: 'queue',
  },
  models: { orchestrator: DEFAULT_ORCHESTRATOR_MODEL_KEY_VALUE },
  sweep: {
    enabled: true,
    interval_minutes: 30,
    max_actions_per_sweep: 10,
    autonomy_level: 'advisor' as const,
    priorities: ['stale_signals', 'unlinked_entities', 'pending_evaluations'],
  },
  mcpBaseUrl: process.env['IMPULSE_MCP_BASE_URL'] ?? DEFAULT_MCP_BASE_URL,
  externalMcpServers: {},
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MCP_ENV_REFERENCE_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function mcpEnvReferencedVars(value: string): string[] {
  return [...value.matchAll(MCP_ENV_REFERENCE_RE)].map((match) => match[1]!);
}

/** Keep resolvable references out of the CLI's serialized MCP argv. */
function preserveMcpEnvReferences(
  envMap: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(envMap)) {
    const referenced = mcpEnvReferencedVars(value);
    if (referenced.some((name) => !hostEnv[name])) continue;
    if (value) resolved[key] = value;
  }
  return resolved;
}

export function collectMcpEnvReferencedVars(servers: Record<string, ExternalMcpServerConfig>): string[] {
  const names = new Set<string>();
  for (const server of Object.values(servers)) {
    if (server.transport !== 'stdio' || !server.env) continue;
    for (const value of Object.values(server.env)) {
      for (const name of mcpEnvReferencedVars(value)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Resolve the workspace path from config + config file location.
 *
 * Resolution order:
 * 1. `IMPULSE_WORKSPACE` env var (absolute override)
 * 2. `mcp_servers.workspace.path` from YAML (resolved relative to config dir)
 * 3. `<configDir>/workspace` (default)
 *
 * Creates the directory if it doesn't exist.
 */
function resolveWorkspacePath(configDir: string, workspaceConfig?: { path?: string }): string {
  const envOverride = process.env['IMPULSE_WORKSPACE'];
  if (envOverride) {
    const resolved = path.resolve(envOverride);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  const raw = workspaceConfig?.path ?? 'workspace';
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(configDir, raw);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

/**
 * Parse raw external MCP server definitions from YAML into typed configs.
 * PRESERVES `${VAR}` env references in stdio server env maps (SEC-016) so the
 * plaintext never reaches the CLI child's command line.
 * Replaces `/workspace` in stdio args with the resolved workspace path.
 */
function parseExternalMcpServers(
  rawExternal: Record<string, z.infer<typeof ExternalMcpServerYamlSchema>>,
  workspacePath: string,
  hostEnv: NodeJS.ProcessEnv = process.env
): Record<string, ExternalMcpServerConfig> {
  const result: Record<string, ExternalMcpServerConfig> = {};
  for (const [name, def] of Object.entries(rawExternal)) {
    if (def.transport === 'http') {
      result[name] = { transport: 'http', url: def.url };
    } else {
      const args = def.args.map((arg) =>
        arg.startsWith('/workspace') ? arg.replace('/workspace', workspacePath) : arg
      );
      result[name] = {
        transport: 'stdio',
        command: def.command,
        args,
        ...(def.env ? { env: preserveMcpEnvReferences(def.env) } : {}),
      };
    }
  }
  return result;
}

/**
 * Load agent config from a YAML file.
 *
 * If the file does not exist, returns {@link DEFAULT_AGENT_CONFIG}.
 * If the file exists but is invalid, throws an error with details.
 *
 * The `mcpBaseUrl` field is resolved by {@link resolveMcpBaseUrl}: an explicit
 * `IMPULSE_MCP_BASE_URL` environment value (the launcher-selected active-runtime
 * authority) outranks any YAML value, which in turn outranks the hard-coded
 * default. This precedence is what keeps mission MCP routing following the app
 * the launcher actually started instead of a stale ignored YAML port (OPS-004).
 */
export function loadAgentConfig(configPath?: string): AgentConfig {
  if (!configPath || !fs.existsSync(configPath)) {
    // No YAML — still honor an explicit launcher-selected environment so the
    // default path routes to the active app rather than the static default.
    return { ...DEFAULT_AGENT_CONFIG, mcpBaseUrl: resolveMcpBaseUrl(undefined, undefined) };
  }

  const rawYaml = fs.readFileSync(configPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = yaml.parse(rawYaml);
  } catch (err) {
    throw new Error(`Failed to parse config file "${configPath}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = AgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config file "${configPath}":\n${issues}`);
  }

  const data = result.data;

  const mcpBaseUrl = resolveMcpBaseUrl(data.mcpBaseUrl, data.mcp_servers?.internal?.base_url);

  const configDir = path.dirname(path.resolve(configPath));
  const workspacePath = resolveWorkspacePath(configDir, data.mcp_servers?.workspace);

  const externalMcpServers = data.mcp_servers?.external
    ? parseExternalMcpServers(data.mcp_servers.external, workspacePath)
    : {};

  return {
    instance: data.instance,
    budget: data.budget,
    models: data.models,
    sweep: data.sweep,
    mcpBaseUrl,
    externalMcpServers,
  };
}

/**
 * Construct the full MCP server URL for a named server.
 *
 * @example
 * getMcpServerUrl(config, 'entities')
 * // => 'http://localhost:3000/api/mcp/entities'
 */
export function getMcpServerUrl(config: AgentConfig, serverName: string): string {
  const base = config.mcpBaseUrl.replace(/\/+$/, '');
  // Internal MCP servers use 'impulse-' prefix in agent configs but the
  // API route expects the bare name (e.g. 'signals' not 'impulse-signals')
  const routeName = serverName.replace(/^impulse-/, '');
  return `${base}/${routeName}`;
}

/**
 * Resolve the full set of MCP servers for a specific agent.
 *
 * Merges universal requests with the agent's specialized MCP declarations.
 * Internal universal routes are always included. Universal third-party names
 * are included only when the global config supplies a transport.
 *
 * @param globalExternal - External MCP server definitions from impulse.config.yaml
 * @param agentMcpServers - Per-agent MCP declarations from agent config.yaml
 * @returns Merged internal server names and external server configs
 */
export function resolveAgentMcpServers(
  globalExternal: Record<string, ExternalMcpServerConfig>,
  agentMcpServers: { internal: string[]; external: string[] }
): {
  internal: string[];
  external: Record<string, ExternalMcpServerConfig>;
  /**
   * In-tree route names listed in an agent's external set without an explicit
   * transport. Third-party names are omitted until the operator configures a
   * real stdio/http transport; they are never fabricated as platform routes.
   */
  httpFallback: string[];
} {
  const internal = [...new Set([...UNIVERSAL_MCP_SERVERS.internal, ...agentMcpServers.internal])];

  const externalNames = [...new Set([...UNIVERSAL_MCP_SERVERS.external, ...agentMcpServers.external])];

  const external: Record<string, ExternalMcpServerConfig> = {};
  const httpFallback: string[] = [];
  for (const name of externalNames) {
    if (globalExternal[name]) {
      external[name] = globalExternal[name];
    } else if (INTERNAL_PLATFORM_MCP_ROUTES.has(name.replace(/^impulse-/, ''))) {
      httpFallback.push(name);
    }
  }

  return { internal, external, httpFallback };
}
