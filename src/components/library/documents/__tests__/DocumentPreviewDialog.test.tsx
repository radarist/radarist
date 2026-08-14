/**
 * @file DocumentPreviewDialog.test.tsx
 * @description Tests for the document Preview dialog — focused on the
 * fallback ladder (mocked fetch + mocked chunk reads):
 *
 * - Loading skeleton while fetching
 * - Markdown success path (file fetched, chunks untouched)
 * - Fetch rejection / non-OK response → extracted-text fallback with an
 *   honest note + the "what the AI sees" header
 * - No-file documents (URL type) → extracted text directly, no fetch
 * - Too-large docx → extracted text with the size note, no fetch
 * - Fetch AND chunk read both failing → error state with download hint
 * - Empty chunk text → "No extracted text yet" empty state
 * - Defensive `none` strategy → error message
 *
 * Renderer-selection logic itself is covered in lib/__tests__/document-preview.test.ts.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Document, DocumentChunk } from '@/lib/types';

// ============================================================================
// Mocks
// ============================================================================

// react-markdown: render children as plain text (ESM-only package)
jest.mock('react-markdown', () => {
  return function MockReactMarkdown({ children }: { children: string }) {
    return <div data-testid="markdown-content">{children}</div>;
  };
});

// remark-gfm: no-op plugin
jest.mock('remark-gfm', () => {
  return function mockRemarkGfm() {
    return undefined;
  };
});

// lucide-react: lightweight stub icons (ESM-only package, same pattern as
// AIMessage.test.tsx)
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  );
});

jest.mock('next-themes', () => ({
  useTheme: () => ({ resolvedTheme: 'light' }),
}));

const mockFetchWithAuth = jest.fn();
jest.mock('@/lib/fetch-with-auth', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

const mockGetActiveChunks = jest.fn();
jest.mock('@/lib/document-chunk-service', () => ({
  getActiveChunksForDocument: (...args: unknown[]) => mockGetActiveChunks(...args),
}));

// formatFileSize lives in the page hook whose import chain reaches Firestore
// services — mock the module so the test stays free of the Firebase chain.
jest.mock('@/hooks/useDocumentsPage', () => ({
  formatFileSize: (bytes?: number) => (bytes ? `${bytes} B` : '—'),
}));

// Radix primitives: lightweight stubs (portal/focus-trap free), matching the
// house pattern in DocumentUploadDialog.test.tsx.
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog-content">{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div data-testid="scroll-area">{children}</div>,
}));

// Import after mocks
import { DocumentPreviewDialog } from '../DocumentPreviewDialog';

// ============================================================================
// Helpers
// ============================================================================

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    title: 'Quarterly Strategy',
    type: 'markdown',
    storageUrl: 'documents/123-abc-strategy.md',
    status: 'processed',
    chunkCount: 2,
    fileSize: 2048,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uploadedBy: 'user-1',
    ...overrides,
  };
}

function makeChunks(contents: string[]): DocumentChunk[] {
  return contents.map((content, index) => ({
    id: `chunk-${index}`,
    documentId: 'doc-1',
    content,
    metadata: { startChar: 0, endChar: content.length },
    chunkIndex: index,
    createdAt: Date.now(),
  }));
}

function okTextResponse(text: string) {
  return { ok: true, status: 200, text: jest.fn().mockResolvedValue(text) };
}

function renderDialog(document: Document, onDownload?: (doc: Document) => void) {
  return render(
    <DocumentPreviewDialog document={document} open={true} onOpenChange={jest.fn()} onDownload={onDownload} />
  );
}

const AI_HEADER = /Extracted text preview — this is what the AI sees/;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetActiveChunks.mockResolvedValue(makeChunks(['First chunk text.', 'Second chunk text.']));
});

// ============================================================================
// Tests
// ============================================================================

describe('DocumentPreviewDialog', () => {
  it('shows the loading skeleton while the file is being fetched', () => {
    mockFetchWithAuth.mockReturnValue(new Promise(() => {})); // never resolves
    renderDialog(makeDocument());

    expect(screen.getByTestId('preview-skeleton')).toBeInTheDocument();
  });

  it('renders fetched markdown without touching the chunk store', async () => {
    mockFetchWithAuth.mockResolvedValue(okTextResponse('# Hello Radar'));
    renderDialog(makeDocument({ type: 'markdown' }));

    const markdown = await screen.findByTestId('markdown-content');
    expect(markdown).toHaveTextContent('# Hello Radar');
    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/documents/download?id=doc-1');
    expect(mockGetActiveChunks).not.toHaveBeenCalled();
  });

  it('falls back to extracted text with an honest note when the file fetch rejects', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));
    renderDialog(makeDocument({ type: 'markdown' }));

    expect(await screen.findByText(AI_HEADER)).toBeInTheDocument();
    expect(screen.getByText(/Could not fetch the original file/)).toBeInTheDocument();
    expect(screen.getByText(/First chunk text\./)).toBeInTheDocument();
    expect(screen.getByText(/Second chunk text\./)).toBeInTheDocument();
    expect(mockGetActiveChunks).toHaveBeenCalledWith('doc-1');
  });

  it('falls back to extracted text when the download API returns non-OK', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false, status: 404 });
    renderDialog(makeDocument({ type: 'pdf' }));

    expect(await screen.findByText(AI_HEADER)).toBeInTheDocument();
    expect(screen.getByText(/Could not fetch the original file/)).toBeInTheDocument();
  });

  it('renders extracted text directly (no fetch, no note) for URL documents without a file', async () => {
    renderDialog(makeDocument({ type: 'url', storageUrl: '', chunkCount: 2 }));

    expect(await screen.findByText(AI_HEADER)).toBeInTheDocument();
    expect(screen.getByText(/First chunk text\./)).toBeInTheDocument();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    // The no-file path is by design — no apologetic note
    expect(screen.queryByText(/showing extracted text instead/)).not.toBeInTheDocument();
  });

  it('skips fetching and shows the size note for a too-large docx', async () => {
    renderDialog(makeDocument({ type: 'docx', fileSize: 25 * 1024 * 1024 }));

    expect(await screen.findByText(AI_HEADER)).toBeInTheDocument();
    expect(screen.getByText(/too large to preview in the browser/)).toBeInTheDocument();
    expect(screen.getByText(/First chunk text\./)).toBeInTheDocument();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('shows an error with a download hint when both the fetch and the chunk read fail', async () => {
    mockFetchWithAuth.mockRejectedValue(new Error('network down'));
    mockGetActiveChunks.mockRejectedValue(new Error('firestore down'));
    const onDownload = jest.fn();
    renderDialog(makeDocument({ type: 'pdf' }), onDownload);

    expect(
      await screen.findByText(/Could not load a preview or the extracted text for this document\./)
    ).toBeInTheDocument();
    // UX-060: the label comes from the shared availability contract — a
    // document with stored bytes is offered its "original", never a generic
    // "Download" that might hand over something else.
    expect(screen.getByRole('button', { name: /Download original instead/ })).toBeInTheDocument();
  });

  it('shows the empty state when the document has chunk metadata but no live chunk text', async () => {
    mockGetActiveChunks.mockResolvedValue([]);
    renderDialog(makeDocument({ type: 'url', storageUrl: '', chunkCount: 2 }));

    expect(await screen.findByText(/No extracted text yet/)).toBeInTheDocument();
  });

  it('shows a clear message for documents with neither a file nor chunks (defensive)', async () => {
    renderDialog(makeDocument({ type: 'markdown', storageUrl: '', chunkCount: 0 }));

    expect(await screen.findByText(/This document has no stored file and no extracted text\./)).toBeInTheDocument();
    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(mockGetActiveChunks).not.toHaveBeenCalled();
  });

  /**
   * UX-060: an empty URL document is not "broken" — nothing has been fetched
   * from its source yet, and the honest message names the recovery action.
   * The dialog reads this copy from the shared contract, so the tooltip on the
   * disabled launcher and the dialog body cannot disagree.
   */
  it('tells a URL document with no content what to do about it', async () => {
    renderDialog(
      makeDocument({ type: 'url', storageUrl: '', originalUrl: 'https://example.com/a', chunkCount: 0 })
    );

    expect(await screen.findByText(/retry processing to fetch and extract its content/)).toBeInTheDocument();
    expect(mockGetActiveChunks).not.toHaveBeenCalled();
  });

  /**
   * UX-060 regression: the dialog offered a download only when `storageUrl`
   * was set, so a URL document whose chunk read came back empty had no
   * affordance at all — while the detail sheet for the same document offered a
   * download that shipped a title-only stub.
   */
  it('offers the extracted-text export from the empty state of a no-file document', async () => {
    mockGetActiveChunks.mockResolvedValue([]);
    const onDownload = jest.fn();
    renderDialog(makeDocument({ type: 'url', storageUrl: '', chunkCount: 2 }), onDownload);

    expect(await screen.findByTestId('preview-empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download extracted text instead/ })).toBeInTheDocument();
  });

  it('falls back to extracted text when the conversion step throws (markdown text() failure)', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockRejectedValue(new Error('decode failure')),
    });
    renderDialog(makeDocument({ type: 'markdown' }));

    expect(await screen.findByText(AI_HEADER)).toBeInTheDocument();
    expect(screen.getByText(/Could not render the original file/)).toBeInTheDocument();
  });

  it('keeps the footer Download action wired to the existing download handler', async () => {
    mockFetchWithAuth.mockResolvedValue(okTextResponse('content'));
    const onDownload = jest.fn();
    const document = makeDocument();
    renderDialog(document, onDownload);

    const downloadButton = await screen.findByRole('button', { name: /Download original/ });
    fireEvent.click(downloadButton);
    await waitFor(() => expect(onDownload).toHaveBeenCalledWith(document));
  });
});
