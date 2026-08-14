/**
 * @file app/api/agents/profiles/route.ts
 * @description API route returning the LIVE agent profiles and mission budget.
 *
 * Reads `agent/agents/<name>/config.yaml` at request time — the exact files the
 * mission runtime (`agent/src/profiles.ts`) loads — and mirrors its env-override
 * semantics (`IMPULSE_AGENT_<NAME>_MODEL` wins over config.yaml). Also surfaces
 * the live mission cost/tool-call caps and configured token reference from
 * `src/lib/inngest/functions/run-agent-mission.ts`.
 *
 * This is the single source the settings UI (Profiles tab, Agent Config editor,
 * Token Budget dashboard) consumes so those panels tell the truth about the
 * runtime instead of rendering hardcoded snapshots.
 *
 * @created 2026-06-10
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import { resolveEffectiveAgentMissionLimits, resolveMissionLimits } from '@/lib/mission-limits';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const log = createLogger('api/agents/profiles');

// ---------------------------------------------------------------------------
// Types + validation
// ---------------------------------------------------------------------------

/** Zod schema for the subset of agent config.yaml the settings UI displays. */
const AgentConfigYamlSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  model: z.string().min(1),
  budget: z.object({
    max_tokens: z.number().int().positive(),
    max_tool_calls: z.number().int().positive(),
  }),
  mcp_servers: z
    .object({
      internal: z.array(z.string()).default([]),
      external: z.array(z.string()).default([]),
    })
    .default({ internal: [], external: [] }),
  max_turns: z.number().int().positive().optional(),
  effort: z.string().optional(),
});

export interface AgentProfileSummary {
  /** Canonical agent name from config.yaml (e.g. 'defense-minister'). */
  name: string;
  description: string;
  /** Effective model — env override applied, matching the runtime resolution. */
  model: string;
  /** Where the effective model came from. */
  modelSource: 'config' | 'env';
  /** Lower of the global and profile token references; observational only. */
  maxTokens: number;
  /** Lower of the enforced global and profile tool-call caps. */
  maxToolCalls: number;
  internalMcpServers: string[];
  externalMcpServers: string[];
  maxTurns?: number;
  effort?: string;
}

export interface MissionBudgetInfo {
  /** Hard per-mission cost cap (USD) — the SDK aborts the mission above this. */
  maxCostUsd: number;
  maxCostSource: 'env' | 'default';
  /** Configured token reference used for telemetry; it does not stop execution. */
  tokenBudget: number;
  /** Explicit contract guard until token-based cancellation is implemented. */
  tokenBudgetEnforced: false;
  /** Per-mission tool-call cap enforced by the mission budget hooks. */
  maxToolCalls: number;
}

export interface AgentProfilesResponse {
  profiles: AgentProfileSummary[];
  missionBudget: MissionBudgetInfo;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Canonical display order — pipeline order, verifier last. */
const AGENT_ORDER = ['scout', 'evaluator', 'linker', 'curator', 'strategist', 'creator', 'defense-minister'];

/**
 * Per-agent model-override env var name. Mirrors `modelEnvVarName` in
 * `agent/src/profiles.ts` (uppercased, hyphens → underscores).
 */
function modelEnvVarName(agentName: string): string {
  return `IMPULSE_AGENT_${agentName.toUpperCase().replace(/-/g, '_')}_MODEL`;
}

/** Effective model: non-empty env override wins over config.yaml (runtime parity). */
function resolveAgentModel(agentName: string, configModel: string): { model: string; modelSource: 'config' | 'env' } {
  const override = process.env[modelEnvVarName(agentName)];
  if (override !== undefined && override.trim() !== '') {
    return { model: override.trim(), modelSource: 'env' };
  }
  return { model: configModel, modelSource: 'config' };
}

/**
 * Read every `agent/agents/<dir>/config.yaml` and return parsed summaries.
 * Directories without a config.yaml (or with an invalid one) are skipped with
 * a warning so one bad profile doesn't blank the whole panel.
 */
function readAgentProfiles(missionLimits: { tokenBudget: number; maxToolCalls: number }): AgentProfileSummary[] {
  const agentsDir = path.resolve(process.cwd(), 'agent', 'agents');
  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });

  const profiles: AgentProfileSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const configPath = path.join(agentsDir, entry.name, 'config.yaml');
    if (!fs.existsSync(configPath)) {
      log.warn('Agent directory has no config.yaml — skipping', { agent: entry.name });
      continue;
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = AgentConfigYamlSchema.safeParse(yaml.load(raw));
      if (!parsed.success) {
        log.warn('Invalid agent config.yaml — skipping', {
          agent: entry.name,
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
        continue;
      }

      const config = parsed.data;
      const { model, modelSource } = resolveAgentModel(config.name, config.model);
      const effectiveLimits = resolveEffectiveAgentMissionLimits(missionLimits, config.budget);
      profiles.push({
        name: config.name,
        description: config.description,
        model,
        modelSource,
        maxTokens: effectiveLimits.tokenBudget,
        maxToolCalls: effectiveLimits.maxToolCalls,
        internalMcpServers: config.mcp_servers.internal,
        externalMcpServers: config.mcp_servers.external,
        maxTurns: config.max_turns,
        effort: config.effort,
      });
    } catch (error) {
      log.warn('Failed to read agent config.yaml — skipping', {
        agent: entry.name,
        error: String(error),
      });
    }
  }

  profiles.sort((a, b) => {
    const ai = AGENT_ORDER.indexOf(a.name);
    const bi = AGENT_ORDER.indexOf(b.name);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  return profiles;
}

/**
 * Real mission-control facts — same defaults and env vars as
 * `run-agent-mission.ts`, including the observational token reference.
 */
function readMissionBudget(limits: ReturnType<typeof resolveMissionLimits>): MissionBudgetInfo {
  return {
    maxCostUsd: limits.maxCostUsd,
    maxCostSource: limits.maxCostSource,
    tokenBudget: limits.tokenBudget,
    tokenBudgetEnforced: false,
    maxToolCalls: limits.maxToolCalls,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/agents/profiles
 *
 * Returns the live agent profiles (parsed from agent/agents/&#42;/config.yaml at
 * request time, env model overrides applied) plus the real per-mission budget.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    const missionLimits = resolveMissionLimits(process.env);
    for (const variable of missionLimits.invalidEnvironmentVariables) {
      log.warn('Invalid mission limit environment value; using secure default', { variable });
    }
    const body: AgentProfilesResponse = {
      profiles: readAgentProfiles(missionLimits),
      missionBudget: readMissionBudget(missionLimits),
    };
    return NextResponse.json(body);
  } catch (error) {
    log.error('Failed to read agent profiles', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to read agent profiles' }, { status: 500 });
  }
}
