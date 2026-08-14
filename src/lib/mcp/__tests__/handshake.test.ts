/**
 * Wave-3 HANDSHAKE GATE — in-process end-to-end proof of the ambient-substrate
 * MCP surface. Calls `handleMcpRequest` directly (NO live HTTP server) and runs
 * the REAL lane modules wired by `server.ts`:
 *   - `resources.ts`     — owner ACL + principal-scoped listing (Lane D)
 *   - `budget.ts`        — durable per-key deny-before-spend (Lane A)
 *   - `prompts.ts`       — skills-as-prompts + hash-verify + untrusted frame (Lane E)
 *   - `permissions.ts`   — real write/delete tool ACL
 *   - `grounding-wrap.ts`— fact-asserting pass-through (Lane F)
 * Only the IO edges are mocked (api-key validation, graph readers, firebase-admin,
 * Gemini client), so the three gate conditions are proven against real logic:
 *
 *   G1  initialize advertises BOTH `capabilities.resources` AND `capabilities.prompts`.
 *   G2  a read-only key (permissions:['read']) runs the full chain
 *       initialize → resources/list → resources/read (own data) → prompts/get.
 *   G3  the same read-only key is REJECTED on a representative write/delete tool.
 *
 * @jest-environment node
 */

// --- API key validation (auth edge) ----------------------------------------
jest.mock('../api-keys', () => ({
  validateApiKey: jest.fn(),
}));

// --- tools surface kept tiny; REAL permissions module drives the G3 ACL -----
jest.mock('../schema-converter', () => ({
  convertGeminiToolsToMcpTools: jest.fn().mockReturnValue([]),
}));
jest.mock('@/lib/ai/tools', () => ({
  CORE_AI_TOOLS: [],
  // Must NEVER run for a denied write/delete tool — asserted in G3.
  executeTool: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
}));

// --- grounding-wrap IO edge (REAL grounding-wrap runs over this mock) -------
jest.mock('@/lib/ai/client', () => ({
  generateGroundedContent: jest.fn(),
}));

// --- resources.ts graph-reader edges (REAL resources.ts runs the ACL) ------
jest.mock('@/lib/graph/episodes', () => ({
  queryEpisodes: jest.fn().mockResolvedValue([{ id: 'ep1', summary: 'alice-only-episode' }]),
}));
jest.mock('@/lib/graph/interest-profile', () => ({
  getInterestProfile: jest.fn().mockResolvedValue({ vertical: 'fintech' }),
}));
jest.mock('@/lib/graph/proactive-insights', () => ({
  getInsightsForUser: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/graph/session-memory', () => ({
  getExploredEntities: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/graph/community-reports', () => ({
  queryCommunityReports: jest.fn().mockResolvedValue([{ title: 'community-report-1' }]),
}));

// --- budget.ts IO edges (REAL budget.ts runs deny-before-spend in-memory) ---
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { increment: (n: number) => ({ __incr: n }) },
  Timestamp: { fromMillis: (m: number) => ({ __ts: m }) },
}));
jest.mock('@/lib/firebase-admin', () => {
  const store: Record<string, number> = {};
  return {
    db: {
      collection: () => ({
        doc: (id: string) => ({ id }),
      }),
      runTransaction: async (fn: (tx: unknown) => unknown) =>
        fn({
          get: async (ref: { id: string }) => {
            const current = store[ref.id];
            return { exists: current !== undefined, data: () => ({ count: current }) };
          },
          set: (ref: { id: string }, data: { count?: { __incr?: number } }) => {
            store[ref.id] = (store[ref.id] ?? 0) + (data.count?.__incr ?? 0);
          },
        }),
    },
  };
});

import { handleMcpRequest } from '../server';
import { validateApiKey } from '../api-keys';
import { executeTool } from '@/lib/ai/tools';
import { JSON_RPC_ERROR_CODES } from '../types';
import type { ApiKey } from '../types';

const ALICE = 'alice-uid';

function readOnlyKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-readonly-handshake',
    hashedKey: 'h',
    userId: ALICE,
    name: 'read-only-handshake',
    permissions: ['read'],
    createdAt: 0,
    ...overrides,
  };
}

function call(method: string, params?: Record<string, unknown>, authHeader: string | null = 'Bearer tp_live_x') {
  return handleMcpRequest({
    authHeader,
    body: { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
  });
}

describe('Wave-3 handshake gate (in-process, real lane modules)', () => {
  const ORIGINAL_BUDGET = process.env.MCP_DAILY_READ_BUDGET;

  beforeEach(() => {
    jest.clearAllMocks();
    // Generous budget — the chain consumes 1 on read + 1 on prompts/get.
    process.env.MCP_DAILY_READ_BUDGET = '1000';
  });

  afterEach(() => {
    if (ORIGINAL_BUDGET === undefined) delete process.env.MCP_DAILY_READ_BUDGET;
    else process.env.MCP_DAILY_READ_BUDGET = ORIGINAL_BUDGET;
  });

  // ── G1 ─────────────────────────────────────────────────────────────────
  describe('G1 — initialize advertises resources AND prompts', () => {
    it('returns both capabilities (no auth required)', async () => {
      const result = await call('initialize', undefined, null);

      expect(result.status).toBe(200);
      const caps = (result.response.result as { capabilities: Record<string, unknown> }).capabilities;
      expect(caps.resources).toBeDefined();
      expect(caps.prompts).toBeDefined();
      // Sanity: the existing tools capability is still advertised alongside.
      expect(caps.tools).toBeDefined();
    });
  });

  // ── G2 ─────────────────────────────────────────────────────────────────
  describe('G2 — read-only key runs the full read flow end-to-end', () => {
    it('initialize → resources/list → resources/read (own data) → prompts/get', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(readOnlyKey());

      // 1) Handshake.
      const init = await call('initialize', undefined, null);
      expect(init.status).toBe(200);

      // 2) Principal-scoped listing — caller's own memory + shared overlay.
      const list = await call('resources/list');
      expect(list.status).toBe(200);
      const resources = (list.response.result as { resources: Array<{ uri: string }> }).resources;
      expect(resources.length).toBeGreaterThan(0);
      const ownEpisodeUri = resources.find((r) => r.uri.includes('memory/episodes') && r.uri.includes(ALICE))?.uri;
      expect(ownEpisodeUri).toBeDefined();

      // 3) Read the caller's OWN memory resource discovered from the list.
      const read = await call('resources/read', { uri: ownEpisodeUri! });
      expect(read.status).toBe(200);
      const contents = (read.response.result as { contents: Array<{ text: string }> }).contents;
      expect(contents).toHaveLength(1);
      // Body is framed through the untrusted boundary and carries the payload.
      expect(contents[0].text).toContain('UNTRUSTED');
      expect(contents[0].text).toContain('alice-only-episode');

      // 4) Discover a real skill prompt from the live list, then fetch it.
      const promptsList = await call('prompts/list');
      expect(promptsList.status).toBe(200);
      const prompts = (promptsList.response.result as { prompts: Array<{ name: string }> }).prompts;
      const skillName = prompts.find((p) => p.name.startsWith('skill:'))?.name;
      expect(skillName).toBeDefined();

      const get = await call('prompts/get', { name: skillName!, arguments: { query: 'handshake probe' } });
      expect(get.status).toBe(200);
      const messages = (get.response.result as { messages: Array<{ content: { text: string } }> }).messages;
      expect(messages.length).toBeGreaterThan(0);
      // The skill body is served framed as inert/untrusted data; the user query
      // is echoed in the final message.
      expect(messages.some((m) => m.content.text.includes('UNTRUSTED'))).toBe(true);
      expect(messages.some((m) => m.content.text.includes('handshake probe'))).toBe(true);
    });
  });

  // ── G3 ─────────────────────────────────────────────────────────────────
  describe('G3 — read-only key is rejected on write/delete tools', () => {
    it('FORBIDDEN on a write tool (createCompany) — executor never runs', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(readOnlyKey());

      const result = await call('tools/call', {
        name: 'createCompany',
        arguments: { name: 'Acme' },
      });

      expect(result.status).toBe(403);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.FORBIDDEN);
      expect(executeTool).not.toHaveBeenCalled();
    });

    it('FORBIDDEN on a delete tool (deleteEntity) — executor never runs', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(readOnlyKey());

      const result = await call('tools/call', {
        name: 'deleteEntity',
        arguments: { id: 'x', entityType: 'companies' },
      });

      expect(result.status).toBe(403);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.FORBIDDEN);
      expect(executeTool).not.toHaveBeenCalled();
    });
  });
});
