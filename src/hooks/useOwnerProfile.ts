/**
 * @file hooks/useOwnerProfile.ts
 * @description UX-062 — TanStack Query hook for the authenticated operator's
 * owner profile (`/api/user/profile`). The sidebar binds the visible identity
 * to this canonical record instead of the seeded Firebase Auth `displayName`.
 *
 * Gated on Firebase auth-state restoration via `useAuth()` — the same pattern
 * as `useBriefing`/`useAssessments`/`useProposedEntities`. Without the gate,
 * TanStack Query fires on mount before `onAuthStateChanged` restores the
 * persisted session, `fetchWithAuth` ships with no Authorization header, and
 * `/api/user/profile` correctly 401s. `profile` is null when no owner doc
 * exists yet (fresh signup); callers fall back to the Auth email identity.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { useAuth } from '@/components/providers/AuthProvider';
import { userKeys } from '@/lib/query-keys';
import type { OwnerProfile } from '@/lib/user-profile';

async function fetchOwnerProfile(): Promise<OwnerProfile | null> {
  const res = await fetchWithAuth('/api/user/profile');
  if (!res.ok) throw new Error(`Failed to read owner profile (${res.status})`);
  const data = await res.json();
  return (data.profile as OwnerProfile | null) ?? null;
}

/**
 * The authenticated operator's owner profile. `data` is `null` when no owner
 * doc exists yet (fresh signup) — distinct from the loading/error states.
 */
export function useOwnerProfile() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: userKeys.profile(user?.uid ?? 'anonymous'),
    queryFn: fetchOwnerProfile,
    enabled: !loading && !!user,
    staleTime: 60_000,
  });
}
