/**
 * @file BulkDismissDialog.test.tsx
 * @description Pins the Q3 disclaimer copy + interaction surface.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

import { BulkDismissDialog } from '../BulkDismissDialog';

describe('BulkDismissDialog', () => {
  it('does not render when open=false', () => {
    render(<BulkDismissDialog open={false} onOpenChange={() => {}} count={3} onConfirm={() => {}} />);
    expect(screen.queryByTestId('bulk-dismiss-dialog')).toBeNull();
  });

  it('carries the Q3 disclaimer verbatim', () => {
    render(<BulkDismissDialog open={true} onOpenChange={() => {}} count={5} onConfirm={() => {}} />);
    // The disclaimer is the literal phrasing from the plan.
    expect(screen.getByTestId('bulk-dismiss-disclaimer')).toHaveTextContent(
      "This won't tell agents to find fewer of them."
    );
  });

  it('pluralises the title based on count', () => {
    const { rerender } = render(
      <BulkDismissDialog open={true} onOpenChange={() => {}} count={1} onConfirm={() => {}} />
    );
    expect(screen.getByText('Mark 1 insight as read')).toBeInTheDocument();
    rerender(<BulkDismissDialog open={true} onOpenChange={() => {}} count={5} onConfirm={() => {}} />);
    expect(screen.getByText('Mark 5 insights as read')).toBeInTheDocument();
  });

  it('confirm button fires onConfirm', () => {
    const onConfirm = jest.fn();
    render(<BulkDismissDialog open={true} onOpenChange={() => {}} count={3} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId('bulk-dismiss-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancel button fires onOpenChange(false)', () => {
    const onOpenChange = jest.fn();
    render(<BulkDismissDialog open={true} onOpenChange={onOpenChange} count={3} onConfirm={() => {}} />);
    fireEvent.click(screen.getByTestId('bulk-dismiss-cancel'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('disables confirm when `disabled` prop is true (mid-mutation)', () => {
    render(<BulkDismissDialog open={true} onOpenChange={() => {}} count={3} onConfirm={() => {}} disabled />);
    expect(screen.getByTestId('bulk-dismiss-confirm')).toBeDisabled();
  });
});
