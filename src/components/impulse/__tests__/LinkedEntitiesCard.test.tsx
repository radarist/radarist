/**
 * @file LinkedEntitiesCard.test.tsx
 * @description Tests the insight-detail aside's "Linked Entities" card
 * (Task 20 / P-D4).
 *
 * Pins:
 *   1. Renders nothing when there are no related entities.
 *   2. Renders one row per entity with its name.
 *   3. Renders the canon color/icon chip for a recognised entity type.
 *   4. Falls back to the shared document-palette chip (via the consolidated
 *      `resolveEntityChipColor` guard — Task 20 finding #2) for an
 *      unrecognised type, never throws.
 *   5. Renders an "Open" action that navigates to the resolved entity URL.
 *   6. Omits the "Open" action when the type has no resolvable URL.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: Record<string, unknown>) => (
      <span data-testid={`icon-${name}`} className={props.className as string} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

import { LinkedEntitiesCard } from '../LinkedEntitiesCard';
import { fireEvent } from '@testing-library/react';
import type { BriefingInsight } from '@/hooks/useBriefing';

type RelatedEntity = BriefingInsight['relatedEntities'][number];

describe('LinkedEntitiesCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders nothing when there are no related entities', () => {
    const { container } = render(<LinkedEntitiesCard entities={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one row per entity with its name', () => {
    const entities: RelatedEntity[] = [
      { id: 'comp-ibm', name: 'IBM', type: 'company' },
      { id: 'tech-quantum', name: 'Quantum Computing', type: 'technology' },
    ];
    render(<LinkedEntitiesCard entities={entities} />);
    expect(screen.getByTestId('linked-entities-card')).toBeInTheDocument();
    expect(screen.getByTestId('linked-entity-comp-ibm')).toHaveTextContent('IBM');
    expect(screen.getByTestId('linked-entity-tech-quantum')).toHaveTextContent('Quantum Computing');
  });

  it('renders the canon color chip for a recognised entity type (company → blue)', () => {
    const entities: RelatedEntity[] = [{ id: 'comp-ibm', name: 'IBM', type: 'company' }];
    render(<LinkedEntitiesCard entities={entities} />);
    const row = screen.getByTestId('linked-entity-comp-ibm');
    const chip = row.querySelector('span.bg-blue-500\\/10');
    expect(chip).not.toBeNull();
  });

  it('falls back to the document-palette chip for an unrecognised entity type without throwing', () => {
    // Task 20 finding #2 — the fallback now routes through the same
    // `resolveEntityChipColor` guard RelationsTab uses, so an unrecognised
    // type resolves to ENTITY_COLORS.document (bg-slate-500/10), not a
    // separately-invented bg-muted/text-muted-foreground fallback.
    const entities: RelatedEntity[] = [{ id: 'm-1', name: 'Mystery', type: 'mystery' }];
    expect(() => render(<LinkedEntitiesCard entities={entities} />)).not.toThrow();
    const row = screen.getByTestId('linked-entity-m-1');
    expect(row.querySelector('span.bg-slate-500\\/10')).not.toBeNull();
  });

  it('renders an Open action that navigates to the resolved entity URL', () => {
    const entities: RelatedEntity[] = [{ id: 'comp-ibm', name: 'IBM', type: 'company' }];
    render(<LinkedEntitiesCard entities={entities} />);
    fireEvent.click(screen.getByRole('button', { name: /open ibm/i }));
    expect(mockPush).toHaveBeenCalledWith(expect.stringContaining('/library/companies'));
  });

  it('omits the Open action when the entity type has no resolvable URL', () => {
    const entities: RelatedEntity[] = [{ id: 'm-1', name: 'Mystery', type: 'mystery' }];
    render(<LinkedEntitiesCard entities={entities} />);
    expect(screen.queryByRole('button', { name: /open mystery/i })).not.toBeInTheDocument();
  });
});
