/**
 * @file lib/__tests__/mission-quality-llm.test.ts
 * @description Unit tests for Quality Layer 2 — LLM-as-judge.
 *
 * Mocks the unified Gemini client so these tests never make real API calls.
 * The happy-path tests assert the judgement shape; failure-path tests assert
 * the caller contract (null on any error/skip).
 */

// Mock the Gemini client before the module under test imports it.
jest.mock('@/lib/ai/client', () => ({
  generateStructuredContentWithMetadata: jest.fn(),
}));

import { generateStructuredContentWithMetadata } from '@/lib/ai/client';
import { evaluateMissionQualityLlm, shouldSkipLlmJudge, type MissionForLlmJudge } from '../mission-quality-llm';
import { QUALITY_JUDGEMENT_DIMENSIONS } from '../schemas/mission-quality-llm';

const mockedGenerate = generateStructuredContentWithMetadata as jest.MockedFunction<
  typeof generateStructuredContentWithMetadata
>;

/** Wrap a judge-response fixture in the WithMetadata envelope (MISSION-005). */
function wrapJudge<T>(data: T) {
  return {
    data,
    costUsd: 0.003,
    requestId: 'req-judge',
    durationMs: 1,
    effectiveModel: 'gemini-2.5-flash',
  };
}

/** A plausible 10-dimension judge response with good scores across the board. */
function goodJudgeResponse() {
  return {
    verdict: 'PASS' as const,
    overallScore: 0.88,
    dimensions: QUALITY_JUDGEMENT_DIMENSIONS.map((name) => ({
      name,
      score: 0.85,
      rationale: `${name} looks solid`,
    })),
    note: 'Overall, this is well-structured.',
  };
}

/** A mission long enough to not be skipped. */
function nonTrivialMission(overrides: Partial<MissionForLlmJudge> = {}): MissionForLlmJudge {
  return {
    prompt: 'Produce an IMRAD whitepaper analyzing the competitive landscape for open-weight AI models in 2026.',
    result: 'x'.repeat(1500),
    agent: 'creator',
    ...overrides,
  };
}

describe('shouldSkipLlmJudge', () => {
  it('skips when the result is below the minimum byte threshold', () => {
    const decision = shouldSkipLlmJudge({ prompt: 'Give me a whitepaper analysis of X', result: 'short' });
    expect(decision.skip).toBe(true);
    if (decision.skip) expect(decision.reason).toMatch(/500B/);
  });

  it('skips when the prompt looks trivial (short + no analysis keywords)', () => {
    const decision = shouldSkipLlmJudge({ prompt: 'What time is it?', result: 'x'.repeat(1000) });
    expect(decision.skip).toBe(true);
    if (decision.skip) expect(decision.reason).toBe('trivial prompt');
  });

  it('does NOT skip an analysis-style prompt even when short', () => {
    const decision = shouldSkipLlmJudge({ prompt: 'Analyze this market', result: 'x'.repeat(1000) });
    expect(decision.skip).toBe(false);
  });

  it('can prune by sample rate (rate=0 always skips)', () => {
    const decision = shouldSkipLlmJudge(nonTrivialMission(), 0);
    expect(decision.skip).toBe(true);
    if (decision.skip) expect(decision.reason).toMatch(/sampled out/);
  });
});

describe('evaluateMissionQualityLlm', () => {
  beforeEach(() => {
    mockedGenerate.mockReset();
  });

  it('returns null and never calls the judge when the mission should be skipped', async () => {
    const { judgement: out } = await evaluateMissionQualityLlm({ prompt: 'hi', result: 'short' });
    expect(out).toBeNull();
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('returns null when sample-rate pruning skips the call', async () => {
    const { judgement: out } = await evaluateMissionQualityLlm(nonTrivialMission(), { sampleRate: 0 });
    expect(out).toBeNull();
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('returns a parsed QualityJudgement on the happy path', async () => {
    mockedGenerate.mockResolvedValueOnce(wrapJudge(goodJudgeResponse()));
    const { judgement: out } = await evaluateMissionQualityLlm(nonTrivialMission());
    expect(out).not.toBeNull();
    expect(out!.verdict).toBe('PASS');
    expect(out!.overallScore).toBeCloseTo(0.88);
    expect(out!.dimensions).toHaveLength(QUALITY_JUDGEMENT_DIMENSIONS.length);
    expect(out!.dimensions[0]).toMatchObject({ name: 'answersQuestion', score: 0.85 });
    // evaluatedAt + judgeModel get populated server-side regardless of what the model returned.
    expect(new Date(out!.evaluatedAt).toString()).not.toBe('Invalid Date');
    expect(out!.judgeModel).toMatch(/gemini/);
  });

  it('returns null (best-effort) when the judge model throws', async () => {
    mockedGenerate.mockRejectedValueOnce(new Error('Gemini 503'));
    const { judgement: out } = await evaluateMissionQualityLlm(nonTrivialMission());
    expect(out).toBeNull();
  });

  it('preserves an unavailable judge cost instead of settling it as zero', async () => {
    mockedGenerate.mockResolvedValueOnce({
      ...wrapJudge(goodJudgeResponse()),
      costUsd: null,
      effectiveModel: 'gemini-unlisted-served-model',
    });

    const result = await evaluateMissionQualityLlm(nonTrivialMission());

    expect(result.costUsd).toBeNull();
    expect(result.judgement?.judgeModel).toBe('gemini-unlisted-served-model');
  });

  it('truncates very long results before shipping them to the judge (40KB cap)', async () => {
    mockedGenerate.mockResolvedValueOnce(wrapJudge(goodJudgeResponse()));
    // 60KB result — should be truncated to 40KB + truncation marker in the prompt.
    const huge = 'y'.repeat(60 * 1024);
    await evaluateMissionQualityLlm({
      prompt: 'Analyze the open-weight AI model market',
      result: huge,
      agent: 'scout',
    });
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    const sentPrompt = mockedGenerate.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('[truncated]');
    // The final prompt must be bounded: template overhead + 40KB cap ≈ under 45KB.
    expect(sentPrompt.length).toBeLessThan(45 * 1024);
  });

  it('includes the prompt, agent, and result placeholders in the rendered prompt', async () => {
    mockedGenerate.mockResolvedValueOnce(wrapJudge(goodJudgeResponse()));
    const mission = nonTrivialMission({
      prompt: 'Audit the 2026 AI investment landscape',
      result: 'A'.repeat(1200),
      agent: 'strategist',
    });
    await evaluateMissionQualityLlm(mission);
    const sentPrompt = mockedGenerate.mock.calls[0][0] as string;
    expect(sentPrompt).toContain('Audit the 2026 AI investment landscape');
    expect(sentPrompt).toContain('strategist');
    expect(sentPrompt).toContain('A'.repeat(100)); // a chunk of the result body
  });
});
