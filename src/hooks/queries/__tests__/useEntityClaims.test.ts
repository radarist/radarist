/**
 * @file useEntityClaims.test.ts
 * @description Tests for the entity claims query hook (P5-D claims review surface).
 *
 * Pins:
 *   1. Fetches `/api/entities/[id]/claims` via fetchWithAuth and maps the
 *      DTO into the `EntityClaims` shape (asSubject/asObject split by the
 *      current entity, evidence attached per claim).
 *   2. Gated on auth (disabled while auth is restoring or logged out) and
 *      on a non-empty entityId.
 *   3. Surfaces fetch errors (including 503 degraded) as query errors
 *      instead of fabricating empty data.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockUseAuth = jest.fn();
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => mockUseAuth(),
}));

import { useEntityClaims } from '../useEntityClaims';

// ============================================================================
// FIXTURES
// ============================================================================

function makeClaimDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    predicate: 'ADDRESSES',
    subject: { id: 'ent-1', type: 'technology', name: 'TensorFlow' },
    object: { id: 'ent-2', type: 'useCase', name: 'ML complexity' },
    status: 'proposed',
    confidence: 85,
    statement: 'TensorFlow addresses ML complexity',
    assertedBy: 'agent:scout',
    asserterType: 'agent',
    createdAt: 1000,
    updatedAt: 2000,
    relationId: null,
    evidence: [
      {
        id: 'ev-1',
        sourceType: 'web_ref',
        snippet: 'TensorFlow simplifies ML.',
        sourceUrl: 'https://example.com',
        capturedAt: 1500,
      },
    ],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('useEntityClaims', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ user: { uid: 'user-1' }, loading: false });
  });

  it('fetches claims and splits them into asSubject/asObject', async () => {
    mockFetchWithAuth.mockResolvedValue(
      jsonResponse({
        claims: [
          makeClaimDto(),
          makeClaimDto({
            id: 'claim-2',
            subject: { id: 'ent-3', type: 'technology', name: 'PyTorch' },
            object: { id: 'ent-1', type: 'technology', name: 'TensorFlow' },
            predicate: 'COMPETES_WITH',
            evidence: [],
          }),
        ],
        totalCount: 2,
      })
    );

    const { result } = renderHook(() => useEntityClaims('ent-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/entities/ent-1/claims');

    const data = result.current.data!;
    expect(data.totalCount).toBe(2);
    expect(data.asSubject).toHaveLength(1);
    expect(data.asObject).toHaveLength(1);

    const asSubject = data.asSubject[0];
    expect(asSubject.id).toBe('claim-1');
    expect(asSubject.subjectId).toBe('ent-1');
    expect(asSubject.subjectName).toBe('TensorFlow');
    expect(asSubject.objectId).toBe('ent-2');
    expect(asSubject.objectName).toBe('ML complexity');
    expect(asSubject.predicate).toBe('ADDRESSES');
    expect(asSubject.status).toBe('proposed');
    expect(asSubject.confidence).toBe(85);
    expect(asSubject.evidence).toHaveLength(1);
    expect(asSubject.evidence[0].snippet).toBe('TensorFlow simplifies ML.');

    expect(data.asObject[0].id).toBe('claim-2');
    expect(data.asObject[0].objectId).toBe('ent-1');
  });

  it('does not fetch while auth is restoring', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: true });

    renderHook(() => useEntityClaims('ent-1'), { wrapper: createWrapper() });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('does not fetch when logged out', () => {
    mockUseAuth.mockReturnValue({ user: null, loading: false });

    renderHook(() => useEntityClaims('ent-1'), { wrapper: createWrapper() });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('does not fetch when entityId is empty', () => {
    renderHook(() => useEntityClaims(''), { wrapper: createWrapper() });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('respects the enabled option', () => {
    renderHook(() => useEntityClaims('ent-1', { enabled: false }), { wrapper: createWrapper() });

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('surfaces a 503 degraded response as a query error', async () => {
    mockFetchWithAuth.mockResolvedValue(jsonResponse({ degraded: true, error: 'Graph backend unavailable' }, 503));

    const { result } = renderHook(() => useEntityClaims('ent-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
  });

  it('can recover from an unavailable graph through an explicit refetch', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce(jsonResponse({ degraded: true, error: 'Graph backend unavailable' }, 503))
      .mockResolvedValueOnce(jsonResponse({ claims: [], totalCount: 0 }));

    const { result } = renderHook(() => useEntityClaims('ent-1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));

    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ asSubject: [], asObject: [], totalCount: 0 });
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
  });
});
