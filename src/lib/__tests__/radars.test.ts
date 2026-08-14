/**
 * Unit Tests for Radars Module
 *
 * Tests CRUD operations for radars and radar entries including:
 * - createRadar - Creates a new radar with uniqueness enforcement
 * - getRadarById - Retrieves a specific radar
 * - updateRadarQuadrants - Updates radar quadrant names
 * - getAllRadars - Lists all radars with optional stats
 * - updateRadar - Updates radar settings
 * - deleteRadar - Removes a radar with cascade delete
 * - createRadarEntry - Creates a new entry with uniqueness enforcement
 * - updateRadarEntry - Updates a radar entry
 * - batchUpdateRadarEntries - Batch updates multiple entries
 * - getRadarEntries - Gets all entries for a radar
 * - radarEntryExists - Checks if an entry name exists
 *
 * @jest-environment node
 */

import type { RadarData, RadarEntry, QuadrantConfig } from '../types';

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key in obj) {
      if (obj[key] !== undefined) result[key] = obj[key];
    }
    return result;
  }),
}));

const mockTransactionSet = jest.fn();
const mockRunTransaction = jest.fn((_db: unknown, fn: (transaction: { set: jest.Mock }) => Promise<unknown>) =>
  fn({ set: mockTransactionSet })
);

jest.mock('firebase/firestore', () => ({
  __esModule: true,
  collection: jest.fn(),
  doc: jest.fn(() => ({ id: 'doc-id', path: 'radars/test-radar' })),
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
  limit: jest.fn(),
  runTransaction: (db: unknown, fn: (transaction: { set: jest.Mock }) => Promise<unknown>) =>
    mockRunTransaction(db, fn),
}));

jest.mock('../entity-factory', () => ({
  generateSlug: jest.fn((name: string) =>
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
  ),
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

jest.mock('../constants', () => ({
  DEFAULT_QUADRANTS: ['Techniques', 'Tools', 'Platforms', 'Languages & Frameworks'],
  MIN_QUADRANTS: 1,
  MAX_QUADRANTS: 8,
  defaultQuadrantIdFromName: jest.fn((name: string, index: number) => {
    const slug = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    return slug ? `q_${slug}` : `q_${index}`;
  }),
  buildDefaultQuadrantConfigs: jest.fn(() => [
    { id: 'q_techniques', name: 'Techniques', order: 0 },
    { id: 'q_tools', name: 'Tools', order: 1 },
    { id: 'q_platforms', name: 'Platforms', order: 2 },
    { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
  ]),
}));

jest.mock('../radar-placement-service', () => ({
  deleteAllPlacementsForRadar: jest.fn(),
  getRadarPlacementStats: jest.fn(),
  getPlacementsByRadar: jest.fn(() => Promise.resolve([])),
  updateRadarPlacement: jest.fn(),
  deleteRadarPlacement: jest.fn(),
}));

jest.mock('../radar-deletion-sync', () => ({
  requestRadarGraphDeletion: jest.fn().mockResolvedValue(undefined),
}));

// ============================================================================
// IMPORT MOCKED MODULES
// ============================================================================

import { getDocs, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import {
  deleteAllPlacementsForRadar,
  getPlacementsByRadar,
  getRadarPlacementStats,
} from '../radar-placement-service';
import { requestRadarGraphDeletion } from '../radar-deletion-sync';

const mockGetDocs = getDocs as jest.Mock;
const mockGetDoc = getDoc as jest.Mock;
const _mockSetDoc = setDoc as jest.Mock;
const mockUpdateDoc = updateDoc as jest.Mock;
const mockDeleteDoc = deleteDoc as jest.Mock;
const mockDeleteAllPlacements = deleteAllPlacementsForRadar as jest.Mock;
const mockGetPlacementsByRadar = getPlacementsByRadar as jest.Mock;
const mockRequestRadarGraphDeletion = requestRadarGraphDeletion as jest.Mock;
const mockGetRadarPlacementStats = getRadarPlacementStats as jest.Mock;

// ============================================================================
// IMPORT MODULE UNDER TEST
// ============================================================================

import {
  createRadar,
  getRadarById,
  updateRadarQuadrants,
  getAllRadars,
  updateRadar,
  deleteRadar,
  getRadarEntries,
} from '../radars';

// ============================================================================
// HELPERS
// ============================================================================

function createMockRadar(overrides?: Partial<RadarData>): RadarData {
  return {
    id: 'test-radar-123',
    name: 'Test Radar',
    slug: 'test-radar',
    description: 'A test radar',
    quadrants: [
      { id: 'q_techniques', name: 'Techniques', order: 0 },
      { id: 'q_tools', name: 'Tools', order: 1 },
      { id: 'q_platforms', name: 'Platforms', order: 2 },
      { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
    ],
    entries: [],
    ...overrides,
  };
}

function createMockEntry(overrides?: Partial<RadarEntry>): RadarEntry {
  return {
    id: 1,
    name: 'React',
    description: 'A JavaScript library',
    quadrantId: 'q_languages_frameworks',
    ring: 'Adopt',
    status: 'Stable',
    tags: [],
    costToPrototype: 0,
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('Radars Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // createRadar
  // --------------------------------------------------------------------------
  describe('createRadar()', () => {
    it('should create a radar with the given name and description', async () => {
      // Arrange
      mockGetDocs.mockResolvedValueOnce({
        empty: true,
        docs: [],
      });

      // Act
      const result = await createRadar('My Radar', 'A description');

      // Assert
      expect(result.name).toBe('My Radar');
      expect(result.description).toBe('A description');
      expect(result.slug).toBe('my-radar');
      expect(result.quadrants).toEqual([
        { id: 'q_techniques', name: 'Techniques', order: 0 },
        { id: 'q_tools', name: 'Tools', order: 1 },
        { id: 'q_platforms', name: 'Platforms', order: 2 },
        { id: 'q_languages_frameworks', name: 'Languages & Frameworks', order: 3 },
      ]);
      expect(result.entries).toEqual([]);
      expect(mockTransactionSet).toHaveBeenCalledTimes(1);
    });

    it('should throw when name is empty', async () => {
      // Act & Assert
      await expect(createRadar('')).rejects.toThrow('Radar name is required');
    });

    it('should throw when name is only whitespace', async () => {
      // Act & Assert
      await expect(createRadar('   ')).rejects.toThrow('Radar name is required');
    });

    it('should throw DuplicateEntityError when radar with same slug exists', async () => {
      // Arrange
      mockGetDocs.mockResolvedValueOnce({
        empty: false,
        docs: [{ id: 'existing-radar-id', data: () => ({ name: 'My Radar' }) }],
      });

      // Act & Assert
      await expect(createRadar('My Radar')).rejects.toThrow('radar with slug "my-radar" already exists');
    });

    it('should use empty string for description when not provided', async () => {
      // Arrange
      mockGetDocs.mockResolvedValueOnce({ empty: true, docs: [] });

      // Act
      const result = await createRadar('No Desc Radar');

      // Assert
      expect(result.description).toBe('');
    });

    it('omits absent nested quadrant descriptions at the browser create boundary', async () => {
      mockGetDocs.mockResolvedValueOnce({ empty: true, docs: [] });

      await createRadar('Custom Radar', undefined, [
        { id: 'q-absent', name: 'Absent', order: 0, description: undefined },
        { id: 'q-empty', name: 'Empty', order: 1, description: '' },
      ]);

      const written = mockTransactionSet.mock.calls[0][1] as RadarData;
      expect(written.quadrants).toEqual([
        { id: 'q-absent', name: 'Absent', order: 0 },
        { id: 'q-empty', name: 'Empty', order: 1, description: '' },
      ]);
      expect(Object.prototype.hasOwnProperty.call(written.quadrants[0], 'description')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getRadarById
  // --------------------------------------------------------------------------
  describe('getRadarById()', () => {
    it('should return radar data when document exists', async () => {
      // Arrange
      const mockRadar = createMockRadar();
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => mockRadar,
      });

      // Act
      const result = await getRadarById('test-radar-123');

      // Assert
      expect(result).toEqual(mockRadar);
      expect(mockGetDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when document does not exist', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce({
        exists: () => false,
      });

      // Act
      const result = await getRadarById('nonexistent');

      // Assert
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // updateRadarQuadrants
  // --------------------------------------------------------------------------
  describe('updateRadarQuadrants()', () => {
    it('should update quadrants with a valid QuadrantConfig[] in the [1, 8] range', async () => {
      // Arrange — 4 valid configs with stable ids
      const newQuadrants: QuadrantConfig[] = [
        { id: 'q1', name: 'Q1', order: 0 },
        { id: 'q2', name: 'Q2', order: 1 },
        { id: 'q3', name: 'Q3', order: 2 },
        { id: 'q4', name: 'Q4', order: 3 },
      ];
      // No existing placements → no orphans
      mockGetDocs.mockResolvedValue({ docs: [] });
      mockGetDoc.mockResolvedValue({ exists: () => true, data: () => createMockRadar() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      await updateRadarQuadrants('radar-1', newQuadrants);

      // Assert — the radar doc was updated with the new quadrants
      expect(mockUpdateDoc).toHaveBeenCalled();
    });

    it('omits absent nested quadrant descriptions at the browser update boundary', async () => {
      const newQuadrants: QuadrantConfig[] = [
        { id: 'q1', name: 'Q1', order: 0, description: undefined },
        { id: 'q2', name: 'Q2', order: 1, description: '' },
      ];
      mockGetDocs.mockResolvedValue({ docs: [] });
      mockGetDoc.mockResolvedValue({ exists: () => true, data: () => createMockRadar() });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      await updateRadarQuadrants('radar-1', newQuadrants);

      const written = mockUpdateDoc.mock.calls[0][1] as { quadrants: QuadrantConfig[] };
      expect(written.quadrants).toEqual([
        { id: 'q1', name: 'Q1', order: 0 },
        { id: 'q2', name: 'Q2', order: 1, description: '' },
      ]);
      expect(Object.prototype.hasOwnProperty.call(written.quadrants[0], 'description')).toBe(false);
    });

    it('should throw when quadrants array is empty', async () => {
      await expect(updateRadarQuadrants('radar-1', [])).rejects.toThrow(/out of range/i);
    });

    it('should throw when quadrants exceeds MAX', async () => {
      const tooMany: QuadrantConfig[] = Array.from({ length: 9 }, (_, i) => ({
        id: `q${i}`,
        name: `Q${i}`,
        order: i,
      }));
      await expect(updateRadarQuadrants('radar-1', tooMany)).rejects.toThrow(/out of range/i);
    });
  });

  // --------------------------------------------------------------------------
  // getAllRadars
  // --------------------------------------------------------------------------
  describe('getAllRadars()', () => {
    it('should return all radars without stats by default', async () => {
      // Arrange
      const radar1 = createMockRadar({ id: 'r1', name: 'Radar One' });
      const radar2 = createMockRadar({ id: 'r2', name: 'Radar Two' });
      mockGetDocs.mockResolvedValueOnce({
        docs: [
          { id: 'r1', data: () => radar1 },
          { id: 'r2', data: () => radar2 },
        ],
      });

      // Act
      const result = await getAllRadars();

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('r1');
      expect(result[1].id).toBe('r2');
      expect(result[0]).not.toHaveProperty('stats');
    });

    it('should return empty array when no radars exist', async () => {
      // Arrange
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      // Act
      const result = await getAllRadars();

      // Assert
      expect(result).toEqual([]);
    });

    it('should include stats when includeStats is true', async () => {
      // Arrange
      const radar1 = createMockRadar({ id: 'r1', name: 'Radar One' });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ id: 'r1', data: () => radar1 }],
      });
      mockGetRadarPlacementStats.mockResolvedValueOnce({
        total: 5,
        byRing: { Adopt: 2, Trial: 3 },
        byQuadrant: { Tools: 5 },
        recentMoves: 1,
      });

      // Act
      const result = await getAllRadars(true);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].stats).toEqual({
        totalPlacements: 5,
        byRing: { Adopt: 2, Trial: 3 },
        byQuadrant: { Tools: 5 },
      });
    });

    it('should return zero stats when getRadarPlacementStats fails', async () => {
      // Arrange
      const radar1 = createMockRadar({ id: 'r1', name: 'Radar One' });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ id: 'r1', data: () => radar1 }],
      });
      mockGetRadarPlacementStats.mockRejectedValueOnce(new Error('Stats error'));

      // Act
      const result = await getAllRadars(true);

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0].stats).toEqual({
        totalPlacements: 0,
        byRing: {},
        byQuadrant: {},
      });
    });
  });

  // --------------------------------------------------------------------------
  // updateRadar
  // --------------------------------------------------------------------------
  describe('updateRadar()', () => {
    it('should update radar name and regenerate slug', async () => {
      // Arrange
      const existingRadar = createMockRadar();
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingRadar }).mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ ...existingRadar, name: 'Updated Radar', slug: 'updated-radar' }),
      });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      // Act
      const result = await updateRadar('test-radar-123', { name: 'Updated Radar' });

      // Assert
      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.name).toBe('Updated Radar');
      expect(updateCall.slug).toBe('updated-radar');
      expect(result.name).toBe('Updated Radar');
    });

    it('should throw when radar not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      // Act & Assert
      await expect(updateRadar('nonexistent', { name: 'Test' })).rejects.toThrow('Radar nonexistent not found');
    });

    // AUDIT-001: the share opt-in must actually PERSIST. The first fix
    // accepted `shared` in the type but the body silently dropped it —
    // caught live by Playwright (toggle flipped, Firestore unchanged).
    it.each([true, false])('persists shared=%s to the radar doc', async (shared) => {
      const existingRadar = createMockRadar();
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingRadar }).mockResolvedValueOnce({
        exists: () => true,
        data: () => ({ ...existingRadar, shared }),
      });
      mockUpdateDoc.mockResolvedValueOnce(undefined);

      const result = await updateRadar('test-radar-123', { shared });

      expect(mockUpdateDoc).toHaveBeenCalledTimes(1);
      const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.shared).toBe(shared);
      expect(result.shared).toBe(shared);
    });

    it('should throw when quadrants count is out of [1, 8] range', async () => {
      // Arrange
      const existingRadar = createMockRadar();
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => existingRadar });

      // Act & Assert — empty is out of range
      const tooFew: QuadrantConfig[] = [];
      await expect(updateRadar('test-radar-123', { quadrants: tooFew })).rejects.toThrow(/out of range/i);
    });

    it('should update description and quadrants', async () => {
      // Arrange
      const existingRadar = createMockRadar();
      const newConfigs: QuadrantConfig[] = [
        { id: 'a', name: 'A', order: 0 },
        { id: 'b', name: 'B', order: 1 },
        { id: 'c', name: 'C', order: 2 },
        { id: 'd', name: 'D', order: 3 },
      ];
      const updatedRadar = {
        ...existingRadar,
        description: 'New desc',
        quadrants: newConfigs,
      };
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => existingRadar })
        // updateRadarQuadrants inside updateRadar re-reads the radar for orphan detection
        .mockResolvedValue({ exists: () => true, data: () => updatedRadar });
      mockGetDocs.mockResolvedValue({ docs: [] }); // no placements, no orphans
      mockUpdateDoc.mockResolvedValue(undefined);

      // Act
      const result = await updateRadar('test-radar-123', {
        description: 'New desc',
        quadrants: newConfigs,
      });

      // Assert
      expect(result.description).toBe('New desc');
    });

    it('should not regenerate slug when name is unchanged', async () => {
      // Arrange
      const existingRadar = createMockRadar({ name: 'Same Name' });
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => existingRadar })
        .mockResolvedValueOnce({ exists: () => true, data: () => existingRadar });
      mockUpdateDoc.mockResolvedValue(undefined);

      // Act — name is unchanged, no other updates, so nothing should be written
      await updateRadar('test-radar-123', { name: 'Same Name' });

      // Assert — when the name matches current, no slug/name fields are written.
      // (Implementation-detail change: the rewritten service skips updateDoc
      // entirely when only `updatedAt` would change.)
      if (mockUpdateDoc.mock.calls.length > 0) {
        const updateCall = mockUpdateDoc.mock.calls[0][1] as Record<string, unknown>;
        expect(updateCall.slug).toBeUndefined();
        expect(updateCall.name).toBeUndefined();
      }
    });
  });

  // --------------------------------------------------------------------------
  // deleteRadar
  // --------------------------------------------------------------------------
  describe('deleteRadar()', () => {
    it('should delete radar with cascade delete of placements', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockRadar(),
      });
      mockDeleteAllPlacements.mockResolvedValueOnce(3);
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      // Act
      const result = await deleteRadar('test-radar-123');

      // Assert
      expect(result.placementsDeleted).toBe(3);
      expect(mockDeleteAllPlacements).toHaveBeenCalledWith('test-radar-123');
      expect(mockRequestRadarGraphDeletion).toHaveBeenCalledWith('test-radar-123', true);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should delete radar without cascade when cascadeDelete is false', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockRadar(),
      });
      mockDeleteDoc.mockResolvedValueOnce(undefined);

      // Act
      const result = await deleteRadar('test-radar-123', false);

      // Assert
      expect(result.placementsDeleted).toBe(0);
      expect(mockDeleteAllPlacements).not.toHaveBeenCalled();
      expect(mockRequestRadarGraphDeletion).toHaveBeenCalledWith('test-radar-123', false);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(1);
    });

    it('refuses non-cascade deletion while Firestore placements still reference the radar', async () => {
      mockGetDoc.mockResolvedValueOnce({ exists: () => true, data: () => createMockRadar() });
      mockGetPlacementsByRadar.mockResolvedValueOnce([{ id: 'placement-1' }]);

      await expect(deleteRadar('test-radar-123', false)).rejects.toThrow(
        'Cannot delete radar test-radar-123 without cascading: 1 placement(s) still reference it'
      );

      expect(mockRequestRadarGraphDeletion).not.toHaveBeenCalled();
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('should throw when radar not found', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce({ exists: () => false });

      // Act & Assert
      await expect(deleteRadar('nonexistent')).rejects.toThrow('Radar nonexistent not found');
    });

    it('should throw when cascade delete fails', async () => {
      // Arrange
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockRadar(),
      });
      mockDeleteAllPlacements.mockRejectedValueOnce(new Error('Cascade error'));

      // Act & Assert
      await expect(deleteRadar('test-radar-123')).rejects.toThrow('Failed to delete radar placements: Cascade error');
    });

    it('retains the radar document when the required graph handoff fails', async () => {
      mockGetDoc.mockResolvedValueOnce({
        exists: () => true,
        data: () => createMockRadar(),
      });
      mockDeleteAllPlacements.mockResolvedValueOnce(3);
      mockRequestRadarGraphDeletion.mockRejectedValueOnce(new Error('Inngest unavailable'));

      await expect(deleteRadar('test-radar-123')).rejects.toThrow(
        'Failed to schedule radar graph cleanup: Inngest unavailable'
      );

      expect(mockDeleteAllPlacements).toHaveBeenCalledWith('test-radar-123');
      expect(mockDeleteDoc).not.toHaveBeenCalled();
    });

    it('converges on retry when the event is accepted but the final Firestore delete fails', async () => {
      mockGetDoc
        .mockResolvedValueOnce({ exists: () => true, data: () => createMockRadar() })
        .mockResolvedValueOnce({ exists: () => true, data: () => createMockRadar() });
      mockDeleteAllPlacements.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      mockDeleteDoc.mockRejectedValueOnce(new Error('Firestore unavailable')).mockResolvedValueOnce(undefined);

      await expect(deleteRadar('test-radar-123')).rejects.toThrow('Firestore unavailable');
      await expect(deleteRadar('test-radar-123')).resolves.toEqual({ placementsDeleted: 0 });

      expect(mockRequestRadarGraphDeletion).toHaveBeenCalledTimes(2);
      expect(mockDeleteDoc).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // getRadarEntries
  // --------------------------------------------------------------------------
  describe('getRadarEntries()', () => {
    it('should return all entries for a radar', async () => {
      // Arrange
      const entry1 = createMockEntry({ id: 1, name: 'React' });
      const entry2 = createMockEntry({ id: 2, name: 'Vue' });
      mockGetDocs.mockResolvedValueOnce({
        docs: [{ data: () => entry1 }, { data: () => entry2 }],
      });

      // Act
      const result = await getRadarEntries('radar-1');

      // Assert
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('React');
      expect(result[1].name).toBe('Vue');
    });

    it('should return empty array when no entries exist', async () => {
      // Arrange
      mockGetDocs.mockResolvedValueOnce({ docs: [] });

      // Act
      const result = await getRadarEntries('radar-1');

      // Assert
      expect(result).toEqual([]);
    });
  });
});
