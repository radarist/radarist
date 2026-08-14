/**
 * @file hooks/useDigests.ts
 * @description TanStack Query hooks for daily digests.
 *
 * @phase Impulse v1.0 — Phase 4: Intelligence Layer
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { createLogger } from '@/lib/logger';
import { useAuth } from '@/components/providers/AuthProvider';

const log = createLogger('hooks/useDigests');

export const digestKeys = {
  all: ['digests'] as const,
  unread: () => [...digestKeys.all, 'unread'] as const,
};

/**
 * fetchWithAuth is a thin fetch wrapper — it does NOT throw on non-2xx, so
 * mutations must check `response.ok` themselves. Without this, a failed
 * mark-read (e.g. a partial batch failure surfacing as an API 500) would
 * fire onSuccess and silently show success in the popover.
 */
async function postDigestAction(body: { digestId?: string; action: 'markRead' | 'markAllRead' }): Promise<void> {
  const response = await fetchWithAuth('/api/digests', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Digest ${body.action} request failed (${response.status}): ${text || response.statusText}`);
  }
}

export function useUnreadDigests() {
  // Gate on auth being restored — otherwise the query fires before Firebase Auth
  // resolves and ships with no Authorization header, returning 401 on every page.
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: digestKeys.unread(),
    queryFn: async () => {
      const res = await fetchWithAuth('/api/digests?unread=true');
      // AUDIT-008: a failed fetch must surface as a query error, not be
      // swallowed into an empty (== "all read") notification list.
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Digest fetch failed (${res.status}): ${text || res.statusText}`);
      }
      return res.json();
    },
    enabled: !loading && !!user,
    staleTime: 60 * 1000,
  });
}

export function useMarkDigestRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (digestId: string) => postDigestAction({ digestId, action: 'markRead' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: digestKeys.unread() }),
    onError: (error) => {
      log.error('Failed to mark digest read', error);
      toast.error('Failed to mark notifications read');
    },
  });
}

export function useMarkAllDigestsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postDigestAction({ action: 'markAllRead' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: digestKeys.unread() }),
    onError: (error) => {
      log.error('Failed to mark all digests read', error);
      toast.error('Failed to mark notifications read');
    },
  });
}
