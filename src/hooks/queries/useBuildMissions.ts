/**
 * @file useBuildMissions.ts
 * @description TanStack Query hooks for build missions (kind 'build') —
 * list polling while any mission is active, plus gate/cancel mutations
 * against the authenticated API routes.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/components/providers/AuthProvider';
import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { MAX_RECOVERY_ADDITIONAL_TURNS } from '@/lib/build-mission-recovery';
import { getBuildMissions } from '@/lib/missions-client';
import { buildMissionKeys } from '@/lib/query-keys';
import type { Mission } from '@/lib/schemas/mission';

const ACTIVE_POLL_MS = 5_000;
const IDLE_POLL_MS = 30_000;

/** Build missions for the signed-in user; polls faster while one is live. */
export function useBuildMissions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: buildMissionKeys.list(user?.uid ?? 'anonymous'),
    enabled: Boolean(user?.uid),
    queryFn: () => getBuildMissions(user!.uid),
    refetchInterval: (query) => {
      const missions = query.state.data as Mission[] | undefined;
      const anyActive = missions?.some((m) => m.status === 'running' || m.status === 'pending');
      return anyActive ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    },
  });
}

export interface GateResolution {
  missionId: string;
  gate: 'budget' | 'stall' | 'final';
  decision: 'approve' | 'deny';
  topUpUsd?: number;
  note?: string;
}

/** Resolve a human gate (budget top-up / stall / final approval). */
export function useResolveGate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ missionId, ...body }: GateResolution) => {
      const res = await fetchWithAuth(`/api/missions/${missionId}/gates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `Gate resolution failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

export interface DispatchArtifactInput {
  prompt: string;
  budgetUsd?: number;
  modelOverrides?: { plan?: string; build?: string; qa?: string; escalation?: string };
}

/** Dispatch a new build mission (artifact) with budget + per-stage models. */
export function useDispatchArtifact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DispatchArtifactInput) => {
      const res = await fetchWithAuth('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, kind: 'build', agent: 'builder' }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        const flat = typeof detail.error === 'string' ? detail.error : JSON.stringify(detail.error ?? {});
        throw new Error(flat || `Dispatch failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

/**
 * Dispatch a Technology Evaluation (E1) — the brief is composed server-side
 * from the graph (the technology's real repo + linked use cases), so the
 * caller only supplies the technology and an optional budget.
 */
export function useDispatchEvaluation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      technologyId,
      useCaseIds,
      budgetUsd,
    }: {
      technologyId: string;
      useCaseIds?: string[];
      budgetUsd?: number;
    }) => {
      const res = await fetchWithAuth('/api/missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: `Evaluate technology ${technologyId}`, // ignored — brief composed from the graph
          kind: 'build',
          agent: 'builder',
          artifactKind: 'evaluation',
          motivation: {
            sourceTechnologyId: technologyId,
            useCaseIds: useCaseIds ?? [],
            painPointIds: [],
            strategyIds: [],
          },
          budgetUsd: budgetUsd ?? 15,
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(typeof detail.error === 'string' ? detail.error : `Evaluation dispatch failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

/** Iterate on a finished build mission — same sandbox volume, new work. */
export function useIterateBuildMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ missionId, instructions }: { missionId: string; instructions: string }) => {
      const res = await fetchWithAuth(`/api/missions/${missionId}/iterate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instructions }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `Iterate failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

export interface ResumeBuildArtifactInput {
  missionId: string;
  additionalTurns: number;
  additionalBudgetUsd: number;
  confirmationText?: string;
}

export interface ResumeBuildArtifactSuccess {
  ok: true;
  missionId: string;
  additionalTurns: number;
  additionalBudgetUsd: number;
  authorizedMaxTurns: number;
  capUsd: number;
}

export interface ResumeBuildArtifactConfirmation {
  requiresConfirmation: true;
  confirmationPhrase: string;
  amountUsd?: number;
  message?: string;
}

export type ResumeBuildArtifactResult = ResumeBuildArtifactSuccess | ResumeBuildArtifactConfirmation;

function isResumeConfirmation(value: unknown): value is ResumeBuildArtifactConfirmation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.requiresConfirmation === true &&
    typeof candidate.confirmationPhrase === 'string' &&
    candidate.confirmationPhrase.length > 0
  );
}

function isResumeSuccess(value: unknown): value is ResumeBuildArtifactSuccess {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.ok === true &&
    typeof candidate.missionId === 'string' &&
    candidate.missionId.length > 0 &&
    typeof candidate.additionalTurns === 'number' &&
    Number.isSafeInteger(candidate.additionalTurns) &&
    candidate.additionalTurns > 0 &&
    candidate.additionalTurns <= MAX_RECOVERY_ADDITIONAL_TURNS &&
    typeof candidate.additionalBudgetUsd === 'number' &&
    Number.isFinite(candidate.additionalBudgetUsd) &&
    candidate.additionalBudgetUsd >= 0 &&
    typeof candidate.authorizedMaxTurns === 'number' &&
    Number.isSafeInteger(candidate.authorizedMaxTurns) &&
    candidate.authorizedMaxTurns > 0 &&
    typeof candidate.capUsd === 'number' &&
    Number.isFinite(candidate.capUsd) &&
    candidate.capUsd >= 0
  );
}

function resumeError(detail: unknown, status: number): Error {
  if (detail && typeof detail === 'object' && typeof (detail as { error?: unknown }).error === 'string') {
    return new Error((detail as { error: string }).error);
  }
  if (detail && typeof detail === 'object' && 'error' in detail) {
    return new Error(JSON.stringify((detail as { error: unknown }).error));
  }
  return new Error(`Resume failed (${status})`);
}

/** Resume an eligible failed Limitless build with explicit turn and spend authority. */
export function useResumeBuildArtifact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ missionId, ...body }: ResumeBuildArtifactInput): Promise<ResumeBuildArtifactResult> => {
      const res = await fetchWithAuth(`/api/missions/${missionId}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const detail: unknown = await res.json().catch(() => ({}));
      if ((res.status === 409 || res.status === 428) && isResumeConfirmation(detail)) {
        return detail;
      }
      if (!res.ok) {
        throw resumeError(detail, res.status);
      }
      if (!isResumeSuccess(detail)) {
        throw new Error('Resume returned an invalid response');
      }
      return detail;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

/** Cancel a running build mission (stops the container, keeps the volume). */
export function useCancelBuildMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (missionId: string) => {
      const res = await fetchWithAuth(`/api/missions/${missionId}/cancel`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `Cancel failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

/** POST a build-artifact lifecycle action (start | stop) for an app's sandbox. */
function useArtifactLifecycle(action: 'start' | 'stop') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (missionId: string) => {
      const res = await fetchWithAuth(`/api/missions/${missionId}/${action}`, { method: 'POST' });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `${action} failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}

/** Start (resume) an app artifact's stopped sandbox + relaunch its preview. */
export const useStartBuildArtifact = () => useArtifactLifecycle('start');
/** Stop (pause) an app artifact's sandbox (keeps the completed status + volume). */
export const useStopBuildArtifact = () => useArtifactLifecycle('stop');

/** Delete a build artifact: cascades the output entity + destroys the sandbox. */
export function useDeleteBuildArtifact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (missionId: string) => {
      const res = await fetchWithAuth(`/api/missions/${missionId}`, { method: 'DELETE' });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error ?? `Delete failed (${res.status})`);
      }
      return res.json();
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: buildMissionKeys.all }),
  });
}
