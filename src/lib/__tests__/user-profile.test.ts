/**
 * @file user-profile.test.ts
 * @description UX-062 — pins the owner-profile reader: owner-scoped doc read,
 * null when no doc exists (fresh signup), and defensive coercion of malformed
 * legacy fields so a non-string can never reach an identity surface.
 *
 * @jest-environment node
 */

import { createFirebaseAdminMock } from '@/lib/__tests__/helpers/firebase-admin-mock';

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const { adminMock } = createFirebaseAdminMock();
jest.mock('@/lib/firebase-admin', () => ({ __esModule: true, db: adminMock.db }));

// `require` (not `import`) — the firebase-admin mock factory closes over
// `adminMock`, so the SUT must evaluate AFTER that const is initialized
// (see signals-autopilot-admin.test.ts / document-refresh-admin.test.ts TDZ note).
const { getOwnerProfile } = require('../user-profile') as { getOwnerProfile: typeof import('../user-profile')['getOwnerProfile'] };

describe('getOwnerProfile (UX-062)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reads the users/{uid} doc for the given owner uid', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ displayName: 'Real Operator', email: 'real@example.com', photoURL: 'https://img/x.png' }),
    });

    const profile = await getOwnerProfile('uid-1');

    expect(adminMock.collection).toHaveBeenCalledWith('users');
    expect(adminMock.doc).toHaveBeenCalledWith('uid-1');
    expect(profile).toEqual({
      uid: 'uid-1',
      displayName: 'Real Operator',
      email: 'real@example.com',
      photoURL: 'https://img/x.png',
    });
  });

  it('returns null when no owner doc exists (fresh signup, not seeded)', async () => {
    adminMock.docGet.mockResolvedValue({ exists: false, data: () => null });

    const profile = await getOwnerProfile('uid-fresh');

    expect(profile).toBeNull();
  });

  it('coerces malformed legacy fields to null instead of surfacing non-strings', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ displayName: 12345, email: { not: 'a string' }, photoURL: '   ' }),
    });

    const profile = await getOwnerProfile('uid-bad');

    expect(profile).toEqual({ uid: 'uid-bad', displayName: null, email: null, photoURL: null });
  });

  it('treats empty/whitespace-only string fields as null', async () => {
    adminMock.docGet.mockResolvedValue({
      exists: true,
      data: () => ({ displayName: '   ', email: 'kept@example.com', photoURL: '' }),
    });

    const profile = await getOwnerProfile('uid-ws');

    expect(profile).toEqual({ uid: 'uid-ws', displayName: null, email: 'kept@example.com', photoURL: null });
  });

  it('wraps a Firestore failure in a descriptive error', async () => {
    adminMock.docGet.mockRejectedValue(new Error('boom'));

    await expect(getOwnerProfile('uid-err')).rejects.toThrow('Failed to read owner profile: boom');
  });
});
