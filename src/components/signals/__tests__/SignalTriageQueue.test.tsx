/**
 * @file SignalTriageQueue.test.tsx
 * @description AUDIT-005: pins that the triage queue branches on
 * `submitSignalFeedback`'s `{success, error}` result instead of toasting
 * success unconditionally:
 *
 *   1. `{success: false}` → destructive toast with the server error,
 *      onSignalProcessed NOT called, processed counter unchanged (the user
 *      stays on the same signal and can retry).
 *   2. `{success: true}` → happy path: onSignalProcessed called, success
 *      toast, processed counter incremented.
 *
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// lucide-react is ESM; stub icons as null-rendering components.
jest.mock('lucide-react', () => {
  const Stub = () => null;
  return new Proxy({}, { get: () => Stub });
});

jest.mock('@/lib/firebase', () => ({ db: {}, auth: {} }));

jest.mock('@/components/providers/AuthProvider', () => ({
  useAuth: () => ({ user: { uid: 'user-1' } }),
}));

const mockSubmitSignalFeedback = jest.fn();
jest.mock('@/lib/signals/feedback', () => ({
  submitSignalFeedback: (...args: unknown[]) => mockSubmitSignalFeedback(...args),
}));

const mockToast = jest.fn();
jest.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: mockToast }),
}));

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() }),
}));

import { SignalTriageQueue } from '../SignalTriageQueue';
import type { Signal } from '@/lib/types';

function makeSignal(overrides: Partial<Signal> & { id: string; title: string }): Signal {
  return {
    description: 'A signal description',
    source: 'TechCrunch',
    status: 'Detected',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Signal;
}

const SIGNAL_A = makeSignal({ id: 's1', title: 'Signal Alpha' });
const SIGNAL_B = makeSignal({ id: 's2', title: 'Signal Beta' });

describe('SignalTriageQueue — feedback result branching (AUDIT-005)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('failed write → destructive toast, no onSignalProcessed, counter unchanged', async () => {
    mockSubmitSignalFeedback.mockResolvedValue({ success: false, error: 'boom' });
    const onSignalProcessed = jest.fn();

    render(<SignalTriageQueue signals={[SIGNAL_A, SIGNAL_B]} onSignalProcessed={onSignalProcessed} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Error', description: 'boom', variant: 'destructive' })
      )
    );

    expect(mockSubmitSignalFeedback).toHaveBeenCalledWith('s1', 'up', undefined, true, 'user-1');
    expect(onSignalProcessed).not.toHaveBeenCalled();
    // Counter unchanged — the user stays on the same signal and can retry.
    expect(screen.getByText('0 processed')).toBeTruthy();
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: 'Signal Approved' }));
  });

  it('successful write → onSignalProcessed called, success toast, counter incremented', async () => {
    mockSubmitSignalFeedback.mockResolvedValue({ success: true });
    const onSignalProcessed = jest.fn();

    render(<SignalTriageQueue signals={[SIGNAL_A, SIGNAL_B]} onSignalProcessed={onSignalProcessed} />);

    fireEvent.click(screen.getByRole('button', { name: /Approve/ }));

    await waitFor(() => expect(onSignalProcessed).toHaveBeenCalledWith('s1', 'approved'));
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Signal Approved', description: 'Signal Alpha' })
    );
    await waitFor(() => expect(screen.getByText('1 processed')).toBeTruthy());
  });

  it('rejected write failure also stays put (Reject path shares the branch)', async () => {
    mockSubmitSignalFeedback.mockResolvedValue({ success: false, error: 'write rejected' });
    const onSignalProcessed = jest.fn();

    render(<SignalTriageQueue signals={[SIGNAL_A]} onSignalProcessed={onSignalProcessed} />);

    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Error', description: 'write rejected', variant: 'destructive' })
      )
    );
    expect(mockSubmitSignalFeedback).toHaveBeenCalledWith('s1', 'down', undefined, true, 'user-1');
    expect(onSignalProcessed).not.toHaveBeenCalled();
    expect(screen.getByText('0 processed')).toBeTruthy();
  });

  it('skip does not submit feedback and still advances', async () => {
    const onSignalProcessed = jest.fn();

    render(<SignalTriageQueue signals={[SIGNAL_A, SIGNAL_B]} onSignalProcessed={onSignalProcessed} />);

    fireEvent.click(screen.getByRole('button', { name: /Skip/ }));

    await waitFor(() => expect(onSignalProcessed).toHaveBeenCalledWith('s1', 'skipped'));
    expect(mockSubmitSignalFeedback).not.toHaveBeenCalled();
  });
});
