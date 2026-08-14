/**
 * DEP-010 — typed model surfaces and un-pinned shutdown call sites.
 * DEP-011 — removal of the sampling parameters Google deprecated 2026-07-21.
 *
 * Both gemini-2.5 models shut down 2026-10-16, and both of our uses were
 * hardcoded outside the model-config override system, so they would break at
 * the call site on that date with no env-var escape hatch.
 *
 * `temperature` / `top_p` / `top_k` are accepted and SILENTLY IGNORED on
 * 3.6-era models, and the migration guide states future generations return
 * HTTP 400 — the hardcoded `topK: 40` being the field that 400s first. Sending
 * them is therefore worse than useless: it makes the thinkingLevel sampling
 * presets look live when they are already a no-op.
 *
 * @jest-environment node
 */

export {};

const mockCurrencyGenerateContent = jest.fn();
const mockCurrencyGetGenerativeModel = jest.fn().mockReturnValue({ generateContent: mockCurrencyGenerateContent });

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockCurrencyGetGenerativeModel,
  })),
  TaskType: { RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT', RETRIEVAL_QUERY: 'RETRIEVAL_QUERY' },
}));

jest.mock('../reliability', () => ({
  withReliability: jest.fn(async (fn: () => Promise<{ result: unknown }>) => ({ data: (await fn()).result })),
  trackCost: jest.fn(),
  calculateCost: jest.fn(() => 0),
  assertCostBudgetAvailable: jest.fn(),
  generateRequestId: jest.fn(() => 'req-test'),
  getCostTracker: jest.fn(() => ({ getTotalCost: () => 0 })),
}));

function plainResponse() {
  return {
    response: {
      text: () => 'answer',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
  };
}

/** The generation config actually sent to the provider on the last call. */
function lastGenerationConfig(): Record<string, unknown> {
  const call = mockCurrencyGetGenerativeModel.mock.calls.at(-1);
  return (call?.[0] as { generationConfig?: Record<string, unknown> })?.generationConfig ?? {};
}

describe('model currency (DEP-010 / DEP-011)', () => {
  const ORIGINAL_KEY = process.env.GEMINI_API_KEY;

  beforeAll(() => {
    process.env.GEMINI_API_KEY = 'test-key';
  });

  afterAll(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = ORIGINAL_KEY;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCurrencyGenerateContent.mockResolvedValue(plainResponse());
  });

  describe('DEP-011 — deprecated sampling parameters are not sent', () => {
    it('omits temperature, topP and topK from the generation config', async () => {
      const { generateContent } = await import('../client');

      await generateContent('hello');

      const config = lastGenerationConfig();
      expect(config).not.toHaveProperty('temperature');
      expect(config).not.toHaveProperty('topP');
      expect(config).not.toHaveProperty('topK');
    });

    it('omits them even when a caller still passes them', async () => {
      const { generateContent } = await import('../client');

      await generateContent('hello', { temperature: 0.3, topP: 0.9, topK: 40 });

      const config = lastGenerationConfig();
      expect(config).not.toHaveProperty('temperature');
      expect(config).not.toHaveProperty('topP');
      expect(config).not.toHaveProperty('topK');
    });

    it('omits them on the grounded path too', async () => {
      const { generateGroundedContent } = await import('../client');

      await generateGroundedContent('hello', { citationResolution: { enabled: false } });

      const config = lastGenerationConfig();
      expect(config).not.toHaveProperty('temperature');
      expect(config).not.toHaveProperty('topP');
      expect(config).not.toHaveProperty('topK');
    });

    it('still sends maxOutputTokens — only the sampling trio was deprecated', async () => {
      const { generateContent } = await import('../client');

      await generateContent('hello', { maxOutputTokens: 1234 });

      expect(lastGenerationConfig()).toHaveProperty('maxOutputTokens', 1234);
    });

    it('keeps thinkingLevel working — thinking_level is the documented replacement', async () => {
      const { generateContent } = await import('../client');

      await generateContent('hello', { thinkingLevel: 'high' });

      expect(lastGenerationConfig()).toMatchObject({ thinkingConfig: { thinkingLevel: 'high' } });
    });
  });

  describe('DEP-010 — no hardcoded model shuts down under us', () => {
    it('leaves no hardcoded model literal in the comprehensive-research flow', async () => {
      // The flow carries `'use server'`, so its resolver cannot be exported for
      // a direct call (every export there must be an async server action).
      // Assert the source instead: no `gemini-*` literal, and the accessor is
      // the thing it reads. `effective-model.test.ts` enforces the same rule
      // repo-wide via its frozen allow-list.
      const fs = await import('fs');
      const source = fs.readFileSync('src/ai/flows/research-technology-comprehensive.ts', 'utf8');

      expect(source).not.toMatch(/['"]gemini-[0-9]/);
      expect(source).toContain('geminiComprehensiveResearchModel');
    });

    it('keeps comprehensive research on the Pro tier and env-overridable', async () => {
      // The old pin's stated reason was "stable, not a preview" — but there is
      // no stable Gemini 3.x Pro (Google shipped Flash on 2026-07-21, no 3.5
      // Pro), so the only same-tier successor IS a preview. The deadline fix is
      // to stop pointing at a model that stops serving; whether to accept the
      // preview or drop a tier is an owner call, so it gets its own env var
      // rather than being silently folded into GEMINI_PRO_MODEL.
      const { geminiComprehensiveResearchModel } = await import('../model-config');

      expect(geminiComprehensiveResearchModel()).toBe('gemini-3.1-pro-preview');

      const previous = process.env.GEMINI_COMPREHENSIVE_RESEARCH_MODEL;
      process.env.GEMINI_COMPREHENSIVE_RESEARCH_MODEL = 'gemini-3.6-flash';
      try {
        jest.resetModules();
        const reloaded = await import('../model-config');
        expect(reloaded.geminiComprehensiveResearchModel()).toBe('gemini-3.6-flash');
      } finally {
        if (previous === undefined) delete process.env.GEMINI_COMPREHENSIVE_RESEARCH_MODEL;
        else process.env.GEMINI_COMPREHENSIVE_RESEARCH_MODEL = previous;
        jest.resetModules();
      }
    });

    it('routes super-graph vision evaluation through the canonical resolver', async () => {
      const { geminiVisionModel } = await import('../model-config');
      const mod = await import('@/lib/super-graph/evaluator-vision');

      expect(mod.visionModel()).toBe(geminiVisionModel());
      expect(mod.visionModel()).not.toContain('gemini-2.5');
    });

    it('defaults vision to the price-identical replacement, not the 5x-input default', async () => {
      // Google's stated replacement for gemini-2.5-flash is gemini-3.6-flash at
      // 1.50 input — 5x the 0.30 the vision evaluator pays today.
      // gemini-3.5-flash-lite is 0.30 / 2.50: exactly the price it replaces.
      const { geminiVisionModel } = await import('../model-config');

      expect(geminiVisionModel()).toBe('gemini-3.5-flash-lite');
    });

    it('lets an operator override the vision model by env var', async () => {
      const previous = process.env.GEMINI_VISION_MODEL;
      process.env.GEMINI_VISION_MODEL = 'gemini-3.6-flash';
      try {
        jest.resetModules();
        const { geminiVisionModel } = await import('../model-config');
        expect(geminiVisionModel()).toBe('gemini-3.6-flash');
      } finally {
        if (previous === undefined) delete process.env.GEMINI_VISION_MODEL;
        else process.env.GEMINI_VISION_MODEL = previous;
        jest.resetModules();
      }
    });

    it('accepts the newly priced models in the typed union', async () => {
      const { resolveGeminiPricing } = await import('../rate-card');
      const models: Array<import('../client').GeminiModel> = ['gemini-3.6-flash', 'gemini-3.5-flash-lite'];

      for (const model of models) {
        expect(resolveGeminiPricing(model)).toBeDefined();
      }
    });

    it('leaves the chat default on pro — a Flash swap needs tool-loop evidence first', async () => {
      // A Flash swap on the chat path was tried and reverted the same day on
      // 2026-06-15 because a reasoning-only benchmark missed a tool-loop
      // regression. Comparative model evidence gates any change here.
      const { geminiChatModel } = await import('../model-config');

      expect(geminiChatModel()).toBe('gemini-3.1-pro-preview');
    });
  });
});
