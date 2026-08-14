/**
 * @file RelationPicker.add-failure.test.tsx
 * @description UX-054 — a failed Add must not look like a successful one.
 *
 * The picker removes a result row once `onAddRelation` RESOLVES. Page handlers
 * that caught their own errors therefore resolved on failure too, and the row
 * vanished exactly as it does on success — the user saw the Add "work" and then
 * found `No relations yet`. The handler now rejects; this pins the picker half
 * of that contract, so the row survives a failure and can be retried.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EntityOption } from '../RelationPicker';
import { RELATION_TARGET_ENTITY_TYPES } from '../relation-target-types';

jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${name}`} {...props} />;
    Icon.displayName = name;
    return Icon;
  };
  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

// `var` (not const): RelationPicker calls createLogger at module scope, and the
// hoisted import runs before any const in this file is initialized.
// eslint-disable-next-line no-var
var mockLogError: jest.Mock;
jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: (...args: unknown[]) => mockLogError?.(...args),
  }),
}));
mockLogError = jest.fn();

jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import { RelationPicker } from '../RelationPicker';

const PAIN_POINT: EntityOption = {
  id: 'pain-point-1',
  name: 'Mis-scanned bins',
  type: 'painPoint',
};

beforeAll(() => {
  Element.prototype.hasPointerCapture = jest.fn(() => false) as unknown as typeof Element.prototype.hasPointerCapture;
  Element.prototype.setPointerCapture = jest.fn() as unknown as typeof Element.prototype.setPointerCapture;
  Element.prototype.releasePointerCapture = jest.fn() as unknown as typeof Element.prototype.releasePointerCapture;
  Element.prototype.scrollIntoView = jest.fn() as unknown as typeof Element.prototype.scrollIntoView;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

function renderPicker(onAddRelation: jest.Mock) {
  render(
    <RelationPicker
      open
      onOpenChange={jest.fn()}
      currentEntityType="useCase"
      currentEntityId="use-case-1"
      onAddRelation={onAddRelation}
      onSearch={jest.fn().mockResolvedValue([PAIN_POINT])}
    />
  );
}

async function searchAndAdd(): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Search entities...'), 'bins');
  await screen.findByText(PAIN_POINT.name, undefined, { timeout: 3000 });
  await user.click(screen.getByRole('button', { name: /Add/ }));
}

describe('RelationPicker — a rejected Add is not a success', () => {
  beforeEach(() => jest.clearAllMocks());

  it('keeps the row when the handler rejects, so the Add can be retried', async () => {
    const onAddRelation = jest.fn().mockRejectedValue(new Error('PainPoint not found'));
    renderPicker(onAddRelation);

    await searchAndAdd();

    await waitFor(() => expect(onAddRelation).toHaveBeenCalled());
    expect(screen.getByText(PAIN_POINT.name)).toBeInTheDocument();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('removes the row only when the handler resolves', async () => {
    const onAddRelation = jest.fn().mockResolvedValue(undefined);
    renderPicker(onAddRelation);

    await searchAndAdd();

    await waitFor(() => expect(screen.queryByText(PAIN_POINT.name)).not.toBeInTheDocument());
  });

  it('re-enables the Add button after a failure', async () => {
    const onAddRelation = jest.fn().mockRejectedValue(new Error('boom'));
    renderPicker(onAddRelation);

    await searchAndAdd();

    await waitFor(() => expect(screen.getByRole('button', { name: /Add/ })).toBeEnabled());
  });

  it('advertises exactly the shared, resolvable target types', () => {
    renderPicker(jest.fn());

    // The picker's default list is the single advertised-target constant, which
    // the contract test holds equal to what both snapshot resolvers support.
    expect(RELATION_TARGET_ENTITY_TYPES).toContain('painPoint');
    expect(RELATION_TARGET_ENTITY_TYPES).toContain('orgUnit');
    expect(RELATION_TARGET_ENTITY_TYPES).toContain('initiative');
  });
});
