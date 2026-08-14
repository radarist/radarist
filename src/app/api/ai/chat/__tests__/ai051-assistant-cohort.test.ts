/**
 * @jest-environment node
 */

/**
 * AI-051 — the frozen Assistant cohort.
 *
 * A read-only graph question can gather relevant evidence through every tool
 * iteration and still return `tool_iterations_exhausted` with no answer.
 *
 * These cases are the deterministic, zero-spend replay of that shape and of the
 * boundaries around it. The provider is a scripted stub, so the numbers reported
 * by the receipt at the bottom of this file are synthetic and reproducible —
 * they measure the loop, not a model run.
 *
 * Frozen cases:
 *  1. broad graph gap, evidence early                -> synthesizes before the cap
 *  2. same question, duplicate tool results          -> does not loop
 *  3. sparse evidence                                -> answers with bounded uncertainty
 *  4. tool failure before sufficient evidence        -> explicit incomplete, no fabrication
 *  5. no relevant entities                           -> concise no-evidence answer
 *  6. negative mutation control                      -> zero domain mutations
 *  7. cap honoured                                   -> 15 stays 15
 *
 * Case 7 of the lane's cohort (the Linker proposal journey) is a Firestore
 * acceptance, not a chat-loop case: `tests/emulator/skill-049-linker-proposal.emulator.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));
jest.mock('@/lib/auth-utils', () => ({
  getAuthenticatedUser: jest.fn().mockResolvedValue({ authenticated: true, uid: 'user-ai051' }),
}));

/** Canonical-enough Anthropic pricing for the replay: $3/MTok in, $15/MTok out. */
function priceForTest(model: string, usage: Record<string, unknown>) {
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0);
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  const cacheReadInputTokens = Number(usage.cacheReadInputTokens ?? usage.cache_read_input_tokens ?? 0);
  const cacheCreationInputTokens = Number(usage.cacheCreationInputTokens ?? usage.cache_creation_input_tokens ?? 0);
  const totalInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  return {
    costUsd: (inputTokens * 3 + outputTokens * 15 + cacheReadInputTokens * 0.3 + cacheCreationInputTokens * 3.75) / 1e6,
    pricingModel: model,
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      totalInputTokens,
      totalTokens: totalInputTokens + outputTokens,
    },
    costBreakdown: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreationUsd: 0 },
  };
}

const mockLogAIOperation = jest.fn();
const mockRecordChatTurnCostEstimate = jest.fn();
jest.mock('@/lib/ai/reliability', () => ({
  withRetry: jest.fn((fn: () => unknown) => fn()),
  getCircuitBreaker: jest.fn(() => ({ allowRequest: () => true, recordSuccess: () => {}, recordFailure: () => {} })),
  getRateLimiter: jest.fn(() => ({ waitForToken: () => Promise.resolve(true) })),
  trackCost: jest.fn(() => 0),
  calculateAnthropicUsageCost: jest.fn((model: string, usage: Record<string, unknown>) => priceForTest(model, usage)),
  trackAnthropicUsageCost: jest.fn((model: string, usage: Record<string, unknown>) => priceForTest(model, usage)),
  logAIOperation: (...args: unknown[]) => mockLogAIOperation(...args),
  generateRequestId: jest.fn(() => 'req-ai051'),
  assertCostBudgetAvailable: jest.fn(),
  recordChatTurnCostEstimate: (...args: unknown[]) => mockRecordChatTurnCostEstimate(...args),
  CostBudgetError: class CostBudgetError extends Error {},
}));

const mockCreateAgentRun = jest.fn().mockResolvedValue({ id: 'run-ai051' });
const mockPatchAgentRunAccounting = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/agent-runs', () => ({
  generateAgentRunId: () => 'run-ai051',
  createAgentRun: (input: unknown) => mockCreateAgentRun(input),
  patchAgentRunAccounting: mockPatchAgentRunAccounting,
}));

const { buildPricedFlushResult } = require('@/lib/__tests__/helpers/chat-accounting-flush-mock');
const mockFlushCapturedUsage = jest.fn(
  async (_correlation: unknown, captured: readonly unknown[], _prefix?: unknown, _scope?: unknown) =>
    buildPricedFlushResult(captured as ReadonlyArray<Record<string, unknown>> as never)
);
jest.mock('@/lib/operation-receipt-instrument', () => ({
  __esModule: true,
  flushCapturedUsage: (corr: unknown, captured: unknown, prefix: unknown, scope: unknown) =>
    mockFlushCapturedUsage(corr, captured as readonly unknown[], prefix, scope),
}));

const mockExecuteTool = jest.fn();
jest.mock('@/lib/ai/tools', () => ({
  CORE_AI_TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
}));

const mockExtractMutatedTypes = jest.fn(() => new Set<string>());
jest.mock('@/lib/ai/mutation-tracking', () => ({
  extractMutatedTypes: (...args: unknown[]) => mockExtractMutatedTypes(...(args as [])),
  getToolMutatedTypes: jest.fn(() => [] as string[]),
  normalizeToolName: jest.fn((name: string) => (name.startsWith('mcp__') ? name.split('__').at(-1) : name)),
}));

jest.mock('@/lib/with-timeout', () => ({
  withTimeout: (promise: Promise<unknown>) => promise,
}));

const mockMessagesCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: mockMessagesCreate } })),
}));

jest.mock('@/lib/ai/claude-system-prompt', () => ({
  buildClaudeSystemPrompt: jest.fn(() => 'You are Radarist AI.'),
}));
jest.mock('@/lib/graph/episodes', () => ({
  createEpisode: jest.fn().mockResolvedValue({ id: 'ep-ai051' }),
  completeEpisode: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/agent-events', () => ({ emitAgentEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/chat-preferences-admin', () => ({
  __esModule: true,
  buildWorkingStyleBlock: jest.fn().mockResolvedValue(''),
}));

// ---------------------------------------------------------------------------
// Retained sequence
// ---------------------------------------------------------------------------

/** The gathering phase the retained turn actually performed, in order. */
const RETAINED_OPENING: Array<{ name: string; input: Record<string, unknown> }> = [
  { name: 'searchKnowledgeGraph', input: { query: 'evidence gap' } },
  { name: 'findDataGaps', input: {} },
  { name: 'getGapAnalysis', input: {} },
  { name: 'getEntityDetails', input: { id: 'tech-alpha', type: 'technology' } },
  { name: 'getEntityAssertions', input: { entityId: 'tech-alpha' } },
];

/**
 * The retained turn then re-probed single entities it had already read. This is
 * the shape that burned the rest of the budget; the stub repeats it forever,
 * exactly as the retained turn's model did, so the loop — not the script — has
 * to decide when to stop.
 */
const RETAINED_REPROBE = RETAINED_OPENING.slice(3);

interface StubUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

/**
 * Synthetic per-response usage combines a small uncached prefix with a large
 * cache read that grows on every iteration. It stays below the spend guard so
 * the test isolates iteration behavior.
 */
const TOOL_TURN_USAGE: StubUsage = { input_tokens: 4_000, cache_read_input_tokens: 87_000, output_tokens: 160 };
const SYNTHESIS_TURN_USAGE: StubUsage = { input_tokens: 3_000, cache_read_input_tokens: 60_000, output_tokens: 220 };

function toolUseResponse(
  blocks: Array<{ name: string; input: Record<string, unknown> }>,
  usage: StubUsage,
  seq: number
) {
  return {
    id: `msg_${seq}`,
    content: blocks.map((b, i) => ({ type: 'tool_use', id: `tu_${seq}_${i}`, name: b.name, input: b.input })),
    stop_reason: 'tool_use',
    model: 'claude-sonnet-4-6',
    usage,
  };
}

function textResponse(text: string, usage: StubUsage, seq: number) {
  return {
    id: `msg_${seq}`,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model: 'claude-sonnet-4-6',
    usage,
  };
}

/** True when the route withheld tools for a synthesis turn. */
function isSynthesisRequest(request: { tool_choice?: { type?: string } }): boolean {
  return request?.tool_choice?.type === 'none';
}

/** The trailing directive the route appends inside the tool-result user turn. */
function synthesisDirectiveIn(request: { messages?: Array<{ role: string; content: unknown }> }): string | undefined {
  const last = request.messages?.at(-1);
  if (!last || last.role !== 'user' || !Array.isArray(last.content)) return undefined;
  const trailing = last.content.at(-1) as { type?: string; text?: string } | undefined;
  return trailing?.type === 'text' ? trailing.text : undefined;
}

/**
 * Script the provider: emit the given batches in order, then repeat the last one
 * forever — and, whenever tools are withheld, answer. A real model cannot ask for
 * a tool when `tool_choice: none`, so this stub is faithful to the API contract.
 */
function scriptProvider(batches: Array<Array<{ name: string; input: Record<string, unknown> }>>, answer: string) {
  let seq = 0;
  mockMessagesCreate.mockImplementation(async (request: Record<string, unknown>) => {
    seq++;
    if (isSynthesisRequest(request as { tool_choice?: { type?: string } })) {
      return textResponse(answer, SYNTHESIS_TURN_USAGE, seq);
    }
    const batch = batches[Math.min(seq - 1, batches.length - 1)];
    return toolUseResponse(batch, TOOL_TURN_USAGE, seq);
  });
}

const CONTEXT = { currentRoute: '/dashboard', currentPage: 'Dashboard' };

interface TurnMeasurement {
  case: string;
  providerCalls: number;
  toolIterations: number;
  toolExecutions: number;
  repeatedToolCalls: number;
  suppressedRepeats: number;
  inputTokens: number;
  outputTokens: number;
  providerReceipts: number;
  exactlyPricedReceipts: number;
  unpricedReceipts: number;
  costUsd: number | null;
  answerDelivered: boolean;
  answerChars: number;
  citedToolFacts: string[];
  domainMutations: string[];
  incompleteReason?: string;
  agentRunStatus?: string;
}

const MEASUREMENTS: TurnMeasurement[] = [];

describe('AI-051 — frozen Assistant cohort (provider-stubbed replay)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecuteTool.mockReset();
    mockCreateAgentRun.mockResolvedValue({ id: 'run-ai051' });
    mockExtractMutatedTypes.mockReturnValue(new Set());
    process.env = { ...originalEnv };
    process.env.CLAUDE_CHAT_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.IMPULSE_CHAT_MAX_TOOL_CALLS;
  });

  afterAll(() => {
    process.env = originalEnv;
    // Opt-in so an ordinary `test:coverage` run never dirties the tree. The
    // committed receipts under `evidence/ai051/` were produced by this exact
    // block: `assistant-cohort-baseline-518342f5d.json` from the same file run
    // against the base commit, `assistant-cohort-fixed.json` from this branch.
    if (process.env.AI051_WRITE_RECEIPT !== '1') return;
    const out = path.resolve(__dirname, '../../../../../../evidence/ai051');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, 'assistant-cohort-fixed.json'),
      `${JSON.stringify({ cases: MEASUREMENTS }, null, 2)}\n`
    );
  });

  async function runTurn(message: string) {
    jest.resetModules();
    const { POST } = require('../route');
    const { NextRequest } = require('next/server');
    const req = new NextRequest('http://localhost:3000/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, context: CONTEXT }),
    });
    const res = await POST(req);
    return res.json();
  }

  /** Read the exact turn accounting out of the mocks the route actually drove. */
  function measure(name: string, json: Record<string, unknown>): TurnMeasurement {
    const run = (mockCreateAgentRun.mock.calls.at(-1)?.[0] ?? {}) as {
      status?: string;
      tokenUsage?: { input?: number; output?: number };
    };
    const patched = mockPatchAgentRunAccounting.mock.calls.at(-1)?.[1] as { costUsd?: number | null } | undefined;
    const captured = (mockFlushCapturedUsage.mock.calls.at(-1)?.[1] ?? []) as Array<{
      counters?: { promptTokens?: number; outputTokens?: number; cacheReadTokens?: number };
      usageCompleteness?: string;
    }>;
    const toolCalls = (json.toolCalls ?? []) as Array<{
      name: string;
      args: Record<string, unknown>;
      result: { success: boolean; repeatedCall?: boolean; data?: unknown };
    }>;
    const seen = new Set<string>();
    let repeated = 0;
    for (const c of toolCalls) {
      const sig = `${c.name}:${JSON.stringify(c.args)}`;
      if (seen.has(sig)) repeated++;
      seen.add(sig);
    }
    const answer = typeof json.message === 'string' ? json.message : '';
    const measurement: TurnMeasurement = {
      case: name,
      providerCalls: mockMessagesCreate.mock.calls.length,
      // One tool BATCH per loop iteration; the route emits exactly one provider
      // call per iteration plus the opening call.
      toolIterations: Math.max(0, mockMessagesCreate.mock.calls.length - 1),
      toolExecutions: mockExecuteTool.mock.calls.length,
      repeatedToolCalls: repeated,
      suppressedRepeats: toolCalls.filter((c) => c.result?.repeatedCall === true).length,
      inputTokens: run.tokenUsage?.input ?? 0,
      outputTokens: run.tokenUsage?.output ?? 0,
      providerReceipts: captured.length,
      exactlyPricedReceipts: captured.filter((c) => c.usageCompleteness === 'complete').length,
      unpricedReceipts: captured.filter((c) => c.usageCompleteness !== 'complete').length,
      costUsd: patched?.costUsd ?? null,
      answerDelivered: json.success === true && answer.trim().length > 0,
      answerChars: answer.length,
      citedToolFacts: toolCalls.filter((c) => c.result?.success).map((c) => c.name),
      domainMutations: (json.mutatedEntityTypes ?? []) as string[],
      ...(json.incomplete ? { incompleteReason: (json.incomplete as { reason: string }).reason } : {}),
      ...(run.status ? { agentRunStatus: run.status } : {}),
    };
    MEASUREMENTS.push(measurement);
    return measurement;
  }

  // -------------------------------------------------------------------------
  // Case 1 — the retained failure, replayed
  // -------------------------------------------------------------------------

  it('case 1: broad graph gap with early evidence — synthesizes an answer before the cap', async () => {
    mockExecuteTool.mockImplementation(async ({ name }: { name: string }) => ({
      success: true,
      data: { tool: name, gaps: 4, entities: ['tech-alpha'] },
    }));
    scriptProvider(
      [
        [RETAINED_OPENING[0]],
        [RETAINED_OPENING[1]],
        [RETAINED_OPENING[2]],
        [RETAINED_OPENING[3]],
        [RETAINED_OPENING[4]],
        // …and from here the retained turn re-probed forever.
        RETAINED_REPROBE,
      ],
      'Radarist holds 4 open data gaps. findDataGaps returned 4 and getGapAnalysis confirmed tech-alpha is the weakest.'
    );

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');
    const m = measure('1-broad-gap-synthesizes-before-cap', json);

    expect(json.success).toBe(true);
    expect(json.incomplete).toBeUndefined();
    expect(m.answerDelivered).toBe(true);
    // The whole point: an answer strictly BEFORE the 15-iteration cap.
    expect(m.toolIterations).toBeLessThan(15);
    expect(m.toolExecutions).toBe(RETAINED_OPENING.length);
    // The re-probe batch was served from the earlier results, not re-run.
    expect(m.suppressedRepeats).toBe(RETAINED_REPROBE.length);
    expect(m.citedToolFacts).toEqual(expect.arrayContaining(['findDataGaps', 'getGapAnalysis']));
    expect(m.domainMutations).toEqual([]);
  });

  it('case 1b: the synthesis turn withholds tools and carries the evidence-bound directive', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, data: { gaps: 4 } });
    scriptProvider([[RETAINED_OPENING[1]], RETAINED_REPROBE], 'findDataGaps returned 4 open gaps.');
    await runTurn('Which retained evidence gap most weakens our current radar view?');

    const synthesisRequests = mockMessagesCreate.mock.calls
      .map(([request]) => request as Record<string, unknown>)
      .filter((request) => isSynthesisRequest(request as { tool_choice?: { type?: string } }));

    expect(synthesisRequests).toHaveLength(1);
    const directive = synthesisDirectiveIn(synthesisRequests[0] as { messages?: [] });
    expect(directive).toMatch(/ONLY the tool results already in this conversation/);
    expect(directive).toMatch(/never invent an id, number, date or name/i);
    // Opening call, the first re-probe batch (genuinely new), the batch that
    // repeats it, then the reserved synthesis. The reservation re-uses a call the
    // loop was already going to make — it does not add a fifth.
    expect(mockMessagesCreate).toHaveBeenCalledTimes(4);
  });

  // -------------------------------------------------------------------------
  // Case 2 — duplicate results must not loop
  // -------------------------------------------------------------------------

  it('case 2: identical repeated tool results do not consume the budget', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, data: { total: 2, ids: ['a', 'b'] } });
    scriptProvider([[{ name: 'searchKnowledgeGraph', input: { query: 'same' } }]], 'searchKnowledgeGraph returned 2.');

    const json = await runTurn('What do we know about the same thing?');
    const m = measure('2-duplicate-results-no-loop', json);

    expect(json.success).toBe(true);
    // Executed exactly once no matter how many times the model re-asked.
    expect(m.toolExecutions).toBe(1);
    expect(m.suppressedRepeats).toBe(1);
    expect(m.toolIterations).toBe(2);
    expect(m.answerDelivered).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Case 3 — sparse evidence
  // -------------------------------------------------------------------------

  it('case 3: sparse evidence returns an answer with explicit bounded uncertainty', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, data: { total: 1, results: [{ id: 'tech-alpha' }] } });
    scriptProvider(
      [[{ name: 'searchKnowledgeGraph', input: { query: 'sparse' } }]],
      'Only one entity (tech-alpha) matched searchKnowledgeGraph. That is not enough to rank the gaps; a corroborating source is missing.'
    );

    const json = await runTurn('Rank our evidence gaps by severity.');
    const m = measure('3-sparse-evidence-bounded-uncertainty', json);

    expect(m.answerDelivered).toBe(true);
    expect(m.toolExecutions).toBe(1);
    // The directive is what makes the uncertainty explicit rather than optional.
    const directive = synthesisDirectiveIn(
      mockMessagesCreate.mock.calls.map(([r]) => r).find((r) => isSynthesisRequest(r)) as { messages?: [] }
    );
    expect(directive).toMatch(/state plainly which part is unsupported/i);
  });

  // -------------------------------------------------------------------------
  // Case 4 — tool failure before sufficient evidence
  // -------------------------------------------------------------------------

  it('case 4: a turn whose tools all failed returns the explicit incomplete result, never a fabricated answer', async () => {
    mockExecuteTool.mockResolvedValue({ success: false, error: 'graph unavailable' });
    scriptProvider(
      [[{ name: 'findDataGaps', input: {} }], [{ name: 'getGapAnalysis', input: {} }]],
      'THIS ANSWER MUST NEVER BE REACHED'
    );

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');
    const m = measure('4-tool-failure-incomplete', json);

    expect(json.success).toBe(false);
    expect(json.incomplete).toEqual(expect.objectContaining({ reason: 'tool_iterations_exhausted', limit: 15 }));
    expect(m.answerDelivered).toBe(false);
    // No synthesis was ever offered — nothing citable existed to synthesize from.
    expect(mockMessagesCreate.mock.calls.map(([r]) => r).filter((r) => isSynthesisRequest(r))).toHaveLength(0);
    // AI-042 — the terminal code is the FIRST entry; the per-tool failures follow.
    const run = mockCreateAgentRun.mock.calls.at(-1)?.[0] as { status: string; errors: string[] };
    expect(run.status).toBe('failure');
    expect(run.errors[0]).toBe('tool_iterations_exhausted');
    // The unreserved exhausted turn accumulates a deliberately large synthetic
    // input envelope while still delivering no answer.
    expect(m.inputTokens).toBeGreaterThan(1_000_000);
    expect(m.providerCalls).toBe(16);
  });

  it('case 4b: one late success is enough to earn the reserved synthesis', async () => {
    let calls = 0;
    mockExecuteTool.mockImplementation(async () => {
      calls++;
      return calls >= 3 ? { success: true, data: { gaps: 2 } } : { success: false, error: 'graph unavailable' };
    });
    scriptProvider(
      [
        [{ name: 'findDataGaps', input: {} }],
        [{ name: 'getGapAnalysis', input: {} }],
        [{ name: 'searchKnowledgeGraph', input: { query: 'late' } }],
        [{ name: 'searchKnowledgeGraph', input: { query: 'late' } }],
      ],
      'Two tools failed (findDataGaps, getGapAnalysis); searchKnowledgeGraph returned 2 gaps.'
    );

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');
    expect(json.success).toBe(true);
    expect(json.message).toContain('failed');
  });

  // -------------------------------------------------------------------------
  // Case 5 — no relevant entities
  // -------------------------------------------------------------------------

  it('case 5: an empty but successful search yields a concise no-evidence answer', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, data: { total: 0, results: [] } });
    scriptProvider(
      [[{ name: 'searchKnowledgeGraph', input: { query: 'nothing here' } }]],
      'searchKnowledgeGraph returned 0 matches: the graph holds nothing on this topic.'
    );

    const json = await runTurn('What do we know about underwater basket weaving?');
    const m = measure('5-no-relevant-entities', json);

    expect(m.answerDelivered).toBe(true);
    expect(json.incomplete).toBeUndefined();
    expect(m.toolExecutions).toBe(1);
    expect(m.answerChars).toBeLessThan(400);
  });

  // -------------------------------------------------------------------------
  // Case 6 — negative mutation control
  // -------------------------------------------------------------------------

  it('case 6: a read-only turn performs zero domain mutations', async () => {
    const executedNames: string[] = [];
    mockExecuteTool.mockImplementation(async ({ name }: { name: string }) => {
      executedNames.push(name);
      return { success: true, data: { tool: name } };
    });
    scriptProvider([[RETAINED_OPENING[0]], [RETAINED_OPENING[1]], RETAINED_REPROBE], 'Read-only summary.');

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');
    const m = measure('6-zero-mutation-control', json);

    // Census derived from the live permission registry, not from a list in this
    // file: every tool this turn executed must be `read`-class. A `write`,
    // `delete` or `signals` class would be a Firestore/Neo4j-touching call.
    const { getToolPermissions } = require('@/lib/mcp/permissions');
    expect(executedNames.length).toBeGreaterThan(0);
    const nonRead = [...new Set(executedNames)].filter(
      (name) => !getToolPermissions(name).every((perm: string) => perm === 'read')
    );
    expect(nonRead).toEqual([]);
    expect(m.domainMutations).toEqual([]);
    expect(json.mutatedEntityTypes).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Case 7 — the cap is unchanged
  // -------------------------------------------------------------------------

  it('case 7: the 15-iteration cap is unchanged, and the reserved turn is the 15th, not a 16th', async () => {
    mockExecuteTool.mockImplementation(async ({ name }: { name: string }) => ({ success: true, data: { tool: name } }));
    // Every batch is genuinely new, so nothing reserves early; the loop must run
    // to the cap and spend its LAST scheduled call on the answer.
    let n = 0;
    mockMessagesCreate.mockImplementation(async (request: Record<string, unknown>) => {
      n++;
      if (isSynthesisRequest(request as { tool_choice?: { type?: string } })) {
        return textResponse('getEntityDetails resolved 15 distinct entities.', SYNTHESIS_TURN_USAGE, n);
      }
      return toolUseResponse(
        [{ name: 'getEntityDetails', input: { id: `tech-${n}`, type: 'technology' } }],
        TOOL_TURN_USAGE,
        n
      );
    });

    const json = await runTurn('Walk every technology and tell me which is least supported.');
    const m = measure('7-cap-unchanged', json);

    expect(m.toolExecutions).toBe(15);
    expect(m.toolIterations).toBe(15);
    // 1 opening call + 15 in-loop calls. Identical to the retained turn's shape:
    // the LAST one is now the answer instead of a discarded tool request.
    expect(m.providerCalls).toBe(16);
    expect(m.answerDelivered).toBe(true);
    expect(json.incomplete).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  it('reconciles tool receipts, token totals, cost and the final AgentRun outcome', async () => {
    mockExecuteTool.mockResolvedValue({ success: true, data: { gaps: 4 } });
    scriptProvider([[{ name: 'findDataGaps', input: {} }], [{ name: 'findDataGaps', input: {} }]], 'findDataGaps: 4.');

    const json = await runTurn('Which retained evidence gap most weakens our current radar view?');

    const providerCalls = mockMessagesCreate.mock.calls.length;
    const captured = mockFlushCapturedUsage.mock.calls.at(-1)?.[1] as Array<{
      counters: { promptTokens: number; outputTokens: number; cacheReadTokens?: number };
      usageCompleteness: string;
    }>;
    const run = mockCreateAgentRun.mock.calls.at(-1)?.[0] as {
      status: string;
      tokenUsage: { input: number; output: number };
    };
    const patched = mockPatchAgentRunAccounting.mock.calls.at(-1)?.[1] as { costUsd: number | null };

    // Two tool-offering calls plus the reserved synthesis call.
    expect(providerCalls).toBe(3);
    // One durable receipt per provider response — no orphan, no double count.
    expect(captured).toHaveLength(providerCalls);
    expect(captured.every((c) => c.usageCompleteness === 'complete')).toBe(true);

    // The AgentRun's token totals are the exact fold of the receipts', not an
    // independent count that could silently disagree with them.
    const receiptInput = captured.reduce(
      (sum, c) => sum + c.counters.promptTokens + (c.counters.cacheReadTokens ?? 0),
      0
    );
    const receiptOutput = captured.reduce((sum, c) => sum + c.counters.outputTokens, 0);
    expect(run.tokenUsage).toEqual({ input: receiptInput, output: receiptOutput });
    // And they are the exact sum of what the provider stub reported.
    expect(receiptInput).toBe(
      (TOOL_TURN_USAGE.input_tokens + (TOOL_TURN_USAGE.cache_read_input_tokens ?? 0)) * 2 +
        SYNTHESIS_TURN_USAGE.input_tokens +
        (SYNTHESIS_TURN_USAGE.cache_read_input_tokens ?? 0)
    );
    expect(receiptOutput).toBe(TOOL_TURN_USAGE.output_tokens * 2 + SYNTHESIS_TURN_USAGE.output_tokens);

    expect(run.status).toBe('success');
    expect(patched.costUsd).toBeGreaterThan(0);
    expect(json.success).toBe(true);
    // The receipt the user sees lists every call, including the suppressed repeat.
    expect((json.toolCalls as unknown[]).length).toBe(2);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockRecordChatTurnCostEstimate).toHaveBeenCalled();
  });
});
