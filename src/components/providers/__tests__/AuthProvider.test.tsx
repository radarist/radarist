/**
 * @file AuthProvider.test.tsx
 * @description Integration test for the client-side auth redirect contract.
 *
 * Closes US-01 gap (G10): /login -> /dashboard for authenticated users and
 * /dashboard -> /login for unauthenticated users. The redirect lives in
 * AuthProvider.tsx (NOT middleware - middleware is API-only).
 *
 * Strategy: capture the onAuthStateChanged callback so each test drives the
 * auth state transition manually inside act(). usePathname is a mutable
 * module-scope variable so per-test the pathname can be flipped before render.
 */

import { render } from '@testing-library/react';
import { act } from 'react';
import type { User } from 'firebase/auth';

// ============================================================================
// Mocks (must be declared before importing the SUT)
// ============================================================================

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockBack = jest.fn();

let mockPathname = '/login';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: mockBack }),
  usePathname: () => mockPathname,
}));

let onAuthStateChangedCallback: ((user: User | null) => void) | null = null;
const mockUnsubscribe = jest.fn();

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: User | null) => void) => {
    onAuthStateChangedCallback = cb;
    return mockUnsubscribe;
  },
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithPopup: jest.fn(),
  signOut: jest.fn(),
  GoogleAuthProvider: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@/lib/firebase', () => ({
  auth: {},
  db: {},
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// Import AFTER mocks so the SUT picks them up.
import { AuthProvider } from '../AuthProvider';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a minimal User-shaped object. The redirect logic only checks truthy
 * vs null, so this is sufficient for behavioral assertions.
 */
function makeMockUser(): User {
  return {
    uid: 'test-user-uid',
    email: 'test@example.com',
    emailVerified: true,
    displayName: 'Test User',
    isAnonymous: false,
    photoURL: null,
    providerData: [],
    refreshToken: 'test-refresh-token',
    tenantId: null,
    metadata: {
      creationTime: undefined,
      lastSignInTime: undefined,
    },
    phoneNumber: null,
    providerId: 'firebase',
    delete: jest.fn(),
    getIdToken: jest.fn(),
    getIdTokenResult: jest.fn(),
    reload: jest.fn(),
    toJSON: jest.fn(),
  } as unknown as User;
}

// ============================================================================
// Tests
// ============================================================================

describe('AuthProvider redirect behavior', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockBack.mockClear();
    mockUnsubscribe.mockClear();
    onAuthStateChangedCallback = null;
  });

  it('redirects authenticated user from /login to /dashboard', () => {
    mockPathname = '/login';

    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>
    );

    expect(onAuthStateChangedCallback).not.toBeNull();

    act(() => {
      onAuthStateChangedCallback?.(makeMockUser());
    });

    expect(mockPush).toHaveBeenCalledWith('/dashboard');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('redirects unauthenticated user from /dashboard to /login', () => {
    mockPathname = '/dashboard';

    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>
    );

    expect(onAuthStateChangedCallback).not.toBeNull();

    act(() => {
      onAuthStateChangedCallback?.(null);
    });

    expect(mockPush).toHaveBeenCalledWith('/login');
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('keeps unauthenticated user on /login', () => {
    mockPathname = '/login';

    render(
      <AuthProvider>
        <div>child</div>
      </AuthProvider>
    );

    expect(onAuthStateChangedCallback).not.toBeNull();

    act(() => {
      onAuthStateChangedCallback?.(null);
    });

    expect(mockPush).not.toHaveBeenCalled();
  });
});
