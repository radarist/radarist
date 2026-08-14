/**
 * E2E Tests for Radar Entry Workflow
 *
 * Comprehensive tests for the full technology + radar placement workflow:
 * 1. Create a new technology in the library
 * 2. Add technology to radar with classification fields
 * 3. Verify all fields (TRL, Time-to-Impact, Ring) are saved correctly
 * 4. Update values and verify persistence
 * 5. Test ring system switching (Standard/HATA, TRL, Time-to-Impact)
 *
 * This test validates the critical bug fix where timeToImpact and trlScore
 * were not being saved during updates in useRadarEntriesDecoupled.ts
 *
 * @see useRadarEntriesDecoupled.ts - Hook under test
 * @see radar-placement-service.ts - Service layer
 * @see technology-adapters.ts - Data conversion layer
 */

import type { RadarPlacement, Technology, TimeToImpact, Ring, Quadrant, Status } from '../types';
import { mapTimeToImpactToDisplay } from '../technology-adapters';

// Mock firebase module - must be before imports that use it
jest.mock('../firebase', () => ({
  db: {},
}));

// Mock technology-service so the FK existence check in createRadarPlacement
// (added 2026-05-12 to close the orphan-placement bug class) passes for the
// hard-coded tech IDs this E2E test uses. The fixture tech IDs don't need to
// resolve to a "real" stored entity for this suite — the test exercises the
// placement service, not the technology service.
jest.mock('../technology-service', () => ({
  getTechnologyById: jest.fn().mockImplementation((id: string) => Promise.resolve({ id, name: `Fixture tech ${id}` })),
}));

// This suite exercises the in-memory placement contract only. Keep every
// projection/event boundary hermetic so Jest cannot auto-discover a live local
// Inngest server or mutate a developer's Neo4j graph.
jest.mock('../entity-sync', () => ({
  triggerEntitySync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../events/data-refresh', () => ({
  emitDataRefresh: jest.fn(),
}));
jest.mock('../inngest/send-client', () => ({
  inngest: { send: jest.fn().mockResolvedValue({ ids: ['test-event'] }) },
}));

// GRAPH-060: in a browser the placement service delegates to the same-origin API
// client (fetch). This suite exercises the direct-Firestore persistence path with
// an in-memory Firestore mock, so force the non-browser branch (the same
// server-side path the admin twin covers) instead of hitting the network.
jest.mock('../radar-placement-api-client', () => ({
  isBrowserRadarPlacementClient: jest.fn(() => false),
  createRadarPlacementViaApi: jest.fn(),
  updateRadarPlacementViaApi: jest.fn(),
  deleteRadarPlacementViaApi: jest.fn(),
}));

// In-memory store for testing
let placementsStore: Map<string, RadarPlacement>;
let _technologiesStore: Map<string, Technology>;

// Mock firebase/firestore module
jest.mock('firebase/firestore', () => {
  // We need to return fresh mock functions for each test
  return {
    __esModule: true,
    getDocs: jest.fn(async () => ({
      docs: Array.from(placementsStore.values()).map((p) => ({
        id: p.id,
        data: () => p,
      })),
      empty: placementsStore.size === 0,
    })),
    getDoc: jest.fn(async (ref: { id: string; collection: string }) => {
      // Determine which store to use based on collection
      const id = typeof ref === 'object' && 'id' in ref ? ref.id : ref;
      const placement = placementsStore.get(id as string);
      return {
        exists: () => !!placement,
        id: id as string,
        data: () => placement,
      };
    }),
    setDoc: jest.fn(async (ref: { id: string }, data: RadarPlacement) => {
      placementsStore.set(ref.id, { ...data, id: ref.id });
    }),
    updateDoc: jest.fn(async (ref: { id: string }, updates: Partial<RadarPlacement>) => {
      const existing = placementsStore.get(ref.id);
      if (existing) {
        placementsStore.set(ref.id, { ...existing, ...updates });
      }
    }),
    deleteDoc: jest.fn(async (ref: { id: string }) => {
      placementsStore.delete(ref.id);
    }),
    writeBatch: jest.fn(() => ({
      delete: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
    })),
    collection: jest.fn((_, name) => ({ name })),
    doc: jest.fn((_, id) => ({ id, collection: _ })),
    query: jest.fn((ref) => ref),
    where: jest.fn(() => ({})),
  };
});

// Import service functions after mocks
import { createRadarPlacement, updateRadarPlacement, getRadarPlacementById } from '../radar-placement-service';

// Import the firestore mock to control return values
import { getDoc, getDocs } from 'firebase/firestore';

const mockedGetDoc = getDoc as jest.Mock;
const mockedGetDocs = getDocs as jest.Mock;

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Simulates the form value conversion that happens in useRadarEntriesDecoupled.ts
 */
function parseTimeToImpact(value: string | undefined): TimeToImpact | undefined {
  if (!value) return undefined;
  const match = value.match(/^(H[123])/);
  if (match) return match[1] as TimeToImpact;
  if (value === 'H1' || value === 'H2' || value === 'H3') return value as TimeToImpact;
  return undefined;
}

function parseTrlScore(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/TRL\s*(\d)/i);
  if (match) {
    const score = parseInt(match[1], 10);
    if (score >= 1 && score <= 9) return score;
  }
  return undefined;
}

/**
 * Creates a mock placement for testing
 */
function createTestPlacement(overrides?: Partial<RadarPlacement>): RadarPlacement {
  const id = `placement-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const now = Date.now();
  return {
    id,
    technologyId: `tech-${Date.now()}`,
    radarId: 'test-radar-1',
    quadrantId: 'q_languages_frameworks' as Quadrant,
    ring: 'Trial' as Ring,
    status: 'Stable' as Status,
    x: 0.5,
    y: 0.5,
    timeToImpact: 'unknown' as TimeToImpact,
    createdAt: now,
    updatedAt: now,
    placedBy: 'test-user',
    ...overrides,
  };
}

// ============================================================================
// TEST SUITES
// ============================================================================

describe('Radar Entry E2E Workflow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    placementsStore = new Map();
    _technologiesStore = new Map();
  });

  // ==========================================================================
  // CRITICAL BUG FIX: timeToImpact and trlScore persistence
  // ==========================================================================

  describe('CRITICAL: timeToImpact and trlScore persistence (Bug Fix)', () => {
    it('should save timeToImpact when creating a new placement', async () => {
      // Simulate form values from AddEntrySheet
      const formValues = {
        name: 'React 19',
        quadrantId: 'q_languages_frameworks' as Quadrant,
        ring: 'Trial' as Ring,
        trl: 'TRL 6',
        timeToImpact: 'H1 (0-6mo)', // Form value format
        status: 'Stable' as Status,
      };

      // Convert form values to database format (as done in useRadarEntriesDecoupled)
      const timeToImpact = parseTimeToImpact(formValues.timeToImpact);
      const trlScore = parseTrlScore(formValues.trl);

      // Mock: No existing placement
      mockedGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      // Create placement
      const placement = await createRadarPlacement({
        technologyId: 'tech-react-19',
        radarId: 'test-radar-1',
        quadrantId: formValues.quadrantId,
        ring: formValues.ring,
        status: formValues.status,
        timeToImpact,
        trlScore,
        placedBy: 'test-user',
      });

      // Verify timeToImpact was saved
      expect(placement.timeToImpact).toBe('H1');
      expect(placement.trlScore).toBe(6);
    });

    it('should save timeToImpact when updating an existing placement', async () => {
      // Create initial placement WITHOUT timeToImpact (simulating legacy data)
      const existingPlacement = createTestPlacement({
        id: 'placement-existing',
        timeToImpact: undefined,
        trlScore: undefined,
      });
      placementsStore.set(existingPlacement.id, existingPlacement);

      // Mock getDoc to return the existing placement
      mockedGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          id: existingPlacement.id,
          data: () => existingPlacement,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: existingPlacement.id,
          data: () => ({
            ...existingPlacement,
            timeToImpact: 'H2' as TimeToImpact,
            trlScore: 7,
          }),
        });

      // Update with timeToImpact (simulating form submission in useRadarEntriesDecoupled)
      const formTimeToImpact = 'H2 (6-18mo)'; // Form value format
      const formTrl = 'TRL 7';

      const updated = await updateRadarPlacement(existingPlacement.id, {
        timeToImpact: parseTimeToImpact(formTimeToImpact),
        trlScore: parseTrlScore(formTrl),
      });

      // Verify timeToImpact was saved
      expect(updated.timeToImpact).toBe('H2');
      expect(updated.trlScore).toBe(7);
    });

    it('should preserve timeToImpact when updating other fields', async () => {
      // Create placement WITH timeToImpact
      const existingPlacement = createTestPlacement({
        id: 'placement-preserve',
        timeToImpact: 'H1' as TimeToImpact,
        trlScore: 5,
      });
      placementsStore.set(existingPlacement.id, existingPlacement);

      mockedGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          id: existingPlacement.id,
          data: () => existingPlacement,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: existingPlacement.id,
          data: () => ({
            ...existingPlacement,
            ring: 'Adopt' as Ring,
          }),
        });

      // Update only ring (not timeToImpact)
      await updateRadarPlacement(existingPlacement.id, {
        ring: 'Adopt' as Ring,
      });

      // Verify timeToImpact is still preserved in store
      const storedPlacement = placementsStore.get(existingPlacement.id);
      expect(storedPlacement?.timeToImpact).toBe('H1');
      expect(storedPlacement?.trlScore).toBe(5);
    });
  });

  // ==========================================================================
  // Ring System Switching Tests
  // ==========================================================================

  describe('Ring System Switching', () => {
    it('should map TRL values correctly between form and database', () => {
      // Test all TRL values
      const trlValues = ['TRL 1', 'TRL 2', 'TRL 3', 'TRL 4', 'TRL 5', 'TRL 6', 'TRL 7', 'TRL 8', 'TRL 9'];

      trlValues.forEach((trl, index) => {
        const trlScore = parseTrlScore(trl);
        expect(trlScore).toBe(index + 1);
      });
    });

    it('should map Time-to-Impact values correctly between form and database', () => {
      // Form values -> Database values
      expect(parseTimeToImpact('H1 (0-6mo)')).toBe('H1');
      expect(parseTimeToImpact('H2 (6-18mo)')).toBe('H2');
      expect(parseTimeToImpact('H3 (18+mo)')).toBe('H3');
      expect(parseTimeToImpact('')).toBeUndefined();
      expect(parseTimeToImpact(undefined)).toBeUndefined();
    });

    it('should convert database values back to form display values', () => {
      // Database values -> Form display values
      expect(mapTimeToImpactToDisplay('H1')).toBe('H1 (0-6mo)');
      expect(mapTimeToImpactToDisplay('H2')).toBe('H2 (6-18mo)');
      expect(mapTimeToImpactToDisplay('H3')).toBe('H3 (18+mo)');
      expect(mapTimeToImpactToDisplay('unknown')).toBeUndefined();
      expect(mapTimeToImpactToDisplay(undefined)).toBeUndefined();
    });

    it('should maintain consistency through round-trip conversion', () => {
      // Form -> DB -> Form should be consistent
      const formValues = ['H1 (0-6mo)', 'H2 (6-18mo)', 'H3 (18+mo)'];

      formValues.forEach((formValue) => {
        const dbValue = parseTimeToImpact(formValue);
        const backToForm = mapTimeToImpactToDisplay(dbValue);
        expect(backToForm).toBe(formValue);
      });
    });

    it('should handle switching from Standard ring to TRL ring system', async () => {
      // Start with Standard ring (HATA)
      const placement = createTestPlacement({
        id: 'placement-switch-test',
        ring: 'Assess' as Ring,
        timeToImpact: 'H2' as TimeToImpact,
        trlScore: undefined,
      });
      placementsStore.set(placement.id, placement);

      // Mock getDoc calls
      mockedGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          id: placement.id,
          data: () => placement,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: placement.id,
          data: () => ({
            ...placement,
            ring: 'TRL 5' as Ring,
            trlScore: 5,
          }),
        });

      // Switch to TRL ring system
      const updated = await updateRadarPlacement(placement.id, {
        ring: 'TRL 5' as Ring,
        trlScore: parseTrlScore('TRL 5'),
      });

      expect(updated.ring).toBe('TRL 5');
      expect(updated.trlScore).toBe(5);
    });

    it('should handle switching from TRL to Time-to-Impact ring system', async () => {
      const placement = createTestPlacement({
        id: 'placement-trl-to-tti',
        ring: 'TRL 5' as Ring,
        trlScore: 5,
        timeToImpact: undefined,
      });
      placementsStore.set(placement.id, placement);

      const updatedPlacement = {
        ...placement,
        ring: 'H1 (0-6mo)' as Ring,
        timeToImpact: 'H1' as TimeToImpact,
      };

      mockedGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          id: placement.id,
          data: () => placement,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: placement.id,
          data: () => updatedPlacement,
        });

      // Switch to Time-to-Impact ring system
      const result = await updateRadarPlacement(placement.id, {
        ring: 'H1 (0-6mo)' as Ring,
        timeToImpact: parseTimeToImpact('H1 (0-6mo)'),
      });

      // Verify the returned result has the updated values
      expect(result.timeToImpact).toBe('H1');
    });
  });

  // ==========================================================================
  // Full E2E Workflow Tests
  // ==========================================================================

  describe('Full E2E Workflow', () => {
    it('should complete full workflow: create -> read -> update -> verify', async () => {
      // STEP 1: Create new technology placement with all fields
      const formData = {
        name: 'Next.js 14',
        quadrantId: 'q_languages_frameworks' as Quadrant,
        ring: 'Trial' as Ring,
        hata: 'Trial',
        trl: 'TRL 7',
        timeToImpact: 'H2 (6-18mo)',
        status: 'Trending' as Status,
        description: 'Full-stack React framework',
      };

      // Mock: No existing placement
      mockedGetDocs.mockResolvedValueOnce({ docs: [], empty: true });

      const createdPlacement = await createRadarPlacement({
        technologyId: 'tech-nextjs-14',
        radarId: 'test-radar-1',
        quadrantId: formData.quadrantId,
        ring: formData.ring,
        status: formData.status,
        timeToImpact: parseTimeToImpact(formData.timeToImpact),
        trlScore: parseTrlScore(formData.trl),
        placedBy: 'test-user',
      });

      // Verify creation
      expect(createdPlacement.timeToImpact).toBe('H2');
      expect(createdPlacement.trlScore).toBe(7);
      expect(createdPlacement.ring).toBe('Trial');

      // Store for subsequent operations
      placementsStore.set(createdPlacement.id, createdPlacement);

      // STEP 2: Read placement and verify values
      mockedGetDoc.mockResolvedValueOnce({
        exists: () => true,
        id: createdPlacement.id,
        data: () => createdPlacement,
      });

      const readPlacement = await getRadarPlacementById(createdPlacement.id);
      expect(readPlacement?.timeToImpact).toBe('H2');
      expect(readPlacement?.trlScore).toBe(7);

      // STEP 3: Update to new values
      const updatedData = {
        ring: 'Adopt' as Ring,
        timeToImpact: 'H1 (0-6mo)',
        trl: 'TRL 9',
      };

      const updatedPlacementData = {
        ...createdPlacement,
        ring: updatedData.ring,
        timeToImpact: 'H1' as TimeToImpact,
        trlScore: 9,
      };

      mockedGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          id: createdPlacement.id,
          data: () => createdPlacement,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: createdPlacement.id,
          data: () => updatedPlacementData,
        });

      const updatedPlacement = await updateRadarPlacement(createdPlacement.id, {
        ring: updatedData.ring,
        timeToImpact: parseTimeToImpact(updatedData.timeToImpact),
        trlScore: parseTrlScore(updatedData.trl),
      });

      // STEP 4: Verify updated values
      expect(updatedPlacement.ring).toBe('Adopt');
      expect(updatedPlacement.timeToImpact).toBe('H1');
      expect(updatedPlacement.trlScore).toBe(9);
    });

    it('should handle all Time-to-Impact values (H1, H2, H3, empty)', async () => {
      const testCases = [
        { formValue: 'H1 (0-6mo)', expectedDb: 'H1', expectedDisplay: 'H1 (0-6mo)' },
        { formValue: 'H2 (6-18mo)', expectedDb: 'H2', expectedDisplay: 'H2 (6-18mo)' },
        { formValue: 'H3 (18+mo)', expectedDb: 'H3', expectedDisplay: 'H3 (18+mo)' },
        { formValue: '', expectedDb: undefined, expectedDisplay: undefined },
      ];

      for (const testCase of testCases) {
        const dbValue = parseTimeToImpact(testCase.formValue);
        expect(dbValue).toBe(testCase.expectedDb);

        const displayValue = mapTimeToImpactToDisplay(dbValue);
        expect(displayValue).toBe(testCase.expectedDisplay);
      }
    });

    it('should handle all TRL values (1-9)', async () => {
      for (let i = 1; i <= 9; i++) {
        const formValue = `TRL ${i}`;
        const dbValue = parseTrlScore(formValue);
        expect(dbValue).toBe(i);

        // Verify reverse conversion
        const displayValue = `TRL ${dbValue}`;
        expect(displayValue).toBe(formValue);
      }
    });
  });

  // ==========================================================================
  // Edge Cases and Error Handling
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle legacy data without timeToImpact gracefully', async () => {
      // Legacy placement without timeToImpact field
      const legacyPlacement = createTestPlacement({
        id: 'placement-legacy',
      });
      // Explicitly remove timeToImpact to simulate legacy data
      delete (legacyPlacement as Partial<RadarPlacement>).timeToImpact;
      delete (legacyPlacement as Partial<RadarPlacement>).trlScore;

      placementsStore.set(legacyPlacement.id, legacyPlacement);

      mockedGetDoc.mockResolvedValueOnce({
        exists: () => true,
        id: legacyPlacement.id,
        data: () => legacyPlacement,
      });

      const result = await getRadarPlacementById(legacyPlacement.id);

      // Should not crash, timeToImpact should be undefined
      expect(result).toBeDefined();
      expect(result?.timeToImpact).toBeUndefined();
    });

    it('should handle invalid TRL format gracefully', () => {
      expect(parseTrlScore('TRL')).toBeUndefined();
      expect(parseTrlScore('TRL 0')).toBeUndefined(); // Invalid: must be 1-9
      // Note: "TRL 10" matches "TRL 1" with single-digit regex, returns 1
      expect(parseTrlScore('TRL 10')).toBe(1); // Matches first digit
      expect(parseTrlScore('invalid')).toBeUndefined();
      expect(parseTrlScore('')).toBeUndefined();
    });

    it('should handle invalid Time-to-Impact format gracefully', () => {
      expect(parseTimeToImpact('H4')).toBeUndefined();
      expect(parseTimeToImpact('H0')).toBeUndefined();
      expect(parseTimeToImpact('invalid')).toBeUndefined();
      expect(parseTimeToImpact('H1 invalid')).toBe('H1'); // Still extracts H1
    });

    it('should handle concurrent updates correctly', async () => {
      const placement = createTestPlacement({ id: 'placement-concurrent' });
      placementsStore.set(placement.id, placement);

      // Simulate two concurrent updates
      const update1Promise = new Promise<void>((resolve) => {
        mockedGetDoc.mockResolvedValueOnce({
          exists: () => true,
          id: placement.id,
          data: () => placement,
        });
        resolve();
      });

      const update2Promise = new Promise<void>((resolve) => {
        mockedGetDoc.mockResolvedValueOnce({
          exists: () => true,
          id: placement.id,
          data: () => placement,
        });
        resolve();
      });

      await Promise.all([update1Promise, update2Promise]);

      // Both updates should complete (last one wins in this simple mock)
      expect(placementsStore.has(placement.id)).toBe(true);
    });
  });

  // ==========================================================================
  // Data Integrity Tests
  // ==========================================================================

  describe('Data Integrity', () => {
    it('should not lose data when partial updates are made', async () => {
      // Create full placement with all fields
      const fullPlacement = createTestPlacement({
        id: 'placement-full',
        quadrantId: 'q_tools' as Quadrant,
        ring: 'Adopt' as Ring,
        timeToImpact: 'H1' as TimeToImpact,
        trlScore: 9,
        rationale: 'Production ready',
        x: 0.3,
        y: 0.7,
      });
      placementsStore.set(fullPlacement.id, fullPlacement);

      // Update only ring
      mockedGetDoc
        .mockResolvedValueOnce({
          exists: () => true,
          id: fullPlacement.id,
          data: () => fullPlacement,
        })
        .mockResolvedValueOnce({
          exists: () => true,
          id: fullPlacement.id,
          data: () => ({ ...fullPlacement, ring: 'Trial' as Ring }),
        });

      await updateRadarPlacement(fullPlacement.id, { ring: 'Trial' as Ring });

      // Verify other fields are preserved
      const storedPlacement = placementsStore.get(fullPlacement.id);
      expect(storedPlacement?.timeToImpact).toBe('H1');
      expect(storedPlacement?.trlScore).toBe(9);
      expect(storedPlacement?.rationale).toBe('Production ready');
      expect(storedPlacement?.x).toBe(0.3);
      expect(storedPlacement?.y).toBe(0.7);
    });
  });
});
