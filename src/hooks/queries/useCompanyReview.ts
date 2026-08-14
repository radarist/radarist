'use client';

/**
 * @file hooks/queries/useCompanyReview.ts
 * @description AI-043 — client access to the human source-review workflow.
 * Reads the review projection + derived readiness + the caller's own decisions,
 * and exposes record + promote mutations. All requests are authenticated via
 * `fetchWithAuth`; readiness is derived server-side and never written by the client.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { fetchWithAuth } from '@/lib/fetch-with-auth';
import { companyKeys } from '@/lib/query-keys';
import type {
  CompanyReviewArtifactKind,
  CompanyReviewDecision,
  CompanyReviewEvent,
  CompanyReviewProjection,
  CompanyReviewReadiness,
  CompanyReviewStatus,
} from '@/lib/company-review';

export interface CompanyReviewState {
  projection: CompanyReviewProjection;
  readiness: CompanyReviewReadiness;
  events: CompanyReviewEvent[];
}

export interface RecordReviewDecisionArgs {
  artifactKind: CompanyReviewArtifactKind;
  artifactVersion: string;
  area: string;
  areaDigest: string;
  draftDigest: string;
  sourceIds: string[];
  decision: CompanyReviewDecision;
  note?: string;
}

export const companyReviewKeys = {
  all: ['company-review'] as const,
  detail: (companyId: string) => ['company-review', companyId] as const,
  /** Prefix for every batch review-summary query (queue statuses). */
  summaries: ['company-review-summaries'] as const,
};

/**
 * Invalidate every view a recorded decision or a promotion can move: this
 * company's review detail, the review-queue summaries (so a now-ready or now-blocked
 * draft leaves/updates the queue WITHOUT a reload), and — because promotion writes
 * canonical fields — the company detail + list. One shared helper so record and
 * promote can never drift into invalidating different sets.
 */
function invalidateReviewViews(queryClient: QueryClient, companyId: string): void {
  void queryClient.invalidateQueries({ queryKey: companyReviewKeys.detail(companyId) });
  void queryClient.invalidateQueries({ queryKey: companyReviewKeys.summaries });
  void queryClient.invalidateQueries({ queryKey: companyKeys.detail(companyId) });
  void queryClient.invalidateQueries({ queryKey: companyKeys.lists() });
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

export interface CompanyReviewSummary {
  status: CompanyReviewStatus;
  hasDraft: boolean;
}

/**
 * Batch review-status for the queue: one authenticated request derives the
 * caller's CURRENT review status for every requested company (no N+1).
 */
export function useCompanyReviewSummaries(companyIds: string[]) {
  const sorted = [...companyIds].sort();
  return useQuery<Record<string, CompanyReviewSummary>>({
    queryKey: [...companyReviewKeys.summaries, sorted],
    enabled: sorted.length > 0,
    queryFn: async () => {
      const response = await fetchWithAuth('/api/companies/review-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyIds: sorted }),
      });
      if (!response.ok) {
        const body = (await readJson(response)) as { error?: string } | undefined;
        throw new Error(body?.error ?? `Failed to load review summaries (${response.status})`);
      }
      return ((await response.json()) as { summaries: Record<string, CompanyReviewSummary> }).summaries;
    },
  });
}

/** GET the current review state for a company (auth required). */
export function useCompanyReview(companyId: string | undefined, enabled = true) {
  return useQuery<CompanyReviewState>({
    queryKey: companyReviewKeys.detail(companyId ?? ''),
    enabled: Boolean(companyId) && enabled,
    queryFn: async () => {
      const response = await fetchWithAuth(`/api/companies/${companyId}/review`);
      if (!response.ok) {
        const body = (await readJson(response)) as { error?: string } | undefined;
        throw new Error(body?.error ?? `Failed to load review state (${response.status})`);
      }
      return (await response.json()) as CompanyReviewState;
    },
  });
}

/**
 * Record one review decision. On success the review query is invalidated so the
 * durable server state (not an optimistic guess) is re-read. On a stale draft the
 * server returns 409 and the caller must reload.
 */
export function useRecordReviewDecision(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (args: RecordReviewDecisionArgs) => {
      const idempotencyKey = generateIdempotencyKey();
      const response = await fetchWithAuth(`/api/companies/${companyId}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId, idempotencyKey, ...args }),
      });
      const body = (await readJson(response)) as { error?: string; message?: string } | undefined;
      if (!response.ok) {
        if (response.status === 409 && body?.error === 'stale_draft') {
          throw new StaleDraftError(body?.message ?? 'The draft changed. Reload and review again.');
        }
        throw new Error(body?.message ?? body?.error ?? `Failed to record decision (${response.status})`);
      }
      return body;
    },
    onSuccess: () => invalidateReviewViews(queryClient, companyId),
  });
}

/** Promote every currently-approved claim into canonical Company fields. */
export function usePromoteReviewClaims(companyId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const response = await fetchWithAuth(`/api/companies/${companyId}/review/promote`, { method: 'POST' });
      const body = (await readJson(response)) as
        { error?: string; promoted?: string[]; graphSync?: string } | undefined;
      if (!response.ok) {
        throw new Error(body?.error ?? `Failed to promote (${response.status})`);
      }
      return body as { promoted: string[]; graphSync: 'delivered' | 'deferred' | 'suppressed' | 'failed' };
    },
    onSuccess: () => invalidateReviewViews(queryClient, companyId),
  });
}

/** A stale-draft rejection, surfaced distinctly so the UI can prompt a reload. */
export class StaleDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleDraftError';
  }
}

function generateIdempotencyKey(): string {
  const cryptoObj = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // Deterministic-charset fallback (schema requires [A-Za-z0-9_-]{8,128}).
  return `k-${Math.abs(hashString(String(Date.now()) + Math.random())).toString(36)}-${Math.abs(
    hashString(Math.random().toString())
  ).toString(36)}`.slice(0, 60);
}

function hashString(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  return h;
}
