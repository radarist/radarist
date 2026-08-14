/**
 * @file hooks/useInbox.ts
 * @description Shared data + actions for the Assessments inbox — the unified set of
 * proactive proposals awaiting approval: net-new discoveries, evaluation verdicts, and
 * artifact RECOMMENDATIONS (produce a report / research / infographic). Used by both the
 * inbox table and the per-row detail page so the row shape and the approve/reject/dismiss
 * dispatch live in one place. `useInboxArchive` returns the resolved history (the items
 * that "stay" after you approve/dismiss them).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  usePendingAssessments,
  useApproveAssessment,
  useRejectAssessment,
  useDismissAssessment,
} from '@/hooks/useAssessments';
import {
  useProposedEntities,
  useApproveProposedEntity,
  useRejectProposedEntity,
  useDismissProposedEntity,
} from '@/hooks/useProposedEntities';
import {
  useProposedArtifacts,
  listProposedArtifacts,
  useApproveProposedArtifact,
  useRejectProposedArtifact,
  useDismissProposedArtifact,
} from '@/hooks/useProposedArtifacts';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { entityToRow, assessmentToRow, artifactToRow, type InboxRow, type InboxSourceHealth } from '@/hooks/inbox-rows';
import type { ProposedEntity } from '@/lib/schemas/proposed-entity';
import type { ProposedAssessment } from '@/lib/schemas/proposed-assessment';
import type { ProposedArtifact } from '@/lib/schemas/proposed-artifact';

export type { InboxRow, InboxKind, InboxSourceHealth } from '@/hooks/inbox-rows';
export { entityToRow, assessmentToRow, artifactToRow, degradedInboxSources } from '@/hooks/inbox-rows';

/**
 * UX-053: bounded retry — per outage episode, the banner's Retry refetches only
 * the failed sources at most this many times; the counter resets once every
 * source is healthy again.
 */
export const MAX_INBOX_RETRIES = 3;

// ── Live inbox (pending across all three kinds) ────────────────────────────

export function useInbox() {
  const assessments = usePendingAssessments();
  const entities = useProposedEntities('pending');
  const artifacts = useProposedArtifacts('pending');
  const approveA = useApproveAssessment();
  const rejectA = useRejectAssessment();
  const dismissA = useDismissAssessment();
  const approveE = useApproveProposedEntity();
  const rejectE = useRejectProposedEntity();
  const dismissE = useDismissProposedEntity();
  const approveR = useApproveProposedArtifact();
  const rejectR = useRejectProposedArtifact();
  const dismissR = useDismissProposedArtifact();

  const rows = useMemo<InboxRow[]>(
    () => [
      ...(entities.data ?? []).map(entityToRow),
      ...(artifacts.data ?? []).map(artifactToRow),
      ...(assessments.data ?? []).map(assessmentToRow),
    ],
    [entities.data, artifacts.data, assessments.data]
  );

  const busy =
    approveA.isPending ||
    rejectA.isPending ||
    dismissA.isPending ||
    approveE.isPending ||
    rejectE.isPending ||
    dismissE.isPending ||
    approveR.isPending ||
    rejectR.isPending ||
    dismissR.isPending;

  const approve = (r: InboxRow) => {
    if (r.kind === 'discovery') approveE.mutate({ id: r.id });
    else if (r.kind === 'recommendation') approveR.mutate({ id: r.id });
    else approveA.mutate({ id: r.id });
  };
  const reject = (r: InboxRow) => {
    if (r.kind === 'discovery') rejectE.mutate({ id: r.id });
    else if (r.kind === 'recommendation') rejectR.mutate({ id: r.id });
    else rejectA.mutate({ id: r.id });
  };
  const dismiss = (r: InboxRow) => {
    if (r.kind === 'discovery') dismissE.mutate({ id: r.id });
    else if (r.kind === 'recommendation') dismissR.mutate({ id: r.id });
    else dismissA.mutate({ id: r.id });
  };

  // UX-053: per-source health instead of one collapsed error. Rows above are
  // already the concatenation of whichever sources succeeded — a failed source
  // must degrade its own lane, never blank the others.
  const sourceHealth: InboxSourceHealth = useMemo(
    () => ({
      discoveries: !!entities.error,
      recommendations: !!artifacts.error,
      verdicts: !!assessments.error,
    }),
    [entities.error, artifacts.error, assessments.error]
  );
  const anySourceFailed = sourceHealth.discoveries || sourceHealth.recommendations || sourceHealth.verdicts;
  const allSourcesFailed = sourceHealth.discoveries && sourceHealth.recommendations && sourceHealth.verdicts;

  // Bounded retry: the ref is the authoritative counter (state updaters must
  // stay pure — refetch side effects cannot live inside one), and the state
  // mirror re-renders the Retry button into its exhausted form.
  const [retryCount, setRetryCount] = useState(0);
  const retryCountRef = useRef(0);
  const refetchRef = useRef({ entities, artifacts, assessments });
  refetchRef.current = { entities, artifacts, assessments };
  // The episode ends only on a SETTLED recovery — while a retry is in flight
  // TanStack can transiently clear the error, and resetting there would hand
  // back retry budget that was never earned.
  const anyFetching = entities.isFetching || artifacts.isFetching || assessments.isFetching;
  useEffect(() => {
    if (!anySourceFailed && !anyFetching) {
      retryCountRef.current = 0;
      setRetryCount(0);
    }
  }, [anySourceFailed, anyFetching]);

  const retriesExhausted = retryCount >= MAX_INBOX_RETRIES;
  const retryFailed = useCallback(() => {
    if (retryCountRef.current >= MAX_INBOX_RETRIES) return;
    retryCountRef.current += 1;
    setRetryCount(retryCountRef.current);
    const current = refetchRef.current;
    if (current.entities.error) void current.entities.refetch();
    if (current.artifacts.error) void current.artifacts.refetch();
    if (current.assessments.error) void current.assessments.refetch();
  }, []);

  return {
    rows,
    // isPending (not TanStack's isLoading = isPending && isFetching): the three
    // composed queries are auth-gated (P-A4), so while Firebase restores the
    // session they are disabled — isFetching is false but there's no data yet.
    // Consumers must keep showing the skeleton through that window instead of
    // flashing the empty state (the useBriefing "Phase 0 step 0.10" contract).
    isLoading: assessments.isPending || entities.isPending || artifacts.isPending,
    sourceHealth,
    anySourceFailed,
    allSourcesFailed,
    retryFailed,
    retriesExhausted,
    busy,
    approve,
    reject,
    dismiss,
  };
}

// ── Archive (resolved history — the items that "stay" after a decision) ─────

const NON_PENDING = ['approved', 'rejected', 'dismissed'] as const;

async function listResolved<T>(endpoint: string, key: string): Promise<T[]> {
  const results = await Promise.all(
    NON_PENDING.map(async (status) => {
      const res = await fetchWithAuth(`${endpoint}?status=${status}`);
      if (!res.ok) return [] as T[];
      const data = await res.json();
      return (data[key] ?? []) as T[];
    })
  );
  return results.flat();
}

/**
 * The resolved history across all kinds, newest first. One query, fanned out internally.
 *
 * Gated on Firebase auth-state restoration via `useAuth()` (P-A4) — same pattern as the
 * three pending-lane hooks it composes: without the gate, the fan-out fires on mount
 * before `onAuthStateChanged` restores the session, `fetchWithAuth` ships with no
 * Authorization header, and the triage list routes correctly 401.
 */
export function useInboxArchive() {
  const { user, loading } = useAuth();
  const query = useQuery({
    queryKey: ['inbox', 'archive'],
    enabled: !loading && !!user,
    queryFn: async (): Promise<InboxRow[]> => {
      const [entities, assessments, artifacts] = await Promise.all([
        listResolved<ProposedEntity>('/api/triage/entities', 'entities'),
        listResolved<ProposedAssessment>('/api/triage/assessments', 'assessments'),
        listProposedArtifacts('approved')
          .then((a) =>
            Promise.all([listProposedArtifacts('rejected'), listProposedArtifacts('dismissed')]).then((rest) => [
              ...a,
              ...rest.flat(),
            ])
          )
          .catch(() => [] as ProposedArtifact[]),
      ]);
      return [...entities.map(entityToRow), ...assessments.map(assessmentToRow), ...artifacts.map(artifactToRow)];
    },
    staleTime: 30_000,
    // Poll while any recommendation is still generating, so 'generating…' flips to
    // 'ready' (with its output link) without the user having to refresh.
    refetchInterval: (q) =>
      (q.state.data as InboxRow[] | undefined)?.some((r) => r.generationStatus === 'generating') ? 5_000 : false,
  });
  // isPending, not isLoading — keep the skeleton up while the auth gate holds
  // (see the useInbox return comment).
  return { rows: query.data ?? [], isLoading: query.isPending, error: query.error, refetch: query.refetch };
}
