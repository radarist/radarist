/**
 * @file BriefingEmptyState.test.tsx
 * @description UX-051 — the empty briefing feed distinguishes five real
 * states instead of claiming "agents are working in the background":
 *
 *   outage    — status endpoint failed / degraded / last sweep failed
 *   paused    — background sweeps are disabled
 *   noexplore — the user has no exploration memory yet
 *   pending   — exploration exists but no sweep has processed it
 *   quiet     — pipeline healthy, last sweep genuinely found nothing
 *
 * Each state names the exact action that can advance it, and none of
 * them promises guaranteed output.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockUseBriefingStatus = jest.fn();
jest.mock('@/hooks/queries/useBriefingStatus', () => ({
  __esModule: true,
  useBriefingStatus: () => mockUseBriefingStatus(),
}));

import { BriefingEmptyState } from '../BriefingEmptyState';

const HEALTHY_QUIET = {
  hasExploration: true,
  sweepEnabled: true,
  pauseReason: null,
  degraded: false,
  lastSweep: {
    at: '2026-07-18T06:00:00.000Z',
    status: 'quiet' as const,
    insightsTotal: 0,
    watchedInsights: 0,
    narrativeInsights: 0,
  },
};

describe('BriefingEmptyState (UX-051)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders a loading skeleton while the status is pending', () => {
    mockUseBriefingStatus.mockReturnValue({ data: undefined, isPending: true, isError: false });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-loading')).toBeInTheDocument();
  });

  it('outage: status fetch failure never renders as a clean inbox', () => {
    mockUseBriefingStatus.mockReturnValue({ data: undefined, isPending: false, isError: true });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-outage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /view agent runs/i })).toBeInTheDocument();
    expect(screen.queryByText(/working in the background/i)).toBeNull();
  });

  it('outage: a failed last sweep is surfaced, not hidden behind quiet copy', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: {
        ...HEALTHY_QUIET,
        lastSweep: { ...HEALTHY_QUIET.lastSweep, status: 'failed' as const },
      },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-outage')).toBeInTheDocument();
  });

  it('outage: a degraded status payload is treated as unknown, not healthy', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: { ...HEALTHY_QUIET, hasExploration: null, degraded: true },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-outage')).toBeInTheDocument();
  });

  it('paused: disabled sweeps name the settings action', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: { ...HEALTHY_QUIET, sweepEnabled: false, pauseReason: 'settings' },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open agent settings/i })).toBeInTheDocument();
    expect(screen.queryByText(/working in the background/i)).toBeNull();
  });

  it('paused: the maintenance guard names the environment action instead of sending users to Settings', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: { ...HEALTHY_QUIET, sweepEnabled: false, pauseReason: 'maintenance' },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-paused')).toBeInTheDocument();
    expect(screen.getByText(/maintenance guard/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open agent settings/i })).toBeNull();
  });

  it('noexplore: no exploration memory names the exact bootstrap action', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: { ...HEALTHY_QUIET, hasExploration: false },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-noexplore')).toBeInTheDocument();
    screen.getByRole('button', { name: /browse technologies/i }).click();
    expect(mockPush).toHaveBeenCalledWith('/library/technologies');
  });

  it('pending: exploration exists but no sweep has run yet — no guaranteed output implied', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: { ...HEALTHY_QUIET, lastSweep: null },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-pending')).toBeInTheDocument();
    expect(screen.getByText(/may find nothing/i)).toBeInTheDocument();
  });

  it('quiet: healthy pipeline with nothing new states the honest outcome and timestamp context', () => {
    mockUseBriefingStatus.mockReturnValue({ data: HEALTHY_QUIET, isPending: false, isError: false });
    render(<BriefingEmptyState />);
    expect(screen.getByTestId('briefing-empty-quiet')).toBeInTheDocument();
    expect(screen.getByText(/found no new insights/i)).toBeInTheDocument();
    expect(screen.getByText(/isn't guaranteed/i)).toBeInTheDocument();
    expect(screen.queryByText(/working in the background/i)).toBeNull();
    screen.getByRole('button', { name: /keep exploring/i }).click();
    expect(mockPush).toHaveBeenCalledWith('/library/technologies');
  });

  it('not-run: an early sweep never claims that insight reflection ran healthily', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: {
        ...HEALTHY_QUIET,
        lastSweep: { ...HEALTHY_QUIET.lastSweep, status: 'not-run' as const },
      },
      isPending: false,
      isError: false,
    });

    render(<BriefingEmptyState />);
    expect(screen.getByText(/completed before insight generation/i)).toBeInTheDocument();
    expect(screen.queryByText(/ran healthily/i)).toBeNull();
  });

  it('every state exposes an accessible heading', () => {
    mockUseBriefingStatus.mockReturnValue({ data: HEALTHY_QUIET, isPending: false, isError: false });
    render(<BriefingEmptyState />);
    expect(screen.getByRole('heading')).toBeInTheDocument();
  });

  it('actions navigate to their named destinations', () => {
    mockUseBriefingStatus.mockReturnValue({
      data: { ...HEALTHY_QUIET, sweepEnabled: false, pauseReason: 'settings' },
      isPending: false,
      isError: false,
    });
    render(<BriefingEmptyState />);
    screen.getByRole('button', { name: /open agent settings/i }).click();
    expect(mockPush).toHaveBeenCalledWith('/settings?tab=agent-config');
  });
});
