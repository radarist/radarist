import { jest, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type {
  AgentDefinition,
  McpHttpServerConfig,
  McpStdioServerConfig,
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
} from '@anthropic-ai/claude-agent-sdk';
import type { AgentProfile } from '../src/profiles';
import type { AgentConfig, ExternalMcpServerConfig } from '../src/config';
import { UNIVERSAL_MCP_SERVERS } from '../src/config';
import {
  Orchestrator,
  auditMcpCredentialContainment,
  discoverRuntimeSkills,
  expandMcpHeaderPlaceholders,
  McpCredentialContainmentError,
  resolveMcpAuthHeaderValue,
  resolveOrchestratorEnv,
  INTERNAL_PLATFORM_MCP_ROUTES,
} from '../src/orchestrator';
import { decideToolCall } from '../src/capability-policy';
import type { OrchestratorDeps } from '../src/orchestrator';
import { RUNTIME_SKILL_NAMES } from '../src/runtime-skill-contract';

// OPS-004: cross-package catalog equality. The agent runtime cannot import from
// src/lib, so INTERNAL_PLATFORM_MCP_ROUTES is a hand-maintained mirror of the
// canonical src/lib/mcp/internal-servers.ts. This regression fails the moment
// the two drift, so the route/worker and the Orchestrator can never enforce a
// different platform surface.
describe('OPS-004 canonical internal-MCP catalog parity (cross-package)', () => {
  it('agent INTERNAL_PLATFORM_MCP_ROUTES equals the src canonical INTERNAL_MCP_SERVERS', () => {
    const srcCatalogPath = path.resolve(process.cwd(), '..', 'src', 'lib', 'mcp', 'internal-servers.ts');
    const source = fs.readFileSync(srcCatalogPath, 'utf-8');
    const extract = (constName: string): string[] => {
      const match = source.match(new RegExp(`${constName}\\s*=\\s*\\[([^\\]]*)\\]`));
      if (!match) throw new Error(`Could not find ${constName} in ${srcCatalogPath}`);
      return [...match[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
    };
    const srcNames = [...extract('DOMAIN_MCP_SERVERS'), ...extract('AUXILIARY_INTERNAL_MCP_SERVERS')];
    expect([...INTERNAL_PLATFORM_MCP_ROUTES].sort()).toEqual([...srcNames].sort());
    expect(srcNames).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PROFILES: Map<string, AgentProfile> = new Map([
  [
    'scout',
    {
      name: 'scout',
      description: 'Discovers new signals',
      prompt: '# Scout\nYou are the scout.',
      model: 'claude-sonnet-4-6',
      budget: { max_tokens: 30000, max_tool_calls: 20 },
      mcp_servers: {
        internal: ['impulse-entities', 'impulse-signals'],
        external: ['impulse-research', 'custom-reader'],
      },
      // scout declares an effort in its config.yaml; evaluator (below) does
      // not — this split lets the effort-wiring tests assert both branches.
      effort: 'high',
    },
  ],
  [
    'evaluator',
    {
      name: 'evaluator',
      description: 'Scores technologies',
      prompt: '# Evaluator\nYou score things.',
      model: 'claude-sonnet-4-6',
      budget: { max_tokens: 25000, max_tool_calls: 15 },
      mcp_servers: {
        internal: ['impulse-entities', 'impulse-graph'],
        external: ['impulse-research'],
      },
    },
  ],
  [
    'linker',
    {
      name: 'linker',
      description: 'Discovers relationships',
      prompt: '# Linker\nYou link entities.',
      model: 'claude-sonnet-4-6',
      budget: { max_tokens: 20000, max_tool_calls: 25 },
      mcp_servers: {
        internal: ['impulse-entities', 'impulse-graph', 'impulse-reports'],
        external: [],
      },
    },
  ],
  [
    'curator',
    {
      name: 'curator',
      description: 'Maintains data quality',
      prompt: '# Curator\nYou curate data.',
      model: 'claude-haiku-4-5',
      budget: { max_tokens: 15000, max_tool_calls: 30 },
      mcp_servers: {
        internal: ['impulse-entities', 'impulse-graph'],
        external: [],
      },
    },
  ],
  [
    'strategist',
    {
      name: 'strategist',
      description: 'Analyzes patterns',
      prompt: '# Strategist\nYou strategize.',
      model: 'claude-opus-4-8',
      budget: { max_tokens: 50000, max_tool_calls: 20 },
      mcp_servers: {
        internal: ['impulse-entities', 'impulse-graph', 'impulse-radar'],
        external: ['impulse-research'],
      },
    },
  ],
  [
    'creator',
    {
      name: 'creator',
      description: 'Generates reports',
      prompt: '# Creator\nYou create reports.',
      model: 'claude-opus-4-6',
      budget: { max_tokens: 50000, max_tool_calls: 30 },
      mcp_servers: {
        internal: ['impulse-entities', 'impulse-graph', 'impulse-reports'],
        external: ['impulse-research'],
      },
    },
  ],
]);

const MOCK_EXTERNAL_MCP: Record<string, ExternalMcpServerConfig> = {
  'custom-reader': { transport: 'stdio', command: 'npx', args: ['custom-reader-mcp'] },
  'neo4j-memory': { transport: 'stdio', command: 'uvx', args: ['mcp-neo4j-memory'] },
  filesystem: {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
  },
};

const MOCK_CONFIG: AgentConfig = {
  instance: {
    name: 'TestImpulse',
    domain: 'technology-innovation',
    description: 'Test instance',
  },
  budget: {
    daily_limit: 100000,
    weekly_limit: 500000,
    alert_threshold: 0.8,
    overflow_policy: 'queue',
  },
  models: {
    orchestrator: 'claude-sonnet-4-6',
    analysis: 'claude-sonnet-4-6',
  },
  sweep: {
    enabled: true,
    interval_minutes: 30,
    max_actions_per_sweep: 10,
    autonomy_level: 'advisor',
    priorities: ['stale_signals'],
  },
  mcpBaseUrl: 'http://localhost:3000/api/mcp',
  externalMcpServers: MOCK_EXTERNAL_MCP,
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSuccessResult(overrides?: Partial<SDKResultSuccess>): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 3,
    result: 'Mission completed successfully.',
    stop_reason: 'end_turn',
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 5000,
      output_tokens: 2000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
    } as unknown as SDKResultSuccess['usage'],
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: 'test-session',
    ...overrides,
  };
}

function createErrorResult(overrides?: Partial<SDKResultError>): SDKResultError {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 500,
    duration_api_ms: 400,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      inference_geo: null,
      iterations: null,
      server_tool_use: null,
      service_tier: null,
    } as unknown as SDKResultError['usage'],
    modelUsage: {},
    permission_denials: [],
    errors: ['Something went wrong', 'API timeout'],
    uuid: '00000000-0000-0000-0000-000000000002' as `${string}-${string}-${string}-${string}-${string}`,
    session_id: 'test-session',
    ...overrides,
  };
}

function createMockGenerator(messages: SDKMessage[]): AsyncGenerator<SDKMessage, void> {
  return (async function* () {
    for (const msg of messages) {
      yield msg;
    }
  })();
}

function createMockDeps(overrides?: Partial<OrchestratorDeps>): Partial<OrchestratorDeps> {
  return {
    loadConfig: () => MOCK_CONFIG,
    loadProfiles: () => MOCK_PROFILES,
    getServerUrl: (config: AgentConfig, serverName: string) => `${config.mcpBaseUrl.replace(/\/+$/, '')}/${serverName}`,
    queryFn: () => createMockGenerator([]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Global fetch mock (prevents real network calls during checkMcpHealth)
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

// OPS-004 (B): checkMcpHealth now probes `tools/list` and parses the JSON-RPC
// body — a healthy endpoint returns HTTP 200 with a `result` and no `error`.
// The default mock returns exactly that so every existing runMission test sees
// its internal MCPs online.
function healthyMcpResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
  } as unknown as Response;
}

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn(() => Promise.resolve(healthyMcpResponse())) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator', () => {
  describe('constructor', () => {
    it('should load config and profiles on construction', () => {
      let configCalled = false;
      let profilesCalled = false;

      const deps = createMockDeps({
        loadConfig: () => {
          configCalled = true;
          return MOCK_CONFIG;
        },
        loadProfiles: () => {
          profilesCalled = true;
          return MOCK_PROFILES;
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);

      expect(configCalled).toBe(true);
      expect(profilesCalled).toBe(true);
      expect(orchestrator.getAgentNames()).toHaveLength(6);
    });

    it('should pass configPath and agentsDir options through', () => {
      let receivedConfigPath: string | undefined;
      let receivedAgentsDir: string | undefined;

      const deps = createMockDeps({
        loadConfig: (configPath?: string) => {
          receivedConfigPath = configPath;
          return MOCK_CONFIG;
        },
        loadProfiles: (agentsDir: string) => {
          receivedAgentsDir = agentsDir;
          return MOCK_PROFILES;
        },
      });

      new Orchestrator({ configPath: '/custom/config.yaml', agentsDir: '/custom/agents' }, deps);

      expect(receivedConfigPath).toBe('/custom/config.yaml');
      expect(receivedAgentsDir).toBe('/custom/agents');
    });
  });

  describe('getAgentDefinitions', () => {
    it('should return all 6 agents as SDK AgentDefinitions', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      const names = Object.keys(definitions);
      expect(names).toHaveLength(6);
      expect(names.sort()).toEqual(['creator', 'curator', 'evaluator', 'linker', 'scout', 'strategist']);
    });

    it('should set description and prompt from profile', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      const scout = definitions['scout'] as AgentDefinition;
      expect(scout.description).toBe('Discovers new signals');
      expect(scout.prompt).toBe('# Scout\nYou are the scout.');
    });

    it('OPS-005: hands the SDK each profile’s EXACT pinned model, not its family alias', () => {
      // Pre-OPS-005 these collapsed to 'sonnet' / 'opus' / 'haiku', so pinning a
      // newer same-price id in a profile changed nothing the SDK saw.
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      expect(definitions['scout']?.model).toBe('claude-sonnet-4-6');
      expect(definitions['evaluator']?.model).toBe('claude-sonnet-4-6');
      expect(definitions['linker']?.model).toBe('claude-sonnet-4-6');
    });

    it('should map opus model correctly', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      // strategist uses claude-opus-4-8
      expect(definitions['strategist']?.model).toBe('claude-opus-4-8');
      expect(definitions['creator']?.model).toBe('claude-opus-4-6');
    });

    it('should map haiku model correctly', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      // curator uses claude-haiku-4-5
      expect(definitions['curator']?.model).toBe('claude-haiku-4-5');
    });

    it('should forward effort from the profile when the profile declares one', () => {
      // P3 dead-config fix: profiles.ts already parsed config.yaml's `effort`
      // but buildAgentDefinitions never forwarded it to the SDK. scout's mock
      // profile sets effort:'high', so its AgentDefinition must carry it.
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      expect(definitions['scout']?.effort).toBe('high');
    });

    it('should omit the effort key when the profile does not declare one', () => {
      // evaluator's mock profile has no `effort` — the AgentDefinition must NOT
      // include the key so the SDK applies its model default rather than a
      // pinned value.
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      const evaluator = definitions['evaluator'] as AgentDefinition;
      expect('effort' in evaluator).toBe(false);
    });

    it('should merge universal and per-agent mcpServers', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const definitions = orchestrator.getAgentDefinitions();

      const scoutServers = definitions['scout']?.mcpServers as string[];
      // Universal internal always present
      expect(scoutServers).toContain('impulse-entities');
      expect(scoutServers).toContain('impulse-graph');
      // Per-agent internal
      expect(scoutServers).toContain('impulse-signals');
      // Universal external (defined in MOCK_EXTERNAL_MCP)
      expect(scoutServers).toContain('neo4j-memory');
      expect(scoutServers).toContain('filesystem');
      expect(scoutServers).not.toContain('neo4j-cypher');
      // Explicitly assigned external servers remain supported, but are not
      // ambient capabilities for every agent.
      expect(scoutServers).toContain('custom-reader');
      expect(definitions['evaluator']?.mcpServers as string[]).not.toContain('custom-reader');
      // Per-agent external 'impulse-research' is NOT declared in
      // MOCK_EXTERNAL_MCP, so resolveAgentMcpServers routes it through the
      // httpFallback bucket (see agent/src/config.ts:312-330). The
      // orchestrator surfaces httpFallback names alongside resolved external
      // configs, so the SDK sees the name and serves it via the in-process
      // HTTP MCP at IMPULSE_MCP_BASE_URL/impulse-research. Before that bucket
      // existed, gemini-image / super-graph and similar agent-declared HTTP
      // MCPs were silently dropped; this assertion documents the fix.
      expect(scoutServers).toContain('impulse-research');
    });
  });

  describe('getMcpServerConfigs', () => {
    it('should deduplicate servers across all profiles including universal tier', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      const serverNames = Object.keys(configs).sort();
      // Unique set: universal internal + per-agent internal + universal external
      expect(serverNames).toContain('impulse-entities');
      expect(serverNames).toContain('impulse-graph');
      expect(serverNames).toContain('impulse-signals');
      expect(serverNames).toContain('impulse-radar');
      expect(serverNames).toContain('impulse-reports');
      // Universal external
      expect(serverNames).toContain('neo4j-memory');
      expect(serverNames).toContain('filesystem');
      expect(serverNames).toContain('custom-reader');
      // 'impulse-research' is the httpFallback case — declared by agents as
      // external but not in MOCK_EXTERNAL_MCP, so resolveAgentMcpServers adds
      // it to httpFallback and getMcpServerConfigs maps it to an HTTP entry
      // pointed at the in-process Next.js MCP route. See
      // agent/src/config.ts:312-330 for the documented contract.
      expect(serverNames).toContain('impulse-research');
    });

    it('should use correct URL format for internal HTTP servers', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      const entities = configs['impulse-entities'];
      expect(entities?.type).toBe('http');
      if (entities?.type === 'http') {
        expect(entities.url).toBe('http://localhost:3000/api/mcp/impulse-entities');
      }

      const signals = configs['impulse-signals'];
      expect(signals?.type).toBe('http');
      if (signals?.type === 'http') {
        expect(signals.url).toBe('http://localhost:3000/api/mcp/impulse-signals');
      }
    });

    it('should use correct transport per server type', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      // Internal servers should be HTTP
      expect(configs['impulse-entities']?.type).toBe('http');
      expect(configs['impulse-graph']?.type).toBe('http');
      expect(configs['impulse-signals']?.type).toBe('http');

      // External stdio servers
      expect(configs['custom-reader']?.type).toBe('stdio');
      expect(configs['neo4j-memory']?.type).toBe('stdio');
      expect(configs['filesystem']?.type).toBe('stdio');
    });

    it('should include auth headers on internal HTTP servers when apiKey is provided', () => {
      const orchestrator = new Orchestrator({ apiKey: 'test-key-123' }, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      // Internal HTTP servers get auth headers
      const entities = configs['impulse-entities'];
      if (entities?.type === 'http') {
        expect(entities.headers).toEqual({ 'x-api-key': '${RADARIST_MCP_AUTH_KEY}' });
      }

      // External stdio servers don't have headers
      const customReader = configs['custom-reader'];
      expect(customReader?.type).toBe('stdio');
    });

    it('should exclude auth headers when no apiKey is provided', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      const entities = configs['impulse-entities'];
      if (entities?.type === 'http') {
        expect(entities.headers).toBeUndefined();
      }
    });

    it('should use stdio transport for external servers defined in config', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      // An explicitly assigned arbitrary external server keeps its configured
      // stdio transport without becoming universal.
      const customReader = configs['custom-reader'];
      expect(customReader).toBeDefined();
      expect(customReader.type).toBe('stdio');
      if (customReader.type === 'stdio') {
        expect(customReader.command).toBe('npx');
        expect(customReader.args).toEqual(['custom-reader-mcp']);
      }

      // Internal servers should still be HTTP
      const entities = configs['impulse-entities'];
      expect(entities.type).toBe('http');
    });

    it('should not add auth headers to external stdio servers', () => {
      const orchestrator = new Orchestrator({ apiKey: 'my-key' }, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      const customReader = configs['custom-reader'] as McpStdioServerConfig;
      expect(customReader.type).toBe('stdio');
      // Stdio configs don't have headers field
      expect('headers' in customReader).toBe(false);
    });

    it('should bind x-mission-id header when missionId is provided (C2)', () => {
      const orchestrator = new Orchestrator({ apiKey: 'test-key', missionId: 'mission-abc-123' }, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      // Internal HTTP servers must carry both headers so the platform MCP
      // route can bind tool calls to this mission server-side. Without this,
      // draftReport / publishReport reject with "missionId not bound" and
      // every mission costs $$$ but produces zero reports.
      const entities = configs['impulse-entities'];
      if (entities?.type === 'http') {
        expect(entities.headers).toEqual({
          'x-api-key': '${RADARIST_MCP_AUTH_KEY}',
          'x-mission-id': 'mission-abc-123',
        });
      }

      // External stdio servers must NOT receive the header.
      const customReader = configs['custom-reader'] as McpStdioServerConfig;
      expect(customReader.type).toBe('stdio');
      expect('headers' in customReader).toBe(false);
    });

    it('should omit x-mission-id header when missionId is not provided (C2)', () => {
      const orchestrator = new Orchestrator({ apiKey: 'test-key' }, createMockDeps());
      const configs = orchestrator.getMcpServerConfigs();

      const entities = configs['impulse-entities'];
      if (entities?.type === 'http') {
        expect(entities.headers).toEqual({ 'x-api-key': '${RADARIST_MCP_AUTH_KEY}' });
        expect(entities.headers).not.toHaveProperty('x-mission-id');
      }
    });
  });

  describe('getAgentNames', () => {
    it('should return sorted list of agent names', () => {
      const orchestrator = new Orchestrator(undefined, createMockDeps());
      const names = orchestrator.getAgentNames();

      expect(names).toEqual(['creator', 'curator', 'evaluator', 'linker', 'scout', 'strategist']);
    });
  });

  describe('runMission', () => {
    it('should return success result when query succeeds', async () => {
      const deps = createMockDeps({
        queryFn: () => createMockGenerator([createSuccessResult()]),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Discover new AI signals');

      expect(result.success).toBe(true);
      expect(result.result).toBe('Mission completed successfully.');
      expect(result.costUsd).toBe(0.05);
      expect(result.tokenUsage).toEqual({ input: 5000, output: 2000 });
      expect(result.errors).toBeUndefined();
    });

    it('OPS-004: fails fast at $0 with no provider spend when a required internal MCP is unreachable', async () => {
      // Simulate the OPS-004 misroute: the platform MCP base points at a port
      // nothing is listening on, so every internal HTTP ping is refused. The
      // mission must abort BEFORE the SDK query loop (provider spend) rather
      // than driving an expensive tool-search loop to the watchdog abort.
      const savedFetch = globalThis.fetch;
      globalThis.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 502 } as Response)) as typeof fetch;
      let queryCalled = false;
      try {
        const deps = createMockDeps({
          queryFn: () => {
            queryCalled = true;
            return createMockGenerator([createSuccessResult()]);
          },
        });
        const orchestrator = new Orchestrator(undefined, deps);
        const result = await orchestrator.runMission('Should not spend a cent');

        expect(result.success).toBe(false);
        // The SDK query loop is where provider tokens are spent — it must never
        // have been entered.
        expect(queryCalled).toBe(false);
        expect(result.costUsd).toBe(0);
        expect(result.tokenUsage).toEqual({ input: 0, output: 0 });
        expect(result.errors?.[0]).toMatch(/mcp-preflight-failed/);
        expect(result.errors?.[0]).toMatch(/impulse-entities|impulse-graph/);
        // User-visible error must NOT leak the internal base URL.
        expect(result.errors?.[0]).not.toMatch(/https?:\/\//);
        // Typed failure kind so the worker can short-circuit later paid stages.
        expect(result.failureKind).toBe('mcp-preflight-failed');
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it('OPS-004 (B): a required internal MCP that returns a JSON-RPC error at HTTP 200 (invalid key) is unhealthy', async () => {
      // `tools/list` with a rejected key returns HTTP 200 + a JSON-RPC error.
      // response.ok alone would call it healthy; the body must be parsed.
      const savedFetch = globalThis.fetch;
      globalThis.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'Unauthorized' } }),
        } as unknown as Response)
      ) as typeof fetch;
      let queryCalled = false;
      try {
        const deps = createMockDeps({
          queryFn: () => {
            queryCalled = true;
            return createMockGenerator([createSuccessResult()]);
          },
        });
        const orchestrator = new Orchestrator(undefined, deps);
        const result = await orchestrator.runMission('Invalid key should not spend');

        expect(result.success).toBe(false);
        expect(queryCalled).toBe(false);
        expect(result.failureKind).toBe('mcp-preflight-failed');
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it('OPS-004: fails fast when entities/graph are healthy but a specialist internal MCP (reports) is down', async () => {
      // Asymmetric reachability: the universal tier answers but impulse-reports
      // is refused. A two-server witness would pass here and let the mission
      // burn budget searching for Report tools. Requiring the
      // FULL internal set catches it.
      const savedFetch = globalThis.fetch;
      globalThis.fetch = jest.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('impulse-reports')) {
          return Promise.resolve({ ok: false, status: 502 } as Response);
        }
        return Promise.resolve(healthyMcpResponse());
      }) as typeof fetch;
      let queryCalled = false;
      try {
        const deps = createMockDeps({
          queryFn: () => {
            queryCalled = true;
            return createMockGenerator([createSuccessResult()]);
          },
        });
        const orchestrator = new Orchestrator(undefined, deps);
        // Sanity: impulse-reports is an internal HTTP server this mission is
        // configured with, and impulse-entities/graph are healthy.
        const configs = orchestrator.getMcpServerConfigs();
        expect(configs['impulse-reports']).toMatchObject({ type: 'http' });

        const result = await orchestrator.runMission('Specialist MCP down');

        expect(result.success).toBe(false);
        expect(queryCalled).toBe(false);
        expect(result.costUsd).toBe(0);
        expect(result.errors?.[0]).toMatch(/impulse-reports/);
        expect(result.errors?.[0]).not.toMatch(/impulse-entities/);
        expect(result.errors?.[0]).toMatch(/mcp-preflight-failed/);
        expect(result.errors?.[0]).not.toMatch(/https?:\/\//);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it('fresh install omits unconfigured third parties but retains an in-tree HTTP fallback', async () => {
      // No impulse.config.yaml means no third-party transport authority. The
      // in-tree gemini-image route remains available; exa is omitted entirely.
      const freshConfig: AgentConfig = { ...MOCK_CONFIG, externalMcpServers: {} };
      const soloProfile = new Map<string, AgentProfile>([
        [
          'creator',
          {
            name: 'creator',
            description: 'Generates reports',
            prompt: '# Creator',
            model: 'claude-sonnet-4-6',
            budget: { max_tokens: 20000, max_tool_calls: 20 },
            mcp_servers: { internal: ['impulse-entities', 'impulse-graph'], external: ['exa', 'gemini-image'] },
          },
        ],
      ]);

      const savedFetch = globalThis.fetch;
      // Every platform endpoint is healthy. A third-party fallback URL must
      // NEVER be fetched at all.
      const fetchSpy = jest.fn((_input: RequestInfo | URL) => Promise.resolve(healthyMcpResponse()));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;
      let queryCalled = false;
      try {
        const deps = createMockDeps({
          loadConfig: () => freshConfig,
          loadProfiles: () => soloProfile,
          queryFn: () => {
            queryCalled = true;
            return createMockGenerator([createSuccessResult()]);
          },
        });
        const orchestrator = new Orchestrator(undefined, deps);
        expect(orchestrator.getMcpServerConfigs()['exa']).toBeUndefined();

        const result = await orchestrator.runMission('Fresh install OSS mission');

        // The mission proceeds because exa is not a platform server...
        expect(queryCalled).toBe(true);
        expect(result.success).toBe(true);
        // ...and the third-party fallback URL was never probed.
        const fetchedUrls = fetchSpy.mock.calls.map(([input]) => (typeof input === 'string' ? input : String(input)));
        expect(fetchedUrls.some((url) => url.endsWith('/exa'))).toBe(false);
        expect(fetchedUrls.some((url) => url.endsWith('/gemini-image'))).toBe(true);
      } finally {
        globalThis.fetch = savedFetch;
      }

      // Now flip: gemini-image (a real platform route) is down → mission must fail fast.
      globalThis.fetch = jest.fn((input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/gemini-image')) return Promise.resolve({ ok: false, status: 502 } as Response);
        return Promise.resolve(healthyMcpResponse());
      }) as typeof fetch;
      let queryCalled2 = false;
      try {
        const deps = createMockDeps({
          loadConfig: () => freshConfig,
          loadProfiles: () => soloProfile,
          queryFn: () => {
            queryCalled2 = true;
            return createMockGenerator([createSuccessResult()]);
          },
        });
        const orchestrator = new Orchestrator(undefined, deps);
        const result = await orchestrator.runMission('gemini-image down');
        expect(queryCalled2).toBe(false);
        expect(result.failureKind).toBe('mcp-preflight-failed');
        expect(result.errors?.[0]).toMatch(/gemini-image/);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it('OPS-004: proceeds to provider spend when the required internal MCPs are reachable', async () => {
      // The default global fetch mock returns ok:true → required servers online.
      let queryCalled = false;
      const deps = createMockDeps({
        queryFn: () => {
          queryCalled = true;
          return createMockGenerator([createSuccessResult()]);
        },
      });
      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Healthy platform');

      expect(queryCalled).toBe(true);
      expect(result.success).toBe(true);
    });

    it('last-resort estimate prices each model on ITS family card, cache-write included (AUDIT-022)', async () => {
      // total_cost_usd 0 and no per-model costUSD → the estimator branch.
      // A Fable mission with heavy cache-write must NOT be billed at the old
      // hardcoded Sonnet rates with cache-write at $0.
      const deps = createMockDeps({
        queryFn: () =>
          createMockGenerator([
            createSuccessResult({
              total_cost_usd: 0,
              modelUsage: {
                'claude-fable-5': {
                  inputTokens: 1_000_000,
                  outputTokens: 100_000,
                  cacheReadInputTokens: 2_000_000,
                  cacheCreationInputTokens: 500_000,
                  costUSD: 0,
                  contextWindow: 200_000,
                  webSearchRequests: 0,
                } as unknown as NonNullable<SDKResultSuccess['modelUsage']>[string],
              },
            }),
          ]),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Estimate me honestly');

      // FABLE card: 1M×$10 + 0.1M×$50 + 2M×$1 cacheRead + 0.5M×$12.50 cacheWrite
      // = 10 + 5 + 2 + 6.25 = $23.25 (old Sonnet-hardcode gave 3+1.5+0.6+0 = $5.10)
      expect(result.costUsd).toBeCloseTo(23.25, 2);
    });

    it('fails closed without a model breakdown — no fabricated wrong-model estimate (TEST-021)', async () => {
      const deps = createMockDeps({
        queryFn: () =>
          createMockGenerator([
            createSuccessResult({
              total_cost_usd: 0,
              modelUsage: {},
              usage: {
                input_tokens: 1_000_000,
                output_tokens: 0,
                cache_creation_input_tokens: 1_000_000,
                cache_read_input_tokens: 0,
              } as unknown as SDKResultSuccess['usage'],
            }),
          ]),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('No breakdown');

      // TEST-021: with no per-model breakdown the effective model is unknown, so
      // the aggregate counters CANNOT be priced. The old code fabricated a
      // Sonnet-floor $6.75, then an interim version kept the SDK's own $0 — both
      // are misleading. We now fail CLOSED: cost is unavailable (null) with a
      // reason, never a wrong-model estimate and never a deceptive $0.
      expect(result.costUsd).toBeNull();
      expect(result.costUnavailableReason).toMatch(/no per-model usage breakdown/i);
    });

    it('should return error result when query fails', async () => {
      const deps = createMockDeps({
        queryFn: () => createMockGenerator([createErrorResult()]),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Do something that fails');

      expect(result.success).toBe(false);
      expect(result.result).toBeUndefined();
      expect(result.costUsd).toBe(0.01);
      expect(result.tokenUsage).toEqual({ input: 1000, output: 200 });
      expect(result.errors).toEqual(['Something went wrong', 'API timeout']);
    });

    // A heavy turn (e.g. an Opus subagent with large cache_read) accumulates
    // cumulative tokens, then the SDK aborts on budget and returns an error
    // result whose total_cost_usd/usage reflect only the final turn. The recorded
    // cost/tokens must reflect reality, not that undercount.
    const heavyTurn = (id: string): SDKMessage =>
      ({
        type: 'assistant',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Researching…' }],
          model: 'claude-opus-4-6',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 200000, output_tokens: 30000, cache_read_input_tokens: 800000 },
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-0000000000aa' as `${string}-${string}-${string}-${string}-${string}`,
        session_id: 'test-session',
      }) as SDKMessage;

    it('floors a budget-abort error cost at the budget cap and uses cumulative tokens (not the undercounted headline)', async () => {
      const budgetError = createErrorResult({ total_cost_usd: 0.01, errors: ['Reached maximum budget ($5)'] });
      const deps = createMockDeps({
        queryFn: () => createMockGenerator([heavyTurn('msg-heavy-1'), budgetError]),
      });

      const orchestrator = new Orchestrator({ maxBudgetUsd: 5 }, deps);
      const result = await orchestrator.runMission('Expensive report mission');

      expect(result.success).toBe(false);
      // MISSION-004: the turn ran on OPUS (200K in / 30K out / 800K cache-read
      // = $2.15 at current Opus rates $5/$25/$0.50). The estimate sits below
      // the $5 budget cap the SDK stopped at, so the cap floor wins — by
      // definition spend reached the cap when the SDK aborted for budget.
      expect(result.costUsd).toBe(0.01);
      expect(result.providerReportedCostUsd).toBe(0.01);
      expect(result.exposureUsd).toBe(5);
      expect(result.tokenUsage.input).toBe(200000); // cumulative, not the final-turn 1000
      expect(result.errors).toEqual(['Reached maximum budget ($5)']);
    });

    it('uses the cumulative-token estimate for a non-budget failure when it beats the SDK headline', async () => {
      const err = createErrorResult({ total_cost_usd: 0.01, errors: ['API timeout'] });
      const deps = createMockDeps({
        queryFn: () => createMockGenerator([heavyTurn('msg-heavy-2'), err]),
      });

      const orchestrator = new Orchestrator({}, deps); // no budget cap
      const result = await orchestrator.runMission('Failing heavy mission');

      expect(result.success).toBe(false);
      // (200000*3 + 30000*15 + 800000*0.3) / 1e6 = 1.29
      // MISSION-004: Opus-priced at CURRENT rates ($2.15 = 0.2M×$5 + 0.03M×$25
      // + 0.8M×$0.50), vs the old always-Sonnet $1.29 for this exact fixture.
      expect(result.costUsd).toBe(0.01);
      expect(result.providerReportedCostUsd).toBe(0.01);
      expect(result.exposureUsd).toBeCloseTo(2.15, 2);
      expect(result.tokenUsage.input).toBe(200000);
    });

    it('suppresses an identical re-emitted usage event without lowering the exposure bound', async () => {
      const err = createErrorResult({ total_cost_usd: 0.01, errors: ['API timeout'] });
      const deps = createMockDeps({
        queryFn: () => createMockGenerator([heavyTurn('msg-duplicate'), heavyTurn('msg-duplicate'), err]),
      });
      const result = await new Orchestrator({}, deps).runMission('Duplicated usage stream');

      expect(result.costUsd).toBe(0.01);
      expect(result.exposureUsd).toBeCloseTo(2.15, 2);
      expect(result.duplicateUsageEvents).toBe(1);
      expect(result.tokenUsage.input).toBe(200000);
    });

    it('refuses an unsupported configured model before the SDK query starts', async () => {
      const queryFn = jest.fn(() => createMockGenerator([createSuccessResult()]));
      const result = await new Orchestrator({ model: 'claude-opus-9-9' }, createMockDeps({ queryFn })).runMission(
        'Unsupported model'
      );

      expect(queryFn).not.toHaveBeenCalled();
      expect(result.failureKind).toBe('unsupported-model');
      expect(result.costUsd).toBe(0);
    });

    it('should pass correct options to query', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('Test mission prompt');

      expect(capturedParams).toBeDefined();
      // Prompt is now prefixed with the preamble; original text appears after the separator
      expect(capturedParams?.prompt).toContain('Test mission prompt');
      expect(capturedParams?.prompt).toContain('---\n');

      const options = capturedParams?.options;
      expect(options).toBeDefined();

      // Should have agents
      const agents = options?.agents as Record<string, AgentDefinition>;
      expect(Object.keys(agents)).toHaveLength(6);

      // Should have MCP servers
      const mcpServers = options?.mcpServers as Record<string, McpHttpServerConfig | McpStdioServerConfig>;
      expect(Object.keys(mcpServers).length).toBeGreaterThan(0);

      // Should have model from config
      expect(options?.model).toBe('claude-sonnet-4-6');

      // Should bypass permissions
      expect(options?.permissionMode).toBe('bypassPermissions');
      expect(options?.allowDangerouslySkipPermissions).toBe(true);

      // Should not persist session
      expect(options?.persistSession).toBe(false);
    });

    it('should handle empty message stream gracefully', async () => {
      const deps = createMockDeps({
        queryFn: () => createMockGenerator([]),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Empty response test');

      expect(result.success).toBe(false);
      expect(result.costUsd).toBeNull();
      expect(result.providerReportedCostUsd).toBeNull();
      expect(result.tokenUsage).toEqual({ input: 0, output: 0 });
      expect(result.errors).toEqual(['No result message received from SDK']);
    });

    it('should skip non-result messages and use the result', async () => {
      const assistantMessage: SDKMessage = {
        type: 'assistant',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Working...' }],
          model: 'claude-sonnet-4-6',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 50 },
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000003' as `${string}-${string}-${string}-${string}-${string}`,
        session_id: 'test-session',
      } as SDKMessage;

      const deps = createMockDeps({
        queryFn: () => createMockGenerator([assistantMessage, createSuccessResult()]),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Multi-message mission');

      expect(result.success).toBe(true);
      expect(result.result).toBe('Mission completed successfully.');
    });

    it('should handle query throwing an error', async () => {
      const deps = createMockDeps({
        queryFn: () => {
          throw new Error('SDK initialization failed');
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Failing mission');

      expect(result.success).toBe(false);
      expect(result.costUsd).toBeNull();
      expect(result.providerReportedCostUsd).toBeNull();
      expect(result.errors).toEqual(['SDK initialization failed']);
    });

    it('should handle async generator error', async () => {
      const deps = createMockDeps({
        queryFn: () =>
          (async function* () {
            throw new Error('Stream error');
          })(),
      });

      const orchestrator = new Orchestrator(undefined, deps);
      const result = await orchestrator.runMission('Stream error mission');

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(['Stream error']);
    });

    it('should call onSkillInvocation when a Skill tool-use fires', async () => {
      const skillMsg = (n: number, skillName: string): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: `tool-${n}`,
                name: 'Skill',
                input: { skill: skillName, args: 'the arg payload' },
              },
            ],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [
        skillMsg(1, 'grounded-answer'),
        skillMsg(2, 'rate-source-admiralty'),
        createSuccessResult(),
      ];

      const calls: Array<{ skill: string; args?: string; turn: number }> = [];
      const orchestrator = new Orchestrator(
        {
          onSkillInvocation: async (inv) => {
            calls.push({ skill: inv.skill, args: inv.args, turn: inv.turn });
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      await orchestrator.runMission('Skill trail test');

      expect(calls).toHaveLength(2);
      expect(calls[0].skill).toBe('grounded-answer');
      expect(calls[0].args).toBe('the arg payload');
      expect(calls[0].turn).toBe(1);
      expect(calls[1].skill).toBe('rate-source-admiralty');
      expect(calls[1].turn).toBe(2);
    });

    it('omits the optional args field when Skill is called without args', async () => {
      const skillMsg = {
        type: 'assistant',
        message: {
          id: 'msg-no-args',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-no-args', name: 'Skill', input: { skill: 'design-pass' } }],
          model: 'claude-sonnet-4-6',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000001',
        session_id: 'test-session',
      } as unknown as SDKMessage;
      const calls: Array<Record<string, unknown>> = [];
      const orchestrator = new Orchestrator(
        { onSkillInvocation: async (inv) => void calls.push(inv) },
        createMockDeps({ queryFn: () => createMockGenerator([skillMsg, createSuccessResult()]) })
      );

      await orchestrator.runMission('Skill receipt without args');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ skill: 'design-pass', turn: 1 });
      expect(Object.prototype.hasOwnProperty.call(calls[0], 'args')).toBe(false);
    });

    it('should not call onSkillInvocation for non-Skill tool uses', async () => {
      const nonSkillMsg: SDKMessage = {
        type: 'assistant',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'exa_search', input: { query: 'x' } }],
          model: 'claude-sonnet-4-6',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000001' as `${string}-${string}-${string}-${string}-${string}`,
        session_id: 'test-session',
      } as SDKMessage;

      const calls: unknown[] = [];
      const orchestrator = new Orchestrator(
        {
          onSkillInvocation: async (inv) => {
            calls.push(inv);
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator([nonSkillMsg, createSuccessResult()]) })
      );

      await orchestrator.runMission('Non-skill tool test');
      expect(calls).toHaveLength(0);
    });

    it('should abort and throw when watchdog detects duplicate tool calls', async () => {
      const dupMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tool-${n}`, name: 'loop_me', input: { q: 'same' } }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [dupMsg(1), dupMsg(2), dupMsg(3), createSuccessResult()];

      const orchestrator = new Orchestrator(
        { watchdog: { enabled: true } },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      const result = await orchestrator.runMission('Watchdog loop test');

      // Watchdog should have aborted — mission returns success=false with the
      // watchdog reason in errors.
      expect(result.success).toBe(false);
      expect(result.errors?.[0]).toContain('Watchdog abort');
      expect(result.errors?.[0]).toContain('loop_me');
    });

    it('returns success=false carrying the watchdog abort reason when watchdog trips during the SDK loop', async () => {
      // G2 wiring test: pins the orchestrator's catch-block contract for the
      // watchdog → throw → MissionResult path. Distinct from the sibling test
      // above (which only checks the throw fires) by asserting the precise
      // reason-string format the watchdog produces and that the orchestrator's
      // `Watchdog abort:` prefix is preserved end-to-end into MissionResult.errors.
      //
      // Source-of-truth references (read-only):
      //   - orchestrator.ts:749   throws `Watchdog abort: ${reason}`
      //   - orchestrator.ts:832-854  catch block → success:false + errors:[msg]
      //   - hooks/watchdog.ts:144 produces `tool X with identical args fired N× ... — loop detected`
      const dupMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-wd-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tool-wd-${n}`, name: 'spinning_tool', input: { query: 'identical' } }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-0000000000a${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [dupMsg(1), dupMsg(2), dupMsg(3), createSuccessResult()];

      const orchestrator = new Orchestrator(
        { watchdog: { enabled: true } },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      const result = await orchestrator.runMission('Watchdog wiring contract test');

      // Pin the catch-block contract: success flips false and the thrown
      // error message is captured into errors[0].
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors).toHaveLength(1);

      // The orchestrator's throw site (orchestrator.ts:749) prefixes the
      // watchdog's reason with `Watchdog abort: `. That literal prefix must
      // survive the catch-block → MissionResult.errors round-trip — that's
      // the wiring this test guards.
      const errorMessage = result.errors?.[0] ?? '';
      expect(errorMessage).toMatch(/^Watchdog abort: /);

      // The reason-fragment shape emitted by Watchdog.recordToolCall when
      // duplicateThreshold is hit (hooks/watchdog.ts:143-145). Pinning the
      // structural words `identical args fired` + `loop detected` ensures
      // the watchdog's specific halt cause is the reason carried — not some
      // other thrown error that happens to flip success=false.
      expect(errorMessage).toMatch(/identical args fired/);
      expect(errorMessage).toMatch(/loop detected/);

      // Fingerprint-level evidence that the duplicate-args heuristic fired
      // (vs. the H7 soft-loop or empty-turn paths, which produce different
      // reason strings).
      expect(errorMessage).toContain('spinning_tool');
    });

    it('should include TIME BUDGET preamble when timeoutMs is set', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator({ timeoutMs: 90 * 60_000 }, deps);
      await orchestrator.runMission('Time-budget test');

      expect(capturedParams?.prompt).toContain('TIME BUDGET');
      expect(capturedParams?.prompt).toContain('90 minutes');
      expect(capturedParams?.prompt).toContain('70% elapsed');
    });

    it('should omit TIME BUDGET preamble when timeoutMs not set', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('No time-budget test');

      expect(capturedParams?.prompt).not.toContain('TIME BUDGET');
    });

    it('should fire onCheckpoint every N turns with accumulated text', async () => {
      // Build 12 assistant messages with distinct text; checkpoint is configured
      // for every 3 turns — expect 4 invocations (turns 3, 6, 9, 12).
      const makeAssistantMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            // Text block is ≥200 chars per turn so each checkpoint cycle clears
            // the delta-skip threshold — tests the firing cadence, not the skip.
            content: [{ type: 'text', text: `turn-${n} content `.repeat(20) }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [];
      for (let i = 1; i <= 12; i++) msgs.push(makeAssistantMsg(i));
      msgs.push(createSuccessResult());

      const checkpoints: { turn: number; partialResult: string }[] = [];
      const orchestrator = new Orchestrator(
        {
          checkpointEveryNTurns: 3,
          onCheckpoint: async (data) => {
            checkpoints.push({ turn: data.turn, partialResult: data.partialResult });
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      await orchestrator.runMission('Checkpoint test');

      expect(checkpoints.map((c) => c.turn)).toEqual([3, 6, 9, 12]);
      // Every checkpoint accumulates prior turn text — turn 6 must include
      // turn 1..6 text; turn 12 must include all 12.
      expect(checkpoints[0].partialResult).toContain('turn-1 content');
      expect(checkpoints[0].partialResult).toContain('turn-3 content');
      expect(checkpoints[0].partialResult).not.toContain('turn-4 content');
      expect(checkpoints[3].partialResult).toContain('turn-12 content');
    });

    it('should include tool-use markers in the checkpoint accumulator', async () => {
      // An agent that does a tool call on turn 1, another on turn 2, then a
      // result. No text blocks at all ("silent agent" pattern). The
      // accumulator should still contain tool-call markers so the checkpoint
      // isn't empty.
      const toolCallMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'tool_use', id: `tool-${n}`, name: 'exa_search', input: { query: `q${n}` } }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [];
      for (let i = 1; i <= 6; i++) msgs.push(toolCallMsg(i));
      msgs.push(createSuccessResult());

      const checkpoints: { turn: number; partialResult: string }[] = [];
      const orchestrator = new Orchestrator(
        {
          checkpointEveryNTurns: 3,
          onCheckpoint: async (data) => {
            checkpoints.push(data);
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      await orchestrator.runMission('Silent agent test');

      // Checkpoint at turn 3 should exist with non-empty content (tool markers)
      expect(checkpoints.length).toBeGreaterThan(0);
      expect(checkpoints[0].partialResult).toContain('[tool-call]');
      expect(checkpoints[0].partialResult).toContain('exa_search');
    });

    it('should skip checkpoint write when delta below threshold', async () => {
      // Create 6 assistant messages with tiny text blocks (under 40 chars each)
      // and checkpoint every 3 turns. First checkpoint at turn 3 should fire;
      // second at turn 6 should be skipped because the delta is only ~30 bytes
      // (tiny text * 3 turns < 200B threshold).
      const tinyMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `t${n}` }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 2 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [];
      for (let i = 1; i <= 6; i++) msgs.push(tinyMsg(i));
      msgs.push(createSuccessResult());

      const checkpoints: { turn: number; partialResult: string }[] = [];
      const orchestrator = new Orchestrator(
        {
          checkpointEveryNTurns: 3,
          onCheckpoint: async (data) => {
            checkpoints.push(data);
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      await orchestrator.runMission('Tiny delta test');

      // Turn 3 should fire (first checkpoint passes; delta = total > 200B? no —
      // total is ~16 bytes). Actually for the FIRST checkpoint, delta is
      // partial.length - 0 = 16 < 200 → skipped. So 0 checkpoints.
      expect(checkpoints.length).toBe(0);
    });

    it('should keep firing checkpoints when accumulated text exceeds 200KB', async () => {
      // Regression test for C3: once accumulatedText.join('\n\n').length exceeds
      // 200KB, the .slice(-200_000) cap pinned partial.length to 200000, so
      // delta = partial.length - lastCheckpointBytes settled to 0 forever and
      // every subsequent checkpoint was skipped. The longest, most expensive
      // missions (large reports) got NO checkpoints past the 200KB mark.
      //
      // 6 turns × 50KB each = 300KB cumulative. The slice cap kicks in at
      // turn 5; the buggy version stops firing at turn 5; the fix keeps
      // firing on every turn.
      const FIFTY_KB = 50_000;
      const bigMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `t${n}-` + 'x'.repeat(FIFTY_KB) }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [];
      for (let i = 1; i <= 6; i++) msgs.push(bigMsg(i));
      msgs.push(createSuccessResult());

      const checkpoints: { turn: number; partialResult: string }[] = [];
      const orchestrator = new Orchestrator(
        {
          checkpointEveryNTurns: 1,
          onCheckpoint: async (data) => {
            checkpoints.push({ turn: data.turn, partialResult: data.partialResult });
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      await orchestrator.runMission('Large output test');

      // All 6 turns should have a checkpoint — none should be skipped after
      // the slice cap engages.
      expect(checkpoints.map((c) => c.turn)).toEqual([1, 2, 3, 4, 5, 6]);
      // Payload stays bounded at 200KB even when total accumulated exceeds it.
      expect(checkpoints[5].partialResult.length).toBeLessThanOrEqual(200_000);
      // Latest checkpoint should contain the most recent turn's marker.
      expect(checkpoints[5].partialResult).toContain('t6-');
    });

    it('getAccumulatedPartial should expose current snapshot', async () => {
      const textMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `content-${n}` }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [textMsg(1), textMsg(2), textMsg(3), createSuccessResult()];
      const orchestrator = new Orchestrator({}, createMockDeps({ queryFn: () => createMockGenerator(msgs) }));

      await orchestrator.runMission('Getter test');

      const snap = orchestrator.getAccumulatedPartial();
      expect(snap.turn).toBe(3);
      expect(snap.partialResult).toContain('content-1');
      expect(snap.partialResult).toContain('content-3');
    });

    // MISSION-001 — honest in-flight/timeout spend telemetry
    const usageTurn = (n: number, input: number, output: number): SDKMessage =>
      ({
        type: 'assistant',
        message: {
          id: `u-${n}`,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: `turn-${n}` }],
          model: 'claude-sonnet-4-6',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: input, output_tokens: output },
        },
        parent_tool_use_id: null,
        uuid: `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}` as `${string}-${string}-${string}-${string}-${string}`,
        session_id: 'test-session',
      }) as SDKMessage;

    it('getUsageSnapshot exposes real cumulative cost + input/output token split', async () => {
      const msgs: SDKMessage[] = [usageTurn(1, 100, 50), usageTurn(2, 100, 50), createSuccessResult()];
      const orchestrator = new Orchestrator({}, createMockDeps({ queryFn: () => createMockGenerator(msgs) }));

      await orchestrator.runMission('Snapshot test');

      const snap = orchestrator.getUsageSnapshot();
      expect(snap.tokenUsage).toEqual({ input: 200, output: 100 });
      expect(snap.costUsd).toBeGreaterThan(0);
    });

    it('marks the in-flight cost snapshot unavailable (null) after an unpriceable turn (TEST-021)', async () => {
      // A turn produced by an unknown model cannot be priced. Rather than a
      // partial lower bound that silently omits the turn, the running snapshot
      // reports costUsd null + a reason, while token counters stay truthful.
      const base = usageTurn(1, 100, 50) as SDKMessage & { message: { model: string } };
      base.message.model = 'made-up-model-x';
      const msgs: SDKMessage[] = [base, createSuccessResult()];
      const orchestrator = new Orchestrator({}, createMockDeps({ queryFn: () => createMockGenerator(msgs) }));

      await orchestrator.runMission('Unpriceable turn');

      const snap = orchestrator.getUsageSnapshot();
      expect(snap.tokenUsage).toEqual({ input: 100, output: 50 }); // tokens still counted
      expect(snap.costUsd).toBeNull();
      expect(snap.costUnavailableReason).toMatch(/made-up-model-x/);
    });

    it('fires onUsage once per assistant turn with monotonically growing spend', async () => {
      const seenInput: number[] = [];
      // TEST-021: costUsd is number | null (null once a turn is unpriceable).
      // These turns are all priceable, so every published cost must be a real
      // number — assert that explicitly before comparing magnitudes.
      const seenCost: Array<number | null> = [];
      const msgs: SDKMessage[] = [usageTurn(1, 100, 50), usageTurn(2, 100, 50), createSuccessResult()];
      const orchestrator = new Orchestrator(
        {
          onUsage: (u) => {
            seenInput.push(u.tokenUsage.input);
            seenCost.push(u.costUsd);
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      await orchestrator.runMission('onUsage test');

      expect(seenInput).toEqual([100, 200]); // cumulative after turn 1, then turn 2
      expect(seenCost[0]).not.toBeNull();
      expect(seenCost[1]).not.toBeNull();
      expect(seenCost[1] as number).toBeGreaterThan(seenCost[0] as number); // spend only grows
    });

    it('resets the usage snapshot between missions (no cross-run leak)', async () => {
      const orchestrator = new Orchestrator(
        {},
        createMockDeps({
          queryFn: () => createMockGenerator([usageTurn(1, 100, 50), usageTurn(2, 100, 50), createSuccessResult()]),
        })
      );
      await orchestrator.runMission('first');
      expect(orchestrator.getUsageSnapshot().tokenUsage.input).toBe(200);

      // Second run with a different deps generator carrying a smaller turn.
      const o2 = new Orchestrator(
        {},
        createMockDeps({ queryFn: () => createMockGenerator([usageTurn(1, 30, 10), createSuccessResult()]) })
      );
      await o2.runMission('second');
      expect(o2.getUsageSnapshot().tokenUsage.input).toBe(30); // not 230
    });

    it('abort() is a no-op (does not throw) when no mission is running', () => {
      const orchestrator = new Orchestrator({}, createMockDeps());
      expect(() => orchestrator.abort('idle abort')).not.toThrow();
    });

    it('should swallow onCheckpoint errors without aborting the mission', async () => {
      const makeAssistantMsg = (n: number): SDKMessage =>
        ({
          type: 'assistant',
          message: {
            id: `msg-${n}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: `turn-${n}` }],
            model: 'claude-sonnet-4-6',
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          },
          parent_tool_use_id: null,
          uuid: `00000000-0000-0000-0000-00000000000${n}` as `${string}-${string}-${string}-${string}-${string}`,
          session_id: 'test-session',
        }) as SDKMessage;

      const msgs: SDKMessage[] = [makeAssistantMsg(1), makeAssistantMsg(2), createSuccessResult()];

      const orchestrator = new Orchestrator(
        {
          checkpointEveryNTurns: 2,
          onCheckpoint: async () => {
            throw new Error('simulated firestore outage');
          },
        },
        createMockDeps({ queryFn: () => createMockGenerator(msgs) })
      );

      // Mission must still complete — checkpoint errors are best-effort only.
      const result = await orchestrator.runMission('Checkpoint error test');
      expect(result.success).toBe(true);
    });

    it('should use orchestrator model from config.models', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('Check model');

      expect(capturedParams?.options?.model).toBe('claude-sonnet-4-6');
    });

    it('should use custom permissionMode when provided', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator({ permissionMode: 'dontAsk' }, deps);
      await orchestrator.runMission('Custom permission test');

      expect(capturedParams?.options?.permissionMode).toBe('dontAsk');
      expect(capturedParams?.options?.allowDangerouslySkipPermissions).toBe(false);
    });

    it('should pass maxBudgetUsd when provided', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator({ maxBudgetUsd: 2.5 }, deps);
      await orchestrator.runMission('Budget test');

      expect(capturedParams?.options?.maxBudgetUsd).toBe(2.5);
    });

    it('should forward hooks to SDK query() when provided', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const mockHooks = {
        PreToolUse: [{ hooks: [jest.fn()] }],
        PostToolUse: [{ hooks: [jest.fn()] }],
      };

      const orchestrator = new Orchestrator({ hooks: mockHooks }, deps);
      await orchestrator.runMission('Hooks test');

      // SEC-014: caller hooks are preserved but no longer replace the hook map —
      // the orchestrator prepends its own default-deny capability hook so the
      // boundary holds whatever the caller passes.
      const hooks = capturedParams?.options?.hooks as Record<string, Array<{ hooks: unknown[] }>>;
      expect(hooks.PreToolUse).toHaveLength(2);
      expect(hooks.PreToolUse[1]).toBe(mockHooks.PreToolUse[0]);
      expect(hooks.PostToolUse).toEqual(mockHooks.PostToolUse);
    });

    it('should not include hooks key in query options when no hooks provided', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('No hooks test');

      // SEC-014: the capability hook is ALWAYS installed. Pre-fix the key was
      // omitted entirely when the caller passed no hooks, which is exactly how a
      // worker omission left a mission running with no enforced boundary.
      expect(capturedParams?.options).toBeDefined();
      const hooks = capturedParams?.options?.hooks as Record<string, Array<{ hooks: unknown[] }>>;
      expect(hooks).toBeDefined();
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(typeof hooks.PreToolUse[0].hooks[0]).toBe('function');
    });

    it('should fall back to claude-sonnet-4-6 when orchestrator model not in config', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;

      const configWithoutOrchModel: AgentConfig = {
        ...MOCK_CONFIG,
        models: { analysis: 'claude-sonnet-4-6' },
      };

      const deps = createMockDeps({
        loadConfig: () => configWithoutOrchModel,
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('Fallback model test');

      expect(capturedParams?.options?.model).toBe('claude-sonnet-4-6');
    });

    it('should pass fallbackModel defaulting to claude-haiku-4-5', async () => {
      // P3 resilience: query() should always carry a fallbackModel so the SDK
      // can transparently retry when the primary model fails/is unavailable.
      const originalFallback = process.env.IMPULSE_AGENT_FALLBACK_MODEL;
      delete process.env.IMPULSE_AGENT_FALLBACK_MODEL;
      try {
        let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
        const deps = createMockDeps({
          queryFn: (params) => {
            capturedParams = params;
            return createMockGenerator([createSuccessResult()]);
          },
        });

        const orchestrator = new Orchestrator(undefined, deps);
        await orchestrator.runMission('Fallback default test');

        expect(capturedParams?.options?.fallbackModel).toBe('claude-haiku-4-5');
      } finally {
        if (originalFallback === undefined) delete process.env.IMPULSE_AGENT_FALLBACK_MODEL;
        else process.env.IMPULSE_AGENT_FALLBACK_MODEL = originalFallback;
      }
    });

    it('should let IMPULSE_AGENT_FALLBACK_MODEL override the fallbackModel default', async () => {
      const originalFallback = process.env.IMPULSE_AGENT_FALLBACK_MODEL;
      // COORD-019: this case previously used `claude-sonnet-4-6`, which is ALSO
      // this orchestrator's model — a pair the SDK refuses outright while
      // building the CLI argv. The assertion therefore encoded a configuration
      // that could never have dispatched in production. It now overrides with a
      // model distinct from both the main model and the haiku default, so it
      // still proves the env override without asserting a dead run.
      process.env.IMPULSE_AGENT_FALLBACK_MODEL = 'claude-sonnet-4-5';
      try {
        let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
        const deps = createMockDeps({
          queryFn: (params) => {
            capturedParams = params;
            return createMockGenerator([createSuccessResult()]);
          },
        });

        const orchestrator = new Orchestrator(undefined, deps);
        await orchestrator.runMission('Fallback override test');

        expect(capturedParams?.options?.fallbackModel).toBe('claude-sonnet-4-5');
      } finally {
        if (originalFallback === undefined) delete process.env.IMPULSE_AGENT_FALLBACK_MODEL;
        else process.env.IMPULSE_AGENT_FALLBACK_MODEL = originalFallback;
      }
    });
  });

  describe('budget preamble', () => {
    it('should prepend budget context to prompt when maxBudgetUsd is set', async () => {
      let capturedPrompt = '';

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedPrompt = params.prompt;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator({ maxBudgetUsd: 1.5 }, deps);
      await orchestrator.runMission('Discover AI signals');

      expect(capturedPrompt).toContain('BUDGET: You have $1.50 for this mission.');
      expect(capturedPrompt).toContain('Current spend: $0.00');
      expect(capturedPrompt).toContain('Plan your work to complete within budget');
      expect(capturedPrompt).toContain('Discover AI signals');
    });

    it('should not include budget preamble when maxBudgetUsd is not set', async () => {
      let capturedPrompt = '';

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedPrompt = params.prompt;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('Discover AI signals');

      expect(capturedPrompt).not.toContain('BUDGET:');
    });

    it('should include permission map in preamble', async () => {
      let capturedPrompt = '';

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedPrompt = params.prompt;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('Test permission map');

      expect(capturedPrompt).toContain('YOUR AVAILABLE MCP SERVERS:');
      // Scout profile servers should be listed
      expect(capturedPrompt).toContain('scout:');
      expect(capturedPrompt).toContain('impulse-entities');
      expect(capturedPrompt).toContain('Do NOT attempt tools from servers not listed for the active agent.');
    });

    it('should include orchestrator rules in preamble', async () => {
      let capturedPrompt = '';

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedPrompt = params.prompt;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(undefined, deps);
      await orchestrator.runMission('Test orchestrator rules');

      expect(capturedPrompt).toContain('ORCHESTRATOR RULES:');
      expect(capturedPrompt).toContain('ONE agent writes at a time');
    });

    it('preserves requested procedures as formal Creator skill work', async () => {
      let capturedPrompt = '';
      const deps = createMockDeps({
        queryFn: (params) => {
          capturedPrompt = params.prompt;
          return createMockGenerator([createSuccessResult()]);
        },
      });
      const orchestrator = new Orchestrator({ missionId: 'mission-skill-1', slots: [{ name: 'main' }] }, deps);

      await orchestrator.runMission('Create an IEEE-cited visual report.');

      expect(capturedPrompt).toContain('Preserve the mission request and its CRITICAL DIMENSIONS verbatim');
      expect(capturedPrompt).toContain('invoke the matching built-in Skill tool');
      expect(capturedPrompt).toContain('marker-shaped prose without a formal Skill call is not completion');
    });

    it('should always include the separator and original prompt after preamble', async () => {
      let capturedPrompt = '';
      const originalPrompt = 'My special mission instructions go here';

      const deps = createMockDeps({
        queryFn: (params) => {
          capturedPrompt = params.prompt;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator({ maxBudgetUsd: 0.5 }, deps);
      await orchestrator.runMission(originalPrompt);

      // Separator must appear between preamble and original prompt
      expect(capturedPrompt).toContain('---\n' + originalPrompt);
    });
  });

  describe('model mapping', () => {
    it('passes an exact Sonnet id through unchanged', () => {
      const profiles = new Map<string, AgentProfile>([
        [
          'test-agent',
          {
            name: 'test-agent',
            description: 'Test',
            prompt: '# Test',
            model: 'claude-sonnet-4-6',
            budget: { max_tokens: 1000, max_tool_calls: 10 },
            mcp_servers: { internal: ['test-server'], external: [] },
          },
        ],
      ]);

      const deps = createMockDeps({ loadProfiles: () => profiles });
      const orchestrator = new Orchestrator(undefined, deps);
      expect(orchestrator.getAgentDefinitions()['test-agent']?.model).toBe('claude-sonnet-4-6');
    });

    it('passes an exact Opus id through unchanged', () => {
      const profiles = new Map<string, AgentProfile>([
        [
          'test-agent',
          {
            name: 'test-agent',
            description: 'Test',
            prompt: '# Test',
            model: 'claude-opus-4-8',
            budget: { max_tokens: 1000, max_tool_calls: 10 },
            mcp_servers: { internal: ['test-server'], external: [] },
          },
        ],
      ]);

      const deps = createMockDeps({ loadProfiles: () => profiles });
      const orchestrator = new Orchestrator(undefined, deps);
      expect(orchestrator.getAgentDefinitions()['test-agent']?.model).toBe('claude-opus-4-8');
    });

    it('passes another exact Opus id through unchanged', () => {
      const profiles = new Map<string, AgentProfile>([
        [
          'test-agent',
          {
            name: 'test-agent',
            description: 'Test',
            prompt: '# Test',
            model: 'claude-opus-4-6',
            budget: { max_tokens: 1000, max_tool_calls: 10 },
            mcp_servers: { internal: ['test-server'], external: [] },
          },
        ],
      ]);

      const deps = createMockDeps({ loadProfiles: () => profiles });
      const orchestrator = new Orchestrator(undefined, deps);
      expect(orchestrator.getAgentDefinitions()['test-agent']?.model).toBe('claude-opus-4-6');
    });

    it('passes a dated Haiku id through unchanged', () => {
      const profiles = new Map<string, AgentProfile>([
        [
          'test-agent',
          {
            name: 'test-agent',
            description: 'Test',
            prompt: '# Test',
            model: 'claude-haiku-4-5-20250801',
            budget: { max_tokens: 1000, max_tool_calls: 10 },
            mcp_servers: { internal: ['test-server'], external: [] },
          },
        ],
      ]);

      const deps = createMockDeps({ loadProfiles: () => profiles });
      const orchestrator = new Orchestrator(undefined, deps);
      expect(orchestrator.getAgentDefinitions()['test-agent']?.model).toBe('claude-haiku-4-5-20250801');
    });

    it('records an unservable gemini id as a placeholder the pre-spend gate refuses', () => {
      const profiles = new Map<string, AgentProfile>([
        [
          'test-agent',
          {
            name: 'test-agent',
            description: 'Test',
            prompt: '# Test',
            model: 'gemini-2.5-flash',
            budget: { max_tokens: 1000, max_tool_calls: 10 },
            mcp_servers: { internal: ['test-server'], external: [] },
          },
        ],
      ]);

      const deps = createMockDeps({ loadProfiles: () => profiles });
      const orchestrator = new Orchestrator(undefined, deps);
      expect(orchestrator.getAgentDefinitions()['test-agent']?.model).toBe('inherit');
    });

    it('records an unknown id as a placeholder the pre-spend gate refuses', () => {
      const profiles = new Map<string, AgentProfile>([
        [
          'test-agent',
          {
            name: 'test-agent',
            description: 'Test',
            prompt: '# Test',
            model: 'gpt-4o',
            budget: { max_tokens: 1000, max_tool_calls: 10 },
            mcp_servers: { internal: ['test-server'], external: [] },
          },
        ],
      ]);

      const deps = createMockDeps({ loadProfiles: () => profiles });
      const orchestrator = new Orchestrator(undefined, deps);
      expect(orchestrator.getAgentDefinitions()['test-agent']?.model).toBe('inherit');
    });
  });
});

// ---------------------------------------------------------------------------
// discoverRuntimeSkills — strict product-owned plugin isolation.
// ---------------------------------------------------------------------------

describe('discoverRuntimeSkills', () => {
  /** Create a local plugin with one SKILL.md per requested name. */
  function makeSkillsRoot(skillNames: readonly string[] = RUNTIME_SKILL_NAMES): string {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-test-'));
    const manifestDir = path.join(tmpDir, '.claude-plugin');
    const skillsDir = path.join(tmpDir, 'skills');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(
      path.join(manifestDir, 'plugin.json'),
      JSON.stringify({
        name: 'radarist-analytical-skills',
        description: 'Product-owned analytical methods available to Radarist mission and chat agents',
        version: '0.1.0',
      })
    );
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const name of skillNames) {
      const dir = path.join(skillsDir, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\n# ${name}\n`);
    }
    return tmpDir;
  }

  it('rejects any skill name outside the approved product allowlist', () => {
    const tmpDir = makeSkillsRoot([...RUNTIME_SKILL_NAMES, 'not-approved-runtime-skill']);

    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime skill names do not match the approved v0.1 contract');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed on a directory without SKILL.md', () => {
    const tmpDir = makeSkillsRoot();
    fs.rmSync(path.join(tmpDir, 'skills', RUNTIME_SKILL_NAMES[0], 'SKILL.md'));

    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime skill contains an undeclared file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the plugin manifest is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-test-'));

    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime plugin contains an undeclared surface');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects hooks, agents, commands, and every other undeclared plugin surface', () => {
    const tmpDir = makeSkillsRoot();
    fs.mkdirSync(path.join(tmpDir, 'hooks'));
    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime plugin contains an undeclared surface');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects unapproved plugin metadata instead of accepting a renamed release surface', () => {
    const tmpDir = makeSkillsRoot();
    fs.writeFileSync(
      path.join(tmpDir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'radarist-analytical-skills',
        description: 'Different product contract',
        version: '0.2.0',
      })
    );
    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow(
        'Runtime skill plugin manifest metadata does not match the approved v0.1 contract'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns a sorted, name-validated product skill list', () => {
    const tmpDir = makeSkillsRoot();
    try {
      expect(discoverRuntimeSkills(tmpDir)).toEqual([...RUNTIME_SKILL_NAMES].sort());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('fails closed when the directory and frontmatter names differ', () => {
    const tmpDir = makeSkillsRoot();
    fs.writeFileSync(
      path.join(tmpDir, 'skills', 'grounded-answer', 'SKILL.md'),
      '---\nname: another-skill\n---\n# Wrong\n'
    );
    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime skill name mismatch');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects body-only metadata without leading frontmatter', () => {
    const tmpDir = makeSkillsRoot();
    fs.writeFileSync(
      path.join(tmpDir, 'skills', RUNTIME_SKILL_NAMES[0], 'SKILL.md'),
      `name: ${RUNTIME_SKILL_NAMES[0]}\ndescription: Not frontmatter\n`
    );
    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime skill is missing leading YAML frontmatter');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a product skill without a description', () => {
    const tmpDir = makeSkillsRoot();
    fs.writeFileSync(
      path.join(tmpDir, 'skills', RUNTIME_SKILL_NAMES[0], 'SKILL.md'),
      `---\nname: ${RUNTIME_SKILL_NAMES[0]}\n---\n# Missing description\n`
    );
    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime skill is missing a description');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked skills root', () => {
    const tmpDir = makeSkillsRoot();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-skills-external-'));
    fs.rmSync(path.join(tmpDir, 'skills'), { recursive: true, force: true });
    fs.symlinkSync(external, path.join(tmpDir, 'skills'));
    try {
      expect(() => discoverRuntimeSkills(tmpDir)).toThrow('Runtime skills directory must be a real directory');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(external, { recursive: true, force: true });
    }
  });

  it('loads the exact approved repository plugin surface', () => {
    expect(discoverRuntimeSkills()).toEqual([...RUNTIME_SKILL_NAMES].sort());
  });
});

describe('OSS-014 runtime customization isolation', () => {
  it('uses only the product plugin for mission and specialist skills', async () => {
    let captured: { prompt: string; options?: Record<string, unknown> } | undefined;
    const orchestrator = new Orchestrator(
      {},
      createMockDeps({
        queryFn: (params) => {
          captured = params;
          return createMockGenerator([createSuccessResult()]);
        },
      })
    );

    await orchestrator.runMission('Use an analytical method.');

    const options = captured?.options;
    expect(options?.settingSources).toEqual([]);
    expect(options?.plugins).toEqual([
      expect.objectContaining({ type: 'local', path: expect.stringMatching(/agent[/\\](?:dist[/\\])?runtime-plugin$/) }),
    ]);
    expect(options?.skills).toHaveLength(56);
    expect(options?.skills).toEqual([...RUNTIME_SKILL_NAMES].sort());
    const definitions = options?.agents as Record<string, AgentDefinition>;
    for (const definition of Object.values(definitions)) {
      expect(definition.skills).toEqual(options?.skills);
    }
  });

  it('uses the same isolated product plugin for chat', async () => {
    let captured: { prompt: string; options?: Record<string, unknown> } | undefined;
    const orchestrator = new Orchestrator(
      {},
      createMockDeps({
        queryFn: (params) => {
          captured = params;
          return createMockGenerator([createSuccessResult()]);
        },
      })
    );

    for await (const _message of orchestrator.streamChat({ prompt: 'Analyze this signal.' })) {
      // drain
    }

    expect(captured?.options?.settingSources).toEqual([]);
    expect(captured?.options?.plugins).toEqual([
      expect.objectContaining({ type: 'local', path: expect.stringContaining('runtime-plugin') }),
    ]);
    expect(captured?.options?.skills).toHaveLength(56);
  });
});

// ---------------------------------------------------------------------------
// resolveOrchestratorEnv — explicit env allowlist for the SDK subprocess (#31)
// The full host env must NEVER cross into the subprocess or its stdio-MCP
// children; only ANTHROPIC_*/CLAUDE_* + OS/proxy/TLS + declared MCP creds pass.
// ---------------------------------------------------------------------------

describe('resolveOrchestratorEnv', () => {
  it('passes ANTHROPIC_*/CLAUDE_* SDK knobs and OS/MCP essentials', () => {
    const env = resolveOrchestratorEnv({
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_BASE_URL: 'https://api.example',
      CLAUDE_CONFIG_DIR: '/home/u/.claude',
      PATH: '/usr/bin:/bin',
      HOME: '/home/u',
      NEO4J_URI: 'bolt://localhost:7687',
      NEO4J_USERNAME: 'neo4j',
      NEO4J_PASSWORD: 'secret',
      EXA_API_KEY: 'exa-123',
      FIRECRAWL_API_KEY: 'fc-123',
      GOOGLE_API_KEY: 'g-123',
      IMPULSE_API_KEY: 'imp-123',
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    });

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/home/u/.claude');
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/u');
    expect(env.NEO4J_URI).toBe('bolt://localhost:7687');
    expect(env.NEO4J_USERNAME).toBe('neo4j');
    expect(env.NEO4J_PASSWORD).toBe('secret');
    expect(env.EXA_API_KEY).toBe('exa-123');
    expect(env.FIRECRAWL_API_KEY).toBe('fc-123');
    expect(env.GOOGLE_API_KEY).toBe('g-123');
    expect(env.IMPULSE_API_KEY).toBe('imp-123');
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('/etc/ca.pem');
  });

  it('drops host secrets not on the allowlist', () => {
    const env = resolveOrchestratorEnv({
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      PATH: '/usr/bin',
      // These MUST be stripped — they leaked into third-party MCP children before.
      GOOGLE_APPLICATION_CREDENTIALS: '/secrets/firebase-admin.json',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----',
      GEMINI_API_KEY: 'gemini-secret',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      OPENAI_API_KEY: 'oai-secret',
      SOME_RANDOM_TOKEN: 'nope',
    });

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-xxx');
    expect(env).not.toHaveProperty('GOOGLE_APPLICATION_CREDENTIALS');
    expect(env).not.toHaveProperty('FIREBASE_PRIVATE_KEY');
    expect(env).not.toHaveProperty('GEMINI_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('SOME_RANDOM_TOKEN');
  });

  it('always sets CLAUDE_CODE_MAX_OUTPUT_TOKENS, defaulting to 128000', () => {
    expect(resolveOrchestratorEnv({}).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('128000');
    expect(resolveOrchestratorEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(
      '64000'
    );
  });

  it('omits undefined values rather than emitting empty strings', () => {
    const env = resolveOrchestratorEnv({ ANTHROPIC_API_KEY: undefined, PATH: '/usr/bin' });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.PATH).toBe('/usr/bin');
  });
});

// ---------------------------------------------------------------------------
// REPORT-006 — publish-result prompt contract
// ---------------------------------------------------------------------------

describe('publish-result prompt contract (REPORT-006)', () => {
  async function composeMissionPrompt(): Promise<{
    prompt: string;
    agents: Record<string, AgentDefinition>;
  }> {
    let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
    const deps = createMockDeps({
      queryFn: (params) => {
        capturedParams = params;
        return createMockGenerator([createSuccessResult()]);
      },
    });
    const orchestrator = new Orchestrator(
      { missionId: 'mission-report-006', slots: [{ name: 'main', intent: 'test' }] },
      deps
    );
    await orchestrator.runMission('Produce the quarterly landscape report');
    return {
      prompt: capturedParams!.prompt,
      agents: capturedParams!.options!.agents as Record<string, AgentDefinition>,
    };
  }

  it('the orchestrator preamble promises the REAL publish result and the private reportUrl', async () => {
    const { prompt } = await composeMissionPrompt();
    expect(prompt).toContain('{success:true, data:{reportId, reportUrl, isUpsert}}');
    expect(prompt).toContain('data.reportUrl');
    expect(prompt).toContain('/reports/{id}');
    // Stop-after-publish preserved.
    expect(prompt).toContain('THIS TURN IS COMPLETE');
    expect(prompt).toContain('Do not call ANY more tools');
    // Share links only after persisted shared:true — never invented at publish.
    expect(prompt).toContain('shared:true');
    expect(prompt).toContain('NEVER output or invent a /share/report/');
    // The stale field name is gone everywhere in the composed prompt.
    expect(prompt).not.toContain('shareUrl');
  });

  it('every subagent mission-context block (initial AND revision turns share this builder) carries the same contract', async () => {
    const { agents } = await composeMissionPrompt();
    const names = Object.keys(agents);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const agentPrompt = agents[name].prompt;
      expect(agentPrompt).toContain('{success:true, data:{reportId, reportUrl, isUpsert}}');
      expect(agentPrompt).toContain('data.reportUrl');
      expect(agentPrompt).toContain('THIS TURN IS COMPLETE');
      expect(agentPrompt).toContain('NEVER output or invent a /share/report/');
      expect(agentPrompt).not.toContain('shareUrl');
    }
  });

  describe('report authoring mode contract', () => {
    afterEach(() => {
      delete process.env.REPORT_COMPOSER_MODE;
    });

    it('defaults the orchestrator and every mission subagent to HTML on the first draft attempt', async () => {
      delete process.env.REPORT_COMPOSER_MODE;

      const { prompt, agents } = await composeMissionPrompt();

      expect(prompt).toContain('REPORT AUTHORING MODE: legacy');
      expect(prompt).toContain('draftReport({ slotName, html })');
      expect(prompt).toContain('blocks are rejected');
      for (const agent of Object.values(agents)) {
        expect(agent.prompt).toContain('REPORT AUTHORING MODE: legacy');
        expect(agent.prompt).toContain('draftReport({ slotName, html })');
      }
    });

    it('instructs the orchestrator and every mission subagent to use blocks only when template mode is explicit', async () => {
      process.env.REPORT_COMPOSER_MODE = 'template';

      const { prompt, agents } = await composeMissionPrompt();

      expect(prompt).toContain('REPORT AUTHORING MODE: template');
      expect(prompt).toContain('draftReport({ slotName, blocks })');
      for (const agent of Object.values(agents)) {
        expect(agent.prompt).toContain('REPORT AUTHORING MODE: template');
        expect(agent.prompt).toContain('draftReport({ slotName, blocks })');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-013 — the internal MCP key must never reach the SDK transport config
// ---------------------------------------------------------------------------
//
// The SDK serialises `options.mcpServers` into `--mcp-config <json>` on the CLI
// child's command line, and the CLI persists transport options into its session
// JSONL. Anything placed in `headers` therefore lands in `ps` output and in a
// cache broad support bundles collect. These tests pin the mitigation: the
// header carries a `${VAR}` reference the CLI resolves from its own env, so the
// plaintext exists only inside this process.

describe('SEC-013 MCP transport secrecy', () => {
  const LIVE_KEY = 'synthetic-internal-key-1234567890';
  const ORIGINAL_INTERNAL = process.env.IMPULSE_INTERNAL_KEY;
  const ORIGINAL_API = process.env.IMPULSE_API_KEY;

  afterEach(() => {
    if (ORIGINAL_INTERNAL === undefined) delete process.env.IMPULSE_INTERNAL_KEY;
    else process.env.IMPULSE_INTERNAL_KEY = ORIGINAL_INTERNAL;
    if (ORIGINAL_API === undefined) delete process.env.IMPULSE_API_KEY;
    else process.env.IMPULSE_API_KEY = ORIGINAL_API;
  });

  it('emits ${IMPULSE_INTERNAL_KEY} instead of the value when the env backs the key', () => {
    process.env.IMPULSE_INTERNAL_KEY = LIVE_KEY;
    const orchestrator = new Orchestrator({ apiKey: LIVE_KEY }, createMockDeps());
    const configs = orchestrator.getMcpServerConfigs();
    const entities = configs['impulse-entities'] as McpHttpServerConfig;
    expect(entities.headers?.['x-api-key']).toBe('${IMPULSE_INTERNAL_KEY}');
    // The serialised form is what reaches `--mcp-config`; the key must not be in it.
    expect(JSON.stringify(configs)).not.toContain(LIVE_KEY);
  });

  it('falls back to IMPULSE_API_KEY when that is the backing variable (standalone CLI)', () => {
    delete process.env.IMPULSE_INTERNAL_KEY;
    process.env.IMPULSE_API_KEY = LIVE_KEY;
    const orchestrator = new Orchestrator({ apiKey: LIVE_KEY }, createMockDeps());
    const entities = orchestrator.getMcpServerConfigs()['impulse-entities'] as McpHttpServerConfig;
    expect(entities.headers?.['x-api-key']).toBe('${IMPULSE_API_KEY}');
  });

  it('injects a child-only variable when no forwarded host variable holds the key', () => {
    delete process.env.IMPULSE_INTERNAL_KEY;
    delete process.env.IMPULSE_API_KEY;
    const orchestrator = new Orchestrator({ apiKey: 'unbacked-key-value' }, createMockDeps());
    const entities = orchestrator.getMcpServerConfigs()['impulse-entities'] as McpHttpServerConfig;
    expect(entities.headers?.['x-api-key']).toBe('${RADARIST_MCP_AUTH_KEY}');
    expect(JSON.stringify(orchestrator.getMcpServerConfigs())).not.toContain('unbacked-key-value');
  });

  it('the backing variable is one the SDK subprocess actually receives', () => {
    // A reference is only resolvable if `resolveOrchestratorEnv` forwards it.
    process.env.IMPULSE_INTERNAL_KEY = LIVE_KEY;
    const env = resolveOrchestratorEnv();
    expect(env.IMPULSE_INTERNAL_KEY).toBe(LIVE_KEY);
  });

  it('forwards an explicitly referenced external MCP variable without widening the allowlist', () => {
    const host = { CUSTOM_READER_TOKEN: LIVE_KEY } as NodeJS.ProcessEnv;
    expect(resolveOrchestratorEnv(host, ['CUSTOM_READER_TOKEN']).CUSTOM_READER_TOKEN).toBe(LIVE_KEY);
    expect(resolveOrchestratorEnv(host).CUSTOM_READER_TOKEN).toBeUndefined();
  });

  it('detects literal and unresolvable transport credentials without echoing values', () => {
    expect(
      auditMcpCredentialContainment(
        { exa: { type: 'stdio', command: 'npx', args: [], env: { EXA_API_KEY: LIVE_KEY } } },
        {},
        {} as NodeJS.ProcessEnv
      )
    ).toEqual([{ location: 'exa.EXA_API_KEY', reason: 'literal-credential' }]);
    const violations = auditMcpCredentialContainment(
      { exa: { type: 'stdio', command: 'npx', args: [], env: { EXA_API_KEY: '${EXA_API_KEY}' } } },
      {},
      {} as NodeJS.ProcessEnv
    );
    const error = new McpCredentialContainmentError(violations);
    expect(error.failureKind).toBe('mcp-credential-containment-failed');
    expect(error.message).not.toContain(LIVE_KEY);
  });

  it('refuses a literal stdio credential before provider work', async () => {
    const queryFn = jest.fn(() => createMockGenerator([createSuccessResult()]));
    const deps = createMockDeps({
      queryFn,
      loadConfig: () => ({
        ...MOCK_CONFIG,
        externalMcpServers: {
          ...MOCK_EXTERNAL_MCP,
          'neo4j-memory': {
            transport: 'stdio',
            command: 'uvx',
            args: ['mcp-neo4j-memory'],
            env: { NEO4J_PASSWORD: LIVE_KEY },
          },
        },
      }),
    });
    const result = await new Orchestrator({}, deps).runMission('Credential containment');

    expect(queryFn).not.toHaveBeenCalled();
    expect(result.failureKind).toBe('mcp-credential-containment-failed');
    expect(JSON.stringify(result)).not.toContain(LIVE_KEY);
  });

  it('expands the placeholder for the orchestrator’s OWN in-process probe', () => {
    // checkMcpHealth runs here, not in the CLI, so it must send the real value.
    expect(
      expandMcpHeaderPlaceholders({ 'x-api-key': '${IMPULSE_INTERNAL_KEY}', 'x-mission-id': 'm-1' }, {
        IMPULSE_INTERNAL_KEY: LIVE_KEY,
      } as NodeJS.ProcessEnv)
    ).toEqual({ 'x-api-key': LIVE_KEY, 'x-mission-id': 'm-1' });
  });

  it('leaves an unresolvable placeholder untouched rather than emitting "undefined"', () => {
    expect(expandMcpHeaderPlaceholders({ 'x-api-key': '${NOT_SET_ANYWHERE}' }, {} as NodeJS.ProcessEnv)).toEqual({
      'x-api-key': '${NOT_SET_ANYWHERE}',
    });
  });

  it('resolveMcpAuthHeaderValue prefers IMPULSE_INTERNAL_KEY over IMPULSE_API_KEY', () => {
    const env = { IMPULSE_INTERNAL_KEY: LIVE_KEY, IMPULSE_API_KEY: LIVE_KEY } as NodeJS.ProcessEnv;
    expect(resolveMcpAuthHeaderValue(LIVE_KEY, env)).toEqual({
      headerValue: '${IMPULSE_INTERNAL_KEY}',
      envVar: 'IMPULSE_INTERNAL_KEY',
    });
  });

  it('does not reference a variable whose value merely resembles the key', () => {
    const env = { IMPULSE_INTERNAL_KEY: `${LIVE_KEY}-different` } as NodeJS.ProcessEnv;
    expect(resolveMcpAuthHeaderValue(LIVE_KEY, env)).toEqual({
      headerValue: '${RADARIST_MCP_AUTH_KEY}',
      envVar: 'RADARIST_MCP_AUTH_KEY',
      injectIntoChild: true,
    });
  });

  it('never writes the key into an orchestrator log line', () => {
    process.env.IMPULSE_INTERNAL_KEY = LIVE_KEY;
    const lines: string[] = [];
    const logger = {
      info: (msg: string) => lines.push(msg),
      warn: () => {},
      error: () => {},
      debug: () => {},
      log: () => {},
      close: () => {},
    };
    const orchestrator = new Orchestrator({ apiKey: LIVE_KEY, logger: logger as unknown as never }, createMockDeps());
    expect(orchestrator.getMcpServerConfigs()).toBeDefined();
    expect(lines.join('\n')).not.toContain(LIVE_KEY);
  });
});

// ---------------------------------------------------------------------------
// SEC-016 external stdio MCP credential containment.
//
// These four cases were authored in 8096cf88b and silently lost when merge
// 49094ca63 resolved a conflict in favour of a parallel lane's shorter block.
// The three overlapping cases (referenced-var forwarding, the literal/
// unresolvable audit, and the pre-spend runMission refusal) survive in the
// SEC-013 block above and are deliberately not duplicated here.
//
// Every credential value below is SYNTHETIC. No observed credential appears in
// this file.
// ---------------------------------------------------------------------------
describe('SEC-016 external stdio MCP credential containment', () => {
  const PROVIDER_SECRET = 'synthetic-provider-key-9f21ab77';

  function credentialedDeps(env: Record<string, string>) {
    return createMockDeps({
      loadConfig: () => ({
        ...MOCK_CONFIG,
        externalMcpServers: {
          ...MOCK_EXTERNAL_MCP,
          'custom-reader': { transport: 'stdio', command: 'npx', args: ['custom-reader-mcp'], env },
        },
      }),
    });
  }

  it('serialises only the reference for every credential-shaped stdio env entry', () => {
    // The row's headline claim: what the SDK serialises into `--mcp-config` on
    // the CLI child's argv must never carry the value itself.
    process.env.EXA_API_KEY = PROVIDER_SECRET;
    try {
      const orchestrator = new Orchestrator({}, credentialedDeps({ EXA_API_KEY: '${EXA_API_KEY}' }));
      const configs = orchestrator.getMcpServerConfigs();
      const reader = configs['custom-reader'] as McpStdioServerConfig;
      expect(reader.env?.EXA_API_KEY).toBe('${EXA_API_KEY}');
      // This exact string is what the SDK puts on the CLI child's argv.
      expect(JSON.stringify(configs)).not.toContain(PROVIDER_SECRET);
    } finally {
      delete process.env.EXA_API_KEY;
    }
  });

  it('audits a live host secret hidden under an innocuous key name', () => {
    // The key-agnostic net: the value IS a live host secret, so it is caught
    // even though `READER_ENDPOINT` looks harmless. This is what covers
    // NEO4J_PASSWORD and any future credential-shaped entry.
    expect(
      auditMcpCredentialContainment(
        { reader: { type: 'stdio', command: 'npx', args: [], env: { READER_ENDPOINT: PROVIDER_SECRET } } },
        {},
        { EXA_API_KEY: PROVIDER_SECRET } as NodeJS.ProcessEnv
      )
    ).toEqual([{ location: 'reader.READER_ENDPOINT', reason: 'literal-credential' }]);
  });

  it('accepts a resolvable reference and a non-credential literal', () => {
    // The clean case — proves the audit is not simply refusing everything.
    expect(
      auditMcpCredentialContainment(
        {
          exa: {
            type: 'stdio',
            command: 'npx',
            args: [],
            env: { EXA_API_KEY: '${EXA_API_KEY}', READER_ENDPOINT: 'http://reader.test' },
          },
          remote: { type: 'http', url: 'http://example.test/mcp' },
        },
        { EXA_API_KEY: PROVIDER_SECRET },
        {} as NodeJS.ProcessEnv
      )
    ).toEqual([]);
  });

  it('audits a credential embedded in an http server URL', () => {
    // The `config.url` net, otherwise untested anywhere.
    expect(
      auditMcpCredentialContainment(
        { remote: { type: 'http', url: `http://example.test/mcp?api_key=${PROVIDER_SECRET}` } },
        {},
        { EXA_API_KEY: PROVIDER_SECRET } as NodeJS.ProcessEnv
      )
    ).toEqual([{ location: 'remote.url', reason: 'literal-credential' }]);
  });
});

// ---------------------------------------------------------------------------
// SEC-014 — the orchestrator owns the executable capability boundary
// ---------------------------------------------------------------------------

describe('SEC-014 orchestrator capability policy', () => {
  it('derives the subagent server lists from the same definitions the SDK receives', () => {
    const orchestrator = new Orchestrator({ apiKey: 'k' }, createMockDeps());
    const policy = orchestrator.getCapabilityPolicy();
    const definitions = orchestrator.getAgentDefinitions();
    for (const [name, definition] of Object.entries(definitions)) {
      expect(policy.subagentMcpServers[name]).toEqual(definition.mcpServers);
    }
  });

  it('scopes path-bearing capabilities to the mission workspace, and nowhere when there is no mission', () => {
    const withMission = new Orchestrator({ apiKey: 'k', missionId: 'mission-abc' }, createMockDeps());
    expect(withMission.getCapabilityPolicy().workspaceRoots).toEqual([
      path.join(os.tmpdir(), 'impulse-missions', 'mission-abc'),
    ]);

    const withoutMission = new Orchestrator({ apiKey: 'k' }, createMockDeps());
    expect(withoutMission.getCapabilityPolicy().workspaceRoots).toEqual([]);
  });

  it('denies host mutation and allows the research built-ins', () => {
    const orchestrator = new Orchestrator({ apiKey: 'k', missionId: 'mission-abc' }, createMockDeps());
    const policy = orchestrator.getCapabilityPolicy();
    for (const tool of ['Bash', 'Write', 'Edit', 'CronCreate']) {
      expect(decideToolCall(policy, { kind: 'parent' }, tool, {}).allow).toBe(false);
    }
    for (const tool of ['Skill', 'Task', 'WebSearch']) {
      expect(decideToolCall(policy, { kind: 'parent' }, tool, {}).allow).toBe(true);
    }
  });

  it('REGRESSION: Creator cannot reach filesystem tools the mission never configured', async () => {
    // If the Report MCP fails, a Creator must not fall back to a file write.
    // Both the built-in and the MCP route are refused.
    const orchestrator = new Orchestrator({ apiKey: 'k', missionId: 'mission-abc' }, createMockDeps());
    const policy = orchestrator.getCapabilityPolicy();
    const creator = { kind: 'subagent' as const, agentType: 'creator' };
    expect(decideToolCall(policy, creator, 'Write', { file_path: 'main.html' }).allow).toBe(false);
    expect(decideToolCall(policy, creator, 'Bash', { command: 'echo x > main.html' }).allow).toBe(false);
    expect(decideToolCall(policy, creator, 'mcp__filesystem__write_file', { path: '/repo/main.html' }).allow).toBe(
      false
    );
  });

  it('passes the host-mutation deny list to the SDK for the parent and every subagent', async () => {
    let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
    const deps = createMockDeps({
      queryFn: (params) => {
        capturedParams = params;
        return createMockGenerator([createSuccessResult()]);
      },
    });
    const orchestrator = new Orchestrator({ missionId: 'mission-abc' }, deps);
    await orchestrator.runMission('Deny-list test');

    const options = capturedParams?.options as Record<string, unknown>;
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit', 'CronCreate']));
    const agents = options.agents as Record<string, AgentDefinition>;
    for (const definition of Object.values(agents)) {
      expect(definition.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Write', 'Edit']));
    }
  });

  it('installs an enforcing PreToolUse hook that denies Bash end-to-end', async () => {
    let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
    const deps = createMockDeps({
      queryFn: (params) => {
        capturedParams = params;
        return createMockGenerator([createSuccessResult()]);
      },
    });
    const orchestrator = new Orchestrator({ missionId: 'mission-abc' }, deps);
    await orchestrator.runMission('Hook enforcement test');

    const hooks = capturedParams?.options?.hooks as Record<
      string,
      Array<{ hooks: Array<(input: unknown, id: string, opts: { signal: AbortSignal }) => Promise<unknown>> }>
    >;
    const hookFn = hooks.PreToolUse[0].hooks[0];
    const signal = new AbortController().signal;

    const denied = (await hookFn(
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't1' },
      't1',
      { signal }
    )) as { hookSpecificOutput?: { permissionDecision: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny');

    const allowed = await hookFn(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'mcp__impulse-entities__listEntities',
        tool_input: {},
        tool_use_id: 't2',
      },
      't2',
      { signal }
    );
    expect(allowed).toEqual({ continue: true });
  });
});

// ---------------------------------------------------------------------------
// COORD-019 — a revision model must not also be its own fallback
//
// Reproduced by COORD-018: a revision turn requested `claude-opus-4-8` while
// `claude-opus-4-8` was also the configured fallback, and the pinned SDK threw
// `Fallback model cannot be the same as the main model` while building the CLI
// argv — before spawning the child, so no provider call and no spend.
//
// The revision turn is the exposed path precisely because it carries NO
// envelope authority: `runRevisionOrchestrator` passes neither `model` nor
// `authorizedFallbackModel`, so its main model falls through to the role
// profile while its fallback comes from `IMPULSE_AGENT_FALLBACK_MODEL`. Two
// unrelated sources, one id.
//
// Every assertion below runs against a mock `queryFn`: no network, no CLI
// child, no provider call, so these prove the contract at zero spend.
// ---------------------------------------------------------------------------
describe('COORD-019 revision model is never its own fallback', () => {
  /**
   * The top-level model pair the SDK would receive. Deliberately scoped to
   * `model` + `fallbackModel`: `options.agents` carries each subagent's own
   * profile pin, which is pre-existing configuration and not part of the pair
   * being resolved here.
   */
  function topLevelModelPair(options: Record<string, unknown> | undefined): string[] {
    return [options?.model, options?.fallbackModel].filter((value): value is string => typeof value === 'string');
  }

  function withFallbackEnv<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
    const original = process.env.IMPULSE_AGENT_FALLBACK_MODEL;
    if (value === undefined) delete process.env.IMPULSE_AGENT_FALLBACK_MODEL;
    else process.env.IMPULSE_AGENT_FALLBACK_MODEL = value;
    return run().finally(() => {
      if (original === undefined) delete process.env.IMPULSE_AGENT_FALLBACK_MODEL;
      else process.env.IMPULSE_AGENT_FALLBACK_MODEL = original;
    });
  }

  it('runs the revision instead of refusing when the role profile pins the configured fallback', async () => {
    // The exact reproduction shape. In production the creator profile pins
    // `claude-opus-4-8`; here the mock strategist profile does. No `model` and
    // no `authorizedFallbackModel` option — exactly what the revision wrapper
    // passes.
    await withFallbackEnv('claude-opus-4-8', async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
      const queryFn = jest.fn((params: { prompt: string; options?: Record<string, unknown> }) => {
        capturedParams = params;
        return createMockGenerator([createSuccessResult()]);
      });
      const deps = createMockDeps({ queryFn: queryFn as unknown as OrchestratorDeps['queryFn'] });

      const orchestrator = new Orchestrator({ roleAgent: 'strategist' }, deps);
      const result = await orchestrator.runMission('COORD-019 revision reproduction');

      // The run is DISPATCHED, not refused before spend — that is the row's goal.
      expect(queryFn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);

      // The authorized model still reaches the SDK unchanged...
      expect(capturedParams?.options?.model).toBe('claude-opus-4-8');
      // ...and the colliding fallback is simply absent, which is the state
      // COORD-012 already authorizes for an explicit null fallback.
      expect(capturedParams?.options && 'fallbackModel' in capturedParams.options).toBe(false);

      // No unauthorized model: `claude-opus-4-8` is the ONLY model id anywhere
      // in what the SDK receives. Nothing was substituted in place of the drop.
      expect(topLevelModelPair(capturedParams?.options)).toEqual(['claude-opus-4-8']);
    });
  });

  it('drops the fallback on the envelope path too, when both fields name one model', async () => {
    // The shape the backlog row describes: an envelope authorizing the same id
    // for both. Resolved identically, and without rewriting the envelope.
    await withFallbackEnv(undefined, async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(
        { model: 'claude-opus-4-8', authorizedFallbackModel: 'claude-opus-4-8' },
        deps
      );
      const result = await orchestrator.runMission('COORD-019 envelope pair');

      expect(result.success).toBe(true);
      expect(capturedParams?.options?.model).toBe('claude-opus-4-8');
      expect(capturedParams?.options && 'fallbackModel' in capturedParams.options).toBe(false);
      expect(topLevelModelPair(capturedParams?.options)).toEqual(['claude-opus-4-8']);
    });
  });

  it('keeps a genuinely different authorized fallback intact', async () => {
    // Guards against over-correction: the fix must only remove a redundant
    // fallback, never a real one.
    await withFallbackEnv(undefined, async () => {
      let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
      const deps = createMockDeps({
        queryFn: (params) => {
          capturedParams = params;
          return createMockGenerator([createSuccessResult()]);
        },
      });

      const orchestrator = new Orchestrator(
        { model: 'claude-opus-4-8', authorizedFallbackModel: 'claude-haiku-4-5' },
        deps
      );
      await orchestrator.runMission('COORD-019 distinct fallback');

      expect(capturedParams?.options?.model).toBe('claude-opus-4-8');
      expect(capturedParams?.options?.fallbackModel).toBe('claude-haiku-4-5');
    });
  });

  it('resolves the pair for chat too, where the main model is read per dispatch', async () => {
    // `this.fallbackModel` is one run-wide field but `streamChat` reads
    // CLAUDE_CHAT_MODEL at dispatch time, so a constructor-only dedupe would
    // leave this path broken.
    const originalChatModel = process.env.CLAUDE_CHAT_MODEL;
    process.env.CLAUDE_CHAT_MODEL = 'claude-opus-4-8';
    try {
      await withFallbackEnv('claude-opus-4-8', async () => {
        let capturedParams: { prompt: string; options?: Record<string, unknown> } | undefined;
        const deps = createMockDeps({
          queryFn: (params) => {
            capturedParams = params;
            return createMockGenerator([createSuccessResult()]);
          },
        });

        const orchestrator = new Orchestrator(undefined, deps);
        for await (const _message of orchestrator.streamChat({ prompt: 'COORD-019 chat pair' })) {
          // drain
        }

        expect(capturedParams?.options?.model).toBe('claude-opus-4-8');
        expect(capturedParams?.options && 'fallbackModel' in capturedParams.options).toBe(false);
        expect(topLevelModelPair(capturedParams?.options)).toEqual(['claude-opus-4-8']);
      });
    } finally {
      if (originalChatModel === undefined) delete process.env.CLAUDE_CHAT_MODEL;
      else process.env.CLAUDE_CHAT_MODEL = originalChatModel;
    }
  });
});
