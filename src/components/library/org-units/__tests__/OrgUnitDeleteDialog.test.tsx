import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { OrgUnitDeleteDialog } from '../OrgUnitDeleteDialog';

const mockRadixActionClose = jest.fn();

jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogCancel: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
    <button disabled={disabled}>{children}</button>
  ),
  AlertDialogAction: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) mockRadixActionClose();
      }}
    >
      {children}
    </button>
  ),
}));

describe('OrgUnitDeleteDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    orgUnitName: 'Platform Engineering',
    childCount: 0,
    onConfirm: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks confirmation and explains how to resolve known child dependencies', () => {
    render(<OrgUnitDeleteDialog {...defaultProps} childCount={2} />);

    expect(screen.getByText(/cannot be deleted because it has 2 child org units/i)).toBeInTheDocument();
    expect(screen.getByText(/reassign its children and any initiatives it owns/i)).toBeInTheDocument();

    const action = screen.getByRole('button', { name: 'Delete' });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
  });

  it('uses singular copy for one child org unit', () => {
    render(<OrgUnitDeleteDialog {...defaultProps} childCount={1} />);

    expect(screen.getByText(/has 1 child org unit\./i)).toBeInTheDocument();
  });

  it('allows confirmation when no child is currently known', () => {
    render(<OrgUnitDeleteDialog {...defaultProps} />);

    expect(screen.getByText(/deletion is blocked while it has child org units or owns initiatives/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
    expect(mockRadixActionClose).not.toHaveBeenCalled();
  });

  it('disables the dialog actions while deletion is pending', () => {
    render(<OrgUnitDeleteDialog {...defaultProps} isPending />);

    expect(screen.getByRole('button', { name: 'Deleting...' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('does not render dialog content while closed', () => {
    render(<OrgUnitDeleteDialog {...defaultProps} open={false} />);

    expect(screen.queryByTestId('dialog')).not.toBeInTheDocument();
  });
});
