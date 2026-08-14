'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import {
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  createUserWithEmailAndPassword,
} from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useRouter, usePathname } from 'next/navigation';
import { createLogger } from '@/lib/logger';
import { AUTH_SESSION_EXPIRED_QUERY, type AuthFailureReason } from '@/lib/auth-failure';
import { clearAuthSessionRecovery, onAuthSessionRecovery } from '@/lib/auth-session-recovery';

const log = createLogger('ui/AuthProvider');

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// AUDIT-012: '/forgot-password' removed — no such route or link exists.
const PUBLIC_PATHS = ['/login', '/signup'];
const PUBLIC_PATH_PREFIXES = ['/share']; // Paths that allow unauthenticated access via prefix match

/**
 * Checks if a pathname is public (doesn't require authentication)
 */
function isPublicPath(pathname: string): boolean {
  // Exact match for auth pages
  if (PUBLIC_PATHS.includes(pathname)) return true;
  // Prefix match for shared content (e.g., /share/[radarId])
  if (PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true;
  return false;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);

      // UX-056: a real session exists again, so re-arm the recovery latch — a
      // later expiry must be able to raise its own transition.
      if (user) clearAuthSessionRecovery();

      // Redirect logic
      if (!user && !isPublicPath(pathname)) {
        router.push('/login');
      } else if (user && PUBLIC_PATHS.includes(pathname)) {
        // Only redirect from auth pages (login/signup), not from shared content
        router.push('/dashboard');
      }
    });

    return () => unsubscribe();
  }, [pathname, router]);

  // UX-056 — the sign-in transition for a server-confirmed stale credential.
  //
  // `fetch-with-auth` detects the condition but must not navigate; this is the
  // one place that acts on it. The latch in `auth-session-recovery` guarantees a
  // single transition no matter how many concurrent requests reported the same
  // 401, which is what keeps a retained browser from thrashing between screens.
  useEffect(() => {
    if (isPublicPath(pathname)) return;

    return onAuthSessionRecovery((reason: AuthFailureReason) => {
      log.warn('clearing a stale local session', { reason });
      // Navigate regardless of the sign-out result. A failed sign-out would
      // otherwise strand the operator on a workspace where every request 401s
      // and nothing explains why; the redirect is what makes it recoverable.
      void firebaseSignOut(auth).catch((error: unknown) => {
        log.error('could not clear the stale session', error instanceof Error ? error : undefined);
      });
      router.replace(`/login?${AUTH_SESSION_EXPIRED_QUERY}=${encodeURIComponent(reason)}`);
    });
  }, [pathname, router]);

  const signIn = async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      router.push('/dashboard');
    } catch (error) {
      log.error('Sign in failed', error instanceof Error ? error : undefined);
      throw error;
    }
  };

  const signUp = async (email: string, password: string) => {
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      router.push('/dashboard');
    } catch (error) {
      log.error('Sign up failed', error instanceof Error ? error : undefined);
      throw error;
    }
  };

  const signInWithGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      router.push('/dashboard');
    } catch (error) {
      log.error('Google sign in failed', error instanceof Error ? error : undefined);
      throw error;
    }
  };

  const signOut = async () => {
    try {
      await firebaseSignOut(auth);
      router.push('/login');
    } catch (error) {
      log.error('Sign out failed', error instanceof Error ? error : undefined);
      throw error;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signIn,
        signUp,
        signInWithGoogle,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
