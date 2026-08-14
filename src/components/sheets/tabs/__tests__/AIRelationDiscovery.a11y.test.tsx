/**
 * @file AIRelationDiscovery.a11y.test.tsx
 * @description Accessible-name regressions for AI relation suggestion cards
 * (UX-040/ACCESS-001): the tooltip-only approve/dismiss icon buttons must
 * carry contextual accessible names — a Radix TooltipContent alone provides
 * no accessible name.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

jest.mock('@/ai/flows/discover-relations', () => ({
  discoverRelations: jest.fn(),
}));

import { AIRelationDiscovery } from '../AIRelationDiscovery';
import { discoverRelations } from '@/ai/flows/discover-relations';

const mockDiscoverRelations = discoverRelations as jest.MockedFunction<typeof discoverRelations>;

describe('AIRelationDiscovery accessible names (UX-040)', () => {
  it('names the approve and dismiss suggestion buttons with the target entity name', async () => {
    const user = userEvent.setup();
    mockDiscoverRelations.mockResolvedValue({
      suggestions: [
        {
          targetEntityId: 'tech-9',
          targetEntityName: 'Quantum Mesh',
          targetEntityType: 'technology',
          relationType: 'uses',
          confidence: 88,
          reasoning: 'Strong overlap.',
        },
      ],
    } as Awaited<ReturnType<typeof discoverRelations>>);

    render(
      <AIRelationDiscovery
        entityId="comp-1"
        entityType="company"
        entityName="Acme Corp"
        candidateEntities={[{ id: 'tech-9', name: 'Quantum Mesh', type: 'technology' }]}
        onApprove={jest.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /ai relation discovery/i }));
    await user.click(await screen.findByRole('button', { name: /discover relations/i }));

    expect(
      await screen.findByRole('button', { name: /approve suggested relation to quantum mesh/i })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss suggested relation to quantum mesh/i })).toBeInTheDocument();
  });
});
