/**
 * Unit Tests for Contacts Module
 *
 * Tests CRUD operations for Contacts (company subcollection):
 * - getContactsByCompanyId - Lists contacts for a company
 * - getContactById - Retrieves a single contact
 * - createContact - Creates a contact with auto-generated ID
 * - updateContact - Updates contact fields
 * - deleteContact - Removes a contact
 * - setPrimaryContact - Sets a contact as primary (unsets others)
 * - getPrimaryContact - Returns the primary contact for a company
 *
 * @jest-environment node
 */

import type { Contact } from '../types';
import {
  createFirestoreMocks,
  createMockDocSnapshot,
  createMockQuerySnapshot,
} from './helpers/firestore-mock';

// ============================================================================
// MOCKS
// ============================================================================

const firestoreMocks = createFirestoreMocks();

jest.mock('firebase/firestore', () => firestoreMocks);
jest.mock('@/lib/firebase', () => ({
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

// Import AFTER mocks
const {
  getContactsByCompanyId,
  getContactById,
  createContact,
  updateContact,
  deleteContact,
  setPrimaryContact,
  getPrimaryContact,
} = require('../contacts') as typeof import('../contacts');

// ============================================================================
// HELPERS
// ============================================================================

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    companyId: 'company-1',
    name: 'John Doe',
    role: 'CTO',
    email: 'john@example.com',
    phone: '+1-555-0100',
    linkedin: 'https://linkedin.com/in/johndoe',
    notes: 'Met at conference',
    isPrimary: false,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('contacts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    firestoreMocks.setDoc.mockResolvedValue(undefined);
    firestoreMocks.updateDoc.mockResolvedValue(undefined);
    firestoreMocks.deleteDoc.mockResolvedValue(undefined);
  });

  // --------------------------------------------------------------------------
  // getContactsByCompanyId
  // --------------------------------------------------------------------------

  describe('getContactsByCompanyId', () => {
    it('should return all contacts for a company', async () => {
      const contacts = [
        makeContact({ id: 'c-1', name: 'Alice' }),
        makeContact({ id: 'c-2', name: 'Bob' }),
      ];
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot(contacts));

      const result = await getContactsByCompanyId('company-1');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Alice');
      expect(result[1].name).toBe('Bob');
      expect(firestoreMocks.collection).toHaveBeenCalledWith(
        {},
        'companies',
        'company-1',
        'contacts'
      );
    });

    it('should return empty array when no contacts exist', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getContactsByCompanyId('company-empty');

      expect(result).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // getContactById
  // --------------------------------------------------------------------------

  describe('getContactById', () => {
    it('should return contact when found', async () => {
      const contact = makeContact({ id: 'c-1' });
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(contact));

      const result = await getContactById('company-1', 'c-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('c-1');
      expect(result!.name).toBe('John Doe');
    });

    it('should return null when contact not found', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(null));

      const result = await getContactById('company-1', 'nonexistent');

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // createContact
  // --------------------------------------------------------------------------

  describe('createContact', () => {
    it('should create a contact with generated ID and timestamps', async () => {
      // No existing primary contacts
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await createContact('company-1', {
        name: 'Jane Smith',
        role: 'VP Engineering',
        email: 'jane@example.com',
        notes: 'New hire',
        isPrimary: false,
      });

      expect(result.companyId).toBe('company-1');
      expect(result.name).toBe('Jane Smith');
      expect(result.id).toContain('jane-smith-');
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBeGreaterThan(0);
      expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(1);
    });

    it('should generate slug-style ID from contact name', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await createContact('company-1', {
        name: 'John O\'Brien III',
        role: 'CEO',
        email: 'john@example.com',
        notes: '',
        isPrimary: false,
      });

      // Should strip special chars, keep alphanumeric and hyphens
      expect(result.id).toMatch(/^john-obrien-iii-\d+$/);
    });

    it('should unset other primary contacts when creating a primary contact', async () => {
      const existingPrimary = makeContact({ id: 'existing-primary', isPrimary: true });
      firestoreMocks.getDocs.mockResolvedValue(
        createMockQuerySnapshot([existingPrimary])
      );

      await createContact('company-1', {
        name: 'New Primary',
        role: 'Director',
        email: 'new@example.com',
        notes: '',
        isPrimary: true,
      });

      // updateDoc should have been called to unset old primary
      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ isPrimary: false })
      );
      // setDoc should have been called for the new contact
      expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(1);
    });

    it('should not unset primary contacts when isPrimary is false', async () => {
      await createContact('company-1', {
        name: 'Regular Contact',
        role: 'Engineer',
        email: 'regular@example.com',
        notes: '',
        isPrimary: false,
      });

      // getDocs should NOT be called (no primary unset needed)
      expect(firestoreMocks.getDocs).not.toHaveBeenCalled();
      expect(firestoreMocks.setDoc).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // updateContact
  // --------------------------------------------------------------------------

  describe('updateContact', () => {
    it('should update contact fields and set updatedAt', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      await updateContact('company-1', 'c-1', {
        role: 'Senior Engineer',
      });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          role: 'Senior Engineer',
          updatedAt: expect.any(Number),
        })
      );
    });

    it('should unset other primaries when setting isPrimary to true', async () => {
      const existingPrimary = makeContact({ id: 'old-primary', isPrimary: true });
      firestoreMocks.getDocs.mockResolvedValue(
        createMockQuerySnapshot([existingPrimary])
      );

      await updateContact('company-1', 'c-1', { isPrimary: true });

      // Should call updateDoc at least twice: once for unsetting old primary, once for the update
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(2);
    });

    it('should not unset primaries when isPrimary is not being changed', async () => {
      await updateContact('company-1', 'c-1', { role: 'Manager' });

      // getDocs should not be called (no primary logic)
      expect(firestoreMocks.getDocs).not.toHaveBeenCalled();
      // Only one updateDoc call for the actual update
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // deleteContact
  // --------------------------------------------------------------------------

  describe('deleteContact', () => {
    it('should delete a contact document', async () => {
      await deleteContact('company-1', 'c-1');

      expect(firestoreMocks.deleteDoc).toHaveBeenCalledTimes(1);
      expect(firestoreMocks.doc).toHaveBeenCalledWith(
        {},
        'companies',
        'company-1',
        'contacts',
        'c-1'
      );
    });
  });

  // --------------------------------------------------------------------------
  // setPrimaryContact
  // --------------------------------------------------------------------------

  describe('setPrimaryContact', () => {
    it('should set a contact as primary (delegates to updateContact)', async () => {
      const existingPrimary = makeContact({ id: 'old-primary', isPrimary: true });
      firestoreMocks.getDocs.mockResolvedValue(
        createMockQuerySnapshot([existingPrimary])
      );

      await setPrimaryContact('company-1', 'c-1');

      // Should unset old primary and then update the target
      expect(firestoreMocks.updateDoc).toHaveBeenCalledTimes(2);
    });
  });

  // --------------------------------------------------------------------------
  // getPrimaryContact
  // --------------------------------------------------------------------------

  describe('getPrimaryContact', () => {
    it('should return the primary contact', async () => {
      const contacts = [
        makeContact({ id: 'c-1', isPrimary: false }),
        makeContact({ id: 'c-2', isPrimary: true, name: 'Primary Person' }),
      ];
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot(contacts));

      const result = await getPrimaryContact('company-1');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('Primary Person');
      expect(result!.isPrimary).toBe(true);
    });

    it('should return null when no primary contact exists', async () => {
      const contacts = [
        makeContact({ id: 'c-1', isPrimary: false }),
        makeContact({ id: 'c-2', isPrimary: false }),
      ];
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot(contacts));

      const result = await getPrimaryContact('company-1');

      expect(result).toBeNull();
    });

    it('should return null when no contacts exist', async () => {
      firestoreMocks.getDocs.mockResolvedValue(createMockQuerySnapshot([]));

      const result = await getPrimaryContact('company-empty');

      expect(result).toBeNull();
    });
  });
});
