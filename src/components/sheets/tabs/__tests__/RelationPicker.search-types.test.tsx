import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('lucide-react', () => {
  const makeIcon = (name: string) => {
    const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${name}`} {...props} />;
    Icon.displayName = name;
    return Icon;
  };

  return new Proxy({}, { get: (_target, prop: string) => makeIcon(prop) });
});

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

// The project currently resolves Dialog and Select through different Radix
// focus-scope versions. Their nested focus traps loop in jsdom, although the
// browser interaction is valid. Keep the real Select behavior under test and
// replace only the nonessential Dialog shell.
jest.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

import { RelationPicker, type RelationPickerProps } from '../RelationPicker';

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

function renderPicker(overrides: Partial<RelationPickerProps> = {}) {
  const props: RelationPickerProps = {
    open: true,
    onOpenChange: jest.fn(),
    currentEntityType: 'technology',
    currentEntityId: 'tech-current',
    onAddRelation: jest.fn().mockResolvedValue(undefined),
    onSearch: jest.fn().mockResolvedValue([]),
    ...overrides,
  };

  const user = userEvent.setup({ pointerEventsCheck: 0 });
  render(<RelationPicker {...props} />);
  return { props, user };
}

describe('RelationPicker searchable entity types', () => {
  it('offers org units, initiatives, and pain points in the default type filter', async () => {
    const { user } = renderPicker();

    await user.click(screen.getAllByRole('combobox')[0]);

    expect(await screen.findByRole('option', { name: 'Org Unit' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Initiative' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Pain Point' })).toBeInTheDocument();
  });

  it('passes the selected new entity type to the search callback', async () => {
    const onSearch = jest.fn().mockResolvedValue([]);
    const { user } = renderPicker({ onSearch });

    await user.click(screen.getAllByRole('combobox')[0]);
    await user.click(await screen.findByRole('option', { name: 'Initiative' }));
    await user.type(screen.getByPlaceholderText('Search entities...'), 'quantum');

    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('quantum', 'initiative'));
  });
});
