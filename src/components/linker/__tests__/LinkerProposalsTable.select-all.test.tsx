/**
 * @file LinkerProposalsTable.select-all.test.tsx
 * @description UX-037 — the header checkbox must describe the rows it renders.
 *
 * The table is handed one PAGE of the visible scope, while the selection lives
 * on the page and spans every page. The header checkbox previously compared
 * `selectedIds.length === proposals.length`, so selecting ten rows on page 1
 * rendered page 2's header as fully checked and "select all" then CLEARED a
 * selection the operator had not made on that page.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ProposedRelation } from '@/lib/types';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

jest.mock('@/hooks/useProposedRelations', () => ({
  useApproveProposedRelation: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRejectProposedRelation: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useDismissProposedRelation: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRevertProposedRelation: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useRemoveApprovedRelation: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}));

import { LinkerProposalsTable } from '../LinkerProposalsTable';

function makeProposal(id: string): ProposedRelation {
  return {
    id,
    sourceId: `company-${id}`,
    sourceType: 'company',
    sourceSnapshot: { id: `company-${id}`, name: `Source ${id}`, type: 'company', snapshotAt: 1 },
    targetId: `tech-${id}`,
    targetType: 'technology',
    targetSnapshot: { id: `tech-${id}`, name: `Target ${id}`, type: 'technology', snapshotAt: 1 },
    relationType: 'uses',
    confidence: 85,
    reasoning: 'because',
    evidence: [],
    status: 'pending',
    discoveredBy: 'linker-agent',
    createdAt: 1,
    updatedAt: 1,
  } as ProposedRelation;
}

/** The page this table renders. */
const PAGE = [makeProposal('page2-a'), makeProposal('page2-b')];

/** A selection made on a DIFFERENT page — same size, no overlap. */
const OFF_PAGE_SELECTION = ['page1-a', 'page1-b'];

function renderTable(selectedIds: string[], onSelectionChange = jest.fn()) {
  render(
    <LinkerProposalsTable
      proposals={PAGE}
      selectedIds={selectedIds}
      onSelectionChange={onSelectionChange}
      userId="user-1"
      sort={{ key: 'createdAt', direction: 'desc' }}
      onSortClick={jest.fn()}
    />
  );
  return { onSelectionChange, header: screen.getByLabelText('Select all proposals') };
}

describe('LinkerProposalsTable — select-all reflects the rendered page', () => {
  it('is unchecked when the selection is entirely on another page', () => {
    const { header } = renderTable(OFF_PAGE_SELECTION);

    expect(header).toHaveAttribute('data-state', 'unchecked');
  });

  it('is indeterminate when only some rendered rows are selected', () => {
    const { header } = renderTable(['page2-a']);

    expect(header).toHaveAttribute('data-state', 'indeterminate');
  });

  it('is checked only when every rendered row is selected', () => {
    const { header } = renderTable(['page2-a', 'page2-b']);

    expect(header).toHaveAttribute('data-state', 'checked');
  });

  it('adds this page to the selection without discarding other pages', () => {
    const { onSelectionChange, header } = renderTable(OFF_PAGE_SELECTION);

    fireEvent.click(header);

    expect(onSelectionChange).toHaveBeenCalledWith([...OFF_PAGE_SELECTION, 'page2-a', 'page2-b']);
  });

  it('removes only this page from the selection when it was fully selected', () => {
    const { onSelectionChange, header } = renderTable([...OFF_PAGE_SELECTION, 'page2-a', 'page2-b']);

    fireEvent.click(header);

    expect(onSelectionChange).toHaveBeenCalledWith(OFF_PAGE_SELECTION);
  });
});
