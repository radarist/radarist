/** @jest-environment node */

import { createFirebaseAdminMock, fakeDocSnapshot } from './helpers/firebase-admin-mock';

const { adminMock } = createFirebaseAdminMock();

jest.mock('@/lib/firebase-admin', () => ({ db: adminMock.db }));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const { adminGetPlatformConfig } = require('../platform-config-admin') as typeof import('../platform-config-admin');

describe('platform-config-admin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects an unsafe persisted retention policy before a worker can consume it', async () => {
    adminMock.docGet.mockResolvedValue(
      fakeDocSnapshot({
        archiveRetentionDays: 0,
        autoArchiveRejectedDays: -1,
        updatedAt: 1700000000000,
      })
    );

    await expect(adminGetPlatformConfig()).rejects.toThrow('Invalid persisted archiveRetentionDays');
  });

  it('preserves valid boundary values', async () => {
    adminMock.docGet.mockResolvedValue(
      fakeDocSnapshot({
        archiveRetentionDays: 7,
        autoArchiveRejectedDays: 0,
        updatedAt: 1700000000000,
      })
    );

    const config = await adminGetPlatformConfig();

    expect(config.archiveRetentionDays).toBe(7);
    expect(config.autoArchiveRejectedDays).toBe(0);
  });

  it('fails closed when Firestore cannot read the policy', async () => {
    adminMock.docGet.mockRejectedValue(new Error('Firestore unavailable'));

    await expect(adminGetPlatformConfig()).rejects.toThrow('Firestore unavailable');
  });

  it('uses the default only when no platform policy exists', async () => {
    adminMock.docGet.mockResolvedValue({ exists: false, data: () => undefined });

    await expect(adminGetPlatformConfig()).resolves.toMatchObject({ archiveRetentionDays: 90 });
  });
});
