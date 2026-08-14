import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useMutation, useQuery } from '@tanstack/react-query';

let mockActiveTabIndex = 0;

jest.mock('@tanstack/react-query', () => ({
  useQuery: jest.fn(),
  useMutation: jest.fn(),
  useQueryClient: jest.fn(() => ({ invalidateQueries: jest.fn() })),
}));

jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/lib/document-service', () => ({
  getDocumentById: jest.fn(),
  deleteDocument: jest.fn(),
  retryDocumentProcessing: jest.fn(),
}));
jest.mock('@/lib/document-chunk-service', () => ({ getChunksForDocument: jest.fn() }));
jest.mock('@/lib/entity-document-link-service', () => ({
  getLinksForDocument: jest.fn(),
  deleteEntityDocumentLink: jest.fn(),
}));
jest.mock('@/lib/fetch-with-auth', () => ({ fetchWithAuth: jest.fn() }));
jest.mock('@/components/knowledge/LinkEntityForm', () => ({ LinkEntityForm: () => null }));
jest.mock('@/hooks/useTrackEntityView', () => ({ useTrackEntityView: jest.fn() }));
jest.mock('@/components/impulse/VerificationBadge', () => ({ VerificationBadge: () => null }));
jest.mock('@/components/feedback/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

jest.mock('../EntitySheetShell', () => ({
  EntitySheetShell: ({
    children,
    footer,
  }: {
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));
jest.mock('../EntitySheetTabs', () => ({
  EntitySheetTabs: ({ tabs }: { tabs: Array<{ content: React.ReactNode }> }) => <>{tabs[mockActiveTabIndex]?.content}</>,
}));
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { DocumentSheet } from '../DocumentSheet';

const mockUseQuery = jest.mocked(useQuery);
const mockUseMutation = jest.mocked(useMutation);

describe('DocumentSheet delete', () => {
  beforeEach(() => {
    mockActiveTabIndex = 0;
    mockUseQuery.mockReset();
    mockUseMutation.mockReset();
  });

  it('passes the selected id into the mutation before the nested dialog can clear it', () => {
    const deleteMutate = jest.fn();
    let mutationIndex = 0;

    mockUseQuery.mockReturnValue({
      data: {
        id: 'doc-delete-1',
        title: 'Disposable document',
        type: 'markdown',
        storageUrl: '',
        status: 'processed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        uploadedBy: 'test-user',
      },
      isLoading: false,
      error: null,
    } as never);
    mockUseMutation.mockImplementation(() => {
      const mutate = mutationIndex % 2 === 0 ? deleteMutate : jest.fn();
      mutationIndex += 1;
      return { mutate, isPending: false } as never;
    });

    const onOpenChange = jest.fn();
    const onDelete = jest.fn();
    const { rerender } = render(
      <DocumentSheet documentId="doc-delete-1" open onOpenChange={onOpenChange} onDelete={onDelete} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    rerender(<DocumentSheet documentId={null} open={false} onOpenChange={onOpenChange} onDelete={onDelete} />);
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    expect(deleteMutate).toHaveBeenCalledWith('doc-delete-1');
  });

  it('names the metadata copy action and copies the original URL', () => {
    const writeText = jest.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockUseQuery.mockReturnValue({
      data: {
        id: 'doc-copy-1',
        title: 'Source document',
        type: 'url',
        originalUrl: 'https://example.com/research',
        storageUrl: '',
        status: 'processed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        uploadedBy: 'test-user',
      },
      isLoading: false,
      error: null,
    } as never);
    mockUseMutation.mockReturnValue({ mutate: jest.fn(), isPending: false } as never);

    render(<DocumentSheet documentId="doc-copy-1" open onOpenChange={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Copy Original URL' }));
    expect(writeText).toHaveBeenCalledWith('https://example.com/research');
  });

  it('names the linked-entity delete action and removes the selected link', () => {
    mockActiveTabIndex = 2;
    const removeLink = jest.fn();
    mockUseQuery
      .mockReturnValueOnce({
        data: {
          id: 'doc-links-1',
          title: 'Linked document',
          type: 'markdown',
          storageUrl: '',
          status: 'processed',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          uploadedBy: 'test-user',
        },
        isLoading: false,
        error: null,
      } as never)
      .mockReturnValueOnce({
        data: [
          {
            id: 'link-1',
            documentId: 'doc-links-1',
            entityId: 'tech-quantum',
            entityType: 'technology',
            relationshipType: 'evidence',
            relevance: 'high',
            createdAt: Date.now(),
          },
        ],
        isLoading: false,
        error: null,
      } as never);
    mockUseMutation
      .mockReturnValueOnce({ mutate: jest.fn(), isPending: false } as never)
      .mockReturnValueOnce({ mutate: jest.fn(), isPending: false } as never)
      .mockReturnValueOnce({ mutate: removeLink, isPending: false } as never);

    render(<DocumentSheet documentId="doc-links-1" open onOpenChange={jest.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Technology link tech-quantum' }));
    expect(removeLink).toHaveBeenCalledWith('link-1');
  });
});
