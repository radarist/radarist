/**
 * Tests for lib/platform-config.ts
 */

import { createFirestoreMocks, createMockDocSnapshot } from './helpers/firestore-mock';

const firestoreMocks = createFirestoreMocks();
jest.mock('firebase/firestore', () => firestoreMocks);
jest.mock('@/lib/firebase', () => ({ db: {} }));

const { getPlatformConfig, updatePlatformConfig, resetPlatformConfig } =
  require('../platform-config');

const MOCK_DOC_REF = 'mock-doc-ref';

describe('platform-config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    firestoreMocks.doc.mockReturnValue(MOCK_DOC_REF);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // getPlatformConfig
  // ==========================================================================

  describe('getPlatformConfig', () => {
    it('should return stored config when document exists', async () => {
      const storedConfig = {
        archiveRetentionDays: 60,
        autoArchiveRejectedDays: 14,
        updatedAt: 1700000000000,
        updatedBy: 'admin@test.com',
      };
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(storedConfig));

      const result = await getPlatformConfig();

      expect(result).toEqual(storedConfig);
      expect(firestoreMocks.doc).toHaveBeenCalled();
    });

    it('should return defaults when document does not exist', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(null));

      const result = await getPlatformConfig();

      expect(result.archiveRetentionDays).toBe(90);
      expect(result.autoArchiveRejectedDays).toBe(30);
    });

    it('should return defaults on error', async () => {
      firestoreMocks.getDoc.mockRejectedValue(new Error('Network error'));

      const result = await getPlatformConfig();

      expect(result.archiveRetentionDays).toBe(90);
      expect(console.error).toHaveBeenCalled();
    });

    it('replaces unsafe persisted retention values with safe defaults', async () => {
      firestoreMocks.getDoc.mockResolvedValue(
        createMockDocSnapshot({
          archiveRetentionDays: -30,
          autoArchiveRejectedDays: 999,
          updatedAt: 1700000000000,
        })
      );

      const result = await getPlatformConfig();

      expect(result.archiveRetentionDays).toBe(90);
      expect(result.autoArchiveRejectedDays).toBe(30);
    });
  });

  // ==========================================================================
  // updatePlatformConfig
  // ==========================================================================

  describe('updatePlatformConfig', () => {
    it('should update existing config with updateDoc', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot({ archiveRetentionDays: 90 }));
      firestoreMocks.updateDoc.mockResolvedValue(undefined);

      await updatePlatformConfig({ archiveRetentionDays: 60 }, 'admin@test.com');

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          archiveRetentionDays: 60,
          updatedBy: 'admin@test.com',
        })
      );
    });

    it('should create config with setDoc when document does not exist', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot(null));
      firestoreMocks.setDoc.mockResolvedValue(undefined);

      await updatePlatformConfig({ archiveRetentionDays: 45 });

      expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          archiveRetentionDays: 45,
          autoArchiveRejectedDays: 30, // default merged
        })
      );
    });

    it('should include updatedAt timestamp', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot({ existing: true }));
      firestoreMocks.updateDoc.mockResolvedValue(undefined);

      await updatePlatformConfig({ archiveRetentionDays: 60 });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          updatedAt: expect.any(Number),
        })
      );
    });

    it('should not include updatedBy when not provided', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot({ existing: true }));
      firestoreMocks.updateDoc.mockResolvedValue(undefined);

      await updatePlatformConfig({ archiveRetentionDays: 60 });

      const updateArg = firestoreMocks.updateDoc.mock.calls[0][1];
      expect(updateArg.updatedBy).toBeUndefined();
    });

    it('should throw on error', async () => {
      firestoreMocks.getDoc.mockRejectedValue(new Error('Permission denied'));

      await expect(updatePlatformConfig({ archiveRetentionDays: 60 }))
        .rejects.toThrow('Failed to update platform config');
    });

    it.each([0, -1, 7.5, 366, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects unsafe archiveRetentionDays value %s before reading Firestore',
      async (archiveRetentionDays) => {
        await expect(updatePlatformConfig({ archiveRetentionDays })).rejects.toThrow(
          'archiveRetentionDays must be a whole number between 7 and 365'
        );
        expect(firestoreMocks.getDoc).not.toHaveBeenCalled();
      }
    );

    it.each([-1, 1.5, 366, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects unsafe legacy autoArchiveRejectedDays value %s before reading Firestore',
      async (autoArchiveRejectedDays) => {
        await expect(updatePlatformConfig({ autoArchiveRejectedDays })).rejects.toThrow(
          'autoArchiveRejectedDays must be a whole number between 0 and 365'
        );
        expect(firestoreMocks.getDoc).not.toHaveBeenCalled();
      }
    );

    it('accepts zero for the legacy auto-archive field without exposing a no-op UI control', async () => {
      firestoreMocks.getDoc.mockResolvedValue(createMockDocSnapshot({ autoArchiveRejectedDays: 30 }));
      firestoreMocks.updateDoc.mockResolvedValue(undefined);

      await updatePlatformConfig({ autoArchiveRejectedDays: 0 });

      expect(firestoreMocks.updateDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ autoArchiveRejectedDays: 0 })
      );
    });
  });

  // ==========================================================================
  // resetPlatformConfig
  // ==========================================================================

  describe('resetPlatformConfig', () => {
    it('should reset to defaults with setDoc', async () => {
      firestoreMocks.setDoc.mockResolvedValue(undefined);

      await resetPlatformConfig('admin@test.com');

      expect(firestoreMocks.setDoc).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          archiveRetentionDays: 90,
          autoArchiveRejectedDays: 30,
          updatedBy: 'admin@test.com',
        })
      );
    });

    it('should reset without updatedBy when not provided', async () => {
      firestoreMocks.setDoc.mockResolvedValue(undefined);

      await resetPlatformConfig();

      const setDocArg = firestoreMocks.setDoc.mock.calls[0][1];
      expect(setDocArg.updatedBy).toBeUndefined();
    });

    it('should throw on error', async () => {
      firestoreMocks.setDoc.mockRejectedValue(new Error('Write failed'));

      await expect(resetPlatformConfig()).rejects.toThrow('Failed to reset platform config');
    });
  });
});
