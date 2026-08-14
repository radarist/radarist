/**
 * @file BulkDeleteDialog.test.tsx
 * @description Tests for the BulkDeleteDialog component
 *
 * Covers rendering, pluralization, cascade warning toggle,
 * confirm/cancel flows, and loading state during deletion.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BulkDeleteDialog } from '../BulkDeleteDialog';

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  AlertTriangle: (props: Record<string, unknown>) => (
    <span data-testid="icon-alert-triangle" className={props.className as string} />
  ),
  Loader2: (props: Record<string, unknown>) => (
    <span data-testid="icon-loader2" className={props.className as string} />
  ),
  Trash2: (props: Record<string, unknown>) => (
    <span data-testid="icon-trash2" className={props.className as string} />
  ),
}));

// Mock shadcn/ui AlertDialog components
jest.mock('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="alert-dialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-content">{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-header">{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="alert-dialog-title">{children}</h2>
  ),
  AlertDialogDescription: ({ children, asChild: _asChild }: { children: React.ReactNode; asChild?: boolean }) => (
    <div data-testid="alert-dialog-description">{children}</div>
  ),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-dialog-footer">{children}</div>
  ),
  AlertDialogCancel: ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
    <button data-testid="alert-dialog-cancel" disabled={disabled}>
      {children}
    </button>
  ),
  AlertDialogAction: ({ children, ...props }: { children: React.ReactNode }) => (
    <button data-testid="alert-dialog-action" {...props}>
      {children}
    </button>
  ),
}));

// Mock shadcn/ui Button
jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    ...props
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
  }) => (
    <button
      data-testid={`button-${variant || 'default'}`}
      onClick={onClick}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  ),
}));

describe('BulkDeleteDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    count: 3,
    entityType: 'company',
    onConfirm: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ================================================================
  // Rendering
  // ================================================================

  it('should render when open is true', () => {
    render(<BulkDeleteDialog {...defaultProps} />);
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
  });

  it('should not render when open is false', () => {
    render(<BulkDeleteDialog {...defaultProps} open={false} />);
    expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
  });

  // ================================================================
  // Title and pluralization
  // ================================================================

  it('should display correct title with pluralized entity type for count > 1', () => {
    render(<BulkDeleteDialog {...defaultProps} count={3} entityType="company" />);
    expect(screen.getByText('Delete 3 companies?')).toBeInTheDocument();
  });

  it('should display singular entity type for count of 1', () => {
    render(<BulkDeleteDialog {...defaultProps} count={1} entityType="company" />);
    expect(screen.getByText('Delete 1 company?')).toBeInTheDocument();
  });

  it('should display correct entity type in description', () => {
    render(<BulkDeleteDialog {...defaultProps} count={2} entityType="technology" />);
    expect(
      screen.getByText(/Technologies will be permanently deleted/)
    ).toBeInTheDocument();
  });

  // ================================================================
  // Cascade warning
  // ================================================================

  it('should show cascade warning by default', () => {
    render(<BulkDeleteDialog {...defaultProps} />);
    expect(
      screen.getByText(/All relations connected to these/)
    ).toBeInTheDocument();
  });

  it('should hide cascade warning when showCascadeWarning is false', () => {
    render(
      <BulkDeleteDialog {...defaultProps} showCascadeWarning={false} />
    );
    expect(
      screen.queryByText(/All relations connected to these/)
    ).not.toBeInTheDocument();
  });

  // ================================================================
  // Delete button
  // ================================================================

  it('should show delete button with correct label', () => {
    render(<BulkDeleteDialog {...defaultProps} count={5} entityType="signal" />);
    expect(screen.getByText('Delete 5 signals')).toBeInTheDocument();
  });

  it('should show trash icon in delete button by default', () => {
    render(<BulkDeleteDialog {...defaultProps} />);
    expect(screen.getByTestId('icon-trash2')).toBeInTheDocument();
  });

  // ================================================================
  // Confirm flow
  // ================================================================

  it('should call onConfirm when delete button is clicked', async () => {
    const onConfirm = jest.fn().mockResolvedValue(undefined);
    render(<BulkDeleteDialog {...defaultProps} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByTestId('button-destructive'));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it('should call onOpenChange(false) after successful confirm', async () => {
    const onOpenChange = jest.fn();
    const onConfirm = jest.fn().mockResolvedValue(undefined);

    render(
      <BulkDeleteDialog
        {...defaultProps}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByTestId('button-destructive'));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('should remain open when confirm reports a retryable failure', async () => {
    const onOpenChange = jest.fn();
    const onConfirm = jest.fn().mockResolvedValue(false);

    render(
      <BulkDeleteDialog
        {...defaultProps}
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByTestId('button-destructive'));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Deleting...')).not.toBeInTheDocument();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
  });

  // ================================================================
  // Loading state during deletion
  // ================================================================

  it('should show loading state while deleting', async () => {
    // Create a promise that we can resolve manually
    let resolveConfirm: () => void;
    const confirmPromise = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const onConfirm = jest.fn().mockReturnValue(confirmPromise);

    render(<BulkDeleteDialog {...defaultProps} onConfirm={onConfirm} />);

    // Click delete
    fireEvent.click(screen.getByTestId('button-destructive'));

    // Should show loading state
    await waitFor(() => {
      expect(screen.getByText('Deleting...')).toBeInTheDocument();
      expect(screen.getByTestId('icon-loader2')).toBeInTheDocument();
    });

    // Buttons should be disabled during deletion
    expect(screen.getByTestId('button-destructive')).toBeDisabled();
    expect(screen.getByTestId('alert-dialog-cancel')).toBeDisabled();

    // Resolve to clean up
    resolveConfirm!();
    await waitFor(() => {
      expect(screen.queryByText('Deleting...')).not.toBeInTheDocument();
    });
  });

  // ================================================================
  // Cancel button
  // ================================================================

  it('should render a cancel button', () => {
    render(<BulkDeleteDialog {...defaultProps} />);
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  // ================================================================
  // Error handling in onConfirm
  // ================================================================

  it('should not call onOpenChange when onConfirm is still in progress', async () => {
    let resolveConfirm: () => void;
    const confirmPromise = new Promise<void>((resolve) => {
      resolveConfirm = resolve;
    });
    const onConfirm = jest.fn().mockReturnValue(confirmPromise);
    const onOpenChange = jest.fn();

    render(
      <BulkDeleteDialog
        {...defaultProps}
        onConfirm={onConfirm}
        onOpenChange={onOpenChange}
      />
    );

    fireEvent.click(screen.getByTestId('button-destructive'));

    // While still deleting, onOpenChange should NOT have been called
    expect(onOpenChange).not.toHaveBeenCalled();

    // Now resolve, and onOpenChange should be called
    resolveConfirm!();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  // ================================================================
  // Alert triangle icon
  // ================================================================

  it('should display the alert triangle warning icon', () => {
    render(<BulkDeleteDialog {...defaultProps} />);
    expect(screen.getByTestId('icon-alert-triangle')).toBeInTheDocument();
  });
});
