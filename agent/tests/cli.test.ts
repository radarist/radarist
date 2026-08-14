import { jest } from '@jest/globals';
import { parseArgs, execute, buildSweepOrchestratorOptions } from '../src/cli';
import type { CliCommand, ExecuteDeps } from '../src/cli';
import type { AgentProfile } from '../src/profiles';
import type { MissionResult } from '../src/orchestrator';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_PROFILE: AgentProfile = {
  name: 'scout',
  description: 'Discovers new signals and emerging technologies',
  prompt: '# Scout\nYou are the scout agent.',
  model: 'claude-sonnet-4-6',
  budget: { max_tokens: 30000, max_tool_calls: 20 },
  mcp_servers: {
    internal: ['impulse-entities', 'impulse-signals'],
    external: ['impulse-research'],
  },
};

const MOCK_SUCCESS_RESULT: MissionResult = {
  success: true,
  result: 'Mission completed. Found 3 new AI signals.',
  costUsd: 0.05,
  tokenUsage: { input: 5000, output: 2000 },
};

const MOCK_ERROR_RESULT: MissionResult = {
  success: false,
  costUsd: 0.01,
  tokenUsage: { input: 1000, output: 200 },
  errors: ['API timeout', 'Rate limit exceeded'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDeps(overrides?: Partial<ExecuteDeps>): ExecuteDeps {
  return {
    listAgentsFn: () => ['curator', 'evaluator', 'linker', 'scout', 'strategist'],
    loadProfileFn: () => MOCK_PROFILE,
    createOrchestratorFn: () => ({
      runMission: async () => MOCK_SUCCESS_RESULT,
    }),
    startSweepFn: jest.fn(async () => {}),
    log: jest.fn(),
    error: jest.fn(),
    ...overrides,
  };
}

function argv(...args: string[]): string[] {
  return ['node', 'dist/index.js', ...args];
}

// ---------------------------------------------------------------------------
// parseArgs tests
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('should parse list command', () => {
    const command = parseArgs(argv('list'));
    expect(command).toEqual({ name: 'list' });
  });

  it('should parse describe <agent> command', () => {
    const command = parseArgs(argv('describe', 'scout'));
    expect(command).toEqual({ name: 'describe', agent: 'scout' });
  });

  it('should parse run <agent> --mission "prompt" command', () => {
    const command = parseArgs(argv('run', 'scout', '--mission', 'Find AI signals'));
    expect(command).toEqual({
      name: 'run',
      agent: 'scout',
      mission: 'Find AI signals',
    });
  });

  it('should parse sweep command', () => {
    const command = parseArgs(argv('sweep'));
    expect(command).toEqual({ name: 'sweep' });
  });

  it('should parse --config flag for list', () => {
    const command = parseArgs(argv('list', '--config', '/custom/config.yaml'));
    expect(command).toEqual({
      name: 'list',
      configPath: '/custom/config.yaml',
    });
  });

  it('should parse --config flag for run', () => {
    const command = parseArgs(argv('run', 'scout', '--mission', 'test', '--config', '/custom/config.yaml'));
    expect(command).toEqual({
      name: 'run',
      agent: 'scout',
      mission: 'test',
      configPath: '/custom/config.yaml',
    });
  });

  it('should parse --agents-dir flag', () => {
    const command = parseArgs(argv('list', '--agents-dir', '/custom/agents'));
    expect(command).toEqual({
      name: 'list',
      agentsDir: '/custom/agents',
    });
  });

  it('should parse --api-key flag', () => {
    const command = parseArgs(argv('run', 'scout', '--mission', 'test', '--api-key', 'sk-123'));
    expect(command).toEqual({
      name: 'run',
      agent: 'scout',
      mission: 'test',
      apiKey: 'sk-123',
    });
  });

  it('should parse all flags together', () => {
    const command = parseArgs(
      argv('run', 'scout', '--mission', 'test', '--config', '/c.yaml', '--agents-dir', '/agents', '--api-key', 'sk-123')
    );
    expect(command).toEqual({
      name: 'run',
      agent: 'scout',
      mission: 'test',
      configPath: '/c.yaml',
      agentsDir: '/agents',
      apiKey: 'sk-123',
    });
  });

  it('should throw on unknown command', () => {
    expect(() => parseArgs(argv('unknown'))).toThrow(/Unknown command: unknown/);
  });

  it('should throw on missing command', () => {
    expect(() => parseArgs(argv())).toThrow(/No command provided/);
  });

  it('should throw on empty string command', () => {
    expect(() => parseArgs(argv(''))).toThrow(/No command provided/);
  });

  it('should return undefined for missing optional flags', () => {
    const command = parseArgs(argv('run', 'scout', '--mission', 'test'));
    expect(command.configPath).toBeUndefined();
    expect(command.agentsDir).toBeUndefined();
    expect(command.apiKey).toBeUndefined();
  });

  it('should return undefined for flag without value', () => {
    // --mission is at end of args with no value following
    const command = parseArgs(argv('run', 'scout', '--mission'));
    expect(command.mission).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// execute tests
// ---------------------------------------------------------------------------

describe('execute', () => {
  describe('list command', () => {
    it('should print all agents', async () => {
      const deps = createMockDeps();
      await execute({ name: 'list' }, deps);

      expect(deps.log).toHaveBeenCalledWith('Available agents:');
      expect(deps.log).toHaveBeenCalledWith('  - curator');
      expect(deps.log).toHaveBeenCalledWith('  - evaluator');
      expect(deps.log).toHaveBeenCalledWith('  - linker');
      expect(deps.log).toHaveBeenCalledWith('  - scout');
      expect(deps.log).toHaveBeenCalledWith('  - strategist');
    });

    it('should print "No agents found." when empty', async () => {
      const deps = createMockDeps({ listAgentsFn: () => [] });
      await execute({ name: 'list' }, deps);

      expect(deps.log).toHaveBeenCalledWith('No agents found.');
    });

    it('should pass agentsDir when provided', async () => {
      const listSpy = jest.fn(() => ['scout']);
      const deps = createMockDeps({ listAgentsFn: listSpy });

      await execute({ name: 'list', agentsDir: '/custom/agents' }, deps);

      expect(listSpy).toHaveBeenCalledWith('/custom/agents');
    });
  });

  describe('describe command', () => {
    it('should print profile details', async () => {
      const deps = createMockDeps();
      await execute({ name: 'describe', agent: 'scout' }, deps);

      expect(deps.log).toHaveBeenCalledWith('Agent: scout');
      expect(deps.log).toHaveBeenCalledWith('Model: claude-sonnet-4-6');
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Discovers new signals'));
      expect(deps.log).toHaveBeenCalledWith('MCP Servers: impulse-entities, impulse-signals, impulse-research');
      expect(deps.log).toHaveBeenCalledWith('Profile limits: 30000 token reference, 20 tool calls');
    });

    it('should throw when agent not specified', async () => {
      const deps = createMockDeps();
      await expect(execute({ name: 'describe' }, deps)).rejects.toThrow(/Usage: impulse-agent describe <agent-name>/);
    });

    it('should pass agentsDir to loadProfileFn', async () => {
      const loadSpy = jest.fn(() => MOCK_PROFILE);
      const deps = createMockDeps({ loadProfileFn: loadSpy });

      await execute({ name: 'describe', agent: 'scout', agentsDir: '/custom/agents' }, deps);

      expect(loadSpy).toHaveBeenCalledWith('/custom/agents', 'scout');
    });
  });

  describe('run command', () => {
    it('should call orchestrator.runMission with mission prompt', async () => {
      const runMissionSpy = jest.fn(async () => MOCK_SUCCESS_RESULT);
      const deps = createMockDeps({
        createOrchestratorFn: () => ({ runMission: runMissionSpy }),
      });

      await execute({ name: 'run', agent: 'scout', mission: 'Find AI signals' }, deps);

      expect(runMissionSpy).toHaveBeenCalledWith('Find AI signals');
    });

    it('should log result on success', async () => {
      const deps = createMockDeps();
      await execute({ name: 'run', agent: 'scout', mission: 'Find AI signals' }, deps);

      expect(deps.log).toHaveBeenCalledWith('Mission completed. Found 3 new AI signals.');
    });

    it('should throw when agent not specified', async () => {
      const deps = createMockDeps();
      await expect(execute({ name: 'run', mission: 'test' }, deps)).rejects.toThrow(
        /Usage: impulse-agent run <agent-name>/
      );
    });

    it('should throw when mission not specified', async () => {
      const deps = createMockDeps();
      await expect(execute({ name: 'run', agent: 'scout' }, deps)).rejects.toThrow(/--mission flag is required/);
    });

    it('should report errors on mission failure', async () => {
      const deps = createMockDeps({
        createOrchestratorFn: () => ({
          runMission: async () => MOCK_ERROR_RESULT,
        }),
      });

      const result = await execute({ name: 'run', agent: 'scout', mission: 'Failing mission' }, deps);

      expect(deps.error).toHaveBeenCalledWith('Mission failed: API timeout, Rate limit exceeded');
      // execute returns 1 for failure
      expect(result).toBe(1);
    });

    it('should return 0 on success', async () => {
      const deps = createMockDeps();
      const result = await execute({ name: 'run', agent: 'scout', mission: 'test' }, deps);
      expect(result).toBe(0);
    });

    it('should pass configPath to orchestrator', async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      const deps = createMockDeps({
        createOrchestratorFn: (options) => {
          capturedOptions = options as Record<string, unknown>;
          return { runMission: async () => MOCK_SUCCESS_RESULT };
        },
      });

      await execute(
        {
          name: 'run',
          agent: 'scout',
          mission: 'test',
          configPath: '/custom/config.yaml',
          apiKey: 'sk-123',
        },
        deps
      );

      expect(capturedOptions?.configPath).toBe('/custom/config.yaml');
      expect(capturedOptions?.apiKey).toBe('sk-123');
    });
  });

  describe('sweep command', () => {
    it('should call startSweepFn and log start/stop messages', async () => {
      const deps = createMockDeps();
      const result = await execute({ name: 'sweep' }, deps);

      expect(deps.startSweepFn).toHaveBeenCalled();
      expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Starting sweep loop'));
      expect(deps.log).toHaveBeenCalledWith('Sweep loop stopped.');
      expect(result).toBe(0);
    });

    it('should pass configPath to startSweepFn', async () => {
      const sweepSpy = jest.fn(async () => {});
      const deps = createMockDeps({ startSweepFn: sweepSpy });

      await execute({ name: 'sweep', configPath: '/custom/config.yaml' }, deps);

      expect(sweepSpy).toHaveBeenCalledWith(
        '/custom/config.yaml',
        expect.any(Object), // AbortSignal
        expect.any(Object), // Logger
        undefined // ARUN-011: apiKey threaded through (none passed here)
      );
    });
  });
});

describe('buildSweepOrchestratorOptions (OPS-004: sweep Orchestrator MCP auth)', () => {
  it('threads the resolved apiKey into the sweep Orchestrator options', () => {
    const options = buildSweepOrchestratorOptions('/c/impulse.config.yaml', undefined, 'sk-sweep-123');
    expect(options.apiKey).toBe('sk-sweep-123');
    expect(options.configPath).toBe('/c/impulse.config.yaml');
  });

  it('omits apiKey entirely when no key resolved (unauthenticated local sweep unchanged)', () => {
    const options = buildSweepOrchestratorOptions('/c/impulse.config.yaml', undefined, undefined);
    expect('apiKey' in options).toBe(false);
    expect(options.configPath).toBe('/c/impulse.config.yaml');
  });

  it('treats an empty-string key as no key', () => {
    const options = buildSweepOrchestratorOptions(undefined, undefined, '');
    expect('apiKey' in options).toBe(false);
  });
});
