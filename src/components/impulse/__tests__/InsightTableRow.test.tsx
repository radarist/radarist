/**
 * @file InsightTableRow.test.tsx
 * @description Tests one row's interaction model.
 *
 * Pins:
 *   1. Plain row click navigates to /triage/insights/[id].
 *   2. Action buttons (checkbox, like, dismiss, ⋯) stop propagation —
 *      clicking them does NOT also fire the row's click handler.
 *   3. Like button fires `useLikeInsight` with the inverse boolean.
 *   4. Dismiss button fires `useDismissInsight` and shows the undo toast.
 *   5. Undo button on the toast calls `useUndismissInsight` with the
 *      captured snapshot.
 *   6. Like icon visually reflects the `insight.liked` flag.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({
  __esModule: true,
  useRouter: () => ({ push: mockPush }),
}));

// lucide-react is ESM; stub icons as spans.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

const mockLikeMutate = jest.fn();
const mockDismissMutateAsync = jest.fn();
const mockUndismissMutate = jest.fn();

jest.mock('@/hooks/queries/useLikeInsight', () => ({
  __esModule: true,
  useLikeInsight: () => ({ mutate: mockLikeMutate }),
}));
jest.mock('@/hooks/queries/useDismissInsight', () => ({
  __esModule: true,
  useDismissInsight: () => ({ mutateAsync: mockDismissMutateAsync }),
}));
jest.mock('@/hooks/queries/useUndismissInsight', () => ({
  __esModule: true,
  useUndismissInsight: () => ({ mutate: mockUndismissMutate }),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock('sonner', () => ({
  __esModule: true,
  toast: {
    success: (msg: string, opts: unknown) => mockToastSuccess(msg, opts),
    error: (msg: string, opts: unknown) => mockToastError(msg, opts),
  },
}));

jest.mock('@/lib/firebase', () => ({ auth: {}, db: {} }));
jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-claudio' }, loading: false }),
}));

// 2.1 label-integrity fix: the act path records a 'clicked' preference.
const mockFetchWithAuth = jest.fn().mockResolvedValue({ ok: true });
jest.mock('@/lib/fetch-with-auth', () => ({
  __esModule: true,
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Radix DropdownMenu needs these primitives that jsdom doesn't implement,
// otherwise the menu won't open under fireEvent and the items never mount.
beforeAll(() => {
  if (!('PointerEvent' in window)) {
    // @ts-expect-error minimal stub
    window.PointerEvent = class extends Event {};
  }
  Element.prototype.hasPointerCapture = Element.prototype.hasPointerCapture ?? (() => false);
  Element.prototype.releasePointerCapture = Element.prototype.releasePointerCapture ?? (() => {});
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});
});

import { Table, TableBody } from '@/components/ui/table';
import { InsightTableRow } from '../InsightTableRow';
import type { BriefingInsight } from '@/hooks/useBriefing';

function makeInsight(overrides: Partial<BriefingInsight> = {}): BriefingInsight {
  return {
    id: 'pi-1',
    type: 'connection',
    title: 'Quantum link',
    summary: 'A → B',
    agentName: 'scout',
    confidenceScore: 0.8,
    relatedEntities: [{ id: 'c1', name: 'Acme', type: 'company' }],
    actionable: true,
    actionUrl: '/library/companies?sheet=c1',
    actionLabel: 'View company',
    createdAt: '2026-05-13T00:00:00.000Z',
    liked: false,
    ...overrides,
  };
}

// The row must live inside a Table/TableBody — TableRow uses semantic
// markup that React Testing Library would flag if rendered bare.
function renderRow(insight: BriefingInsight, onSelectedChange = jest.fn()) {
  return render(
    <Table>
      <TableBody>
        <InsightTableRow insight={insight} selected={false} onSelectedChange={onSelectedChange} />
      </TableBody>
    </Table>
  );
}

describe('InsightTableRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDismissMutateAsync.mockResolvedValue(undefined);
  });

  it('navigates to the detail page on plain row click', () => {
    renderRow(makeInsight());
    fireEvent.click(screen.getByTestId('insight-row-pi-1'));
    expect(mockPush).toHaveBeenCalledWith('/triage/insights/pi-1');
  });

  it('does not navigate when the like button is clicked (stopPropagation)', () => {
    renderRow(makeInsight());
    fireEvent.click(screen.getByTestId('insight-like-pi-1'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockLikeMutate).toHaveBeenCalledWith({ insightId: 'pi-1', liked: true });
  });

  it('fires liked=false when the insight is already liked (toggle off)', () => {
    renderRow(makeInsight({ liked: true }));
    fireEvent.click(screen.getByTestId('insight-like-pi-1'));
    expect(mockLikeMutate).toHaveBeenCalledWith({ insightId: 'pi-1', liked: false });
  });

  it('fires the dismiss mutation and shows the five-second Undo toast on success', async () => {
    renderRow(makeInsight());
    fireEvent.click(screen.getByTestId('insight-dismiss-pi-1'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockDismissMutateAsync).toHaveBeenCalledWith({ insightId: 'pi-1' });

    // Toast carries an action with the Undo label.
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        'Insight dismissed',
        expect.objectContaining({
          duration: 5_000,
          action: expect.objectContaining({ label: 'Undo' }),
        })
      )
    );
  });

  it('undo button calls useUndismissInsight with the captured insight snapshot', async () => {
    const insight = makeInsight();
    renderRow(insight);
    fireEvent.click(screen.getByTestId('insight-dismiss-pi-1'));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledTimes(1));
    const opts = mockToastSuccess.mock.calls[0][1] as {
      action: { onClick: () => void };
    };
    act(() => {
      opts.action.onClick();
    });
    // The snapshot carried into the undo should equal the original
    // insight — pin a few key fields rather than full equality so future
    // shape additions don't break this test for the wrong reason.
    expect(mockUndismissMutate).toHaveBeenCalledTimes(1);
    const undoCall = mockUndismissMutate.mock.calls[0][0] as { insight: BriefingInsight };
    expect(undoCall.insight.id).toBe(insight.id);
    expect(undoCall.insight.title).toBe(insight.title);
  });

  it('keeps the Undo continuation alive when optimistic dismissal unmounts the row', async () => {
    let resolveDismiss!: () => void;
    mockDismissMutateAsync.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDismiss = resolve;
      })
    );

    const insight = makeInsight();
    const { unmount } = renderRow(insight);
    fireEvent.click(screen.getByTestId('insight-dismiss-pi-1'));

    // `useDismissInsight.onMutate` removes this row from the query cache in
    // production. Reproduce that observer teardown before the request settles.
    unmount();
    await act(async () => {
      resolveDismiss();
      await Promise.resolve();
    });

    expect(mockToastSuccess).toHaveBeenCalledWith(
      'Insight dismissed',
      expect.objectContaining({
        duration: 5_000,
        action: expect.objectContaining({ label: 'Undo' }),
      })
    );

    const opts = mockToastSuccess.mock.calls[0][1] as { action: { onClick: () => void } };
    act(() => opts.action.onClick());
    expect(mockUndismissMutate).toHaveBeenCalledWith({ insight });
  });

  it('shows the request error after unmount while the mutation hook retains rollback ownership', async () => {
    let rejectDismiss!: (error: Error) => void;
    mockDismissMutateAsync.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectDismiss = reject;
      })
    );
    const { unmount } = renderRow(makeInsight());

    fireEvent.click(screen.getByTestId('insight-dismiss-pi-1'));
    unmount();
    await act(async () => {
      rejectDismiss(new Error('dismiss endpoint unavailable'));
      await Promise.resolve();
    });

    expect(mockToastError).toHaveBeenCalledWith('Failed to dismiss insight', {
      description: 'dismiss endpoint unavailable',
    });
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  it('checkbox toggle calls onSelectedChange without navigating', () => {
    const onSelectedChange = jest.fn();
    renderRow(makeInsight(), onSelectedChange);
    fireEvent.click(screen.getByTestId('insight-select-pi-1'));
    expect(mockPush).not.toHaveBeenCalled();
    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });

  it('clicking the kebab menu does not navigate', () => {
    renderRow(makeInsight());
    fireEvent.click(screen.getByTestId('insight-menu-pi-1'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('humanizes the agent slug (CONV-ENUM)', () => {
    renderRow(makeInsight({ agentName: 'narrative-synthesizer' }));
    const row = screen.getByTestId('insight-row-pi-1');
    expect(within(row).getByText('Narrative Synthesizer')).toBeInTheDocument();
  });

  it('renders "—" instead of throwing when createdAt is not a valid date', () => {
    renderRow(makeInsight({ createdAt: 'not-a-date' }));
    const row = screen.getByTestId('insight-row-pi-1');
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('act ("View source") navigates AND records the clicked preference (2.1 label-integrity)', async () => {
    const user = userEvent.setup();
    renderRow(makeInsight());
    // Radix DropdownMenu needs real pointer events → userEvent (fireEvent won't
    // open it under jsdom). Open the kebab, then click the act item.
    await user.click(screen.getByTestId('insight-menu-pi-1'));
    await user.click(await screen.findByTestId('insight-act-pi-1'));

    expect(mockPush).toHaveBeenCalledWith('/library/companies?sheet=c1');
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/graph/preference',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ insightId: 'pi-1', action: 'clicked' }),
      })
    );
  });
});
