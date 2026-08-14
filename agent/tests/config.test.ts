import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadAgentConfig,
  getMcpServerUrl,
  resolveMcpBaseUrl,
  DEFAULT_AGENT_CONFIG,
  DEFAULT_MCP_BASE_URL,
  resolveAgentMcpServers,
  UNIVERSAL_MCP_SERVERS,
  collectMcpEnvReferencedVars,
  mcpEnvReferencedVars,
} from '../src/config';
import type { AgentConfig } from '../src/config';

describe('AgentConfig', () => {
  // Save and restore env vars across tests. Each test starts from a KNOWN
  // clean state (env unset) so YAML/default precedence is deterministic even
  // when the developer's shell exports IMPULSE_MCP_BASE_URL — the env now
  // outranks YAML (OPS-004), so an inherited value would otherwise flip the
  // YAML-precedence assertions.
  const originalEnv = process.env['IMPULSE_MCP_BASE_URL'];
  beforeEach(() => {
    delete process.env['IMPULSE_MCP_BASE_URL'];
  });
  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env['IMPULSE_MCP_BASE_URL'];
    } else {
      process.env['IMPULSE_MCP_BASE_URL'] = originalEnv;
    }
  });

  describe('loadAgentConfig', () => {
    it('should load default config when no file path is provided', () => {
      const config = loadAgentConfig();
      expect(config.instance.name).toBe('Impulse');
      expect(config.budget.daily_limit).toBe(100000);
      expect(config.sweep.enabled).toBe(true);
    });

    it('should load default config when file does not exist', () => {
      const config = loadAgentConfig('/nonexistent/path.yaml');
      expect(config.instance.name).toBe('Impulse');
      expect(config.budget.daily_limit).toBe(100000);
      expect(config.budget.weekly_limit).toBe(500000);
      expect(config.budget.alert_threshold).toBe(0.8);
      expect(config.budget.overflow_policy).toBe('queue');
      expect(config.sweep.enabled).toBe(true);
      expect(config.sweep.interval_minutes).toBe(30);
      expect(config.sweep.max_actions_per_sweep).toBe(10);
      expect(config.sweep.priorities).toEqual(expect.arrayContaining(['stale_signals', 'unlinked_entities']));
    });

    it('should load config from a valid YAML file', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: TestInstance',
          '  domain: test-domain',
          '  description: "A test instance"',
          'budget:',
          '  daily_limit: 50000',
          '  weekly_limit: 200000',
          '  alert_threshold: 0.9',
          '  overflow_policy: drop',
          'models:',
          '  orchestrator: claude-opus-4-8',
          '  analysis: claude-sonnet-4-6',
          'sweep:',
          '  enabled: false',
          '  interval_minutes: 60',
          '  max_actions_per_sweep: 5',
          '  priorities:',
          '    - stale_signals',
          'mcpBaseUrl: "http://example.com/api/mcp"',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        expect(config.instance.name).toBe('TestInstance');
        expect(config.instance.domain).toBe('test-domain');
        expect(config.budget.daily_limit).toBe(50000);
        expect(config.budget.overflow_policy).toBe('drop');
        expect(config.models['orchestrator']).toBe('claude-opus-4-8');
        expect(config.sweep.enabled).toBe(false);
        expect(config.sweep.interval_minutes).toBe(60);
        expect(config.mcpBaseUrl).toBe('http://example.com/api/mcp');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should fall back to env var for mcpBaseUrl when not in YAML', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      process.env['IMPULSE_MCP_BASE_URL'] = 'http://env-var.example.com/mcp';

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: EnvTest',
          '  domain: env-test',
          '  description: "Tests env var fallback"',
          'budget:',
          '  daily_limit: 10000',
          '  weekly_limit: 50000',
          '  alert_threshold: 0.5',
          '  overflow_policy: alert_only',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 15',
          '  max_actions_per_sweep: 3',
          '  priorities:',
          '    - pending_evaluations',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        expect(config.mcpBaseUrl).toBe('http://env-var.example.com/mcp');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('OPS-004: explicit IMPULSE_MCP_BASE_URL outranks a stale YAML top-level mcpBaseUrl', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      // Simulate the OPS-004 defect: an ignored developer YAML pins the default
      // port while the launcher started the app on a shifted profile port and
      // exported the matching env value.
      process.env['IMPULSE_MCP_BASE_URL'] = 'http://127.0.0.1:9022/api/mcp';

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: StaleYaml',
          '  domain: test',
          '  description: "Stale YAML port test"',
          'budget:',
          '  daily_limit: 10000',
          '  weekly_limit: 50000',
          '  alert_threshold: 0.5',
          '  overflow_policy: queue',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
          'mcpBaseUrl: "http://localhost:9002/api/mcp"',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        expect(config.mcpBaseUrl).toBe('http://127.0.0.1:9022/api/mcp');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('OPS-004: explicit IMPULSE_MCP_BASE_URL outranks a stale mcp_servers.internal.base_url', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      process.env['IMPULSE_MCP_BASE_URL'] = 'http://127.0.0.1:9022/api/mcp';

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: StaleInternal',
          '  domain: test',
          '  description: "Stale internal base_url test"',
          'budget:',
          '  daily_limit: 10000',
          '  weekly_limit: 50000',
          '  alert_threshold: 0.5',
          '  overflow_policy: queue',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
          'mcp_servers:',
          '  internal:',
          '    base_url: "http://app:9002/api/mcp"',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        expect(config.mcpBaseUrl).toBe('http://127.0.0.1:9022/api/mcp');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('OPS-004: a blank IMPULSE_MCP_BASE_URL does not blank out a real YAML value', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      process.env['IMPULSE_MCP_BASE_URL'] = '   ';

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: BlankEnv',
          '  domain: test',
          '  description: "Blank env test"',
          'budget:',
          '  daily_limit: 10000',
          '  weekly_limit: 50000',
          '  alert_threshold: 0.5',
          '  overflow_policy: queue',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
          'mcpBaseUrl: "http://localhost:9002/api/mcp"',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        expect(config.mcpBaseUrl).toBe('http://localhost:9002/api/mcp');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('OPS-004: honors an explicit env value even with no config file (default path)', () => {
      process.env['IMPULSE_MCP_BASE_URL'] = 'http://127.0.0.1:9042/api/mcp';
      const config = loadAgentConfig('/nonexistent/path.yaml');
      expect(config.mcpBaseUrl).toBe('http://127.0.0.1:9042/api/mcp');
    });

    it('should throw for invalid YAML syntax', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'bad.yaml');
      fs.writeFileSync(configPath, 'instance: "unterminated');

      try {
        expect(() => loadAgentConfig(configPath)).toThrow(/Failed to parse config file|Invalid config file/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw for config that fails Zod validation', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'invalid.yaml');
      // Missing required fields
      fs.writeFileSync(configPath, ['instance:', '  name: Incomplete'].join('\n'));

      try {
        expect(() => loadAgentConfig(configPath)).toThrow(/Invalid config file/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should reject negative budget values', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'neg.yaml');
      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: NegBudget',
          '  domain: test',
          '  description: "Negative budget test"',
          'budget:',
          '  daily_limit: -100',
          '  weekly_limit: 500000',
          '  alert_threshold: 0.8',
          '  overflow_policy: queue',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
        ].join('\n')
      );

      try {
        expect(() => loadAgentConfig(configPath)).toThrow(/Invalid config file/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should reject invalid overflow_policy', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'bad-policy.yaml');
      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: BadPolicy',
          '  domain: test',
          '  description: "Bad overflow policy"',
          'budget:',
          '  daily_limit: 1000',
          '  weekly_limit: 5000',
          '  alert_threshold: 0.8',
          '  overflow_policy: explode',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
        ].join('\n')
      );

      try {
        expect(() => loadAgentConfig(configPath)).toThrow(/Invalid config file/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return a fresh copy of defaults (not reference)', () => {
      const config1 = loadAgentConfig();
      const config2 = loadAgentConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });

    it('should default externalMcpServers to empty when no mcp_servers section', () => {
      const config = loadAgentConfig();
      expect(config.externalMcpServers).toEqual({});
    });

    it('should load external MCP server definitions from YAML', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: McpTest',
          '  domain: test',
          '  description: "Tests MCP loading"',
          'budget:',
          '  daily_limit: 10000',
          '  weekly_limit: 50000',
          '  alert_threshold: 0.5',
          '  overflow_policy: queue',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
          'mcp_servers:',
          '  internal:',
          '    base_url: "http://app:9002/api/mcp"',
          '  external:',
          '    exa:',
          '      transport: stdio',
          '      command: "npx"',
          '      args:',
          '        - "-y"',
          '        - "exa-mcp-server"',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        expect(config.mcpBaseUrl).toBe('http://app:9002/api/mcp');
        expect(Object.keys(config.externalMcpServers)).toHaveLength(1);

        const exa = config.externalMcpServers['exa'];
        expect(exa.transport).toBe('stdio');
        if (exa.transport === 'stdio') {
          expect(exa.command).toBe('npx');
          expect(exa.args).toEqual(['-y', 'exa-mcp-server']);
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('preserves resolvable ${VAR} references outside the serialized credential value', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
      const configPath = path.join(tmpDir, 'impulse.config.yaml');

      process.env['TEST_READER_ENDPOINT'] = 'http://reader.test';
      process.env['TEST_READER_SECRET'] = 'synthetic-config-secret-2f7a';

      fs.writeFileSync(
        configPath,
        [
          'instance:',
          '  name: EnvResolve',
          '  domain: test',
          '  description: "Tests env resolution"',
          'budget:',
          '  daily_limit: 10000',
          '  weekly_limit: 50000',
          '  alert_threshold: 0.5',
          '  overflow_policy: queue',
          'models:',
          '  orchestrator: claude-sonnet-4-6',
          'sweep:',
          '  enabled: true',
          '  interval_minutes: 30',
          '  max_actions_per_sweep: 10',
          '  priorities:',
          '    - stale_signals',
          'mcp_servers:',
          '  external:',
          '    custom-reader:',
          '      transport: stdio',
          '      command: "npx"',
          '      args:',
          '        - "custom-reader-mcp"',
          '      env:',
          '        READER_ENDPOINT: "${TEST_READER_ENDPOINT}"',
          '        READER_API_KEY: "${TEST_READER_SECRET}"',
          '        MISSING_VAR: "${NONEXISTENT_VAR_12345}"',
        ].join('\n')
      );

      try {
        const config = loadAgentConfig(configPath);
        const reader = config.externalMcpServers['custom-reader'];
        expect(reader.transport).toBe('stdio');
        if (reader.transport === 'stdio') {
          expect(reader.env).toBeDefined();
          expect(reader.env!['READER_ENDPOINT']).toBe('${TEST_READER_ENDPOINT}');
          expect(reader.env!['READER_API_KEY']).toBe('${TEST_READER_SECRET}');
          expect(JSON.stringify(reader)).not.toContain('synthetic-config-secret-2f7a');
          expect(reader.env!['MISSING_VAR']).toBeUndefined();
        }
        expect(collectMcpEnvReferencedVars(config.externalMcpServers)).toEqual([
          'TEST_READER_ENDPOINT',
          'TEST_READER_SECRET',
        ]);
      } finally {
        delete process.env['TEST_READER_ENDPOINT'];
        delete process.env['TEST_READER_SECRET'];
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('extracts all MCP environment references and ignores plain values', () => {
      expect(mcpEnvReferencedVars('bolt://${NEO4J_HOST}:${NEO4J_PORT}')).toEqual(['NEO4J_HOST', 'NEO4J_PORT']);
      expect(mcpEnvReferencedVars('plain')).toEqual([]);
    });
  });

  describe('mcpEnvReferencedVars (SEC-016)', () => {
    it('extracts every reference and ignores plain values', () => {
      expect(mcpEnvReferencedVars('${EXA_API_KEY}')).toEqual(['EXA_API_KEY']);
      expect(mcpEnvReferencedVars('bolt://${NEO4J_HOST}:${NEO4J_PORT}')).toEqual(['NEO4J_HOST', 'NEO4J_PORT']);
      expect(mcpEnvReferencedVars('plain-value')).toEqual([]);
      expect(mcpEnvReferencedVars('$NOT_BRACED')).toEqual([]);
    });

    it('collects nothing from http servers or env-less stdio servers', () => {
      expect(
        collectMcpEnvReferencedVars({
          remote: { transport: 'http', url: 'http://example.test/mcp' },
          plain: { transport: 'stdio', command: 'npx', args: ['x'] },
        })
      ).toEqual([]);
    });
  });

  describe('resolveMcpBaseUrl (OPS-004 active-runtime authority)', () => {
    it('prefers the explicit env value over both YAML sources', () => {
      const resolved = resolveMcpBaseUrl('http://yaml-top/api/mcp', 'http://yaml-internal/api/mcp', {
        IMPULSE_MCP_BASE_URL: 'http://env/api/mcp',
      });
      expect(resolved).toBe('http://env/api/mcp');
    });

    it('falls back to the YAML top-level value when env is unset', () => {
      const resolved = resolveMcpBaseUrl('http://yaml-top/api/mcp', 'http://yaml-internal/api/mcp', {});
      expect(resolved).toBe('http://yaml-top/api/mcp');
    });

    it('falls back to the YAML internal base_url when only it is present', () => {
      const resolved = resolveMcpBaseUrl(undefined, 'http://yaml-internal/api/mcp', {});
      expect(resolved).toBe('http://yaml-internal/api/mcp');
    });

    it('falls back to the hard-coded default when nothing is set', () => {
      const resolved = resolveMcpBaseUrl(undefined, undefined, {});
      expect(resolved).toBe(DEFAULT_MCP_BASE_URL);
    });

    it('treats a whitespace-only env value as unset', () => {
      const resolved = resolveMcpBaseUrl('http://yaml-top/api/mcp', undefined, {
        IMPULSE_MCP_BASE_URL: '   ',
      });
      expect(resolved).toBe('http://yaml-top/api/mcp');
    });
  });

  describe('getMcpServerUrl', () => {
    it('should construct MCP server URLs', () => {
      const config = {
        ...DEFAULT_AGENT_CONFIG,
        mcpBaseUrl: 'http://localhost:9002/api/mcp',
      };
      const url = getMcpServerUrl(config, 'entities');
      expect(url).toBe('http://localhost:9002/api/mcp/entities');
    });

    it('should handle trailing slash in base URL', () => {
      const config = {
        ...DEFAULT_AGENT_CONFIG,
        mcpBaseUrl: 'http://localhost:9002/api/mcp/',
      };
      const url = getMcpServerUrl(config, 'research');
      expect(url).toBe('http://localhost:9002/api/mcp/research');
    });

    it('should handle different server names', () => {
      const config = { ...DEFAULT_AGENT_CONFIG };
      expect(getMcpServerUrl(config, 'entities')).toContain('/entities');
      expect(getMcpServerUrl(config, 'research')).toContain('/research');
      expect(getMcpServerUrl(config, 'signals')).toContain('/signals');
    });

    it('should strip impulse- prefix from internal MCP names', () => {
      const config = {
        ...DEFAULT_AGENT_CONFIG,
        mcpBaseUrl: 'http://localhost:9002/api/mcp',
      };
      expect(getMcpServerUrl(config, 'impulse-signals')).toBe('http://localhost:9002/api/mcp/signals');
      expect(getMcpServerUrl(config, 'impulse-entities')).toBe('http://localhost:9002/api/mcp/entities');
    });

    it('should not strip prefix from external MCP names', () => {
      const config = {
        ...DEFAULT_AGENT_CONFIG,
        mcpBaseUrl: 'http://localhost:9002/api/mcp',
      };
      expect(getMcpServerUrl(config, 'exa')).toBe('http://localhost:9002/api/mcp/exa');
      expect(getMcpServerUrl(config, 'custom-reader')).toBe('http://localhost:9002/api/mcp/custom-reader');
    });
  });

  describe('DEFAULT_AGENT_CONFIG', () => {
    it('should have all required fields', () => {
      expect(DEFAULT_AGENT_CONFIG.instance).toBeDefined();
      expect(DEFAULT_AGENT_CONFIG.budget).toBeDefined();
      expect(DEFAULT_AGENT_CONFIG.models).toBeDefined();
      expect(DEFAULT_AGENT_CONFIG.sweep).toBeDefined();
      expect(DEFAULT_AGENT_CONFIG.mcpBaseUrl).toBeDefined();
    });

    it('should have sensible default values', () => {
      expect(DEFAULT_AGENT_CONFIG.instance.name).toBe('Impulse');
      expect(DEFAULT_AGENT_CONFIG.budget.daily_limit).toBeGreaterThan(0);
      expect(DEFAULT_AGENT_CONFIG.budget.weekly_limit).toBeGreaterThan(DEFAULT_AGENT_CONFIG.budget.daily_limit);
      expect(DEFAULT_AGENT_CONFIG.budget.alert_threshold).toBeGreaterThan(0);
      expect(DEFAULT_AGENT_CONFIG.budget.alert_threshold).toBeLessThanOrEqual(1);
      expect(DEFAULT_AGENT_CONFIG.sweep.priorities.length).toBeGreaterThan(0);
    });
  });

  describe('resolveAgentMcpServers', () => {
    const makeGlobalExternal = () => ({
      'custom-reader': { transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg-a'] },
      'neo4j-memory': { transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg-b'] },
      filesystem: { transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg-d'] },
      exa: { transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg-e'], env: { EXA_API_KEY: 'test' } },
      firecrawl: { transport: 'stdio' as const, command: 'npx', args: ['-y', 'pkg-f'] },
    });

    it('should merge universal tier with per-agent MCPs', () => {
      const result = resolveAgentMcpServers(makeGlobalExternal(), {
        internal: ['impulse-signals'],
        external: ['exa'],
      });

      // Universal internal always present
      expect(result.internal).toContain('impulse-entities');
      expect(result.internal).toContain('impulse-graph');
      // Per-agent internal added
      expect(result.internal).toContain('impulse-signals');
      // Universal external always present
      expect(result.external).toHaveProperty('neo4j-memory');
      expect(result.external).toHaveProperty('filesystem');
      // Per-agent external added
      expect(result.external).toHaveProperty('exa');
      // NOT assigned external should be absent
      expect(result.external).not.toHaveProperty('firecrawl');
    });

    it('should deduplicate when per-agent includes universal servers', () => {
      const result = resolveAgentMcpServers(makeGlobalExternal(), {
        internal: ['impulse-entities', 'impulse-graph'],
        external: ['neo4j-memory'],
      });

      const entityCount = result.internal.filter((s) => s === 'impulse-entities').length;
      expect(entityCount).toBe(1);
    });

    it('should skip external servers not defined in global config', () => {
      const result = resolveAgentMcpServers(makeGlobalExternal(), {
        internal: [],
        external: ['nonexistent-server'],
      });

      expect(result.external).not.toHaveProperty('nonexistent-server');
      expect(result.httpFallback).not.toContain('nonexistent-server');
      // Universal external still present, but configured non-universal tools are not.
      expect(result.external).toHaveProperty('neo4j-memory');
      expect(result.external).not.toHaveProperty('custom-reader');
    });

    it('uses HTTP fallback only for a real in-tree platform route', () => {
      const result = resolveAgentMcpServers({}, {
        internal: [],
        external: ['exa', 'gemini-image'],
      });

      expect(result.external).toEqual({});
      expect(result.httpFallback).toEqual(['gemini-image']);
    });

    it('should return only universal MCPs when agent has empty declarations', () => {
      const result = resolveAgentMcpServers(makeGlobalExternal(), {
        internal: [],
        external: [],
      });

      expect(result.internal).toEqual(expect.arrayContaining([...UNIVERSAL_MCP_SERVERS.internal]));
      expect(result.internal).toHaveLength(UNIVERSAL_MCP_SERVERS.internal.length);
      expect(Object.keys(result.external)).toHaveLength(UNIVERSAL_MCP_SERVERS.external.length);
      expect(UNIVERSAL_MCP_SERVERS.external).not.toContain('neo4j-cypher');
      expect(result.external).not.toHaveProperty('neo4j-cypher');
    });

    it('should preserve env vars from global external config', () => {
      const result = resolveAgentMcpServers(makeGlobalExternal(), {
        internal: [],
        external: ['exa'],
      });

      const exa = result.external['exa'];
      expect(exa.transport).toBe('stdio');
      if (exa.transport === 'stdio') {
        expect(exa.env).toEqual({ EXA_API_KEY: 'test' });
      }
    });

    it('should include an arbitrary external server only when the agent explicitly requests it', () => {
      const result = resolveAgentMcpServers(makeGlobalExternal(), {
        internal: [],
        external: ['custom-reader'],
      });

      expect(result.external['custom-reader']).toEqual(expect.objectContaining({ transport: 'stdio', command: 'npx' }));
    });
  });
});
