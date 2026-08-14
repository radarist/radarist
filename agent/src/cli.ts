import * as path from 'path';
import { fileURLToPath } from 'url';
import { listAgents, loadAgentProfile } from './profiles.js';
import type { AgentProfile } from './profiles.js';
import { Orchestrator } from './orchestrator.js';
import type { OrchestratorOptions, MissionResult } from './orchestrator.js';
import { loadAgentConfig } from './config.js';
import { createGraphMcpClient } from './graph-mcp-client.js';
import { startSweepLoop } from './sweep/loop.js';
import type { SweepDeps } from './sweep/loop.js';
import { createLogger } from './logger.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CliCommand {
  name: 'run' | 'sweep' | 'list' | 'describe';
  agent?: string;
  mission?: string;
  configPath?: string;
  agentsDir?: string;
  apiKey?: string;
  logFile?: string;
}

/**
 * Injectable dependencies for testing.
 * When not provided, the real implementations are used.
 */
export interface ExecuteDeps {
  listAgentsFn: (dir: string) => string[];
  loadProfileFn: (dir: string, name: string) => AgentProfile;
  createOrchestratorFn: (options: OrchestratorOptions) => {
    runMission(prompt: string): Promise<MissionResult>;
  };
  startSweepFn: (
    configPath: string | undefined,
    signal: AbortSignal,
    logger?: Logger,
    apiKey?: string
  ) => Promise<void>;
  log: (message: string) => void;
  error: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Default dependencies (production)
// ---------------------------------------------------------------------------

function resolveDefaultAgentsDir(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '..', 'agents');
}

/**
 * Build the OrchestratorOptions for a sweep-dispatched mission. Extracted and
 * exported so the apiKey-threading contract is directly testable: the sweep
 * Orchestrator must carry the resolved MCP auth key (from --api-key or
 * IMPULSE_API_KEY) so its internal HTTP MCP calls authenticate. The `apiKey`
 * key is omitted entirely when no key resolved, so an unauthenticated local
 * sweep behaves exactly as before.
 */
export function buildSweepOrchestratorOptions(
  configPath: string | undefined,
  logger: Logger | undefined,
  apiKey: string | undefined
): OrchestratorOptions {
  const options: OrchestratorOptions = { configPath };
  if (logger !== undefined) options.logger = logger;
  if (apiKey) options.apiKey = apiKey;
  return options;
}

const defaultDeps: ExecuteDeps = {
  listAgentsFn: listAgents,
  loadProfileFn: loadAgentProfile,
  createOrchestratorFn: (options: OrchestratorOptions) => new Orchestrator(options),
  startSweepFn: async (configPath: string | undefined, signal: AbortSignal, logger?: Logger, apiKey?: string) => {
    const log = logger ? (msg: string) => logger.log(msg) : (msg: string) => console.log(msg);
    // ARUN-011: real graph work. executeCypher runs against the app's bounded
    // read-only Cypher tool; persistResults records observations via the same
    // graph MCP server. The old stubs "ran" every cycle against an empty
    // graph and persisted nothing while the help text advertised a sweep.
    const config = loadAgentConfig(configPath);
    // Resolve the MCP auth key once and thread it into BOTH the graph client
    // AND the sweep Orchestrator. Before this, only the graph client received
    // the key — the sweep Orchestrator was constructed without `apiKey`, so its
    // internal HTTP MCP calls carried no `x-api-key` header and every mutating
    // platform tool the sweep dispatched was rejected as unauthenticated.
    const resolvedApiKey = apiKey ?? process.env['IMPULSE_API_KEY'];
    const graphClient = createGraphMcpClient({
      baseUrl: config.mcpBaseUrl,
      apiKey: resolvedApiKey,
      log,
    });
    const sweepDeps: SweepDeps = {
      loadConfig: (path) => loadAgentConfig(path),
      createOrchestrator: (_config) =>
        new Orchestrator(buildSweepOrchestratorOptions(configPath, logger, resolvedApiKey)),
      executeCypher: graphClient.executeCypher,
      persistResults: graphClient.persistResults,
      log,
    };
    await startSweepLoop({ configPath, signal }, sweepDeps);
  },
  log: (message: string) => console.log(message),
  error: (message: string) => console.error(message),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments into a structured command.
 *
 * Expected format:
 * ```
 * impulse-agent <command> [options]
 *
 * Commands:
 *   run <agent>         Run a mission with a specific agent
 *   sweep               Run the sweep loop against the live graph (bounded Cypher via MCP)
 *   list                List available agents
 *   describe <agent>    Show agent profile details
 *
 * Options:
 *   --mission "..."     Mission prompt (required for 'run')
 *   --config <path>     Path to impulse.config.yaml
 *   --agents-dir <path> Path to agents directory
 *   --api-key <key>     API key for MCP server auth
 * ```
 */
export function parseArgs(argv: string[]): CliCommand {
  const args = argv.slice(2);
  const commandName = args[0];

  if (!commandName || commandName.trim() === '') {
    throw new Error('No command provided.\n' + 'Usage: impulse-agent <run|sweep|list|describe> [options]');
  }

  function getFlag(name: string): string | undefined {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  }

  const configPath = getFlag('config');
  const agentsDir = getFlag('agents-dir');
  const apiKey = getFlag('api-key') ?? process.env['IMPULSE_API_KEY'];
  const logFile = getFlag('log-file');

  const base: Partial<CliCommand> = {};
  if (configPath !== undefined) base.configPath = configPath;
  if (agentsDir !== undefined) base.agentsDir = agentsDir;
  if (apiKey !== undefined) base.apiKey = apiKey;
  if (logFile !== undefined) base.logFile = logFile;

  switch (commandName) {
    case 'run': {
      const mission = getFlag('mission');
      const result: CliCommand = { ...base, name: 'run', agent: args[1] };
      if (mission !== undefined) result.mission = mission;
      return result;
    }
    case 'sweep':
      return { ...base, name: 'sweep' };
    case 'list':
      return { ...base, name: 'list' };
    case 'describe':
      return { ...base, name: 'describe', agent: args[1] };
    default:
      throw new Error(`Unknown command: ${commandName}\n` + 'Usage: impulse-agent <run|sweep|list|describe> [options]');
  }
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Execute a parsed CLI command.
 *
 * @returns 0 on success, 1 on mission failure.
 */
export async function execute(command: CliCommand, deps: ExecuteDeps = defaultDeps): Promise<number> {
  const agentsDir = command.agentsDir ?? resolveDefaultAgentsDir();
  const logger = createLogger(command.logFile);

  switch (command.name) {
    case 'list': {
      const names = deps.listAgentsFn(agentsDir);
      if (names.length === 0) {
        deps.log('No agents found.');
      } else {
        deps.log('Available agents:');
        for (const name of names) {
          deps.log(`  - ${name}`);
        }
      }
      return 0;
    }

    case 'describe': {
      if (!command.agent) {
        throw new Error('Usage: impulse-agent describe <agent-name>');
      }
      const profile = deps.loadProfileFn(agentsDir, command.agent);
      deps.log(`Agent: ${profile.name}`);
      deps.log(`Model: ${profile.model}`);
      deps.log(`Description: ${profile.description}`);
      const allServers = [...profile.mcp_servers.internal, ...profile.mcp_servers.external];
      deps.log(`MCP Servers: ${allServers.join(', ')}`);
      deps.log(
        `Profile limits: ${profile.budget.max_tokens} token reference, ${profile.budget.max_tool_calls} tool calls`
      );
      return 0;
    }

    case 'run': {
      if (!command.agent) {
        throw new Error('Usage: impulse-agent run <agent-name> --mission "..."');
      }
      if (!command.mission) {
        throw new Error('--mission flag is required for run command');
      }

      const orchestrator = deps.createOrchestratorFn({
        configPath: command.configPath,
        agentsDir,
        apiKey: command.apiKey,
        logger,
      });

      const result = await orchestrator.runMission(command.mission);

      if (result.success) {
        deps.log(result.result ?? 'Mission completed.');
        return 0;
      } else {
        deps.error(`Mission failed: ${result.errors?.join(', ') ?? 'Unknown error'}`);
        return 1;
      }
    }

    case 'sweep': {
      deps.log('Starting sweep loop... (Ctrl+C to stop)');
      const controller = new AbortController();
      process.on('SIGINT', () => controller.abort());
      process.on('SIGTERM', () => controller.abort());
      await deps.startSweepFn(command.configPath, controller.signal, logger, command.apiKey);
      deps.log('Sweep loop stopped.');
      return 0;
    }
  }
}
