/**
 * @file hooks/useProposedEntities.ts
 * @description TanStack Query hooks for the proposed-Entity triage lane — where
 * technologies discovered by the net-new scout land for review. Reads + triage
 * mutations go through /api/triage/entities (approve mints the real entity admin-side
 * there). Mirrors useAssessments: optimistic remove-from-pending + invalidate.
 *
 * Reads are gated on Firebase auth-state restoration via `useAuth()` — the same
 * "Phase 0 step 0.10" pattern as `useBriefing`/`useDigests`/`useAssessments`.
 * Without the gate, TanStack Query fires on mount before `onAuthStateChanged`
 * restores the persisted session, `fetchWithAuth` ships with no Authorization
 * header, and `/api/triage/entities` correctly 401s.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/components/providers/AuthProvider';
import type { ProposedEntity, ProposedEntityStatus } from '@/lib/schemas/proposed-entity';

const proposedEntityKeys = {
  all: ['proposedEntities'] as const,
  list: (status: ProposedEntityStatus | 'all') => ['proposedEntities', 'list', status] as const,
  pendingCount: () => ['proposedEntities', 'pendingCount'] as const,
};

async function listProposedEntities(status?: ProposedEntityStatus): Promise<ProposedEntity[]> {
  const qs = status ? `?status=${status}` : '';
  const res = await fetchWithAuth(`/api/triage/entities${qs}`);
  if (!res.ok) throw new Error(`Failed to list proposed entities (${res.status})`);
  const data = await res.json();
  return data.entities ?? [];
}

async function resolveProposedEntity(
  id: string,
  action: 'approve' | 'reject' | 'dismiss',
  extra?: { feedbackReason?: string }
): Promise<ProposedEntity> {
  const res = await fetchWithAuth(`/api/triage/entities/${id}`, {
    method: 'POST',
    body: JSON.stringify({ action, ...extra }),
  });
  if (!res.ok) throw new Error(`Failed to ${action} proposed entity (${res.status})`);
  const data = await res.json();
  return data.entity;
}

export function useProposedEntities(status: ProposedEntityStatus = 'pending') {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: proposedEntityKeys.list(status),
    queryFn: () => listProposedEntities(status),
    enabled: !loading && !!user,
    staleTime: 30_000,
  });
}

export function usePendingProposedEntitiesCount() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: proposedEntityKeys.pendingCount(),
    queryFn: async () => (await listProposedEntities('pending')).length,
    enabled: !loading && !!user,
    staleTime: 60_000,
  });
}

/** approve | reject | dismiss with optimistic removal from the pending list. */
function useResolveProposedEntity(action: 'approve' | 'reject' | 'dismiss', successMsg: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pendingKey = proposedEntityKeys.list('pending');
  return useMutation({
    mutationFn: (vars: { id: string; feedbackReason?: string }) =>
      resolveProposedEntity(vars.id, action, { feedbackReason: vars.feedbackReason }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: pendingKey });
      const previous = queryClient.getQueryData<ProposedEntity[]>(pendingKey);
      queryClient.setQueryData<ProposedEntity[]>(pendingKey, (old) => (old ?? []).filter((e) => e.id !== id));
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(pendingKey, ctx.previous);
      toast({ title: `Could not ${action} technology`, variant: 'destructive' });
    },
    onSuccess: () => toast({ title: successMsg }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: proposedEntityKeys.all });
      // approve mints a real technology — refresh the catalog surfaces.
      queryClient.invalidateQueries({ queryKey: ['technologies'] });
    },
  });
}

export const useApproveProposedEntity = () => useResolveProposedEntity('approve', 'Technology added to the catalog');
export const useRejectProposedEntity = () => useResolveProposedEntity('reject', 'Proposal rejected');
export const useDismissProposedEntity = () => useResolveProposedEntity('dismiss', 'Proposal dismissed');
