/**
 * @file helpers/mcp-reachability-matrix.ts
 * @description The ONE derivation of "which agent profile can reach which
 * platform tool", shared by every reachability regression.
 *
 * SKILL-045 introduced this derivation inline in `skill-tool-reachability.test.ts`
 * to answer "can the profile that runs this skill call the tool the skill names".
 * SKILL-049 needs the same matrix to answer a different question — "did a fix
 * hand some other profile authority it did not have" — and two hand-rolled
 * copies of a security-relevant derivation is exactly how the two answers drift
 * apart. It is derived, never listed:
 *
 *   tool   -> MCP servers  from each domain server's own `getTools()`
 *   server -> profiles     from `agent/agents/<profile>/config.yaml` + UNIVERSAL
 *
 * Consumers MUST declare the Firebase SDK mocks before importing this module —
 * the domain server factories reach the SDK entry points transitively, and this
 * helper only ever reads their declaration arrays:
 *
 * ```typescript
 * jest.mock('@/lib/firebase', () => ({ db: {}, auth: {}, storage: {} }));
 * jest.mock('@/lib/firebase-admin', () => ({ db: {}, auth: {}, storage: {}, adminApp: {} }));
 * ```
 */

import fs from 'node:fs';
import path from 'node:path';

import yaml from 'js-yaml';

import { createEntitiesServer } from '@/lib/mcp/servers/entities-server';
import { createGraphServer } from '@/lib/mcp/servers/graph-server';
import { createRadarServer } from '@/lib/mcp/servers/radar-server';
import { createReportsServer } from '@/lib/mcp/servers/reports-server';
import { createResearchServer } from '@/lib/mcp/servers/research-server';
import { createSignalsServer } from '@/lib/mcp/servers/signals-server';
import { createSuperGraphServer } from '@/lib/mcp/servers/super-graph-server';

export const REPO_ROOT = path.resolve(__dirname, '../../../..');
export const AGENTS_DIR = path.join(REPO_ROOT, 'agent', 'agents');
export const SKILLS_DIR = path.join(REPO_ROOT, 'agent', 'runtime-plugin', 'skills');

/**
 * Servers that mount platform tools. Gemini-side servers are excluded: they
 * expose provider capabilities (`generate_image`, `search_with_grounding`),
 * not the `camelCase` platform tools a profile or SKILL.md names.
 */
export const PLATFORM_SERVERS: Record<string, () => { getTools(): Array<{ name: string }> }> = {
  'impulse-entities': createEntitiesServer,
  'impulse-graph': createGraphServer,
  'impulse-signals': createSignalsServer,
  'impulse-research': createResearchServer,
  'impulse-radar': createRadarServer,
  'impulse-reports': createReportsServer,
  'super-graph': createSuperGraphServer,
};

/** Mirrors UNIVERSAL_MCP_SERVERS.internal in agent/src/config.ts. */
export const UNIVERSAL_INTERNAL_SERVERS = ['impulse-entities', 'impulse-graph'];

/** tool name -> every platform server that mounts it. */
export function buildToolToServers(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [server, factory] of Object.entries(PLATFORM_SERVERS)) {
    for (const tool of factory().getTools()) {
      map.set(tool.name, [...(map.get(tool.name) ?? []), server]);
    }
  }
  return map;
}

/** profile -> every platform server it mounts (universal tier included). */
export function buildProfileToServers(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const profile of fs.readdirSync(AGENTS_DIR).sort()) {
    const configPath = path.join(AGENTS_DIR, profile, 'config.yaml');
    if (!fs.existsSync(configPath)) continue;
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as {
      mcp_servers?: { internal?: string[]; external?: string[] };
    } | null;
    const internal = config?.mcp_servers?.internal ?? [];
    // `super-graph` is configured under `external` but is an in-tree platform
    // server exposed at /api/mcp/super-graph, so it counts for reachability.
    const external = (config?.mcp_servers?.external ?? []).filter((s) => s in PLATFORM_SERVERS);
    out[profile] = [...new Set([...UNIVERSAL_INTERNAL_SERVERS, ...internal, ...external])];
  }
  return out;
}

/** profile -> the exact set of platform tool names that profile can invoke. */
export function buildProfileToTools(): Record<string, Set<string>> {
  const profileToServers = buildProfileToServers();
  const out: Record<string, Set<string>> = {};
  for (const [profile, servers] of Object.entries(profileToServers)) {
    const tools = new Set<string>();
    for (const server of servers) {
      const factory = PLATFORM_SERVERS[server];
      if (!factory) continue;
      for (const tool of factory().getTools()) tools.add(tool.name);
    }
    out[profile] = tools;
  }
  return out;
}

/** Every profile that can invoke `tool`, derived from the two maps above. */
export function profilesReaching(tool: string, toolToServers = buildToolToServers()): string[] {
  const servers = toolToServers.get(tool) ?? [];
  return Object.entries(buildProfileToServers())
    .filter(([, mounted]) => servers.some((server) => mounted.includes(server)))
    .map(([profile]) => profile);
}
