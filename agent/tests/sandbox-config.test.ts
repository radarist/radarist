/** BuildConfig precedence: env > impulse.config.yaml build: > defaults. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fullImageName, loadBuildConfig } from '../src/sandbox/config.js';

describe('loadBuildConfig — unsupported sandbox driver (BUILD-010 / AUDIT-011)', () => {
  // `apple-container` was an accepted config value with no implementation behind
  // it: every driver method rejected NOT_IMPLEMENTED. Selecting it passed
  // validation, the mission was marked `running` and `agent.started` was
  // emitted, and only THEN the provisioner refused. The value is now gone from
  // the enum, so it is rejected here — inside `load-and-validate`, which is the
  // last step before the mission is announced as running.
  it('refuses an unimplemented driver at config load, not after the mission is running', () => {
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_SANDBOX_DRIVER: 'apple-container' } })).toThrow(
      /Unsupported sandbox driver/
    );
  });

  it('names the env var and the supported values, so the operator knows what to do', () => {
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_SANDBOX_DRIVER: 'firecracker' } })).toThrow(
      /IMPULSE_BUILD_SANDBOX_DRIVER must be one of: docker/
    );
  });

  it('still accepts the one driver that exists', () => {
    expect(loadBuildConfig({ env: { IMPULSE_BUILD_SANDBOX_DRIVER: 'docker' } }).driver).toBe('docker');
  });
});

describe('loadBuildConfig', () => {
  it('produces the documented defaults from an empty environment', () => {
    const cfg = loadBuildConfig({ env: {} });
    expect(cfg.enabled).toBe(false);
    expect(cfg.driver).toBe('docker');
    expect(fullImageName(cfg)).toBe('radarist-build-sandbox:v2');
    expect(cfg.cpus).toBe(2);
    expect(cfg.memoryGb).toBe(4);
    expect(cfg.pidsLimit).toBe(512);
    expect([cfg.portRangeStart, cfg.portRangeEnd]).toEqual([4100, 4199]);
    expect(cfg.sessions).toEqual({ max: 8, maxTurns: 80, maxMinutes: 30, maxCostUsd: 6, maxOutputTokens: 64000 });
    expect(cfg.budget).toEqual({ missionCapUsd: 25, warnThreshold: 0.8 });
    expect(cfg.gates).toEqual({ timeoutHours: 24, approvalTimeoutHours: 72 });
    // Defaults must be API-available model IDs (the in-sandbox CLI hits the raw
    // Anthropic API). claude-fable-5 — the host CLI default — 404s there, so it
    // must never be a default; override per stage via IMPULSE_BUILD_MODEL_*.
    expect(cfg.models).toEqual({
      plan: 'claude-sonnet-4-6',
      build: 'claude-sonnet-4-6',
      qa: 'claude-sonnet-4-6',
      escalation: 'claude-opus-4-8',
    });
    expect(cfg.mcp.hostBaseUrl).toBe('http://host.docker.internal:9002/api/mcp');
    expect(cfg.mcp.platformServers).toEqual([]);
    expect(cfg.mcp.evalPlatformServers).toEqual([]); // S: evals get no platform key by default
    expect(cfg.mcp.enableWeb).toBe(false);
    expect(cfg.cloneAllowlist).toContain('github.com');
    expect(cfg.envAllowlist).toEqual(['ANTHROPIC_API_KEY']);
    expect(cfg.poll).toEqual({ watchSeconds: 60, intervalSeconds: 5 });
    expect(cfg.stall).toEqual({ escalateAfter: 2, pauseAfter: 3 });
    expect(cfg.qaMaxAttempts).toBe(1);
    expect(cfg.concurrency).toBe(1);
    expect(cfg.keepAliveMinutes).toBe(240);
    expect(cfg.gcThresholdHours).toBe(96);
  });

  it('coerces an empty/whitespace model override back to the safe default (never --model "")', () => {
    // A blank `IMPULSE_BUILD_MODEL_PLAN=` in .env must NOT pass '' through to
    // `claude -p --model ''` (the CLI would fall back to its host default
    // claude-fable-5 → 404). It must resolve to the schema default instead.
    const cfg = loadBuildConfig({
      env: {
        IMPULSE_BUILD_MODEL_PLAN: '', // blank
        IMPULSE_BUILD_MODEL_QA: '   ', // whitespace
        IMPULSE_BUILD_MODEL_BUILD: 'claude-opus-4-8', // a real override still wins
      },
    });
    expect(cfg.models.plan).toBe('claude-sonnet-4-6'); // default, not ''
    expect(cfg.models.qa).toBe('claude-sonnet-4-6'); // default, not whitespace
    expect(cfg.models.build).toBe('claude-opus-4-8'); // explicit override respected
    expect(cfg.models.escalation).toBe('claude-opus-4-8'); // untouched default
  });

  it('parses env overrides with correct types (num/int/bool/csv)', () => {
    const cfg = loadBuildConfig({
      env: {
        IMPULSE_BUILD_ENABLED: 'true',
        IMPULSE_BUILD_SESSION_MAX_COST_USD: '9.5',
        IMPULSE_BUILD_SANDBOX_PIDS_LIMIT: '768',
        IMPULSE_BUILD_MAX_SESSIONS: '4',
        IMPULSE_BUILD_PLATFORM_MCP: 'entities, reports',
        IMPULSE_BUILD_ENABLE_WEB_MCP: '1',
        IMPULSE_BUILD_MODEL_BUILD: 'claude-opus-4-8',
      },
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.sessions.maxCostUsd).toBe(9.5);
    expect(cfg.pidsLimit).toBe(768);
    expect(cfg.sessions.max).toBe(4);
    expect(cfg.sessions.maxTurns).toBe(80); // untouched sibling keeps default
    expect(cfg.mcp.platformServers).toEqual(['entities', 'reports']);
    expect(cfg.mcp.enableWeb).toBe(true);
    expect(cfg.models.build).toBe('claude-opus-4-8');
  });

  it('rejects unsafe or unbounded sandbox PID limits', () => {
    for (const pidsLimit of ['0', '63', '512.5', '4097', 'Infinity', 'not-a-number']) {
      expect(() =>
        loadBuildConfig({ env: { IMPULSE_BUILD_SANDBOX_PIDS_LIMIT: pidsLimit } })
      ).toThrow();
    }
  });

  // BUILD-015/020 — the output-token ceiling is env-overridable within the CLI cap.
  it('parses the output-token override and defaults it to the CLI cap of 64000', () => {
    expect(loadBuildConfig({ env: {} }).sessions.maxOutputTokens).toBe(64000);
    const cfg = loadBuildConfig({ env: { IMPULSE_BUILD_SESSION_MAX_OUTPUT_TOKENS: '48000' } });
    expect(cfg.sessions.maxOutputTokens).toBe(48000);
  });

  // The premium tier is one Opus builder plus a fresh-context Opus reviewer.
  it('defaults Limitless to an Opus builder + reviewer under one bounded cap', () => {
    const { limitless } = loadBuildConfig({ env: {} });
    expect(limitless).toEqual({
      buildModel: 'claude-opus-4-8',
      qaModel: 'claude-opus-4-8',
      escalationModel: 'claude-opus-4-8',
      maxTurns: 160,
      maxMinutes: 120,
      maxSessions: 2,
      missionCapUsd: 50,
      sessionMaxCostUsd: 40,
      reviewerMaxCostUsd: 10,
      effort: 'max',
      escalationEffort: 'max',
      useGoal: false,
    });
  });

  it('accepts every Limitless env override', () => {
    const cfg = loadBuildConfig({
      env: {
        IMPULSE_BUILD_LIMITLESS_MODEL_BUILD: 'env-build-model',
        IMPULSE_BUILD_LIMITLESS_MODEL_QA: 'env-qa-model',
        IMPULSE_BUILD_LIMITLESS_MODEL_ESCALATION: 'env-escalation-model',
        IMPULSE_BUILD_LIMITLESS_EFFORT: 'xhigh',
        IMPULSE_BUILD_LIMITLESS_ESCALATION_EFFORT: 'high',
        IMPULSE_BUILD_LIMITLESS_MAX_TURNS: '200',
        IMPULSE_BUILD_LIMITLESS_MAX_MINUTES: '90',
        IMPULSE_BUILD_LIMITLESS_MAX_SESSIONS: '2',
        IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD: '75',
        IMPULSE_BUILD_LIMITLESS_SESSION_MAX_COST_USD: '50',
        IMPULSE_BUILD_LIMITLESS_REVIEWER_MAX_COST_USD: '20',
        IMPULSE_BUILD_LIMITLESS_USE_GOAL: 'true',
      },
    });
    expect(cfg.limitless).toEqual({
      buildModel: 'env-build-model',
      qaModel: 'env-qa-model',
      escalationModel: 'env-escalation-model',
      maxTurns: 200,
      maxMinutes: 90,
      maxSessions: 2,
      missionCapUsd: 75,
      sessionMaxCostUsd: 50,
      reviewerMaxCostUsd: 20,
      effort: 'xhigh',
      escalationEffort: 'high',
      useGoal: true,
    });
  });

  it('keeps the Limitless wall clock positive and bounded', () => {
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_LIMITLESS_MAX_MINUTES: '0' } })).toThrow();
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_LIMITLESS_MAX_MINUTES: '241' } })).toThrow(
      /cannot exceed 240/
    );
  });

  it('Limitless defaults to one builder plus one fresh reviewer within $50', () => {
    const cfg = loadBuildConfig({ env: {} });
    expect(cfg.limitless.maxSessions).toBe(2);
    expect(cfg.limitless.missionCapUsd).toBe(50);
    expect(cfg.limitless.sessionMaxCostUsd).toBe(40);
    expect(cfg.limitless.reviewerMaxCostUsd).toBe(10);
    expect(cfg.limitless.useGoal).toBe(false);
    expect(cfg.limitless.effort).toBe('max');
  });

  it('refuses a Limitless configuration with no fresh-reviewer slot', () => {
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_LIMITLESS_MAX_SESSIONS: '1' } })).toThrow();
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_LIMITLESS_MAX_SESSIONS: '2.5' } })).toThrow();
  });

  it('refuses a Limitless configuration whose builder and reviewer caps exceed the mission cap', () => {
    expect(() =>
      loadBuildConfig({
        env: {
          IMPULSE_BUILD_LIMITLESS_SESSION_MAX_COST_USD: '45',
          IMPULSE_BUILD_LIMITLESS_REVIEWER_MAX_COST_USD: '10',
        },
      })
    ).toThrow(/must fit inside missionCapUsd/);
  });

  it('IMPULSE_BUILD_LIMITLESS_USE_GOAL=false disables the goal kickoff', () => {
    const cfg = loadBuildConfig({ env: { IMPULSE_BUILD_LIMITLESS_USE_GOAL: 'false' } });
    expect(cfg.limitless.useGoal).toBe(false);
  });

  it('platform MCP is empty by default and remains an explicit opt-in', () => {
    expect(loadBuildConfig({ env: {} }).mcp.platformServers).toEqual([]);
    expect(loadBuildConfig({ env: { IMPULSE_BUILD_PLATFORM_MCP: 'entities,reports' } }).mcp.platformServers).toEqual([
      'entities',
      'reports',
    ]);
  });

  it('standard tier is unchanged by the limitless redefinition', () => {
    const cfg = loadBuildConfig({ env: {} });
    expect(cfg.sessions.max).toBe(8);
    expect(cfg.sessions.maxTurns).toBe(80);
    expect(cfg.budget.missionCapUsd).toBe(25);
  });

  it('rejects an output-token ceiling above the Claude Code CLI hard cap of 64000', () => {
    // Guards against the stale "128000" recommendation: the CLI caps/errors on
    // values past 64000 regardless of the model's larger API ceiling, so config
    // load fails loudly rather than reproducing that mid-mission CLI error.
    expect(() => loadBuildConfig({ env: { IMPULSE_BUILD_SESSION_MAX_OUTPUT_TOKENS: '128000' } })).toThrow();
  });

  it('reads the yaml build: section and lets env win over it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const yamlPath = path.join(dir, 'impulse.config.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'build:',
        "  image: 'custom-img:v9'",
        '  resources: { cpus: 8, memory_gb: 16 }',
        '  pids_limit: 1024',
        '  sessions: { max_turns: 40 }',
        '  limitless: { max_minutes: 75 }',
        "  models: { build: 'claude-haiku-4-5' }",
      ].join('\n')
    );
    const cfg = loadBuildConfig({ env: { IMPULSE_BUILD_SANDBOX_CPUS: '3' }, yamlPath });
    expect(fullImageName(cfg)).toBe('custom-img:v9');
    expect(cfg.cpus).toBe(3); // env beats yaml
    expect(cfg.memoryGb).toBe(16); // yaml beats default
    expect(cfg.pidsLimit).toBe(1024);
    expect(cfg.sessions.maxTurns).toBe(40);
    expect(cfg.limitless.maxMinutes).toBe(75);
    expect(cfg.models.build).toBe('claude-haiku-4-5');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps every snake_case build.limitless yaml field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const yamlPath = path.join(dir, 'impulse.config.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'build:',
        '  limitless:',
        "    build_model: 'yaml-build-model'",
        "    qa_model: 'yaml-qa-model'",
        "    escalation_model: 'yaml-escalation-model'",
        '    max_turns: 220',
        '    max_minutes: 180',
        '    max_sessions: 2',
        '    mission_cap_usd: 80',
        '    session_max_cost_usd: 55',
        '    reviewer_max_cost_usd: 20',
        '    effort: high',
        '    escalation_effort: xhigh',
        '    use_goal: true',
      ].join('\n')
    );

    expect(loadBuildConfig({ env: {}, yamlPath }).limitless).toEqual({
      buildModel: 'yaml-build-model',
      qaModel: 'yaml-qa-model',
      escalationModel: 'yaml-escalation-model',
      maxTurns: 220,
      maxMinutes: 180,
      maxSessions: 2,
      missionCapUsd: 80,
      sessionMaxCostUsd: 55,
      reviewerMaxCostUsd: 20,
      effort: 'high',
      escalationEffort: 'xhigh',
      useGoal: true,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets env override every build.limitless yaml field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const yamlPath = path.join(dir, 'impulse.config.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'build:',
        '  limitless:',
        "    build_model: 'yaml-build-model'",
        "    qa_model: 'yaml-qa-model'",
        "    escalation_model: 'yaml-escalation-model'",
        '    max_turns: 170',
        '    max_minutes: 80',
        '    max_sessions: 2',
        '    mission_cap_usd: 60',
        '    session_max_cost_usd: 40',
        '    reviewer_max_cost_usd: 15',
        '    effort: low',
        '    escalation_effort: medium',
        '    use_goal: true',
      ].join('\n')
    );
    const cfg = loadBuildConfig({
      yamlPath,
      env: {
        IMPULSE_BUILD_LIMITLESS_MODEL_BUILD: 'env-build-model',
        IMPULSE_BUILD_LIMITLESS_MODEL_QA: 'env-qa-model',
        IMPULSE_BUILD_LIMITLESS_MODEL_ESCALATION: 'env-escalation-model',
        IMPULSE_BUILD_LIMITLESS_MAX_TURNS: '230',
        IMPULSE_BUILD_LIMITLESS_MAX_MINUTES: '200',
        IMPULSE_BUILD_LIMITLESS_MAX_SESSIONS: '2',
        IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD: '90',
        IMPULSE_BUILD_LIMITLESS_SESSION_MAX_COST_USD: '60',
        IMPULSE_BUILD_LIMITLESS_REVIEWER_MAX_COST_USD: '25',
        IMPULSE_BUILD_LIMITLESS_EFFORT: 'max',
        IMPULSE_BUILD_LIMITLESS_ESCALATION_EFFORT: 'xhigh',
        IMPULSE_BUILD_LIMITLESS_USE_GOAL: 'false',
      },
    });

    expect(cfg.limitless).toEqual({
      buildModel: 'env-build-model',
      qaModel: 'env-qa-model',
      escalationModel: 'env-escalation-model',
      maxTurns: 230,
      maxMinutes: 200,
      maxSessions: 2,
      missionCapUsd: 90,
      sessionMaxCostUsd: 60,
      reviewerMaxCostUsd: 25,
      effort: 'max',
      escalationEffort: 'xhigh',
      useGoal: false,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enforces the two-session invariant for build.limitless yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const yamlPath = path.join(dir, 'impulse.config.yaml');
    fs.writeFileSync(yamlPath, ['build:', '  limitless:', '    max_sessions: 3'].join('\n'));
    expect(() => loadBuildConfig({ env: {}, yamlPath })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('strictly rejects invalid build.limitless yaml types and enum values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const modelPath = path.join(dir, 'invalid-model.yaml');
    const effortPath = path.join(dir, 'invalid-effort.yaml');
    const goalPath = path.join(dir, 'invalid-goal.yaml');
    fs.writeFileSync(modelPath, ['build:', '  limitless:', '    build_model: 42'].join('\n'));
    fs.writeFileSync(effortPath, ['build:', '  limitless:', '    effort: turbo'].join('\n'));
    fs.writeFileSync(goalPath, ['build:', '  limitless:', "    use_goal: 'yes'"].join('\n'));

    expect(() => loadBuildConfig({ env: {}, yamlPath: modelPath })).toThrow();
    expect(() => loadBuildConfig({ env: {}, yamlPath: effortPath })).toThrow();
    expect(() => loadBuildConfig({ env: {}, yamlPath: goalPath })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects overcommitted role caps and an excessive max_minutes value from yaml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const capPath = path.join(dir, 'overcommitted.yaml');
    const timePath = path.join(dir, 'excessive-time.yaml');
    fs.writeFileSync(
      capPath,
      [
        'build:',
        '  limitless:',
        '    mission_cap_usd: 50',
        '    session_max_cost_usd: 45',
        '    reviewer_max_cost_usd: 10',
      ].join('\n')
    );
    fs.writeFileSync(timePath, ['build:', '  limitless:', '    max_minutes: 241'].join('\n'));

    expect(() => loadBuildConfig({ env: {}, yamlPath: capPath })).toThrow(/must fit inside missionCapUsd/);
    expect(() => loadBuildConfig({ env: {}, yamlPath: timePath })).toThrow(/cannot exceed 240/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ignores a missing or malformed yaml file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-cfg-'));
    const yamlPath = path.join(dir, 'impulse.config.yaml');
    fs.writeFileSync(yamlPath, ':\n  - not yaml: [');
    expect(() => loadBuildConfig({ env: {}, yamlPath })).not.toThrow();
    expect(() => loadBuildConfig({ env: {}, yamlPath: path.join(dir, 'absent.yaml') })).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
