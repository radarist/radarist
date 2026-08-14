/**
 * @jest-environment node
 */

/**
 * Tests for Signal Management AI tools
 *
 * Covers: executeListSignals, executeApproveSignal, executeRejectSignal,
 * executeBulkApproveSignals, executeBulkRejectSignals, executeGetSignalDetails,
 * executeResetSignalToDetected
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// ============================================================================
// Mocks (must be before imports)
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'mock-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  updateDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
}));

const mockGetSignals = jest.fn<(...args: unknown[]) => Promise<unknown[]>>();
const mockGetSignalById = jest.fn<(...args: unknown[]) => Promise<unknown | null>>();
const mockApproveSignal = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockRejectSignal = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockUpdateSignal = jest.fn<(...args: unknown[]) => Promise<void>>();
const mockCreateSignal = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMarkSignalAsImported = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.mock('@/lib/signals-admin', () => ({
  __esModule: true,
  adminGetSignals: mockGetSignals,
  adminGetSignalById: mockGetSignalById,
  adminApproveSignal: mockApproveSignal,
  adminRejectSignal: mockRejectSignal,
  adminUpdateSignal: mockUpdateSignal,
  adminCreateSignal: mockCreateSignal,
  adminMarkSignalAsImported: mockMarkSignalAsImported,
}));

// importSignalToRadar (#93) dependencies.
const mockGetTechnologies = jest.fn<(...args: unknown[]) => Promise<Array<{ id: string; name: string }>>>();
const mockCreateTechnology = jest.fn<(...args: unknown[]) => Promise<{ id: string; name: string }>>();
const mockCreateRadarPlacement = jest.fn<(...args: unknown[]) => Promise<{ id: string; ring: string }>>();
const mockCreateRadarPlacementWithHandoff = jest.fn<(...args: unknown[]) => Promise<{ placement: { id: string; ring: string }; graphHandoff: { acknowledged: boolean; reconciliationRequired: boolean } }>>(async (...args: unknown[]) => ({
  placement: await mockCreateRadarPlacement(...args),
  graphHandoff: { acknowledged: true, reconciliationRequired: false },
}));
const mockListRadars = jest.fn<(...args: unknown[]) => Promise<Array<{ id: string; name: string }>>>();
const mockGetRadarById = jest.fn<(...args: unknown[]) => Promise<unknown | null>>();
const mockGetOwnedRadarById = jest.fn<(...args: unknown[]) => Promise<{ id: string; ownerId?: string }>>();

jest.mock('@/lib/technology-admin', () => ({
  __esModule: true,
  adminCreateTechnology: (...args: unknown[]) => mockCreateTechnology(...args),
  adminGetTechnologies: (...args: unknown[]) => mockGetTechnologies(...args),
}));
jest.mock('@/lib/radar-placement-admin', () => ({
  __esModule: true,
  adminCreateRadarPlacementWithHandoff: (...args: unknown[]) => mockCreateRadarPlacementWithHandoff(...args),
  PlacementAuthorizationError: class PlacementAuthorizationError extends Error {},
}));
jest.mock('@/lib/radars-admin', () => ({
  __esModule: true,
  adminListRadars: (...args: unknown[]) => mockListRadars(...args),
  adminGetRadarById: (...args: unknown[]) => mockGetRadarById(...args),
  adminGetOwnedRadarById: (...args: unknown[]) => mockGetOwnedRadarById(...args),
  RadarAuthorizationError: class RadarAuthorizationError extends Error {},
}));
jest.mock('@/lib/events/data-refresh', () => ({
  __esModule: true,
  emitDataRefresh: jest.fn(),
}));

jest.mock('@/lib/fuzzy-search', () => ({
  fuzzySearch: jest.fn((items: unknown[]) => items),
}));

const mockExpandSignal = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock('@/lib/signals/expand-signal', () => ({
  __esModule: true,
  expandSignal: (...args: unknown[]) => mockExpandSignal(...args),
}));

jest.mock('@/lib/signals/trust-score', () => ({
  calculateTrustScore: jest.fn().mockReturnValue({
    overall: 72,
    breakdown: {
      sourceReliability: 80,
      dataCompleteness: 70,
      corroboration: 60,
      aiConfidence: 80,
    },
    factors: ['Good source'],
  }),
}));

jest.mock('@/lib/agent-events', () => ({
  __esModule: true,
  emitAgentEvent: jest.fn(() => Promise.resolve()),
}));

// ============================================================================
// Import after mocks
// ============================================================================

const {
  SIGNAL_MANAGEMENT_TOOLS,
  executeListSignals,
  executeApproveSignal,
  executeRejectSignal,
  executeBulkApproveSignals,
  executeBulkRejectSignals,
  executeGetSignalDetails,
  executeExpandSignal,
  executeResetSignalToDetected,
  executeCreateVerifiedSignal,
  executeImportSignalToRadar,
} = require('../signal-management');

// ============================================================================
// Tool Definition Tests
// ============================================================================

describe('Signal Management - Tool Definitions', () => {
  it('should contain all 11 tool definitions', () => {
    expect(SIGNAL_MANAGEMENT_TOOLS).toHaveLength(11);
    const names = SIGNAL_MANAGEMENT_TOOLS.map((t: { name: string }) => t.name);
    expect(names).toContain('listSignals');
    expect(names).toContain('approveSignalForImport');
    expect(names).toContain('rejectSignalWithReason');
    expect(names).toContain('bulkApproveSignals');
    expect(names).toContain('bulkRejectSignals');
    expect(names).toContain('getSignalDetails');
    expect(names).toContain('expandSignal');
    expect(names).toContain('resetSignalToDetected');
    expect(names).toContain('createVerifiedSignal');
    expect(names).toContain('importSignalToRadar');
  });

  it('resetSignalToDetected should have required signalId parameter', () => {
    const tool = SIGNAL_MANAGEMENT_TOOLS.find((t: { name: string }) => t.name === 'resetSignalToDetected');
    expect(tool).toBeDefined();
    expect(tool?.parameters?.properties).toHaveProperty('signalId');
    expect(tool?.parameters?.properties).toHaveProperty('reason');
    expect(tool?.parameters?.required).toContain('signalId');
    expect(tool?.parameters?.required).not.toContain('reason');
  });

  it('advertises only the real signal lifecycle statuses', () => {
    const tool = SIGNAL_MANAGEMENT_TOOLS.find((candidate: { name: string }) => candidate.name === 'listSignals');
    const status = tool?.parameters?.properties?.status as { enum?: string[]; description?: string };

    expect(status.enum).toEqual(['Detected', 'Validated', 'Approved', 'Rejected', 'Imported', 'Archived']);
    expect(status.description).not.toContain('Expanded');
  });
});

// ============================================================================
// Executor Tests
// ============================================================================

describe('Signal Management - Executors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('executeResetSignalToDetected', () => {
    it('should reset signal status to Detected', async () => {
      mockUpdateSignal.mockResolvedValue(undefined);

      const result = await executeResetSignalToDetected({
        signalId: 'sig-123',
      });

      expect(result.success).toBe(true);
      expect(result.data?.signalId).toBe('sig-123');
      expect(result.data?.newStatus).toBe('Detected');
      expect(mockUpdateSignal).toHaveBeenCalledWith('sig-123', {
        status: 'Detected',
        reviewedAt: undefined,
        validationNotes: undefined,
      });
    });

    it('should include reason in response when provided', async () => {
      mockUpdateSignal.mockResolvedValue(undefined);

      const result = await executeResetSignalToDetected({
        signalId: 'sig-456',
        reason: 'Approved by mistake',
      });

      expect(result.success).toBe(true);
      expect(result.data?.reason).toBe('Approved by mistake');
      expect(mockUpdateSignal).toHaveBeenCalledWith('sig-456', {
        status: 'Detected',
        reviewedAt: undefined,
        validationNotes: 'Reset: Approved by mistake',
      });
    });

    it('should use default reason when none provided', async () => {
      mockUpdateSignal.mockResolvedValue(undefined);

      const result = await executeResetSignalToDetected({
        signalId: 'sig-789',
      });

      expect(result.data?.reason).toBe('Reset for re-triage');
    });

    it('should handle errors gracefully', async () => {
      mockUpdateSignal.mockRejectedValue(new Error('Signal not found'));

      const result = await executeResetSignalToDetected({
        signalId: 'nonexistent',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Signal not found');
    });
  });

  describe('executeListSignals', () => {
    it('should return filtered signals', async () => {
      mockGetSignals.mockResolvedValue([
        {
          id: 'sig-1',
          type: 'news',
          title: 'AI Breakthrough',
          source: 'TechCrunch',
          status: 'Detected',
          relevanceScore: 85,
          alignmentScore: 70,
          date: Date.now(),
        },
      ]);

      const result = await executeListSignals({
        status: 'Detected',
        limit: 10,
      });

      expect(result.success).toBe(true);
      expect(result.data?.signals).toHaveLength(1);
      expect(result.data?.signals[0].id).toBe('sig-1');
    });

    it.each(['Detected', 'Validated', 'Approved', 'Rejected', 'Imported', 'Archived'])(
      'accepts advertised status %s through the real filter executor',
      async (status) => {
        mockGetSignals.mockResolvedValue([
          { id: `sig-${status}`, type: 'news', title: status, status, date: 1 },
          {
            id: 'sig-other',
            type: 'news',
            title: 'Other',
            status: status === 'Detected' ? 'Approved' : 'Detected',
            date: 2,
          },
        ]);

        const result = await executeListSignals({ status });

        expect(result.success).toBe(true);
        expect(result.data?.signals).toEqual([expect.objectContaining({ id: `sig-${status}`, status })]);
        expect(mockGetSignals).toHaveBeenCalledTimes(1);
      }
    );

    it('trims a canonical status at ingress', async () => {
      mockGetSignals.mockResolvedValue([
        { id: 'sig-approved', type: 'news', title: 'Approved', status: 'Approved', date: 1 },
      ]);

      const result = await executeListSignals({ status: ' Approved ' });

      expect(result.success).toBe(true);
      expect(result.data?.signals).toHaveLength(1);
    });

    it.each(['Expanded', 'approved', 'ARCHIVED', 'Unknown', 42])(
      'rejects phantom or unsupported status %p before reading signals',
      async (status) => {
        const result = await executeListSignals({ status });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/unknown signal status/i);
        expect(mockGetSignals).not.toHaveBeenCalled();
      }
    );

    it('matches a no-space query against a spaced title ("fable5" → "Claude Fable 5")', async () => {
      // Regression: fuzzySearch tokenizes on whitespace, so "fable5" scored 0 against
      // "Claude Fable 5" and the assistant wrongly said "no signals". The substring
      // match (whitespace-collapsed) must find it. fuzzySearch is mocked to pass-through,
      // so a hit here can ONLY come from the new exact/substring branch.
      mockGetSignals.mockResolvedValue([
        { id: 'sig-fable', type: 'news', title: 'Anthropic Claude Fable 5 suspended', status: 'Detected', date: 3 },
        { id: 'sig-other', type: 'news', title: 'Unrelated AI news', status: 'Detected', date: 2 },
      ]);

      const result = await executeListSignals({ search: 'fable5' });

      expect(result.success).toBe(true);
      expect(result.data?.signals).toHaveLength(1);
      expect(result.data?.signals[0].id).toBe('sig-fable');
    });

    it('should handle errors gracefully', async () => {
      mockGetSignals.mockRejectedValue(new Error('Firestore unavailable'));

      const result = await executeListSignals({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('Firestore unavailable');
    });
  });

  describe('executeApproveSignal', () => {
    it('should call approveSignal service', async () => {
      mockApproveSignal.mockResolvedValue(undefined);

      const result = await executeApproveSignal({
        signalId: 'sig-100',
        notes: 'Looks good',
      });

      expect(result.success).toBe(true);
      expect(mockApproveSignal).toHaveBeenCalledWith('sig-100', 'Looks good');
    });

    it('threads context.userId as feedbackUserId (T27 interest-steering wire)', async () => {
      mockApproveSignal.mockResolvedValue(undefined);

      const result = await executeApproveSignal({ signalId: 'sig-100', notes: 'Looks good' }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(mockApproveSignal).toHaveBeenCalledWith('sig-100', 'Looks good', { feedbackUserId: 'user-1' });
    });

    it('omits the options arg entirely when no context is supplied (no feedbackUserId)', async () => {
      mockApproveSignal.mockResolvedValue(undefined);

      await executeApproveSignal({ signalId: 'sig-100', notes: 'Looks good' }, {});

      expect(mockApproveSignal).toHaveBeenCalledWith('sig-100', 'Looks good');
    });
  });

  describe('executeRejectSignal', () => {
    it('should call rejectSignal with reason', async () => {
      mockRejectSignal.mockResolvedValue(undefined);

      const result = await executeRejectSignal({
        signalId: 'sig-200',
        reason: 'Not relevant',
      });

      expect(result.success).toBe(true);
      expect(mockRejectSignal).toHaveBeenCalledWith('sig-200', 'Not relevant');
    });

    it('threads context.userId as feedbackUserId (T27 interest-steering wire)', async () => {
      mockRejectSignal.mockResolvedValue(undefined);

      const result = await executeRejectSignal({ signalId: 'sig-200', reason: 'Not relevant' }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(mockRejectSignal).toHaveBeenCalledWith('sig-200', 'Not relevant', { feedbackUserId: 'user-1' });
    });

    it('should propagate service errors', async () => {
      mockRejectSignal.mockRejectedValue(new Error('Rejection reason is required'));

      const result = await executeRejectSignal({
        signalId: 'sig-200',
        reason: '',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rejection reason is required');
    });
  });

  describe('executeBulkApproveSignals', () => {
    it('threads context.userId as feedbackUserId per signal', async () => {
      mockApproveSignal.mockResolvedValue(undefined);

      const result = await executeBulkApproveSignals(
        { signalIds: ['sig-1', 'sig-2'], notes: 'Batch approve' },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(2);
      expect(mockApproveSignal).toHaveBeenNthCalledWith(1, 'sig-1', 'Batch approve', { feedbackUserId: 'user-1' });
      expect(mockApproveSignal).toHaveBeenNthCalledWith(2, 'sig-2', 'Batch approve', { feedbackUserId: 'user-1' });
    });

    it('no feedbackUserId (agent principal) → omits options, bulk approve still succeeds', async () => {
      mockApproveSignal.mockResolvedValue(undefined);

      const result = await executeBulkApproveSignals({ signalIds: ['sig-1'], notes: 'Batch approve' });

      expect(result.success).toBe(true);
      expect(result.data?.approved).toBe(1);
      expect(mockApproveSignal).toHaveBeenCalledWith('sig-1', 'Batch approve');
    });
  });

  describe('executeBulkRejectSignals', () => {
    it('threads context.userId as feedbackUserId per signal', async () => {
      mockRejectSignal.mockResolvedValue(undefined);

      const result = await executeBulkRejectSignals(
        { signalIds: ['sig-1', 'sig-2'], reason: 'Duplicates' },
        { userId: 'user-1' }
      );

      expect(result.success).toBe(true);
      expect(result.data?.rejected).toBe(2);
      expect(mockRejectSignal).toHaveBeenNthCalledWith(1, 'sig-1', 'Duplicates', { feedbackUserId: 'user-1' });
      expect(mockRejectSignal).toHaveBeenNthCalledWith(2, 'sig-2', 'Duplicates', { feedbackUserId: 'user-1' });
    });

    it('no feedbackUserId (agent principal) → omits options, bulk reject still succeeds', async () => {
      mockRejectSignal.mockResolvedValue(undefined);

      const result = await executeBulkRejectSignals({ signalIds: ['sig-1'], reason: 'Duplicates' });

      expect(result.success).toBe(true);
      expect(result.data?.rejected).toBe(1);
      expect(mockRejectSignal).toHaveBeenCalledWith('sig-1', 'Duplicates');
    });
  });

  describe('executeGetSignalDetails', () => {
    it('should return signal details when found', async () => {
      const mockSignal = {
        id: 'sig-300',
        title: 'Test Signal',
        status: 'Detected',
      };
      mockGetSignalById.mockResolvedValue(mockSignal);

      const result = await executeGetSignalDetails({ signalId: 'sig-300' });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('sig-300');
    });

    it('should return error when signal not found', async () => {
      mockGetSignalById.mockResolvedValue(null);

      const result = await executeGetSignalDetails({ signalId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('executeExpandSignal', () => {
    it('enriches an EXISTING signal in place via the expandSignal service (not a new signal)', async () => {
      mockExpandSignal.mockResolvedValue({ success: true, signalId: 'sig-fable', trustScore: { overall: 80 } });

      const result = await executeExpandSignal({ signalId: 'sig-fable' });

      expect(mockExpandSignal).toHaveBeenCalledWith('sig-fable');
      expect(result.success).toBe(true);
      expect(result.data?.signalId).toBe('sig-fable');
      // It must NOT create a new signal.
      expect(mockCreateSignal).not.toHaveBeenCalled();
    });

    it('requires a signalId', async () => {
      const result = await executeExpandSignal({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('signalId');
      expect(mockExpandSignal).not.toHaveBeenCalled();
    });

    it('surfaces a service failure honestly', async () => {
      mockExpandSignal.mockResolvedValue({ success: false, signalId: 'sig-x', error: 'expansion failed' });
      const result = await executeExpandSignal({ signalId: 'sig-x' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('expansion failed');
    });
  });

  describe('executeCreateVerifiedSignal', () => {
    it('should reject signals without URL', async () => {
      const result = await executeCreateVerifiedSignal({
        title: 'Test',
        description: 'A test signal',
        url: '',
        source: 'web',
        type: 'technology_release',
        evidence: [{ url: 'https://example.com', snippet: 'test' }],
        confidence: 'high',
        confidenceReason: 'Strong evidence',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('URL');
    });

    it('should reject signals with description under 50 chars', async () => {
      const result = await executeCreateVerifiedSignal({
        title: 'Test',
        description: 'Too short',
        url: 'https://example.com',
        source: 'web',
        type: 'technology_release',
        evidence: [{ url: 'https://example.com', snippet: 'test' }],
        confidence: 'high',
        confidenceReason: 'Strong evidence',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('description');
    });

    it('should reject signals without evidence', async () => {
      const result = await executeCreateVerifiedSignal({
        title: 'Test',
        description:
          'A sufficiently long description that exceeds the fifty character minimum threshold for validation.',
        url: 'https://example.com',
        source: 'web',
        type: 'technology_release',
        evidence: [],
        confidence: 'high',
        confidenceReason: 'Strong evidence',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('evidence');
    });

    it('should create signal with computed trust score', async () => {
      mockCreateSignal.mockResolvedValue({
        id: 'sig-1',
        title: 'Edge AI Release',
      });

      const result = await executeCreateVerifiedSignal({
        title: 'Edge AI Release',
        description:
          'A new edge AI chip has been released with significant improvements over previous generation hardware...',
        url: 'https://techcrunch.com/edge-ai',
        source: 'TechCrunch',
        type: 'technology_release',
        evidence: [{ url: 'https://techcrunch.com/edge-ai', snippet: 'The new chip...' }],
        confidence: 'high',
        confidenceReason: 'Primary source reporting',
      });

      expect(result.success).toBe(true);
      expect(result.data?.trustScore).toBeDefined();
      expect(result.data?.trustScore.overall).toBe(72);
      expect(result.data?.signalId).toBe('sig-1');
      expect(mockCreateSignal).toHaveBeenCalledTimes(1);
    });

    // ----------------------------------------------------------------------
    // AI-032 — trust must follow source independence, never raw evidence count
    // ----------------------------------------------------------------------

    // NOTE: `calculateTrustScore` is mocked in this file, so asserting on
    // `trustScore.overall` here would only test the mock. These tests assert the
    // CORROBORATION INPUT this handler computes — the thing AI-032 actually
    // changes. The end-to-end proof that those inputs cannot raise the real
    // score lives in `src/lib/signals/__tests__/verified-evidence.test.ts`,
    // which composes the real scorer.

    /** Run the handler and return the corroboration input it fed to the scorer. */
    async function corroborationInputFor(
      evidence: Array<{ url?: string; snippet: string }>
    ): Promise<{ hasCorroboration: boolean; corroboratingSourceCount: number }> {
      const { calculateTrustScore } = jest.requireMock('@/lib/signals/trust-score') as {
        calculateTrustScore: jest.Mock;
      };
      calculateTrustScore.mockClear();
      mockCreateSignal.mockResolvedValue({ id: 'sig-x', title: 'Acme launch' });

      const result = await executeCreateVerifiedSignal({
        title: 'Acme launch',
        description:
          'Acme announced a new inference accelerator with substantial throughput gains over the prior generation.',
        url: 'https://acme-vendor.com/blog/launch',
        source: 'TechCrunch',
        type: 'technology_release',
        evidence,
        confidence: 'high',
        confidenceReason: 'Reported by trade press',
      });
      expect(result.success).toBe(true);

      const input = calculateTrustScore.mock.calls[0][0] as {
        hasCorroboration: boolean;
        corroboratingSourceCount: number;
      };
      return { hasCorroboration: input.hasCorroboration, corroboratingSourceCount: input.corroboratingSourceCount };
    }

    it('counts one repeated article as a single corroborating source', async () => {
      const repeated = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://techcrunch.com/acme', snippet: 'b' },
        { url: 'https://techcrunch.com/acme', snippet: 'c' },
        { url: 'https://techcrunch.com/acme', snippet: 'd' },
      ]);

      // The old path passed 4 here, which scored 95 — the "suitable for
      // autopilot" tier — off one source repeated four times.
      expect(repeated.corroboratingSourceCount).toBe(1);
      expect(repeated.hasCorroboration).toBe(false);
    });

    it('counts redirect aliases of one article as a single corroborating source', async () => {
      const aliased = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://www.techcrunch.com/acme/', snippet: 'b' },
        { url: 'https://techcrunch.com/acme?utm_source=newsletter', snippet: 'c' },
        { url: 'http://techcrunch.com/acme', snippet: 'd' },
      ]);

      expect(aliased.corroboratingSourceCount).toBe(1);
    });

    it('counts repeated publishers across different articles as one source', async () => {
      const samePublisher = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://techcrunch.com/acme-followup', snippet: 'b' },
        { url: 'https://blog.techcrunch.com/acme-analysis', snippet: 'c' },
      ]);

      expect(samePublisher.corroboratingSourceCount).toBe(1);
    });

    it('does not count unresolved grounding redirects as corroborating sources', async () => {
      const redirects = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA', snippet: 'b' },
        { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB', snippet: 'c' },
      ]);

      expect(redirects.corroboratingSourceCount).toBe(1);
    });

    it('does not count model-authored evidence with no source URL', async () => {
      const modelAuthored = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { snippet: 'I recall this being widely reported.' },
        { url: '', snippet: 'Also widely known.' },
      ]);

      expect(modelAuthored.corroboratingSourceCount).toBe(1);
    });

    it('does not count first-party evidence from the signal own publisher', async () => {
      const withFirstParty = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://acme-vendor.com/press/launch', snippet: 'vendor press release' },
        { url: 'https://acme-vendor.com/newsroom/launch', snippet: 'vendor newsroom' },
      ]);

      expect(withFirstParty.corroboratingSourceCount).toBe(1);
    });

    it('counts genuinely independent publishers', async () => {
      const two = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://reuters.com/acme', snippet: 'b' },
      ]);
      const four = await corroborationInputFor([
        { url: 'https://techcrunch.com/acme', snippet: 'a' },
        { url: 'https://reuters.com/acme', snippet: 'b' },
        { url: 'https://ft.com/acme', snippet: 'c' },
        { url: 'https://bloomberg.com/acme', snippet: 'd' },
      ]);

      expect(two.corroboratingSourceCount).toBe(2);
      expect(two.hasCorroboration).toBe(true);
      expect(four.corroboratingSourceCount).toBe(4);
    });

    it('persists provenance labels alongside each evidence item', async () => {
      mockCreateSignal.mockResolvedValue({ id: 'sig-p', title: 'Acme launch' });
      await executeCreateVerifiedSignal({
        title: 'Acme launch',
        description:
          'Acme announced a new inference accelerator with substantial throughput gains over the prior generation.',
        url: 'https://acme-vendor.com/blog/launch',
        source: 'TechCrunch',
        type: 'technology_release',
        evidence: [
          { url: 'https://techcrunch.com/acme', snippet: 'independent' },
          { url: 'https://acme-vendor.com/press/launch', snippet: 'vendor' },
          { snippet: 'no url' },
        ],
        confidence: 'high',
        confidenceReason: 'Reported by trade press',
      });

      const persisted = mockCreateSignal.mock.calls[0][0] as {
        metadata: { evidence: Array<{ provenance: string }>; evidenceSummary: { independentPublisherCount: number } };
      };
      expect(persisted.metadata.evidence.map((item) => item.provenance)).toEqual([
        'independent',
        'first_party',
        'unverifiable',
      ]);
      expect(persisted.metadata.evidenceSummary.independentPublisherCount).toBe(1);
    });

    it('rejects a signal URL that is not a usable http(s) URL', async () => {
      const result = await executeCreateVerifiedSignal({
        title: 'Test',
        description:
          'A sufficiently long description that exceeds the fifty character minimum threshold for validation.',
        url: 'javascript:alert(1)',
        source: 'web',
        type: 'technology_release',
        evidence: [{ url: 'https://example.com', snippet: 'test' }],
        confidence: 'high',
        confidenceReason: 'Strong evidence',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('URL');
    });

    it('should pass signal data to createSignal with correct shape', async () => {
      mockCreateSignal.mockResolvedValue({
        id: 'sig-2',
        title: 'Test Signal',
      });

      await executeCreateVerifiedSignal({
        title: 'Test Signal',
        description: 'A detailed description that is long enough to pass the fifty character minimum validation check.',
        url: 'https://example.com/article',
        source: 'Example News',
        type: 'market_shift',
        evidence: [{ url: 'https://example.com/article', snippet: 'Market is shifting...' }],
        confidence: 'medium',
        confidenceReason: 'Secondary source',
      });

      const callArgs = mockCreateSignal.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs.title).toBe('Test Signal');
      expect(callArgs.status).toBe('Detected');
      expect(callArgs.relevanceScore).toBe(70);
      expect(callArgs.metadata).toHaveProperty('evidence');
      expect(callArgs.metadata).toHaveProperty('confidenceReason');
      expect(callArgs.metadata).toHaveProperty('trustScore');
    });

    it('should handle createSignal errors gracefully', async () => {
      mockCreateSignal.mockRejectedValue(new Error('Firestore write failed'));

      const result = await executeCreateVerifiedSignal({
        title: 'Error Signal',
        description: 'A detailed description that is long enough to pass the fifty character minimum validation check.',
        url: 'https://example.com',
        source: 'Test',
        type: 'news',
        evidence: [{ url: 'https://example.com', snippet: 'test' }],
        confidence: 'low',
        confidenceReason: 'Unverified source',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Firestore write failed');
    });
  });

  // ==========================================================================
  // executeImportSignalToRadar (#93)
  // ==========================================================================
  describe('executeImportSignalToRadar', () => {
    const signal = {
      id: 'sig-1',
      title: 'Neuromorphic Chips',
      description: 'Brain-inspired compute.',
      status: 'Detected',
      metadata: { matchedKeyword: 'neuromorphic' },
    };
    const radar = {
      id: 'radar-1',
      name: 'AI Radar',
      quadrants: [
        { id: 'q_platforms', name: 'Platforms' },
        { id: 'q_tools', name: 'Tools' },
      ],
    };

    beforeEach(() => {
      jest.clearAllMocks();
      mockGetSignalById.mockResolvedValue(signal);
      mockListRadars.mockResolvedValue([radar]);
      mockGetRadarById.mockResolvedValue(radar);
      mockGetOwnedRadarById.mockResolvedValue({ id: radar.id, ownerId: 'user-1' });
      mockGetTechnologies.mockResolvedValue([]);
      mockCreateTechnology.mockResolvedValue({ id: 'tech-1', name: 'Neuromorphic Chips' });
      mockCreateRadarPlacement.mockResolvedValue({ id: 'plc-1', ring: 'Assess' });
      mockMarkSignalAsImported.mockResolvedValue(undefined);
    });

    it('creates a technology, places it, and marks the signal imported', async () => {
      const result = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'Platforms' }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(mockCreateTechnology).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Neuromorphic Chips', tags: ['neuromorphic'] })
      );
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(
        expect.objectContaining({
          technologyId: 'tech-1',
          radarId: 'radar-1',
          quadrantId: 'q_platforms',
          ring: 'Assess',
          placedBy: 'user-1',
        })
      , { requireOwnerId: 'user-1' });
      // AUDIT-010: provenance is the BARE technology id — composites matched nothing downstream.
      expect(mockMarkSignalAsImported).toHaveBeenCalledWith(
        'sig-1',
        'technology',
        'tech-1' /* AUDIT-010: BARE tech id — the composite matched nothing downstream */
      );
      expect(result.data.reusedExistingTechnology).toBe(false);
    });

    it('reuses an identically-named technology instead of duplicating', async () => {
      mockGetTechnologies.mockResolvedValue([{ id: 'tech-existing', name: 'neuromorphic chips' }]);

      const result = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'q_platforms' }, { userId: 'user-1' });

      expect(result.success).toBe(true);
      expect(mockCreateTechnology).not.toHaveBeenCalled();
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(expect.objectContaining({ technologyId: 'tech-existing', placedBy: 'user-1' }), { requireOwnerId: 'user-1' });
      expect(result.data.reusedExistingTechnology).toBe(true);
    });

    it('keeps signal import id-first on collisions and whitespace-sensitive on names', async () => {
      mockGetRadarById.mockResolvedValue({
        ...radar,
        quadrants: [
          { id: 'q_name_target', name: 'collision', order: 0 },
          { id: 'collision', name: 'ID target', order: 1 },
        ],
      });

      const collision = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'collision' }, { userId: 'user-1' });
      const spaced = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: ' collision ' }, { userId: 'user-1' });

      expect(collision.success).toBe(true);
      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(expect.objectContaining({ quadrantId: 'collision', placedBy: 'user-1' }), { requireOwnerId: 'user-1' });
      expect(spaced.success).toBe(false);
      expect(spaced.error).toContain('not found on radar');
      expect(mockCreateRadarPlacement).toHaveBeenCalledTimes(1);
    });

    it('honors an explicit ring', async () => {
      await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'Platforms', ring: 'Trial' }, { userId: 'user-1' });

      expect(mockCreateRadarPlacement).toHaveBeenCalledWith(expect.objectContaining({ ring: 'Trial', placedBy: 'user-1' }), { requireOwnerId: 'user-1' });
    });

    it('fails clearly when the signal does not exist', async () => {
      mockGetSignalById.mockResolvedValue(null);

      const result = await executeImportSignalToRadar({ signalId: 'missing', quadrant: 'Platforms' }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });

    it('refuses to re-import an already-imported signal', async () => {
      mockGetSignalById.mockResolvedValue({
        ...signal,
        status: 'Imported',
        importedAs: { type: 'technology', id: 'x' },
      });

      const result = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'Platforms' }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('already imported');
      expect(mockMarkSignalAsImported).not.toHaveBeenCalled();
    });

    it('rejects an unknown quadrant and lists the valid ones', async () => {
      const result = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'Nonexistent' }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found on radar');
      expect(result.error).toContain('Platforms');
      expect(mockCreateRadarPlacement).not.toHaveBeenCalled();
    });

    it('errors when no radar exists and none is specified', async () => {
      mockListRadars.mockResolvedValue([]);

      const result = await executeImportSignalToRadar({ signalId: 'sig-1', quadrant: 'Platforms' }, { userId: 'user-1' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No radars exist');
    });
  });
});
