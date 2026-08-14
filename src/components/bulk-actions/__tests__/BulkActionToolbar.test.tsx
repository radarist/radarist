/**
 * @file BulkActionToolbar.test.tsx
 * @description Component rendering tests for BulkActionToolbar
 *
 * Tests the rendered output, visibility logic, button interactions,
 * additional actions slot, and custom className support.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { BulkActionToolbar } from '../BulkActionToolbar';

// Mock framer-motion to avoid animation complexity in tests
jest.mock('framer-motion', () => ({
  motion: {
    div: ({ children, className }: React.HTMLAttributes<HTMLDivElement>) => (
      <div className={className} data-testid="motion-div">
        {children}
      </div>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock lucide-react icons
jest.mock('lucide-react', () => ({
  X: (props: Record<string, unknown>) => (
    <span data-testid="icon-x" className={props.className as string} />
  ),
  Trash2: (props: Record<string, unknown>) => (
    <span data-testid="icon-trash2" className={props.className as string} />
  ),
}));

// Mock shadcn/ui Button
jest.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    size,
    className,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
    className?: string;
    'aria-label'?: string;
  }) => (
    <button
      data-testid={`button-${variant || 'default'}${size ? `-${size}` : ''}`}
      onClick={onClick}
      disabled={disabled}
      className={className}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  ),
}));

// Mock cn utility
jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

describe('BulkActionToolbar', () => {
  const defaultProps = {
    selectedCount: 3,
    entityType: 'company',
    onClearSelection: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ================================================================
  // Visibility
  // ================================================================

  it('should return null when selectedCount is 0', () => {
    const { container } = render(
      <BulkActionToolbar {...defaultProps} selectedCount={0} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('should render when selectedCount is greater than 0', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={1} />);
    expect(screen.getByTestId('motion-div')).toBeInTheDocument();
  });

  // ================================================================
  // Selection count display
  // ================================================================

  it('should display selection count with plural entity label', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={3} />);
    expect(screen.getByText('3 companies selected')).toBeInTheDocument();
  });

  it('should display singular entity label for count of 1', () => {
    render(<BulkActionToolbar {...defaultProps} selectedCount={1} />);
    expect(screen.getByText('1 company selected')).toBeInTheDocument();
  });

  it('should display correct entity type for different types', () => {
    render(
      <BulkActionToolbar
        {...defaultProps}
        selectedCount={2}
        entityType="technology"
      />
    );
    expect(screen.getByText('2 technologies selected')).toBeInTheDocument();
  });

  // ================================================================
  // Clear selection button
  // ================================================================

  it('should render clear selection button with X icon', () => {
    render(<BulkActionToolbar {...defaultProps} />);
    expect(screen.getByLabelText('Clear selection')).toBeInTheDocument();
    expect(screen.getByTestId('icon-x')).toBeInTheDocument();
  });

  it('should call onClearSelection when clear button is clicked', () => {
    const onClearSelection = jest.fn();
    render(
      <BulkActionToolbar {...defaultProps} onClearSelection={onClearSelection} />
    );

    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });

  // ================================================================
  // Delete button
  // ================================================================

  it('should render delete button when onDelete is provided', () => {
    const onDelete = jest.fn();
    render(<BulkActionToolbar {...defaultProps} onDelete={onDelete} />);

    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByTestId('icon-trash2')).toBeInTheDocument();
  });

  it('should not render delete button when onDelete is not provided', () => {
    render(<BulkActionToolbar {...defaultProps} />);
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('should call onDelete when delete button is clicked', () => {
    const onDelete = jest.fn();
    render(<BulkActionToolbar {...defaultProps} onDelete={onDelete} />);

    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('should show "Deleting..." when isDeleting is true', () => {
    const onDelete = jest.fn();
    render(
      <BulkActionToolbar
        {...defaultProps}
        onDelete={onDelete}
        isDeleting={true}
      />
    );

    expect(screen.getByText('Deleting...')).toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
  });

  it('should disable delete button when isDeleting is true', () => {
    const onDelete = jest.fn();
    render(
      <BulkActionToolbar
        {...defaultProps}
        onDelete={onDelete}
        isDeleting={true}
      />
    );

    expect(screen.getByTestId('button-destructive-sm')).toBeDisabled();
  });

  // ================================================================
  // Additional actions
  // ================================================================

  it('should render additional actions when provided', () => {
    render(
      <BulkActionToolbar
        {...defaultProps}
        additionalActions={<button data-testid="custom-action">Custom</button>}
      />
    );

    expect(screen.getByTestId('custom-action')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  // ================================================================
  // Custom className
  // ================================================================

  it('should apply custom className to the toolbar', () => {
    render(
      <BulkActionToolbar {...defaultProps} className="my-custom-class" />
    );

    const motionDiv = screen.getByTestId('motion-div');
    expect(motionDiv.className).toContain('my-custom-class');
  });
});
