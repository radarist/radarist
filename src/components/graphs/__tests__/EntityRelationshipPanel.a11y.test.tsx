/**
 * @file components/graphs/__tests__/EntityRelationshipPanel.a11y.test.tsx
 * @description UX-040 — the live "Relationship Map" dialog (mode="dialog", the
 * mode every live mount uses) must expose an accessible description. Renders the
 * REAL Radix Dialog so aria-describedby wiring is genuinely exercised.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
          Icon.displayName = prop;
          return Icon;
        },
      }
    )
);
jest.mock('next/dynamic', () => () => {
  const Dyn = () => null;
  Dyn.displayName = 'DynamicStub';
  return Dyn;
});
jest.mock('@/lib/firebase', () => ({ db: {} }));
jest.mock('firebase/firestore', () => ({
  doc: jest.fn(),
  getDoc: jest.fn().mockResolvedValue({ exists: () => false }),
}));
jest.mock('@/lib/relations', () => ({ getRelationsForEntity: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/company-relationships', () => ({ getRelationshipsByCompanyId: jest.fn().mockResolvedValue([]) }));
jest.mock('@/lib/graph/client-safe', () => ({
  checkGraphAvailability: jest.fn().mockResolvedValue(false),
  explainGraphConnection: jest.fn(),
}));
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { EntityRelationshipPanel } from '../EntityRelationshipPanel';

// jsdom has no ResizeObserver; the panel measures its container on mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;

describe('EntityRelationshipPanel — dialog-mode accessibility (UX-040)', () => {
  it('wires the dialog to an accessible description (no Radix missing-description warning)', async () => {
    render(
      <EntityRelationshipPanel
        mode="dialog"
        isOpen
        onOpenChange={jest.fn()}
        entityId="e1"
        entityName="Acme Corp"
        entityType={'companies' as never}
      />
    );

    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();

    const description = screen.getByText(/interactive relationship map for acme corp/i);
    expect(description.id).toBe(describedBy);

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('gives the portaled viewport controls stable contextual names', async () => {
    render(
      <EntityRelationshipPanel
        mode="dialog"
        isOpen
        onOpenChange={jest.fn()}
        entityId="e1"
        entityName="Acme Corp"
        entityType="company"
      />
    );

    await screen.findByRole('dialog', { name: 'Relationship Map: Acme Corp' });
    expect(await screen.findByRole('button', { name: 'Zoom out relationship map' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Zoom in relationship map' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Fit relationship map to view' })).toBeVisible();
  });
});
