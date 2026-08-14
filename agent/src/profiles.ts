import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AgentConfigYamlSchema = z.object({
  name: z.string().min(1, 'Agent name is required'),
  description: z.string().min(1, 'Agent description is required'),
  model: z.string().min(1, 'Model is required'),
  budget: z.object({
    max_tokens: z.number().int().positive('max_tokens must be a positive integer'),
    max_tool_calls: z.number().int().positive('max_tool_calls must be a positive integer'),
  }),
  mcp_servers: z
    .object({
      internal: z.array(z.string()).default([]),
      external: z.array(z.string()).default([]),
    })
    .default({ internal: [], external: [] }),
  // Task 0.10: SDK 0.2.109 subagent controls — declarative budget enforcement
  max_turns: z.number().int().positive().optional(),
  effort: z.enum(['low', 'medium', 'high', 'max']).optional(),
  permission_mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']).optional(),
  // Per-agent wall-clock mission timeout in minutes. Default falls back to
  // the MISSION_TIMEOUT_MINUTES env var in the Inngest handler. Cap at 120
  // to prevent accidental multi-hour missions.
  timeoutMinutes: z.number().int().positive().max(120).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentProfile {
  name: string;
  description: string;
  prompt: string;
  model: string;
  budget: {
    max_tokens: number;
    max_tool_calls: number;
  };
  mcp_servers: {
    internal: string[];
    external: string[];
  };
  /** SDK 0.2.109: Max agentic turns before stopping (Task 0.10) */
  max_turns?: number;
  /** SDK 0.2.109: Per-agent effort level — controls token consumption (Task 0.10) */
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** SDK 0.2.109: Per-agent permission mode (Task 0.10) */
  permission_mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'auto';
  /** Per-agent wall-clock timeout in minutes. Inngest handler uses this instead of the env default when set. */
  timeoutMinutes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROFILE_FILENAME = 'PROFILE.md';
const CONFIG_FILENAME = 'config.yaml';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the per-agent model-override env var name for an agent.
 *
 * Pattern: `IMPULSE_AGENT_<NAME>_MODEL` where `<NAME>` is the agent name
 * uppercased with hyphens replaced by underscores.
 *
 * @example
 * modelEnvVarName('scout')            // 'IMPULSE_AGENT_SCOUT_MODEL'
 * modelEnvVarName('defense-minister') // 'IMPULSE_AGENT_DEFENSE_MINISTER_MODEL'
 */
function modelEnvVarName(agentName: string): string {
  return `IMPULSE_AGENT_${agentName.toUpperCase().replace(/-/g, '_')}_MODEL`;
}

/**
 * Resolve the effective model for an agent: a non-empty
 * `IMPULSE_AGENT_<NAME>_MODEL` env var wins over the config.yaml value.
 */
function resolveAgentModel(agentName: string, configModel: string): string {
  const override = process.env[modelEnvVarName(agentName)];
  if (override !== undefined && override.trim() !== '') {
    return override;
  }
  return configModel;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a single agent profile by name.
 *
 * Reads `{agentsDir}/{agentName}/PROFILE.md` and
 * `{agentsDir}/{agentName}/config.yaml`, validates the config with Zod,
 * and returns a merged {@link AgentProfile}.
 *
 * @throws if the agent directory, PROFILE.md, or config.yaml is missing
 * @throws if config.yaml fails Zod validation
 */
export function loadAgentProfile(agentsDir: string, agentName: string): AgentProfile {
  const agentDir = path.join(agentsDir, agentName);

  if (!fs.existsSync(agentDir) || !fs.statSync(agentDir).isDirectory()) {
    throw new Error(`Agent directory not found: ${agentDir}`);
  }

  const profilePath = path.join(agentDir, PROFILE_FILENAME);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`PROFILE.md not found for agent "${agentName}" at ${profilePath}`);
  }

  const configPath = path.join(agentDir, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.yaml not found for agent "${agentName}" at ${configPath}`);
  }

  const prompt = fs.readFileSync(profilePath, 'utf-8');
  const rawYaml = fs.readFileSync(configPath, 'utf-8');

  let parsed: unknown;
  try {
    parsed = yaml.parse(rawYaml);
  } catch (err) {
    throw new Error(
      `Failed to parse config.yaml for agent "${agentName}": ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const result = AgentConfigYamlSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid config.yaml for agent "${agentName}":\n${issues}`);
  }

  const config = result.data;

  return {
    name: config.name,
    description: config.description,
    prompt,
    // Per-agent env override: IMPULSE_AGENT_<NAME>_MODEL takes precedence
    // over the config.yaml model when set and non-empty.
    model: resolveAgentModel(config.name, config.model),
    budget: {
      max_tokens: config.budget.max_tokens,
      max_tool_calls: config.budget.max_tool_calls,
    },
    mcp_servers: config.mcp_servers,
    max_turns: config.max_turns,
    effort: config.effort,
    permission_mode: config.permission_mode,
    timeoutMinutes: config.timeoutMinutes,
  };
}

/**
 * List all agent names found in the given agents directory.
 *
 * An agent is any subdirectory that contains both `PROFILE.md` and
 * `config.yaml`.
 */
export function listAgents(agentsDir: string): string[] {
  if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) {
    return [];
  }

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });

  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      const dir = path.join(agentsDir, entry.name);
      return fs.existsSync(path.join(dir, PROFILE_FILENAME)) && fs.existsSync(path.join(dir, CONFIG_FILENAME));
    })
    .map((entry) => entry.name)
    .sort();
}

/**
 * Load all agent profiles from the given directory.
 *
 * @returns A `Map` keyed by agent name.
 */
export function loadAllProfiles(agentsDir: string): Map<string, AgentProfile> {
  const names = listAgents(agentsDir);
  const profiles = new Map<string, AgentProfile>();

  for (const name of names) {
    profiles.set(name, loadAgentProfile(agentsDir, name));
  }

  return profiles;
}
