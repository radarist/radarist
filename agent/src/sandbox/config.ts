/**
 * Build-mission configuration: env > impulse.config.yaml `build:` > defaults.
 *
 * Every knob is documented in docs/ENVIRONMENT.md and .env.example under
 * "Build Missions (Sandboxed Prototyping)". The yaml section is parsed
 * independently of loadAgentConfig() so the sandbox layer stays decoupled
 * from the orchestrator config schema.
 */
import * as fs from 'fs';
import * as yaml from 'yaml';
import { z } from 'zod';

/** `claude -p --effort` levels, lowest→highest (BUILD-013 steps this UP). */
export const buildEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type BuildEffort = z.infer<typeof buildEffortSchema>;

/**
 * Process budget for a build container (BUILD-037).
 *
 * A typical Next/Playwright build stays well below 200 tasks. The 512 default
 * leaves generous build-tool headroom while preventing an unreaped process
 * storm from consuming the Docker VM or host PID namespace. Operators may
 * tune it, but it always remains a finite cgroup limit.
 */
export const DEFAULT_SANDBOX_PIDS_LIMIT = 512;
export const MIN_SANDBOX_PIDS_LIMIT = 64;
export const MAX_SANDBOX_PIDS_LIMIT = 4096;
export const sandboxPidsLimitSchema = z
  .number()
  .int('Sandbox PID limit must be an integer')
  .min(MIN_SANDBOX_PIDS_LIMIT, `Sandbox PID limit must be at least ${MIN_SANDBOX_PIDS_LIMIT}`)
  .max(MAX_SANDBOX_PIDS_LIMIT, `Sandbox PID limit cannot exceed ${MAX_SANDBOX_PIDS_LIMIT}`);

export const buildConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Only backends that exist. See assertSupportedDriver below for why an
  // unsupported value must fail HERE and not later (BUILD-010).
  driver: z.enum(['docker']).default('docker'),
  image: z.string().default('radarist-build-sandbox'),
  imageTag: z.string().default('v2'),
  cpus: z.number().positive().default(2),
  memoryGb: z.number().positive().default(4),
  pidsLimit: sandboxPidsLimitSchema.default(DEFAULT_SANDBOX_PIDS_LIMIT),
  network: z.string().default('bridge'),
  portRangeStart: z.number().int().default(4100),
  portRangeEnd: z.number().int().default(4199),
  workspacePath: z.string().default('/workspace'),
  containerPort: z.number().int().default(3000),
  sessions: z
    .object({
      max: z.number().int().positive().default(8),
      maxTurns: z.number().int().positive().default(80),
      maxMinutes: z.number().positive().default(30),
      maxCostUsd: z.number().positive().default(6),
      // BUILD-015/020: the in-sandbox `claude -p` output-token ceiling, injected
      // as CLAUDE_CODE_MAX_OUTPUT_TOKENS (see resolveContainerEnv). Default 64000
      // = the Claude Code CLI's documented hard maximum for this env var (the CLI
      // default is 32000). Do NOT raise past 64000: the CLI caps it there
      // regardless of the model's larger API ceiling, and larger values have been
      // reported to error mid-session. Keep this conservative compatibility
      // ceiling unless a provider-verified regression proves a higher value.
      maxOutputTokens: z
        .number()
        .int()
        .positive()
        .max(64000, 'CLAUDE_CODE_MAX_OUTPUT_TOKENS cannot exceed the Claude Code CLI hard cap of 64000')
        .default(64000),
    })
    .prefault({}),
  budget: z
    .object({
      missionCapUsd: z.number().positive().default(25),
      warnThreshold: z.number().min(0).max(1).default(0.8),
    })
    .prefault({}),
  gates: z
    .object({
      timeoutHours: z.number().positive().default(24),
      approvalTimeoutHours: z.number().positive().default(72),
    })
    .prefault({}),
  models: z
    .object({
      // IMPORTANT: these are model IDs passed verbatim to `claude -p --model`
      // INSIDE the sandbox, which authenticates against the raw Anthropic API
      // (ANTHROPIC_API_KEY). They must be API-available model IDs — NOT the
      // host Claude Code CLI's default (`claude-fable-5`), which the raw API
      // rejects with 404 model_not_found and makes every session fail instantly
      // at the plan phase. Override per stage via IMPULSE_BUILD_MODEL_* or
      // impulse.config.yaml `build.models`.
      plan: z.string().default('claude-sonnet-4-6'),
      build: z.string().default('claude-sonnet-4-6'),
      qa: z.string().default('claude-sonnet-4-6'),
      escalation: z.string().default('claude-opus-4-8'),
    })
    .prefault({}),
  // BUILD-012/013 (redefined, Task 1): the premium `limitless` tier — a config
  // PROFILE selected by mission.buildMode, applied over the SAME pipeline (no
  // fork). One Opus builder session carries the build, then one fresh-context
  // Opus reviewer session runs phase 08. Both share the same $50 mission cap;
  // the builder is capped at $40 so the reviewer has a protected $10 reserve.
  // MAX `--effort` applies from the start (there is no builder-session stall
  // escalation runway, and the base is already the ceiling; BUILD-013).
  // Mission `modelOverrides`/`budget` still win.
  limitless: z
    .object({
      buildModel: z.string().default('claude-opus-4-8'),
      qaModel: z.string().default('claude-opus-4-8'),
      escalationModel: z.string().default('claude-opus-4-8'),
      // Exactly one builder plus one mandatory fresh-context QA reviewer.
      maxTurns: z.number().int().positive().default(160),
      // The premium builder has a larger turn/cost envelope than standard;
      // keep its wall clock separately bounded so the standard 30-minute cap
      // cannot terminate a healthy long-running build halfway through.
      maxMinutes: z.number().positive().max(240, 'Limitless maxMinutes cannot exceed 240').default(120),
      maxSessions: z.literal(2).default(2),
      missionCapUsd: z.number().positive().default(50),
      sessionMaxCostUsd: z.number().positive().default(40),
      reviewerMaxCostUsd: z.number().positive().default(10),
      effort: buildEffortSchema.default('max'),
      escalationEffort: buildEffortSchema.default('max'),
      // `/goal` remains an explicit compatibility opt-in until its headless
      // Claude Code behavior is proven live. The reviewer never uses /goal.
      useGoal: z.boolean().default(false),
    })
    .superRefine((profile, ctx) => {
      if (profile.sessionMaxCostUsd + profile.reviewerMaxCostUsd > profile.missionCapUsd) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Limitless builder + reviewer caps must fit inside missionCapUsd',
        });
      }
    })
    .prefault({}),
  mcp: z
    .object({
      hostBaseUrl: z.string().default('http://host.docker.internal:9002/api/mcp'),
      // Empty by default: enabling any platform server also injects the
      // unrestricted internal key. Build briefs carry a sanitized data packet;
      // operators may explicitly opt in to named servers when appropriate.
      platformServers: z.array(z.string()).default([]),
      // Evaluation missions clone untrusted repos — by default they get NO
      // platform servers (hence no admin key); the brief carries the graph
      // context and the supervisor does writeback outside the sandbox.
      evalPlatformServers: z.array(z.string()).default([]),
      enableWeb: z.boolean().default(false),
      enableGithub: z.boolean().default(false),
    })
    .prefault({}),
  // Advisory in v1 (documented; Docker network-policy enforcement is post-v1):
  // the hosts a sandbox is expected to reach when cloning/installing.
  cloneAllowlist: z
    .array(z.string())
    .default(['github.com', 'gitlab.com', 'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org']),
  envAllowlist: z.array(z.string()).default(['ANTHROPIC_API_KEY']),
  poll: z
    .object({
      watchSeconds: z.number().positive().default(60),
      intervalSeconds: z.number().positive().default(5),
    })
    .prefault({}),
  stall: z
    .object({
      escalateAfter: z.number().int().positive().default(2),
      pauseAfter: z.number().int().positive().default(3),
    })
    .prefault({}),
  qaMaxAttempts: z.number().int().nonnegative().default(1),
  concurrency: z.number().int().positive().default(1),
  keepAliveMinutes: z.number().positive().default(240),
  gcThresholdHours: z.number().positive().default(96),
  // Lifecycle / lean cleanup (L): after these windows a finished mission's
  // container + volume are harvested (git bundle + logs) then RECLAIMED.
  // Evaluations are leanest (verdict already in the graph); solutions keep a
  // warm window for fast iterate; failed runs keep a forensics window.
  lifecycle: z
    .object({
      volumeRetentionDays: z.number().positive().default(7),
      evalVolumeRetentionDays: z.number().positive().default(1),
      failedVolumeRetentionDays: z.number().positive().default(2),
    })
    .prefault({}),
});
export type BuildConfig = z.infer<typeof buildConfigSchema>;

type Env = Record<string, string | undefined>;

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
const int = (v: string | undefined) => {
  const n = num(v);
  return n === undefined ? undefined : Math.trunc(n);
};
const bool = (v: string | undefined) =>
  v === undefined || v === '' ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
// A string knob that must never reach the consumer blank — an empty/whitespace
// value falls through to yaml/defaults. Critical for model ids: a blank
// `--model ''` makes the in-sandbox CLI fall back to its host default
// (claude-fable-5 → 404). compact() only strips undefined, and z.string()
// .default() only fires on undefined, so the empty must be nulled here.
const str = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v);
// YAML is untyped at runtime. Preserve non-string values so Zod rejects them;
// only blank strings retain the established "fall through to default" behavior.
const yamlStr = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
// Unlike num/bool, an explicitly EMPTY csv var means "empty list" (e.g.
// IMPULSE_BUILD_PLATFORM_MCP= disables all platform servers); only an
// unset var falls through to yaml/defaults.
const csv = (v: string | undefined) =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

/** Strip undefined values so they don't shadow yaml/defaults in the merge. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const nested = compact(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function fromEnv(env: Env): Record<string, unknown> {
  return compact({
    enabled: bool(env.IMPULSE_BUILD_ENABLED),
    driver: env.IMPULSE_BUILD_SANDBOX_DRIVER,
    image: env.IMPULSE_BUILD_SANDBOX_IMAGE,
    imageTag: env.IMPULSE_BUILD_SANDBOX_IMAGE_TAG,
    cpus: num(env.IMPULSE_BUILD_SANDBOX_CPUS),
    memoryGb: num(env.IMPULSE_BUILD_SANDBOX_MEMORY_GB),
    // Do not truncate: fractional PID limits are configuration errors.
    pidsLimit: num(env.IMPULSE_BUILD_SANDBOX_PIDS_LIMIT),
    network: env.IMPULSE_BUILD_SANDBOX_NETWORK,
    portRangeStart: int(env.IMPULSE_BUILD_PORT_RANGE_START),
    portRangeEnd: int(env.IMPULSE_BUILD_PORT_RANGE_END),
    workspacePath: env.IMPULSE_BUILD_WORKSPACE_PATH,
    sessions: {
      max: int(env.IMPULSE_BUILD_MAX_SESSIONS),
      maxTurns: int(env.IMPULSE_BUILD_SESSION_MAX_TURNS),
      maxMinutes: num(env.IMPULSE_BUILD_SESSION_MAX_MINUTES),
      maxCostUsd: num(env.IMPULSE_BUILD_SESSION_MAX_COST_USD),
      maxOutputTokens: int(env.IMPULSE_BUILD_SESSION_MAX_OUTPUT_TOKENS),
    },
    budget: {
      missionCapUsd: num(env.IMPULSE_BUILD_MISSION_MAX_COST_USD),
      warnThreshold: num(env.IMPULSE_BUILD_WARN_THRESHOLD),
    },
    gates: {
      timeoutHours: num(env.IMPULSE_BUILD_GATE_TIMEOUT_HOURS),
      approvalTimeoutHours: num(env.IMPULSE_BUILD_APPROVAL_TIMEOUT_HOURS),
    },
    models: {
      plan: str(env.IMPULSE_BUILD_MODEL_PLAN),
      build: str(env.IMPULSE_BUILD_MODEL_BUILD),
      qa: str(env.IMPULSE_BUILD_MODEL_QA),
      escalation: str(env.IMPULSE_BUILD_MODEL_ESCALATION),
    },
    limitless: {
      buildModel: str(env.IMPULSE_BUILD_LIMITLESS_MODEL_BUILD),
      qaModel: str(env.IMPULSE_BUILD_LIMITLESS_MODEL_QA),
      escalationModel: str(env.IMPULSE_BUILD_LIMITLESS_MODEL_ESCALATION),
      maxTurns: int(env.IMPULSE_BUILD_LIMITLESS_MAX_TURNS),
      maxMinutes: num(env.IMPULSE_BUILD_LIMITLESS_MAX_MINUTES),
      // Do not truncate fractions here: the protected builder + reviewer
      // contract requires the literal value 2, not a value that rounds to it.
      maxSessions: num(env.IMPULSE_BUILD_LIMITLESS_MAX_SESSIONS),
      missionCapUsd: num(env.IMPULSE_BUILD_LIMITLESS_MISSION_MAX_COST_USD),
      sessionMaxCostUsd: num(env.IMPULSE_BUILD_LIMITLESS_SESSION_MAX_COST_USD),
      reviewerMaxCostUsd: num(env.IMPULSE_BUILD_LIMITLESS_REVIEWER_MAX_COST_USD),
      effort: str(env.IMPULSE_BUILD_LIMITLESS_EFFORT),
      escalationEffort: str(env.IMPULSE_BUILD_LIMITLESS_ESCALATION_EFFORT),
      useGoal: bool(env.IMPULSE_BUILD_LIMITLESS_USE_GOAL),
    },
    mcp: {
      hostBaseUrl: env.IMPULSE_BUILD_MCP_HOST_BASE_URL,
      platformServers: csv(env.IMPULSE_BUILD_PLATFORM_MCP),
      evalPlatformServers: csv(env.IMPULSE_BUILD_EVAL_PLATFORM_MCP),
      enableWeb: bool(env.IMPULSE_BUILD_ENABLE_WEB_MCP),
      enableGithub: bool(env.IMPULSE_BUILD_ENABLE_GITHUB_MCP),
    },
    cloneAllowlist: csv(env.IMPULSE_BUILD_CLONE_ALLOWLIST),
    envAllowlist: csv(env.IMPULSE_BUILD_ENV_ALLOWLIST),
    poll: {
      watchSeconds: num(env.IMPULSE_BUILD_POLL_WATCH_SECONDS),
      intervalSeconds: num(env.IMPULSE_BUILD_POLL_INTERVAL_SECONDS),
    },
    stall: {
      escalateAfter: int(env.IMPULSE_BUILD_STALL_ESCALATE_AFTER),
      pauseAfter: int(env.IMPULSE_BUILD_STALL_PAUSE_AFTER),
    },
    qaMaxAttempts: int(env.IMPULSE_BUILD_QA_MAX_ATTEMPTS),
    concurrency: int(env.IMPULSE_BUILD_CONCURRENCY),
    keepAliveMinutes: num(env.IMPULSE_BUILD_KEEP_ALIVE_MINUTES),
    gcThresholdHours: num(env.IMPULSE_BUILD_GC_THRESHOLD_HOURS),
    lifecycle: {
      volumeRetentionDays: num(env.IMPULSE_BUILD_VOLUME_RETENTION_DAYS),
      evalVolumeRetentionDays: num(env.IMPULSE_BUILD_EVAL_VOLUME_RETENTION_DAYS),
      failedVolumeRetentionDays: num(env.IMPULSE_BUILD_FAILED_VOLUME_RETENTION_DAYS),
    },
  });
}

function fromYaml(yamlPath: string | undefined): Record<string, unknown> {
  if (!yamlPath || !fs.existsSync(yamlPath)) return {};
  try {
    const doc = yaml.parse(fs.readFileSync(yamlPath, 'utf8')) as Record<string, unknown> | null;
    const section = doc?.build;
    if (!section || typeof section !== 'object') return {};
    interface YamlBuildSection {
      image?: string;
      resources?: { cpus?: number; memory_gb?: number };
      pids_limit?: number;
      ports?: { start?: number; end?: number };
      sessions?: {
        max?: number;
        max_turns?: number;
        max_minutes?: number;
        max_cost_usd?: number;
        max_output_tokens?: number;
      };
      budget?: { mission_cap_usd?: number; warn_threshold?: number };
      gates?: { timeout_hours?: number; approval_timeout_hours?: number };
      models?: { plan?: string; build?: string; qa?: string; escalation?: string };
      limitless?: {
        build_model?: string;
        qa_model?: string;
        escalation_model?: string;
        max_turns?: number;
        max_minutes?: number;
        max_sessions?: number;
        mission_cap_usd?: number;
        session_max_cost_usd?: number;
        reviewer_max_cost_usd?: number;
        effort?: string;
        escalation_effort?: string;
        use_goal?: boolean;
      };
      mcp?: { host_base_url?: string; platform_servers?: string[]; enable_web?: boolean; enable_github?: boolean };
      env_allowlist?: string[];
    }
    const b = section as YamlBuildSection;
    // yaml uses snake_case per impulse.config.yaml conventions.
    return compact({
      image: typeof b.image === 'string' ? b.image.split(':')[0] : undefined,
      imageTag: typeof b.image === 'string' && b.image.includes(':') ? b.image.split(':')[1] : undefined,
      cpus: b.resources?.cpus,
      memoryGb: b.resources?.memory_gb,
      pidsLimit: b.pids_limit,
      portRangeStart: b.ports?.start,
      portRangeEnd: b.ports?.end,
      sessions: {
        max: b.sessions?.max,
        maxTurns: b.sessions?.max_turns,
        maxMinutes: b.sessions?.max_minutes,
        maxCostUsd: b.sessions?.max_cost_usd,
        maxOutputTokens: b.sessions?.max_output_tokens,
      },
      budget: {
        missionCapUsd: b.budget?.mission_cap_usd,
        warnThreshold: b.budget?.warn_threshold,
      },
      gates: {
        timeoutHours: b.gates?.timeout_hours,
        approvalTimeoutHours: b.gates?.approval_timeout_hours,
      },
      models: b.models
        ? {
            plan: str(b.models.plan),
            build: str(b.models.build),
            qa: str(b.models.qa),
            escalation: str(b.models.escalation),
          }
        : undefined,
      limitless: {
        buildModel: yamlStr(b.limitless?.build_model),
        qaModel: yamlStr(b.limitless?.qa_model),
        escalationModel: yamlStr(b.limitless?.escalation_model),
        maxTurns: b.limitless?.max_turns,
        maxMinutes: b.limitless?.max_minutes,
        maxSessions: b.limitless?.max_sessions,
        missionCapUsd: b.limitless?.mission_cap_usd,
        sessionMaxCostUsd: b.limitless?.session_max_cost_usd,
        reviewerMaxCostUsd: b.limitless?.reviewer_max_cost_usd,
        effort: yamlStr(b.limitless?.effort),
        escalationEffort: yamlStr(b.limitless?.escalation_effort),
        useGoal: b.limitless?.use_goal,
      },
      mcp: {
        hostBaseUrl: b.mcp?.host_base_url,
        platformServers: b.mcp?.platform_servers,
        enableWeb: b.mcp?.enable_web,
        enableGithub: b.mcp?.enable_github,
      },
      envAllowlist: b.env_allowlist,
    });
  } catch {
    return {}; // malformed yaml never blocks config — env/defaults still apply
  }
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const prev = out[k];
    if (v && prev && typeof v === 'object' && typeof prev === 'object' && !Array.isArray(v) && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const SUPPORTED_SANDBOX_DRIVERS = ['docker'] as const;

/**
 * Reject an unsupported sandbox backend at CONFIG-LOAD time (BUILD-010).
 *
 * This runs inside `load-and-validate`, which is deliberate: it is the last
 * point before `mark-running` flips the mission to `running` and emits
 * `agent.started`. `IMPULSE_BUILD_SANDBOX_DRIVER=apple-container` used to sail
 * through here — the config accepted it and the driver factory handed back a
 * stub whose every method rejected — so a mission was announced as running and
 * only then died in the provisioner.
 *
 * The narrowed zod enum above would already throw, but its error names a field,
 * not a fix. An operator who set an env var deserves to be told which one and
 * what the supported values are.
 */
function assertSupportedDriver(driver: unknown): void {
  if (driver === undefined || driver === null) return; // falls back to the default
  if ((SUPPORTED_SANDBOX_DRIVERS as readonly unknown[]).includes(driver)) return;

  throw new Error(
    `Unsupported sandbox driver ${JSON.stringify(driver)}. ` +
      `IMPULSE_BUILD_SANDBOX_DRIVER must be one of: ${SUPPORTED_SANDBOX_DRIVERS.join(', ')}. ` +
      `('apple-container' was accepted by earlier configs but never implemented — it is gone, not disabled.)`
  );
}

export function loadBuildConfig(opts?: { env?: Env; yamlPath?: string }): BuildConfig {
  const env = opts?.env ?? process.env;
  const merged = deepMerge(fromYaml(opts?.yamlPath), fromEnv(env));
  assertSupportedDriver((merged as { driver?: unknown }).driver);
  return buildConfigSchema.parse(merged);
}

export function fullImageName(cfg: BuildConfig): string {
  return `${cfg.image}:${cfg.imageTag}`;
}
