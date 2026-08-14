/**
 * Unit Tests for Signal Feedback System (Phase 4.2)
 *
 * Tests all feedback functions including:
 * - Submitting signal feedback (thumbs up/down)
 * - Feedback with optional reasons
 * - Feedback loop inclusion
 * - Feedback statistics calculation
 * - Agent performance metrics
 * - Negative feedback retrieval
 * - Feedback loop data for training
 *
 * @jest-environment node
 */

// NOTE: Using native Jest globals instead of @jest/globals to fix mock hoisting

// ============================================================================
// Mocks - Must be BEFORE any imports that use the mocked modules
// ============================================================================

// Mock firebase first
jest.mock('../../firebase', () => ({
  db: {},
}));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
}));

// The status write now goes through the ADMIN SDK (submitSignalFeedback is a
// Server Action; the client SDK throws a540 server-side). Mock the admin twin
// and the enrich helper (fired fire-and-forget on up-votes).
jest.mock('@/lib/signals-admin', () => ({
  adminUpdateSignal: jest.fn(),
  adminGetSignalById: jest.fn().mockResolvedValue(null), // prior-vote read for the steering wire
}));
jest.mock('@/lib/signals/enrich-on-like', () => ({
  queueEnrichOnLike: jest.fn().mockResolvedValue({ queued: false, reason: 'disabled' }),
}));

// ============================================================================
// Imports (AFTER mocks)
// ============================================================================

import type { Signal } from '../../types';
import {
  submitSignalFeedback,
  getFeedbackStats,
  getSignalsWithNegativeFeedback,
  getFeedbackLoopData,
} from '../feedback';
import { getDocs, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { adminUpdateSignal } from '@/lib/signals-admin';

// Cast mocks for type safety
const mockGetDocs = getDocs as jest.Mock;
const _mockGetDoc = getDoc as jest.Mock;
const _mockSetDoc = setDoc as jest.Mock;
const mockAdminUpdateSignal = adminUpdateSignal as jest.Mock;
const _mockDeleteDoc = deleteDoc as jest.Mock;

/**
 * Helper to create a mock signal with feedback
 */
function createMockSignalWithFeedback(overrides?: Partial<Signal>): Signal {
  return {
    id: 'signal-123',
    type: 'patent',
    title: 'Novel AI system',
    description: 'Machine learning system...',
    source: 'USPTO Patent #12345678',
    url: 'https://patents.google.com/patent/US12345678',
    date: Date.now() - 24 * 60 * 60 * 1000,
    relevanceScore: 85,
    alignmentScore: 78,
    alignedStrategies: ['strategy-789'],
    linkedEntities: {
      technologies: ['tech-radar-1:ai-ml'],
      companies: ['company-123'],
      useCases: ['usecase-456'],
    },
    status: 'Detected',
    sentiment: 'positive',
    aiSummary: 'AI system for innovation',
    detectedAt: Date.now() - 24 * 60 * 60 * 1000,
    trustScore: {
      overall: 85,
      breakdown: {
        sourceReliability: 90,
        dataCompleteness: 85,
        corroboration: 80,
        aiConfidence: 85,
      },
      factors: ['verified-source', 'complete-data'],
    },
    feedback: {
      vote: 'up',
      votedAt: Date.now(),
      votedBy: 'user-123',
      includedInFeedbackLoop: true,
    },
    ...overrides,
  } as Signal;
}

describe('Signal Feedback System', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('submitSignalFeedback()', () => {
    it('should submit thumbs up feedback without reason', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      const result = await submitSignalFeedback('signal-123', 'up');

      expect(result.success).toBe(true);
      expect(mockAdminUpdateSignal).toHaveBeenCalledTimes(1);

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;
      expect(updateCall.feedback.vote).toBe('up');
      expect(updateCall.feedback.votedAt).toBeDefined();
      expect(updateCall.feedback.votedBy).toBe('anonymous');
      expect(updateCall.feedback.includedInFeedbackLoop).toBe(true);
      expect(updateCall.feedback.reason).toBeUndefined();
    });

    it('should submit thumbs down feedback with reason', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      const result = await submitSignalFeedback('signal-123', 'down', 'Not relevant to our strategy', true, 'user-456');

      expect(result.success).toBe(true);

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;
      expect(updateCall.feedback.vote).toBe('down');
      expect(updateCall.feedback.reason).toBe('Not relevant to our strategy');
      expect(updateCall.feedback.votedBy).toBe('user-456');
      expect(updateCall.feedback.includedInFeedbackLoop).toBe(true);
    });

    it('should exclude from feedback loop when specified', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      const result = await submitSignalFeedback(
        'signal-123',
        'down',
        'Low quality',
        false // Don't include in feedback loop
      );

      expect(result.success).toBe(true);

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;
      expect(updateCall.feedback.includedInFeedbackLoop).toBe(false);
    });

    it('should not include reason field when undefined', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      await submitSignalFeedback('signal-123', 'up', undefined);

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;
      expect('reason' in updateCall.feedback).toBe(false);
    });

    it('should update updatedAt timestamp', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      const beforeTime = Date.now();
      await submitSignalFeedback('signal-123', 'up');
      const afterTime = Date.now();

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;
      expect(updateCall.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(updateCall.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('should handle Firestore errors gracefully', async () => {
      mockAdminUpdateSignal.mockRejectedValueOnce(new Error('Firestore error'));

      const result = await submitSignalFeedback('signal-123', 'up');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Firestore error');
    });

    it('should handle non-Error exceptions', async () => {
      mockAdminUpdateSignal.mockRejectedValueOnce('Unknown error');

      const result = await submitSignalFeedback('signal-123', 'up');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Failed to submit feedback');
    });
  });

  describe('getFeedbackStats()', () => {
    it('should calculate feedback statistics correctly', async () => {
      const mockSignals = [
        createMockSignalWithFeedback({
          id: 'signal-1',
          feedback: {
            vote: 'up',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
            reason: 'Very relevant',
          },
        }),
        createMockSignalWithFeedback({
          id: 'signal-2',
          feedback: {
            vote: 'down',
            votedAt: Date.now(),
            votedBy: 'user-2',
            includedInFeedbackLoop: true,
          },
        }),
        createMockSignalWithFeedback({
          id: 'signal-3',
          feedback: {
            vote: 'up',
            votedAt: Date.now(),
            votedBy: 'user-3',
            includedInFeedbackLoop: false,
          },
        }),
      ];

      const docs = mockSignals.map((s) => ({ data: () => s }));
      mockGetDocs.mockResolvedValueOnce({
        docs,
        size: docs.length,
      });

      const stats = await getFeedbackStats();

      expect(stats.totalFeedback).toBe(3);
      expect(stats.upvotes).toBe(2);
      expect(stats.downvotes).toBe(1);
      expect(stats.withReasons).toBe(1);
      expect(stats.inFeedbackLoop).toBe(2);
    });

    it('should return zero stats when no feedback exists', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [], size: 0 });

      const stats = await getFeedbackStats();

      expect(stats.totalFeedback).toBe(0);
      expect(stats.upvotes).toBe(0);
      expect(stats.downvotes).toBe(0);
      expect(stats.withReasons).toBe(0);
      expect(stats.inFeedbackLoop).toBe(0);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Database error'));

      const stats = await getFeedbackStats();

      expect(stats.totalFeedback).toBe(0);
    });

    it('should ignore signals without feedback', async () => {
      const mockSignals = [
        createMockSignalWithFeedback({
          id: 'signal-1',
          feedback: {
            vote: 'up',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
          },
        }),
        createMockSignalWithFeedback({
          id: 'signal-2',
          feedback: undefined,
        }),
      ];

      const docs = mockSignals.map((s) => ({ data: () => s }));
      mockGetDocs.mockResolvedValueOnce({
        docs,
        size: docs.length,
      });

      const stats = await getFeedbackStats();

      expect(stats.totalFeedback).toBe(2); // Query filters for feedback != null
      expect(stats.upvotes).toBe(1);
    });
  });

  describe('getSignalsWithNegativeFeedback()', () => {
    it('should return signals with downvotes', async () => {
      const mockSignals = [
        createMockSignalWithFeedback({
          id: 'signal-1',
          feedback: {
            vote: 'down',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
            reason: 'Not relevant',
          },
        }),
        createMockSignalWithFeedback({
          id: 'signal-2',
          feedback: {
            vote: 'down',
            votedAt: Date.now(),
            votedBy: 'user-2',
            includedInFeedbackLoop: true,
          },
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({
          id: s.id,
          data: () => s,
        })),
      });

      const result = await getSignalsWithNegativeFeedback();

      expect(result).toHaveLength(2);
      expect((result[0] as Signal).feedback?.vote).toBe('down');
      expect((result[1] as Signal).feedback?.vote).toBe('down');
    });

    it('should apply limit parameter', async () => {
      const mockSignals = Array.from({ length: 50 }, (_, i) =>
        createMockSignalWithFeedback({
          id: `signal-${i}`,
          feedback: {
            vote: 'down',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
          },
        })
      );

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({
          id: s.id,
          data: () => s,
        })),
      });

      const result = await getSignalsWithNegativeFeedback(10);

      expect(result).toHaveLength(10);
    });

    it('should use default limit of 20', async () => {
      const mockSignals = Array.from({ length: 30 }, (_, i) =>
        createMockSignalWithFeedback({
          id: `signal-${i}`,
          feedback: {
            vote: 'down',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
          },
        })
      );

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({
          id: s.id,
          data: () => s,
        })),
      });

      const result = await getSignalsWithNegativeFeedback();

      expect(result.length).toBeLessThanOrEqual(20);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Database error'));

      const result = await getSignalsWithNegativeFeedback();

      expect(result).toEqual([]);
    });
  });

  describe('getFeedbackLoopData()', () => {
    it('should return positive and negative examples', async () => {
      const mockSignals = [
        createMockSignalWithFeedback({
          id: 'signal-1',
          title: 'Great Innovation',
          feedback: {
            vote: 'up',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
            reason: 'Very relevant',
          },
        }),
        createMockSignalWithFeedback({
          id: 'signal-2',
          title: 'Poor Signal',
          feedback: {
            vote: 'down',
            votedAt: Date.now(),
            votedBy: 'user-2',
            includedInFeedbackLoop: true,
            reason: 'Not relevant',
          },
        }),
        createMockSignalWithFeedback({
          id: 'signal-3',
          title: 'Excluded Signal',
          feedback: {
            vote: 'up',
            votedAt: Date.now(),
            votedBy: 'user-3',
            includedInFeedbackLoop: false, // Excluded
          },
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals
          .filter((s) => s.feedback?.includedInFeedbackLoop)
          .map((s) => ({
            id: s.id,
            data: () => s,
          })),
      });

      const result = await getFeedbackLoopData();

      expect(result.positive).toHaveLength(1);
      expect(result.negative).toHaveLength(1);
      expect(result.positive[0].signalId).toBe('signal-1');
      expect(result.positive[0].title).toBe('Great Innovation');
      expect(result.negative[0].signalId).toBe('signal-2');
      expect(result.negative[0].feedback?.reason).toBe('Not relevant');
    });

    it('should include signal metadata in feedback loop', async () => {
      const mockSignals = [
        createMockSignalWithFeedback({
          id: 'signal-1',
          title: 'Test Signal',
          description: 'Test description',
          source: 'Test source',
          type: 'patent',
          relevanceScore: 90,
          alignmentScore: 85,
          feedback: {
            vote: 'up',
            votedAt: Date.now(),
            votedBy: 'user-1',
            includedInFeedbackLoop: true,
          },
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({
          id: s.id,
          data: () => s,
        })),
      });

      const result = await getFeedbackLoopData();

      expect(result.positive[0]).toMatchObject({
        signalId: 'signal-1',
        title: 'Test Signal',
        description: 'Test description',
        source: 'Test source',
        type: 'patent',
        relevanceScore: 90,
        alignmentScore: 85,
      });
    });

    it('should return empty arrays when no feedback loop data exists', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getFeedbackLoopData();

      expect(result.positive).toEqual([]);
      expect(result.negative).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Database error'));

      const result = await getFeedbackLoopData();

      expect(result.positive).toEqual([]);
      expect(result.negative).toEqual([]);
    });
  });

  describe('Edge Cases', () => {
    it('should handle concurrent feedback submissions', async () => {
      mockAdminUpdateSignal.mockResolvedValue(undefined);

      await Promise.all([
        submitSignalFeedback('signal-1', 'up'),
        submitSignalFeedback('signal-2', 'down'),
        submitSignalFeedback('signal-3', 'up'),
      ]);

      expect(mockAdminUpdateSignal).toHaveBeenCalledTimes(3);
    });

    it('should handle feedback updates (changing vote)', async () => {
      mockAdminUpdateSignal.mockResolvedValue(undefined);

      // First vote
      await submitSignalFeedback('signal-123', 'up');

      // Change to down vote
      await submitSignalFeedback('signal-123', 'down', 'Changed my mind');

      expect(mockAdminUpdateSignal).toHaveBeenCalledTimes(2);

      const secondCall = mockAdminUpdateSignal.mock.calls[1][1] as any;
      expect(secondCall.feedback.vote).toBe('down');
      expect(secondCall.feedback.reason).toBe('Changed my mind');
    });

    it('should handle empty strings as reason', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      await submitSignalFeedback('signal-123', 'down', '');

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;
      // Empty string is falsy, so reason should not be included
      expect('reason' in updateCall.feedback).toBe(false);
    });

    it('should preserve other signal fields when submitting feedback', async () => {
      mockAdminUpdateSignal.mockResolvedValueOnce(undefined);

      await submitSignalFeedback('signal-123', 'up');

      const updateCall = mockAdminUpdateSignal.mock.calls[0][1] as any;

      // By default, updateStatus=true so status, reviewedAt, reviewedBy are also updated
      expect(Object.keys(updateCall).sort()).toEqual(
        ['feedback', 'reviewedAt', 'reviewedBy', 'status', 'updatedAt'].sort()
      );
    });
  });
});
