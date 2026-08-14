/**
 * @jest-environment node
 */

/**
 * @file Tests for run-document-deep-research Inngest function
 *
 * Tests verify:
 * - Function is registered with correct config (id, retries, concurrency)
 * - Successful flow: all 5 steps execute and return expected result
 * - startDeepResearch failure propagates error
 * - pollDeepResearch 'failed' status throws error
 * - Poll timeout (MAX_POLL_ITERATIONS exceeded) throws timeout error
 * - uploadDocument failure throws error
 * - processDocumentFromContent failure is non-fatal
 * - Empty research text throws error in save-to-storage step
 * - onFailure handler updates document status to 'failed'
 */

type AnyFunction = (...args: any[]) => any;

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock inngest client with registry pattern (established project convention)
jest.mock('../../client', () => {
  const registry: {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  } = { handlers: {}, configs: {}, triggers: {} };

  return {
    __esModule: true,
    inngest: {
      createFunction: jest.fn((config: Record<string, unknown>, trigger: unknown, handler: AnyFunction) => {
        const id = config.id as string;
        registry.handlers[id] = handler;
        registry.configs[id] = config;
        registry.triggers[id] = trigger;
        return { config, trigger, handler };
      }),
      send: jest.fn().mockResolvedValue(undefined),
    },
    _registry: registry,
  };
});

// Mock deep research client
const mockStartDeepResearch = jest.fn();
const mockPollDeepResearch = jest.fn();
jest.mock('@/lib/ai/deep-research-client', () => ({
  __esModule: true,
  startDeepResearch: (...args: unknown[]) => mockStartDeepResearch(...args),
  pollDeepResearch: (...args: unknown[]) => mockPollDeepResearch(...args),
}));

// Mock document admin service (source now uses adminUpdateDocument from @/lib/document-admin)
const mockUpdateDocument = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/document-admin', () => ({
  __esModule: true,
  adminUpdateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
}));

// Mock document storage admin service (source now uses adminUploadDocument from @/lib/document-storage-admin)
const mockUploadDocument = jest.fn();
jest.mock('@/lib/document-storage-admin', () => ({
  __esModule: true,
  adminUploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}));

// Mock document processing service
const mockProcessDocumentFromContent = jest.fn();
jest.mock('@/lib/document-processing-service', () => ({
  __esModule: true,
  processDocumentFromContent: (...args: unknown[]) => mockProcessDocumentFromContent(...args),
}));

// Mock logger
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }),
}));

// Import AFTER all mocks — triggers createFunction and populates registry
import '../run-document-deep-research';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNCTION_ID = 'run-document-deep-research';

function getRegistry() {
  const clientMock = require('../../client');
  return clientMock._registry as {
    handlers: Record<string, AnyFunction>;
    configs: Record<string, Record<string, unknown>>;
    triggers: Record<string, unknown>;
  };
}

function getHandler(): AnyFunction {
  const handler = getRegistry().handlers[FUNCTION_ID];
  if (!handler) throw new Error(`Handler for '${FUNCTION_ID}' not found in registry`);
  return handler;
}

function getConfig(): Record<string, unknown> {
  const config = getRegistry().configs[FUNCTION_ID];
  if (!config) throw new Error(`Config for '${FUNCTION_ID}' not found in registry`);
  return config;
}

function getTrigger(): Record<string, unknown> {
  return getRegistry().triggers[FUNCTION_ID] as Record<string, unknown>;
}

function buildMockStep() {
  return {
    run: jest.fn((name: string, fn: AnyFunction) => fn()),
    sleep: jest.fn().mockResolvedValue(undefined),
    sendEvent: jest.fn().mockResolvedValue(undefined),
  };
}

function buildEventContext(overrides: Record<string, unknown> = {}) {
  return {
    event: {
      data: {
        query: 'Analyze emerging quantum computing trends in 2026',
        documentId: 'doc-123',
        userId: 'user-456',
        ...overrides,
      },
    },
    step: buildMockStep(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** A report that clears the AI-038 evidence gate: primary sources, cited identifiers. */
const WELL_SOURCED_REPORT = [
  '# Deep Research Result',
  '',
  'Findings here, claimed in [US11234567B2](https://patents.google.com/patent/US11234567B2/en)',
  'and proved in [arXiv:2401.12345](https://arxiv.org/abs/2401.12345).',
].join('\n');

/**
 * The live AI-038 failure in miniature: many citations, every one an opaque
 * grounding redirect, plus patent numbers that appear in no source.
 */
const REDIRECT_ONLY_REPORT = [
  '# Quantum Patent Landscape',
  '',
  'IBM holds US11234567B2 and Google filed EP3456789A1.',
  '',
  ...Array.from(
    { length: 43 },
    (_, index) => `[${index + 1}]: https://vertexaisearch.cloud.google.com/grounding-api-redirect/token${index}`
  ),
].join('\n');

describe('run-document-deep-research', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default happy-path mock behaviors. AI-038: the happy path is a report that
    // CLEARS the evidence gate — two distinct primary sources and no identifier
    // claim that goes uncited — so these tests still describe an untouched
    // pass-through. The gate's own behaviour is covered in its describe block.
    mockStartDeepResearch.mockResolvedValue({ interactionId: 'interaction-abc' });
    mockPollDeepResearch.mockResolvedValue({ status: 'completed', text: WELL_SOURCED_REPORT });
    mockUploadDocument.mockResolvedValue({
      success: true,
      storageUrl: 'documents/user-456/deep-research-doc-123.md',
    });
    mockUpdateDocument.mockResolvedValue(undefined);
    mockProcessDocumentFromContent.mockResolvedValue({
      success: true,
      chunkCount: 5,
    });
  });

  // -------------------------------------------------------------------------
  // Function configuration
  // -------------------------------------------------------------------------

  describe('function registration', () => {
    it('should register with correct id', () => {
      expect(getConfig().id).toBe('run-document-deep-research');
    });

    it('should register with correct name', () => {
      expect(getConfig().name).toBe('Run Document Deep Research');
    });

    it('should set retries to 2', () => {
      expect(getConfig().retries).toBe(2);
    });

    it('should set concurrency limit to 3', () => {
      expect(getConfig().concurrency).toEqual({ limit: 3 });
    });

    it('should have an onFailure handler', () => {
      expect(typeof getConfig().onFailure).toBe('function');
    });

    it('should trigger on app/document.deep-research.requested event', () => {
      expect(getTrigger()).toEqual({ event: 'app/document.deep-research.requested' });
    });
  });

  // -------------------------------------------------------------------------
  // Successful flow
  // -------------------------------------------------------------------------

  describe('successful flow', () => {
    it('should execute steps in correct order', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const stepNames = ctx.step.run.mock.calls.map((call: [string, AnyFunction]) => call[0]);
      // OBS-006: both timing endpoints are STEPS, which is the whole point — a
      // step result is memoized by Inngest and replayed verbatim, so the span
      // survives the poll checkpoints in between. The start step must bracket
      // all real work, and the end step must come after it.
      expect(stepNames).toEqual([
        'capture-start-time',
        'start-research',
        // PRODUCT-003: the interaction id is persisted immediately — it is the
        // only handle by which a run outlasting the poll budget can be checked
        // again, so it must land before the first poll can time out.
        'record-interaction',
        'poll-0',
        'save-to-storage',
        'update-document',
        'chunk-document',
        'sync-to-graph',
        'capture-end-time',
      ]);
    });

    it('should call startDeepResearch with the query', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockStartDeepResearch).toHaveBeenCalledWith('Analyze emerging quantum computing trends in 2026');
    });

    it('should call pollDeepResearch with the interactionId', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockPollDeepResearch).toHaveBeenCalledWith('interaction-abc');
    });

    it('should upload research text as markdown buffer', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockUploadDocument).toHaveBeenCalledWith(
        expect.any(Buffer),
        'deep-research-doc-123.md',
        'text/markdown',
        'user-456'
      );

      // A report that clears the gate is uploaded verbatim — no banner added.
      const uploadedBuffer = mockUploadDocument.mock.calls[0][0] as Buffer;
      expect(uploadedBuffer.toString('utf-8')).toBe(WELL_SOURCED_REPORT);
    });

    it('should update document with storage metadata', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      // Find the update-document step call
      const updateCalls = mockUpdateDocument.mock.calls.filter((call: unknown[]) => call[0] === 'doc-123');
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);

      // The first updateDocument call should be from the 'update-document' step
      expect(mockUpdateDocument).toHaveBeenCalledWith('doc-123', {
        storageUrl: 'documents/user-456/deep-research-doc-123.md',
        fileSize: Buffer.byteLength(WELL_SOURCED_REPORT, 'utf-8'),
        mimeType: 'text/markdown',
        researchEvidence: expect.objectContaining({ verdict: 'sufficient' }),
      });
    });

    it('should process document for chunking', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      expect(mockProcessDocumentFromContent).toHaveBeenCalledWith('doc-123', WELL_SOURCED_REPORT);
    });

    it('should return success result with metadata', async () => {
      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result).toMatchObject({
        success: true,
        documentId: 'doc-123',
        resultLength: WELL_SOURCED_REPORT.length,
        evidenceVerdict: 'sufficient',
      });
      // OBS-006: units are named. The old field was `duration` — a bare number a
      // reader had to guess the unit of, which is part of why a `9` next to a
      // 561-second span never looked wrong.
      expect(typeof result.executionMs).toBe('number');
      expect(result.executionMs).toBeGreaterThanOrEqual(0);
      expect(result.totalMs).toBe(result.executionMs);
      // This trigger carries no accepted-at token, so queue wait is honestly
      // absent rather than reported as zero.
      expect(result.basis).toBe('started-to-terminal');
      expect(result).not.toHaveProperty('queueWaitMs');
      expect(result).not.toHaveProperty('duration');
      // OBS-001: the run declares its own business outcome.
      expect(result.__domainOutcome).toEqual({ outcome: 'success' });
    });
  });

  // -------------------------------------------------------------------------
  // AI-038 — primary-evidence gate
  // -------------------------------------------------------------------------

  describe('primary-evidence gate (AI-038)', () => {
    beforeEach(() => {
      mockPollDeepResearch.mockResolvedValue({ status: 'completed', text: REDIRECT_ONLY_REPORT });
    });

    it('RETAINS a report that fails the gate — the artifact is not discarded', async () => {
      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result.success).toBe(true);
      expect(mockUploadDocument).toHaveBeenCalled();
      // Never marked failed: the document is real, it is just not verified.
      expect(mockUpdateDocument).not.toHaveBeenCalledWith('doc-123', expect.objectContaining({ status: 'failed' }));
    });

    it('prepends the evidence review INTO the stored markdown, not just onto the record', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const uploaded = (mockUploadDocument.mock.calls[0][0] as Buffer).toString('utf-8');
      expect(uploaded.startsWith('> **Evidence review — insufficient primary evidence**')).toBe(true);
      expect(uploaded).toContain('UNVERIFIED');
      expect(uploaded).toContain(REDIRECT_ONLY_REPORT);
    });

    it('chunks the ANNOTATED text so a retrieved citation carries its own caveat', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const chunkedText = mockProcessDocumentFromContent.mock.calls[0][1] as string;
      expect(chunkedText).toContain('Evidence review');
      expect(chunkedText).toBe((mockUploadDocument.mock.calls[0][0] as Buffer).toString('utf-8'));
    });

    it('persists the bounded verdict on the document record', async () => {
      const ctx = buildEventContext();
      await getHandler()(ctx);

      const [, updates] = mockUpdateDocument.mock.calls.find(
        (call: unknown[]) => (call[1] as Record<string, unknown>)?.researchEvidence !== undefined
      ) as [string, { researchEvidence: Record<string, unknown> }];

      expect(updates.researchEvidence).toMatchObject({
        verdict: 'insufficient',
        totalCitations: 43,
        searchRedirectCitations: 43,
        primaryCitations: 0,
        distinctPrimaryDomains: 0,
      });
      expect(updates.researchEvidence.findingCodes).toEqual(
        expect.arrayContaining(['no-resolvable-citations', 'unsupported-identifier-claims', 'below-primary-quota'])
      );
      expect(updates.researchEvidence.unsupportedIdentifiers).toEqual(
        expect.arrayContaining(['US11234567B2', 'EP3456789A1'])
      );
    });

    it('records the annotated length so fileSize matches what was actually stored', async () => {
      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      const uploaded = (mockUploadDocument.mock.calls[0][0] as Buffer).toString('utf-8');
      expect(result.resultLength).toBe(uploaded.length);
      expect(mockUpdateDocument).toHaveBeenCalledWith(
        'doc-123',
        expect.objectContaining({ fileSize: Buffer.byteLength(uploaded, 'utf-8') })
      );
    });

    it('grades a sourced-but-thin report as `limited` without the unverified warning', async () => {
      mockPollDeepResearch.mockResolvedValue({
        status: 'completed',
        text: '# Market View\n\n[TechCrunch](https://techcrunch.com/a) and [Reuters](https://reuters.com/b) agree.',
      });

      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result.evidenceVerdict).toBe('limited');
      const uploaded = (mockUploadDocument.mock.calls[0][0] as Buffer).toString('utf-8');
      expect(uploaded).toContain('limited primary evidence');
      expect(uploaded).not.toContain('UNVERIFIED');
    });

    it('is stable across a replay — the same report yields the same stored bytes', async () => {
      const first = (await getHandler()(buildEventContext())) as { resultLength: number };
      const firstUpload = (mockUploadDocument.mock.calls[0][0] as Buffer).toString('utf-8');

      mockUploadDocument.mockClear();
      const second = (await getHandler()(buildEventContext())) as { resultLength: number };
      const secondUpload = (mockUploadDocument.mock.calls[0][0] as Buffer).toString('utf-8');

      expect(secondUpload).toBe(firstUpload);
      expect(second.resultLength).toBe(first.resultLength);
    });
  });

  // -------------------------------------------------------------------------
  // startDeepResearch failure
  // -------------------------------------------------------------------------

  describe('startDeepResearch failure', () => {
    it('should propagate error when startDeepResearch throws', async () => {
      mockStartDeepResearch.mockRejectedValue(new Error('Interactions API unavailable'));

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Interactions API unavailable');
    });

    it('should not proceed to poll step on start failure', async () => {
      mockStartDeepResearch.mockRejectedValue(new Error('API error'));

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();

      expect(mockPollDeepResearch).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // pollDeepResearch returns 'failed'
  // -------------------------------------------------------------------------

  describe('pollDeepResearch failure status', () => {
    it('should throw when poll returns failed status', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'failed' });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Deep research task failed');
    });

    it('should not proceed to upload step on poll failure', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'failed' });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();

      expect(mockUploadDocument).not.toHaveBeenCalled();
    });

    it('should not mark the document failed inline for a generic failure (onFailure owns it)', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'failed' });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();

      // PRODUCT-003: the interaction-id write is expected; what must NOT happen
      // is an inline terminal status write, which onFailure owns.
      expect(mockUpdateDocument).not.toHaveBeenCalledWith('doc-123', expect.objectContaining({ status: 'failed' }));
    });
  });

  // -------------------------------------------------------------------------
  // pollDeepResearch returns terminal 'failed' with a reason (requires_action)
  // -------------------------------------------------------------------------

  describe('pollDeepResearch terminal failure with reason (requires_action fail-fast)', () => {
    const REQUIRES_ACTION_REASON =
      'Deep research requested user input (requires_action), which this integration does not support — try a more specific query';

    it('should mark the document failed immediately with the truthful reason', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'failed', reason: REQUIRES_ACTION_REASON });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow(REQUIRES_ACTION_REASON);

      expect(mockUpdateDocument).toHaveBeenCalledWith('doc-123', {
        status: 'failed',
        errorMessage: REQUIRES_ACTION_REASON,
      });
    });

    it('should stop polling on the first requires_action result (no timeout burn)', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'failed', reason: REQUIRES_ACTION_REASON });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();

      expect(mockPollDeepResearch).toHaveBeenCalledTimes(1);
      expect(ctx.step.sleep).not.toHaveBeenCalled();
      expect(mockUploadDocument).not.toHaveBeenCalled();
    });

    it('should still throw even if marking the document failed rejects', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'failed', reason: REQUIRES_ACTION_REASON });
      mockUpdateDocument.mockRejectedValueOnce(new Error('Firestore down'));

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow(REQUIRES_ACTION_REASON);
    });
  });

  // -------------------------------------------------------------------------
  // Poll timeout
  // -------------------------------------------------------------------------

  describe('poll timeout', () => {
    it('should throw timeout error after MAX_POLL_ITERATIONS', async () => {
      // Always return 'in_progress' to simulate infinite polling
      mockPollDeepResearch.mockResolvedValue({ status: 'in_progress' });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Deep research timed out after 60 poll iterations');

      // Should have polled exactly MAX_POLL_ITERATIONS times
      expect(mockPollDeepResearch).toHaveBeenCalledTimes(60);

      // Should have called step.sleep between polls
      expect(ctx.step.sleep).toHaveBeenCalledTimes(60);
    });

    it('should not proceed to upload on timeout', async () => {
      mockPollDeepResearch.mockResolvedValue({ status: 'in_progress' });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();
      expect(mockUploadDocument).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Poll completes after multiple in_progress rounds
  // -------------------------------------------------------------------------

  describe('poll with intermediate in_progress', () => {
    it('should succeed after several in_progress polls', async () => {
      mockPollDeepResearch
        .mockResolvedValueOnce({ status: 'in_progress' })
        .mockResolvedValueOnce({ status: 'in_progress' })
        .mockResolvedValueOnce({
          status: 'completed',
          text: '# Result after delay',
        });

      const ctx = buildEventContext();
      const result = await getHandler()(ctx);

      expect(result.success).toBe(true);
      expect(mockPollDeepResearch).toHaveBeenCalledTimes(3);
      // Should have slept between polls (2 sleeps for 3 polls)
      expect(ctx.step.sleep).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // uploadDocument failure
  // -------------------------------------------------------------------------

  describe('uploadDocument failure', () => {
    it('should throw when upload returns success: false', async () => {
      mockUploadDocument.mockResolvedValue({
        success: false,
        error: 'Storage quota exceeded',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Failed to upload research result: Storage quota exceeded');
    });

    it('should throw with unknown error when upload fails without message', async () => {
      mockUploadDocument.mockResolvedValue({
        success: false,
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Failed to upload research result: Unknown error');
    });

    it('should proceed when upload succeeds with storageUrl', async () => {
      mockUploadDocument.mockResolvedValue({
        success: true,
        storageUrl: 'gs://bucket/path/file.md',
      });

      const ctx = buildEventContext();
      const result = await getHandler()(ctx);
      expect(result.success).toBe(true);
    });

    it('should throw when uploadDocument rejects', async () => {
      mockUploadDocument.mockRejectedValue(new Error('Network timeout'));

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Network timeout');
    });

    it('should not proceed to update-document step on upload failure', async () => {
      mockUploadDocument.mockResolvedValue({
        success: false,
        error: 'Disk full',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();

      // The step-4 metadata write must NOT be reached. The PRODUCT-003
      // interaction-id write happens before the upload and is expected.
      expect(mockUpdateDocument).not.toHaveBeenCalledWith('doc-123', expect.objectContaining({ storageUrl: expect.anything() }));
    });
  });

  // -------------------------------------------------------------------------
  // processDocumentFromContent failure (AI-021: honest failed state)
  // -------------------------------------------------------------------------

  describe('processDocumentFromContent failure (honest failed state)', () => {
    it('should throw so Inngest can retry, keeping the truthful failed status', async () => {
      mockProcessDocumentFromContent.mockResolvedValue({
        success: false,
        error: 'Embedding model unavailable',
        stage: 'embedding',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow(
        'Chunking failed at stage embedding: Embedding model unavailable'
      );
    });

    it('must NEVER overwrite the failed chunking state with processed', async () => {
      mockProcessDocumentFromContent.mockResolvedValue({
        success: false,
        error: 'Token limit exceeded',
        stage: 'chunking',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();

      expect(mockUpdateDocument).not.toHaveBeenCalledWith('doc-123', expect.objectContaining({ status: 'processed' }));
    });
  });

  // -------------------------------------------------------------------------
  // Empty research text
  // -------------------------------------------------------------------------

  describe('empty research text', () => {
    it('should throw when research text is empty string', async () => {
      mockPollDeepResearch.mockResolvedValue({
        status: 'completed',
        text: '',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Deep research returned empty result');
    });

    it('should throw when research text is whitespace only', async () => {
      mockPollDeepResearch.mockResolvedValue({
        status: 'completed',
        text: '   \n\t  ',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Deep research returned empty result');
    });

    it('should throw when research text is undefined (via nullish coalesce)', async () => {
      mockPollDeepResearch.mockResolvedValue({
        status: 'completed',
        text: undefined,
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow('Deep research returned empty result');
    });

    it('should not call uploadDocument when research text is empty', async () => {
      mockPollDeepResearch.mockResolvedValue({
        status: 'completed',
        text: '',
      });

      const ctx = buildEventContext();
      await expect(getHandler()(ctx)).rejects.toThrow();
      expect(mockUploadDocument).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onFailure handler
  // -------------------------------------------------------------------------

  describe('onFailure handler', () => {
    // In Inngest onFailure, the original event is nested: event.data.event.data.*
    it('should update document status to failed', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: { message: 'Interactions API rate limit' },
        event: {
          data: {
            event: {
              data: {
                documentId: 'doc-fail-1',
                query: 'some query',
              },
            },
          },
        },
      });

      expect(mockUpdateDocument).toHaveBeenCalledWith('doc-fail-1', {
        status: 'failed',
        errorMessage: 'Deep research failed: Interactions API rate limit',
      });
    });

    it('should skip update when documentId is not provided', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: { message: 'Unexpected error' },
        event: {
          data: {
            event: {
              data: {},
            },
          },
        },
      });

      expect(mockUpdateDocument).not.toHaveBeenCalled();
    });

    it('should not throw if updateDocument fails in onFailure', async () => {
      mockUpdateDocument.mockRejectedValueOnce(new Error('Firestore down'));
      const onFailure = getConfig().onFailure as AnyFunction;

      // Should not throw — error is caught and logged
      await expect(
        onFailure({
          error: { message: 'Original error' },
          event: {
            data: {
              event: {
                data: { documentId: 'doc-fail-2' },
              },
            },
          },
        })
      ).resolves.toBeUndefined();
    });

    it('should include error message in errorMessage field', async () => {
      const onFailure = getConfig().onFailure as AnyFunction;

      await onFailure({
        error: { message: 'Gemini quota exhausted after 3 retries' },
        event: {
          data: {
            event: {
              data: { documentId: 'doc-fail-3' },
            },
          },
        },
      });

      const updateArgs = mockUpdateDocument.mock.calls[0];
      expect(updateArgs[1].errorMessage).toContain('Gemini quota exhausted after 3 retries');
    });
  });
});

// ---------------------------------------------------------------------------
// PRODUCT-003 — provider-backed plan/progress
//
// The nine-minute run that showed nothing but "Processing" did so because the
// Interactions-API poll response was read only to branch on completed/failed.
// These tests pin that the provider's own facts now reach the document, that
// our poll budget is stated as ours, and that no branch invents a stage,
// a percentage, or an ETA.
// ---------------------------------------------------------------------------

describe('PRODUCT-003 — deep research progress', () => {
  const observation = (providerStatus: string, stepCount?: number) => ({
    providerStatus,
    ...(stepCount === undefined ? {} : { steps: Array.from({ length: stepCount }, (_, i) => ({ index: i })) }),
    observedAt: '2026-07-30T10:00:00.000Z',
  });

  /** The document writes that carried a progress snapshot, in order. */
  function progressWrites() {
    return mockUpdateDocument.mock.calls
      .filter((call: [string, Record<string, unknown>]) => call[1].deepResearchProgress !== undefined)
      .map((call: [string, Record<string, unknown>]) => call[1].deepResearchProgress as Record<string, unknown>);
  }

  beforeEach(() => {
    // This block sits outside the main describe, so it owns its own reset.
    jest.clearAllMocks();
    mockUpdateDocument.mockReset().mockResolvedValue(undefined);
    mockPollDeepResearch.mockReset();
    mockStartDeepResearch.mockResolvedValue({ interactionId: 'interaction-abc' });
    mockUploadDocument.mockResolvedValue({ success: true, storageUrl: 'gs://bucket/doc.md' });
    mockProcessDocumentFromContent.mockResolvedValue({ success: true, chunkCount: 3 });
  });

  it('persists the interaction id before polling, so a timeout stays resumable', async () => {
    mockPollDeepResearch.mockResolvedValue({
      status: 'completed',
      text: WELL_SOURCED_REPORT,
      progress: observation('completed', 4),
    });

    await getHandler()(buildEventContext());

    expect(mockUpdateDocument).toHaveBeenCalledWith('doc-123', { deepResearchInteractionId: 'interaction-abc' });
  });

  it('records the provider’s own status and step count — and no percentage or ETA', async () => {
    mockPollDeepResearch
      .mockResolvedValueOnce({ status: 'in_progress', progress: observation('in_progress', 1) })
      .mockResolvedValueOnce({ status: 'in_progress', progress: observation('in_progress', 3) })
      .mockResolvedValue({ status: 'completed', text: WELL_SOURCED_REPORT, progress: observation('completed', 5) });

    await getHandler()(buildEventContext());

    const writes = progressWrites();
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes[0]).toMatchObject({ providerStatus: 'in_progress', stepCount: 1, interactionId: 'interaction-abc' });
    expect(writes[1]).toMatchObject({ providerStatus: 'in_progress', stepCount: 3 });
    const terminal = writes[writes.length - 1];
    expect(terminal).toMatchObject({ providerStatus: 'completed', stepCount: 5, terminal: { state: 'completed' } });
    // Our poll budget is stated as ours; nothing claims to know how far along
    // the agent is.
    expect(terminal.poll).toEqual({ iteration: 3, max: 60, intervalSeconds: 15 });
    expect(JSON.stringify(writes)).not.toMatch(/percent|\beta\b|estimatedCompletion/i);
  });

  it('does not restate an unchanged snapshot on every poll', async () => {
    mockPollDeepResearch
      .mockResolvedValueOnce({ status: 'in_progress', progress: observation('in_progress', 2) })
      .mockResolvedValueOnce({ status: 'in_progress', progress: observation('in_progress', 2) })
      .mockResolvedValue({ status: 'completed', text: WELL_SOURCED_REPORT, progress: observation('completed', 2) });

    await getHandler()(buildEventContext());

    // First (new), the unchanged second is skipped, then the terminal one.
    expect(progressWrites()).toHaveLength(2);
  });

  it('marks a run whose provider reports no step list as progress-unavailable, never as stalled', async () => {
    mockPollDeepResearch
      .mockResolvedValueOnce({ status: 'in_progress', progress: observation('in_progress') })
      .mockResolvedValue({ status: 'completed', text: WELL_SOURCED_REPORT, progress: observation('completed') });

    await getHandler()(buildEventContext());

    const writes = progressWrites();
    expect(writes[0]).toMatchObject({ progressUnavailable: true, stalled: false });
    expect(writes[0].stepCount).toBeUndefined();
  });

  it('records a provider-reported stall once no new step arrives for long enough', async () => {
    mockPollDeepResearch.mockImplementation(async () => ({
      status: 'in_progress',
      progress: observation('in_progress', 2),
    }));

    await expect(getHandler()(buildEventContext())).rejects.toThrow(/timed out/);

    const stalled = progressWrites().filter((write) => write.stalled === true);
    expect(stalled.length).toBeGreaterThan(0);
  });

  it('distinguishes our exhausted poll budget from a provider failure and keeps it resumable', async () => {
    mockPollDeepResearch.mockResolvedValue({
      status: 'in_progress',
      progress: observation('in_progress', 2),
    });

    await expect(getHandler()(buildEventContext())).rejects.toThrow(/timed out/);

    const last = progressWrites().at(-1)!;
    expect(last).toMatchObject({
      terminal: { state: 'timed-out' },
      resumable: true,
      providerStatus: 'in_progress',
    });
    expect((last.terminal as { reason: string }).reason).toContain('in_progress');
  });

  it('carries a provider terminal status through as the failure reason and settles it', async () => {
    mockPollDeepResearch.mockResolvedValue({
      status: 'failed',
      reason: 'Deep research ended with provider status "cancelled"',
      terminal: true,
      progress: observation('cancelled', 1),
    });

    await expect(getHandler()(buildEventContext())).rejects.toThrow(/cancelled/);

    const last = progressWrites().at(-1)!;
    expect(last).toMatchObject({ terminal: { state: 'failed' }, resumable: false, providerStatus: 'cancelled' });
    expect(mockUpdateDocument).toHaveBeenCalledWith(
      'doc-123',
      expect.objectContaining({ status: 'failed', errorMessage: expect.stringContaining('cancelled') })
    );
  });

  it('runs unchanged against a memoized pre-deploy poll result that carries no progress', async () => {
    mockPollDeepResearch.mockResolvedValue({ status: 'completed', text: WELL_SOURCED_REPORT });

    await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ success: true });
    expect(progressWrites()).toHaveLength(0);
  });

  it('never lets a progress write failure break the research run', async () => {
    mockUpdateDocument.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      if (patch.deepResearchProgress || patch.deepResearchInteractionId) throw new Error('firestore unavailable');
    });
    mockPollDeepResearch.mockResolvedValue({
      status: 'completed',
      text: WELL_SOURCED_REPORT,
      progress: observation('completed', 2),
    });

    await expect(getHandler()(buildEventContext())).resolves.toMatchObject({ success: true });
  });
});
