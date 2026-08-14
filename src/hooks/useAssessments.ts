/**
 * @file hooks/useAssessments.ts
 * @description TanStack Query hooks for the Assessment triage lane (build-mission
 * evaluation verdicts). Reads + triage mutations go through /api/triage/assessments
 * (the apply — radar placement + TRL — runs admin-side there). Mirrors
 * useProposedRelations: optimistic remove-from-pending + invalidate.
 *
 * Reads are gated on Firebase auth-state restoration via `useAuth()` — the same
 * "Phase 0 step 0.10" pattern as `useBriefing`/`useDigests`. Without the gate,
 * TanStack Query fires on mount before `onAuthStateChanged` restores the
 * persisted session, `fetchWithAuth` ships with no Authorization header, and
 * `/api/triage/assessments` correctly 401s — surfacing as sidebar-badge console
 * noise on every page load.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { assessmentKeys } from '@/lib/query-keys';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/components/providers/AuthProvider';
import type { ProposedAssessment, ProposedAssessmentStatus } from '@/lib/schemas/proposed-assessment';

async function listAssessments(status?: ProposedAssessmentStatus): Promise<ProposedAssessment[]> {
  const qs = status ? `?status=${status}` : '';
  const res = await fetchWithAuth(`/api/triage/assessments${qs}`);
  if (!res.ok) throw new Error(`Failed to list assessments (${res.status})`);
  const data = await res.json();
  return data.assessments ?? [];
}

async function resolveAssessment(
  id: string,
  action: 'approve' | 'reject' | 'dismiss',
  extra?: { radarId?: string; quadrantId?: string; feedbackReason?: string }
): Promise<ProposedAssessment> {
  const res = await fetchWithAuth(`/api/triage/assessments/${id}`, {
    method: 'POST',
    body: JSON.stringify({ action, ...extra }),
  });
  if (!res.ok) throw new Error(`Failed to ${action} assessment (${res.status})`);
  const data = await res.json();
  return data.assessment;
}

export function useAssessments(status?: ProposedAssessmentStatus) {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: assessmentKeys.list({ status }),
    queryFn: () => listAssessments(status),
    enabled: !loading && !!user,
    staleTime: 30_000,
  });
}

export function usePendingAssessments() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: assessmentKeys.pending(),
    queryFn: () => listAssessments('pending'),
    enabled: !loading && !!user,
    staleTime: 30_000,
  });
}

export function usePendingAssessmentsCount() {
  const { user, loading } = useAuth();
  return useQuery({
    queryKey: assessmentKeys.pendingCount(),
    queryFn: async () => (await listAssessments('pending')).length,
    enabled: !loading && !!user,
    staleTime: 60_000,
  });
}

type SuccessToast = { title: string; description?: string };

/** approve | reject | dismiss with optimistic removal from the pending list.
 * `success` may be a function of the returned assessment so the confirmation can
 * tell the truth about what actually happened (BUILD-005 — the approve path only
 * claims "applied to the radar" when a placement was really created/updated). */
function useResolveAssessment(
  action: 'approve' | 'reject' | 'dismiss',
  success: SuccessToast | ((result: ProposedAssessment) => SuccessToast)
) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (vars: { id: string; radarId?: string; quadrantId?: string; feedbackReason?: string }) =>
      resolveAssessment(vars.id, action, vars),
    onMutate: async ({ id }) => {
      await queryClient.cancelQueries({ queryKey: assessmentKeys.pending() });
      const previous = queryClient.getQueryData<ProposedAssessment[]>(assessmentKeys.pending());
      queryClient.setQueryData<ProposedAssessment[]>(assessmentKeys.pending(), (old) =>
        (old ?? []).filter((a) => a.id !== id)
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(assessmentKeys.pending(), ctx.previous);
      toast({ title: `Could not ${action} assessment`, variant: 'destructive' });
    },
    onSuccess: (result) => toast(typeof success === 'function' ? success(result) : success),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: assessmentKeys.all });
      // approve mutates the graph radar — refresh those surfaces too.
      queryClient.invalidateQueries({ queryKey: ['radarPlacements'] });
      queryClient.invalidateQueries({ queryKey: ['technologies'] });
    },
  });
}

export const useApproveAssessment = () =>
  useResolveAssessment('approve', (result) => {
    if (result.appliedPlacementId) {
      return {
        title: 'Applied to the radar',
        description: result.proposedRing ? `Placed in the ${result.proposedRing} ring.` : undefined,
      };
    }
    // No placement landed — say WHY honestly. A resolved radar target with no
    // appliedPlacementId means the placement write didn't succeed (transient
    // error / race), NOT that the tech is untracked — telling the reviewer to
    // "add it to a radar" there would create a duplicate.
    if (result.radarId) {
      return {
        title: 'Verdict recorded',
        description: "Couldn't apply the radar placement just now — try approving again.",
      };
    }
    return {
      title: 'Verdict recorded',
      description:
        "This technology isn't on a radar yet — ask the AI assistant to place it (e.g. 'put <tech> on <radar>').",
    };
  });
export const useRejectAssessment = () => useResolveAssessment('reject', { title: 'Assessment rejected' });
export const useDismissAssessment = () => useResolveAssessment('dismiss', { title: 'Assessment dismissed' });
