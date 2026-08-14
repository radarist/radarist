/**
 * Unit Tests for Radar Placement Service (Decoupled Model)
 *
 * Tests CRUD operations for the new RadarPlacement entity:
 * - getRadarPlacements - Fetch with filtering
 * - getRadarPlacementById - Single fetch by ID
 * - getPlacementForTechnologyOnRadar - Find specific placement
 * - createRadarPlacement - Create new placement
 * - updateRadarPlacement - Update existing placement
 * - moveTechnologyRing - Move technology between rings
 * - deleteRadarPlacement - Delete placement
 * - deleteAllPlacementsForTechnology - Cascade delete
 * - getRadarPlacementStats - Statistics aggregation
 */

import type { RadarPlacement, Ring, Quadrant, Status, TimeToImpact } from '../types';

// Mock firebase module - must be before imports that use it
jest.mock('../firebase', () => ({
  db: {},
}));

// Mock firebase/firestore module with jest.fn() in factory
jest.mock('firebase/firestore', () => ({
  __esModule: true,
  getDocs: jest.fn(),
  getDoc: jest.fn(),
  setDoc: jest.fn(),
  updateDoc: jest.fn(),
  deleteDoc: jest.fn(),
  writeBatch: jest.fn(),
  collection: jest.fn(),
  doc: jest.fn(),
  query: jest.fn(),
  where: jest.fn(),
}));

// Mock relations service for cascade deletion
jest.mock('@/lib/relations', () => ({
  deleteRelationsForEntity: jest.fn().mockResolvedValue(0),
}));

// GRAPH-060: this suite exercises the direct-Firestore (server-side) mutation
// path. In a browser the service delegates to the same-origin API client instead
// (covered by radar-placement-service-handoff.test.ts). Force the non-browser
// branch here so these tests keep validating the direct implementation under the
// default jsdom environment.
jest.mock('@/lib/radar-placement-api-client', () => ({
  isBrowserRadarPlacementClient: jest.fn(() => false),
  createRadarPlacementViaApi: jest.fn(),
  updateRadarPlacementViaApi: jest.fn(),
  deleteRadarPlacementViaApi: jest.fn(),
}));

// Mock technology service so the FK existence check in createRadarPlacement
// has a stable answer. Default is "tech exists"; individual tests override
// for the rejection cases.
jest.mock('@/lib/technology-service', () => ({
  getTechnologyById: jest.fn().mockResolvedValue({ id: 'tech-123', name: 'Mock Tech' }),
}));

// Stub the async side-effect dependencies so NO real Inngest send / graph sync
// fires during the test. Without these, createRadarPlacement/update/delete call
// the real inngest.send() — directly and via triggerEntitySync — which attempts a
// real network POST. It fails fast in isolation, but under full-suite CPU load that
// attempt can approach the 5s per-test timeout, making this suite intermittently
// fail (the "flaky radar-placement" symptom). Stubbing makes the test hermetic and
// deterministic. Inngest-touching tests must mock @/lib/inngest/client.
jest.mock('@/lib/inngest/client', () => ({
  inngest: { send: jest.fn().mockResolvedValue(undefined), createFunction: jest.fn() },
}));
jest.mock('@/lib/entity-sync', () => ({
  triggerEntitySync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));

// Import the service functions (after mocks are set up)
import {
  getRadarPlacements,
  getPlacementsByRadar,
  getPlacementsForTechnology,
  getRadarPlacementById,
  getPlacementForTechnologyOnRadar,
  createRadarPlacement,
  updateRadarPlacement,
  moveTechnologyRing,
  deleteRadarPlacement,
  deleteAllPlacementsForTechnology,
  deleteAllPlacementsForRadar,
  getRadarPlacementStats,
} from '../radar-placement-service';

// Import the mocked module to get references to the mocks
import {
  getDocs,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  doc,
  query,
  where,
} from 'firebase/firestore';

// Re-export as typed mocks for use in tests
const firestoreMocks = {
  getDocs: getDocs as jest.Mock,
  getDoc: getDoc as jest.Mock,
  setDoc: setDoc as jest.Mock,
  updateDoc: updateDoc as jest.Mock,
  deleteDoc: deleteDoc as jest.Mock,
  writeBatch: writeBatch as jest.Mock,
  collection: collection as jest.Mock,
  doc: doc as jest.Mock,
  query: query as jest.Mock,
  where: where as jest.Mock,
};

/**
 * Helper to create a mock radar placement for testing
 */
function createMockPlacement(overrides?: Partial<RadarPlacement>): RadarPlacement {
  return {
    id: 'placement-123',
    technologyId: 'tech-123',
    radarId: 'radar-1',
    quadrantId: 'q_languages_frameworks' as Quadrant,
    ring: 'Adopt' as Ring,
    rationale: 'Mature framework with strong team expertise',
    x: 0.5,
    y: 0.5,
    status: 'Stable' as Status,
    timeToImpact: 'unknown' as TimeToImpact,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    placedBy: 'user-123',
    ...overrides,
  };
}

/**
 * Helper to create mock docs response
 */
function createMockDocsResponse(placements: RadarPlacement[]) {
  return {
    docs: placements.map((p) => ({ id: p.id, data: () => p })),
    empty: placements.length === 0,
  };
}

/**
 * Helper to create mock doc response
 */
function createMockDocResponse(placement: RadarPlacement | null) {
  if (!placement) {
    return { exists: () => false };
  }
  return {
    exists: () => true,
    id: placement.id,
    data: () => placement,
  };
}

describe('Radar Placement Service (Decoupled Model)', () => {
  beforeEach(() => {
    // Reset all mocks completely (including return values and implementations)
    firestoreMocks.getDocs.mockReset();
    firestoreMocks.getDoc.mockReset();
    firestoreMocks.setDoc.mockReset();
    firestoreMocks.updateDoc.mockReset();
    firestoreMocks.deleteDoc.mockReset();
    firestoreMocks.writeBatch.mockReset();
    firestoreMocks.collection.mockReset();
    firestoreMocks.doc.mockReset();
    firestoreMocks.query.mockReset();
    firestoreMocks.where.mockReset();

    // Set default implementations for helpers
    firestoreMocks.collection.mockReturnValue('collection-ref');
    firestoreMocks.doc.mockReturnValue('doc-ref');
    firestoreMocks.query.mockReturnValue('query-ref');
    firestoreMocks.where.mockReturnValue('where-ref');

    // Set default behaviors for data operations
    firestoreMocks.getDocs.mockResolvedValue({ empty: true, docs: [] });
    firestoreMocks.getDoc.mockResolvedValue({ exists: () => false });
    firestoreMocks.setDoc.mockResolvedValue(undefined);
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);
    firestoreMocks.writeBatch.mockReturnValue({
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    });
  });

  // ============================================================================
  // GET OPERATIONS
  // ============================================================================

  describe('getRadarPlacements()', () => {
    it('should fetch all placements', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'placement-1' });
      const mockPlacement2 = createMockPlacement({ id: 'placement-2' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements();

      expect(result).toHaveLength(2);
      expect(firestoreMocks.getDocs).toHaveBeenCalledTimes(1);
    });

    it('should filter by radarId', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'placement-1', radarId: 'radar-1' });
      const mockPlacement2 = createMockPlacement({ id: 'placement-2', radarId: 'radar-2' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements({ radarId: 'radar-1' });

      expect(result).toHaveLength(1);
      expect(result[0].radarId).toBe('radar-1');
    });

    it('should filter by technologyId', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'placement-1', technologyId: 'tech-1' });
      const mockPlacement2 = createMockPlacement({ id: 'placement-2', technologyId: 'tech-2' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements({ technologyId: 'tech-1' });

      expect(result).toHaveLength(1);
      expect(result[0].technologyId).toBe('tech-1');
    });

    it('should filter by quadrant', async () => {
      const mockPlacement1 = createMockPlacement({ quadrantId: 'q_languages_frameworks' });
      const mockPlacement2 = createMockPlacement({ id: 'p2', quadrantId: 'q_tools' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements({ quadrantId: 'q_tools' });

      expect(result).toHaveLength(1);
      expect(result[0].quadrantId).toBe('q_tools');
    });

    it('should filter by ring', async () => {
      const mockPlacement1 = createMockPlacement({ ring: 'Adopt' });
      const mockPlacement2 = createMockPlacement({ id: 'p2', ring: 'Trial' });
      const mockPlacement3 = createMockPlacement({ id: 'p3', ring: 'Adopt' });
      firestoreMocks.getDocs.mockResolvedValueOnce(
        createMockDocsResponse([mockPlacement1, mockPlacement2, mockPlacement3])
      );

      const result = await getRadarPlacements({ ring: 'Adopt' });

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.ring === 'Adopt')).toBe(true);
    });

    it('should filter by status', async () => {
      const mockPlacement1 = createMockPlacement({ status: 'Stable' });
      const mockPlacement2 = createMockPlacement({ id: 'p2', status: 'Trending' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements({ status: 'Trending' });

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('Trending');
    });

    it('should apply limit', async () => {
      const placements = Array.from({ length: 10 }, (_, i) => createMockPlacement({ id: `placement-${i}` }));
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));

      const result = await getRadarPlacements({ limit: 5 });

      expect(result).toHaveLength(5);
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDocs.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getRadarPlacements()).rejects.toThrow('Failed to fetch placements');
    });
  });

  describe('getPlacementsByRadar()', () => {
    it('should fetch placements for a specific radar', async () => {
      const mockPlacement = createMockPlacement({ radarId: 'my-radar' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement]));

      const result = await getPlacementsByRadar('my-radar');

      expect(result).toHaveLength(1);
      expect(result[0].radarId).toBe('my-radar');
    });
  });

  describe('getPlacementsForTechnology()', () => {
    it('should fetch all placements for a technology across radars', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'p1', technologyId: 'tech-1', radarId: 'radar-1' });
      const mockPlacement2 = createMockPlacement({ id: 'p2', technologyId: 'tech-1', radarId: 'radar-2' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getPlacementsForTechnology('tech-1');

      expect(result).toHaveLength(2);
    });
  });

  describe('getRadarPlacementById()', () => {
    it('should fetch placement by ID', async () => {
      const mockPlacement = createMockPlacement();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockPlacement));

      const result = await getRadarPlacementById('placement-123');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('placement-123');
      expect(firestoreMocks.getDoc).toHaveBeenCalledTimes(1);
    });

    it('should return null when placement not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      const result = await getRadarPlacementById('nonexistent');

      expect(result).toBeNull();
    });

    it('should handle errors gracefully', async () => {
      firestoreMocks.getDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(getRadarPlacementById('placement-123')).rejects.toThrow('Failed to fetch placement');
    });
  });

  describe('getPlacementForTechnologyOnRadar()', () => {
    it('should find placement for tech on specific radar', async () => {
      const mockPlacement = createMockPlacement({
        technologyId: 'tech-123',
        radarId: 'radar-1',
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement]));

      const result = await getPlacementForTechnologyOnRadar('tech-123', 'radar-1');

      expect(result).not.toBeNull();
      expect(result?.technologyId).toBe('tech-123');
      expect(result?.radarId).toBe('radar-1');
    });

    it('should return null when no placement exists', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getPlacementForTechnologyOnRadar('tech-123', 'radar-2');

      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // CREATE OPERATIONS
  // ============================================================================

  describe('createRadarPlacement()', () => {
    it('should create a new placement', async () => {
      // First call: check for existing placement (empty - no existing)
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createRadarPlacement({
        technologyId: 'tech-123',
        radarId: 'radar-1',
        quadrantId: 'q_languages_frameworks',
        ring: 'Trial',
        rationale: 'Testing new framework',
        placedBy: 'user-123',
      });

      expect(result.technologyId).toBe('tech-123');
      expect(result.radarId).toBe('radar-1');
      expect(result.ring).toBe('Trial');
      expect(result.id).toMatch(/^placement-/);
      expect(result.createdAt).toBeDefined();
      expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(1);
    });

    it('should include optional fields when provided', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createRadarPlacement({
        technologyId: 'tech-456',
        radarId: 'radar-2',
        quadrantId: 'q_tools',
        ring: 'Adopt',
        rationale: 'Mature tool',
        x: 0.7,
        y: 0.3,
        status: 'Stable',
        placedBy: 'user-123',
      });

      expect(result.x).toBe(0.7);
      expect(result.y).toBe(0.3);
      expect(result.status).toBe('Stable');
    });

    it('should throw error if technology already placed on radar', async () => {
      // Existing placement found
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([createMockPlacement()]));

      await expect(
        createRadarPlacement({
          technologyId: 'tech-123',
          radarId: 'radar-1',
          quadrantId: 'q_tools',
          ring: 'Adopt',
          placedBy: 'user-123',
        })
      ).rejects.toThrow('already placed');
    });

    // A placement must never point at a fabricated technology ID; this guard
    // closes the bug class at the service entry.
    it('should reject placement when the referenced technology does not exist', async () => {
      const { getTechnologyById } = jest.requireMock('@/lib/technology-service');
      getTechnologyById.mockResolvedValueOnce(null);

      await expect(
        createRadarPlacement({
          technologyId: 'tech-does-not-exist',
          radarId: 'radar-1',
          quadrantId: 'q_tools',
          ring: 'Trial',
          placedBy: 'ai-assistant',
        })
      ).rejects.toThrow(/technology tech-does-not-exist does not exist/);

      // Must not attempt to write anything when the FK check fails.
      expect(firestoreMocks.setDoc).not.toHaveBeenCalled();
    });

    it('should handle creation errors', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
      firestoreMocks.setDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(
        createRadarPlacement({
          technologyId: 'tech-789',
          radarId: 'radar-3',
          quadrantId: 'q_tools',
          ring: 'Hold',
          placedBy: 'user-123',
        })
      ).rejects.toThrow('Failed to create placement');
    });
  });

  // ============================================================================
  // UPDATE OPERATIONS
  // ============================================================================

  describe('updateRadarPlacement()', () => {
    it('should update an existing placement', async () => {
      const existingPlacement = createMockPlacement();
      const updatedPlacement = { ...existingPlacement, rationale: 'Updated rationale' };

      // First call: existence check
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));
      // Second call: return updated document
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(updatedPlacement));

      const result = await updateRadarPlacement('placement-123', { rationale: 'Updated rationale' });

      expect(result.rationale).toBe('Updated rationale');
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should track ring movement history', async () => {
      const existingPlacement = createMockPlacement({ ring: 'Trial' });
      const updatedPlacement = { ...existingPlacement, ring: 'Adopt' as Ring, movedFrom: 'Trial' };

      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(updatedPlacement));

      await updateRadarPlacement('placement-123', { ring: 'Adopt' });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      const updateCall = firestoreMocks.updateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.movedFrom).toBe('Trial');
      expect(updateCall.movedAt).toBeDefined();
    });

    it('should not track movement when ring unchanged', async () => {
      const existingPlacement = createMockPlacement({ ring: 'Adopt' });

      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));

      await updateRadarPlacement('placement-123', { rationale: 'New rationale' });

      const updateCall = firestoreMocks.updateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.movedFrom).toBeUndefined();
    });

    it('should throw when placement not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(updateRadarPlacement('nonexistent', { ring: 'Adopt' })).rejects.toThrow(
        'Placement nonexistent not found'
      );
    });

    it('should handle update errors', async () => {
      const existingPlacement = createMockPlacement();
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));
      firestoreMocks.updateDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(updateRadarPlacement('placement-123', { ring: 'Adopt' })).rejects.toThrow(
        'Failed to update placement'
      );
    });
  });

  describe('moveTechnologyRing()', () => {
    it('should move technology to new ring with rationale', async () => {
      const existingPlacement = createMockPlacement({ ring: 'Trial' });
      const updatedPlacement = { ...existingPlacement, ring: 'Adopt' as Ring };

      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(updatedPlacement));

      await moveTechnologyRing('placement-123', 'Adopt', 'Ready for production');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
      const updateCall = firestoreMocks.updateDoc.mock.calls[0][1] as Record<string, unknown>;
      expect(updateCall.ring).toBe('Adopt');
      expect(updateCall.rationale).toBe('Ready for production');
    });
  });

  // ============================================================================
  // DELETE OPERATIONS
  // ============================================================================

  describe('deleteRadarPlacement()', () => {
    it('should delete a placement by ID', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockPlacement()));

      await deleteRadarPlacement('placement-123');

      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should cascade-delete relations when deleting a placement', async () => {
      const { deleteRelationsForEntity } = jest.requireMock('@/lib/relations');
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockPlacement({ id: 'p-1' })));
      (deleteRelationsForEntity as jest.Mock).mockResolvedValueOnce(2);

      await deleteRadarPlacement('p-1');

      expect(deleteRelationsForEntity).toHaveBeenCalledWith('p-1');
      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should throw when placement not found', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(null));

      await expect(deleteRadarPlacement('nonexistent')).rejects.toThrow('Placement nonexistent not found');
    });

    it('should handle deletion errors', async () => {
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(createMockPlacement()));
      firestoreMocks.deleteDoc.mockRejectedValueOnce(new Error('Firestore error'));

      await expect(deleteRadarPlacement('placement-123')).rejects.toThrow('Failed to delete placement');
    });
  });

  describe('deleteAllPlacementsForTechnology()', () => {
    it('should delete all placements for a technology', async () => {
      const placements = [
        createMockPlacement({ id: 'p1', technologyId: 'tech-123', radarId: 'radar-1' }),
        createMockPlacement({ id: 'p2', technologyId: 'tech-123', radarId: 'radar-2' }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));

      const result = await deleteAllPlacementsForTechnology('tech-123');

      expect(result).toBe(2);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should cascade-delete relations for each placement when deleting by technology', async () => {
      const { deleteRelationsForEntity } = jest.requireMock('@/lib/relations');
      const placements = [
        createMockPlacement({ id: 'p1', technologyId: 'tech-123', radarId: 'radar-1' }),
        createMockPlacement({ id: 'p2', technologyId: 'tech-123', radarId: 'radar-2' }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));
      (deleteRelationsForEntity as jest.Mock).mockResolvedValue(1);

      await deleteAllPlacementsForTechnology('tech-123');

      expect(deleteRelationsForEntity).toHaveBeenCalledWith('p1');
      expect(deleteRelationsForEntity).toHaveBeenCalledWith('p2');
    });

    it('should return 0 when no placements exist', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await deleteAllPlacementsForTechnology('tech-123');

      expect(result).toBe(0);
    });
  });

  describe('deleteAllPlacementsForRadar()', () => {
    it('should delete all placements for a radar', async () => {
      const placements = Array.from({ length: 5 }, (_, i) => createMockPlacement({ id: `p${i}`, radarId: 'radar-1' }));
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));

      const result = await deleteAllPlacementsForRadar('radar-1');

      expect(result).toBe(5);
      expect(firestoreMocks.writeBatch).toHaveBeenCalled();
    });

    it('should cascade-delete relations for each placement when deleting by radar', async () => {
      const { deleteRelationsForEntity } = jest.requireMock('@/lib/relations');
      const placements = Array.from({ length: 3 }, (_, i) => createMockPlacement({ id: `p${i}`, radarId: 'radar-1' }));
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));
      (deleteRelationsForEntity as jest.Mock).mockResolvedValue(1);

      await deleteAllPlacementsForRadar('radar-1');

      expect(deleteRelationsForEntity).toHaveBeenCalledWith('p0');
      expect(deleteRelationsForEntity).toHaveBeenCalledWith('p1');
      expect(deleteRelationsForEntity).toHaveBeenCalledWith('p2');
    });

    it('should handle batch processing for large numbers', async () => {
      // Create 600 placements to test batching (Firestore limit is 500)
      const placements = Array.from({ length: 600 }, (_, i) =>
        createMockPlacement({ id: `p${i}`, radarId: 'radar-1' })
      );
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));

      const result = await deleteAllPlacementsForRadar('radar-1');

      expect(result).toBe(600);
      // writeBatch should be called twice due to batching (500 + 100)
      expect(firestoreMocks.writeBatch).toHaveBeenCalledTimes(2);
    });
  });

  // ============================================================================
  // STATISTICS
  // ============================================================================

  describe('getRadarPlacementStats()', () => {
    it('should calculate correct statistics', async () => {
      const now = Date.now();
      const placements = [
        createMockPlacement({ ring: 'Adopt', quadrantId: 'q_languages_frameworks' }),
        createMockPlacement({ id: 'p2', ring: 'Adopt', quadrantId: 'q_languages_frameworks' }),
        createMockPlacement({ id: 'p3', ring: 'Trial', quadrantId: 'q_tools' }),
        createMockPlacement({ id: 'p4', ring: 'Assess', quadrantId: 'q_platforms' }),
        createMockPlacement({
          id: 'p5',
          ring: 'Hold',
          quadrantId: 'q_techniques',
          movedAt: now - 10 * 24 * 60 * 60 * 1000, // 10 days ago
        }),
      ];
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse(placements));

      const result = await getRadarPlacementStats('radar-1');

      expect(result.total).toBe(5);
      expect(result.byRing.Adopt).toBe(2);
      expect(result.byRing.Trial).toBe(1);
      expect(result.byRing.Assess).toBe(1);
      expect(result.byRing.Hold).toBe(1);
      expect(result.byQuadrant['q_languages_frameworks']?.count).toBe(2);
      expect(result.byQuadrant['q_tools']?.count).toBe(1);
      expect(result.recentMoves).toBe(1); // One move in last 30 days
    });

    it('should handle empty radar', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await getRadarPlacementStats('empty-radar');

      expect(result.total).toBe(0);
      expect(result.byRing.Adopt).toBe(0);
      expect(result.byRing.Trial).toBe(0);
      expect(result.recentMoves).toBe(0);
    });
  });

  // ============================================================================
  // TIME TO IMPACT FIELD (Phase 0 Task 0.2.2)
  // ============================================================================

  describe('timeToImpact field (Phase 0 Task 0.2.2)', () => {
    it('should create placement with timeToImpact value', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createRadarPlacement({
        technologyId: 'tech-123',
        radarId: 'radar-1',
        quadrantId: 'q_languages_frameworks',
        ring: 'Trial',
        timeToImpact: 'H1',
        placedBy: 'user-123',
      });

      expect(result.timeToImpact).toBe('H1');
    });

    it('should default timeToImpact to unknown when not provided', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));

      const result = await createRadarPlacement({
        technologyId: 'tech-456',
        radarId: 'radar-1',
        quadrantId: 'q_tools',
        ring: 'Adopt',
        placedBy: 'user-123',
      });

      expect(result.timeToImpact).toBe('unknown');
    });

    it('should preserve timeToImpact when fetching placement by ID', async () => {
      const mockPlacement = createMockPlacement({ timeToImpact: 'H2' });
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(mockPlacement));

      const result = await getRadarPlacementById('placement-123');

      expect(result?.timeToImpact).toBe('H2');
    });

    it('should filter placements by timeToImpact', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'p1', timeToImpact: 'H1' });
      const mockPlacement2 = createMockPlacement({ id: 'p2', timeToImpact: 'H2' });
      const mockPlacement3 = createMockPlacement({ id: 'p3', timeToImpact: 'H1' });
      firestoreMocks.getDocs.mockResolvedValueOnce(
        createMockDocsResponse([mockPlacement1, mockPlacement2, mockPlacement3])
      );

      const result = await getRadarPlacements({ timeToImpact: 'H1' });

      expect(result).toHaveLength(2);
      expect(result.every((p) => p.timeToImpact === 'H1')).toBe(true);
    });

    it('should update timeToImpact field', async () => {
      const existingPlacement = createMockPlacement({ timeToImpact: 'H3' });
      const updatedPlacement = { ...existingPlacement, timeToImpact: 'H1' as TimeToImpact };

      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(existingPlacement));
      firestoreMocks.getDoc.mockResolvedValueOnce(createMockDocResponse(updatedPlacement));

      const result = await updateRadarPlacement('placement-123', { timeToImpact: 'H1' });

      expect(result.timeToImpact).toBe('H1');
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should handle all valid timeToImpact values (H1, H2, H3, unknown)', async () => {
      const validValues: TimeToImpact[] = ['H1', 'H2', 'H3', 'unknown'];

      for (const value of validValues) {
        firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
        firestoreMocks.setDoc.mockResolvedValueOnce(undefined);

        const result = await createRadarPlacement({
          technologyId: `tech-${value}`,
          radarId: `radar-${value}`,
          quadrantId: 'q_tools',
          ring: 'Adopt',
          timeToImpact: value,
          placedBy: 'user-123',
        });

        expect(result.timeToImpact).toBe(value);
      }
    });

    it('should preserve timeToImpact in getRadarPlacements list', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'p1', timeToImpact: 'H1' });
      const mockPlacement2 = createMockPlacement({ id: 'p2', timeToImpact: 'H3' });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements();

      expect(result[0].timeToImpact).toBe('H1');
      expect(result[1].timeToImpact).toBe('H3');
    });
  });

  // ============================================================================
  // PHASE 2 TASK 2.1.1: trlScore and technologySnapshot
  // ============================================================================

  describe('Phase 2 - trlScore field', () => {
    it('should create placement with trlScore', async () => {
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
      firestoreMocks.setDoc.mockResolvedValueOnce(undefined);

      const result = await createRadarPlacement({
        technologyId: 'tech-123',
        radarId: 'radar-1',
        quadrantId: 'q_tools',
        ring: 'Adopt',
        trlScore: 7,
        placedBy: 'user-123',
      });

      expect(result.trlScore).toBe(7);
      expect(firestoreMocks.setDoc).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trlScore: 7 }));
    });

    it('should update placement trlScore', async () => {
      const mockPlacement = createMockPlacement({ trlScore: 5 });
      const updatedPlacement = { ...mockPlacement, trlScore: 8 };
      // First call: existence check
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: mockPlacement.id,
        data: () => mockPlacement,
      });
      firestoreMocks.updateDoc.mockResolvedValueOnce(undefined);
      // Second call: return updated document
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: updatedPlacement.id,
        data: () => updatedPlacement,
      });

      await updateRadarPlacement(mockPlacement.id, { trlScore: 8 });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ trlScore: 8 })
      );
    });

    it('should preserve trlScore in getRadarPlacements list', async () => {
      const mockPlacement1 = createMockPlacement({ id: 'p1', trlScore: 3 });
      const mockPlacement2 = createMockPlacement({ id: 'p2', trlScore: 9 });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement1, mockPlacement2]));

      const result = await getRadarPlacements();

      expect(result[0].trlScore).toBe(3);
      expect(result[1].trlScore).toBe(9);
    });
  });

  describe('Phase 2 - technologySnapshot field', () => {
    it('should create placement with technologySnapshot', async () => {
      const snapshot = { name: 'React', slug: 'react', category: 'Frontend' };
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([]));
      firestoreMocks.setDoc.mockResolvedValueOnce(undefined);

      const result = await createRadarPlacement({
        technologyId: 'tech-123',
        radarId: 'radar-1',
        quadrantId: 'q_languages_frameworks',
        ring: 'Adopt',
        technologySnapshot: snapshot,
        placedBy: 'user-123',
      });

      expect(result.technologySnapshot).toEqual(snapshot);
      expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ technologySnapshot: snapshot })
      );
    });

    it('should update placement technologySnapshot', async () => {
      const mockPlacement = createMockPlacement({
        technologySnapshot: { name: 'React', slug: 'react' },
      });
      const updatedSnapshot = {
        name: 'React 19',
        slug: 'react-19',
        category: 'Frontend',
        snapshotUpdatedAt: Date.now(),
      };
      const updatedPlacement = { ...mockPlacement, technologySnapshot: updatedSnapshot };

      // First call: existence check
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: mockPlacement.id,
        data: () => mockPlacement,
      });
      firestoreMocks.updateDoc.mockResolvedValueOnce(undefined);
      // Second call: return updated document
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: updatedPlacement.id,
        data: () => updatedPlacement,
      });

      await updateRadarPlacement(mockPlacement.id, {
        technologySnapshot: updatedSnapshot,
      });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ technologySnapshot: updatedSnapshot })
      );
    });

    it('should preserve technologySnapshot in getRadarPlacementById', async () => {
      const snapshot = { name: 'Vue.js', slug: 'vuejs', category: 'Frontend' };
      const mockPlacement = createMockPlacement({
        technologySnapshot: snapshot,
      });
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: mockPlacement.id,
        data: () => mockPlacement,
      });

      const result = await getRadarPlacementById(mockPlacement.id);

      expect(result?.technologySnapshot).toEqual(snapshot);
    });

    it('should include snapshotUpdatedAt timestamp when updating snapshot', async () => {
      const mockPlacement = createMockPlacement({
        technologySnapshot: { name: 'Angular', slug: 'angular' },
      });
      const snapshotWithTimestamp = {
        name: 'Angular 17',
        slug: 'angular-17',
        snapshotUpdatedAt: Date.now(),
      };
      const updatedPlacement = { ...mockPlacement, technologySnapshot: snapshotWithTimestamp };

      // First call: existence check
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: mockPlacement.id,
        data: () => mockPlacement,
      });
      firestoreMocks.updateDoc.mockResolvedValueOnce(undefined);
      // Second call: return updated document
      firestoreMocks.getDoc.mockResolvedValueOnce({
        exists: () => true,
        id: updatedPlacement.id,
        data: () => updatedPlacement,
      });

      await updateRadarPlacement(mockPlacement.id, {
        technologySnapshot: snapshotWithTimestamp,
      });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          technologySnapshot: expect.objectContaining({
            snapshotUpdatedAt: expect.any(Number),
          }),
        })
      );
    });
  });

  describe('Phase 2 - combined three-dimensional placement', () => {
    it('should support all three dimensions on a single placement', async () => {
      const mockPlacement = createMockPlacement({
        ring: 'Trial',
        timeToImpact: 'H2',
        trlScore: 6,
        technologySnapshot: { name: 'Next.js', slug: 'nextjs', category: 'Framework' },
      });
      firestoreMocks.getDocs.mockResolvedValueOnce(createMockDocsResponse([mockPlacement]));

      const result = await getRadarPlacements();

      expect(result[0]).toEqual(
        expect.objectContaining({
          ring: 'Trial',
          timeToImpact: 'H2',
          trlScore: 6,
          technologySnapshot: { name: 'Next.js', slug: 'nextjs', category: 'Framework' },
        })
      );
    });
  });
});
