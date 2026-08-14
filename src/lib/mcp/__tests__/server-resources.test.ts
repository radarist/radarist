/**
 * In-process integration tests for the Wave-2 MCP integration spine.
 *
 * These call `handleMcpRequest` directly (NOT a live HTTP server) and exercise
 * the REAL lane modules wired by `server.ts`:
 *   - `resources.ts`     — the owner ACL + not-found collapse (Lane D)
 *   - `budget.ts`        — durable per-key deny-before-spend (Lane A)
 *   - `grounding-wrap.ts`— the fact-asserting pass-through (Lane F)
 * Only their IO edges are mocked (graph readers, firebase-admin, Gemini client),
 * so the wiring contract — capability handshake, principal-scoped listing,
 * cross-tenant no-existence-leak, read-budget `-32020` — is proven end to end.
 *
 * @jest-environment node
 */

// --- API key validation (auth edge) ----------------------------------------
jest.mock('../api-keys', () => ({
  validateApiKey: jest.fn(),
}));

// --- tools surface (kept tiny — this suite is about resources/budget) -------
jest.mock('../schema-converter', () => ({
  convertGeminiToolsToMcpTools: jest.fn().mockReturnValue([]),
}));
jest.mock('@/lib/ai/tools', () => ({
  CORE_AI_TOOLS: [],
  executeTool: jest.fn().mockResolvedValue({ success: true, data: { ok: true } }),
}));

// --- grounding-wrap IO edge (REAL grounding-wrap runs over this mock) -------
jest.mock('@/lib/ai/client', () => ({
  generateGroundedContent: jest.fn(),
}));

// --- resources.ts graph-reader edges (REAL resources.ts runs the ACL) ------
jest.mock('@/lib/graph/episodes', () => ({
  queryEpisodes: jest.fn().mockResolvedValue([{ id: 'ep1' }]),
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
import { queryEpisodes } from '@/lib/graph/episodes';
import { executeTool } from '@/lib/ai/tools';
import { JSON_RPC_ERROR_CODES } from '../types';
import type { ApiKey } from '../types';

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

function key(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key-alice',
    hashedKey: 'h',
    userId: ALICE,
    name: 'test',
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

describe('MCP integration spine (Wave 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize — capability handshake (G1)', () => {
    it('advertises both resources and prompts capabilities', async () => {
      const result = await call('initialize', undefined, null);

      expect(result.status).toBe(200);
      const caps = (result.response.result as { capabilities: Record<string, unknown> }).capabilities;
      expect(caps.resources).toBeDefined();
      expect(caps.prompts).toBeDefined();
      expect(caps.tools).toBeDefined();
    });
  });

  describe('resources/list — principal-scoped', () => {
    it('lists only the caller`s own memory URIs plus the shared overlay', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key());

      const result = await call('resources/list');

      expect(result.status).toBe(200);
      const resources = (result.response.result as { resources: Array<{ uri: string }> }).resources;
      const uris = resources.map((r) => r.uri);

      // Every per-user URI is scoped to the caller; no other principal leaks in.
      expect(uris.some((u) => u.includes('memory/episodes') && u.includes(ALICE))).toBe(true);
      expect(uris.some((u) => u.includes(BOB))).toBe(false);
      // The shared community-reports overlay is always offered.
      expect(uris.some((u) => u.includes('graph/community-reports'))).toBe(true);
    });
  });

  describe('resources/read — owner ACL', () => {
    it('serves the owner their own memory, framed as untrusted data', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key());

      const result = await call('resources/read', { uri: `radarist://memory/episodes/${ALICE}` });

      expect(result.status).toBe(200);
      const contents = (result.response.result as { contents: Array<{ text: string }> }).contents;
      expect(contents).toHaveLength(1);
      // Body is wrapped through the untrusted boundary and carries the payload.
      expect(contents[0].text).toContain('UNTRUSTED');
      expect(contents[0].text).toContain('ep1');
      // M14: the agent/MCP resource surface includes system-principal sweep
      // episodes alongside the caller's own.
      expect(queryEpisodes).toHaveBeenCalledWith({ userId: ALICE, includeSystem: true });
    });

    it('collapses a cross-tenant read to NOT_FOUND without touching the reader', async () => {
      // Alice (a valid read key) tries to read Bob's memory.
      (validateApiKey as jest.Mock).mockResolvedValue(key());

      const result = await call('resources/read', { uri: `radarist://memory/episodes/${BOB}` });

      expect(result.status).toBe(404);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.NOT_FOUND);
      // The owner check fails BEFORE any IO — the reader is never consulted, so
      // the victim`s existence is never probed.
      expect(queryEpisodes).not.toHaveBeenCalled();
    });

    it('an ADMIN key still cannot read another user`s memory', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key({ id: 'key-admin', permissions: ['admin'] }));

      const result = await call('resources/read', { uri: `radarist://memory/episodes/${BOB}` });

      expect(result.status).toBe(404);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.NOT_FOUND);
      expect(queryEpisodes).not.toHaveBeenCalled();
    });

    it('collapses a malformed radarist:// URI to the SAME NOT_FOUND family (no leak)', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key());

      const result = await call('resources/read', { uri: 'radarist://bogus/authority' });

      expect(result.status).toBe(404);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.NOT_FOUND);
    });

    it('serves the shared community-reports overlay to any read key', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key({ id: 'key-cr' }));

      const result = await call('resources/read', { uri: 'radarist://graph/community-reports?q=ai' });

      expect(result.status).toBe(200);
      const contents = (result.response.result as { contents: Array<{ text: string }> }).contents;
      expect(contents[0].text).toContain('community-report-1');
    });

    it('rejects a key lacking the read permission with FORBIDDEN', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key({ id: 'key-write', permissions: ['write'] }));

      const result = await call('resources/read', { uri: `radarist://memory/episodes/${ALICE}` });

      expect(result.status).toBe(403);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.FORBIDDEN);
    });

    it('rejects a missing/empty uri with INVALID_PARAMS', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key());

      const result = await call('resources/read', {});

      expect(result.status).toBe(400);
      expect(result.response.error?.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
    });
  });

  describe('resources/read — durable read budget (G4)', () => {
    const ORIGINAL = process.env.MCP_DAILY_READ_BUDGET;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.MCP_DAILY_READ_BUDGET;
      else process.env.MCP_DAILY_READ_BUDGET = ORIGINAL;
    });

    it('returns -32020 RATE_LIMITED once the per-key daily budget is exhausted', async () => {
      process.env.MCP_DAILY_READ_BUDGET = '1';
      // Same key id across both calls so they share the per-key counter doc.
      (validateApiKey as jest.Mock).mockResolvedValue(key({ id: 'key-budget' }));

      const uri = `radarist://memory/episodes/${ALICE}`;
      const first = await call('resources/read', { uri });
      const second = await call('resources/read', { uri });

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(second.response.error?.code).toBe(JSON_RPC_ERROR_CODES.RATE_LIMITED);
    });
  });

  describe('tools/call — grounding wrap (MCP path only)', () => {
    it('passes a non-fact-asserting tool result through unchanged', async () => {
      (validateApiKey as jest.Mock).mockResolvedValue(key());

      const result = await call('tools/call', { name: 'listSignals', arguments: { status: 'pending' } });

      expect(result.status).toBe(200);
      expect(executeTool).toHaveBeenCalled();
      const content = (result.response.result as { content: Array<{ text: string }> }).content;
      expect(content[0].text).toContain('ok');
    });
  });
});
