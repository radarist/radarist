/**
 * @file LinkerProposalsTable.test.tsx
 * @description Pins the Relation column label for the linker's table view.
 *
 * Pins:
 *   1. A `custom` relationType renders "Related to" — matching
 *      RelationsTab.tsx and AIRelationDiscovery.tsx, which already map
 *      `custom` → "Related to" (CONV-ENUM: the three surfaces must agree).
 *   2. A regular relationType (e.g. `competes_with`) still falls back to
 *      `formatEnumLabel`'s default title-case ("Competes With").
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import type { ProposedRelation, EntityType, RelationType, ProposedRelationStatus } from '@/lib/types';

// lucide-react is ESM; stub icons as null-rendering components.
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

function makeProposal(
  id: string,
  relationType: RelationType,
  overrides: Partial<ProposedRelation> = {}
): ProposedRelation {
  const sourceType: EntityType = 'company';
  const targetType: EntityType = 'technology';
  return {
    id,
    sourceId: `${sourceType}-${id}-src`,
    sourceType,
    sourceSnapshot: { id: `${sourceType}-${id}-src`, name: `Source ${id}`, type: sourceType, snapshotAt: Date.now() },
    targetId: `${targetType}-${id}-tgt`,
    targetType,
    targetSnapshot: { id: `${targetType}-${id}-tgt`, name: `Target ${id}`, type: targetType, snapshotAt: Date.now() },
    relationType,
    confidence: 85,
    reasoning: 'Test reasoning',
    evidence: [],
    status: 'pending' as ProposedRelationStatus,
    discoveredBy: 'linker-agent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as ProposedRelation;
}

describe('LinkerProposalsTable — Relation column', () => {
  it('renders "custom" as "Related to", matching RelationsTab / AIRelationDiscovery', () => {
    render(
      <LinkerProposalsTable
        proposals={[makeProposal('1', 'custom')]}
        userId="test-user"
        sort={{ key: 'createdAt', direction: 'desc' }}
        onSortClick={jest.fn()}
      />
    );

    expect(screen.getByText('Related to')).toBeInTheDocument();
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();
  });

  it('still falls back to default title-case for other relation types', () => {
    render(
      <LinkerProposalsTable
        proposals={[makeProposal('2', 'competes_with')]}
        userId="test-user"
        sort={{ key: 'createdAt', direction: 'desc' }}
        onSortClick={jest.fn()}
      />
    );

    expect(screen.getByText('Competes With')).toBeInTheDocument();
  });

  // task-15 (P-B11): the relation pill was monospace/code-style; CONV-BADGE
  // calls for the same neutral outline pill as the library classification
  // badges (e.g. CompaniesTable's industry pill: `text-xs font-normal`, no tint).
  it('renders the relation pill as a neutral outline badge, not monospace', () => {
    render(
      <LinkerProposalsTable
        proposals={[makeProposal('3', 'competes_with')]}
        userId="test-user"
        sort={{ key: 'createdAt', direction: 'desc' }}
        onSortClick={jest.fn()}
      />
    );

    const pill = screen.getByText('Competes With');
    expect(pill.className).not.toMatch(/font-mono/);
    expect(pill.className).toMatch(/font-normal/);
  });

  it('names every icon-only action for the exact proposed relation', () => {
    render(
      <LinkerProposalsTable
        proposals={[makeProposal('accessible', 'uses')]}
        userId="test-user"
        sort={{ key: 'createdAt', direction: 'desc' }}
        onSortClick={jest.fn()}
      />
    );

    expect(
      screen.getByRole('button', {
        name: 'Approve relation: Source accessible to Target accessible',
      })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', {
        name: 'Reject relation: Source accessible to Target accessible',
      })
    ).toBeEnabled();
    expect(
      screen.getByRole('button', {
        name: 'More actions for relation: Source accessible to Target accessible',
      })
    ).toBeEnabled();
  });
});
