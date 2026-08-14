/**
 * @file DetailPageShell.test.tsx
 * @description Tests for the shared detail-page layout template (Task 19,
 * P-D1/P-D2/P-D3) — back link, h1 title, actions slot, aside landmark, and
 * main content column.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { DetailPageShell } from '../DetailPageShell';

// Mock lucide-react with a Proxy so any icon import works (canonical pattern —
// see EntitySheetShell.test.tsx / DashboardOverview.test.tsx).
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

it('renders back link, title, actions, aside and content', () => {
  render(
    <DetailPageShell
      backHref="/triage/signals"
      backLabel="Back to Signals"
      title="T"
      actions={<button>Approve</button>}
      aside={<div>Details</div>}
    >
      <div>Body</div>
    </DetailPageShell>
  );
  expect(screen.getByRole('link', { name: /back to signals/i })).toHaveAttribute('href', '/triage/signals');
  expect(screen.getByRole('heading', { level: 1, name: 'T' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  expect(screen.getByText('Details')).toBeInTheDocument();
  expect(screen.getByText('Body')).toBeInTheDocument();
});
