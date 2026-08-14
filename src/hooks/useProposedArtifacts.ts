/**
 * @file hooks/useProposedArtifacts.ts
 * @description TanStack Query hooks for the artifact-RECOMMENDATION triage lane — the
 * "produce a report / research / infographic" proposals. Reads + triage go through
 * /api/triage/artifacts; APPROVE dispatches the generation job server-side. Mirrors
 * useProposedEntities: optimistic remove-from-pending + invalidate (also refreshes the
 * Reports/Documents output surfaces on approve).
 *
 * Reads are gated on Firebase auth-state restoration via `useAuth()` — the same
 * "Phase 0 step 0.10" pattern as `useBriefing`/`useDigests`/`useAssessments`.
 * Without the gate, TanStack Query fires on mount before `onAuthStateChanged`
 * restores the persisted session, `fetchWithAuth` ships with no Authorization
 * header, and `/api/triage/artifacts` correctly 401s.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/components/providers/AuthProvider';
import type { ProposedArtifact, ProposedArtifactStatus } from '@/lib/schemas/proposed-artifact';

const proposedArtifactKeys = {
  all: ['proposedArtifacts'] as const,
  list: (status: ProposedArtifactStatus | 'all') => ['proposedArtifacts', 'list', status] as const,
  pendingCount: () => ['proposedArtifacts', 'pendingCount'] as const,
};

export async function listProposedArtifacts(status?: ProposedArtifactStatus): Promise<ProposedArtifact[]> {
  const qs = status ? `?status=${status}` : '';
  const res = await fetchWithAuth(`/api/triage/artifacts${qs}`);
  if (!res.ok) throw new Error(`Failed to list proposed artifacts (${res.status})`);
  const data = await res.json();
  return data.artifacts ?? [];
}

async function resolveProposedArtifact(
  id: string,
  action: 'approve' | 'reject' | 'dismiss',
  extra?: { feedbackReason?: string }
): Promise<ProposedArtifact> {
  const res = await fetchWithAuth(`/api/triage/artifacts/${id}`, {
    method: 'POST',
    body: JSON.stringify({ action, ...extra }),
  });
  if (!res.ok) throw new Error(`Failed to ${action} proposed artifact (${res.status})`);
  const data = await res.json();
  return data.artifact;
}

export function useProposedArtifacts(status: ProposedArtifactStatus = 'pending') {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: proposedArtifactKeys.list(status),
    queryFn: () => listProposedArtifacts(status),
    enabled: !loading && !!user,
    staleTime: 30_000,
  });
}

export function usePendingProposedArtifactsCount() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: proposedArtifactKeys.pendingCount(),
    queryFn: async () => (await listProposedArtifacts('pending')).length,
    enabled: !loading && !!user,
    staleTime: 60_000,
  });
}

/** approve | reject | dismiss with optimistic removal from the pending list. */
function useResolveProposedArtifact(action: 'approve' | 'reject' | 'dismiss', successMsg: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const pendingKey = proposedArtifactKeys.list('pending');
  return useMutation({
    mutationFn: (vars: { id: string; feedbackReason?: string }) =>
      resolveProposedArtifact(vars.id, action, { feedbackReason: vars.feedbackReason }),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: pendingKey });
      const previous = queryClient.getQueryData<ProposedArtifact[]>(pendingKey);
      queryClient.setQueryData<ProposedArtifact[]>(pendingKey, (old) => (old ?? []).filter((a) => a.id !== id));
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(pendingKey, ctx.previous);
      toast({ title: `Could not ${action} recommendation`, variant: 'destructive' });
    },
    onSuccess: () => toast({ title: successMsg }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: proposedArtifactKeys.all });
      // approve generates an output — refresh the Reports/Documents surfaces.
      queryClient.invalidateQueries({ queryKey: ['reports'] });
      queryClient.invalidateQueries({ queryKey: ['documents'] });
    },
  });
}

export const useApproveProposedArtifact = () =>
  useResolveProposedArtifact('approve', 'Approved — generating the artifact…');
export const useRejectProposedArtifact = () => useResolveProposedArtifact('reject', 'Recommendation rejected');
export const useDismissProposedArtifact = () => useResolveProposedArtifact('dismiss', 'Recommendation dismissed');
