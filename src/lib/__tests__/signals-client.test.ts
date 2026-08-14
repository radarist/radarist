/**
 * Unit Tests for signals-client.ts
 *
 * Tests all client-safe signal operations:
 * - getSignals, getSignalById
 * - markSignalAsImported
 * - approveSignal, rejectSignal
 * - getSignalsByStatus, getPendingSignals
 * - getHighConfidenceSignals, getSignalStatistics
 * - getSignalsByAgent, deleteSignal
 * - mergeIntoSignal, dismissDuplicate
 *
 * @jest-environment node
 */

// Mock Firebase BEFORE imports
jest.mock('@/lib/firebase', () => ({ db: {} }));

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'mock-id' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  startAfter: jest.fn(),
  Timestamp: {
    now: jest.fn(() => ({ toMillis: () => Date.now() })),
    fromDate: jest.fn(),
  },
  writeBatch: jest.fn(() => ({
    set: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  })),
  serverTimestamp: jest.fn(),
  increment: jest.fn(),
  arrayUnion: jest.fn(),
  arrayRemove: jest.fn(),
}));

import { getDocs, getDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import type { Signal, SignalType, SignalStatus } from '../types';

import {
  getSignals,
  getSignalById,
  markSignalAsImported,
  approveSignal,
  rejectSignal,
  getSignalsByStatus,
  getPendingSignals,
  getHighConfidenceSignals,
  getSignalStatistics,
  getSignalsByAgent,
  deleteSignal,
  mergeIntoSignal,
  dismissDuplicate,
} from '../signals-client';

const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;

// Helper to create a mock signal
function createMockSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'signal-123',
    slug: 'test-signal',
    type: 'news' as SignalType,
    title: 'Test Signal',
    description: 'Test description',
    source: 'TechCrunch',
    url: 'https://example.com',
    date: Date.now(),
    relevanceScore: 75,
    alignmentScore: 60,
    alignedStrategies: [],
    linkedEntities: { technologies: [], companies: [], useCases: [] },
    status: 'Detected' as SignalStatus,
    sentiment: 'positive',
    aiSummary: 'Summary',
    detectedAt: Date.now() - 1000 * 60 * 60,
    ...overrides,
  } as Signal;
}

describe('signals-client module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // getSignals
  // =========================================================================

  describe('getSignals()', () => {
    it('should fetch all signals and return them', async () => {
      const signals = [
        createMockSignal({ id: 's1', title: 'Signal 1' }),
        createMockSignal({ id: 's2', title: 'Signal 2' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getSignals();

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Signal 1');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no signals', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getSignals();

      expect(result).toEqual([]);
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getSignals()).rejects.toThrow('Failed to fetch signals');
    });
  });

  // =========================================================================
  // getSignalById
  // =========================================================================

  describe('getSignalById()', () => {
    it('should return signal when it exists', async () => {
      const signal = createMockSignal();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => signal,
      });

      const result = await getSignalById('signal-123');

      expect(result).toEqual(signal);
    });

    it('should return null when signal does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      const result = await getSignalById('nonexistent');

      expect(result).toBeNull();
    });

    it('should throw on Firestore error', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('DB error'));

      await expect(getSignalById('signal-123')).rejects.toThrow(
        'Failed to fetch signal signal-123'
      );
    });
  });

  // =========================================================================
  // markSignalAsImported
  // =========================================================================

  describe('markSignalAsImported()', () => {
    it('should mark signal as imported with technology reference', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await markSignalAsImported('signal-123', 'technology', 'tech-456');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Imported');
      expect(updateArg.importedAs.type).toBe('technology');
      expect(updateArg.importedAs.id).toBe('tech-456');
    });

    it('should mark signal as imported with company reference', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await markSignalAsImported('signal-123', 'company', 'company-789');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.importedAs.type).toBe('company');
    });

    it('should mark signal as imported with useCase reference', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await markSignalAsImported('signal-123', 'useCase', 'uc-789');

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.importedAs.type).toBe('useCase');
    });

    it('should throw if signal does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(
        markSignalAsImported('nonexistent', 'technology', 'tech-456')
      ).rejects.toThrow('Failed to mark signal as imported');
    });

    it('should throw on Firestore error', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        markSignalAsImported('signal-123', 'technology', 'tech-456')
      ).rejects.toThrow('Failed to mark signal as imported');
    });
  });

  // =========================================================================
  // approveSignal
  // =========================================================================

  describe('approveSignal()', () => {
    it('should approve signal without review notes', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await approveSignal('signal-123');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Approved');
      expect(updateArg.reviewedAt).toBeDefined();
    });

    it('should approve signal with review notes', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await approveSignal('signal-123', 'Excellent signal');

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Approved');
      expect(updateArg.validationNotes).toContain('Excellent signal');
    });

    it('should throw on update failure', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockRejectedValueOnce(new Error('Update failed'));

      await expect(approveSignal('signal-123')).rejects.toThrow(
        'Failed to approve signal signal-123'
      );
    });

    it('should throw when signal does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(approveSignal('nonexistent')).rejects.toThrow(
        'Failed to approve signal nonexistent'
      );
    });
  });

  // =========================================================================
  // rejectSignal
  // =========================================================================

  describe('rejectSignal()', () => {
    it('should reject signal with a reason', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await rejectSignal('signal-123', 'Not relevant');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Rejected');
      expect(updateArg.validationNotes).toContain('Not relevant');
    });

    it('should throw if reason is empty', async () => {
      await expect(rejectSignal('signal-123', '')).rejects.toThrow(
        'Failed to reject signal signal-123'
      );
    });

    it('should throw if reason is whitespace only', async () => {
      await expect(rejectSignal('signal-123', '   ')).rejects.toThrow(
        'Failed to reject signal signal-123'
      );
    });

    it('should throw on Firestore error', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockRejectedValueOnce(new Error('Write error'));

      await expect(rejectSignal('signal-123', 'Valid reason')).rejects.toThrow(
        'Failed to reject signal signal-123'
      );
    });
  });

  // =========================================================================
  // getSignalsByStatus
  // =========================================================================

  describe('getSignalsByStatus()', () => {
    it('should return signals filtered by status', async () => {
      const validated = createMockSignal({ id: 'v1', status: 'Validated', detectedAt: Date.now() - 1000 });
      const validated2 = createMockSignal({ id: 'v2', status: 'Validated', detectedAt: Date.now() - 2000 });
      mockGetDocs.mockResolvedValueOnce({
        docs: [validated2, validated].map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStatus('Validated');

      expect(result).toHaveLength(2);
      // Sorted newest first
      expect(result[0].id).toBe('v1');
    });

    it('should apply maxResults limit', async () => {
      const signals = Array.from({ length: 10 }, (_, i) =>
        createMockSignal({ id: `s${i}`, detectedAt: Date.now() - i * 1000 })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStatus('Detected', 3);

      expect(result).toHaveLength(3);
    });

    it('should return all signals when maxResults not specified', async () => {
      const signals = Array.from({ length: 5 }, (_, i) =>
        createMockSignal({ id: `s${i}` })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStatus('Detected');

      expect(result).toHaveLength(5);
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Query failed'));

      await expect(getSignalsByStatus('Detected')).rejects.toThrow(
        'Failed to fetch signals by status Detected'
      );
    });
  });

  // =========================================================================
  // getPendingSignals
  // =========================================================================

  describe('getPendingSignals()', () => {
    it('should fetch signals with Validated status', async () => {
      const signals = [
        createMockSignal({ id: 'p1', status: 'Validated' }),
        createMockSignal({ id: 'p2', status: 'Validated' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getPendingSignals();

      expect(result).toHaveLength(2);
    });

    it('should apply default limit of 50', async () => {
      const signals = Array.from({ length: 100 }, (_, i) =>
        createMockSignal({ id: `s${i}`, status: 'Validated', detectedAt: Date.now() - i * 1000 })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getPendingSignals();

      expect(result.length).toBeLessThanOrEqual(50);
    });

    it('should accept custom maxResults', async () => {
      const signals = Array.from({ length: 20 }, (_, i) =>
        createMockSignal({ id: `s${i}`, status: 'Validated', detectedAt: Date.now() - i * 1000 })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getPendingSignals(5);

      expect(result).toHaveLength(5);
    });
  });

  // =========================================================================
  // getHighConfidenceSignals
  // =========================================================================

  describe('getHighConfidenceSignals()', () => {
    it('should return high confidence signals sorted by relevance', async () => {
      const high = createMockSignal({ id: 'h1', relevanceScore: 95, detectedAt: Date.now() - 1000 });
      const medium = createMockSignal({ id: 'h2', relevanceScore: 85, detectedAt: Date.now() - 2000 });
      mockGetDocs.mockResolvedValueOnce({
        docs: [medium, high].map((s) => ({ data: () => s })),
      });

      const result = await getHighConfidenceSignals(80);

      expect(result[0].id).toBe('h1'); // highest relevance first
      expect(result[1].id).toBe('h2');
    });

    it('should sort by detectedAt when relevance scores are equal', async () => {
      const newer = createMockSignal({ id: 'n1', relevanceScore: 90, detectedAt: Date.now() - 100 });
      const older = createMockSignal({ id: 'n2', relevanceScore: 90, detectedAt: Date.now() - 5000 });
      mockGetDocs.mockResolvedValueOnce({
        docs: [older, newer].map((s) => ({ data: () => s })),
      });

      const result = await getHighConfidenceSignals(80);

      expect(result[0].id).toBe('n1'); // newer first when same score
    });

    it('should apply maxResults limit', async () => {
      const signals = Array.from({ length: 10 }, (_, i) =>
        createMockSignal({ id: `s${i}`, relevanceScore: 90 + i })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getHighConfidenceSignals(80, 3);

      expect(result).toHaveLength(3);
    });

    it('should use default threshold of 80', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      await getHighConfidenceSignals();

      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getHighConfidenceSignals()).rejects.toThrow(
        'Failed to fetch high-confidence signals'
      );
    });
  });

  // =========================================================================
  // getSignalStatistics
  // =========================================================================

  describe('getSignalStatistics()', () => {
    it('should return accurate statistics for mixed signals', async () => {
      const signals = [
        createMockSignal({ type: 'patent', status: 'Detected', source: 'USPTO', relevanceScore: 80, alignmentScore: 70 }),
        createMockSignal({ type: 'patent', status: 'Validated', source: 'Google', relevanceScore: 60, alignmentScore: 50 }),
        createMockSignal({ type: 'news', status: 'Imported', source: 'TechCrunch', relevanceScore: 90, alignmentScore: 80 }),
        createMockSignal({ type: 'paper', status: 'Rejected', source: 'arXiv', relevanceScore: 50, alignmentScore: 40 }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.total).toBe(4);
      expect(stats.pendingCount).toBe(1); // Validated
      expect(stats.approvedCount).toBe(0);
      expect(stats.rejectedCount).toBe(1);
      expect(stats.importedCount).toBe(1);
      expect(stats.signalsByType.patent).toBe(2);
      expect(stats.signalsByType.news).toBe(1);
      expect(stats.signalsByType.paper).toBe(1);
    });

    it('should calculate import rate correctly', async () => {
      const signals = [
        createMockSignal({ status: 'Imported' }),
        createMockSignal({ status: 'Rejected' }),
        createMockSignal({ status: 'Imported' }),
        createMockSignal({ status: 'Rejected' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.importRate).toBe(50); // 2/4 * 100
    });

    it('should return 0 import rate when no completed signals', async () => {
      const signals = [createMockSignal({ status: 'Detected' })];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.importRate).toBe(0);
    });

    it('should calculate average relevance', async () => {
      const signals = [
        createMockSignal({ relevanceScore: 80 }),
        createMockSignal({ relevanceScore: 60 }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.averageRelevance).toBe(70);
    });

    it('should identify top source correctly', async () => {
      const signals = [
        createMockSignal({ source: 'TechCrunch' }),
        createMockSignal({ source: 'TechCrunch' }),
        createMockSignal({ source: 'arXiv' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.topSource).toBe('TechCrunch');
    });

    it('should handle empty signals list', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const stats = await getSignalStatistics();

      expect(stats.total).toBe(0);
      expect(stats.averageRelevance).toBe(0);
      expect(stats.averageAlignment).toBe(0);
      expect(stats.topSource).toBe('None');
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getSignalStatistics()).rejects.toThrow(
        'Failed to calculate signal statistics'
      );
    });
  });

  // =========================================================================
  // getSignalsByAgent
  // =========================================================================

  describe('getSignalsByAgent()', () => {
    it('should return signals for a specific agent', async () => {
      const agentSignal = createMockSignal({
        id: 'agent-sig-1',
        metadata: { agentId: 'agent-123' },
        detectedAt: Date.now() - 1000,
      });
      const otherSignal = createMockSignal({
        id: 'other-sig',
        metadata: { agentId: 'other-agent' },
      });
      mockGetDocs.mockResolvedValueOnce({
        docs: [agentSignal, otherSignal].map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByAgent('agent-123');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('agent-sig-1');
    });

    it('should apply maxResults limit', async () => {
      const signals = Array.from({ length: 10 }, (_, i) =>
        createMockSignal({
          id: `s${i}`,
          metadata: { agentId: 'agent-123' },
          detectedAt: Date.now() - i * 1000,
        })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByAgent('agent-123', 3);

      expect(result).toHaveLength(3);
    });

    it('should return empty when agent has no signals', async () => {
      mockGetDocs.mockResolvedValueOnce({
        docs: [createMockSignal({ metadata: { agentId: 'other' } })].map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByAgent('agent-123');

      expect(result).toHaveLength(0);
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getSignalsByAgent('agent-123')).rejects.toThrow(
        'Failed to get signals for agent agent-123'
      );
    });
  });

  // =========================================================================
  // deleteSignal
  // =========================================================================

  describe('deleteSignal()', () => {
    it('should delete signal successfully', async () => {
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteSignal('signal-123');

      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw on Firestore error', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Delete failed'));

      await expect(deleteSignal('signal-123')).rejects.toThrow(
        'Failed to delete signal signal-123'
      );
    });
  });

  // =========================================================================
  // mergeIntoSignal
  // =========================================================================

  describe('mergeIntoSignal()', () => {
    it('should merge new signal data into existing signal', async () => {
      const existingSignal = createMockSignal({
        id: 'existing-123',
        metadata: { mergedSources: [] },
      });
      // First getDoc for getSignalById
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingSignal });
      // Second getDoc for existence check in updateSignal
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingSignal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await mergeIntoSignal('existing-123', {
        title: 'Same topic different source',
        source: 'NewSource',
        url: 'https://new-source.com',
      });

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });

    it('should append description when new description is long enough', async () => {
      const existingSignal = createMockSignal({
        id: 'existing-123',
        description: 'Existing description',
        metadata: {},
      });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingSignal });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingSignal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const longDescription = 'A'.repeat(51); // > 50 chars
      await mergeIntoSignal('existing-123', {
        title: 'Title',
        source: 'Source',
        description: longDescription,
      });

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.description).toContain('Existing description');
      expect(updateArg.description).toContain(longDescription);
    });

    it('should throw when signal not found', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(
        mergeIntoSignal('nonexistent', { title: 'T', source: 'S' })
      ).rejects.toThrow('Failed to merge signal');
    });

    it('should throw on Firestore error', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        mergeIntoSignal('signal-123', { title: 'T', source: 'S' })
      ).rejects.toThrow('Failed to merge signal');
    });
  });

  // =========================================================================
  // dismissDuplicate
  // =========================================================================

  describe('dismissDuplicate()', () => {
    it('should remove duplicate from possibleDuplicates list', async () => {
      const signal = createMockSignal({
        id: 'sig-1',
        metadata: {
          possibleDuplicates: [
            { signalId: 'dup-1', similarity: 85 },
            { signalId: 'dup-2', similarity: 80 },
          ],
          dismissedDuplicates: [],
        },
      });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await dismissDuplicate('sig-1', 'dup-1');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      const remaining = updateArg.metadata.possibleDuplicates;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].signalId).toBe('dup-2');
      expect(updateArg.metadata.dismissedDuplicates).toContain('dup-1');
    });

    it('should work when no existing possibleDuplicates', async () => {
      const signal = createMockSignal({ id: 'sig-1', metadata: {} });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await dismissDuplicate('sig-1', 'dup-1');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw when signal not found', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(dismissDuplicate('nonexistent', 'dup-1')).rejects.toThrow(
        'Failed to dismiss duplicate'
      );
    });

    it('should throw on Firestore error', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('DB error'));

      await expect(dismissDuplicate('sig-1', 'dup-1')).rejects.toThrow(
        'Failed to dismiss duplicate'
      );
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('Edge cases', () => {
    it('getSignalStatistics() - all signal types are counted', async () => {
      const signals = [
        createMockSignal({ type: 'patent' }),
        createMockSignal({ type: 'paper' }),
        createMockSignal({ type: 'news' }),
        createMockSignal({ type: 'funding' }),
        createMockSignal({ type: 'github' }),
        createMockSignal({ type: 'trend' }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.signalsByType.patent).toBe(1);
      expect(stats.signalsByType.paper).toBe(1);
      expect(stats.signalsByType.news).toBe(1);
      expect(stats.signalsByType.funding).toBe(1);
      expect(stats.signalsByType.github).toBe(1);
      expect(stats.signalsByType.trend).toBe(1);
    });

    it('getSignalsByStatus() - returns empty array for no matches', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getSignalsByStatus('Validated');

      expect(result).toEqual([]);
    });
  });
});
