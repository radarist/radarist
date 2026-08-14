import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { loadAgentProfile, loadAllProfiles, listAgents } from '../src/profiles';
import type { AgentProfile } from '../src/profiles';

// Resolve the real agents directory relative to this test file (ESM-compatible)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENTS_DIR = path.resolve(__dirname, '..', 'agents');

describe('AgentProfileLoader', () => {
  describe('loadAgentProfile', () => {
    it('should load a single agent profile', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'scout');

      expect(profile.name).toBe('scout');
      expect(profile.description).toContain('Discovers');
      expect(profile.prompt).toContain('Curious Explorer');
      expect(profile.model).toBe('claude-sonnet-4-6');
      expect(profile.budget.max_tokens).toBeGreaterThan(0);
      expect(profile.budget.max_tokens).toBe(30000);
      expect(profile.budget.max_tool_calls).toBe(50);
      expect(profile.mcp_servers.internal).toContain('impulse-signals');
      expect(profile.mcp_servers.external).toContain('exa');
      expect(profile.mcp_servers.external).toContain('firecrawl');
    });

    it('should return the full PROFILE.md content as prompt', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'scout');

      expect(profile.prompt).toContain('# Scout');
      expect(profile.prompt).toContain('## Personality');
      expect(profile.prompt).toContain('## Values');
      expect(profile.prompt).toContain('## Communication Style');
      expect(profile.prompt).toContain('## Working with Others');
      expect(profile.prompt).toContain('## Domain Expertise');
    });

    it('should throw for missing agent directory', () => {
      expect(() => loadAgentProfile(AGENTS_DIR, 'nonexistent')).toThrow(/Agent directory not found/);
    });

    it('should throw for missing PROFILE.md', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'broken');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'name: broken\n');

      try {
        expect(() => loadAgentProfile(tmpDir, 'broken')).toThrow(/PROFILE\.md not found/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw for missing config.yaml', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'broken');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Broken');

      try {
        expect(() => loadAgentProfile(tmpDir, 'broken')).toThrow(/config\.yaml not found/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw for invalid YAML in config.yaml', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'bad-yaml');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Bad');
      // Unbalanced quotes cause a YAML parse error
      fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'name: "unterminated');

      try {
        expect(() => loadAgentProfile(tmpDir, 'bad-yaml')).toThrow(/Failed to parse config\.yaml|Invalid config\.yaml/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should throw for config.yaml that fails Zod validation', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'invalid');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Invalid');
      // Missing required fields
      fs.writeFileSync(path.join(agentDir, 'config.yaml'), 'name: invalid\ndescription: "test"\n');

      try {
        expect(() => loadAgentProfile(tmpDir, 'invalid')).toThrow(/Invalid config\.yaml/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should reject negative budget values', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'neg-budget');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Negative');
      fs.writeFileSync(
        path.join(agentDir, 'config.yaml'),
        [
          'name: neg-budget',
          'description: "test agent"',
          'model: claude-sonnet-4-6',
          'budget:',
          '  max_tokens: -100',
          '  max_tool_calls: 10',
          'mcp_servers:',
          '  internal:',
          '    - test-server',
        ].join('\n')
      );

      try {
        expect(() => loadAgentProfile(tmpDir, 'neg-budget')).toThrow(/Invalid config\.yaml/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should accept config with both internal and external mcp_servers', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'mixed');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Mixed');
      fs.writeFileSync(
        path.join(agentDir, 'config.yaml'),
        [
          'name: mixed',
          'description: "mixed mcp agent"',
          'model: claude-sonnet-4-6',
          'budget:',
          '  max_tokens: 1000',
          '  max_tool_calls: 10',
          'mcp_servers:',
          '  internal:',
          '    - impulse-signals',
          '  external:',
          '    - exa',
          '    - firecrawl',
        ].join('\n')
      );

      try {
        const profile = loadAgentProfile(tmpDir, 'mixed');
        expect(profile.mcp_servers.internal).toEqual(['impulse-signals']);
        expect(profile.mcp_servers.external).toEqual(['exa', 'firecrawl']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should load timeoutMinutes when set in config.yaml', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'long-running');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Long');
      fs.writeFileSync(
        path.join(agentDir, 'config.yaml'),
        [
          'name: long-running',
          'description: "opt-in long timeout"',
          'model: claude-sonnet-4-6',
          'budget:',
          '  max_tokens: 1000',
          '  max_tool_calls: 10',
          'mcp_servers:',
          '  internal:',
          '    - impulse-signals',
          'timeoutMinutes: 90',
        ].join('\n')
      );

      try {
        const profile = loadAgentProfile(tmpDir, 'long-running');
        expect(profile.timeoutMinutes).toBe(90);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should leave timeoutMinutes undefined when not set', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'scout');
      // scout does not declare timeoutMinutes — expect undefined so handler falls back to env default
      expect(profile.timeoutMinutes).toBeUndefined();
    });

    it('should reject timeoutMinutes > 120', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      const agentDir = path.join(tmpDir, 'too-long');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(path.join(agentDir, 'PROFILE.md'), '# Too long');
      fs.writeFileSync(
        path.join(agentDir, 'config.yaml'),
        [
          'name: too-long',
          'description: "tries to run for 6 hours"',
          'model: claude-sonnet-4-6',
          'budget:',
          '  max_tokens: 1000',
          '  max_tool_calls: 10',
          'mcp_servers:',
          '  internal:',
          '    - impulse-signals',
          'timeoutMinutes: 360',
        ].join('\n')
      );

      try {
        expect(() => loadAgentProfile(tmpDir, 'too-long')).toThrow(/Invalid config\.yaml/);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should load timeoutMinutes from the creator agent (opted-in to 90)', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'creator');
      expect(profile.timeoutMinutes).toBe(90);
    });

    it('keeps the Creator profile mode-neutral and defaults missing mode instructions to legacy HTML', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'creator');

      expect(profile.prompt).toContain('If the instruction is absent');
      expect(profile.prompt).toContain('the mode is `legacy`');
      expect(profile.prompt).toContain('Provide `draftReport({ slotName, title, html, figurePlan })`');
      expect(profile.prompt).toContain('Do not send `blocks`');
      expect(profile.prompt).not.toContain('template mode — PREFERRED');
      expect(profile.prompt).not.toContain('no draft after a blocks draft succeeded');
    });

    it('requires formal output-skill calls and material cite/design evidence', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'creator');

      expect(profile.prompt).toContain('A formal call means an actual');
      expect(profile.prompt).toContain('`Skill({ skill: "..." })` tool invocation');
      expect(profile.prompt).toContain('Never call an explicitly');
      expect(profile.prompt).toContain('`N/A`');
      expect(profile.prompt).toContain('Skill({ skill: "cite-ieee" })');
      expect(profile.prompt).toContain('href="#ref-1"');
      expect(profile.prompt).toContain('Skill({ skill: "design-pass" })');
      expect(profile.prompt).toContain('Design review: PASS|FAIL');
      expect(profile.prompt).toContain('never add the verdict as');
      expect(profile.prompt).toContain('reader-facing report boilerplate');
      expect(profile.prompt).toContain('full `exportSha256`');
      expect(profile.prompt).toContain('scenarios as a comparison table or matrix with signposts');
    });

    it('should load timeoutMinutes from the strategist agent (opted-in to 90)', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'strategist');
      expect(profile.timeoutMinutes).toBe(90);
    });

    it('should use claude-opus-4-8 for the strategist agent', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'strategist');
      expect(profile.model).toBe('claude-opus-4-8');
    });

    it('should use claude-haiku-4-5 for the curator agent', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'curator');
      expect(profile.model).toBe('claude-haiku-4-5');
    });
  });

  describe('per-agent model env override', () => {
    const OVERRIDE_VARS = [
      'IMPULSE_AGENT_SCOUT_MODEL',
      'IMPULSE_AGENT_STRATEGIST_MODEL',
      'IMPULSE_AGENT_DEFENSE_MINISTER_MODEL',
    ];

    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const v of OVERRIDE_VARS) {
        saved[v] = process.env[v];
        delete process.env[v];
      }
    });

    afterEach(() => {
      for (const v of OVERRIDE_VARS) {
        if (saved[v] === undefined) {
          delete process.env[v];
        } else {
          process.env[v] = saved[v];
        }
      }
    });

    it('should override the config.yaml model from IMPULSE_AGENT_<NAME>_MODEL', () => {
      // Sanity: without the override, scout uses its config.yaml model.
      const baseline = loadAgentProfile(AGENTS_DIR, 'scout');
      expect(baseline.model).toBe('claude-sonnet-4-6');

      process.env['IMPULSE_AGENT_SCOUT_MODEL'] = 'claude-opus-4-8';
      const overridden = loadAgentProfile(AGENTS_DIR, 'scout');
      expect(overridden.model).toBe('claude-opus-4-8');
    });

    it('should derive the env var name with hyphen→underscore for multi-word agents', () => {
      process.env['IMPULSE_AGENT_DEFENSE_MINISTER_MODEL'] = 'claude-sonnet-4-6';
      const profile = loadAgentProfile(AGENTS_DIR, 'defense-minister');
      expect(profile.model).toBe('claude-sonnet-4-6');
    });

    it('should fall back to config.yaml when the override is empty/whitespace', () => {
      process.env['IMPULSE_AGENT_STRATEGIST_MODEL'] = '   ';
      const profile = loadAgentProfile(AGENTS_DIR, 'strategist');
      expect(profile.model).toBe('claude-opus-4-8');
    });

    it('should fall back to config.yaml when the override is unset', () => {
      const profile = loadAgentProfile(AGENTS_DIR, 'strategist');
      expect(profile.model).toBe('claude-opus-4-8');
    });
  });

  describe('listAgents', () => {
    it('should list available agents', () => {
      const agents = listAgents(AGENTS_DIR);
      expect(agents).toContain('scout');
    });

    it('should return empty array for nonexistent directory', () => {
      const agents = listAgents('/nonexistent/agents/dir');
      expect(agents).toEqual([]);
    });

    it('should ignore directories without required files', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      // Create a directory without PROFILE.md or config.yaml
      fs.mkdirSync(path.join(tmpDir, 'incomplete'));
      // Create a valid agent
      const validDir = path.join(tmpDir, 'valid');
      fs.mkdirSync(validDir);
      fs.writeFileSync(path.join(validDir, 'PROFILE.md'), '# Valid');
      fs.writeFileSync(
        path.join(validDir, 'config.yaml'),
        [
          'name: valid',
          'description: "valid agent"',
          'model: claude-sonnet-4-6',
          'budget:',
          '  max_tokens: 1000',
          '  max_tool_calls: 10',
          'mcp_servers:',
          '  internal:',
          '    - test-server',
        ].join('\n')
      );

      try {
        const agents = listAgents(tmpDir);
        expect(agents).toContain('valid');
        expect(agents).not.toContain('incomplete');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should ignore files (non-directories) in agents dir', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
      fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Agents');

      try {
        const agents = listAgents(tmpDir);
        expect(agents).toEqual([]);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('should return agent names sorted alphabetically', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));

      for (const name of ['zebra', 'alpha', 'middle']) {
        const dir = path.join(tmpDir, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'PROFILE.md'), `# ${name}`);
        fs.writeFileSync(
          path.join(dir, 'config.yaml'),
          [
            `name: ${name}`,
            `description: "${name} agent"`,
            'model: claude-sonnet-4-6',
            'budget:',
            '  max_tokens: 1000',
            '  max_tool_calls: 10',
            'mcp_servers:',
            '  internal:',
            '    - test-server',
          ].join('\n')
        );
      }

      try {
        const agents = listAgents(tmpDir);
        expect(agents).toEqual(['alpha', 'middle', 'zebra']);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('loadAllProfiles', () => {
    it('should load all profiles', () => {
      const profiles = loadAllProfiles(AGENTS_DIR);
      expect(profiles.size).toBeGreaterThan(0);
      expect(profiles.get('scout')).toBeDefined();
    });

    it('should return AgentProfile objects with correct shape', () => {
      const profiles = loadAllProfiles(AGENTS_DIR);
      const scout = profiles.get('scout') as AgentProfile;

      expect(scout).toEqual(
        expect.objectContaining({
          name: 'scout',
          model: expect.any(String),
          prompt: expect.any(String),
          description: expect.any(String),
          budget: expect.objectContaining({
            max_tokens: expect.any(Number),
            max_tool_calls: expect.any(Number),
          }),
          mcp_servers: expect.objectContaining({
            internal: expect.any(Array),
            external: expect.any(Array),
          }),
        })
      );
    });

    it('should return empty map for nonexistent directory', () => {
      const profiles = loadAllProfiles('/nonexistent/agents/dir');
      expect(profiles.size).toBe(0);
    });

    it('should load multiple agents', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));

      for (const name of ['agent-a', 'agent-b']) {
        const dir = path.join(tmpDir, name);
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'PROFILE.md'), `# ${name}`);
        fs.writeFileSync(
          path.join(dir, 'config.yaml'),
          [
            `name: ${name}`,
            `description: "${name} agent"`,
            'model: claude-sonnet-4-6',
            'budget:',
            '  max_tokens: 1000',
            '  max_tool_calls: 10',
            'mcp_servers:',
            '  internal:',
            '    - test-server',
          ].join('\n')
        );
      }

      try {
        const profiles = loadAllProfiles(tmpDir);
        expect(profiles.size).toBe(2);
        expect(profiles.get('agent-a')).toBeDefined();
        expect(profiles.get('agent-b')).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
