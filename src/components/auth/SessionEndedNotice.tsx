'use client';

import { useSearchParams } from 'next/navigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { AUTH_SESSION_EXPIRED_QUERY, authFailureMessage, parseAuthFailureReason } from '@/lib/auth-failure';

/**
 * UX-056 — why the previous session ended, shown on the sign-in screen.
 *
 * Its own component, and its own file, for a build reason: `useSearchParams()`
 * opts a page out of static prerendering unless it sits inside a Suspense
 * boundary. Calling it directly in `LoginPage` failed the production build with
 * `useSearchParams() should be wrapped in a suspense boundary at page "/login"`.
 * Isolating the hook here lets `/login` stay prerendered while this fragment
 * resolves on the client.
 *
 * The reason is parsed through the closed reason set, so a hand-edited or stale
 * URL cannot put arbitrary text on the sign-in screen, and the copy comes from
 * the shared message table rather than the query parameter.
 */
export function SessionEndedNotice() {
  const searchParams = useSearchParams();
  const reason = parseAuthFailureReason(searchParams?.get(AUTH_SESSION_EXPIRED_QUERY));
  if (!reason) return null;

  return (
    <Alert role="status" className="bg-amber-500/20 border-amber-400/30 text-white [&>svg]:text-white">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Session ended</AlertTitle>
      <AlertDescription className="text-white/80">{authFailureMessage(reason)}</AlertDescription>
    </Alert>
  );
}
