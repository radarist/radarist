'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';

/**
 * UX-046 — hard isolation between account sessions.
 *
 * Account-scoped query keys embed the uid (briefingKeys, activityKeys,
 * buildMissionKeys, …), which prevents key collisions — but the previous
 * account's entries would still sit in the shared browser QueryClient
 * until gcTime expires. On any account transition (switch or sign-out)
 * this boundary cancels in-flight queries and drops the entire cache, so
 * nothing fetched under the previous principal can render, be reused, or
 * linger in memory for the next one.
 *
 * The initial auth restoration (no previous principal) does NOT purge —
 * clearing there would wipe prefetched state on every load for zero
 * isolation benefit. The `loading` window before the first resolution is
 * ignored for the same reason.
 */
export function AccountCacheBoundary({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const queryClient = useQueryClient();
  const lastUidRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (loading) return;
    const uid = user?.uid ?? null;
    const previous = lastUidRef.current;
    lastUidRef.current = uid;
    if (previous === undefined || previous === uid) return;
    void queryClient.cancelQueries();
    queryClient.clear();
  }, [user, loading, queryClient]);

  return <>{children}</>;
}
