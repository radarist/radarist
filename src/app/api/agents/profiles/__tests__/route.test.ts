/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports). js-yaml and zod are intentionally REAL so the
// test exercises parsing of real-shaped config.yaml content.
// ---------------------------------------------------------------------------

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}));

const mockReaddirSync = jest.fn();
const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
jest.mock('fs', () => ({
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { GET } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(url = 'http://localhost:3000/api/agents/profiles'): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer mock-token' },
  });
}

interface AgentYamlOptions {
  name: string;
  description?: string;
  model: string;
  maxTokens: number;
  maxToolCalls: number;
  internal?: string[];
  external?: string[];
  maxTurns?: number;
  effort?: string;
}

/** Real-shaped config.yaml content, including comments, like the live files. */
function agentYaml(opts: AgentYamlOptions): string {
  const internal = (opts.internal ?? []).map((s) => `    - ${s}`).join('\n');
  const external = (opts.external ?? []).map((s) => `    - ${s}`).join('\n');
  return `name: ${opts.name}
description: '${opts.description ?? `${opts.name} description`}'
# upgraded per 2026-06 model-alignment pass
model: ${opts.model}
budget:
  max_tokens: ${opts.maxTokens}
  max_tool_calls: ${opts.maxToolCalls}
mcp_servers:
  internal:
${internal}
  external:
${external}
${opts.maxTurns !== undefined ? `max_turns: ${opts.maxTurns}` : ''}
${opts.effort !== undefined ? `effort: ${opts.effort}` : ''}
permission_mode: acceptEdits
`;
}

function agentNameFromPath(p: unknown): string | null {
  if (typeof p !== 'string') return null;
  const match = p.match(/agents[/\\]([^/\\]+)[/\\]config\.yaml$/);
  return match ? match[1] : null;
}

/**
 * Wire the fs mocks for a set of agent directories.
 * A `null` value means the directory exists but has no config.yaml.
 */
function setupAgents(configs: Record<string, string | null>) {
  mockReaddirSync.mockReturnValue(Object.keys(configs).map((name) => ({ name, isDirectory: () => true })));
  mockExistsSync.mockImplementation((p: unknown) => {
    const name = agentNameFromPath(p);
    return name !== null && typeof configs[name] === 'string';
  });
  mockReadFileSync.mockImplementation((p: unknown) => {
    const name = agentNameFromPath(p);
    const content = name !== null ? configs[name] : null;
    if (typeof content !== 'string') throw new Error(`ENOENT: ${String(p)}`);
    return content;
  });
}

/** The seven live agent configs, mirroring agent/agents/&#42;/config.yaml. */
function realShapedConfigs(): Record<string, string> {
  return {
    creator: agentYaml({
      name: 'creator',
      model: 'claude-opus-4-8',
      maxTokens: 100000,
      maxToolCalls: 50,
      internal: ['impulse-reports', 'impulse-research'],
      external: ['super-graph', 'gemini-image', 'antv-chart', 'playwright', 'exa'],
      maxTurns: 25,
      effort: 'high',
    }),
    curator: agentYaml({
      name: 'curator',
      model: 'claude-haiku-4-5',
      maxTokens: 15000,
      maxToolCalls: 30,
      internal: ['impulse-signals'],
      external: ['gemini-grounding', 'exa', 'firecrawl', 'arxiv', 'github'],
      maxTurns: 20,
      effort: 'low',
    }),
    'defense-minister': agentYaml({
      name: 'defense-minister',
      model: 'claude-haiku-4-5',
      maxTokens: 15000,
      maxToolCalls: 30,
      internal: ['impulse-entities', 'impulse-graph'],
      external: ['gemini-grounding', 'exa', 'firecrawl'],
      maxTurns: 20,
      effort: 'low',
    }),
    evaluator: agentYaml({
      name: 'evaluator',
      model: 'claude-sonnet-4-6',
      maxTokens: 25000,
      maxToolCalls: 25,
      internal: ['impulse-signals', 'impulse-radar'],
      external: ['arxiv', 'github', 'gemini-grounding'],
      maxTurns: 15,
      effort: 'medium',
    }),
    linker: agentYaml({
      name: 'linker',
      model: 'claude-sonnet-4-6',
      maxTokens: 20000,
      maxToolCalls: 25,
      internal: ['impulse-signals'],
      external: ['exa'],
      maxTurns: 20,
      effort: 'medium',
    }),
    scout: agentYaml({
      name: 'scout',
      model: 'claude-sonnet-4-6',
      maxTokens: 30000,
      maxToolCalls: 50,
      internal: ['impulse-signals'],
      external: ['gemini-grounding', 'gemini-research', 'arxiv', 'exa', 'firecrawl', 'playwright', 'github'],
      maxTurns: 30,
      effort: 'high',
    }),
    strategist: agentYaml({
      name: 'strategist',
      model: 'claude-opus-4-8',
      maxTokens: 30000,
      maxToolCalls: 20,
      internal: ['impulse-radar', 'impulse-signals'],
      external: ['super-graph', 'exa', 'arxiv', 'gemini-grounding'],
      maxTurns: 15,
      effort: 'high',
    }),
  };
}

// ---------------------------------------------------------------------------
// Env hygiene — the route reads these at request time
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'MISSION_MAX_COST_USD',
  'MISSION_TOKEN_BUDGET',
  'MISSION_MAX_TOOL_CALLS',
  'IMPULSE_MISSION_MAX_COST_USD',
  'IMPULSE_MISSION_TOKEN_BUDGET',
  'IMPULSE_MISSION_MAX_TOOL_CALLS',
  'MISSION_WARN_THRESHOLD',
  'IMPULSE_MISSION_WARN_THRESHOLD',
  'IMPULSE_AGENT_CURATOR_MODEL',
  'IMPULSE_AGENT_DEFENSE_MINISTER_MODEL',
];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/agents/profiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    setupAgents(realShapedConfigs());
  });

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
  });

  it('parses all 7 real-shaped config.yaml files', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.profiles).toHaveLength(7);
    const names = json.profiles.map((p: { name: string }) => p.name);
    expect(names).toEqual(
      expect.arrayContaining(['scout', 'evaluator', 'linker', 'curator', 'strategist', 'creator', 'defense-minister'])
    );
  });

  it('returns configured models and effective lower-of-global-or-profile limits', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    const byName = Object.fromEntries(json.profiles.map((p: { name: string }) => [p.name, p]));

    expect(byName['curator'].model).toBe('claude-haiku-4-5');
    expect(byName['strategist'].model).toBe('claude-opus-4-8');
    expect(byName['creator'].model).toBe('claude-opus-4-8');
    // Creator config declares 100k tokens, but the global reference is 50k.
    expect(byName['creator'].maxTokens).toBe(50000);
    expect(byName['creator'].maxToolCalls).toBe(50);
    expect(byName['defense-minister']).toBeDefined();
    expect(byName['defense-minister'].maxTokens).toBe(15000);
    expect(byName['scout'].modelSource).toBe('config');
  });

  it('returns MCP server lists per agent', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    const strategist = json.profiles.find((p: { name: string }) => p.name === 'strategist');
    expect(strategist.internalMcpServers).toEqual(['impulse-radar', 'impulse-signals']);
    expect(strategist.externalMcpServers).toEqual(['super-graph', 'exa', 'arxiv', 'gemini-grounding']);
  });

  it('sorts profiles in canonical pipeline order', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.profiles.map((p: { name: string }) => p.name)).toEqual([
      'scout',
      'evaluator',
      'linker',
      'curator',
      'strategist',
      'creator',
      'defense-minister',
    ]);
  });

  it('applies IMPULSE_AGENT_<NAME>_MODEL env override with modelSource env', async () => {
    process.env.IMPULSE_AGENT_CURATOR_MODEL = 'claude-sonnet-4-6';
    process.env.IMPULSE_AGENT_DEFENSE_MINISTER_MODEL = 'claude-opus-4-8';

    const res = await GET(createMockRequest());
    const json = await res.json();

    const byName = Object.fromEntries(json.profiles.map((p: { name: string }) => [p.name, p]));
    expect(byName['curator'].model).toBe('claude-sonnet-4-6');
    expect(byName['curator'].modelSource).toBe('env');
    expect(byName['defense-minister'].model).toBe('claude-opus-4-8');
    expect(byName['defense-minister'].modelSource).toBe('env');
    // Others untouched
    expect(byName['scout'].model).toBe('claude-sonnet-4-6');
    expect(byName['scout'].modelSource).toBe('config');
  });

  it('skips directories without a config.yaml', async () => {
    setupAgents({ ...realShapedConfigs(), 'some-readme-dir': null });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.profiles).toHaveLength(7);
    expect(json.profiles.map((p: { name: string }) => p.name)).not.toContain('some-readme-dir');
  });

  it('skips a config.yaml that fails schema validation without failing the request', async () => {
    const configs = realShapedConfigs();
    configs['curator'] = 'name: curator\nmodel: claude-haiku-4-5\n'; // missing budget
    setupAgents(configs);

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.profiles).toHaveLength(6);
    expect(json.profiles.map((p: { name: string }) => p.name)).not.toContain('curator');
  });

  it('returns enforced caps and marks the 50k token reference as observational', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.missionBudget).toEqual({
      maxCostUsd: 15.0,
      maxCostSource: 'default',
      tokenBudget: 50000,
      tokenBudgetEnforced: false,
      maxToolCalls: 100,
    });
  });

  it('reports env-overridden mission budget values', async () => {
    process.env.MISSION_MAX_COST_USD = '7.50';
    process.env.MISSION_TOKEN_BUDGET = '80000';
    process.env.MISSION_MAX_TOOL_CALLS = '40';

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.missionBudget).toEqual({
      maxCostUsd: 7.5,
      maxCostSource: 'env',
      tokenBudget: 80000,
      tokenBudgetEnforced: false,
      maxToolCalls: 40,
    });
    const byName = Object.fromEntries(json.profiles.map((p: { name: string }) => [p.name, p]));
    // Global values constrain creator's 100k/50 profile; defense-minister's
    // stricter 15k/30 profile remains authoritative.
    expect(byName['creator']).toEqual(expect.objectContaining({ maxTokens: 80000, maxToolCalls: 40 }));
    expect(byName['defense-minister']).toEqual(expect.objectContaining({ maxTokens: 15000, maxToolCalls: 30 }));
  });

  it('falls back to the default cap when MISSION_MAX_COST_USD is invalid', async () => {
    process.env.MISSION_MAX_COST_USD = 'not-a-number';

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.missionBudget.maxCostUsd).toBe(15.0);
    expect(json.missionBudget.maxCostSource).toBe('default');
  });

  it.each(['-1', '0', 'NaN', 'Infinity', '-Infinity'])(
    'uses secure defaults for invalid mission limits: %s',
    async (invalidValue) => {
      process.env.MISSION_MAX_COST_USD = invalidValue;
      process.env.MISSION_TOKEN_BUDGET = invalidValue;
      process.env.MISSION_MAX_TOOL_CALLS = invalidValue;

      const res = await GET(createMockRequest());
      const json = await res.json();

      expect(json.missionBudget).toEqual({
        maxCostUsd: 15,
        maxCostSource: 'default',
        tokenBudget: 50000,
        tokenBudgetEnforced: false,
        maxToolCalls: 100,
      });
    }
  );

  it('uses IMPULSE mission limit aliases and reports env cost provenance', async () => {
    process.env.IMPULSE_MISSION_MAX_COST_USD = '8.25';
    process.env.IMPULSE_MISSION_TOKEN_BUDGET = '70000';
    process.env.IMPULSE_MISSION_MAX_TOOL_CALLS = '65';

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.missionBudget).toEqual({
      maxCostUsd: 8.25,
      maxCostSource: 'env',
      tokenBudget: 70000,
      tokenBudgetEnforced: false,
      maxToolCalls: 65,
    });
  });

  it('returns 500 when the agents directory cannot be read', async () => {
    mockReaddirSync.mockImplementation(() => {
      throw new Error('ENOENT: no such directory');
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe('Failed to read agent profiles');
  });
});
