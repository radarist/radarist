/**
 * Tests for unified config module (Task 0.9b)
 */

describe('Unified Config Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function loadConfig() {
    return require('../config').config;
  }

  function loadValidate() {
    return require('../config').validateConfigOrThrow;
  }

  // ── Mission Config ──────────────────────────────────────────

  describe('mission config', () => {
    it('should use defaults when no env vars set', () => {
      delete process.env.MISSION_TIMEOUT_MINUTES;
      delete process.env.IMPULSE_MISSION_TIMEOUT_MINUTES;
      const cfg = loadConfig();
      expect(cfg.mission.timeoutMinutes).toBe(30);
      expect(cfg.mission.tokenBudget).toBe(50000);
      expect(cfg.mission.maxToolCalls).toBe(100);
      // Mirrors the enforced $15 default in run-agent-mission.ts / profiles route.
      expect(cfg.mission.maxCostUsd).toBe(15.0);
      expect(cfg.mission.warnThreshold).toBe(0.8);
    });

    it('should read legacy unprefixed env vars', () => {
      process.env.MISSION_TIMEOUT_MINUTES = '60';
      process.env.MISSION_TOKEN_BUDGET = '100000';
      const cfg = loadConfig();
      expect(cfg.mission.timeoutMinutes).toBe(60);
      expect(cfg.mission.tokenBudget).toBe(100000);
    });

    it('should read IMPULSE_ prefixed alias', () => {
      process.env.IMPULSE_MISSION_TIMEOUT_MINUTES = '45';
      process.env.IMPULSE_MISSION_MAX_COST_USD = '8.25';
      process.env.IMPULSE_MISSION_TOKEN_BUDGET = '75000';
      process.env.IMPULSE_MISSION_MAX_TOOL_CALLS = '60';
      process.env.IMPULSE_MISSION_WARN_THRESHOLD = '0.65';
      const cfg = loadConfig();
      expect(cfg.mission.timeoutMinutes).toBe(45);
      expect(cfg.mission.maxCostUsd).toBe(8.25);
      expect(cfg.mission.tokenBudget).toBe(75000);
      expect(cfg.mission.maxToolCalls).toBe(60);
      expect(cfg.mission.warnThreshold).toBe(0.65);
    });

    it('should prefer primary over alias', () => {
      process.env.MISSION_TIMEOUT_MINUTES = '20';
      process.env.IMPULSE_MISSION_TIMEOUT_MINUTES = '40';
      const cfg = loadConfig();
      expect(cfg.mission.timeoutMinutes).toBe(20);
    });

    it('should parse floats for cost fields', () => {
      process.env.MISSION_MAX_COST_USD = '10.50';
      const cfg = loadConfig();
      expect(cfg.mission.maxCostUsd).toBe(10.5);
    });

    it('should fall back to default on invalid number', () => {
      process.env.MISSION_TIMEOUT_MINUTES = 'not-a-number';
      process.env.MISSION_MAX_COST_USD = '-1';
      process.env.MISSION_TOKEN_BUDGET = 'Infinity';
      process.env.MISSION_MAX_TOOL_CALLS = '0';
      process.env.MISSION_WARN_THRESHOLD = '2';
      const cfg = loadConfig();
      expect(cfg.mission.timeoutMinutes).toBe(30);
      expect(cfg.mission.maxCostUsd).toBe(15);
      expect(cfg.mission.tokenBudget).toBe(50000);
      expect(cfg.mission.maxToolCalls).toBe(100);
      expect(cfg.mission.warnThreshold).toBe(0.8);
    });
  });

  // ── Chat Config ──────────────────────────────────────────

  describe('chat config', () => {
    it('should have sensible defaults', () => {
      const cfg = loadConfig();
      expect(cfg.chat.maxBudgetUsd).toBe(0.5);
      // DISC-003: default 15 preserves the previously-hardcoded loop guard;
      // routeTimeoutSeconds was removed (never enforced — static maxDuration).
      expect(cfg.chat.maxToolCalls).toBe(15);
      expect(cfg.chat.parallelToolCalls).toBe(3);
      expect(cfg.chat).not.toHaveProperty('routeTimeoutSeconds');
    });

    it('should read IMPULSE_CHAT_MAX_TOOL_CALLS with the legacy CHAT_MAX_TOOL_ITERATIONS alias', () => {
      process.env.CHAT_MAX_TOOL_ITERATIONS = '9';
      let cfg = loadConfig();
      expect(cfg.chat.maxToolCalls).toBe(9);
      jest.resetModules(); // config is built at module init — re-require for the next read
      process.env.IMPULSE_CHAT_MAX_TOOL_CALLS = '21'; // primary wins over alias
      cfg = loadConfig();
      expect(cfg.chat.maxToolCalls).toBe(21);
      delete process.env.CHAT_MAX_TOOL_ITERATIONS;
      delete process.env.IMPULSE_CHAT_MAX_TOOL_CALLS;
    });

    it('should read AI_PARALLEL_TOOL_CALLS', () => {
      process.env.AI_PARALLEL_TOOL_CALLS = '5';
      const cfg = loadConfig();
      expect(cfg.chat.parallelToolCalls).toBe(5);
    });
  });

  // ── Models / Delegation Config (removed — DISC-003) ─────────────────────

  describe('removed dead config blocks (DISC-003)', () => {
    it('no longer mints config.models or config.delegation (they had zero consumers)', () => {
      const cfg = loadConfig() as Record<string, unknown>;
      expect(cfg).not.toHaveProperty('models');
      expect(cfg).not.toHaveProperty('delegation');
    });
  });

  // ── Flags Config ──────────────────────────────────────────

  describe('flags config', () => {
    it('should default claudeChatEnabled to false', () => {
      const cfg = loadConfig();
      expect(cfg.flags.claudeChatEnabled).toBe(false);
    });

    it('should default graphSyncEnabled to true', () => {
      const cfg = loadConfig();
      expect(cfg.flags.graphSyncEnabled).toBe(true);
    });

    it('should parse boolean from string "true"', () => {
      process.env.CLAUDE_CHAT_ENABLED = 'true';
      const cfg = loadConfig();
      expect(cfg.flags.claudeChatEnabled).toBe(true);
    });

    it('should parse boolean from string "false"', () => {
      process.env.GRAPH_SYNC_ENABLED = 'false';
      const cfg = loadConfig();
      expect(cfg.flags.graphSyncEnabled).toBe(false);
    });

    it('should treat non-"true" strings as false', () => {
      process.env.CLAUDE_CHAT_ENABLED = 'yes';
      const cfg = loadConfig();
      expect(cfg.flags.claudeChatEnabled).toBe(false);
    });

    it('should read IMPULSE_ alias for flags', () => {
      process.env.IMPULSE_SIGNAL_AUTOPILOT_ENABLED = 'true';
      const cfg = loadConfig();
      expect(cfg.flags.signalAutopilotEnabled).toBe(true);
    });

    it('should default autopilot flags to false', () => {
      const cfg = loadConfig();
      expect(cfg.flags.signalAutopilotEnabled).toBe(false);
      expect(cfg.flags.linkerAutopilotEnabled).toBe(false);
    });

    it('confidenceScale100Enabled defaults to true', () => {
      delete process.env.CONFIDENCE_SCALE_100_ENABLED;
      delete process.env.IMPULSE_CONFIDENCE_SCALE_100_ENABLED;
      expect(loadConfig().flags.confidenceScale100Enabled).toBe(true);
    });

    it('confidenceScale100Enabled honours CONFIDENCE_SCALE_100_ENABLED=false', () => {
      process.env.CONFIDENCE_SCALE_100_ENABLED = 'false';
      expect(loadConfig().flags.confidenceScale100Enabled).toBe(false);
    });

    it('confidenceScale100Enabled reads the IMPULSE_ alias', () => {
      delete process.env.CONFIDENCE_SCALE_100_ENABLED;
      process.env.IMPULSE_CONFIDENCE_SCALE_100_ENABLED = 'false';
      expect(loadConfig().flags.confidenceScale100Enabled).toBe(false);
    });
  });

  // ── Thresholds Config ──────────────────────────────────────────

  describe('thresholds config', () => {
    it('should have correct defaults', () => {
      const cfg = loadConfig();
      expect(cfg.thresholds.signalAutoApprove).toBe(85);
      expect(cfg.thresholds.linkerAutoApprove).toBe(75);
    });

    it('should read override from env', () => {
      process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = '90';
      const cfg = loadConfig();
      expect(cfg.thresholds.signalAutoApprove).toBe(90);
    });

    it.each(['-1', '0.5', '85x', '', '101'])('fails closed for invalid signal threshold %j', (value) => {
      process.env.SIGNAL_AUTO_APPROVE_THRESHOLD = value;
      const cfg = loadConfig();
      expect(cfg.thresholds.signalAutoApprove).toBeNull();
    });
  });

  // ── AI Config ──────────────────────────────────────────

  describe('ai config', () => {
    it('should have correct defaults matching the enforced reliability values (DISC-001)', () => {
      const cfg = loadConfig();
      expect(cfg.ai.rateLimitRpm).toBe(30);
      // 10, not 25: the default now matches what reliability.ts always enforced.
      expect(cfg.ai.dailyBudgetUsd).toBe(10);
      // maxToolLoops moved to chat.maxToolCalls (single knob, DISC-003).
      expect(cfg.ai).not.toHaveProperty('maxToolLoops');
    });

    it('should read AI_DAILY_BUDGET_USD and AI_RATE_LIMIT_RPM', () => {
      process.env.AI_DAILY_BUDGET_USD = '42';
      process.env.AI_RATE_LIMIT_RPM = '7';
      const cfg = loadConfig();
      expect(cfg.ai.dailyBudgetUsd).toBe(42);
      expect(cfg.ai.rateLimitRpm).toBe(7);
      delete process.env.AI_DAILY_BUDGET_USD;
      delete process.env.AI_RATE_LIMIT_RPM;
    });
  });

  // ── MCP Config ──────────────────────────────────────────

  describe('mcp config', () => {
    it('should have correct default error threshold', () => {
      const cfg = loadConfig();
      expect(cfg.mcp.errorWarnThreshold).toBe(3);
    });
  });

  // ── Auth Config ──────────────────────────────────────────

  describe('auth config', () => {
    it('should read IMPULSE_INTERNAL_KEY', () => {
      process.env.IMPULSE_INTERNAL_KEY = 'test-key-123';
      const cfg = loadConfig();
      expect(cfg.auth.internalKey).toBe('test-key-123');
    });

    it('should be undefined when not set', () => {
      delete process.env.IMPULSE_INTERNAL_KEY;
      const cfg = loadConfig();
      expect(cfg.auth.internalKey).toBeUndefined();
    });
  });

  // ── Validation ──────────────────────────────────────────

  describe('validateConfigOrThrow', () => {
    it('should not throw when required vars are present', () => {
      process.env.GOOGLE_API_KEY = 'test';
      const validate = loadValidate();
      expect(() => validate()).not.toThrow();
    });

    it('should not throw when GEMINI_API_KEY alias is set', () => {
      delete process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = 'test';
      const validate = loadValidate();
      expect(() => validate()).not.toThrow();
    });

    it('should throw when required vars are missing', () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;
      const validate = loadValidate();
      expect(() => validate()).toThrow('Missing required env vars');
    });
  });
});
