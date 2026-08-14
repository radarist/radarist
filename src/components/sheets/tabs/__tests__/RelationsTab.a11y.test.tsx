/**
 * @file RelationsTab.a11y.test.tsx
 * @description Accessible-name regressions for the entity-sheet relations tab
 * (UX-040/ACCESS-001): per-relation open/remove icon controls must carry
 * contextual accessible names that include the related entity's name.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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

jest.mock('@/lib/graph/client-safe', () => ({
  getNeighbors: jest.fn().mockResolvedValue([]),
  explainGraphConnection: jest.fn().mockResolvedValue(null),
  checkGraphAvailability: jest.fn().mockResolvedValue(false),
}));

jest.mock('@/hooks/useProposedRelations', () => ({
  usePendingProposedRelations: jest.fn(() => ({ data: [], isLoading: false })),
}));

jest.mock('@/ai/flows/discover-relations', () => ({
  discoverRelations: jest.fn().mockResolvedValue({ suggestions: [] }),
}));

jest.mock('../RelationPicker', () => ({
  RelationPicker: () => null,
}));

import { RelationsTab } from '../RelationsTab';
import type { Relation } from '@/lib/types';

const relation: Relation = {
  id: 'rel-1',
  sourceSnapshot: { id: 'comp-1', type: 'company', name: 'Acme Corp', snapshotAt: 1 },
  targetSnapshot: { id: 'tech-9', type: 'technology', name: 'Quantum Mesh', snapshotAt: 1 },
  relationType: 'uses',
  confidence: 100,
  aiSuggested: false,
  claimStatus: 'curated',
  createdAt: 1,
  updatedAt: 1,
} as unknown as Relation;

describe('RelationsTab accessible names (UX-040)', () => {
  it('names the per-relation open and remove icon buttons with the related entity name', async () => {
    render(
      <RelationsTab
        entityId="comp-1"
        entityType="company"
        entityName="Acme Corp"
        relations={[relation]}
        onRemoveRelation={jest.fn()}
        onEntityClick={jest.fn()}
      />
    );

    expect(await screen.findByRole('button', { name: /open quantum mesh/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove relation to quantum mesh/i })).toBeInTheDocument();
  });
});
