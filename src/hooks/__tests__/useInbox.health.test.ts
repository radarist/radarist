/**
 * @file useInbox.health.test.ts
 * @description UX-053 — per-source health for the Assessment inbox. One failed
 * source must degrade its own lane only: the rows from the healthy sources stay,
 * the failure is exposed as `sourceHealth` labels (never raw error text), and
 * Retry refetches ONLY the failed sources, bounded per outage episode.
 *
 * @jest-environment jsdom
 */
import React from 'react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

const mockFetch = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: (...a: unknown[]) => mockFetch(...a) }));
jest.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: jest.fn() }) }));

import { useInbox, MAX_INBOX_RETRIES, degradedInboxSources } from '../useInbox';

function wrapper(qc: QueryClient) {
  return function W({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const down = { ok: false, status: 500, json: async () => ({ error: 'boom' }) };

const ENTITY = { id: 'e1', name: 'TechX', entityType: 'technology', confidence: 80, status: 'pending', data: {} };
const ARTIFACT = {
  id: 'a1',
  artifactKind: 'report',
  title: 'AI agents report',
  confidence: 70,
  status: 'pending',
  generationStatus: 'idle',
  scope: { entityIds: [] },
  createdAt: 1,
  updatedAt: 1,
};
const ASSESSMENT = {
  id: 'v1',
  technologyId: 't1',
  technologyName: 'TechX',
  recommendation: 'trial',
  proposedRing: 'trial',
  confidence: 90,
  status: 'pending',
};

/** Route the three inbox endpoints; `failing` marks endpoint substrings to 500. */
function routeFetch(failing: string[] = []) {
  mockFetch.mockImplementation(async (url: string) => {
    if (failing.some((f) => url.includes(f))) return down;
    if (url.includes('/api/triage/entities')) return ok({ entities: [ENTITY] });
    if (url.includes('/api/triage/artifacts')) return ok({ artifacts: [ARTIFACT] });
    if (url.includes('/api/triage/assessments')) return ok({ assessments: [ASSESSMENT] });
    return down;
  });
}

const callsTo = (fragment: string) => mockFetch.mock.calls.filter(([u]) => String(u).includes(fragment)).length;

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('useInbox per-source health (UX-053)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-claudio' }, loading: false });
  });

  it('one failed source keeps the other sources’ rows and flags only that lane', async () => {
    routeFetch(['/api/triage/entities']);
    const { result } = renderHook(() => useInbox(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows.map((r) => r.kind).sort()).toEqual(['recommendation', 'verdict']);
    expect(result.current.sourceHealth).toEqual({ discoveries: true, recommendations: false, verdicts: false });
    expect(result.current.anySourceFailed).toBe(true);
    expect(result.current.allSourcesFailed).toBe(false);
    expect(degradedInboxSources(result.current.sourceHealth)).toEqual(['discoveries']);
  });

  it('a full outage is distinguishable from a genuinely empty inbox', async () => {
    routeFetch(['/api/triage/entities', '/api/triage/artifacts', '/api/triage/assessments']);
    const { result } = renderHook(() => useInbox(), { wrapper: wrapper(newClient()) });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.rows).toEqual([]);
    expect(result.current.allSourcesFailed).toBe(true);
    expect(degradedInboxSources(result.current.sourceHealth)).toEqual([
      'discoveries',
      'report recommendations',
      'verdicts',
    ]);
  });

  it('retryFailed refetches ONLY the failed sources and recovery clears the episode', async () => {
    routeFetch(['/api/triage/assessments']);
    const { result } = renderHook(() => useInbox(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.sourceHealth.verdicts).toBe(true));

    const entityCalls = callsTo('/api/triage/entities');
    const artifactCalls = callsTo('/api/triage/artifacts');

    routeFetch([]); // backend recovered
    act(() => result.current.retryFailed());

    await waitFor(() => expect(result.current.sourceHealth.verdicts).toBe(false));
    // Last-good lanes were not refetched by the targeted retry.
    expect(callsTo('/api/triage/entities')).toBe(entityCalls);
    expect(callsTo('/api/triage/artifacts')).toBe(artifactCalls);
    expect(result.current.rows).toHaveLength(3);
    expect(result.current.retriesExhausted).toBe(false);
  });

  it(`retry is bounded to ${MAX_INBOX_RETRIES} per outage episode`, async () => {
    routeFetch(['/api/triage/assessments']);
    const { result } = renderHook(() => useInbox(), { wrapper: wrapper(newClient()) });
    await waitFor(() => expect(result.current.sourceHealth.verdicts).toBe(true));

    const before = callsTo('/api/triage/assessments');
    for (let i = 0; i < MAX_INBOX_RETRIES; i++) {
      act(() => result.current.retryFailed());
      await waitFor(() => expect(result.current.sourceHealth.verdicts).toBe(true));
    }
    expect(result.current.retriesExhausted).toBe(true);
    expect(callsTo('/api/triage/assessments')).toBe(before + MAX_INBOX_RETRIES);

    // The 4th retry is a no-op — the budget is spent.
    act(() => result.current.retryFailed());
    await new Promise((r) => setTimeout(r, 25));
    expect(callsTo('/api/triage/assessments')).toBe(before + MAX_INBOX_RETRIES);
  });
});
