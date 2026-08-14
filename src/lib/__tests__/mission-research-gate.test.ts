jest.mock('../missions', () => ({
  createMission: jest.fn(),
}));
jest.mock('../mission-chains', () => ({
  createChain: jest.fn(),
}));

// OPS-004: the gate runs the MCP preflight (the common dispatch choke point).
// Default healthy so gate-routing tests are unaffected.
const mockPreflightMissionMcp = jest.fn();
jest.mock('../mission-mcp-preflight', () => ({
  preflightMissionMcp: (...args: unknown[]) => mockPreflightMissionMcp(...args),
  formatMcpPreflightFailure: (r: { reason?: string; unreachable: string[] }) =>
    `${r.reason ?? 'mcp-preflight-failed'}: ${r.unreachable.join(', ')}`,
}));

// The gate dynamic-imports the classifier when no slots are provided. Spy on it
// to prove it never runs when the preflight fails.
const mockClassifyMissionIntent = jest.fn();
jest.mock('../ai/mission-intent-classifier', () => ({
  classifyMissionIntent: (...args: unknown[]) => mockClassifyMissionIntent(...args),
}));

import * as missionsMod from '../missions';
import * as chainsMod from '../mission-chains';
import {
  shouldGateResearch,
  buildResearchChainSteps,
  dispatchMissionWithGate,
  RESEARCH_CHAIN_STEP_AGENTS,
} from '../mission-research-gate';
import { SCOUT_FETCHED_VIA_VALUES } from '../schemas/scout-bundle';

const createMissionMock = missionsMod.createMission as jest.Mock;
const createChainMock = chainsMod.createChain as jest.Mock;

describe('shouldGateResearch', () => {
  it('triggers for a neutral analytical creator prompt with no bundle', () => {
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Give me an analysis of open-weight AI model economics for the next 12 months.',
      })
    ).toEqual({ gate: true });
  });

  it('skips non-creator agents', () => {
    expect(shouldGateResearch({ agent: 'scout', prompt: 'Research the AI market' })).toEqual({
      gate: false,
      reason: 'not-creator-agent',
    });
  });

  it('skips when the prompt already has a parent-result token', () => {
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Write a report using: {{parent.result}}',
      })
    ).toEqual({ gate: false, reason: 'downstream-of-chain' });
  });

  it('skips when the prompt carries its own bundle marker', () => {
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Write the report.\n\n### Research Bundle\nSources: [1] OpenAI 2025 report...\nFindings: ...',
      })
    ).toEqual({ gate: false, reason: 'inline-research-bundle' });
  });

  it('skips when the prompt is heavy with real citations', () => {
    const inlineCitations = [1, 2, 3, 4, 5].map((n) => `[${n}] https://example.com/${n}`).join('\n');
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Summarize these sources.\n' + inlineCitations + '\n' + 'x'.repeat(500),
      })
    ).toMatchObject({ gate: false });
  });

  it('skips when the prompt is short and narrow (likely reformatting)', () => {
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Reformat the data I provided earlier as a bullet list',
      })
    ).toEqual({ gate: false, reason: 'short-narrow-prompt' });
  });

  it('triggers on a short but analytical prompt', () => {
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Analyze the market for open-weight AI models',
      })
    ).toEqual({ gate: true });
  });

  // AI-054 — the analytical vocabulary is written as stems, but a trailing `\b`
  // meant a stem only matched when the word ENDED there. `analyze`, `strategy`,
  // `trends`, `adopting` and `comparing` all fell through to
  // `short-narrow-prompt` and never reached the Scout. Each row here is a short
  // prompt (under SHORT_PROMPT_CHARS) whose ONLY analytical signal is the word
  // under test, so a regression re-narrows the stem and the row fails.
  describe('AI-054 — analytical stems match their real inflections', () => {
    it.each([
      ['analyze', 'Analyze our position here'],
      ['analyse', 'Analyse our position here'],
      ['analysis', 'Write the analysis for us'],
      ['analyzing', 'Start analyzing our position'],
      ['strategy', 'Write up our strategy here'],
      ['strategic', 'Write the strategic view up'],
      ['strategies', 'Write up the strategies here'],
      ['trend', 'Write up the trend for us'],
      ['trends', 'Write up technology trends'],
      ['adopt', 'Should we adopt this now'],
      ['adopting', 'Should we be adopting this'],
      ['adopted', 'Has this been adopted yet'],
      ['adoption', 'Write up the adoption case'],
      ['compare', 'Compare these two for us'],
      ['comparing', 'Start comparing these two'],
      ['comparison', 'Write the comparison up'],
    ])('gates a short creator prompt carrying %s', (_word, prompt) => {
      expect(shouldGateResearch({ agent: 'creator', prompt })).toEqual({ gate: true });
    });

    // The widened stems are word-INITIAL: the leading \b still holds, so an
    // analytical stem buried inside another word must not gate, and a genuine
    // reformatting request must still exit at short-narrow-prompt.
    it.each([
      ['a reformatting request', 'Reformat the text I gave you'],
      ['a translation request', 'Translate the summary to Spanish'],
      ['a shortening request', 'Shorten the intro paragraph'],
      ['a mid-word stem (maladopted is not a word-initial stem)', 'Fix the header spacing please'],
    ])('still exits short-narrow-prompt for %s', (_case, prompt) => {
      expect(shouldGateResearch({ agent: 'creator', prompt })).toEqual({
        gate: false,
        reason: 'short-narrow-prompt',
      });
    });
  });

  it('respects the explicit skipResearchGate flag', () => {
    expect(
      shouldGateResearch({
        agent: 'creator',
        prompt: 'Analyze the market',
        skipResearchGate: true,
      })
    ).toEqual({ gate: false, reason: 'explicit-skip' });
  });
});

describe('buildResearchChainSteps', () => {
  it('returns a 2-step chain when the gate triggers', () => {
    const steps = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Give me an analysis of open-weight AI model economics for the next 12 months.',
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].agent).toBe('scout');
    expect(steps[1].agent).toBe('creator');
  });

  it('scout step prompt contains the original analytical topic', () => {
    const steps = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Give me an analysis of open-weight AI model economics for the next 12 months.',
    });
    expect(steps[0].prompt).toContain('open-weight AI model economics');
  });

  it('scout step prompt demands the structured json bundle block', () => {
    const steps = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Analyze the market for open-weight AI models',
    });
    expect(steps[0].prompt).toMatch(/```\s*json/i);
    expect(steps[0].prompt).toMatch(/tool_call_id/);
    expect(steps[0].prompt).toMatch(/fetched_via/);
    expect(steps[0].prompt).toMatch(/admiralty/i);
  });

  it('creator step embeds {{parent.result}} and tells creator to cite from sources[]', () => {
    const steps = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Give me an analysis of open-weight AI model economics.',
    });
    expect(steps[1].prompt).toContain('{{parent.result}}');
    expect(steps[1].prompt).toContain('open-weight AI model economics');
    expect(steps[1].prompt).toMatch(/sources\[?\]?/i);
  });

  it('scout step prompt demands a queries[] field, single-source→unresolved, and anti-padding rules', () => {
    const steps = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Analyze the market for open-weight AI models',
    });
    expect(steps[0].prompt).toMatch(/queries/);
    expect(steps[0].prompt).toMatch(/single.source|only one source/i);
    expect(steps[0].prompt).toMatch(/unresolved/);
    // New: anti-citation-padding assertions — both cited sources must independently
    // support the specific claim, not just appear on the same general topic.
    expect(steps[0].prompt).toMatch(/padding|specific.*claim|independently/i);
  });

  it('keeps the schema and the prompt provenance vocabulary aligned', () => {
    const [scout] = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Analyze the market for open-weight AI models',
    });

    for (const fetchedVia of SCOUT_FETCHED_VIA_VALUES) {
      expect(scout.prompt).toContain(fetchedVia);
    }
  });

  it('treats downstream report instructions as quoted research context, not Scout work', () => {
    const designBrief = {
      theme: 'brand-dark' as const,
      infographicStyle: 'Board-ready editorial graphics',
      source: 'user' as const,
    };
    const [scout, creator] = buildResearchChainSteps({
      agent: 'creator',
      prompt: 'Create and publish a report with an infographic and a rendered diagram.',
      designBrief,
    });

    expect(scout.prompt).toContain('BEGIN DOWNSTREAM TOPIC');
    expect(scout.prompt).toContain('END DOWNSTREAM TOPIC');
    expect(scout.prompt).toMatch(/quoted research context/i);
    expect(scout.prompt).toMatch(/do not delegate or spawn sub-agents/i);
    expect(scout.prompt).toMatch(/do not draft, render, generate, or publish/i);
    expect(scout.designBrief).toBeUndefined();
    expect(creator.designBrief).toEqual(designBrief);
  });

  it('throws if called on a non-gated input (defensive — caller should check)', () => {
    expect(() => buildResearchChainSteps({ agent: 'scout', prompt: 'anything' })).toThrow(/only.*creator/i);
  });
});

describe('dispatchMissionWithGate', () => {
  beforeEach(() => {
    createMissionMock.mockReset();
    createChainMock.mockReset();
    mockClassifyMissionIntent.mockReset();
    mockClassifyMissionIntent.mockResolvedValue({
      slots: [],
      metadata: { latencyMs: 0, costUsd: 0, fallback: true, model: 'test' },
    });
    mockPreflightMissionMcp.mockReset();
    mockPreflightMissionMcp.mockResolvedValue({
      ok: true,
      baseUrl: 'http://127.0.0.1:9002/api/mcp',
      checked: ['entities', 'graph', 'signals', 'research', 'radar', 'reports'],
      unreachable: [],
    });
  });

  it('OPS-004: throws and never calls the classifier when the MCP preflight fails (sweep/direct-gate path)', async () => {
    // The sweep cron and any direct-gate caller reach the classifier HERE with
    // no slots. A failed preflight must abort before the paid classifier.
    mockPreflightMissionMcp.mockResolvedValue({
      ok: false,
      reason: 'mcp-preflight-failed',
      baseUrl: 'http://127.0.0.1:9002/api/mcp',
      checked: ['entities'],
      unreachable: ['reports'],
    });

    await expect(
      dispatchMissionWithGate('system-sweep', { agent: 'scout', prompt: 'sweep discovery', skipResearchGate: true })
    ).rejects.toThrow(/mcp-preflight-failed/);

    expect(mockClassifyMissionIntent).not.toHaveBeenCalled();
    expect(createMissionMock).not.toHaveBeenCalled();
    expect(createChainMock).not.toHaveBeenCalled();
  });

  it('OPS-004: skips the gate preflight entirely when the caller passes preflightVerified (route path)', async () => {
    // The HTTP route already ran the preflight before its classifier call; the
    // gate must not re-probe (a second failure would become an unreceipted 500).
    createMissionMock.mockResolvedValue({ id: 'mission-1', agent: 'scout', prompt: 'research X' });
    // Even if the (unused) preflight would fail, verified callers proceed.
    mockPreflightMissionMcp.mockResolvedValue({
      ok: false,
      reason: 'mcp-preflight-failed',
      baseUrl: 'x',
      checked: [],
      unreachable: ['reports'],
    });

    const result = await dispatchMissionWithGate(
      'user-a',
      { agent: 'scout', prompt: 'research X' },
      { slots: [] },
      { preflightVerified: true }
    );

    expect(mockPreflightMissionMcp).not.toHaveBeenCalled();
    expect(result.gated).toBe(false);
  });

  it('OPS-004: threads the paid classifier metadata into the gated chain (primary report path)', async () => {
    mockClassifyMissionIntent.mockResolvedValue({
      slots: [{ name: 'main', intent: 'vendor report' }],
      metadata: { latencyMs: 5, costUsd: 0.003, fallback: false, model: 'gemini-3-flash-preview' },
    });
    createChainMock.mockResolvedValue({
      chainId: 'chain-1',
      missions: [
        { id: 'm-scout', agent: 'scout', prompt: '...', chainStep: 1 },
        { id: 'm-creator', agent: 'creator', prompt: '...', chainStep: 2 },
      ],
    });

    // A gate-triggering creator prompt with NO caller-supplied slots → the gate
    // classifies, then must carry that metadata into createChain.
    await dispatchMissionWithGate('user-a', {
      agent: 'creator',
      prompt: 'Give me an analysis of open-weight AI model economics for the next 12 months.',
    });

    expect(createChainMock).toHaveBeenCalledTimes(1);
    const [, , extras] = createChainMock.mock.calls[0];
    expect(extras).toEqual(
      expect.objectContaining({
        slots: [{ name: 'main', intent: 'vendor report' }],
        classifierMetadata: expect.objectContaining({ costUsd: 0.003, fallback: false }),
      })
    );
  });

  it('creates a single mission when the gate does NOT trigger', async () => {
    createMissionMock.mockResolvedValue({
      id: 'mission-1',
      agent: 'scout',
      prompt: 'research X',
    });

    const result = await dispatchMissionWithGate('user-a', {
      agent: 'scout',
      prompt: 'research X',
    });

    expect(createMissionMock).toHaveBeenCalledTimes(1);
    expect(createChainMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      dispatched: [{ id: 'mission-1', agent: 'scout', prompt: 'research X' }],
      gated: false,
    });
  });

  it('creates a 2-mission chain when the gate triggers', async () => {
    createChainMock.mockResolvedValue({
      chainId: 'chain-abc',
      missions: [
        { id: 'mission-scout-1', agent: 'scout', prompt: '...', chainStep: 1, chainTotalSteps: 2 },
        { id: 'mission-creator-2', agent: 'creator', prompt: '...{{parent.result}}', chainStep: 2, chainTotalSteps: 2 },
      ],
    });

    const result = await dispatchMissionWithGate('user-a', {
      agent: 'creator',
      prompt: 'Give me an analysis of open-weight AI model economics for the next 12 months.',
    });

    expect(createMissionMock).not.toHaveBeenCalled();
    expect(createChainMock).toHaveBeenCalledTimes(1);
    const chainCallArgs = createChainMock.mock.calls[0];
    expect(chainCallArgs[0]).toBe('user-a');
    expect(chainCallArgs[1]).toHaveLength(2);
    expect(chainCallArgs[1][0].agent).toBe('scout');
    expect(chainCallArgs[1][1].agent).toBe('creator');

    expect(result).toEqual({
      dispatched: [
        expect.objectContaining({ id: 'mission-scout-1', agent: 'scout', chainStep: 1 }),
        expect.objectContaining({ id: 'mission-creator-2', agent: 'creator', chainStep: 2 }),
      ],
      gated: true,
      chainId: 'chain-abc',
    });
  });

  it('returns the first mission as the one to fire Inngest for', async () => {
    createChainMock.mockResolvedValue({
      chainId: 'chain-abc',
      missions: [
        { id: 'mission-scout-1', agent: 'scout', prompt: '...', chainStep: 1, chainTotalSteps: 2 },
        { id: 'mission-creator-2', agent: 'creator', prompt: '...{{parent.result}}', chainStep: 2, chainTotalSteps: 2 },
      ],
    });

    const result = await dispatchMissionWithGate('user-a', {
      agent: 'creator',
      prompt: 'Analyze the open-weight AI model market',
    });

    // Consumers fire Inngest for the FIRST dispatched mission. Subsequent
    // chain steps are fired automatically by the advance-chain step.
    expect(result.dispatched[0].id).toBe('mission-scout-1');
  });
});

// ============================================================================
// AI-053 — per-step cost authorization
// ============================================================================

describe('dispatchMissionWithGate — AI-053 per-step cost authorization', () => {
  const GATING_PROMPT = 'Analyze the competitive landscape and adoption economics for open-weight AI models';
  // Structural stand-ins for the real envelope. The cast lives at the call
  // boundary, not on the constants — `as never` would poison the spread below.
  const SCOUT_COST = { authorizedMaxCostUsd: 31, executionEnvelope: { totalMaxCostUsd: 31 } };
  const CREATOR_COST = { authorizedMaxCostUsd: 31, executionEnvelope: { totalMaxCostUsd: 31 } };
  const costMap = (m: Record<string, object>) => m as Record<string, never>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPreflightMissionMcp.mockResolvedValue({ ok: true });
    createMissionMock.mockResolvedValue({ id: 'mission-1', agent: 'scout', prompt: '...' });
    createChainMock.mockResolvedValue({
      chainId: 'chain-abc',
      missions: [
        { id: 'mission-scout-1', agent: 'scout', chainStep: 1 },
        { id: 'mission-creator-2', agent: 'creator', chainStep: 2 },
      ],
    });
  });

  it('RESEARCH_CHAIN_STEP_AGENTS matches what buildResearchChainSteps actually creates', () => {
    // The agent-keyed cost map assumes the exported constant IS the chain shape.
    // If they ever drift, a paid dispatch would price the wrong steps.
    expect(buildResearchChainSteps({ agent: 'creator', prompt: GATING_PROMPT }).map((s) => s.agent)).toEqual([
      ...RESEARCH_CHAIN_STEP_AGENTS,
    ]);
  });

  it('hands createChain one authorized envelope per step, positionally aligned to the steps', async () => {
    await dispatchMissionWithGate(
      'user-a',
      { agent: 'creator', prompt: GATING_PROMPT },
      { slots: [] },
      { perStepCostExtras: costMap({ scout: SCOUT_COST, creator: CREATOR_COST }) }
    );

    const [, steps, deliverableExtras, perStepExtras] = createChainMock.mock.calls[0];
    expect((steps as Array<{ agent: string }>).map((s) => s.agent)).toEqual(['scout', 'creator']);
    expect(perStepExtras).toEqual([SCOUT_COST, CREATOR_COST]);
    // Cost fields never travel in the deliverable bag — they would reach one step.
    expect(deliverableExtras).not.toHaveProperty('authorizedMaxCostUsd');
    expect(deliverableExtras).not.toHaveProperty('executionEnvelope');
  });

  it('merges the single-step envelope into the UNGATED createMission extras', async () => {
    // The easy bug: moving the cost fields onto the per-step channel and updating
    // only the gated branch silently de-authorizes every ungated dispatch.
    await dispatchMissionWithGate(
      'user-a',
      { agent: 'scout', prompt: GATING_PROMPT },
      { slots: [] },
      { perStepCostExtras: costMap({ scout: SCOUT_COST }) }
    );

    expect(createChainMock).not.toHaveBeenCalled();
    expect(createMissionMock.mock.calls[0][2]).toEqual({ slots: [], ...SCOUT_COST });
  });

  it('fails closed before ANY write when a step agent has no authorized envelope', async () => {
    await expect(
      dispatchMissionWithGate(
        'user-a',
        { agent: 'creator', prompt: GATING_PROMPT },
        { slots: [] },
        { perStepCostExtras: costMap({ creator: CREATOR_COST }) } // scout deliberately absent
      )
    ).rejects.toThrow(/'scout' step/);

    expect(createChainMock).not.toHaveBeenCalled();
    expect(createMissionMock).not.toHaveBeenCalled();
  });

  it('leaves the sweep call shape byte-identical — no cost extras reach createMission', async () => {
    // The sweep passes no perStepCostExtras at all, so its pre-AI-053 behaviour
    // must be preserved exactly.
    await dispatchMissionWithGate('system', {
      agent: 'scout',
      prompt: GATING_PROMPT,
      skipResearchGate: true,
      sweepId: 'sweep-1',
    });

    const extras = createMissionMock.mock.calls[0][2] as Record<string, unknown>;
    expect(extras).not.toHaveProperty('authorizedMaxCostUsd');
    expect(extras).not.toHaveProperty('executionEnvelope');
    expect(createMissionMock.mock.calls[0][1]).toEqual({
      agent: 'scout',
      prompt: GATING_PROMPT,
      sweepId: 'sweep-1',
    });
  });

  it('explicit-skip still bypasses even when perStepCostExtras is supplied', async () => {
    await dispatchMissionWithGate(
      'system',
      { agent: 'creator', prompt: GATING_PROMPT, skipResearchGate: true },
      { slots: [] },
      { perStepCostExtras: costMap({ creator: CREATOR_COST }) }
    );

    expect(createChainMock).not.toHaveBeenCalled();
    expect(createMissionMock).toHaveBeenCalledTimes(1);
  });
});
