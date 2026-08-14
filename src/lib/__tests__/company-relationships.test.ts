/**
 * Unit Tests for Company Relationships Module
 *
 * Tests company-blip relationship CRUD operations:
 * - linkCompanyToBlip - Creates a relationship
 * - unlinkCompanyFromBlip - Deletes by relationship ID
 * - unlinkCompanyFromBlipByIds - Deletes by company/radar/entry IDs
 * - updateRelationship - Updates relationship fields
 * - getRelationshipsByCompanyId - Queries by company
 * - getRelationshipsByBlipId - Queries by blip
 * - getRelationshipsByCompanyAndBlip - Queries by company + blip
 * - getRelationshipById - Fetches single relationship
 * - getRelationshipsByRadarId - Queries by radar
 * - relationshipExists - Checks existence
 *
 * @jest-environment node
 */

import {
  createFirestoreMocks,
  createMockDocSnapshot,
  createMockQuerySnapshot,
} from './helpers/firestore-mock';

import type { CompanyBlipRelationship } from '../types';

// =============================================================================
// MOCKS
// =============================================================================

const firestoreMocks = createFirestoreMocks();
jest.mock('firebase/firestore', () => ({
  ...firestoreMocks.factory,
  Timestamp: { now: jest.fn(() => ({ toMillis: () => Date.now() })) },
}));

jest.mock('../firebase', () => ({
  db: {},
  removeUndefinedFields: jest.fn((obj: Record<string, unknown>) => {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }),
}));

// Dynamic import after mocks
const {
  linkCompanyToBlip,
  unlinkCompanyFromBlip,
  unlinkCompanyFromBlipByIds,
  updateRelationship,
  getRelationshipsByCompanyId,
  getRelationshipsByBlipId,
  getRelationshipsByCompanyAndBlip,
  getRelationshipById,
  getRelationshipsByRadarId,
  relationshipExists,
} = require('../company-relationships');

// =============================================================================
// HELPERS
// =============================================================================

function createMockRelationship(overrides: Partial<CompanyBlipRelationship> = {}): CompanyBlipRelationship {
  return {
    id: 'rel-1',
    companyId: 'company-1',
    radarId: 'radar-1',
    radarEntryId: 42,
    relationshipType: 'Vendor',
    notes: 'Test notes',
    useCaseIds: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('CompanyRelationships', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // linkCompanyToBlip
  // ---------------------------------------------------------------------------

  describe('linkCompanyToBlip', () => {
    it('should create a relationship and write to Firestore', async () => {
      firestoreMocks.setDoc.mockResolvedValue(undefined);

      const result = await linkCompanyToBlip(
        'company-1',
        'radar-1',
        42,
        'Vendor',
        'Some notes',
        ['uc-1']
      );

      expect(result.companyId).toBe('company-1');
      expect(result.radarId).toBe('radar-1');
      expect(result.radarEntryId).toBe(42);
      expect(result.relationshipType).toBe('Vendor');
      expect(result.notes).toBe('Some notes');
      expect(result.useCaseIds).toEqual(['uc-1']);
      expect(result.id).toContain('company-1-radar-1-42-');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();
      expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(1);
    });

    it('should use default values for optional parameters', async () => {
      firestoreMocks.setDoc.mockResolvedValue(undefined);

      const result = await linkCompanyToBlip('c-1', 'r-1', 1, 'User');

      expect(result.notes).toBe('');
      expect(result.useCaseIds).toEqual([]);
    });

    it('should propagate Firestore errors', async () => {
      firestoreMocks.setDoc.mockRejectedValue(new Error('Firestore write failed'));

      await expect(
        linkCompanyToBlip('c-1', 'r-1', 1, 'Vendor')
      ).rejects.toThrow('Firestore write failed');
    });
  });

  // ---------------------------------------------------------------------------
  // unlinkCompanyFromBlip
  // ---------------------------------------------------------------------------

  describe('unlinkCompanyFromBlip', () => {
    it('should delete the relationship document', async () => {
      firestoreMocks.deleteDoc.mockResolvedValue(undefined);

      await unlinkCompanyFromBlip('rel-123');

      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
    });

    it('should propagate Firestore errors', async () => {
      firestoreMocks.deleteDoc.mockRejectedValue(new Error('Delete failed'));

      await expect(unlinkCompanyFromBlip('rel-123')).rejects.toThrow('Delete failed');
    });
  });

  // ---------------------------------------------------------------------------
  // unlinkCompanyFromBlipByIds
  // ---------------------------------------------------------------------------

  describe('unlinkCompanyFromBlipByIds', () => {
    it('should delete all matching relationships and return count', async () => {
      const rel1 = createMockRelationship({ id: 'rel-1' });
      const rel2 = createMockRelationship({ id: 'rel-2' });

      firestoreMocks.getDocs.mockResolvedValue(
        createMockQuerySnapshot([rel1, rel2])
      );
      firestoreMocks.deleteDoc.mockResolvedValue(undefined);

      const count = await unlinkCompanyFromBlipByIds('company-1', 'radar-1', 42);

      expect(count).toBe(2);
      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(2);
    });

    it('should return 0 when no matching relationships', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const count = await unlinkCompanyFromBlipByIds('company-x', 'radar-x', 999);

      expect(count).toBe(0);
      expect(firestoreMocks.deleteDoc).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // updateRelationship
  // ---------------------------------------------------------------------------

  describe('updateRelationship', () => {
    it('should update the relationship document with updatedAt', async () => {
      firestoreMocks.updateDoc.mockResolvedValue(undefined);

      await updateRelationship('rel-1', {
        relationshipType: 'Partner',
        notes: 'Updated notes',
      });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });

    it('should propagate Firestore errors', async () => {
      firestoreMocks.updateDoc.mockRejectedValue(new Error('Update failed'));

      await expect(
        updateRelationship('rel-1', { notes: 'test' })
      ).rejects.toThrow('Update failed');
    });
  });

  // ---------------------------------------------------------------------------
  // getRelationshipsByCompanyId
  // ---------------------------------------------------------------------------

  describe('getRelationshipsByCompanyId', () => {
    it('should return relationships for the company', async () => {
      const rel = createMockRelationship();
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([rel]));

      const result = await getRelationshipsByCompanyId('company-1');

      expect(result).toHaveLength(1);
      expect(result[0].companyId).toBe('company-1');
      expect(firestoreMocks.where).toHaveBeenCalledWith('companyId', '==', 'company-1');
    });

    it('should return empty array when no relationships exist', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getRelationshipsByCompanyId('company-x');

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getRelationshipsByBlipId
  // ---------------------------------------------------------------------------

  describe('getRelationshipsByBlipId', () => {
    it('should return relationships for the blip', async () => {
      const rel = createMockRelationship();
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([rel]));

      const result = await getRelationshipsByBlipId('radar-1', 42);

      expect(result).toHaveLength(1);
      expect(firestoreMocks.where).toHaveBeenCalledWith('radarId', '==', 'radar-1');
      expect(firestoreMocks.where).toHaveBeenCalledWith('radarEntryId', '==', 42);
    });

    it('should return empty array when no relationships exist', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getRelationshipsByBlipId('radar-x', 999);

      expect(result).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getRelationshipsByCompanyAndBlip
  // ---------------------------------------------------------------------------

  describe('getRelationshipsByCompanyAndBlip', () => {
    it('should return relationships matching company and blip', async () => {
      const rel = createMockRelationship();
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([rel]));

      const result = await getRelationshipsByCompanyAndBlip('company-1', 'radar-1', 42);

      expect(result).toHaveLength(1);
      expect(firestoreMocks.where).toHaveBeenCalledWith('companyId', '==', 'company-1');
      expect(firestoreMocks.where).toHaveBeenCalledWith('radarId', '==', 'radar-1');
      expect(firestoreMocks.where).toHaveBeenCalledWith('radarEntryId', '==', 42);
    });
  });

  // ---------------------------------------------------------------------------
  // getRelationshipById
  // ---------------------------------------------------------------------------

  describe('getRelationshipById', () => {
    it('should return the relationship when found', async () => {
      const rel = createMockRelationship();
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(rel, 'rel-1'));

      const result = await getRelationshipById('rel-1');

      expect(result).not.toBeNull();
      expect(result.companyId).toBe('company-1');
    });

    it('should return null when not found', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(null));

      const result = await getRelationshipById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getRelationshipsByRadarId
  // ---------------------------------------------------------------------------

  describe('getRelationshipsByRadarId', () => {
    it('should return all relationships for the radar', async () => {
      const rels = [
        createMockRelationship({ id: 'rel-1' }),
        createMockRelationship({ id: 'rel-2', companyId: 'company-2' }),
      ];
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot(rels));

      const result = await getRelationshipsByRadarId('radar-1');

      expect(result).toHaveLength(2);
      expect(firestoreMocks.where).toHaveBeenCalledWith('radarId', '==', 'radar-1');
    });
  });

  // ---------------------------------------------------------------------------
  // relationshipExists
  // ---------------------------------------------------------------------------

  describe('relationshipExists', () => {
    it('should return true when relationships exist', async () => {
      const rel = createMockRelationship();
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([rel]));

      const exists = await relationshipExists('company-1', 'radar-1', 42);

      expect(exists).toBe(true);
    });

    it('should return false when no relationships exist', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const exists = await relationshipExists('company-x', 'radar-x', 999);

      expect(exists).toBe(false);
    });

    it('should filter by relationship type when provided', async () => {
      const rel = createMockRelationship({ relationshipType: 'Vendor' });
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([rel]));

      const isVendor = await relationshipExists('company-1', 'radar-1', 42, 'Vendor');
      expect(isVendor).toBe(true);
    });

    it('should return false when type does not match', async () => {
      const rel = createMockRelationship({ relationshipType: 'Vendor' });
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([rel]));

      const isPartner = await relationshipExists('company-1', 'radar-1', 42, 'Partner');
      expect(isPartner).toBe(false);
    });
  });
});
