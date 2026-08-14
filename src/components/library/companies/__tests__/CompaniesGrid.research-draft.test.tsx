/**
 * AI-028 — grid and table views must disclose the same company research draft.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { CompaniesGrid } from '../CompaniesGrid';
import type { Company } from '@/lib/types';

const BASE_COMPANY = {
  id: 'company-1',
  slug: 'acme',
  name: 'Acme',
  description: 'An existing company description.',
  type: ['corporate'],
  industry: ['technology'],
  status: 'Watching',
  tags: [],
  technologyStack: [],
  documents: [],
  createdAt: 1,
  updatedAt: 1,
} as unknown as Company;

describe('CompaniesGrid — company research draft truth', () => {
  it('discloses an AI research draft on the grid card', () => {
    render(
      <CompaniesGrid
        companies={[
          {
            ...BASE_COMPANY,
            research: {
              lastResearched: 2,
              version: 1,
              executiveSummary: { overview: 'Generated draft', keyHighlights: [] },
            },
          } as Company,
        ]}
        relations={{}}
        onSelectCompany={jest.fn()}
      />
    );

    expect(screen.getByRole('img', { name: /AI draft.*source review required/i })).toBeInTheDocument();
  });

  it('does not add a draft marker to a company without research', () => {
    render(<CompaniesGrid companies={[BASE_COMPANY]} relations={{}} onSelectCompany={jest.fn()} />);
    expect(screen.queryByRole('img', { name: /AI draft/i })).toBeNull();
  });
});
