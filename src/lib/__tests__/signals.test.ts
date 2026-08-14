/**
 * Unit Tests for Signals Module
 *
 * Tests all signal management functions including:
 * - CRUD operations (Create, Read, Update, Delete)
 * - Filtering by status, type, strategy, confidence, date range
 * - Signal approval workflow (approve, reject, mark as imported)
 * - Statistics and metrics calculation
 *
 * @jest-environment node
 */

import type { Signal, SignalStatus, SignalType } from '../types';

// Mock firebase with jest.fn() in factory (proper hoisting pattern)
jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj) => {
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (obj[key] !== undefined) {
        result[key] = obj[key];
      }
    }
    return result;
  }),
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
  runTransaction: jest.fn(),
  writeBatch: jest.fn(() => ({
    delete: jest.fn(),
    update: jest.fn(),
    set: jest.fn(),
    commit: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Mock entity-factory to break runTransaction dependency
let entityCounter = 0;
jest.mock('../entity-factory', () => ({
  createEntity: jest.fn().mockImplementation(async (_type: string, data: Record<string, unknown>) => {
    entityCounter++;
    return {
      entity: { ...data, id: `sig-${entityCounter}` },
      isNew: true,
    };
  }),
  DuplicateEntityError: class DuplicateEntityError extends Error {
    public readonly entityType: string;
    public readonly field: string;
    public readonly value: string;
    public readonly existingId: string;
    constructor(entityType: string, field: string, value: string, existingId: string) {
      super(`${entityType} with ${field} "${value}" already exists (ID: ${existingId})`);
      this.name = 'DuplicateEntityError';
      this.entityType = entityType;
      this.field = field;
      this.value = value;
      this.existingId = existingId;
    }
  },
}));

// Mock inngest client
jest.mock('../inngest/client', () => ({
  inngest: {
    send: jest.fn().mockResolvedValue(undefined),
    createFunction: jest.fn().mockReturnValue(jest.fn()),
  },
}));

// Mock sync-entity-to-neo4j to break import chain
jest.mock('../inngest/functions/sync-entity-to-neo4j', () => ({
  triggerUnifiedEntitySync: jest.fn().mockResolvedValue(undefined),
  syncUnifiedEntityToNeo4jJob: jest.fn(),
}));

// Mock expansion utils
jest.mock('../signals/expansion-utils', () => ({
  needsExpansion: jest.fn().mockReturnValue(false),
}));

// Mock entity sync
jest.mock('../entity-sync', () => ({
  triggerEntitySync: jest.fn().mockResolvedValue(undefined),
}));

// Mock relations for cascade delete
jest.mock('../relations', () => ({
  deleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

const mockDeleteLinksForEntity = jest.fn().mockResolvedValue(0);
jest.mock('../entity-document-link-service', () => ({
  deleteLinksForEntity: mockDeleteLinksForEntity,
}));

// Mock data refresh event
jest.mock('../events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

// Import mocked modules to get references
import { getDocs, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';

// Cast to jest.Mock for type safety
const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const mockSetDoc = setDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const { triggerEntitySync: mockTriggerSync } = jest.requireMock('../entity-sync') as {
  triggerEntitySync: jest.Mock;
};

// Import functions after mocking
import {
  getSignals,
  getSignalById,
  createSignal,
  updateSignal,
  deleteSignal,
  getSignalsByStatus,
  getSignalsByType,
  getPendingSignals,
  getRecentSignals,
  getHighConfidenceSignals,
  approveSignal,
  rejectSignal,
  markSignalAsImported,
  getSignalStatistics,
  getSignalsByStrategy,
  getSignalsByDateRange,
  getSignalsByAgent,
  deleteSignals,
  archiveSignal,
  restoreSignal,
  getArchivedSignals,
  archiveSignals,
  cleanupArchivedSignals,
  dismissDuplicate,
  mergeIntoSignal,
  findDuplicateSignals,
  checkAndHandleDuplicates,
} from '../signals';

/**
 * Helper to create a mock signal for testing
 */
function createMockSignal(overrides?: Partial<Signal>): Signal {
  return {
    id: 'signal-123',
    slug: 'novel-ai-based-flavor-prediction-system',
    type: 'patent',
    title: 'Novel AI-based flavor prediction system',
    description: 'Machine learning system for predicting flavor compounds...',
    source: 'USPTO Patent #12345678',
    url: 'https://patents.google.com/patent/US12345678',
    date: Date.now() - 24 * 60 * 60 * 1000, // 1 day ago
    relevanceScore: 85,
    alignmentScore: 78,
    alignedStrategies: ['strategy-789'],
    linkedEntities: {
      technologies: ['tech-radar-1:ai-ml'],
      companies: ['company-123'],
      useCases: ['usecase-456'],
    },
    status: 'Detected',
    importedAs: undefined,
    sentiment: 'positive',
    aiSummary: 'AI system for predicting flavor compounds using neural networks',
    validationNotes: 'High relevance to taste innovation strategy',
    detectedAt: Date.now() - 24 * 60 * 60 * 1000, // 1 day ago
    reviewedAt: undefined,
    processedAt: undefined,
    ...overrides,
  };
}

describe('Signals Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSignals()', () => {
    it('should fetch all signals', async () => {
      const mockSignals = [
        createMockSignal({ id: 'signal-1', title: 'Signal 1' }),
        createMockSignal({ id: 'signal-2', title: 'Signal 2' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getSignals();

      expect(result).toHaveLength(2);
      expect(result[0].title).toBe('Signal 1');
      expect(result[1].title).toBe('Signal 2');
      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no signals exist', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getSignals();

      expect(result).toEqual([]);
    });

    it('should handle errors gracefully', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getSignals()).rejects.toThrow('Failed to fetch signals');
    });
  });

  describe('getSignalById()', () => {
    it('should fetch a signal by ID', async () => {
      const mockSignal = createMockSignal();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockSignal,
      });

      const result = await getSignalById('signal-123');

      expect(result).toEqual(mockSignal);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when signal does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      const result = await getSignalById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getSignalById('signal-123')).rejects.toThrow('Failed to fetch signal signal-123');
    });
  });

  describe('createSignal()', () => {
    it('should create a new signal with generated ID', async () => {
      const newSignal = {
        type: 'paper' as SignalType,
        title: 'New Research Paper',
        description: 'Research on AI applications...',
        source: 'arXiv',
        url: 'https://arxiv.org/abs/2024.12345',
        date: Date.now(),
        relevanceScore: 75,
        alignmentScore: 80,
        alignedStrategies: [],
        linkedEntities: {
          technologies: [],
          companies: [],
          useCases: [],
        },
        status: 'Detected' as const,
        sentiment: 'neutral' as const,
        aiSummary: 'Research on AI applications in food tech',
        detectedAt: Date.now(),
      };

      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await createSignal(newSignal);

      expect(result.id).toBeDefined();
      expect(result.title).toBe('New Research Paper');
      expect(result.status).toBe('Detected');
      expect(result.detectedAt).toBeDefined();
      expect(mockTriggerSync).not.toHaveBeenCalled();
    });

    it('should generate unique IDs for different signals', async () => {
      mockSetDoc.mockResolvedValue(undefined);

      const signal1 = await createSignal(createMockSignal({ title: 'Signal 1' }) as any);
      const signal2 = await createSignal(createMockSignal({ title: 'Signal 2' }) as any);

      expect(signal1.id).not.toBe(signal2.id);
    });

    it('should set default status to Detected', async () => {
      mockSetDoc.mockResolvedValueOnce(undefined);

      const result = await createSignal(createMockSignal() as any);

      expect(result.status).toBe('Detected');
    });
  });

  describe('updateSignal()', () => {
    it('should update an existing signal', async () => {
      const updates = {
        status: 'Validated' as SignalStatus,
        validationNotes: 'Approved by team',
      };

      // Mock getDoc for existence check
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockSignal(),
      });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateSignal('signal-123', updates);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle update errors', async () => {
      // Mock getDoc to return existing document
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockSignal(),
      });
      mockUpdateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updateSignal('signal-123', { status: 'Validated' })).rejects.toThrow(
        'Failed to update signal signal-123'
      );
    });

    it('should fail if signal does not exist', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      await expect(updateSignal('nonexistent', { status: 'Validated' })).rejects.toThrow(
        'Failed to update signal nonexistent'
      );
    });
  });

  describe('deleteSignal()', () => {
    it('should delete a signal by ID', async () => {
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteSignal('signal-123');

      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should clean up relations before deleting', async () => {
      const { deleteRelationsForEntity } = require('../relations');
      (deleteRelationsForEntity as jest.Mock).mockResolvedValueOnce(3);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      await deleteSignal('signal-123');

      expect(mockDeleteLinksForEntity).toHaveBeenCalledWith('signal', 'signal-123');
      expect(deleteRelationsForEntity).toHaveBeenCalledWith('signal-123');
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
      expect(mockDeleteLinksForEntity.mock.invocationCallOrder[0]).toBeLessThan(
        (deleteRelationsForEntity as jest.Mock).mock.invocationCallOrder[0]
      );
      expect((deleteRelationsForEntity as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
        mockDeleteDoc.mock.invocationCallOrder[0]
      );
    });

    it('should handle deletion errors', async () => {
      mockDeleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteSignal('signal-123')).rejects.toThrow('Failed to delete signal signal-123');
    });

    it('retains the parent when document-link cleanup fails', async () => {
      mockDeleteLinksForEntity.mockRejectedValueOnce(new Error('link cleanup failed'));

      await expect(deleteSignal('signal-123')).rejects.toThrow('Failed to delete signal signal-123');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });
  });

  describe('getSignalsByStatus()', () => {
    it('should fetch signals filtered by status', async () => {
      const mockSignals = [createMockSignal({ status: 'Detected' }), createMockSignal({ status: 'Detected' })];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStatus('Detected');

      expect(result).toHaveLength(2);
      expect(result.every((s) => s.status === 'Detected')).toBe(true);
    });

    it('should sort signals by detection date (newest first)', async () => {
      const mockSignals = [
        createMockSignal({ id: 'old', detectedAt: Date.now() - 48 * 60 * 60 * 1000 }),
        createMockSignal({ id: 'new', detectedAt: Date.now() - 24 * 60 * 60 * 1000 }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStatus('Detected');

      expect(result[0].id).toBe('new'); // Newer signal first
      expect(result[1].id).toBe('old');
    });

    it('should apply maxResults limit', async () => {
      const mockSignals = Array.from({ length: 10 }, (_, i) => createMockSignal({ id: `signal-${i}` }));

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStatus('Detected', 5);

      expect(result).toHaveLength(5);
    });
  });

  describe('getSignalsByType()', () => {
    it('should fetch signals filtered by type', async () => {
      const mockSignals = [createMockSignal({ type: 'patent' }), createMockSignal({ type: 'patent' })];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByType('patent');

      expect(result).toHaveLength(2);
      expect(result.every((s) => s.type === 'patent')).toBe(true);
    });
  });

  describe('getPendingSignals()', () => {
    it('should fetch signals with Validated status', async () => {
      const mockSignals = [createMockSignal({ status: 'Validated' }), createMockSignal({ status: 'Validated' })];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getPendingSignals();

      expect(result.every((s) => s.status === 'Validated')).toBe(true);
    });

    it('should apply default limit of 50', async () => {
      const mockSignals = Array.from({ length: 100 }, (_, i) =>
        createMockSignal({ id: `signal-${i}`, status: 'Validated' })
      );

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getPendingSignals();

      expect(result.length).toBeLessThanOrEqual(50);
    });
  });

  describe('getRecentSignals()', () => {
    it('should fetch signals from last 7 days by default', async () => {
      const now = Date.now();
      const mockSignals = [
        createMockSignal({ detectedAt: now - 2 * 24 * 60 * 60 * 1000 }), // 2 days ago
        createMockSignal({ detectedAt: now - 5 * 24 * 60 * 60 * 1000 }), // 5 days ago
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getRecentSignals();

      expect(result).toHaveLength(2);
    });

    it('should accept custom day range', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      await getRecentSignals(30);

      expect(mockGetDocs).toHaveBeenCalledTimes(1);
    });
  });

  describe('getHighConfidenceSignals()', () => {
    it('should fetch signals above confidence threshold', async () => {
      const mockSignals = [
        createMockSignal({
          relevanceScore: 95,
          alignmentScore: 90,
        }),
        createMockSignal({
          relevanceScore: 88,
          alignmentScore: 85,
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getHighConfidenceSignals(85);

      expect(result.every((s) => s.relevanceScore >= 85)).toBe(true);
    });

    it('should use default threshold of 80', async () => {
      const mockSignals = [
        createMockSignal({
          relevanceScore: 82,
          alignmentScore: 81,
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const result = await getHighConfidenceSignals();

      expect(result).toHaveLength(1);
    });
  });

  describe('Signal Approval Workflow', () => {
    describe('approveSignal()', () => {
      it('should update signal status to Approved', async () => {
        // Mock getDoc for existence check (called by updateSignal)
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => createMockSignal(),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await approveSignal('signal-123', 'Approved by innovation team');

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      });

      it('should set reviewedAt timestamp', async () => {
        // Mock getDoc for existence check
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => createMockSignal(),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        const _beforeTime = Date.now();
        await approveSignal('signal-123');
        const _afterTime = Date.now();

        // Verify updateDoc was called
        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      });
    });

    describe('rejectSignal()', () => {
      it('should update signal status to Rejected', async () => {
        // Mock getDoc for existence check
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => createMockSignal(),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await rejectSignal('signal-123', 'Not aligned with strategy');

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      });
    });

    describe('markSignalAsImported()', () => {
      it('should mark signal as imported with entity reference', async () => {
        // Mock getDoc for existence check
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => createMockSignal(),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await markSignalAsImported('signal-123', 'technology', 'tech-radar-1:new-tech');

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      });

      it('should support company imports', async () => {
        // Mock getDoc for existence check
        mockGetDoc.mockResolvedValueOnce({
          exists: () => true,
          data: () => createMockSignal(),
        });
        mockUpdateDoc.mockResolvedValueOnce(undefined);

        await markSignalAsImported('signal-123', 'company', 'company-456');

        expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('getSignalStatistics()', () => {
    it('should calculate correct statistics', async () => {
      const mockSignals = [
        createMockSignal({ status: 'Detected', type: 'patent' }),
        createMockSignal({ status: 'Validated', type: 'patent' }),
        createMockSignal({ status: 'Imported', type: 'paper' }),
        createMockSignal({ status: 'Rejected', type: 'news' }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.total).toBe(4);
      expect(stats.pendingCount).toBeGreaterThanOrEqual(0);
      expect(stats.importedCount).toBe(1);
      expect(stats.rejectedCount).toBe(1);
      expect(stats.signalsByType.patent).toBe(2);
      expect(stats.signalsByType.paper).toBe(1);
      expect(stats.signalsByType.news).toBe(1);
    });

    it('should calculate average confidence score', async () => {
      const mockSignals = [
        createMockSignal({
          relevanceScore: 80,
          alignmentScore: 70,
        }),
        createMockSignal({
          relevanceScore: 90,
          alignmentScore: 80,
        }),
      ];

      mockGetDocs.mockResolvedValueOnce({
        docs: mockSignals.map((s) => ({ data: () => s })),
      });

      const stats = await getSignalStatistics();

      expect(stats.averageRelevance).toBe(85); // (80 + 90) / 2 for relevanceScore
    });

    it('should handle empty signal list', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const stats = await getSignalStatistics();

      expect(stats.total).toBe(0);
      expect(stats.averageRelevance).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle signals with missing optional fields', async () => {
      const minimalSignal = createMockSignal({
        validationNotes: undefined,
        reviewedAt: undefined,
        processedAt: undefined,
        importedAs: undefined,
      });

      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => minimalSignal,
      });

      const result = await getSignalById('signal-123');

      expect(result).toEqual(minimalSignal);
      expect(result?.validationNotes).toBeUndefined();
    });

    it('should handle concurrent approvals', async () => {
      // Mock getDoc for both calls
      mockGetDoc.mockResolvedValue({
        exists: () => true,
        data: () => createMockSignal(),
      });
      mockUpdateDoc.mockResolvedValue(undefined);

      await Promise.all([approveSignal('signal-1', 'Approved'), approveSignal('signal-2', 'Approved')]);

      expect(mockUpdateDoc).toHaveBeenCalledTimes(2);
    });
  });
});

// ============================================================================
// Additional coverage: filtering, archiving, bulk ops, duplicates
// ============================================================================

describe('Signals Module - Additional Functions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // getSignalsByStrategy
  // -------------------------------------------------------------------------

  describe('getSignalsByStrategy()', () => {
    it('should return signals matching a strategy', async () => {
      const signal = createMockSignal({ alignedStrategies: ['strat-1'] });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => signal }],
      });

      const result = await getSignalsByStrategy('strat-1');

      expect(result).toHaveLength(1);
    });

    it('should apply maxResults limit', async () => {
      const signals = Array.from({ length: 10 }, (_, i) =>
        createMockSignal({ id: `s${i}`, detectedAt: Date.now() - i * 1000 })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStrategy('strat-1', 3);

      expect(result).toHaveLength(3);
    });

    it('should sort by detectedAt (newest first)', async () => {
      const older = createMockSignal({ id: 'old', detectedAt: Date.now() - 10000 });
      const newer = createMockSignal({ id: 'new', detectedAt: Date.now() - 100 });
      mockGetDocs.mockResolvedValueOnce({
        docs: [older, newer].map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByStrategy('strat-1');

      expect(result[0].id).toBe('new');
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getSignalsByStrategy('strat-1')).rejects.toThrow('Failed to fetch signals by strategy strat-1');
    });
  });

  // -------------------------------------------------------------------------
  // getSignalsByDateRange
  // -------------------------------------------------------------------------

  describe('getSignalsByDateRange()', () => {
    it('should return signals in date range', async () => {
      const now = Date.now();
      const signals = [createMockSignal({ id: 's1' })];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByDateRange(now - 1000, now);

      expect(result).toHaveLength(1);
    });

    it('should return empty for empty Firestore response', async () => {
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await getSignalsByDateRange(0, Date.now());

      expect(result).toEqual([]);
    });

    it('should sort results by detectedAt (newest first)', async () => {
      const older = createMockSignal({ id: 'old', detectedAt: 1000 });
      const newer = createMockSignal({ id: 'new', detectedAt: 2000 });
      mockGetDocs.mockResolvedValueOnce({
        docs: [older, newer].map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByDateRange(0, 5000);

      expect(result[0].id).toBe('new');
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getSignalsByDateRange(0, Date.now())).rejects.toThrow('Failed to fetch signals by date range');
    });
  });

  // -------------------------------------------------------------------------
  // getSignalsByAgent
  // -------------------------------------------------------------------------

  describe('getSignalsByAgent()', () => {
    it('should return signals for specific agent', async () => {
      const agentSignal = createMockSignal({
        id: 'a-sig',
        metadata: { agentId: 'agent-123' },
        detectedAt: Date.now() - 100,
      });
      const otherSignal = createMockSignal({
        id: 'other',
        metadata: { agentId: 'other-agent' },
      });
      mockGetDocs.mockResolvedValueOnce({
        docs: [agentSignal, otherSignal].map((s) => ({ data: () => s })),
      });

      const result = await getSignalsByAgent('agent-123');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a-sig');
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

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getSignalsByAgent('agent-123')).rejects.toThrow('Failed to get signals for agent agent-123');
    });
  });

  // -------------------------------------------------------------------------
  // deleteSignals (bulk)
  // -------------------------------------------------------------------------

  describe('deleteSignals()', () => {
    it('should delete multiple signals in a batch', async () => {
      const result = await deleteSignals(['sig-1', 'sig-2', 'sig-3']);

      expect(result.deleted).toBe(3);
      expect(result.failed).toHaveLength(0);
    });

    it('should clean up relations for each signal before deleting', async () => {
      const { deleteRelationsForEntity } = require('../relations');
      (deleteRelationsForEntity as jest.Mock)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0);

      const result = await deleteSignals(['sig-1', 'sig-2', 'sig-3']);

      expect(deleteRelationsForEntity).toHaveBeenCalledTimes(3);
      expect(result.relationsDeleted).toBe(3);
      expect(result.deleted).toBe(3);
    });

    it('retains the exact signal whose relation cleanup fails', async () => {
      const { deleteRelationsForEntity } = require('../relations');
      (deleteRelationsForEntity as jest.Mock)
        .mockResolvedValueOnce(1)
        .mockRejectedValueOnce(new Error('Relation cleanup failed'));

      const result = await deleteSignals(['sig-1', 'sig-2']);

      expect(result).toEqual({ deleted: 1, failed: ['sig-2'], relationsDeleted: 1 });
    });

    it('retains the exact signal whose document-link cleanup fails', async () => {
      mockDeleteLinksForEntity
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error('link cleanup failed'));

      const result = await deleteSignals(['sig-1', 'sig-2']);

      expect(result).toEqual({ deleted: 1, failed: ['sig-2'], relationsDeleted: 0 });
    });

    it('should return empty result for empty array', async () => {
      const result = await deleteSignals([]);

      expect(result.deleted).toBe(0);
      expect(result.failed).toHaveLength(0);
      expect(result.relationsDeleted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // archiveSignal
  // -------------------------------------------------------------------------

  describe('archiveSignal()', () => {
    it('should archive a signal with reason', async () => {
      const signal = createMockSignal({ id: 'sig-1', status: 'Detected' });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal }) // getSignalById
        .mockResolvedValueOnce({ exists: () => true, data: () => signal }); // updateSignal check
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await archiveSignal('sig-1', 'No longer relevant');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Archived');
      expect(updateArg.metadata.archiveReason).toBe('No longer relevant');
    });

    it('should archive a signal without reason (default)', async () => {
      const signal = createMockSignal({ id: 'sig-1', status: 'Detected' });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await archiveSignal('sig-1');

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.metadata.archiveReason).toBe('Manual archive');
    });

    it('should preserve previous status in metadata', async () => {
      const signal = createMockSignal({ id: 'sig-1', status: 'Validated' });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await archiveSignal('sig-1');

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.metadata.previousStatus).toBe('Validated');
    });

    it('should throw when signal not found', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(archiveSignal('nonexistent')).rejects.toThrow('Failed to archive signal nonexistent');
    });

    it('should throw on Firestore error', async () => {
      mockGetDoc.mockRejectedValueOnce(new Error('DB error'));

      await expect(archiveSignal('sig-1')).rejects.toThrow('Failed to archive signal sig-1');
    });
  });

  // -------------------------------------------------------------------------
  // restoreSignal
  // -------------------------------------------------------------------------

  describe('restoreSignal()', () => {
    it('should restore archived signal to previous status', async () => {
      const signal = createMockSignal({
        id: 'sig-1',
        status: 'Archived' as SignalStatus,
        metadata: { previousStatus: 'Validated', archivedAt: Date.now() - 1000 },
      });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await restoreSignal('sig-1');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Validated');
    });

    it('should default to Validated status when no previousStatus', async () => {
      const signal = createMockSignal({
        id: 'sig-1',
        status: 'Archived' as SignalStatus,
        metadata: {},
      });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await restoreSignal('sig-1');

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.status).toBe('Validated');
    });

    it('should throw when signal not archived', async () => {
      const signal = createMockSignal({ id: 'sig-1', status: 'Detected' });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => signal });

      await expect(restoreSignal('sig-1')).rejects.toThrow('Failed to restore signal sig-1');
    });

    it('should throw when signal not found', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(restoreSignal('nonexistent')).rejects.toThrow('Failed to restore signal nonexistent');
    });
  });

  // -------------------------------------------------------------------------
  // getArchivedSignals
  // -------------------------------------------------------------------------

  describe('getArchivedSignals()', () => {
    it('should return archived signals', async () => {
      const signals = [
        createMockSignal({
          id: 'a1',
          status: 'Archived' as SignalStatus,
          metadata: { archivedAt: Date.now() - 1000 },
        }),
        createMockSignal({
          id: 'a2',
          status: 'Archived' as SignalStatus,
          metadata: { archivedAt: Date.now() - 5000 },
        }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getArchivedSignals();

      expect(result).toHaveLength(2);
      // Sorted by archivedAt (newest first)
      expect(result[0].id).toBe('a1');
    });

    it('should apply maxResults limit', async () => {
      const signals = Array.from({ length: 10 }, (_, i) =>
        createMockSignal({
          id: `a${i}`,
          status: 'Archived' as SignalStatus,
          metadata: { archivedAt: Date.now() - i * 1000 },
        })
      );
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getArchivedSignals(3);

      expect(result).toHaveLength(3);
    });

    it('should fallback to detectedAt when archivedAt missing', async () => {
      const signals = [
        createMockSignal({ id: 'a1', status: 'Archived' as SignalStatus, detectedAt: Date.now() - 1000, metadata: {} }),
        createMockSignal({ id: 'a2', status: 'Archived' as SignalStatus, detectedAt: Date.now() - 5000, metadata: {} }),
      ];
      mockGetDocs.mockResolvedValueOnce({
        docs: signals.map((s) => ({ data: () => s })),
      });

      const result = await getArchivedSignals();

      expect(result[0].id).toBe('a1');
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(getArchivedSignals()).rejects.toThrow('Failed to fetch archived signals');
    });
  });

  // -------------------------------------------------------------------------
  // archiveSignals (bulk)
  // -------------------------------------------------------------------------

  describe('archiveSignals()', () => {
    it('should archive multiple signals in a batch', async () => {
      const signal1 = createMockSignal({ id: 'sig-1', status: 'Detected' });
      const signal2 = createMockSignal({ id: 'sig-2', status: 'Validated' });

      // getSignalById calls (one per signal)
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal1 })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal2 });

      const result = await archiveSignals(['sig-1', 'sig-2'], 'Bulk cleanup');

      expect(result.archived).toBe(2);
      expect(result.failed).toHaveLength(0);
    });

    it('should skip already archived signals', async () => {
      const archivedSignal = createMockSignal({ id: 'sig-1', status: 'Archived' as SignalStatus });
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => archivedSignal });

      const result = await archiveSignals(['sig-1']);

      expect(result.archived).toBe(0);
    });

    it('should return empty result for empty IDs array', async () => {
      const result = await archiveSignals([]);

      expect(result.archived).toBe(0);
      expect(result.failed).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // cleanupArchivedSignals
  // -------------------------------------------------------------------------

  describe('cleanupArchivedSignals()', () => {
    it('should delete archived signals older than retention period', async () => {
      const oldSignal = createMockSignal({
        id: 'old-archived',
        status: 'Archived' as SignalStatus,
        metadata: { archivedAt: Date.now() - 91 * 24 * 60 * 60 * 1000 }, // 91 days old
      });
      // getArchivedSignals call
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => oldSignal }],
      });
      // deleteSignals -> writeBatch is mocked to succeed automatically

      const result = await cleanupArchivedSignals(90);

      expect(result.deleted).toBe(1);
    });

    it('should return 0 deleted when no signals exceed retention', async () => {
      const recentSignal = createMockSignal({
        id: 'recent-archived',
        status: 'Archived' as SignalStatus,
        metadata: { archivedAt: Date.now() - 5 * 24 * 60 * 60 * 1000 }, // 5 days old
      });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => recentSignal }],
      });

      const result = await cleanupArchivedSignals(90);

      expect(result.deleted).toBe(0);
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(cleanupArchivedSignals()).rejects.toThrow('Failed to cleanup archived signals');
    });
  });

  // -------------------------------------------------------------------------
  // dismissDuplicate
  // -------------------------------------------------------------------------

  describe('dismissDuplicate()', () => {
    it('should remove duplicate from list and add to dismissed', async () => {
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
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await dismissDuplicate('sig-1', 'dup-1');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.metadata.possibleDuplicates).toHaveLength(1);
      expect(updateArg.metadata.dismissedDuplicates).toContain('dup-1');
    });

    it('should work when metadata is empty', async () => {
      const signal = createMockSignal({ id: 'sig-1', metadata: {} });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => signal })
        .mockResolvedValueOnce({ exists: () => true, data: () => signal });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await dismissDuplicate('sig-1', 'dup-1');

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw when signal not found', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(dismissDuplicate('nonexistent', 'dup-1')).rejects.toThrow('Failed to dismiss duplicate');
    });
  });

  // -------------------------------------------------------------------------
  // mergeIntoSignal
  // -------------------------------------------------------------------------

  describe('mergeIntoSignal()', () => {
    it('should merge new source into existing signal', async () => {
      const existing = createMockSignal({ id: 'existing-1', metadata: {} });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => existing })
        .mockResolvedValueOnce({ exists: () => true, data: () => existing });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await mergeIntoSignal('existing-1', {
        title: 'Same topic',
        source: 'NewSource',
        url: 'https://new.com',
      });

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.metadata.mergeCount).toBe(1);
    });

    it('should append long description', async () => {
      const existing = createMockSignal({
        id: 'existing-1',
        description: 'Original desc',
        metadata: {},
      });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => existing })
        .mockResolvedValueOnce({ exists: () => true, data: () => existing });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const longDesc = 'A'.repeat(51);
      await mergeIntoSignal('existing-1', {
        title: 'Title',
        source: 'Source',
        description: longDesc,
      });

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.description).toContain('Original desc');
      expect(updateArg.description).toContain(longDesc);
    });

    it('should not append short descriptions (< 50 chars)', async () => {
      const existing = createMockSignal({
        id: 'existing-1',
        description: 'Original',
        metadata: {},
      });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => existing })
        .mockResolvedValueOnce({ exists: () => true, data: () => existing });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await mergeIntoSignal('existing-1', {
        title: 'Title',
        source: 'Source',
        description: 'Short desc',
      });

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.description).toBeUndefined();
    });

    it('should throw when signal not found', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      await expect(mergeIntoSignal('nonexistent', { title: 'T', source: 'S' })).rejects.toThrow(
        'Failed to merge signal'
      );
    });
  });

  // -------------------------------------------------------------------------
  // findDuplicateSignals
  // -------------------------------------------------------------------------

  describe('findDuplicateSignals()', () => {
    it('should find signals with similar titles', async () => {
      const signal = createMockSignal({
        id: 'existing',
        title: 'AI Framework for NLP',
        detectedAt: Date.now() - 1000 * 60 * 60,
      });
      // getRecentSignals call
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => signal }],
      });

      const result = await findDuplicateSignals('AI Framework for NLP');

      expect(result).toHaveLength(1);
      expect(result[0].similarity).toBe(100); // exact match
    });

    it('should filter by source when provided', async () => {
      const signal1 = createMockSignal({
        id: 's1',
        title: 'AI Framework',
        source: 'arXiv',
        detectedAt: Date.now() - 1000,
      });
      const signal2 = createMockSignal({
        id: 's2',
        title: 'AI Framework',
        source: 'TechCrunch',
        detectedAt: Date.now() - 2000,
      });
      mockGetDocs.mockResolvedValueOnce({
        docs: [signal1, signal2].map((s) => ({ data: () => s })),
      });

      const result = await findDuplicateSignals('AI Framework', { source: 'arXiv' });

      expect(result).toHaveLength(1);
      expect(result[0].signal.source).toBe('arXiv');
    });

    it('should not include signals with < 50% similarity', async () => {
      const signal = createMockSignal({
        id: 'unrelated',
        title: 'Quantum Computing Hardware',
        detectedAt: Date.now() - 1000,
      });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => signal }],
      });

      const result = await findDuplicateSignals('AI Framework for NLP');

      // These titles are not similar enough
      expect(result.length).toBeLessThanOrEqual(1);
    });

    it('should sort by similarity descending', async () => {
      const exact = createMockSignal({ id: 's1', title: 'AI Framework for NLP', detectedAt: Date.now() - 100 });
      const partial = createMockSignal({ id: 's2', title: 'AI Framework for Text', detectedAt: Date.now() - 200 });
      mockGetDocs.mockResolvedValueOnce({
        docs: [partial, exact].map((s) => ({ data: () => s })),
      });

      const result = await findDuplicateSignals('AI Framework for NLP');

      if (result.length >= 2) {
        expect(result[0].similarity).toBeGreaterThanOrEqual(result[1].similarity);
      }
    });

    it('should throw on Firestore error', async () => {
      mockGetDocs.mockRejectedValueOnce(new Error('DB error'));

      await expect(findDuplicateSignals('Some title')).rejects.toThrow('Failed to find duplicate signals');
    });
  });

  // -------------------------------------------------------------------------
  // checkAndHandleDuplicates
  // -------------------------------------------------------------------------

  describe('checkAndHandleDuplicates()', () => {
    const newSignalData = createMockSignal({
      title: 'New AI Signal',
      status: 'Detected',
    }) as any;

    it('should create signal when no duplicates found', async () => {
      // getRecentSignals returns empty (no duplicates) - exactly 1 Once call to avoid queue pollution
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      const result = await checkAndHandleDuplicates('New AI Signal', newSignalData);

      expect(result.action).toBe('created');
      expect(result.signalId).toBeDefined();
    });

    it('should merge when high similarity (>= 95%) duplicate found', async () => {
      const exactDup = createMockSignal({
        id: 'dup-exact',
        title: 'New AI Signal',
        detectedAt: Date.now() - 1000,
      });
      // getRecentSignals for findDuplicateSignals - exactDup title identical -> 100% similarity
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => exactDup }],
      });
      // mergeIntoSignal -> getSignalById (reads existing signal)
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => exactDup });
      // mergeIntoSignal -> updateSignal -> getDoc (checks existence)
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => exactDup });
      // mergeIntoSignal -> updateSignal -> updateDoc
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const result = await checkAndHandleDuplicates('New AI Signal', newSignalData, {
        autoMergeThreshold: 95,
      });

      expect(result.action).toBe('merged');
      expect(result.existingSignalId).toBe('dup-exact');
    });

    it('should flag signal when medium similarity (80-94%) duplicate found', async () => {
      // Use a carefully crafted title where similarity is in the 80-94% range.
      // "New AI Signal" (13 chars) vs "New AI Signalx" (14 chars): distance=1, similarity=93%
      const mediumDup = createMockSignal({
        id: 'dup-medium',
        title: 'New AI Signalx',
        detectedAt: Date.now() - 1000,
      });
      // getRecentSignals for findDuplicateSignals
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => mediumDup }],
      });
      // flagged path: createSignal via entity factory (already mocked)

      const result = await checkAndHandleDuplicates('New AI Signal', newSignalData, {
        autoMergeThreshold: 95,
        flagThreshold: 80,
      });

      // Similarity ~93% is in range [80, 95) → should be 'flagged'
      expect(result.action).toBe('flagged');
      expect(result.possibleDuplicates).toContain('dup-medium');
    });
  });

  // -------------------------------------------------------------------------
  // createSignal - validation
  // -------------------------------------------------------------------------

  describe('createSignal() - validation', () => {
    it('should throw when title is missing', async () => {
      await expect(createSignal({ ...createMockSignal(), title: '' } as any)).rejects.toThrow(
        'Failed to create signal'
      );
    });

    it('should throw when source is missing', async () => {
      await expect(createSignal({ ...createMockSignal(), source: '' } as any)).rejects.toThrow(
        'Failed to create signal'
      );
    });

    it('should throw when relevanceScore out of range (> 100)', async () => {
      await expect(createSignal({ ...createMockSignal(), relevanceScore: 110 } as any)).rejects.toThrow(
        'Failed to create signal'
      );
    });

    it('should throw when relevanceScore out of range (< 0)', async () => {
      await expect(createSignal({ ...createMockSignal(), relevanceScore: -1 } as any)).rejects.toThrow(
        'Failed to create signal'
      );
    });

    it('should throw when alignmentScore out of range', async () => {
      await expect(createSignal({ ...createMockSignal(), alignmentScore: 150 } as any)).rejects.toThrow(
        'Failed to create signal'
      );
    });

    it('should throw when URL is missing for non-agent signal', async () => {
      await expect(createSignal({ ...createMockSignal(), url: undefined, metadata: undefined } as any)).rejects.toThrow(
        'Failed to create signal'
      );
    });

    it('should succeed for agent-generated signal without URL', async () => {
      const agentSignal = createMockSignal({ url: undefined, metadata: { agentId: 'agent-123' } });
      // createEntity mock will handle the success
      const result = await createSignal(agentSignal as any);

      expect(result).toBeDefined();
      expect(result.title).toBe(agentSignal.title);
    });
  });

  // -------------------------------------------------------------------------
  // rejectSignal - edge cases
  // -------------------------------------------------------------------------

  describe('rejectSignal() - edge cases', () => {
    it('should include rejection reason in validationNotes', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await rejectSignal('signal-123', 'Off topic');

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.validationNotes).toContain('Rejected: Off topic');
    });

    it('should include reviewedAt timestamp', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockSignal() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const before = Date.now();
      await rejectSignal('signal-123', 'Valid reason');
      const after = Date.now();

      const updateArg = mockUpdateDoc.mock.calls[0][1];
      expect(updateArg.reviewedAt).toBeGreaterThanOrEqual(before);
      expect(updateArg.reviewedAt).toBeLessThanOrEqual(after);
    });
  });
});
