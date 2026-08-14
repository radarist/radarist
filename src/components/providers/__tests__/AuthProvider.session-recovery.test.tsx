/**
 * @file AuthProvider.session-recovery.test.tsx
 * @description UX-056 — the sign-in transition raised by a stale credential.
 *
 * `fetch-with-auth` can detect a revoked credential but must never navigate;
 * `AuthProvider` owns that. These cases pin the handoff: one transition per
 * event, stale client session state actually cleared, and the operator landing
 * somewhere that explains why.
 */

import { render } from '@testing-library/react';
import { act } from 'react';
import type { User } from 'firebase/auth';

const mockPush = jest.fn();
const mockReplace = jest.fn();

let mockPathname = '/dashboard';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace, back: jest.fn() }),
  usePathname: () => mockPathname,
}));

let onAuthStateChangedCallback: ((user: User | null) => void) | null = null;
const mockSignOut = jest.fn().mockResolvedValue(undefined);

jest.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: User | null) => void) => {
    onAuthStateChangedCallback = cb;
    return jest.fn();
  },
  signInWithEmailAndPassword: jest.fn().mockResolvedValue(undefined),
  createUserWithEmailAndPassword: jest.fn(),
  signInWithPopup: jest.fn(),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  GoogleAuthProvider: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import {
  clearAuthSessionRecovery,
  pendingAuthSessionRecovery,
  requestAuthSessionRecovery,
} from '@/lib/auth-session-recovery';
import { AUTH_SESSION_EXPIRED_QUERY } from '@/lib/auth-failure';
import { AuthProvider } from '../AuthProvider';

const signedInUser = { uid: 'user-1', email: 'operator@example.com' } as unknown as User;

/** Mount the provider with an authenticated session already established. */
async function mountSignedIn(): Promise<void> {
  render(
    <AuthProvider>
      <div>workspace</div>
    </AuthProvider>
  );
  await act(async () => {
    onAuthStateChangedCallback?.(signedInUser);
  });
}

describe('AuthProvider stale-credential transition (UX-056)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAuthSessionRecovery();
    mockPathname = '/dashboard';
    onAuthStateChangedCallback = null;
  });

  it('clears the stale session and routes to an explained sign-in', async () => {
    await mountSignedIn();

    await act(async () => {
      requestAuthSessionRecovery('token-revoked');
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith(`/login?${AUTH_SESSION_EXPIRED_QUERY}=token-revoked`);
  });

  it('navigates once even when many requests report the same stale credential', async () => {
    await mountSignedIn();

    await act(async () => {
      requestAuthSessionRecovery('token-revoked');
      requestAuthSessionRecovery('token-revoked');
      requestAuthSessionRecovery('token-expired');
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('still reaches the sign-in screen when clearing the session fails', async () => {
    // A failed sign-out must not strand the operator on a workspace that cannot
    // load any data — the navigation is what makes the state recoverable.
    mockSignOut.mockRejectedValueOnce(new Error('offline'));
    await mountSignedIn();

    await act(async () => {
      requestAuthSessionRecovery('token-revoked');
    });

    expect(mockReplace).toHaveBeenCalledWith(`/login?${AUTH_SESSION_EXPIRED_QUERY}=token-revoked`);
  });

  it('re-arms the latch on a fresh sign-in so a later expiry transitions again', async () => {
    await mountSignedIn();
    await act(async () => {
      requestAuthSessionRecovery('token-revoked');
    });
    expect(pendingAuthSessionRecovery()).toBe('token-revoked');

    // A real session exists again.
    await act(async () => {
      onAuthStateChangedCallback?.(signedInUser);
    });

    expect(pendingAuthSessionRecovery()).toBeNull();
  });

  it('does not transition while already on a public path', async () => {
    mockPathname = '/login';
    render(
      <AuthProvider>
        <div>login</div>
      </AuthProvider>
    );
    await act(async () => {
      onAuthStateChangedCallback?.(null);
    });
    mockReplace.mockClear();
    mockSignOut.mockClear();

    await act(async () => {
      requestAuthSessionRecovery('token-revoked');
    });

    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
