/**
 * @file PaidActionConfirmation.test.tsx
 * @description Unit tests for the contained paid-action confirmation card (UX-045).
 *
 * Covers: monospace containment of the phrase, amount labeling, live countdown
 * with a real deadline, Confirm/Copy actions submitting the exact phrase,
 * client-clock expiry flipping to a restage state, and typed terminal outcomes
 * (confirmed / already_used / wrong_session / not_found / expired).
 */

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { PendingPaidActionState } from '@/types/ai-assistant';

// lucide-react: lightweight stub icons
jest.mock('lucide-react', () => {
  return new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        if (typeof prop !== 'string') return undefined;
        const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg data-testid={`icon-${prop}`} {...props} />;
        Icon.displayName = prop;
        return Icon;
      },
    }
  );
});

import { PaidActionConfirmation, formatCountdown, formatUsdAmount } from '../PaidActionConfirmation';

const PHRASE = `CONFIRM SPEND $31 ${encodeURIComponent(`startMission:${'a'.repeat(64)}`)}`;

function buildAction(overrides?: Partial<PendingPaidActionState>): PendingPaidActionState {
  return {
    toolName: 'startMission',
    amountUsd: 31,
    confirmationPhrase: PHRASE,
    expiresAt: Date.now() + 5 * 60 * 1000,
    ttlMs: 5 * 60 * 1000,
    restageMessage: 'Start an AI scan',
    ...overrides,
  };
}

describe('formatUsdAmount', () => {
  it('renders whole dollars without cents and fractional amounts with two decimals', () => {
    expect(formatUsdAmount(31)).toBe('$31');
    expect(formatUsdAmount(31.5)).toBe('$31.50');
  });

  it('rounds fractional cents conservatively UPWARD, matching the server phrase normalization', () => {
    // The server's formatUsd puts $31.01 in the authoritative phrase for
    // 31.001 — the displayed cap must never be lower than the phrase's.
    expect(formatUsdAmount(31.001)).toBe('$31.01');
    expect(formatUsdAmount(0.001)).toBe('$0.01');
    // Floating-point representations of exact cents stay exact, not inflated.
    expect(formatUsdAmount(0.1 + 0.2)).toBe('$0.30');
  });
});

describe('formatCountdown', () => {
  it('renders m:ss and floors at 0:00', () => {
    expect(formatCountdown(4 * 60 * 1000 + 32 * 1000)).toBe('4:32');
    expect(formatCountdown(59 * 1000)).toBe('0:59');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-1000)).toBe('0:00');
  });
});

describe('PaidActionConfirmation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders the exact phrase in a contained monospace block with the amount', () => {
    render(<PaidActionConfirmation action={buildAction()} />);

    const phrase = screen.getByTestId('paid-action-phrase');
    expect(phrase.tagName).toBe('CODE');
    expect(phrase).toHaveTextContent(PHRASE);
    expect(phrase.className).toContain('font-mono');
    expect(phrase.className).toContain('break-all');
    expect(screen.getByText(/authorize up to \$31/i)).toBeInTheDocument();
  });

  it('shows a live countdown with the absolute deadline and ticks it down', () => {
    render(<PaidActionConfirmation action={buildAction({ expiresAt: Date.now() + 5 * 60 * 1000 })} />);

    expect(screen.getByTestId('paid-action-countdown')).toHaveTextContent(/Expires in 5:00/);
    expect(screen.getByTestId('paid-action-countdown')).toHaveTextContent(/\(at .+\)/);

    act(() => {
      jest.advanceTimersByTime(90 * 1000);
    });
    expect(screen.getByTestId('paid-action-countdown')).toHaveTextContent(/Expires in 3:30/);
  });

  it('submits the exact phrase as a confirm turn', () => {
    const onSubmitMessage = jest.fn();
    render(<PaidActionConfirmation action={buildAction()} onSubmitMessage={onSubmitMessage} />);

    const confirm = screen.getByTestId('paid-action-confirm');
    expect(confirm).toHaveTextContent('Confirm $31');
    fireEvent.click(confirm);
    expect(onSubmitMessage).toHaveBeenCalledWith({ text: PHRASE, kind: 'confirm' });
  });

  it('copies the exact phrase to the clipboard', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PaidActionConfirmation action={buildAction()} />);

    fireEvent.click(screen.getByTestId('paid-action-copy'));
    expect(writeText).toHaveBeenCalledWith(PHRASE);
  });

  it('disables the actions while a turn is in flight', () => {
    render(<PaidActionConfirmation action={buildAction()} busy onSubmitMessage={jest.fn()} />);
    expect(screen.getByTestId('paid-action-confirm')).toBeDisabled();
  });

  it('never displays a cap below the authorized phrase amount for fractional cents', () => {
    // Even if a raw un-normalized amount reaches the card, the display applies
    // the same conservative upward normalization as the server phrase.
    render(<PaidActionConfirmation action={buildAction({ amountUsd: 31.001 })} />);
    expect(screen.getByText(/authorize up to \$31\.01/i)).toBeInTheDocument();
    expect(screen.getByTestId('paid-action-confirm')).toHaveTextContent('Confirm $31.01');
  });

  it('ignores a rapid double-click: exactly one confirm submission until the turn settles', () => {
    const onSubmitMessage = jest.fn();
    render(<PaidActionConfirmation action={buildAction()} onSubmitMessage={onSubmitMessage} />);

    const confirm = screen.getByTestId('paid-action-confirm');
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('paid-action-confirm')).toBeDisabled();
  });

  it('re-enables Confirm after a turn settles without a terminal outcome (retry stays possible)', () => {
    const onSubmitMessage = jest.fn();
    const { rerender } = render(
      <PaidActionConfirmation action={buildAction()} busy={false} onSubmitMessage={onSubmitMessage} />
    );

    fireEvent.click(screen.getByTestId('paid-action-confirm'));
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);

    // The turn runs (busy) and settles without an outcome (e.g. transient
    // provider failure) — the guard releases and a retry can submit again.
    rerender(<PaidActionConfirmation action={buildAction()} busy onSubmitMessage={onSubmitMessage} />);
    rerender(<PaidActionConfirmation action={buildAction()} busy={false} onSubmitMessage={onSubmitMessage} />);

    const confirm = screen.getByTestId('paid-action-confirm');
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onSubmitMessage).toHaveBeenCalledTimes(2);
  });

  it('guards restage against rapid double-clicks the same way', () => {
    const onSubmitMessage = jest.fn();
    render(
      <PaidActionConfirmation action={buildAction({ outcome: 'already_used' })} onSubmitMessage={onSubmitMessage} />
    );

    const restage = screen.getByTestId('paid-action-restage');
    fireEvent.click(restage);
    fireEvent.click(restage);
    expect(onSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it('flips to an expired restage state when the deadline passes on the client clock', () => {
    const onSubmitMessage = jest.fn();
    render(
      <PaidActionConfirmation
        action={buildAction({ expiresAt: Date.now() + 2000 })}
        onSubmitMessage={onSubmitMessage}
      />
    );
    expect(screen.getByTestId('paid-action-confirm')).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(2500);
    });

    expect(screen.queryByTestId('paid-action-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('paid-action-copy')).not.toBeInTheDocument();
    expect(screen.getByTestId('paid-action-status')).toHaveTextContent(/expired/i);

    fireEvent.click(screen.getByTestId('paid-action-restage'));
    expect(onSubmitMessage).toHaveBeenCalledWith({ text: 'Start an AI scan', kind: 'restage' });
  });

  it('hides the restage action when no restage message is known', () => {
    render(<PaidActionConfirmation action={buildAction({ expiresAt: Date.now() - 1, restageMessage: undefined })} />);
    expect(screen.getByTestId('paid-action-status')).toHaveTextContent(/expired/i);
    expect(screen.queryByTestId('paid-action-restage')).not.toBeInTheDocument();
  });

  it('renders the one-time used state after a confirmed outcome, with no actions', () => {
    render(<PaidActionConfirmation action={buildAction({ outcome: 'confirmed' })} />);
    expect(screen.getByTestId('paid-action-status')).toHaveTextContent(/has been used/i);
    expect(screen.queryByTestId('paid-action-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('paid-action-restage')).not.toBeInTheDocument();
  });

  it.each([
    ['already_used', /already used/i],
    ['wrong_session', /different chat session/i],
    ['not_found', /server may have restarted/i],
    ['expired', /expired/i],
  ] as const)('names the %s outcome distinctly and offers restaging', (outcome, expected) => {
    const onSubmitMessage = jest.fn();
    render(<PaidActionConfirmation action={buildAction({ outcome })} onSubmitMessage={onSubmitMessage} />);

    expect(screen.getByTestId('paid-action-status')).toHaveTextContent(expected);
    expect(screen.queryByTestId('paid-action-confirm')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('paid-action-restage'));
    expect(onSubmitMessage).toHaveBeenCalledWith({ text: 'Start an AI scan', kind: 'restage' });
  });
});
