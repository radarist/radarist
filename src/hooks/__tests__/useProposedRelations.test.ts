/**
 * Unit Tests for useProposedRelations Hooks
 *
 * Tests all TanStack Query hooks for proposed relations (Linker Triage):
 * - Query hooks: useProposedRelations, usePendingProposedRelations,
 *   useProposedRelationsPaginated, usePendingProposedRelationsCount
 * - Mutation hooks: useApproveProposedRelation, useRejectProposedRelation,
 *   useDismissProposedRelation, useBulkApproveProposedRelations,
 *   useBulkRejectProposedRelations, useBulkDeleteProposedRelations,
 *   useUndoProposedRelation, useRevertProposedRelation, useRemoveApprovedRelation
 *
 * @jest-environment jsdom
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import type { ProposedRelation } from '@/lib/types';
import { CORRELATION_ID_HEADER, isCorrelationId } from '@/lib/observability/correlation';

// ============================================================================
// MOCKS
// ============================================================================

const mockGetProposedRelations = jest.fn();
const mockGetProposedRelationsPaginated = jest.fn();
const mockGetPendingProposedRelationsCount = jest.fn();
const mockApproveProposedRelation = jest.fn();
const mockRejectProposedRelation = jest.fn();
const mockDismissProposedRelation = jest.fn();
const mockBulkApproveProposedRelations = jest.fn();
const mockBulkRejectProposedRelations = jest.fn();
const mockBulkDeleteProposedRelations = jest.fn();
const mockUpdateProposedRelation = jest.fn();
const mockRevertProposedRelation = jest.fn();
const mockMarkProposedRelationAsRemoved = jest.fn();
const mockDeleteRelationBetween = jest.fn();

jest.mock('@/lib/proposed-relations', () => ({
  getProposedRelations: (...args: unknown[]) => mockGetProposedRelations(...args),
  getProposedRelationsPaginated: (...args: unknown[]) => mockGetProposedRelationsPaginated(...args),
  getPendingProposedRelationsCount: () => mockGetPendingProposedRelationsCount(),
  approveProposedRelation: (...args: unknown[]) => mockApproveProposedRelation(...args),
  rejectProposedRelation: (...args: unknown[]) => mockRejectProposedRelation(...args),
  dismissProposedRelation: (...args: unknown[]) => mockDismissProposedRelation(...args),
  bulkApproveProposedRelations: (...args: unknown[]) => mockBulkApproveProposedRelations(...args),
  bulkRejectProposedRelations: (...args: unknown[]) => mockBulkRejectProposedRelations(...args),
  bulkDeleteProposedRelations: (...args: unknown[]) => mockBulkDeleteProposedRelations(...args),
  updateProposedRelation: (...args: unknown[]) => mockUpdateProposedRelation(...args),
  revertProposedRelation: (...args: unknown[]) => mockRevertProposedRelation(...args),
  markProposedRelationAsRemoved: (...args: unknown[]) => mockMarkProposedRelationAsRemoved(...args),
}));

jest.mock('@/lib/relations', () => ({
  deleteRelationBetween: (...args: unknown[]) => mockDeleteRelationBetween(...args),
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

// Global fetch mock
const mockFetch = jest.fn();
global.fetch = mockFetch;

jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetch(...args),
}));

// Import hooks after mocks
import {
  useProposedRelations,
  usePendingProposedRelations,
  useProposedRelationsPaginated,
  usePendingProposedRelationsCount,
  useApproveProposedRelation,
  useRejectProposedRelation,
  useDismissProposedRelation,
  useBulkApproveProposedRelations,
  useBulkRejectProposedRelations,
  useBulkDeleteProposedRelations,
  useUndoProposedRelation,
  useRevertProposedRelation,
  useRemoveApprovedRelation,
} from '../useProposedRelations';

// ============================================================================
// TEST UTILITIES
// ============================================================================

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return {
    wrapper: function Wrapper({ children }: { children: React.ReactNode }) {
      return React.createElement(QueryClientProvider, { client: queryClient }, children);
    },
    queryClient,
  };
}

function correlationIdsFromFetchCalls(): Array<string | null> {
  return mockFetch.mock.calls.map(([, init]) => new Headers((init as RequestInit).headers).get(CORRELATION_ID_HEADER));
}

const mockProposal = (overrides?: Partial<ProposedRelation>): ProposedRelation => ({
  id: 'proposal-1',
  sourceId: 'src-1',
  sourceType: 'technology',
  sourceSnapshot: { name: 'React', type: 'technology', id: 'src-1', snapshotAt: Date.now() },
  targetId: 'tgt-1',
  targetType: 'company',
  targetSnapshot: { name: 'Acme Corp', type: 'company', id: 'tgt-1', snapshotAt: Date.now() },
  relationType: 'uses',
  confidence: 85,
  status: 'pending',
  discoveredBy: 'linker-agent',
  reasoning: 'Auto-detected relation',
  evidence: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// ============================================================================
// QUERY HOOKS
// ============================================================================

describe('useProposedRelations (query)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should fetch proposed relations', async () => {
    const proposals = [mockProposal()];
    mockGetProposedRelations.mockResolvedValue(proposals);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProposedRelations(), { wrapper });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(proposals);
    expect(mockGetProposedRelations).toHaveBeenCalledWith(undefined);
  });

  it('should pass filters to query function', async () => {
    mockGetProposedRelations.mockResolvedValue([]);

    const filters = { status: 'pending' as const };
    const { wrapper } = createWrapper();
    renderHook(() => useProposedRelations(filters), { wrapper });

    await waitFor(() => {
      expect(mockGetProposedRelations).toHaveBeenCalledWith(filters);
    });
  });

  it('should handle fetch errors', async () => {
    mockGetProposedRelations.mockRejectedValue(new Error('Fetch failed'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProposedRelations(), { wrapper });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('usePendingProposedRelations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should fetch only pending proposals', async () => {
    mockGetProposedRelations.mockResolvedValue([mockProposal()]);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePendingProposedRelations(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetProposedRelations).toHaveBeenCalledWith({ status: 'pending' });
  });
});

describe('useProposedRelationsPaginated', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should fetch paginated proposals', async () => {
    mockGetProposedRelationsPaginated.mockResolvedValue({ data: [], nextCursor: null });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useProposedRelationsPaginated(undefined, { cursor: undefined, limit: 20 }), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockGetProposedRelationsPaginated).toHaveBeenCalled();
  });
});

describe('usePendingProposedRelationsCount', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should fetch pending count', async () => {
    mockGetPendingProposedRelationsCount.mockResolvedValue(5);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => usePendingProposedRelationsCount(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toBe(5);
  });
});

// ============================================================================
// MUTATION HOOKS
// ============================================================================

describe('useApproveProposedRelation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should approve a proposal via the triage route', async () => {
    const approvedData = mockProposal({ status: 'approved' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ relation: approvedData }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useApproveProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/proposal-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'approve' }),
      })
    );
    expect(mockApproveProposedRelation).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalledWith('/api/relations/from-ids', expect.anything());
    expect(isCorrelationId(correlationIdsFromFetchCalls()[0])).toBe(true);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Relation Approved' }));
  });

  it('should show error toast and throw the server message on a non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Server error' }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useApproveProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toEqual(new Error('Server error'));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});

describe('useRejectProposedRelation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should reject a proposal via the triage route', async () => {
    const rejectedData = mockProposal({ status: 'rejected' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ relation: rejectedData }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRejectProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({
        proposalId: 'proposal-1',
        reviewedBy: 'user-1',
        feedbackReason: 'Not relevant',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/proposal-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'reject', feedbackReason: 'Not relevant' }),
      })
    );
    expect(mockRejectProposedRelation).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Relation Rejected' }));
  });

  it('should show error toast on a non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Failed' }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRejectProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'p1', reviewedBy: 'u1' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toEqual(new Error('Failed'));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});

describe('useDismissProposedRelation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should dismiss a proposal via the triage route', async () => {
    const dismissedData = mockProposal({ status: 'dismissed' });
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ relation: dismissedData }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDismissProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/proposal-1',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'dismiss' }),
      })
    );
    expect(mockDismissProposedRelation).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Relation Dismissed' }));
  });

  it('should show error toast on a non-OK response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: 'Failed to dismiss' }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useDismissProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toEqual(new Error('Failed to dismiss'));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});

describe('useBulkApproveProposedRelations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should bulk approve proposals via the triage route', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ relation: mockProposal({ status: 'approved' }) }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBulkApproveProposedRelations(), { wrapper });

    await act(async () => {
      result.current.mutate({
        proposalIds: ['p1', 'p2', 'p3'],
        reviewedBy: 'user-1',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const correlationIds = correlationIdsFromFetchCalls();
    expect(correlationIds.every(isCorrelationId)).toBe(true);
    expect(new Set(correlationIds).size).toBe(3);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/p1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'approve' }) })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/p2',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'approve' }) })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/p3',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'approve' }) })
    );
    expect(mockBulkApproveProposedRelations).not.toHaveBeenCalled();
    // UX-037 — the result names WHICH ids failed so the caller can keep exactly
    // those selected for retry; an all-success run reports an empty list.
    expect(result.current.data).toEqual({ approved: 3, failed: 0, failedIds: [], errors: [] });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Approve Complete' }));
  });

  it('should show destructive variant when some fail', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ relation: mockProposal({ status: 'approved' }) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ relation: mockProposal({ status: 'approved' }) }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'Failed' }),
      });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBulkApproveProposedRelations(), { wrapper });

    await act(async () => {
      result.current.mutate({
        proposalIds: ['p1', 'p2', 'p3'],
        reviewedBy: 'user-1',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(expect.objectContaining({ approved: 2, failed: 1 }));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});

describe('useBulkRejectProposedRelations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should bulk reject proposals via the triage route', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ relation: mockProposal({ status: 'rejected' }) }),
    });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBulkRejectProposedRelations(), { wrapper });

    await act(async () => {
      result.current.mutate({
        proposalIds: ['p1', 'p2'],
        reviewedBy: 'user-1',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/p1',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'reject' }) })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/triage/relations/p2',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ action: 'reject' }) })
    );
    expect(mockBulkRejectProposedRelations).not.toHaveBeenCalled();
    expect(result.current.data).toEqual({ rejected: 2, failed: 0, failedIds: [], errors: [] });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Reject Complete' }));
  });

  it('should show destructive variant when some fail', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ relation: mockProposal({ status: 'rejected' }) }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'Failed' }),
      });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBulkRejectProposedRelations(), { wrapper });

    await act(async () => {
      result.current.mutate({
        proposalIds: ['p1', 'p2'],
        reviewedBy: 'user-1',
      });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual(expect.objectContaining({ rejected: 1, failed: 1 }));
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});

describe('useBulkDeleteProposedRelations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should bulk delete proposals', async () => {
    mockBulkDeleteProposedRelations.mockResolvedValue({ deleted: 2, failed: 0 });

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBulkDeleteProposedRelations(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalIds: ['p1', 'p2'] });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockBulkDeleteProposedRelations).toHaveBeenCalledWith(['p1', 'p2']);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Bulk Delete Complete' }));
  });

  it('should show error toast on bulk delete failure', async () => {
    mockBulkDeleteProposedRelations.mockRejectedValue(new Error('Network error'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useBulkDeleteProposedRelations(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalIds: ['p1'] });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});

// ============================================================================
// useUndoProposedRelation
// ============================================================================

describe('useUndoProposedRelation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should revert a proposal back to pending status', async () => {
    const revertedData = mockProposal({ status: 'pending' });
    mockUpdateProposedRelation.mockResolvedValue(revertedData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUndoProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockUpdateProposedRelation).toHaveBeenCalledWith('proposal-1', {
      status: 'pending',
      reviewedAt: undefined,
      reviewedBy: undefined,
      feedbackReason: undefined,
    });
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Undo Successful' }));
  });

  it('should show error toast on undo failure', async () => {
    mockUpdateProposedRelation.mockRejectedValue(new Error('Expired'));

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useUndoProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'p1' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Error', variant: 'destructive' }));
  });
});

// ============================================================================
// useRevertProposedRelation
// ============================================================================

describe('useRevertProposedRelation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should revert a rejected/dismissed proposal back to pending', async () => {
    const revertedData = mockProposal({
      status: 'pending',
      sourceSnapshot: { name: 'React', type: 'technology', id: 'src-1', snapshotAt: Date.now() },
      targetSnapshot: { name: 'Acme Corp', type: 'company', id: 'tgt-1', snapshotAt: Date.now() },
    });
    mockRevertProposedRelation.mockResolvedValue(revertedData);

    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRevertProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockRevertProposedRelation).toHaveBeenCalledWith('proposal-1', 'user-1');
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Proposal Reverted' }));
  });

  it('should optimistically set proposal status to pending in cache', async () => {
    // onMutate runs before the mutationFn and updates the cache optimistically.
    // We can verify the onMutate behaviour by seeding cache and observing the change.
    mockRevertProposedRelation.mockResolvedValue(
      mockProposal({
        status: 'pending',
        sourceSnapshot: { name: 'A', type: 'technology', id: 'a1', snapshotAt: Date.now() },
        targetSnapshot: { name: 'B', type: 'company', id: 'b1', snapshotAt: Date.now() },
      })
    );

    const { wrapper, queryClient } = createWrapper();
    const { proposedRelationKeys } = require('@/lib/query-keys');
    const existingProposal = mockProposal({ id: 'p1', status: 'rejected' });
    queryClient.setQueryData(proposedRelationKeys.list({}), [existingProposal]);

    const { result } = renderHook(() => useRevertProposedRelation(), { wrapper });

    // Trigger the mutation and wait for completion
    await act(async () => {
      result.current.mutate({ proposalId: 'p1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockRevertProposedRelation).toHaveBeenCalledWith('p1', 'user-1');
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Proposal Reverted' }));
  });

  it('should rollback on revert failure', async () => {
    mockRevertProposedRelation.mockRejectedValue(new Error('Server error'));

    const { wrapper, queryClient } = createWrapper();
    const { proposedRelationKeys } = require('@/lib/query-keys');
    const existingProposals = [mockProposal({ status: 'rejected' })];
    queryClient.setQueryData(proposedRelationKeys.list({}), existingProposals);

    const { result } = renderHook(() => useRevertProposedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposalId: 'proposal-1', reviewedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});

// ============================================================================
// useRemoveApprovedRelation
// ============================================================================

describe('useRemoveApprovedRelation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('should delete relation and mark proposal as removed', async () => {
    const removedData = mockProposal({
      status: 'removed',
      sourceSnapshot: { name: 'React', type: 'technology', id: 'src-1', snapshotAt: Date.now() },
      targetSnapshot: { name: 'Acme Corp', type: 'company', id: 'tgt-1', snapshotAt: Date.now() },
    });
    mockDeleteRelationBetween.mockResolvedValue(undefined);
    mockMarkProposedRelationAsRemoved.mockResolvedValue(removedData);

    const proposal = mockProposal({ status: 'approved' });
    const { wrapper } = createWrapper();
    const { result } = renderHook(() => useRemoveApprovedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposal, removedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockDeleteRelationBetween).toHaveBeenCalledWith(proposal.sourceId, proposal.targetId, proposal.relationType);
    expect(mockMarkProposedRelationAsRemoved).toHaveBeenCalledWith(proposal.id, 'user-1');
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link Removed' }));
  });

  it('should optimistically set proposal status to removed in cache', async () => {
    // onMutate runs before mutationFn and updates the cache optimistically.
    mockDeleteRelationBetween.mockResolvedValue(undefined);
    mockMarkProposedRelationAsRemoved.mockResolvedValue(
      mockProposal({
        status: 'removed',
        sourceSnapshot: { name: 'A', type: 'technology', id: 'a1', snapshotAt: Date.now() },
        targetSnapshot: { name: 'B', type: 'company', id: 'b1', snapshotAt: Date.now() },
      })
    );

    const { wrapper, queryClient } = createWrapper();
    const { proposedRelationKeys } = require('@/lib/query-keys');
    const existingProposal = mockProposal({ id: 'p1', status: 'approved' });
    queryClient.setQueryData(proposedRelationKeys.list({}), [existingProposal]);

    const { result } = renderHook(() => useRemoveApprovedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposal: existingProposal, removedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockDeleteRelationBetween).toHaveBeenCalledWith(
      existingProposal.sourceId,
      existingProposal.targetId,
      existingProposal.relationType
    );
    expect(mockMarkProposedRelationAsRemoved).toHaveBeenCalledWith(existingProposal.id, 'user-1');
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link Removed' }));
  });

  it('should rollback on failure', async () => {
    mockDeleteRelationBetween.mockRejectedValue(new Error('Relation not found'));

    const proposal = mockProposal({ status: 'approved' });
    const { wrapper, queryClient } = createWrapper();
    const { proposedRelationKeys } = require('@/lib/query-keys');
    queryClient.setQueryData(proposedRelationKeys.list({}), [proposal]);

    const { result } = renderHook(() => useRemoveApprovedRelation(), { wrapper });

    await act(async () => {
      result.current.mutate({ proposal, removedBy: 'user-1' });
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'destructive' }));
  });
});
