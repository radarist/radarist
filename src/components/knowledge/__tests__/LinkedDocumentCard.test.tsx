/** @jest-environment jsdom */

import React from 'react';

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
          Icon.displayName = prop;
          return Icon;
        },
      }
    )
);

import { render, screen } from '@testing-library/react';
import { LinkedDocumentCard } from '../LinkedDocumentCard';
import type { EntityDocumentLinkWithDocument } from '@/lib/types';

function linkedDocument(originalUrl: string | undefined, domain = 'example.com'): EntityDocumentLinkWithDocument {
  return {
    id: 'link-1',
    workspaceId: 'default',
    entityType: 'technology',
    entityId: 'tech-1',
    documentId: 'doc-1',
    relationshipType: 'documentation',
    tags: [],
    relevance: 'high',
    createdAt: 1700000000000,
    createdBy: 'user-1',
    updatedAt: 1700000000000,
    document: {
      title: 'Source document',
      type: 'url',
      status: 'processed',
      originalUrl,
      domain,
    },
  };
}

describe('LinkedDocumentCard source action', () => {
  it('opens the exact source path rather than reconstructing the domain homepage', () => {
    const sourceUrl = 'https://example.com/research/article?id=42#results';

    render(<LinkedDocumentCard link={linkedDocument(sourceUrl)} readOnly />);

    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('href', sourceUrl);
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('link', { name: 'Open source' })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each([undefined, 'javascript:alert(1)', 'file:///tmp/private', 'https://user:secret@example.com/private'])(
    'omits the action when the source URL is unavailable or unsafe: %s',
    (sourceUrl) => {
      render(<LinkedDocumentCard link={linkedDocument(sourceUrl)} readOnly />);

      expect(screen.queryByRole('link', { name: 'Open source' })).not.toBeInTheDocument();
    }
  );
});

describe('LinkedDocumentCard accessible names (UX-040)', () => {
  it('names the approve and reject suggestion buttons with the document title', () => {
    const link = { ...linkedDocument('https://example.com/a'), aiSuggested: true };

    render(<LinkedDocumentCard link={link} onApprove={jest.fn()} onReject={jest.fn()} />);

    expect(screen.getByRole('button', { name: /approve suggested link to source document/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject suggested link to source document/i })).toBeInTheDocument();
  });

  it('names the remove-link button with the document title', () => {
    render(<LinkedDocumentCard link={linkedDocument('https://example.com/a')} onDelete={jest.fn()} />);

    expect(screen.getByRole('button', { name: /remove link to source document/i })).toBeInTheDocument();
  });
});
