/**
 * @file hooks/useProposedRelations.ts
 * @description TanStack Query hooks for proposed relations (Linker Triage)
 *
 * Features:
 * - Fetch pending proposed relations
 * - Approve/reject mutations with optimistic updates
 * - Bulk actions support
 * - Count query for badges/notifications
 *
 * @author Radarist Team
 * @created 2026-01-20
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { proposedRelationKeys } from '@/lib/query-keys';
import {
  getProposedRelations,
  getProposedRelationsPaginated,
  getPendingProposedRelationsCount,
  bulkDeleteProposedRelations,
  type ProposedRelationFilters,
  type PaginationOptions,
} from '@/lib/proposed-relations';
import type { ProposedRelation, ProposedRelationStatus } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { CORRELATION_ID_HEADER, createCorrelationId } from '@/lib/observability/correlation';

// ============================================================================
// TRIAGE ROUTE HELPER
// ============================================================================

/**
 * Resolves a proposed relation via the server-side triage route
 * (`POST /api/triage/relations/[id]`). This is the single write path for
 * approve/reject/dismiss — it replaces the old two-step client-SDK-write +
 * `/api/relations/from-ids` POST, which could 409 on duplicate creation
 * after a successful approval (see relation-triage route header for the
 * full contract).
 */
async function postTriageAction(
  proposalId: string,
  action: 'approve' | 'reject' | 'dismiss',
  feedbackReason?: string
): Promise<ProposedRelation> {
  const correlationId = createCorrelationId();
  const response = await fetchWithAuth(`/api/triage/relations/${proposalId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [CORRELATION_ID_HEADER]: correlationId,
    },
    body: JSON.stringify({
      action,
      ...(feedbackReason ? { feedbackReason } : {}),
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}) as { error?: string });
    throw new Error(error.error || `Failed to ${action} relation`);
  }
  const { relation } = (await response.json()) as {
    relation: ProposedRelation;
  };
  return relation;
}

// ============================================================================
// QUERIES
// ============================================================================

/**
 * Hook to fetch proposed relations with optional filters
 */
export function useProposedRelations(filters?: ProposedRelationFilters) {
  return useQuery({
    queryKey: proposedRelationKeys.list(filters as Record<string, unknown>),
    queryFn: () => getProposedRelations(filters),
    staleTime: 30_000, // 30 seconds
  });
}

/**
 * Hook to fetch pending proposed relations specifically
 */
export function usePendingProposedRelations() {
  return useQuery({
    queryKey: proposedRelationKeys.pending(),
    queryFn: () => getProposedRelations({ status: 'pending' }),
    staleTime: 30_000,
  });
}

/**
 * Hook to fetch proposed relations with pagination
 */
export function useProposedRelationsPaginated(filters?: ProposedRelationFilters, pagination?: PaginationOptions) {
  return useQuery({
    queryKey: proposedRelationKeys.paginated(pagination?.cursor, pagination?.limit),
    queryFn: () => getProposedRelationsPaginated(filters, pagination),
    staleTime: 30_000,
  });
}

/**
 * Hook to fetch count of pending proposed relations
 */
export function usePendingProposedRelationsCount() {
  return useQuery({
    queryKey: proposedRelationKeys.pendingCount(),
    queryFn: getPendingProposedRelationsCount,
    staleTime: 60_000, // 1 minute
  });
}

// ============================================================================
// MUTATIONS
// ============================================================================

/**
 * Hook to approve a proposed relation
 * Creates the actual relation upon approval
 */
export function useApproveProposedRelation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    // `reviewedBy` is accepted for call-site compatibility but unused —
    // the triage route derives the reviewer from the authenticated request.
    mutationFn: async ({ proposalId }: { proposalId: string; reviewedBy: string }) => {
      return postTriageAction(proposalId, 'approve');
    },
    onMutate: async ({ proposalId }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: proposedRelationKeys.pending(),
      });

      // Snapshot previous value
      const previousProposals = queryClient.getQueryData<ProposedRelation[]>(proposedRelationKeys.pending());

      // Optimistically remove from pending list
      queryClient.setQueryData<ProposedRelation[]>(
        proposedRelationKeys.pending(),
        (old) => old?.filter((p) => p.id !== proposalId) ?? []
      );

      return { previousProposals };
    },
    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previousProposals) {
        queryClient.setQueryData(proposedRelationKeys.pending(), context.previousProposals);
      }
      toast({
        title: 'Error',
        description: 'Failed to approve relation. Please try again.',
        variant: 'destructive',
      });
    },
    onSuccess: (data) => {
      toast({
        title: 'Relation Approved',
        description: `${data.sourceSnapshot.name} → ${data.targetSnapshot.name}`,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook to reject a proposed relation
 */
export function useRejectProposedRelation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    // `reviewedBy` is accepted for call-site compatibility but unused —
    // the triage route derives the reviewer from the authenticated request.
    mutationFn: async ({
      proposalId,
      feedbackReason,
    }: {
      proposalId: string;
      reviewedBy: string;
      feedbackReason?: string;
    }) => {
      return postTriageAction(proposalId, 'reject', feedbackReason);
    },
    onMutate: async ({ proposalId }) => {
      await queryClient.cancelQueries({
        queryKey: proposedRelationKeys.pending(),
      });

      const previousProposals = queryClient.getQueryData<ProposedRelation[]>(proposedRelationKeys.pending());

      queryClient.setQueryData<ProposedRelation[]>(
        proposedRelationKeys.pending(),
        (old) => old?.filter((p) => p.id !== proposalId) ?? []
      );

      return { previousProposals };
    },
    onError: (err, variables, context) => {
      if (context?.previousProposals) {
        queryClient.setQueryData(proposedRelationKeys.pending(), context.previousProposals);
      }
      toast({
        title: 'Error',
        description: 'Failed to reject relation. Please try again.',
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      toast({
        title: 'Relation Rejected',
        description: 'The proposal has been rejected.',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook to dismiss a proposed relation (won't be re-proposed)
 */
export function useDismissProposedRelation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    // `reviewedBy` is accepted for call-site compatibility but unused —
    // the triage route derives the reviewer from the authenticated request.
    mutationFn: async ({ proposalId }: { proposalId: string; reviewedBy: string }) => {
      return postTriageAction(proposalId, 'dismiss');
    },
    onMutate: async ({ proposalId }) => {
      await queryClient.cancelQueries({
        queryKey: proposedRelationKeys.pending(),
      });

      const previousProposals = queryClient.getQueryData<ProposedRelation[]>(proposedRelationKeys.pending());

      queryClient.setQueryData<ProposedRelation[]>(
        proposedRelationKeys.pending(),
        (old) => old?.filter((p) => p.id !== proposalId) ?? []
      );

      return { previousProposals };
    },
    onError: (err, variables, context) => {
      if (context?.previousProposals) {
        queryClient.setQueryData(proposedRelationKeys.pending(), context.previousProposals);
      }
      toast({
        title: 'Error',
        description: 'Failed to dismiss relation.',
        variant: 'destructive',
      });
    },
    onSuccess: () => {
      toast({
        title: 'Relation Dismissed',
        description: "This relation won't be suggested again.",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook to bulk approve high-confidence proposals
 */
export function useBulkApproveProposedRelations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    // `reviewedBy` is accepted for call-site compatibility but unused —
    // the triage route derives the reviewer from the authenticated request.
    mutationFn: async ({ proposalIds }: { proposalIds: string[]; reviewedBy: string }) => {
      const results = await Promise.allSettled(proposalIds.map((id) => postTriageAction(id, 'approve')));

      const errors: string[] = [];
      // UX-037 — the caller keeps exactly these selected so a partial failure
      // is retryable. A count alone loses which proposals still need a decision.
      const failedIds: string[] = [];
      let approved = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          approved++;
        } else {
          failedIds.push(proposalIds[index]);
          errors.push(`${proposalIds[index]}: ${result.reason}`);
        }
      });

      return { approved, failed: failedIds.length, failedIds, errors };
    },
    onSuccess: (result) => {
      toast({
        title: 'Bulk Approve Complete',
        description: `${result.approved} approved, ${result.failed} failed`,
        variant: result.failed > 0 ? 'destructive' : 'default',
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Bulk approve failed. Please try again.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook to bulk reject multiple proposals
 */
export function useBulkRejectProposedRelations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    // `reviewedBy` is accepted for call-site compatibility but unused —
    // the triage route derives the reviewer from the authenticated request.
    mutationFn: async ({ proposalIds }: { proposalIds: string[]; reviewedBy: string }) => {
      const results = await Promise.allSettled(proposalIds.map((id) => postTriageAction(id, 'reject')));

      const errors: string[] = [];
      // See useBulkApproveProposedRelations — the failed ids stay selected.
      const failedIds: string[] = [];
      let rejected = 0;

      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          rejected++;
        } else {
          failedIds.push(proposalIds[index]);
          errors.push(`${proposalIds[index]}: ${result.reason}`);
        }
      });

      return { rejected, failed: failedIds.length, failedIds, errors };
    },
    onSuccess: (result) => {
      toast({
        title: 'Bulk Reject Complete',
        description: `${result.rejected} rejected, ${result.failed} failed`,
        variant: result.failed > 0 ? 'destructive' : 'default',
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Bulk reject failed. Please try again.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook to bulk delete multiple proposals
 */
export function useBulkDeleteProposedRelations() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ proposalIds }: { proposalIds: string[] }) => {
      return bulkDeleteProposedRelations(proposalIds);
    },
    onSuccess: (result) => {
      toast({
        title: 'Bulk Delete Complete',
        description: `${result.deleted} deleted, ${result.failed} failed`,
        variant: result.failed > 0 ? 'destructive' : 'default',
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Bulk delete failed. Please try again.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook for undo functionality (reverts approved/rejected back to pending)
 * Only available within 24-hour window
 */
export function useUndoProposedRelation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ proposalId }: { proposalId: string }) => {
      // Import the update function
      const { updateProposedRelation } = await import('@/lib/proposed-relations');

      // Revert status to pending
      return updateProposedRelation(proposalId, {
        status: 'pending',
        reviewedAt: undefined,
        reviewedBy: undefined,
        feedbackReason: undefined,
      });
    },
    onSuccess: () => {
      toast({
        title: 'Undo Successful',
        description: 'The relation has been restored to pending.',
      });
    },
    onError: () => {
      toast({
        title: 'Error',
        description: 'Unable to undo. The action may have expired.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

// ============================================================================
// REWORK MUTATIONS
// ============================================================================

/**
 * Hook to revert a rejected/dismissed proposal back to pending.
 * This allows the proposal to be reconsidered.
 */
export function useRevertProposedRelation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ proposalId, reviewedBy }: { proposalId: string; reviewedBy: string }) => {
      const { revertProposedRelation } = await import('@/lib/proposed-relations');
      return revertProposedRelation(proposalId, reviewedBy);
    },
    onMutate: async ({ proposalId }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: proposedRelationKeys.all,
      });

      // Snapshot previous all proposals
      const previousProposals = queryClient.getQueryData<ProposedRelation[]>(proposedRelationKeys.list({}));

      // Optimistically update the status to pending
      queryClient.setQueryData<ProposedRelation[]>(
        proposedRelationKeys.list({}),
        (old) =>
          old?.map((p) => (p.id === proposalId ? { ...p, status: 'pending' as ProposedRelationStatus } : p)) ?? []
      );

      return { previousProposals };
    },
    onError: (err, variables, context) => {
      if (context?.previousProposals) {
        queryClient.setQueryData(proposedRelationKeys.list({}), context.previousProposals);
      }
      toast({
        title: 'Error',
        description: 'Failed to revert proposal. Please try again.',
        variant: 'destructive',
      });
    },
    onSuccess: (data) => {
      toast({
        title: 'Proposal Reverted',
        description: `${data.sourceSnapshot.name} → ${data.targetSnapshot.name} is now pending.`,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.pendingCount(),
      });
    },
  });
}

/**
 * Hook to remove an approved relation.
 * This deletes the actual relation and marks the proposal as 'removed'.
 */
export function useRemoveApprovedRelation() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async ({ proposal, removedBy }: { proposal: ProposedRelation; removedBy: string }) => {
      const { markProposedRelationAsRemoved } = await import('@/lib/proposed-relations');
      const { deleteRelationBetween } = await import('@/lib/relations');

      // First delete the actual relation
      await deleteRelationBetween(proposal.sourceId, proposal.targetId, proposal.relationType);

      // Then mark the proposal as removed
      return markProposedRelationAsRemoved(proposal.id, removedBy);
    },
    onMutate: async ({ proposal }) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({
        queryKey: proposedRelationKeys.all,
      });

      // Snapshot previous all proposals
      const previousProposals = queryClient.getQueryData<ProposedRelation[]>(proposedRelationKeys.list({}));

      // Optimistically update the status to removed
      queryClient.setQueryData<ProposedRelation[]>(
        proposedRelationKeys.list({}),
        (old) =>
          old?.map((p) => (p.id === proposal.id ? { ...p, status: 'removed' as ProposedRelationStatus } : p)) ?? []
      );

      return { previousProposals };
    },
    onError: (err, variables, context) => {
      if (context?.previousProposals) {
        queryClient.setQueryData(proposedRelationKeys.list({}), context.previousProposals);
      }
      toast({
        title: 'Error',
        description: 'Failed to remove link. Please try again.',
        variant: 'destructive',
      });
    },
    onSuccess: (data) => {
      toast({
        title: 'Link Removed',
        description: `Removed ${data.sourceSnapshot.name} → ${data.targetSnapshot.name}`,
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: proposedRelationKeys.all,
      });
      // Also invalidate relations since we deleted one
      queryClient.invalidateQueries({
        queryKey: ['relations'],
      });
    },
  });
}
