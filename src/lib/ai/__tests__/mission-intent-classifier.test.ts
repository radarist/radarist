jest.mock('@/lib/ai/client', () => ({
  generateStructuredContentWithMetadata: jest.fn(),
}));

import { generateStructuredContentWithMetadata } from '@/lib/ai/client';
import { classifyMissionIntent, ClassifierOutputSchema } from '../mission-intent-classifier';

const mockGen = generateStructuredContentWithMetadata as jest.MockedFunction<
  typeof generateStructuredContentWithMetadata
>;

const generated = (data: unknown, costUsd: number | null = 0.001) => ({
  data,
  costUsd,
  requestId: 'classifier-request',
  durationMs: 5,
  effectiveModel: 'gemini-3-flash-preview',
});

describe('classifyMissionIntent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns slots from a structured Gemini call', async () => {
    mockGen.mockResolvedValueOnce(
      generated({ slots: [{ name: 'main', intent: 'vendor comparison report' }] }) as never
    );
    const result = await classifyMissionIntent({ prompt: 'create a report on X', agent: 'creator' });
    expect(result.slots).toEqual([{ name: 'main', intent: 'vendor comparison report' }]);
    expect(result.metadata.fallback).toBe(false);
    expect(result.metadata.model).toBeTruthy();
    expect(result.metadata.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.costUsd).toBe(0.001);
  });

  it('returns empty slots for exploratory prompts', async () => {
    mockGen.mockResolvedValueOnce(generated({ slots: [] }) as never);
    const result = await classifyMissionIntent({ prompt: 'help me think about X', agent: 'creator' });
    expect(result.slots).toEqual([]);
    expect(result.metadata.fallback).toBe(false);
  });

  it('marks an unpriced served model as unavailable instead of classifier cost $0', async () => {
    mockGen.mockResolvedValueOnce(generated({ slots: [] }, null) as never);

    const result = await classifyMissionIntent({ prompt: 'explore X', agent: 'creator' });

    expect(result.metadata).toMatchObject({
      model: 'gemini-3-flash-preview',
      costUnavailableReason: 'unknown-pricing',
    });
    expect(result.metadata).not.toHaveProperty('costUsd');
  });

  it('falls back to [{ name: "main" }] when generateStructuredContent throws', async () => {
    mockGen.mockRejectedValueOnce(new Error('Gemini timeout'));
    const result = await classifyMissionIntent({ prompt: 'create a report', agent: 'creator' });
    expect(result.slots).toEqual([{ name: 'main', intent: 'fallback default (classifier failed)' }]);
    expect(result.metadata.fallback).toBe(true);
  });

  it('falls back when generateStructuredContent throws a wrapped Zod failure', async () => {
    mockGen.mockRejectedValueOnce(new Error('Schema validation failed: slots.0.name: invalid'));
    const result = await classifyMissionIntent({ prompt: 'p', agent: 'creator' });
    expect(result.metadata.fallback).toBe(true);
  });

  it('caps slots at 5 (defensive — should already be enforced by classifier prompt)', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `slot-${i}`, intent: `intent ${i}` }));
    mockGen.mockResolvedValueOnce(generated({ slots: six }) as never);
    const result = await classifyMissionIntent({ prompt: 'do many things', agent: 'creator' });
    expect(result.slots.length).toBe(5);
  });

  it('passes the agent name into the classifier prompt', async () => {
    mockGen.mockResolvedValueOnce(generated({ slots: [{ name: 'main', intent: 'x' }] }) as never);
    await classifyMissionIntent({ prompt: 'p', agent: 'scout' });
    expect(mockGen).toHaveBeenCalledTimes(1);
    const promptArg = mockGen.mock.calls[0][0];
    expect(promptArg).toContain('scout');
  });
});

describe('ClassifierOutputSchema preprocessor', () => {
  // Regression: gemini-3-flash-preview frequently returns a bare array of slots
  // instead of the canonical { slots: [...] } object wrapper. Without the
  // preprocessor, every multi-deliverable prompt fell back to single-slot
  // default. The preprocessor wraps a bare array so both shapes parse.
  it('accepts the canonical { slots: [...] } shape', () => {
    const parsed = ClassifierOutputSchema.parse({
      slots: [
        { name: 'main', intent: 'comparison report' },
        { name: 'tco-breakdown', intent: 'cost breakdown' },
      ],
    });
    expect(parsed.slots.length).toBe(2);
  });

  it('accepts a bare array (Gemini quirk) and wraps it transparently', () => {
    const parsed = ClassifierOutputSchema.parse([
      { name: 'comparison', intent: 'A vs B' },
      { name: 'tco', intent: 'cost over 3 years' },
    ]);
    expect(parsed.slots.length).toBe(2);
    expect(parsed.slots[0].name).toBe('comparison');
  });

  it('accepts an empty array (exploratory mission)', () => {
    const parsed = ClassifierOutputSchema.parse([]);
    expect(parsed.slots).toEqual([]);
  });

  it('rejects an array of malformed slots (still validates inner shape)', () => {
    expect(() => ClassifierOutputSchema.parse([{ name: 'INVALID UPPERCASE', intent: 'x' }])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A >200-char slot intent from the model must be
// CLAMPED, not rejected — schema rejection silently collapsed every verbose
// classification into the single-slot fallback.
// ---------------------------------------------------------------------------
describe('T1.7 verbose intent clamping', () => {
  it('clamps a 260-char intent to 200 chars instead of failing validation', () => {
    const verbose = { slots: [{ name: 'main', intent: 'x'.repeat(260) }] };
    const parsed = ClassifierOutputSchema.safeParse(verbose);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.slots[0].intent).toHaveLength(200);
  });

  it('clamps intents inside the bare-array form too', () => {
    const parsed = ClassifierOutputSchema.safeParse([{ name: 'a', intent: 'y'.repeat(500) }]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.slots[0].intent).toHaveLength(200);
  });
});
