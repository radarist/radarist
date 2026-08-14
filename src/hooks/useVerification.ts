/**
 * @file hooks/useVerification.ts
 * @description TanStack Query hook for entity verification status.
 *
 * @phase Impulse v1.0 — Phase 3: Defense Minister
 */

import { useQuery } from '@tanstack/react-query';

import { fetchWithAuth } from '@/lib/fetch-with-auth';

export const verificationKeys = {
  all: ['verification'] as const,
  entity: (entityId: string) => [...verificationKeys.all, entityId] as const };

export function useVerification(entityId: string | undefined) {
  return useQuery({
    queryKey: verificationKeys.entity(entityId ?? ''),
    queryFn: async () => {
      if (!entityId) return null;      const res = await fetchWithAuth(`/api/verification/${entityId}`, {
        headers: { } });
      if (!res.ok) return null;
      const data = await res.json();
      return data.verification;
    },
    enabled: !!entityId,
    staleTime: 5 * 60 * 1000 });
}
