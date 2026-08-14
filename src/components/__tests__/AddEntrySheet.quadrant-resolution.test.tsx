import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

const mockAutoFillEntryAction = jest.fn();
const mockSearchTechnologies = jest.fn();
const mockGetTechnologyBySlug = jest.fn();
const mockToast = jest.fn();

jest.mock('@/app/actions', () => ({
  autoFillEntryAction: (...args: unknown[]) => mockAutoFillEntryAction(...args),
  suggestTagsAction: jest.fn(),
}));

jest.mock('@/lib/technology-service', () => ({
  searchTechnologies: (...args: unknown[]) => mockSearchTechnologies(...args),
  getTechnologyBySlug: (...args: unknown[]) => mockGetTechnologyBySlug(...args),
}));

jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined;
          const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
          Icon.displayName = prop;
          return Icon;
        },
      }
    )
);

jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  SheetDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  SheetFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

jest.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

import { AddEntrySheet } from '../AddEntrySheet';
import type { QuadrantConfig } from '@/lib/types';

const quadrants: QuadrantConfig[] = [
  { id: 'q_default', name: 'Default', order: 0 },
  { id: 'collision', name: 'ID target', order: 1 },
  { id: 'q_name_target', name: 'collision', order: 2 },
];

describe('AddEntrySheet quadrant resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchTechnologies.mockResolvedValue([]);
    mockGetTechnologyBySlug.mockResolvedValue(null);
  });

  it.each([
    ['stable id wins over a colliding legacy name', { quadrantId: 'collision', quadrant: 'collision' }, 'collision'],
    ['legacy name is case-insensitive', { quadrantId: 'missing', quadrant: 'CoLlIsIoN' }, 'q_name_target'],
    ['legacy name is not trimmed', { quadrantId: 'missing', quadrant: ' collision ' }, 'q_default'],
  ])('%s', async (_label, quadrantResult, expectedQuadrantId) => {
    mockAutoFillEntryAction.mockResolvedValue({
      description: 'A sufficiently detailed technology description.',
      ...quadrantResult,
      hata: 'Assess',
      trl: 'TRL 5',
      status: 'Stable',
      tags: ['test'],
    });
    const onSaveEntry = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <AddEntrySheet
        isOpen
        onOpenChange={jest.fn()}
        onSaveEntry={onSaveEntry}
        quadrants={quadrants}
        rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      />
    );

    await user.type(screen.getByPlaceholderText('Search existing or type new...'), 'Resolver Test');
    await user.click(screen.getByTitle('Auto-Fill with AI'));
    await waitFor(() => expect(mockAutoFillEntryAction).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Add to Radar' }));

    await waitFor(() => expect(onSaveEntry).toHaveBeenCalledTimes(1));
    expect(onSaveEntry.mock.calls[0][0]).toEqual(expect.objectContaining({ quadrantId: expectedQuadrantId }));
  });

  it('submits the current radar custom Tools id when selecting an existing tool', async () => {
    const customQuadrants: QuadrantConfig[] = [
      { id: 'q_default', name: 'Default', order: 0 },
      { id: 'Tools', name: 'ID collision', order: 1 },
      { id: 'q_custom_tools', name: 'Tools', order: 2 },
    ];
    mockSearchTechnologies.mockResolvedValue([
      {
        id: 'tech-existing',
        name: 'Existing Tool',
        description: 'An existing tool with enough detail for form validation.',
        category: 'tool',
        tags: ['existing'],
      },
    ]);
    const onSaveEntry = jest.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <AddEntrySheet
        isOpen
        onOpenChange={jest.fn()}
        onSaveEntry={onSaveEntry}
        quadrants={customQuadrants}
        rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      />
    );

    await user.type(screen.getByPlaceholderText('Search existing or type new...'), 'Existing');
    await waitFor(() => expect(mockSearchTechnologies).toHaveBeenCalledWith('Existing', 10));
    await user.click(await screen.findByText('Existing Tool'));
    await user.click(screen.getByRole('button', { name: 'Add to Radar' }));

    await waitFor(() => expect(onSaveEntry).toHaveBeenCalledTimes(1));
    expect(onSaveEntry.mock.calls[0][0]).toEqual(
      expect.objectContaining({ quadrantId: 'q_custom_tools', technologyId: 'tech-existing' })
    );
  });

  it('names the clear-selected-technology button with the technology name (UX-040)', async () => {
    mockSearchTechnologies.mockResolvedValue([
      {
        id: 'tech-existing',
        name: 'Existing Tool',
        description: 'An existing tool with enough detail for form validation.',
        category: 'tool',
        tags: ['existing'],
      },
    ]);
    const user = userEvent.setup();

    render(
      <AddEntrySheet
        isOpen
        onOpenChange={jest.fn()}
        onSaveEntry={jest.fn()}
        quadrants={[{ id: 'q_tools', name: 'Tools', order: 0 }]}
        rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      />
    );

    await user.type(screen.getByPlaceholderText('Search existing or type new...'), 'Existing');
    await user.click(await screen.findByText('Existing Tool'));

    expect(screen.getByRole('button', { name: /clear selected technology existing tool/i })).toBeInTheDocument();
  });

  it('keeps a stale selection in the sheet and tells the user to reselect it', async () => {
    mockSearchTechnologies.mockResolvedValue([
      {
        id: 'tech-stale',
        name: 'Stale Technology',
        description: 'An existing technology with enough detail for validation.',
        category: 'tool',
        tags: ['existing'],
      },
    ]);
    const onSaveEntry = jest
      .fn()
      .mockRejectedValue(new Error('The selected technology changed. Clear it and select it again.'));
    const onOpenChange = jest.fn();
    const user = userEvent.setup();

    render(
      <AddEntrySheet
        isOpen
        onOpenChange={onOpenChange}
        onSaveEntry={onSaveEntry}
        quadrants={[{ id: 'q_tools', name: 'Tools', order: 0 }]}
        rings={['Adopt', 'Trial', 'Assess', 'Hold']}
      />
    );

    await user.type(screen.getByPlaceholderText('Search existing or type new...'), 'Stale');
    await user.click(await screen.findByText('Stale Technology'));
    await user.click(screen.getByRole('button', { name: 'Add to Radar' }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Failed to save entry',
          description: 'The selected technology changed. Clear it and select it again.',
          variant: 'destructive',
        })
      )
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText('Stale Technology')).toBeInTheDocument();
  });
});
