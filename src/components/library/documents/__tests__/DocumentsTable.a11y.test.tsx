import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
jest.mock('@/hooks/useDocumentsPage', () => ({
  formatFileSize: () => '1 KB',
  formatDate: () => 'Jul 17, 2026',
}));

import { DocumentsTable } from '../DocumentsTable';
import type { Document } from '@/lib/types';

const document = {
  id: 'doc-table-1',
  title: 'Quantum evidence',
  type: 'markdown',
  storageUrl: 'documents/doc-table-1.md',
  status: 'processed',
  chunkCount: 2,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  uploadedBy: 'test-user',
} as Document;

/** A processed URL document: no stored bytes, but extracted text exists. */
const urlDocument = {
  id: 'doc-table-url',
  title: 'External source',
  type: 'url',
  storageUrl: '',
  originalUrl: 'https://example.com/article',
  status: 'processed',
  chunkCount: 12,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  uploadedBy: 'test-user',
} as Document;

function renderTable(target: Document = document) {
  const props = {
    onSelectDocument: jest.fn(),
    onProcessDocument: jest.fn(),
    onRetryDocument: jest.fn(),
    onDeleteDocument: jest.fn(),
    onDownloadDocument: jest.fn(),
    onRefreshDocument: jest.fn(),
    onPreviewDocument: jest.fn(),
    isSelected: jest.fn(() => false),
    onToggleSelection: jest.fn(),
    isAllSelected: false,
    isSomeSelected: false,
    onSelectAllChange: jest.fn(),
    sortState: { key: 'createdAt', direction: 'desc' } as const,
    onSort: jest.fn(),
  };
  render(<DocumentsTable documents={[target]} {...props} />);
  return props;
}

describe('DocumentsTable row actions', () => {
  it('contextualizes the repeated menu trigger and preserves preview/download actions', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderTable();
    const trigger = screen.getByRole('button', { name: 'Open actions for Quantum evidence' });

    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Preview' }));
    expect(props.onPreviewDocument).toHaveBeenCalledWith(document);

    await user.click(trigger);
    // UX-060: the item states what the user will receive. The shared contract
    // labels stored bytes "Download original".
    await user.click(screen.getByRole('menuitem', { name: 'Download original' }));
    expect(props.onDownloadDocument).toHaveBeenCalledWith(document);
  });

  /**
   * UX-060 regression. The row menu disabled Download whenever `storageUrl`
   * was empty, so a processed URL document with 12 extracted chunks offered
   * nothing — while the detail sheet for the SAME document offered a download
   * that silently shipped a title-only markdown stub.
   */
  it('offers the extracted text for a URL document with chunks but no stored file', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const props = renderTable(urlDocument);

    await user.click(screen.getByRole('button', { name: 'Open actions for External source' }));
    const item = screen.getByRole('menuitem', { name: 'Download extracted text' });
    expect(item).not.toHaveAttribute('data-disabled');

    await user.click(item);
    expect(props.onDownloadDocument).toHaveBeenCalledWith(urlDocument);
  });
});
