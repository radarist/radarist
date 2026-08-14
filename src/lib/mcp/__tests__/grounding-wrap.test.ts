/**
 * @file mcp/__tests__/grounding-wrap.test.ts
 * @description Lane F — TDD gate for the SOFT, FAIL-OPEN grounding post-wrap.
 *
 * The wrap LABELS, it never hard-blocks:
 *   (a) a non-allow-listed tool result passes through byte-identical;
 *   (b) an allow-listed ungrounded fact-asserting result is flagged/labelled;
 *   (c) a grounding-call failure fails OPEN (returns the result, never throws).
 *
 * The grounding client (`generateGroundedContent`) is mocked so no Gemini SDK
 * or network is touched.
 */

// Mock the grounding primitive — this also short-circuits the Gemini SDK init
// chain that importing the real `@/lib/ai/client` would trigger.
const mockGenerateGroundedContent = jest.fn();
jest.mock('@/lib/ai/client', () => ({
  generateGroundedContent: (...args: unknown[]) => mockGenerateGroundedContent(...args),
}));

import { wrapFactAsserting, FACT_ASSERTING_TOOLS, GROUNDING_LABEL_META_KEY } from '../grounding-wrap';

/** Build an MCP-shaped success result carrying a single text block. */
function textResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

const FACTY = 'Quantum chip X ships 256 logical qubits as of March 2026, a 4x lead over rivals.';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FACT_ASSERTING_TOOLS allow-list', () => {
  it('is a non-empty, explicit named set (not inferred)', () => {
    expect(FACT_ASSERTING_TOOLS instanceof Set).toBe(true);
    expect(FACT_ASSERTING_TOOLS.size).toBeGreaterThan(0);
    // Anchors — representative graph + research read tools must be covered.
    expect(FACT_ASSERTING_TOOLS.has('webSearch')).toBe(true);
    expect(FACT_ASSERTING_TOOLS.has('askGraphQuestion')).toBe(true);
  });

  it('does NOT include mutation / diagnostic tools', () => {
    expect(FACT_ASSERTING_TOOLS.has('executeCypher')).toBe(false);
    expect(FACT_ASSERTING_TOOLS.has('recordKnowledgeGap')).toBe(false);
    expect(FACT_ASSERTING_TOOLS.has('getGraphHealth')).toBe(false);
  });
});

describe('(a) non-allow-listed tools pass through byte-identical', () => {
  it('returns the SAME reference and never calls grounding', async () => {
    const result = textResult(FACTY);
    const out = await wrapFactAsserting('createCompany', result);

    expect(out).toBe(result); // same reference — byte-identical
    expect(mockGenerateGroundedContent).not.toHaveBeenCalled();
  });

  it('passes through arbitrary non-MCP shapes untouched', async () => {
    const weird = { foo: 'bar', n: 42 };
    const out = await wrapFactAsserting('someRandomTool', weird);
    expect(out).toBe(weird);
    expect(mockGenerateGroundedContent).not.toHaveBeenCalled();
  });
});

describe('(b) allow-listed ungrounded fact-asserting results are flagged', () => {
  it('labels the result when grounding returns no citations', async () => {
    mockGenerateGroundedContent.mockResolvedValue({ text: 'no supporting sources found', citations: [] });

    const result = textResult(FACTY);
    const out = (await wrapFactAsserting('webSearch', result)) as Record<string, unknown>;

    expect(mockGenerateGroundedContent).toHaveBeenCalledTimes(1);
    // It is a NEW object (label applied), not the original reference.
    expect(out).not.toBe(result);
    // Metadata flag records the ungrounded verdict.
    expect((out[GROUNDING_LABEL_META_KEY] as { grounded: boolean }).grounded).toBe(false);
    // A human-visible banner is prepended; original text preserved downstream.
    const content = out.content as Array<{ type: string; text: string }>;
    const joined = content.map((c) => c.text).join('\n');
    expect(joined).toMatch(/unverified|ungrounded/i);
    expect(joined).toContain(FACTY);
  });

  it('does NOT label when grounding returns citations (grounded)', async () => {
    mockGenerateGroundedContent.mockResolvedValue({
      text: 'confirmed',
      citations: [{ uri: 'https://example.com', title: 'src' }],
    });

    const result = textResult(FACTY);
    const out = await wrapFactAsserting('askGraphQuestion', result);

    expect(mockGenerateGroundedContent).toHaveBeenCalledTimes(1);
    expect(out).toBe(result); // grounded → untouched pass-through
  });

  it('skips error results without calling grounding', async () => {
    const errResult = { content: [{ type: 'text', text: 'boom' }], isError: true };
    const out = await wrapFactAsserting('webSearch', errResult);
    expect(out).toBe(errResult);
    expect(mockGenerateGroundedContent).not.toHaveBeenCalled();
  });

  it('skips results with no extractable / too-short text', async () => {
    const tiny = textResult('ok');
    const out = await wrapFactAsserting('webSearch', tiny);
    expect(out).toBe(tiny);
    expect(mockGenerateGroundedContent).not.toHaveBeenCalled();

    const shapeless = await wrapFactAsserting('webSearch', { content: [] });
    expect(mockGenerateGroundedContent).not.toHaveBeenCalled();
    expect(shapeless).toEqual({ content: [] });
  });
});

describe('(c) grounding failure fails OPEN', () => {
  it('returns the original result and does not throw when grounding rejects', async () => {
    mockGenerateGroundedContent.mockRejectedValue(new Error('grounding outage'));

    const result = textResult(FACTY);
    let out: unknown;
    await expect(
      (async () => {
        out = await wrapFactAsserting('webSearch', result);
      })()
    ).resolves.toBeUndefined();

    expect(out).toBe(result); // unchanged, fail-open
  });

  it('fails open when grounding returns a malformed payload', async () => {
    mockGenerateGroundedContent.mockResolvedValue(undefined);

    const result = textResult(FACTY);
    const out = await wrapFactAsserting('webSearch', result);
    expect(out).toBe(result);
  });
});
