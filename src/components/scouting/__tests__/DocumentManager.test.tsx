/**
 * Component render tests for DocumentManager (React Testing Library)
 *
 * Live-surface verification (task-17 finding #2): DocumentManager is
 * imported by CompanyDialog.tsx (Documents tab), which is rendered on the
 * /radar page when a user clicks a company linked to a radar blip. A prior
 * pass styled this component believing it was dead code; it is not. Every
 * radar entry sampled in this environment's Firestore project had zero
 * company-blip-relationships (BlipCompanyLinks renders `null` when empty,
 * and no seed/demo script ever populates that collection — confirmed via
 * `grep -rln "linkCompanyToBlip" scripts/`), so the CompanyDialog could not
 * be reached live through several radar/entry combinations. This test
 * renders DocumentManager directly to pin its two states instead:
 *
 *   1. Zero documents → the outline "Add Link" header button plus the
 *      standard EmptyState (icon + title + "Add Document Link" action)
 *      render correctly, with no crash.
 *   2. One or more documents → each renders as a card with name + link,
 *      and the "Add Link" affordance still renders alongside them.
 */

// ============================================================================
// MOCKS
// ============================================================================

// lucide-react ships as ESM which Jest doesn't transform by default.
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined;
        const IconComponent = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        IconComponent.displayName = prop as string;
        return IconComponent;
      },
    }
  );
});

jest.mock('@/hooks/use-toast', () => {
  const stableToast = jest.fn();
  return { useToast: () => ({ toast: stableToast }) };
});

// ============================================================================
// IMPORTS
// ============================================================================

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { DocumentManager } from '../DocumentManager';
import type { Company } from '@/lib/types';

function buildCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: 'company-1',
    name: 'Acme Corp',
    slug: 'acme-corp',
    description: 'A company',
    website: 'https://acme.example.com',
    type: ['sme'],
    industry: ['technology'],
    size: 'small',
    stage: 'private',
    location: { city: 'Zurich', country: 'Switzerland' },
    status: 'Watching',
    tags: [],
    socialLinks: {},
    technologyStack: [],
    documents: [],
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
    ...overrides,
  } as Company;
}

describe('DocumentManager rendering', () => {
  it('renders the outline "Add Link" header button and the standard EmptyState when there are no documents', () => {
    const company = buildCompany({ documents: [] });
    render(<DocumentManager company={company} onUpdate={jest.fn()} />);

    expect(screen.getByText('0 documents')).toBeInTheDocument();

    // Header action — outline variant "Add Link" button.
    const headerButton = screen.getByRole('button', { name: /add link/i });
    expect(headerButton).toBeInTheDocument();
    expect(headerButton.className).toMatch(/outline/);

    // Standard EmptyState: icon + title + outline action.
    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.getByText('No documents yet')).toBeInTheDocument();
    const emptyStateAction = screen.getByRole('button', { name: /add document link/i });
    expect(emptyStateAction).toBeInTheDocument();
    expect(emptyStateAction.className).toMatch(/outline/);
  });

  it('opens the Add External Document Link dialog from either entry point without crashing', async () => {
    const user = userEvent.setup();
    const company = buildCompany({ documents: [] });
    render(<DocumentManager company={company} onUpdate={jest.fn()} />);

    await user.click(screen.getByRole('button', { name: /add link/i }));

    expect(await screen.findByText('Add External Document Link')).toBeInTheDocument();
    expect(screen.getByLabelText(/document name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/document url/i)).toBeInTheDocument();
  });

  it('renders existing documents as cards alongside the "Add Link" affordance', () => {
    const company = buildCompany({
      documents: [
        {
          id: 'doc-1',
          name: 'Pitch Deck',
          type: 'link',
          url: 'https://docs.example.com/pitch',
          uploadedAt: Date.now(),
        },
      ],
    });
    render(<DocumentManager company={company} onUpdate={jest.fn()} />);

    expect(screen.getByText('1 document')).toBeInTheDocument();
    expect(screen.getByText('Pitch Deck')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /docs.example.com\/pitch/i })).toHaveAttribute(
      'href',
      'https://docs.example.com/pitch'
    );
    // No empty state once documents exist.
    expect(screen.queryByTestId('empty-state')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add link/i })).toBeInTheDocument();
  });

  it('names the remove-document icon button with the document name (UX-040)', () => {
    const company = buildCompany({
      documents: [
        { id: 'doc-1', name: 'Q3 Pitch Deck', type: 'link', url: 'https://docs.example.com/pitch', uploadedAt: 1 },
      ],
    });
    render(<DocumentManager company={company} onUpdate={jest.fn()} />);

    expect(screen.getByRole('button', { name: /remove document q3 pitch deck/i })).toBeInTheDocument();
  });

  it('keeps unsaved document input open when the owner reports failure', async () => {
    const user = userEvent.setup();
    const onUpdate = jest.fn().mockResolvedValue(false);
    render(<DocumentManager company={buildCompany()} onUpdate={onUpdate} />);

    await user.click(screen.getByRole('button', { name: /add link/i }));
    await user.type(screen.getByLabelText(/document name/i), 'Evidence dossier');
    await user.type(screen.getByLabelText(/document url/i), 'https://example.com/evidence');
    await user.click(screen.getByRole('button', { name: 'Add Link' }));

    expect(onUpdate).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'Evidence dossier', url: 'https://example.com/evidence' }),
    ]);
    expect(screen.getByText('Add External Document Link')).toBeInTheDocument();
    expect(screen.getByLabelText(/document name/i)).toHaveValue('Evidence dossier');
  });
});
