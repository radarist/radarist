/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports)
// ---------------------------------------------------------------------------

jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({
    authenticated: true,
    uid: 'test-user-123',
    email: 'test@example.com',
  }),
}));

const mockLogWarn = jest.fn();
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: jest.fn(),
    info: jest.fn(),
    // Lazy reference — the factory is hoisted above the const initializer.
    warn: (...args: unknown[]) => mockLogWarn(...args),
    error: jest.fn(),
  }),
}));

// Mock fs to return a fake config
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue(`
mcp_servers:
  external:
    custom-reader:
      transport: stdio
      command: npx
      args: ["custom-reader-mcp", "--transport", "stdio"]
    exa:
      transport: stdio
      command: npx
      args: ["-y", "exa-mcp-server"]
    firecrawl:
      transport: stdio
      command: npx
      args: ["-y", "firecrawl-mcp"]
`),
}));

jest.mock('js-yaml', () => ({
  load: jest.fn().mockReturnValue({
    mcp_servers: {
      external: {
        'custom-reader': {
          transport: 'stdio',
          command: 'npx',
          args: ['custom-reader-mcp', '--transport', 'stdio'],
        },
        exa: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'exa-mcp-server'],
        },
        firecrawl: {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'firecrawl-mcp'],
        },
      },
    },
  }),
}));

// Mock MCP server factories for direct import (Task 0.6: no more self-HTTP)
const mockGetTools = jest.fn().mockReturnValue([
  { name: 'createCompany', description: 'Create a company' },
  { name: 'searchEntities', description: 'Search entities' },
]);

jest.mock('@/lib/mcp/servers/entities-server', () => ({
  createEntitiesServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/graph-server', () => ({
  createGraphServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/signals-server', () => ({
  createSignalsServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/research-server', () => ({
  createResearchServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/radar-server', () => ({
  createRadarServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/reports-server', () => ({
  createReportsServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/gemini-servers', () => ({
  createGeminiImageServer: jest.fn(() => ({ getTools: mockGetTools })),
  createGeminiEmbeddingsServer: jest.fn(() => ({ getTools: mockGetTools })),
  createGeminiResearchServer: jest.fn(() => ({ getTools: mockGetTools })),
  createGeminiGroundingServer: jest.fn(() => ({ getTools: mockGetTools })),
}));
jest.mock('@/lib/mcp/servers/super-graph-server', () => ({
  createSuperGraphServer: jest.fn(() => ({ getTools: mockGetTools })),
}));

// Set env before import
process.env.IMPULSE_INTERNAL_KEY = 'test-key-123';

// ---------------------------------------------------------------------------
// Import under test (AFTER mocks)
// ---------------------------------------------------------------------------

import { GET } from '../route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockRequest(url = 'http://localhost:3000/api/mcp/tools-status'): NextRequest {
  return new NextRequest(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer mock-token' },
  });
}

// mockSuccessfulPing removed — Task 0.6 replaced fetch-based pings with direct imports

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/mcp/tools-status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: all server factories return working servers
    mockGetTools.mockReturnValue([
      { name: 'createCompany', description: 'Create a company' },
      { name: 'searchEntities', description: 'Search entities' },
    ]);
  });

  it('returns 401 when not authenticated', async () => {
    const { getAuthenticatedUser } = jest.requireMock('@/lib/auth-utils');
    getAuthenticatedUser.mockResolvedValueOnce({
      authenticated: false,
      error: 'No authorization header provided',
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toBe('No authorization header provided');
  });

  it('returns internal and external server sections', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toHaveProperty('internal');
    expect(json).toHaveProperty('external');
    expect(Array.isArray(json.internal)).toBe(true);
    expect(Array.isArray(json.external)).toBe(true);
  });

  it('returns all 11 logical internal servers (6 domains + 4 gemini + super-graph)', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.internal).toHaveLength(11);
    const names = json.internal.map((s: { name: string }) => s.name);
    expect(names).toContain('impulse-entities');
    expect(names).toContain('impulse-graph');
    expect(names).toContain('impulse-signals');
    expect(names).toContain('impulse-research');
    expect(names).toContain('impulse-radar');
    expect(names).toContain('impulse-reports');
    expect(names).toContain('gemini-image');
    expect(names).toContain('gemini-embeddings');
    expect(names).toContain('gemini-research');
    expect(names).toContain('gemini-grounding');
    expect(names).toContain('super-graph');
  });

  it('exposes the gemini servers under their dispatcher slugs', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    const geminiImage = json.internal.find((s: { name: string }) => s.name === 'gemini-image');
    expect(geminiImage?.slug).toBe('gemini-image');
    expect(geminiImage?.status).toBe('connected');

    const superGraph = json.internal.find((s: { name: string }) => s.name === 'super-graph');
    expect(superGraph?.slug).toBe('super-graph');
    expect(superGraph?.status).toBe('connected');
  });

  it('marks servers as connected when factory succeeds', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    // All servers should be connected since mocked factories succeed
    for (const server of json.internal) {
      expect(server.status).toBe('connected');
      expect(server.tools.length).toBeGreaterThan(0);
    }
  });

  it('marks disconnected servers when factory throws', async () => {
    // Override one factory to throw
    const { createEntitiesServer } = jest.requireMock('@/lib/mcp/servers/entities-server');
    createEntitiesServer.mockImplementationOnce(() => {
      throw new Error('Module load failed');
    });

    const res = await GET(createMockRequest());
    const json = await res.json();

    const entities = json.internal.find((s: { name: string }) => s.name === 'impulse-entities');
    expect(entities.status).toBe('disconnected');
    expect(entities.tools).toEqual([]);
  });

  it('returns external servers from config', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    expect(json.external).toHaveLength(3);
    const names = json.external.map((s: { name: string }) => s.name);
    expect(names).toContain('custom-reader');
    expect(names).toContain('exa');
    expect(names).toContain('firecrawl');
  });

  it('external servers show command and transport info', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    const exa = json.external.find((s: { name: string }) => s.name === 'exa');
    expect(exa).toBeDefined();
    expect(exa.command).toBe('npx');
    expect(exa.transport).toBe('stdio');
    expect(exa.status).toBe('configured');
  });

  it('external servers include args', async () => {
    const res = await GET(createMockRequest());
    const json = await res.json();

    const reader = json.external.find((s: { name: string }) => s.name === 'custom-reader');
    expect(reader?.args).toEqual(['custom-reader-mcp', '--transport', 'stdio']);
  });

  // OBS-002: absent config is the supported internal-only state — silent.
  // Unreadable or malformed config keeps the warning + empty list.
  describe('impulse.config.yaml states (OBS-002)', () => {
    it('absent config file returns empty external list WITHOUT a warning', async () => {
      const fs = jest.requireMock('fs');
      fs.existsSync.mockReturnValueOnce(false);

      const res = await GET(createMockRequest());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.external).toEqual([]);
      expect(json.internal).toHaveLength(11); // internal-only mode fully served
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('unreadable config file warns and returns empty external list', async () => {
      const fs = jest.requireMock('fs');
      fs.readFileSync.mockImplementationOnce(() => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      });

      const res = await GET(createMockRequest());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.external).toEqual([]);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Failed to read impulse.config.yaml for external servers',
        expect.objectContaining({ error: expect.stringContaining('EACCES') })
      );
    });

    it('malformed YAML warns and returns empty external list', async () => {
      const yaml = jest.requireMock('js-yaml');
      yaml.load.mockImplementationOnce(() => {
        throw new Error('bad indentation of a mapping entry');
      });

      const res = await GET(createMockRequest());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.external).toEqual([]);
      expect(mockLogWarn).toHaveBeenCalledWith(
        'Failed to read impulse.config.yaml for external servers',
        expect.objectContaining({ error: expect.stringContaining('bad indentation') })
      );
    });

    it('valid config with external entries stays warning-free', async () => {
      const res = await GET(createMockRequest());
      const json = await res.json();

      expect(json.external).toHaveLength(3);
      expect(mockLogWarn).not.toHaveBeenCalled();
    });
  });
});
