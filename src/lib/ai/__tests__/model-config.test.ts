/**
 * Unit tests for the env-backed Gemini model accessors in model-config.ts.
 *
 * Each accessor reads process.env on every call (no module-level caching), so we
 * can mutate process.env per-test and restore it afterwards without re-importing
 * the module.
 *
 * @jest-environment node
 */

import {
  geminiTextModel,
  geminiProModel,
  geminiChatModel,
  geminiImageModel,
  geminiDeepResearchModel,
  geminiEmbeddingModel,
  geminiEmbeddingDim,
} from '../model-config';

const MODEL_ENV_VARS = [
  'GEMINI_TEXT_MODEL',
  'GEMINI_PRO_MODEL',
  'GEMINI_CHAT_MODEL',
  'GEMINI_IMAGE_MODEL',
  'GEMINI_DEEP_RESEARCH_MODEL',
  'GEMINI_EMBEDDING_MODEL',
  'GEMINI_EMBEDDING_DIM',
] as const;

describe('model-config accessors', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Start each test from a clean copy with all model env vars unset.
    process.env = { ...originalEnv };
    for (const key of MODEL_ENV_VARS) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('defaults (no env override)', () => {
    it('geminiTextModel defaults to gemini-3.5-flash', () => {
      expect(geminiTextModel()).toBe('gemini-3.5-flash');
    });

    it('geminiProModel defaults to gemini-3.1-pro-preview', () => {
      expect(geminiProModel()).toBe('gemini-3.1-pro-preview');
    });

    it('geminiChatModel defaults to gemini-3.1-pro-preview (reverted from flash — flash regressed the tool-loop)', () => {
      expect(geminiChatModel()).toBe('gemini-3.1-pro-preview');
    });

    it('geminiImageModel defaults to gemini-3-pro-image', () => {
      expect(geminiImageModel()).toBe('gemini-3-pro-image');
    });

    it('geminiDeepResearchModel defaults to deep-research-preview-04-2026', () => {
      expect(geminiDeepResearchModel()).toBe('deep-research-preview-04-2026');
    });

    it('geminiEmbeddingModel defaults to gemini-embedding-001', () => {
      expect(geminiEmbeddingModel()).toBe('gemini-embedding-001');
    });

    it('geminiEmbeddingDim defaults to 768', () => {
      expect(geminiEmbeddingDim()).toBe(768);
    });
  });

  describe('env overrides', () => {
    it('geminiTextModel honors GEMINI_TEXT_MODEL', () => {
      process.env.GEMINI_TEXT_MODEL = 'gemini-4-flash';
      expect(geminiTextModel()).toBe('gemini-4-flash');
    });

    it('geminiProModel honors GEMINI_PRO_MODEL', () => {
      process.env.GEMINI_PRO_MODEL = 'gemini-4-pro';
      expect(geminiProModel()).toBe('gemini-4-pro');
    });

    it('geminiChatModel honors GEMINI_CHAT_MODEL', () => {
      process.env.GEMINI_CHAT_MODEL = 'gemini-3.5-flash';
      expect(geminiChatModel()).toBe('gemini-3.5-flash');
    });

    it('geminiImageModel honors GEMINI_IMAGE_MODEL', () => {
      process.env.GEMINI_IMAGE_MODEL = 'nano-banana-3';
      expect(geminiImageModel()).toBe('nano-banana-3');
    });

    it('geminiDeepResearchModel honors GEMINI_DEEP_RESEARCH_MODEL', () => {
      process.env.GEMINI_DEEP_RESEARCH_MODEL = 'deep-research-next';
      expect(geminiDeepResearchModel()).toBe('deep-research-next');
    });

    it('geminiEmbeddingModel honors GEMINI_EMBEDDING_MODEL', () => {
      process.env.GEMINI_EMBEDDING_MODEL = 'gemini-embedding-002';
      expect(geminiEmbeddingModel()).toBe('gemini-embedding-002');
    });

    it('geminiEmbeddingDim honors GEMINI_EMBEDDING_DIM', () => {
      process.env.GEMINI_EMBEDDING_DIM = '1536';
      expect(geminiEmbeddingDim()).toBe(1536);
    });
  });

  describe('robustness', () => {
    it('trims surrounding whitespace from env values', () => {
      process.env.GEMINI_TEXT_MODEL = '  gemini-spaced  ';
      expect(geminiTextModel()).toBe('gemini-spaced');
    });

    it('treats an all-whitespace env value as unset (falls back to default)', () => {
      process.env.GEMINI_PRO_MODEL = '   ';
      expect(geminiProModel()).toBe('gemini-3.1-pro-preview');
    });

    it('treats an empty env value as unset (falls back to default)', () => {
      process.env.GEMINI_IMAGE_MODEL = '';
      expect(geminiImageModel()).toBe('gemini-3-pro-image');
    });

    it('falls back to 768 when GEMINI_EMBEDDING_DIM is not a number', () => {
      process.env.GEMINI_EMBEDDING_DIM = 'not-a-number';
      expect(geminiEmbeddingDim()).toBe(768);
    });

    it('falls back to 768 when GEMINI_EMBEDDING_DIM is zero or negative', () => {
      process.env.GEMINI_EMBEDDING_DIM = '0';
      expect(geminiEmbeddingDim()).toBe(768);
      process.env.GEMINI_EMBEDDING_DIM = '-512';
      expect(geminiEmbeddingDim()).toBe(768);
    });
  });
});
