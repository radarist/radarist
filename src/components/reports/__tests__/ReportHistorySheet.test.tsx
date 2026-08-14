/**
 * @file components/reports/__tests__/ReportHistorySheet.test.tsx
 * @description DISC-014 — version-history sheet rendering + interactions.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// lucide-react is ESM-only (not in the jest transform allowlist) — stub icons.
jest.mock('lucide-react', () =>
  new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  )
);

// Render the Sheet shell inline (avoid Radix portal/pointer-events in jsdom);
// the sheet's OPEN state is exercised via the `open` prop passthrough test.
jest.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) => (open ? <div>{children}</div> : null),
  SheetContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  SheetDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const mockUseReportVersions = jest.fn();
jest.mock('@/hooks/useReports', () => ({
  useReportVersions: (...args: unknown[]) => mockUseReportVersions(...args),
}));

import { ReportHistorySheet, describeSaver, formatSize } from '../ReportHistorySheet';

const baseProps = {
  reportId: 'report-1',
  open: true,
  onOpenChange: jest.fn(),
  previewVersionId: null as string | null,
  onPreview: jest.fn(),
  onRestore: jest.fn(),
  isRestoring: false,
};

const versions = [
  { versionId: 'v-2', versionNumber: 2, createdAt: '2026-07-14T02:00:00Z', savedBy: 'user:u1', htmlLength: 2048 },
  {
    versionId: 'v-1',
    versionNumber: 1,
    createdAt: '2026-07-14T01:00:00Z',
    savedBy: 'agent:creator',
    htmlLength: 900,
    reason: 'revision',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockUseReportVersions.mockReturnValue({ data: versions, isLoading: false, isError: false, refetch: jest.fn() });
});

describe('describeSaver / formatSize', () => {
  it('maps saver actors to friendly labels and never leaks a raw uid', () => {
    expect(describeSaver('user:abc123xyz')).toBe('Manual edit');
    expect(describeSaver('agent:creator')).toBe('Creator agent');
    expect(describeSaver('agent:artifact-recommender')).toBe('Recommendation engine');
    expect(describeSaver('agent:strategist')).toBe('strategist agent');
    expect(describeSaver('unknown')).toBe('Earlier version');
    // A raw uid must never surface.
    expect(describeSaver('user:abc123xyz')).not.toContain('abc123xyz');
  });

  it('formats byte sizes compactly', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
  });
});

describe('ReportHistorySheet', () => {
  it('renders one row per version with its actor label and size', () => {
    render(<ReportHistorySheet {...baseProps} />);

    expect(screen.getByTestId('history-list')).toBeInTheDocument();
    expect(screen.getByTestId('version-row-2')).toBeInTheDocument();
    expect(screen.getByTestId('version-row-1')).toBeInTheDocument();
    expect(screen.getByText('Manual edit')).toBeInTheDocument();
    expect(screen.getByText('Creator agent')).toBeInTheDocument();
    expect(screen.getByText(/2\.0 KB/)).toBeInTheDocument();
  });

  it('shows a loading skeleton while fetching', () => {
    mockUseReportVersions.mockReturnValue({ data: undefined, isLoading: true, isError: false, refetch: jest.fn() });
    render(<ReportHistorySheet {...baseProps} />);
    expect(screen.getByTestId('history-loading')).toBeInTheDocument();
  });

  it('shows an honest error state (never a falsely-empty history) with retry', () => {
    const refetch = jest.fn();
    mockUseReportVersions.mockReturnValue({ data: undefined, isLoading: false, isError: true, refetch });
    render(<ReportHistorySheet {...baseProps} />);

    expect(screen.getByTestId('history-error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows an empty state when there are no versions yet', () => {
    mockUseReportVersions.mockReturnValue({ data: [], isLoading: false, isError: false, refetch: jest.fn() });
    render(<ReportHistorySheet {...baseProps} />);
    expect(screen.getByTestId('history-empty')).toBeInTheDocument();
  });

  it('fires onPreview with the version id when the preview button is clicked', () => {
    render(<ReportHistorySheet {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview version 2' }));
    expect(baseProps.onPreview).toHaveBeenCalledWith('v-2');
  });

  it('only fetches history while the sheet is open (passes open through to the hook)', () => {
    render(<ReportHistorySheet {...baseProps} open={false} />);
    expect(mockUseReportVersions).toHaveBeenCalledWith('report-1', false);
  });
});
