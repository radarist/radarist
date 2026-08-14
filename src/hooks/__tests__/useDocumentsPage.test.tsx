/**
 * @file useDocumentsPage.test.tsx
 * @description Pins the documents-page sort semantics added for the table's
 * Type + Links columns:
 *
 *   1. compareDocuments('type'): locale-aware ordering of the *display label*
 *      (DOCUMENT_TYPE_LABELS) — what the Type column renders — not the raw
 *      type key; unknown types fall back to the raw string.
 *   2. compareDocuments('linkedEntityCount'): numeric; rows the Links column
 *      renders as '—' (undefined OR 0) sort last in BOTH directions.
 *   3. toggleSort('type') / toggleSort('linkedEntityCount') re-sort
 *      filteredDocuments through the same mechanism as the other sortable
 *      columns (asc on first click, desc on second).
 *
 * @jest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import type { Document } from '@/lib/types';

// ============================================================================
// MOCKS
// ============================================================================

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

jest.mock('@/lib/document-service', () => ({
  getDocuments: jest.fn(),
  deleteDocument: jest.fn(),
  deleteDocuments: jest.fn(),
  retryDocumentProcessing: jest.fn(),
}));

jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }),
}));

// Stable singletons — a fresh jest.fn() per render would change the identity
// of useCallback deps (loadDocuments depends on `toast`) and loop the load
// effect, so the hooks must return the same instances every call.
jest.mock('@/hooks/use-toast', () => {
  const toast = jest.fn();
  // `__toast` exposes the singleton to assertions without calling the hook at
  // module scope (which react-hooks/rules-of-hooks rightly rejects).
  return { useToast: () => ({ toast }), __toast: toast };
});

jest.mock('@/hooks/useSheetUrl', () => {
  const openSheet = jest.fn();
  const closeSheet = jest.fn();
  return {
    useSheetUrl: () => ({
      openEntityId: undefined,
      isOpen: false,
      openSheet,
      closeSheet,
    }),
  };
});

jest.mock('@/hooks/useDataRefresh', () => ({ useDataRefresh: jest.fn() }));

import { useDocumentsPage, compareDocuments } from '@/hooks/useDocumentsPage';
import { getDocuments, retryDocumentProcessing } from '@/lib/document-service';
import { fetchWithAuth } from '@/lib/fetch-with-auth';

const mockGetDocuments = getDocuments as jest.MockedFunction<typeof getDocuments>;
const mockRetryDocumentProcessing = retryDocumentProcessing as jest.MockedFunction<typeof retryDocumentProcessing>;
const mockFetchWithAuth = fetchWithAuth as jest.MockedFunction<typeof fetchWithAuth>;
// The toast mock is a module-level singleton (see the mock above); `__toast` is
// the same instance every render receives.
const mockToast = (jest.requireMock('@/hooks/use-toast') as { __toast: jest.Mock }).__toast;

// ============================================================================
// HELPERS
// ============================================================================

let docCounter = 0;

function makeDoc(overrides: Partial<Document>): Document {
  docCounter++;
  return {
    id: `doc-${docCounter}`,
    title: `Doc ${docCounter}`,
    type: 'pdf',
    storageUrl: `documents/doc-${docCounter}.pdf`,
    status: 'processed',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    uploadedBy: 'user-1',
    ...overrides,
  } as Document;
}

// ============================================================================
// compareDocuments — pure sort semantics
// ============================================================================

describe('compareDocuments', () => {
  describe('type (sorts by display label)', () => {
    const md = makeDoc({ type: 'markdown' }); // label: 'Markdown'
    const pdf = makeDoc({ type: 'pdf' }); // label: 'PDF'
    const dr = makeDoc({ type: 'deep-research' }); // label: 'Deep Research'
    const url = makeDoc({ type: 'url' }); // label: 'URL'

    it('orders ascending by display label', () => {
      const sorted = [url, pdf, md, dr].sort((a, b) => compareDocuments(a, b, { key: 'type', direction: 'asc' }));
      expect(sorted.map((d) => d.type)).toEqual(['deep-research', 'markdown', 'pdf', 'url']);
    });

    it('orders descending by display label', () => {
      const sorted = [md, dr, url, pdf].sort((a, b) => compareDocuments(a, b, { key: 'type', direction: 'desc' }));
      expect(sorted.map((d) => d.type)).toEqual(['url', 'pdf', 'markdown', 'deep-research']);
    });

    it('falls back to the raw type string for unknown types', () => {
      const unknown = makeDoc({ type: 'audio' as Document['type'] });
      // 'audio' (raw fallback) < 'Markdown' label
      expect(compareDocuments(unknown, md, { key: 'type', direction: 'asc' })).toBeLessThan(0);
    });
  });

  describe('linkedEntityCount (missing last in both directions)', () => {
    const five = makeDoc({ linkedEntityCount: 5 });
    const two = makeDoc({ linkedEntityCount: 2 });
    const zero = makeDoc({ linkedEntityCount: 0 }); // renders '—' → missing
    const none = makeDoc({ linkedEntityCount: undefined }); // renders '—' → missing

    it('orders ascending with missing (undefined and 0) last', () => {
      const sorted = [none, five, zero, two].sort((a, b) =>
        compareDocuments(a, b, { key: 'linkedEntityCount', direction: 'asc' })
      );
      expect(sorted.map((d) => d.linkedEntityCount)).toEqual([2, 5, undefined, 0]);
    });

    it('orders descending with missing (undefined and 0) STILL last', () => {
      const sorted = [zero, two, none, five].sort((a, b) =>
        compareDocuments(a, b, { key: 'linkedEntityCount', direction: 'desc' })
      );
      expect(sorted.map((d) => d.linkedEntityCount)).toEqual([5, 2, 0, undefined]);
    });

    it('two missing rows compare equal (stable sort keeps their order)', () => {
      expect(compareDocuments(zero, none, { key: 'linkedEntityCount', direction: 'asc' })).toBe(0);
      expect(compareDocuments(zero, none, { key: 'linkedEntityCount', direction: 'desc' })).toBe(0);
    });
  });
});

// ============================================================================
// toggleSort wiring through the hook
// ============================================================================

describe('useDocumentsPage toggleSort', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sorts filteredDocuments by type label asc, then desc on second toggle', async () => {
    mockGetDocuments.mockResolvedValue([
      makeDoc({ id: 'a', type: 'url' }),
      makeDoc({ id: 'b', type: 'deep-research' }),
      makeDoc({ id: 'c', type: 'pdf' }),
    ]);

    const { result } = renderHook(() => useDocumentsPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.toggleSort('type'));
    expect(result.current.sortState).toEqual({ key: 'type', direction: 'asc' });
    expect(result.current.filteredDocuments.map((d) => d.type)).toEqual(['deep-research', 'pdf', 'url']);

    act(() => result.current.toggleSort('type'));
    expect(result.current.sortState).toEqual({ key: 'type', direction: 'desc' });
    expect(result.current.filteredDocuments.map((d) => d.type)).toEqual(['url', 'pdf', 'deep-research']);
  });

  it('sorts filteredDocuments by links with missing rows last in both directions', async () => {
    mockGetDocuments.mockResolvedValue([
      makeDoc({ id: 'a', linkedEntityCount: undefined }),
      makeDoc({ id: 'b', linkedEntityCount: 7 }),
      makeDoc({ id: 'c', linkedEntityCount: 1 }),
      makeDoc({ id: 'd', linkedEntityCount: 0 }),
    ]);

    const { result } = renderHook(() => useDocumentsPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.toggleSort('linkedEntityCount'));
    expect(result.current.filteredDocuments.map((d) => d.id)).toEqual(['c', 'b', 'a', 'd']);

    act(() => result.current.toggleSort('linkedEntityCount'));
    expect(result.current.filteredDocuments.map((d) => d.id)).toEqual(['b', 'c', 'a', 'd']);
  });
});

/**
 * UX-036 — ONE acknowledged processing path.
 *
 * The row menu offers "Process" for an `uploaded` document and "Retry" for the
 * other retryable states. Retry went through `/api/documents/retry`: an atomic
 * claim, one canonical `app/document.process.requested` event, and a 202 the UI
 * can trust. Process posted to `/api/documents/process`, which ran the whole
 * pipeline INLINE in the HTTP request — no claim, no event, no acknowledgement.
 *
 * That second path reintroduced every failure UX-036 closed:
 *  - it could run concurrently with a live claimed worker run, so two writers
 *    deleted and recreated the same document's chunks;
 *  - nothing acknowledged the work, so the toast's "Processing Complete" was
 *    the client's own guess about a request that may have been aborted;
 *  - an aborted request left the document mid-pipeline while the UI reported a
 *    finished state.
 *
 * Both menu items must therefore reach the SAME enqueue.
 */
describe('useDocumentsPage processing enqueue (UX-036)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRetryDocumentProcessing.mockResolvedValue({ documentId: 'doc-1', eventIds: ['01EVENT'] });
  });

  const renderWithOneDocument = async () => {
    mockGetDocuments.mockResolvedValue([makeDoc({ id: 'doc-1', status: 'uploaded' })]);
    const { result } = renderHook(() => useDocumentsPage());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    return result;
  };

  it('routes Process through the acknowledged enqueue, not a second inline route', async () => {
    const result = await renderWithOneDocument();

    await act(async () => {
      await result.current.handleProcessDocument(result.current.filteredDocuments[0]);
    });

    expect(mockRetryDocumentProcessing).toHaveBeenCalledWith('doc-1');
    // The inline pipeline route must not be reachable from the UI at all.
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('reports the queue refusal instead of claiming the document was processed', async () => {
    const result = await renderWithOneDocument();
    mockRetryDocumentProcessing.mockRejectedValue(new Error('Processing is already running for this document.'));

    await act(async () => {
      await result.current.handleProcessDocument(result.current.filteredDocuments[0]);
    });

    const descriptions = mockToast.mock.calls.map(([args]) => String(args.description ?? ''));
    expect(descriptions.some((d) => d.includes('already running'))).toBe(true);
    expect(descriptions.some((d) => /processed successfully/i.test(d))).toBe(false);
  });
});
