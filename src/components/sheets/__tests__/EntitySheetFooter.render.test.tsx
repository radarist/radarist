import React from 'react';
import { render, screen } from '@testing-library/react';

import { EntitySheetFooter } from '../EntitySheetFooter';

jest.mock('lucide-react', () => ({
  Loader2: () => <span data-testid="loader-icon" />,
  Trash2: () => <span data-testid="trash-icon" />,
}));

jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

describe('EntitySheetFooter delete policy', () => {
  const baseProps = {
    mode: 'edit' as const,
    onCancel: jest.fn(),
    onSave: jest.fn(),
    onDelete: jest.fn(),
    entityName: 'Platform Engineering',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders entity-specific policy copy and blocks a known-invalid delete', () => {
    render(
      <EntitySheetFooter
        {...baseProps}
        deleteDescription="Reassign child org units before deleting this organizational unit."
        isDeleteBlocked
      />
    );

    expect(screen.getByText(/reassign child org units/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Delete' })[1]).toBeDisabled();
  });

  it('keeps the confirmed action available when no dependency is known', () => {
    render(
      <EntitySheetFooter
        {...baseProps}
        deleteDescription="Deletion is blocked if this organizational unit owns initiatives."
      />
    );

    expect(screen.getByText(/owns initiatives/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })[1]).toBeEnabled();
  });
});
