/**
 * Unit Tests for Deep Research Client
 *
 * Tests the Gemini Deep Research Interactions API wrapper:
 * - startDeepResearch: creating background research interactions
 * - pollDeepResearch: polling interaction status and extracting results
 *
 * @jest-environment node
 */

export {};

// ============================================================================
// Mocks - Must be BEFORE any imports
// ============================================================================

const mockInteractionsCreate = jest.fn();
const mockInteractionsGet = jest.fn();

// Stable logger mock so individual log methods can be asserted on. The module
// captures its logger from a single createLogger() call at import; returning the
// same object every time keeps the reference stable across the suite.
const mockLogWarn = jest.fn();
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: mockLogWarn,
  error: jest.fn(),
};

jest.mock('@google/genai', () => ({
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    interactions: {
      create: mockInteractionsCreate,
      get: mockInteractionsGet,
    },
  })),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: jest.fn(() => mockLogger),
}));

// ARUN-022 — capture the ambient usage-capture calls so the terminal-poll
// receipt behavior is assertable. The client must capture exactly once on a
// terminal event and never on an in_progress poll.
const mockCaptureProviderUsage = jest.fn();
jest.mock('@/lib/operation-context', () => ({
  captureProviderUsage: (...args: unknown[]) => mockCaptureProviderUsage(...args),
}));

// ============================================================================
// Import AFTER mocks
// ============================================================================

const { startDeepResearch, pollDeepResearch } = require('../deep-research-client');

// ============================================================================
// Tests
// ============================================================================

describe('deep-research-client', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, GOOGLE_API_KEY: 'test-api-key' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // --------------------------------------------------------------------------
  // startDeepResearch
  // --------------------------------------------------------------------------

  describe('startDeepResearch', () => {
    it('uses the guarded loopback endpoint for Interactions API requests', async () => {
      process.env.GEMINI_TEST_BASE_URL = 'http://127.0.0.1:18790';
      process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:18080';
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = 'demo-deep-research';
      mockInteractionsCreate.mockResolvedValue({ id: 'interaction-loopback' });

      await startDeepResearch('Loopback research query');

      const { GoogleGenAI } = jest.requireMock('@google/genai') as { GoogleGenAI: jest.Mock };
      expect(GoogleGenAI).toHaveBeenLastCalledWith({
        apiKey: 'test-api-key',
        httpOptions: { baseUrl: 'http://127.0.0.1:18790' },
      });
    });

    it('keeps the production constructor shape when the guarded seam is inactive', async () => {
      delete process.env.GEMINI_TEST_BASE_URL;
      mockInteractionsCreate.mockResolvedValue({ id: 'interaction-direct' });

      await startDeepResearch('Direct research query');

      const { GoogleGenAI } = jest.requireMock('@google/genai') as { GoogleGenAI: jest.Mock };
      expect(GoogleGenAI).toHaveBeenLastCalledWith({ apiKey: 'test-api-key' });
    });

    it('should call interactions.create with correct agent, input, and background flag', async () => {
      // Arrange
      const query = 'Analyze the impact of quantum computing on cryptography';
      mockInteractionsCreate.mockResolvedValue({ id: 'interaction-abc-123' });

      // Act
      await startDeepResearch(query);

      // Assert
      expect(mockInteractionsCreate).toHaveBeenCalledTimes(1);
      expect(mockInteractionsCreate).toHaveBeenCalledWith({
        agent: 'deep-research-preview-04-2026',
        input: query,
        background: true,
      });
    });

    it('should return the interactionId from the created interaction', async () => {
      // Arrange
      mockInteractionsCreate.mockResolvedValue({ id: 'interaction-xyz-789' });

      // Act
      const result = await startDeepResearch('Test query');

      // Assert
      expect(result).toEqual({ interactionId: 'interaction-xyz-789' });
    });

    it('should throw if no API key is set', async () => {
      // Arrange - remove both API key env vars
      delete process.env.GOOGLE_API_KEY;
      delete process.env.GEMINI_API_KEY;

      // Use isolateModules so the module re-evaluates with missing env vars
      await expect(async () => {
        await jest.isolateModulesAsync(async () => {
          jest.mock('@google/genai', () => ({
            GoogleGenAI: jest.fn().mockImplementation(() => ({
              interactions: { create: jest.fn(), get: jest.fn() },
            })),
          }));
          jest.mock('@/lib/logger', () => ({
            createLogger: jest.fn(() => ({
              debug: jest.fn(),
              info: jest.fn(),
              warn: jest.fn(),
              error: jest.fn(),
            })),
          }));
          const mod = require('../deep-research-client');
          await mod.startDeepResearch('some query');
        });
      }).rejects.toThrow('API key not found');
    });

    it('should use GEMINI_API_KEY when GOOGLE_API_KEY is not set', async () => {
      // Arrange
      delete process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = 'gemini-fallback-key';
      mockInteractionsCreate.mockResolvedValue({ id: 'interaction-fallback' });

      // Act
      const result = await startDeepResearch('Fallback key query');

      // Assert
      expect(result).toEqual({ interactionId: 'interaction-fallback' });
      expect(mockInteractionsCreate).toHaveBeenCalledTimes(1);
    });

    it('should propagate errors from interactions.create', async () => {
      // Arrange
      mockInteractionsCreate.mockRejectedValue(new Error('API rate limit exceeded'));

      // Act & Assert
      await expect(startDeepResearch('Rate limited query')).rejects.toThrow('API rate limit exceeded');
    });
  });

  // --------------------------------------------------------------------------
  // pollDeepResearch
  // --------------------------------------------------------------------------

  describe('pollDeepResearch', () => {
    it('should return completed with text when status is completed', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        outputs: [
          { text: 'First partial result' },
          { text: 'Final comprehensive research report on quantum computing.' },
        ],
      });

      // Act
      const result = await pollDeepResearch('interaction-abc-123');

      // Assert
      expect(result).toMatchObject({
        status: 'completed',
        text: 'Final comprehensive research report on quantum computing.',
      });
      expect(mockInteractionsGet).toHaveBeenCalledWith('interaction-abc-123');
    });

    it('should read the report text from the new `steps` field (last step)', async () => {
      // The Interactions API is migrating outputs -> steps. Newer responses
      // carry the report on `steps`, not `outputs`.
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ text: 'Step 1: gathered sources' }, { text: 'Final report sourced from the steps field.' }],
      });

      const result = await pollDeepResearch('interaction-steps');

      expect(result).toMatchObject({
        status: 'completed',
        text: 'Final report sourced from the steps field.',
      });
    });

    it('should prefer `steps` over the legacy `outputs` field when both are present', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ text: 'Report from steps (preferred)' }],
        outputs: [{ text: 'Report from outputs (legacy)' }],
      });

      const result = await pollDeepResearch('interaction-both');

      expect(result).toMatchObject({
        status: 'completed',
        text: 'Report from steps (preferred)',
      });
    });

    it('should read the new nested `steps[].content[].text` (model_output) shape', async () => {
      // The 2.x Interactions schema nests text under content[], not flat step.text.
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [
          { type: 'user_input', content: [{ type: 'text', text: 'the question' }] },
          {
            type: 'model_output',
            content: [{ type: 'text', text: 'Final report from the nested steps content shape.' }],
          },
        ],
      });

      const result = await pollDeepResearch('interaction-nested-steps');

      expect(result).toMatchObject({
        status: 'completed',
        text: 'Final report from the nested steps content shape.',
      });
    });

    it('should join multi-part content[] text within a model_output step', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              { type: 'text', text: 'Part A.' },
              { type: 'text', text: 'Part B.' },
            ],
          },
        ],
      });

      const result = await pollDeepResearch('interaction-multipart');

      expect(result).toMatchObject({ status: 'completed', text: 'Part A.\nPart B.' });
    });

    it('should pick the LAST model_output when several steps carry content', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [
          { type: 'model_output', content: [{ type: 'text', text: 'Early draft.' }] },
          { type: 'google_search_call', arguments: { queries: ['x'] } },
          { type: 'model_output', content: [{ type: 'text', text: 'Final answer.' }] },
        ],
      });

      const result = await pollDeepResearch('interaction-multi-steps');

      expect(result).toMatchObject({ status: 'completed', text: 'Final answer.' });
    });

    it('should prefer the `output_text` convenience accessor over steps and outputs', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        output_text: 'Report via output_text accessor (wins).',
        steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Report from steps.' }] }],
        outputs: [{ text: 'Report from outputs.' }],
      });

      const result = await pollDeepResearch('interaction-output-text');

      expect(result).toMatchObject({
        status: 'completed',
        text: 'Report via output_text accessor (wins).',
      });
    });

    it('should fall back to legacy `outputs` when `steps` is absent', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        outputs: [{ text: 'Legacy report from the outputs field.' }],
      });

      const result = await pollDeepResearch('interaction-outputs-fallback');

      expect(result).toMatchObject({
        status: 'completed',
        text: 'Legacy report from the outputs field.',
      });
    });

    it('should fall back to `outputs` when `steps` has no usable text', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ someOtherField: 'no text here' }],
        outputs: [{ text: 'Report recovered from outputs.' }],
      });

      const result = await pollDeepResearch('interaction-steps-empty-text');

      expect(result).toMatchObject({
        status: 'completed',
        text: 'Report recovered from outputs.',
      });
    });

    it('should return completed with empty string when text is undefined', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        outputs: [{ someOtherField: 'no text here' }],
      });

      // Act
      const result = await pollDeepResearch('interaction-no-text');

      // Assert
      expect(result).toMatchObject({
        status: 'completed',
        text: '',
      });
    });

    it('should log a warning (not silently fail) when neither steps nor outputs yield text', async () => {
      // Arrange — completed but no usable report text anywhere.
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ someOtherField: 'no text' }],
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-silent-empty');

      // Assert — empty text returned, but a warning was emitted.
      expect(result).toMatchObject({ status: 'completed', text: '' });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('no report text'),
        expect.objectContaining({ interactionId: 'interaction-silent-empty' })
      );
    });

    it('should NOT warn when a valid report is found', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ text: 'A perfectly good report.' }],
      });

      // Act
      await pollDeepResearch('interaction-has-report');

      // Assert
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it('should return completed with empty string when outputs is empty', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-empty-outputs');

      // Assert
      expect(result).toMatchObject({
        status: 'completed',
        text: '',
      });
    });

    it('should return completed with empty string when outputs is undefined', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        outputs: undefined,
      });

      // Act
      const result = await pollDeepResearch('interaction-no-outputs');

      // Assert
      expect(result).toMatchObject({
        status: 'completed',
        text: '',
      });
    });

    it('should return failed when status is failed', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'failed',
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-failed');

      // Assert
      expect(result).toMatchObject({ status: 'failed' });
    });

    it('should return failed when status is cancelled', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'cancelled',
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-cancelled');

      // Assert
      expect(result).toMatchObject({ status: 'failed' });
    });

    it('should return failed when status is incomplete', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'incomplete',
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-incomplete');

      // Assert
      expect(result).toMatchObject({ status: 'failed' });
    });

    it('should return in_progress when status is in_progress', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'in_progress',
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-pending');

      // Assert
      expect(result).toMatchObject({ status: 'in_progress' });
    });

    it('should fail fast with a truthful reason when status is requires_action', async () => {
      // Arrange — the integration is headless: user input can never be supplied,
      // so requires_action must be terminal (not in_progress → 15 min timeout).
      mockInteractionsGet.mockResolvedValue({
        status: 'requires_action',
        outputs: [],
      });

      // Act
      const result = await pollDeepResearch('interaction-requires-action');

      // Assert
      expect(result).toMatchObject({
        status: 'failed',
        reason:
          'Deep research requested user input (requires_action), which this integration does not support — try a more specific query',
      });
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining('requires user action'),
        expect.objectContaining({ interactionId: 'interaction-requires-action' })
      );
    });

    it('should propagate errors from interactions.get', async () => {
      // Arrange
      mockInteractionsGet.mockRejectedValue(new Error('Network error'));

      // Act & Assert
      await expect(pollDeepResearch('interaction-network-err')).rejects.toThrow('Network error');
    });

    it('should extract text from the last output only', async () => {
      // Arrange
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        outputs: [
          { text: 'Intermediate chunk 1' },
          { text: 'Intermediate chunk 2' },
          { text: 'The final and definitive research report.' },
        ],
      });

      // Act
      const result = await pollDeepResearch('interaction-multi-output');

      // Assert
      expect(result).toMatchObject({
        status: 'completed',
        text: 'The final and definitive research report.',
      });
    });
  });

  // --------------------------------------------------------------------------
  // ARUN-022 — operation-usage capture on terminal polls
  // --------------------------------------------------------------------------
  describe('ARUN-022 usage capture', () => {
    it('captures exactly one unreported/applicable-but-unknown receipt on completion', async () => {
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ text: 'Final report.' }],
      });

      await pollDeepResearch('interaction-capture-complete');

      expect(mockCaptureProviderUsage).toHaveBeenCalledTimes(1);
      const captured = mockCaptureProviderUsage.mock.calls[0][0] as Record<string, unknown>;
      expect(captured.provider).toBe('gemini');
      expect(captured.operation).toBe('gemini.deep-research');
      expect(captured.usageCompleteness).toBe('unreported');
      // Deep Research is billed but reports no per-call amount → never $0.
      expect(captured.feeState).toBe('applicable-but-unknown');
      // No externalFees amount (that field is for KNOWN micro-amounts only).
      expect(captured.externalFees).toBeUndefined();
      // Content-free: no report text in the capture.
      expect(JSON.stringify(captured)).not.toContain('Final report');
    });

    it('captures a failed/aborted terminal so billable-but-failed attempts stay visible', async () => {
      mockInteractionsGet.mockResolvedValue({ status: 'failed' });

      await pollDeepResearch('interaction-capture-failed');

      expect(mockCaptureProviderUsage).toHaveBeenCalledTimes(1);
      const captured = mockCaptureProviderUsage.mock.calls[0][0] as Record<string, unknown>;
      expect(captured.feeState).toBe('applicable-but-unknown');
      expect(captured.usageCompleteness).toBe('unreported');
    });

    it('captures a requires_action terminal', async () => {
      mockInteractionsGet.mockResolvedValue({ status: 'requires_action' });

      await pollDeepResearch('interaction-capture-requires-action');

      expect(mockCaptureProviderUsage).toHaveBeenCalledTimes(1);
    });

    it('does NOT capture on an in_progress poll (no billable terminal event)', async () => {
      mockInteractionsGet.mockResolvedValue({ status: 'in_progress' });

      await pollDeepResearch('interaction-capture-in-progress');

      expect(mockCaptureProviderUsage).not.toHaveBeenCalled();
    });

    it('never throws into the poll path when capture fails', async () => {
      mockCaptureProviderUsage.mockImplementation(() => {
        throw new Error('sink broken');
      });
      mockInteractionsGet.mockResolvedValue({
        status: 'completed',
        steps: [{ text: 'Report.' }],
      });

      await expect(pollDeepResearch('interaction-capture-throws')).resolves.toMatchObject({
        status: 'completed',
        text: 'Report.',
      });
      mockCaptureProviderUsage.mockReset();
    });
  });
});

// ---------------------------------------------------------------------------
// PRODUCT-003 — the poll now carries the provider's OWN plan/progress facts.
//
// The Interactions-API response was previously read only to branch on
// completed/failed, so a nine-minute run had nothing to show. These pin that
// the raw status and the agent's `steps[]` reach the caller verbatim, that a
// provider-terminal status stops the retry budget explicitly, and that nothing
// here invents a stage, a percentage or an ETA.
// ---------------------------------------------------------------------------

describe('pollDeepResearch — provider-backed progress (PRODUCT-003)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GEMINI_API_KEY = 'test-api-key';
  });

  it('passes the raw provider status and the provider’s own step types through', async () => {
    mockInteractionsGet.mockResolvedValue({
      status: 'in_progress',
      steps: [{ type: 'plan' }, { type: 'web_search' }, {}],
    });

    const result = await pollDeepResearch('interaction-progress');

    expect(result.status).toBe('in_progress');
    expect(result.progress.providerStatus).toBe('in_progress');
    expect(result.progress.steps).toEqual([{ index: 0, type: 'plan' }, { index: 1, type: 'web_search' }, { index: 2 }]);
  });

  it('reports no step list — rather than an empty one — when the provider exposes none', async () => {
    mockInteractionsGet.mockResolvedValue({ status: 'in_progress' });

    const result = await pollDeepResearch('interaction-no-steps');

    expect(result.progress.steps).toBeUndefined();
  });

  it('marks a provider-settled failure terminal and names the provider status as the reason', async () => {
    for (const status of ['failed', 'cancelled', 'incomplete']) {
      jest.clearAllMocks();
      mockInteractionsGet.mockResolvedValue({ status, steps: [{ type: 'plan' }] });

      const result = await pollDeepResearch(`interaction-${status}`);

      expect(result).toMatchObject({ status: 'failed', terminal: true });
      expect(result.reason).toContain(status);
      expect(result.progress.providerStatus).toBe(status);
    }
  });

  it('marks the headless-unsupported requires_action state terminal', async () => {
    mockInteractionsGet.mockResolvedValue({ status: 'requires_action' });

    const result = await pollDeepResearch('interaction-requires-action-terminal');

    expect(result).toMatchObject({ status: 'failed', terminal: true });
    expect(result.progress.providerStatus).toBe('requires_action');
  });

  it('leaves an in-progress poll non-terminal', async () => {
    mockInteractionsGet.mockResolvedValue({ status: 'in_progress', steps: [] });

    const result = await pollDeepResearch('interaction-still-running');

    expect(result.terminal).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });

  it('never adds a percentage, ETA, or invented stage to the observation', async () => {
    mockInteractionsGet.mockResolvedValue({ status: 'in_progress', steps: [{ type: 'plan' }] });

    const result = await pollDeepResearch('interaction-no-fabrication');

    expect(Object.keys(result.progress).sort()).toEqual(['observedAt', 'providerStatus', 'steps']);
  });
});
