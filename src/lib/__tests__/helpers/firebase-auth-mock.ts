/**
 * Shared Firebase Auth mock helper
 *
 * Usage:
 *   const { firebaseAdminMock, mockVerifyIdToken } = createFirebaseAuthMock();
 *   jest.mock('@/lib/firebase-admin', () => firebaseAdminMock);
 */

export interface MockUser {
  uid: string;
  email?: string;
  name?: string;
}

export function createFirebaseAuthMock(defaultUser?: MockUser) {
  const user: MockUser = defaultUser ?? { uid: 'test-user-id', email: 'test@example.com' };

  const mockVerifyIdToken = jest.fn().mockResolvedValue({
    uid: user.uid,
    email: user.email,
    name: user.name,
  });

  const firebaseAdminMock = {
    adminAuth: {
      verifyIdToken: mockVerifyIdToken,
    },
    adminDb: {},
  };

  return {
    firebaseAdminMock,
    mockVerifyIdToken,
    setUser: (newUser: MockUser) => {
      mockVerifyIdToken.mockResolvedValue({
        uid: newUser.uid,
        email: newUser.email,
        name: newUser.name,
      });
    },
  };
}
