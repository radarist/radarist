import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

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
jest.mock('@/hooks/useDocumentsPage', () => ({ formatFileSize: () => '1 KB' }));

import { DocumentsGrid } from '../DocumentsGrid';
import type { Document } from '@/lib/types';

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: 'doc-1',
    title: 'Quantum evidence',
    type: 'markdown',
    storageUrl: 'documents/doc-1.md',
    status: 'processed',
    chunkCount: 2,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    uploadedBy: 'test-user',
    ...overrides,
  } as Document;
}

function renderGrid(document: Document, overrides: Record<string, jest.Mock> = {}) {
  const props = {
    onSelectDocument: jest.fn(),
    onProcessDocument: jest.fn(),
    onRetryDocument: jest.fn(),
    onDeleteDocument: jest.fn(),
    onDownloadDocument: jest.fn(),
    onRefreshDocument: jest.fn(),
    onPreviewDocument: jest.fn(),
    ...overrides,
  };
  render(<DocumentsGrid documents={[document]} {...props} />);
  return props;
}

describe('DocumentsGrid compact actions', () => {
  it('gives preview and download contextual names and preserves their actions', () => {
    const document = makeDocument();
    const props = renderGrid(document);

    fireEvent.click(screen.getByRole('button', { name: 'Preview Quantum evidence' }));
    // UX-060: the accessible name now states WHAT will be downloaded — the
    // shared availability contract labels a stored-bytes document
    // "Download original" and a chunks-only document "Download extracted text".
    fireEvent.click(screen.getByRole('button', { name: 'Download original: Quantum evidence' }));

    expect(props.onPreviewDocument).toHaveBeenCalledWith(document);
    expect(props.onDownloadDocument).toHaveBeenCalledWith(document);
  });

  it('keeps unavailable preview and download actions named while disabled', () => {
    renderGrid(makeDocument({ id: 'doc-url', title: 'External source', type: 'url', storageUrl: '', chunkCount: 0 }));

    expect(screen.getByRole('button', { name: 'Preview External source' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download: External source' })).toBeDisabled();
  });

  /**
   * UX-060 regression. A processed URL document has no stored bytes but DOES
   * have extracted text. The row used to hard-disable Download on
   * `!doc.storageUrl` while the detail sheet offered a download that shipped a
   * title-only stub — two surfaces, two answers, neither the real content.
   */
  it('offers the extracted text for a URL document that has chunks but no stored file', () => {
    const urlDoc = makeDocument({
      id: 'doc-url',
      title: 'External source',
      type: 'url',
      storageUrl: '',
      chunkCount: 12,
    });
    const props = renderGrid(urlDoc);

    const download = screen.getByRole('button', { name: 'Download extracted text: External source' });
    expect(download).toBeEnabled();
    fireEvent.click(download);
    expect(props.onDownloadDocument).toHaveBeenCalledWith(urlDoc);
  });

  it('names and invokes process, retry, and URL refresh actions for their document', () => {
    const uploaded = makeDocument({ status: 'uploaded' });
    const uploadedProps = renderGrid(uploaded);
    fireEvent.click(screen.getByRole('button', { name: 'Process Quantum evidence' }));
    expect(uploadedProps.onProcessDocument).toHaveBeenCalledWith(uploaded);

    const failed = makeDocument({ id: 'doc-failed', title: 'Failed evidence', status: 'failed' });
    const failedProps = renderGrid(failed);
    fireEvent.click(screen.getByRole('button', { name: 'Retry processing Failed evidence' }));
    expect(failedProps.onRetryDocument).toHaveBeenCalledWith(failed);

    const url = makeDocument({ id: 'doc-url', title: 'External source', type: 'url', storageUrl: '' });
    const urlProps = renderGrid(url);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh External source' }));
    expect(urlProps.onRefreshDocument).toHaveBeenCalledWith(url);
  });

  it('names the delete trigger for its document and preserves confirmation', () => {
    const document = makeDocument();
    const props = renderGrid(document);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Quantum evidence' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete "Quantum evidence"?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(props.onDeleteDocument).toHaveBeenCalledWith(document);
  });
});
