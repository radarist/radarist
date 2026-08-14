/**
 * Unit Tests for AI Client Module
 *
 * Tests the unified AI client abstraction layer including:
 * - generateContent with various configurations
 * - generateStructuredContent with Zod schema validation
 * - generateContentWithMetadata
 * - generateEmbedding and generateEmbeddings
 * - JSON cleaning and parsing
 * - Error handling and fallback behavior
 * - transformNullToUndefined utility
 *
 * @jest-environment node
 */

import { z } from 'zod';

// ============================================================================
// Mocks - Must be BEFORE any imports
// ============================================================================

// Mock response builder
function createMockResponse(
  text: string,
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
) {
  return {
    response: {
      text: () => text,
      usageMetadata: usageMetadata || { promptTokenCount: 10, candidatesTokenCount: 5 },
    },
  };
}

// Mock embedding response
function createMockEmbeddingResponse(values: number[]) {
  return {
    embedding: { values },
  };
}

const mockGenerateContent = jest.fn();
const mockEmbedContent = jest.fn();
const mockGetGenerativeModel = jest.fn().mockReturnValue({
  generateContent: mockGenerateContent,
  embedContent: mockEmbedContent,
});

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: mockGetGenerativeModel,
  })),
  TaskType: {
    RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT',
    RETRIEVAL_QUERY: 'RETRIEVAL_QUERY',
  },
}));

// Captures the token counts the internal generate functions report to the
// reliability layer, so tests can assert thoughtsTokenCount folding into output.
const capturedTokens: { inputTokens?: number; outputTokens?: number } = {};

// Mock reliability module - provide minimal implementations
jest.mock('../reliability', () => ({
  withReliability: jest.fn(
    async (
      fn: () => Promise<{ result: unknown; inputTokens: number; outputTokens: number }>,
      options: { requestId?: string }
    ) => {
      const result = await fn();
      capturedTokens.inputTokens = result.inputTokens;
      capturedTokens.outputTokens = result.outputTokens;
      return {
        data: result.result,
        requestId: options.requestId || 'mock-req-id',
        durationMs: 100,
        costUsd: 0.001,
        retriesUsed: 0,
      };
    }
  ),
  generateRequestId: jest.fn(() => 'mock-generated-id'),
  trackCost: jest.fn(),
  assertCostBudgetAvailable: jest.fn(),
}));

// Mock constants
jest.mock('../constants', () => ({
  DEFAULT_EMBEDDING_MODEL: 'gemini-embedding-001',
  EMBEDDING_DIMENSION: 768,
  TaskType: {
    RETRIEVAL_DOCUMENT: 'RETRIEVAL_DOCUMENT',
    RETRIEVAL_QUERY: 'RETRIEVAL_QUERY',
  },
}));

// Set up env vars
const originalEnv = process.env;

// ============================================================================
// Imports (AFTER mocks)
// ============================================================================

import {
  generateContent,
  generateContentWithMetadata,
  generateStructuredContent,
  generateEmbedding,
  generateEmbeddingWithMetadata,
  generateEmbeddings,
  resolveThinkingConfig,
} from '../client';
import { isPlaceholderKey, resolveGeminiApiKey, MissingAIKeyError } from '../key-resolution';
import {
  runWithOperationUsageSink,
  type CapturedProviderUsage,
  type OperationUsageSink,
} from '@/lib/operation-context';

import { withReliability } from '../reliability';

const mockWithReliability = withReliability as jest.Mock;

// ============================================================================
// Tests
// ============================================================================

describe('AI Client Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, GOOGLE_API_KEY: 'test-api-key' };
    capturedTokens.inputTokens = undefined;
    capturedTokens.outputTokens = undefined;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('guarded Gemini test endpoint', () => {
    const StructuredSchema = z.object({ name: z.string() });

    async function exerciseEveryModelConstructionPath(): Promise<void> {
      mockGenerateContent
        .mockResolvedValueOnce(createMockResponse('plain content'))
        .mockResolvedValueOnce(createMockResponse('{"name":"structured content"}'));
      mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse([0.1, 0.2]));

      await generateContent('plain prompt', { skipReliability: true });
      await generateStructuredContent('structured prompt', StructuredSchema, {
        skipReliability: true,
      });
      await generateEmbedding('embedding input');
    }

    it('passes the guarded loopback request options to content, structured, and embedding models', async () => {
      process.env.GEMINI_TEST_BASE_URL = 'http://127.0.0.1:18790';
      process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:18080';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-client-test';
      process.env.FIREBASE_PROJECT_ID = 'demo-client-test';
      process.env.GCLOUD_PROJECT = 'demo-client-test';
      process.env.GOOGLE_CLOUD_PROJECT = 'demo-client-test';

      await exerciseEveryModelConstructionPath();

      expect(mockGetGenerativeModel).toHaveBeenCalledTimes(3);
      for (const call of mockGetGenerativeModel.mock.calls) {
        expect(call).toHaveLength(2);
        expect(call[1]).toEqual({ baseUrl: 'http://127.0.0.1:18790' });
      }
    });

    it('preserves the SDK single-argument call shape when the test endpoint is inactive', async () => {
      delete process.env.GEMINI_TEST_BASE_URL;

      await exerciseEveryModelConstructionPath();

      expect(mockGetGenerativeModel).toHaveBeenCalledTimes(3);
      for (const call of mockGetGenerativeModel.mock.calls) {
        expect(call).toHaveLength(1);
      }
    });
  });

  // ==========================================================================
  // generateContent
  // ==========================================================================

  describe('generateContent', () => {
    it('should generate text content with default config', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Hello, world!'));

      const result = await generateContent('Test prompt');

      expect(result).toBe('Hello, world!');
      expect(mockWithReliability).toHaveBeenCalledTimes(1);
    });

    it('should pass through model configuration', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Pro response'));

      await generateContent('Test prompt', {
        model: 'gemini-2.5-pro',
        temperature: 0.8,
        maxOutputTokens: 4096,
      });

      // The model should be passed to withReliability options
      const reliabilityCall = mockWithReliability.mock.calls[0];
      expect(reliabilityCall[1].model).toBe('gemini-2.5-pro');
    });

    it('should skip reliability wrapper when skipReliability is true', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Direct response'));

      const result = await generateContent('Test prompt', {
        skipReliability: true,
      });

      expect(result).toBe('Direct response');
      expect(mockWithReliability).not.toHaveBeenCalled();
    });

    it('should use provided requestId', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Response'));

      await generateContent('Test', { requestId: 'custom-id' });

      const reliabilityCall = mockWithReliability.mock.calls[0];
      expect(reliabilityCall[1].requestId).toBe('custom-id');
    });

    it('should auto-generate requestId when not provided', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Response'));

      await generateContent('Test');

      const reliabilityCall = mockWithReliability.mock.calls[0];
      expect(reliabilityCall[1].requestId).toBe('mock-generated-id');
    });

    it('should throw descriptive error on failure', async () => {
      mockWithReliability.mockRejectedValueOnce(new Error('API failure'));

      await expect(generateContent('Test prompt')).rejects.toThrow('Failed to generate content: API failure');
    });

    it('should handle non-Error thrown objects', async () => {
      mockWithReliability.mockRejectedValueOnce('string error');

      await expect(generateContent('Test prompt')).rejects.toThrow('Failed to generate content: Unknown error');
    });

    it('should include metadata about google search in reliability options', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Search result'));

      await generateContent('Research topic', { useGoogleSearch: true });

      const reliabilityCall = mockWithReliability.mock.calls[0];
      expect(reliabilityCall[1].metadata.hasGoogleSearch).toBe(true);
      expect(reliabilityCall[1].metadata.promptLength).toBe('Research topic'.length);
    });

    it('should configure Google Search tools when enabled', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Search result'));

      await generateContent('Test', {
        useGoogleSearch: true,
        skipReliability: true,
      });

      // Verify model was created with tools
      expect(mockGetGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [{ googleSearch: {} }],
        })
      );
    });

    it('should not include tools when Google Search is disabled', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('No search'));

      await generateContent('Test', { skipReliability: true });

      // Verify model was created without tools
      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.tools).toBeUndefined();
    });

    // DEP-011 — these used to assert the thinkingLevel → temperature/topP preset
    // map. Google deprecated those parameters on 2026-07-21 (ignored on 3.6-era
    // models, HTTP 400 in the next generation), so the presets are gone and
    // `thinkingLevel` now expresses itself solely through `thinkingConfig`.
    it.each([
      ['high', 'Complex prompt'],
      ['low', 'Focused prompt'],
      ['medium', 'Moderate prompt'],
    ] as const)('maps thinkingLevel %s to thinkingConfig, with no sampling parameters', async (level, prompt) => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Response'));

      await generateContent(prompt, { thinkingLevel: level, skipReliability: true });

      const { generationConfig } = mockGetGenerativeModel.mock.calls[0][0];
      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: level });
      expect(generationConfig).not.toHaveProperty('temperature');
      expect(generationConfig).not.toHaveProperty('topP');
      expect(generationConfig).not.toHaveProperty('topK');
    });

    it('drops an explicitly passed temperature instead of forwarding it', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Custom temp'));

      await generateContent('Test', {
        thinkingLevel: 'high',
        temperature: 0.5,
        skipReliability: true,
      });

      // The field stays on GenerationConfig (deprecated) so existing call sites
      // keep compiling while they are swept, but it must never reach the wire.
      expect(mockGetGenerativeModel.mock.calls[0][0].generationConfig).not.toHaveProperty('temperature');
    });
  });

  // ==========================================================================
  // Real Gemini thinkingConfig (thinking_level)
  // ==========================================================================

  describe('resolveThinkingConfig (buildThinkingConfig mapping)', () => {
    it('returns { thinkingLevel: "high" } for a gemini-3 model at high', async () => {
      await expect(resolveThinkingConfig('gemini-3.5-flash', 'high')).resolves.toEqual({ thinkingLevel: 'high' });
    });

    it('returns { thinkingLevel: "low" } for a gemini-3 model at low', async () => {
      await expect(resolveThinkingConfig('gemini-3.1-pro-preview', 'low')).resolves.toEqual({ thinkingLevel: 'low' });
    });

    it('returns undefined for "none" (use the model default — do not force a level)', async () => {
      await expect(resolveThinkingConfig('gemini-3.5-flash', 'none')).resolves.toBeUndefined();
    });

    it('returns undefined for gemini-2.5 models (they use thinkingBudget, not thinkingLevel)', async () => {
      await expect(resolveThinkingConfig('gemini-2.5-flash', 'high')).resolves.toBeUndefined();
      await expect(resolveThinkingConfig('gemini-2.5-pro', 'medium')).resolves.toBeUndefined();
    });
  });

  describe('thinkingConfig attachment on generate calls', () => {
    it('attaches thinkingConfig.thinkingLevel for a gemini-3 model in generateContent', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Thoughtful'));

      await generateContent('Complex prompt', {
        model: 'gemini-3.5-flash',
        thinkingLevel: 'high',
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
    });

    it('attaches thinkingConfig.thinkingLevel for a gemini-3 model in generateStructuredContent', async () => {
      const Schema = z.object({ name: z.string() });
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "Thinky"}'));

      await generateStructuredContent('Get name', Schema, {
        model: 'gemini-3.1-pro-preview',
        thinkingLevel: 'medium',
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
    });

    it('does NOT attach thinkingConfig when thinkingLevel is "none"', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Default thinking'));

      await generateContent('Prompt', {
        model: 'gemini-3.5-flash',
        thinkingLevel: 'none',
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.thinkingConfig).toBeUndefined();
    });

    it('does NOT attach thinkingConfig for gemini-2.5 models (avoids 400)', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('25 response'));

      await generateContent('Prompt', {
        model: 'gemini-2.5-flash',
        thinkingLevel: 'high',
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.thinkingConfig).toBeUndefined();
    });

    // DEP-011 — inverted: the sampling presets that used to ride alongside
    // thinkingConfig are deprecated and no longer sent. thinkingConfig is now
    // the ONLY deliberation control on the wire.
    it('sends thinkingConfig as the only deliberation control', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('Both'));

      await generateContent('Prompt', {
        model: 'gemini-3.5-flash',
        thinkingLevel: 'high',
        skipReliability: true,
      });

      const { generationConfig } = mockGetGenerativeModel.mock.calls[0][0];
      expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'high' });
      expect(generationConfig).not.toHaveProperty('temperature');
      expect(generationConfig).not.toHaveProperty('topP');
      expect(generationConfig).not.toHaveProperty('topK');
    });
  });

  describe('thoughtsTokenCount accounting', () => {
    it('adds thoughtsTokenCount to outputTokens in generateContent', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('Reasoned answer', {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 200,
        })
      );

      await generateContent('Prompt', { model: 'gemini-3.5-flash', thinkingLevel: 'high' });

      // 50 visible output + 200 thinking tokens (billed as output) = 250
      expect(capturedTokens.outputTokens).toBe(250);
      expect(capturedTokens.inputTokens).toBe(100);
    });

    it('adds thoughtsTokenCount to outputTokens in generateStructuredContent', async () => {
      const Schema = z.object({ name: z.string() });
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('{"name": "X"}', {
          promptTokenCount: 80,
          candidatesTokenCount: 20,
          thoughtsTokenCount: 30,
        })
      );

      await generateStructuredContent('Get name', Schema, { model: 'gemini-3.5-flash', thinkingLevel: 'high' });

      // 20 visible + 30 thinking = 50
      expect(capturedTokens.outputTokens).toBe(50);
      expect(capturedTokens.inputTokens).toBe(80);
    });

    it('does not change outputTokens when thoughtsTokenCount is absent', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('No thinking', { promptTokenCount: 10, candidatesTokenCount: 5 })
      );

      await generateContent('Prompt', { model: 'gemini-3.5-flash' });

      expect(capturedTokens.outputTokens).toBe(5);
    });
  });

  // ==========================================================================
  // generateContentWithMetadata
  // ==========================================================================

  describe('generateContentWithMetadata', () => {
    it('should return text with metadata', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('Response text', { promptTokenCount: 100, candidatesTokenCount: 50 })
      );

      const result = await generateContentWithMetadata('Test prompt');

      expect(result.text).toBe('Response text');
      expect(result.requestId).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.costUsd).toBeGreaterThanOrEqual(0);
      expect(result.retriesUsed).toBe(0);
    });
  });

  // ==========================================================================
  // generateStructuredContent
  // ==========================================================================

  describe('generateStructuredContent', () => {
    const TestSchema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean().optional(),
    });

    it('should parse and validate structured response', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "John", "age": 30, "active": true}'));

      const result = await generateStructuredContent('Get person', TestSchema);

      expect(result).toEqual({ name: 'John', age: 30, active: true });
    });

    it('should handle JSON wrapped in markdown code blocks', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('```json\n{"name": "Jane", "age": 25}\n```'));

      const result = await generateStructuredContent('Get person', TestSchema);

      expect(result).toEqual({ name: 'Jane', age: 25 });
    });

    it('should transform null to undefined for Zod compatibility', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "Bob", "age": 40, "active": null}'));

      const result = await generateStructuredContent('Get person', TestSchema);

      expect(result.name).toBe('Bob');
      expect(result.age).toBe(40);
      // null should become undefined, which is ok for optional
      expect(result.active).toBeUndefined();
    });

    it('should throw on schema validation failure', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": 123, "age": "not a number"}'));

      await expect(generateStructuredContent('Get person', TestSchema)).rejects.toThrow('Schema validation failed');
    });

    it('should throw on invalid JSON with descriptive error', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('This is not JSON at all'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(generateStructuredContent('Get person', TestSchema)).rejects.toThrow('Failed to parse JSON');

      consoleSpy.mockRestore();
    });

    it('should skip reliability when skipReliability is true', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "Direct", "age": 1}'));

      const result = await generateStructuredContent('Get person', TestSchema, {
        skipReliability: true,
      });

      expect(result).toEqual({ name: 'Direct', age: 1 });
      expect(mockWithReliability).not.toHaveBeenCalled();
    });

    it('should set responseMimeType to JSON when no tools', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "Test", "age": 1}'));

      await generateStructuredContent('Get person', TestSchema, {
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.responseMimeType).toBe('application/json');
    });

    it('should not set responseMimeType when using Google Search', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "Searched", "age": 2}'));

      await generateStructuredContent('Get person', TestSchema, {
        useGoogleSearch: true,
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.responseMimeType).toBeUndefined();
    });

    it('should use larger maxOutputTokens when Google Search is enabled', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "BigSearch", "age": 3}'));

      await generateStructuredContent('Get person', TestSchema, {
        useGoogleSearch: true,
        skipReliability: true,
      });

      const modelCall = mockGetGenerativeModel.mock.calls[0][0];
      expect(modelCall.generationConfig.maxOutputTokens).toBe(16384);
    });

    it('should throw descriptive error on reliability failure', async () => {
      mockWithReliability.mockRejectedValueOnce(new Error('Reliability failure'));

      await expect(generateStructuredContent('Get person', TestSchema)).rejects.toThrow(
        'Failed to generate structured content: Reliability failure'
      );
    });

    it('should handle aggressive JSON cleaning for truncated responses', async () => {
      // Simulate a truncated JSON response
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('Some prefix text {"name": "Truncated", "age": 99}')
      );

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await generateStructuredContent('Get person', TestSchema, {
        skipReliability: true,
      });

      expect(result.name).toBe('Truncated');
      expect(result.age).toBe(99);
      consoleSpy.mockRestore();
    });

    it('should close missing outer delimiters after a complete final value', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('{\n  "name": "Truncated",\n  "age": 99,\n  "active": true')
      );

      const result = await generateStructuredContent('Get person', TestSchema, {
        skipReliability: true,
      });

      expect(result).toEqual({ name: 'Truncated', age: 99, active: true });
    });

    it('should close nested object and array delimiters in stack order', async () => {
      const NestedDelimiterSchema = z.object({
        name: z.string(),
        metadata: z.object({ tags: z.array(z.string()) }),
      });
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name":"Nested","metadata":{"tags":["one","two"'));

      const result = await generateStructuredContent('Get nested data', NestedDelimiterSchema, {
        skipReliability: true,
      });

      expect(result).toEqual({
        name: 'Nested',
        metadata: { tags: ['one', 'two'] },
      });
    });

    it('should ignore escaped quotes and delimiters inside a complete string value', async () => {
      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse(String.raw`{"name":"Literal \"{[]}\" text","age":7`)
      );

      const result = await generateStructuredContent('Get escaped data', TestSchema, {
        skipReliability: true,
      });

      expect(result).toEqual({ name: 'Literal "{[]}" text', age: 7 });
    });

    it('should fail honestly when a closing delimiter mismatches the open structure', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name":"Broken","age":7]'));
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(
        generateStructuredContent('Get malformed data', TestSchema, {
          skipReliability: true,
        })
      ).rejects.toThrow('Failed to parse JSON response');

      consoleSpy.mockRestore();
    });

    it('should handle trailing commas in JSON', async () => {
      mockGenerateContent.mockResolvedValueOnce(createMockResponse('{"name": "Trailing", "age": 5, }'));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const result = await generateStructuredContent('Get person', TestSchema, {
        skipReliability: true,
      });

      expect(result.name).toBe('Trailing');
      consoleSpy.mockRestore();
    });

    it('should handle nested objects with null values', async () => {
      const NestedSchema = z.object({
        items: z.array(
          z.object({
            name: z.string(),
            value: z.number().optional(),
          })
        ),
      });

      mockGenerateContent.mockResolvedValueOnce(
        createMockResponse('{"items": [{"name": "A", "value": null}, {"name": "B", "value": 42}]}')
      );

      const result = await generateStructuredContent('Get items', NestedSchema);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].value).toBeUndefined();
      expect(result.items[1].value).toBe(42);
    });
  });

  // ==========================================================================
  // generateEmbedding
  // ==========================================================================

  describe('generateEmbedding', () => {
    it('should generate an embedding vector', async () => {
      const mockEmbedding = Array.from({ length: 768 }, () => Math.random());
      mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse(mockEmbedding));

      const result = await generateEmbedding('Test text');

      expect(result).toEqual(mockEmbedding);
      expect(result).toHaveLength(768);
    });

    it('should use default embedding model', async () => {
      mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse([0.1, 0.2]));

      await generateEmbedding('Test');

      expect(mockGetGenerativeModel).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-embedding-001' }));
    });

    it('should pass task type to embedding request', async () => {
      mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse([0.1]));

      await generateEmbedding('Query text', {
        taskType: 'RETRIEVAL_QUERY' as unknown as undefined,
      });

      expect(mockEmbedContent).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'RETRIEVAL_QUERY',
        })
      );
    });
  });

  // ==========================================================================
  // generateEmbeddingWithMetadata
  // ==========================================================================

  describe('generateEmbeddingWithMetadata', () => {
    it('should return embedding with metadata', async () => {
      const mockEmbedding = [0.1, 0.2, 0.3];
      mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse(mockEmbedding));

      const result = await generateEmbeddingWithMetadata('Test text');

      expect(result.embedding).toEqual(mockEmbedding);
      expect(result.model).toBe('gemini-embedding-001');
      expect(result.requestId).toBeDefined();
    });

    it('should use provided requestId', async () => {
      mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse([0.1]));

      const result = await generateEmbeddingWithMetadata('Test', {
        requestId: 'custom-embed-id',
      });

      expect(result.requestId).toBe('custom-embed-id');
    });
  });

  // ==========================================================================
  // generateEmbeddings (batch)
  // ==========================================================================

  describe('generateEmbeddings', () => {
    it('should generate embeddings for multiple texts', async () => {
      mockEmbedContent
        .mockResolvedValueOnce(createMockEmbeddingResponse([0.1, 0.2]))
        .mockResolvedValueOnce(createMockEmbeddingResponse([0.3, 0.4]))
        .mockResolvedValueOnce(createMockEmbeddingResponse([0.5, 0.6]));

      const result = await generateEmbeddings(['Text 1', 'Text 2', 'Text 3'], { concurrency: 3, batchDelayMs: 0 });

      expect(result.embeddings.size).toBe(3);
      expect(result.failures.size).toBe(0);
      expect(result.model).toBe('gemini-embedding-001');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should track progress via callback', async () => {
      mockEmbedContent
        .mockResolvedValueOnce(createMockEmbeddingResponse([0.1]))
        .mockResolvedValueOnce(createMockEmbeddingResponse([0.2]));

      const progressUpdates: [number, number][] = [];

      await generateEmbeddings(['A', 'B'], {
        concurrency: 2,
        batchDelayMs: 0,
        onProgress: (completed, total) => {
          progressUpdates.push([completed, total]);
        },
      });

      expect(progressUpdates.length).toBeGreaterThan(0);
      // Last update should show all completed
      const lastUpdate = progressUpdates[progressUpdates.length - 1];
      expect(lastUpdate[0]).toBe(2);
      expect(lastUpdate[1]).toBe(2);
    });

    it('should handle failures and record them', async () => {
      mockEmbedContent
        .mockResolvedValueOnce(createMockEmbeddingResponse([0.1]))
        .mockRejectedValue(new Error('Embedding failed'));

      const result = await generateEmbeddings(['OK', 'Fail'], {
        concurrency: 2,
        batchDelayMs: 0,
        maxRetries: 1, // Reduce retries to speed up test
        baseRetryDelayMs: 1,
      });

      expect(result.embeddings.size).toBe(1);
      expect(result.failures.size).toBe(1);
      expect(result.failures.get(1)).toContain('Embedding failed');
    });

    it('should process texts in batches with concurrency limit', async () => {
      // 5 texts with concurrency 2 = 3 batches
      for (let i = 0; i < 5; i++) {
        mockEmbedContent.mockResolvedValueOnce(createMockEmbeddingResponse([i * 0.1]));
      }

      const result = await generateEmbeddings(['A', 'B', 'C', 'D', 'E'], { concurrency: 2, batchDelayMs: 0 });

      expect(result.embeddings.size).toBe(5);
    });
  });

  // ==========================================================================
  // API Key Handling
  // ==========================================================================

  describe('API Key handling', () => {
    it('should throw when no API key is configured', async () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;

      await expect(generateContent('Test', { skipReliability: true })).rejects.toThrow('API key not found');
    });

    it('should throw a typed MissingAIKeyError BEFORE the reliability wrapper when keyless', async () => {
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;

      // Non-skipReliability path: the keyless guard must fire before
      // withReliability is ever entered (no circuit-breaker involvement).
      await expect(generateContent('Test')).rejects.toBeInstanceOf(MissingAIKeyError);
      await expect(generateContentWithMetadata('Test')).rejects.toBeInstanceOf(MissingAIKeyError);
      await expect(generateStructuredContent('Test', z.object({}))).rejects.toBeInstanceOf(MissingAIKeyError);
      expect(mockWithReliability).not.toHaveBeenCalled();
    });

    it('should treat placeholder scaffold keys as missing', async () => {
      process.env.GOOGLE_API_KEY = 'your-google-genai-api-key';
      process.env.GEMINI_API_KEY = 'change-me';

      await expect(generateContent('Test')).rejects.toBeInstanceOf(MissingAIKeyError);
      expect(mockWithReliability).not.toHaveBeenCalled();
    });

    it('should accept GEMINI_API_KEY as fallback', async () => {
      delete process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = 'gemini-key';

      mockGenerateContent.mockResolvedValueOnce(createMockResponse('OK'));

      const result = await generateContent('Test', { skipReliability: true });
      expect(result).toBe('OK');
    });
  });

  // ==========================================================================
  // Gemini key resolution heuristic (single source of truth)
  // ==========================================================================

  describe('isPlaceholderKey / resolveGeminiApiKey', () => {
    // Table-driven pin of the placeholder heuristic. This is the ONE place the
    // heuristic is tested — the chat route imports it from client.ts, and
    // scripts/lib/local-demo.ts isPlaceholder() must stay in sync with this
    // table (it writes the 'your-google-genai-api-key' scaffold value).
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, true],
      ['', true],
      ['   ', true],
      ['change-me', true],
      ['CHANGE-ME', true], // case-insensitive
      ['change-me-required', true],
      ['your-google-genai-api-key', true], // setup-script scaffold literal
      ['your-anything', true], // 'your-' prefix
      ['  <your-key-here>  ', true], // '<your-' anywhere, whitespace-trimmed
      ['AIzaSyREALLOOKINGKEY123', false],
      ['sk-not-a-placeholder', false],
    ];

    it.each(cases)('isPlaceholderKey(%p) → %p', (value, expected) => {
      expect(isPlaceholderKey(value)).toBe(expected);
    });

    it('resolves GOOGLE_API_KEY first when both are usable', () => {
      process.env.GOOGLE_API_KEY = 'google-key';
      process.env.GEMINI_API_KEY = 'gemini-key';
      expect(resolveGeminiApiKey()).toBe('google-key');
    });

    it('skips a placeholder GOOGLE_API_KEY and falls back to GEMINI_API_KEY', () => {
      process.env.GOOGLE_API_KEY = 'your-google-genai-api-key';
      process.env.GEMINI_API_KEY = 'real-gemini-key';
      expect(resolveGeminiApiKey()).toBe('real-gemini-key');
    });

    it('returns undefined when both keys are missing or placeholders', () => {
      process.env.GOOGLE_API_KEY = 'change-me';
      delete process.env.GEMINI_API_KEY;
      expect(resolveGeminiApiKey()).toBeUndefined();
    });
  });
});

// ============================================================================
// ARUN-022 — operation-usage capture at the Gemini chokepoint
// ============================================================================

describe('ARUN-022 operation-usage capture', () => {
  class ArraySink implements OperationUsageSink {
    readonly items: CapturedProviderUsage[] = [];
    collect(u: CapturedProviderUsage): void {
      this.items.push(u);
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, GOOGLE_API_KEY: 'test-api-key' };
    delete process.env.GEMINI_TEST_BASE_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('captures distinct token tiers and the served model into the active sink', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'hello',
        modelVersion: 'models/gemini-3.5-flash',
        usageMetadata: {
          promptTokenCount: 100, // total prompt tokens (includes the 60 cached)
          candidatesTokenCount: 40,
          thoughtsTokenCount: 12,
          cachedContentTokenCount: 60,
        },
      },
    });

    const sink = new ArraySink();
    await runWithOperationUsageSink(sink, async () => {
      await generateContent('prompt', { skipReliability: true });
    });

    expect(sink.items).toHaveLength(1);
    expect(sink.items[0]).toMatchObject({
      provider: 'gemini',
      operation: 'gemini.generate-content',
      requestedModel: 'gemini-3.5-flash',
      providerModel: 'models/gemini-3.5-flash',
      // promptTokens is the RAW total (includes the 60 cached); the pricer
      // subtracts the cached subset when billing so cache is charged once.
      counters: { promptTokens: 100, outputTokens: 40, thinkingTokens: 12, cacheReadTokens: 60 },
      usageCompleteness: 'complete',
      // An ungrounded call owes no provider fee.
      feeState: 'none',
    });
    expect(typeof sink.items[0].occurredAt).toBe('string');
  });

  it('records the grounded-search operation and a webSearchQueries count', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: {
        text: () => 'grounded answer',
        modelVersion: 'gemini-3.5-flash',
        usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 20 },
        candidates: [{ groundingMetadata: { webSearchQueries: ['q1', 'q2', 'q3'] } }],
      },
    });

    const sink = new ArraySink();
    await runWithOperationUsageSink(sink, async () => {
      await generateContent('prompt', { skipReliability: true, useGoogleSearch: true });
    });

    expect(sink.items[0]).toMatchObject({
      operation: 'gemini.grounded-generate',
      counters: { promptTokens: 30, outputTokens: 20, queryCount: 3 },
      // A grounded search owes a Google Search fee whose per-request charge is
      // free-tier-windowed and unreported → applicable-but-unknown, never $0.
      feeState: 'applicable-but-unknown',
    });
  });

  it('does not capture when no operation-usage sink is active', async () => {
    mockGenerateContent.mockResolvedValueOnce({
      response: { text: () => 'hello', usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } },
    });
    // No runWithOperationUsageSink wrapper — capture must be a strict no-op.
    await expect(generateContent('prompt', { skipReliability: true })).resolves.toBe('hello');
  });
});
