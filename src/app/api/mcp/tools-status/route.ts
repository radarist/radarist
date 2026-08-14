/**
 * @file app/api/mcp/tools-status/route.ts
 * @description API route for MCP server and tool status
 *
 * Returns status of all MCP servers (internal + external) with tool lists.
 * Internal servers are live-pinged via JSON-RPC tools/list.
 * External servers are read from impulse.config.yaml (config-only).
 *
 * @author Radarist Team
 * @created 2026-02-26
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth-utils';
import { createLogger } from '@/lib/logger';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const log = createLogger('api/mcp/tools-status');

interface InternalServerStatus {
  name: string;
  slug: string;
  status: 'connected' | 'disconnected';
  tools: string[];
  version?: string;
}

interface ExternalServerConfig {
  name: string;
  transport: string;
  command: string;
  args?: string[];
  status: 'configured';
}

interface ImpulseConfig {
  mcp_servers?: {
    internal?: {
      base_url?: string;
      servers?: string[];
    };
    external?: Record<
      string,
      {
        transport?: string;
        command?: string;
        args?: string[];
        env?: Record<string, string>;
      }
    >;
  };
}

/**
 * Display name → dispatch slug for every logical in-tree MCP server.
 * Must stay in sync with `VALID_SERVERS` in `src/app/api/mcp/[server]/route.ts`
 * (11 logical servers: 6 platform domains + 4 Gemini capabilities + super-graph).
 */
const INTERNAL_SERVER_SLUGS: Record<string, string> = {
  'impulse-entities': 'entities',
  'impulse-graph': 'graph',
  'impulse-signals': 'signals',
  'impulse-research': 'research',
  'impulse-radar': 'radar',
  'impulse-reports': 'reports',
  'gemini-image': 'gemini-image',
  'gemini-embeddings': 'gemini-embeddings',
  'gemini-research': 'gemini-research',
  'gemini-grounding': 'gemini-grounding',
  'super-graph': 'super-graph',
};

/**
 * Get internal MCP server status via direct module import.
 * Task 0.6: Replaced self-HTTP calls (http://localhost:9002/api/mcp/...)
 * with direct imports to avoid CI/Docker/reverse-proxy breakage.
 */
async function getInternalServerStatus(slug: string, name: string): Promise<InternalServerStatus> {
  try {
    // Dynamic import to get the domain server factory directly
    const serverFactories: Record<
      string,
      () => Promise<{ getTools: () => Array<{ name: string; description?: string }> }>
    > = {
      entities: async () => {
        const { createEntitiesServer } = await import('@/lib/mcp/servers/entities-server');
        return createEntitiesServer();
      },
      graph: async () => {
        const { createGraphServer } = await import('@/lib/mcp/servers/graph-server');
        return createGraphServer();
      },
      signals: async () => {
        const { createSignalsServer } = await import('@/lib/mcp/servers/signals-server');
        return createSignalsServer();
      },
      research: async () => {
        const { createResearchServer } = await import('@/lib/mcp/servers/research-server');
        return createResearchServer();
      },
      radar: async () => {
        const { createRadarServer } = await import('@/lib/mcp/servers/radar-server');
        return createRadarServer();
      },
      reports: async () => {
        const { createReportsServer } = await import('@/lib/mcp/servers/reports-server');
        return createReportsServer();
      },
      'gemini-image': async () => {
        const { createGeminiImageServer } = await import('@/lib/mcp/servers/gemini-servers');
        return createGeminiImageServer();
      },
      'gemini-embeddings': async () => {
        const { createGeminiEmbeddingsServer } = await import('@/lib/mcp/servers/gemini-servers');
        return createGeminiEmbeddingsServer();
      },
      'gemini-research': async () => {
        const { createGeminiResearchServer } = await import('@/lib/mcp/servers/gemini-servers');
        return createGeminiResearchServer();
      },
      'gemini-grounding': async () => {
        const { createGeminiGroundingServer } = await import('@/lib/mcp/servers/gemini-servers');
        return createGeminiGroundingServer();
      },
      'super-graph': async () => {
        const { createSuperGraphServer } = await import('@/lib/mcp/servers/super-graph-server');
        return createSuperGraphServer();
      },
    };

    const factory = serverFactories[slug];
    if (!factory) {
      return { name, slug, status: 'disconnected', tools: [] };
    }

    const server = await factory();
    const tools: string[] = server.getTools().map((t: { name: string }) => t.name);

    return { name, slug, status: 'connected', tools, version: '1.0.0' };
  } catch {
    return { name, slug, status: 'disconnected', tools: [] };
  }
}

/**
 * Parse external MCP servers from impulse.config.yaml.
 *
 * The config file is optional (internal-only mode is fully supported), so an
 * absent file returns an empty list silently — same contract as the sandbox
 * and agent config loaders. Unreadable or malformed config still warns.
 */
function getExternalServers(): ExternalServerConfig[] {
  const configPath = path.resolve(process.cwd(), 'impulse.config.yaml');
  if (!fs.existsSync(configPath)) {
    return [];
  }
  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config = yaml.load(configContent) as ImpulseConfig;

    const externalServers = config?.mcp_servers?.external ?? {};
    return Object.entries(externalServers).map(([name, serverConfig]) => ({
      name,
      transport: serverConfig.transport ?? 'stdio',
      command: serverConfig.command ?? 'unknown',
      args: serverConfig.args,
      status: 'configured' as const,
    }));
  } catch (error) {
    log.warn('Failed to read impulse.config.yaml for external servers', {
      error: String(error),
    });
    return [];
  }
}

/**
 * GET /api/mcp/tools-status
 *
 * Returns status of all MCP servers with tool lists.
 */
export async function GET(request: NextRequest) {
  const auth = await getAuthenticatedUser(request);
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  try {
    // Task 0.6: Direct module import instead of self-HTTP calls
    // (no more localhost:9002 fallback that breaks in CI/Docker)
    const internalPromises = Object.entries(INTERNAL_SERVER_SLUGS).map(([name, slug]) =>
      getInternalServerStatus(slug, name)
    );
    const internal = await Promise.all(internalPromises);

    // Read external servers from config
    const external = getExternalServers();

    return NextResponse.json({ internal, external });
  } catch (error) {
    log.error('Failed to get MCP tools status', error instanceof Error ? error : new Error(String(error)));
    return NextResponse.json({ error: 'Failed to get MCP tools status' }, { status: 500 });
  }
}
