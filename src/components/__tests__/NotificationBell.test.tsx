/**
 * @file NotificationBell.test.tsx
 * @description Tests for the notification bell popover — unread count,
 * per-item mark-read, and the mark-all-read affordance added for Task 25
 * (P-A6: bell couldn't clear a backlog of stale all-zero digests).
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationBell } from '../NotificationBell';

// shadcn/ui - Popover: render children directly (avoids Radix portal issues)
jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => <>{children}</>,
  PopoverTrigger: ({ children, asChild }: React.PropsWithChildren<{ asChild?: boolean }>) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  PopoverContent: ({ children }: React.PropsWithChildren) => <div data-testid="popover-content">{children}</div>,
}));

jest.mock('lucide-react', () => ({
  Bell: () => <span data-testid="icon-bell" />,
  Check: () => <span data-testid="icon-check" />,
}));

type Digest = {
  id: string;
  date: string;
  summary: { signalsDiscovered: number; connectionsFound: number; insightsGenerated: number };
};

let mockDigests: Digest[] = [];
let mockError: Error | null = null;
const mockMarkReadMutate = jest.fn();
const mockMarkAllReadMutate = jest.fn();
let mockMarkAllReadPending = false;

jest.mock('@/hooks/useDigests', () => ({
  useUnreadDigests: () => ({ data: mockError ? undefined : { digests: mockDigests }, error: mockError }),
  useMarkDigestRead: () => ({ mutate: mockMarkReadMutate }),
  useMarkAllDigestsRead: () => ({ mutate: mockMarkAllReadMutate, isPending: mockMarkAllReadPending }),
}));

function digest(id: string, date: string, overrides: Partial<Digest['summary']> = {}): Digest {
  return {
    id,
    date,
    summary: { signalsDiscovered: 0, connectionsFound: 0, insightsGenerated: 0, ...overrides },
  };
}

describe('NotificationBell', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDigests = [];
    mockError = null;
    mockMarkAllReadPending = false;
  });

  it('shows no badge and an empty state when there are no unread digests', () => {
    render(<NotificationBell />);

    expect(screen.queryByTestId('notification-count')).not.toBeInTheDocument();
    expect(screen.getByText('No new notifications')).toBeInTheDocument();
    expect(screen.queryByTestId('digest-mark-all-read')).not.toBeInTheDocument();
  });

  it('shows the unread count badge and lists each digest', () => {
    mockDigests = [digest('d1', '2026-07-01', { signalsDiscovered: 2 }), digest('d2', '2026-07-02')];

    render(<NotificationBell />);

    expect(screen.getByTestId('notification-count')).toHaveTextContent('2');
    expect(screen.getByTestId('digest-item-d1')).toBeInTheDocument();
    expect(screen.getByTestId('digest-item-d2')).toBeInTheDocument();
  });

  it('marks a single digest read when its check button is clicked', () => {
    mockDigests = [digest('d1', '2026-07-01', { signalsDiscovered: 2 })];

    render(<NotificationBell />);
    fireEvent.click(screen.getByTestId('digest-mark-read-d1'));

    expect(mockMarkReadMutate).toHaveBeenCalledWith('d1');
  });

  it('renders a "Mark all read" button when there are unread digests, and it triggers the batch mutation', () => {
    mockDigests = [digest('d1', '2026-07-01', { signalsDiscovered: 1 }), digest('d2', '2026-07-02')];

    render(<NotificationBell />);
    const markAllButton = screen.getByTestId('digest-mark-all-read');
    expect(markAllButton).toBeInTheDocument();

    fireEvent.click(markAllButton);
    expect(mockMarkAllReadMutate).toHaveBeenCalledTimes(1);
  });

  it('shows an error row and no badge when the digest fetch failed (AUDIT-008)', () => {
    mockError = new Error('Digest fetch failed (500): boom');

    render(<NotificationBell />);

    expect(screen.queryByTestId('notification-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('digest-error')).toBeInTheDocument();
    expect(screen.getByText("Couldn't load notifications")).toBeInTheDocument();
    // Not the all-clear copy — a failed fetch is not "all read".
    expect(screen.queryByText('No new notifications')).not.toBeInTheDocument();
    expect(screen.queryByTestId('digest-mark-all-read')).not.toBeInTheDocument();
  });

  it('disables "Mark all read" while the batch mutation is in flight', () => {
    mockDigests = [digest('d1', '2026-07-01', { signalsDiscovered: 1 })];
    mockMarkAllReadPending = true;

    render(<NotificationBell />);

    expect(screen.getByTestId('digest-mark-all-read')).toBeDisabled();
  });
});
